// Run against the pinned Go checkout, not copied/approximated bridge validators.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'
import { registerDshGo } from '../lib/dsh-go.js'
import { host } from './helpers/host.mjs'
import { client } from './helpers/client.mjs'

const go = resolve(process.argv[2] ?? '../dsh-go')
const sdk = await import(pathToFileURL(resolve(go, 'sdk/plugin-kit/lib/testing.js')).href)
const { checkView } = await import(pathToFileURL(resolve(go, 'sdk/plugin-kit/lib/view-check.js')).href)
const dir = fileURLToPath(new URL('..', import.meta.url))

test('an approval-card scope survives the official view, stream and invoke boundary', async (t) => {
  const bridge = sdk.createTestHost({ dir, caps: { app: '1.0.15' } })
  const h = host(t, {}, { native: { registerDshGo }, services: { dshGo: bridge.ctx.get('dshGo') } })
  h.main(); const selected = h.pending('selected'); const other = h.pending('other')
  const scope = { sessionId: 'A', callId: 'selected' }
  const feed = bridge.subscribe('consult', scope)
  try {
    await feed.settled
    assert.deepEqual(feed.errors, [])
    assert.equal(feed.data.form.consultKey, selected.key)
    for (const locale of ['zh-CN', 'en-US']) {
      const { view } = await bridge.view('consult', scope, { locale })
      const checked = checkView(view, { data: feed.data, budget: 'panel' })
      assert.equal(checked.fatal, false)
      assert.deepEqual(checked.issues.filter((i) => i.kind !== 'note'), [])
      assert.equal(checked.placeholders, 0)
    }
    const send = (consultKey) => bridge.invoke('consult', { action: 'ask', scope, userGesture: true,
      value: { consultKey, values: { 'data.form.target': 'executor', 'data.form.question': 'why this call?' } } })
    const rejected = await send(other.key)
    assert.deepEqual(rejected.effects.map((e) => e.type), ['toast'])
    assert.equal(other.threads.executor.length, 0)
    const accepted = await send(selected.key)
    assert.deepEqual(accepted.issues, [])
    assert.deepEqual(accepted.effects.map((e) => e.type), ['patch', 'toast'])
    assert.equal(selected.threads.executor.length, 1)
  } finally { feed.stop(); bridge.dispose() }
})

test('Go v1.0.15 manifest, view, data, actions and cleanup use the official SDK contracts', async (t) => {
  const bridge = sdk.createTestHost({ dir, caps: { app: '1.0.15' } })
  const h = host(t, {}, { native: { registerDshGo }, services: { dshGo: bridge.ctx.get('dshGo') } })
  const row = bridge.contributions()
  assert.equal(row.state, 'ok'); assert.deepEqual(row.issues, [])
  assert.equal(row.contributes.panels[0].ready, true)
  assert.deepEqual(row.contributes.panels[0].placement, ['session.tab', 'chat.panel'])
  assert.equal(row.contributes['session.actions'][0].effect[0].page, 'panel:consult')
  h.main(); const r = h.pending()
  r.threads.executor.push({ id: 'q:test', at: 1, question: 'why?', answer: '完整🙂\n'.repeat(3000), status: 'done' })
  const feed = bridge.subscribe('consult', { sessionId: 'A' }); await feed.settled
  assert.deepEqual(feed.errors, [])
  for (const locale of ['zh-CN', 'en-US']) {
    for (const components of [undefined, ['stack', 'text', 'callout']]) {
      const { view, stats } = await bridge.view('consult', { sessionId: 'A' }, { locale, ...(components ? { components } : {}) })
      assert.ok(stats.bytes <= 32768)
      for (const data of [undefined, feed.data]) {
        const checked = checkView(view, { data, budget: 'panel' })
        assert.equal(checked.fatal, false)
        assert.deepEqual(checked.issues.filter((i) => i.kind !== 'note'), [])
        assert.equal(checked.placeholders, 0)
      }
    }
  }
  const actions = [
    ['select', { consultKey: r.key }],
    ['history', { page: 0, direction: 1 }],
    ['threads', { consultKey: r.key, page: 0 }],
    ['read', { consultKey: r.key, target: 'executor', threadId: 'q:test', page: 1 }],
    ['copy', { consultKey: r.key, target: 'executor', threadId: 'q:test', page: 1 }],
    ['ask', { consultKey: r.key, values: { 'data.form.target': 'executor', 'data.form.question': 'why?' } }],
    ['stop', { consultKey: r.key }],
    ['ask', { consultKey: 'foreign', values: {} }],
  ]
  for (const [action, value] of actions) {
    const response = await bridge.invoke('consult', { action, value, scope: { sessionId: 'A' }, locale: 'en-US', userGesture: true })
    assert.deepEqual(response.issues, [], action)
    assert.ok(response.effects.every((e) => ['patch', 'toast', 'copy'].includes(e.type)))
    for (const effect of response.effects) {
      if (effect.type !== 'patch') continue
      const data = { ...feed.data, ...effect.data }
      const { view } = await bridge.view('consult', { sessionId: 'A' })
      assert.deepEqual(checkView(view, { data }).issues.filter((i) => i.kind !== 'note'), [], action)
    }
  }
  feed.stop(); bridge.dispose()
})

test('the real Go back script blurs the input and dismisses the consultation once', () => {
  const root = { isConnected: true, getClientRects: () => [1] }
  let listener, closes = 0
  const body = { dispatchEvent(event) { event.target = body; if (event.type === 'keydown') listener(event) } }
  const doc = {
    body, documentElement: {}, activeElement: null,
    querySelectorAll: () => closes ? [] : [root],
    addEventListener: (_name, fn) => { listener = fn }, removeEventListener() {},
  }
  doc.activeElement = { tagName: 'TEXTAREA', blur() { doc.activeElement = body } }
  const win = {}
  const h = client(['listenForGoBack'], { window: win, document: doc })
  h.ctx.listenForGoBack(root, () => closes++)
  const context = vm.createContext({ window: win, document: doc, Date,
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, init, { type }) } preventDefault() {} stopImmediatePropagation() {} },
  })
  vm.runInContext(readFileSync(resolve(go, 'app/assets/web/dsh_web_back.js'), 'utf8'), context)
  assert.equal(win.__dshAppBack(), 'layer')
  assert.equal(doc.activeElement, body)
  assert.equal(closes, 1)
})

test('escaped Unicode data and action patches stay within Go wire budgets', async () => {
  const bridge = sdk.createTestHost({ dir })
  const records = Array.from({ length: 8 }, (_, i) => ({
    consultKey: `ac:${i}`, callId: 'x'.repeat(100), toolName: '\u0000'.repeat(1000), reason: '🙂'.repeat(3000),
    executor: { argumentsPreview: '\u0000'.repeat(5000) }, reviewer: { reason: '\u0000'.repeat(5000) },
    threads: { executor: Array.from({ length: 8 }, (_, j) => ({ id: `q:${i}:${j}`, at: j,
      question: '\u0000'.repeat(600), answer: '\u0000'.repeat(10000), status: 'streaming' })), reviewer: [] },
  }))
  const dispose = registerDshGo(bridge.ctx, { maxQuestionChars: 2000, records: () => records })
  try {
    const feed = bridge.subscribe('consult', { sessionId: 'A' }); await feed.settled
    assert.deepEqual(feed.errors, [])
    assert.ok(Buffer.byteLength(JSON.stringify(feed.data)) <= 32768)
    for (const action of ['select', 'history', 'threads', 'read']) {
      const result = await bridge.invoke('consult', { action, scope: { sessionId: 'A' }, userGesture: true,
        value: { consultKey: 'ac:0', threadId: 'q:0:0', target: 'executor', page: 0 } })
      assert.deepEqual(result.issues, [], action)
      assert.ok(result.effects.every((e) => e.type === 'patch'))
    }
  } finally { dispose(); bridge.dispose() }
})
