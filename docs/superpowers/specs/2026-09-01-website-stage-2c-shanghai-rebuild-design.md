# 网站阶段 2C 上海免费环境重建设计

> **历史替代声明（禁止执行旧自动审核部署）：** 本规格中关于 CloudBase Run Scanner、腾讯 TMS/IMS、`ai-pet-moderation-worker`、Scanner Secret 与相关 smoke 的内容已被 [`2026-09-01-website-stage-2c-zero-cost-manual-review-design.md`](2026-09-01-website-stage-2c-zero-cost-manual-review-design.md) 替代。下文仅保留为历史设计上下文，不得据此部署、配置或恢复这些已退役能力；现行运维以 `docs/operations/cloudbase-deployment.md` 和 `docs/operations/content-moderation.md` 为准。

> 日期：2026-09-01
> 分支：`WebsiteExtension`
> 状态：已于 2026-09-01 获用户确认
> 替代范围：仅替代网站与 CloudBase 相关规格、计划、代码和运维文档中“开发环境固定为 `ap-singapore`”的结论；不改变桌宠、角色工作室或正式生产部署边界

## 1. 目标

在不产生任何额外费用的前提下，将网站阶段 2C 的唯一开发目标从已停用的新加坡环境改为上海 CloudBase 免费体验环境，并完成以下工作：

1. 销毁当前不兼容的上海传统模式环境，在上海重新创建 PostgreSQL（PG 模式）免费体验环境。
2. 将网站、CloudBase API、迁移适配器和 Scanner 候选中的唯一固定地域改为 `ap-shanghai`，删除只服务旧新加坡环境的断言与说明，不增加双地域兼容层。
3. 在新上海 PG 开发环境中验证受控 migration、三个云函数、Scanner 云托管、私有存储、身份认证、HTTP 网关和定时任务。
4. 保持共享包投稿开关关闭，通过完整开发环境 smoke 后再单独裁决是否允许开发环境投稿。
5. 用真实证据更新运维与验收记录，不把阶段 2C 写成正式生产上线。

## 2. 硬约束与非目标

### 2.1 零额外费用

- 只允许使用腾讯云明确标示为 `0 元` 的上海免费体验环境、套餐内免费资源点和不会自动转为付费的试用额度。
- 不购买或升级套餐，不购买资源包，不开启按量付费，不开启自动续费，不提交任何会立即或以后自动扣费的订单。
- 创建环境、开通内容安全、部署计算资源或启用网络能力前，必须读取当前控制台的价格、试用期、自动续费和超限处理。页面未明确为零费用，或需要勾选按量计费时，立即停止。
- 免费资源点不足、免费函数配置不足、试用能力不可用或平台要求付费时，阶段 2C 记为 `blocked`；不得通过架构扩张、绕过计费提示或擅自付费解决。
- Scanner 云托管最小实例数保持 `0`；只在部署与 smoke 所需窗口运行，完成后恢复为无常驻实例的低消耗状态。

### 2.2 业务与仓库范围

- 只修改网站业务允许范围：`apps/website/**`、`apps/cloudbase-api/**`、`apps/package-scanner/**`、`cloudbase/**`、相关网站工具、配置、规格、计划与运维文档。
- 不修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**` 或 `packages/character-assets/**`。
- Scanner 可以继续消费角色包已有公开契约，但不得修改这些契约的 owner 或桌宠运行逻辑。
- 不执行 Git 合并、变基或推送；Git 写操作只发生在当前 `WebsiteExtension` 分支。

### 2.3 本轮非目标

- 不把阶段 2C 环境作为正式生产环境，不绑定正式域名，不切换线上旧测试版流量。
- 不开启共享包匿名投稿；`SHARED_PACKAGE_SUBMISSIONS_ENABLED` 始终保持 `false`。
- 不恢复已退役的 `apply-cloudbase-migrations*` 或控制台手工复制 SQL 路径。
- 不把 PostgreSQL 改写为 MySQL，不为新加坡保留兼容分支，不新增第二套 Router、迁移器或存储实现。
- 不以免费套餐限制为理由降低权限、审核、对象结构、扫描事实或管理员审计要求。

## 3. 当前事实

### 3.1 仓库事实

- 网站阶段四本地治理已经完成，完整 `verify:web-chain` 通过；阶段 2C、远端 migration 和正式生产部署尚未执行。
- 13 个 migration 已在本地 PostgreSQL 17.11 顺序通过，但仓库默认入口 `pnpm.cmd plan:cloudbase-migrations` 仍只生成只读 checksum plan。
- `@cloudbase/manager-node` 受控 Adapter 已覆盖 preview、push 与 task poll 的本地边界测试，但没有可直接执行远端写入的默认 CLI。
- `cloudbaserc.json` 已声明 `ai-pet-api`、`ai-pet-moderation-worker` 和 `ai-pet-cleanup`，但只构成本地部署描述，不证明任何函数已部署。
- CloudBase API、网站 SDK、迁移 Adapter 和 Scanner 候选仍有 `ap-singapore` 单地域硬编码，直接指向上海会失败关闭。

### 3.2 上海环境事实

2026-09-01 在腾讯云控制台只读核对到当前唯一上海环境：

- 环境名称：`ai-pet-scanner-dev`
- 环境 ID：`ai-pet-scanner-dev-d8cqh04af371e`
- 地域：上海 `ap-shanghai`
- 套餐：免费体验版
- 数据库模式：传统模式；未启用 PostgreSQL，控制台只提供 MySQL 8.0 开通入口
- 云函数：0 个
- 云托管：1 个已暂停、允许公网访问的 `ai-pet-package-scanner`
- 云存储：空，访问权限为“仅创建者及管理员可读写”
- 静态网站托管：0 个应用
- HTTP 网关：0 条路由，保留一个旧环境安全域名
- 身份认证：1 个旧管理员账号

腾讯云官方文档明确：传统模式环境不能升级或切换为 PG 模式；PG 模式只能在新建环境时选择 PostgreSQL。当前环境无法承载现有 PG migration 与运行时契约。

免费体验版每月提供 3000 资源点，但不支持资源包和按量付费；其函数资源扩展能力受套餐限制。当前仓库声明的 30 秒、900 秒和 300 秒超时不能在部署前假定免费版一定允许，必须以新环境控制台的实际可配置范围为准。

## 4. 方案比较与裁决

### 4.1 采用：销毁并重建上海 PG 免费环境

销毁当前传统模式环境，释放免费环境名额，再创建上海 `ap-shanghai`、数据库类型为 PostgreSQL 的免费体验环境。新环境沿用显示名称 `ai-pet-scanner-dev`（若平台允许），但接受平台生成新的环境 ID；所有本地和云端配置只使用新 ID。

优点：

- 保留现有 PostgreSQL 状态机、事务、RLS、RPC、migration 和 PG Storage 设计。
- 只需把唯一固定地域从新加坡替换为上海，不引入双地域或双数据库复杂度。
- 删除旧 Scanner 和旧身份残留，得到真正可重复的干净开发环境。

代价与风险：

- 当前环境及其所有资源永久删除且不可恢复。
- 环境 ID、默认域名、存储域名和 Publishable Key 全部变化。
- 免费环境释放或重新创建可能受腾讯云隔离期、销毁次数和当月额度限制；遇到限制时停止，不购买付费环境。

### 4.2 拒绝：保留传统环境并改写 MySQL

该方案会重写 migration、PostgreSQL RPC、事务、RLS、PG Storage 和身份边界，产生第二套实现或大量替换，风险与代码量远高于地域替换，不符合“能不加就不加、能减则减”。

### 4.3 拒绝：保留旧环境并另购上海 PG 环境

该方案能降低销毁风险，但立即产生费用并留下两个环境，与用户明确的零额外费用和从头重建要求冲突。

## 5. 环境销毁与重建边界

### 5.1 销毁前门禁

销毁是大量、不可恢复的云端删除。即使方案已经批准，真正点击确认或执行命令前仍须：

1. 再次只读核对环境 ID、地域、套餐与资源清单。
2. 执行官方 CLI `env delete --dry-run` 或控制台等价预览；不使用 `--yes`、`BypassCheck` 或跳过资源检查。
3. 向用户展示将被删除的精确环境和资源，取得行动时第二次明确确认。
4. 确认用户不需要旧 Scanner、管理员账号、安全域名或任何数据备份。

### 5.2 销毁范围

第二次确认后只允许销毁：

- 上海环境 `ai-pet-scanner-dev-d8cqh04af371e`
- 其中已暂停的旧 `ai-pet-package-scanner` 云托管服务
- 空云存储与其默认域名
- 旧管理员身份记录
- 旧 Web 安全域名、日志和环境级配置

不得访问、恢复、迁移或修改任何新加坡环境；不得删除账号级 CAM 用户、访问密钥、账单、域名或其他腾讯云产品。

### 5.3 新环境创建门禁

- 购买页或创建页必须显示上海、PostgreSQL、免费体验版和应付金额 `0 元`。
- 不勾选按量付费、自动续费、付费资源包或其他附加服务。
- 页面若未提供 PostgreSQL 免费选项，或最终订单金额不是 `0 元`，立即停止。
- 创建成功后记录新环境 ID、环境类型、地域、套餐、到期日和当期资源点；通过官方环境信息或 PostgreSQL 页面再次证明 PG 模式已启用。

## 6. 单一上海地域迁移

### 6.1 代码和配置

- 把 CloudBase API 配置、V3 SDK 运行时、网站浏览器 SDK、user migration Adapter 和 Scanner 候选中的固定地域从 `ap-singapore` 改为 `ap-shanghai`。
- 类型继续使用单一字符串字面量，不扩展为任意 region 或地区枚举。
- `CLOUDBASE_REGION`、`TCB_REGION` 与 Scanner/TMS/IMS 地域不一致时继续失败关闭。
- 删除只服务新加坡环境的测试断言、文档和示例；以等价上海断言替换，不保留旧别名。
- 不改动业务状态机、HTTP DTO、审核语义或桌宠契约。

### 6.2 规格替代关系

本规格仅在“阶段 2C 开发环境地域”范围内替代以下旧结论：

- `2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md` 中固定 `ap-singapore` 的开发环境配置。
- `2026-08-31-website-stage-2-3-local-closure-design.md` 中“继续固定 `ap-singapore`”的条款。
- `docs/operations/cloudbase-deployment.md` 中开发环境只能使用 `ap-singapore` 的现行说明。

上述文档的 SDK、PG、存储、审核、管理员权限和失败关闭边界继续有效。正式生产环境地域不由本规格自动裁决；后续生产计划须以阶段 2C 的上海证据重新决定。

## 7. 阶段 2C 云端实施顺序

所有步骤串行执行，前一步没有可验证证据时不得进入下一步。唯一例外是第 5 步内部为验证整轮锁而发起的两次同 plan 受控并发 push；该实验期间禁止其他云端写操作，任一任务进入未知状态即停止，不构成并行部署授权：

1. 完成本地上海地域 TDD 改动和网站链验证。
2. 销毁旧传统模式环境并创建上海 PG 免费环境。
3. 生成只读 migration inventory，核对 13 个版本、顺序与 checksum。
4. 使用现有 manager SDK user migration Adapter 执行 preview、push 和 task poll；不得把收到 `TaskId` 当成成功。
5. 验证整轮锁、并发拒绝、任务失败、重复执行和续跑，不修改历史 migration。
6. 创建或验证 PG Storage 中的私有 `ai-pet-private` Bucket 契约和权限，验证短期上传、对象身份与短期下载 URL。
7. 构建并部署三个现有云函数，只配置每个 loader 实际读取的最小环境变量；投稿开关保持关闭。
8. 将现有 Scanner Dockerfile 部署为 `ai-pet-package-scanner`，Node 22、非 root、最小实例 0、单实例并发 1、内存至少 1 GB，并验证 `/healthz`。
9. 在明确零费用且不会自动转付费时，使用腾讯内容安全免费试用完成 TMS/IMS smoke；否则记录外部阻塞。
10. 捕获脱敏的真实 HTTP 网关 event/path 和管理员请求头行为，裁决唯一 Router，配置最小路由、认证、CORS 和安全域名。
11. 配置审核 worker 与 cleanup 的定时触发器，验证幂等和失败关闭。
12. 执行完整开发环境 smoke，更新部署手册、内容审核手册与网站验收记录。

## 8. 凭据、安全与隐私

- 不从浏览器 Cookie、Local Storage、密码管理器或页面内部状态提取登录凭据。
- 管理 SDK 所需凭据必须使用腾讯云官方路径创建或取得，采用最小权限和临时有效期；创建持久访问密钥前必须在行动时另行确认。
- SecretId、SecretKey、SessionToken、API Key、HMAC Secret、管理员邮箱和状态令牌不得写入仓库、终端历史、构建日志、验收文档或前端变量。
- `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` 只能是官方定义的公开 Publishable Key；创建该持久密钥前按浏览器安全规则取得行动时确认。
- `SCANNER_HMAC_SECRET` 与 `SCANNER_INTERNAL_SECRET` 使用同一随机值但保留进程内不同变量名；不得复制到无关函数。
- 管理员路径同时经过网关认证和应用层身份、邮箱白名单与角色校验；网关认证不能替代应用层授权。
- 投稿对象始终位于私有存储；公开下载只签发短期地址，不暴露对象长期地址或服务端凭据。

## 9. 免费套餐失败处理

- 免费体验版的资源点、云函数内存/超时、云托管规格、日志保留或内容安全试用任何一项不足时，记录实际限制、控制台证据和受阻验收项。
- 不把三个云函数改造成第二套云托管架构，不降低 Scanner、审核或清理语义来伪造通过。
- 不因免费限制跳过真实网关、对象存储、事务、锁、续跑、管理员认证或扫描失败关闭验证。
- 资源点接近耗尽时立即暂停 Scanner、停止 smoke 并保留已完成证据；不得开启按量付费。
- 若腾讯云环境销毁进入隔离期导致免费名额未立即释放，等待官方释放或向用户报告；不得购买临时付费环境。
- 任何步骤出现价格不明、账户权限不足、验证码、持久密钥创建、付费确认或不可逆删除，都停在提交动作之前按规则交由用户处理或确认。

## 10. TDD、验证与验收

### 10.1 本地 RED → GREEN → REFACTOR

1. RED：把相关测试改为期望 `ap-shanghai`，确认现有 `ap-singapore` 实现失败。
2. GREEN：以最小代码把唯一固定地域替换为 `ap-shanghai`。
3. REFACTOR：删除新加坡旧断言、旧示例和只服务旧地域的说明，不引入通用地域抽象。
4. 定向验证：CloudBase API 配置/运行时、网站 CloudBase 客户端、migration Adapter、Scanner candidate 工具测试。
5. 范围验证：`pnpm.cmd verify:cloudbase`、`pnpm.cmd verify:website`、必要的 `verify:web-chain`、scope、ownership 与 `git diff --check`。

### 10.2 云端证据

阶段 2C 只有在同一新上海 PG 环境中观察到以下结果才能写为通过：

- 免费套餐、地域与 PG 模式证据明确，实际支付为 0 元。
- 13 个 migration preview/push/task 最终成功，重复执行无漂移；锁、并发、失败和续跑有真实证据。
- 三个函数和 Scanner 使用预期版本、入口、最小变量及失败关闭配置。
- 私有对象不可公开列出，上传、对象身份核对和下载短期 URL 生效。
- 共享包投稿默认暂停，反馈不直接公开；状态令牌只位于 URL Fragment。
- 系统审核、人工转审、普通批准、管理员强制发布、删除和恢复符合现行规格，且扫描事实不可改写。
- 错误或非管理员令牌返回 401/403；真实网关兼容管理员请求头。
- Scanner 对干净包、EICAR、超时、IMS 错误和并发限制均按协议返回。
- cleanup 和 moderation worker 定时触发、幂等和失败关闭可观察。
- 资源点没有产生超额账单，未开启任何付费能力。

### 10.3 状态裁决

- 全部本地和云端强制项通过：阶段 2C 写为 `pass`，共享包投稿是否解冻另行裁决。
- 免费套餐限制、外部试用不可用或任何强制 smoke 未通过：阶段 2C 写为 `blocked`，保留投稿关闭。
- 未执行或只有本地证据：写为 `unverified`，不得宣称远端部署、发布或上线成功。

## 11. 后续生产边界

上海免费环境只用于阶段 2C 开发验证。即使阶段 2C 通过，也不自动成为正式生产环境。正式上线前仍须单独制定阶段 5 生产计划，评估：

- 是否继续使用上海地域；
- 正式套餐、资源点、SLA、日志、告警、备份与恢复；
- 正式域名、HTTPS、CSP、CORS 和 DNS 切换；
- 生产 migration、函数、Scanner、静态站点的顺序与回滚；
- 生产环境与开发环境的数据库、Bucket、密钥、管理员、域名和告警隔离。

任何生产付费或套餐升级仍需用户独立授权，本规格不构成购买或正式上线授权。

## 12. 官方事实来源

- [云开发环境介绍](https://docs.cloudbase.net/quick-start/env-overview)：PG 模式只能在新建环境时选择，存量传统模式不能切换。
- [PG 模式概述](https://docs.cloudbase.net/quick-start/pg-overview)：PostgreSQL 作为身份、存储、权限与业务数据的统一底座。
- [CloudBase 价格文档](https://cloud.tencent.com/document/product/876/75213)：免费环境数量、销毁后重新创建、零元套餐与付费限制。
- [CloudBase 资源点价格文档](https://cloud.tencent.com/document/product/876/127357)：上海 PG 环境支持能力、免费资源点和环境类型差异。
- [CloudBase 环境销毁](https://cloud.tencent.com/document/product/876/40467)：不可恢复的资源删除范围、销毁次数和限制。
- [CloudBase PostgreSQL manager-node API](https://docs.cloudbase.net/api-reference/manager/node/postgresql)：preview、push、task poll 与 migration checksum 契约。
- [PostgreSQL 数据库](https://docs.cloudbase.net/database/configuration/db/postgresql/initialization)：PG 环境初始化与 `ExecutePGSql` 管控面能力。
- [云函数基础配置](https://docs.cloudbase.net/cloud-function/function-configuration/config)：函数内存与超时时间的基础范围。
- [CloudBase Run 服务设置](https://cloud.tencent.com/document/product/1243/77197)：最小实例、缩容到零与持续费用关系。
- [HTTP 访问服务](https://cloud.tencent.com/document/product/876/130728)：网关路径、资源路由、认证、限频与请求头能力。
- [COS 预签名 URL](https://cloud.tencent.com/document/product/436/68284)：私有对象的限时上传与下载访问。
- [文本内容安全](https://cloud.tencent.com/document/product/1124/37119) 与 [图片内容安全](https://cloud.tencent.com/document/product/1125/37109)：试用额度、服务开通与后续计费边界。
