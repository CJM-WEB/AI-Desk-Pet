# 网站阶段 2C 零费用人工审核验收记录

## 结论

- 日期：2026-09-02。
- 范围：阶段 2C 零费用人工审核的本地实现、自动化验证、真实 Docker 候选、运维文档收敛，以及上海免费开发环境的实际最小部署与已完成远端 smoke 子项。
- 提交范围：`5c914ef`（不含）至本次阶段 2C 整分支终审修复提交（含，本记录所在提交）。
- 远端状态：`remote: in_progress`；最小部署已完成，真实 OTP 管理员登录、管理员详情与指标读取、反馈批准/公开/点赞/撤赞/删除隔离及官方下载计数已通过。
- 本记录不表示阶段 2C 已通过或正式生产上线；共享包强制发布、短期下载、评论能力裁决、cleanup 调度和完整业务 smoke 仍待完成。

## 已执行的远端环境门

| 项目 | 实际结果 |
| --- | --- |
| 旧环境删除 | 已只读核对旧上海环境 `ai-pet-scanner-dev-d8cq…e` 的地域、体验套餐和资源；展示销毁范围并取得行动时第二次明确确认后，先销毁再永久释放。环境列表复核确认该环境已不存在；新加坡旧环境未触碰。 |
| 新环境创建 | 创建页明确显示上海、PostgreSQL、免费体验版、6 个月、配置与实付均为 0.00 元，且未勾选任何搭配购买；兑换码验证通过后创建。 |
| 费用保护 | 新环境 `ai-pet-scanner-dev-d0cp…826` 的套餐页显示免费体验版、有效期至 2027-03-01、体验版不支持自动续费、资源点 `0/3000`；按量付费开关未开启。 |
| PostgreSQL migration | CLI 对比确认远端与本地全部 16 条 migration 一致；远端最新版本为 `20260901020000`，没有 pending 或 conflict。 |
| 私有对象存储 | 私有 Bucket `ai-pet-private` 已存在，`public=false`。 |
| 函数 | 仅部署 `ai-pet-api` 与 `ai-pet-cleanup`；两者均为 Event 云函数、Node.js 20.19。`ai-pet-api` 已于 2026-09-02 10:18 更新为 `$LATEST`，状态为 Active/Available；免费体验版实际固定超时 3 秒、内存 256 MB。 |
| 网关 | 两条 `SCF` 路由：公开 `/api` 不启用网关认证；管理员 `/api/v1/admin` 启用网关认证。最长前缀使管理员路由优先。公开 `GET /api/v1/community?limit=1` 返回 200；未认证管理员请求返回 401 `MISSING_CREDENTIALS`。 |
| 身份 | 邮箱 OTP 已启用，唯一管理员账号为 ACTIVE；真实 OTP 登录、双头管理员认证、详情读取和管理员指标读取均已通过。 |
| 静态托管 | 网站以目标环境、Publishable Key 与网关 `/api/v1` 基址构建，67/67 个构建文件上传成功；当前静态托管对象总数为 73。未记录任何 Key 值。 |
| 投稿与费用 | `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。当前计费周期总资源点 3000、已使用 0.21；`packageDeduct=0`、`payAsYouGoDeduct=0`，未发生资源包外或按量扣费。 |
| 日志与反馈链 | 已临时开通上海开发环境函数日志且未购买独立日志资源包。日志定位并闭环空 GET 正文与 void RPC 204 两个兼容问题；反馈真实执行批准发布、公开读取、点赞 `0→1`、撤赞 `1→0`、删除隔离和公开消失，审计记录保留批准与删除两次动作。CloudBase 系统日志会保存函数响应摘要，因此当前只允许测试数据且共享包投稿继续关闭；接入真实投稿或正式上线前必须关闭该日志或先完成独立脱敏方案。 |
| cleanup | 真实函数直调返回 `claimed=0/purged=0/failed=0/expiredOperationsPurged=0`。规格未定义周期，未配置定时触发器，待另行裁决与验证。 |

## 已执行的本地事实

| 项目 | 实际结果 |
| --- | --- |
| PostgreSQL 行为门 | 本地 PostgreSQL 17.11，顺序执行 16 个 migration，85 项行为验证通过。 |
| 自动化测试 | 共 985 项通过：门禁测试 108、共享契约 43、网站单测 383、CloudBase API 核心 277、CloudBase 构建产物 3、包扫描器 67、发行工具 4、migration 工具 42、网站合同 34、CloudBase 构建工具 5、Playwright E2E 19。 |
| 网站 | 383 项单测通过；生产构建通过；Playwright E2E 19/19 通过。 |
| CloudBase API | 280 项通过（含构建产物 3 项）；构建与 typecheck 通过，产物只含 `api`、`cleanup`。 |
| 包扫描器 | 67 项测试通过；typecheck 通过。 |
| 依赖审查 | 263 个模块、687 条依赖；0 个错误，8 个已批准历史 warning。 |
| 真实 Docker 候选 | imageId `sha256:a02f6a8a6cd2fbd3663a61d811c9eae4f7bc6a3b0fdb41f1b495fbaa60a45a9c`；Node `v22.23.2`、ClamAV `1.4.3`、UID `999`；ClamAV DB `28110`，更新时间 `2026-09-01T11:10:23.000Z`，裁决时年龄 0 天；无网络、全部 capability 移除、只读根文件系统、只读输入与 `mode=1777` tmpfs 条件下，干净包进入人工审核、EICAR 阻断、非法包拒绝。 |

## 2026-09-02 官方安装包点击计数补充

- 本地范围新增第 16 条前向 migration `20260901020000_official_windows_download_click_metric.sql`；历史 migration 未修改。
- Memory 与生产合同替身共用公开空响应和管理员累计值合同；公开社区、反馈与静态页面不返回 `officialDownloadCount` 或 `clickCount`。
- 本地浏览器场景以 Memory API 连续登记两次点击，公开页不显示指标，认证管理员工作台才显示累计值；本次完整网站链与范围/所有权门均通过。
- 上海远端公开计数接口已使用空对象请求并返回 200/空数据；认证管理员工作台读取到累计值 3。三次均为本轮可解释的验收点击，不代表三个用户、三次传输完成或三次安装。

## 2026-09-02 上海远端日志诊断与真实反馈验收

- CloudBase 网关把无正文 GET 表示为 `body: ''`；旧详情解析误把它当作非法 JSON 并返回 400。最小修复只把 `undefined` 和精确空字符串视为无正文，非空正文及额外 query 继续失败关闭。
- PostgREST 对 `RETURNS void` 的计数 RPC 返回 204 空正文；旧客户端强制解析 JSON，导致数据库已计数却对外误报 500。最小修复只接受 HTTP 204 为成功空数据，其余响应继续走原有有界解析和错误归一化。
- 两次修复均按 RED → GREEN 完成独立回归测试和复审；部署后 10:18 起日志共观察到 3 个函数请求，平台与应用层均为 200，0 个失败，最长 709 ms。
- 临时反馈已从隔离区保留至 `purgeAfter` 到期；公开列表已确认不再出现，未直接篡改或删除审计数据。
- 官方 `IgnoreSysLog` 配置已做真实试验，但环境日志仍出现系统响应摘要，不能作为脱敏措施；试验配置已撤回，没有把无效加法留在正式配置中。

## 2026-09-02 本轮新鲜本地验证

以下均为本地验证，不替代远端 smoke：

```powershell
pnpm.cmd verify:cloudbase
pnpm.cmd verify:website
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git status --short
```

- `verify:cloudbase`：CloudBase API 280/280（含构建产物 3 项）、包扫描器 67/67 通过。
- `verify:website`：网站 383/383、生产构建与 Playwright E2E 19/19 通过。
- 范围门、测试所有权门与差异检查通过；提交后 `git status --short` 为空。

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

以下仍未验证：共享包强制发布与公开风险提示、待审包短期下载、完整远端数据清理、cleanup 定时调度、监控、告警和正式生产发布。现有代码没有可执行的评论入口，但现行阶段 2C 规格仍列出评论验收，因此必须先纠正规格或另行实现，当前不得宣称通过。本地 Docker 干净包/EICAR 与本地全链证据仍有效，但不得冒充远端 smoke。

共享包投稿开关继续保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。后续远端写操作继续执行行动时预览与失败关闭；任何远端验证成功也不自动等于正式生产上线。
