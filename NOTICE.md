# 第三方组件与许可说明（NOTICE）

本仓库自身以 MIT 许可发布（见 `LICENSE`）。以下是运行时/派生内容涉及的第三方项目：

## DeepSeek Harness（DSH）

- 项目：`deepseek-harness`（`@deepseek-ai/dsh-*`）
- 许可：MIT
- 关系：本插件是 DSH 的第三方插件，运行在 DSH 之上；不包含 DSH 源码。
  依赖 DSH 的公开扩展面：`llm/stream`、`tools/pre-execute`、`approval/request`、
  `agent.inject()`、`session.surface`、`webServer.register`、client slots/locale。

## @deepseek-ai/dsh-experimental-auto-review（可选依赖）

- 许可：MIT
- 关系：本插件可选的「审查 AI」通道复用其审查请求前缀与策略。
  - `lib/review-policy.txt`：由 `tests/extract-review-policy.mjs` 从 auto-review 源码或已安装包中
    原样抽取的 `REVIEW_POLICY` 文本（MIT，版权归 DeepSeek 所有），仅作为离线兜底策略；
    运行时一旦捕获到真实审查请求，会**自动使用捕获到的策略文本**（`/diag.config.reviewPolicySource = captured`）。
  - 当前策略来自 [dsh-v0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/experimental/auto-review/src/index.ts)（2026-11-12 同步）。
  - `lib/impl.js` 中 advisory 材料、消息来源角色与新旧格式的处理参考了该包的 MIT 实现；重建结果不保证等价于官方完整快照。
- 未安装该插件时，本插件自动降级为「只问执行 AI」。

## 其他可选插件

- `dsh-approval-timeout`（自动拒绝倒计时）：用户自研插件，**不随本仓库分发**；
  本插件只通过公开 HTTP 路由（`/status`、`/cancel`）做可选集成，并可用 `timeoutAutoPause` 关闭。
- `dsh-notify` / `dsh-web-mobile-fix` 等：无代码依赖，仅要求不冲突。

## 字体与图标

- `icon.svg` 为本仓库自绘，MIT。
- 不内嵌任何第三方字体；UI 使用宿主主题字体与等宽字体回退。
