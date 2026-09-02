# CloudBase 部署与上线手册

本文是网站阶段 2C 零费用人工审核方案的现行运维入口。它只描述上海 CloudBase PostgreSQL 开发环境的最小运行面；不构成远端操作授权，更不构成正式生产上线授权。

> 当前状态（2026-09-02）：`remote: pass`。上海免费开发环境 `ai-pet-scanner-dev-d0cp…826` 的 16 条 migration、私有 Bucket、两个函数、邮箱 OTP、最小网关、静态托管、备案根域名 `cjmwebsite.cn`、公开反馈／建议正文及其点赞、共享包强制发布/风险披露/互动/隔离清理和官方下载计数均已实际验证；cleanup 每日 timer 配置已创建并启用，函数直调和真实清理通过，自然定时投递尚未观察。用户已确认不实现共享资源留言或回复。共享包匿名投稿开关保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。根域名只接入本开发环境用于验收，不是正式生产上线，现行证据见 `website-stage-2c-zero-cost-manual-review-acceptance.md`。

## 1. 正式运行面与禁止部署项

上海开发环境只允许部署下列组件：

- CloudBase PostgreSQL 与顺序前向 migration；
- 私有 `ai-pet-private` Bucket；
- `ai-pet-api` 与 `ai-pet-cleanup` 云函数；
- 身份认证、最小 HTTP 网关与静态网站托管。

以下旧能力已退役，**禁止部署、配置或作为冒烟前提**：CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 协议和 Scanner Secret。云函数构建产物只应包含 `api` 与 `cleanup`。

任何创建页若不能同时证明上海、PostgreSQL、应付 `0 元`、按量付费关闭和自动续费关闭，立即停止。不得通过购买、开启按量、未经批准创建持久云密钥或恢复已退役组件绕过该门禁。

## 2. 环境隔离与投稿开关

1. 开发与正式生产环境必须分离，分别保存环境标识；数据库、Bucket、函数、域名、密钥和告警不得复用。
2. 服务端目标地域为 `ap-shanghai`；正式生产地域由独立生产计划重新裁决。
3. `cjmwebsite.cn` 当前只指向本开发环境；既有 `www.cjmwebsite.cn` 解析保持不变。正式生产环境不得默认复用当前环境、证书、密钥、日志或数据库。
4. 共享包投稿保持关闭：

   ```text
   SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
   ```

5. `pnpm.cmd plan:cloudbase-migrations` 仅生成本地 checksum plan，不读取凭据、不连接或写入远端数据库。远端 migration 只能在获得单独授权后，由现有 Adapter 顺序执行；不得通过控制台手工复制 SQL。

## 3. PostgreSQL 与私有对象存储

1. 同一上海 PostgreSQL 环境已通过 CLI 对比确认全部 16 条前向 migration 一致，最新版本 `20260901020000`，没有 pending 或 conflict；不得修改、重排或回滚历史 migration。失败只能用新的前向 migration 修复。
2. 仅服务端可访问的私有 Bucket `ai-pet-private` 已存在且 `public=false`，并配置为 `PRIVATE_BUCKET_ID`。禁止公开读写；上传和下载只使用短期签名地址。
3. 正式安装包使用独立发布目录和 CDN 策略，不得复用匿名投稿隔离区。
4. 真实 PostgreSQL 的锁、并发、任务失败和续跑必须以远端 smoke 证据确认；本地 PostgreSQL 结果不能替代该证据。

## 4. 云函数、身份与网关

`ai-pet-api` 负责公开投稿、状态、公开读取与管理员 API；`ai-pet-cleanup` 负责既有隔离对象和互动幂等账本的清理。仅配置各自 loader 实际读取的最小变量，密钥不得写入仓库、构建日志、前端变量或本手册。

两个函数共同配置以下变量（不在此记录任何值）：

```text
CLOUDBASE_ENV_ID
PRIVATE_BUCKET_ID
```

`ai-pet-api` 额外配置：

```text
CLOUDBASE_API_KEY
ADMIN_EMAIL
ABUSE_HMAC_SECRET
SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
```

`ai-pet-cleanup` 额外配置：

```text
CLOUDBASE_API_KEY
```

以上清单与当前 `config.ts` 的两个 loader 对齐。不得为 worker、Scanner 或腾讯内容安全添加变量，也不得复制旧的 HMAC、Scanner Secret 或腾讯凭据。

两个 Event 函数在 HTTP 网关真实执行中不得把调用 `context` 作为私有 PG Storage 身份。RDB 与 Storage 共用同一 CloudBase V3 服务端 API Key 实例，避免第二次初始化覆盖同环境请求身份；该 Key 只存在于函数环境变量，必须限期、可轮换且不得进入响应、前端或普通日志。管理员 Bearer Token 与邮箱白名单仍是独立授权门，不能用服务端 Key 替代。

`cloudbaserc.json` 只为 `ai-pet-cleanup` 声明一个 `ai-pet-cleanup-daily` timer，七段 Cron 为 `0 0 4 * * * *`。具体钟点按 CloudBase 控制台显示的触发器时区解释；清理函数只按数据库绝对时间挑选已到期记录，因此最坏只增加不足 24 小时等待。不要给 API 函数添加定时器，也不要恢复 moderation worker 调度。

身份认证已启用邮箱 OTP，唯一管理员账号为 ACTIVE；真实 OTP 登录和管理员双头认证已通过。管理员路径同时经过网关认证与应用层身份、邮箱白名单和角色校验；客户端在同一 access token 上同时发送 `Authorization: Bearer <token>`（网关）与 `x-ai-pet-admin-token: <token>`（应用层复验），网关认证不能替代应用层授权。公开投稿与状态路径允许匿名访问，仍由限流、管理员审批和私有对象边界保护。

默认网关域名已使用两条 `SCF` 路由：公开 `/api` 不启用网关认证；管理员 `/api/v1/admin` 启用网关认证。备案根域名额外使用 `/` 静态托管、公开 `/api` 和管理员 `/api/v1/admin` 三条路由；公开 API 按客户端 IP 限制为总 QPS 100、单客户端 10，管理员 API 按用户限制为总 QPS 100、单用户 10。最长前缀使管理员路由优先；公开 `GET /api/v1/community` 返回 200，未认证管理员请求在网关返回 401 `MISSING_CREDENTIALS`。

免费体验版调用 `CreateAuthDomain` 会被平台以 `OperationDenied.FreePackageDenied` 拒绝，因此不得购买套餐绕过。公开站构建把 `NEXT_PUBLIC_API_BASE_URL` 固定为 `https://cjmwebsite.cn/api/v1`，在备案根域名上走同源请求；管理员邮箱 OTP 继续从已存在于 Web 安全域名列表的默认静态托管域名进入，其跨域调用备案根域 API 已用真实已登录工作台验证。不得配置带认证信息的通配 CORS 来源。

## 5. 静态托管与观测

部署静态网站前先在本地运行：

```powershell
pnpm.cmd --filter @myself/website build
```

静态网站已使用以下三个前端环境变量构建：`NEXT_PUBLIC_CLOUDBASE_ENV_ID`、`NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`、`NEXT_PUBLIC_API_BASE_URL=https://cjmwebsite.cn/api/v1`；67/67 个构建文件上传成功，删除不再被新页面引用的旧哈希产物后，静态托管对象总数为 73，其中 6 个为平台维护的 `__auth` 与 `cloud-admin` 文件。根域 CNAME 指向 `cjmwebsite.cn.cdn.dnsv1.com`，CloudBase 域名状态与两项 DNS 状态均为成功，HTTPS 首页与公开 API 返回 200。日志、告警和审计不得记录状态令牌、签名 URL、管理员令牌、OTP、密钥或私有对象地址。

上海开发环境函数日志已临时开通且未购买独立日志资源包，用于定位函数、网关和数据库边界错误；CloudBase 系统日志会保存函数响应摘要，`IgnoreSysLog` 真实试验也没有消除该摘要。因此当前只允许测试数据且共享包投稿保持关闭，接入真实投稿或正式上线前必须关闭日志或先形成并验证独立脱敏方案。日志不得替代长期监控与告警。域名验收后套餐页显示当前计费周期总资源点 3000、已使用 81.39，按量付费开关关闭，HTTP 加速请求数为 0、流量为 0 Byte；资源点主要来自持续运行的 PostgreSQL。没有购买、升级或开启按量，但该观察不替代正式生产费用结论。

## 6. 投稿与人工审核部署后语义

- 新共享包完成私有上传后直接进入 `manual_review_pending`。
- 新反馈和建议创建后也直接进入 `manual_review_pending`，管理员可走普通 `approve`，发布依据为 `standard`。
- 新共享包没有当前有效系统扫描通过证据时，普通 `approve` 必须返回 `TECHNICAL_SCAN_REQUIRED`；管理员只能完成独立风险确认后执行 `force_publish`，发布依据为 `admin_override`。
- 强制发布不改变历史扫描事实、结构不变量、审计、状态版本或公开风险提示。

## 7. 本地 Docker 辅助检查

共享包只在管理员本机进行一次性 Docker CLI 检查，不上传报告、不调用云服务，也不生成系统通过证据。管理员从详情中的“下载待审 ZIP（5分钟）”取得短期地址；该地址只出现在管理员 DTO，既不进入公开 DTO，也不增加公开下载计数。构建时 `freshclam` 需要网络下载病毒库；运行时必须断网。`CLAMAV_DB_REFRESH_DATE` 按 UTC 日期使构建阶段每日刷新，候选验证拒绝超过 7 天的病毒库，因此超过 7 天必须重新构建并复验。

```powershell
$clamavRefreshDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
docker build --file apps/package-scanner/Dockerfile `
  --build-arg "CLAMAV_DB_REFRESH_DATE=$clamavRefreshDate" `
  --tag ai-pet-package-scanner:local .

$archivePath = (Resolve-Path '.\package.zip').Path
docker run --rm --network none --read-only --cap-drop ALL `
  --tmpfs /tmp/scan:rw,noexec,nosuid,nodev,mode=1777 `
  --mount "type=bind,source=$archivePath,target=/input/package.zip,readonly" `
  ai-pet-package-scanner:local /input/package.zip
```

镜像默认以非 root 的 `scanner` 用户运行。`--read-only` 固定根文件系统，输入 ZIP 以只读方式挂载；`/tmp/scan` 是唯一可写 tmpfs，必须带 `mode=1777`，否则非 root ClamAV 无法创建临时文件。CLI 只接受一个 ZIP；成功仅表示结构、图片解码和 ClamAV 检查完成，并始终要求人工查看图片。EICAR、非法结构、超时或病毒库不可用都失败关闭。

## 8. 远端开发环境 smoke 与发布边界

同一上海环境已经验证：migration、匿名与管理员授权、反馈直入人工队列、普通批准、公开读取、点赞与撤赞、删除隔离、审计记录、官方下载计数、私有对象短期上传/下载、共享包两步强制发布、三处公开风险提示、幂等下载计数和完整物理清理。cleanup 每日 timer 的名称、类型、Cron 与启用状态已核对，函数直调成功，但尚未观察一次平台自然定时投递。用户已确认规格中的“评论”仅指公开反馈／建议正文，不包含共享资源留言或回复；现有反馈发布、公开读取与点赞链即为该验收。共享包投稿开关继续关闭，直到另有裁决。

本次已按以下合同验证官方安装包计数，后续重新部署仍须复验：公开 `POST /api/v1/official-downloads/windows/click` 只接受空对象并只返回空数据；管理员 `GET /api/v1/admin/metrics/official-windows-download` 经现有管理员认证后才返回累计值；公开页面、公开 DTO 与静态导出均不含累计值。上述计数是被服务端接受的点击，既不代表下载、安装、独立用户，也不应把原始 IP、User-Agent、下载地址或管理员令牌写入日志。

单独的本地验证或开发域名可访问不能证明阶段 2C 通过；现行验收记录已经汇总完整远端证据并将阶段 2C 关闭为 `pass`。该状态仍不等于正式上线；正式生产需要独立规格和授权，单独裁决生产环境、套餐、域名切换、备份、监控、迁移与回滚。
