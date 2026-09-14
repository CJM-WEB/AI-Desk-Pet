# CloudBase 部署与上线手册

本文是网站 CloudBase 最小运行面的现行运维入口。2026-09-11 起，本轮共享资源开放按[已确认规格](../superpowers/specs/2026-09-11-shared-resources-opening-design.md)沿用现有上海环境及用户已购个人版，直接人工审核、不执行 Scanner、不新建环境；其他范围仍遵守原隔离与授权边界。本文不代替具体远端操作授权或真实链路验收。

> 当前结果（2026-09-11）：个人版和 `cjmwebsite.cn` 精确安全来源已确认；`SHARED_PACKAGE_SUBMISSIONS_ENABLED=true`，API 正常且两个 CLS 绑定为空。真实官网上传、人工强制发布、三处风险提示、浏览器下载触发和匿名完整 ZIP 哈希核对均通过。测试包已软下架，投稿保持开启。投稿者专属状态页因浏览器工具策略拦截未验证；样本及证据范围见[本轮验收记录](2026-09-11-shared-resources-opening-acceptance.md)。

> 历史基线（2026-09-02）：`remote: pass`。上海免费开发环境 `ai-pet-scanner-dev-d0cp…826` 的 16 条 migration、私有 Bucket、两个函数、邮箱 OTP、最小网关、静态托管、备案根域名 `cjmwebsite.cn`、公开反馈／建议正文及其点赞、共享包强制发布/风险披露/互动/隔离清理和官方下载计数均已实际验证；cleanup 每日 timer 配置已创建并启用，函数直调和真实清理通过，自然定时投递尚未观察。用户已确认不实现共享资源留言或回复。当时共享包匿名投稿开关为 false。根域名只接入本开发环境用于验收，不是正式生产上线，该日期证据见 `website-stage-2c-zero-cost-manual-review-acceptance.md`。

> 历史修复（2026-09-09 08:39）：管理员根域入口自动转到已允许认证的默认托管域，实际观察验证码发送被平台接受、后续工作台恢复。API CLS 已解除绑定；投稿曾开启实测，但根域存储预检因安全来源限制返回 403，控制台添加根域要求升级套餐，因此当时恢复 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。当日用户已同意测试协议，上传仍未修复完成，免费默认测试域临时入口尚待裁决。没有修改首页视觉、放开存储权限或增加收费资源，详见[该日验收记录](website-login-upload-repair-2026-09-09.md)。该段仅保留历史事实，当前配置与本轮确认状态见上方。

> 最新安装包与下载入口（2026-09-14）：按用户要求从当前main重建Windows包并覆盖旧文件，2982126566字节，SHA-256与本地一致，详见[安装包替换验收](2026-09-14-latest-installer-replacement.md)。后续修复将按钮改为现有正式域 `cjmwebsite.cn`，解决默认域浏览器导航提示；带导航请求头的完整附件下载及11个网页候选发布、公开内容核验通过。浏览器可见新链接，下载事件等待因工具超时未完成，最终点击待人工确认，详见[直接下载修复验收](2026-09-14-direct-installer-download.md)。当前环境沿用此前购买的个人版，根域管理员入口保持；未改套餐、CDN、网关或其他云配置。

> 历史下载接入（2026-09-09）：用户当时同意沿用免费环境供少量测试；官网 Windows 下载入口接入同环境默认域的 `0.1.0-alpha.1` 安装包。旧约2.86 GB整包下载与SHA-256校验通过，证据见[历史接入验收](2026-09-09-website-installer-download.md)。同名文件现已被上方新版替换，按钮地址现为正式域；当前仍不承诺断点续传，安装卸载仍待人工确认。

> 入口补充（2026-09-03）：`www.cjmwebsite.cn` 已通过免费 Makers 独立入口以 301 跳到 `https://cjmwebsite.cn`，11:17 命令行普通网络实测四个 HTTP/HTTPS、根域/www 入口最终首页字节一致。浏览器缓存收敛另行记录，不承诺即时刷新。仅统一入口，不改变上述开发环境与正式上线边界；配置及证据见同一验收记录的 2026-09-03 补充节。

## 1. 正式运行面与禁止部署项

上海开发环境只允许部署下列组件：

- CloudBase PostgreSQL 与顺序前向 migration；
- 私有 `ai-pet-private` Bucket；
- `ai-pet-api` 与 `ai-pet-cleanup` 云函数；
- 身份认证、最小 HTTP 网关与静态网站托管。

以下旧能力已退役，**禁止部署、配置或作为冒烟前提**：CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 协议和 Scanner Secret。云函数构建产物只应包含 `api` 与 `cleanup`。

阶段 2C 的新建环境曾要求上海、PostgreSQL、应付 `0 元`、按量付费关闭和自动续费关闭；本轮已由用户明确改为沿用已购个人版，不再创建或购买环境。不得自行重复购买、开启按量、创建持久云密钥或恢复已退役组件。

## 2. 环境隔离与投稿开关

1. 开发与正式生产环境默认分离。2026-09-11 用户已明确批准本轮共享资源沿用上海 `ai-pet-scanner-dev-d0cpbc8094826`，不新建环境；此例外只覆盖本轮规格，其余环境复用仍需独立授权。
2. 服务端目标地域为 `ap-shanghai`；正式生产地域由独立生产计划重新裁决。
3. `cjmwebsite.cn` 继续指向本环境。`www.cjmwebsite.cn` CNAME 为 `www.cjmwebsite.cn.pages.dnsoe6.com`，由独立 Makers 项目 `cjmwebsite-www-redirect` 承接 HTTPS 并保留路径、查询参数跳到根域，不承载业务或连接数据库。根域 CNAME 保持 `cjmwebsite.cn.cdn.dnsv1.com`。其他生产用途不得由本轮例外推导复用授权。
4. 当前个人版和官网安全来源已核对，真实上传、人工发布和完整下载验收已通过，投稿开关保持开启；API CLS 响应日志须继续解除绑定。后续上传、审核或完整下载出现阻断时恢复 false，并读取确认。当前值：

   ```text
   SHARED_PACKAGE_SUBMISSIONS_ENABLED=true
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
SHARED_PACKAGE_SUBMISSIONS_ENABLED=true
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

2026-09-09 免费体验版曾以 `OperationDenied.FreePackageDenied` 拒绝新增安全域名；2026-09-11 已确认用户购买个人版，官网 `cjmwebsite.cn` 已加入精确安全来源。公开站构建继续把 `NEXT_PUBLIC_API_BASE_URL` 固定为 `https://cjmwebsite.cn/api/v1`；2026-09-14只读复核当前线上管理员来源已是根域，后续构建沿用该值。安全来源配置成功不代替浏览器 PUT 实测，禁止带认证信息的通配 CORS 来源。

2026-09-09曾设置默认托管域作为 `NEXT_PUBLIC_ADMIN_ORIGIN`；该值已是历史配置。2026-09-14复核当前线上脚本后，构建保持 `NEXT_PUBLIC_ADMIN_ORIGIN=https://cjmwebsite.cn`，不得通过复用旧助手把管理员入口改回旧域。不同来源的 `/admin/` 会在初始化认证 SDK 前跳到配置来源，不携带查询或 fragment；同来源不循环。配置只接受纯 HTTPS origin（允许尾部斜杠），错误配置显示原有配置错误页面。Memory E2E 构建必须清空该变量，正式产物不得从 `.e2e-out` 部署。本轮入口配置证据见[安装包替换验收](2026-09-14-latest-installer-replacement.md)，不代表重新执行了OTP登录。

## 5. 静态托管与观测

www 入口只有平台原生 `$wwwhost` → `$host` 301 规则和强制 HTTPS 301，不需要重新构建或部署业务站点。复用的 SSL 证书 `ZfX6LSdA` 覆盖根域与 www，控制台到期时间为 2026-10-30 21:59:59；到期前须完成续期并确认 CloudBase 与 Makers 两处均部署有效证书，本次未证明该托管证书会自动续期。变更或回滚 www 时必须先验证证书、深层链接和查询参数，不得恢复指向旧 CloudBase 的记录后仍宣称入口已统一。

部署静态网站前先在本地运行：

```powershell
pnpm.cmd --filter @myself/website build
```

静态网站构建使用 `NEXT_PUBLIC_CLOUDBASE_ENV_ID`、`NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`、`NEXT_PUBLIC_API_BASE_URL=https://cjmwebsite.cn/api/v1` 和上节的 `NEXT_PUBLIC_ADMIN_ORIGIN`。2026-09-02 全量部署曾上传 67/67 个构建文件，清理旧哈希后共有 73 个托管对象（含六个由平台维护的 `__auth` 与 `cloud-admin` 文件）；该对象数是历史证据，不是当前固定数量。2026-09-09 仅更新六项管理员产物，未删除旧哈希，首页字节校验不变。根域 CNAME 指向 `cjmwebsite.cn.cdn.dnsv1.com`，CloudBase 域名状态与两项 DNS 状态均为成功，HTTPS 首页与公开 API 返回 200。日志、告警和审计不得记录状态令牌、签名 URL、管理员令牌、OTP、密钥或私有对象地址。

上海开发环境曾临时开通函数日志用于定位边界错误；CloudBase 系统日志会保存响应摘要，`IgnoreSysLog` 真实试验没有消除该摘要，因此当时保持投稿暂停。2026-09-09 已解除 `ai-pet-api` 的 `ClsLogsetId` 与 `ClsTopicId` 绑定并读取回为空，短暂开启投稿实测后，因根域跨域限制恢复暂停；cleanup 配置与数据库审计不变。后续更新函数必须防止 SDK 默认重新注入 API CLS 绑定；若需要重新启用响应日志，应先暂停投稿并独立验证脱敏方案。日志不得替代长期监控与告警。2026-09-02 套餐观察为 81.39/3000 点，2026-09-09 为 269.4/3000 点、按量付费关闭，体验有效期至 2027-03-01。没有购买、升级或开启按量，但这些时点观察不替代正式生产费用结论，也不代表无限免费。

## 6. 投稿与人工审核部署后语义

- 新共享包完成私有上传后直接进入 `manual_review_pending`。
- 新反馈和建议创建后也直接进入 `manual_review_pending`，管理员可走普通 `approve`，发布依据为 `standard`。
- 新共享包没有当前有效系统扫描通过证据时，普通 `approve` 必须返回 `TECHNICAL_SCAN_REQUIRED`；管理员只能完成独立风险确认后执行 `force_publish`，发布依据为 `admin_override`。
- 强制发布不改变历史扫描事实、结构不变量、审计、状态版本或公开风险提示。

## 7. 本地 Docker 辅助检查（历史参考，本轮不执行）

2026-09-11 用户已明确跳过 Scanner，管理员按本轮规格直接人工审核并保留 `force_publish`／`admin_override`。以下旧步骤仅作为历史参考，不是当前发布或开放的前置门禁，不执行、不生成扫描通过结论。

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

同一上海环境在 2026-09-02 已经验证：migration、匿名与管理员授权、反馈直入人工队列、普通批准、公开读取、点赞与撤赞、删除隔离、审计记录、官方下载计数、私有对象短期上传/下载、共享包两步强制发布、三处公开风险提示、幂等下载计数和完整物理清理。cleanup 每日 timer 的名称、类型、Cron 与启用状态已核对，函数直调成功，但尚未观察一次平台自然定时投递。用户已确认规格中的“评论”仅指公开反馈／建议正文，不包含共享资源留言或回复；现有反馈发布、公开读取与点赞链即为该验收。2026-09-09 根域真实上传失败并暂时恢复 false；2026-09-11 增加精确安全来源并开启投稿后，本轮实际完成官网上传、人工发布、匿名完整下载与测试包软下架，详见独立验收记录。

本次已按以下合同验证官方安装包计数，后续重新部署仍须复验：公开 `POST /api/v1/official-downloads/windows/click` 只接受空对象并只返回空数据；管理员 `GET /api/v1/admin/metrics/official-windows-download` 经现有管理员认证后才返回累计值；公开页面、公开 DTO 与静态导出均不含累计值。上述计数是被服务端接受的点击，既不代表下载、安装、独立用户，也不应把原始 IP、User-Agent、下载地址或管理员令牌写入日志。

单独的本地验证或域名可访问不能证明完整链通过；历史阶段 2C 的 `pass` 与本轮开放证据分别记录，不互相替代。本轮环境复用和个人版安排以已确认规格为准；其他生产事项仍须独立裁决，不扩展本轮上传与下载范围。
