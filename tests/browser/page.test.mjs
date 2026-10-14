import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HTML = readFileSync(join(ROOT, 'src', 'side_insights', 'web', 'app.html'), 'utf8')
const SCRIPT = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'))
const EN = JSON.parse(readFileSync(join(ROOT, 'src', 'side_insights', 'locales', 'en.json'), 'utf8'))
const KEY = 'pane1'
const HUNK = '@@ -1,2 +1,2 @@\n-old <b>line</b>\n+new line\n same'

const STATE = {
  activity: {
    sid: 's1',
    cwd: '/repo',
    busy: false,
    tools: [
      { tool: 'Edit', label: 'Edit', state: 'ok', start: 100, end: 101, file: 'src/a.ts' },
      { tool: 'Bash', label: 'Bash', state: 'err', start: 102, end: 103, summary: 'npm test', reason: 'exit 1: 2 failed' },
      { tool: 'Read', label: 'Read', state: 'ok', start: 104, end: 105, file: 'src/b.ts' },
    ],
    files: [
      { path: 'src/a.ts', count: 2, created: false, last: 101 },
      { path: 'src/new.ts', count: 1, created: true, last: 109 },
    ],
  },
  flows: [{ id: 'f1', ts: 200, status: 'ok', title: 'Retry-safe checkout' }],
  pending: null,
  qa: {
    sid: 's1',
    pending: false,
    waiting: [],
    eta: 30,
    auto: true,
    counts: { answered: 1, partial: 1, unanswered: 1, open: 2, total: 3 },
    turns: [
      {
        turn_id: 't1',
        ts: 150,
        status: 'ok',
        prompt: 'make checkout retry-safe',
        items: [
          { id: 'i1', status: 'answered', question: 'Does it retry?', answer: 'Yes.' },
          { id: 'i2', status: 'partial', question: 'What about <script>alert(1)</script>?', answer: 'Partly.', from: 'mid-turn' },
          { id: 'i3', status: 'unanswered', question: 'Is the load test done?', answer: 'No.', manual: true },
        ],
      },
    ],
  },
}

const FLOW = {
  ts: 200,
  status: 'ok',
  cwd: '/repo',
  edited: ['/elsewhere/src/store.ts', '/repo/src/store.ts'],
  prompt: 'make checkout retry-safe',
  flow: {
    title: 'Retry-safe checkout',
    summary: 'A key makes the second click safe.',
    steps: [
      { title: 'Read the key', location: 'src/route.ts / post', kind: 'input', explanation: 'Reads it.', code: 'const key = 1' },
      { title: 'Store the key', location: 'src/store.ts / save', kind: 'storage', changed: true, explanation: 'Saves it.', code: 'save(key)', highlight: ['save'] },
    ],
    changes: [{ file: 'src/store.ts', what: 'New store' }],
    checks: [{ label: 'npm test', status: 'fail', steps: [2] }],
  },
}

const element = () => ({
  innerHTML: '',
  textContent: '',
  dataset: {},
  style: {},
  classList: { toggle() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  focus() {},
})

async function openPage({ state = STATE, mode = 'live', diff, pane = {}, shared = {}, batches = [5, 10, 20, 30], search = '' } = {}) {
  const requests = []
  const handlers = {}
  const copied = []
  const els = { app: element(), toast: element(), tip: element() }
  const configPayload = () => {
    const global = { analyze: 'opened', flow_auto: true, qa_auto: true, qa_batch: 20, model: 'opus', lang: 'en', theme: 'auto', ...shared }
    return { global, pane, effective: { ...global, ...pane }, models: ['opus'], langs: [], themes: ['auto', 'dark', 'light'], analyze: ['opened', 'all'],
      ...(batches ? { qa_batches: batches } : {}) }
  }
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1:47821')
    requests.push({ method: init.method || 'GET', path: u.pathname, params: u.searchParams, body: init.body })
    if (u.pathname === '/api/config' && init.method === 'POST' && u.searchParams.get('pane')) pane = { ...pane, ...JSON.parse(init.body) }
    const body = u.pathname.endsWith('/state') ? state
      : u.pathname.endsWith('/flow/f1') ? FLOW
      : u.pathname.endsWith('/diff') ? (diff ? diff(u.searchParams) : { source: 'working', hunks: HUNK, cut: 0 })
      : u.pathname === '/api/config' ? configPayload()
      : { ok: true }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }
  const document = {
    title: '',
    documentElement: { lang: '' },
    activeElement: null,
    getElementById: id => els[id],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { handlers[type] = fn },
  }
  const context = vm.createContext({
    document,
    window: { scrollY: 0, scrollTo() {}, getSelection: () => '' },
    location: { search: `?full=1&mode=${mode}${search}`, href: `http://127.0.0.1:47821/p/${KEY}?full=1` },
    navigator: { clipboard: { writeText: async text => { copied.push(text) } } },
    fetch,
    URL,
    URLSearchParams,
    AbortSignal,
    CSS: { escape: s => String(s) },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {},
    getComputedStyle: () => ({}),
    innerWidth: 1400,
    innerHeight: 900,
    console,
  })
  const source = SCRIPT.replace('__PANEL_KEY__', JSON.stringify(KEY))
    .replace('__PANEL_I18N__', JSON.stringify({ lang: 'en', messages: EN, fallback: EN }))
    .replace('__PANEL_TOKEN__', '"tok"')
  vm.runInContext(source, context)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 5; i++) await settle()
  const run = async code => {
    const out = vm.runInContext(code, context)
    for (let i = 0; i < 5; i++) await settle()
    return out
  }
  const click = async dataset => {
    const target = { dataset, closest: sel => (/qid|overlay/.test(sel) ? null : target), getAttribute: () => null, disabled: false }
    handlers.click({ target })
    for (let i = 0; i < 5; i++) await settle()
  }
  const key = async (k, extra = {}) => {
    handlers.keydown({ key: k, target: { closest: () => null, matches: () => false }, preventDefault() {}, ...extra })
    for (let i = 0; i < 5; i++) await settle()
  }
  const change = async target => {
    handlers.change({ target: { type: 'select-one', ...target } })
    for (let i = 0; i < 5; i++) await settle()
  }
  return { html: () => els.app.innerHTML, toast: () => els.toast.textContent, requests, run, click, key, change, copied }
}

const diffRequests = page => page.requests.filter(r => r.path.endsWith('/diff')).map(r => Object.fromEntries(r.params))

test('Live shows a count tile per tool state, and a tile filters the tool list until pressed again', async () => {
  const page = await openPage()
  assert.match(page.html(), /data-tool-filter="err"/)
  assert.match(page.html(), /Tools 3/)
  await page.click({ toolFilter: 'err' })
  assert.match(page.html(), /Tools 1 \/ 3/)
  assert.doesNotMatch(page.html(), /src\/b\.ts/)
  await page.click({ toolFilter: 'err' })
  assert.match(page.html(), /Tools 3/)
})

test('a failed tool call opens to show why it failed', async () => {
  const page = await openPage()
  assert.doesNotMatch(page.html(), /exit 1: 2 failed/)
  await page.click({ toolOpen: '102:Bash' })
  assert.match(page.html(), /exit 1: 2 failed/)
})

test('clicking an edited file opens its diff with escaped hunks, and d s f switch the view', async () => {
  const page = await openPage({ diff: q => (q.get('view') === 'commit' ? { source: 'commit', commit: 'abc1234 Fix', hunks: HUNK, cut: 0 } : { source: 'working', hunks: HUNK, cut: 0 }) })
  await page.click({ diffFile: 'src/a.ts', diffFlow: '' })
  assert.deepEqual(diffRequests(page), [{ path: 'src/a.ts', view: 'auto' }])
  assert.match(page.html(), /<span class="del">-old &lt;b&gt;line&lt;\/b&gt;<\/span>/)
  assert.match(page.html(), /<span class="add">\+new line<\/span>/)
  await page.key('s')
  assert.equal(diffRequests(page).at(-1).view, 'commit')
  assert.match(page.html(), /abc1234 Fix/)
  await page.key('x')
  assert.doesNotMatch(page.html(), /diff-card/)
})

test('k and j walk the edited files newest first, and a held key does not fire again', async () => {
  const page = await openPage()
  await page.key('j')
  assert.equal(diffRequests(page).at(-1).path, 'src/new.ts')
  await page.key('j')
  assert.equal(diffRequests(page).at(-1).path, 'src/a.ts')
  await page.key('j', { repeat: true })
  assert.equal(diffRequests(page).length, 2)
})

test('a Flow change opens the edited file under the flow folder and names its flow', async () => {
  const page = await openPage({ mode: 'flow' })
  assert.match(page.html(), /data-diff-file="\/repo\/src\/store\.ts" data-diff-flow="f1"/)
  await page.click({ diffFile: '/repo/src/store.ts', diffFlow: 'f1' })
  assert.deepEqual(diffRequests(page), [{ path: '/repo/src/store.ts', view: 'auto', flow: 'f1' }])
})

test('a Flow step lists its own changes and checks, and k j move between steps', async () => {
  const page = await openPage({ mode: 'flow' })
  assert.doesNotMatch(page.html(), /sub-h changes/)
  await page.key('j')
  assert.match(page.html(), /sub-h changes/)
  assert.match(page.html(), /sub-h checks/)
  assert.match(page.html(), /class="card fail"/)
})

test('Q&A status tiles filter the questions, and question text is escaped with its tags', async () => {
  const page = await openPage({ mode: 'qa' })
  assert.match(page.html(), /33%/)
  assert.match(page.html(), /What about &lt;script&gt;alert\(1\)&lt;\/script&gt;\?/)
  assert.doesNotMatch(page.html(), /<script>alert/)
  assert.match(page.html(), new RegExp(EN.midturn))
  assert.match(page.html(), new RegExp(EN.manual_tag))
  await page.click({ qaStatus: 'partial' })
  assert.match(page.html(), /data-qa-pick="i2"/)
  assert.doesNotMatch(page.html(), /data-qa-pick="i1"/)
  assert.doesNotMatch(page.html(), /data-qa-pick="i3"/)
})

test('clicking a question copies its text', async () => {
  const page = await openPage({ mode: 'qa' })
  await page.click({ qaPick: 'i1' })
  assert.deepEqual(page.copied, ['Does it retry?'])
})

test('a new finished flow is announced, a pending one only once it finishes', async () => {
  const pending = { ...STATE, flows: [{ id: 'f2', ts: 300, status: 'pending', title: 'Later' }, ...STATE.flows] }
  const page = await openPage({ state: STATE })
  await page.run(`absorbState(${JSON.stringify(pending)})`)
  assert.equal(page.toast(), '')
  const done = { ...pending, flows: [{ ...pending.flows[0], status: 'ok' }, ...STATE.flows] }
  await page.run(`absorbState(${JSON.stringify(done)})`)
  assert.equal(page.toast(), EN.mod_toast_flow.replace('{0}', 'Later'))
})

const posted = page => page.requests.filter(r => r.method === 'POST').map(r => `${r.path}?${r.params}${r.body ? ` ${r.body}` : ''}`)

test('opening a panel page switches the panel on and checks what is already there, unless it is already on', async () => {
  const expected = ['/api/config?pane=pane1 {"enabled":true}', '/api/pane1/regen?target=flow&new=1', '/api/pane1/regen?target=qa']
  const page = await openPage()
  assert.deepEqual(posted(page).sort(), expected)
  const off = await openPage({ pane: { enabled: false } })
  assert.deepEqual(posted(off).sort(), expected)
  const on = await openPage({ pane: { enabled: true } })
  assert.deepEqual(posted(on), [])
})

test('switching on with analyze set to all sessions starts no check, since the hooks already run them', async () => {
  const page = await openPage({ shared: { analyze: 'all' } })
  assert.deepEqual(posted(page), ['/api/config?pane=pane1 {"enabled":true}'])
})

test('switching on asks only for the checks whose switch is on', async () => {
  const qa = await openPage({ shared: { flow_auto: false } })
  assert.deepEqual(posted(qa).sort(), ['/api/config?pane=pane1 {"enabled":true}', '/api/pane1/regen?target=qa'])
  const flow = await openPage({ shared: { qa_auto: false } })
  assert.deepEqual(posted(flow).sort(), ['/api/config?pane=pane1 {"enabled":true}', '/api/pane1/regen?target=flow&new=1'])
})

test('a page opened on its settings shows this panel as on once it has been switched on', async () => {
  const page = await openPage({ search: '&dialog=settings' })
  assert.match(page.html(), /data-setting="enabled" data-setting-scope="pane"[^>]*checked/)
})

test('settings show this panel, which sessions, and the shared switches, each saved to its own scope', async () => {
  const page = await openPage({ pane: { enabled: true } })
  await page.run('openDialog("settings")')
  const html = page.html()
  for (const key of ['s_enabled', 's_analyze', 's_flow_auto', 's_qa_auto']) assert.ok(html.includes(EN[key].replace(/&/g, '&amp;')), key)
  assert.match(html, /data-setting="enabled" data-setting-scope="pane"/)
  assert.match(html, /data-setting="analyze" data-setting-scope="global"/)
  assert.match(html, new RegExp(EN.analyze_all))
  await page.run('saveSetting({ analyze: "all" }, "global")')
  assert.ok(posted(page).includes('/api/config? {"analyze":"all"}'))
  await page.run('saveSetting({ enabled: false }, "pane")')
  assert.ok(posted(page).includes('/api/config?pane=pane1 {"enabled":false}'))
})

test('check now builds the flow on Flow, checks pending turns on Q&A, and only refreshes Live', async () => {
  for (const [mode, target] of [['flow', 'flow'], ['qa', 'qa'], ['live', null]]) {
    const page = await openPage({ mode, pane: { enabled: true } })
    await page.key('u')
    const regens = posted(page).filter(p => p.includes('/regen'))
    assert.deepEqual(regens, target ? [`/api/pane1/regen?target=${target}`] : [], mode)
  }
})

test('a check that skipped older turns offers to check the next batch of them', async () => {
  const turn = { ...STATE.qa.turns[0], skipped_turns: 15 }
  const page = await openPage({ mode: 'qa', pane: { enabled: true }, state: { ...STATE, qa: { ...STATE.qa, batch: 7, turns: [turn] } } })
  assert.match(page.html(), new RegExp(EN.qa_skipped.replace('{0}', '15')))
  assert.match(page.html(), new RegExp(EN.check_older.replace('{0}', '7').replace('↻', '.')))
  await page.click({ qaOlder: 't1' })
  assert.ok(posted(page).includes('/api/pane1/regen?target=qa&older=t1'))
})

test('a held u does not start a second check', async () => {
  const page = await openPage({ mode: 'qa', pane: { enabled: true } })
  await page.key('u', { repeat: true })
  assert.deepEqual(posted(page).filter(p => p.includes('/regen')), [])
})

test('check now is hidden while help or settings is open, and help lists u and the batch size', async () => {
  const page = await openPage({ pane: { enabled: true } })
  assert.match(page.html(), /data-act="check-now"/)
  await page.run('openDialog("help")')
  assert.doesNotMatch(page.html(), /data-act="check-now"/)
  assert.match(page.html(), new RegExp(`<kbd>u</kbd></td><td>${EN.term_k_check_now}`))
  assert.match(page.html(), new RegExp(`qa_batch = 20</td><td>${EN.s_qa_batch.replace("&", "&amp;")}`))
  await page.run('closeDialog()')
  assert.match(page.html(), /data-act="check-now"/)
})

test('the batch size is saved as a number', async () => {
  const page = await openPage({ pane: { enabled: true } })
  await page.run('openDialog("settings")')
  await page.change({ dataset: { setting: 'qa_batch', settingScope: 'global' }, value: '30' })
  assert.ok(posted(page).includes('/api/config? {"qa_batch":30}'))
})

test('the batch size menu falls back to the known sizes when the server does not list them', async () => {
  const page = await openPage({ pane: { enabled: true }, batches: null })
  await page.run('openDialog("settings")')
  const menu = page.html().match(/data-setting="qa_batch"[\s\S]*?<\/select>/)[0]
  assert.deepEqual([...menu.matchAll(/<option value="(\d+)"/g)].map(m => m[1]), ['5', '10', '20', '30'])
})

test('the header names the last folder of a Windows path', async () => {
  const page = await openPage({ pane: { enabled: true }, state: { ...STATE, activity: { ...STATE.activity, cwd: 'C:\\work\\shop-api' } } })
  assert.match(page.html(), /class="where"[^>]*>shop-api</)
})
