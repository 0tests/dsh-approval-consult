import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
export function client(names, overrides = {}) {
  const emitted = [], scheduled = [], requests = []
  const state = {
    store: { open: true, mode: 'pending', demo: null, connection: 'online', sessionId: 'A', consultKey: 'ac:A', callId: '1', draft: 'why?', limits: {},
      threads: { executor: [], reviewer: [] }, context: null, attachments: [], tab: 'executor' },
    runtime: { disposed: false }, pollGeneration: 0, contextRequest: 0, activePolls: new Map(),
    API: '/dsh-approval-consult', POLL_INTERVAL_MS: 120,
    AbortController, window: { navigator: { onLine: true } }, document: { visibilityState: 'visible' }, canReadTransport: () => true, clearReconnect() {}, transientError: () => false,
    emit(patch) { emitted.push(patch); Object.assign(state.store, patch) },
    after(ms, fn) { const task = () => task.cancelled ? undefined : fn(); task.ms = ms; scheduled.push(task); return () => { task.cancelled = true } },
    requestJson(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) },
    contextQuery: () => '/context', applyContext: (payload) => { state.store.context = payload },
    describeError: (error) => ({ code: error.code, detail: error.message }),
    readyAttachmentMeta: () => [], nextLocalId: () => 'local:1', invalidateHistory() {}, panelApproval: () => null,
    toast() {}, clearAttachments() { state.store.attachments = [] },
    demoStopTimers: new Map(),
    ...overrides,
  }
  const ctx = vm.createContext(state)
  for (const name of new Set(['isCurrentPanel', 'cancelRequestedJob', ...names])) {
    const start = source.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'))
    assert.ok(start >= 0, `missing ${name}`)
    const end = source.indexOf('\n    }', start) + 6
    vm.runInContext(source.slice(start, end), ctx)
  }
  return { ctx, state, emitted, scheduled, requests }
}
