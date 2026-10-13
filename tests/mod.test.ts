import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

import { cells, connect } from '../hooks/mod/data'

const SURFACES = ['terminal', 'desktop'] as const
const KEY = 'demo'
const PLUGIN = 'side-insights'
const PANE = 'side-insights'

const EN: Record<string, string> = {
  ask_message: 'Please answer: {0}',
  flow_started: 'Rebuilding the flow',
  mod_band_flow: 'Flow: {0}',
  mod_diff_working: 'Not committed yet (git diff HEAD)',
  mod_diff_new: 'New file, not in git yet',
  mod_diff_commit: 'Already committed, showing {0} (git show)',
  mod_key_unused: '{0} does nothing here. Press h to see the keys.',
  mod_band_hint: '/si to open',
  mod_band_waiting: '{0} waiting, checked ~{1}s after the turn',
  mod_spinner_waiting: '{0} questions waiting',
  mod_toast_flow: 'Flow ready: {0}',
  mod_toast_open: 'Open questions from the last turn: {0}',
  qa_checking: 'Checking questions',
  qa_wait_off: 'Automatic checks are off. Press ↻ to check.',
  server_down: 'The panel server is not running. Run ! claude-panel to start it.',
  term_failed: 'Could not do that: {0}',
  flow_fail: 'Could not build the flow',
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

const KO: Record<string, string> = {
  mod_band_flow: '흐름: {0}',
  mod_band_hint: '/si 로 열기',
  mod_band_waiting: '{0}개 대기 중, 턴이 끝나고 약 {1}초 뒤 확인',
}

type Call = { url: string; method: string; body?: string }

type World = {
  current: unknown
  up: boolean
  stateStatus?: number
  flowStatus?: number
  lang?: string
  sid?: string
  env?: Record<string, string>
  taken?: string[]
  git?: (args: string[]) => { exitCode: number; stdout: string }
}

const reply = (status: number, data: unknown): { value: HttpResponse } => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) },
})

const setup = (on: On, world: World) => {
  const calls: Call[] = []
  const toasts: string[] = []
  const copied: string[] = []
  const runs: string[][] = []
  const registered: string[] = []
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
  on('fs.read', async ($, e) => ({
    value: e.path.endsWith('/token')
      ? 'tok\n'
      : e.path.endsWith('/en.json')
        ? JSON.stringify(EN)
        : e.path.endsWith('/ko.json')
          ? JSON.stringify(KO)
          : '{}',
  }))
  on('http.fetch', async ($, e) => {
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', body: e.init?.body })
    expect(e.init?.headers?.['X-Side-Insights']).toBe('tok')
    if (!world.up) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:47821')
    }
    const path = e.url.replace('http://127.0.0.1:47821', '')
    if (path.startsWith('/api/config')) {
      return reply(200, { effective: { lang: world.lang ?? 'en' } })
    }
    if (path.endsWith('/state')) {
      return world.stateStatus ? reply(world.stateStatus, { error: 'Request refused. Reopen the panel and try again.' }) : reply(200, world.current)
    }
    if (path === `/api/${KEY}/flow/f2`) {
      return world.flowStatus ? reply(world.flowStatus, { error: 'Flow file is unreadable' }) : reply(200, FLOW)
    }
    if (e.init?.method === 'POST') {
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'Not found' })
  })
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    const out = e.argv[0] === 'git' && world.git ? world.git([...e.argv]) : { exitCode: 0, stdout: '' }
    return { value: { ...out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', async ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.open', async () => ({ value: undefined }))
  on('classic.SessionStart', async () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', props: { key: 'engine-band' }, children: [] }))
  return { calls, toasts, copied, runs, registered, clock }
}

const start = async ($: Engine, clock: { settle: () => Promise<void> }, isInteractive = true) => {
  await $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive })
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

const RUN_SI = { command: 'si', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }

const bandText = async ($: Engine, cols: number, surface: (typeof SURFACES)[number] = 'terminal') => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND(cols) })
  const text = (await ui.find({ key: 'side-insights-band' }))?.text
  const engine = await ui.find({ key: 'engine-band' })
  await ui.unmount()
  return { text, engine }
}

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

test('band shows Q&A counts, the waiting count with ETA and the latest flow', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  for (const surface of SURFACES) {
    const wide = (await bandText($, 200, surface)).text ?? ''
    expect(wide).toContain('Q&A ✓ 2  ◐ 1  ✗ 1')
    expect(wide).toContain('2 waiting, checked ~34s after the turn')
    expect(wide).toContain('Flow: Retry-safe checkout')
    expect(wide).toContain('/si to open')
    expect(wide).not.toContain(String.fromCharCode(0xb7))
    const short = (await bandText($, 40, surface)).text ?? ''
    expect(short).not.toContain('/si to open')
    expect(cells(short)).toBeLessThanOrEqual(40)
  }
})

test('band uses the server counts and says when automatic checks are off', async ($, on) => {
  const counts = { answered: 7, partial: 0, unanswered: 3, open: 3, total: 10 }
  const { clock } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, auto: false, counts } }, up: true })
  await start($, clock)
  const line = (await bandText($, 200)).text ?? ''
  expect(line).toContain('Q&A ✓ 7  ◐ 0  ✗ 3')
  expect(line).toContain('2  Automatic checks are off')
  expect(line).not.toContain('checked ~34s')
})

test('band fits a Korean line by display width', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true, lang: 'ko' })
  await start($, clock)
  const wide = (await bandText($, 200)).text ?? ''
  expect(wide).toContain('흐름: Retry-safe checkout')
  for (const cols of [30, 45, 60]) {
    const line = (await bandText($, cols)).text ?? ''
    expect(cells(line)).toBeLessThanOrEqual(cols)
    expect(line.length).toBeLessThan(cells(line))
  }
})

test('band sits on top of what the engine draws, and yields when there is nothing to show', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock } = setup(on, world)
  await start($, clock)
  for (const surface of SURFACES) {
    const both = await bandText($, 120, surface)
    expect(both.text).toContain('Q&A')
    expect(both.engine, "{ key: 'engine-band' }").toBeDefined()
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
  const first = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
  expect((await first.find({ key: 'row-1-i2' }))?.text).toContain('▶')
  await first.unmount()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE_PROPS })
    expect(await ui.find({ key: 'tab-flow' }), "{ key: 'tab-flow' }").toBeDefined()
    await ui.press({ key: 'item-1-i2' })
    expect((await ui.find({ key: 'row-1-i2' }))?.text).toContain('▶')
    expect(await ui.find({ type: 'Markdown', text: /\*\*Answer\*\*/ }), "{ type: 'Markdown', text: /\\*\\*Answer\\*\\*/ }").toBeDefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(surface === 'desktop' ? 'http://localhost:47821/p/demo?t=tok&full=1' : undefined)

    expect(await ui.find({ key: 'status' }), 'no manual status key').toBeUndefined()

    await ui.press({ key: 'item-0-i1' })
    expect(await ui.find({ key: 'copy' }), 'no copy for an answered question').toBeUndefined()

    await ui.press({ key: 'item-2-i3' })
    expect((await ui.find({ key: 'row-2-i3' }))?.text).toContain('▶')
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)).toBe('Please answer: Is the load test done?')

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

test('the browser link is drawn only where a local page can open', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'vscode', ...PANE_PROPS })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ key: 'open' }), "{ key: 'open' }").toBeDefined()
  await ui.unmount()
})

test('a failed turn row re-checks that turn', async ($, on) => {
  const failed = { turn_id: 't5', ts: 1791905400, status: 'error', prompt: 'broken turn', items: [] }
  const { clock, calls } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, turns: [failed, ...STATE.qa.turns] } }, up: true })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
  await ui.press({ key: 'fail-0-t5' })
  await ui.press({ key: 'recheck' })
  await ui.press({ key: 'recheck' })
  expect(calls.find(c => c.url.includes('/regen'))?.url).toContain('target=qa&turn=t5')
  await ui.unmount()
})

test('a selection that the filter hides is cleared', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
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
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
  await ui.press({ key: 'tab-flow' })
  await ui.press({ key: 'flow-next' })
  expect(await ui.find({ type: 'Text', text: '2 / 2' }), "{ text: '2 / 2' }").toBeDefined()
  world.current = { ...STATE, flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows] }
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: '3 / 3' }), "{ text: '3 / 3' }").toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Cart total rounding' }), 'still on f1').toBeDefined()
  await ui.unmount()
})

test('a flow that fails to load shows the error once instead of refetching', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true, flowStatus: 500 })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
  await ui.press({ key: 'tab-flow' })
  await clock.advance(6000)
  expect(await ui.find({ type: 'Text', text: 'Could not build the flow' }), 'flow_fail').toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Flow file is unreadable' }), 'server error').toBeDefined()
  expect(calls.filter(c => c.url.endsWith('/flow/f2'))).toHaveLength(1)
  await ui.unmount()
})

test('toasts once per poll when a new flow finishes and a verdict leaves questions open', async ($, on) => {
  const world: World = { current: STATE, up: true }
  const { clock, toasts } = setup(on, world)
  await start($, clock)
  expect(toasts).toEqual([])
  world.current = {
    ...STATE,
    flows: [{ id: 'f3', ts: 1791905300, status: 'ok', title: 'Login rate limit' }, ...STATE.flows],
    qa: { ...STATE.qa, turns: [turn('t3', [{ id: 'i9', status: 'partial', question: 'And mobile?' }]), ...STATE.qa.turns] },
  }
  await clock.advance(2000)
  expect(toasts).toEqual(['Flow ready: Login rate limit  |  Open questions from the last turn: 1'])
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
  expect(toasts).toEqual([])
})

test('a child analysis session skips the timer too', async ($, on) => {
  const { clock, calls } = setup(on, { current: STATE, up: true, env: { CMUX_PANEL_ID: KEY, HOME: '/home/u', SIDE_INSIGHTS_CHILD: '1' } })
  await start($, clock)
  await clock.advance(20_000)
  expect(calls.filter(c => c.url.endsWith('/state'))).toHaveLength(1)
})

test('a taken command name does not stop the other one or the band', async ($, on) => {
  const { clock, registered } = setup(on, { current: STATE, up: true, taken: ['si'] })
  await start($, clock)
  expect(registered).toEqual(['side-insights'])
  expect((await bandText($, 200)).text).toContain('Q&A ✓ 2')
})

test('/clear moves to the new session key and forgets the old state', async ($, on) => {
  const world: World = { current: STATE, up: true, sid: 'sess-a', env: { HOME: '/home/u' } }
  const { clock, calls } = setup(on, world)
  await start($, clock)
  expect(calls.some(c => c.url.endsWith('/api/sess-a/state'))).toBe(true)
  world.sid = 'sess-b'
  world.current = { ...STATE, flows: [], qa: { ...STATE.qa, turns: [], waiting: [] } }
  calls.length = 0
  await $.classic.SessionStart({
    hook_event_name: 'SessionStart',
    source: 'clear',
    session_id: 'sess-b',
    transcript_path: '/t/sess-b.jsonl',
    cwd: '/repo',
  })
  await clock.settle()
  expect(calls.some(c => c.url.endsWith('/api/sess-b/state'))).toBe(true)
  expect(calls.some(c => c.url.includes('/api/sess-a/'))).toBe(false)
  expect((await bandText($, 200)).text).toBeUndefined()
})

test('a server that is down shows the hint and is started at most once a minute', async ($, on) => {
  const world: World = { current: STATE, up: false }
  const { clock, runs } = setup(on, world)
  await start($, clock)
  for (const surface of SURFACES) {
    expect((await bandText($, 120, surface)).text).toContain('! claude-panel')
  }
  const starts = () => runs.filter(r => r.join(' ').includes('ensure_panel_server')).length
  expect(starts()).toBe(1)
  expect(runs[0]?.slice(0, 2)).toEqual(['/bin/bash', '-c'])
  await clock.advance(10_000)
  expect(starts()).toBe(1)
  await clock.advance(60_000)
  expect(starts()).toBe(2)
})

for (const status of [403, 500]) {
  test(`HTTP ${status} shows the server message and never starts the server`, async ($, on) => {
    const { clock, runs } = setup(on, { current: STATE, up: true, stateStatus: status })
    await start($, clock)
    await clock.advance(10_000)
    const line = (await bandText($, 200)).text ?? ''
    expect(line).toContain('Could not do that: Request refused. Reopen the panel and try again.')
    expect(line).not.toContain('claude-panel')
    expect(runs).toEqual([])
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
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS, props: { ...PANE_PROPS.props, bodyColumns } })
    await ui.press({ key: 'tab-flow' })
    expect(!!(await ui.find({ key: 'flow-cols' })), `flow columns at ${bodyColumns}`).toBe(wide)
    expect(await ui.find({ key: 'step' }), 'the step card is drawn either way').toBeDefined()
    await ui.press({ key: 'tab-live' })
    expect(!!(await ui.find({ key: 'live-cols' })), `live columns at ${bodyColumns}`).toBe(wide)
    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('h opens a help card with the panel keys and the Claude Code pane keys, and a tab closes it', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE_PROPS })
    await ui.press({ key: 'help' })
    expect(await ui.find({ key: 'help-cc' }), "{ key: 'help-cc' }").toBeDefined()
    expect(await ui.find({ type: 'Text', text: / ctrl\+x ← ↑ / }), 'the grow keys').toBeDefined()
    expect(await ui.find({ type: 'Text', text: / a / }), 'a Q&A key').toBeDefined()
    expect(await ui.find({ key: 'qa-tiles' }), 'help replaces the tab body').toBeUndefined()
    await ui.press({ key: 'tab-qa' })
    expect(await ui.find({ key: 'help-cc' }), 'a tab press leaves help').toBeUndefined()
    await ui.unmount()
  }
})

test('a key the pane does not use is caught with a hint instead of falling through to the prompt', async ($, on) => {
  const { clock } = setup(on, { current: STATE, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE_PROPS })
    await ui.press({ key: 'unused-4' })
    expect(await ui.find({ type: 'Text', text: /4 does nothing here/ }), 'the hint').toBeDefined()
    await ui.press({ key: 'tab-flow' })
    expect(await ui.find({ key: 'pipeline' }), 'the tab key still works after it').toBeDefined()
    await ui.press({ key: 'tab-qa' })
    await ui.unmount()
  }
})

test('re-checking a question marked by hand clears the mark first, so the check can change it', async ($, on) => {
  const manual = { ...STATE.qa.turns[0], items: STATE.qa.turns[0].items.map(i => (i.id === 'i2' ? { ...i, manual: true } : i)) }
  const { clock, calls } = setup(on, { current: { ...STATE, qa: { ...STATE.qa, turns: [manual, ...STATE.qa.turns.slice(1)] } }, up: true })
  await start($, clock)
  await $.command.run(RUN_SI)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
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

const DIFF_CASES = [
    { name: 'uncommitted', git: (a: string[]) => (a.includes('diff') && a.includes('HEAD') ? { exitCode: 0, stdout: `diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /git diff HEAD/ },
    { name: 'new', git: (a: string[]) => (a.includes('ls-files') ? { exitCode: 1, stdout: '' } : a.includes('--no-index') ? { exitCode: 1, stdout: `--- /dev/null\n+++ b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /New file/ },
    { name: 'committed', git: (a: string[]) => (a.includes('log') ? { exitCode: 0, stdout: `abc1234 Add retries\n\ndiff --git a/x b/x\n${HUNK_TEXT}\n` } : { exitCode: 0, stdout: '' }), label: /abc1234 Add retries/ },
]

for (const k of DIFF_CASES) {
  test(`pressing a changed file shows its diff: ${k.name}`, async ($, on) => {
    const world: World = { current: STATE, up: true, git: k.git }
    const { clock } = setup(on, world)
    await start($, clock)
    await $.command.run(RUN_SI)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE_PROPS })
    await ui.press({ key: 'tab-live' })
    await ui.press({ key: 'file-0' })
    expect(await ui.find({ type: 'Text', text: k.label }), `${k.name}: source label`).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format, `${k.name}: drawn as a diff`).toBe('diff')
    expect(String(code?.props.source).startsWith('@@ '), `${k.name}: only hunks reach the Code`).toBe(true)
    await ui.press({ key: 'diff-close' })
    expect(await ui.find({ key: 'diff' }), `${k.name}: closed`).toBeUndefined()
    await ui.unmount()
  })
}
