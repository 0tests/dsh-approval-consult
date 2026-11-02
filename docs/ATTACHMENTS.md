# 图文上传（v1.1）技术方案

> 状态：**S 阶段已实现**（2026-11-02：宿主上传/引用/侧调用图片块 + 客户端附件 UI 已提交）。
> 需要重启一次 dsh web 让宿主侧路由生效；M 阶段（历史缩略图策略、预算压测、demo 变体）待做。
> 目标：审批等待期间向执行 AI / 审查 AI 提问时，可以带上图片（最常见的是审批卡片或报错的截图）。

## 0. 结论速览

- **不要自建上传目录**。DSH 已有 `ctx.attachments`（`AttachmentStore`，服务名 `attachments`，本地实现
  `@deepseek-ai/dsh-attachment-local`）：内容寻址（sha256）、解码校验、EXIF 旋转、缩放归一化（≤2048²/≤4 MiB）、
  去重，并负责按路由生成请求版本。自建 `dataDir/attachments` 会绕开这些，升级迁移还会丢。
- **v1 只做图片**（png / jpeg / webp / gif）。文件（PDF/zip）在请求里只会被投影成「文件名 + 字节数 + 只读路径」
  的文本，而本插件的侧调用明确「不调用任何工具」——把文件发给模型没有意义。文件能力留到 L 段，
  且需要先解决「侧调用如何读取文件内容」。
- **图片只加在侧调用的最后一条 user 消息**里（`ImageBlock`），`base.messages` 一个字节都不动 →
  prompt cache 命中与今天纯文本完全一致。
- **能力探测**用 `ctx.llm.resolveModelInfo(provider, model).inputModalities`（缺省/异常一律视为不支持）；
  不支持时**整块 UI 不渲染**（与「缺 auto-review 插件就隐藏审查 tab」同一条约定：一个字都不提示）。
- 本机当前路由 `opencode-go / deepseek-v4.1-flash` 的目录条目是 `input: ["text","image"]`，**本机可用**；
  切到 `glm-5.2` / `hy3` / `deepseek-v4-pro`（`["text"]`）时该功能自动消失。
- 工作量：**S ≈ 1.5–2 人日**（执行侧图文可用）；**M +1–2 天**（审查侧可选附图、历史缩略图、预算预检与错误语义）；
  **L +3–5 天**（文件、跨轮复用、标注裁剪——不建议现在做）。

## 1. 范围

### 1.1 做

- 面板输入区：附件按钮 + 粘贴 + 拖拽，缩略图 chip、删除、失败重试、张数/大小提示。
- 宿主：同源上传路由（复用 `connection.requestRejection` 鉴权）→ `ctx.attachments.saveImage()` → 引用登记。
- 侧调用：带附件时把 `ImageBlock` 追加到最后一条 user 消息；提示词里加一段「用户附了 N 张图」的说明。
- 线程回显：问题气泡下方显示只读缩略图（宿主 GET 路由读取）。
- 能力/限额随 `/context` 下发；不支持时整块隐藏。
- 清理：审批结束时失效引用、TTL 兜底；客户端关闭面板时清空待发 chips。

### 1.2 不做（v1）

| 不做 | 原因 |
| --- | --- |
| 文件（PDF/zip/txt） | 侧调用不调工具 → 模型只能看到路径文本，等于没给；要做得先解决「如何让侧调用读文件」。
| 客户端压缩/裁剪 | 与宿主归一化重复，容易二次损失画质；超大图直接提示换 jpeg 或裁剪。
| 上传到主对话 | 面板的问答是旁路调用，不应改动主对话上下文（会破坏主请求前缀缓存）。
| 图片进会话日志 | 同上；只注入「（附了 N 张图）」一行文字。

### 1.3 已知缺口（必须如实写进 README，不假装没有）

1. **字节不可回收**：`AttachmentStore` 没有删除/GC API（只有 save/read/limits）。我们能清理的只是「引用」，
   字节会留在 `~/.dsh/attachments`（与官方 composer 上传的图片同一待遇）。靠「每问 ≤3 张 + 内容寻址去重」控制增长，
   后续可向上游提 `deleteAttachment(ref)` + 引用计数。
2. **图片不进入会话**：聊天流、会话导出、其它客户端刷新后都看不到这些图；面板内靠自己的 GET 路由显示。
   文案上**不要**承诺「已在聊天里可见」。
3. **审查侧语义**：审查 AI 的职责是「按固定策略判定这一次工具调用」，附图属于用户澄清，可能让结论漂移。
   默认只给执行侧；审查侧默认 `auto`（只有用户在该 tab 显式加图才发），可配 `on/off`。
4. **双问不一致**：双问模式下执行侧带图、审查侧不带图时，两侧输入不同，答案不可严格对比；
   这条路径只显示一次性说明，不报错。

## 2. 数据流

```
① 截图 → 面板 Composer（粘贴 / 拖拽 / 附件按钮）
     └─ 本地校验（4 种 MIME、张数、单图字节）→ blob: 立即预览（chip: uploading）
     └─ POST /dsh-approval-consult/attachment?sessionId=&consultKey=&mediaType=&name=   [octet-stream]
          ├─ route() 守卫（同源 + 已认证会话）
          ├─ 流式收字节，超限即 413 并断开
          ├─ ctx.attachments.saveImage({ data, mediaType, name })
          │     └─ 解码校验 → EXIF → 归一化 → sha256 落盘 → ImageAttachmentRef
          ├─ registry[uploadId] = { ref, consultKey, sessionId, expiresAt }
          └─ 200 { attachment: { id, mediaType, bytes, width, height, name } }

② 发送
   POST /dsh-approval-consult/ask { sessionId, consultKey, target, question, attachmentIds[] }
     ├─ 校验 pending 未结束
     ├─ 能力复查 resolveModelInfo(base.provider, base.model)   // 切换过模型就拒
     ├─ 预算预检：前缀已有图片字节 + 本次字节 ≤ maxAskImageBytes
     └─ job.attachments = [ImageAttachmentRef...]

③ 侧调用装配（cache 安全）
   messages = [
     ...base.messages,                      // 原样，一个字节不动
     ...followUps,                          // 历史问答（纯文本）
     { role: 'user', content: [
         { type: 'text',  text: <提问 + 附图说明 + 旁路哨兵> },
         { type: 'image', attachment: ref1 },
         { type: 'image', attachment: ref2 },
     ]},
   ]
   ctx.llm.stream(options)

④ 适配器（pi-ai）
   containsImage → model.input 必须含 'image'（否则 UNSUPPORTED_CONTENT）
   readImageRequest(ref, imageRequestTarget()) → 请求版本（默认 ≤4 Mpx / ≤1 MiB）
   请求级字节预算超限 → IMAGE_OFFLOAD_REQUIRED（旁路请求没有插件替它下线图片 → 自建预检兜底）

⑤ 回答回流（现有链路不变）：job.text → /poll → Turn 渲染
   注入会话的问答只写「（附了 N 张图）」，不注入图片块

⑥ 回显 / 历史
   /context threads[*].attachments = [{ id, name, mediaType, bytes, width, height }]
   GET /dsh-approval-consult/attachment?id=&consultKey=  → 归一化图片字节（registry 鉴权）
```

## 3. 接口设计

### 3.1 上传

`POST /dsh-approval-consult/attachment?sessionId=&consultKey=&mediaType=&name=`

- Header：`content-type: application/octet-stream`（否则 415）；Body：原始字节。
- 上限：`min(config.maxAttachmentBytes, attachments.imageLimits.maxImageBytes)`，默认 8 MiB。
- 200：

```json
{ "ok": true,
  "attachment": { "id": "att_9f…", "mediaType": "image/png", "bytes": 482113,
                  "width": 2560, "height": 1440, "name": "截图 2026-11-02 004012.png",
                  "createdAt": 1762000000000, "expiresAt": 1762007200000 } }
```

`id` 是我们自己的 `randomUUID()`，**不暴露**内容寻址的 `attachmentId`（避免跨咨询枚举对照）。

### 3.2 读取（缩略图）

`GET /dsh-approval-consult/attachment?id=&consultKey=`

- 只接受属于该 `consultKey` 的 `id`，否则 404（不泄漏存在性）。
- 响应头：`cache-control: private, no-store`、`x-content-type-options: nosniff`、`content-security-policy: sandbox`。

### 3.3 丢弃

`POST /dsh-approval-consult/attachment/drop`，body `{ consultKey?, ids: [] }` → `{ ok: true, dropped: n }`（幂等，只丢引用）。

### 3.4 `/ask` 扩展

新增 `attachmentIds?: string[]`（默认 ≤3）。其余字段不变。
- 只有图、没写字时，客户端补一句默认问题（`attachmentOnlyQuestion`），宿主「question 非空」的契约不变。
- `target=reviewer` 且审查侧不支持图片：不报错，改为纯文本 + 一行「用户附了 N 张图，只发给执行 AI」。

### 3.5 `/context` 扩展

```json
"features": { "attachments": { "enabled": true, "executor": true, "reviewer": false } },
"limits": {
  "attachments": { "maxFiles": 3, "maxBytes": 8388608, "maxTotalBytes": 6291456,
                   "mediaTypes": ["image/png","image/jpeg","image/webp","image/gif"] }
},
"threads": { "executor": [ { "…": "…", "attachments": [ { "id": "att_9f…", "name": "…", "mediaType": "image/png", "bytes": 482113, "width": 2560, "height": 1440 } ] } ] }
```

### 3.6 错误码（沿用 `{ ok:false, code, error }` 信封）

| HTTP | code | 触发 |
| --- | --- | --- |
| 400 | `attachment-bad-request` | 缺 sessionId / mediaType、name 非法 |
| 400 | `attachment-invalid-image` | 解码失败 |
| 400 | `attachment-type-mismatch` | 声明与字节不符 |
| 404 | `attachment-unknown` | id 不存在 / 不属于该 consultKey |
| 409 | `attachment-unavailable` | 宿主没有 attachments 服务（理论上 base bundle 必有） |
| 409 | `model-no-image-input` | 提问时复查发现路由不支持图片 |
| 410 | `attachment-expired` | TTL 到期 |
| 413 | `attachment-too-large` | 超单图字节上限 |
| 413 | `attachment-too-many` / `attachment-too-many-pixels` / `attachment-dimension-too-large` | 张数 / 像素 / 单边超限 |
| 413 | `image-budget-exceeded` | 预检失败，或适配器抛 `IMAGE_OFFLOAD_REQUIRED` |
| 415 | `attachment-content-type` | 非 octet-stream |
| 415 | `attachment-unsupported-type` | 非 4 种 MIME |
| 429 | `attachment-busy` | 同咨询并发上传超限 |
| 500 | `attachment-store-failed` | 写入失败 |

## 4. 能力探测与降级

探测输入：`attachmentsAvailable = ctx.get('attachments') != null`；
`imageCapable(provider, model) = resolveModelInfo(...).inputModalities?.includes('image') === true`（缺省/异常 → false）。

| 条件 | `features.attachments` | 客户端 |
| --- | --- | --- |
| 无 attachments 服务 | `{enabled:false, executor:false, reviewer:false}` | 按钮不存在、不挂 paste/drop、不发请求、无任何提示文案 |
| 执行侧 text-only | `{executor:false}` | 执行 tab 不出现附件 |
| 两侧都 text-only / 未知 | 全 false | 整块功能不存在（等价于「缺插件」） |
| 都支持 | 全 true | 按钮 + 张数徽标 |

**「完全不渲染」的三条硬约束**（对齐现有 `reviewerAvailable` 的实现方式）：

1. 组件 `return null`（不是 `disabled`、不是 `display:none`）；
2. 副作用不注册（`onPaste` / `onDrop` / `onDragOver` 只在 enabled 时挂载；`drop` 不 `preventDefault`，不抢官方 composer）；
3. 不做探测请求，`/context` 一次拿全；服务端探测原因只进 `/diag`，永不渲染。

## 5. 侧调用与 prompt cache

- 改动点：`buildExecutorOptions` / `buildReviewerOptions` 里装配 messages 的那一处
  （`lib/impl.js` 当前 `:1032-1039` / `:1086-1094`），把 `content` 从 `[{type:'text'}]` 换成
  `[{type:'text'}, ...imageBlocks]`；`base` 只做 `...` 展开，**不要改 base**（loop 请求的 base 是 deep-frozen）。
- 为什么位置不能变：图片放在 system 或历史中间 → 请求前缀变化 → provider 整段缓存失效；
  放在最后一条新 user 消息里，前缀逐字节不变，图片只付「本来就新增」的 token。
- 提示词（只在带图时插在哨兵之前）：

  ```
  用户随这个问题附了 {n} 张图片（已随本条消息发送，见下方图片）。
  请把图里的内容当作问题的一部分来读；如果图中看不清或不包含所需信息，直接说明，不要猜测。
  ```

  审查侧措辞要守住边界：

  ```
  用户随这个问题附了 {n} 张图片。它们只作为用户澄清用，不改变你当时的审查材料；
  结论仍以 PENDING_ACTION 与 FILTERED_HISTORY 为准。
  ```

- 注入会话（`injectExecutorQa`）只写「（附了 N 张图）」，**不注入 image 块**：
  否则主对话历史多出图片 → 下一次主请求前缀变化、缓存全失效，用户还会在聊天流里看到没发过的图。
- 预算：图片只占**输入**，不占 `maxTokens`；真正会失败的是请求级图片字节预算
  （pi-ai 默认 20 MiB base64，超了抛 `IMAGE_OFFLOAD_REQUIRED`），而 `dsh-compaction-image-offload`
  只处理主对话请求，救不了旁路请求 → 必须在 `/ask` 前预检（按 `ref.bytes` 求和，不读盘）。

## 6. 存储与生命周期

**放哪**：`ctx.attachments.saveImage()`。`dataDir` 继续只放 `presets.json`。

| 限额 | 默认 | 依据 |
| --- | --- | --- |
| 每问张数 | 3 | 468px 抽屉 / 390px 手机一行放得下；压住请求预算 |
| 单图字节 | 8 MiB | 低于 `imageLimits.maxImageBytes`（20 MiB） |
| 每问图片原始总字节 | 6 MiB | 归一化后 ×4/3 base64 仍远低于 20 MiB |
| 每咨询保留条目 | 6 | 追问时可复用上一张 |
| 单咨询并发上传 | 2 | 内存峰值 ≈16 MiB |
| TTL | `min(threadTtlMs, 2h)` | 与面板线程一致 |
| MIME | 4 种 | `ImageMediaType` 定义 |

**清理**：审批结束（`finalizePending`）→ 立即失效；`sweep()` 每 60s 清 TTL；插件 dispose 清空；
面板关闭只清客户端 chips。**只丢引用，字节不删**（见 §1.3）。

**安全**：上传路由走 `connection.requestRejection`（同源 + 已认证会话）；`name` 只作展示
（`basename` 化、剥控制字符、截 120 字符，永不参与路径）；读取只认 registry 里的 `id`，
不拼接任何文件系统路径；响应头 `nosniff` + `CSP: sandbox`。

## 7. 客户端交互

- **入口**：`.ac-composer` 内、textarea 上方新增 `.ac-attachment-rail`（chips，可横向滚动，不换行挤压输入框）；
  `.ac-input-tools` 左侧加「附件」按钮；`.ac-input-wrap` 与 `.ac-sheet` 挂 paste / drag 监听（仅能力可用时）。
- **chip**：缩略图 64×64、右上角 18×18 删除按钮（hover 显形，`pointer: coarse` 常显），
  状态 `uploading / ready / error`；失败可重试（复用原 File，不重新选择）。
- **尺寸**：468px 抽屉与 390px 手机两套度量；3 张 chip 必须满足 `document.documentElement.scrollWidth === innerWidth`。
- **a11y**：rail `role="list"`、chip `role="listitem"`、删除按钮 `aria-label` 含文件名；
  `prefers-reduced-motion` 下不做入场动画。
- **主题**：只用 `--dsw-alias-*` token，亮/暗/壁纸主题都要成立。

## 8. 失败模式

| 场景 | 处理 |
| --- | --- |
| HEIC / SVG / BMP（`file.type` 常为空） | 前端白名单拦并提示；服务端 415 兜底 |
| 声明 MIME 与字节不符 | 400 `attachment-type-mismatch`，chip 标红可重试 |
| 超大截图（4K PNG > 8 MiB） | 413，提示改用 jpeg 或裁剪；不做客户端压缩 |
| 上传中关面板 / 切会话 | TTL + sweep；`/ask` 时 consultKey 不符 404 |
| 宿主热重载 | registry 放 `globalThis` 状态里，与 jobs 一样保留 |
| 宿主重启 | registry 丢 → `attachment-unknown`，面板此时已走 `no-pending` 结束态 |
| 上传后、提问前审批结束 | `/ask` 409 `approval-resolved`（已有分支），chips 一并作废 |
| 并发上传 | 每咨询 ≤2，超出 429 |
| 图片预算越界 | 预检 + 413，提示去掉一张；chips 保留不丢 |
| 模型中途切成 text-only | 提问时复查 → 409 `model-no-image-input`，提示「去掉图片重发 / 取消」 |

## 9. 测试与验收

**A. 单测**（导出纯函数给 `tests/unit.mjs`）

- `sanitizeAttachmentName`：`..\..\x.png`→`x.png`、控制字符、超长截断、空名默认。
- `pickAttachmentMediaType`：4 种通过；`image/heic`、`""`、`application/pdf` 拒绝。
- `clampAttachmentIds`：超过 3 截断、去重、非字符串丢弃。
- `estimateImageBytes`：边界值恰好等于上限通过、超过判超。
- `attachmentFeatureOf`：无服务全 false；`inputModalities` undefined → false；抛错 → false（不冒泡）。
- 错误码映射表：9 个 `AttachmentError` → 期望 HTTP/code。

**B. 宿主集成（真实 DSH）**

1. 100 KB PNG → 200，尺寸/字节正确；
2. 4K PNG → 200 但落库字节明显变小（证明归一化生效）；
3. `.txt` 改名 `.png` → 400 `attachment-type-mismatch`；
4. 9 MiB → 413 且连接断开（不挂起）；
5. 上传后立刻结束审批 → `/ask` 409、`/context` 无残留；
6. 用别的 consultKey 读同一个 id → 404；
7. `/diag` 只有计数与 TTL，无字节/路径。

**C. 浏览器（Playwright，1440×900 + 390×844）**

1. 粘贴截图 → chip ≤400ms，uploading→ready；发送后问题气泡下有缩略图；
2. 手机 390：3 张不撑破宽度、无横向滚动；键盘弹起不被 chip 顶出视口；
3. 拖拽：面板内高亮，面板外不高亮、不 preventDefault；
4. × 立即移除并 revoke blob；失败重试复用原 File；
5. 切 `glm-5.2` 刷新 → 按钮/粘贴/拖拽全不存在，DOM 无 `ac-attachment-*`，Console 无「不支持」；
6. 审批结束 → 结态、chips 清空；
7. 暗色/亮色都只用 token；
8. a11y：role/aria-label 齐全，减少动效下无动画。

**D. 视觉验收**：chip 与官方 composer 观感一致（圆角/删除按钮），不与手机 `.ac-grabber` 重叠；
468px 下 3 张若挤压输入框 → 改横向滚动而非换行。

**E. 回归**：纯文本提问的 `/ask` 请求体除 `attachmentIds: []` 外与今天一致；`promptChars` 不变；
`usage.cacheReadTokens` 与改造前同量级（cache 未被破坏的硬证据）；`npm test` 全绿。

## 10. 分阶段

| 阶段 | 内容 | 估时 | 风险 |
| --- | --- | --- | --- |
| **S** | 上传路由 + registry + `saveImage` + `/ask attachmentIds` + 执行侧 `ImageBlock` + `/context` 能力/限额 + 结束/TTL 清理；客户端按钮/粘贴/拖拽/chip + 不支持整块隐藏 + zh/en 文案 | 1.5–2 人日 | 低，全部复用现有管线 |
| **M** | 审查侧可选附图 + 双问降级文案；线程/历史缩略图 + GET 路由；预算预检 + `IMAGE_OFFLOAD_REQUIRED` 友好化；`model-no-image-input` 二选一交互；`/diag`；demo 变体；单测；文档 | +1–2 人日 | 中，预算边界要用真实 20 MiB 上限压测 |
| **L** | 非图片文件（需先解决侧调用读文件）、跨轮复用、标注裁剪、多图排序、手机拍照、计量与回收（需上游 delete） | +3–5 人日 | 高，涉产品取向与上游契约 |

## 11. 需要拍板的四个选择

1. **只做图片？**（建议：是）——文件在侧调用里对模型不可读，等 L 段。
2. **审查侧默认要不要给图？**（建议：默认 `auto` = 只有用户在该 tab 显式加图才发；`on/off` 可配）。
3. **限额用默认值？**（建议：每问 3 张、单图 8 MiB、每问总 6 MiB、每咨询保留 6 条）。
4. **历史缩略图放 S 还是 M？**（建议：M；S 只保证「发出去能看到图」）。

## 12. 与 `docs/BACKLOG.md` 4.5 草案的差异

| 旧草案 | 本方案 | 理由 |
| --- | --- | --- |
| 存 `data/uploads/<uuid>.<ext>` + 绝对路径 | `ctx.attachments.saveImage()` → `ImageAttachmentRef` | 外部文件无法变成 `ImageAttachmentRef`；也没有校验/归一化/去重 |
| 「多模态 part 或 路径 + 文本」 | 只做 `ImageBlock` | 侧调用不调工具，「路径 + 文本」对模型等于没给 |
| 不支持时退化为路径文本并提示 | 不支持时**整块不渲染** | 与既有「零提示」约定一致 |
| 「审查模型通常是纯文本」 | 审查与执行同路由、能力一致（限制在语义而非能力） | 事实纠正 |
| 未提图片预算 | 显式预检 + `IMAGE_OFFLOAD_REQUIRED` 映射 | 20 MiB 上限在长会话里会随机炸 |
