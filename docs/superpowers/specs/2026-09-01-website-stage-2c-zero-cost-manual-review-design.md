# 网站阶段 2C 零费用人工审核设计

> 日期：2026-09-01
> 分支：`WebsiteExtension`
> 状态：已于 2026-09-01 获用户确认
> 修订：2026-09-02，基于上海真实链证据，按用户持续授权收敛服务端身份、cleanup 低频调度与备案根域名开发验收例外
> 替代范围：在网站阶段 2C 的审核与部署路径内，替代“必须部署 CloudBase Run Scanner、腾讯 TMS/IMS 和 moderation worker”的旧结论；并以真实 HTTP 网关执行证据替代旧的 `context` 临时身份初始化约束；继续沿用上海 PostgreSQL 免费环境、私有存储、唯一管理员、强制发布、审计和公开风险披露边界
> 验收事实源：`docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`

## 1. 目标

以“能不加就不加，能减则减”为首要原则，把网站共享资源和反馈链改成可以长期维持的零额外费用方案：

1. 云上仅承载网站、CloudBase PostgreSQL、私有存储、API 函数和 cleanup 函数。
2. 新投稿完成后直接进入 `manual_review_pending`，不等待远程自动审核。
3. 共享包由管理员下载后，通过本地 Docker 中的 ClamAV 与既有包结构校验进行辅助检查。
4. 没有当前有效系统扫描通过证据的共享包只允许使用现有 `force_publish` 发布，并永久保留 `admin_override` 公开警告和完整审计。
5. 删除 CloudBase Run Scanner、腾讯 TMS/IMS、远程 Scanner HTTP/HMAC 协议和 moderation worker，不保留双轨运行路径。

## 2. 非目标与硬边界

- 本规格只涉及官网、CloudBase API、包扫描器、数据库 migration、网站测试与运维文档；不得修改桌宠、角色工作室或桌面 Agent 代码。
- 本轮不执行正式生产部署、不切换正式生产流量。用户于 2026-09-02 另行明确批准把已备案根域名 `cjmwebsite.cn` 绑定到上海开发环境用于阶段 2C 验收；该例外只覆盖根域名测试接入，不改变开发环境属性，不触碰既有 `www.cjmwebsite.cn` 解析，也不等于正式上线。
- 不购买套餐、资源包或内容安全服务，不开启按量付费、自动续费或 CloudBase Run。
- 不把本地扫描结果伪造成 `isolated-scanner` 系统通过证据，不把人工判断写成自动扫描通过。
- 不降低私有对象、固定对象键、文件大小/MIME、ZIP 结构、管理员认证、状态版本、幂等和审计约束。
- 不增加第二套审核状态机、第二套数据库或新的云服务适配层。

## 3. 采用方案

### 3.1 云端最小运行面

上海 CloudBase 免费环境只部署：

- PostgreSQL 数据库及顺序 migration；
- 私有 `ai-pet-private` Bucket；
- `ai-pet-api` 云函数；
- `ai-pet-cleanup` 云函数；
- 静态网站托管、身份认证与最小 HTTP 路由。

以下能力从正式路径删除且不部署：

- `ai-pet-moderation-worker`；
- CloudBase Run `ai-pet-package-scanner`；
- 腾讯文本内容安全 TMS；
- 腾讯图片内容安全 IMS；
- Scanner 的公网 HTTP 服务、内部 Secret、HMAC 请求签名和远程下载协议。

免费套餐无法提供上述能力不再构成阶段 2C 阻断，因为它们已被本规格从目标架构移除。

### 3.2 投稿状态

- 共享包仍按 `prepare → 私有直传 → finalize` 完成；`finalize` 继续校验对象、大小、MIME 和固定对象键，成功后直接返回 `manual_review_pending`。
- 反馈和建议创建成功后直接返回 `manual_review_pending`。
- 部署 migration 时，遗留 `system_reviewing` 投稿原子迁移到 `manual_review_pending`，状态版本递增，并清除未完成的 worker 租约与重试状态；历史扫描结果、风险摘要和自动拒绝原因不被改写。
- `system_reviewing` 继续作为历史兼容状态保留在共享枚举与数据库约束中；管理员仍可手动把历史 `system_reviewing` 或 `auto_rejected` 投稿转入人工队列。

### 3.3 管理员发布权

- 反馈和建议可由管理员普通 `approve`，发布依据为 `standard`。
- 共享包若存在当前归档、当前状态版本且 24 小时 TTL 内的有效系统通过证据，可继续普通 `approve`；这是历史兼容能力。
- 所有新共享包默认没有系统通过证据，只能在 `manual_review_pending` 状态使用两步确认的 `force_publish`。
- `force_publish` 必须携带 `ADMIN_OVERRIDE_ACCEPTED`、理由、期望版本和幂等键；数据库原子写入 `published`、`admin_override`、动作快照和管理员审计。
- 公开列表、详情和下载入口继续显示“管理员人工放行，未通过系统安全验证”；本地 Docker 报告不能消除此标记。

### 3.4 本地 Docker 扫描

包扫描器改成一次性 CLI，而不是常驻网络服务：

```powershell
docker run --rm --network none --read-only --cap-drop ALL `
  --mount type=bind,src=<本地待审目录>,dst=/input,readonly `
  ai-pet-package-scanner:local /input/<归档文件名>.zip
```

CLI 复用已有 ZIP 防护、预算、路径、图片实际解码、角色包结构和 ClamAV 校验。图片内容不调用云服务，只记录“需要管理员人工查看”。输出为本地 JSON 报告，至少包含归档摘要、结构结论、ClamAV 结论、图片人工检查提示和总体 `manualReviewRequired: true`。

容器必须满足：

- `--network none` 可运行；
- 输入目录只读挂载；
- 非 root 用户；
- 不接收腾讯云凭据、管理员令牌或 Scanner Secret；
- 干净包返回成功，EICAR 和结构非法包失败关闭；
- 报告不得包含私有云对象地址、凭据或无必要的主机绝对路径。

本地报告由管理员自行保存或查看，不上传数据库，也不改变 `publication_basis`。这样避免新增“本地报告上传、签名和可信来源”体系。

## 4. 数据库减法与历史保留

采用两个不可变前向 migration：

1. 第一条切换新投稿为人工队列并迁移未完成状态；暂时保留 worker 专用列和 RPC，保证应用改造过程中每个提交均可验证。
2. 云函数与 Adapter 已不再引用 worker 后，第二条删除 `claim_moderation_jobs`、`apply_moderation_decision`、`record_moderation_failure` 以及只服务 worker 的租约、重试和告警列/索引。

以下历史与安全结构必须保留：

- `moderation_results` 及历史记录；
- `risk_summary`、`auto_rejection_reason`、`publication_basis`；
- `admin_audit_logs`、请求快照、结果快照和幂等约束；
- 发布结构触发器与资产唯一索引；
- `apply_admin_action`、公开读取、下载、互动和 cleanup RPC。

已有 migration 不修改、不重排、不删除；新环境从第一条历史 migration 顺序执行到最新版本，最终只留下人工审核正式路径。

## 5. 应用与契约减法

### 5.1 保留

- 网站投稿、状态查询、管理员队列、详情、点赞、评论、下载和风险提示。
- CloudBase API Router、存储 Adapter、管理员身份与授权。
- `force_publish` 及其两步前端确认。
- cleanup 定时任务。
- 包扫描器的纯扫描内核和本地 Docker 构建。

### 5.2 删除

- CloudBase API 的 moderation worker 函数、服务、Tencent TMS/IMS Adapter、远程 Scanner Client、worker 配置与测试。
- CloudBase 构建和部署描述中的 moderation worker 入口。
- 包扫描器 HTTP server、健康接口、HMAC 签名、远程下载、腾讯 IMS Adapter 与共享 Scanner 网络协议。
- 只覆盖自动审核、后到 worker、远程 Scanner 超时/重试的 Memory E2E 入口和测试。
- 两个包中的 `tencentcloud-sdk-nodejs` 依赖及不再引用的锁文件项。

删除后仓库只能存在一条正式路径：云端人工队列 + 管理员本地扫描 + `force_publish`。

## 6. 安全、隐私与失败处理

- 匿名用户只能创建投稿和查看自己的状态；不能调用管理员动作或读取私有对象。
- 管理员下载仍使用短期签名 URL；本地 Docker 不读取云凭据。
- 普通批准缺少有效系统证据时继续返回 `TECHNICAL_SCAN_REQUIRED`，客户端不得自动降级为强制发布。
- 本地扫描失败、超时、ClamAV 数据库不可用、图片无法解码或包结构非法时，管理员界面状态不自动变化；管理员必须主动判断是否继续强制发布。
- `force_publish` 不得绕过投稿结构约束，也不得改写历史扫描事实。
- 上海环境中的两个函数保持 Event 类型。真实 HTTP 网关调用证明，把该次调用的 `context` 交给第二个 CloudBase V3 实例后不能读取同环境私有 PG Storage；同一对象用函数内既有服务端 API Key 可读取。为避免双实例身份覆盖，RDB 与私有 Storage 共用一个经批准、限期且可轮换的服务端 API Key 实例；管理员 Bearer Token、邮箱白名单和网关鉴权仍是独立的应用层授权门。
- 服务端 API Key 只能存在于云函数环境变量，不进入仓库、前端、响应、普通日志或验收记录；泄露或行动时暴露后立即轮换并使旧 Key 失效。
- cleanup 继续按既有保留期清理隔离对象，与审核方式无关；只为 cleanup 配置每日一次的低频定时触发器。Cron 时区以 CloudBase 控制台触发器页的标注为准，清理函数以数据库绝对时间判断到期，因此时区差异只改变一天内的执行钟点。
- 任何需要付费、开启按量或未经用户批准创建持久云密钥的步骤立即停止，不以新增代码绕过。

## 7. 部署顺序

1. 在当前分支完成契约、migration、CloudBase 减法、本地 Scanner 和网站 E2E 的 TDD 改造。
2. 运行完整 `verify:web-chain`，证明本地行为与减法边界一致。
3. 行动时再次核对旧上海环境的精确资源并取得不可逆删除二次确认。
4. 创建上海 PostgreSQL 免费环境；金额必须为 0 元，按量付费与自动续费关闭。
5. 顺序执行全部 migration，创建私有 Bucket，部署 API 与 cleanup 两个函数。
6. 配置身份、最小网关和静态托管；不部署 Run、TMS、IMS 或 moderation worker。
7. 如用户另行批准备案域名开发验收，则只把根域名接入同一上海环境，以同域 `/api/v1` 完成公开链验证；免费套餐不能新增 Web 安全域名时，不购买套餐，管理员继续使用既有安全域名入口。
8. 使用本地 Docker 检查测试共享包，再在开发环境验证人工队列、强制发布风险提示、点赞、评论、反馈和下载链。
9. 保持共享包匿名投稿开关关闭，记录开发环境验收；是否开放开发环境投稿另行裁决。

## 8. TDD 与验收

### 8.1 自动化

- 共享 HTTP Schema、服务和 Memory/生产 Adapter 均返回 `manual_review_pending`。
- PostgreSQL 从全部历史 migration 顺序执行，新投稿直入人工队列，遗留状态迁移且历史事实保留。
- 无系统通过证据的共享包普通批准失败，`force_publish` 成功并写入 `admin_override` 与审计。
- CloudBase 构建产物只包含 API 与 cleanup 两个入口；自动审核模块不可达且依赖已删除。
- 本地 Scanner CLI 在无网络、只读输入、非 root 容器中对干净包通过，对 EICAR/非法包失败关闭。
- 网站真实页面显示人工覆盖警告，点赞、评论、反馈、详情和下载链仍通过。
- `verify:cloudbase`、`verify:website`、`verify:web-chain`、scope、ownership 和 `git diff --check` 通过。

### 8.2 远端阶段 2C

只有同一上海 PostgreSQL 免费环境观察到以下结果，阶段 2C 才可写为 `pass`：

- 费用为 0 元，未开启按量付费或自动续费；
- 全部 migration 成功且无 checksum 漂移；
- 私有对象不能公开列出，短期上传/下载生效；
- 只有 API 与 cleanup 两个云函数；
- 新投稿直接进入人工队列；
- 反馈普通批准、共享包强制发布、公开风险提示、点赞、评论和下载符合契约；
- 本地 Docker 的干净包与 EICAR smoke 符合预期；
- 未部署 CloudBase Run、TMS、IMS 或 moderation worker。
- 经用户另行批准的备案根域名接入状态、HTTPS、静态页面、公开 API 与原管理员入口兼容性均有真实证据；该证据只属于开发环境。

本地通过但远端未执行时写为 `unverified`；外部免费环境能力不足时写为 `blocked`。任一状态都不等于正式生产上线。

## 9. 替代关系

- 本规格在阶段 2C 审核与部署范围内替代 `2026-09-01-website-stage-2c-shanghai-rebuild-design.md` 第 7、9、10 节中关于 Scanner 云托管、TMS/IMS、moderation worker 及其强制 smoke 的要求。
- 本规格扩展 `2026-08-31-admin-override-publication-design.md`：不再要求新共享包先经过系统审核，但不改变 `force_publish`、`admin_override`、真实扫描事实和公开风险标记。
- `2026-08-08-direct-manual-review-design.md` 中保留自动审核代码的过渡方案不再是正式路径；本规格要求验证替代路径后删除旧实现。
- 上海地域、PostgreSQL、零费用、私有存储和非生产边界继续服从 `2026-09-01-website-stage-2c-shanghai-rebuild-design.md`；Event 函数经 HTTP 网关执行时的服务端身份改由本规格第 6 节覆盖。
- 本规格第 6 节仅替代 `2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md` 第 50–51、118 行的 HTTP 网关执行身份结论；浏览器、管理员授权、短期 URL、私有 Bucket 和密钥不出日志等边界继续有效。

## 10. 官方依据

- [CloudBase 套餐与资源点](https://cloud.tencent.com/document/product/876/75213)：免费环境与资源点边界。
- [CloudBase Run 使用限制](https://docs.cloudbase.net/run/limitation)：CloudBase Run 需要按量付费；关闭按量后服务停止。
- [文本内容安全购买指南](https://cloud.tencent.com/document/product/1124/37119)：试用额度与到期后计费边界。
- [图片内容安全购买指南](https://cloud.tencent.com/document/product/1125/62796)：试用额度与到期后计费边界。
- [CloudBase PostgreSQL](https://docs.cloudbase.net/quick-start/pg-overview)：PG 环境的数据、身份和存储能力。
- [CloudBase V3 PG 初始化](https://docs.cloudbase.net/api-reference/webv3-pg/initialization)：记录服务端 API Key、运行时身份和 `context` 等官方初始化方式；本项目结合上海 HTTP 网关真实结果采用服务端 API Key。
- [CloudBase 定时触发器](https://docs.cloudbase.net/en/cli-v1/functions/trigger)：七段 Cron、配置结构与触发器管理方式。
- [CloudBase 自定义域名](https://docs.cloudbase.net/service/custom-domain)：备案域名、SSL 证书、CNAME 与接入限制。
- [CloudBase 增加安全域名 API](https://cloud.tencent.com/document/api/876/42764)：Web 安全域名用途与免费套餐拒绝错误码。
