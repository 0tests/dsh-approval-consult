# 审批咨询台 · 客户端契约（CLIENT-CONTRACT）

本文件是 `lib/client.js` 的唯一事实来源。宿主实现 `lib/impl.js` 必须与第 2 节的 HTTP 契约一致；
UI 负责第 3 节的状态机与第 4 节的视觉/交互。改动接口时同步改 `lib/impl.js` 与本文件。

---

## 1. 运行环境与硬约束

- 纯 JS，无构建、无 JSX、无 npm 依赖。入口固定为：

  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-approval-consult',
    factory(require) {
      const React = require('react')
      // ...
      return { inject: ['slots', 'locale'], apply(ctx) { /* ... */ } }
    },
  })
  ```

- 只用 `React.createElement`（可自写 `h`/`el` 小工具）。
- 客户端只能通过 **同源 fetch** 访问宿主（`/dsh-approval-consult/*`），已由宿主做 connection 鉴权；
  一律 `credentials: 'same-origin'`、`cache: 'no-store'`。
- 样式：注入 `<style data-plugin="dsh-approval-consult">`（`ctx.effect` 清理），只用
  `--dsw-alias-*` / `--dsw-specific-*` / `--dsh-*` 主题 token；允许少量自绘颜色只用于风险徽标。
- **不要**：替换官方审批卡片、读其他插件 DOM、全局拦截键盘、`document.body` 直接挂应用、
  引用 `@deepseek-ai/dsh-client-ui-*` 包。
- 组件必须容错：任何可能抛错的渲染路径都要兜底（slot 条目崩溃会让整块 UI 空白）。所有 fetch 都
  try/catch 并把错误展示在面板内。
- 注册两个 slot：
  - `conversation.input.dock`（list 型）：`id: 'approval-consult-entry'`，输入区上方的咨询提示条。
  - `shell.overlay`（list 型）：`id: 'approval-consult-panel'`，全屏浮层里的抽屉/底部弹层。
- 待审批检测：`props.useSessionStatus((map) => map.get(sessionId))?.pendingInteraction`，
  当 `pendingInteraction.kind === 'approval'` 时视为审批等待期。该对象即 `PendingApproval`：
  `{ sessionId, kind, key, toolName, callId?, reason?, displayReason?, result, answerable, answer(outcome), delegate() }`。
  `answer('allowed-once' | 'rejected')` 就是官方审批按钮的同一动作，可用于面板内的“允许一次/拒绝”。

## 2. 宿主 HTTP 契约（全部返回 JSON，`ok:false` 时带 `code`/`error`）

前缀 `const API = '/dsh-approval-consult'`。

### GET `/context?sessionId=&callId=&toolName=&consultKey=`

```jsonc
{
  "ok": true,
  "serverTime": 1763,
  "consultKey": "ac:7",
  "pending": {
    "consultKey": "ac:7", "toolName": "pwsh", "callId": "call_x|null",
    "reason": "Auto review denied tool \"pwsh\": ...|null",
    "displayReason": { "en": "...", "zh": "..." } | null,
    "startedAt": 1763, "resolved": false, "resolvedAt": null,
    "outcome": null,          // 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null
    "error": null             // 审批失败/超时的原始错误文本（只读展示）
  } | null,                    // null = 当前没有可咨询的待审批
  "executor": {
    "available": true, "provider": "opencode-go", "model": "deepseek-v4.1-flash",
    "messageCount": 42, "toolCount": 18, "capturedAt": 1763,
    "argumentsPreview": "{\n  \"command\": \"...\"\n}",   // 待执行参数（截断）
    "toolDescription": "..." , "assistantNote": "上一步 assistant 文本（截断）"
  },
  "reviewer": {
    // 情况 1：捕获到官方审查请求
    "available": true, "advisory": false, "classified": true, "failed": false,
    "provider": "...", "model": "...", "capturedAt": 1763,
    "risk": "low|medium|high|null", "decision": "allow|deny|null", "reason": "中文拒绝理由|null",
    "decisionText": "{\"risk\":\"medium\",\"decision\":\"deny\"}", "finishKind": "stop",
    "usage": {...} | null,
    "action": { "mode": "native|ptc-inner", "name": "pwsh", "description": "...", "parameters": {...} } | null,
    "historyCount": 12
  },
  // 情况 2：没有捕获到官方审查，但可以 advisory 重新评估
  "reviewer": {
    "available": true, "advisory": true, "needsClassification": true,
    "action": { "mode": "native", "name": "pwsh", "description": "...", "parameters": {...} },
    "historyCount": 11,
    "hint": "没有捕获到官方审查请求，但有足够的材料让审查 AI 重新评估这次调用。"
  },
  // 情况 3：完全不可用
  // { "available": false, "reason": "no-review-captured|review-not-matched", "hint": "..." }
  "threads": {
    "executor": [ { "id": "q:3", "question": "...", "answer": "...", "status": "streaming|done|error|cancelled",
                    "at": 1763, "usage": {...}|null, "error": null, "injectedAt": null,
                    "relayedAt": null, "injectError": null, "truncated": false } ],
    "reviewer": [ ... ]
  },
  "presets": { "executor": ["..."], "reviewer": ["..."] },
  "limits": { "maxQuestionChars": 2000, "maxConcurrentJobs": 3 },
  "features": { "ask": true, "followUp": true, "relay": true, "decision": true, "compare": true,
                "timeoutAutoPause": "on-send|on-open|off",
                "reviewerAvailable": true,
                "timeoutAvailable": true }
}
```

**能力开关（2026-10-31 新增，缺插件适配）**：

- `reviewerAvailable`：宿主检测官方自动审查插件是否安装/启用（`reviewerMode: auto`）。为 `false` 时：
  客户端**隐藏审查 AI tab、双问、审查侧文案与重新评估入口**，只保留执行 AI；宿主 `/ask`(reviewer)、
  `/review` 返回 `409 reviewer-unavailable`；`reviewer` 字段为 `null`，`compare:false`。
- `timeoutAvailable`：宿主检测 `dsh-approval-timeout` 是否安装/启用。为 `false` 时客户端**一次都不请求**
  `/dsh-approval-timeout/*`，不渲染倒计时 chip、提示条、暂停按钮，也不显示任何“未安装”文案；
  首次倒计时探测**必须等 `/context` 返回后**再做，避免先打一次 404。
- 两个字段缺省视为 `true`（兼容旧宿主）。

### GET/POST `/presets`（常用问题读写）

- `GET` → `{ ok, executor:[...], reviewer:[...], defaults:{...}, config:{...}, source:"user|config|builtin",
  reviewerAvailable, limits:{ maxCount:10, maxChars:300 } }`
- `POST` body `{ executor?: string[], reviewer?: string[] }` → 保存后返回同 GET 结构。
  校验：每侧最多 10 条、单条 1–300 字、去重、空字符串忽略；错误码 `bad-presets` / `preset-too-long` /
  `too-many-presets` / `presets-write-failed`。
- `POST /presets/reset` → 删除用户文件并返回同 GET 结构。
- 优先级：`data/presets.json`（用户编辑） > `config.presets` > 内置默认；`/context.presets` 返回生效值。
- 客户端编辑入口：面板「常见问题 → 编辑」→ `mode:'presets'` 编辑器（新增/删除/↑↓排序/修改/恢复默认两段确认/
  取消）；保存成功后 `emit({mode:'pending', presets:{...}})` 并立即刷新 chips。

### POST `/review`（advisory 重新评估；仅当 `reviewer.needsClassification === true` 时使用）

请求 `{ sessionId, consultKey?, callId?, toolName? }`

```jsonc
{ "ok": true, "advisory": true, "reused": false,
  "risk": "medium", "decision": "allow", "reason": null,
  "decisionText": "{\"risk\":\"medium\",\"decision\":\"allow\"}",
  "usage": { "inputTokens": 5080, "outputTokens": 542, "totalTokens": 5622 },
  "error": null }
```

- 已捕获官方审查时该接口直接返回官方结论（`advisory:false, reused:true`）。
- 调用耗时约 6–10s；按钮需要 loading 态与失败重试。
- 成功后用返回的 risk/decision/reason 立即更新上下文卡片，然后开放提问。

### POST `/ask`

请求 `{ sessionId, callId?, toolName?, consultKey?, target: 'executor'|'reviewer', question }`
→ `{ ok: true, jobId: "j:9", threadId: "q:8", consultKey: "ac:7", target: "executor" }`

错误码：`no-pending`、`approval-resolved`、`executor-context-missing`、`reviewer-context-missing`、
`review-not-initialized`（先调用 `/review`）、`empty-question`、`question-too-long`、`too-many-jobs`。

### GET `/poll?jobId=&cursor=`

```jsonc
{ "ok": true, "jobId": "j:9", "status": "streaming|done|error|cancelled",
  "delta": "新增文本", "cursor": 1234, "question": "...", "usage": {...}|null,
  "error": null, "createdAt": 1763, "finishedAt": null }
```

轮询节奏建议 100–160ms；`status !== 'streaming'` 后停止。宿主把完整文本按 `cursor` 切片返回，
客户端把 `delta` 追加到对应线程条目。`usage` 可能有 `cacheReadTokens/inputTokens/outputTokens`。

### POST `/cancel` `{ jobId }` → `{ ok: true, status }`

### POST `/relay`

```jsonc
{ "sessionId": "...", "consultKey": "ac:7", "threadId": "q:8",
  "kind": "reviewer|decision|note", "text": "要写进会话的内容" }
```
→ `{ ok: true, injected: true, kind }`。作用：把审查 AI 的回答/用户的决定说明注入执行 AI 的上下文
（会以“上下文注入”行出现在 Chat，并进入模型下一轮请求）。
**仅当审批仍在等待时可用**；已结束（resolved）返回 `{ ok:false, code:"approval-resolved" }`。

### GET `/diag` 诊断（计数、版本、shim 状态；不包含对话内容）

### GET `/history?sessionId=&limit=8`

该会话的审批咨询历史（含已结束），按时间倒序；没有咨询过的 pending 不返回。

```jsonc
{ "ok": true, "sessionId": "...", "total": 2,
  "items": [{
    "consultKey": "ac:7", "toolName": "pwsh", "callId": "call_x|null",
    "startedAt": 1763, "resolved": true, "resolvedAt": 1764, "outcome": "allowed-once",
    "reviewSource": "captured|advisory|none",
    "risk": "medium", "decision": "allow", "reason": null,
    "threads": { "executor": [...], "reviewer": [...] },
    "relays": 0,
    "counts": { "executor": 1, "reviewer": 2 }
  }] }
```

### 历史上入口：`conversation.chat.turnTail` 槽（新增注册）

- 新增一个 list 注册：`id: 'approval-consult-history'`，`order: 40`。
- 组件拿到 `props.sessionId` 与 ownerProps `turn`；挂载时调用一次 `/history`（按 sessionId 缓存 30s，避免每个 Turn 都请求），
  没有记录返回 `null`；有记录时渲染一个小 chip：`💬 审批咨询记录 · N`。
- 点击：`store.open = true; store.mode = 'history'; store.historyItems = items`，复用同一个抽屉/底部弹层，
  以只读模式列出每次审批：工具名、时间、审批结果、风险/结论、两侧问答线程（按时间顺序，不再显示提问框与决策按钮）。
- 该入口是"选择完就忘"痛点的可见补充：注入到会话的 context 消息官方 Chat 默认隐藏（`isVisibleChatNode`
  只显示含 tool-change 的 context），因此历史面板是从用户视角回看的唯一入口。


### 自动拒绝倒计时（可选集成，失败静默）

宿主未提供该能力；客户端直接探测另一个插件 `dsh-approval-timeout` 的同源路由：

- `GET /dsh-approval-timeout/status` → `{ ok, timeoutMs, pending: [{ toolName, callId, cancelled, elapsedMs }] }`
- `POST /dsh-approval-timeout/cancel` → 取消当前所有倒计时（一次性，无恢复）

要求：
- 探测失败（404/非 JSON/网络错）就完全隐藏倒计时 UI，不能报错。
- 倒计时存在且未取消时，显示小 chip “自动拒绝倒计时 {N}s”；剩余 ≤15s 变危险色。
- **暂停策略由宿主配置 `features.timeoutAutoPause` 决定**（默认 `on-send`）：
  - `on-send`：打开面板不打扰倒计时；用户**第一次发送问题**时自动暂停一次并提示；
  - `on-open`：打开面板即自动暂停；
  - `off`：完全不自动暂停，只保留 chip 的手动暂停。
- **全局副作用防护**：该插件 `/cancel` 会取消所有待审批项的倒计时。自动暂停前必须重新探测 `/status`，
  若存在其它未取消的待审批项（非当前 callId/toolName）则不自动暂停，改为 toast 提示用户；
  只有用户**显式点击** chip 时才（force）执行全局取消，且 chip 的 tooltip 必须说明会同时取消其它项。
- 该插件取消后不可恢复，属于已知限制。

## 3. 客户端状态机（模块级 store + useSyncExternalStore）

```js
const store = {
  open: false,          // 面板是否打开
  demo: false,          // 演示模式（见第 6 节）
  sessionId: null, toolName: null, callId: null, consultKey: null,
  tab: 'executor',      // 'executor' | 'reviewer'
  compare: false,       // 双问开关
  draft: '',
  context: null, contextError: null, loadingContext: false,
  pending: null,        // /context 的 pending
  resolved: false, outcome: null,
  threads: { executor: [], reviewer: [] },
  presets: { executor: [], reviewer: [] },
  timeout: null,        // { timeoutMs, elapsedMs, cancelled }
  timeoutPaused: false,
  decided: false, notice: null,
}
```

行为要求：
1. dock 条目只在 `pendingInteraction.kind === 'approval'` 时渲染；点击两个按钮分别以对应 tab 打开面板。
   面板打开时拉取 `/context`，之后每 5s 刷新一次（审批结束、线程变化由宿主侧维护）。
2. 发送问题：先乐观插入 `{ id: 'local:...', question, answer:'', status:'streaming' }`，再 `/ask`，
   用返回的 `threadId/jobId` 替换本地 id，然后轮询 `/poll` 追加 `delta`；结束后以宿主返回的 `status/usage` 为准。
3. 终止：`stop` 调 `/cancel`；审批结束时宿主会自行中止并返回 `cancelled`。
4. 双问（compare）：开启后发送一次问题会同时向 executor 与 reviewer 各发一次（两条独立任务），
   当前 tab 显示自己的回答，并在顶部/尾部提示另一侧也已回答并提供跳转。
5. 追问：同一 tab 内多次提问即形成线程；每次都把完整线程传给宿主（宿主决定上下文复用）。
   UI 不要求滚动定位，按时间顺序追加即可。
6. 转达：审查 tab 的每条完成回答提供“转达给执行 AI”按钮 → `/relay { kind:'reviewer', threadId }`，
   成功后该条显示“已转达”。**仅在审批等待期间渲染**；`ended`（resolved/decided）后隐藏按钮，
   点击逻辑也要防御（toast `relayEnded`）；宿主对已结束审批返回 409 `approval-resolved`。
7. 执行 tab 的回答完成后宿主已自动注入会话（`injectedAt` 非空）→ 显示“已保存到会话”。
   不要对执行 tab 再显示“转达”（避免重复）。
   回答因输出预算被截断（`turn.truncated === true`，宿主 finish reason = length）时**仍会注入**，
   但注入文本带“被截断”说明，面板显示“回答被截断”标签；用户停止或审批结束导致流被取消
   （`status === 'cancelled'`）的回答**不会注入**。
8. 决策：面板底部提供“拒绝 / 允许一次”，直接调用 `pending.answer(...)`（与官方审批卡片同一动作）。
   成功后显示“已提交决定”；审批结束（pending 消失）时显示结束态与 outcome 文案，保留全部问答。
   官方审批卡片仍在页面上，两边都可点，竞态由 PendingApproval 自身一次性语义处理（调用方 catch）。
9. 审批结束后面板**不自动关闭**：顶部显示结束 banner，用户可继续阅读，手动关闭。
10. 错误处理：context 失败显示可重试的错误块；单条回答失败显示错误行 + 重试按钮（重试用同问题再发一次）。
11. 状态提示：`notice` 作为 2.5s 自动消失的轻提示（转达成功、暂停倒计时、决策失败等）。
12. 多设备：线程以宿主为准，因此页面刷新后重新打开仍能看到同一审批的问答（`/context.threads`）。
13. 审查结论来源：`reviewer.synthetic === true` 表示结论来自审批卡片上的 auto-review 理由
    （审查请求没捕获到时）；UI 显示“取自审批理由”badge 与 deny/failed + 理由，`risk` 可能为 null。
    `/history` 的 `reviewSource` 对应值为 `approval-reason`。
13. advisory 审查：`reviewer.needsClassification === true` 时，审查 tab 显示「让审查 AI 重新评估」按钮
    （loading 文案「正在评估…」），调用 `POST /review`，成功后用返回的 risk/decision/reason 更新上下文卡片并开放提问；
    失败保留按钮可重试。遇到 409 `review-not-initialized` 时回到同一提示卡，不要变成死路。
14. `/ask` 返回 409 `no-pending` / `approval-resolved` 时：面板切到“审批已结束”状态并刷新 context，不保留悬空输入。

## 4. 视觉与交互要求（PC + 手机）

- 桌面（>700px）：右侧抽屉，宽 440–480px，全高，左侧 1px 边框 + 阴影；背景遮罩 10% 黑，点击关闭。
- 手机（<=700px）：底部弹层（88vh），顶部圆角，遮罩 32% 黑；底部按钮区留 `env(safe-area-inset-bottom)`；
  输入框 `font-size` ≥16px 防止 iOS 缩放；Enter 换行、显式发送按钮。
- 头部：标题 + 当前状态（等待审批 / 已结束）+ 工具名；右侧倒计时 chip（可选）、关闭按钮。
- tab：执行 AI / 审查 AI / 双问开关；审查不可用时 tab 上有 ! 标记并给出原因。
- 上下文卡片：风险徽标（低/中/高）、结论（允许/拒绝）、证据条数、审查理由（最多 3 行，可展开）、
  “工具参数”折叠区（等宽字体 `<pre>`）。
- 线程：问题右对齐气泡；回答左侧卡片式，流式时显示光标/省略号；元信息行显示缓存/输入/输出 token、
  “已保存到会话”/“已转达”。
- 预设问题：chips 横向换行，最多两行高度可滚动；点击立即发送。
- 输入区：自适应高度 2–4 行；发送按钮 disabled 条件=空；流式时显示“停止”。
- 动效：面板滑入 180–220ms、ease-out；减少动态偏好时不做位移。所有可点元素有 hover/active/focus-visible。
- 键盘：Esc 关闭面板（只在面板内且焦点不在输入框时）；Enter 发送（桌面）；Shift+Enter 换行。
  **不要**注册全局快捷键（会与官方审批卡片的 Enter=允许/Esc=拒绝冲突）。
- 无障碍：`role="dialog" aria-label`、tablist/tab/aria-selected、按钮 aria-disabled、焦点管理（打开时聚焦输入框，
  关闭时聚焦回触发按钮）、遮罩不吞键盘事件。
- 主题：亮/暗色都要正常（只用 token，风险徽标给亮暗两套低饱和背景）。

## 5. 文案

中文为主，英文必须有同 key 集合（`ZH`/`EN` 两个字典，`ctx.locale.register(NS, 'zh', ZH)` /
`ctx.locale.register(NS, 'en', EN)`）。面板内所有可见文本走字典；已存在的 key 可复用/扩充，
不要硬编码中文字符串到组件里（demo 文案除外）。

## 6. 演示模式（无审批时调 UI，必须保留）

- 触发：`localStorage.setItem('dsh-approval-consult.demo','1')` 或 URL 加 `?consult-demo=1`。
- 行为：dock 始终可见；打开面板使用内置 mock context（风险 medium/deny、参数示例、预设问题）；
  `/ask` 用本地伪造流式回答（40–60ms 一个 chunk）；决策/转达按钮走本地模拟并标记状态。
- demo 模式不得向真实宿主发 `/ask`、`/relay`、`/cancel`、`/context`（`/context` 可跳过）。
- 关闭：`localStorage.removeItem('dsh-approval-consult.demo')` 并刷新。

## 7. 验收清单（ui-dev 自测）

1. 无插件宿主错误：Console 无 `slot entry crashed`、无未捕获异常。
2. demo 模式：dock 出现 → 打开面板 → 预设问题流式回答 → 转达/决策状态变化 → Esc 关闭。
3. 真实审批：dock 出现 → 问审查 AI → 回答流式且显示缓存命中 → 问执行 AI → 显示已保存 →
   决策按钮与官方卡片都能工作 → 结束后 banner 正常。
4. 390×844 与 1440×900 两个视口截图，无横向滚动、无文字溢出、按钮可点。
5. 亮色/暗色主题各截一张。
