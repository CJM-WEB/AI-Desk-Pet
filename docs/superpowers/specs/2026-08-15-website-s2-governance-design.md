# 网站阶段四 S2 持续治理设计

> 文档状态：已按用户 2026-08-31“开始执行阶段四”及此前逐环自主执行授权确认
> 日期：2026-08-31
> 目标分支：`WebsiteExtension`
> 适用范围：官网、CloudBase API、网站共享运行时契约、数据库前向迁移、发布工具与网站链验证
> 实施方式：规格驱动开发、测试驱动开发、子智能体驱动开发

## 1. 目标

阶段四不重写整站，而是逐条替换已经证实的 S2 旧语义和浅接口。每个纵向切片必须先建立可失败的行为测试，再用一条正式路径替代旧路径，并在同一任务中删除失去职责的旧代码或测试。

本阶段完成以下本地可执行治理：

1. 公开社区、反馈和管理员队列从数字 offset 迁移为版本化 keyset cursor。
2. 点赞改为 desired-state 与 `operationId` 幂等写入。
3. 下载计数改为“成功签发次数”，签名成功且幂等计数成功后才返回 URL。
4. 建立发布结构不变量，并隔离单条损坏公开记录，避免拖垮整页。
5. CloudBase PostgreSQL REST RPC 获得独立 deadline、响应字节上限和有界 JSON 读取。
6. Release Manifest 由一个 published/unpublished 运行时契约拥有。
7. CloudBase 服务只依赖所需能力端口，删除重复端口成员和无生产消费者的方法。
8. i18n 以 `zhCN` 为唯一消息键权威，删除 type-only 循环。
9. 记录 `LiquidGlassHome` 跨章节事件已由后续减法规格删除，不重新建立事件总线。
10. 生产 Router 保留条件裁决门，等待阶段 2C 的真实 CloudBase 网关 `/api` 前缀证据。

## 2. 非目标

- 不修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**` 或 `packages/character-assets/**`。
- 不执行 CloudBase 开发环境或生产环境 migration、函数、Scanner、Hosting、域名或数据写入。
- 不开启共享包投稿，不正式部署，不合并、变基、推送或创建 PR。
- 不删除 IndexedDB/LocalStorage 历史 Repository、旧首页文件、CSS 或资产；这些属于阶段五按簇退役，并继续受大量删除二次批准门约束。
- 不裁决生产 `createRouter` 保留或删除，不根据本地注释猜测真实网关 path。
- 不增加安装完成、真实下载字节、用户账号或长期用户画像遥测。
- 不扩大版本范围；Release Manifest 继续只支持 `windows-x64`、`x.y.z-alpha.n` 和当前未签名事实。

## 3. 当前证据与替代关系

### 3.1 已证实的旧路径

- `cursor` 在共享 Schema、端口、API、网站 Repository 和 PostgreSQL Adapter 中均为数字 offset；数据库使用 `.range(offset, ...)`。
- 点赞请求是空对象，SQL `toggle_public_like` 对同一请求重放会反向切换。
- 下载请求是空对象；服务先增加计数再签名，签名失败也会留下计数。
- 公开社区批量映射和封面签名使用 fail-fast `map`/`Promise.all`，单条坏记录可使整页失败。
- 独立 PostgreSQL REST RPC 没有 `AbortSignal`，并通过无上限 `response.text()` 读取正文。
- release-tools 和 website 分别维护 published-only 与 published/unpublished Schema。
- `SubmissionStore` 暴露多个由其他端口重复拥有或没有生产消费者的方法；`PublicContentService` 获得投稿、审核和管理等无关能力。
- `messages.ts` 与 `i18n-types.ts` 形成 type-only 循环；当前网站依赖审查为 0 error、9 warning，其中 1 条就是该循环。

### 3.2 后续规格接替

`docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md` 已明确删除四条装饰性全局事件，禁止把它们替换为 Context、store、callback props 或新事件名称。当前运行代码对五个旧事件符号零命中，因此 2026-08-15 上层规格中的“事件上移”已由“删除且不替换”接替。

`docs/superpowers/specs/2026-08-31-admin-override-publication-design.md` 继续是审核权力的最新事实来源：结构不变量不得恢复“系统扫描结论决定一切”的旧规则；结构完整但无有效通过证据的共享包仍可经 `move_to_manual` 与独立 `force_publish` 公开为 `admin_override`。

## 4. 方案比较与裁决

### 4.1 方案 A：逐条纵向替换（采用）

每个债务沿“共享 wire contract → 服务 Interface → 生产 Adapter/SQL → 网站或测试 Adapter → 删除旧路径”闭环。优点是每批可独立 RED/GREEN、可审查、可回退，并能在新增最少机制的同时立即做减法。缺点是共享契约和数据库迁移必须严格串行。

### 4.2 方案 B：建立第二套网站 V2 后整体切换（拒绝）

新建平行 DTO、Repository、Router 和数据库函数后一次切换，短期看似隔离，实际会长期保留双 owner、放大状态漂移，也违背“能不加就不加、替换后删除旧路径”。

### 4.3 方案 C：只登记债务，修改对应功能时再处理（拒绝）

该方案改动最少，但会继续保留已证实的重放错误、虚假下载计数、无界 RPC 和分页漂移，无法达到“优化达标后再开发”的目标。

## 5. 模块与 Interface

### 5.1 版本化 keyset cursor

HTTP Interface 统一为：

```ts
type PageQuery = { limit: number; cursor?: string };
type Page<T> = { items: T[]; nextCursor: string | null };
```

浏览器只把 `nextCursor` 作为不透明字符串回传，不解析、不计算 offset。生产 Adapter 私有 cursor payload 包含：

```text
version + scope + sortTime + id
```

- 社区和反馈使用 `(published_at, id)` 降序。
- 管理员队列使用 `(created_at, id)` 降序，cursor scope 同时绑定状态筛选。
- cursor 不保存私有内容，不需要签名；未知版本、错误 scope、非法时间、非法 id、超长或畸形值稳定返回 `INVALID_CURSOR`。
- cursor 不设时间 TTL；协议升级通过版本拒绝旧 cursor，不建立数字兼容 Wrapper。

CloudBase SDK 的当前链式查询 Interface 无法可靠表达复合 tuple 比较，因此新增三个前向 SQL RPC，以 `(time, id) < (cursorTime, cursorId)` 实现 keyset。Adapter 负责 cursor 编解码，数据库只接收已校验的排序锚点。

社区界面保留当前上一页/下一页产品表现。Cloud Repository 只缓存已经由服务端返回的页首 cursor；第一页刷新会丢弃后续旧 cursor，禁止跳转到尚未取得 cursor 的页码。反馈全量刷新与管理员“加载更多”只传播服务端 cursor。

### 5.2 公开互动命令

点赞 HTTP 请求替换为空对象旧协议：

```ts
type PublicLikeRequest = {
  liked: boolean;
  operationId: string; // UUID
};
```

后端 Interface 为：

```ts
setPublicLike({
  submissionId,
  fingerprintHash,
  desiredLiked,
  operationId
}): Promise<{ liked: boolean; likeCount: number }>;
```

下载 HTTP 请求为：

```ts
type PublicDownloadRequest = { operationId: string };
```

下载服务固定执行：

1. 读取并验证已发布共享包、`publicationBasis` 与唯一 package 资产。
2. 成功生成短期签名 URL。
3. 使用 `submissionId + fingerprintHash + operationId` 幂等记录一次“成功签发”。
4. 只有计数事务成功才向浏览器返回 URL。

下载计数不是安装完成数，也不证明浏览器实际读取了文件字节。历史计数不回写或猜测校正；切换后的新口径写入运维文档。

网站 Repository 为每个未完成互动保留 operationId：失败重试复用同一 ID，成功后清除。点赞对外仍可表达用户的切换动作，但发往服务端的是明确 desired state；不保留服务端 toggle Wrapper。

### 5.3 互动幂等账本与保留期

新增单一 `public_interaction_operations` 表，同时服务点赞和下载，不建立两套幂等表。账本保存最小字段：operationId、动作种类、投稿 ID、设备哈希、desired state（仅点赞）、首次结果快照、创建与过期时间。

- 同 operationId、同输入且未过期：回放首次结果。
- 同 operationId、不同投稿、设备、动作或 desired state：返回稳定幂等冲突。
- 两个不同 operationId 请求同一 desired state：保持当前状态和计数不变。
- 保留期固定 24 小时；这是互动请求重放窗口，不是技术扫描证据 TTL。
- cleanup 函数每轮有界删除最多 500 条过期记录；未部署 cleanup 时不得宣称远端保留期已生效。
- operationId、设备哈希和结果快照不得进入公开 DTO 或普通日志。

### 5.4 发布结构不变量与坏记录隔离

新增唯一 SQL 结构断言，由普通 `approve` 与 `force_publish` 共同经过的状态写入触发，不复制两份规则。

共享包进入 `published` 前必须满足：

- title/body 去空白后非空；
- cover、package 各恰好一个，derived 可多值；
- package key 精确为 `submissions/{id}/package.zip`；
- cover key 只能是投稿根内单层 `cover.png|cover.webp|cover.jpg|cover.jpeg`；
- cover/package `actual_size > 0` 且 MIME 与现行上传契约一致。

反馈和建议进入 `published` 前只要求合法 kind、非空 title/body，不要求资产或 Scanner 证据。`admin_override` 继续允许无有效技术通过证据，但不能绕过结构完整性。

前向 migration 在创建唯一索引和触发器前只读检查既有公开记录；发现冲突时整份 migration 失败，不静默修改、删除或下架远端数据。

读侧按原始候选行逐项映射；结构损坏只隐藏该项，cursor 仍锚定最后扫描的原始行。封面签名使用逐项结果：至少一项成功时返回成功项；非空候选页全部签名失败时按系统性存储故障失败，不能伪装为空页。详情或下载访问坏记录继续失败关闭。

### 5.5 有界远程 JSON

在 `apps/cloudbase-api/src/adapters` 内建立一个内部有界 JSON 读取实现，由 Scanner Client 与 PostgreSQL REST RPC 复用。该模块隐藏：

- `Content-Length` 预检；
- 实际流式字节累计；
- 超限后的 reader cancel；
- deadline 对等待响应头和读取正文的共同覆盖；
- 空正文、畸形 JSON、超限和中止分类。

生产 PostgreSQL RPC 固定复用现有 CloudBase SDK 的 15 秒 deadline，最大响应正文固定为 4 MiB。两个值在阶段 2C 以真实网关响应验证；当前不得写成生产通过。Scanner 继续使用共享 Scanner 契约的 130 秒和 12 MiB，不改变既有对外错误分类。

业务 Store 仍只看 `rpc(name, params)`；不得把 fetch、reader 或 AbortController 暴露到业务端口。PostgreSQL RPC 名称收窄为当前实际调用的可辨识字符串联合。

### 5.6 Release Manifest 单一契约

新增 `@myself/shared-types/release-manifest`，唯一拥有：

- published/unpublished 可辨识联合；
- `version`、`platform`、`fileName` 的共同身份；
- published 的 URL、大小、SHA-256、发布时间和 `signed: false`；
- unpublished 只保留共同身份，不保存可由 `version` 派生的 `plannedReleaseTag`。

release-tools 只生成 published 分支，website 同时消费两种分支。网站本地文件只保留 UI 大小格式化，不再重导出或复制 Schema。当前 JSON 删除 `plannedReleaseTag`，界面需要 `v` 前缀时从 `version` 派生。

本阶段不读取桌面 package、不构建安装包、不上传候选。外部分支安装包身份核对和真实 generator → CDN → website 字节闭环属于阶段五发布候选门。

### 5.7 CloudBase 能力端口收窄

端口按业务能力收窄，不增加运行时转发 Wrapper：

- `SubmissionStore` 只保留 prepare/finalize/status 所需的 create、find、complete、findByStatusTokenHash。
- 文本投稿创建从 `PublicInteractionStore` 移入单独 `TextSubmissionStore`。
- `PublicContentStore` 拥有公开列表、详情、desired-like 和幂等下载计数，不再向 `PublicContentService` 暴露通用私有投稿 Store。
- 各服务对对象存储使用所需 `Pick`：投稿需要上传签名与 info，公开/管理员需要下载签名，清理需要 delete。
- `CloudBasePostgresStore` 继续作为一个多接口生产 Adapter；不为每个端口建立浅 facade。
- 删除无生产消费者的 `listPublished`、`listPurgeCandidates`、`recordModerationResult` 及其类型、映射和只维护旧路径的测试。
- `CloudBaseRdbQuery` 删除当前实现零调用的 `update`、`upsert`、`single`。

### 5.8 i18n 与 LiquidGlass 职责

`zhCN` 继续作为唯一消息键权威。`messages.ts` 直接以 `keyof typeof zhCN` 约束 `en`，不再导入 `MessageKey`；`i18n-types.ts` 单向从 messages 推导并对调用者提供 `MessageKey`/`Translate`。

网站依赖审查把网站范围内的 `no-circular` 与功能层导入 `LiquidGlassHome`/shader 提升为 error。About/Download 测试删除对 shader 源码字符串的内部断言，GPU 可观察行为继续由现有 `magnetic-intro` 组件契约测试承担。

阶段四不修改 LiquidGlass 生产实现，不创建新的交互契约模块。

### 5.9 生产 Router 条件门

当前生产调用链是 `main → createProductionHandler → createApi → dispatch`；`createRouter` 只被自身测试引用。尽管存在双实现，本地证据不能证明 CloudBase 网关实际传入 `/v1/...` 还是 `/api/v1/...`。

阶段 2C 必须捕获脱敏真实 event/path 后二选一：

1. 深化 `createRouter` 接管 context、动态段、认证顺序、Schema 和错误信封，再删除旧 dispatch；或
2. 以 `createApi/dispatch` 为唯一深模块，迁移平台 event 类型后删除 `createRouter` 及其独有测试。

两条路径不得长期并存。本阶段只保存 endpoint inventory 与选择门，不修改 path 兼容行为。

## 6. 实施顺序

1. 前端契约减法：i18n 单向权威、Liquid 测试 locality、Release Manifest 单一契约。
2. 有界远程 JSON：先锁 Scanner 行为，再迁 PostgreSQL RPC。
3. keyset cursor：社区、反馈、管理员按顺序迁移，删除 numeric cursor 与死列表路径。
4. desired-state 点赞：共享请求、SQL、服务、网站与 Memory 同步替换 toggle。
5. 幂等下载：复用互动账本，签名先于计数，删除旧计数函数。
6. 发布结构不变量与坏记录隔离。
7. 在数据 Interface 稳定后收窄 CloudBase 能力端口并删除死方法。
8. 运行网站全门，更新阶段索引与验收记录；Router 继续标记等待阶段 2C。

共享 Schema、同一 migration、同一状态机或同一端口文件上的任务必须串行，不能由多个实现子智能体并行写入。

## 7. TDD 与验证

### 7.1 定向 RED/GREEN

- cursor：同时间 id 定序、页间插入/删除、跨 scope、畸形和未知版本。
- 点赞：同 operation 重放、不同 operation 同 desired state、冲突复用、两设备和并发。
- 下载：签名失败不计数、计数失败不返回 URL、响应丢失重试只计一次。
- 发布不变量：缺失/重复/错误路径/零大小不能普通或强制发布；结构合法的 `admin_override` 仍可发布。
- 坏记录：`[合法、损坏、合法]` 返回两条；全部签名失败仍是错误。
- RPC：等待响应头超时、读取正文超时、声明超限、分块超限、恰好上限和畸形 JSON。
- Release Manifest：两分支共享解析、生成器输出可由网站消费、冗余 tag 与额外字段拒绝。
- i18n：中英文键集、插值和未知键类型不退化，依赖审查循环归零。
- 能力端口：最小 fake 可构造各服务，旧宽方法不再是 Interface 成员。

### 7.2 自动门

每项先运行定向测试和 typecheck。数据库行为必须由本地 PostgreSQL 17 顺序执行全部 migration 验证，不能以 SQL 源码字符串代替。阶段收口至少运行：

```powershell
pnpm.cmd deps:audit:web
pnpm.cmd verify:cloudbase
pnpm.cmd verify:website
pnpm.cmd test:website-contract
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
```

如果本地 PostgreSQL runtime 的实际路径不同，只允许显式提供已验证的 PostgreSQL 17 runtime；不得把缺环境变量的停止写成实现失败，也不得跳过真实 SQL 行为门。

### 7.3 外部未验证项

阶段四本地通过不证明以下事项：真实 CloudBase 网关 path、RPC 压缩/流行为、数据库存量结构、索引计划、cleanup 实际调度、远端 migration、函数/Scanner/Hosting 部署或正式网站上线。这些项目继续等待阶段 2C 或阶段五授权与证据。

## 8. 删除纪律与恢复

本阶段不计划大量删除文件，因此不触发网站文件簇二次批准。每个替换任务仍必须删除对应的：

- 数字 cursor 类型、offset 计算、`.range` 列表路径和只锁旧语义的测试；
- `toggle_public_like` 与无 operationId 的 `record_public_download`；
- 两份 Release Manifest Schema 中的本地复制；
- 无界 JSON reader；
- 重复 Store 成员、死方法和死映射；
- i18n 反向类型导入与 shader 内部字符串测试。

数据库历史 migration 永不修改；旧 SQL 函数只通过新前向 migration 撤权并删除。Git 提交是恢复点，不执行 merge、rebase、push 或破坏性回退。

## 9. 完成定义

阶段四本地治理完成需同时满足：

- 八项本地可执行债务均有实现、删除证据和定向测试；
- `LiquidGlassHome` 项明确为已由 8/20 减法规格接替，生产代码零新增；
- Router 项明确为“等待阶段 2C 真实证据”，没有预判或永久双轨认可；
- PostgreSQL 17 全 migration 与行为测试通过；
- production 与 Memory 网站 Adapter 对新 wire 行为一致；
- website、CloudBase、合同、依赖、范围、归属和完整网站链门通过；
- 网站依赖审查从 9 个 warning 降为只剩阶段五旧文件候选，不再有 i18n 循环；
- 没有桌宠黑名单路径差异，没有远端写入，没有部署或上线声明；
- 阶段索引和验收记录只写实际执行证据及仍待 2C 的事项。
