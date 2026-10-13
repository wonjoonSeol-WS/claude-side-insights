import type { Elements, RenderChildren, RenderSurface, UiPressArgument } from 'claude-code'

import {
  CheckStatus,
  Kind,
  RecordStatus,
  Source,
  Status,
  ToolState,
  clock,
  counts,
  duration,
  fit,
  highlight,
  turnRow,
  type FlowRecord,
  type FlowRef,
  type FlowStep,
  type PanelState,
  type QaItem,
  type QaTurn,
  type Tool,
} from './data'

export type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code' | 'Markdown'>

export const Tab = { FLOW: 'flow', LIVE: 'live', QA: 'qa' } as const
export type TabValue = (typeof Tab)[keyof typeof Tab]
export const TAB_KEYS: [string, TabValue][] = [
  ['1', Tab.FLOW],
  ['2', Tab.LIVE],
  ['3', Tab.QA],
]

export type View = {
  tab: TabValue
  flowId?: string
  step: number
  selected?: string
  openOnly: boolean
  showArchived: boolean
  note?: { text: string; color: string }
}

export type Actions = {
  setTab: (tab: TabValue) => void
  flowBy: (delta: number) => void
  stepTo: (step: number) => void
  select: (id: string) => void
  cycleStatus: () => void
  autoStatus: () => void
  archive: () => void
  copy: (press: UiPressArgument) => void
  recheck: () => void
  rebuild: () => void
  toggleOpenOnly: () => void
  toggleArchived: () => void
  openBrowser: () => void
}

export type Ctx = {
  ui: UI
  s?: PanelState
  t: (key: string, ...args: (string | number)[]) => string
  cols: number
  view: View
  surface: RenderSurface
  selected?: string
  flow?: FlowRecord
  flowLoading: boolean
  act: Actions
  pageUrl: string
  problem?: string
}

const STATUS_COLOR: Record<string, string> = {
  [Status.ANSWERED]: 'success',
  [Status.PARTIAL]: 'warning',
  [Status.UNANSWERED]: 'error',
}
const KIND_COLOR: Record<string, string> = {
  [Kind.INPUT]: 'subtle',
  [Kind.LOGIC]: 'suggestion',
  [Kind.EXTERNAL]: 'warning',
  [Kind.STORAGE]: 'success',
  [Kind.OUTPUT]: 'merged',
  [Kind.CONFIG]: 'subtle',
  [Kind.TEST]: 'ide',
}
const TOOL_MARK: Record<string, [string, string]> = {
  [ToolState.OK]: ['✓', 'success'],
  [ToolState.ERR]: ['✗', 'error'],
  [ToolState.RUN]: ['⠋', 'warning'],
}
const LOST_MARK: [string, string] = ['–', 'inactive']
const CHECK_MARK: Record<string, [string, string]> = { [CheckStatus.PASS]: ['✓', 'success'], [CheckStatus.FAIL]: ['✗', 'error'] }
const LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  sh: 'bash',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
}
const MAX_FILES = 30
const MAX_TOOLS = 40
const TOOLS_IN_FLOW = 12
const MAX_TURNS = 20
const LINK_SURFACES = new Set<RenderSurface>(['terminal', 'desktop'])
const OPEN_STATUSES = new Set<string>([Status.PARTIAL, Status.UNANSWERED])
const HINTS: Record<TabValue, [string, string][]> = {
  [Tab.FLOW]: [
    ['1 2 3', 'term_k_tabs'],
    ['p n', 'term_k_flows'],
    ['k j', 'term_k_steps'],
    ['r', 'term_k_rebuild'],
    ['o', 'term_k_open'],
  ],
  [Tab.LIVE]: [
    ['1 2 3', 'term_k_tabs'],
    ['o', 'term_k_open'],
  ],
  [Tab.QA]: [
    ['1 2 3', 'term_k_tabs'],
    ['s', 'term_k_status'],
    ['u', 'reset_auto'],
    ['a', 'term_k_archive'],
    ['c', 'term_k_copy'],
    ['r', 'term_k_recheck'],
    ['f', 'term_k_open_only'],
    ['v', 'qa_archived'],
    ['o', 'term_k_open'],
  ],
}

export const isOpen = (item: QaItem) => OPEN_STATUSES.has(item.status ?? '')
export const canCopy = (item: QaItem | undefined) => !!item && isOpen(item) && !item.archived && !item.manual

export const currentFlow = (flows: FlowRef[], flowId: string | undefined) => {
  const found = flows.findIndex(f => f.id === flowId)
  const index = found < 0 ? 0 : found
  return { index, ref: flows[index] }
}
const BAR = 16
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const bar = (done: number, total: number): string => {
  const filled = total ? Math.round((BAR * done) / total) : 0
  return '━'.repeat(filled) + '╌'.repeat(BAR - filled)
}

const statusLabel = (c: Ctx, status: string | undefined) => (status && STATUS_COLOR[status] ? c.t(`st_${status}`) : '-')

export const header = (c: Ctx) => {
  const { Box, Text, Button, Link } = c.ui
  const busy = c.s?.activity.busy
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TAB_KEYS.map(([key, tab]) => (
          <Button
            key={`tab-${tab}`}
            plain
            hotkey={key}
            label={c.t(`mode_${tab}`)}
            dimColor={c.view.tab !== tab}
            onPress={() => c.act.setTab(tab)}
          />
        ))}
        <Text color={busy ? 'warning' : 'inactive'}>{busy ? `⠋ ${c.t('busy')}` : `○ ${c.t('idle')}`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="open" plain hotkey="o" label={c.t('full')} onPress={() => c.act.openBrowser()} />
        {c.pageUrl && LINK_SURFACES.has(c.surface) ? <Link href={c.pageUrl} label={c.t('full_title')} /> : null}
      </Box>
      {c.problem ? <Text color="error">{c.problem}</Text> : null}
    </Box>
  )
}

export const noteOrHints = (c: Ctx) => {
  const { Text } = c.ui
  if (c.view.note) {
    return <Text color={c.view.note.color}>{c.view.note.text}</Text>
  }
  return (
    <Text dimColor>
      {HINTS[c.view.tab].map(([key, label]) => (
        <Text key={`hint-${key}`}>
          <Text color="suggestion">{key}</Text> {c.t(label)}
          {'  '}
        </Text>
      ))}
    </Text>
  )
}

const card = (c: Ctx, key: string, title: string, children: RenderChildren[], color = 'inactive') => {
  const { Box, Text } = c.ui
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  )
}

const toolLine = (c: Ctx, tool: Tool, i: number, now: number) => {
  const { Text } = c.ui
  const [mark, color] = TOOL_MARK[tool.state] ?? LOST_MARK
  const end = tool.state === ToolState.RUN ? now : tool.end
  const took = tool.start && end ? duration(end - tool.start) : ''
  const name = tool.label || tool.tool
  const nameColor = EDIT_TOOLS.has(tool.tool) ? 'merged' : tool.tool.startsWith('mcp__') ? 'ide' : 'suggestion'
  const what = (tool.file ? relative(c, tool.file) : tool.summary) ?? ''
  return (
    <Text key={`tool-${i}`} wrap="truncate-end">
      <Text color={color}>{mark}</Text> <Text dimColor>{clock(tool.start, true)}</Text>{' '}
      <Text color={nameColor} bold>
        {name}
      </Text>{' '}
      {what} <Text dimColor>{took}</Text>
    </Text>
  )
}

const relative = (c: Ctx, path: string) => {
  const cwd = c.s?.activity.cwd
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

export const live = (c: Ctx) => {
  const { Box, Text } = c.ui
  const tools = c.s?.activity.tools ?? []
  const files = [...(c.s?.activity.files ?? [])].sort((a, b) => b.last - a.last)
  const done = tools.filter(x => x.state === ToolState.OK || x.state === ToolState.ERR).length
  const failed = tools.filter(x => x.state === ToolState.ERR).length
  const now = Date.now() / 1000
  const fileLines = files.slice(0, MAX_FILES).map((f, i) => (
    <Text key={`file-${i}`} wrap="truncate-start">
      <Text color={f.created ? 'success' : 'warning'} bold>
        {f.created ? 'A' : 'M'}
      </Text>{' '}
      {relative(c, f.path)}
      <Text dimColor>{f.count > 1 ? ` ×${f.count}` : ''}</Text>
    </Text>
  ))
  if (files.length > MAX_FILES) {
    fileLines.push(
      <Text key="files-more" dimColor>
        {c.t('term_more', files.length - MAX_FILES)}
      </Text>,
    )
  }
  const toolLines = [...tools]
    .reverse()
    .slice(0, MAX_TOOLS)
    .map((tool, i) => toolLine(c, tool, i, now))
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={failed ? 'warning' : 'success'}>{bar(done, tools.length)}</Text>{' '}
        <Text dimColor>
          {done}/{tools.length}
        </Text>
        {failed ? <Text color="error"> ✗ {failed}</Text> : ''}
      </Text>
      <Text dimColor>
        <Text color="success">✓</Text> {c.t('term_ok')} <Text color="error">✗</Text> {c.t('term_err')} – {c.t('term_lost')}{' '}
        <Text color="warning">⠋</Text> {c.t('term_run')}
      </Text>
      {card(c, 'files', c.t('term_files', files.length), fileLines.length ? fileLines : [<Text key="files-none" dimColor>{c.t('term_none')}</Text>])}
      {card(c, 'tools', c.t('term_tools', tools.length), toolLines.length ? toolLines : [<Text key="tools-none" dimColor>{c.t('term_not_yet')}</Text>])}
    </Box>
  )
}

const stateCard = (c: Ctx, steps: FlowStep[], step: number) => {
  const { Text } = c.ui
  const values = new Map<string, { d: NonNullable<FlowStep['data']>[number]; now: boolean }>()
  steps.slice(0, step + 1).forEach((s, i) => {
    for (const d of s.data ?? []) {
      values.set(d.name ?? '', { d, now: i === step })
    }
  })
  const lines = [...values.entries()].map(([name, { d, now }], i) => {
    const moved = now && d.before != null && d.before !== '' && d.before !== d.after
    return (
      <Text key={`val-${i}`}>
        <Text color="warning">{now ? '●' : ' '}</Text> <Text color={now ? 'suggestion' : 'inactive'}>{name}</Text>{'  '}
        <Text dimColor={!now}>{moved ? `${d.before} → ${d.after}` : String(d.after ?? '')}</Text>
      </Text>
    )
  })
  const changed = [...values.values()].some(v => v.now)
  return card(c, 'state', c.t('state_title'), lines.length ? lines : [<Text key="state-none" dimColor>{c.t('state_empty')}</Text>], changed ? 'warning' : 'inactive')
}

const language = (location: string | undefined) => {
  const file = (location ?? '').split(' ')[0] ?? ''
  const ext = file.includes('.') ? file.split('.').pop() ?? '' : ''
  return LANGUAGE[ext]
}

const stepCard = (c: Ctx, s: FlowStep, step: number) => {
  const { Text, Code, Markdown } = c.ui
  const color = KIND_COLOR[s.kind ?? ''] ?? 'suggestion'
  const lang = language(s.location)
  const hits = (s.highlight ?? []).filter(Boolean)
  const body = [
    <Text key="where" dimColor wrap="truncate-start">
      {s.location ?? ''}
    </Text>,
    <Markdown key="explain" text={highlight(s.explanation ?? '')} />,
  ]
  if (s.code) {
    body.push(<Code key="code" source={s.code} {...(lang ? { language: lang } : {})} />)
  }
  if (hits.length) {
    body.push(
      <Text key="hits" color="warning">
        ▌ {hits.join(', ')}
      </Text>,
    )
  }
  return card(c, 'step', `${step + 1}. ${s.title ?? ''}`, body, color)
}

const flowCards = (c: Ctx, rec: FlowRecord) => {
  const { Text, Markdown } = c.ui
  const flow = rec.flow ?? {}
  const out: RenderChildren[] = []
  const changes = flow.changes ?? []
  if (changes.length) {
    out.push(
      card(
        c,
        'changes',
        c.t('changes', changes.length),
        changes.flatMap((ch, i) => [
          <Text key={`chg-${i}`} wrap="truncate-start">
            <Text color="warning" bold>
              M
            </Text>{' '}
            {ch.file ?? ''}
          </Text>,
          <Text key={`chg-what-${i}`} dimColor>{`    ${ch.what ?? ''}`}</Text>,
        ]),
      ),
    )
  }
  const checks = flow.checks ?? []
  if (checks.length) {
    out.push(
      card(
        c,
        'checks',
        c.t('checks'),
        checks.map((ck, i) => {
          const [mark, color] = CHECK_MARK[ck.status ?? ''] ?? ['?', 'inactive']
          return (
            <Text key={`chk-${i}`}>
              <Text color={color}>{mark}</Text> {ck.label ?? ''}
            </Text>
          )
        }),
      ),
    )
  }
  if (rec.prompt) {
    const meta = [rec.model, rec.cost ? `$${rec.cost.toFixed(3)}` : ''].filter(Boolean).join(' / ')
    out.push(card(c, 'request', c.t('request'), [<Markdown key="prompt" dimColor text={rec.prompt} />, ...(meta ? [<Text key="meta" dimColor>{meta}</Text>] : [])]))
  }
  const now = Date.now() / 1000
  const tools = (c.s?.activity.tools ?? []).filter(x => !rec.ts || (x.start ?? 0) <= rec.ts).slice(-TOOLS_IN_FLOW)
  if (tools.length) {
    out.push(card(c, 'flow-tools', c.t('term_tools', tools.length), [...tools].reverse().map((x, i) => toolLine(c, x, i, now))))
  }
  return out
}

export const flow = (c: Ctx) => {
  const { Box, Text, Button, Markdown } = c.ui
  const flows = c.s?.flows ?? []
  const top: RenderChildren[] = []
  if (c.s?.pending) {
    top.push(
      <Text key="flow-gen" color="warning">
        ⠋ {c.t('flow_gen')}
      </Text>,
    )
  }
  if (!flows.length) {
    return (
      <Box flexDirection="column">
        {top}
        <Text bold>{c.t('flow_empty_t')}</Text>
        <Text dimColor>{c.t('flow_empty_d')}</Text>
      </Box>
    )
  }
  const { index, ref } = currentFlow(flows, c.view.flowId)
  if (flows.length > 1) {
    top.push(
      <Box key="flow-nav" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="flow-prev" plain hotkey="p" label={c.t('mod_prev_flow')} onPress={() => c.act.flowBy(-1)} />
        <Button key="flow-next" plain hotkey="n" label={c.t('mod_next_flow')} onPress={() => c.act.flowBy(1)} />
        <Text dimColor>
          {index + 1}/{flows.length}
        </Text>
      </Box>,
    )
  }
  const rec = c.flow
  if (!rec || c.flowLoading) {
    return (
      <Box flexDirection="column">
        {top}
        <Text bold>{ref?.title ?? ''}</Text>
        <Text dimColor>{c.t('loading')}</Text>
      </Box>
    )
  }
  if (rec.status !== RecordStatus.OK) {
    return (
      <Box flexDirection="column">
        {top}
        <Text bold>{ref?.title ?? ''}</Text>
        <Text color="error" bold>
          {c.t('flow_fail')}
        </Text>
        <Text dimColor>{rec.error ?? ''}</Text>
      </Box>
    )
  }
  const f = rec.flow ?? {}
  const steps = f.steps ?? []
  const step = Math.max(0, Math.min(c.view.step, steps.length - 1))
  const kinds = [...new Set(steps.map(s => (s.kind && KIND_COLOR[s.kind] ? s.kind : Kind.LOGIC)))]
  return (
    <Box flexDirection="column">
      {top}
      <Text>
        <Text bold>{f.title ?? ''}</Text> <Text dimColor>{clock(rec.ts)}</Text>
      </Text>
      {steps.length > 0 && (
        <Text>
          <Text color="suggestion">{bar(step + 1, steps.length)}</Text>{' '}
          <Text dimColor>
            {step + 1}/{steps.length}
          </Text>
        </Text>
      )}
      {f.example && (
        <Text>
          <Text color="suggestion" bold>
            {c.t('example_label')}
          </Text>{' '}
          <Text dimColor>{f.example}</Text>
        </Text>
      )}
      {f.summary && <Markdown text={highlight(f.summary)} />}
      {card(c, 'pipeline', c.t('pipeline'), [
        <Text key="legend" dimColor>
          {kinds.map(k => (
            <Text key={`kind-${k}`}>
              <Text color={KIND_COLOR[k]}>●</Text> {c.t(`kind_${k}`)}
              {'  '}
            </Text>
          ))}
          <Text color="warning">●</Text> {c.t('changed_this')}
        </Text>,
        ...steps.map((s, i) => (
          <Box key={`step-row-${i}`} flexDirection="row" columnGap={1}>
            <Text>{i === step ? '▶' : ' '}</Text>
            <Text color={KIND_COLOR[s.kind ?? ''] ?? 'suggestion'}>{`${i + 1}`}</Text>
            <Button
              key={`step-${i}`}
              plain
              dimColor={i !== step}
              label={fit(s.title ?? '', Math.max(8, c.cols - 16))}
              onPress={() => c.act.stepTo(i)}
            />
            {s.changed ? <Text color="warning">{c.t('changed_short')}</Text> : null}
          </Box>
        )),
        <Box key="step-keys" flexDirection="row" columnGap={1}>
          <Button key="step-prev" plain hotkey="k" label={c.t('prev_step')} onPress={() => c.act.stepTo(step - 1)} />
          <Button key="step-next" plain hotkey="j" label={c.t('next_step')} onPress={() => c.act.stepTo(step + 1)} />
          <Button key="rebuild" plain hotkey="r" label={c.t('regen')} onPress={() => c.act.rebuild()} />
        </Box>,
      ])}
      {steps[step] && stepCard(c, steps[step], step)}
      {steps.length > 0 && stateCard(c, steps, step)}
      {flowCards(c, rec)}
    </Box>
  )
}

export const visibleTurns = (view: View, turns: QaTurn[]) =>
  turns
    .map(turn => {
      const failed = turn.status !== undefined && turn.status !== RecordStatus.OK
      const shown = (turn.items ?? []).filter(i => (view.showArchived || !i.archived) && !(view.openOnly && i.status === Status.ANSWERED))
      return { turn, failed, shown }
    })
    .filter(({ failed, shown }) => failed || shown.length || !(view.openOnly || view.showArchived))

export const qaPage = (view: View, turns: QaTurn[]) => {
  const all = visibleTurns(view, turns)
  const shown = all.slice(0, MAX_TURNS)
  return { shown, more: all.length - shown.length }
}

const rowIds = (shown: ReturnType<typeof visibleTurns>) =>
  shown.flatMap(({ turn, failed, shown: items }) => [...(failed ? [turnRow(turn.turn_id)] : []), ...items.map(i => i.id)])

export const isShown = (view: View, turns: QaTurn[], id: string) => rowIds(qaPage(view, turns).shown).includes(id)

export const selection = (view: View, turns: QaTurn[]): string | undefined => {
  const { shown } = qaPage(view, turns)
  if (view.selected && rowIds(shown).includes(view.selected)) {
    return view.selected
  }
  return shown.flatMap(x => x.shown).find(isOpen)?.id
}

const itemNote = (c: Ctx, item: QaItem) => {
  const first = item.first_status
  if (item.resolved_in && first) {
    return c.t('resolved', statusLabel(c, first), statusLabel(c, item.auto_status))
  }
  if (item.rechecked_at && first && first !== item.auto_status) {
    return c.t('rechecked', statusLabel(c, first), statusLabel(c, item.auto_status))
  }
  return undefined
}

const itemView = (c: Ctx, item: QaItem, n: number) => {
  const { Box, Text, Button, Markdown } = c.ui
  const tags = [
    ...(item.from === Source.MID_TURN ? [c.t('midturn')] : []),
    ...(item.archived ? [c.t('qa_archived_tag')] : []),
    ...(item.manual ? [c.t('manual').trim()] : []),
  ]
  const note = itemNote(c, item)
  return (
    <Box key={`item-box-${n}-${item.id}`} flexDirection="column">
      <Box key={`row-${n}-${item.id}`} flexDirection="row" columnGap={1}>
        <Text>{c.selected === item.id ? '▶' : ' '}</Text>
        <Text color={STATUS_COLOR[item.status ?? ''] ?? 'inactive'} bold>
          [{statusLabel(c, item.status)}]
        </Text>
        <Button key={`item-${n}-${item.id}`} plain dimColor={!!item.archived} label={item.question ?? ''} onPress={() => c.act.select(item.id)} />
        {tags.length ? <Text dimColor>{tags.join('  ')}</Text> : null}
      </Box>
      {item.answer ? <Markdown dimColor text={highlight(item.answer)} /> : null}
      {note ? <Text color="success">{`    ${note}`}</Text> : null}
    </Box>
  )
}

export const qa = (c: Ctx) => {
  const { Box, Text, Button } = c.ui
  const q = c.s?.qa
  const turns = q?.turns ?? []
  const n = counts(q)
  const filters = [c.view.openOnly ? c.t('qa_open_only') : '', c.view.showArchived ? c.t('qa_archived') : ''].filter(Boolean)
  const waiting = q?.waiting ?? []
  const eta = q?.eta ?? 0
  const selectedItem = turns.flatMap(x => x.items ?? []).find(i => i.id === c.selected)
  const top = [
    <Text key="qa-bar">
      <Text color="success">{bar(n.answered, n.total)}</Text>{' '}
      <Text dimColor>
        {n.answered}/{n.total}
      </Text>{' '}
      <Text color="success">{c.t('st_answered')}</Text>
      {n.partial ? <Text color="warning"> ◐ {n.partial}</Text> : ''}
      {n.unanswered ? <Text color="error"> ✗ {n.unanswered}</Text> : ''}
    </Text>,
    <Box key="qa-keys" flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Button key="status" plain hotkey="s" label={c.t('term_k_status')} onPress={() => c.act.cycleStatus()} />
      <Button key="auto" plain hotkey="u" label={c.t('reset_auto')} onPress={() => c.act.autoStatus()} />
      <Button key="archive" plain hotkey="a" label={c.t('term_k_archive')} onPress={() => c.act.archive()} />
      {canCopy(selectedItem) ? <Button key="copy" plain hotkey="c" label={c.t('term_k_copy')} onPress={press => c.act.copy(press)} /> : null}
      <Button key="recheck" plain hotkey="r" label={c.t('term_k_recheck')} onPress={() => c.act.recheck()} />
      <Button key="open-only" plain hotkey="f" label={c.t('qa_open_only')} dimColor={!c.view.openOnly} onPress={() => c.act.toggleOpenOnly()} />
      <Button key="archived" plain hotkey="v" label={c.t('qa_archived')} dimColor={!c.view.showArchived} onPress={() => c.act.toggleArchived()} />
    </Box>,
  ]
  if (filters.length) {
    top.push(
      <Text key="filters" color="suggestion">
        {filters.map(f => `[${f}]`).join('  ')}
      </Text>,
    )
  }
  if (q?.pending) {
    top.push(
      <Text key="checking" color="warning">
        ⠋ {c.t('qa_checking')}
      </Text>,
    )
  }
  if (waiting.length) {
    const note = q?.pending ? c.t('qa_wait_checking') : q?.auto ? c.t('qa_wait_d', eta) : c.t('qa_wait_off')
    top.push(
      card(
        c,
        'waiting',
        `⏳ ${c.t('qa_wait_t', waiting.length)}`,
        [
          <Text key="wait-note" dimColor>
            {note}
          </Text>,
          ...waiting.map((w, i) => (
            <Text key={`wait-${i}`} wrap="truncate-end">
              <Text color="warning">• </Text>
              {w.text.replace(/\n/g, ' ')}
              <Text dimColor>{w.mid_turn ? `  ${c.t('midturn')}` : ''}</Text>
            </Text>
          )),
        ],
        'warning',
      ),
    )
  } else if (!q?.pending) {
    top.push(
      <Text key="eta" dimColor>
        {c.t('qa_eta', eta)}
      </Text>,
    )
  }
  if (!turns.length) {
    return (
      <Box flexDirection="column">
        {top}
        <Text bold>{c.t('qa_empty_t')}</Text>
        <Text dimColor>{c.t('qa_empty_d')}</Text>
      </Box>
    )
  }
  const page = qaPage(c.view, turns)
  let row = 0
  const boxes = page.shown.map(({ turn, failed, shown: items }, ti) => {
    const rowId = turnRow(turn.turn_id)
    const body: RenderChildren[] = []
    if (turn.model) {
      body.push(
        <Text key="model" dimColor>
          {turn.model}
        </Text>,
      )
    }
    if (failed) {
      body.push(
        <Box key={`fail-row-${ti}`} flexDirection="row" columnGap={1}>
          <Text>{c.selected === rowId ? '▶' : ' '}</Text>
          <Text color="error" bold>
            [{c.t('qa_fail')}]
          </Text>
          <Button key={`fail-${ti}-${turn.turn_id}`} plain dimColor label={c.t('recheck_title')} onPress={() => c.act.select(rowId)} />
        </Box>,
      )
    }
    if (!failed && !items.length) {
      body.push(
        <Text key="noq" dimColor>
          {c.t('qa_noq')}
        </Text>,
      )
    }
    body.push(...items.map(item => itemView(c, item, row++)))
    const prompt = (turn.prompt ?? '').replace(/\n/g, ' ')
    return card(c, `turn-${ti}-${turn.turn_id}`, `${clock(turn.ts)} ${fit(prompt, Math.max(10, c.cols - 12))}`, body)
  })
  return (
    <Box flexDirection="column">
      {top}
      {boxes}
      {page.more > 0 && <Text dimColor>{c.t('term_more', page.more)}</Text>}
      {!page.shown.length && <Text bold>{c.t(c.view.openOnly && !c.view.showArchived ? 'qa_all_done' : 'qa_nothing_shown')}</Text>}
    </Box>
  )
}
