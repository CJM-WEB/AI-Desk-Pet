# 网站阶段 2—3 本地闭环差量设计

> 地域条款已被 2026-09-01 上海重建规格替代。

> 日期：2026-08-31
> 分支：`WebsiteExtension`
> 替代范围：修订主规格第 5.7、6.3、7.3、7.4 节和 2026-08-15 阶段 2、阶段 3 计划中与当前代码、阶段 1 减法及外部环境边界冲突的部分；其余条款继续有效。管理员人工覆盖另由 `2026-08-31-admin-override-publication-design.md` 约束

## 1. 目标与非目标

本轮目标是完成网站业务的阶段 2A 本地结构门、阶段 2B 本地运行候选门和阶段 3 HTTP 契约门。只有三个强制门全部通过，才恢复与共享包投稿无关的普通网站功能开发；任一门未通过时继续冻结。阶段 2C 真实 CloudBase 开发环境门后置，共享包投稿继续关闭。

本轮不执行 CloudBase 迁移、函数部署、Scanner 远程部署、投稿开关变更或正式生产部署；不修改 `apps/desktop`、Agent、文件工具和角色包 owner；不执行 Git 合并。

## 2. 当前事实与冲突裁决

1. 阶段 1 已完成，固定 SQL 写库入口已退役；阶段 2 不得恢复 `tools/apply-cloudbase-migrations.mjs`。
2. CloudBase API 仍直接使用 `@cloudbase/node-sdk`，且三个函数共用过宽配置。
3. Scanner 已有真实 HTTP、HMAC、限额和失败关闭基础，但客户端、服务端各自定义协议；bundle target 仍为 Node 20。
4. 投稿完成仍有直接进入 `manual_review_pending` 的旧路径，完整 ZIP 身份和证据时效尚未闭合。
5. 网站客户端仍有 `request<unknown>`、本地重复 DTO/Schema；生产与内存 Adapter 的信封、管理员认证和回执状态存在漂移。
6. 主规格第 3.4、7.3 节允许在真实 Scanner 验收前保持投稿关闭并记录外部未验证项。因此本差量规格把第 5.7 节的“开发环境 PostgreSQL 冒烟”和第 7.3 节第 7 项明确归入阶段 2C 投稿/部署门，不再作为普通非投稿功能的恢复门；专用会话、整轮锁和真实远端续跑仍只能在 2C 验证，不得由本地 fake 冒充。

## 3. 方案

### 3.1 CloudBase 运行时与配置

- 只保留 `@cloudbase/js-sdk` V3；先以已安装 3.6.8 的 Node 类型核对 `eventID` 与 `extendedContext.tmpSecret`，三个函数入口都显式接收并向 SDK 传递同一精确收窄的 context。PostgreSQL RPC API Key 只留在 PostgreSQL Adapter。
- 一个内部环境变量读取模块，分别导出 API、moderation worker、cleanup 三个最小 loader；删除聚合配置与旧 SDK 初始化路径。
- 地域继续固定 `ap-singapore`，不引入第二套地域策略。

### 3.2 Scanner 协议与候选

- 在 `@myself/shared-types/scanner-protocol` 建立唯一 wire contract：版本、规则版本、请求、成功/失败响应、归档大小与 SHA-256、现有受限 `jsonTexts` 与 `imageSignals`。
- 共享 canonical 签名输入；客户端和服务端删除重复 Schema、类型判断和签名格式。
- 不修改 `packages/character-*`；Scanner 继续只消费其既有公开契约。
- bundle target 改为 Node 22。候选验证分为可重复的 build/bundle 门和容器运行门；容器门必须验证非 root、health、EICAR 与 timeout。缺少 Docker 或等价容器运行时时阶段 2B 未通过，普通开发资格继续冻结。

### 3.3 迁移能力

- 阶段 1 的 `plan:cloudbase-migrations` 永远只读。
- 复用 `@cloudbase/manager-node` 已有 PostgreSQL user migration 能力，建立新命名的受控 Adapter；管理 SDK 不得进入只读 CLI。
- 本地用 fake 验证环境分类、checksum 冲突、任务轮询、失败和续跑编排分支。真实事务、锁和并发只可由以后获授权的开发环境 smoke 证明。
- 本轮不新增可直接连接远端的默认命令，不恢复旧 `apply-*` 文件。

### 3.4 状态流与扫描证据

- 共享包完成上传只进入 `system_reviewing`；clean 扫描后进入 `manual_review_pending`；危险或无效包进入 `auto_rejected`；超时和依赖失败保持私有并重试。
- 普通反馈和建议同样先进入 `system_reviewing`，系统内容审核后才进入 `manual_review_pending`；唯一管理员可按强制发布规格提前转人工。
- 扫描下载写临时文件时累计完整 ZIP 的大小和 SHA-256，不二次下载、不把完整 ZIP 常驻内存。
- clean 证据绑定投稿、不可覆盖对象键、实际大小、完整 ZIP SHA-256、协议版本、规则版本、完成时间和最终状态版本。ETag 只有在真实环境证明稳定后才进入必填门。
- 历史 migration 不改写，只新增前向 migration。
- 证据 TTL 必须由用户提供正整数与单位；在决定到达前，本节实现保持未开始，不猜默认值。
- 新前向 migration 必须在临时 PostgreSQL 中执行并验证函数、约束和事务行为；没有本地 PostgreSQL 或等价容器门时阶段 2B 未通过。
- 管理员可将 `system_reviewing` 或 `auto_rejected` 的任意投稿转入 `manual_review_pending`。共享包缺少有效通过证据时，普通批准仍失败；独立 `force_publish` 才能覆盖该门，并保留 `admin_override` 发布依据、公开警告和审计。

### 3.5 HTTP 运行时契约

- `@myself/shared-types/website-http` 是唯一 wire Schema owner，不进入根 barrel。
- 信封严格要求 `requestId`，成功与失败互斥；错误只保留浏览器真实消费的 `code` 与可选 `retryAfterSeconds`，删除无消费者的公开 message。
- `ApiClient` 只保留一个 `request(path, schema, init)` 接缝；每个 endpoint 使用精确响应 Schema。
- 生产 `createApi` 发送前和浏览器接收后都解析共享 Schema；替换后删除本地重复 DTO、Schema、手工投影和 unchecked cast。
- 管理端统一使用当前候选接口 `x-ai-pet-admin-token`、401 `UNAUTHORIZED`、403 `FORBIDDEN`。真实网关兼容性留待开发环境验证。

### 3.6 双 Adapter 行为契约

- 建立最小 `WebsiteApiDriver { request, reset }`；`reset()` 返回同构的 `ContractFixtureRefs`，包含公开内容 ID、状态 token、管理员队列 ID 与版本，生产 `createApi` 与内存后端共用行为案例但不共用数据库实现。
- 内存后端只额外暴露 `reset`，socket 生命周期由测试 driver 管理。
- 契约测试登记到网站链唯一 owner、scope 和 fast/full 门，不修改桌面测试配置。

## 4. 减法与删除边界

替代测试为绿后删除：旧 Node SDK、聚合配置、Scanner 双份协议/签名、直接人工审核路径、弱扫描证据、浏览器本地信封与重复 endpoint Schema、内存后端旧认证头和旧错误码、只锁定旧响应状态的测试。

不删除历史 migration、业务内部 ports/service 类型、生产与内存两个 Adapter、角色包公开契约。若实施中出现大批文件删除，先列出精确目标并另行执行二次确认门。

## 5. 验收

完成标准：定向 RED/GREEN、相关 package test/typecheck、Scanner build、容器候选、临时 PostgreSQL migration 行为、迁移 Adapter fake 测试、双 Adapter 契约测试、`verify:cloudbase`、`verify:website`、`verify:web-chain`、scope 和 `git diff --check` 全部通过。

验收记录必须分别写明：阶段 2A、阶段 2B、阶段 3、CloudBase 开发环境未执行、生产未部署、投稿开关仍关闭。只有 2A、2B、3 全部通过才恢复普通非投稿网站开发；否则明确写“继续冻结”。共享包投稿仍由以后独立的阶段 2C 远程验收门冻结。
