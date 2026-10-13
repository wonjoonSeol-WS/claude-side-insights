import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

export type Io = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  read: (path: string) => Promise<string>
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  toast: (text: string) => void
  invalidate: () => void
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
  session: string
}

export const Status = { ANSWERED: 'answered', PARTIAL: 'partial', UNANSWERED: 'unanswered' } as const
export type StatusValue = (typeof Status)[keyof typeof Status]
export const STATUS_CYCLE: Record<string, StatusValue> = {
  [Status.ANSWERED]: Status.PARTIAL,
  [Status.PARTIAL]: Status.UNANSWERED,
  [Status.UNANSWERED]: Status.ANSWERED,
}
export const ToolState = { RUN: 'run', OK: 'ok', ERR: 'err', LOST: 'lost' } as const
export const RecordStatus = { OK: 'ok', ERROR: 'error' } as const
export const Source = { PROMPT: 'prompt', MID_TURN: 'mid-turn' } as const
export const Regen = { QA: 'qa', FLOW: 'flow' } as const

export type Tool = {
  tool: string
  label?: string
  summary?: string
  file?: string | null
  state: string
  start?: number | null
  end?: number | null
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
export type QaTurn = { turn_id: string; ts?: number; prompt?: string; status?: string; model?: string; items?: QaItem[] }
export type Waiting = { ts?: number; text: string; mid_turn?: boolean }
export type PanelState = {
  activity: { sid?: string | null; cwd?: string | null; busy?: boolean; tools: Tool[]; files: FileChange[] }
  flows: FlowRef[]
  pending: unknown
  qa: { sid?: string | null; turns: QaTurn[]; pending: boolean; waiting: Waiting[]; eta: number; auto: boolean }
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
    checks?: { label?: string; status?: string }[]
  }
}

const DEFAULT_PORT = 47821
const KEY_MAX_BYTES = 80
const LANGS = ['en', 'ko', 'ja'] as const
const DEFAULT_LANG = 'en'
const TOKEN_HEADER = 'X-Side-Insights'
const FETCH_ERROR = -1

export type Conn = { base: string; page: string; key: string; dataDir: string }

export const paneKey = (raw: string): string => {
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
    try {
      const res = await this.io.fetch(`${this.conn.base}${path}`, {
        method,
        headers: { [TOKEN_HEADER]: this.token ?? '', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const parsed = res.text ? (JSON.parse(res.text) as unknown) : undefined
      if (!res.ok) {
        const error = (parsed as { error?: string } | undefined)?.error
        if (res.status === 403) {
          this.token = undefined
        }
        return { status: res.status, error }
      }
      return { status: res.status, data: parsed as T }
    } catch {
      return { status: FETCH_ERROR }
    }
  }

  state = () => this.call<PanelState>('GET', `/api/${this.conn.key}/state`)
  flow = (id: string) => this.call<FlowRecord>('GET', `/api/${this.conn.key}/flow/${encodeURIComponent(id)}`)
  config = () => this.call<{ effective?: { lang?: string } }>('GET', `/api/config?pane=${encodeURIComponent(this.conn.key)}`)
  setStatus = (id: string, status: string | null) => this.call('POST', `/api/${this.conn.key}/qa/override`, { id, status })
  setArchived = (id: string, archived: boolean) => this.call('POST', `/api/${this.conn.key}/qa/override`, { id, archived })

  regen(params: Record<string, string | undefined>) {
    const query = Object.entries(params)
      .filter((kv): kv is [string, string] => !!kv[1])
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return this.call('POST', `/api/${this.conn.key}/regen?${query}`)
  }
}

export type Messages = Record<string, string>

export const loadMessages = async (io: Io, lang: string | undefined): Promise<Messages> => {
  const read = async (code: string): Promise<Messages> => {
    try {
      return JSON.parse(await io.read(`${io.root}/src/side_insights/locales/${code}.json`)) as Messages
    } catch {
      return {}
    }
  }
  const code = LANGS.find(l => l === lang) ?? DEFAULT_LANG
  const fallback = await read(DEFAULT_LANG)
  return code === DEFAULT_LANG ? fallback : { ...fallback, ...(await read(code)) }
}

export const format = (messages: Messages, key: string, ...args: (string | number)[]): string =>
  (messages[key] ?? key).replace(/\{(\d+)\}/g, (m, i: string) => String(args[Number(i)] ?? m))

export const counts = (turns: QaTurn[]) => {
  const items = turns.flatMap(t => (t.items ?? []).filter(i => !i.archived))
  const of = (s: string) => items.filter(i => i.status === s).length
  return { answered: of(Status.ANSWERED), partial: of(Status.PARTIAL), unanswered: of(Status.UNANSWERED), total: items.length }
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

export const highlight = (text: string): string => text.replace(/==([^=\n]+)==/g, '**$1**')
