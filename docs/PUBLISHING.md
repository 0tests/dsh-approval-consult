# 发布前检查清单（PUBLISHING）

> 目标：把 `dsh-approval-consult` 作为独立、通用、可维护的开源 DSH 插件发布（npm + GitHub）。
> 当前状态：**本地功能完成，尚未发布**。下面是发布前还缺的东西和已完成的项。

## 已完成（2026-11-01）

- [x] 安全默认值：`devWatch: false`、`devTools: false`（排障接口默认关闭；本地开发用 profile patch 覆盖）
- [x] `package.json` 发布元数据：去掉 `private`、license MIT、engines、exports、files、scripts（`test`/`check`）、keywords
- [x] `LICENSE`（MIT）、`NOTICE.md`（DSH / auto-review 的 MIT 归属与策略文本来源）
- [x] `.gitignore`（`node_modules/`、`data/`、日志、本地截图）
- [x] 测试：`tests/unit.mjs`（25 项）+ `tests/locale-parity.mjs`（186 key zh/en 对齐）
- [x] CI：`.github/workflows/ci.yml`（Ubuntu + Windows，Node 20）
- [x] `docs/COMPATIBILITY.md`（环境矩阵、必需/可选扩展面、缺插件降级、隐私）
- [x] 用户数据改为与包目录无关（默认 `~/.dsh-approval-consult`；`--profile` 时用 profile 数据目录；
      支持 `dataDir` 配置 / `DSH_APPROVAL_CONSULT_DATA`；旧包内文件自动迁移），npm 升级不丢配置
- [x] 运行时自动同步官方审查策略（避免 DSH 升级后内置 policy 过期）
- [x] 槽位缺失时降级（只告警，不拖垮页面）
- [x] `CHANGELOG.md` 1.0.0
- [x] `README.en.md` 英文简版 + `docs/assets/` 截图（相对路径）

## 发布前还需要

- [x] **本地 git 仓库**：`git init -b main` + 首提交 `6715bf6`（35 个文件，`data/`/截图/日志已忽略）；
      后续提交 `d967190`（发布准备）、`6a09853`（仓库元数据）。
- [x] **GitHub 身份已确认**：本机 SSH key `0tests@github` 认证成功 → GitHub 账号 **`0tests`**
      （已有公开仓库 `0tests/dsh-balance-pet`，本插件沿用同一组织/命名风格）。
- [x] **remote 已配置**：`origin = git@github.com:0tests/dsh-approval-consult.git`（SSH，走 `ssh.github.com:443`）。
      `package.json` 已写入 `repository`/`homepage`/`bugs` 指向该地址。
- [ ] **远程仓库尚未创建**：`git ls-remote` 返回 `Repository not found`。需要二选一：
      a) 在 GitHub 网页新建空仓库 `0tests/dsh-approval-consult`（public，不加 README/gitignore），然后 `git push -u origin main`；
      b) 或登录 `gh`（当前未登录）后 `gh repo create 0tests/dsh-approval-consult --public --source . --remote origin --push`。
- [x] **提交者身份匿名化**：仓库内提交使用 `dsh-approval-consult <noreply@users.noreply.github.com>`，
      未使用本机 `Administrator@ZEROTESTS-PC`。
- [x] **README 双语**：`README.md`（中文，主）+ `README.en.md`（英文简版）；截图改用相对路径。
- [x] **npm 包名**：`dsh-approval-consult` 目前 **404（可用）**（2026-11-01 用 `cmd /c npm view` 确认）。
- [ ] **版本**：当前 1.0.0；首个公开版本可考虑 0.1.0 以示 API 未冻结（需同步 CHANGELOG/README）。
- [x] **发布 dry-run**：`npm pack --dry-run` 通过（13 个文件、包体 104.7 kB；含 `lib/`、`locale/`、`icon.svg`、
      `cordis.patch.yml`、LICENSE/NOTICE/README，不含 `docs/assets` 与本地文件）。
- [ ] **安装即用验证**：
      在一个干净 profile（`dsh` 新 profile）里 `install_bundle` 安装本包，不依赖任何本地开发文件；
      验证无 `auto-review`、无 `approval-timeout`、无网络时分别的降级行为。
- [ ] **真实浏览器矩阵**：Chrome / Edge / Firefox（Firefox 的 Popover 支持情况需验证；
      若不支持会退化为 fixed 层）、亮色主题、iPhone 真机键盘。
- [x] **License 合规复查**：`lib/review-policy.txt` 的 MIT 归属已在 NOTICE 写明，发行包内附 LICENSE + NOTICE。
- [x] **安全审查**：`data/`、日志、本机绝对路径已从公开文档清理（2026-11-01 全仓扫描无残留）；
      `/debug/*` 默认关闭；HTTP 路由全部经 `connection.requestRejection` 鉴权。
- [x] **文档**：`VERIFICATION.md` / `DOGFOOD.md` / `PATCHES.md` / `UI-NOTES.md` 中的个人绝对路径
      已替换为 `<workspace>` / `<DSH_HOME>` / `<user-home>` 占位（保留证据可读性）。
- [x] **社区文件**：`CONTRIBUTING.md`、`SECURITY.md`（私有漏洞报告）；Issue/PR 模板暂不需要。
- [x] **README 截图**：全部改为**面板本体**截图（裁掉宿主界面与壁纸，演示数据，
      `docs/assets` 合计约 416 KB），避免泄露真实会话内容。

## 不在 1.0 范围（后续版本）

- 面板内上传附件/图片（见 `docs/BACKLOG.md` 4.5；依赖模型多模态能力，需要先探测 provider 支持）。
- advisory 自动评估开关（manual / on-open / background）。
- “决定附言”（拒绝/允许时附一句原因给执行 AI）。
- 真机 iPhone 键盘 / safe-area 回归、Firefox 兼容。

## 发布步骤（建议）

1. 完成上面“还需要”的项；`npm test && npm run check` 全绿。
2. `npm version <x.y.z>` + 更新 CHANGELOG。
3. `npm publish --access public`（或先 `npm pack` 本地安装验证）。
4. GitHub Release 附 `docs/assets/` 截图与 CHANGELOG。
5. 在 README 顶部写清“DSH 版本范围 / 可选插件 / 安全默认值 / 数据路径”，避免用户踩坑。
