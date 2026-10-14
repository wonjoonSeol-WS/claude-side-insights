import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

export type Io = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  read: (path: string) => Promise<string>
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  toast: (text: string) => void
  invalidate: () => void
  blit: (key: string, columns: number, rows: number, cells: string) => Promise<unknown>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  theme: () => Promise<string | undefined>
  systemDark: () => Promise<boolean | undefined>
  now: () => Promise<number>
  root: string
}

export type Env = {
  cmux?: string
  orca?: string
  iterm?: string
  home?: string
  data?: string
  port?: string
  legacyPort?: string
  child?: string
  session: string
  windows?: boolean
  gitBash?: string
  localAppData?: string
}

type Run = (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>

const THEME_PROBE_MS = 2000
const WINDOWS_THEME = ['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme']
const GNOME_THEME = ['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme']

export const probeSystemDark = async (run: Run): Promise<boolean | undefined> => {
  const probe = (argv: readonly string[]) => run(argv, { timeoutMs: THEME_PROBE_MS }).catch(() => undefined)
  const mac = await probe(['/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle'])
  if (mac) {
    return mac.stdout.trim().toLowerCase() === 'dark' ? true : /does not exist/.test(mac.stderr) ? false : undefined
  }
  const windows = await probe(WINDOWS_THEME)
  const light = windows && /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(windows.stdout)
  if (light) {
    return parseInt(light[1] ?? '1', 16) === 0
  }
  const gnome = await probe(GNOME_THEME)
  if (gnome?.exitCode === 0) {
    return /dark/.test(gnome.stdout) ? true : /default|light/.test(gnome.stdout) ? false : undefined
  }
  return undefined
}

const WINDOWS_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']

export const bashCandidates = (env: Env | undefined): string[] =>
  env?.windows
    ? [...(env.gitBash ? [env.gitBash] : []), ...WINDOWS_BASH, ...(env.localAppData ? [`${env.localAppData}\\Programs\\Git\\bin\\bash.exe`] : [])]
    : ['/bin/bash', 'bash']

export const isAbsolutePath = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

export const Status = { ANSWERED: 'answered', PARTIAL: 'partial', UNANSWERED: 'unanswered' } as const
export const ToolState = { RUN: 'run', OK: 'ok', ERR: 'err', LOST: 'lost' } as const
export const RecordStatus = { OK: 'ok', ERROR: 'error' } as const
export const Source = { PROMPT: 'prompt', MID_TURN: 'mid-turn' } as const
export const Regen = { QA: 'qa', FLOW: 'flow' } as const
export const Kind = {
  INPUT: 'input',
  LOGIC: 'logic',
  EXTERNAL: 'external',
  STORAGE: 'storage',
  OUTPUT: 'output',
  CONFIG: 'config',
  TEST: 'test',
} as const
export const CheckStatus = { PASS: 'pass', FAIL: 'fail' } as const

export type Tool = {
  tool: string
  label?: string
  summary?: string
  file?: string | null
  state: string
  start?: number | null
  end?: number | null
  reason?: string | null
}
export type FileChange = { path: string; count: number; created: boolean; last: number }
export type FlowRef = { id: string; ts: number; status: string; title: string }
export type QaItem = {
  id: string
  question?: string
  answer?: string
  status?: string
  from?: string
  archived?: boolean
  manual?: boolean
  first_status?: string
  auto_status?: string
  resolved_in?: string
  rechecked_at?: number
}
export type QaTurn = { turn_id: string; ts?: number; prompt?: string; status?: string; model?: string; items?: QaItem[]; skipped_turns?: number }
type Waiting = { ts?: number; text: string; mid_turn?: boolean }
export const Setting = { MODEL: 'model', LANG: 'lang', FLOW_AUTO: 'flow_auto', QA_AUTO: 'qa_auto', QA_BATCH: 'qa_batch', ANALYZE: 'analyze', ENABLED: 'enabled', PANEL_AUTO: 'panel_auto', THEME: 'theme' } as const
export const Analyze = { OPENED: 'opened', ALL: 'all' } as const
export type SettingKey = (typeof Setting)[keyof typeof Setting]
type Settings = { model: string; lang: string; flow_auto: boolean; qa_auto: boolean; qa_batch?: number; analyze?: string; enabled?: boolean; panel_auto: boolean; theme?: string }
export type ConfigPayload = {
  global?: Settings
  pane?: Partial<Settings>
  effective?: Settings
  models?: string[]
  themes?: string[]
  analyze?: string[]
  qa_batches?: number[]
  langs?: { code: string; label: string }[]
}
export const Scope = { GLOBAL: 'global', PANE: 'pane' } as const
export type ScopeValue = (typeof Scope)[keyof typeof Scope]
type QaCounts = { answered: number; partial: number; unanswered: number; open: number; total: number }
export type PanelState = {
  activity: { sid?: string | null; cwd?: string | null; busy?: boolean; tools: Tool[]; files: FileChange[] }
  flows: FlowRef[]
  pending: unknown
  qa: { sid?: string | null; turns: QaTurn[]; pending: boolean; waiting: Waiting[]; eta: number; auto: boolean; batch?: number; counts?: QaCounts }
}
export type FlowStep = {
  title?: string
  location?: string
  kind?: string
  changed?: boolean
  explanation?: string
  code?: string
  highlight?: string[]
  data?: { name?: string; before?: string | null; after?: string | null }[]
}
export type FlowRecord = {
  ts?: number
  turn_ids?: string[]
  cwd?: string
  edited?: string[]
  status?: string
  error?: string
  prompt?: string
  model?: string
  cost?: number
  flow?: {
    title?: string
    summary?: string
    example?: string
    steps?: FlowStep[]
    changes?: { file?: string; what?: string }[]
    checks?: { label?: string; status?: string; steps?: number[] }[]
  }
}

const DEFAULT_PORT = 47821
const KEY_MAX_BYTES = 80
const LANGS = ['en', 'ko', 'ja'] as const
const DEFAULT_LANG = 'en'
const TOKEN_HEADER = 'X-Side-Insights'
export const FETCH_ERROR = -1

type Conn = { base: string; page: string; key: string; dataDir: string }

const paneKey = (raw: string): string => {
  const bytes = new TextEncoder().encode(raw)
  let out = ''
  for (const b of bytes) {
    const c = String.fromCharCode(b)
    out += /[A-Za-z0-9_.-]/.test(c) && b < 128 ? c : '_'
  }
  out = out.slice(-KEY_MAX_BYTES)
  return /^[.-]/.test(out) ? `_${out.slice(1)}` : out
}

const port = (value: string | undefined): number => {
  const n = /^\d+$/.test(value ?? '') ? Number(value) : DEFAULT_PORT
  return n >= 1024 && n <= 65535 ? n : DEFAULT_PORT
}

export const connect = (env: Env): Conn => {
  const raw = env.cmux || env.orca || env.iterm || env.session
  const dataDir = env.data || `${env.home ?? ''}/.claude/side-insights`
  const p = port(env.port || env.legacyPort)
  return { base: `http://127.0.0.1:${p}`, page: `http://localhost:${p}`, key: paneKey(raw), dataDir }
}

export type Reply<T> = { status: number; data?: T; error?: string }

export const isOk = (reply: Reply<unknown>) => reply.status >= 200 && reply.status < 300

const TURN_ROW = 'turn:'
export const turnRow = (turnId: string) => `${TURN_ROW}${turnId}`
export const rowTurn = (row: string) => (row.startsWith(TURN_ROW) ? row.slice(TURN_ROW.length) : undefined)

export class Api {
  private token: string | undefined

  constructor(
    private readonly io: Io,
    readonly conn: Conn,
  ) {}

  async readToken(): Promise<string | undefined> {
    try {
      this.token = (await this.io.read(`${this.conn.dataDir}/token`)).trim() || undefined
    } catch {
      this.token = undefined
    }
    return this.token
  }

  pageUrl(): string {
    return `${this.conn.page}/p/${this.conn.key}?t=${encodeURIComponent(this.token ?? '')}&full=1`
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    if (!this.token && !(await this.readToken())) {
      return { status: FETCH_ERROR }
    }
    let res: HttpResponse
    try {
      res = await this.io.fetch(`${this.conn.base}${path}`, {
        method,
        headers: { [TOKEN_HEADER]: this.token ?? '', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      return { status: FETCH_ERROR }
    }
    let parsed: unknown
    try {
      parsed = res.text ? JSON.parse(res.text) : undefined
    } catch {
      parsed = undefined
    }
    if (!res.ok) {
      if (res.status === 403) {
        this.token = undefined
      }
      return { status: res.status, error: (parsed as { error?: string } | undefined)?.error }
    }
    return { status: res.status, data: parsed as T }
  }

  state = () => this.call<PanelState>('GET', `/api/${this.conn.key}/state`)
  flow = (id: string) => this.call<FlowRecord>('GET', `/api/${this.conn.key}/flow/${encodeURIComponent(id)}`)
  config = () => this.call<ConfigPayload>('GET', `/api/config${query({ pane: this.conn.key })}`)
  saveConfig = (update: Partial<Record<SettingKey, string | boolean | number | null>>, scope: ScopeValue) =>
    this.call<ConfigPayload>('POST', `/api/config${query({ pane: scope === Scope.PANE ? this.conn.key : undefined })}`, update)
  override = (id: string, change: { status: string | null } | { archived: boolean }) => this.call('POST', `/api/${this.conn.key}/qa/override`, { id, ...change })
  open = (mode: string) => this.call('POST', `/api/${this.conn.key}/open?mode=${encodeURIComponent(mode)}`)
  regen = (params: Record<string, string | undefined>) => this.call('POST', `/api/${this.conn.key}/regen${query(params)}`)
  diff = (path: string, view: DiffViewValue, flow?: string) => this.call<FileDiff>('GET', `/api/${this.conn.key}/diff${query({ path, view, flow })}`)
}

const query = (params: Record<string, string | undefined>) => {
  const pairs = Object.entries(params)
    .filter((kv): kv is [string, string] => !!kv[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}

export type Messages = Record<string, string>

export const langCode = (lang: string | undefined): string => LANGS.find(l => l === lang) ?? DEFAULT_LANG

export const loadMessages = async (io: Io, lang: string | undefined): Promise<Messages> => {
  const read = async (code: string): Promise<Messages> => {
    try {
      return JSON.parse(await io.read(`${io.root}/src/side_insights/locales/${code}.json`)) as Messages
    } catch {
      return {}
    }
  }
  const code = langCode(lang)
  const fallback = await read(DEFAULT_LANG)
  return code === DEFAULT_LANG ? fallback : { ...fallback, ...(await read(code)) }
}

export const format = (messages: Messages, key: string, ...args: (string | number)[]): string =>
  (Object.hasOwn(messages, key) ? (messages[key] ?? key) : key).replace(/\{(\d+)\}/g, (m, i: string) =>
    Object.hasOwn(args, Number(i)) ? String(args[Number(i)]) : m,
  )

export const counts = (qa: PanelState['qa'] | undefined): QaCounts => {
  if (qa?.counts) {
    return qa.counts
  }
  const items = (qa?.turns ?? []).flatMap(t => (t.items ?? []).filter(i => !i.archived))
  const of = (s: string) => items.filter(i => i.status === s).length
  const partial = of(Status.PARTIAL)
  const unanswered = of(Status.UNANSWERED)
  return { answered: of(Status.ANSWERED), partial, unanswered, open: partial + unanswered, total: items.length }
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export const cells = (text: string): number => {
  let n = 0
  for (const ch of text) {
    n += WIDE.test(ch) || (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1
  }
  return n
}

export const fit = (text: string, max: number): string => {
  if (cells(text) <= max) {
    return text
  }
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > max - 1) {
      break
    }
    out += ch
  }
  return `${out}…`
}

export const clock = (ts: number | null | undefined, seconds = false): string => {
  if (!ts) {
    return '--:--'
  }
  const d = new Date(ts * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`
}

export const duration = (seconds: number): string => {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

export const DiffSource = { WORKING: 'working', NEW: 'new', COMMIT: 'commit', FILE: 'file', NONE: 'none' } as const
type DiffSourceValue = (typeof DiffSource)[keyof typeof DiffSource]
export type FileDiff = { source: DiffSourceValue; hunks: string; cut: number; commit?: string; error?: string; text?: string }
export const DiffView = { AUTO: 'auto', WORKING: 'working', COMMIT: 'commit', FILE: 'file' } as const
export type DiffViewValue = (typeof DiffView)[keyof typeof DiffView]
export type DiffState = { path: string; loading: boolean; data?: FileDiff; view: DiffViewValue }

export const noDiff = (error?: string): FileDiff => ({ source: DiffSource.NONE, hunks: '', cut: 0, ...(error ? { error } : {}) })
