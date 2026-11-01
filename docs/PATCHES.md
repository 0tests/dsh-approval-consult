# 第三方插件补丁记录（本地）

> 本文件记录为修复真实问题而对**其他已安装插件**做的本地最小改动（均已征得用户同意）。
> 所有改动都保留备份，可随时还原；升级/重装对应插件会覆盖这些补丁，需要重新评估。

## 1. dsh-approval-timeout —— 倒计时状态可能标错审批卡片

- 日期：2026-10-31
- 用户授权：用户在审批咨询面板里明确说「这个超时插件也是我这做的，你可以修改」。
- 文件：`<DSH_HOME>\profiles\web\plugins\dsh-approval-timeout\lib\client.js`
- 备份：同目录 `client.js.bak-20261031`
- 版本：`dsh-approval-timeout` 当前安装版（profile `web`）

### 问题

`syncWithHost()` 启动时用卡片 DOM 的 `data-approval-key`（值是 `PendingApproval.key`，形如
`approval:<uuid>`）去匹配宿主 `/status` 里的 `pending[].callId`（工具调用 id）。两者格式不同，
**永远匹配不上**，于是退回 `list[0]`（第一条待审批）。当列表里存在一条更早、已被用户
「取消倒计时」的待审批时（`cancelled:true`），新出现的审批卡片会继承它的状态，被错误地
显示成「倒计时已取消」；但宿主侧这条新审批的 60s 计时仍在运行，最终仍会**自动拒绝** ——
显示与实际不一致，用户会误以为已经安全。

### 补丁（约 20 行，纯客户端）

`if (!hit) hit = list[0];` 改为：优先选择**仍在计时（`cancelled !== true`）的最新一条**
（`elapsedMs` 最小），只有全部已取消时才退回 `list[0]`。

单条待审批时行为完全不变；多条待审批时能避免“拿错上一条的已取消状态”。

### 验证

- 在 `/status` 同时存在一条 6.5 小时前已取消的旧记录 + 新审批记录的情况下，新审批卡片
  正确显示 **「拒绝（60s）」+「取消倒计时」**（修复前会显示「倒计时已取消」）。
- 语法检查 `node --check` 通过。
- 详见 `docs/VERIFICATION.md` V13。

### 还原

```powershell
Copy-Item "<DSH_HOME>\profiles\web\plugins\dsh-approval-timeout\lib\client.js.bak-20261031" `
          "<DSH_HOME>\profiles\web\plugins\dsh-approval-timeout\lib\client.js" -Force
```

还原后刷新页面即可（无需重启 DSH）。

## 2. dsh-approval-timeout —— 外部取消后卡片倒计时不同步（同一文件，补丁 2）

- 日期：2026-10-31 晚
- 用户授权：同上（该插件由用户自己开发并明确允许修改）
- 备份：`client.js.bak-20261031b`

### 问题

用户在审批咨询面板里点「暂停倒计时」时，我们的插件直接调用
`POST /dsh-approval-timeout/cancel`（全局取消）。timeout 插件客户端只在**自己插入的
「取消倒计时」按钮被点击**时才把本地 `cancelled` 置 true，面板外部发起的取消它收不到通知 ——
于是官方卡片仍然显示「拒绝（Ns）」并继续每秒递减，直到归零显示「已超时」，但宿主计时其实早已取消、
不会拒绝。用户看到的现象：「右边已取消，左边还在计时，归零也不触发」。

### 补丁

- 新增 `refreshHostCancelState()`：卡片存在且本地未取消时，每 **1.5s** 拉一次 `/status`；
  当宿主列表非空且**所有条目都 `cancelled:true`** 时，把本地 `cancelled=true` 并 `paint()`，
  卡片随即显示「倒计时已取消」（拒绝按钮恢复原文案）。
- 卡片消失时轮询自停（`refreshHostCancelState` 内清理 interval；`cleanup()` 的同步清理因
  审批未获授权未加，但不影响正确性 —— 最多多跑一个 1.5s 周期）。
- 保留补丁 1 的“优先取仍在计时的最新条目”匹配逻辑。

### 验证（无需真实审批）

用 Playwright 在一个空白标签页里注入伪审批卡片 `[data-approval-key]`，并用 `page.route`
把 `/dsh-approval-timeout/status` 先返回 `cancelled:false`、2.5s 后返回 `cancelled:true`：

- 阶段 1（宿主计时中）：卡片按钮 = `拒绝（56s）` / `取消倒计时` / `允许一次`；
- 阶段 2（模拟外部取消后 2.8s 内）：`拒绝` / `倒计时已取消（disabled）` / `允许一次` —— 同步成功。

全程未触碰任何真实审批，未调用 `/cancel`。

