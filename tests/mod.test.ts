import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

import { Kind, Setting, Status, cells, connect, trimHunks } from '../hooks/mod/data'
import { changeFiles, resolveChange } from '../hooks/mod/select'
import { PILL_STRONG_TINT, PILL_TINT, TAB_TINT, TOGGLES, Tab } from '../hooks/mod/views'
import { AUTO_THEME, DARK, LIGHT, THEMES, hex, mix, resolvePalette, type Palette, type Rgb } from '../hooks/mod/theme'
import { LOCALES } from './locales'

const SURFACES = ['terminal', 'desktop'] as const
const KEY = 'demo'
const PLUGIN = 'side-insights'
const PANE = 'side-insights'
const FILE = '/repo/src/a.ts'

const EN = LOCALES.en
const KO = LOCALES.ko

type Item = { id: string; status: string; question: string; archived?: boolean }

const turn = (id: string, items: Item[]) => ({
  turn_id: id,
  ts: 1791905000,
  status: 'ok',
  model: 'opus',
  prompt: `prompt of ${id}`,
  items: items.map(i => ({ from: 'prompt', answer: `==Answer== to ${i.question}`, archived: false, ...i })),
})

const QUESTION_WITH_SPACES = 'Which  currency\nfor refunds?'

const STATE = {
  activity: {
    sid: 's1',
    cwd: '/repo',
    busy: false,
    tools: [
      { tool: 'Edit', label: 'Edit', summary: 'edit', file: FILE, state: 'ok', start: 1791905000, end: 1791905001 },
      { tool: 'Bash', label: 'Bash', summary: 'npm test', file: null, state: 'err', start: 1791905002, end: 1791905004, reason: 'Exit code 1 FAIL retry.test.ts' },
    ],
    files: [{ path: FILE, count: 2, created: false, last: 1791905001 }],
  },
  flows: [
    { id: 'f2', ts: 1791905100, status: 'ok', title: 'Retry-safe checkout' },
    { id: 'f1', ts: 1791905000, status: 'ok', title: 'Cart total rounding' },
  ],
  pending: null,
  qa: {
    sid: 's1',
    turns: [
      turn('t2', [
        { id: 'i1', status: 'answered', question: 'Does it retry?' },
        { id: 'i2', status: 'partial', question: 'What about the second click?' },
        { id: 'i3', status: 'unanswered', question: 'Is the load test done?' },
      ]),
      turn('t1', [
        { id: 'i4', status: 'unanswered', question: 'Rounding mode?' },
        { id: 'i5', status: 'partial', question: 'Half up or half even?' },
        { id: 'i6', status: 'unanswered', question: QUESTION_WITH_SPACES },
        { id: 'i7', status: 'partial', question: 'An old question', archived: true },
      ]),
    ],
    pending: false,
    waiting: [
      { ts: 1791905200, text: 'and the docs?', mid_turn: true },
      { ts: 1791905201, text: 'ship it?', mid_turn: false },
    ],
    eta: 34,
    auto: true,
  },
}

const FLOW = {
  ts: 1791905100,
  status: 'ok',
  prompt: 'make checkout retry-safe',
  model: 'opus',
  cost: 0.012,
  flow: {
    title: 'Retry-safe checkout',
    summary: 'A key makes ==the second click== safe.',
    example: 'key k-91',
    steps: [
      { title: 'Read the key', location: 'src/checkout/route.ts / post', kind: 'input', changed: false, explanation: 'Reads it.', code: 'const key = req.header("k")', data: [{ name: 'key', after: 'k-91' }] },
      { title: 'Claim the key', location: 'src/checkout/idempotency.ts / claim', kind: 'logic', changed: true, explanation: '==409 on a second click==', code: 'claim(key)', highlight: ['claim'], data: [{ name: 'keys[k-91]', before: '(none)', after: 'in_progress' }] },
    ],
    changes: [{ file: 'src/checkout/idempotency.ts', what: 'New key store' }],
    checks: [
      { label: 'npm test (23 passed)', status: 'pass' },
      { label: 'claim test (409 on a second click)', status: 'pass', steps: [2] },
    ],
  },
}

const FLOW_F1 = {
  ts: 1791905000,
  status: 'ok',
  prompt: 'round the cart total',
  flow: {
    title: 'Cart total rounding',
    summary: 'Totals round half even.',
    steps: [{ title: 'Round the total', location: 'src/cart/total.ts / total', kind: 'logic', changed: true, explanation: 'Rounds.', code: 'round(total)' }],
    changes: [{ file: '~/notes/todo.md,plan.md', what: 'Notes' }],
  },
}

type Call = { url: string; method: string; body?: string }
type Settings = { model: string; lang: string; flow_auto: boolean; qa_auto: boolean; panel_auto: boolean }
type GitOut = { exitCode: number; stdout: string; stderr?: string }

type World = {
  current: unknown
  up: boolean
  stateStatus?: number
  flowStatus?: number
  lang?: string
  sid?: string
  env?: Record<string, string>
  taken?: string[]
  git?: (args: string[]) => GitOut
  files?: Record<string, string>
  messages?: Partial<Record<'en' | 'ko', Record<string, string>>>
  claudeTheme?: string
  systemDark?: boolean
  models?: string[]
  global?: Settings
  panes?: Record<string, Partial<Settings>>
  delay?: (path: string, method: string, body?: string) => number
  inFlight?: number
  maxInFlight?: number
}

const reply = (status: number, data: unknown): { value: HttpResponse } => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) },
})

const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
]

const configPayload = (world: World, pane: string | null) => {
  const global = (world.global ??= { model: 'opus', lang: world.lang ?? 'en', flow_auto: true, qa_auto: true, panel_auto: false })
  const own = pane ? (world.panes?.[pane] ?? {}) : {}
  return { global, pane: own, effective: { ...global, ...own }, models: world.models ?? ['opus', 'sonnet', 'haiku'], langs: LANGS }
}

const setup = (on: On, world: World) => {
  const calls: Call[] = []
  const toasts: string[] = []
  const copied: string[] = []
  const runs: string[][] = []
  const envs: (Record<string, string> | undefined)[] = []
  const registered: string[] = []
  const opened: { title?: string }[] = []
  const events: string[] = []
  const blits: string[] = []
  mock.env(on, world.env ?? { CMUX_PANEL_ID: KEY, HOME: '/home/u' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: world.sid ?? 's1' }))
  on('command.register', async ($, e) => {
    if (world.taken?.includes(e.name)) {
      throw new Error(`/${e.name} is taken`)
    }
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('config.list', async () => ({
    value: world.claudeTheme === undefined ? [] : ([{ key: 'theme', label: 'Theme', kind: 'choice', value: world.claudeTheme, provider: { kind: 'engine' }, isLocked: false }] as never),
  }))
  on('fs.read', async ($, e) => {
    const locale = /\/(en|ko|ja)\.json$/.exec(e.path)?.[1] as 'en' | 'ko' | 'ja' | undefined
    if (locale) {
      return { value: JSON.stringify({ ...LOCALES[locale], ...(world.messages?.[locale as 'en' | 'ko'] ?? {}) }) }
    }
    if (e.path.endsWith('/token')) {
      return { value: 'tok\n' }
    }
    const file = world.files?.[e.path]
    if (file === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: file }
  })
  on('http.fetch', async ($, e) => {
    const method = e.init?.method ?? 'GET'
    calls.push({ url: e.url, method, body: e.init?.body })
    expect(e.init?.headers?.['X-Side-Insights']).toBe('tok')
    if (!world.up) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:47821')
    }
    const path = e.url.replace('http://127.0.0.1:47821', '')
    const pane = new URL(e.url).searchParams.get('pane')
    let answer: { value: HttpResponse }
    if (path.startsWith('/api/config')) {
      if (method === 'POST') {
        const update = JSON.parse(e.init?.body ?? '{}') as Partial<Settings>
        if (pane) {
          world.panes = { ...world.panes, [pane]: { ...world.panes?.[pane], ...update } }
        } else {
          configPayload(world, null)
          world.global = { ...world.global!, ...update }
        }
      }
      answer = reply(200, configPayload(world, pane))
    } else if (path.endsWith('/state')) {
      answer = world.stateStatus ? reply(world.stateStatus, { error: 'Request refused. Reopen the panel and try again.' }) : reply(200, world.current)
    } else if (path === `/api/${KEY}/flow/f2`) {
      answer = world.flowStatus ? reply(world.flowStatus, { error: 'Flow file is unreadable' }) : reply(200, FLOW)
    } else if (path === `/api/${KEY}/flow/f1`) {
      answer = reply(200, FLOW_F1)
    } else if (method === 'POST') {
      answer = reply(200, { ok: true })
    } else {
      answer = reply(404, { error: 'Not found' })
    }
    const wait = world.delay?.(path, method, e.init?.body) ?? 0
    if (wait) {
      world.inFlight = (world.inFlight ?? 0) + 1
      world.maxInFlight = Math.max(world.maxInFlight ?? 0, world.inFlight)
      await clock.sleep(wait)
      world.inFlight -= 1
    }
    return answer
  })
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    envs.push(e.init?.env)
    if (e.argv[0] === '/usr/bin/defaults') {
      events.push('defaults')
      const out = world.systemDark === undefined ? { exitCode: 1, stdout: '', stderr: 'boom' } : world.systemDark ? { exitCode: 0, stdout: 'Dark\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist' }
      return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const out = e.argv[0] === 'git' && world.git ? world.git([...e.argv]) : { exitCode: 0, stdout: '' }
    return { value: { stderr: '', ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.open', async ($, e) => {
    events.push('open')
    opened.push({ title: e.title })
    return { value: { isPlaced: true } as never }
  })
  on('ui.blit', async ($, e) => {
    blits.push(e.key)
    return { value: {} as never }
  })
  on('classic.SessionStart', async () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', props: { key: 'engine-band' }, children: [] }))
  return { calls, toasts, copied, runs, envs, registered, clock, opened, events, blits }
}

const start = async ($: Engine, clock: { settle: () => Promise<void> }, isInteractive = true) => {
  await $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive })
  await clock.settle()
}

const BAND = (bodyColumns: number, hasSurvey = false) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey, isWorking: false, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
})

const PANE_PROPS = {
  component: 'Pane' as const,
  requestId: PANE,
  props: { title: 'Side insights', isFocused: true, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

const RUN_SI = { command: 'si', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const childKeys = (node: unknown) => ((node as Node).children ?? []).map(child => (child as Node).props?.key)

const bandText = async ($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal', hasSurvey = false) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(cols, hasSurvey) })
  const text = (await ui.find({ key: 'side-insights-band' }))?.text
  const engine = await ui.find({ key: 'engine-band' })
  const order = childKeys(await ui.drawn())
  await ui.unmount()
  return { text, engine, order }
}

const mountPane = ($: Engine, surface: string = 'terminal', bodyColumns = 90): Promise<any> =>
  $.ui.mount({ plugin: PLUGIN, surface, ...PANE_PROPS, props: { ...PANE_PROPS.props, bodyColumns } } as never)

const background = async (ui: { drawn: () => Promise<unknown> }) => (await ui.drawn() as Node).props?.backgroundColor


test('pane key: terminal ids win in cmux, orca, iterm order, then the session id', async () => {
  const base = { home: '/h', session: 'sess-1' }
  const cases: [Record<string, string>, string][] = [
    [{ cmux: 'cmux-1', orca: 'orca-1', iterm: 'w0t0p0:AB' }, 'cmux-1'],
    [{ cmux: '', orca: 'orca-1', iterm: 'w0t0p0:AB' }, 'orca-1'],
    [{ iterm: 'w0t0p0:AB' }, 'w0t0p0_AB'],
    [{}, 'sess-1'],
  ]
  for (const [env, key] of cases) {
    expect(connect({ ...base, ...env }).key).toBe(key)
  }
})

test('every dynamic key the mod builds (tab, status, kind, setting) is in every language', () => {
  const keys = [
    ...Object.values(Tab).map(x => `mode_${x}`),
    ...Object.values(Status).map(x => `st_${x}`),
    ...Object.values(Kind).map(x => `kind_${x}`),
    ...TOGGLES.map(x => `s_${x}`),
    `s_${Setting.LANG}`,
    `s_${Setting.MODEL}`,
    `s_${Setting.THEME}`,
    ...[AUTO_THEME, ...Object.keys(THEMES)].map(x => `theme_${x}`),
  ]
  for (const lang of ['en', 'ko', 'ja'] as const) {
    expect(keys.filter(k => !Object.hasOwn(LOCALES[lang], k)), lang).toEqual([])
  }
})

test('band shows Q&A counts without archived items, the waiting count with ETA and the latest flow', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  for (const surface of SURFACES) {
    const wide = (await bandText($, 200, surface)).text ?? ''
    expect(wide).toContain('Q&A ✓ 1  ◐ 2  ✗ 3')
    expect(wide).toContain('2 waiting, checked ~34s after the turn')
    expect(wide).toContain('Flow: Retry-safe checkout')
    expect(wide).toContain('/si to open')
    expect(wide).not.toContain(String.fromCharCode(0xb7))
    const short = (await bandText($, 40, surface)).text
    expect(short, 'the band is drawn at 40 columns').toBeDefined()
    expect(short).not.toContain('/si to open')
    expect(cells(short ?? '')).toBeLessThanOrEqual(40)
  }
})

test('band names Q&A with the locale word', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, messages: { en: { mode_qa: 'Questions' } } })
  await start($, clock)
  const line = (await bandText($, 200)).text ?? ''
  expect(line).toContain('Questions ✓ 1')
  expect(line).not.toContain('Q&A')
})

test('band uses the server counts and says when automatic checks are off', async ($, on) => {
  const counts = { answered: 7, partial: 0, unanswered: 3, open: 3, total: 10 }
  const { clock } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, auto: false, counts } }, up: true })
  await start($, clock)
  const line = (await bandText($, 200)).text ?? ''
  expect(line).toContain('Q&A ✓ 7  ◐ 0  ✗ 3')
  expect(line).toContain(`2  ${EN.qa_wait_off}`)
  expect(line).not.toContain('checked ~34s')
})

test('band fits a Korean line by display width', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, lang: 'ko' })
  await start($, clock)
  const wide = (await bandText($, 200)).text ?? ''
  expect(wide).toContain(KO.mod_band_waiting!.replace('{0}', '2').replace('{1}', '34'))
  expect(wide).toContain(KO.mod_band_hint!)
  for (const cols of [30, 45, 60]) {
    const line = (await bandText($, cols)).text ?? ''
    expect(cells(line)).toBeLessThanOrEqual(cols)
    expect(line.length).toBeLessThan(cells(line))
  }
})

test('band sits above what the engine draws, yields to a survey, and yields when there is nothing to show', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock } = setup(on, world)
  await start($, clock)
  for (const surface of SURFACES) {
    const both = await bandText($, 120, surface)
    expect(both.text).toContain('Q&A')
    expect(both.order, 'the band first, then the engine band').toEqual(['side-insights-band', 'engine-band'])
    const survey = await bandText($, 120, surface, true)
    expect(survey.text, 'a survey keeps the band away').toBeUndefined()
    expect(survey.engine, "{ key: 'engine-band' }").toBeDefined()
  }
  world.current = { ...STATE, flows: [], qa: { ...STATE.qa, turns: [], waiting: [] } }
  await clock.advance(2000)
  for (const surface of SURFACES) {
    const only = await bandText($, 120, surface)
    expect(only.text).toBeUndefined()
    expect(only.engine, "{ key: 'engine-band' }").toBeDefined()
  }
})

test('spinner gets the waiting count as a suffix', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  const seen: string[] = []
  on('ui.render', { component: 'Spinner' }, async ($, e) => {
    seen.push(e.props.suffix)
    return { type: 'Text', props: {}, children: [e.props.suffix] }
  })
  await start($, clock)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Baking', message: null, suffix: '…', mode: 'responding' },
  })
  expect(seen.at(-1)).toBe('… - 2 questions waiting')
  await ui.unmount()
})

test('pane draws the three tabs and its keys act on the server', async ($, on) => {
  const { clock, calls, copied } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const first = await mountPane($)
  expect((await first.find({ key: 'row-1-i2' }))?.text).toContain('▶')
  await first.unmount()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'tab-flow' }), "{ key: 'tab-flow' }").toBeDefined()
    await ui.press({ key: 'item-1-i2' })
    expect((await ui.find({ key: 'row-1-i2' }))?.text).toContain('▶')
    const answer = await ui.find({ type: 'Text', text: /^Answer to Does it retry\?$/ })
    const marked = (answer?.children ?? []).find((child: unknown) => typeof child === 'object' && (child as Node).children?.[0] === 'Answer')
    expect(typeof marked === 'object' && (marked as Node).props?.bold, 'the ==highlight== in an answer is drawn bold').toBe(true)
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(surface === 'desktop' ? 'http://localhost:47821/p/demo?t=tok&full=1' : undefined)
    expect(await ui.find({ key: 'tile-waiting' }), 'the waiting tile').toBeDefined()
    expect((await ui.find({ key: 'tile-waiting' }))?.text).toContain(`⏳ ${EN.qa_wait_tile}`)

    expect(await ui.find({ key: 'status' }), 'no manual status key').toBeUndefined()

    await ui.press({ key: 'item-0-i1' })
    expect(await ui.find({ key: 'copy' }), 'no copy for an answered question').toBeUndefined()

    await ui.press({ key: 'item-2-i3' })
    expect((await ui.find({ key: 'row-2-i3' }))?.text).toContain('▶')
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)).toBe(EN.ask_message!.replace('{0}', 'Is the load test done?'))

    calls.length = 0
    await ui.press({ key: 'recheck' })
    expect(calls.some(c => c.url.includes('/regen'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /Press r again/ }), "{ type: 'Text', text: /Press r again/ }").toBeDefined()
    await ui.press({ key: 'recheck' })
    expect(calls.find(c => c.url.includes('/regen'))?.url).toContain('target=qa&item=i3')

    calls.length = 0
    await ui.press({ key: 'recheck' })
    await ui.press({ key: 'tab-flow' })
    await ui.press({ key: 'rebuild' })
    expect(calls.some(c => c.url.includes('/regen')), 'a Q&A confirm does not arm the flow rebuild').toBe(false)
    await ui.press({ key: 'rebuild' })
    expect(calls.find(c => c.url.includes('/regen'))?.url).toContain('target=flow')

    await ui.press({ key: 'step-0' })
    expect(calls.filter(c => c.url.endsWith(`/api/${KEY}/flow/f2`))).toHaveLength(surface === 'terminal' ? 1 : 0)
    expect(await ui.find({ key: 'step-1' }), "{ key: 'step-1' }").toBeDefined()
    expect(await ui.find({ type: 'Code', text: /req.header/ }), "{ type: 'Code', text: /req.header/ }").toBeDefined()
    await ui.press({ key: 'step-next' })
    expect((await ui.find({ key: 'step-row-1' }))?.text).toContain('▶')
    await ui.press({ key: 'step-next' })
    expect((await ui.find({ key: 'step-row-1' }))?.text, 'the step stays on the last one').toContain('▶')
    expect(await ui.find({ type: 'Code', text: 'claim(key)' }), "{ type: 'Code', text: 'claim(key)' }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(none\) → in_progress/ }), "{ type: 'Text', text: /\\(none\\) → in_progress/ }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm test \(23 passed\)/ }), "{ type: 'Text', text: /npm test \\(23 passed\\)/ }").toBeDefined()

    calls.length = 0
    await ui.press({ key: 'open' })
    expect(calls.find(c => c.method === 'POST' && c.url.includes('/open'))?.url).toBe(`http://127.0.0.1:47821/api/${KEY}/open?mode=flow`)

    await ui.press({ key: 'tab-live' })
    expect(await ui.find({ type: 'Text', text: /src\/a\.ts/ }), "{ type: 'Text', text: /src\\/a\\.ts/ }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm test/ }), "{ type: 'Text', text: /npm test/ }").toBeDefined()

    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('pressing a question copies its whole text exactly as asked and selects it', async ($, on) => {
  const { clock, copied } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    copied.length = 0
    await ui.press({ key: 'item-5-i6' })
    expect(copied).toEqual([QUESTION_WITH_SPACES])
    expect((await ui.find({ key: 'row-5-i6' }))?.text).toContain('▶')
    expect(await ui.find({ type: 'Text', text: new RegExp(EN.mod_copied_question!) }), 'the copied note').toBeDefined()
    await ui.unmount()
  }
})

test('a confirm that is not repeated within four seconds expires', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'item-2-i3' })
  calls.length = 0
  await ui.press({ key: 'recheck' })
  await clock.advance(4100)
  await ui.press({ key: 'recheck' })
  expect(calls.some(c => c.url.includes('/regen')), 'the second press only arms it again').toBe(false)
  await ui.press({ key: 'recheck' })
  expect(calls.some(c => c.url.includes('/regen'))).toBe(true)
  await ui.unmount()
})

test('the browser link is drawn only where a local page can open', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  const ui = await mountPane($, 'vscode')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ key: 'open' }), "{ key: 'open' }").toBeDefined()
  await ui.unmount()
})

test('a failed turn row re-checks that turn', async ($, on) => {
  const failed = { turn_id: 't5', ts: 1791905400, status: 'error', prompt: 'broken turn', items: [] }
  const { clock, calls } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, turns: [failed, ...STATE.qa.turns] } }, up: true })
  await start($, clock)
  const ui = await mountPane($)
  await ui.press({ key: 'fail-0-t5' })
  await ui.press({ key: 'recheck' })
  await ui.press({ key: 'recheck' })
  expect(calls.find(c => c.url.includes('/regen'))?.url).toContain('target=qa&turn=t5')
  await ui.unmount()
})

test('a selection that the filter hides is cleared', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  const ui = await mountPane($)
  await ui.press({ key: 'item-0-i1' })
  expect((await ui.find({ key: 'row-0-i1' }))?.text).toContain('▶')
  await ui.press({ key: 'open-only' })
  expect(await ui.find({ key: 'row-0-i1' })).toBeUndefined()
  expect((await ui.find({ key: 'row-0-i2' }))?.text, 'falls back to the first open question').toContain('▶')
  await ui.press({ key: 'open-only' })
  expect((await ui.find({ key: 'row-1-i2' }))?.text).toContain('▶')
  await ui.unmount()
})

test('a new flow arriving keeps the flow on screen', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'flow-next' })
  expect((await ui.find({ key: 'flow-row-f1' }))?.text, 'the second flow is open').toContain('▶')
  expect(await ui.find({ key: 'step' }), 'f1 is served and drawn').toBeDefined()
  world.current = { ...STATE, flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows] }
  await clock.advance(2000)
  expect((await ui.find({ key: 'flow-row-f1' }))?.text, 'still on f1 after a newer flow arrives').toContain('▶')
  expect((await ui.find({ key: 'flow-row-f3' }))?.text).not.toContain('▶')
  expect(await ui.find({ type: 'Text', text: 'Cart total rounding' }), 'still on f1').toBeDefined()
  await ui.unmount()
})

test('a flow that fails to load shows the error once instead of refetching', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true, flowStatus: 500 })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  await clock.advance(6000)
  expect(await ui.find({ type: 'Text', text: EN.flow_fail }), 'flow_fail').toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Flow file is unreadable' }), 'server error').toBeDefined()
  expect(calls.filter(c => c.url.endsWith('/flow/f2'))).toHaveLength(1)
  await ui.unmount()
})

test('a slow flow that lands after another flow was picked does not restart the other load', async ($, on) => {
  const world: World = { current: STATE, up: true, delay: path => (path.endsWith('/flow/f2') ? 1000 : path.endsWith('/flow/f1') ? 5000 : 0) }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'flow-tab-f1' })
  await clock.advance(1100)
  await clock.advance(2000)
  expect(calls.filter(c => c.url.endsWith('/flow/f1')), 'f1 is fetched once while it loads').toHaveLength(1)
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: 'Cart total rounding' })).toBeDefined()
  await ui.unmount()
})

test('toasts once when a new flow finishes and a verdict leaves questions open, and never again for the same ones', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock, toasts } = setup(on, world)
  await start($, clock)
  expect(toasts).toEqual([])
  world.current = {
    ...STATE,
    flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows],
    qa: {
      ...STATE.qa,
      turns: [
        turn('t3', [
          { id: 'i9', status: 'partial', question: 'And mobile?' },
          { id: 'i10', status: 'unanswered', question: 'Archived already', archived: true },
        ]),
        ...STATE.qa.turns,
      ],
    },
  }
  await clock.advance(2000)
  expect(toasts).toEqual(['Flow ready: Login rate limit  |  Open questions from the last turn: 1'])
  await clock.advance(2000)
  expect(toasts, 'a second poll does not repeat it').toHaveLength(1)
})

test('a run without a person at the prompt polls once and never toasts', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock, toasts, calls } = setup(on, world)
  await start($, clock, false)
  const polls = () => calls.filter(c => c.url.endsWith('/state')).length
  expect(polls()).toBe(1)
  world.current = { ...STATE, flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows] }
  await clock.advance(20_000)
  expect(polls()).toBe(1)
  await $.command.run(RUN_SI)
  await clock.settle()
  expect(polls(), 'a later poll').toBe(2)
  expect(toasts).toEqual([])
})

test('a child analysis session skips the timer too, and never toasts', async ($, on) => {
  const world: World = { current: STATE, up: true, env: { CMUX_PANEL_ID: KEY, HOME: '/home/u', SIDE_INSIGHTS_CHILD: '1' } }
  const { clock, calls, toasts } = setup(on, world)
  await start($, clock)
  await clock.advance(20_000)
  expect(calls.filter(c => c.url.endsWith('/state'))).toHaveLength(1)
  world.current = { ...STATE, flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows] }
  await $.command.run(RUN_SI)
  await clock.settle()
  expect(calls.filter(c => c.url.endsWith('/state')), 'a later poll').toHaveLength(2)
  expect(toasts).toEqual([])
})

test('a taken command name does not stop the other one or the band', async ($, on) => {
  const { clock, registered } = setup(on, { current: STATE, up: true, taken: ['si'] })
  await start($, clock)
  expect(registered).toEqual(['side-insights', 'si-browser'])
  expect((await bandText($, 200)).text).toContain('Q&A ✓ 1')
})

const clearTo = async ($: Engine, sid: string) =>
  $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'clear', session_id: sid, transcript_path: `/t/${sid}.jsonl`, cwd: '/repo' })

test('/clear moves to the new session key and forgets the old state', async ($, on) => {
  const world: World = { current: STATE, up: true, sid: 'sess-a', env: { HOME: '/home/u' } }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  expect(calls.some(c => c.url.endsWith('/api/sess-a/state'))).toBe(true)
  world.sid = 'sess-b'
  world.current = { ...STATE, flows: [], qa: { ...STATE.qa, turns: [], waiting: [] } }
  calls.length = 0
  await clearTo($, 'sess-b')
  await clock.settle()
  expect(calls.some(c => c.url.endsWith('/api/sess-b/state'))).toBe(true)
  expect(calls.some(c => c.url.includes('/api/sess-a/'))).toBe(false)
  expect((await bandText($, 200)).text).toBeUndefined()
})

test('/clear during a slow poll waits for it and then polls the new key, never two at once', async ($, on) => {
  let slow = false
  const world: World = { current: STATE, up: true, sid: 'sess-a', env: { HOME: '/home/u' }, delay: path => (slow && path.endsWith('/state') ? 1000 : 0) }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  slow = true
  await clock.advance(2000)
  world.sid = 'sess-b'
  world.current = { ...STATE, flows: [], qa: { ...STATE.qa, turns: [], waiting: [] } }
  await clearTo($, 'sess-b')
  await clock.advance(1500)
  expect(world.maxInFlight, 'one state request at a time').toBe(1)
  expect(calls.some(c => c.url.endsWith('/api/sess-b/state'))).toBe(true)
  await clock.advance(1000)
  expect((await bandText($, 200)).text, 'the old reply is dropped').toBeUndefined()
})

test('a slow config reply from before /clear does not change the language', async ($, on) => {
  let slow = false
  const world: World = { current: STATE, up: true, sid: 'sess-a', env: { HOME: '/home/u' }, delay: path => (slow && path.startsWith('/api/config') ? 5000 : 0) }
  const { clock } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  world.panes = { 'sess-a': { lang: 'ko' } }
  slow = true
  await ui.press({ key: 'settings' })
  slow = false
  world.sid = 'sess-b'
  await clearTo($, 'sess-b')
  await clock.settle()
  await clock.advance(6000)
  const line = (await bandText($, 200)).text ?? ''
  expect(line).toContain('/si to open')
  expect(line).not.toContain(KO.mod_band_hint!)
  await ui.unmount()
})

test('a server that is down shows the hint and is started at most once a minute, only when its tools are installed', async ($, on) => {
  const world: World = { current: STATE, up: false }
  const { clock, runs } = setup(on, world)
  await start($, clock)
  for (const surface of SURFACES) {
    expect((await bandText($, 120, surface)).text).toContain('! si-panel')
  }
  const startRuns = () => runs.filter(r => r.join(' ').includes('ensure_panel_server'))
  expect(startRuns()).toHaveLength(1)
  expect(startRuns()[0]?.slice(0, 2)).toEqual(['/bin/bash', '-c'])
  expect(startRuns()[0]?.[2], 'a Mac without the Command Line Tools is not asked to install them every minute').toMatch(/\[ -z "\$\(panel_missing\)" \] && ensure_panel_server/)
  await clock.advance(10_000)
  expect(startRuns()).toHaveLength(1)
  await clock.advance(60_000)
  expect(startRuns()).toHaveLength(2)
})

test('a server that comes back clears the hint and reloads the settings', async ($, on) => {
  const world: World = { current: STATE, up: false }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  expect((await bandText($, 120)).text).toContain('! si-panel')
  world.up = true
  calls.length = 0
  await clock.advance(2000)
  const line = (await bandText($, 120)).text ?? ''
  expect(line).not.toContain('! si-panel')
  expect(line).toContain('Q&A ✓ 1')
  expect(calls.some(c => c.url.includes('/api/config')), 'the settings are fetched again').toBe(true)
})

for (const status of [403, 500]) {
  test(`HTTP ${status} shows the server message and never starts the server`, async ($, on) => {
    const { clock, runs } = setup(on, { current: STATE, up: true, stateStatus: status })
    await start($, clock)
    await clock.advance(10_000)
    const line = (await bandText($, 200)).text ?? ''
    expect(line).toContain('Could not do that: Request refused. Reopen the panel and try again.')
    expect(line).not.toContain('si-panel')
    expect(runs.filter(r => r[0] !== '/usr/bin/defaults')).toEqual([])
  })
}

test('a wide pane puts the pipeline beside the step and files beside tools; a narrow one stacks them', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const [bodyColumns, wide] of [
    [90, true],
    [60, false],
  ] as const) {
    const ui = await mountPane($, 'terminal', bodyColumns)
    await ui.press({ key: 'tab-flow' })
    expect(!!(await ui.find({ key: 'flow-cols' })), `flow columns at ${bodyColumns}`).toBe(wide)
    expect(await ui.find({ key: 'step' }), 'the step card is drawn either way').toBeDefined()
    await ui.press({ key: 'tab-live' })
    expect(!!(await ui.find({ key: 'live-cols' })), `live columns at ${bodyColumns}`).toBe(wide)
    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('h opens a help card with every panel key and the Claude Code pane keys, and a tab closes it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'help' })
    expect(await ui.find({ key: 'help-cc' }), "{ key: 'help-cc' }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: / ctrl\+x ← ↑ / }), 'the grow keys').toBeDefined()
    for (const [key, label] of [
      ['a', 'term_k_archive'],
      ['g', 'settings'],
      ['d', 'mod_view_working'],
      ['s', 'mod_view_commit'],
      ['f', 'mod_view_file'],
      ['x', 'mod_k_close_diff'],
      ['k j', 'mod_k_setting_rows'],
      ['p n', 'mod_k_setting_value'],
    ]) {
      expect((await ui.find({ key: `help-${key}-${label}` }))?.text, `help lists ${key}`).toContain(EN[label!]!)
    }
    expect(await ui.find({ key: 'qa-tiles' }), 'help replaces the tab body').toBeUndefined()
    await ui.press({ key: 'tab-qa' })
    expect(await ui.find({ key: 'help-cc' }), 'a tab press leaves help').toBeUndefined()
    await ui.unmount()
  }
})

type Found = { key?: string; type?: string; props: Record<string, unknown>; children?: unknown[] }

const isHidden = (b: Found) => /^(hk|unused)-/.test(String(b.key))

const colorless = (node: unknown, inherited = false, out: string[] = []): string[] => {
  if (!node || typeof node !== 'object') {
    return out
  }
  const n = node as Node
  const colored = inherited || (n.type === 'Text' && !!n.props?.color)
  if (n.type === 'Text' && !colored) {
    out.push(JSON.stringify(n).slice(0, 120))
  }
  for (const child of n.children ?? []) {
    colorless(child, n.type === 'Text' ? colored : false, out)
  }
  return out
}

const PANE_VIEWS = (ui: { press: (t: { key: string }) => Promise<unknown> }): [string, () => Promise<unknown>][] => [
  ['qa', async () => undefined],
  ['flow', () => ui.press({ key: 'tab-flow' })],
  [
    'live with a diff',
    async () => {
      await ui.press({ key: 'tab-live' })
      await ui.press({ key: `file-${FILE}` })
    },
  ],
  ['help', () => ui.press({ key: 'help' })],
  ['settings', () => ui.press({ key: 'settings' })],
]

test('hotkeys live on hidden buttons drawn last; visible buttons carry none; unused keys are caught without a clash', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: (a: string[]) => (a.includes('HEAD') ? { exitCode: 0, stdout: `${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }) })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    for (const [name, open] of PANE_VIEWS(ui)) {
      await open()
      const all: Found[] = await ui.findAll({ type: 'Button' })
      const visible = all.filter(b => !isHidden(b))
      const hidden = all.filter(isHidden)
      expect(visible.filter(b => b.props.hotkey !== undefined).map(b => b.key), `${name}: no visible button has a hotkey`).toEqual([])
      const keys = hidden.map(b => String(b.props.hotkey))
      expect(new Set(keys).size, `${name}: each hotkey once`).toBe(keys.length)
      expect(hidden.filter(b => String(b.key).startsWith('unused-')).length, `${name}: some keys are caught`).toBeGreaterThan(0)
      expect(Math.min(...hidden.map(b => all.indexOf(b))), `${name}: hidden buttons after every visible one`).toBeGreaterThan(Math.max(...visible.map(b => all.indexOf(b))))
    }
    await ui.press({ key: 'tab-qa' })
    expect((await ui.find({ key: 'hk-1' }))?.props.hotkey).toBe('1')
    await ui.press({ key: 'hk-2' })
    expect(await ui.find({ key: 'live-tiles' }), 'a hidden hotkey acts like its visible button').toBeDefined()
    await ui.press({ key: 'hk-j' })
    expect(await ui.find({ key: 'diff' }), 'j on Live opens a file').toBeDefined()
    await ui.press({ key: 'hk-3' })
    await ui.unmount()
  }
})

test('every text in the pane has a palette colour of its own or from the text around it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: (a: string[]) => (a.includes('HEAD') ? { exitCode: 0, stdout: `${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }) })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    for (const [name, open] of PANE_VIEWS(ui)) {
      await open()
      expect(colorless(await ui.drawn()), name).toEqual([])
    }
    await ui.press({ key: 'tab-qa' })
    await ui.press({ key: 'unused-4' })
    expect(colorless(await ui.drawn()), 'a note').toEqual([])
    const chip = ((await ui.find({ key: 'row-0-i1' }))?.children ?? []).find((child: unknown) => !!(child as Node).props?.backgroundColor) as Node | undefined
    expect(chip?.props?.color, 'pill text is the palette text colour').toBe(hex(DARK.text))
    await ui.unmount()
  }
})

test('a key the pane does not use is caught with a hint instead of falling through to the prompt', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'unused-4' })
    expect(await ui.find({ type: 'Text', text: /4 does nothing here/ }), 'the hint').toBeDefined()
    await ui.press({ key: 'tab-flow' })
    expect(await ui.find({ key: 'pipeline' }), 'the tab key still works after it').toBeDefined()
    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('re-checking a question marked by hand clears the mark first, so the check can change it', async ($, on) => {
  const manual = { ...STATE.qa.turns[0]!, items: STATE.qa.turns[0]!.items.map(i => (i.id === 'i2' ? { ...i, manual: true } : i)) }
  const { clock, calls } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, turns: [manual, ...STATE.qa.turns.slice(1)] } }, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'item-2-i3' })
  calls.length = 0
  await ui.press({ key: 'recheck' })
  await ui.press({ key: 'recheck' })
  expect(calls.some(c => c.url.endsWith('/qa/override')), 'an automatic item is re-checked as is').toBe(false)
  expect(calls.some(c => c.url.includes('item=i3'))).toBe(true)
  await ui.press({ key: 'item-1-i2' })
  calls.length = 0
  await ui.press({ key: 'recheck' })
  await ui.press({ key: 'recheck' })
  const order = calls.filter(c => c.method === 'POST').map(c => (c.url.endsWith('/qa/override') ? `override ${c.body}` : c.url.includes('/regen') ? 'regen' : c.url))
  expect(order).toEqual(['override {"id":"i2","status":null}', 'regen'])
  await ui.unmount()
})

const HUNK_TEXT = '@@ -1,2 +1,2 @@\n-old line\n+new line\n same'
const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git'

const DIFF_CASES = [
  { name: 'uncommitted', git: (a: string[]) => (a.includes('diff') && a.includes('HEAD') ? { exitCode: 0, stdout: `diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /git diff HEAD/ },
  { name: 'new', git: (a: string[]) => (a.includes('ls-files') ? { exitCode: 1, stdout: '', stderr: "error: pathspec 'x' did not match" } : a.includes('--no-index') ? { exitCode: 1, stdout: `--- /dev/null\n+++ b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /New file/ },
  { name: 'committed', git: (a: string[]) => (a.includes('log') ? { exitCode: 0, stdout: `abc1234 Add retries\n\ndiff --git a/x b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /Last commit that changed this file: abc1234 Add retries/ },
]

for (const k of DIFF_CASES) {
  test(`pressing a changed file shows its diff: ${k.name}`, async ($, on) => {
    const world: World = { current: STATE, up: true, git: k.git }
    const { clock, runs } = setup(on, world)
    await start($, clock)
    await $.command.run(RUN_SI)
    const ui = await mountPane($)
    await ui.press({ key: 'tab-live' })
    await ui.press({ key: `file-${FILE}` })
    expect(await ui.find({ type: 'Text', text: k.label }), `${k.name}: source label`).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format, `${k.name}: drawn as a diff`).toBe('diff')
    expect(String(code?.props.source).startsWith('@@ '), `${k.name}: only hunks reach the Code`).toBe(true)
    expect((await ui.find({ key: 'diff-code' }))?.props.backgroundColor, `${k.name}: on the code background the engine colours it for`).toBe(hex(DARK.code))
    const gits = runs.filter(r => r[0] === 'git')
    expect(gits.length).toBeGreaterThan(0)
    for (const argv of gits) {
      expect(argv.slice(1, 3), 'runs in the file\'s folder').toEqual(['-C', '/repo/src'])
      expect(argv, 'with the absolute path').toContain(FILE)
      expect(argv.join(' '), 'no fsmonitor hook').toContain('-c core.fsmonitor=false')
      if (argv.includes('diff') || argv.includes('log')) {
        expect(argv, 'no textconv driver').toContain('--no-textconv')
      }
    }
    await ui.press({ key: 'diff-close' })
    expect(await ui.find({ key: 'diff' }), `${k.name}: closed`).toBeUndefined()
    await ui.unmount()
  })
}

test('an untracked new file keeps d lit, and d shows the new file again', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: DIFF_CASES[1]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: `file-${FILE}` })
  expect((await ui.find({ key: 'diff-view-working' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'diff-view-commit' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'diff-view-working' })
  expect(await ui.find({ type: 'Text', text: /New file/ }), 'still the new file').toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(EN.mod_diff_none!) }), 'not "no change"').toBeUndefined()
  expect((await ui.find({ key: 'diff-view-working' }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('a file outside any git repository opens as the whole file', async ($, on) => {
  const { clock } = setup(on, {
    current: STATE,
    up: true,
    git: () => ({ exitCode: 128, stdout: '', stderr: NOT_A_REPO }),
    files: { [FILE]: 'line one\nline two' },
  })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: `file-${FILE}` })
  expect(await ui.find({ type: 'Text', text: EN.mod_diff_file }), 'whole-file label').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /New file/ }), 'not called a new file').toBeUndefined()
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('line one\nline two')
  await ui.unmount()
})

test('a first hunk longer than the limit is cut to a hunk whose header matches what is kept, so it still draws as a diff', async ($, on) => {
  const body = Array.from({ length: 500 }, (_, i) => (i % 4 < 2 ? `-old ${i}` : i % 4 === 2 ? `+new ${i}` : ` same ${i}`))
  const long = `diff --git a/x b/x\n@@ -10,334 +12,333 @@ function f() {\n${body.join('\n')}\n`
  const cut = trimHunks(long)
  const kept = cut.hunks.split('\n')
  expect(kept).toHaveLength(400)
  expect(cut.cut).toBe(101)
  const old = kept.slice(1).filter(l => !l.startsWith('+')).length
  const added = kept.slice(1).filter(l => !l.startsWith('-')).length
  expect(kept[0]).toBe(`@@ -10,${old} +12,${added} @@ function f() {`)
  expect(old, 'the two counts differ, so a swapped pair fails').not.toBe(added)
  const two = trimHunks(`@@ -1 +1 @@\n+a\n@@ -9 +9 @@\n${Array.from({ length: 500 }, () => '+b').join('\n')}`)
  expect(two.hunks, 'a cut at a hunk boundary keeps whole hunks as they are').toBe('@@ -1 +1 @@\n+a')
  const { clock } = setup(on, { current: STATE, up: true, git: (a: string[]) => (a.includes('HEAD') ? { exitCode: 0, stdout: long } : { exitCode: 0, stdout: '' }) })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: `file-${FILE}` })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.format).toBe('diff')
  expect(String(code?.props.source).split('\n')[0]).toBe(kept[0])
  expect(await ui.find({ type: 'Text', text: EN.mod_diff_cut!.replace('{0}', '101') })).toBeDefined()
  await ui.unmount()
})

test('/si-browser toggles the cmux browser split through si-panel inside cmux, asking it to leave out the tokened link', async ($, on) => {
  const { clock, runs, envs } = setup(on, { current: STATE, up: true })
  await start($, clock)
  runs.length = 0
  envs.length = 0
  await $.command.run({ ...RUN_SI, command: 'si-browser' })
  const at = runs.findIndex(r => r[0]?.endsWith('/bin/si-panel'))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(envs[at]?.SIDE_INSIGHTS_NO_LINK).toBe('1')
})

test('/si-browser opens the full page in the browser outside cmux, and keeps the token out of the transcript', async ($, on) => {
  const { clock, calls, runs } = setup(on, { current: STATE, up: true, env: { HOME: '/home/u' } })
  await start($, clock)
  runs.length = 0
  calls.length = 0
  const result = await $.command.run({ ...RUN_SI, command: 'si-browser' })
  expect(runs.some(r => r[0]?.endsWith('/bin/si-panel'))).toBe(false)
  expect(calls.some(c => c.method === 'POST' && c.url.includes('/open'))).toBe(true)
  expect((result as { text?: string }).text).toBe(EN.panel_requested)
})

test('the Flow tab shows every flow title as a pill, and pressing one opens it', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  expect((await ui.find({ key: 'flow-tab-f2' }))?.text).toContain('Retry-safe checkout')
  expect((await ui.find({ key: 'flow-tab-f1' }))?.text).toContain('Cart total rounding')
  calls.length = 0
  await ui.press({ key: 'flow-tab-f1' })
  expect(calls.some(c => c.url.endsWith(`/api/${KEY}/flow/f1`))).toBe(true)
  expect((await ui.find({ key: 'step' }))?.text).toContain('Round the total')
  await ui.unmount()
})

const twoFiles = (cwd: string | null = '/repo') => ({
  ...STATE,
  activity: {
    ...STATE.activity,
    cwd,
    files: [
      { path: FILE, count: 2, created: false, last: 1791905001 },
      { path: '/repo/src/b.ts', count: 1, created: true, last: 1791905009 },
    ],
  },
})

test('j and k walk the files and stay put at either end with the diff open', async ($, on) => {
  const { clock, runs } = setup(on, { current: twoFiles(), up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: 'file-next' })
  expect((await ui.find({ key: 'diff' }))?.text, 'the newest file first').toContain('src/b.ts')
  await ui.press({ key: 'file-next' })
  expect((await ui.find({ key: 'diff' }))?.text).toContain('src/a.ts')
  const loads = runs.length
  await ui.press({ key: 'file-next' })
  expect((await ui.find({ key: 'diff' }))?.text, 'j at the last file keeps its diff open').toContain('src/a.ts')
  expect(runs.length, 'and does not load it again').toBe(loads)
  await ui.press({ key: 'file-prev' })
  await ui.press({ key: 'file-prev' })
  expect((await ui.find({ key: 'diff' }))?.text, 'k at the first file keeps its diff open').toContain('src/b.ts')
  await ui.unmount()
})

test('file rows are keyed by path, so a re-sort keeps the open file marked', async ($, on) => {
  const world: World = { current: twoFiles(), up: true, git: DIFF_CASES[0]!.git }
  const { clock } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: `file-${FILE}` })
  expect((await ui.find({ key: `file-row-${FILE}` }))?.text).toContain('▶')
  world.current = { ...twoFiles(), activity: { ...twoFiles().activity, files: [{ path: FILE, count: 3, created: false, last: 1791905020 }, twoFiles().activity.files[1]!] } }
  await clock.advance(2000)
  expect((await ui.find({ key: `file-row-${FILE}` }))?.text, 'still marked after it moved to the top').toContain('▶')
  expect((await ui.find({ key: 'file-row-/repo/src/b.ts' }))?.text).not.toContain('▶')
  await ui.unmount()
})

test('j stops at the last file shown, not at files hidden past the limit', async ($, on) => {
  const files = Array.from({ length: 32 }, (_, i) => ({ path: `/repo/f${String(i).padStart(2, '0')}.ts`, count: 1, created: false, last: 1791906000 - i }))
  const { clock } = setup(on, { current: { ...STATE, activity: { ...STATE.activity, files } }, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: 'file-/repo/f29.ts' })
  await ui.press({ key: 'file-next' })
  expect((await ui.find({ key: 'diff' }))?.text).toContain('f29.ts')
  await ui.unmount()
})

test('a path without a folder runs git in the current folder; ~/ paths expand to home', async ($, on) => {
  const { clock, runs } = setup(on, { current: { ...STATE, activity: { ...STATE.activity, cwd: null, files: [{ path: 'notes.md', count: 1, created: false, last: 1 }] } }, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: 'file-notes.md' })
  const first = runs.find(r => r[0] === 'git')
  expect(first?.slice(1, 3)).toEqual(['-C', '.'])
  expect(first).toContain('notes.md')
  runs.length = 0
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'flow-tab-f1' })
  await ui.press({ key: 'change-0' })
  const home = runs.find(r => r[0] === 'git')
  expect(home?.slice(1, 3)).toEqual(['-C', '/home/u/notes'])
  expect(home).toContain('/home/u/notes/todo.md')
  expect(await ui.find({ key: 'change-0-1' }), 'the second file of a comma list without a space').toBeDefined()
  await ui.unmount()
})

test('a change entry naming several files is split into one path per file', () => {
  expect(changeFiles('~/repo/README.md, README.ko.md, README.ja.md')).toEqual(['~/repo/README.md', '~/repo/README.ko.md', '~/repo/README.ja.md'])
  expect(changeFiles('src/a.ts, lib/b.ts')).toEqual(['src/a.ts', 'lib/b.ts'])
  expect(changeFiles('src/a.ts,b.ts , c.ts')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  expect(changeFiles('src/only.ts')).toEqual(['src/only.ts'])
})

test('the diff card switches between the uncommitted diff, the last commit and the whole file', async ($, on) => {
  const git = (a: string[]) =>
    a.includes('log') ? { exitCode: 0, stdout: `abc1234 Add retries\n\n${HUNK_TEXT}\n` } : a.includes('HEAD') ? { exitCode: 0, stdout: `${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }
  const { clock, runs } = setup(on, { current: STATE, up: true, git, files: { [FILE]: 'whole\nfile' } })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  await ui.press({ key: `file-${FILE}` })
  expect(await ui.find({ type: 'Text', text: /git diff HEAD/ }), 'opens on the uncommitted diff').toBeDefined()
  await ui.press({ key: 'diff-view-commit' })
  expect(await ui.find({ type: 'Text', text: /abc1234 Add retries/ }), 'the last commit even though there are uncommitted changes').toBeDefined()
  expect((await ui.find({ key: 'diff-view-commit' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'diff-view-file' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.format, 'the whole file is plain code').toBeUndefined()
  expect(code?.props.startLine).toBe(1)
  expect(runs.some(r => r.includes('log')), 'git log ran for the commit view').toBe(true)
  await ui.press({ key: 'diff-view-working' })
  expect(await ui.find({ type: 'Text', text: /git diff HEAD/ }), 'd goes back to the uncommitted diff').toBeDefined()
  expect(await ui.find({ key: 'diff' }), 'd never closes the card').toBeDefined()
  await ui.unmount()
})

test('the Live footer offers x only while a diff is open', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  expect((await ui.find({ key: 'footer' }))?.text).not.toContain(EN.mod_k_close_diff)
  await ui.press({ key: `file-${FILE}` })
  expect((await ui.find({ key: 'footer' }))?.text).toContain(EN.mod_k_close_diff)
  await ui.unmount()
})

test('a diff opened from a flow closes when the step or the flow changes', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'change-0' })
  expect(await ui.find({ key: 'diff' }), 'opened from Changes').toBeDefined()
  await ui.press({ key: 'step-next' })
  expect(await ui.find({ key: 'diff' }), 'closed by a step change').toBeUndefined()
  await ui.press({ key: 'change-0' })
  await ui.press({ key: 'change-0' })
  expect(await ui.find({ key: 'diff' }), 'a second press on the same file closes it').toBeUndefined()
  await ui.press({ key: 'change-0' })
  await ui.press({ key: 'flow-next' })
  expect(await ui.find({ key: 'diff' }), 'closed by a flow change').toBeUndefined()
  await ui.unmount()
})

test('each step lists only the changes to its own file, and a change opens its diff', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  expect(await ui.find({ key: 'step-changes' }), 'step 1 reads route.ts, which did not change').toBeUndefined()
  await ui.press({ key: 'step-next' })
  expect((await ui.find({ key: 'step-change-0' }))?.text).toContain('src/checkout/idempotency.ts')
  await ui.press({ key: 'step-change-0' })
  expect(await ui.find({ key: 'diff' }), 'the diff of that file').toBeDefined()
  await ui.unmount()
})

test('a change named relative to another repo opens the edited file there, not the same name under the session folder', async ($, on) => {
  const elsewhere = '~/other/src/checkout/idempotency.ts'
  const current = { ...STATE, activity: { ...STATE.activity, files: [{ path: elsewhere, count: 1, created: false, last: 1 }] } }
  const { clock, runs } = setup(on, { current, up: true, git: DIFF_CASES[0]!.git })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'step-next' })
  runs.length = 0
  await ui.press({ key: 'step-change-0' })
  const git = runs.find(r => r[0] === 'git')
  expect(git?.slice(1, 3)).toEqual(['-C', '/home/u/other/src/checkout'])
  await ui.unmount()
})

test('resolveChange prefers a known path ending in the change file, else keeps the name', () => {
  expect(resolveChange('README.md', ['~/a/docs/README.md', '/r/x.ts'])).toBe('~/a/docs/README.md')
  expect(resolveChange('lib/x.ts', ['/r/src/x.ts'])).toBe('lib/x.ts')
})

test('pressing a Live tile filters the tool list to that state, and pressing it again clears it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  expect(await ui.find({ type: 'Text', text: /npm test/ }), 'the failed Bash call').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/a\.ts/ }), 'the done Edit call').toBeDefined()
  await ui.press({ key: 'tile-err-press' })
  const tools = await ui.find({ key: 'tools' })
  expect(tools?.text).toContain('npm test')
  expect(tools?.text, 'the done Edit call is filtered out').not.toContain('src/a.ts')
  await ui.press({ key: 'tile-err-press' })
  expect((await ui.find({ key: 'tools' }))?.text, 'cleared').toContain('src/a.ts')
  await ui.unmount()
})

test('pressing a Q&A tile shows only questions with that status, and pressing it again clears it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tile-unanswered-press' })
  expect(await ui.find({ type: 'Button', text: 'Is the load test done?' }), 'an unanswered one').toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Does it retry?' }), 'an answered one is hidden').toBeUndefined()
  await ui.press({ key: 'tile-unanswered-press' })
  expect(await ui.find({ type: 'Button', text: 'Does it retry?' }), 'cleared').toBeDefined()
  await ui.unmount()
})

test('a step lists only the checks that name it, and the flow card still lists every check', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-flow' })
  expect(await ui.find({ key: 'step-checks' }), 'no check names step 1').toBeUndefined()
  await ui.press({ key: 'step-next' })
  const own = await ui.find({ key: 'step-checks' })
  expect(own?.text).toContain('claim test')
  expect(own?.text, 'a whole-change check is not tied to step 2').not.toContain('npm test')
  const all = await ui.find({ key: 'checks' })
  expect(all?.text).toContain('npm test')
  expect(all?.text).toContain('claim test')
  await ui.unmount()
})

test('pressing a failed tool call shows why it failed, and pressing it again hides it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-live' })
  expect(await ui.find({ type: 'Text', text: /FAIL retry\.test\.ts/ }), 'hidden until pressed').toBeUndefined()
  await ui.press({ key: 'tool-reason-0' })
  expect(await ui.find({ type: 'Text', text: /Exit code 1 FAIL retry\.test\.ts/ })).toBeDefined()
  await ui.press({ key: 'tool-reason-0' })
  expect(await ui.find({ type: 'Text', text: /FAIL retry\.test\.ts/ }), 'hidden again').toBeUndefined()
  await ui.unmount()
})

const settingText = async (ui: { find: (q: object) => Promise<{ text?: string } | undefined> }, key: string) => (await ui.find({ key: `setting-${key}` }))?.text ?? ''

const posts = (calls: Call[]) => calls.filter(c => c.method === 'POST' && c.url.includes('/api/config')).map(c => ({ url: c.url, body: JSON.parse(c.body ?? '{}') }))

test('settings rows move with j and k, change with n and p or a press, and save for all panels or this one', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'setting-next' }), 'the row keys are drawn only in settings').toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ type: 'Select' }), 'no engine-coloured Select').toBeUndefined()
    expect(await settingText(ui, 'scope')).toContain('▶')
    expect((await ui.find({ key: 'footer' }))?.text).toContain(EN.mod_k_setting_rows)
    await ui.press({ key: 'setting-prev' })
    expect(await settingText(ui, 'scope'), 'k at the top stays').toContain('▶')
    await ui.press({ key: 'setting-next' })
    await ui.press({ key: 'setting-next' })
    expect(await settingText(ui, 'model')).toContain('▶')
    const models = ['opus', 'sonnet', 'haiku']
    const before = models.indexOf(world.global!.model)
    const wanted = models[(before + models.length - 1) % models.length]!
    calls.length = 0
    await ui.press({ key: 'setting-value-prev' })
    expect(posts(calls), 'p goes to the previous option, wrapping').toEqual([{ url: 'http://127.0.0.1:47821/api/config', body: { model: wanted } }])
    expect(await settingText(ui, 'model')).toContain(wanted)
    calls.length = 0
    await ui.press({ key: 'set-scope' })
    expect(await settingText(ui, 'scope')).toContain(EN.scope_pane)
    expect(await settingText(ui, 'scope'), 'pressing a value also moves the highlight').toContain('▶')
    expect(posts(calls), 'the scope is not a saved setting').toEqual([])
    for (let i = 0; i < 4; i++) {
      await ui.press({ key: 'setting-next' })
    }
    expect(await settingText(ui, Setting.QA_AUTO)).toContain('▶')
    const qaAuto = world.panes?.[KEY]?.qa_auto ?? world.global!.qa_auto
    await ui.press({ key: 'setting-value-next' })
    expect(posts(calls)).toEqual([{ url: `http://127.0.0.1:47821/api/config?pane=${KEY}`, body: { qa_auto: !qaAuto } }])
    for (let i = 0; i < 9; i++) {
      await ui.press({ key: 'setting-next' })
    }
    expect(await settingText(ui, Setting.THEME), 'j at the bottom stays on the last row').toContain('▶')
    await ui.press({ key: 'set-scope' })
    await ui.press({ key: 'tab-qa' })
    expect(await ui.find({ key: 'setting-scope' }), 'a tab press leaves settings').toBeUndefined()
    await ui.unmount()
  }
})

test('saving a setting uses the reply instead of fetching the settings again, and keeps this panel\'s own values', async ($, on) => {
  const world: World = { current: STATE, up: true, panes: { [KEY]: { lang: 'ko' } } }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'settings' })
  expect(await settingText(ui, 'lang'), 'this panel is in Korean').toContain(KO.s_lang!)
  await ui.press({ key: 'setting-next' })
  await ui.press({ key: 'setting-next' })
  calls.length = 0
  await ui.press({ key: 'setting-value-next' })
  expect(posts(calls)[0]?.url, 'saved for all panels').toBe('http://127.0.0.1:47821/api/config')
  expect(calls.filter(c => c.method === 'GET' && c.url.includes('/api/config')), 'no second fetch').toEqual([])
  expect(await settingText(ui, 'model')).toContain('sonnet')
  expect(await ui.find({ type: 'Text', text: new RegExp(KO.mod_settings_saved!) }), 'still Korean: the panel override stays').toBeDefined()
  await ui.unmount()
})

test('two quick changes end on the last one even when the first reply comes back later', async ($, on) => {
  const world: World = { current: STATE, up: true, delay: (path, method, body) => (method === 'POST' && body?.includes('sonnet') ? 1000 : 0) }
  const { clock } = setup(on, world)
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'setting-next' })
  await ui.press({ key: 'setting-next' })
  await ui.press({ key: 'setting-value-next' })
  await ui.press({ key: 'setting-value-next' })
  expect(await settingText(ui, 'model')).toContain('haiku')
  await clock.advance(1500)
  expect(await settingText(ui, 'model'), 'the late sonnet reply does not win').toContain('haiku')
  await ui.unmount()
})

test('a setting with no options from the server shows its current value and n changes nothing', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true, models: [] })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'setting-next' })
  await ui.press({ key: 'setting-next' })
  expect(await settingText(ui, 'model')).toContain('opus')
  calls.length = 0
  await ui.press({ key: 'setting-value-next' })
  expect(posts(calls)).toEqual([])
  await ui.unmount()
})

test('the theme setting offers auto, dark and light even when the server lists none, and switching it repaints', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true, claudeTheme: 'dark', delay: (path, method) => (method === 'POST' ? 1000 : 0) })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  expect(await background(ui)).toBe(hex(DARK.base))
  await ui.press({ key: 'settings' })
  for (let i = 0; i < 6; i++) {
    await ui.press({ key: 'setting-next' })
  }
  expect(await settingText(ui, Setting.THEME)).toContain(EN.theme_auto)
  calls.length = 0
  await ui.press({ key: 'setting-value-prev' })
  expect(posts(calls)[0]?.body).toEqual({ theme: 'light' })
  expect(await background(ui), 'light at once, before the server answers').toBe(hex(LIGHT.base))
  await clock.advance(1500)
  expect(await background(ui), 'and after it').toBe(hex(LIGHT.base))
  await ui.unmount()
})

test('the pane opens before the theme is read, takes its title from the language, and follows Claude Code and macOS theme changes', async ($, on) => {
  const world: World = { current: STATE, up: true, claudeTheme: 'light-daltonized', messages: { en: { mod_pane_title: 'Side insights (test)' } } }
  const { clock, events, opened } = setup(on, world)
  await start($, clock)
  events.length = 0
  await $.command.run(RUN_SI)
  expect(events.slice(0, 2), 'open first, then read the system appearance').toEqual(['open', 'defaults'])
  expect(opened.at(-1)?.title).toBe('Side insights (test)')
  const ui = await mountPane($)
  expect(await background(ui), 'a light Claude Code theme').toBe(hex(LIGHT.base))
  world.claudeTheme = 'dark'
  await clock.advance(30_000)
  expect(await background(ui), 'Claude Code switched to dark').toBe(hex(DARK.base))
  world.claudeTheme = undefined
  world.systemDark = false
  await clock.advance(30_000)
  expect(await background(ui), 'no Claude theme name: macOS light').toBe(hex(LIGHT.base))
  world.global = { ...world.global!, theme: 'dark' } as Settings
  await clock.advance(30_000)
  expect(await background(ui), 'a theme set from the browser panel').toBe(hex(DARK.base))
  await ui.unmount()
})

test('the hero is animated only while the pane is drawn in a terminal', async ($, on) => {
  const { clock, blits } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const desktop = await mountPane($, 'desktop')
  blits.length = 0
  await clock.advance(1000)
  expect(blits, 'no raster on the desktop').toEqual([])
  await desktop.unmount()
  const terminal = await mountPane($, 'terminal')
  await clock.advance(1000)
  expect(blits.length).toBeGreaterThan(0)
  await terminal.unmount()
})

test('the palette follows the setting first, then Claude Code\'s theme, then the system appearance, else dark', () => {
  expect(resolvePalette('light', 'dark', true).base, 'the setting wins over a dark Claude theme').toEqual(LIGHT.base)
  expect(resolvePalette('dark', 'light', false).base, 'the setting wins over a light Claude theme').toEqual(DARK.base)
  expect(resolvePalette('auto', 'light-daltonized', true).base, 'auto follows Claude Code over a dark system').toEqual(LIGHT.base)
  expect(resolvePalette('auto', 'dark-ansi', false).base, 'auto follows Claude Code over a light system').toEqual(DARK.base)
  expect(resolvePalette(undefined, 'auto', false).base, 'a Claude theme with no light or dark falls to the system').toEqual(LIGHT.base)
  expect(resolvePalette(undefined, undefined, true).base).toEqual(DARK.base)
  expect(resolvePalette(undefined, undefined, undefined).base, 'nothing known').toEqual(DARK.base)
  expect(resolvePalette('light', 'dark', true).code, 'code keeps the background the engine colours it for').toEqual(DARK.code)
  expect(resolvePalette('dark', 'light', false).code).toEqual(LIGHT.code)
})

const luminance = ([r, g, b]: Rgb) => {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const ACCENTS = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'yellow', 'pink'] as const

test('every colour pair the views draw meets WCAG contrast in both palettes', () => {
  for (const [name, p] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as [string, Palette][]) {
    const pairs: [string, Rgb, Rgb, number][] = []
    for (const fg of ['text', 'muted'] as const) {
      for (const bg of ['base', 'card', 'selected'] as const) {
        pairs.push([`${fg} on ${bg}`, p[fg], p[bg], 4.5])
      }
    }
    for (const bg of ['base', 'card', 'selected'] as const) {
      pairs.push([`faint on ${bg}`, p.faint, p[bg], 3])
    }
    for (const accent of ACCENTS) {
      pairs.push([`${accent} text on card`, p[accent], p.card, 4.5])
      pairs.push([`${accent} text on base`, p[accent], p.base, 4.5])
      pairs.push([`${accent} mark on selected`, p[accent], p.selected, 3])
      pairs.push([`text on ${accent} pill`, p.text, mix(p.base, p[accent], PILL_TINT), 4.5])
      pairs.push([`text on strong ${accent} pill`, p.text, mix(p.base, p[accent], PILL_STRONG_TINT), 4.5])
    }
    pairs.push(['text on the active tab', p.text, mix(p.base, p.blue, TAB_TINT), 4.5])
    pairs.push(['muted on an idle tab', p.muted, mix(p.base, p.line, TAB_TINT), 4.5])
    pairs.push(['keycap text on key', p.text, p.key, 4.5])
    p.hero.forEach((stop, i) => {
      pairs.push([`hero text on stop ${i}`, p.heroText, stop, 4.5])
      pairs.push([`cat on stop ${i}`, p.cat, stop, 3])
    })
    const failing = pairs.filter(([, fg, bg, min]) => contrast(fg, bg) < min).map(([label, fg, bg, min]) => `${label}: ${contrast(fg, bg).toFixed(2)} < ${min}`)
    expect(failing, name).toEqual([])
  }
})

test('focus never rests on a hidden button: Tab past the end wraps to the first control, Shift+Tab past the start to the last', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  const landed: (string | undefined)[] = []
  on('ui.focus', async ($, e) => {
    landed.push(e.element)
    return {}
  })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  const all: Found[] = await ui.findAll({ type: 'Button' })
  const visible = all.filter(b => !isHidden(b)).map(b => String(b.key))
  const raise = (element: string) => $.ui.focus({ component: 'Pane', requestId: PANE, element, origin: { kind: 'person' } } as never)
  await raise(visible.at(-1)!)
  await raise('unused-4')
  expect(landed.at(-1), 'forward off the end').toBe(visible[0])
  await raise('hk-1')
  expect(landed.at(-1), 'backward off the start').toBe(visible.at(-1))
  await raise(visible[3]!)
  expect(landed.at(-1), 'a visible control is left alone').toBe(visible[3])
  await ui.unmount()
})

test('the settings footer shows g to close them', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await mountPane($)
  await ui.press({ key: 'settings' })
  expect((await ui.find({ key: 'settings' }))?.text).toContain(EN.mod_settings_close)
  expect((await ui.find({ key: 'settings' }))?.text).toContain(' g ')
  await ui.press({ key: 'hk-g' })
  expect(await ui.find({ key: 'setting-scope' }), 'g closes settings').toBeUndefined()
  await ui.unmount()
})
