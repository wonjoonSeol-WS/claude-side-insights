// usage: node browser.mjs <page url> <text the Live tab must show>
// Opens the real panel page in headless Chrome and checks the rendered Live tab. Exits 2 when Chrome is missing.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, want] = process.argv.slice(2)
const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const chrome = CHROMES.find(p => existsSync(p))
if (!chrome) {
  console.log('skip: no Chrome found')
  process.exit(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 9300 + Math.floor(Math.random() * 600)
const child = spawn(chrome, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'si-chrome-'))}`, 'about:blank'], { stdio: 'ignore' })
let targets
for (let i = 0; i < 100 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch {
    await sleep(200)
  }
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const waiting = new Map()
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data)
  waiting.get(d.id)?.(d)
})
const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
await send('Page.navigate', { url: `${url}&mode=live` })
let text = ''
for (let i = 0; i < 40 && !text.includes(want); i++) {
  await sleep(250)
  text = (await send('Runtime.evaluate', { expression: 'document.getElementById("app")?.innerText || ""' })).result?.result?.value ?? ''
}
child.kill()
const ok = text.includes(want)
console.log(ok ? `ok   the Live tab shows ${want}` : `FAIL the Live tab does not show ${want}:\n${text.slice(0, 500)}`)
process.exit(ok ? 0 : 1)
