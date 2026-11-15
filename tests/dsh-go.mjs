import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerDshGo, answerPages } from '../lib/dsh-go.js'
import { host } from './helpers/host.mjs'

const turn = () => new Promise((resolve) => setImmediate(resolve))
function nativeHost(t, config = {}) {
  let panel, registrations = 0, removals = 0
  const h = host(t, config, { native: { registerDshGo }, services: {
    dshGo: { panel(id, value) { assert.equal(id, 'consult'); panel = value; registrations++; return () => { removals++ } } },
  } })
  t.after(() => { assert.equal(registrations, 1); assert.equal(removals, 1) })
  return { ...h, get state() { return h.state }, panel,
    invoke: (action, value, scope = 'A') => panel.actions[action](typeof scope === 'string' ? { sessionId: scope } : scope, { value, locale: 'zh-CN' }),
  }
}
const askValue = (key, question = 'why?') => ({ consultKey: key, values: { 'data.form.question': question, 'data.form.target': 'executor' } })

function snapshot(h, scope) {
  let data
  h.panel.data(scope, (value) => { data = value }, { locale: 'zh' })()
  return data
}

test('approval card scopes auto-select the exact call, including PTC children', async (t) => {
  const h = nativeHost(t); h.main()
  const first = h.pending('inner', { command: 'echo inner' }, true)
  const other = h.pending('newer')
  const scope = { sessionId: 'A', callId: 'inner' }
  const data = snapshot(h, scope)
  assert.equal(data.form.consultKey, first.key)
  assert.equal(data.form.locked, false)
  assert.match(data.detail, /echo inner/)
  assert.equal(data.recent.length, 1)
  assert.equal(snapshot(h, { sessionId: 'A', callId: 'root' }).form.consultKey, '')
  const effects = await h.invoke('ask', askValue(data.form.consultKey), scope)
  assert.equal(effects[0].patch.form.question, '')
  await turn()
  assert.equal(first.threads.executor.length, 1)
  assert.equal(other.threads.executor.length, 0)
  assert.equal(first.resolvedAt, null)
  const view = h.panel.view(scope, { locale: 'zh', components: ['form', 'select', 'textField'] })
  assert.ok(!JSON.stringify(view).includes('"id":"history"'), 'card entry has no extra record picker above the form')
})

test('a stale card or a foreign call never falls back to the newest approval', async (t) => {
  const h = nativeHost(t); h.main(); const current = h.pending()
  for (const scope of [{ sessionId: 'A', callId: 'missing' }, { sessionId: 'B', callId: current.callId }]) {
    const data = snapshot(h, scope)
    assert.equal(data.form.consultKey, '')
    assert.equal(data.form.locked, true)
    assert.deepEqual(data.recent, [])
    for (const action of ['select', 'ask', 'review', 'stop', 'read', 'copy', 'threads']) {
      const result = await h.invoke(action, askValue(current.key), scope)
      assert.equal(typeof result.toast, 'string', action)
      assert.equal(result.patch, undefined, action)
      assert.equal(result.copy, undefined, action)
    }
  }
  assert.equal(h.state.jobs.size, 0)
})

test('card scope reconstructs its exact log record after a plugin restart', (t) => {
  const h = nativeHost(t); h.main(); h.pending('older'); h.pending('newer')
  h.state.pendings.clear(); h.state.pendingBySession.clear()
  const data = snapshot(h, { sessionId: 'A', callId: 'older' })
  assert.ok(data.form.consultKey)
  assert.equal(h.state.pendings.get(data.form.consultKey).callId, 'older')
  assert.equal(data.form.locked, false)
})

test('card reconnect restores its selection and answer without replaying a question', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending('older')
  const scope = { sessionId: 'A', callId: 'older' }
  const before = snapshot(h, scope)
  await h.invoke('ask', askValue(before.form.consultKey), scope); await turn()
  h.pending('newer')
  const after = snapshot(h, scope)
  assert.equal(after.form.consultKey, before.form.consultKey)
  assert.match(after.answers[0].subtitle, /test answer/)
  assert.equal(after.form.question, '')
  assert.equal(r.threads.executor.length, 1)
  r.resolvedAt = Date.now()
  assert.equal(snapshot(h, scope).form.locked, true)
  assert.match((await h.invoke('ask', askValue(r.key), scope)).toast, /已结束/)
})

test('a delayed scoped record is selected once; live pushes retain input defaults and lock on completion', () => {
  const saved = { set: globalThis.setInterval, clear: globalThis.clearInterval }
  const ticks = new Map(), feed = []
  let panel, records = []
  globalThis.setInterval = (fn) => { const id = { unref() {} }; ticks.set(id, fn); return id }
  globalThis.clearInterval = (id) => ticks.delete(id)
  try {
    const dispose = registerDshGo({ inject(_names, fn) { fn({ dshGo: { panel(_id, p) { panel = p } } }) } }, {
      maxQuestionChars: 2000, records: () => records,
    })
    const close = panel.data({ sessionId: 'A', callId: 'a' }, (data) => feed.push(data), {})
    assert.equal(feed.at(-1).form.locked, true)
    const first = { callId: 'a', consultKey: 'first', toolName: 'shell', resolved: false }
    records = [first]
    for (const tick of ticks.values()) tick()
    assert.equal(feed.at(-1).form.consultKey, 'first')
    assert.equal(feed.at(-1).form.locked, false)
    first.reviewBusy = true
    for (const tick of ticks.values()) tick()
    assert.match(feed.at(-1).detail, /正在评估/)
    first.reviewBusy = false
    first.reviewer = { reason: '只读取测试数据' }
    for (const tick of ticks.values()) tick()
    assert.match(feed.at(-1).detail, /只读取测试数据/)
    first.resolved = true
    records.unshift({ ...first, consultKey: 'second', resolved: false })
    for (const tick of ticks.values()) tick()
    assert.equal(feed.at(-1).form.consultKey, 'first', 'another approval cannot redirect an existing draft')
    assert.equal(feed.at(-1).form.locked, true)
    assert.equal(feed.at(-1).recent.length, 1)
    assert.ok(feed.every((d) => d.form.question === '' && d.form.target === 'executor'))
    close(); dispose(); assert.equal(ticks.size, 0)
  } finally { globalThis.setInterval = saved.set; globalThis.clearInterval = saved.clear }
})

test('native bridge is optional and cannot become a required DSH service', () => {
  let deps
  const dispose = registerDshGo({ inject(names, fn) { deps = names; fn({}); return () => {} } }, {})
  assert.deepEqual(deps, ['dshGo']); dispose()
})

test('native ask returns before the model finishes; stop aborts that same host job', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  let unblock, signal
  h.ctx.llm.stream = async function* (options) {
    signal = options.signal
    await new Promise((resolve) => { unblock = resolve })
    yield { type: 'text-delta', text: 'late' }
  }
  const effects = await h.invoke('ask', askValue(r.key))
  assert.equal(effects[0].patch.form.question, '')
  assert.equal(r.threads.executor.length, 1)
  assert.equal(r.threads.executor[0].status, 'streaming')
  const job = [...h.state.jobs.values()][0]
  await h.invoke('stop', { consultKey: r.key })
  assert.equal(job.controller.signal.aborted, true)
  assert.equal(job.status, 'cancelled')
  unblock(); await turn()
  assert.notEqual(job.entry.status, 'done')
})

for (const action of ['select', 'ask', 'review', 'stop', 'read', 'copy', 'threads']) {
  test(`native ${action} rejects cross-session identifiers and missing scope`, async (t) => {
    const h = nativeHost(t); h.main(); const r = h.pending()
    for (const sessionId of ['B', '']) {
      const result = await h.invoke(action, { ...askValue(r.key), sessionId: 'A', target: 'executor', threadId: 'q:1' }, sessionId)
      assert.equal(typeof result.toast, 'string')
      assert.equal(result.patch, undefined)
      assert.equal(result.copy, undefined)
    }
    assert.equal(h.state.jobs.size, 0)
  })
}

test('native record selection is per client; another selection cannot redirect a draft', async (t) => {
  const h = nativeHost(t); h.main(); const a = h.pending('a'), b = h.pending('b')
  const clientA = await h.invoke('select', { consultKey: a.key })
  await h.invoke('select', { consultKey: b.key })
  await h.invoke('ask', askValue(clientA.patch.form.consultKey))
  await turn()
  assert.equal(a.threads.executor.length, 1)
  assert.equal(b.threads.executor.length, 0)
})

test('native ended approval rejects ask and review without generating or deciding', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending(); r.resolvedAt = Date.now()
  for (const action of ['ask', 'review']) {
    const result = await h.invoke(action, askValue(r.key))
    assert.match(result.toast, /已结束/)
  }
  assert.equal(h.state.jobs.size, 0)
  assert.equal(h.injections.length, 0)
})

test('native review starts immediately and repeated clicks reuse the active classification', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  let release, calls = 0
  h.ctx.llm.stream = async function* () {
    calls++
    await new Promise((resolve) => { release = resolve })
    yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  assert.ok((await h.invoke('review', { consultKey: r.key })).toast)
  await h.invoke('review', { consultKey: r.key })
  await turn(); assert.equal(calls, 1)
  release(); await turn(); await turn()
  assert.equal(r.advisoryReview.decision.decision, 'allow')
  assert.equal(r.resolvedAt, null, 'advice must never approve the tool')
})

test('native subscription reconnect reads completed answers without replaying a question', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const first = [], second = []
  const close = h.panel.data({ sessionId: 'A' }, (data) => first.push(data), { locale: 'zh' })
  close()
  await h.invoke('ask', askValue(r.key)); await turn()
  const stop = h.panel.data({ sessionId: 'A' }, (data) => second.push(data), { locale: 'zh' })
  stop()
  assert.equal(first[0].answers.length, 0)
  assert.match(second[0].answers[0].subtitle, /test answer/)
  assert.equal(r.threads.executor.length, 1)
  assert.equal(second[0].form.question, '')
  assert.ok(Buffer.byteLength(JSON.stringify(second[0])) < 32768)
})

test('native invalid input retains the client draft and does not start work', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  for (const text of ['', 'a'.repeat(601), '\u0000'.repeat(700)]) {
    const result = await h.invoke('ask', askValue(r.key, text))
    assert.ok(result.toast)
    assert.equal(result.patch, undefined)
  }
  assert.equal(h.state.jobs.size, 0)
})

test('native Unicode limit counts scalars while respecting the host and wire budgets', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const effects = await h.invoke('ask', askValue(r.key, '🙂'.repeat(600)))
  assert.equal(effects[0].patch.form.question, '')
  assert.equal(r.threads.executor[0].question, '🙂'.repeat(600))
  await turn()
})

test('native reviewer-off hides reviewer inputs and stored reviewer answers', (t) => {
  const h = nativeHost(t, { reviewerMode: 'off' }); h.main(); const r = h.pending()
  r.threads.reviewer.push({ id: 'review-secret', at: 1, answer: 'hidden', question: 'hidden', status: 'done' })
  const view = h.panel.view({}, { components: ['form', 'textField', 'select'], locale: 'zh' })
  const form = view.children.find((c) => c.type === 'form')
  assert.deepEqual(form.children[0].options.map((o) => o.value), ['executor'])
  assert.ok(!JSON.stringify(view).includes('"id":"review"'))
  let data
  h.panel.data({ sessionId: 'A' }, (d) => { data = d }, {})()
  assert.equal(data.answers.length, 0)
})

test('native subscriptions emit only changes and release timers on close and unload', () => {
  const saved = { set: globalThis.setInterval, clear: globalThis.clearInterval }
  const timers = new Map(), feeds = [[], []]
  let panel, removals = 0, released = 0
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 500); const id = { unref() {} }; timers.set(id, fn); return id }
  globalThis.clearInterval = (id) => timers.delete(id)
  try {
    const ctx = { inject(_deps, fn) { fn({ dshGo: { panel(_id, p) { panel = p; return () => removals++ } } }); return () => released++ } }
    const dispose = registerDshGo(ctx, { maxQuestionChars: 2000, records: () => [] })
    const first = panel.data({ sessionId: 'A' }, (d) => feeds[0].push(d), {})
    panel.data({ sessionId: 'A' }, (d) => feeds[1].push(d), {})
    for (const tick of timers.values()) tick()
    assert.deepEqual(feeds.map((f) => f.length), [1, 1])
    first(); assert.equal(timers.size, 1)
    dispose(); assert.equal(timers.size, 0)
    assert.equal(removals, 1); assert.equal(released, 1)
  } finally { globalThis.setInterval = saved.set; globalThis.clearInterval = saved.clear }
})

test('all answer pages round trip Unicode and escapes within bridge budgets', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const answer = ('你🙂\n\u0000"').repeat(5000)
  const pages = answerPages(answer)
  assert.equal(pages.join(''), answer)
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4002)
  r.threads.executor.push({ id: 'q:long', question: 'long?', answer, status: 'done', at: Date.now() })
  const result = await h.invoke('read', { consultKey: r.key, target: 'executor', threadId: 'q:long', page: 1 })
  assert.equal(result.patch.reader.text, pages[1])
  assert.equal((await h.invoke('copy', { consultKey: r.key, target: 'executor', threadId: 'q:long', page: 1 })).copy, pages[1])
})

test('native record and thread pages reach entries beyond the initial snapshot', async (t) => {
  const h = nativeHost(t); h.main()
  const records = Array.from({ length: 12 }, (_, i) => h.pending(`call-${i}`))
  const r = records[0]
  r.threads.executor.push(...Array.from({ length: 20 }, (_, i) => ({ id: `q:${i}`, at: i, question: `q${i}`, answer: 'x', status: 'done' })))
  const history = await h.invoke('history', { page: 0, direction: 1 })
  assert.ok(history.patch.history.items.some((item) => item.action.args.consultKey === r.key))
  const older = await h.invoke('threads', { consultKey: r.key, page: 1, direction: 1 })
  assert.equal(older.patch.conversation.items.at(-1).action.args.threadId, 'q:0')
})
