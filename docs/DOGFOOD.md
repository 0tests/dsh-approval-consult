# 真实使用记录（Dogfooding）与修复清单

> 时间：2026-10-31 14:10–15:35（Asia/Shanghai）
> 方式：用 Playwright 直接操作 DSH Web GUI，走真实审批链路（workspace-write 沙箱提权 → 审批卡片 → 咨询台），
> 像用户一样点胶囊、切 tab、点预设、追问、点倒计时、拖拽、看历史；不做 API 层模拟。
> 环境特点：用户自定义了**壁纸主题**（`body[data-ds-dark-theme]`，`--dsw-alias-bg-base` 被主题设成 `transparent`），
> 这恰好暴露了此前所有自动化验收（纯色主题）看不到的问题。

## 一、发现并修复的问题

| # | 问题 | 严重度 | 证据 | 修复 |
| --- | --- | --- | --- | --- |
| D1 | **壁纸主题下面板完全透明**：背后的对话文字/审批卡片/底部按钮和面板内容叠在一起，完全无法阅读。根因：面板底色用 `var(--dsw-alias-bg-base, #fff)`，而该主题把这个 token 定义成 `transparent`（token 存在但透明，兜底值不生效）。 | 严重 | `dogfood-04-mobile-panel.png`（修复前，多层文字重叠） vs `dogfood-05-mobile-panel-fixed.png` | 面板自带**不透明表面色**（`--ac-surface` / `--ac-surface-2` / `--ac-surface-3`，亮/暗两套，按 `body[data-ds-dark-theme]` 切换），不再依赖可能透明的主题底色；`dogfood-06-desktop-fixed-1440.png` 为桌面验证 |
| D2 | **阅读期间倒计时悄悄到期**：打开面板不会暂停倒计时（上次按用户要求改成默认 `on-send`），但用户读审批理由+材料常常超过 60s，审批直接超时自动拒绝，面板突然变“已结束”，非常困惑。 | 高 | 实测中两次发生（dogfood-01/02） | 面板顶部新增**倒计时提示条**：`自动拒绝倒计时还剩 {N}s：阅读/思考期间可以暂停。[暂停倒计时] [×]`；保留 `on-send` 默认策略不变，把选择权交还用户。`dogfood-08-timeout-banner.png` |
| D3 | **矮窗口下上下文卡挤占聊天区**：1440×900 时默认展开的上下文卡占 ~170px，加上预设区，问答线程只剩 ~250px，回答被从中间截断。 | 中 | `dogfood-06-desktop-fixed-1440.png` | 上下文卡默认展开条件改为 `innerHeight >= 1100`；矮窗口/手机默认收起（摘要行保留风险/结论/历史数），可手动展开。线程区从 ~250px 增至 ~360px |
| D4 | **预设问题区有丑陋的内部小滚动条**：`.ac-chips` 限高 66px，5 条常见问题被截断成两行 + 细滚动条。 | 中 | `dogfood-08-timeout-banner.png` 右侧 | 桌面限高改为 168px（完整显示 5 条），手机 96px；一旦开始提问（线程非空）预设自动折叠成一行标题 |
| D5 | 输入框占位符与下方提示重复：“问点什么…（Enter 发送，Shift+Enter 换行）” + “Enter 发送 · Shift+Enter 换行”。 | 低 | `dogfood-08` | 占位符统一为“问点什么…”；键盘提示只在可输入时显示一行 |
| D6 | **手机底部弹层的把手只是个装饰**：有 grabber 但没有下滑关闭，用户会本能地往下拖。 | 中 | 代码检查 + 实测 | 实现**下滑关闭**：把手 27px 命中区、拖动跟手、超过 96px 自动关闭并回到胶囊；`dogfood-13-mobile-threads.png` |
| D7 | **审批结束后仍有“不可用”噪音**：审查 tab 带 `!`、常见问题区、输入键盘提示都还在（虽然按钮已 disabled）。 | 低 | 结束态快照 | 结束态隐藏 `!` 徽标、预设区、键盘提示；决策条只保留结局标签 |
| D8 | **超时结束显示成“审批已结束”，看不出是超时**：宿主 `String(null)` 把内核返回的 `null` 结局写成字符串 `"null"`，前端无法识别。 | 中 | 结束态实测 | 宿主修正 `finalizePending` 的 null 规范化（含历史 `"null"/"undefined"`）；前端新增 `normalizeOutcome`；结束 banner 和决策条现在显示 **“已超时（无人应答）”**（与“已拒绝”区分）。`dogfood-14-ended-timeout-desktop.png` |
| D9 | 历史（只读）卡片里出现“本次审批没有可用的自动审查上下文”的操作性提示，历史场景纯噪音。 | 低 | `dogfood-12-history-panel.png` | 历史卡片改为中性标签“未咨询审查 AI” |
| D10 | 审查 AI advisory 的说明重复三处：上下文卡 hint + 线程 CTA 标题 + “没有可用的自动审查上下文”。 | 低 | `dogfood-03-reviewer-advisory-qa.png` | 删除上下文卡里的 advisory 重复 hint，保留线程区 CTA（“审查材料已就绪，但还没有结论 / 让审查 AI 重新评估”） |

## 二、实测确认可用的能力

- 胶囊在真实审批出现时立即显示（右上角，含工具名示例 `pwsh`）；打开面板默认「执行 AI」tab。
- 执行 AI：预设问题一键发送、流式渲染 Markdown、`缓存/输入/输出` 用量、大约 5s 内出现「已保存到会话」。
- 审查 AI（advisory 路径，本次审批未开自动审查）：材料重建 → 点「让审查 AI 重新评估」→ 风险/结论/理由更新 → 可继续追问；答案带缓存命中。
- 双问：同一问题两侧各自流式回答，互不污染；两侧都可「停止」。
- 流式滚动：在底部时自动跟随；向上翻后**不会**被强行拽回，出现「↓ 回到最新」。
- 倒计时集成：提示条可一键暂停（`暂停倒计时` → 提示“已暂停自动拒绝倒计时”，审批保持等待）；`dsh-approval-timeout` 的全局 cancel 语义已在按钮 tooltip 说明。
- 手机 390×844：底部弹层无横向溢出、输入框 16px（避免 iOS 缩放）、决策条贴底、上下文默认收起、预设自动折叠；**下滑把手可关闭**。
- 审批结束后：结束 banner 显示结局（已拒绝/已超时（无人应答））、只读、无转达按钮、无预设、无 `!` 徽标；`/relay` 对已结束审批 409。
- 历史：对话流末尾出现「💬 审批咨询记录 · 1」→ 打开只读「咨询记录」，无输入框、无转达按钮，可回看问答与用量。
- 无障碍抽查：Tab 焦点在面板内循环（8 次未逃逸）；Esc 在非输入区关闭面板、在输入框内不清空不关闭；blur 后焦点回胶囊。

## 三、仍未覆盖/遗留

- **真机 iPhone 键盘 + safe-area**：仅 390×844 视口 + `visualViewport` 实现级验证，未在真实 iPhone 上跑键盘弹起/收起。
- **亮色主题**只做了代码级兼容（自带亮色 surface），未实际切换主题截图。
- 转达按钮的真实点击（会向会话注入内容）未在本次 dogfood 中点击；host 侧 409 与按钮隐藏已分别验证。
- 本次 dogfood 创建了 6–7 个测试会话（部分已自动超时结束，1 个 `等待审批` 因倒计时被暂停仍在等待）；建议归档。
  其中「等待审批 用 pwsh 写入 dogfood2」为**未决审批**，直接拒绝/允许或归档会话即可。
- 环境噪声（与插件无关）：本机 Edge 偶发 `net::ERR_NETWORK_CHANGED`；auto-review 间歇性 `TRANSPORT/TIMEOUT`
  会让部分工具调用被拒（fail-closed），本次 dogfood 中因此被动中断过几次，不代表插件问题。

## 四、截图索引

| 文件 | 内容 |
| --- | --- |
| `dogfood-01-pill-desktop.png` | 真实审批等待时的胶囊（壁纸主题背景） |
| `dogfood-02-ended-after-timeout.png` | 第一次阅读超时（修复前的困惑点） |
| `dogfood-03-reviewer-advisory-qa.png` | 审查 AI advisory + 追问（修复前布局） |
| `dogfood-04-mobile-panel.png` | **修复前**：透明面板 + 内容重叠 |
| `dogfood-05-mobile-panel-fixed.png` | 修复后：移动端面板清晰可读 |
| `dogfood-06-desktop-fixed-1440.png` | 修复后：1440×900 桌面抽屉 |
| `dogfood-08-timeout-banner.png` | 倒计时提示条 + 上下文默认收起 + 预设完整显示 |
| `dogfood-10-fresh-approval.png` | 新审批：提示条、预设 5 条完整、无重复占位提示 |
| `dogfood-12-history-panel.png` | 只读咨询记录（历史入口） |
| `dogfood-13-mobile-threads.png` | 移动端有线程时：把手、线程、折叠预设、决策条 |
| `dogfood-14-ended-timeout-desktop.png` | 结束态：已超时（无人应答）、无噪音控件 |
