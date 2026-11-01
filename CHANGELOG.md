# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 功能

- **一键复制审查意见**：自动审查存在时，「本次审批」标题行右侧新增「复制意见」，
  把结论 / 风险 / 工具 / 理由拼成一段可直接粘贴给执行 AI 的纯文本（不发新请求、不改会话）；
  复制失败时退回 `execCommand`。缺自动审查插件时不渲染该按钮。

## [1.0.0] - 2026-11-01

首个可发布版本。

### 功能

- 审批等待期间的悬浮入口（桌面右侧抽屉 / 手机底部弹层）。
- 双通道独立提问：执行 AI（复用主对话请求前缀）与审查 AI（复用官方 auto-review 审查前缀），
  互不污染，prompt cache 命中原样保留。
- 「双问」、追问、常用问题一键发送、流式回答、停止/重试、Markdown 渲染。
- 审查 AI 的两种来源：捕获到的官方审查请求；没有捕获时按官方 `REVIEW_POLICY` 与四段材料规则
  做 advisory 重新评估。
- 执行 AI 问答自动注入会话（`approval-consult` 上下文记录）；审查 AI 回答按「转达」显式注入。
- 面板内直接「允许一次 / 拒绝」（与官方卡片同一动作）。
- 只读咨询记录：对话流末尾「💬 审批咨询记录」→ 历史面板。
- **缺插件自适应**：无官方自动审查插件时自动降级为只问执行 AI；无 `dsh-approval-timeout` 时
  完全不探测、不显示倒计时内容。`reviewerMode` / `timeoutAutoPause` 可配置。
- **常用问题可自定义**：面板内编辑（新增/删除/排序/恢复默认），持久化到 `~/.dsh-approval-consult/presets.json`
  （`--profile` 启动时用 profile 数据目录；`dataDir` 配置 / `DSH_APPROVAL_CONSULT_DATA` 可覆盖，npm 升级不丢配置）。
- 从会话日志重建丢失的 pending；从审批理由合成 auto-review 结论；跨热重载保留状态。
- 主题适配（亮/暗、自定义壁纸主题下自带不透明表面色）、375/390 宽手机布局、下滑关闭、
  焦点陷阱、Esc/键盘可达、`prefers-reduced-motion`。

### 兼容性

- DSH Web（`shell.overlay` / `conversation.chat.turnTail` 槽位）。
- 可选：`@deepseek-ai/dsh-experimental-auto-review`、`dsh-approval-timeout`。
- 详见 `docs/COMPATIBILITY.md`。
