import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerDshGo, answerPages } from '../lib/dsh-go.js'
import { host } from './helpers/host.mjs'

const turn = () => new Promise((resolve) => setImmediate(resolve))
function nativeHost(t, config = {}) {
  const panels = {}; let removals = 0
  const h = host(t, config, { native: { registerDshGo }, services: {
    dshGo: { panel(id, value) { panels[id] = value; return () => { removals++ } } },
  } })
  t.after(() => { assert.deepEqual(Object.keys(panels), ['consult', 'consult-live']); assert.equal(removals, 2) })
  const panel = panels.consult
  return { ...h, live: panels['consult-live'], get state() { return h.state }, panel,
    invoke: (action, value, scope = 'A') => panel.actions[action](typeof scope === 'string' ? { sessionId: scope } : scope, { value, locale: 'zh-CN' }),
  }
}
const caps = { locale: 'zh', components: ['form', 'textField', 'select'] }
const scoped = (callId) => ({ sessionId: 'A', callId })
const formIn = (nodes) => nodes.find((node) => node.type === 'form')
const snapshot = (h, scope) => h.panel.view(scope, caps).children
const formFor = (h, record) => formIn(snapshot(h, scoped(record.callId)))
function submission(form, question = 'why?', target = 'executor') {
  const args = Object.fromEntries(Object.entries(form.submit.args).filter(([, value]) => !value || typeof value !== 'object'))
  return { ...args, values: { [form.children.at(-1).bind]: question, [`data.${args.slot}.target`]: target } }
}
const askValue = (h, record, question) => submission(formFor(h, record), question)

test('PTC scope pins an exact call; stale cards do not fall back to another call', async (t) => {
  const h = nativeHost(t); h.main()
  const first = h.pending('inner', { command: 'echo inner' }, true), other = h.pending('newer')
  const nodes = snapshot(h, scoped('inner'))
  assert.equal(formIn(nodes).submit.args.consultKey, first.key)
  assert.match(JSON.stringify(nodes), /echo inner/)
  assert.ok(!JSON.stringify(nodes).includes('"id":"history"'))
  for (const foreign of [scoped('missing'), scoped('root'), { sessionId: 'B', callId: 'inner' }]) {
    assert.equal(formIn(snapshot(h, foreign)), undefined)
    for (const name of ['ask', 'select', 'stop', 'review', 'read', 'copy', 'threads']) {
      const result = await h.invoke(name, submission(formIn(nodes)), foreign)
      assert.equal(typeof result.toast, 'string')
    }
  }
  await h.invoke('ask', submission(formIn(nodes)), scoped('inner')); await turn()
  assert.equal(first.threads.executor.length, 1)
  assert.equal(other.threads.executor.length, 0)
})

test('incomplete enumeration and multiple pending calls require a choice; only a complete unique pending is preselected', () => {
  let panel, complete = false
  const records = [{ consultKey: 'k1', callId: 'c1', toolName: 'x', resolved: false }, { consultKey: 'old', resolved: true }]
  const close = registerDshGo({ inject(_, fn) { fn({ dshGo: { panel(id, definition) { if (id === 'consult') panel = definition } } }) } },
    { maxQuestionChars: 600, recordSet: () => ({ records, complete }) })
  const current = () => formIn(panel.view({ sessionId: 'A' }, caps).children)?.submit.args.consultKey
  assert.equal(current(), undefined)
  complete = true
  assert.equal(current(), 'k1')
  records.push({ consultKey: 'k2', resolved: false })
  assert.equal(current(), undefined)
  close()
})

test('reconnect re-reads a log record and never replays a consultation; a changed approval or confirmed thread gets a fresh field', async (t) => {
  const h = nativeHost(t); h.main(); h.pending('older'); h.pending('newer')
  h.state.pendings.clear(); h.state.pendingBySession.clear()
  const scope = scoped('older')
  const first = formIn(snapshot(h, scope))
  assert.equal(h.state.pendings.get(first.submit.args.consultKey).callId, 'older')
  const second = formIn(snapshot(h, scope))
  assert.equal(first.children.at(-1).bind, second.children.at(-1).bind)
  await h.invoke('ask', submission(first), scope); await turn()
  const third = formIn(snapshot(h, scope))
  assert.equal(third.submit.args.consultKey, first.submit.args.consultKey)
  assert.notEqual(third.children.at(-1).bind, first.children.at(-1).bind)
  assert.equal(h.state.pendings.get(first.submit.args.consultKey).threads.executor.length, 1)
})

test('an ambiguous native receipt reuses the same job and an acknowledged next question uses a fresh operation', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const send = submission(formFor(h, r))
  const [accepted, retried] = await Promise.all([h.invoke('ask', send), h.invoke('ask', send)])
  assert.equal(r.threads.executor.length, 1)
  assert.deepEqual(accepted.map((effect) => Object.keys(effect)[0]), ['patch','toast'])
  assert.equal(retried[0].patch[send.slot].question, '')
  const ack = accepted[0].patch[send.slot]
  const next = await h.invoke('ask', { ...send, next: ack.next, clear: ack.clear, expected: ack.expected })
  assert.equal(next[0].patch[send.slot].question, null)
  assert.equal(r.threads.executor.length, 2)
  await turn()
})

test('a late first request is visible before retrying an ambiguous send across a view reload', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const original = submission(formFor(h, r)), reopened = submission(formFor(h, r))
  assert.notEqual(original.seed, reopened.seed)
  await h.invoke('ask', original)
  const reconcile = await h.invoke('ask', reopened)
  assert.match(reconcile[0].patch.receipt, /why\?/)
  assert.equal(reconcile[0].patch[reopened.slot].question, undefined, 'retain the unsent local field')
  assert.equal(r.threads.executor.length, 1)
  await turn()
})

test('a follow-up in an explicitly selected editor keeps its local field identity and alternates successful clears', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending('first'); h.pending('second')
  const first = submission(formIn((await h.invoke('select', { consultKey: r.key })).patch.editor))
  const sent = await h.invoke('ask', first)
  const second = submission(formIn(sent[0].patch.editor), 'follow-up')
  assert.equal(first.slot, second.slot)
  assert.notEqual(first.seed, second.seed)
  const again = await h.invoke('ask', second)
  assert.equal(again[0].patch[second.slot].question, null)
  assert.deepEqual(r.threads.executor.map((q) => q.question), ['why?', 'follow-up'])
  await turn()
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
  const effects = await h.invoke('ask', askValue(h, r))
  assert.equal(Object.entries(effects[0].patch).find(([k]) => /^q[a-f0-9]{32}$/.test(k))[1].question, '')
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
      const result = await h.invoke(action, { ...askValue(h, r), sessionId: 'A', target: 'executor', threadId: 'q:1' }, sessionId)
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
  await h.invoke('ask', submission(formIn(clientA.patch.editor)))
  await turn()
  assert.equal(a.threads.executor.length, 1)
  assert.equal(b.threads.executor.length, 0)
})

test('native ended approval rejects ask and review without generating or deciding', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending(); const ask = askValue(h, r); r.resolvedAt = Date.now()
  for (const action of ['ask', 'review']) {
    const result = await h.invoke(action, ask)
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
  const close = h.live.data({ sessionId: 'A' }, (data) => first.push(data), { locale: 'zh' })
  close()
  await h.invoke('ask', askValue(h, r)); await turn()
  const stop = h.live.data({ sessionId: 'A' }, (data) => second.push(data), { locale: 'zh' })
  stop()
  assert.equal(first[0].answers.length, 0)
  assert.match(second[0].answers[0].subtitle, /test answer/)
  assert.equal(r.threads.executor.length, 1)
  assert.equal(second[0].form, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(second[0])) < 32768)
})

test('native invalid input retains the client draft and does not start work', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  for (const text of ['', 'a'.repeat(601), '\u0000'.repeat(700)]) {
    const result = await h.invoke('ask', askValue(h, r, text))
    assert.ok(result.toast)
    assert.equal(result.patch, undefined)
  }
  assert.equal(h.state.jobs.size, 0)
})

test('native Unicode limit counts scalars while respecting the host and wire budgets', async (t) => {
  const h = nativeHost(t); h.main(); const r = h.pending()
  const effects = await h.invoke('ask', askValue(h, r, '🙂'.repeat(600)))
  assert.equal(Object.entries(effects[0].patch).find(([k]) => /^q[a-f0-9]{32}$/.test(k))[1].question, '')
  assert.equal(r.threads.executor[0].question, '🙂'.repeat(600))
  await turn()
})

test('native reviewer-off hides reviewer inputs and stored reviewer answers', (t) => {
  const h = nativeHost(t, { reviewerMode: 'off' }); h.main(); const r = h.pending()
  r.threads.reviewer.push({ id: 'review-secret', at: 1, answer: 'hidden', question: 'hidden', status: 'done' })
  const view = h.panel.view(scoped(r.callId), caps)
  const form = view.children.find((c) => c.type === 'form')
  assert.ok(form.children.every((node) => node.type !== 'select'))
  assert.ok(!JSON.stringify(view).includes('"id":"review"'))
  let data
  h.live.data({ sessionId: 'A' }, (d) => { data = d }, {})()
  assert.equal(data.answers.length, 0)
})

test('native subscriptions emit only changes and release timers on close and unload', () => {
  const saved = { set: globalThis.setInterval, clear: globalThis.clearInterval }
  const timers = new Map(), feeds = [[], []]
  let panel, removals = 0, released = 0
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 500); const id = { unref() {} }; timers.set(id, fn); return id }
  globalThis.clearInterval = (id) => timers.delete(id)
  try {
    const ctx = { inject(_deps, fn) { fn({ dshGo: { panel(id, p) { if (id === 'consult-live') panel = p; return () => removals++ } } }); return () => released++ } }
    const dispose = registerDshGo(ctx, { maxQuestionChars: 2000, records: () => [] })
    const first = panel.data({ sessionId: 'A' }, (d) => feeds[0].push(d), {})
    panel.data({ sessionId: 'A' }, (d) => feeds[1].push(d), {})
    for (const tick of timers.values()) tick()
    assert.deepEqual(feeds.map((f) => f.length), [1, 1])
    first(); assert.equal(timers.size, 1)
    dispose(); assert.equal(timers.size, 0)
    assert.equal(removals, 2); assert.equal(released, 1)
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
