# 安全策略 / Security Policy

## 报告漏洞

**请不要公开提交 issue。** 请通过 GitHub 仓库的
**Security → Report a vulnerability**（私有漏洞报告 / Security Advisory）提交，
并尽量包含：

- 受影响的插件版本与 DSH 版本（`dsh --version`）；
- 复现步骤、预期行为与实际行为；
- 影响面判断（能否读到本不该读的会话内容、能否绕过审批、能否写入数据目录之外的路径等）；
- 相关日志（**先删掉 token、会话内容和个人路径**）。

我们会在 7 天内确认收到，并在修复发布后致谢（如你愿意署名）。

## 安全模型

本插件是一个**只读咨询面板**，不参与审批决策本身：

- 它**不会**自动批准或拒绝任何工具调用；面板上的「允许/拒绝」只是转发给官方审批卡片同一个动作，
  最终仍由宿主审批链路处理。
- 宿主侧需要 `llm/stream`、`approval/request`、`tools/pre-execute` 等官方扩展面；
  它不修改官方审批卡片 DOM，也不注册任何工具。
- 侧调用（向执行 AI / 审查 AI 提问）复用主对话已捕获的请求前缀，**只会拿到主对话已有权限内的信息**；
  它不会扩大模型可见范围，也不会把面板问答写进用户不可见的隐藏上下文。

## 安全默认值

- `devTools: false`：`/dsh-approval-consult/debug/*` 排障路由默认不注册；
- `devWatch: false`：不做开发热重载，避免文件监听带来的意外执行；
- 所有 HTTP 路由同源，并走宿主 `connection.requestRejection` 鉴权（未认证请求被拒绝）；
- 用户数据写在 `dataDir`（默认 `~/.dsh-approval-consult`，`--profile` 时落在该 profile 数据目录），
  **不写进 npm 包目录**，npm 升级不会覆盖用户配置；
- 面板线程只存在宿主内存中，随审批结束/进程重启消失；落盘的只有用户自己编辑的
  `presets.json`（常用问题）。
- 日志默认不记录会话正文；`/diag` 只输出计数与能力开关，不含消息内容。

## 依赖与许可

- 插件代码：MIT（见 [`LICENSE`](LICENSE)）。
- `lib/review-policy.txt` 原样抽取自 `@deepseek-ai/dsh-experimental-auto-review`（MIT），
  仅用于「重新评估」兜底；运行时会用捕获到的真实策略文本覆盖。归属说明见 [`NOTICE.md`](NOTICE.md)。
- 可选集成（`dsh-approval-timeout`、自动审查插件）均为**可选依赖**：未安装时相关功能整体隐藏，
  不会产生报错或 404 噪音。
