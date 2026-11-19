// Optional real-browser fixture. Install test-only dependencies outside the plugin:
// npm install --prefix ../mobile-browser react@19.2.0 react-dom@19.2.0 playwright@1.56.1
// node tests/mobile-browser.mjs ../mobile-browser ../dsh-go ../browser-results
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { createServer } from 'node:http'
const dependencies = resolve(process.argv[2] ?? '../mobile-browser')
const go = resolve(process.argv[3] ?? '../dsh-go')
const output = resolve(process.argv[4] ?? '../browser-results')
const require = createRequire(resolve(dependencies, 'package.json'))
const { chromium } = require('playwright')
const modules = { react: ['react', 'react.production.js'], 'react-dom': ['react-dom', 'react-dom.production.js'],
  'react-dom/client': ['react-dom', 'react-dom-client.production.js'], scheduler: ['scheduler', 'scheduler.production.js'] }
const react = `var process={env:{NODE_ENV:'production'}}; var modules={${Object.entries(modules).map(([id, [pkg, file]]) =>
  `${JSON.stringify(id)}:function(module,exports,require){${readFileSync(resolve(dirname(require.resolve(`${pkg}/package.json`)), 'cjs', file), 'utf8')}\n}`).join(',')}}; var cache={}; function require(id){if(!cache[id]){var module=cache[id]={exports:{}};modules[id](module,module.exports,require)}return cache[id].exports}window.React=require('react');window.ReactDOM=require('react-dom/client');`
let asks = 0, polls = 0, disconnected = false, answer = '', status = 'streaming', hasJob = false
const pending = { consultKey: 'ac:A', approvalId: 'one', callId: 'call-1', toolName: 'shell', reason: '确认执行命令', resolved: false }
const bootstrap = `window.__ModuleLoader__={load(def){var plugin=def.factory(()=>React),dict={},cleanups=[];
const binding={props:{sessionId:'A'}}, pending={kind:'approval',key:'approval:1',callId:'call-1',toolName:'shell',reason:'确认执行命令',answerable:true};
const statuses=new Map([['A',{pendingInteraction:pending}]]), listeners=new Set();
window.decisions=[];
function answer(outcome){window.decisions.push([this.key,outcome])}
pending.answer=answer;
window.replaceApproval=()=>{
  statuses.set('A',{pendingInteraction:{...pending,key:'approval:2',callId:'call-2',reason:'另一项审批'}});
  for(const fn of listeners)fn();
};
plugin.apply({effect(fn){const dispose=fn();if(dispose)cleanups.push(dispose)},locale:{register(ns,lang,values){dict[lang]=values;return()=>{}},bind(){return key=>dict.zh[key]||key},resolveText(x){return x}},
uiSession:{adapter:{current:{getSnapshot:()=>binding,subscribe:()=>()=>{}}},sessionStatus:{getSnapshot:()=>statuses,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}}},
slots:{inject(name,fn){fn()},register(slot,render){if(slot.name==='shell.overlay')ReactDOM.createRoot(document.getElementById('root')).render(render({}));return()=>{}}}});window.disposeConsult=()=>cleanups.reverse().forEach(fn=>fn());}};`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const send = (body, type = 'application/json', code = 200) => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
  if (path === '/') return send(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}#root{min-height:100vh}</style><div id="root"></div><script src="/react.js"></script><script>${bootstrap}</script><script src="/client.js"></script><script src="/back.js"></script>`, 'text/html;charset=utf-8')
  if (path === '/react.js') return send(react, 'text/javascript')
  if (path === '/client.js') return send(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), 'text/javascript')
  if (path === '/back.js') return send(readFileSync(resolve(go, 'app/assets/web/dsh_web_back.js'), 'utf8'), 'text/javascript')
  if (path.endsWith('/ask')) { asks++; hasJob = true; return send({ ok: true, jobId: 'j:1', threadId: 'q:1', consultKey: 'ac:A' }) }
  if (disconnected) return send({ ok: false, error: 'disconnected' }, 'application/json', 503)
  if (path.endsWith('/context') && url.searchParams.get('callId') === 'call-2') {
    return send({ ok: true, consultKey: 'ac:B', pending: { ...pending, consultKey: 'ac:B', approvalId: 'two', callId: 'call-2', reason: '另一项审批' },
      executor: { available: true }, features: { timeoutAvailable: false }, threads: { executor: [], reviewer: [] } })
  }
  if (path.endsWith('/context')) return send({ ok: true, pending, consultKey: 'ac:A', executor: { available: true }, reviewer: { available: true },
    features: { timeoutAvailable: false, attachments: { enabled: false } }, limits: { maxQuestionChars: 2000 },
    threads: { executor: hasJob ? [{ id: 'q:1', jobId: 'j:1', at: 1, question: 'test', answer, status }] : [], reviewer: [] } })
  if (path.endsWith('/poll')) { polls++; const cursor = Number(new URL(req.url, 'http://localhost').searchParams.get('cursor')); return send({ ok: true, delta: answer.slice(cursor), cursor: answer.length, status }) }
  return send({ ok: true, items: [] })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_EXECUTABLE ? { executablePath: process.env.DSH_BROWSER_EXECUTABLE } : {}) })
  .catch((error) => { server.close(); throw error })
mkdirSync(output, { recursive: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => { errors.push(String(error)); console.error(error) })
  page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('[data-approval-consult-pill]').click()
  await page.locator('.ac-input:not([disabled])').waitFor()
  const setKeyboard = async (height) => {
    await page.evaluate((height) => {
      for (const [id, css] of [['dsh-app-insets', ':root{--dsh-app-inset-top:20px;--dsh-app-inset-bottom:24px}'], ['dsh-app-keyboard', height ? `#root{bottom:${height}px}` : '']]) {
        let style = document.getElementById(id)
        if (!style) { style = document.createElement('style'); style.id = id; document.head.appendChild(style) }
        style.textContent = css
      }
      window.__dshAppKeyboard = height
    }, height)
    await page.waitForTimeout(100)
  }
  await page.locator('.ac-input').fill('中文输入')
  await page.locator('.ac-input').press('Enter')
  assert.equal(asks, 0)
  assert.match(await page.locator('.ac-input').inputValue(), /\n/)
  for (const [name, width, height, keyboard] of [['portrait', 393, 852, 330], ['landscape', 852, 393, 200]]) {
    await page.setViewportSize({ width, height }); await setKeyboard(keyboard)
    await page.locator('.ac-input').focus()
    await page.waitForTimeout(350)
    const geometry = await page.evaluate(() => {
      const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
      return { input: rect('.ac-input'), send: rect('.ac-send'), root: rect('.ac-root'), max: innerHeight - window.__dshAppKeyboard }
    })
    await page.screenshot({ path: resolve(output, `${name}-keyboard.png`) })
    console.log(name, geometry)
    assert.ok(geometry.input.top >= 20 && geometry.input.bottom <= geometry.max + 1, `${name}: input above IME`)
    assert.ok(geometry.send.bottom <= geometry.max + 1, `${name}: Send above IME`)
    assert.ok(geometry.root.left >= 0 && geometry.root.right <= width, `${name}: no horizontal overflow`)
  }
  await page.setViewportSize({ width: 393, height: 852 }); await setKeyboard(0)
  assert.equal(await page.evaluate(() => window.__dshAppBack()), 'layer')
  await page.locator('.ac-root').waitFor({ state: 'detached' })
  await page.locator('[data-approval-consult-pill]').click()
  await page.locator('.ac-input:not([disabled])').fill('test')
  await page.locator('.ac-send').click()
  await page.waitForFunction(() => document.querySelector('.ac-turn'))
  await page.waitForTimeout(150)
  assert.equal(asks, 1)
  disconnected = true
  await page.locator('.ac-connection').waitFor()
  await page.locator('.ac-input').fill('保留这条草稿')
  answer = '断线期间完成的回答🙂'; status = 'done'; disconnected = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.getByText(answer, { exact: true }).waitFor()
  assert.equal(await page.locator('.ac-input').inputValue(), '保留这条草稿')
  assert.equal(asks, 1, 'reconnection must not submit another question')
  assert.ok(polls > 0)
  // Replace A directly with B in the same React update. Even a click before
  // React paints B must never answer from A's still-visible consultation.
  await page.locator('.ac-decide-actions .ac-btn-primary:enabled').waitFor({ state: 'attached' })
  await page.evaluate(() => {
    const allow = document.querySelector('.ac-decide-actions .ac-btn-primary')
    window.replaceApproval()
    allow.click()
  })
  await page.waitForFunction(() => !document.querySelector('.ac-decide-actions button:enabled'))
  assert.deepEqual(await page.evaluate(() => window.decisions), [])
  await page.evaluate(() => window.__dshAppBack())
  await page.locator('[data-approval-consult-pill]').click()
  await page.locator('.ac-input:not([disabled])').waitFor()
  await page.locator('.ac-decide-actions .ac-btn-primary').click()
  assert.deepEqual(await page.evaluate(() => window.decisions), [['approval:2', 'allowed-once']])
  assert.deepEqual(errors, [])
  console.log('mobile browser: keyboard, Go Back, reconnect, draft and approval identity checks passed')
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
