import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { host } from './helpers/host.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function upload(h, key) {
  // The helper serializes the body as JSON; the fake storage accepts those four bytes.
  return h.request('/attachment?sessionId=A&mediaType=image/png&consultKey=' + encodeURIComponent(key), 'ok')
}

test('token-limited executor answers are marked as partial in the panel and injected context', async (t) => {
  const h = host(t)
  h.main()
  const record = h.pending()
  for (const kind of ['max-tokens', 'length', 'stop']) {
    h.ctx.llm.stream = async function* () {
      yield { type: 'text-delta', index: 0, text: 'explanation' }
      yield { type: 'finish', reason: { kind } }
    }
    const ask = await h.request('/ask', { sessionId: 'A', consultKey: record.key, question: 'What happens?' })
    assert.equal(ask.status, 200)
    await new Promise((resolve) => setImmediate(resolve))
    const context = await h.request('/context?sessionId=A&consultKey=' + encodeURIComponent(record.key))
    assert.equal(context.body.threads.executor.at(-1).truncated, kind !== 'stop')
    assert.equal(h.injections.at(-1).content[0].text.includes('截断'), kind !== 'stop')
  }
})

test('concurrent image saves charge their own bytes and roll back only a failed save', async (t) => {
  const started = deferred(), release = deferred()
  let saves = 0
  const h = host(t, {}, { services: { attachments: { async saveImage({ data }) {
    const index = ++saves
    if (index === 3) started.resolve()
    await release.promise
    if (index === 2) throw new Error('storage unavailable')
    return { bytes: data.length + 1 }
  } } } })
  const { key } = h.pending()
  const jobs = [upload(h, key), upload(h, key), upload(h, key)]
  await started.promise
  assert.equal(h.state.uploadTotals.get(key), 12)
  release.resolve()
  const responses = await Promise.all(jobs)
  assert.deepEqual(responses.map((r) => r.status), [200, 500, 200])
  assert.equal(h.state.uploadTotals.get(key), 10)
})

test('a normalized image that crosses the budget remains charged after registration is refused', async (t) => {
  let saves = 0
  const h = host(t, {}, { services: { attachments: { async saveImage() {
    saves++
    return { bytes: 8 }
  } } } })
  const { key } = h.pending()
  const limit = 24 * 1024 * 1024
  h.state.uploadTotals.set(key, limit - 4)
  assert.equal((await upload(h, key)).body.code, 'attachment-budget-exceeded')
  assert.equal(h.state.uploadTotals.get(key), limit + 4)
  assert.equal(h.state.attachments.size, 0)
  assert.equal((await upload(h, key)).body.code, 'attachment-budget-exceeded')
  assert.equal(saves, 1)
})

test('storage is charged even if an approval ends while an image is being saved', async (t) => {
  const started = deferred(), release = deferred()
  const h = host(t, {}, { services: { attachments: { async saveImage({ data }) {
    started.resolve()
    await release.promise
    return { bytes: data.length }
  } } } })
  const { key, callId } = h.pending()
  const response = upload(h, key)
  await started.promise
  h.append('approval/decided', { id: callId, outcome: 'rejected' })
  release.resolve()
  assert.equal((await response).body.code, 'approval-resolved')
  assert.equal(h.state.uploadTotals.get(key), 4)
  assert.equal(h.state.attachments.size, 0)
})

test('dropping an attachment while its model capabilities are resolving cancels that ask', async (t) => {
  const h = host(t, {}, { services: { attachments: { saveImage: async () => ({ bytes: 4 }) } } })
  h.main()
  const { key } = h.pending()
  const id = (await upload(h, key)).body.attachment.id
  const started = deferred(), release = deferred()
  h.ctx.llm.resolveModelInfo = async () => { started.resolve(); return release.promise }
  const ask = h.request('/ask', { sessionId: 'A', consultKey: key, question: 'Describe this image', attachmentIds: [id] })
  await started.promise
  const drop = await h.request('/attachment/drop', { sessionId: 'A', consultKey: key, ids: [id] })
  assert.equal(drop.body.dropped, 1)
  release.resolve({ inputModalities: ['image'] })
  assert.equal((await ask).body.code, 'attachment-unknown')
  assert.equal(h.state.stats.asks, 0)
})

test('a failed capability lookup is retried and keeps raw errors out of default diagnostics', async (t) => {
  const h = host(t, {}, { services: { attachments: {} } })
  h.main()
  const { key } = h.pending()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let calls = 0
  h.ctx.llm.resolveModelInfo = async () => {
    if (++calls === 1) throw new Error('private provider detail')
    return { inputModalities: ['image'] }
  }
  const getCap = async () => (await h.request('/context?sessionId=A&consultKey=' + encodeURIComponent(key))).body.features.attachments.executor
  assert.equal(await getCap(), false)
  assert.deepEqual((await h.request('/diag')).body.lastError, { type: 'image-capability', at: now })
  assert.equal(await getCap(), false)
  assert.equal(calls, 1)
  now += 1001
  assert.equal(await getCap(), true)
  assert.equal(await getCap(), true)
  assert.equal(calls, 2)
})

test('detailed diagnostics include safe error metadata without the provider message or stack', async (t) => {
  const h = host(t, { devTools: true }, { services: { attachments: {} } })
  h.main()
  const { key } = h.pending()
  h.ctx.llm.resolveModelInfo = async () => {
    throw Object.assign(new TypeError('private request detail'), { code: 'ETIMEDOUT', status: 503 })
  }
  await h.request('/context?sessionId=A&consultKey=' + encodeURIComponent(key))
  const { body } = await h.request('/diag')
  assert.equal(typeof body.lastError.at, 'number')
  assert.equal(body.lastError.type, 'image-capability')
  assert.equal(body.lastError.name, 'TypeError')
  assert.equal(body.lastError.status, 503)
  assert.equal(body.lastError.code, 'ETIMEDOUT')
  assert.doesNotMatch(JSON.stringify(body), /private request detail/)
})

test('adapter changes prevent an older capability query from replacing newer results', async (t) => {
  const h = host(t, {}, { services: { attachments: {} } })
  h.main()
  const { key } = h.pending()
  const started = deferred(), release = deferred()
  let calls = 0
  h.ctx.llm.resolveModelInfo = async () => {
    if (++calls === 1) { started.resolve(); return release.promise }
    return { inputModalities: [] }
  }
  const getCap = async () => (await h.request('/context?sessionId=A&consultKey=' + encodeURIComponent(key))).body.features.attachments.executor
  const first = getCap()
  await started.promise
  h.hooks.get('llm/adapters-updated').fn()
  assert.equal(await getCap(), false)
  release.resolve({ inputModalities: ['image'] })
  assert.equal(await first, false)
  assert.equal(await getCap(), false)
  assert.equal(calls, 2)
})

test('history with no limit returns the eight latest consulted approvals', async (t) => {
  const h = host(t)
  h.main()
  for (let i = 0; i < 9; i++) {
    const record = h.pending('call-' + i)
    await h.request('/ask', { sessionId: 'A', consultKey: record.key, question: 'Why?' })
  }
  const { body } = await h.request('/history?sessionId=A')
  assert.equal(body.items.length, 8)
  assert.equal(body.items[0].callId, 'call-8')
  assert.equal(body.items.at(-1).callId, 'call-1')
})

test('a failed preset reset keeps the same effective and persisted presets', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'consult-presets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const h = host(t, { dataDir: dir })
  const presets = { executor: ['custom question'] }
  assert.equal((await h.request('/presets', presets)).status, 200)
  const file = join(dir, 'presets.json')
  const original = fs.readFileSync(file, 'utf8')
  const failure = t.mock.method(fs, 'unlinkSync', (path) => {
    // The package's legacy fallback must never be removed by this test.
    if (path === file) throw Object.assign(new Error('read only'), { code: 'EACCES' })
  })
  syncBuiltinESMExports()
  try {
    const result = await h.request('/presets/reset', {})
    assert.equal(result.status, 500)
    assert.equal(result.body.code, 'presets-reset-failed')
    assert.deepEqual((await h.request('/presets')).body.executor, presets.executor)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
  } finally {
    failure.mock.restore()
    syncBuiltinESMExports()
  }
})
