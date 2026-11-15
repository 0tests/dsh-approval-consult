// Emit the real card-scoped native view/data for the companion Flutter tests.
// Usage: node tests/export-go-panel.mjs /path/to/approval_consult_panel.json
import { writeFileSync } from 'node:fs'
import { registerDshGo } from '../lib/dsh-go.js'

let panel, data
const caps = { locale: 'zh-CN', components: ['form', 'textField', 'select'] }
const scope = { sessionId: 'approval-session', callId: 'inner-call' }
const dispose = registerDshGo({ inject(_names, fn) { fn({ dshGo: { panel(_id, value) { panel = value } } }) } }, {
  maxQuestionChars: 2000,
  records: () => [{ consultKey: 'consult-current', callId: scope.callId, toolName: 'bash',
    reason: '检查当前操作的影响', resolved: false, executor: { argumentsPreview: 'echo test' },
    threads: { executor: [], reviewer: [] } }],
})
panel.data(scope, (value) => { data = value }, caps)()
const fixture = { pkg: 'dsh-approval-consult', id: 'consult', title: '咨询',
  view: panel.view(scope, caps), data, rev: 'r1', live: true }
writeFileSync(process.argv[2], JSON.stringify(fixture, null, 2) + '\n')
dispose()
