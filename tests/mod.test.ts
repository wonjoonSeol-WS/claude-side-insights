import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const KEY = 'demo'
const PLUGIN = 'side-insights'
const PANE = 'side-insights'

const EN: Record<string, string> = {
  ask_message: 'Please answer: {0}',
  flow_started: 'Rebuilding the flow',
  mod_band_flow: 'Flow: {0}',
  mod_band_hint: '/si to open',
  mod_band_waiting: '{0} waiting, checked ~{1}s after the turn',
  mod_server_down: 'Side insights server is not running. Run ! claude-panel to start it.',
  mod_spinner_waiting: '{0} questions waiting',
  mod_toast_flow: 'Flow ready: {0}',
  mod_toast_open: 'Open questions from the last turn: {0}',
  qa_checking: 'Checking questions',
  term_confirm: 'Press {0} again to run it (one Claude call)',
  term_status_set: 'Status set to {0}',
}

const turn = (id: string, items: { id: string; status: string; question: string }[]) => ({
  turn_id: id,
  ts: 1791905000,
  status: 'ok',
  model: 'opus',
  prompt: `prompt of ${id}`,
  items: items.map(i => ({ ...i, from: 'prompt', answer: `==Answer== to ${i.question}`, archived: false })),
})

const STATE = {
  activity: {
    sid: 's1',
    cwd: '/repo',
    busy: false,
    tools: [
      { tool: 'Edit', label: 'Edit', summary: 'edit', file: '/repo/src/a.ts', state: 'ok', start: 1791905000, end: 1791905001 },
      { tool: 'Bash', label: 'Bash', summary: 'npm test', file: null, state: 'err', start: 1791905002, end: 1791905004 },
    ],
    files: [{ path: '/repo/src/a.ts', count: 2, created: false, last: 1791905001 }],
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
      turn('t1', [{ id: 'i4', status: 'answered', question: 'Rounding mode?' }]),
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
    checks: [{ label: 'npm test (23 passed)', status: 'pass' }],
  },
}

type Call = { url: string; method: string; body?: string }

const reply = (status: number, data: unknown): { value: HttpResponse } => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) },
})

const setup = (on: On, state: { current: unknown; up: boolean }) => {
  const calls: Call[] = []
  const toasts: string[] = []
  const copied: string[] = []
  const runs: string[][] = []
  mock.env(on, { CMUX_PANEL_ID: KEY, HOME: '/home/u' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 's1' }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('fs.read', async ($, e) => ({
    value: e.path.endsWith('/token') ? 'tok\n' : e.path.endsWith('/en.json') ? JSON.stringify(EN) : '{}',
  }))
  on('http.fetch', async ($, e) => {
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', body: e.init?.body })
    expect(e.init?.headers?.['X-Side-Insights']).toBe('tok')
    if (!state.up) {
      return reply(502, {})
    }
    const path = e.url.replace('http://127.0.0.1:47821', '')
    if (path.startsWith('/api/config')) {
      return reply(200, { effective: { lang: 'en' } })
    }
    if (path === `/api/${KEY}/state`) {
      return reply(200, state.current)
    }
    if (path === `/api/${KEY}/flow/f2`) {
      return reply(200, FLOW)
    }
    if (e.init?.method === 'POST') {
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'err_not_found' })
  })
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', props: { key: 'engine-band' }, children: [] }))
  return { calls, toasts, copied, runs, clock }
}

const start = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

const BAND = (bodyColumns: number) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
})

const PANE_PROPS = {
  component: 'Pane' as const,
  requestId: PANE,
  props: { title: 'Side insights', isFocused: true, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

test('band shows Q&A counts, the waiting count with ETA and the latest flow', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  for (const surface of SURFACES) {
    const wide = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(200) })
    const line = (await wide.find({ type: 'Text' }))?.text ?? ''
    expect(line).toContain('Q&A ✓ 2  ◐ 1  ✗ 1')
    expect(line).toContain('2 waiting, checked ~34s after the turn')
    expect(line).toContain('Flow: Retry-safe checkout')
    expect(line).toContain('/si to open')
    expect(line).not.toContain(String.fromCharCode(0xb7))
    await wide.unmount()
    const narrow = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(40) })
    const short = (await narrow.find({ type: 'Text' }))?.text ?? ''
    expect(short).not.toContain('/si to open')
    expect(short.length).toBeLessThanOrEqual(40)
    await narrow.unmount()
  }
})

test('band yields to the engine when there is nothing to show', async ($, on) => {
  const empty = { ...STATE, flows: [], qa: { ...STATE.qa, turns: [], waiting: [] } }
  const { clock } = setup(on, { current: empty, up: true })
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(120) })
    expect(await ui.find({ key: 'engine-band' }), "{ key: 'engine-band' }").toBeDefined()
    await ui.unmount()
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
  expect(seen.at(-1)).toBe('… (2 questions waiting)')
  await ui.unmount()
})

test('pane draws the three tabs and its keys act on the server', async ($, on) => {
  const { clock, calls, copied } = setup(on, { current: STATE, up: true })
  await start($, clock)
  const first = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
  expect((await first.find({ key: 'item-i2' }))?.text).toContain('▶')
  await first.unmount()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE_PROPS })
    expect(await ui.find({ key: 'tab-flow' }), "{ key: 'tab-flow' }").toBeDefined()
    await ui.press({ key: 'item-i2' })
    expect((await ui.find({ key: 'item-i2' }))?.text).toContain('▶')
    expect(await ui.find({ type: 'Markdown', text: /\*\*Answer\*\*/ }), "{ type: 'Markdown', text: /\\*\\*Answer\\*\\*/ }").toBeDefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('http://localhost:47821/p/demo?t=tok&full=1')

    calls.length = 0
    await ui.press({ key: 'status' })
    const override = calls.find(c => c.url.endsWith(`/api/${KEY}/qa/override`))
    expect(JSON.parse(override?.body ?? '{}')).toEqual({ id: 'i2', status: 'unanswered' })

    await ui.press({ key: 'item-i3' })
    expect((await ui.find({ key: 'item-i3' }))?.text).toContain('▶')
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)).toBe('Please answer: Is the load test done?')

    calls.length = 0
    await ui.press({ key: 'recheck' })
    expect(calls.some(c => c.url.includes('/regen'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /Press r again/ }), "{ type: 'Text', text: /Press r again/ }").toBeDefined()
    await ui.press({ key: 'recheck' })
    expect(calls.find(c => c.url.includes('/regen'))?.url).toContain('target=qa&item=i3')

    await ui.press({ key: 'tab-flow' })
    await ui.press({ key: 'step-0' })
    expect(calls.filter(c => c.url.endsWith(`/api/${KEY}/flow/f2`))).toHaveLength(surface === 'terminal' ? 1 : 0)
    expect(await ui.find({ key: 'step-1' }), "{ key: 'step-1' }").toBeDefined()
    expect(await ui.find({ type: 'Code', text: /req.header/ }), "{ type: 'Code', text: /req.header/ }").toBeDefined()
    await ui.press({ key: 'step-next' })
    expect((await ui.find({ key: 'step-1' }))?.text).toContain('▶')
    expect(await ui.find({ type: 'Code', text: 'claim(key)' }), "{ type: 'Code', text: 'claim(key)' }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(none\) → in_progress/ }), "{ type: 'Text', text: /\\(none\\) → in_progress/ }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm test \(23 passed\)/ }), "{ type: 'Text', text: /npm test \\(23 passed\\)/ }").toBeDefined()

    await ui.press({ key: 'tab-live' })
    expect(await ui.find({ type: 'Text', text: /src\/a\.ts/ }), "{ type: 'Text', text: /src\\/a\\.ts/ }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm test/ }), "{ type: 'Text', text: /npm test/ }").toBeDefined()

    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('toasts when a new flow finishes and when a verdict leaves questions open', async ($, on) => {
  const state = { current: STATE as unknown, up: true }
  const { clock, toasts } = setup(on, state)
  await start($, clock)
  expect(toasts).toEqual([])
  state.current = {
    ...STATE,
    flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows],
    qa: { ...STATE.qa, turns: [turn('t3', [{ id: 'i9', status: 'partial', question: 'And mobile?' }]), ...STATE.qa.turns] },
  }
  await clock.advance(2000)
  expect(toasts).toContain('Flow ready: Login rate limit')
  expect(toasts).toContain('Open questions from the last turn: 1')
})

test('a server that is down shows the hint and is started at most once a minute', async ($, on) => {
  const state = { current: STATE as unknown, up: false }
  const { clock, runs } = setup(on, state)
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(120) })
    expect((await ui.find({ type: 'Text' }))?.text).toContain('! claude-panel')
    await ui.unmount()
  }
  const starts = () => runs.filter(r => r.join(' ').includes('ensure_panel_server')).length
  expect(starts()).toBe(1)
  expect(runs[0]?.slice(0, 2)).toEqual(['/bin/bash', '-c'])
  await clock.advance(10_000)
  expect(starts()).toBe(1)
  await clock.advance(60_000)
  expect(starts()).toBe(2)
})
