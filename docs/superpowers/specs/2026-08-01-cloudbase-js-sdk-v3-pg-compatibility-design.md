# CloudBase JS SDK V3 PG 兼容迁移设计

## 目标

在继续公开共享仓库、匿名反馈和管理员工作台之前，按照腾讯云 CloudBase 最新官方文档统一 SDK 初始化方式，消除已停止维护的 `@cloudbase/node-sdk`，同时保持既有匿名投稿、双层审核、私有存储和管理员唯一邮箱白名单不变。

## 采用方案

采用最小兼容迁移：

- 后端统一使用 `@cloudbase/js-sdk` V3 的 PG 模式能力。
- 前端 CloudBase SDK 仅负责管理员邮箱 OTP 登录、会话刷新和退出。
- 普通用户不创建 CloudBase 匿名账户，继续完全匿名调用业务 HTTP API。
- 浏览器不直接读写 PostgreSQL，也不直接取得私有 Bucket 的长期权限。
- 文件上传和下载仍由后端校验后签发短期 URL。

## SDK 安装与版本策略

使用前必须先安装并锁定 SDK：

- `apps/website` 安装 `@cloudbase/js-sdk` V3，用于管理员邮箱 OTP、会话和 Access Token。
- `apps/cloudbase-api` 继续使用已安装的 `@cloudbase/js-sdk` V3，并按官方 Node.js 接入要求安装 `@cloudbase/signature-nodejs`。
- 完成兼容验证后，从 `apps/cloudbase-api` 删除停止维护的 `@cloudbase/node-sdk`。
- 使用 pnpm workspace 修改对应应用的 `package.json` 和根 `pnpm-lock.yaml`，不使用 CDN 脚本方式。
- 前后端锁定同一 V3 兼容版本范围，避免认证会话和返回类型产生版本差异。

依赖安装必须先于初始化代码迁移，并通过依赖树检查确认网站包不会引入服务端签名模块。

不采用以下方案：

- 不保留双 SDK：会继续依赖停止维护的 Node SDK，并扩大类型与运行差异。
- 不让浏览器直接访问 PostgreSQL：会绕过 CAPTCHA、限流、系统审核和管理员审核边界。
- 不把公开用户改成 CloudBase 匿名账号：与已经确认的“完全匿名”产品策略不一致，也会增加 MAU 和权限配置复杂度。

## 后端架构

三个云函数入口继续保留：

- `api`：匿名投稿、公开查询、下载签名和管理员审核 API。
- `moderation-worker`：系统内容审核和 ZIP 技术审核编排。
- `cleanup`：三天隔离期与残缺上传清理。

三个入口通过共享工厂创建单一 CloudBase V3 应用实例：

- 环境使用 `CLOUDBASE_ENV_ID`，并在云函数环境优先使用当前环境符号。
- 地域显式固定为 `ap-singapore`，与已购买环境保持一致。
- 显式设置有界请求超时，避免 Node.js V3 默认无超时造成函数长期占用。
- CloudBase SDK 使用云函数运行时临时凭证，不注入 Publishable Key 或服务端 API Key。
- PostgreSQL RPC 若仍需服务端 API Key，则保留独立 RPC 适配器，不与认证实例共享初始化参数。

`app.rdb()`、`app.storage.from(bucketId)` 和 `app.auth` 通过仓库内部最小端口隔离。迁移只替换 SDK 适配层，不修改审核服务、状态机和业务 DTO。

## 前端架构

Next.js 保持不变，不改成 Vite。新增仅客户端加载的 CloudBase 单例：

- 使用 `@cloudbase/js-sdk` V3 PG 模式。
- `env` 来自 `NEXT_PUBLIC_CLOUDBASE_ENV_ID`。
- `region` 固定为 `ap-singapore`。
- 浏览器只允许读取 `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`。
- 不允许 SecretId、SecretKey、服务端 API Key 或管理员邮箱进入前端包。

普通公开页面继续使用 `ApiClient` 调用 `/api/v1`。只有 `/admin` 页面加载认证模块，从而减少公开页面包体并避免服务端渲染阶段访问浏览器 API。

## 管理员认证数据流

1. 管理员输入邮箱。
2. 前端调用 `signInWithOtp`，并设置 `shouldCreateUser: false`。
3. 管理员输入邮箱验证码，前端调用返回对象的 `verifyOtp`。
4. SDK 持久化并刷新会话。
5. 管理员 API 请求从会话读取 Access Token，并发送 `Authorization: Bearer <token>`。
6. CloudBase HTTP 网关只对 `/api/v1/admin/*` 开启身份认证。
7. 云函数通过运行时身份读取 UID，再调用 `getEndUserInfo` 获取服务端邮箱。
8. 后端将邮箱规范化后与唯一 `ADMIN_EMAIL` 白名单比较。

即使浏览器认证成功，邮箱不匹配白名单仍返回 403。公开 `/api/v1` 路径不启用强制登录，继续由 CAPTCHA、频率限制和业务校验保护。

## 私有存储与数据库

现有 PG Storage 设计保持：

- 使用 `app.storage.from('ai-pet-private')`。
- 对象路径是 Bucket 内对象名，不使用 `cloud://` fileID。
- 上传使用 `createSignedUploadUrl`，下载使用 `createSignedUrl`。
- 后端在 finalize 时核对对象键、实际大小和 MIME。
- PostgreSQL RLS、受限 RPC 和 `service_role` 权限继续作为资源层边界。

前端不得直接持有能够列出、覆盖或删除私有对象的权限。

## 错误处理

- SDK 初始化失败：云函数返回稳定的 `SERVICE_UNAVAILABLE`，不泄露环境和凭证信息。
- 地域或环境不匹配：启动期配置校验失败，不降级到默认上海地域。
- OTP 发送或验证失败：前端显示稳定的认证错误，不输出原始敏感响应。
- 会话过期：管理员 API 收到 401 后先尝试 SDK 会话刷新；仍失败则返回登录页。
- HTTP 网关拒绝：区分未登录 401 与已登录但非白名单管理员 403。
- CloudBase RPC、存储或认证超时：失败关闭，不发布、批准或删除任何投稿。

## 控制台配置

- 开启邮箱 OTP 登录。
- 预先创建唯一管理员邮箱账号，禁止管理员页面自动注册用户。
- 生成浏览器 Publishable Key。
- 添加正式域名、必要的 Vercel 预览域名和本地开发地址到安全域名。
- 只为 `/api/v1/admin/*` 开启 HTTP 网关身份认证。
- 将 CloudBase、腾讯内容安全和内部 HMAC 密钥只放入服务端环境变量。

## 测试与验收

兼容迁移必须覆盖：

- 网站和后端均安装并解析同一兼容版本的 `@cloudbase/js-sdk` V3。
- `@cloudbase/signature-nodejs` 只存在于后端依赖边界，不进入网站浏览器包。
- 后端不再导入或依赖 `@cloudbase/node-sdk`。
- 三个云函数只初始化一个 V3 应用实例，并显式使用新加坡地域和超时。
- 服务端认证实例没有传入 API Key 或 Publishable Key。
- PG 数据查询、RPC、签名上传、对象信息、签名下载和删除适配器契约不变。
- Next.js 服务端构建不会执行浏览器 CloudBase 初始化。
- 前端产物不包含 SecretId、SecretKey、服务端 API Key 或管理员邮箱。
- OTP 使用 `shouldCreateUser: false`。
- 管理员请求携带 Access Token；匿名公开请求不携带管理员令牌。
- 网关未登录、非白名单邮箱、会话过期和服务超时均失败关闭。

真实部署前还必须在 CloudBase 新加坡开发环境验证：邮箱 OTP、HTTP 网关身份传递、`getUserInfo`、`getEndUserInfo`、PG RLS/RPC、私有存储签名 URL 和三个云函数入口。

## 实施顺序

1. 在网站和后端工作区安装、锁定 CloudBase JS SDK V3 及后端签名依赖。
2. 完成 SDK V3 PG 兼容迁移及测试，并删除旧 Node SDK。
3. 再执行原计划 Task 11 的公开共享仓库云端切换。
4. 继续匿名反馈、状态页和管理员工作台。
5. 最后执行真实 CloudBase、Vercel 和 Cloudflare 部署验收。
