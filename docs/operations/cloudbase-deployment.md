# CloudBase 部署与上线手册

本文记录 CloudBase PostgreSQL、私有对象存储、三个云函数、隔离扫描容器和 Next.js 静态导出的目标配置与当前止血状态。命令中的密钥均通过环境变量提供，不在仓库、构建日志或前端变量中填写真实值；仓库中的配置和迁移文件不证明任何环境已经部署。

> 2026-09-01 状态：阶段四八项本地治理代码与完整 `verify:web-chain` 均已通过，阶段四本地治理验收完成。CloudBase 开发环境、远端 migration、cleanup 调度、真实网关、私有对象存储、函数/Scanner/Hosting 部署、发布和正式上线均未执行；线上仍是旧测试版，本分支未上线且共享包投稿继续关闭。生产 Router 继续等待阶段 2C 真实网关证据，不属于阶段四完成范围。详见 [网站阶段四本地治理真实状态记录](website-optimization-acceptance.md)。
>
> 2026-09-01 阶段 2C 最终状态为 `blocked`：Task 1、Task 2 与适用的 Task 4 已完成本地工作；Task 3、Task 5–10 因零费用门禁裁剪，未执行远端操作。当前旧上海免费体验环境 `ai-pet-scanner-dev`（`ai-pet-scanner-dev-d8cqh04af371e`）仍是传统/MySQL 模式，不是所需 PostgreSQL 环境；控制台显示免费云函数 15 分钟、3 GB 上限，未阻断 30/900/300 秒目标超时，但不证明函数已部署。官方 [CloudBase Run 使用限制](https://docs.cloudbase.net/run/limitation) 说明 Run CPU、内存需开启超限按量服务才会计量计费，关闭后服务停止；官方 CLI 文档与控制台编辑页均未观察到可保存“单实例并发 1”的设置。不得删除旧环境、创建新环境或付费资源。本轮未执行腾讯云写操作；完整事实与恢复条件见[网站阶段 2C 上海阻断验收记录](website-stage-2c-shanghai-acceptance.md)。

当前仓库本地代码已包含版本化 keyset cursor、互动幂等账本、下载成功签发计数、发布结构不变量、坏公开记录隔离、有界 RPC JSON、单一 Release Manifest 契约和收窄后的 CloudBase 能力端口。临时 PostgreSQL 17.11 已顺序执行 13 个前向 migration 并通过 103 项行为验证；这些事实只证明本地实现，不证明任何远端资源已迁移、配置或运行。

## 1. 环境隔离

1. 当前共享包链路处于部署冻结：不得执行数据库迁移、部署云函数、Scanner 镜像或静态网站，也不得修改任何远端资源或数据。
2. 共享包投稿在所有环境保持以下服务端配置；未设置、空值和 `false` 都表示关闭：

   ```text
   SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
   ```

3. 只有真实 Scanner 容器候选与阶段 2C 开发环境完整 smoke 均已完成并验收后，才可将该值改为 `true`；2026-09-01 本地完整门已通过真实 Scanner 候选，但阶段 2C 开发环境 smoke 尚未执行，因此投稿开关继续关闭。该条件不构成实际部署或上线授权。
4. 新增的前向 migration 目前仅在临时本地 PostgreSQL 17.11 中顺序执行 13 个 migration 并通过 103 项行为验证，尚未在任何 CloudBase PostgreSQL 环境执行。当前默认迁移入口仍是以下只读 dry-run；它只读取仓库 migration 并输出 checksum plan，不读取凭据、不加载管理 SDK，也不连接或写入数据库：

   ```powershell
   pnpm.cmd plan:cloudbase-migrations
   ```

   阶段 2C 完成前，任何 CloudBase 环境都不得从仓库执行 migration，也不得通过控制台复制 SQL 绕过冻结。已提交数据库变更只能通过新的前向 migration 修复，历史 migration 不得改写。
5. 解冻后的环境仍须保留独立的开发与生产环境，分别记录 `CLOUDBASE_ENV_ID`；数据库、Bucket、函数、扫描容器、域名、告警与所有密钥不得混用。阶段 2C 开发环境的服务端 CloudBase 目标地域为 `ap-shanghai`，其 `CLOUDBASE_REGION` 只能留空或设为 `ap-shanghai`。正式生产地域不由阶段 2C 裁决，必须由后续生产计划基于上海开发环境证据重新决定，不得直接把阶段 2C 开发配置作为生产配置。

## 2. PostgreSQL 与私有存储

1. 当前不得在任何 CloudBase 环境执行 migration；本地受控 migration Adapter 与临时 PostgreSQL 行为门已经通过，但真实专用会话、整轮锁、并发和续跑仍须由阶段 2C 开发环境 smoke 证明，现阶段不存在获准的远端数据库写入口。
2. 当前唯一获批的远端迁移路径是：现有 inventory 完成文件名、顺序、校验和、重复版本和空文件检查后，直接投影为 `@cloudbase/manager-node` 的 user migration 输入；开发环境 Adapter 再执行 preview、push 和 task poll。不得重新实现第二套 migration 发现、排序或执行器，也不得通过控制台手工执行 SQL 绕过 inventory 检查。
3. 上述 Adapter 目前只有本地编排和 SDK 边界测试，不是可直接运行的部署命令。真实 CloudBase 开发环境中的事务、锁、并发、任务失败与续跑行为必须由阶段 2C smoke 验证；验证前不得恢复远端数据库写入口。
4. 解冻后创建仅服务端可访问的私有 Bucket，将标识配置为 `PRIVATE_BUCKET_ID`。禁止公开读写；上传与下载只使用短期签名地址。
5. 正式安装包放在独立发布目录和 CDN 策略中，不得复用匿名投稿的隔离区。

## 3. 云服务与认证

1. 开通文本内容安全 TMS、图片内容安全 IMS，并创建 AI Pet 专用业务策略。
2. 服务端配置 `TMS_BIZ_TYPE`、`IMS_BIZ_TYPE`、`MODERATION_REGION`、`TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`；临时凭据另配 `TENCENTCLOUD_SESSIONTOKEN`。
3. 在 CloudBase 身份认证中启用邮箱 OTP，预先创建唯一管理员账号。服务端 `ADMIN_EMAIL` 只配置这一地址；关闭自动注册，普通投稿者不登录。
4. 前端使用 `@cloudbase/js-sdk` v3，并配置 `NEXT_PUBLIC_CLOUDBASE_ENV_ID` 与 `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`。安全域名必须只包含实际 HTTPS 域名。

## 4. 本地关键词相关性审核

1. 相关性审核由后端内置的分组关键词规则执行，不需要开通 CloudBase AI、购买 AI Token 或配置第三方模型。
2. 强产品词或有效跨组组合输出系统通过建议；零命中、单个弱词、组合不足和内部异常一律转人工。
3. 关键词层不产生自动驳回。政治、脏话及其他明确风险仍由 TMS、IMS、OCR 和资源包技术扫描处理。
4. 系统通过与转人工都进入管理员队列，只有管理员批准后才能公开。

## 5. 隔离扫描容器（零费用门禁阻断，继续冻结）

2026-09-01 完整网站链已通过真实 `scanner-candidate`：Node `v22.23.2`、ClamAV `1.4.3`/病毒库 `28109`、UID `999`，EICAR 被阻断、超时返回 HTTP 503、健康检查通过。该结果仅证明本地候选镜像；CloudBase Run Scanner 尚未部署或完成开发环境冒烟。

阶段 2C 远端部分现为 `blocked`，下列项目仅保留为冻结的目标配置，不构成当前零费用部署授权：CloudBase Run 的 CPU、内存需要开启超限按量服务才会计量计费，关闭后服务停止；并且官方 CLI 与控制台均未观察到可保存“单实例并发 1”的设置，不能以最大实例 1 替代该强制要求。不得部署 Scanner、删除旧环境、创建新环境或开通按量服务。旧 Scanner 配置中的长期腾讯云访问凭据仅在只读核验中发现，任何值均未记录；未来远端方案重启前必须先通过独立的账号级密钥轮换/删除门禁。

1. 使用 `apps/package-scanner/Dockerfile` 部署 CloudBase Run 服务。
2. 运行参数：Node.js 22 容器、最小实例数 0、单实例并发 1、内存至少 1 GB、健康检查 `/healthz`。
3. 配置 `SCANNER_INTERNAL_SECRET`、`SCANNER_DOWNLOAD_HOSTS`、`SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS`、`TENCENT_CLOUD_REGION`、`TENCENT_IMS_BIZ_TYPE`、`TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`；使用临时凭据时再配置 `TENCENTCLOUD_SESSIONTOKEN`。
4. API 函数的 `SCANNER_URL` 指向容器 HTTPS 地址，`SCANNER_HMAC_SECRET` 必须与容器的 `SCANNER_INTERNAL_SECRET` 使用同一密钥值，但名称按各自进程保留。
5. 用干净包、病毒命中、图片拦截、超时和并发请求验证失败关闭；Scanner 异常时必须保持共享包隐藏和批准禁用。

## 6. 阶段 2C 开发环境目标变量清单

以下清单仅描述阶段 2C 开发环境目标配置，不表示该配置已部署，也不表示正式生产地域或变量已经决定。三个云函数只配置各自 loader 实际读取的最小变量，不向无关函数复制 Secret。共同运行时变量为 `CLOUDBASE_ENV_ID`、`PRIVATE_BUCKET_ID`，以及在该开发环境中可省略且只允许为 `ap-shanghai` 的 `CLOUDBASE_REGION`。

`ai-pet-api`：

```text
CLOUDBASE_API_KEY
ADMIN_EMAIL
ABUSE_HMAC_SECRET
SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
```

`ai-pet-moderation-worker`：

```text
CLOUDBASE_API_KEY
MODERATION_SECRET_ID（或 TENCENTCLOUD_SECRETID）
MODERATION_SECRET_KEY（或 TENCENTCLOUD_SECRETKEY）
MODERATION_SESSION_TOKEN（可选；使用平台变量名时对应 TENCENTCLOUD_SESSIONTOKEN）
MODERATION_REGION
TMS_BIZ_TYPE
IMS_BIZ_TYPE
SCANNER_URL
SCANNER_HMAC_SECRET
```

`ai-pet-cleanup`：

```text
CLOUDBASE_API_KEY
```

## 7. 构建与部署冻结

当前不得构建后部署三个函数、配置定时触发器或关联 HTTP 网关；阶段 2C 的零费用门禁已判定 `blocked`，不得以部署、购买、开通按量计费或创建资源绕过该结论。本节只保留冻结的目标入口清单：

- `ai-pet-api`：公开与管理员 HTTP API；
- `ai-pet-moderation-worker`：定时领取审核任务；
- `ai-pet-cleanup`：清理到期隔离内容与过期互动幂等账本。

阶段 2C 完成开发环境 migration、函数、真实 Scanner 候选与完整 smoke 前，不得部署上述入口或为审核 worker、cleanup 配置定时触发器。当前 cleanup 调度未配置；本地清理函数和测试通过不等于 24 小时互动账本或三天隔离清理已在远端生效。解冻后每次只处理代码限定的小批量，失败后告警并保持内容隐藏。

## 8. HTTP 网关

冻结期间不得把任何新网关路径关联到 `ai-pet-api` 部署。阶段 2C 必须先捕获脱敏的真实 CloudBase event/path，确认平台传给函数的路径是否保留 `/api` 前缀，再裁决由现有 `createApi/dispatch` 还是 `createRouter` 成为唯一正式路径；当前不能从本地注释预判。

取得证据并获部署授权后：

1. 按真实平台路径配置外部 API 前缀并关联到 `ai-pet-api`，不得为兼容猜测长期保留双 Router。
2. 公开投稿、状态和公开列表路径允许匿名访问；匿名投稿依靠 IP 限流、内容审核和管理员审批控制风险。
3. 管理员路径同时启用 CloudBase 身份认证；当前应用层精确读取 `x-ai-pet-admin-token`，并校验令牌对应的管理员身份、邮箱白名单与角色。真实 CloudBase 网关如何传递并保护该请求头尚未在阶段 2C 验证，网关认证不能替代应用层授权。
4. CORS 只允许正式网站和已批准的开发域名及所需方法/请求头，不使用通配来源携带认证信息。

## 9. 静态站点、域名与浏览器配置

1. 冻结期间可以在本地配置 `NEXT_PUBLIC_API_BASE_URL`、`NEXT_PUBLIC_CLOUDBASE_ENV_ID`、`NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` 并构建验证，但不得执行静态站点部署：

   ```powershell
   pnpm.cmd --filter @myself/website build
   ```

2. 绑定已备案的自定义域名并强制 HTTPS；将实际域名加入 CloudBase Web 安全域名配置。
3. 配置 CSP，至少限制默认来源、脚本来源、连接目标、图片来源和 frame 祖先；为阶段 2C 证实的实际 API 前缀配置匹配的 CORS。
4. 检查 `apps/website/out/admin/index.html`、`apps/website/out/submission-status/index.html` 和三个 `/legal/*.html` 均可访问。

## 10. 监控、告警与备份

- 开启函数、HTTP 网关、容器和数据库错误日志；日志不得记录状态令牌、签名 URL、`x-ai-pet-admin-token`、OTP 或密钥。
- 配置费用、函数调用量、5xx/429、审核积压、扫描失败、异常上传、存储容量和清理失败告警。
- 定期备份 PostgreSQL，并在隔离环境演练恢复。私有文件恢复权限仍须遵守状态与审核边界。
- 运行和网络安全日志按适用法规与平台要求设置期限，不把三天文件隔离期直接套用于所有日志。

## 11. 开发环境冒烟门禁

当前开发环境完整 smoke 尚未执行，部署继续冻结。解冻前必须在开发环境验证：共享包投稿默认返回暂停状态，反馈投稿不受影响且不直接公开；状态链接只在 Fragment 携带令牌；强产品词和有效组合进入管理员队列，零命中与弱命中也进入管理员队列且不会自动驳回；明确内容安全风险仍保留真实扫描结论；管理员可把 `system_reviewing` 或 `auto_rejected` 投稿转入人工队列，共享包缺少有效通过证据或系统未通过时可在独立风险确认后强制发布，但不能绕过非空文本、唯一 cover/package、固定对象键、MIME 与正大小等结构不变量，且不得改写扫描事实；删除立即隐藏且三天内可恢复；错误或非管理员 `x-ai-pet-admin-token` 返回 401/403；并验证真实网关与该应用层请求头兼容；下载只发短期签名地址。

执行仓库验证：

```powershell
pnpm verify:cloudbase
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
pnpm test:e2e:website
```

## 12. 发布与回滚

当前不进行发布、灰度、回滚或开启共享包匿名投稿。`pnpm.cmd plan:cloudbase-migrations` 仍仅用于生成只读 checksum plan，不是部署或迁移执行命令。完成阶段 2B 真实容器候选、阶段 2C 开发环境完整 smoke 并获得单独部署授权后，才可先小流量开放浏览；共享包投稿仍须保持关闭，直至确认监控、告警和完整扫描链均可用。出现严重问题时关闭投稿入口或网关写路径，保持公开只读内容可用。已执行的数据库迁移不得回滚，只能新增前向修复 migration；回滚后重新验证管理员权限、私有存储和失败关闭。
