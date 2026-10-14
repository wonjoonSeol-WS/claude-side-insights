import type { Register, RenderSurface, UiCopyResult, UiOpenResult, UiPressArgument, UiScrollResult } from 'claude-code'

import {
  Api,
  FETCH_ERROR,
  RecordStatus,
  Regen,
  cells,
  connect,
  counts,
  fit,
  format,
  isOk,
  langCode,
  loadMessages,
  rowTurn,
  Scope,
  Setting,
  Analyze,
  DiffView,
  noDiff,
  probeSystemDark,
  isAbsolutePath,
  bashCandidates,
  type ConfigPayload,
  type DiffState,
  type DiffViewValue,
  type Env,
  type FlowRecord,
  type Io,
  type Messages,
  type PanelState,
  type QaItem,
  type QaTurn,
  type Reply,
  type ScopeValue,
  type SettingKey,
} from './data'
import { MAX_FILES, clampIndex, currentFlow, findItem, isOpen, isShown, jumpTargets, rememberMessage, selection, sortedFiles } from './select'
import { DARK, hex, resolvePalette, type Palette } from './theme'
import {
  HERO_KEY,
  ON,
  PAD,
  TOGGLES,
  Tab,
  Tone,
  buttonKeys,
  flow,
  footer,
  header,
  help,
  heroCanvas,
  hotkeyLayer,
  isHiddenKey,
  live,
  qa,
  settingKey,
  settingRows,
  settings,
  type Actions,
  type Ctx,
  type TabValue,
  type ToneValue,
  type View,
} from './views'

const PANE = 'side-insights'
const PANE_TITLE = 'Side insights'
const PANE_COMMANDS = ['side-insights', 'si']
const BROWSER_COMMAND = 'si-browser'
const COMMANDS: { name: string; description: string }[] = [
  ...PANE_COMMANDS.map(name => ({ name, description: 'Open the side insights pane: Flow, Live and Q&A' })),
  { name: BROWSER_COMMAND, description: 'Show or hide the side insights browser panel (a cmux split, or your browser)' },
]
const BROWSER_TIMEOUT_MS = 15_000
const POLL_MS = 2000
const IDLE_EVERY = 3
const CONFIG_EVERY = 15
const START_RETRY_MS = 60_000
const START_TIMEOUT_MS = 8000
const CONFIRM_MS = 4000
const NOTE_MS = 5000
const SEP = '  |  '
const FRAME_MS = 140
const IDLE_FRAME_EVERY = 4

type Mod = {
  io?: Io
  api?: Api
  env?: Env
  timer?: { cancel: () => void }
  quiet: boolean
  pollCount: number
  pollRun?: Promise<void>
  pollAgain: boolean
  state?: PanelState
  stateText?: string
  down: boolean
  httpError?: string
  lastStart: number
  lang?: string
  messages: Messages
  messageCache: Map<string, Messages>
  flows: Map<string, FlowRecord>
  flowLoading?: string
  seenFlows?: Set<string>
  seenTurns?: Set<string>
  paneOpen: boolean
  view: View
  confirm?: { key: string; until: number }
  noteUntil: number
  palette: Palette
  tick: number
  frames?: { cancel: () => void }
  heroCols?: number
  themeInputs?: { claude?: string; systemDark?: boolean }
  focusable: string[]
  lastFocus?: string
  configSeq: number
  reopenPending?: boolean
  openPane?: (pane: { id: string; title: string }) => Promise<UiOpenResult>
  working?: boolean
  diff?: DiffState
  config?: ConfigPayload
}

const freshView = (): View => ({ tab: Tab.QA, step: 0, openOnly: false, showArchived: false, help: false, settings: false, settingRow: 0 })

const mod: Mod = {
  quiet: false,
  pollCount: 0,
  pollAgain: false,
  down: false,
  lastStart: -Infinity,
  messages: {},
  messageCache: new Map(),
  flows: new Map(),
  paneOpen: false,
  view: freshView(),
  noteUntil: 0,
  palette: DARK,
  tick: 0,
  configSeq: 0,
  focusable: [],
}

const t = (key: string, ...args: (string | number)[]) => format(mod.messages, key, ...args)

const redraw = () => mod.io?.invalidate()

const isBusy = () => mod.working ?? !!mod.state?.activity.busy

const setWorking = (working: boolean) => {
  if (mod.working !== working) {
    mod.working = working
    if (mod.paneOpen) {
      redraw()
    }
  }
}

const frame = () => {
  const io = mod.io
  if (!io || !mod.heroCols) {
    return
  }
  const busy = isBusy()
  mod.tick += 1
  if (!busy && mod.tick % IDLE_FRAME_EVERY) {
    return
  }
  const canvas = heroCanvas(mod.palette, mod.heroCols, busy, mod.tick)
  void io.blit(HERO_KEY, canvas.columns, canvas.rows, canvas.encode()).catch(() => undefined)
}

const animate = (on: boolean) => {
  if (on && !mod.frames && mod.io && !mod.quiet) {
    mod.frames = mod.io.every(FRAME_MS, frame)
  } else if (!on) {
    mod.frames?.cancel()
    mod.frames = undefined
  }
}

const paletteKey = (p: Palette) => `${hex(p.base)}${hex(p.code)}`

const repaint = () => {
  const next = resolvePalette(mod.config?.effective?.theme, mod.themeInputs?.claude, mod.themeInputs?.systemDark)
  const changed = paletteKey(next) !== paletteKey(mod.palette)
  mod.palette = next
  return changed
}

const loadTheme = async (io: Io) => {
  const [claudeTheme, systemDark] = await Promise.all([io.theme().catch(() => undefined), io.systemDark().catch(() => undefined)])
  mod.themeInputs = { claude: claudeTheme, systemDark }
  return repaint()
}

const paneTitle = () => (Object.hasOwn(mod.messages, 'mod_pane_title') ? t('mod_pane_title') : PANE_TITLE)

const now = async () => (mod.io ? mod.io.now() : 0)

const say = async (text: string, tone: ToneValue = Tone.OK) => {
  mod.view.note = { text, tone }
  mod.noteUntil = (await now()) + NOTE_MS
  redraw()
}

const problem = (): string | undefined => {
  if (mod.down) {
    return t('server_down')
  }
  return mod.httpError ? t('term_failed', mod.httpError) : undefined
}

const startServer = async (io: Io) => {
  const at = await io.now()
  if (at - mod.lastStart < START_RETRY_MS) {
    return
  }
  mod.lastStart = at
  const script = '. "$1/shell/key.sh" && [ -z "$(panel_missing)" ] && ensure_panel_server'
  const root = io.root.replace(/\\/g, '/')
  for (const bash of bashCandidates(mod.env)) {
    const ran = await io.run([bash, '-c', script, '_', root], { timeoutMs: START_TIMEOUT_MS }).then(
      () => true,
      () => false,
    )
    if (ran) {
      return
    }
  }
}

const toasts = (io: Io, s: PanelState) => {
  const ready = s.flows.filter(f => f.status === RecordStatus.OK)
  const turns = s.qa.turns
  if (!mod.seenFlows || !mod.seenTurns) {
    mod.seenFlows = new Set(ready.map(f => f.id))
    mod.seenTurns = new Set(turns.map(x => x.turn_id))
    return
  }
  const parts: string[] = []
  for (const f of ready.filter(f => !mod.seenFlows?.has(f.id))) {
    mod.seenFlows.add(f.id)
    parts.push(t('mod_toast_flow', f.title))
  }
  let open = 0
  for (const turn of turns.filter(x => !mod.seenTurns?.has(x.turn_id))) {
    mod.seenTurns.add(turn.turn_id)
    open += (turn.items ?? []).filter(i => !i.archived && isOpen(i)).length
  }
  if (open) {
    parts.push(t('mod_toast_open', open))
  }
  if (parts.length && !mod.quiet) {
    io.toast(parts.join(SEP))
  }
}

const flowId = () => currentFlow(mod.state?.flows ?? [], mod.view.flowId).ref?.id

const loadFlow = async () => {
  const id = flowId()
  if (!mod.api || !id || mod.flows.has(id) || mod.flowLoading === id) {
    return
  }
  const api = mod.api
  mod.flowLoading = id
  const reply = await api.flow(id)
  if (api !== mod.api) {
    return
  }
  if (mod.flowLoading === id) {
    mod.flowLoading = undefined
  }
  if (reply.data) {
    mod.flows.set(id, reply.data)
  } else if (reply.status !== FETCH_ERROR) {
    mod.flows.set(id, { status: RecordStatus.ERROR, error: reply.error ?? t('unknown_err') })
  }
  redraw()
}

const applyLang = async (io: Io, api: Api, lang: string) => {
  if (lang === mod.lang && Object.keys(mod.messages).length) {
    return false
  }
  const cached = mod.messageCache.get(lang) ?? (await loadMessages(io, lang))
  if (api !== mod.api) {
    return false
  }
  mod.messageCache.set(lang, cached)
  mod.lang = lang
  mod.messages = cached
  return true
}

const loadConfig = async (io: Io, api: Api) => {
  const seq = ++mod.configSeq
  const [config, themeChanged] = await Promise.all([api.config(), loadTheme(io)])
  if (api !== mod.api || seq !== mod.configSeq) {
    return themeChanged
  }
  if (config.data) {
    mod.config = config.data
  }
  const painted = repaint()
  const lang = config.data ? langCode(config.data.effective?.lang) : (mod.lang ?? langCode(undefined))
  return (await applyLang(io, api, lang)) || themeChanged || painted
}

const pruneSelection = () => {
  const id = mod.view.selected
  if (id && mod.state && !isShown(mod.view, mod.state.qa.turns, id)) {
    mod.view.selected = undefined
  }
}

const pollOnce = async (io: Io, api: Api) => {
  mod.pollCount += 1
  const s = mod.state
  const idle = !!s && !mod.paneOpen && !isBusy() && !s.qa.waiting.length && !s.qa.pending
  if (idle && mod.pollCount % IDLE_EVERY !== 0) {
    return
  }
  const wasDown = mod.down
  let changed = false
  if (mod.pollCount === 1 || mod.pollCount % CONFIG_EVERY === 0 || !Object.keys(mod.messages).length) {
    changed = await loadConfig(io, api)
    if (api !== mod.api) {
      return
    }
  }
  const reply = await api.state()
  if (api !== mod.api) {
    return
  }
  if (reply.data) {
    const text = JSON.stringify(reply.data)
    changed = changed || text !== mod.stateText || mod.down || !!mod.httpError
    mod.state = reply.data
    mod.stateText = text
    mod.down = false
    mod.httpError = undefined
    if (wasDown) {
      await loadConfig(io, api)
      if (api !== mod.api) {
        return
      }
    }
    toasts(io, reply.data)
    pruneSelection()
    if (mod.reopenPending) {
      void reopenIfOn()
    }
    if (mod.paneOpen && mod.view.tab === Tab.FLOW) {
      await loadFlow()
    }
  } else if (reply.status === FETCH_ERROR) {
    changed = changed || !mod.down
    mod.down = true
    mod.httpError = undefined
    await startServer(io)
  } else {
    const error = reply.error ?? `HTTP ${reply.status}`
    changed = changed || mod.down || error !== mod.httpError
    mod.down = false
    mod.httpError = error
  }
  if (mod.view.note && (await io.now()) > mod.noteUntil) {
    mod.view.note = undefined
    changed = true
  }
  if (changed) {
    redraw()
  }
}

const poll = (): Promise<void> => {
  if (mod.pollRun) {
    mod.pollAgain = true
    return mod.pollRun
  }
  mod.pollRun = (async () => {
    try {
      do {
        mod.pollAgain = false
        const io = mod.io
        const api = mod.api
        if (!io || !api) {
          break
        }
        await pollOnce(io, api)
      } while (mod.pollAgain)
    } finally {
      mod.pollRun = undefined
    }
  })()
  return mod.pollRun
}

const reset = () => {
  mod.pollCount = 0
  mod.state = undefined
  mod.stateText = undefined
  mod.down = false
  mod.httpError = undefined
  mod.seenFlows = undefined
  mod.seenTurns = undefined
  mod.flows = new Map()
  shownMessages.clear()
  mod.flowLoading = undefined
  mod.confirm = undefined
  mod.diff = undefined
  mod.config = undefined
  mod.configSeq += 1
  mod.view = { ...freshView(), tab: mod.view.tab }
}

const bind = (io: Io, env: Env) => {
  mod.io = io
  mod.env = env
  reset()
  mod.api = new Api(io, connect(env))
  void poll()
}

const confirmed = async (key: string, hotkey: string) => {
  const at = await now()
  if (mod.confirm?.key === key && mod.confirm.until > at) {
    mod.confirm = undefined
    return true
  }
  mod.confirm = { key, until: at + CONFIRM_MS }
  await say(t('term_confirm', hotkey), Tone.WARN)
  return false
}

const run = async (action: () => Promise<Reply<unknown>>, done: string) => {
  const reply = await action()
  if (isOk(reply)) {
    await say(done)
    await poll()
  } else {
    await say(failure(reply), Tone.ERROR)
  }
}

const absolute = (path: string) => {
  const home = mod.env?.home ?? ''
  const cwd = mod.state?.activity.cwd ?? ''
  if (path.startsWith('~/') && home) {
    return `${home}${path.slice(1)}`
  }
  return isAbsolutePath(path) || !cwd ? path : `${cwd}/${path}`
}

const dropDiff = () => {
  mod.diff = undefined
  mod.view.file = undefined
}

const refreshConfig = async () => {
  const io = mod.io
  const api = mod.api
  if (!io || !api) {
    return
  }
  await loadConfig(io, api)
  if (api === mod.api) {
    redraw()
  }
}

const failure = (reply: Reply<unknown>) => t('term_failed', reply.status === FETCH_ERROR ? t('server_down') : (reply.error ?? t('unknown_err')))

const assume = (key: SettingKey, value: string | boolean | number, scope: ScopeValue) => {
  const c = mod.config
  if (!c?.effective) {
    return
  }
  const overridden = !!c.pane && Object.hasOwn(c.pane, key)
  mod.config = {
    ...c,
    effective: scope === Scope.PANE || !overridden ? { ...c.effective, [key]: value } : c.effective,
    ...(scope === Scope.PANE ? { pane: { ...c.pane, [key]: value } } : { global: { ...(c.global ?? c.effective), [key]: value } }),
  }
}

const saveSetting = (key: SettingKey, value: string | boolean | number, scope: ScopeValue) => {
  const api = mod.api
  const io = mod.io
  if (!api || !io) {
    return
  }
  const seq = ++mod.configSeq
  assume(key, value, scope)
  repaint()
  redraw()
  void api.saveConfig({ [key]: value }, scope).then(async reply => {
    if (api !== mod.api) {
      return
    }
    if (!isOk(reply)) {
      return say(failure(reply), Tone.ERROR)
    }
    if (reply.data && seq === mod.configSeq) {
      const pane = mod.config?.pane ?? {}
      const data = reply.data
      mod.config = scope === Scope.PANE || !data.effective ? data : { ...data, pane, effective: { ...data.effective, ...pane } }
      repaint()
      await applyLang(io, api, langCode(mod.config.effective?.lang))
      if (api !== mod.api) {
        return
      }
    }
    await say(t('mod_settings_saved'))
  })
}

const showDiff = async (path: string, view: DiffViewValue = DiffView.AUTO) => {
  const api = mod.api
  if (!api) {
    return
  }
  const flow = mod.view.tab === Tab.FLOW ? flowId() : undefined
  mod.view.file = path
  mod.diff = { path, loading: true, view }
  redraw()
  const reply = await api.diff(absolute(path), view, flow)
  const data = isOk(reply) && reply.data ? reply.data : noDiff(reply.status === FETCH_ERROR ? t('server_down') : (reply.error ?? t('unknown_err')))
  if (mod.diff?.path === path && mod.diff.view === view) {
    mod.diff = { path, loading: false, data, view }
    redraw()
  }
}

const enableHere = async (wanted: () => boolean = () => true) => {
  const api = mod.api
  if (!api || mod.quiet || !wanted()) {
    return
  }
  const before = await api.config()
  if (api !== mod.api || !wanted() || (isOk(before) && before.data?.pane?.enabled === true)) {
    return
  }
  const seq = ++mod.configSeq
  const saved = await api.saveConfig({ [Setting.ENABLED]: true }, Scope.PANE)
  if (!isOk(saved) || api !== mod.api) {
    return
  }
  if (seq !== mod.configSeq) {
    void refreshConfig()
  } else if (saved.data) {
    mod.config = saved.data
    repaint()
    redraw()
  }
  const cfg = before.data
  if (!wanted() || !isOk(before) || !cfg?.global || cfg.global.analyze === Analyze.ALL) {
    return
  }
  if (cfg.global.qa_auto) {
    void api.regen({ target: Regen.QA })
  }
  if (cfg.global.flow_auto) {
    void api.regen({ target: Regen.FLOW, new: '1' })
  }
}

const reopenIfOn = async () => {
  const api = mod.api
  const open = mod.openPane
  if (!api || !open || mod.quiet) {
    return
  }
  const reply = await api.config()
  if (api !== mod.api) {
    return
  }
  mod.reopenPending = reply.status === FETCH_ERROR
  if (mod.paneOpen || reply.data?.pane?.enabled !== true) {
    return
  }
  mod.paneOpen = true
  mod.paneOpen = !!(await open({ id: PANE, title: paneTitle() }).catch(() => undefined))
}

const openBrowserPanel = async (): Promise<string> => {
  const io = mod.io
  const api = mod.api
  if (!io || !api) {
    return t('panel_failed')
  }
  void enableHere()
  if (mod.env?.cmux) {
    const out = await io.run([`${io.root}/bin/si-panel`], { timeoutMs: BROWSER_TIMEOUT_MS, env: { SIDE_INSIGHTS_NO_LINK: '1' } }).catch(() => undefined)
    return out ? [out.stdout, out.stderr].map(x => x.trim()).filter(Boolean).join('\n') || t('panel_shown') : t('panel_failed')
  }
  const reply = await api.open('')
  return isOk(reply) ? t('panel_requested') : failure(reply)
}

const checkNow = (hotkey: string) => {
  const api = mod.api
  if (!api) {
    return
  }
  if (mod.view.tab === Tab.LIVE) {
    void poll().then(() => say(t('check_now_refreshed')))
    return
  }
  const target = mod.view.tab === Tab.FLOW ? Regen.FLOW : Regen.QA
  void confirmed(`check:${target}`, hotkey).then(ok =>
    ok ? run(() => api.regen({ target }), t(target === Regen.FLOW ? 'flow_started' : 'qa_checking')) : undefined,
  )
}

const qaTurns = () => mod.state?.qa.turns ?? []

const selectedId = () => (mod.state ? selection(mod.view, mod.state.qa.turns) : undefined)

const selectedItem = (): QaItem | undefined => findItem(qaTurns(), selectedId())

type FilterField = 'statusFilter' | 'toolFilter' | 'toolOpen'

const flip = (field: FilterField, value: string) => {
  mod.view[field] = mod.view[field] === value ? undefined : value
}

const toggleFlag = (field: 'openOnly' | 'showArchived', name: string) => {
  mod.view[field] = !mod.view[field]
  pruneSelection()
  void say(`${name}: ${t(mod.view[field] ? 'on' : 'off')}`, Tone.INFO)
}

const goFlow = (id: string | undefined) => {
  dropDiff()
  mod.view.flowId = id
  mod.view.step = 0
  redraw()
  void loadFlow()
}

type Copy = (text: string, surface: RenderSurface) => Promise<UiCopyResult>
type Scroll = (requestId: string) => Promise<UiScrollResult>

const shownMessages = new Map<string, string>()
const OWN_PROMPTS = new Set<string>(['composer', 'bridge', 'sdk', 'unclassified'])

const withItem = (act: (item: QaItem, api: Api) => void) => () => {
  const item = selectedItem()
  if (!item || !mod.api) {
    void say(t('mod_no_item'), Tone.WARN)
    return
  }
  act(item, mod.api)
}

const actions = (copyText: Copy, scrollTo: Scroll): Actions => ({
  openFile: path => {
    if (mod.diff?.path === path && mod.view.file === path) {
      dropDiff()
      redraw()
      return
    }
    void showDiff(path)
  },
  fileBy: delta => {
    const files = sortedFiles(mod.state?.activity.files).slice(0, MAX_FILES)
    if (!files.length) {
      return
    }
    const at = files.findIndex(f => f.path === mod.view.file)
    const next = files[at < 0 ? 0 : clampIndex(at + delta, files.length)]
    if (next && next.path !== mod.view.file) {
      void showDiff(next.path)
    }
  },
  filterStatus: status => {
    flip('statusFilter', status)
    pruneSelection()
    redraw()
  },
  toggleTool: id => {
    flip('toolOpen', id)
    redraw()
  },
  filterTools: state => {
    flip('toolFilter', state)
    redraw()
  },
  diffView: view => {
    if (mod.diff) {
      void showDiff(mod.diff.path, view)
    }
  },
  closeDiff: () => {
    dropDiff()
    redraw()
  },
  unusedKey: key => {
    void say(t('mod_key_unused', key), Tone.INFO)
  },
  toggleHelp: () => {
    mod.view.help = !mod.view.help
    mod.view.settings = false
    redraw()
  },
  toggleSettings: () => {
    mod.view.settings = !mod.view.settings
    mod.view.help = false
    redraw()
    if (mod.view.settings) {
      void refreshConfig()
    }
  },
  settingBy: delta => {
    const rows = settingRows(mod.config, t)
    mod.view.settingRow = clampIndex(mod.view.settingRow + delta, rows.length)
    redraw()
    const row = rows[mod.view.settingRow]
    if (row) {
      void mod.io?.focus(settingKey(row.id)).catch(() => undefined)
    }
  },
  settingValue: (delta, row) => {
    const rows = settingRows(mod.config, t)
    const at = clampIndex(row ?? mod.view.settingRow, rows.length)
    const r = rows[at]
    if (!r) {
      return
    }
    mod.view.settingRow = at
    const n = r.options.length
    const i = r.options.findIndex(o => o.value === r.value)
    const next = r.options[((((i < 0 && delta > 0 ? -1 : Math.max(0, i)) + delta) % n) + n) % n]
    if (!next || next.value === r.value) {
      redraw()
      return
    }
    saveSetting(r.key, TOGGLES.includes(r.key) ? next.value === ON : r.key === Setting.QA_BATCH ? Number(next.value) : next.value, r.scope)
  },
  setTab: (tab: TabValue) => {
    dropDiff()
    mod.view.tab = tab
    mod.view.help = false
    mod.view.settings = false
    redraw()
    if (tab === Tab.FLOW) {
      void loadFlow()
    }
  },
  flowTo: id => goFlow(id),
  flowBy: delta => {
    const flows = mod.state?.flows ?? []
    if (flows.length) {
      goFlow(flows[clampIndex(currentFlow(flows, mod.view.flowId).index + delta, flows.length)]?.id)
    }
  },
  stepTo: step => {
    dropDiff()
    const id = flowId()
    const steps = (id && mod.flows.get(id)?.flow?.steps?.length) || 1
    mod.view.step = clampIndex(step, steps)
    redraw()
  },
  select: id => {
    mod.view.selected = id
    redraw()
  },
  jump: async id => {
    const target = id ?? selectedId()
    let turn: QaTurn | undefined
    let item: QaItem | undefined
    for (const x of qaTurns()) {
      item = x.items?.find(i => i.id === target)
      if (item) {
        turn = x
        break
      }
    }
    if (!turn || !item) {
      await say(t(id ? 'mod_jump_failed' : 'mod_no_item'), Tone.WARN)
      return
    }
    mod.view.selected = item.id
    redraw()
    for (const requestId of jumpTargets(turn, item, shownMessages)) {
      const moved: UiScrollResult = await scrollTo(requestId).catch((err: unknown) => ({ deny: String(err) }))
      if (!moved.deny) {
        return
      }
    }
    await say(t('mod_jump_failed'), Tone.WARN)
  },
  pickQuestion: (id, press) => {
    mod.view.selected = id
    redraw()
    const question = findItem(qaTurns(), id)?.question
    if (!question) {
      return
    }
    void copyText(question, press.surface).then(
      r => say(t(r.isCopied ? 'mod_copied_question' : 'copy_failed'), r.isCopied ? Tone.OK : Tone.ERROR),
      () => say(t('copy_failed'), Tone.ERROR),
    )
  },
  archive: withItem((item, api) => {
    const archived = !item.archived
    void run(() => api.override(item.id, { archived }), t(archived ? 'term_archived' : 'term_restored'))
  }),
  copy: (press: UiPressArgument) => {
    const item = selectedItem()
    if (!item) {
      void say(t('mod_no_item'), Tone.WARN)
      return
    }
    const text = t('ask_message', (item.question ?? '').split(/\s+/).filter(Boolean).join(' '))
    void copyText(text, press.surface).then(
      r => say(t(r.isCopied ? 'copy_done' : 'copy_failed'), r.isCopied ? Tone.OK : Tone.ERROR),
      () => say(t('copy_failed'), Tone.ERROR),
    )
  },
  recheck: () => {
    const id = selectedId()
    const api = mod.api
    if (!id || !api) {
      void say(t('mod_no_item'), Tone.WARN)
      return
    }
    void confirmed(`qa:r:${id}`, 'r').then(ok => {
      if (!ok) {
        return
      }
      const turn = rowTurn(id)
      const params = turn ? { target: Regen.QA, turn } : { target: Regen.QA, item: id }
      const marked = !turn && findItem(qaTurns(), id)?.manual
      return run(async () => {
        if (marked) {
          const cleared = await api.override(id, { status: null })
          if (!isOk(cleared)) {
            return cleared
          }
        }
        return api.regen(params)
      }, t('qa_checking'))
    })
  },
  checkNow: () => checkNow('u'),
  checkOlder: turnId => {
    const api = mod.api
    if (!api) {
      return
    }
    void confirmed(`qa:older:${turnId}`, 'Enter').then(ok => (ok ? run(() => api.regen({ target: Regen.QA, older: turnId }), t('qa_checking')) : undefined))
  },
  rebuild: () => checkNow('r'),
  toggleOpenOnly: () => toggleFlag('openOnly', t('qa_open_only')),
  toggleArchived: () => toggleFlag('showArchived', t('qa_archived')),
  openBrowser: () => {
    const api = mod.api
    if (!api) {
      return
    }
    void api.open(mod.view.tab).then(reply => (isOk(reply) ? undefined : say(failure(reply), Tone.ERROR)))
  },
})

const bandLine = (cols: number): string | undefined => {
  const issue = problem()
  if (issue) {
    return fit(issue, cols)
  }
  const s = mod.state
  if (!s) {
    return undefined
  }
  const n = counts(s.qa)
  const waiting = s.qa.waiting.length
  const latest = s.flows.find(f => f.status === RecordStatus.OK)
  const parts: string[] = []
  if (n.total) {
    parts.push(`${t('mode_qa')} ✓ ${n.answered}  ◐ ${n.partial}  ✗ ${n.unanswered}`)
  }
  if (s.qa.pending) {
    parts.push(`⠋ ${t('qa_checking')}`)
  } else if (waiting) {
    parts.push(`⏳ ${t('mod_band_waiting', waiting, s.qa.eta)}`)
  }
  if (s.pending) {
    parts.push(`⠋ ${t('flow_gen')}`)
  } else if (latest) {
    parts.push(t('mod_band_flow', latest.title))
  }
  if (!parts.length) {
    return undefined
  }
  const line = [...parts, t('mod_band_hint')].join(SEP)
  return cells(line) <= cols ? line : fit(parts.join(SEP), cols)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [cmux, orca, iterm, home, profile, os, gitBash, localAppData, data, port, legacyPort, child, session] = await Promise.all([
      $.env.get('CMUX_PANEL_ID'),
      $.env.get('ORCA_PANE_KEY'),
      $.env.get('ITERM_SESSION_ID'),
      $.env.get('HOME'),
      $.env.get('USERPROFILE'),
      $.env.get('OS'),
      $.env.get('CLAUDE_CODE_GIT_BASH_PATH'),
      $.env.get('LOCALAPPDATA'),
      $.env.get('SIDE_INSIGHTS_DATA'),
      $.env.get('SIDE_INSIGHTS_PORT'),
      $.env.get('CLAUDE_PANEL_PORT'),
      $.env.get('SIDE_INSIGHTS_CHILD'),
      $.session.id(),
    ])
    mod.quiet = !e.isInteractive || !!child
    mod.paneOpen = false
    bind(
      {
        fetch: (url, init) => $.http.fetch(url, init),
        read: path => $.fs.read(path),
        run: (argv, init) => $.process.run(argv, init),
        toast: text => $.ui.toast(text),
        invalidate: () => $.ui.invalidate('ui.render'),
        blit: (key, columns, rows, cells) => $.ui.blit({ requestId: PANE, key, columns, rows, cells }),
        focus: key => $.ui.focus({ requestId: PANE, key }),
        every: (ms, fn) => $.clock.every(ms, fn),
        systemDark: () => probeSystemDark((argv, init) => $.process.run(argv, init)),
        theme: async () => {
          const row = (await $.config.list()).find(r => r.key === 'theme')
          return row?.value === undefined ? undefined : String(row.value)
        },
        now: () => $.clock.now(),
        root: $.plugin.root,
      },
      { cmux, orca, iterm, home: os === 'Windows_NT' ? profile || home : home || profile, data, port, legacyPort, child, session, windows: os === 'Windows_NT', gitBash, localAppData },
    )
    mod.timer?.cancel()
    mod.timer = mod.quiet ? undefined : $.clock.every(POLL_MS, () => void poll())
    if (!mod.quiet && mod.io) {
      void startServer(mod.io).then(() => poll())
    }
    for (const { name, description } of COMMANDS) {
      try {
        await $.command.register({ name, description, immediate: true })
      } catch {
        continue
      }
    }
    mod.openPane = pane => $.ui.open(pane)
    await reopenIfOn()
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (mod.io && mod.env) {
      const before = mod.api?.conn.key
      bind(mod.io, { ...mod.env, session: await $.session.id() })
      if (mod.paneOpen && mod.api?.conn.key !== before) {
        void enableHere(() => mod.paneOpen)
      }
      await reopenIfOn()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: BROWSER_COMMAND }, async () => ({ text: await openBrowserPanel() })).catch(($, e, next) => next(e))

  on('command.run', { command: PANE_COMMANDS }, async $ => {
    mod.paneOpen = true
    mod.paneOpen = !!(await $.ui.open({ id: PANE, title: paneTitle(), focus: true }).catch(() => undefined))
    void enableHere(() => mod.paneOpen)
    const io = mod.io
    if (io && (await loadTheme(io))) {
      redraw()
    }
    void poll()
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    mod.paneOpen = false
    animate(false)
    if (e.origin.kind === 'person' && mod.api && !mod.quiet) {
      const api = mod.api
      const seq = ++mod.configSeq
      void api.saveConfig({ [Setting.ENABLED]: false }, Scope.PANE).then(saved => {
        if (isOk(saved) && saved.data && api === mod.api && seq === mod.configSeq) {
          mod.config = saved.data
        }
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const row = mod.view.settings && e.element ? settingRows(mod.config, t).findIndex(r => settingKey(r.id) === e.element) : -1
    if (row >= 0 && row !== mod.view.settingRow) {
      mod.view.settingRow = row
      redraw()
    }
    const visible = mod.focusable
    if (!e.element || !isHiddenKey(e.element) || !visible.length) {
      mod.lastFocus = e.element
      return next(e)
    }
    const target = mod.lastFocus === visible[0] ? visible[visible.length - 1] : visible[0]
    mod.lastFocus = target
    return next({ ...e, element: target })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    setWorking(e.props.isWorking)
    const below = await next(e)
    if (e.props.hasSurvey) {
      return below
    }
    const line = bandLine(e.props.bodyColumns)
    if (!line) {
      return below
    }
    const { Box, Text } = $.ui.resolve(e)
    const issue = !!problem()
    return (
      <Box flexDirection="column">
        <Box key="side-insights-band">
          <Text color={issue ? 'warning' : undefined} dimColor={!issue} wrap="truncate-end">
            {line}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (OWN_PROMPTS.has(e.props.origin.kind)) {
      rememberMessage(shownMessages, e.requestId, e.props.text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const waiting = mod.state?.qa.waiting.length ?? 0
    if (!waiting) {
      return next(e)
    }
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} - ${t('mod_spinner_waiting', waiting)}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const id = flowId()
    const terminal = e.surface === 'terminal'
    mod.paneOpen = true
    animate(terminal)
    mod.heroCols = e.props.bodyColumns
    const c: Ctx = {
      ui,
      raster: terminal ? $.ui.resolve(e).Raster : undefined,
      p: mod.palette,
      tick: mod.tick,
      busy: isBusy(),
      s: mod.state,
      t,
      cols: e.props.bodyColumns,
      view: mod.view,
      surface: e.surface,
      selected: selectedId(),
      flow: id ? mod.flows.get(id) : undefined,
      flowLoading: !!id && mod.flowLoading === id,
      act: actions(
        (text, surface) => $.ui.copy({ text, surface }),
        requestId => $.ui.scroll({ to: { requestId }, block: 'start' }),
      ),
      pageUrl: mod.api?.pageUrl() ?? '',
      problem: problem(),
      diff: mod.diff,
      config: mod.config,
      hotkeys: [],
    }
    const top = header(c)
    const body = mod.view.settings ? settings(c) : mod.view.help ? help(c) : mod.view.tab === Tab.FLOW ? flow(c) : mod.view.tab === Tab.LIVE ? live(c) : qa(c)
    const bottom = footer(c)
    mod.focusable = buttonKeys([top, body, bottom])
    return (
      <Box flexDirection="column" width={e.props.bodyColumns} minHeight={e.props.scroll.bodyRows} paddingX={PAD} paddingY={1} backgroundColor={hex(mod.palette.base)}>
        {top}
        {body}
        {bottom}
        {hotkeyLayer(c)}
      </Box>
    )
  })
}
