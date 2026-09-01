# 网站阶段 2C 零费用人工审核验收记录

## 结论

- 日期：2026-09-02。
- 范围：阶段 2C 零费用人工审核的本地实现、自动化验证、真实 Docker 候选、运维文档收敛，以及上海免费开发环境的实际最小部署与已完成远端 smoke 子项。
- 提交范围：`5c914ef`（不含）至本次阶段 2C 整分支终审修复提交（含，本记录所在提交）。
- 远端状态：`remote: in_progress`；最小部署已完成，真实 smoke 仅完成公开社区、未认证管理员拒绝和 cleanup 直调子项。
- 本记录不表示阶段 2C 已通过或正式生产上线；真实 OTP 管理员登录与完整业务 smoke 仍待完成。

## 已执行的远端环境门

| 项目 | 实际结果 |
| --- | --- |
| 旧环境删除 | 已只读核对旧上海环境 `ai-pet-scanner-dev-d8cq…e` 的地域、体验套餐和资源；展示销毁范围并取得行动时第二次明确确认后，先销毁再永久释放。环境列表复核确认该环境已不存在；新加坡旧环境未触碰。 |
| 新环境创建 | 创建页明确显示上海、PostgreSQL、免费体验版、6 个月、配置与实付均为 0.00 元，且未勾选任何搭配购买；兑换码验证通过后创建。 |
| 费用保护 | 新环境 `ai-pet-scanner-dev-d0cp…826` 的套餐页显示免费体验版、有效期至 2027-03-01、体验版不支持自动续费、资源点 `0/3000`；按量付费开关未开启。 |
| PostgreSQL migration | CLI 对比确认远端与本地全部 16 条 migration 一致；远端最新版本为 `20260901020000`，没有 pending 或 conflict。 |
| 私有对象存储 | 私有 Bucket `ai-pet-private` 已存在，`public=false`。 |
| 函数 | 仅部署 `ai-pet-api` 与 `ai-pet-cleanup`；两者均为 Event 云函数、Node.js 20.19，部署状态完成。免费体验版实际固定超时 3 秒、内存 256 MB。 |
| 网关 | 两条 `SCF` 路由：公开 `/api` 不启用网关认证；管理员 `/api/v1/admin` 启用网关认证。最长前缀使管理员路由优先。公开 `GET /api/v1/community?limit=1` 返回 200；未认证管理员请求返回 401 `MISSING_CREDENTIALS`。 |
| 身份 | 邮箱 OTP 已启用，唯一管理员账号为 ACTIVE；真实 OTP 登录和管理员指标读取尚未完成。 |
| 静态托管 | 网站以目标环境、Publishable Key 与网关 `/api/v1` 基址构建，67/67 个构建文件上传成功；当前静态托管对象总数为 73。未记录任何 Key 值。 |
| 投稿与费用 | `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。当前计费周期总资源点 3000、已使用 0.13；`packageDeduct=0`、`payAsYouGoDeduct=0`，未发生资源包外或按量扣费。 |
| cleanup | 真实函数直调返回 `claimed=0/purged=0/failed=0/expiredOperationsPurged=0`。规格未定义周期，未配置定时触发器，待另行裁决与验证。 |

## 已执行的本地事实

| 项目 | 实际结果 |
| --- | --- |
| PostgreSQL 行为门 | 本地 PostgreSQL 17.11，顺序执行 16 个 migration，85 项行为验证通过。 |
| 自动化测试 | 共 986 项通过：门禁测试 108、共享契约 43、网站单测 383、CloudBase API 278、包扫描器 67、发行工具 4、migration 工具 42、网站合同 34、CloudBase 构建产物 3、CloudBase 构建工具 5、Playwright E2E 19。 |
| 网站 | 383 项单测通过；生产构建通过；Playwright E2E 19/19 通过。 |
| CloudBase API | 278 项单元测试通过；构建与 typecheck 通过；另有 3 项构建产物测试通过，产物只含 `api`、`cleanup`。 |
| 包扫描器 | 67 项测试通过；typecheck 通过。 |
| 依赖审查 | 263 个模块、687 条依赖；0 个错误，8 个已批准历史 warning。 |
| 真实 Docker 候选 | imageId `sha256:a02f6a8a6cd2fbd3663a61d811c9eae4f7bc6a3b0fdb41f1b495fbaa60a45a9c`；Node `v22.23.2`、ClamAV `1.4.3`、UID `999`；ClamAV DB `28110`，更新时间 `2026-09-01T11:10:23.000Z`，裁决时年龄 0 天；无网络、全部 capability 移除、只读根文件系统、只读输入与 `mode=1777` tmpfs 条件下，干净包进入人工审核、EICAR 阻断、非法包拒绝。 |

## 2026-09-02 官方安装包点击计数补充

- 本地范围新增第 16 条前向 migration `20260901020000_official_windows_download_click_metric.sql`；历史 migration 未修改。
- Memory 与生产合同替身共用公开空响应和管理员累计值合同；公开社区、反馈与静态页面不返回 `officialDownloadCount` 或 `clickCount`。
- 本地浏览器场景以 Memory API 连续登记两次点击，公开页不显示指标，认证管理员工作台才显示累计值；本次完整网站链与范围/所有权门均通过。
- 上述是当时的本地合同结论；上海远端 migration、函数更新和网关配置已由本记录的本次远端证据更新。真实 OTP 管理员登录、管理员指标读取与完整业务 smoke 仍未验证，本节不将其写为通过。

Task 7 最终复验实际执行：

```powershell
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 5c914ef..HEAD
git status --short
```

完整网站链、范围门、测试所有权门和提交差异检查均返回 0；`git status --short` 在记录提交前只列出本轮已解释的管理员 ZIP E2E、Memory API 地址、退役策略与测试、现行规格/计划、两本运维手册、优化索引、旧验收历史恢复和本验收记录。

本地行为已收敛为：新共享包和反馈/建议直入 `manual_review_pending`；反馈可普通 `approve` 并记录 `standard`；新共享包没有有效系统证据时普通批准失败关闭，只能经风险确认执行 `force_publish`，并记录 `admin_override` 与公开风险提示。restore 的旧幂等 key 在恢复后的后续发布、驳回、隔离或清理生命周期中仍回放首次快照；同 key 改管理员原始输入继续冲突，新 key 不能绕过当前状态与版本门。

管理员详情提供 5 分钟待审 ZIP 地址；该地址不进入公开 DTO，真实 E2E 下载返回 `application/zip`，且不会增加公开下载计数。本地 Docker CLI 不是云端服务：构建阶段 `freshclam` 使用网络更新病毒库，运行阶段固定 `--network none`；候选病毒库超过 7 天必须重建并复验。报告要求人工查看图片，且不能作为系统扫描通过证据。

## 已退役的云端自动审核入口

现行 CloudBase 最小部署面仅为 PostgreSQL、私有 Bucket、`ai-pet-api`、`ai-pet-cleanup`、身份、网关和静态托管。CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 和 Scanner Secret 已退役，禁止部署。对应的 17 个旧自动审核与远程 Scanner 源码/测试路径由范围门同时拒绝工作树与 Git 索引恢复。

## 未验证项

以下仍未验证：真实 OTP 管理员登录、官方下载点击的管理员指标读取、反馈完整批准、共享包强制发布、点赞、评论、短期下载、完整远端数据清理、cleanup 定时调度、监控、告警和正式生产发布。本地 Docker 干净包/EICAR 与本地全链证据仍有效，但不得冒充远端 smoke。

共享包投稿开关继续保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。后续远端写操作继续执行行动时预览与失败关闭；任何远端验证成功也不自动等于正式生产上线。
