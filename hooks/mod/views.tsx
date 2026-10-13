import type { Elements, RenderChildren, RenderSurface, UiPressArgument } from 'claude-code'

import {
  CheckStatus,
  DiffSource,
  Kind,
  RecordStatus,
  Scope,
  Setting,
  Source,
  Status,
  ToolState,
  clock,
  counts,
  duration,
  fit,
  highlight,
  turnRow,
  type ConfigPayload,
  type FileDiff,
  type ScopeValue,
  type SettingKey,
  type FlowRecord,
  type FlowRef,
  type FlowStep,
  type PanelState,
  type QaItem,
  type QaTurn,
  type Tool,
} from './data'
import { CAT, HERO_ROWS, hero, hex, meter, mix, tint, type Canvas, type Palette, type Rgb, type Segment } from './theme'

export type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code' | 'Markdown' | 'Select'>
export type RasterTag = Elements['terminal']['Raster']

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
  help: boolean
  settings: boolean
  scope: ScopeValue
  file?: string
  toolFilter?: string
  statusFilter?: string
  note?: { text: string; color: string }
}

export type Actions = {
  setTab: (tab: TabValue) => void
  flowBy: (delta: number) => void
  flowTo: (id: string) => void
  stepTo: (step: number) => void
  select: (id: string) => void
  archive: () => void
  copy: (press: UiPressArgument) => void
  recheck: () => void
  rebuild: () => void
  toggleOpenOnly: () => void
  toggleArchived: () => void
  openBrowser: () => void
  toggleHelp: () => void
  toggleSettings: () => void
  setScope: (scope: ScopeValue) => void
  saveSetting: (key: SettingKey, value: string | boolean) => void
  unusedKey: (key: string) => void
  openFile: (path: string) => void
  fileBy: (delta: number) => void
  closeDiff: () => void
  filterTools: (state: string) => void
  filterStatus: (status: string) => void
}

export type Ctx = {
  ui: UI
  raster?: RasterTag
  p: Palette
  tick: number
  busy: boolean
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
  diff?: { path: string; loading: boolean; data?: FileDiff }
  config?: ConfigPayload
}

export const HERO_KEY = 'hero'
export const PAD = 2
const CARD_CHROME = 6
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const MAX_FILES = 30
const MAX_TOOLS = 40
const TOOLS_IN_FLOW = 12
const MAX_TURNS = 20
const LINK_SURFACES = new Set<RenderSurface>(['desktop'])
const OPEN_STATUSES = new Set<string>([Status.PARTIAL, Status.UNANSWERED])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
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
const HINTS: Record<TabValue, [string, string][]> = {
  [Tab.FLOW]: [
    ['1-3', 'term_k_tabs'],
    ['p n', 'term_k_flows'],
    ['k j', 'term_k_steps'],
    ['r', 'term_k_rebuild'],
    ['o', 'term_k_open'],
  ],
  [Tab.LIVE]: [
    ['1-3', 'term_k_tabs'],
    ['k j', 'mod_k_files'],
    ['x', 'mod_k_close_diff'],
    ['o', 'term_k_open'],
  ],
  [Tab.QA]: [
    ['1-3', 'term_k_tabs'],
    ['a', 'term_k_archive'],
    ['c', 'term_k_copy'],
    ['r', 'term_k_recheck'],
    ['f', 'term_k_open_only'],
    ['v', 'qa_archived'],
    ['o', 'term_k_open'],
  ],
}

const PANE_KEYS: [string, string][] = [
  ['ctrl+x tab', 'mod_k_focus'],
  ['tab  shift+tab', 'mod_k_controls'],
  ['↑ ↓  pgup pgdn', 'mod_k_scroll'],
  ['ctrl+x ← ↑', 'mod_k_grow'],
  ['ctrl+x → ↓', 'mod_k_shrink'],
  ['ctrl+x x', 'mod_k_close'],
  ['esc', 'mod_k_leave'],
]

const statusColor = (p: Palette, status: string | undefined): Rgb | undefined =>
  status === Status.ANSWERED ? p.green : status === Status.PARTIAL ? p.orange : status === Status.UNANSWERED ? p.red : undefined

const kindColor = (p: Palette, kind: string | undefined): Rgb => {
  switch (kind) {
    case Kind.INPUT:
    case Kind.CONFIG:
      return p.muted
    case Kind.EXTERNAL:
      return p.orange
    case Kind.STORAGE:
      return p.green
    case Kind.OUTPUT:
      return p.purple
    case Kind.TEST:
      return p.teal
    default:
      return p.blue
  }
}

const KNOWN_KINDS = new Set<string>(Object.values(Kind))

export const isOpen = (item: QaItem) => OPEN_STATUSES.has(item.status ?? '')
export const canCopy = (item: QaItem | undefined) => !!item && isOpen(item) && !item.archived && !item.manual

export const currentFlow = (flows: FlowRef[], flowId: string | undefined) => {
  const found = flows.findIndex(f => f.id === flowId)
  const index = found < 0 ? 0 : found
  return { index, ref: flows[index] }
}

export const innerCols = (cols: number) => Math.max(10, cols - 2 * PAD)
const cardCols = (c: Ctx) => Math.max(8, innerCols(c.cols) - CARD_CHROME)

export const WIDE_COLS = 78
const LEFT_MIN = 30
const LEFT_MAX = 48
const COLUMN_GAP = 2

export const split = (cols: number) => {
  const inner = innerCols(cols)
  if (cols < WIDE_COLS) {
    return undefined
  }
  const left = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.floor(((inner - COLUMN_GAP) * 2) / 5)))
  return { left, right: inner - left - COLUMN_GAP }
}

const twoColumns = (c: Ctx, key: string, left: RenderChildren[], right: RenderChildren[], leftWidth: number) => {
  const { Box } = c.ui
  return (
    <Box key={key} flexDirection="row" columnGap={COLUMN_GAP} alignItems="flex-start">
      <Box key={`${key}-left`} flexDirection="column" width={leftWidth} flexShrink={0}>
        {left}
      </Box>
      <Box key={`${key}-right`} flexDirection="column" flexGrow={1} flexShrink={1}>
        {right}
      </Box>
    </Box>
  )
}

const statusLabel = (c: Ctx, status: string | undefined) => (status && statusColor(c.p, status) ? c.t(`st_${status}`) : '-')

const pill = (c: Ctx, key: string, text: string, color: Rgb, strong = false) => {
  const { Text } = c.ui
  return (
    <Text key={key} backgroundColor={tint(c.p, color, strong ? 0.6 : 0.24)} color={hex(strong ? c.p.text : color)} bold>
      {` ${text} `}
    </Text>
  )
}

const keycap = (c: Ctx, key: string) => {
  const { Text } = c.ui
  return (
    <Text backgroundColor={hex(c.p.key)} color={hex(c.p.text)} bold>
      {` ${key} `}
    </Text>
  )
}

const rasterOf = (c: Ctx, key: string, canvas: Canvas) => {
  const Raster = c.raster
  return Raster ? <Raster key={key} columns={canvas.columns} rows={canvas.rows} cells={canvas.encode()} /> : null
}

const bar = (c: Ctx, key: string, segments: Segment[], total: number, cols: number, gap = false) => {
  const { Text } = c.ui
  const drawn = rasterOf(c, key, meter(c.p, cols, segments, total, gap))
  if (drawn) {
    return drawn
  }
  let used = 0
  const parts = segments.map((seg, i) => {
    const width = total ? Math.round((cols * seg.value) / total) : 0
    used += width
    return (
      <Text key={`${key}-${i}`} color={hex(seg.color)}>
        {'▆'.repeat(width)}
      </Text>
    )
  })
  return (
    <Text key={key}>
      {parts}
      <Text color={hex(c.p.line)}>{'▆'.repeat(Math.max(0, cols - used))}</Text>
    </Text>
  )
}

export const heroCanvas = (p: Palette, cols: number, busy: boolean, tick: number) => hero(p, innerCols(cols), busy, tick)

const banner = (c: Ctx) => {
  const { Box, Text } = c.ui
  const busy = c.busy
  const drawn = rasterOf(c, HERO_KEY, heroCanvas(c.p, c.cols, busy, c.tick))
  if (drawn) {
    return drawn
  }
  return (
    <Box key="hero-text" backgroundColor={hex(c.p.hero[1] ?? c.p.blue)} paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text color={hex(c.p.heroText)} bold>
        ◆ side insights
      </Text>
      <Text color={hex(c.p.cat)} bold>
        {busy ? `⠂⠂${CAT}⠂⠂⠂` : `${CAT} zZ`}
      </Text>
    </Box>
  )
}

export const header = (c: Ctx) => {
  const { Box, Text, Button, Link } = c.ui
  const busy = c.busy
  const where = (c.s?.activity.cwd ?? '').replace(/\/+$/, '').split('/').pop() || '-'
  return (
    <Box key="header" flexDirection="column">
      {banner(c)}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        {TAB_KEYS.map(([key, tab]) => {
          const on = c.view.tab === tab
          return (
            <Button key={`tab-${tab}`} plain hotkey={key} onPress={() => c.act.setTab(tab)}>
              <Text backgroundColor={on ? tint(c.p, c.p.blue, 0.6) : tint(c.p, c.p.line, 0.6)} color={hex(on ? c.p.text : c.p.muted)} bold={on}>
                {` ${c.t(`mode_${tab}`)} `}
              </Text>
            </Button>
          )
        })}
        <Text>
          {busy ? (
            <Text color={hex(c.p.orange)} bold>
              {`${SPINNER[c.tick % SPINNER.length]} ${c.t('busy')}`}
            </Text>
          ) : (
            <Text color={hex(c.p.faint)}>{`○ ${c.t('idle')}`}</Text>
          )}
          <Text color={hex(c.p.faint)}>{`  ${where}`}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="open" plain hotkey="o" label={c.t('full')} dimColor onPress={() => c.act.openBrowser()} />
        {c.pageUrl && LINK_SURFACES.has(c.surface) ? <Link href={c.pageUrl} label={c.t('full_title')} /> : null}
      </Box>
      {c.problem ? (
        <Box marginTop={1} borderStyle="round" borderColor={hex(c.p.red)} paddingX={1}>
          <Text color={hex(c.p.red)} bold>
            {c.problem}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

const ALL_KEYS = [...'0123456789abcdefghijklmnopqrstuvwxyz']

export const keyCatcher = (c: Ctx) => {
  const { Box, Button } = c.ui
  return (
    <Box key="key-catcher" display="none">
      {ALL_KEYS.map(key => (
        <Button key={`unused-${key}`} plain hotkey={key} label={key} onPress={() => c.act.unusedKey(key)} />
      ))}
    </Box>
  )
}

export const footer = (c: Ctx) => {
  const { Box, Text, Button } = c.ui
  if (c.view.note) {
    return (
      <Box key="footer" marginTop={1}>
        <Text color={c.view.note.color} bold>
          {`▌ ${c.view.note.text}`}
        </Text>
      </Box>
    )
  }
  return (
    <Box key="footer" marginTop={1} flexDirection="row" flexWrap="wrap" columnGap={2}>
      {HINTS[c.view.tab].map(([key, label]) => (
        <Text key={`hint-${key}`}>
          {keycap(c, key)}
          <Text color={hex(c.p.muted)}>{` ${c.t(label)}`}</Text>
        </Text>
      ))}
      <Button key="help" plain hotkey="h" label={c.t(c.view.help ? 'mod_help_close' : 'term_k_help')} onPress={() => c.act.toggleHelp()} />
      <Button key="settings" plain hotkey="g" label={c.view.settings ? c.t('mod_settings_close') : c.t('settings')} onPress={() => c.act.toggleSettings()} />
    </Box>
  )
}

const keyRows = (c: Ctx, rows: [string, string][]) => {
  const { Box, Text } = c.ui
  const width = Math.max(...rows.map(([key]) => key.length)) + 2
  return rows.map(([key, label]) => (
    <Box key={`help-${key}`} flexDirection="row" columnGap={2}>
      <Box width={width} flexShrink={0}>
        {keycap(c, key)}
      </Box>
      <Text color={hex(c.p.text)}>{c.t(label)}</Text>
    </Box>
  ))
}

const ON = '1'
const OFF = '0'
const SETTING_LABEL = 28

export const settings = (c: Ctx) => {
  const { Box, Text, Select } = c.ui
  const cfg = c.config
  if (!cfg?.effective) {
    return card(c, 'settings-view', c.t('settings'), [<Text key="settings-loading" color={hex(c.p.faint)}>{c.t('loading')}</Text>], c.p.blue)
  }
  const values = c.view.scope === Scope.PANE ? cfg.effective : (cfg.global ?? cfg.effective)
  const onOff = [
    { value: ON, label: c.t('on') },
    { value: OFF, label: c.t('off') },
  ]
  const row = (key: string, label: string, control: RenderChildren) => (
    <Box key={`setting-${key}`} flexDirection="row" columnGap={2}>
      <Box width={SETTING_LABEL} flexShrink={0}>
        <Text color={hex(c.p.text)}>{label}</Text>
      </Box>
      {control}
    </Box>
  )
  const toggle = (key: SettingKey) => (
    <Select key={`set-${key}`} options={onOff} value={values[key as keyof typeof values] ? ON : OFF} onSelect={v => c.act.saveSetting(key, v === ON)} />
  )
  return (
    <Box key="settings-view" flexDirection="column">
      {card(
        c,
        'settings-card',
        c.t('settings'),
        [
          row(
            'scope',
            c.t('scope_label'),
            <Select
              key="set-scope"
              options={[
                { value: Scope.GLOBAL, label: c.t('scope_global') },
                { value: Scope.PANE, label: c.t('scope_pane') },
              ]}
              value={c.view.scope}
              onSelect={v => c.act.setScope(v === Scope.PANE ? Scope.PANE : Scope.GLOBAL)}
            />,
          ),
          row(
            Setting.LANG,
            c.t('s_lang'),
            <Select key="set-lang" options={(cfg.langs ?? []).map(l => ({ value: l.code, label: l.label }))} value={values.lang} onSelect={v => c.act.saveSetting(Setting.LANG, v)} />,
          ),
          row(
            Setting.MODEL,
            c.t('s_model'),
            <Select key="set-model" options={(cfg.models ?? []).map(m => ({ value: m, label: m }))} value={values.model} onSelect={v => c.act.saveSetting(Setting.MODEL, v)} />,
          ),
          row(Setting.FLOW_AUTO, c.t('s_flow_auto'), toggle(Setting.FLOW_AUTO)),
          row(Setting.QA_AUTO, c.t('s_qa_auto'), toggle(Setting.QA_AUTO)),
          row(Setting.PANEL_AUTO, c.t('s_panel_auto'), toggle(Setting.PANEL_AUTO)),
          <Box key="settings-note" marginTop={1}>
            <Text color={hex(c.p.muted)}>{c.t('mod_settings_note')}</Text>
          </Box>,
        ],
        c.p.blue,
      )}
    </Box>
  )
}

export const help = (c: Ctx) => {
  const { Box, Text } = c.ui
  const panel: [string, string][] = [...Object.values(HINTS).flat(), ['h', 'k_help']].filter(
    ([key, label], i, all) => all.findIndex(([k, l]) => k === key && l === label) === i,
  )
  return (
    <Box key="help-view" flexDirection="column">
      {card(c, 'help-panel', c.t('mod_help_panel'), keyRows(c, panel), c.p.blue)}
      {card(c, 'help-cc', c.t('mod_help_cc'), [...keyRows(c, PANE_KEYS), <Box key="help-drag" marginTop={1}><Text color={hex(c.p.muted)}>{c.t('mod_k_drag')}</Text></Box>], c.p.purple)}
    </Box>
  )
}

const card = (c: Ctx, key: string, title: RenderChildren, children: RenderChildren[], color?: Rgb) => {
  const { Box, Text } = c.ui
  const edge = color ?? c.p.line
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={hex(edge)} backgroundColor={hex(c.p.card)} paddingX={2} paddingY={1} marginTop={1}>
      <Box marginBottom={1}>
        <Text color={hex(color ?? c.p.text)} bold>
          {title}
        </Text>
      </Box>
      <Box flexDirection="column" rowGap={0}>
        {children}
      </Box>
    </Box>
  )
}

const tile = (c: Ctx, key: string, value: string | number, label: string, color: Rgb, dim = false, press?: { on: boolean; act: () => void }) => {
  const { Box, Text, Button } = c.ui
  const on = !!press?.on
  const body = [
    <Text key={`${key}-value`} color={hex(dim && !on ? c.p.faint : color)} bold>
      {String(value)}
    </Text>,
    <Text key={`${key}-label`} color={hex(on ? c.p.text : c.p.muted)} bold={on}>
      {`\n${label}`}
    </Text>,
  ]
  return (
    <Box key={key} flexDirection="column" borderStyle={on ? 'bold' : 'round'} borderColor={hex(dim && !on ? c.p.line : color)} backgroundColor={on ? tint(c.p, color, 0.18) : hex(c.p.card)} paddingX={2} flexGrow={1} minWidth={14}>
      {press ? (
        <Button key={`${key}-press`} plain onPress={press.act}>
          {body}
        </Button>
      ) : (
        body
      )}
    </Box>
  )
}

const tiles = (c: Ctx, key: string, children: RenderChildren[]) => {
  const { Box } = c.ui
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {children}
    </Box>
  )
}

const relative = (c: Ctx, path: string) => {
  const cwd = c.s?.activity.cwd
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

const diffSourceLabel = (c: Ctx, data: FileDiff) =>
  data.source === DiffSource.WORKING
    ? c.t('mod_diff_working')
    : data.source === DiffSource.NEW
      ? c.t('mod_diff_new')
      : data.source === DiffSource.COMMIT
        ? c.t('mod_diff_commit', data.commit ?? '')
        : c.t('mod_diff_none')

const diffCard = (c: Ctx) => {
  const { Box, Text, Button, Code } = c.ui
  const d = c.diff
  if (!d) {
    return null
  }
  const body: RenderChildren[] = []
  if (d.loading || !d.data) {
    body.push(
      <Text key="diff-loading" color={hex(c.p.faint)}>
        {c.t('mod_diff_loading')}
      </Text>,
    )
  } else {
    body.push(
      <Text key="diff-source" color={hex(d.data.source === DiffSource.NONE ? c.p.orange : c.p.muted)}>
        {diffSourceLabel(c, d.data)}
      </Text>,
    )
    if (d.data.error) {
      body.push(
        <Text key="diff-error" color={hex(c.p.faint)}>
          {d.data.error}
        </Text>,
      )
    }
    if (d.data.hunks) {
      body.push(
        <Box key="diff-code" marginTop={1}>
          <Code source={d.data.hunks} format="diff" path={d.path} />
        </Box>,
      )
    }
    if (d.data.cut) {
      body.push(
        <Text key="diff-cut" color={hex(c.p.faint)}>
          {c.t('mod_diff_cut', d.data.cut)}
        </Text>,
      )
    }
  }
  body.push(
    <Box key="diff-keys" marginTop={1}>
      <Button key="diff-close" plain hotkey="x" label={c.t('mod_k_close_diff')} dimColor onPress={() => c.act.closeDiff()} />
    </Box>,
  )
  return card(c, 'diff', c.t('mod_diff_title', relative(c, d.path)), body, c.p.teal)
}

const toolLine = (c: Ctx, tool: Tool, i: number, now: number) => {
  const { Text } = c.ui
  const [mark, color] =
    tool.state === ToolState.OK
      ? ['✓', c.p.green]
      : tool.state === ToolState.ERR
        ? ['✗', c.p.red]
        : tool.state === ToolState.RUN
          ? [SPINNER[c.tick % SPINNER.length] ?? '⠋', c.p.orange]
          : ['–', c.p.faint]
  const end = tool.state === ToolState.RUN ? now : tool.end
  const took = tool.start && end ? duration(end - tool.start) : ''
  const name = tool.label || tool.tool
  const nameColor = EDIT_TOOLS.has(tool.tool) ? c.p.purple : tool.tool.startsWith('mcp__') ? c.p.teal : c.p.blue
  const what = (tool.file ? relative(c, tool.file) : tool.summary) ?? ''
  return (
    <Text key={`tool-${i}`} wrap="truncate-end">
      <Text color={hex(color)} bold>
        {mark}
      </Text>{' '}
      <Text color={hex(c.p.faint)}>{clock(tool.start, true)}</Text>{' '}
      <Text color={hex(nameColor)} bold>
        {name}
      </Text>{' '}
      <Text color={hex(c.p.text)}>{what}</Text> <Text color={hex(c.p.faint)}>{took}</Text>
    </Text>
  )
}

const FILTER_LABEL: Record<string, string> = { [ToolState.OK]: 'term_ok', [ToolState.ERR]: 'term_err', [ToolState.RUN]: 'term_run' }

const statusPress = (c: Ctx, status: string) => ({ on: c.view.statusFilter === status, act: () => c.act.filterStatus(status) })

const filterPress = (c: Ctx, state: string) => ({ on: c.view.toolFilter === state, act: () => c.act.filterTools(state) })

export const live = (c: Ctx) => {
  const { Box, Text, Button } = c.ui
  const tools = c.s?.activity.tools ?? []
  const files = [...(c.s?.activity.files ?? [])].sort((a, b) => b.last - a.last)
  const ok = tools.filter(x => x.state === ToolState.OK).length
  const failed = tools.filter(x => x.state === ToolState.ERR).length
  const running = tools.filter(x => x.state === ToolState.RUN).length
  const now = Date.now() / 1000
  const fileLines = files.slice(0, MAX_FILES).map((f, i) => {
    const on = c.view.file === f.path
    return (
      <Box key={`file-row-${i}`} flexDirection="row" columnGap={1} backgroundColor={on ? hex(c.p.selected) : undefined}>
        <Text color={hex(c.p.yellow)}>{on ? '▶' : ' '}</Text>
        <Button key={`file-${i}`} plain onPress={() => c.act.openFile(f.path)}>
          {pill(c, `file-mark-${i}`, f.created ? 'A' : 'M', f.created ? c.p.green : c.p.orange)}
          <Text color={hex(c.p.text)}>{` ${relative(c, f.path)}`}</Text>
          <Text color={hex(c.p.faint)}>{f.count > 1 ? ` ×${f.count}` : ''}</Text>
        </Button>
      </Box>
    )
  })
  if (files.length > MAX_FILES) {
    fileLines.push(
      <Text key="files-more" color={hex(c.p.faint)}>
        {c.t('term_more', files.length - MAX_FILES)}
      </Text>,
    )
  }
  const filter = c.view.toolFilter
  const shownTools = filter ? tools.filter(x => x.state === filter) : tools
  const toolLines = [...shownTools]
    .reverse()
    .slice(0, MAX_TOOLS)
    .map((tool, i) => toolLine(c, tool, i, now))
  if (files.length) {
    fileLines.push(
      <Box key="file-keys" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
        <Button key="file-prev" plain hotkey="k" label={`↑ ${c.t('mod_prev_file')}`} onPress={() => c.act.fileBy(-1)} />
        <Button key="file-next" plain hotkey="j" label={`↓ ${c.t('mod_next_file')}`} onPress={() => c.act.fileBy(1)} />
      </Box>,
    )
  }
  fileLines.push(
    <Box key="files-note" marginTop={1}>
      <Text color={hex(c.p.faint)}>{c.t('mod_edited_note')}</Text>
    </Box>,
  )
  const filesCard = card(c, 'files', c.t('mod_edited_files', files.length), fileLines.length > 1 ? fileLines : [<Text key="files-none" color={hex(c.p.faint)}>{c.t('term_none')}</Text>, ...fileLines], files.length ? c.p.purple : undefined)
  const toolsTitle = filter ? `${c.t('term_tools', `${shownTools.length} / ${tools.length}`)}  ${c.t(FILTER_LABEL[filter] ?? 'term_ok')}` : c.t('term_tools', tools.length)
  const toolsCard = card(c, 'tools', toolsTitle, toolLines.length ? toolLines : [<Text key="tools-none" color={hex(c.p.faint)}>{c.t(filter ? 'mod_filter_none' : 'term_not_yet')}</Text>], tools.length ? c.p.blue : undefined)
  const wide = split(c.cols)
  const layout = wide ? twoColumns(c, 'live-cols', [filesCard], [toolsCard], wide.left) : [filesCard, toolsCard]
  const diff = diffCard(c)
  return (
    <Box flexDirection="column">
      {tiles(c, 'live-tiles', [
        tile(c, 'tile-ok', ok, c.t('term_ok'), c.p.green, !ok, filterPress(c, ToolState.OK)),
        tile(c, 'tile-err', failed, c.t('term_err'), c.p.red, !failed, filterPress(c, ToolState.ERR)),
        tile(c, 'tile-run', running, c.t('term_run'), c.p.orange, !running, filterPress(c, ToolState.RUN)),
        tile(c, 'tile-files', files.length, c.t('mod_edited_tile'), c.p.purple, !files.length),
      ])}
      <Box marginTop={1}>
        {bar(
          c,
          'live-bar',
          [
            { value: ok, color: c.p.green },
            { value: failed, color: c.p.red },
            { value: running, color: c.p.orange },
          ],
          tools.length,
          innerCols(c.cols),
        )}
      </Box>
      {diff}
      {layout}
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
        <Text color={hex(c.p.yellow)}>{now ? '●' : ' '}</Text>{' '}
        <Text color={hex(now ? c.p.blue : c.p.faint)} bold={now}>
          {name}
        </Text>
        {'  '}
        {moved ? (
          <Text>
            <Text color={hex(c.p.faint)} strikethrough>
              {String(d.before)}
            </Text>
            <Text color={hex(c.p.yellow)}>{' → '}</Text>
            <Text color={hex(c.p.text)} bold>
              {String(d.after ?? '')}
            </Text>
          </Text>
        ) : (
          <Text color={hex(now ? c.p.text : c.p.muted)}>{String(d.after ?? '')}</Text>
        )}
      </Text>
    )
  })
  const changed = [...values.values()].some(v => v.now)
  return card(c, 'state', c.t('state_title'), lines.length ? lines : [<Text key="state-none" color={hex(c.p.faint)}>{c.t('state_empty')}</Text>], changed ? c.p.yellow : undefined)
}

const language = (location: string | undefined) => {
  const file = (location ?? '').split(' ')[0] ?? ''
  const ext = file.includes('.') ? (file.split('.').pop() ?? '') : ''
  return LANGUAGE[ext]
}

type Change = NonNullable<NonNullable<FlowRecord['flow']>['changes']>[number]

const sameFile = (a: string, b: string) => {
  const x = a.replace(/^~\//, '')
  const y = b.replace(/^~\//, '')
  return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`))
}

export const stepChanges = (s: FlowStep, changes: Change[]) => {
  const file = (s.location ?? '').split(' ')[0] ?? ''
  return file ? changes.filter(ch => ch.file && sameFile(ch.file, file)) : []
}

const stepChangeList = (c: Ctx, own: Change[]) => {
  const { Box, Text, Button } = c.ui
  return (
    <Box key="step-changes" flexDirection="column" marginTop={1}>
      <Text color={hex(c.p.orange)} bold>
        {c.t('mod_step_changes')}
      </Text>
      {own.map((ch, i) => (
        <Box key={`step-chg-${i}`} flexDirection="column" backgroundColor={ch.file && c.view.file === ch.file ? hex(c.p.selected) : undefined}>
          <Button key={`step-change-${i}`} plain onPress={() => ch.file && c.act.openFile(ch.file)}>
            {pill(c, `step-chg-mark-${i}`, 'M', c.p.orange)}
            <Text color={hex(c.p.text)}>{` ${ch.file ?? ''}`}</Text>
          </Button>
          <Box paddingLeft={4}>
            <Text color={hex(c.p.muted)}>{ch.what ?? ''}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

const stepCard = (c: Ctx, s: FlowStep, step: number, total: number, changes: Change[] = []) => {
  const { Box, Text, Code, Markdown } = c.ui
  const color = kindColor(c.p, s.kind)
  const lang = language(s.location)
  const hits = (s.highlight ?? []).filter(Boolean)
  const kind = s.kind && KNOWN_KINDS.has(s.kind) ? s.kind : Kind.LOGIC
  const body = [
    <Text key="tags">
      {pill(c, 'step-kind', c.t(`kind_${kind}`), color)}
      {s.changed ? <Text> {pill(c, 'step-changed', c.t('changed_short'), c.p.yellow)}</Text> : null}
      <Text color={hex(c.p.faint)}>{`  ${step + 1}/${total}`}</Text>
    </Text>,
    <Text key="where" color={hex(c.p.faint)} wrap="truncate-start">
      {s.location ?? ''}
    </Text>,
    <Box key="explain" marginTop={1}>
      <Markdown text={highlight(s.explanation ?? '')} />
    </Box>,
  ]
  if (s.code) {
    body.push(
      <Box key="code" marginTop={1} flexDirection="column" backgroundColor={hex(c.p.code)} paddingX={1} paddingY={1}>
        <Code source={s.code} startLine={1} {...(lang ? { language: lang } : {})} />
      </Box>,
    )
  }
  if (hits.length) {
    const lines = (s.code ?? '').split('\n')
    body.push(
      <Box key="hits" flexDirection="column" marginTop={1}>
        <Text color={hex(c.p.yellow)} bold>
          {c.t('mod_key_lines')}
        </Text>
        {hits.map((hit, i) => {
          const at = lines.findIndex(l => l.includes(hit))
          return (
            <Text key={`hit-${i}`} wrap="truncate-end">
              <Text color={hex(c.p.yellow)}>{'▌ '}</Text>
              <Text color={hex(c.p.faint)}>{at < 0 ? '  ' : String(at + 1).padStart(2, ' ')}</Text>
              <Text color={hex(c.p.text)}>{`  ${hit.trim()}`}</Text>
            </Text>
          )
        })}
      </Box>,
    )
  }
  const own = stepChanges(s, changes)
  if (own.length) {
    body.push(stepChangeList(c, own))
  }
  return card(c, 'step', `${step + 1}. ${s.title ?? ''}`, body, color)
}

const flowCards = (c: Ctx, rec: FlowRecord) => {
  const { Box, Text, Button, Markdown } = c.ui
  const flow = rec.flow ?? {}
  const out: RenderChildren[] = []
  const changes = flow.changes ?? []
  if (changes.length) {
    out.push(
      card(
        c,
        'changes',
        c.t('changes', changes.length),
        changes.map((ch, i) => (
          <Box key={`chg-${i}`} flexDirection="column" marginTop={i ? 1 : 0} backgroundColor={ch.file && c.view.file === ch.file ? hex(c.p.selected) : undefined}>
            <Button key={`change-${i}`} plain onPress={() => ch.file && c.act.openFile(ch.file)}>
              {pill(c, `chg-mark-${i}`, 'M', c.p.orange)}
              <Text color={hex(c.p.text)}>{` ${ch.file ?? ''}`}</Text>
            </Button>
            <Box paddingLeft={4}>
              <Text color={hex(c.p.muted)}>{ch.what ?? ''}</Text>
            </Box>
          </Box>
        )),
        c.p.orange,
      ),
    )
    const diff = diffCard(c)
    if (diff) {
      out.push(diff)
    }
  }
  const checks = flow.checks ?? []
  if (checks.length) {
    const failing = checks.some(ck => ck.status === CheckStatus.FAIL)
    out.push(
      card(
        c,
        'checks',
        c.t('checks'),
        checks.map((ck, i) => {
          const [mark, color] = ck.status === CheckStatus.PASS ? ['✓', c.p.green] : ck.status === CheckStatus.FAIL ? ['✗', c.p.red] : ['?', c.p.faint]
          return (
            <Text key={`chk-${i}`}>
              <Text color={hex(color)} bold>
                {mark}
              </Text>{' '}
              <Text color={hex(c.p.text)}>{ck.label ?? ''}</Text>
            </Text>
          )
        }),
        failing ? c.p.red : c.p.green,
      ),
    )
  }
  if (rec.prompt) {
    const meta = [rec.model, rec.cost ? `$${rec.cost.toFixed(3)}` : ''].filter(Boolean).join(' / ')
    out.push(card(c, 'request', c.t('request'), [<Markdown key="prompt" dimColor text={rec.prompt} />, ...(meta ? [<Text key="meta" color={hex(c.p.faint)}>{meta}</Text>] : [])]))
  }
  const now = Date.now() / 1000
  const tools = (c.s?.activity.tools ?? []).filter(x => !rec.ts || (x.start ?? 0) <= rec.ts).slice(-TOOLS_IN_FLOW)
  if (tools.length) {
    out.push(card(c, 'flow-tools', c.t('term_tools', tools.length), [...tools].reverse().map((x, i) => toolLine(c, x, i, now))))
  }
  return out
}

const empty = (c: Ctx, key: string, title: string, detail: string, top: RenderChildren[] = []) => {
  const { Box, Text } = c.ui
  return (
    <Box key={key} flexDirection="column">
      {top}
      <Box flexDirection="column" borderStyle="round" borderColor={hex(c.p.line)} paddingX={2} paddingY={1} marginTop={1} alignItems="center">
        <Text color={hex(c.p.cat)}>{`${CAT}  zZ`}</Text>
        <Text color={hex(c.p.text)} bold>
          {title}
        </Text>
        <Text color={hex(c.p.muted)}>{detail}</Text>
      </Box>
    </Box>
  )
}

const stepSegments = (c: Ctx, steps: FlowStep[], step: number): Segment[] =>
  steps.map((s, i) => {
    const color = kindColor(c.p, s.kind)
    return { value: 1, color: i === step ? mix(color, c.p.heroText, 0.3) : i < step ? color : mix(c.p.base, color, 0.3) }
  })

const FLOW_LIST_ROWS = 5
const FLOW_ROW_CHROME = 12

export const flowWindow = (count: number, index: number, rows = FLOW_LIST_ROWS) => {
  const first = Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows))
  return { first, last: Math.min(count, first + rows) - 1 }
}

const flowList = (c: Ctx, flows: FlowRef[], index: number) => {
  const { Box, Text, Button } = c.ui
  const { first, last } = flowWindow(flows.length, index)
  const width = innerCols(c.cols) - FLOW_ROW_CHROME
  return (
    <Box key="flow-list" flexDirection="column" marginTop={1}>
      <Box key="flow-nav" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={hex(c.p.text)} bold>
          {c.t('mod_flows', flows.length)}
        </Text>
        <Button key="flow-prev" plain hotkey="p" label={`‹ ${c.t('mod_prev_flow')}`} dimColor={index === 0} onPress={() => c.act.flowBy(-1)} />
        <Button key="flow-next" plain hotkey="n" label={`${c.t('mod_next_flow')} ›`} dimColor={index === flows.length - 1} onPress={() => c.act.flowBy(1)} />
      </Box>
      {first > 0 ? <Text key="flow-list-before" color={hex(c.p.faint)}>{`   ${c.t('mod_flows_newer', first)}`}</Text> : null}
      {flows.slice(first, last + 1).map((f, i) => {
        const at = first + i
        const on = at === index
        const failed = f.status !== RecordStatus.OK
        return (
          <Box key={`flow-row-${f.id}`} flexDirection="row" backgroundColor={on ? hex(c.p.selected) : undefined}>
            <Button key={`flow-tab-${f.id}`} plain onPress={() => c.act.flowTo(f.id)}>
              <Text color={hex(on ? c.p.yellow : failed ? c.p.red : c.p.faint)}>{on ? ' ▶ ' : failed ? ' ✗ ' : '   '}</Text>
              <Text color={hex(c.p.faint)}>{`${clock(f.ts)}  `}</Text>
              <Text color={hex(on ? c.p.text : c.p.muted)} bold={on}>
                {fit(f.title || '-', Math.max(10, width))}
              </Text>
            </Button>
          </Box>
        )
      })}
      {last + 1 < flows.length ? <Text key="flow-list-after" color={hex(c.p.faint)}>{`   ${c.t('mod_flows_older', flows.length - last - 1)}`}</Text> : null}
    </Box>
  )
}

export const flow = (c: Ctx) => {
  const { Box, Text, Button, Markdown } = c.ui
  const flows = c.s?.flows ?? []
  const top: RenderChildren[] = []
  if (c.s?.pending) {
    top.push(
      <Text key="flow-gen" color={hex(c.p.orange)} bold>
        {`${SPINNER[c.tick % SPINNER.length]} ${c.t('flow_gen')}`}
      </Text>,
    )
  }
  if (!flows.length) {
    return empty(c, 'flow-empty', c.t('flow_empty_t'), c.t('flow_empty_d'), top)
  }
  const { index, ref } = currentFlow(flows, c.view.flowId)
  if (flows.length > 1) {
    top.push(
      flowList(c, flows, index),
    )
  }
  const rec = c.flow
  if (!rec || c.flowLoading) {
    return empty(c, 'flow-loading', ref?.title ?? '', c.t('loading'), top)
  }
  if (rec.status !== RecordStatus.OK) {
    return (
      <Box flexDirection="column">
        {top}
        {card(c, 'flow-fail', c.t('flow_fail'), [<Text key="flow-title" color={hex(c.p.text)} bold>{ref?.title ?? ''}</Text>, <Text key="flow-error" color={hex(c.p.muted)}>{rec.error ?? ''}</Text>], c.p.red)}
      </Box>
    )
  }
  const f = rec.flow ?? {}
  const steps = f.steps ?? []
  const step = Math.max(0, Math.min(c.view.step, steps.length - 1))
  const kinds = [...new Set(steps.map(s => (s.kind && KNOWN_KINDS.has(s.kind) ? s.kind : Kind.LOGIC)))]
  const wide = split(c.cols)
  const width = wide ? Math.max(8, wide.left - CARD_CHROME) : cardCols(c)
  const pipeline = card(c, 'pipeline', c.t('pipeline'), [
        <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={3} marginBottom={1}>
          {kinds.map(k => (
            <Text key={`kind-${k}`}>
              <Text color={hex(kindColor(c.p, k))}>●</Text>
              <Text color={hex(c.p.muted)}>{` ${c.t(`kind_${k}`)}`}</Text>
            </Text>
          ))}
          <Text key="kind-changed">
            <Text color={hex(c.p.yellow)}>●</Text>
            <Text color={hex(c.p.muted)}>{` ${c.t('changed_this')}`}</Text>
          </Text>
        </Box>,
        ...(steps.length ? [<Box key="step-bar" marginBottom={1}>{bar(c, 'step-bar', stepSegments(c, steps, step), steps.length, width, true)}</Box>] : []),
        ...steps.map((s, i) => {
          const color = kindColor(c.p, s.kind)
          const on = i === step
          return (
            <Box key={`step-row-${i}`} flexDirection="row" columnGap={1} backgroundColor={on ? hex(c.p.selected) : undefined}>
              <Text color={hex(on ? c.p.yellow : color)} bold>
                {on ? '▶' : '▍'}
              </Text>
              <Text backgroundColor={tint(c.p, color, on ? 0.6 : 0.22)} color={hex(on ? c.p.text : color)} bold>
                {` ${i + 1} `}
              </Text>
              <Text key={`changed-${i}`} color={hex(c.p.yellow)}>
                {s.changed ? '●' : ' '}
              </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Button key={`step-${i}`} plain dimColor={!on} label={s.title ?? ''} onPress={() => c.act.stepTo(i)} />
              </Box>
            </Box>
          )
        }),
        <Box key="step-keys" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Button key="step-prev" plain hotkey="k" label={`↑ ${c.t('prev_step')}`} dimColor={step === 0} onPress={() => c.act.stepTo(step - 1)} />
          <Button key="step-next" plain hotkey="j" label={`↓ ${c.t('next_step')}`} dimColor={step >= steps.length - 1} onPress={() => c.act.stepTo(step + 1)} />
          <Button key="rebuild" plain hotkey="r" label={c.t('regen')} dimColor onPress={() => c.act.rebuild()} />
        </Box>,
      ])
  const detail = [...(steps[step] ? [stepCard(c, steps[step], step, steps.length, f.changes ?? [])] : []), ...(steps.length > 0 ? [stateCard(c, steps, step)] : [])]
  return (
    <Box flexDirection="column">
      {top}
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={hex(c.p.text)} bold>
            {f.title ?? ''}
          </Text>
          <Text color={hex(c.p.faint)}>{`  ${clock(rec.ts)}`}</Text>
        </Text>
        {f.example ? (
          <Text key="example-line">
            {pill(c, 'example', c.t('example_label'), c.p.blue)} <Text color={hex(c.p.muted)}>{f.example}</Text>
          </Text>
        ) : null}
        {f.summary ? (
          <Box marginTop={1}>
            <Markdown text={highlight(f.summary)} />
          </Box>
        ) : null}
      </Box>
      {wide ? twoColumns(c, 'flow-cols', [pipeline], detail, wide.left) : [pipeline, ...detail]}
      {flowCards(c, rec)}
    </Box>
  )
}

export const visibleTurns = (view: View, turns: QaTurn[]) =>
  turns
    .map(turn => {
      const failed = turn.status !== undefined && turn.status !== RecordStatus.OK
      const shown = (turn.items ?? []).filter(
        i => (view.showArchived || !i.archived) && !(view.openOnly && i.status === Status.ANSWERED) && (!view.statusFilter || i.status === view.statusFilter),
      )
      return { turn, failed, shown }
    })
    .filter(({ failed, shown }) => failed || shown.length || !(view.openOnly || view.showArchived || view.statusFilter))

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
  const color = statusColor(c.p, item.status) ?? c.p.faint
  const on = c.selected === item.id
  const tags = [
    ...(item.from === Source.MID_TURN ? [c.t('midturn')] : []),
    ...(item.archived ? [c.t('qa_archived_tag')] : []),
    ...(item.manual ? [c.t('manual').trim()] : []),
  ]
  const note = itemNote(c, item)
  return (
    <Box key={`item-box-${n}-${item.id}`} flexDirection="column" backgroundColor={on ? hex(c.p.selected) : undefined} marginTop={n ? 1 : 0}>
      <Box key={`row-${n}-${item.id}`} flexDirection="row" columnGap={1}>
        <Text color={hex(on ? c.p.yellow : color)} bold>
          {on ? '▶' : '▍'}
        </Text>
        {pill(c, `chip-${n}`, statusLabel(c, item.status), color)}
        {tags.length ? <Text color={hex(c.p.faint)}>{tags.join('  ')}</Text> : null}
      </Box>
      <Box flexDirection="row" paddingLeft={2}>
        <Button key={`item-${n}-${item.id}`} plain dimColor={!!item.archived} label={item.question ?? ''} onPress={() => c.act.select(item.id)} />
      </Box>
      {item.answer ? (
        <Box flexDirection="row" paddingLeft={2} columnGap={1} marginTop={1}>
          <Text color={hex(mix(c.p.base, color, 0.6))}>│</Text>
          <Markdown dimColor text={highlight(item.answer)} />
        </Box>
      ) : null}
      {note ? <Text color={hex(c.p.green)}>{`    ↺ ${note}`}</Text> : null}
    </Box>
  )
}

export const qa = (c: Ctx) => {
  const { Box, Text, Button } = c.ui
  const q = c.s?.qa
  const turns = q?.turns ?? []
  const n = counts(q)
  const waiting = q?.waiting ?? []
  const eta = q?.eta ?? 0
  const selectedItem = turns.flatMap(x => x.items ?? []).find(i => i.id === c.selected)
  const percent = n.total ? Math.round((100 * n.answered) / n.total) : 0
  const top: RenderChildren[] = [
    tiles(c, 'qa-tiles', [
      tile(c, 'tile-answered', n.answered, c.t('st_answered'), c.p.green, !n.answered, statusPress(c, Status.ANSWERED)),
      tile(c, 'tile-partial', n.partial, c.t('st_partial'), c.p.orange, !n.partial, statusPress(c, Status.PARTIAL)),
      tile(c, 'tile-unanswered', n.unanswered, c.t('st_unanswered'), c.p.red, !n.unanswered, statusPress(c, Status.UNANSWERED)),
      ...(waiting.length ? [tile(c, 'tile-waiting', waiting.length, `⏳ ${c.t('qa_wait_t', '').replace(/\s*\(\s*\)\s*$/, '')}`, c.p.blue)] : []),
    ]),
    <Box key="qa-meter" flexDirection="row" columnGap={1} marginTop={1}>
      {bar(
        c,
        'qa-bar',
        [
          { value: n.answered, color: c.p.green },
          { value: n.partial, color: c.p.orange },
          { value: n.unanswered, color: c.p.red },
        ],
        n.total,
        Math.max(8, innerCols(c.cols) - 6),
      )}
      <Text color={hex(n.total && n.answered === n.total ? c.p.green : c.p.text)} bold>{`${percent}%`}</Text>
    </Box>,
    <Box key="qa-keys" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      <Button key="archive" plain hotkey="a" label={c.t('term_k_archive')} onPress={() => c.act.archive()} />
      {canCopy(selectedItem) ? <Button key="copy" plain hotkey="c" label={c.t('term_k_copy')} onPress={press => c.act.copy(press)} /> : null}
      <Button key="recheck" plain hotkey="r" label={c.t('term_k_recheck')} onPress={() => c.act.recheck()} />
      <Button key="open-only" plain hotkey="f" label={`${c.view.openOnly ? '◉' : '○'} ${c.t('qa_open_only')}`} dimColor={!c.view.openOnly} onPress={() => c.act.toggleOpenOnly()} />
      <Button key="archived" plain hotkey="v" label={`${c.view.showArchived ? '◉' : '○'} ${c.t('qa_archived')}`} dimColor={!c.view.showArchived} onPress={() => c.act.toggleArchived()} />
    </Box>,
  ]
  if (q?.pending) {
    top.push(
      <Text key="checking" color={hex(c.p.orange)} bold>
        {`${SPINNER[c.tick % SPINNER.length]} ${c.t('qa_checking')}`}
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
          <Text key="wait-note" color={hex(c.p.muted)}>
            {note}
          </Text>,
          ...waiting.map((w, i) => (
            <Text key={`wait-${i}`} wrap="truncate-end">
              <Text color={hex(c.p.blue)}>{'• '}</Text>
              <Text color={hex(c.p.text)}>{w.text.replace(/\n/g, ' ')}</Text>
              {w.mid_turn ? <Text> {pill(c, `mid-${i}`, c.t('midturn'), c.p.purple)}</Text> : null}
            </Text>
          )),
        ],
        c.p.blue,
      ),
    )
  } else if (!q?.pending) {
    top.push(
      <Text key="eta" color={hex(c.p.faint)}>
        {c.t('qa_eta', eta)}
      </Text>,
    )
  }
  if (!turns.length) {
    return empty(c, 'qa-empty', c.t('qa_empty_t'), c.t('qa_empty_d'), top)
  }
  const page = qaPage(c.view, turns)
  let row = 0
  const boxes = page.shown.map(({ turn, failed, shown: items }, ti) => {
    const rowId = turnRow(turn.turn_id)
    const body: RenderChildren[] = []
    if (failed) {
      body.push(
        <Box key={`fail-row-${ti}`} flexDirection="row" columnGap={1} backgroundColor={c.selected === rowId ? hex(c.p.selected) : undefined}>
          <Text color={hex(c.p.yellow)}>{c.selected === rowId ? '▶' : ' '}</Text>
          {pill(c, `fail-chip-${ti}`, c.t('qa_fail'), c.p.red)}
          <Button key={`fail-${ti}-${turn.turn_id}`} plain dimColor label={c.t('recheck_title')} onPress={() => c.act.select(rowId)} />
        </Box>,
      )
    }
    if (!failed && !items.length) {
      body.push(
        <Text key="noq" color={hex(c.p.faint)}>
          {c.t('qa_noq')}
        </Text>,
      )
    }
    body.push(...items.map(item => itemView(c, item, row++)))
    const prompt = (turn.prompt ?? '').replace(/\n/g, ' ')
    const open = items.filter(i => isOpen(i) && !i.archived).length
    const title = (
      <Text>
        <Text color={hex(c.p.faint)}>{`${clock(turn.ts)}  `}</Text>
        <Text color={hex(c.p.text)} bold>
          {fit(prompt, Math.max(10, cardCols(c) - 18))}
        </Text>
        {turn.model ? <Text color={hex(c.p.faint)}>{`  ${turn.model}`}</Text> : null}
      </Text>
    )
    return card(c, `turn-${ti}-${turn.turn_id}`, title, body, failed ? c.p.red : open ? mix(c.p.line, c.p.orange, 0.5) : undefined)
  })
  return (
    <Box flexDirection="column">
      {top}
      {boxes}
      {page.more > 0 ? <Text color={hex(c.p.faint)}>{c.t('term_more', page.more)}</Text> : null}
      {!page.shown.length ? (
        <Text color={hex(c.p.green)} bold>
          {c.t(c.view.openOnly && !c.view.showArchived ? 'qa_all_done' : 'qa_nothing_shown')}
        </Text>
      ) : null}
    </Box>
  )
}

export const HERO_HEIGHT = HERO_ROWS
