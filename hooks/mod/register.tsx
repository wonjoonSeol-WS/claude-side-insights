import type { Register, RenderSurface, UiCopyResult, UiPressArgument } from 'claude-code'

import {
  Api,
  FETCH_ERROR,
  RecordStatus,
  Regen,
  STATUS_CYCLE,
  Status,
  cells,
  connect,
  counts,
  fit,
  format,
  isOk,
  langCode,
  loadMessages,
  rowTurn,
  type Env,
  type Io,
  loadDiff,
  type FileDiff,
  type FlowRecord,
  type Messages,
  type PanelState,
  type QaItem,
  type Reply,
} from './data'
import { DARK, LIGHT, hex, type Palette } from './theme'
import {
  HERO_KEY,
  PAD,
  Tab,
  currentFlow,
  flow,
  footer,
  header,
  help,
  keyCatcher,
  heroCanvas,
  isOpen,
  isShown,
  live,
  qa,
  selection,
  type Actions,
  type Ctx,
  type TabValue,
  type View,
} from './views'

const PANE = 'side-insights'
const PANE_TITLE = 'Side insights'
const COMMANDS = ['side-insights', 'si']
const COMMAND_DESCRIPTION = 'Open the side insights pane: Flow, Live and Q&A'
const POLL_MS = 2000
const IDLE_EVERY = 3
const CONFIG_EVERY = 15
const START_RETRY_MS = 60_000
const START_TIMEOUT_MS = 8000
const CONFIRM_MS = 4000
const NOTE_MS = 5000
const SEP = '  |  '
const FRAME_MS = 140

type Mod = {
  io?: Io
  api?: Api
  env?: Env
  timer?: { cancel: () => void }
  quiet: boolean
  ticks: number
  polling: boolean
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
  diff?: { path: string; loading: boolean; data?: FileDiff }
}

const freshView = (): View => ({ tab: Tab.QA, step: 0, openOnly: false, showArchived: false, help: false })

const mod: Mod = {
  quiet: false,
  ticks: 0,
  polling: false,
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
}

const t = (key: string, ...args: (string | number)[]) => format(mod.messages, key, ...args)

const redraw = () => mod.io?.invalidate()

const frame = () => {
  const io = mod.io
  if (!io || !mod.heroCols) {
    return
  }
  const busy = !!mod.state?.activity.busy
  mod.tick += 1
  if (!busy && mod.tick % 4) {
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

const loadTheme = async (io: Io) => {
  const theme = await io.theme().catch(() => undefined)
  mod.palette = (theme ?? '').toLowerCase().includes('light') ? LIGHT : DARK
}

const now = async () => (mod.io ? mod.io.now() : 0)

const say = async (text: string, color = 'success') => {
  mod.view.note = { text, color }
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
  try {
    await io.run(['/bin/bash', '-c', '. "$1/shell/key.sh" && ensure_panel_server', '_', io.root], {
      timeoutMs: START_TIMEOUT_MS,
    })
  } catch {
    return
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
  mod.flowLoading = undefined
  if (reply.data) {
    mod.flows.set(id, reply.data)
  } else if (reply.status !== FETCH_ERROR) {
    mod.flows.set(id, { status: RecordStatus.ERROR, error: reply.error ?? t('unknown_err') })
  }
  redraw()
}

const loadConfig = async (io: Io, api: Api) => {
  const config = await api.config()
  const lang = config.data ? langCode(config.data.effective?.lang) : (mod.lang ?? langCode(undefined))
  if (lang === mod.lang && Object.keys(mod.messages).length) {
    return
  }
  const cached = mod.messageCache.get(lang) ?? (await loadMessages(io, lang))
  mod.messageCache.set(lang, cached)
  mod.lang = lang
  mod.messages = cached
}

const pruneSelection = () => {
  const id = mod.view.selected
  if (id && mod.state && !isShown(mod.view, mod.state.qa.turns, id)) {
    mod.view.selected = undefined
  }
}

const pollOnce = async (io: Io, api: Api) => {
  mod.ticks += 1
  const s = mod.state
  const idle = !!s && !mod.paneOpen && !s.activity.busy && !s.qa.waiting.length && !s.qa.pending
  if (idle && mod.ticks % IDLE_EVERY !== 0) {
    return
  }
  const wasDown = mod.down
  if (mod.ticks === 1 || mod.ticks % CONFIG_EVERY === 0 || !Object.keys(mod.messages).length) {
    await loadConfig(io, api)
  }
  const reply = await api.state()
  if (api !== mod.api) {
    return
  }
  let changed = false
  if (reply.data) {
    const text = JSON.stringify(reply.data)
    changed = text !== mod.stateText || mod.down || !!mod.httpError
    mod.state = reply.data
    mod.stateText = text
    mod.down = false
    mod.httpError = undefined
    if (wasDown) {
      await loadConfig(io, api)
    }
    toasts(io, reply.data)
    pruneSelection()
    if (mod.paneOpen && mod.view.tab === Tab.FLOW) {
      await loadFlow()
    }
  } else if (reply.status === FETCH_ERROR) {
    changed = !mod.down
    mod.down = true
    mod.httpError = undefined
    await startServer(io)
  } else {
    const error = reply.error ?? `HTTP ${reply.status}`
    changed = mod.down || error !== mod.httpError
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

const poll = async () => {
  const io = mod.io
  const api = mod.api
  if (!io || !api) {
    return
  }
  if (mod.polling) {
    mod.pollAgain = true
    return
  }
  mod.polling = true
  try {
    do {
      mod.pollAgain = false
      await pollOnce(io, api)
    } while (mod.pollAgain && api === mod.api)
  } finally {
    mod.polling = false
  }
}

const reset = () => {
  mod.ticks = 0
  mod.state = undefined
  mod.stateText = undefined
  mod.down = false
  mod.httpError = undefined
  mod.seenFlows = undefined
  mod.seenTurns = undefined
  mod.flows = new Map()
  mod.flowLoading = undefined
  mod.confirm = undefined
  mod.diff = undefined
  mod.polling = false
  mod.pollAgain = false
  mod.view = { ...freshView(), tab: mod.view.tab }
}

const bind = (io: Io, env: Env) => {
  mod.io = io
  mod.env = env
  reset()
  mod.api = new Api(io, connect(env))
  void poll()
}

const confirmed = async (key: string) => {
  const at = await now()
  if (mod.confirm?.key === key && mod.confirm.until > at) {
    mod.confirm = undefined
    return true
  }
  mod.confirm = { key, until: at + CONFIRM_MS }
  await say(t('term_confirm', 'r'), 'warning')
  return false
}

const run = async (action: () => Promise<Reply<unknown>>, done: string) => {
  const reply = await action()
  if (isOk(reply)) {
    await say(done)
    await poll()
  } else {
    await say(t('term_failed', reply.status === FETCH_ERROR ? t('server_down') : (reply.error ?? t('unknown_err'))), 'error')
  }
}

const sortedFiles = () => [...(mod.state?.activity.files ?? [])].sort((a, b) => b.last - a.last)

const absolute = (path: string) => {
  const home = mod.env?.home ?? ''
  const cwd = mod.state?.activity.cwd ?? ''
  if (path.startsWith('~/') && home) {
    return `${home}${path.slice(1)}`
  }
  return path.startsWith('/') || !cwd ? path : `${cwd}/${path}`
}

const showDiff = async (path: string) => {
  const io = mod.io
  if (!io) {
    return
  }
  if (mod.diff?.path === path && mod.view.file === path) {
    mod.diff = undefined
    mod.view.file = undefined
    redraw()
    return
  }
  const full = absolute(path)
  const dir = full.slice(0, full.lastIndexOf('/')) || '/'
  mod.view.file = path
  mod.diff = { path, loading: true }
  redraw()
  const data = await loadDiff(io, dir, full)
  if (mod.diff?.path === path) {
    mod.diff = { path, loading: false, data }
    redraw()
  }
}

const allItems = () => (mod.state?.qa.turns ?? []).flatMap(x => x.items ?? [])

const selectedId = () => (mod.state ? selection(mod.view, mod.state.qa.turns) : undefined)

const selectedItem = (): QaItem | undefined => {
  const id = selectedId()
  return id ? allItems().find(i => i.id === id) : undefined
}

type Copy = (text: string, surface: RenderSurface) => Promise<UiCopyResult>

const withItem = (act: (item: QaItem, api: Api) => void) => () => {
  const item = selectedItem()
  if (!item || !mod.api) {
    void say(t('mod_no_item'), 'warning')
    return
  }
  act(item, mod.api)
}

const actions = (copyText: Copy): Actions => ({
  openFile: path => {
    void showDiff(path)
  },
  fileBy: delta => {
    const files = sortedFiles()
    if (!files.length) {
      return
    }
    const at = files.findIndex(f => f.path === mod.view.file)
    const next = files[at < 0 ? 0 : Math.max(0, Math.min(files.length - 1, at + delta))]
    if (next) {
      void showDiff(next.path)
    }
  },
  closeDiff: () => {
    mod.diff = undefined
    mod.view.file = undefined
    redraw()
  },
  unusedKey: key => {
    void say(t('mod_key_unused', key), 'suggestion')
  },
  toggleHelp: () => {
    mod.view.help = !mod.view.help
    redraw()
  },
  setTab: (tab: TabValue) => {
    mod.view.tab = tab
    mod.view.help = false
    redraw()
    if (tab === Tab.FLOW) {
      void loadFlow()
    }
  },
  flowBy: delta => {
    const flows = mod.state?.flows ?? []
    if (!flows.length) {
      return
    }
    const { index } = currentFlow(flows, mod.view.flowId)
    mod.view.flowId = flows[Math.max(0, Math.min(flows.length - 1, index + delta))]?.id
    mod.view.step = 0
    redraw()
    void loadFlow()
  },
  stepTo: step => {
    const id = flowId()
    const steps = (id && mod.flows.get(id)?.flow?.steps?.length) || 1
    mod.view.step = Math.max(0, Math.min(steps - 1, step))
    redraw()
  },
  select: id => {
    mod.view.selected = id
    redraw()
  },
  cycleStatus: withItem((item, api) => {
    const status = STATUS_CYCLE[item.status ?? ''] ?? Status.ANSWERED
    void run(() => api.setStatus(item.id, status), t('term_status_set', t(`st_${status}`)))
  }),
  autoStatus: withItem((item, api) => {
    void run(() => api.setStatus(item.id, null), t('term_status_auto'))
  }),
  archive: withItem((item, api) => {
    const archived = !item.archived
    void run(() => api.setArchived(item.id, archived), t(archived ? 'term_archived' : 'term_restored'))
  }),
  copy: (press: UiPressArgument) => {
    const item = selectedItem()
    if (!item) {
      void say(t('mod_no_item'), 'warning')
      return
    }
    const text = t('ask_message', (item.question ?? '').split(/\s+/).filter(Boolean).join(' '))
    void copyText(text, press.surface).then(
      r => say(t(r.isCopied ? 'copy_done' : 'copy_failed'), r.isCopied ? 'success' : 'error'),
      () => say(t('copy_failed'), 'error'),
    )
  },
  recheck: () => {
    const id = selectedId()
    const api = mod.api
    if (!id || !api) {
      void say(t('mod_no_item'), 'warning')
      return
    }
    void confirmed(`qa:r:${id}`).then(ok => {
      if (!ok) {
        return
      }
      const turn = rowTurn(id)
      const params = turn ? { target: Regen.QA, turn } : { target: Regen.QA, item: id }
      return run(() => api.regen(params), t('qa_checking'))
    })
  },
  rebuild: () => {
    const api = mod.api
    if (!api) {
      return
    }
    void confirmed('flow:r').then(ok => (ok ? run(() => api.regen({ target: Regen.FLOW }), t('flow_started')) : undefined))
  },
  toggleOpenOnly: () => {
    mod.view.openOnly = !mod.view.openOnly
    pruneSelection()
    void say(`${t('qa_open_only')}: ${t(mod.view.openOnly ? 'on' : 'off')}`, 'suggestion')
  },
  toggleArchived: () => {
    mod.view.showArchived = !mod.view.showArchived
    pruneSelection()
    void say(`${t('qa_archived')}: ${t(mod.view.showArchived ? 'on' : 'off')}`, 'suggestion')
  },
  openBrowser: () => {
    const api = mod.api
    if (!api) {
      return
    }
    void api.open(mod.view.tab).then(reply => {
      if (!isOk(reply)) {
        return say(t('term_failed', reply.status === FETCH_ERROR ? t('server_down') : (reply.error ?? t('unknown_err'))), 'error')
      }
    })
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
    parts.push(`Q&A ✓ ${n.answered}  ◐ ${n.partial}  ✗ ${n.unanswered}`)
  }
  if (s.qa.pending) {
    parts.push(`⠋ ${t('qa_checking')}`)
  } else if (waiting) {
    parts.push(`⏳ ${s.qa.auto ? t('mod_band_waiting', waiting, s.qa.eta) : `${waiting}  ${t('qa_wait_off')}`}`)
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
    const [cmux, orca, iterm, home, data, port, legacyPort, child, session] = await Promise.all([
      $.env.get('CMUX_PANEL_ID'),
      $.env.get('ORCA_PANE_KEY'),
      $.env.get('ITERM_SESSION_ID'),
      $.env.get('HOME'),
      $.env.get('SIDE_INSIGHTS_DATA'),
      $.env.get('SIDE_INSIGHTS_PORT'),
      $.env.get('CLAUDE_PANEL_PORT'),
      $.env.get('SIDE_INSIGHTS_CHILD'),
      $.session.id(),
    ])
    mod.quiet = !e.isInteractive || !!child
    bind(
      {
        fetch: (url, init) => $.http.fetch(url, init),
        read: path => $.fs.read(path),
        run: (argv, init) => $.process.run(argv, init),
        toast: text => $.ui.toast(text),
        invalidate: () => $.ui.invalidate('ui.render'),
        blit: (key, columns, rows, cells) => $.ui.blit({ requestId: PANE, key, columns, rows, cells }),
        every: (ms, fn) => $.clock.every(ms, fn),
        theme: async () => {
          const row = (await $.config.list()).find(r => r.key === 'theme')
          return row?.value === undefined ? undefined : String(row.value)
        },
        now: () => $.clock.now(),
        root: $.plugin.root,
      },
      { cmux, orca, iterm, home, data, port, legacyPort, child, session },
    )
    mod.timer?.cancel()
    mod.timer = mod.quiet ? undefined : $.clock.every(POLL_MS, () => void poll())
    for (const name of COMMANDS) {
      try {
        await $.command.register({ name, description: COMMAND_DESCRIPTION, immediate: true })
      } catch {
        continue
      }
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (mod.io && mod.env) {
      bind(mod.io, { ...mod.env, session: await $.session.id() })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: ['side-insights', 'si'] }, async $ => {
    mod.paneOpen = true
    if (mod.io) {
      await loadTheme(mod.io)
    }
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    animate(true)
    void poll()
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    mod.paneOpen = false
    animate(false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
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
    mod.heroCols = e.props.bodyColumns
    const c: Ctx = {
      ui,
      raster: e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined,
      p: mod.palette,
      tick: mod.tick,
      s: mod.state,
      t,
      cols: e.props.bodyColumns,
      view: mod.view,
      surface: e.surface,
      selected: selectedId(),
      flow: id ? mod.flows.get(id) : undefined,
      flowLoading: !!id && mod.flowLoading === id,
      act: actions((text, surface) => $.ui.copy({ text, surface })),
      pageUrl: mod.api?.pageUrl() ?? '',
      problem: problem(),
      diff: mod.diff,
    }
    const body = mod.view.help ? help(c) : mod.view.tab === Tab.FLOW ? flow(c) : mod.view.tab === Tab.LIVE ? live(c) : qa(c)
    return (
      <Box flexDirection="column" width={e.props.bodyColumns} minHeight={e.props.scroll.bodyRows} paddingX={PAD} paddingY={1} backgroundColor={hex(mod.palette.base)}>
        {keyCatcher(c)}
        {header(c)}
        {body}
        {footer(c)}
      </Box>
    )
  })
}
