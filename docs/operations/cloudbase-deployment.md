# CloudBase 部署与上线手册

本文对应当前 CloudBase PostgreSQL、私有对象存储、三个云函数、隔离扫描容器和 Next.js 静态导出的实现。命令中的密钥均通过环境变量提供，不在仓库、构建日志或前端变量中填写真实值。

## 1. 环境隔离

1. 保留已购买的个人版环境作为开发测试环境。
2. 上线前新建独立生产环境；数据库、Bucket、函数、扫描容器、域名、告警与所有密钥均不得和开发环境混用。
3. 两个环境分别记录 `CLOUDBASE_ENV_ID`，并分别执行迁移与部署。数据库迁移只向前执行，不复制开发投稿到生产。
4. 服务端 CloudBase 固定使用 `ap-singapore`；`CLOUDBASE_REGION` 只能留空或设为 `ap-singapore`。

## 2. PostgreSQL 与私有存储

1. 在目标环境开通 PostgreSQL，给迁移身份最小必要权限。
2. 设置 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`、`CLOUDBASE_ENV_ID`，执行：

   ```powershell
   node tools/apply-cloudbase-migrations.mjs
   ```

3. 创建仅服务端可访问的私有 Bucket，将标识配置为 `PRIVATE_BUCKET_ID`。禁止公开读写；上传与下载只使用短期签名地址。
4. 正式安装包放在独立发布目录和 CDN 策略中，不得复用匿名投稿的隔离区。

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

## 5. 隔离扫描容器

1. 使用 `apps/package-scanner/Dockerfile` 部署 CloudBase Run 服务。
2. 运行参数：Node.js 22 容器、最小实例数 0、单实例并发 1、内存至少 1 GB、健康检查 `/healthz`。
3. 配置 `SCANNER_INTERNAL_SECRET`、`SCANNER_DOWNLOAD_HOSTS`、`SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS`、`TENCENT_CLOUD_REGION`、`TENCENT_IMS_BIZ_TYPE`、`TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`；使用临时凭据时再配置 `TENCENTCLOUD_SESSIONTOKEN`。
4. API 函数的 `SCANNER_URL` 指向容器 HTTPS 地址，`SCANNER_HMAC_SECRET` 必须与容器的 `SCANNER_INTERNAL_SECRET` 使用同一密钥值，但名称按各自进程保留。
5. 用干净包、病毒命中、图片拦截、超时和并发请求验证失败关闭；禁止放宽为扫描异常即通过。

## 6. 服务端环境变量清单

三个云函数共用下列名称：

```text
CLOUDBASE_ENV_ID
CLOUDBASE_REGION
CLOUDBASE_API_KEY
PRIVATE_BUCKET_ID
ADMIN_EMAIL
ABUSE_HMAC_SECRET
TENCENTCLOUD_SECRETID
TENCENTCLOUD_SECRETKEY
TENCENTCLOUD_SESSIONTOKEN
MODERATION_REGION
TMS_BIZ_TYPE
IMS_BIZ_TYPE
SCANNER_URL
SCANNER_HMAC_SECRET
```

## 7. 构建并部署三个函数

```powershell
pnpm.cmd build:cloudbase
pnpm.cmd exec cloudbase fn deploy --all
```

确认 `cloudbaserc.json` 中的三个入口均已部署：

- `ai-pet-api`：公开与管理员 HTTP API；
- `ai-pet-moderation-worker`：定时领取审核任务；
- `ai-pet-cleanup`：清理到期隔离内容。

为审核 worker 和 cleanup 分别配置定时触发器；每次只处理代码限定的小批量，失败后告警并保持内容隐藏。

## 8. HTTP 网关

1. 将 `/api/v1` 关联到 `ai-pet-api`。
2. 公开投稿、状态和公开列表路径允许匿名访问；匿名投稿依靠 IP 限流、内容审核和管理员审批控制风险。
3. `/api/v1/admin/*` 同时启用 CloudBase 身份认证；后端仍会校验 Bearer 会话、邮箱白名单与管理员角色，网关认证不能替代应用层授权。
4. CORS 只允许正式网站和已批准的开发域名及所需方法/请求头，不使用通配来源携带认证信息。

## 9. 静态站点、域名与浏览器配置

1. 配置 `NEXT_PUBLIC_API_BASE_URL`、`NEXT_PUBLIC_CLOUDBASE_ENV_ID`、`NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` 后构建：

   ```powershell
   pnpm.cmd --filter @myself/website build
   pnpm.cmd exec cloudbase hosting deploy apps/website/out -e $env:CLOUDBASE_ENV_ID
   ```

2. 绑定已备案的自定义域名并强制 HTTPS；将实际域名加入 CloudBase Web 安全域名配置。
3. 配置 CSP，至少限制默认来源、脚本来源、连接目标、图片来源和 frame 祖先；为 `/api/v1` 配置匹配的 CORS。
4. 检查 `apps/website/out/admin/index.html`、`apps/website/out/submission-status/index.html` 和三个 `/legal/*.html` 均可访问。

## 10. 监控、告警与备份

- 开启函数、HTTP 网关、容器和数据库错误日志；日志不得记录状态令牌、签名 URL、Bearer、OTP 或密钥。
- 配置费用、函数调用量、5xx/429、审核积压、扫描失败、异常上传、存储容量和清理失败告警。
- 定期备份 PostgreSQL，并在隔离环境演练恢复。私有文件恢复权限仍须遵守状态与审核边界。
- 运行和网络安全日志按适用法规与平台要求设置期限，不把三天文件隔离期直接套用于所有日志。

## 11. 开发环境冒烟门禁

生产部署前在开发环境验证：匿名共享包和反馈投稿不直接公开；状态链接只在 Fragment 携带令牌；验证强产品词和有效组合进入管理员队列，零命中与弱命中也进入管理员队列且不会自动驳回；明确内容安全风险仍进入自动驳回；批准后才公开；危险包不能批准；删除立即隐藏且三天内可恢复；错误或非管理员 Bearer 返回 401/403；下载只发短期签名地址。

执行仓库验证：

```powershell
pnpm verify:cloudbase
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
pnpm test:e2e:website
```

## 12. 发布与回滚

先小流量开放浏览，再开放匿名投稿并观察审核积压、失败率与费用。出现严重问题时关闭投稿入口或网关写路径，保持公开只读内容可用。回滚只切换到上一静态版本和上一函数版本；不得回滚已经执行的数据库迁移。回滚后重新验证管理员权限、私有存储和失败关闭。
