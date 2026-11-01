# 审批咨询台 · 客户端 UI 自测记录（ui-dev）

最终版本：`lib/client.js`（最后修改：2026-11-02 00:50，新增「复制审查意见」；之前一次 2026-10-30 22:47）
验证环境：DSH Web `http://127.0.0.1:3456`、Chromium 156、Playwright MCP。

## 一、架构要点（与 Lead 修正后的契约一致）

- 只有 **两个** slot 注册：
  - `shell.overlay` / id `approval-consult-panel` / order 40 —— 悬浮胶囊 + 抽屉（桌面）/ 底部弹层（手机），
    同时承载「咨询中」与「只读咨询记录」两种面板形态。
  - `conversation.chat.turnTail` / id `approval-consult-history` / order 40 —— 每轮对话尾部的
    `💬 审批咨询记录 · N` 低调 chip；只让本会话最大 `seq` 的一轮显示，避免每轮重复。
- 原 `conversation.input.dock` 注册已删除：审批期间 composer fallback 整棵子树 `display:none`，
  放在那里用户看不见（Lead 复核结论）。
- 面板使用 **Popover API（`popover="manual"` + `showPopover()`）拉到 top layer**：
  `shell.overlay` 只有 z-index:20，环境里存在 z-index:2147483000 的常驻装饰（余额桌宠），
  普通层级右抽屉的底部按钮会被它盖住且无法点击；top layer 不参与普通层叠上下文，
  同时 `manual` 不会被 Esc/点击自动关闭，正好当模态用。不支持时自动退回普通 fixed 层。
- 模块级 **不可变快照 store** + `useSyncExternalStore`：每次 `emit` 生成新对象，否则 React 永不重渲染。
- 所有 hooks 在 early return 之前（骨架“点不开面板”的根因就是 hook 顺序）。
- 所有定时器/轮询经 `after()` / `every()` 登记，`ctx.effect` 卸载时统一清理；`/poll` 用代际打断。

## 二、自测清单（对照 CLIENT-CONTRACT §7 + 新增要求）

| # | 项目 | 结果 | 说明 |
|---|---|---|---|
| 1 | Console 无 `slot entry crashed` / 未捕获异常 | 通过 | 仅剩页面 favicon 404 与第三方插件网络错误（环境网络抖动 `ERR_NETWORK_CHANGED`），与本插件无关 |
| 2 | demo：胶囊 → 面板 → 预设流式 → 转达/决策 → Esc 关闭 → 再开 | 通过 | 合成 Esc 关闭后面板消失、胶囊恢复，再次点击可打开 |
| 3 | 真实审批链路 | 由 Lead 验收通过 | Lead 已实测 `/context`、`/ask` 流式、缓存命中、注入、决策；本机 UI 待 Lead 最终验收 |
| 4 | 1440×900 / 390×844 无横向滚动、无溢出、按钮可点 | 通过 | `document.documentElement.scrollWidth === innerWidth`；390 宽下 `ac-sheet` 无溢出 |
| 5 | 亮色 / 暗色 | 通过 | 暗色用 `body[data-ds-dark-theme]` token 切换验证（截图见 ui-08） |
| 6 | 双问（compare） | 通过 | 同题双发，另一侧完成后出现「{target} 也已回答 / 查看」并可跳转 |
| 7 | 停 止 / 取消 | 通过（demo） | 流式中显示「停止」，点击置为已停止并中止轮询 |
| 8 | 错误分支 + 重试 | 通过 | demo `?consult-demo=error` 模拟 context 失败：错误块（标题/原因/错误码/重试）→ 重试后恢复 |
| 9 | 上下文错误、单条回答失败重试 | 通过 | 错误行 + 重试按钮（重新发送同一问题） |
| 10 | Esc 只作用于面板内、不抢官方快捷键 | 通过 | 只在面板 sheet 的 onKeyDown 处理；输入框内 Esc 不关闭且 stopPropagation；无全局快捷键注册 |
| 11 | 焦点管理 | 通过 | 打开聚焦输入框（桌面）/面板（手机/历史）；关闭焦点回到触发元素；Tab 在面板内循环；aria-modal |
| 12 | 粘性滚动 | 通过 | 底部跟随；向上滚动后不打扰，出现「回到最新」 |
| 13 | 可访问性 | 通过 | dialog/tablist/tab+aria-selected/aria-controls/aria-pressed/aria-busy、aria-label、focus-visible |
| 14 | 减少动效 | 通过 | `prefers-reduced-motion` 下关闭位移/闪烁动画 |
| 15 | 主题 token | 通过 | 只用 `--dsw-alias-*` / `--dsw-specific-*` / `--dsh-*` / `--ds-*`，风险徽标用 `color-mix` 派生低饱和色 |
| 16 | 移动端安全区 / 键盘 | 通过（实现）/ 未真机验证 | 底部 `env(safe-area-inset-bottom)`；input 16px；`visualViewport` 键盘弹出时压缩弹层高度并上移，输入框 `scrollIntoView({block:'nearest'})` |
| 17 | 轻量 Markdown | 通过 | 段落/标题降级/有序无序列表/行内 code/**粗体**/*斜体*/围栏代码块（等宽+横向滚动+复制）/引用/链接降级纯文本；全程 React 元素，无 innerHTML |
| 18 | advisory「让审查 AI 重新评估」 | 通过（demo） | `?consult-demo=advisory`：CTA 卡 → 评估中禁用 → 返回 risk/decision/reason 立即更新上下文卡片与徽标、开放提问；失败保留按钮可重试 |
| 19 | 409 review-not-initialized | 通过（实现） | 捕获后回到审查 tab 并显示 CTA，去掉错误占位 |
| 20 | /ask 409 no-pending / approval-resolved | 通过（实现） | 不弹死面板：移除乐观条目、切结束态并静默刷新 context |
| 21 | 审查不可用 / 执行不可用降级 | 通过 | `?consult-demo=no-reviewer` / `no-executor`：tab 上 !、原因说明、输入禁用 |
| 22 | reviewer.failed / pending.error | 通过 | 上下文卡片内警示行（只读展示原始错误） |
| 23 | 咨询记录历史 | 通过 | 真实（Lead 验收）+ demo：`/history` 30s 缓存 + in-flight 去重；只读面板无输入/决策；`已保存到会话`/`已转达` 标记 |
| 24 | history 无记录不渲染 | 通过 | 拉取失败或空数组时返回 null（console 无报错） |
| 25 | 文案不承诺“聊天里可见” | 通过 | 「已保存到会话」tooltip 明确写「写入会话日志、模型下一轮能看到；聊天流不显示这一行」 |
| 26 | │ 模块 id / demo 模式 / 测试钩子保留 | 通过 | `id: dsh-approval-consult`；`?consult-demo=1`；`data-approval-consult-{pill,dock,panel,thread,context,history,error}` 均在 |
| 27 | 复制审查意见（新增） | 通过 | `data-approval-consult-copy-opinion`：点击后按钮变「已复制」+ toast，剪贴板内容为「【自动审查意见】结论/风险/工具/理由」；`?consult-demo=no-reviewer` 下不渲染；468 / 390 宽度都不溢出、不换行挤压 |

未覆盖 / 风险：
- 真机 iPhone 键盘与安全区未实测（无真机），仅按 `visualViewport` + safe-area 实现并做了 390 宽度验证。
- 暗色截图用 `body[data-ds-dark-theme]` 模拟（页面其余部分会保持浅色，属模拟方式限制，面板本身 token 正确）。
- 顶部悬浮胶囊在手机上会覆盖右侧少量正文（浮动入口的固有代价）；已下移到 tabs 下方、隐藏工具名以减小面积。
- 面板置于 top layer 后，若同期出现 DSH 原生 dialog（z-index:1100 普通层），会被面板盖住；审批等待期极少同时出现，已接受。

## 三、截图证据（`<local-shots-dir>\`）

- `ui-07-desktop-panel-full-1440x900.png` 桌面抽屉：上下文卡片（参数展开）+ 审查理由 + Markdown 回答 + 决策条
- `ui-08-dark-desktop-1440x900.png` 暗色面板
- `ui-12-desktop-advisory-cta-1440x900.png` advisory：兜底重新评估 CTA
- `ui-13-desktop-advisory-after-1440x900.png` 评估后：风险/结论/理由更新 + 「重新评估」徽标 + 可提问
- `ui-14-desktop-history-1440x900.png` 只读咨询记录面板（两段审批，Markdown + 代码块）
- `ui-11-mobile-pill-390x844.png` 手机 390×844：悬浮胶囊
- `ui-09-mobile-panel-390x844.png` 手机底部弹层（上下文展开态）
- `ui-10-mobile-streaming-390x844.png` 手机流式回答 + 收起预设 + 决策条
- `ui-06-desktop-ended-1440x900.png` 决策后结束态（banner + 只读决策栏）
- 早期过程图：`00-baseline-*`、`10-*`、`11-*`、`12-*`、`13-*`、`15-*`、`16-*`、`20-history-desktop.png`
- Lead 侧真实数据证据：`lead-history-panel.png`

## 四、demo 自测入口

```
?consult-demo=1                 完整演示（胶囊常显、mock 上下文、本地伪造流式、可决策/转达）
?consult-demo=advisory          reviewer.advisory + needsClassification（验证“重新评估”流程）
?consult-demo=no-reviewer       审查不可用降级
?consult-demo=no-executor       执行上下文缺失降级
?consult-demo=error             上下文错误 + 重试（点重试后恢复 mock）
```
