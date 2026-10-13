import type { Register, RenderSurface, UiCopyResult, UiPressArgument } from 'claude-code'

import {
  Api,
  RecordStatus,
  Regen,
  STATUS_CYCLE,
  Status,
  cells,
  connect,
  counts,
  fit,
  format,
  loadMessages,
  type Env,
  type Io,
  type FlowRecord,
  type Messages,
  type PanelState,
  type QaItem,
} from './data'
import { Tab, flow, footer, header, live, qa, visibleTurns, type Actions, type Ctx, type TabValue, type View } from './views'

const PANE = 'side-insights'
const PANE_TITLE = 'Side insights'
const COMMAND_DESCRIPTION = 'Open the side insights pane: Flow, Live and Q&A'
const POLL_MS = 2000
const IDLE_EVERY = 3
const CONFIG_EVERY = 15
const START_RETRY_MS = 60_000
const START_TIMEOUT_MS = 8000
const CONFIRM_MS = 4000
const NOTE_MS = 5000
const SEP = '  |  '
const OPEN_STATUSES = new Set<string>([Status.PARTIAL, Status.UNANSWERED])

type Mod = {
  io?: Io
  api?: Api
  timer?: { cancel: () => void }
  ticks: number
  state?: PanelState
  down: boolean
  lastStart: number
  messages: Messages
  flows: Map<string, FlowRecord>
  flowLoading?: string
  seenFlows?: Set<string>
  seenTurns?: Set<string>
  paneOpen: boolean
  view: View
  confirm?: { key: string; until: number }
  noteUntil: number
}

const mod: Mod = {
  ticks: 0,
  down: false,
  lastStart: -Infinity,
  messages: {},
  flows: new Map(),
  paneOpen: false,
  view: { tab: Tab.QA, flowIndex: 0, step: 0, openOnly: false, showArchived: false },
  noteUntil: 0,
}

const t = (key: string, ...args: (string | number)[]) => format(mod.messages, key, ...args)

const redraw = () => mod.io?.invalidate()

const say = (text: string, color = 'success') => {
  mod.view.note = { text, color }
  mod.noteUntil = Date.now() + NOTE_MS
  redraw()
}

const startServer = async (io: Io) => {
  const now = await io.now()
  if (now - mod.lastStart < START_RETRY_MS) {
    return
  }
  mod.lastStart = now
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
  for (const f of ready.filter(f => !mod.seenFlows?.has(f.id))) {
    mod.seenFlows.add(f.id)
    io.toast(t('mod_toast_flow', f.title))
  }
  for (const turn of turns.filter(x => !mod.seenTurns?.has(x.turn_id))) {
    mod.seenTurns.add(turn.turn_id)
    const open = (turn.items ?? []).filter(i => !i.archived && OPEN_STATUSES.has(i.status ?? '')).length
    if (open) {
      io.toast(t('mod_toast_open', open))
    }
  }
}

const loadFlow = async () => {
  const id = mod.state?.flows[Math.min(mod.view.flowIndex, mod.state.flows.length - 1)]?.id
  if (!mod.api || !id || mod.flows.has(id) || mod.flowLoading === id) {
    return
  }
  mod.flowLoading = id
  const reply = await mod.api.flow(id)
  mod.flowLoading = undefined
  if (reply.data) {
    mod.flows.set(id, reply.data)
  }
  redraw()
}

const poll = async () => {
  const io = mod.io
  if (!io || !mod.api) {
    return
  }
  mod.ticks += 1
  const s = mod.state
  const quiet = !!s && !mod.paneOpen && !s.activity.busy && !s.qa.waiting.length && !s.qa.pending
  if (quiet && mod.ticks % IDLE_EVERY !== 0) {
    return
  }
  if (mod.ticks === 1 || mod.ticks % CONFIG_EVERY === 0 || !Object.keys(mod.messages).length) {
    const config = await mod.api.config()
    if (config.data || !Object.keys(mod.messages).length) {
      mod.messages = await loadMessages(io, config.data?.effective?.lang)
    }
  }
  const reply = await mod.api.state()
  if (reply.data) {
    mod.state = reply.data
    mod.down = false
    toasts(io, reply.data)
    if (mod.paneOpen && mod.view.tab === Tab.FLOW) {
      await loadFlow()
    }
  } else {
    mod.down = true
    await startServer(io)
  }
  if (mod.view.note && Date.now() > mod.noteUntil) {
    mod.view.note = undefined
  }
  redraw()
}

const bind = (io: Io, env: Env) => {
  mod.io = io
  mod.api = new Api(io, connect(env))
  void poll()
}

const confirmed = (key: string) => {
  const now = Date.now()
  if (mod.confirm?.key === key && mod.confirm.until > now) {
    mod.confirm = undefined
    return true
  }
  mod.confirm = { key, until: now + CONFIRM_MS }
  say(t('term_confirm', key), 'warning')
  return false
}

const run = async (action: () => Promise<{ status: number; error?: string }>, done: string) => {
  const reply = await action()
  if (reply.status >= 200 && reply.status < 300) {
    say(done)
    await poll()
  } else {
    say(t('term_failed', reply.error ? t(reply.error) : t('mod_server_down')), 'error')
  }
}

const selectedItem = (): QaItem | undefined => {
  const id = mod.view.selected
  return id ? allItems().find(i => i.id === id) : undefined
}

const allItems = () => (mod.state?.qa.turns ?? []).flatMap(x => x.items ?? [])

type Copy = (text: string, surface: RenderSurface) => Promise<UiCopyResult>

const actions = (copyText: Copy): Actions => ({
  setTab: (tab: TabValue) => {
    mod.view.tab = tab
    redraw()
    if (tab === Tab.FLOW) {
      void loadFlow()
    }
  },
  flowBy: delta => {
    const n = mod.state?.flows.length ?? 0
    mod.view.flowIndex = Math.max(0, Math.min(n - 1, mod.view.flowIndex + delta))
    mod.view.step = 0
    redraw()
    void loadFlow()
  },
  stepTo: step => {
    const id = mod.state?.flows[mod.view.flowIndex]?.id
    const steps = (id && mod.flows.get(id)?.flow?.steps?.length) || 1
    mod.view.step = Math.max(0, Math.min(steps - 1, step))
    redraw()
  },
  select: id => {
    mod.view.selected = id
    redraw()
  },
  cycleStatus: () => {
    const item = selectedItem()
    if (!item || !mod.api) {
      return say(t('mod_no_item'), 'warning')
    }
    const status = STATUS_CYCLE[item.status ?? ''] ?? Status.ANSWERED
    void run(() => mod.api!.setStatus(item.id, status), t('term_status_set', t(`st_${status}`)))
  },
  autoStatus: () => {
    const item = selectedItem()
    if (!item || !mod.api) {
      return say(t('mod_no_item'), 'warning')
    }
    void run(() => mod.api!.setStatus(item.id, null), t('term_status_auto'))
  },
  archive: () => {
    const item = selectedItem()
    if (!item || !mod.api) {
      return say(t('mod_no_item'), 'warning')
    }
    const archived = !item.archived
    void run(() => mod.api!.setArchived(item.id, archived), t(archived ? 'term_archived' : 'term_restored'))
  },
  copy: (press: UiPressArgument) => {
    const item = selectedItem()
    if (!item) {
      return say(t('mod_no_item'), 'warning')
    }
    const text = t('ask_message', (item.question ?? '').split(/\s+/).filter(Boolean).join(' '))
    void copyText(text, press.surface).then(
      r => say(t(r.isCopied ? 'copy_done' : 'copy_failed'), r.isCopied ? 'success' : 'error'),
      () => say(t('copy_failed'), 'error'),
    )
  },
  recheck: () => {
    const id = mod.view.selected
    if (!id || !mod.api) {
      return say(t('mod_no_item'), 'warning')
    }
    if (!confirmed('r')) {
      return
    }
    const params = id.startsWith('turn:') ? { target: Regen.QA, turn: id.slice('turn:'.length) } : { target: Regen.QA, item: id }
    void run(() => mod.api!.regen(params), t('qa_checking'))
  },
  rebuild: () => {
    if (!mod.api || !confirmed('r')) {
      return
    }
    void run(() => mod.api!.regen({ target: Regen.FLOW }), t('flow_started'))
  },
  toggleOpenOnly: () => {
    mod.view.openOnly = !mod.view.openOnly
    say(`${t('qa_open_only')}: ${t(mod.view.openOnly ? 'on' : 'off')}`, 'suggestion')
  },
  toggleArchived: () => {
    mod.view.showArchived = !mod.view.showArchived
    say(`${t('qa_archived')}: ${t(mod.view.showArchived ? 'on' : 'off')}`, 'suggestion')
  },
  openBrowser: () => {
    if (!mod.api || !mod.io) {
      return
    }
    void mod.io.run(['/usr/bin/open', mod.api.pageUrl()], {}).catch(() => say(t('mod_server_down'), 'error'))
  },
})

const defaultSelection = () => {
  if (mod.view.selected || !mod.state) {
    return
  }
  const first = visibleTurns(mod, mod.state.qa.turns)
    .flatMap(x => x.shown)
    .find(i => OPEN_STATUSES.has(i.status ?? ''))
  mod.view.selected = first?.id
}

const bandLine = (cols: number): string | undefined => {
  if (mod.down) {
    return fit(t('mod_server_down'), cols)
  }
  const s = mod.state
  if (!s) {
    return undefined
  }
  const n = counts(s.qa.turns)
  const waiting = s.qa.waiting.length
  const latest = s.flows.find(f => f.status === RecordStatus.OK)
  const parts: string[] = []
  if (n.total) {
    parts.push(`Q&A ✓ ${n.answered}  ◐ ${n.partial}  ✗ ${n.unanswered}`)
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
  const hint = t('mod_band_hint')
  const line = [...parts, hint].join(SEP)
  if (cells(line) <= cols) {
    return line
  }
  const bare = parts.join(SEP)
  return fit(bare, cols)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'side-insights', description: COMMAND_DESCRIPTION, immediate: true })
    await $.command.register({ name: 'si', description: COMMAND_DESCRIPTION, immediate: true })
    bind(
      {
        fetch: (url, init) => $.http.fetch(url, init),
        read: path => $.fs.read(path),
        run: (argv, init) => $.process.run(argv, init),
        toast: text => $.ui.toast(text),
        invalidate: () => $.ui.invalidate('ui.render'),
        now: () => $.clock.now(),
        root: $.plugin.root,
      },
      {
        cmux: await $.env.get('CMUX_PANEL_ID'),
        orca: await $.env.get('ORCA_PANE_KEY'),
        iterm: await $.env.get('ITERM_SESSION_ID'),
        home: await $.env.get('HOME'),
        data: await $.env.get('SIDE_INSIGHTS_DATA'),
        port: await $.env.get('SIDE_INSIGHTS_PORT'),
        legacyPort: await $.env.get('CLAUDE_PANEL_PORT'),
        session: await $.session.id(),
      },
    )
    mod.timer?.cancel()
    mod.timer = $.clock.every(POLL_MS, () => void poll())
    return next(e)
  })

  on('command.run', { command: 'side-insights' }, async $ => {
    mod.paneOpen = true
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    void poll()
    return {}
  })

  on('command.run', { command: 'si' }, async $ => {
    mod.paneOpen = true
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    void poll()
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      mod.paneOpen = false
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const line = bandLine(e.props.bodyColumns)
    if (!line) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    return (
      <Text color={mod.down ? 'warning' : undefined} dimColor={!mod.down} wrap="truncate-end">
        {line}
      </Text>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const waiting = mod.state?.qa.waiting.length ?? 0
    if (!waiting) {
      return next(e)
    }
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} (${t('mod_spinner_waiting', waiting)})` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    mod.paneOpen = true
    defaultSelection()
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const id = mod.state?.flows[Math.min(mod.view.flowIndex, Math.max(0, (mod.state?.flows.length ?? 1) - 1))]?.id
    const c: Ctx = {
      ui,
      s: mod.state,
      t,
      cols: e.props.bodyColumns,
      view: mod.view,
      flow: id ? mod.flows.get(id) : undefined,
      flowLoading: !!id && mod.flowLoading === id,
      act: actions((text, surface) => $.ui.copy({ text, surface })),
      pageUrl: mod.api?.pageUrl() ?? '',
      down: mod.down,
    }
    const body = mod.view.tab === Tab.FLOW ? flow(c) : mod.view.tab === Tab.LIVE ? live(c) : qa(c)
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {header(c)}
        {footer(c)}
        {body}
      </Box>
    )
  })
}

