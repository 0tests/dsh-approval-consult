# 验收记录（真实环境，持续更新）

> 目的：区分「代码看起来对」与「在真实 DSH 进程里跑通」。本文件只记录实际执行过的验证、
> 证据与未覆盖项；不编造评分。最终验收以本文件末尾的最新一轮为准。

## 环境

| 项 | 值 |
| --- | --- |
| DSH 实现 | 进程内安装版 `<dsh-install>`，`@deepseek-ai/dsh-*` 0.2.1-rc.2 |
| Profile | `web`（`<DSH_HOME>\profiles\web`） |
| Host | Windows 10 工作站，`pwsh` 工具 |
| 模型路由 | `opencode-go` / `deepseek-v4.1-flash`（支持 reasoning，deepseek 系缓存） |
| 审批策略 | 会话级 `ask`；Auto 权限预设下由 auto-review 审查 |
| 浏览器 | Playwright MCP（共享实例），GUI `http://127.0.0.1:3456` |

## 已完成的验证

### V1. 安装与激活

- 通过 GUI「插件 → 添加插件 → 安装第三方插件」以本地目录 `<plugin-dir>` 安装并点「立即启用」。
- 证据：`GET /dsh-approval-consult/diag` 返回 `ok:true`、`shim.generation>=1`、`shim.lastError:null`；
  `routes registered under /dsh-approval-consult`；client 侧注入 1 个
  `<style data-plugin="dsh-approval-consult">`，`shell.overlay` 出现 id `approval-consult-panel` 的 occupant。
- 结论：**通过**（浏览器端 HMR 在已打开页面上加载了新 client 模块，无需重启）。

### V2. 宿主捕获（真实请求）

- 真实主对话请求被捕获：`/debug/inspect` 显示 `main: { provider: "opencode-go", model: "deepseek-v4.1-flash",
  messageCount: 376+, toolCount: 111 }`；`/diag.llmSeen` 记录到同 session 的 `kind:"main"`。
- 真实 auto-review 审查请求被捕获（另一并发会话）：`kind:"review"`、`systemHead:"REVIEW_POLICY\nYou are the final authoriz"`、
  `messages:1`，并解析出 `PENDING_ACTION.action.name = "mcp__playwright-mcp__browser_evaluate"`、`risk:"low", decision:"allow"`。
- 真实审批 pending 被记录：`/diag.pendings` 出现 `{consultKey:"ac:5", toolName:"pwsh"}`，
  `pending.displayReason.zh` 与官方审批卡片文案一致；60s 超时后 `pending.error` 保存了 approval-timeout 的原始错误文本。
- 结论：**通过**。唯一未解释现象：部分会话（Team Lead 自身会话）的 auto-review 审查请求没有出现在监听路径上，
  因此实现了 advisory 兜底（见 V4），产品行为不受阻。

### V3. 执行 AI 侧调用（真实 LLM + 缓存）

- 走 `/debug/selftest?target=executor`（与 `/ask` 同一 `buildExecutorOptions`）：
  `promptChars: 1,227,017`，`usage: { inputTokens: 472, outputTokens: 1200, totalTokens: 635656, cacheReadTokens: 633984 }`，
  `elapsedMs: 17285` —— **缓存命中 633,984 / 635,656（99.7%）**。
- 发现的问题：该会话主请求 reasoning 开销大，`maxTokens:1200` 全被思考消耗，正文为空。
  已修复：侧调用预算按 `max(executorMaxTokens, 3000)` / `max(reviewerMaxTokens, 1800)` 兜底；
  若仍无正文，返回明确错误并建议重试。
- 另一次真实 `/ask`（workspace-write 测试会话，18 条消息/108 工具）：
  `usage: { inputTokens: 757, outputTokens: 266, cacheReadTokens: 32256 }`，回答准确描述“只会新建/覆盖
  `<user-home>\ac-e2e-approval3.txt`、失败时文件不会按预期写入”。
- 结论：**通过**（含缓存命中与失败语义）。

### V4. 审查 AI 侧调用（官方捕获 + advisory 兜底，真实 LLM）

- **官方捕获路径**：对某并发会话捕获到的真实审查（`browser_evaluate`，risk low/allow）走
  `/debug/selftest?target=reviewer`，回答准确引用审查材料（“本地开发页只读遍历 React fiber 树…不涉及外部或敏感数据”），
  `usage: { inputTokens: 226, outputTokens: 164, cacheReadTokens: 68608, totalTokens: 68998 }` → **缓存命中 99.4%**，
  `elapsedMs: 6482`。
- **advisory 路径**（非 auto-review 的真实 sandbox 提权审批）：
  1. `/context` 返回 `reviewer.available:true, advisory:true, needsClassification:true, historyCount:11, action.name:"pwsh"`；
  2. `POST /review` → `{risk:"medium", decision:"allow", decisionText:"{\"risk\":\"medium\",\"decision\":\"allow\"}"}`；
     对“用户明确要求写指定绝对路径”这一情形给出 medium/allow，与官方策略语义一致；
  3. 追问 `最坏会有什么后果？` → 回答指出“目标文件若已存在会被覆盖且不可恢复；danger-full-access 下沙箱隔离失效”，
     `usage: { inputTokens: 208, outputTokens: 311, cacheReadTokens: 4992 }`（缓存命中 90.6%）。
- 结论：**通过**。

### V5. 执行 AI 问答留存进会话（核心需求）

- 真实 pending 下通过 `/ask` 向执行 AI 提问，回答完成后宿主 `agent.inject()`：
  `/diag.stats.injections` 递增，`/context.threads.executor[0].injectedAt` 非空，客户端显示「已保存到会话」。
- 真实全链路（不借助 debug 注入）：新增一个 sandbox 提权审批 → `/ask` 提问 → 60s 超时后自动拒绝/继续，
  会话事件流出现（`/debug/events`，session 7d46030c…）：

  ```
  approval/asked
  agent/inbox/spliced
  approval/decided          （60s 超时，错误文本被 pending.error 保留）
  tool/result
  step/end
  agent/inbox/spliced       （注入进入 next-step inbox）
  step/start
  user/message:approval-consult    ← 真正的问答记录，正文含工具参数+问题+回答
  assistant/message                ← 模型下一 step 的回应
  ```

  模型在后续回应中明确写道：“按规则我不换别的方式绕过，而是对同一条命令申请一次更高权限重试”，
  并分别报告原目标失败/工作区备用文件成功——说明**问答进入了模型可见历史且没有当成新指令**。
- 说明：官方 Chat 的 `isVisibleChatNode` 会隐藏普通 context 行（仅显示含 tool-change 的 context），
  所以聊天流里不会出现额外一行；用户侧通过面板线程与新增的「审批咨询记录」历史入口回看。
- 结论：**通过**（“不能说你问了、AI 回答了、选择完就忘了”这一痛点已解决）。

### V6. UI 链路（桌面，真实审批）

- 真实 sandbox 提权审批出现时，`shell.overlay` 悬浮胶囊可见：`? 审批有疑问？ pwsh ×`；
  点击后 `data-approval-consult-panel` 渲染，包含：状态、工具名、执行 AI / 审查 AI / 双问 tab、
  上下文卡片（审查原因、7 条消息 · 108 个工具、工具参数折叠）、预设问题 chips、输入区、
  「拒绝 / 允许一次」决策条；倒计时 chip 显示「自动拒绝 59s」。
- 点击预设问题 → 面板内流式回答，回答准确描述 sandbox 拦截与替代路径；元信息行显示
  「缓存 29k · 输入 348 · 输出 400 · 已保存到会话」。
- client HMR 重置后重新打开面板，线程从宿主 `/context` 恢复（`executor:1`）——跨页面生命周期持久化有效。
- 结论：**通过**（视觉打磨与移动端见下一轮，以 ui-dev 最终版为准）。

### V7. 自动拒绝倒计时集成（可选插件）与暂停策略（2026-10-31 修订）

- 面板会只读探测 `/dsh-approval-timeout/status`，显示剩余秒数 chip（剩余 ≤15s 变危险色）。
- 最初实现为「打开面板即自动暂停 / 首次提问自动暂停」，用户反馈“倒计时被默认取消了”，因此改为**可配置且默认保守**：
  - `timeoutAutoPause`：`on-send`（默认，仅真正开始提问时暂停）/ `on-open` / `off`；
  - 自动暂停前重新探测状态：若存在**其它**未取消的待审批项则拒绝自动暂停并 toast 提示
    （因为 `dsh-approval-timeout` 的 `/cancel` 是全局的，会一次取消所有待审批项的倒计时）；
  - 只有用户**显式点击**倒计时 chip 才执行全局取消（tooltip 已注明会同时取消其它项）。
- 复核：`/context.features.timeoutAutoPause = "on-send"`；`/diag.config.timeoutAutoPause = "on-send"`。
- 说明：该插件取消后不可恢复；此前测试期被取消的倒计时无法恢复（属于测试会话，可归档/决定后清理）。
- 结论：**按用户反馈调整并验证配置生效**；真实点击暂停路径待用户真机确认。

### V8. 单元测试

`node tests/unit.mjs`：20/20 通过（审查四段材料解析、PENDING_ACTION（native/PTC）、审查结论解析
（含容错）、canonical JSON、请求识别、预设规范化、边界值等）。

## 未覆盖 / 已知限制

1. **Team Lead 会话的 auto-review 请求捕获路径**未解释（其他会话可正常捕获）。已实现 advisory 兜底，
   且兜底流程经真实 LLM 验证；最终以用户实际会话行为为准。
2. **审批决策点击**（允许一次/拒绝）是用户专属动作，自动化测试没有代替用户点击；面板按钮复用
   `PendingApproval.answer()`（官方同一动作），已通过类型与调用路径核对，待用户真机点一次确认。
3. **移动端布局与暗色主题**的最终视觉验收以 ui-dev 完成后的截图为准（见 `approval-consult-shots/`）。
4. 线程存于宿主内存：DSH 重启后随审批消失（符合预期，已在 README 说明）。
5. `devWatch` 热重载会重置插件内存状态：开发期若在审批等待中修改 `impl.js`，pending 记录会丢失；
   生产使用可关掉 `devWatch`。

### V9. 一致性修复：「审批已结束」误报（用户真机发现，2026-10-31）

**现象**：用户手机上面板显示「审批已结束」，但官方审批卡片仍在等待（截图：会话「写入 ui 文件并报告结果」）。
**根因**：
1. 该测试会话的审批由宿主 approval 服务维护；开发期我反复热重载宿主实现（devWatch），每次重载清空插件内存里的 pending 记录；
2. `/context` 对「记录不存在」返回 `pending:null`，客户端把它当成「审批结束」并永久置 `resolved`；
3. 官方审批卡片不依赖本插件，所以仍然显示 —— 于是一边「等待审批」、一边「审批已结束」。

**修复（三层）**：
1. **状态跨热重载保留**：宿主状态放进 `globalThis.__DSH_APPROVAL_CONSULT_STATE_V1__`，devWatch 重载复用 pendings/线程/捕获缓存，只重建瞬态 job/监听器；
2. **从会话日志重建**：`/context` 找不到记录时，扫描 `approval/asked`（没有对应 `approval/decided` 即仍在等待），结合同 callId 的 `tool/call` 参数重建 pending 与 advisory 审查材料；重建记录自行检查 `approval/decided` 以判定真正的结束；
3. **客户端以 PendingApproval 为准**：只要客户端仍持有未失效的 `PendingApproval`，`/context` 的 `pending:null` 或 `resolved:true` 一律视为「上下文暂未同步」——显示「审批仍在等待，正在同步咨询上下文…（重试）」并每 1.5s 自动重试，**绝不**切换到结束态；`/ask` 返回 409 时同样先看客户端 pending 再决定是否结束。

**复核（2026-10-31 02:0x，真实宿主）**：
- `GET /context?sessionId=session-d22d97a3…`（热重载后的缺失记录）→ `consultKey: "re:62"`, `pending.toolName: "pwsh"`,
  `pending.resolved: false`，`reviewer.available: true, advisory: true`；
- `POST /review` → `{risk:"medium", decision:"allow"}`；
- `POST /ask`（reviewer）+ `/poll` → 正常流式回答，`cacheReadTokens 4096 / totalTokens 4474`；
- 语法检查与 20 项单测通过。
- 结论：**修复并用真实宿主验证**；客户端呈现需刷新页面加载新 `lib/client.js` 后确认（见用户回归步骤）。

## 最终一轮（client 定稿后）与环境限制

> 2026-10-31 下午补做了**真实浏览器 dogfooding**（Playwright 操作真实 GUI，壁纸主题 + 真实审批），
> 发现并修复 10 个真实问题（含壁纸主题下面板透明这一严重问题），详见 [`DOGFOOD.md`](DOGFOOD.md)；
> 修复后的新截图 `dogfood-05/06/08/10/12/13/14` 取代本文件下方早期截图作为最新视觉基线。

时间：2026-10-30 23:00–00:10（Asia/Shanghai）。client 定稿于 23:08（`lib/client.js`，node --check 通过）。

- **真实审批链路复验（宿主）**：新建 workspace-write 会话触发 sandbox 提权审批，`/diag` 正常记录 pending
  （`ac:97` 等），`/context` 返回 executor/reviewer、审批理由、`needsClassification`；`/history` 在审批结束后
  返回线程；注入在超时结束后按 step 边界落盘（见 V5）。
- **client 修复项（demo DOM 断言，ui-dev 执行）**：打开面板自动暂停倒计时、advisory CTA 只在审查 tab、
  结束态隐藏 CTA/决策/倒计时、`⚖`→`!`。截图 `ui-12/ui-13` 为修复前，`ui-07…ui-11` 为定稿前视觉基线。
- **未能在最终版 client 上重跑"真实审批 + 面板点击"**，原因（环境侧，非插件缺陷）：
  1. Playwright 通过浏览器扩展接管的是用户本机 Edge；期间本机网络/VPN 抖动，Edge 内所有
     `http://127.0.0.1:3456/api/*` 请求返回 `net::ERR_NETWORK_CHANGED`，Playwright 无法再导航/求值；
  2. 改用独立的 wincu agent 浏览器 + `dsh web` 打印的带 token URL 可以正常打开 GUI 和会话，但该客户端被宿主视为
     非 owner 的远端连接，审批应答链不可用（审批请求立刻 `unavailable`），因此不能作为审批 UI 的验收环境；
  3. 同一时段 auto-review 的 reviewer 调用多次 `TRANSPORT/TIMEOUT`，按 fail-closed 拒绝工具调用，
     限制了自动化操作。
- **已用真实数据验证过的 UI 能力（定稿前同一代码族的近似版本，功能路径一致）**：
  胶囊在真实审批时可见（`lead-pill-during-approval.png`）；面板打开、执行 AI 预设立式流式回答、
  缓存用量与「已保存到会话」标记（`lead-panel-executor-2.png` 的 DOM 文本记录）；结束态、
  只读历史面板与「💬 审批咨询记录」入口（`lead-history-panel.png`）。
- **结论**：宿主全链路与 UI 状态机已验收；最终版 client 的**真实审批点击回归**受本机网络限制未完成，
  列为交付遗留项（用户 30 秒即可完成，见下）。

### 用户侧 30 秒回归清单（最终版 client）

1. 新建会话（保持"工作区内修改"），让 Agent 往 `<user-home>\` 写一个文件 → 出现审批卡片；
2. 点右上角「审批有疑问？」→ 面板应打开；默认策略下倒计时**继续**（仅显示 chip），只有点 chip 才暂停
   （若你已把配置改成 `on-open`，则打开即暂停并 toast 提示）；
3. 切「审查 AI」→ 点「让审查 AI 重新评估」→ 几秒后出现 风险/结论/理由 → 提一个预设问题，看流式回答；
4. 切「执行 AI」→ 点预设问题 → 看流式回答与「已保存到会话」；面板里点「拒绝」或「允许一次」；
5. 关闭面板 → 对话流末尾应出现「💬 审批咨询记录 · N」→ 点开只读回看。
   任何一步异常时把 `GET /dsh-approval-consult/diag` 的结果发给维护者。

### V11. 审批结束后「转达给执行 AI」仍可点（用户真机发现，2026-10-31）

**现象**：审批已结束（已拒绝）的面板里，审查 AI 回答下方仍显示可点击的「转达给执行 AI」。
**修复**：
- 客户端：`ended`（resolved/decided）时不再渲染该按钮；`relayThread()` 增加防御性拦截（toast `relayEnded`）。
- 宿主：`/relay` 对已结束记录返回 `409 approval-resolved`（结束后的咨询只读，避免把“事后说明”当成授权通道）。
**复核（真实宿主）**：对已拒绝的历史会话 `session-4f06b2bf…` 调 `/relay` →
`{"ok":false,"code":"approval-resolved","error":"本次审批已经结束，转达按钮已关闭；结束后的咨询记录只支持回看。"}`；
`/diag.stats.injections` 未增加。语法检查 + 21 项单测通过。
**说明**：如果以后确实需要“拒绝后给执行 AI 留一句原因”，应作为独立的“决定附言”功能实现（目前不支持）。

### V12. 缺插件自适应 + 常用问题自定义（2026-10-31 晚，真实宿主 + 真实浏览器）

**能力检测（宿主）**：通过 `ctx.registry` 的插件 runtime `name` 检测，失败静默降级。
- 已装 auto-review：`/diag.config.reviewerAvailable = true`；用 devTools 覆盖 `reviewerMode:'off'` 后
  `/context` 返回 `reviewer:null, features:{compare:false, reviewerAvailable:false}`，`/ask`(reviewer) 与
  `/review` 均返回 `409 reviewer-unavailable`；客户端实测只剩「执行 AI」tab、无「双问」、无任何审查 AI 文案
  （截图 `adapt-01-executor-only.png`）。`reviewerMode` 恢复 `auto` 后恢复正常。
- 已装 approval-timeout：`timeoutAvailable=true`；devTools 覆盖 false 后：`/context.features.timeoutAvailable=false`，
  客户端**一次 `/dsh-approval-timeout/*` 请求都没有**（浏览器侧 fetch 计数 0），面板无自动拒绝/倒计时/暂停按钮，
  也没有任何“未安装”提示；面板功能正常。另用 Playwright 路由把该接口改 404 也验证同样结果。

**常用问题自定义（真实链路）**：
- `GET /presets` 返回生效值/defaults/config/source/limits；`POST` 保存后 `data/presets.json`（UTF-8，node 读回正确）
  与 `/context.presets` 同步；`POST /presets/reset` 删除文件并回退默认。
- 校验实测：非字符串 → `bad-presets`；301 字 → `preset-too-long`。
- 面板「常见问题 → 编辑」实测：加载 5+5 条、新增行、修改第一条、保存 → toast「常用问题已保存」、返回问答视图、
  chips 立即出现自定义问题；`恢复默认` 需二次确认、恢复后输入框回到内置问题并 toast；手机 390×844 编辑器无横向
  溢出、底部操作条固定可见（截图 `presets-02-editor-desktop.png` / `presets-03-editor-mobile.png`）。
- 单测 23/23 通过（新增 `normalizeReviewerMode`、插件名匹配、null 结局等）。

**未覆盖**：真实“卸载 auto-review/approval-timeout 后再启动”端到端（当前用 devTools 强制开关模拟同一代码路径）；
真机 iPhone 键盘与 safe-area；亮色主题实拍。

### V13. 「有结论却显示没有结论」+ 倒计时状态错标（用户真机发现，2026-10-31 晚）

**现象 A**：审批卡片明确写着「Auto review 拒绝了此调用：…」，但咨询台「审查 AI」tab 显示「审查材料已就绪，但还没有结论」。
**现象 B**：审批卡片显示「倒计时已取消」，咨询台却显示「还剩 32s」；最后审批仍被自动拒绝。

**A 的根因（三层）**：
1. 部分会话的 auto-review 审查请求没有被本插件捕获（`/debug/inspect` 该 session `reviews=0`，
   而同时段其他 session 捕获正常）——`llm/stream` 按 agent 作用域派发，本插件给每个 agent 绑的
   监听器在 **agent 对象被重建后仍按 sessionId 去重**，旧监听器绑在已死的 ctx 上，导致再也收不到审查请求。
2. 即使捕获不到，**审批理由本身就带着 auto-review 的最终结论**（deny / failed 两种固定前缀）。
3. `matchReview` 只在同 session 内找，跨 session 的高置信匹配缺失。

**A 的修复**：
- per-agent 捕获器改为按 **agent 对象身份**判断，对象重建即换绑；`sweep()` 与 `/diag` 时也会重新核对（`impl.js`）。
- `matchReview` 增加跨 session 兜底：仅接受「工具名相同 + 参数完全一致或审查理由被审批理由原样包含 + 120s 内 + 唯一命中」。
- **从审批理由合成审查记录**：识别 `Auto review denied tool "X": <reason>` 与
  `Auto review of tool "X" failed; ...`，生成 `synthetic:true` 的审查记录（deny 结论 / 失败错误），
  UI 显示结论与理由、badge「取自审批理由」，材料齐全时仍可追问。
- 验证：devTools `POST /debug/synthetic-approval` 造一条带 deny 理由的 pending，`/context.reviewer` 返回
  `available:true, classified:true, synthetic:true, decision:"deny", reason:"测试用：…需要用户明确授权。"`；
  `POST /debug/drop-pending` 清理。单测 24/24（新增 verdict 解析用例）。

**B 的根因与修复**：`dsh-approval-timeout` 客户端把卡片 key（`approval:<uuid>`）去匹配宿主
`callId`，永远匹配失败后退回 `list[0]`；列表里更早一条「已取消」的旧审批会让新卡片误显示
「倒计时已取消」。用户确认该插件也是他做的并授权修改；已打最小补丁（优先选仍在计时的最新一条），
备份 `client.js.bak-20261031`，详见 [`PATCHES.md`](PATCHES.md)。
验证：在旧取消记录仍在 `/status` 的情况下新建审批，官方卡片正确显示「拒绝（60s）」+「取消倒计时」。

**B2（用户 21:05 截图）**：在咨询面板点「暂停倒计时」（外部 `/cancel`）后，官方卡片仍继续倒计时，
归零显示「已超时」但不再触发。根因：timeout 客户端只在**自己按钮被点**时才置 `cancelled`，收不到外部取消通知。
补丁 2：卡片存在期间每 1.5s 查 `/status`，宿主列表非空且全部 `cancelled:true` 时把卡片标成「倒计时已取消」
（`PATCHES.md` 第 2 节，备份 `client.js.bak-20261031b`）。
验证（**未触碰真实审批**）：空白页注入伪 `[data-approval-key]` 卡片 + Playwright 路由 mock `/status`，
先返回计时中、2.5s 后返回已取消 → 卡片从 `拒绝（56s）/取消倒计时` 在 2.8s 内变为 `拒绝/倒计时已取消(disabled)`。

**未覆盖**：没有再次触发一次真实的 auto-review 拒绝来端到端截图（需要用户点允许/拒绝，会打断会话）；
合成结论没有 `risk`（审批卡片不提供），UI 只显示 deny + 理由；跨 session 兜底只在唯一高置信匹配时生效；
真实（非 mock）的“外部取消 → 卡片同步”场景未在在线审批上重演（有意避免取消真实审批的自动拒绝保护，
用户可在场时手动点一次官方「取消倒计时」观察，或下次咨询面板暂停时留意）。

### V14. 发布前硬化（兼容性 / 安全默认 / 数据目录 / i18n，2026-11-01）

- **安全默认值**：`cordis.patch.yml` 改为 `devWatch: false`、`devTools: false`；`cfg.devTools` 缺省也改为
  `false`（显式 true 才开放 `/debug/*`，其中的 inject/synthetic-approval 能写会话/造 pending）。
  本地开发用 profile patch 覆盖（该覆盖的写入待用户授权；当前运行进程仍是旧配置 true，重启后生效）。
- **用户数据目录与包目录解耦**：默认 `~/.dsh-approval-consult`；`--profile` 启动时推导 profile 数据目录；
  支持 `dataDir` 配置与 `DSH_APPROVAL_CONSULT_DATA`；兼容旧版包内 `data/presets.json`（读取并在保存时迁移）。
  验证：`/diag.config.dataRoot = <DSH_HOME>-approval-consult`；`POST /presets` 写入
  `presets.json`、`POST /presets/reset` 删除；25 项单测含目录优先级（显式/profile/--profile/home 兜底）。
- **审查策略防漂移**：捕获真实 auto-review 请求时自动刷新 `REVIEW_POLICY_TEXT`
  （`reviewPolicySource: bundled → captured`），DSH 升级后无需重新抽取；仍保留 `tests/extract-review-policy.mjs`。
- **i18n 一致性**：`tests/locale-parity.mjs` 校验 zh/en 字典 186 个 key 完全对齐、无空文案；CI 会跑。
- **槽位缺失降级**：`shell.overlay` / `conversation.chat.turnTail` 注册失败只告警，不拖垮页面；
  缺 turnTail 时只是没有历史入口。
- **包与合规**：`private` 移除、MIT `LICENSE`、`NOTICE.md`（DSH/auto-review 归属与 policy 来源）、
  `.gitignore`、`CHANGELOG.md`、`README.en.md`、`.github/workflows/ci.yml`（Ubuntu+Windows，Node 20）、
  `npm test` / `npm run check` 脚本、`docs/COMPATIBILITY.md`、`docs/PUBLISHING.md`。
- 检查结果：`node --check`（index/impl/client）通过；单测 25/25；locale 186/186；CI 配置已就绪。
- **未覆盖**：干净 profile / npm pack 安装、Firefox、真机 iPhone 键盘、npm 包名可用性（本机 npm 被
  PowerShell 执行策略拦住，需 `cmd /c npm view` 或发布时确认）。

## 复现命令（宿主侧，不经 UI）


```powershell
# 1) 诊断：路由、捕获数、存活会话权限预设、最近 LLM 分类
curl.exe -s http://127.0.0.1:3456/dsh-approval-consult/diag
# 2) 审查（advisory）重新评估
curl.exe -s -X POST http://127.0.0.1:3456/dsh-approval-consult/review -H "content-type: application/json" -d "{\"sessionId\":\"<sid>\"}"
# 3) 提问 + 轮询
curl.exe -s -X POST http://127.0.0.1:3456/dsh-approval-consult/ask -H "content-type: application/json" -d "{\"sessionId\":\"<sid>\",\"target\":\"reviewer\",\"question\":\"...\"}"
curl.exe -s "http://127.0.0.1:3456/dsh-approval-consult/poll?jobId=<jobId>&cursor=0"
```

> 注：路由有 `connection.requestRejection` 鉴权，命令行请求需带 GUI 的信任头/签名 cookie；
> 验证时实际使用的是页面内 `fetch`（同源、已登录）。
