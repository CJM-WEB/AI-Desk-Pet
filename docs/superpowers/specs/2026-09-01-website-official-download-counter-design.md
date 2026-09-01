# 官网官方安装包下载计数设计

## 1. 目标

在官网正式 Windows 安装包处记录管理员可见的下载按钮点击总数。一次被服务端接受的真实按钮点击将计数原子加一；公开页面、公开列表和公开响应不得返回累计值。

本功能必须保持很小：复用现有 CloudBase API、PostgreSQL Adapter、匿名风控、管理员鉴权和管理员工作台，不引入第三方分析、第二套后台、独立任务或桌宠端改动。

## 2. 非目标

- 不统计首页“跳到下载章节”的锚点点击。
- 不统计 macOS 的未发布按钮，也不为未发布 Windows 清单渲染可点击入口。
- 不宣称计数代表成功下载、成功安装、独立用户或真实人数。
- 不公开累计值，不把累计值加入发行清单、公开社区 DTO 或静态 HTML。
- 不因计数请求失败、超时或限流阻断安装包原始链接。
- 不引入 Cookie、广告标识、第三方 SDK、IP 或 User-Agent 原文存储。

## 3. 现状证据

- 正式下载入口位于 `apps/website/components/website-experience/download/DownloadChapter.tsx`；只有发行清单为 `published` 时才渲染安装包链接。
- `ApiClient` 已提供同源公开 JSON 信封；管理员页面已通过 `x-ai-pet-admin-token` 和服务端邮箱白名单进行双层校验。
- CloudBase API 已将 IP 与 User-Agent 经 HMAC 投影为不可逆设备指纹，并为 `download:<scope>` 提供每设备每分钟 10 次的固定窗口保护。
- 社区下载计数绑定投稿、私有对象签名和公开发布结构，不能承载官方安装包指标。
- 当前上海 PostgreSQL 环境尚未执行 migration，因此新增前向 migration 可以与现有迁移一次顺序落地。

## 4. 方案比较与裁决

### 方案一：独立单行站点指标（采用）

新增官方 Windows 下载单例计数表与原子函数。公开路由只返回严格空对象，管理员路由单独返回 `clickCount`。

该方案不会把官方资产伪装成用户投稿，接口很小，并能通过 PostgreSQL 原子更新避免并发丢失。

### 方案二：复用社区 `public_engagement`（拒绝）

现有表和 RPC 以投稿 ID 为外键，并且下载动作同时负责校验发布结构和签发私有地址。创建虚假投稿或特殊 ID 会破坏官方安装包与用户共享资源的边界。

### 方案三：使用第三方分析或云日志（拒绝）

第三方分析增加依赖、隐私和费用面；云日志只能给控制台提供近似统计，无法以现有管理员鉴权接口稳定显示精确累计值。

## 5. 接口与数据流

### 5.1 公开写入

`POST /api/v1/official-downloads/windows/click`

- 请求体必须为严格空对象 `{}`。
- API 使用既有 HMAC 设备指纹；PostgreSQL 在同一事务内消费 `download:official-windows` 的既有限流策略并原子加一。
- 成功只返回严格空对象 `{}`，不返回累计值。
- 失败保持现有稳定错误信封；浏览器端忽略该辅助请求的失败并继续原始下载链接。

### 5.2 管理员读取

`GET /api/v1/admin/metrics/official-windows-download`

- 必须先执行现有 `requireAdmin`，非管理员统一拒绝。
- 成功返回 `{ "clickCount": <非负安全整数> }`。
- 管理员工作台登录后读取一次，并在顶栏显示“官方安装包下载点击”。读取失败显示不可用状态，不影响审核队列。

### 5.3 浏览器点击

只有 `activePlatform.id === 'windows-x64'` 且状态为 `available` 的真实安装包链接登记点击。处理器不调用 `preventDefault`，不等待计数结果，也不改写发行清单提供的 `href`；旁路请求使用 `keepalive: true` 与 `credentials: 'omit'`，不重试或持久化排队。

## 6. 数据与安全

- 指标表只允许一条 `singleton=true` 的记录，`click_count` 为非负 `bigint`。
- 表启用并强制 RLS，对 `PUBLIC`、`anon`、`authenticated` 均不可读写；只有服务端 `service_role` 可执行两个指标函数。
- `record_official_windows_download_click(char(64))` 校验服务角色与 HMAC 指纹，在同一事务中消费既有限流并使用 `INSERT ... ON CONFLICT ... DO UPDATE` 原子更新；`get_official_windows_download_click_count()` 空表返回 0。
- CloudBase API 通过独立的 `OfficialDownloadMetricStore` 两方法接口访问指标；不把全局指标耦合进社区内容、投稿审核或发行清单。
- 公开请求不接收版本、URL、增量或计数值，采用全站生命周期单例；调用方不能选择其他指标或任意增加数值。
- 原始 IP、User-Agent、下载地址和管理员令牌不得进入指标表或普通日志。
- 计数是受固定窗口保护的“被接受点击数”；恶意或高频请求可被限流，下载本身仍可继续。

## 7. 失败处理

- 公开计数网络失败、API 失败、429 或 malformed response：吞掉辅助错误，保留安装包导航。
- 数据库递增失败：API 返回稳定服务端错误，不伪造成功。
- 管理员指标读取失败：显示不可用，不清空或阻断审核队列；401/403 仍沿用现有会话处理。
- migration 失败：停止阶段 2C 远端部署，先查询远端迁移状态；不得手工修改表或回滚历史 migration。

## 8. 迁移、删除与范围

- 新增不可变前向 migration `20260901020000_official_windows_download_click_metric.sql`，现有迁移总数由 15 增至 16。
- 不修改任何历史 migration。
- 不新增独立统计服务、定时任务、CloudBase Run、SDK 或环境变量。
- `apps/website/components/DownloadCard.tsx` 是未被现行页面引用的旧组件，本功能不恢复或扩展该路径，也不借机清理无关文件。
- 变更仅位于官网、共享网站契约、CloudBase API、数据库 migration、网站链验证和对应中文文档。

## 9. 测试与验收

- RED：共享契约拒绝公开累计值；公开写入仅接受并返回空对象；管理员响应只接受非负安全整数。
- RED：CloudBase API 公开路由执行限流与登记但不泄露累计值；管理员路由先鉴权再读取；非管理员拒绝。
- RED：真实 PostgreSQL 顺序与独立并发点击不丢失计数，限流与递增同事务，匿名角色不能读取表或执行函数。
- RED：正式 Windows 链接点击发送一次辅助请求且不阻止原始 `href`；请求失败仍不阻止下载。
- RED：管理员登录后显示累计值，读取失败不影响审核队列。
- 验证：相关定向测试、migration 行为门、`pnpm.cmd verify:website`、`pnpm.cmd verify:cloudbase`、`pnpm.cmd verify:web-chain`、范围门、所有权门和 `git diff --check`。

完成只代表点击计数功能进入阶段 2C 候选；远端 16 条 migration、函数部署、管理员真实读取和费用用量仍必须在同一上海免费环境 smoke 后才能写为通过。
