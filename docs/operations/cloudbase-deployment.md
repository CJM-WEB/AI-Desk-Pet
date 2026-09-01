# CloudBase 部署与上线手册

本文是网站阶段 2C 零费用人工审核方案的现行运维入口。它只描述上海 CloudBase PostgreSQL 开发环境的最小运行面；不构成远端操作授权，更不构成正式生产上线授权。

> 当前状态（2026-09-01）：`remote: unverified`。本地实现、测试和真实 Docker 候选已完成验证；尚未创建上海 PostgreSQL 环境、执行远端 migration、部署函数、配置私有 Bucket、身份、网关或静态托管。共享包匿名投稿开关保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。

## 1. 正式运行面与禁止部署项

上海开发环境只允许部署下列组件：

- CloudBase PostgreSQL 与顺序前向 migration；
- 私有 `ai-pet-private` Bucket；
- `ai-pet-api` 与 `ai-pet-cleanup` 云函数；
- 身份认证、最小 HTTP 网关与静态网站托管。

以下旧能力已退役，**禁止部署、配置或作为冒烟前提**：CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 协议和 Scanner Secret。云函数构建产物只应包含 `api` 与 `cleanup`。

任何创建页若不能同时证明上海、PostgreSQL、应付 `0 元`、按量付费关闭和自动续费关闭，立即停止。不得通过购买、开启按量、创建持久云密钥或恢复已退役组件绕过该门禁。

## 2. 环境隔离与投稿开关

1. 开发与正式生产环境必须分离，分别保存环境标识；数据库、Bucket、函数、域名、密钥和告警不得复用。
2. 服务端目标地域为 `ap-shanghai`；正式生产地域由独立生产计划重新裁决。
3. 共享包投稿保持关闭：

   ```text
   SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
   ```

4. `pnpm.cmd plan:cloudbase-migrations` 仅生成本地 checksum plan，不读取凭据、不连接或写入远端数据库。远端 migration 只能在获得单独授权后，由现有 Adapter 顺序执行；不得通过控制台手工复制 SQL。

## 3. PostgreSQL 与私有对象存储

1. 先在同一上海 PostgreSQL 环境顺序执行全部前向 migration；不得修改、重排或回滚历史 migration。失败只能用新的前向 migration 修复。
2. 创建仅服务端可访问的私有 Bucket，并配置为 `PRIVATE_BUCKET_ID`。禁止公开读写；上传和下载只使用短期签名地址。
3. 正式安装包使用独立发布目录和 CDN 策略，不得复用匿名投稿隔离区。
4. 真实 PostgreSQL 的锁、并发、任务失败和续跑必须以远端 smoke 证据确认；本地 PostgreSQL 结果不能替代该证据。

## 4. 云函数、身份与网关

`ai-pet-api` 负责公开投稿、状态、公开读取与管理员 API；`ai-pet-cleanup` 负责既有隔离对象和互动幂等账本的清理。仅配置各自 loader 实际读取的最小变量，密钥不得写入仓库、构建日志、前端变量或本手册。

身份认证启用邮箱 OTP，并预先创建唯一管理员账号。管理员路径同时经过网关认证与应用层身份、邮箱白名单和角色校验；网关认证不能替代应用层授权。公开投稿与状态路径允许匿名访问，仍由限流、管理员审批和私有对象边界保护。

配置最小网关时，必须先捕获脱敏的真实 event/path，确认平台传递的路径形状后再选择唯一 Router。CORS 只允许实际开发或正式站点来源及所需方法/请求头，不允许带认证信息的通配来源。

## 5. 静态托管与观测

部署静态网站前先在本地运行：

```powershell
pnpm.cmd --filter @myself/website build
```

将实际 HTTPS 域名加入 Web 安全域名；配置 CSP 与已验证 API 前缀匹配的 CORS。日志、告警和审计不得记录状态令牌、签名 URL、管理员令牌、OTP、密钥或私有对象地址。

监控函数、网关、数据库和存储的错误、5xx/429、审核积压、异常上传和清理失败；费用、资源点、自动续费和按量开关须以远端实际页面为准。远端未验证前不得填写费用、版本或部署成功结论。

## 6. 投稿与人工审核部署后语义

- 新共享包完成私有上传后直接进入 `manual_review_pending`。
- 新反馈和建议创建后也直接进入 `manual_review_pending`，管理员可走普通 `approve`，发布依据为 `standard`。
- 新共享包没有当前有效系统扫描通过证据时，普通 `approve` 必须返回 `TECHNICAL_SCAN_REQUIRED`；管理员只能完成独立风险确认后执行 `force_publish`，发布依据为 `admin_override`。
- 强制发布不改变历史扫描事实、结构不变量、审计、状态版本或公开风险提示。

## 7. 本地 Docker 辅助检查

共享包只在管理员本机进行一次性 Docker CLI 检查，不上传报告、不调用云服务，也不生成系统通过证据。构建时 `freshclam` 需要网络下载病毒库；运行时必须断网。`CLAMAV_DB_REFRESH_DATE` 按 UTC 日期使构建阶段每日刷新，候选验证拒绝超过 7 天的病毒库，因此超过 7 天必须重新构建并复验。

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

获得远端授权后，在同一环境验证：migration、私有对象短期上传/下载、匿名与管理员授权、新投稿直入人工队列、反馈普通批准、共享包强制发布风险提示、点赞、评论、下载和 cleanup。共享包投稿开关继续关闭，直到另有裁决。

本地验证通过不等于远端部署、阶段 2C 通过或正式上线。正式生产还需要独立规格和授权，单独裁决套餐、域名、备份、监控、迁移与回滚。
