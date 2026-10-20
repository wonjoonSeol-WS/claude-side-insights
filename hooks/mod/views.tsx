import type { Elements, RenderChildren, RenderSurface, UiPressArgument } from 'claude-code'

import {
  CheckStatus,
  DiffSource,
  DiffView,
  Kind,
  RecordStatus,
  Scope,
  Setting,
  Analyze,
  Source,
  Status,
  ToolState,
  clock,
  counts,
  duration,
  fit,
  splitPath,
  turnRow,
  type ConfigPayload,
  type DiffState,
  type DiffViewValue,
  type FileChange,
  type FileDiff,
  type FlowRecord,
  type FlowRef,
  type FlowStep,
  type PanelState,
  type QaItem,
  type ScopeValue,
  type SettingKey,
  type Tool,
} from './data'
import {
  MAX_FILES,
  canCopy,
  changeFiles,
  clampIndex,
  currentFlow,
  findItem,
  isOpen,
  kindOf,
  qaPage,
  resolveChange,
  sortedFiles,
  stepChanges,
  type Change,
  type TurnEntry,
} from './select'
import { AUTO_THEME, CAT, THEMES, hero, hex, meter, mix, tint, type Canvas, type Palette, type Rgb, type Segment } from './theme'

type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code' | 'Markdown'>
type RasterTag = Elements['terminal']['Raster']
type ColorName = { [K in keyof Palette]: Palette[K] extends Rgb ? K : never }[keyof Palette]

export const Tone = { OK: 'green', ERROR: 'red', WARN: 'orange', INFO: 'blue' } as const
export type ToneValue = (typeof Tone)[keyof typeof Tone]

export const Tab = { FLOW: 'flow', LIVE: 'live', QA: 'qa' } as const
export type TabValue = (typeof Tab)[keyof typeof Tab]
const TAB_KEYS: [string, TabValue][] = [
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
  settingRow: number
  file?: string
  toolFilter?: string
  toolOpen?: string
  statusFilter?: string
  note?: { text: string; tone: ToneValue }
}

export type Actions = {
  setTab: (tab: TabValue) => void
  flowBy: (delta: number) => void
  flowTo: (id: string) => void
  stepTo: (step: number) => void
  select: (id: string) => void
  pickQuestion: (id: string, press: UiPressArgument) => void
  archive: () => void
  copy: (press: UiPressArgument) => void
  jump: (id?: string) => void
  checkNow: () => void
  checkOlder: (turnId: string) => void
  recheck: () => void
  rebuild: () => void
  toggleOpenOnly: () => void
  toggleArchived: () => void
  openBrowser: () => void
  toggleHelp: () => void
  toggleSettings: () => void
  settingBy: (delta: number) => void
  settingValue: (delta: number, row?: number) => void
  unusedKey: (key: string) => void
  openFile: (path: string) => void
  fileBy: (delta: number) => void
  closeDiff: () => void
  diffView: (view: DiffViewValue) => void
  filterTools: (state: string) => void
  toggleTool: (id: string) => void
  filterStatus: (status: string) => void
}

type Hotkey = { key: string; onPress: (press: UiPressArgument) => void }

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
  diff?: DiffState
  config?: ConfigPayload
  hotkeys: Hotkey[]
}

export const HERO_KEY = 'hero'
export const PAD = 2
const CARD_CHROME = 6
const MIN_CARD_COLS = 8
const MIN_TEXT_COLS = 10
const TILE_MIN_COLS = 14
const PERCENT_COLS = 6
const TURN_TITLE_CHROME = 18
const FLOW_LIST_ROWS = 5
const FLOW_ROW_CHROME = 12
const SETTING_LABEL = 28
const WIDE_COLS = 78
const LEFT_MIN = 30
const LEFT_MAX = 48
const LEFT_SHARE = 2 / 5
const COLUMN_GAP = 2
const MAX_TOOLS = 40
const TOOLS_IN_FLOW = 12
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const LINK_SURFACES = new Set<RenderSurface>(['desktop'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const PILL_TINT = 0.24
export const PILL_STRONG_TINT = 0.45
export const TAB_TINT = 0.6
const STEP_TINT = 0.22
const STEP_ON_TINT = 0.6

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

const QA_STATUSES = [Status.ANSWERED, Status.PARTIAL, Status.UNANSWERED] as const
const STATUS_COLOR: Record<string, ColorName> = { [Status.ANSWERED]: 'green', [Status.PARTIAL]: 'orange', [Status.UNANSWERED]: 'red' }
const STATUS_LABEL: Record<string, string> = { [Status.ANSWERED]: 'st_answered', [Status.PARTIAL]: 'st_partial', [Status.UNANSWERED]: 'st_unanswered' }

const KIND_COLOR: Record<string, ColorName> = {
  [Kind.INPUT]: 'muted',
  [Kind.CONFIG]: 'muted',
  [Kind.EXTERNAL]: 'orange',
  [Kind.STORAGE]: 'green',
  [Kind.OUTPUT]: 'purple',
  [Kind.TEST]: 'teal',
}

const TOOL_STATES = [ToolState.OK, ToolState.ERR, ToolState.RUN] as const
const TOOL_COLOR: Record<string, ColorName> = { [ToolState.OK]: 'green', [ToolState.ERR]: 'red', [ToolState.RUN]: 'orange' }
const TOOL_MARK: Record<string, string> = { [ToolState.OK]: '✓', [ToolState.ERR]: '✗' }
const FILTER_LABEL: Record<string, string> = { [ToolState.OK]: 'term_ok', [ToolState.ERR]: 'term_err', [ToolState.RUN]: 'term_run' }

const CHECK_MARK: Record<string, [string, ColorName]> = { [CheckStatus.PASS]: ['✓', 'green'], [CheckStatus.FAIL]: ['✗', 'red'] }

const DIFF_SOURCE_LABEL: Record<FileDiff['source'], string> = {
  [DiffSource.WORKING]: 'mod_diff_working',
  [DiffSource.NEW]: 'mod_diff_new',
  [DiffSource.FILE]: 'mod_diff_file',
  [DiffSource.COMMIT]: 'mod_diff_commit',
  [DiffSource.NONE]: 'mod_diff_none',
}
const SOURCE_VIEW: Partial<Record<FileDiff['source'], DiffViewValue>> = { [DiffSource.FILE]: DiffView.FILE, [DiffSource.COMMIT]: DiffView.COMMIT }

const HINTS: Record<TabValue, [string, string][]> = {
  [Tab.FLOW]: [
    ['1-3', 'term_k_tabs'],
    ['u', 'term_k_check_now'],
    ['p n', 'term_k_flows'],
    ['k j', 'term_k_steps'],
    ['r', 'term_k_rebuild'],
    ['o', 'term_k_open'],
  ],
  [Tab.LIVE]: [
    ['1-3', 'term_k_tabs'],
    ['u', 'term_k_check_now'],
    ['k j', 'mod_k_files'],
    ['o', 'term_k_open'],
  ],
  [Tab.QA]: [
    ['1-3', 'term_k_tabs'],
    ['u', 'term_k_check_now'],
    ['a', 'term_k_archive'],
    ['c', 'term_k_copy'],
    ['r', 'term_k_recheck'],
    ['m', 'mod_k_jump'],
    ['f', 'term_k_open_only'],
    ['v', 'qa_archived'],
    ['o', 'term_k_open'],
  ],
}

const DIFF_KEYS: [string, string][] = [
  ['d', 'mod_view_working'],
  ['s', 'mod_view_commit'],
  ['f', 'mod_view_file'],
  ['x', 'mod_k_close_diff'],
]
const DIFF_KEY_VIEW: Record<string, DiffViewValue> = { d: DiffView.WORKING, s: DiffView.COMMIT, f: DiffView.FILE }

const SETTINGS_KEYS: [string, string][] = [
  ['k j', 'mod_k_setting_rows'],
  ['p n', 'mod_k_setting_value'],
]

const PANE_KEYS: [string, string][] = [
  ['ctrl+x tab', 'mod_k_focus'],
  ['tab  shift+tab', 'mod_k_controls'],
  ['↑ ↓  pgup pgdn', 'mod_k_scroll'],
  ['ctrl+x ← ↑', 'mod_k_grow'],
  ['ctrl+x → ↓', 'mod_k_shrink'],
  ['ctrl+x x', 'mod_k_close'],
  ['esc', 'mod_k_leave'],
]

const lookup = <V,>(map: Record<string, V>, key: string | undefined): V | undefined => (key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined)

const statusColor = (p: Palette, status: string | undefined): Rgb | undefined => {
  const name = lookup(STATUS_COLOR, status)
  return name ? p[name] : undefined
}

const kindColor = (p: Palette, kind: string | undefined): Rgb => p[lookup(KIND_COLOR, kind) ?? 'blue']

const toolColor = (p: Palette, state: string) => p[lookup(TOOL_COLOR, state) ?? 'faint']

const spin = (c: Ctx) => SPINNER.charAt(c.tick % SPINNER.length)

const innerCols = (cols: number) => Math.max(MIN_TEXT_COLS, cols - 2 * PAD)
const cardCols = (c: Ctx) => Math.max(MIN_CARD_COLS, innerCols(c.cols) - CARD_CHROME)

const split = (cols: number) => {
  const inner = innerCols(cols)
  if (cols < WIDE_COLS) {
    return undefined
  }
  const left = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.floor((inner - COLUMN_GAP) * LEFT_SHARE)))
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

const statusLabel = (c: Ctx, status: string | undefined) => {
  const key = lookup(STATUS_LABEL, status)
  return key ? c.t(key) : '-'
}

const label = (c: Ctx, text: string) => {
  const { Text } = c.ui
  return <Text color={hex(c.p.text)}>{text}</Text>
}

const faintText = (c: Ctx, key: string, text: string) => {
  const { Text } = c.ui
  return (
    <Text key={key} color={hex(c.p.faint)}>
      {text}
    </Text>
  )
}

const RICH = /(`[^`\n]+`|\*\*[^*\n]+\*\*|==[^=\n]+==)/

const rich = (c: Ctx, key: string, text: string, color: Rgb = c.p.text, onPress?: () => void) => {
  const { Box, Text, Button } = c.ui
  const lines = text.replace(/\r/g, '').split('\n')
  return (
    <Box key={key} flexDirection="column">
      {lines.map((raw, i) => {
        const line = raw.replace(/^\s*[-*] /, '• ').replace(/^#+\s*/, '')
        const drawn = (
          <Text key={`${key}-${i}`} color={hex(color)}>
            {line.split(RICH).map((part, k) =>
              part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
                <Text key={String(k)} color={hex(c.p.purple)}>
                  {part.slice(1, -1)}
                </Text>
              ) : part.startsWith('**') && part.endsWith('**') && part.length > 3 ? (
                <Text key={String(k)} color={hex(c.p.text)} bold>
                  {part.slice(2, -2)}
                </Text>
              ) : part.startsWith('==') && part.endsWith('==') && part.length > 3 ? (
                <Text key={String(k)} color={hex(c.p.yellow)} bold>
                  {part.slice(2, -2)}
                </Text>
              ) : (
                part
              ),
            )}
          </Text>
        )
        return onPress ? (
          <Button key={`${key}-press-${i}`} plain onPress={onPress}>
            {drawn}
          </Button>
        ) : (
          drawn
        )
      })}
    </Box>
  )
}

const chip = (c: Ctx, text: string, background: string, color: Rgb, bold = true, key?: string) => {
  const { Text } = c.ui
  return (
    <Text key={key} backgroundColor={background} color={hex(color)} bold={bold}>
      {` ${text} `}
    </Text>
  )
}

const pill = (c: Ctx, key: string, text: string, color: Rgb, strong = false) => chip(c, text, tint(c.p, color, strong ? PILL_STRONG_TINT : PILL_TINT), c.p.text, true, key)

const keycap = (c: Ctx, key: string) => chip(c, key, hex(c.p.key), c.p.text)

const selectedBg = (c: Ctx, on: boolean) => (on ? hex(c.p.selected) : undefined)

const marker = (c: Ctx, on: boolean, idle?: Rgb) => {
  const { Text } = c.ui
  return idle ? (
    <Text color={hex(on ? c.p.yellow : idle)} bold>
      {on ? '▶' : '▍'}
    </Text>
  ) : (
    <Text color={hex(c.p.yellow)}>{on ? '▶' : ' '}</Text>
  )
}

const selectableRow = (c: Ctx, key: string, on: boolean, children: RenderChildren[], idle?: Rgb) => {
  const { Box } = c.ui
  return (
    <Box key={key} flexDirection="row" alignItems="flex-start" columnGap={1} backgroundColor={selectedBg(c, on)}>
      <Box flexShrink={0}>{marker(c, on, idle)}</Box>
      {children}
    </Box>
  )
}

const keyButton = (c: Ctx, key: string, hotkey: string, text: string, onPress: Hotkey['onPress'], dim = false) => {
  const { Button, Text } = c.ui
  c.hotkeys.push({ key: hotkey, onPress })
  return (
    <Button key={key} plain dimColor={dim} onPress={onPress}>
      <Text color={hex(c.p.text)}>
        {keycap(c, hotkey)}
        {` ${text}`}
      </Text>
    </Button>
  )
}

const keyRow = (c: Ctx, key: string, children: RenderChildren[]) => {
  const { Box } = c.ui
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      {children}
    </Box>
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
    <Text key={key} color={hex(c.p.line)}>
      {parts}
      <Text color={hex(c.p.line)}>{'▆'.repeat(Math.max(0, cols - used))}</Text>
    </Text>
  )
}

export const heroCanvas = (p: Palette, cols: number, busy: boolean, tick: number) => hero(p, innerCols(cols), busy, tick)

const banner = (c: Ctx) => {
  const { Box, Text } = c.ui
  const drawn = rasterOf(c, HERO_KEY, heroCanvas(c.p, c.cols, c.busy, c.tick))
  if (drawn) {
    return drawn
  }
  return (
    <Box key="hero-text" backgroundColor={hex(c.p.hero[1] ?? c.p.blue)} paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text color={hex(c.p.heroText)} bold>
        ◆ side insights
      </Text>
      <Text color={hex(c.p.cat)} bold>
        {c.busy ? `⠂⠂${CAT}⠂⠂⠂` : `${CAT} zZ`}
      </Text>
    </Box>
  )
}

const tabButton = (c: Ctx, key: string, tab: TabValue) => {
  const { Button, Text } = c.ui
  const on = c.view.tab === tab
  const press = () => c.act.setTab(tab)
  c.hotkeys.push({ key, onPress: press })
  return (
    <Button key={`tab-${tab}`} plain onPress={press}>
      <Text color={hex(c.p.muted)}>
        {keycap(c, key)}
        {chip(c, c.t(`mode_${tab}`), tint(c.p, on ? c.p.blue : c.p.line, TAB_TINT), on ? c.p.text : c.p.muted, on)}
      </Text>
    </Button>
  )
}

export const header = (c: Ctx) => {
  const { Box, Text, Link } = c.ui
  const where = (c.s?.activity.cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '-'
  return (
    <Box key="header" flexDirection="column">
      {banner(c)}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {TAB_KEYS.map(([key, tab]) => tabButton(c, key, tab))}
        {c.view.settings || c.view.help ? null : keyButton(c, 'check-now', 'u', c.t('check_now'), () => c.act.checkNow())}
        {keyButton(c, 'open', 'o', c.t('full'), () => c.act.openBrowser(), true)}
        <Text color={hex(c.p.faint)}>
          {c.busy ? (
            <Text color={hex(c.p.orange)} bold>
              {`${spin(c)} ${c.t('busy')}`}
            </Text>
          ) : (
            <Text color={hex(c.p.faint)}>{`○ ${c.t('idle')}`}</Text>
          )}
          <Text color={hex(c.p.faint)}>{`  ${where}`}</Text>
        </Text>
      </Box>
      {c.pageUrl && LINK_SURFACES.has(c.surface) ? <Link href={c.pageUrl} label={c.t('full_title')} /> : null}
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
const HOTKEY_PREFIX = 'hk-'
const CATCHER_PREFIX = 'unused-'

export const isHiddenKey = (key: string) => key.startsWith(HOTKEY_PREFIX) || key.startsWith(CATCHER_PREFIX)

type Drawn = { type?: unknown; props?: { key?: unknown }; children?: unknown }

export const buttonKeys = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    node.forEach(child => buttonKeys(child, out))
    return out
  }
  if (!node || typeof node !== 'object') {
    return out
  }
  const n = node as Drawn
  if (n.type === 'Button' && typeof n.props?.key === 'string') {
    out.push(n.props.key)
  }
  buttonKeys(n.children, out)
  return out
}

export const hotkeyLayer = (c: Ctx) => {
  const { Box, Button } = c.ui
  const seen = new Set<string>()
  const own = c.hotkeys.filter(hot => !seen.has(hot.key) && !!seen.add(hot.key))
  return (
    <Box key="hotkeys" display="none">
      {own.map(hot => (
        <Button key={`${HOTKEY_PREFIX}${hot.key}`} plain hotkey={hot.key} onPress={hot.onPress}>
          {label(c, hot.key)}
        </Button>
      ))}
      {ALL_KEYS.filter(key => !seen.has(key)).map(key => (
        <Button key={`${CATCHER_PREFIX}${key}`} plain hotkey={key} onPress={() => c.act.unusedKey(key)}>
          {label(c, key)}
        </Button>
      ))}
    </Box>
  )
}

const idleKeys = (c: Ctx): string[] => {
  const flows = c.s?.flows.length ?? 0
  if (c.view.tab === Tab.FLOW) {
    return flows ? (flows === 1 ? ['p n'] : []) : ['p n', 'k j', 'r']
  }
  if (c.view.tab === Tab.QA && !(c.s?.qa.turns ?? []).length) {
    return ['a', 'c', 'r', 'm', 'f', 'v']
  }
  return c.view.tab === Tab.LIVE && !(c.s?.activity.files ?? []).length ? ['k j'] : []
}

const footerHints = (c: Ctx): [string, string][] => {
  if (c.view.settings) {
    return SETTINGS_KEYS
  }
  if (c.view.help) {
    return []
  }
  const idle = idleKeys(c)
  return [...HINTS[c.view.tab].filter(([key]) => !idle.includes(key)), ...(c.diff ? DIFF_KEYS.filter(([key]) => !lookup(DIFF_KEY_VIEW, key)) : [])]
}

export const footer = (c: Ctx) => {
  const { Box, Text } = c.ui
  return (
    <Box key="footer" marginTop={1} flexDirection="column">
      {c.view.note ? (
        <Text key="note" color={hex(c.p[c.view.note.tone])} bold>
          {`▌ ${c.view.note.text}`}
        </Text>
      ) : null}
      <Box key="hints" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {footerHints(c).map(([key, hint]) => (
          <Text key={`hint-${key}-${hint}`} color={hex(c.p.muted)}>
            {keycap(c, key)}
            <Text color={hex(c.p.muted)}>{` ${c.t(hint)}`}</Text>
          </Text>
        ))}
        {keyButton(c, 'help', 'h', c.t(c.view.help ? 'mod_help_close' : 'term_k_help'), () => c.act.toggleHelp())}
        {keyButton(c, 'settings', 'g', c.t(c.view.settings ? 'mod_settings_close' : 'settings'), () => c.act.toggleSettings())}
      </Box>
    </Box>
  )
}

const keyRows = (c: Ctx, rows: [string, string][]) => {
  const { Box, Text } = c.ui
  const width = Math.max(...rows.map(([key]) => key.length)) + 2
  return rows.map(([key, hint]) => (
    <Box key={`help-${key}-${hint}`} flexDirection="row" columnGap={2}>
      <Box width={width} flexShrink={0}>
        {keycap(c, key)}
      </Box>
      <Text color={hex(c.p.text)}>{c.t(hint)}</Text>
    </Box>
  ))
}

export const ON = '1'
const OFF = '0'
export const TOGGLES: SettingKey[] = [Setting.ENABLED, Setting.FLOW_AUTO, Setting.QA_AUTO, Setting.PANEL_AUTO]

type Option = { value: string; label: string }
type SettingRow = { id: string; key: SettingKey; scope: ScopeValue; label: string; options: Option[]; value: string }

const withCurrent = (options: Option[], value: string) => (options.length ? options : [{ value, label: value }])

export const settingRows = (cfg: ConfigPayload | undefined, t: Ctx['t']): SettingRow[] => {
  if (!cfg?.effective) {
    return []
  }
  const all = cfg.global ?? cfg.effective
  const onOff = [
    { value: ON, label: t('on') },
    { value: OFF, label: t('off') },
  ]
  const toggle = (key: SettingKey, scope: ScopeValue = Scope.GLOBAL): SettingRow => {
    const values = scope === Scope.PANE ? cfg.effective! : all
    return { id: key, key, scope, label: t(`s_${key}`), options: onOff, value: values[key as keyof typeof values] ? ON : OFF }
  }
  const choice = (key: SettingKey, options: Option[], value: string): SettingRow => ({ id: key, key, scope: Scope.GLOBAL, label: t(`s_${key}`), options: withCurrent(options, value), value })
  return [
    toggle(Setting.ENABLED, Scope.PANE),
    choice(Setting.ANALYZE, (cfg.analyze?.length ? cfg.analyze : Object.values(Analyze)).map(a => ({ value: a, label: t(`analyze_${a}`) })), all.analyze ?? Analyze.OPENED),
    toggle(Setting.FLOW_AUTO),
    toggle(Setting.QA_AUTO),
    choice(Setting.QA_BATCH, (cfg.qa_batches ?? []).map(n => ({ value: String(n), label: String(n) })), String(all.qa_batch ?? '')),
    choice(Setting.LANG, (cfg.langs ?? []).map(l => ({ value: l.code, label: l.label })), all.lang),
    choice(Setting.MODEL, (cfg.models ?? []).map(m => ({ value: m, label: m })), all.model),
    toggle(Setting.PANEL_AUTO),
    choice(Setting.THEME, (cfg.themes?.length ? cfg.themes : [AUTO_THEME, ...Object.keys(THEMES)]).map(th => ({ value: th, label: t(`theme_${th}`) })), all.theme ?? AUTO_THEME),
  ]
}

export const settingKey = (id: string) => `set-${id}`

const settingLine = (c: Ctx, r: SettingRow, i: number, on: boolean) => {
  const { Box, Text, Button } = c.ui
  const shown = r.options.find(o => o.value === r.value)?.label ?? r.value
  return selectableRow(c, `setting-${r.id}`, on, [
    <Box width={SETTING_LABEL} flexShrink={0}>
      <Text color={hex(on ? c.p.text : c.p.muted)} bold={on}>
        {r.label}
      </Text>
    </Box>,
    <Button key={settingKey(r.id)} plain onPress={() => c.act.settingValue(1, i)}>
      <Text color={hex(on ? c.p.blue : c.p.text)} bold>{`‹ ${shown} ›`}</Text>
    </Button>,
  ])
}

export const settings = (c: Ctx) => {
  const { Box, Text } = c.ui
  const rows = settingRows(c.config, c.t)
  if (!rows.length) {
    return card(c, 'settings-view', c.t('settings'), [faintText(c, 'settings-loading', c.t('loading'))], c.p.blue)
  }
  const at = clampIndex(c.view.settingRow, rows.length)
  return (
    <Box key="settings-view" flexDirection="column">
      {card(
        c,
        'settings-card',
        c.t('settings'),
        [
          ...rows.map((r, i) => settingLine(c, r, i, i === at)),
          keyRow(c, 'settings-keys', [
            keyButton(c, 'setting-prev', 'k', `↑ ${c.t('mod_prev_setting')}`, () => c.act.settingBy(-1), at === 0),
            keyButton(c, 'setting-next', 'j', `↓ ${c.t('mod_next_setting')}`, () => c.act.settingBy(1), at === rows.length - 1),
            keyButton(c, 'setting-value-prev', 'p', `‹ ${c.t('mod_prev_value')}`, () => c.act.settingValue(-1)),
            keyButton(c, 'setting-value-next', 'n', `${c.t('mod_next_value')} ›`, () => c.act.settingValue(1)),
          ]),
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
  const all: [string, string][] = [...Object.values(HINTS).flat(), ...DIFF_KEYS, ...SETTINGS_KEYS, ['g', 'settings'], ['h', 'k_help']]
  const panel = all.filter(([key, hint], i) => all.findIndex(([k, h]) => k === key && h === hint) === i)
  return (
    <Box key="help-view" flexDirection="column">
      {card(c, 'help-panel', c.t('mod_help_panel'), keyRows(c, panel), c.p.blue)}
      {card(
        c,
        'help-cc',
        c.t('mod_help_cc'),
        [
          ...keyRows(c, PANE_KEYS),
          <Box key="help-drag" marginTop={1}>
            <Text color={hex(c.p.muted)}>{c.t('mod_k_drag')}</Text>
          </Box>,
        ],
        c.p.purple,
      )}
    </Box>
  )
}

const card = (c: Ctx, key: string, title: RenderChildren, children: RenderChildren[], color?: Rgb) => {
  const { Box, Text } = c.ui
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={hex(color ?? c.p.line)} backgroundColor={hex(c.p.card)} paddingX={2} paddingY={1} marginTop={1}>
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

type TilePress = { on: boolean; act: () => void }

const tile = (c: Ctx, key: string, value: string | number, text: string, color: Rgb, dim = false, press?: TilePress) => {
  const { Box, Text, Button } = c.ui
  const on = !!press?.on
  const body = [
    <Text key={`${key}-value`} color={hex(dim && !on ? c.p.faint : color)} bold>
      {String(value)}
    </Text>,
    <Text key={`${key}-label`} color={hex(on ? c.p.text : c.p.muted)} bold={on}>
      {`\n${text}`}
    </Text>,
  ]
  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle={on ? 'bold' : 'round'}
      borderColor={hex(dim && !on ? c.p.line : color)}
      backgroundColor={hex(c.p.card)}
      paddingX={2}
      flexGrow={1}
      minWidth={TILE_MIN_COLS}
    >
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

const filterPress = (current: string | undefined, value: string, act: (value: string) => void): TilePress => ({ on: current === value, act: () => act(value) })

const relative = (c: Ctx, path: string) => {
  const cwd = c.s?.activity.cwd
  return cwd && path.replace(/\\/g, '/').startsWith(`${cwd.replace(/\\/g, '/')}/`) ? path.slice(cwd.length + 1) : path
}

const codeBlock = (c: Ctx, key: string, code: RenderChildren, column = false) => {
  const { Box } = c.ui
  return (
    <Box key={key} marginTop={1} {...(column ? { flexDirection: 'column' as const } : {})} backgroundColor={hex(c.p.code)} paddingX={1} paddingY={1}>
      {code}
    </Box>
  )
}

const diffBody = (c: Ctx, d: DiffState): RenderChildren[] => {
  const { Text, Code } = c.ui
  const data = d.data
  if (d.loading || !data) {
    return [faintText(c, 'diff-loading', c.t('mod_diff_loading'))]
  }
  return [
    <Text key="diff-source" color={hex(data.source === DiffSource.NONE ? c.p.orange : c.p.muted)}>
      {c.t(DIFF_SOURCE_LABEL[data.source], data.commit ?? '')}
    </Text>,
    ...(data.error ? [faintText(c, 'diff-error', data.error)] : []),
    ...(data.hunks ? [codeBlock(c, 'diff-code', <Code source={data.hunks} format="diff" path={d.path} />)] : []),
    ...(data.text !== undefined ? [codeBlock(c, 'diff-file', <Code source={data.text} startLine={1} path={d.path} />)] : []),
    ...(data.cut ? [faintText(c, 'diff-cut', c.t('mod_diff_cut', data.cut))] : []),
  ]
}

const diffCard = (c: Ctx) => {
  const d = c.diff
  if (!d) {
    return null
  }
  const source = d.data?.source
  const shown = (source && SOURCE_VIEW[source]) ?? (source === DiffSource.NONE && d.view !== DiffView.AUTO ? d.view : DiffView.WORKING)
  const body = [
    ...diffBody(c, d),
    keyRow(
      c,
      'diff-keys',
      DIFF_KEYS.map(([key, hint]) => {
        const view = lookup(DIFF_KEY_VIEW, key)
        return view
          ? keyButton(c, `diff-view-${view}`, key, c.t(hint), () => c.act.diffView(view), shown !== view)
          : keyButton(c, 'diff-close', key, c.t(hint), () => c.act.closeDiff(), true)
      }),
    ),
  ]
  return card(c, 'diff', c.t('mod_diff_title', relative(c, d.path)), body, c.p.teal)
}

const toolId = (tool: Tool) => `${tool.start ?? ''}:${tool.tool}`

const toolLine = (c: Ctx, tool: Tool, i: number, now: number) => {
  const { Box, Text, Button } = c.ui
  const mark = tool.state === ToolState.RUN ? spin(c) : (lookup(TOOL_MARK, tool.state) ?? '–')
  const end = tool.state === ToolState.RUN ? now : tool.end
  const took = tool.start && end ? duration(end - tool.start) : ''
  const nameColor = EDIT_TOOLS.has(tool.tool) ? c.p.purple : tool.tool.startsWith('mcp__') ? c.p.teal : c.p.blue
  const what = (tool.file ? shortPath(splitPath(tool.file, tool.where)) : tool.summary) ?? ''
  const line = (
    <Text key={`tool-${i}`} wrap="truncate-end" color={hex(c.p.text)}>
      <Text color={hex(toolColor(c.p, tool.state))} bold>
        {mark}
      </Text>{' '}
      <Text color={hex(c.p.faint)}>{clock(tool.start, true)}</Text>{' '}
      <Text color={hex(nameColor)} bold>
        {tool.label || tool.tool}
      </Text>{' '}
      <Text color={hex(c.p.text)}>{what}</Text> <Text color={hex(c.p.faint)}>{took}</Text>
    </Text>
  )
  if (tool.state !== ToolState.ERR) {
    return line
  }
  const id = toolId(tool)
  const open = c.view.toolOpen === id
  return (
    <Box key={`tool-err-${i}`} flexDirection="column" backgroundColor={selectedBg(c, open)}>
      <Button key={`tool-reason-${i}`} plain onPress={() => c.act.toggleTool(id)}>
        {line}
      </Button>
      {open ? (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color={hex(tool.reason ? c.p.red : c.p.faint)}>{tool.reason || c.t('mod_no_reason')}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

const shortPath = ({ name, dir }: { name: string; dir: string }) => (dir ? `${name}  ${dir}` : name)

const fileLine = (c: Ctx, f: FileChange) => {
  const { Box, Text, Button } = c.ui
  const { name, dir } = splitPath(f.path, f.where)
  return selectableRow(c, `file-row-${f.path}`, c.view.file === f.path, [
    <Box key={`file-line-${f.path}`} flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
      <Box flexShrink={1}>
        <Button key={`file-${f.path}`} plain onPress={() => c.act.openFile(f.path)}>
          {pill(c, `file-mark-${f.path}`, f.created ? 'A' : 'M', f.created ? c.p.green : c.p.orange)}
          <Text color={hex(c.p.text)} bold wrap="truncate-end">{` ${name}`}</Text>
          <Text color={hex(c.p.faint)}>{f.count > 1 ? ` ×${f.count}` : ''}</Text>
        </Button>
      </Box>
      {dir ? (
        <Button key={`file-dir-${f.path}`} plain onPress={() => c.act.openFile(f.path)}>
          <Text color={hex(c.p.faint)} wrap="truncate-middle">
            {dir}
          </Text>
        </Button>
      ) : null}
    </Box>,
  ])
}

const filesCard = (c: Ctx, files: FileChange[]) => {
  const { Box, Text } = c.ui
  const lines = [
    ...files.slice(0, MAX_FILES).map(f => fileLine(c, f)),
    ...(files.length > MAX_FILES ? [faintText(c, 'files-more', c.t('term_more', files.length - MAX_FILES))] : []),
    ...(files.length
      ? [
          keyRow(c, 'file-keys', [
            keyButton(c, 'file-prev', 'k', `↑ ${c.t('mod_prev_file')}`, () => c.act.fileBy(-1)),
            keyButton(c, 'file-next', 'j', `↓ ${c.t('mod_next_file')}`, () => c.act.fileBy(1)),
          ]),
        ]
      : [faintText(c, 'files-none', c.t('term_none'))]),
    <Box key="files-note" marginTop={1}>
      <Text color={hex(c.p.faint)}>{c.t('mod_edited_note')}</Text>
    </Box>,
  ]
  return card(c, 'files', c.t('mod_edited_files', files.length), lines, files.length ? c.p.purple : undefined)
}

const toolsCard = (c: Ctx, tools: Tool[]) => {
  const filter = c.view.toolFilter
  const shown = filter ? tools.filter(x => x.state === filter) : tools
  const now = Date.now() / 1000
  const lines = [...shown]
    .reverse()
    .slice(0, MAX_TOOLS)
    .map((tool, i) => toolLine(c, tool, i, now))
  const title = filter ? `${c.t('term_tools', `${shown.length} / ${tools.length}`)}  ${c.t(lookup(FILTER_LABEL, filter) ?? 'term_ok')}` : c.t('term_tools', tools.length)
  return card(c, 'tools', title, lines.length ? lines : [faintText(c, 'tools-none', c.t(filter ? 'mod_filter_none' : 'term_not_yet'))], tools.length ? c.p.blue : undefined)
}

export const live = (c: Ctx) => {
  const { Box } = c.ui
  const tools = c.s?.activity.tools ?? []
  const files = sortedFiles(c.s?.activity.files)
  const count = (state: string) => tools.filter(x => x.state === state).length
  const filesBox = filesCard(c, files)
  const toolsBox = toolsCard(c, tools)
  const diff = diffCard(c)
  const wide = split(c.cols)
  return (
    <Box flexDirection="column">
      {tiles(c, 'live-tiles', [
        ...TOOL_STATES.map(state =>
          tile(c, `tile-${state}`, count(state), c.t(FILTER_LABEL[state] ?? ''), toolColor(c.p, state), !count(state), filterPress(c.view.toolFilter, state, c.act.filterTools)),
        ),
        tile(c, 'tile-files', files.length, c.t('mod_edited_tile'), c.p.purple, !files.length),
      ])}
      <Box marginTop={1}>
        {bar(
          c,
          'live-bar',
          TOOL_STATES.map(state => ({ value: count(state), color: toolColor(c.p, state) })),
          tools.length,
          innerCols(c.cols),
        )}
      </Box>
      {diff}
      {wide ? twoColumns(c, 'live-cols', [filesBox], [toolsBox], wide.left) : [filesBox, toolsBox]}
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
      <Text key={`val-${i}`} color={hex(c.p.text)}>
        <Text color={hex(c.p.yellow)}>{now ? '●' : ' '}</Text>{' '}
        <Text color={hex(now ? c.p.blue : c.p.faint)} bold={now}>
          {name}
        </Text>
        {'  '}
        {moved ? (
          <Text color={hex(c.p.text)}>
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
  return card(c, 'state', c.t('state_title'), lines.length ? lines : [faintText(c, 'state-none', c.t('state_empty'))], changed ? c.p.yellow : undefined)
}

const language = (location: string | undefined) => {
  const file = (location ?? '').split(' ')[0] ?? ''
  const ext = file.includes('.') ? (file.split('.').pop() ?? '') : ''
  return LANGUAGE[ext]
}

const knownFiles = (c: Ctx) => [...(c.flow?.edited ?? []), ...(c.s?.activity.files ?? []).map(f => f.path)]

const changeRow = (c: Ctx, ch: Change, key: string) => {
  const { Box, Text, Button } = c.ui
  const known = knownFiles(c)
  return [
    ...changeFiles(ch.file).map((f, k) => {
      const path = resolveChange(f, known, c.flow?.cwd)
      return (
        <Box key={`${key}-row-${k}`} flexDirection="row" backgroundColor={selectedBg(c, c.view.file === path)}>
          <Button key={k ? `${key}-${k}` : key} plain onPress={() => c.act.openFile(path)}>
            {pill(c, `${key}-mark-${k}`, 'M', c.p.orange)}
            <Text color={hex(c.p.text)}>{` ${f}`}</Text>
          </Button>
        </Box>
      )
    }),
    <Box key={`${key}-what`} paddingLeft={4}>
      <Text color={hex(c.p.muted)}>{ch.what ?? ''}</Text>
    </Box>,
  ]
}

const changeList = (c: Ctx, changes: Change[], boxKey: string, rowKey: string, spaced: boolean) => {
  const { Box } = c.ui
  return changes.map((ch, i) => (
    <Box key={`${boxKey}-${i}`} flexDirection="column" {...(spaced ? { marginTop: i ? 1 : 0 } : {})}>
      {changeRow(c, ch, `${rowKey}-${i}`)}
    </Box>
  ))
}

type Check = NonNullable<NonNullable<FlowRecord['flow']>['checks']>[number]

const checkLine = (c: Ctx, ck: Check, key: string) => {
  const { Text } = c.ui
  const [mark, color] = lookup(CHECK_MARK, ck.status) ?? ['?', 'faint']
  return (
    <Text key={key} color={hex(c.p.text)}>
      <Text color={hex(c.p[color])} bold>
        {mark}
      </Text>{' '}
      <Text color={hex(c.p.text)}>{ck.label ?? ''}</Text>
    </Text>
  )
}

const section = (c: Ctx, key: string, title: string, color: Rgb, children: RenderChildren[]) => {
  const { Box, Text } = c.ui
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text color={hex(color)} bold>
        {title}
      </Text>
      {children}
    </Box>
  )
}

const keyLines = (c: Ctx, code: string, hits: string[]) => {
  const { Text } = c.ui
  const lines = code.split('\n')
  return section(
    c,
    'hits',
    c.t('mod_key_lines'),
    c.p.yellow,
    hits.map((hit, i) => {
      const at = lines.findIndex(l => l.includes(hit))
      return (
        <Text key={`hit-${i}`} wrap="truncate-end" color={hex(c.p.text)}>
          <Text color={hex(c.p.yellow)}>{'▌ '}</Text>
          <Text color={hex(c.p.faint)}>{at < 0 ? '  ' : String(at + 1).padStart(2, ' ')}</Text>
          <Text color={hex(c.p.text)}>{`  ${hit.trim()}`}</Text>
        </Text>
      )
    }),
  )
}

const stepCard = (c: Ctx, s: FlowStep, step: number, total: number, changes: Change[], checks: Check[]) => {
  const { Box, Text, Code } = c.ui
  const color = kindColor(c.p, s.kind)
  const lang = language(s.location)
  const hits = (s.highlight ?? []).filter(Boolean)
  const own = stepChanges(s, changes)
  const ownChecks = checks.filter(ck => ck.steps?.includes(step + 1))
  const body = [
    <Text key="tags" color={hex(c.p.text)}>
      {pill(c, 'step-kind', c.t(`kind_${kindOf(s)}`), color)}
      {s.changed ? <Text color={hex(c.p.text)}> {pill(c, 'step-changed', c.t('changed_short'), c.p.yellow)}</Text> : null}
      <Text color={hex(c.p.faint)}>{`  ${step + 1}/${total}`}</Text>
    </Text>,
    <Text key="where" color={hex(c.p.faint)} wrap="truncate-start">
      {s.location ?? ''}
    </Text>,
    <Box key="explain" marginTop={1}>
      {rich(c, 'explain-text', s.explanation ?? '')}
    </Box>,
    ...(s.code ? [codeBlock(c, 'code', <Code source={s.code} startLine={1} {...(lang ? { language: lang } : {})} />, true)] : []),
    ...(hits.length ? [keyLines(c, s.code ?? '', hits)] : []),
    ...(own.length ? [section(c, 'step-changes', c.t('mod_step_changes'), c.p.orange, changeList(c, own, 'step-chg', 'step-change', false))] : []),
    ...(ownChecks.length ? [section(c, 'step-checks', c.t('mod_step_checks'), c.p.green, ownChecks.map((ck, i) => checkLine(c, ck, `step-check-${i}`)))] : []),
  ]
  return card(c, 'step', `${step + 1}. ${s.title ?? ''}`, body, color)
}

const flowCards = (c: Ctx, rec: FlowRecord) => {
  const { Text } = c.ui
  const flow = rec.flow ?? {}
  const out: RenderChildren[] = []
  const changes = flow.changes ?? []
  if (changes.length) {
    out.push(card(c, 'changes', c.t('changes', changes.length), changeList(c, changes, 'chg', 'change', true), c.p.orange))
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
        checks.map((ck, i) => checkLine(c, ck, `chk-${i}`)),
        failing ? c.p.red : c.p.green,
      ),
    )
  }
  if (rec.prompt) {
    const meta = [rec.model, rec.cost ? `$${rec.cost.toFixed(3)}` : ''].filter(Boolean).join(' / ')
    out.push(card(c, 'request', c.t('request'), [rich(c, 'prompt', rec.prompt, c.p.muted), ...(meta ? [<Text key="meta" color={hex(c.p.faint)}>{meta}</Text>] : [])]))
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

const flowWindow = (count: number, index: number, rows = FLOW_LIST_ROWS) => {
  const first = Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows))
  return { first, last: Math.min(count, first + rows) - 1 }
}

const flowRow = (c: Ctx, f: FlowRef, on: boolean, width: number) => {
  const { Box, Text, Button } = c.ui
  const failed = f.status !== RecordStatus.OK
  return (
    <Box key={`flow-row-${f.id}`} flexDirection="row" backgroundColor={selectedBg(c, on)}>
      <Button key={`flow-tab-${f.id}`} plain onPress={() => c.act.flowTo(f.id)}>
        <Text color={hex(on ? c.p.yellow : failed ? c.p.red : c.p.faint)}>{on ? ' ▶ ' : failed ? ' ✗ ' : '   '}</Text>
        <Text color={hex(c.p.faint)}>{`${clock(f.ts)}  `}</Text>
        <Text color={hex(on ? c.p.text : c.p.muted)} bold={on}>
          {fit(f.title || '-', width)}
        </Text>
      </Button>
    </Box>
  )
}

const flowList = (c: Ctx, flows: FlowRef[], index: number) => {
  const { Box, Text } = c.ui
  const { first, last } = flowWindow(flows.length, index)
  const width = Math.max(MIN_TEXT_COLS, innerCols(c.cols) - FLOW_ROW_CHROME)
  return (
    <Box key="flow-list" flexDirection="column" marginTop={1}>
      <Box key="flow-nav" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={hex(c.p.text)} bold>
          {c.t('mod_flows', flows.length)}
        </Text>
        {keyButton(c, 'flow-prev', 'p', `‹ ${c.t('mod_prev_flow')}`, () => c.act.flowBy(-1), index === 0)}
        {keyButton(c, 'flow-next', 'n', `${c.t('mod_next_flow')} ›`, () => c.act.flowBy(1), index === flows.length - 1)}
      </Box>
      {first > 0 ? faintText(c, 'flow-list-before', `   ${c.t('mod_flows_newer', first)}`) : null}
      {flows.slice(first, last + 1).map((f, i) => flowRow(c, f, first + i === index, width))}
      {last + 1 < flows.length ? faintText(c, 'flow-list-after', `   ${c.t('mod_flows_older', flows.length - last - 1)}`) : null}
    </Box>
  )
}

const flowHeading = (c: Ctx, rec: FlowRecord) => {
  const { Box, Text } = c.ui
  const f = rec.flow ?? {}
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={hex(c.p.text)}>
        <Text color={hex(c.p.text)} bold>
          {f.title ?? ''}
        </Text>
        <Text color={hex(c.p.faint)}>{`  ${clock(rec.ts)}`}</Text>
        {(rec.turn_ids?.length ?? 0) > 1 ? <Text color={hex(c.p.faint)}>{`  ${c.t('flow_turns', rec.turn_ids!.length)}`}</Text> : null}
      </Text>
      {f.example ? (
        <Text key="example-line" color={hex(c.p.muted)}>
          {pill(c, 'example', c.t('example_label'), c.p.blue)} <Text color={hex(c.p.muted)}>{f.example}</Text>
        </Text>
      ) : null}
      {f.summary ? <Box marginTop={1}>{rich(c, 'summary', f.summary)}</Box> : null}
    </Box>
  )
}

const kindLegend = (c: Ctx, steps: FlowStep[]) => {
  const { Box, Text } = c.ui
  const entry = (key: string, color: Rgb, text: string) => (
    <Text key={key} color={hex(c.p.muted)}>
      <Text color={hex(color)}>●</Text>
      <Text color={hex(c.p.muted)}>{` ${text}`}</Text>
    </Text>
  )
  return (
    <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={3} marginBottom={1}>
      {[...new Set(steps.map(kindOf))].map(k => entry(`kind-${k}`, kindColor(c.p, k), c.t(`kind_${k}`)))}
      {entry('kind-changed', c.p.yellow, c.t('changed_this'))}
    </Box>
  )
}

const pipelineStep = (c: Ctx, s: FlowStep, i: number, on: boolean) => {
  const { Box, Text, Button } = c.ui
  const color = kindColor(c.p, s.kind)
  return selectableRow(
    c,
    `step-row-${i}`,
    on,
    [
      <Box key={`step-chip-${i}`} flexShrink={0}>
        {chip(c, String(i + 1), tint(c.p, color, on ? STEP_ON_TINT : STEP_TINT), on ? c.p.text : color)}
      </Box>,
      <Box key={`step-dot-${i}`} flexShrink={0}>
        <Text color={hex(c.p.yellow)}>{s.changed ? '●' : ' '}</Text>
      </Box>,
      <Box flexGrow={1} flexShrink={1}>
        <Button key={`step-${i}`} plain dimColor={!on} onPress={() => c.act.stepTo(i)}>
          {label(c, s.title ?? '')}
        </Button>
      </Box>,
    ],
    color,
  )
}

const pipelineCard = (c: Ctx, steps: FlowStep[], step: number, width: number) => {
  const { Box } = c.ui
  return card(c, 'pipeline', c.t('pipeline'), [
    kindLegend(c, steps),
    ...(steps.length
      ? [
          <Box key="step-bar" marginBottom={1}>
            {bar(c, 'step-bar', stepSegments(c, steps, step), steps.length, width, true)}
          </Box>,
        ]
      : []),
    ...steps.map((s, i) => pipelineStep(c, s, i, i === step)),
    keyRow(c, 'step-keys', [
      keyButton(c, 'step-prev', 'k', `↑ ${c.t('prev_step')}`, () => c.act.stepTo(step - 1), step === 0),
      keyButton(c, 'step-next', 'j', `↓ ${c.t('next_step')}`, () => c.act.stepTo(step + 1), step >= steps.length - 1),
      keyButton(c, 'rebuild', 'r', c.t('regen'), () => c.act.rebuild(), true),
    ]),
  ])
}

const flowFailure = (c: Ctx, title: string, error: string) => {
  const { Text } = c.ui
  return card(
    c,
    'flow-fail',
    c.t('flow_fail'),
    [
      <Text key="flow-title" color={hex(c.p.text)} bold>
        {title}
      </Text>,
      <Text key="flow-error" color={hex(c.p.muted)}>
        {error}
      </Text>,
    ],
    c.p.red,
  )
}

export const flow = (c: Ctx) => {
  const { Box, Text } = c.ui
  const flows = c.s?.flows ?? []
  const top: RenderChildren[] = c.s?.pending
    ? [
        <Text key="flow-gen" color={hex(c.p.orange)} bold>
          {`${spin(c)} ${c.t('flow_gen')}`}
        </Text>,
      ]
    : []
  if (!flows.length) {
    return empty(c, 'flow-empty', c.t('flow_empty_t'), c.t('flow_empty_d'), top)
  }
  const { index, ref } = currentFlow(flows, c.view.flowId)
  if (flows.length > 1) {
    top.push(flowList(c, flows, index))
  }
  const rec = c.flow
  if (!rec || c.flowLoading) {
    return empty(c, 'flow-loading', ref?.title ?? '', c.t('loading'), top)
  }
  if (rec.status !== RecordStatus.OK) {
    return (
      <Box flexDirection="column">
        {top}
        {flowFailure(c, ref?.title ?? '', rec.error ?? '')}
      </Box>
    )
  }
  const f = rec.flow ?? {}
  const steps = f.steps ?? []
  const step = clampIndex(c.view.step, steps.length)
  const current = steps[step]
  const wide = split(c.cols)
  const pipeline = pipelineCard(c, steps, step, wide ? Math.max(MIN_CARD_COLS, wide.left - CARD_CHROME) : cardCols(c))
  const detail = current ? [stepCard(c, current, step, steps.length, f.changes ?? [], f.checks ?? []), stateCard(c, steps, step)] : []
  return (
    <Box flexDirection="column">
      {top}
      {flowHeading(c, rec)}
      {wide ? twoColumns(c, 'flow-cols', [pipeline], detail, wide.left) : [pipeline, ...detail]}
      {flowCards(c, rec)}
    </Box>
  )
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
  const { Box, Text, Button } = c.ui
  const color = statusColor(c.p, item.status) ?? c.p.faint
  const on = c.selected === item.id
  const tags = [
    ...(item.from === Source.MID_TURN ? [c.t('midturn')] : []),
    ...(item.archived ? [c.t('qa_archived_tag')] : []),
    ...(item.manual ? [c.t('manual_tag')] : []),
  ]
  const note = itemNote(c, item)
  return (
    <Box key={`item-box-${n}-${item.id}`} flexDirection="column" backgroundColor={selectedBg(c, on)} marginTop={n ? 1 : 0}>
      <Box key={`row-${n}-${item.id}`} flexDirection="row" columnGap={1}>
        {marker(c, on, color)}
        {pill(c, `chip-${n}`, statusLabel(c, item.status), color)}
        {tags.length ? <Text color={hex(c.p.faint)}>{tags.join('  ')}</Text> : null}
      </Box>
      <Box flexDirection="row" paddingLeft={2}>
        <Button key={`item-${n}-${item.id}`} plain dimColor={!!item.archived} onPress={press => c.act.pickQuestion(item.id, press)}>
          {label(c, item.question ?? '')}
        </Button>
      </Box>
      {item.answer ? (
        <Box flexDirection="row" paddingLeft={2} columnGap={1} marginTop={1}>
          <Text color={hex(mix(c.p.base, color, 0.6))}>│</Text>
          {rich(c, `answer-${n}`, item.answer, c.p.muted, () => c.act.jump(item.id))}
        </Box>
      ) : null}
      {note ? <Text color={hex(c.p.green)}>{`    ↺ ${note}`}</Text> : null}
    </Box>
  )
}

const qaSummary = (c: Ctx, q: PanelState['qa'] | undefined): RenderChildren[] => {
  const { Box, Text } = c.ui
  const n = counts(q)
  const waiting = q?.waiting.length ?? 0
  const percent = n.total ? Math.round((100 * n.answered) / n.total) : 0
  const color = (status: string) => statusColor(c.p, status) ?? c.p.faint
  const toggle = (on: boolean, key: string, hotkey: string, text: string, act: () => void) => keyButton(c, key, hotkey, `${on ? '◉' : '○'} ${text}`, act, !on)
  return [
    tiles(c, 'qa-tiles', [
      ...QA_STATUSES.map(status => tile(c, `tile-${status}`, n[status], statusLabel(c, status), color(status), !n[status], filterPress(c.view.statusFilter, status, c.act.filterStatus))),
      ...(waiting ? [tile(c, 'tile-waiting', waiting, `⏳ ${c.t('qa_wait_tile')}`, c.p.blue)] : []),
    ]),
    <Box key="qa-meter" flexDirection="row" columnGap={1} marginTop={1}>
      {bar(
        c,
        'qa-bar',
        QA_STATUSES.map(status => ({ value: n[status], color: color(status) })),
        n.total,
        Math.max(MIN_CARD_COLS, innerCols(c.cols) - PERCENT_COLS),
      )}
      <Text color={hex(n.total && n.answered === n.total ? c.p.green : c.p.text)} bold>{`${percent}%`}</Text>
    </Box>,
    keyRow(c, 'qa-keys', [
      keyButton(c, 'archive', 'a', c.t('term_k_archive'), () => c.act.archive()),
      canCopy(findItem(q?.turns ?? [], c.selected)) ? keyButton(c, 'copy', 'c', c.t('term_k_copy'), press => c.act.copy(press)) : null,
      keyButton(c, 'recheck', 'r', c.t('term_k_recheck'), () => c.act.recheck()),
      keyButton(c, 'jump', 'm', c.t('mod_k_jump'), () => c.act.jump(), !c.selected),
      toggle(c.view.openOnly, 'open-only', 'f', c.t('qa_open_only'), () => c.act.toggleOpenOnly()),
      toggle(c.view.showArchived, 'archived', 'v', c.t('qa_archived'), () => c.act.toggleArchived()),
    ]),
  ]
}

const waitingCard = (c: Ctx, q: PanelState['qa']) => {
  const { Text } = c.ui
  const note = q.pending ? c.t('qa_wait_checking') : c.t('qa_wait_d', q.eta)
  return card(
    c,
    'waiting',
    `⏳ ${c.t('qa_wait_t', q.waiting.length)}`,
    [
      <Text key="wait-note" color={hex(c.p.muted)}>
        {note}
      </Text>,
      ...q.waiting.map((w, i) => (
        <Text key={`wait-${i}`} wrap="truncate-end" color={hex(c.p.text)}>
          <Text color={hex(c.p.blue)}>{'• '}</Text>
          <Text color={hex(c.p.text)}>{w.text.replace(/\n/g, ' ')}</Text>
          {w.mid_turn ? <Text color={hex(c.p.text)}> {pill(c, `mid-${i}`, c.t('midturn'), c.p.purple)}</Text> : null}
        </Text>
      )),
    ],
    c.p.blue,
  )
}

const qaProgress = (c: Ctx, q: PanelState['qa'] | undefined): RenderChildren[] => {
  const { Text } = c.ui
  const checking = q?.pending
    ? [
        <Text key="checking" color={hex(c.p.orange)} bold>
          {`${spin(c)} ${c.t('qa_checking')}`}
        </Text>,
      ]
    : []
  if (q?.waiting.length) {
    return [...checking, waitingCard(c, q)]
  }
  return checking.length ? checking : [faintText(c, 'eta', c.t('qa_eta', q?.eta ?? 0))]
}

const turnCard = (c: Ctx, { turn, failed, shown: items }: TurnEntry, ti: number, firstItem: number) => {
  const { Text, Button } = c.ui
  const rowId = turnRow(turn.turn_id)
  const body: RenderChildren[] = [
    ...(failed
      ? [
          selectableRow(c, `fail-row-${ti}`, c.selected === rowId, [
            pill(c, `fail-chip-${ti}`, c.t('qa_fail'), c.p.red),
            <Button key={`fail-${ti}-${turn.turn_id}`} plain dimColor onPress={() => c.act.select(rowId)}>
              {label(c, c.t('recheck_title'))}
            </Button>,
          ]),
        ]
      : []),
    ...(turn.skipped_turns
      ? [
          <Button key={`older-${ti}-${turn.turn_id}`} plain onPress={() => c.act.checkOlder(turn.turn_id)}>
            <Text color={hex(c.p.muted)}>
              {`${c.t('qa_skipped', turn.skipped_turns)}  `}
              <Text color={hex(c.p.blue)}>{c.t('check_older', Math.min(turn.skipped_turns, c.s?.qa.batch ?? turn.skipped_turns))}</Text>
            </Text>
          </Button>,
        ]
      : []),
    ...(!failed && !items.length ? [faintText(c, 'noq', c.t('qa_noq'))] : []),
    ...items.map((item, k) => itemView(c, item, firstItem + k)),
  ]
  const open = items.filter(i => isOpen(i) && !i.archived).length
  const title = (
    <Text color={hex(c.p.text)}>
      <Text color={hex(c.p.faint)}>{`${clock(turn.ts)}  `}</Text>
      <Text color={hex(c.p.text)} bold>
        {fit((turn.prompt ?? '').replace(/\n/g, ' '), Math.max(MIN_TEXT_COLS, cardCols(c) - TURN_TITLE_CHROME))}
      </Text>
      {turn.model ? <Text color={hex(c.p.faint)}>{`  ${turn.model}`}</Text> : null}
    </Text>
  )
  return card(c, `turn-${ti}-${turn.turn_id}`, title, body, failed ? c.p.red : open ? mix(c.p.line, c.p.orange, 0.5) : undefined)
}

export const qa = (c: Ctx) => {
  const { Box, Text } = c.ui
  const q = c.s?.qa
  const turns = q?.turns ?? []
  const top = [...qaSummary(c, q), ...qaProgress(c, q)]
  if (!turns.length) {
    return empty(c, 'qa-empty', c.t('qa_empty_t'), c.t('qa_empty_d'), top)
  }
  const page = qaPage(c.view, turns)
  let row = 0
  const boxes = page.shown.map((entry, ti) => {
    const first = row
    row += entry.shown.length
    return turnCard(c, entry, ti, first)
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
