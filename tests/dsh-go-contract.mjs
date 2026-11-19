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

const runtime = (name) => import(pathToFileURL(resolve(go, 'runtime/bridge/dsh-go-bridge/lib/native', name)).href)
const { NativeCore } = await runtime('core.js')
const { mergeApply, normalizeScope } = await runtime('util.js')

function submission(form, question = 'why?') {
  const args = Object.fromEntries(Object.entries(form.submit.args).filter(([, value]) => !value || typeof value !== 'object'))
  return { ...args, values: { [form.children.at(-1).bind]: question, [`data.${args.slot}.target`]: 'executor' } }
}

function check(view, data) {
  const result = checkView(view, { data, budget: 'panel' })
  assert.equal(result.fatal, false)
  assert.deepEqual(result.issues.filter((i) => i.kind !== 'note'), [])
  assert.equal(result.placeholders, 0)
}

test('stock + menu and session actions open the consultation sheet; old hosts retain their supported entry', async (t) => {
  const bridge = sdk.createTestHost({ dir, caps: { app: '1.0.15' } })
  t.after(() => bridge.dispose())
  const h = host(t, {}, { native: { registerDshGo }, services: { dshGo: bridge.ctx.get('dshGo') } })
  const row = bridge.contributions()
  assert.equal(row.state, 'ok'); assert.deepEqual(row.issues, [])
  assert.ok(row.contributes.panels.every((p) => p.ready))
  assert.equal(row.contributes['composer.tools'][0].effect[0].page, 'panel:consult')
  assert.equal(row.contributes['session.actions'][0].effect[0].page, 'panel:consult')
  h.main(); const selected = h.pending('selected'); h.pending('other')
  const scope = { sessionId: 'A', callId: 'selected' }
  for (const locale of ['zh-CN', 'en-US']) {
    for (const components of [undefined, ['stack', 'text', 'callout']]) {
      const { view, stats } = await bridge.view('consult', scope, { locale, ...(components ? { components } : {}) })
      assert.ok(stats.bytes <= 32768)
      check(view)
    }
  }
  const { view } = await bridge.view('consult', scope)
  const form = view.children.find((n) => n.type === 'form')
  assert.equal(form.submit.args.consultKey, selected.key)
  const invoke = (action, value) => bridge.invoke('consult', { action, value, scope, userGesture: true })
  const rejected = await invoke('ask', { ...submission(form), consultKey: 'missing' })
  assert.deepEqual(rejected.effects.map((e) => e.type), ['toast'])
  const accepted = await invoke('ask', submission(form))
  assert.deepEqual(accepted.issues, [])
  assert.deepEqual(accepted.effects.map((e) => e.type), ['patch', 'toast'])
  const live = await invoke('live', {})
  assert.equal(live.effects[0].page, 'panel:consult-live')
  assert.deepEqual((await invoke('reload', {})).effects.map((e) => e.type), ['refresh'])
  check(view, accepted.effects[0].data)
})

test('production bridge isolates device patches, while live tokens still reach two subscribed clients', async (t) => {
  const core = new NativeCore({}, { feedLingerMs: 100 }, 'test')
  t.after(() => core.dispose())
  const pkg = 'dsh-approval-consult', scope = normalizeScope({ sessionId: 'A' })
  const defs = new Map()
  const service = { panel(id, def) { defs.set(id, { def }); return () => defs.delete(id) } }
  core.regs.set(pkg, { panels: defs })
  const h = host(t, {}, { native: { registerDshGo }, services: { dshGo: service } })
  h.main(); const a = h.pending('first'), b = h.pending('second')
  const consult = defs.get('consult').def
  const editorFeed = core.feed(pkg, 'consult', 'panel', scope, 'zh')
  const liveFeed = core.feed(pkg, 'consult-live', 'panel', scope, 'zh')
  const clients = [{}, {}]
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  for (const [index, client] of clients.entries()) {
    for (const [name, feed] of [['editor', editorFeed], ['live', liveFeed]]) {
      feed.attach({ id: name + index, send(event) {
        if (event.t === 'data') client[name] = event.data
        if (event.t === 'patch') client[name] = mergeApply(client[name], event.merge)
      } })
    }
  }
  await wait(10)
  const view = consult.view(scope.scope, { components: ['form','textField','select'], locale: 'zh' })
  assert.equal(view.children.some((node) => node.type === 'form'), false)
  const apply = async (client, id, value) => {
    const effects = await consult.actions[id](scope.scope, { locale: 'zh', value })
    for (const effect of [].concat(effects)) {
      if (!effect.patch) continue
      core.patchFeed(pkg, 'consult', scope, effect.patch) // production invoke route
      client.editor = mergeApply(client.editor, effect.patch) // Flutter recipient's local merge
    }
  }
  await apply(clients[0], 'select', { consultKey: a.key })
  await apply(clients[1], 'select', { consultKey: b.key })
  const formOf = (client) => client.editor.editor.find((node) => node.type === 'form')
  const firstForm = formOf(clients[0])
  await apply(clients[0], 'ask', submission(firstForm))
  await apply(clients[0], 'ask', submission(firstForm)) // missed receipt
  const entry = a.threads.executor[0]
  await apply(clients[0], 'read', { consultKey: a.key, threadId: entry.id, target: 'executor' })
  const savedPage = clients[0].editor.reader
  await wait(750)
  assert.equal(formOf(clients[0]).submit.args.consultKey, a.key)
  assert.equal(formOf(clients[1]).submit.args.consultKey, b.key)
  assert.equal(clients[0].editor.reader, savedPage)
  assert.equal(clients[1].editor.reader, undefined)
  assert.ok(clients.every((c) => c.live.answers.some((item) => item.subtitle.includes('test answer'))))
  assert.equal(a.threads.executor.length, 1)
  assert.equal(b.threads.executor.length, 0)
  for (const client of clients) check(view, client.editor)
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

test('escaped Unicode data, local action patches and live summaries stay within bridge budgets', async () => {
  const bridge = sdk.createTestHost({ dir })
  const records = Array.from({ length: 8 }, (_, i) => ({
    consultKey: `ac:${i}`, callId: 'x'.repeat(100), toolName: '\u0000'.repeat(1000), reason: '🙂'.repeat(3000),
    executor: { argumentsPreview: '\u0000'.repeat(5000) }, reviewer: { reason: '\u0000'.repeat(5000) },
    threads: { executor: Array.from({ length: 8 }, (_, j) => ({ id: `q:${i}:${j}`, at: j,
      question: '\u0000'.repeat(600), answer: '\u0000'.repeat(10000), status: 'streaming' })), reviewer: [] },
  }))
  const dispose = registerDshGo(bridge.ctx, { maxQuestionChars: 2000, records: () => records })
  try {
    const scope = { sessionId: 'A' }
    const feed = bridge.subscribe('consult-live', scope); await feed.settled
    assert.deepEqual(feed.errors, [])
    assert.ok(Buffer.byteLength(JSON.stringify(feed.data)) <= 32768)
    const { view } = await bridge.view('consult', scope)
    let data = {}
    for (const action of ['select', 'history', 'threads', 'read', 'copy']) {
      const result = await bridge.invoke('consult', { action, scope, userGesture: true,
        value: { consultKey: 'ac:0', threadId: 'q:0:0', target: 'executor', page: 0 } })
      assert.deepEqual(result.issues, [], action)
      for (const effect of result.effects) if (effect.type === 'patch') data = mergeApply(data, effect.data)
      check(view, data)
    }
  } finally { dispose(); bridge.dispose() }
})
