# 2026-08-13 全仓架构审查报告

## 1. 执行摘要

本轮在 `main_Graphify_test` 分支完成只读架构审查。设计批准时的业务基准是 `4ddb14f04f12b3f9341de47a866854450afb24ee`；Graphify 与分域审查快照是 `a05294be01ecea0a420aa7951508b2af3259a3c5`，两者之间只增加了本轮已批准的设计/计划提交，业务源码未改变。范围包含 10 个 pnpm workspace、桌宠 Electron 全链路、网站/CloudBase/PostgreSQL/扫描器、测试、构建、发布、资源投影和长期文档。最终经跨域去重保留 **30 项**：S0 2、S1 6、S2 18、S3 4。

最高优先级有三件事：禁止未携带当前技术扫描证据的共享角色包被批准公开（`W-S0-1`）；将 Agent mutating IPC 和完整确认票据限定到当前聊天窗口（`D-S0-1`）；冻结现有 CloudBase migration runner 的部署使用，直至建立有账本、事务和数据库级互斥的 runner（`G-S1-1`）。本报告只诊断和规划，没有修复 Bug、新增功能或修改业务代码。

### 1.1 范围、方法与非目标

方法是“Graphify 候选索引 → package/源码/配置/SQL/测试/规格回源 → 分域独立复核 → S0/S1 主流程再核验 → 跨域去重”。Graphify 的中心性和社区只决定阅读顺序，不直接产生缺陷。

非目标：不运行生产迁移或部署；不访问真实 CloudBase、Bucket、CloudBase Run、GitHub Release 或用户数据；不构建/打包；不重构、移动、删除业务文件；不修改依赖、锁文件、workspace 或 `.gitignore`；不把 Graphify 加入项目运行或构建。

### 1.2 最终计数

| 域 | S0 | S1 | S2 | S3 | 合计 |
|---|---:|---:|---:|---:|---:|
| 桌宠 `D-*` | 1 | 2 | 6 | 2 | 11 |
| 网站与云端 `W-*` | 1 | 2 | 8 | 1 | 12 |
| 工程治理 `G-*` | 0 | 2 | 4 | 1 | 7 |
| **总计** | **2** | **6** | **18** | **4** | **30** |

Task 6 曾识别的 release manifest 双 schema owner 已并入 `W-S2-5`，工程域只追加候选产物门禁，不重复计数。网站 adapter 状态漂移（`W-S2-1`）与网站 E2E 假后端复制状态机（`G-S2-1`）分别是生产边界解析和测试等价机制两个根因，保留为独立问题。

## 2. Graphify 产物与可信度

- 版本：`graphifyy==0.9.41`。
- 外置安装：`D:\Python\Graphify\tool\.venv`。
- 外置产物目录：`D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out`。
- 规模：5,546 节点、12,435 边、242 communities（报告展示 213，省略 29 个 thin communities）。
- `D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json`：8,088,558 bytes。
- `D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\GRAPH_REPORT.md`：49,001 bytes。
- `D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.html`：6,224,639 bytes。
- 可信度裁决：**有限通过**。仅已进入 manifest 的源码级 `imports`、`imports_from`、`re_exports` 且 `EXTRACTED/1.0/ast` 可作候选；每条结论仍回源。

七个正向 workspace 依赖样本均由 package 声明、生产 import 和图边三轨命中。负向边界只能范围化成立：website 与 desktop 的生产静态模块互不依赖，packages 不依赖 apps；但 `apps/website/tests/default-character-assets.test.ts:6-41` 通过 `new URL`/`readFile` 直接验证桌面资源，Graphify 未表达这条测试期发布投影关系。

### 2.1 已知缺口

五个零节点 JSON：

1. `cloudbaserc.json`
2. `apps/website/content/release-manifest.json`
3. `apps/desktop/resources/windows/explorer-space-integrity.json`
4. `apps/desktop/resources/characters/default/sprite-metadata.json`
5. `apps/website/public/characters/default/sprite-metadata.json`

三个未解析 SQL：

1. `cloudbase/migrations/20260730000000_moderation.sql`
2. `cloudbase/migrations/20260807000000_public_like_kinds.sql`
3. `cloudbase/migrations/20260808000000_direct_manual_review.sql`

此外 `apps/desktop/electron-builder.yml`、`apps/package-scanner/Dockerfile` 和 `pnpm-workspace.yaml` 也在图外。全图 296 条 `INFERRED` 边（251 条 0.8、45 条 0.5）均默认隔离。`package.json` 依赖文本会被错误消歧到另一 workspace 的同名节点，不能证明跨包方向。Electron IPC、DI、事件、Provider factory 和 HTTP/HMAC 仅部分或完全不覆盖。`graph.html` 仍从 `https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js` 加载可视化库，因此不是完全离线自包含文件。

## 3. S0/S1 主流程回源复核

| ID | 两类以上独立证据 | 复核结果 |
|---|---|---|
| `D-S0-1` | 生产控制流：所有窗口共享 preload、完整 TaskEvent 广播、Agent handler 忽略 sender；相反 seam/测试/规格：同文件角色 IPC 已校验 sender，安全测试未覆盖 sender，MVP 规格要求用户确认 | S0 成立：同应用非聊天 Renderer 被注入或攻陷后可读取 actionId 并静默确认，可能使用户在场边界失效 |
| `D-S1-1` | Store 恢复顺序与异常控制流；工作室/V2 规格要求坏角色隔离且保留数据，现有测试只覆盖合法 crash marker | S1 成立；draft 和 publish 必须分面，不能用统一 blocked 误伤健康 compiled runtime |
| `D-S1-2` | marker 最终文件直接写与初始化 fail-stop；仓库已有 temp/sync/rename primitive，规格要求中断可恢复而测试缺坏 marker | S1 成立；需要 exclusive 原子发布、逐 marker 隔离与 owner 身份复核 |
| `W-S0-1` | 最新 SQL、服务和 UI 均允许人工队列直接批准；匿名审核规格与当前运维手册要求技术扫描失败关闭 | S0 成立：源码证明未扫描包可提交、批准并公开；具体恶意载荷是否动态成功仍需安全环境验证 |
| `W-S1-1` | `cloudbaserc.json` 明示三个部署单元；`CloudConfig` 与三个 composition root 证明无关配置被强制读取 | S1 成立：停用审核配置可阻断 API/cleanup 的独立演进与运行 |
| `W-S1-2` | Scanner client/server 独立维护协议与签名；双方测试各自复制算法且没有真实 client↔server 契约测试 | S1 成立：恢复扫描或单侧发布时有安全协议漂移风险，失败关闭但会阻断审核 |
| `G-S1-1` | runner 固定首份 SQL；目录有三份前向 migration 且部署手册把 runner 作为当前入口 | S1 成立：新/旧环境都无法由仓库证明推进到当前 schema |
| `G-S1-2` | 根 Vitest project 集合只覆盖核心/desktop；四个 workspace 自有 test 与两份工具测试无根 owner | S1 成立：`pnpm test` 可全绿却不代表全仓，且新增 workspace 不会令总门失败 |

## 4. 桌宠域问题

来源：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/reviews/02-desktop-domain.md`；独立复核最终 PASS：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/task-4-review.md`。

### D-S0-1：Agent IPC 未按当前聊天窗口授权，完整确认票据广播给所有 Renderer

- **发现方式**：人工回源；Graphify 不覆盖 Electron channel 配对、sender 或事件广播语义。
- **当前行为/触发**：pet/chat/settings/workshop 使用同一 preload；Main 将含 `actionId` 的完整 `pending_action` 广播给四类窗口；submit/cancel/confirm/disclosure/reset handler 忽略 `_event.sender`。非聊天 Renderer 一旦被脚本注入、依赖污染或单点攻陷，可读取票据并调用 confirm。
- **证据路径**：`apps/desktop/src/main/windows/window-manager.ts:18-25,51-90`；`apps/desktop/src/preload/index.ts:125-146`；`apps/desktop/src/main/index.ts:733-740`；`apps/desktop/src/main/ipc/register-ipc.ts:114-140`；`packages/shared-types/src/contracts.ts:253-266`。相反 seam 位于 `apps/desktop/src/main/ipc/register-ipc.ts:649-681,709-777`；测试缺口见 `apps/desktop/tests/agent-ipc.test.ts:87-100`。
- **影响**：可能绕过聊天确认卡所代表的用户在场安全边界；Main 私有执行对象和路径复核仍有效，但不能补偿窗口授权缺失。
- **目标 seam**：`AgentIpcAuthorization.assertChatSender(event)` 位于每个 Agent mutating handler 首步，动态读取当前 chat `WebContents`；`ConversationEventProjection` 只向 chat 投完整事件，pet 仅接行为/必要 phase 投影。
- **最小迁移**：先写非法/当前/旧 chat sender 红测；加入动态 sender guard，不改 channel/DTO；再收窄完整事件广播；最后按窗口收窄 preload 类型，避免同时重写 `MyselfApi`。
- **TDD 验收**：非 chat 和旧 chat sender 全部失败且 service 零调用；当前 chat 成功；非 chat 收不到 command/contentPreview/actionId；文件与 PowerShell E2E、桌宠动作保持通过。

### D-S1-1：单角色损坏 journal 可阻断整个桌面启动

- **发现方式**：Graphify 的 `CharacterStore` 高连接节点只用于定位；恢复顺序、文件异常和启动退出链均由人工源码/规格核验。
- **当前行为/触发**：有效 index 加载后串行恢复每个角色 draft/publish；任一 marker JSON/schema 异常抛错，且发生在官方启动 fallback 之前，最终进入全局退出。
- **证据路径**：`apps/desktop/src/main/characters/character-store.ts:889-918,1158-1163,1187-1221,1312-1376,1486-1494`；`apps/desktop/src/main/index.ts:358-385,916-922`；隔离要求见 `docs/operations/character-workshop-acceptance.md:15-16,58-61` 和角色 V2 规格。
- **影响**：一个非活动角色也能使所有角色、设置和桌宠不可用；若修复用统一 blocked，又会让仅草稿损坏的健康 compiled runtime 不必要退化。
- **目标 seam**：`CharacterTransactionRecovery` 每角色返回 `Healthy | DraftRecoveryBlocked | PublishRecoveryBlocked | DraftAndPublishRecoveryBlocked`，并保留原 marker。
- **最小迁移**：补 active/non-active × draft/publish/并存矩阵红测；逐角色、逐 journal 收集状态；draft blocked 只封锁会覆盖证据的 draft save/publish；publish blocked 才封锁 runtime，且仅 active 角色走现有 fallback。
- **TDD 验收**：坏 draft + 有效 compiled 仍能运行；坏 publish 仅隔离该角色；组合状态同时施加两组限制；健康角色与合法 crash recovery 不回归，marker 原字节不变。

### D-S1-2：Package rollback marker 非原子写入，截断 journal 会令下次启动 fail-stop

- **发现方式**：Graphify 热点只用于定位 `CharacterPackageService`；durability、异常传播和启动顺序由人工回源。
- **当前行为/触发**：pending/preserve marker 以 `writeFile(final,{flag:'wx'})` 直接写最终文件；启动逐项 `JSON.parse`，任一空/半 JSON/未知 schema 使初始化抛错并在 fallback 前退出。
- **证据路径**：`apps/desktop/src/main/characters/character-package-service.ts:1322-1457`；`apps/desktop/src/main/index.ts:371-385,916-922`；可复用原子 primitive 在 `apps/desktop/src/main/storage/atomic-file-coordinator.ts:56-71`。
- **影响**：导入进程中断可阻断无关角色；marker 丢失与 owner 已提交组合还可能留下不可识别的半安装角色。
- **目标 seam**：`CharacterImportJournal.createExclusive/readPending/complete/preserveCorrupt`，提供 Windows 上不覆盖已存在 final 的原子发布语义和故障注入 adapter。
- **最小迁移**：先补坏 marker 与 kill-point 红测；唯一 temp 写入、sync、exclusive 原子安装；逐 marker 隔离并保留 `.corrupt-*` 证据；只有 Store owner token 与物理身份完全匹配才回滚角色。
- **TDD 验收**：open、半写、写完未发布、owner/source/publish 后终止均可重启；只回滚身份匹配对象；坏 marker 不泄露路径、不阻断应用且保留证据。

### D-S2-1：TaskEvent 只有瞬时 push，聊天 reload/显式销毁重建无法恢复展示状态

- **发现方式**：人工发现；Graphify 对事件回调/跨进程 push 仅部分覆盖，不能证明展示恢复语义。
- **当前行为/证据**：Main 只 `send(taskEvent)`；`MyselfApi` 无 snapshot/revision；Renderer 从 idle 开始。见 `apps/desktop/src/main/index.ts:733-740`、`apps/desktop/src/shared/myself-api.ts:165-174`、`apps/desktop/src/renderer/src/stores/task-store.ts:57-75,293-315`。
- **影响/触发**：running、disclosure、awaiting confirmation 期间 reload 或显式重建后 UI 空闲但 Main 仍持有任务；此结论不宣称 render process crash 已自动重建。
- **目标/迁移**：在既有 emit seam 维护有界 `ConversationPresentationState`，新增 chat-only snapshot 与 revision，Renderer 采用“先订阅缓冲→取快照→按 revision 合并”。
- **TDD 验收**：reload/显式销毁重建恢复 phase、消息和卡片；无丢重；schema 不含私有路径、continuation 或 verified action。

### D-S2-2：Unicode 长度口径与 preload TaskEvent 运行时解析漂移

- **发现方式**：人工发现；静态类型 import 边不能证明各入口的运行时计数/解析一致。
- **当前行为/证据**：Coordinator 按 code point，HTML/IPC/Agent 按 UTF-16 length；preload 将未知 payload 直接当 `TaskEvent`。见 `apps/desktop/src/main/conversation/conversation-coordinator.ts:658-664`、`apps/desktop/src/renderer/src/chat/ChatPanel.tsx:294-306`、`apps/desktop/src/main/ipc/register-ipc.ts:88-90`、`apps/desktop/src/main/agent/agent-service.ts:274-284`、`apps/desktop/src/preload/index.ts:143-146`。
- **影响/触发**：4000 emoji 的已定义合法输入会更早被拒；malformed event 可进入 Store reducer。
- **目标/迁移**：复用纯 `UserMessageLengthPolicy` 与现有 `taskEventSchema.safeParse` 两个窄能力，不建立宽会话 contract。
- **TDD 验收**：4000 code points 全链成功、4001 各入口同错；非法事件不到 Store，合法 union 各一次。

### D-S2-3：备用模型配置与真实执行/披露矩阵不一致

- **发现方式**：人工回源；Provider runtime 装配在 Graphify 中仅部分覆盖且含 `INFERRED` 候选，本结论未使用未核验边。
- **当前行为/证据**：普通 chat 无 fallback；Agent 无 visibleHistory 时仅 same-provider fallback；有 history 时不 fallback；cross-provider 未执行。见 `apps/desktop/src/main/conversation/main-conversation-composition.ts:103-153,223-245`、`apps/desktop/src/main/agent/agent-service.ts:149-170,677-687`、`packages/agent-core/src/model-router.ts:57-109`。
- **影响/触发**：UI 承诺超过执行能力；若直接接线，可能把历史发给未披露目标或在工具副作用后重放。
- **目标/迁移**：深化现有 `ModelSelection`，为 fallback 附 target identity/disclosure 状态；先收窄 UI，再接普通 chat same-provider，跨 Provider 另立规格由 Coordinator 切换。
- **TDD 验收**：四格矩阵明确；实际目标披露前不执行；non-retryable 和工具副作用后不转移/重放。

### D-S2-4：Provider 设置没有单一 mutation 权威，保存成功早于 reset 收敛

- **发现方式**：人工发现；Graphify 可定位两个 handler，不能裁决生产消费者、补偿事务或 `await` 因果。
- **当前行为/证据**：legacy save 无补偿，advanced path 有事务补偿；配置 change callback fire-and-forget。reset 会同步清 snapshot/推进 generation，因此真实问题不是旧 snapshot，而是 RPC 过早成功、失败仅日志可见、cleanup 失败可能长期 `resetting`。见 `apps/desktop/src/main/ipc/register-ipc.ts:170-217,286-310`、`apps/desktop/src/main/settings/desktop-settings-service.ts:282-319`、`apps/desktop/src/main/index.ts:873-885`、`apps/desktop/src/main/conversation/conversation-coordinator.ts:355-400`。
- **目标/迁移**：`DesktopSettingsService` 成为唯一 mutation module；legacy 先委托；`onConfigurationChanged(): Promise<void>` 被 await，并显式建模清理失败与安全恢复。
- **TDD 验收**：任一失败点无 secret/metadata 错配；RPC 在 reset 收敛后 resolve；失败 Renderer 可见且 Coordinator 不永久卡住；消费者验证后删除旧 channel/preload/API。

### D-S2-5：CharacterStore 当前 writer 与 Asset legacy recovery authority 共存

- **发现方式**：人工发现；Graphify 不表达两个 module 对同一 `compiled/` 目录的写入/recovery authority。
- **当前行为/证据**：生产发布由 Store 写整目录；Asset `saveCompiled` 无生产调用，但任一 source API 仍先恢复旧 compiled marker并触碰同目录。见 `apps/desktop/src/main/characters/character-asset-service.ts:807-835,1048-1189,2087-2103,2233-2408` 与 `apps/desktop/src/main/characters/character-store.ts:713-747,1056-1136`。
- **影响/触发**：旧 recovery 可能回滚已有效的 V2 published，且两套锁无共同序列化 seam。
- **目标/迁移**：一次性 `LegacyCompiledAssetHandoff` 必须先于 Store recovery/publish 和 Asset source API；有效 V2 优先、逐角色隔离、幂等、失败留原字节。矩阵通过后才删除旧 writer/recovery/test。
- **TDD 验收**：有效 V2 永不回滚；健康/坏 marker 混存不全局阻断；成功才删 marker；source 操作最终不访问 `compiled/`。

### D-S2-6：Package importer 穿透 source 隐式布局并绕过并发 seam

- **发现方式**：Graphify 热点用于定位；`source/catalog.json` 布局、lease 与外层 saga边界由人工源码核验。
- **当前行为/证据**：PackageService 自拼 `source/`、复制文件和写 `catalog.json`，之后才调用 Asset 验证；见 `apps/desktop/src/main/characters/character-package-service.ts:1895-1978`。
- **影响/触发**：布局和 lease/并发规则变化会扩散到 Package；测试需继承完整 concrete。
- **目标/迁移**：只将 source 安装切片收进 `CharacterSourceImportPort`，复用 Asset lease/catalog transaction；ZIP trust boundary、package marker、Store owner 和外层 rollback saga 不迁移。
- **TDD 验收**：source checkpoint 故障整角色回滚；与 list/import 并发；Package 不再直接写 `source/catalog.json`。

### D-S3-1：V2 atlas 校验构造完整 V1 manifest

- **发现方式**：人工发现；Graphify 的静态 V1 import 只提示候选，是否为真实耦合由调用用途裁决。
- **当前行为/证据**：`apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts:165-215` 为验证 frames 构造完整 V1 state/action；最终产物为 V2。`Pick<CharacterManifestV1,'id'|'resources'>` 只是低风险类型来源，不与主问题同级。
- **影响**：V2 编译器被无关 V1 state/action 结构牵制，收缩 V1 compatibility surface 时产生额外修改和回归面。
- **目标/迁移**：复用最小 frames schema/validator，删除伪 V1 文档；保留真实 converter/migration/projection。
- **TDD 验收**：atlas、V1 converter、V2 workshop 通过；生产 atlas compiler 不再依赖完整 V1 manifest。

### D-S3-2：测试 seam 被复制类型与过宽 API 穿透

- **发现方式**：人工发现；Graphify 的测试文件行数/连接度只用于导航，复制类型、cast 和断言方式由源码核验。
- **当前行为/证据**：E2E 复制 `ElectronFixtureModule`；CharacterPlayer 接完整 `MyselfApi` 导致大量 cast；部分安全测试断言源码字符串。见 `tests/e2e/desktop.spec.ts:33-345`、`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx:45-55`、`apps/desktop/tests/character-player.test.tsx`、`apps/desktop/tests/window-security.test.ts:229-265`。
- **影响**：fixture/API 漂移不能在稳定 interface 上尽早失败，测试被迫绕过类型；若错误替换静态检查又会丢失构建边界保护。
- **目标/迁移**：使用 `typeof import`、`Pick<MyselfApi,...>`，只将应验证行为的断言迁到 executable seam；静态构建/wiring 检查保留，E2E 拆文件仅为可选导航清理。
- **TDD 验收**：fixture 改名编译失败可见；对应 casts 清零；sender 行为真实执行；有效静态检查仍在。

## 5. 网站与云端域问题

来源：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/reviews/03-web-cloud-domain.md`；独立复核最终 PASS：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/task-5-review.md`。

### W-S0-1：新共享角色包可绕过隔离扫描直接发布

- **发现方式**：人工回源；SQL、worker触发和 HTTP状态不在 Graphify 覆盖内，图只用于定位 API/服务候选。
- **当前行为/触发**：最新 migration 将完成上传的新共享包从 `uploading` 直接置为 `manual_review_pending`；服务、SQL 和管理员 UI 都允许该状态直接批准。管理员只能看封面、文字、元数据和已有结果，无法人工等价完成 ZIP 内部、ClamAV、图片/JSON 与路径碰撞检查。
- **证据路径**：`cloudbase/migrations/20260808000000_direct_manual_review.sql:4-64,113-244`；`apps/cloudbase-api/src/services/admin-service.ts:74-92`；`apps/website/components/admin/AdminDetail.tsx:24-30,113-145`；安全要求见 `docs/superpowers/specs/2026-07-30-cloudbase-anonymous-moderation-production-design.md` 与 `docs/operations/content-moderation.md:7-12,29-38`；后发规格明确称该行为为临时绕过。
- **影响**：当匿名共享包入口开放且管理员批准无当前 scan pass 的记录时，未验证的 ZIP 可进入 `published` 并获得公开下载地址。源码证明门禁路径失效；某个具体恶意载荷能否经过真实存储并在终端造成结果仍需动态验证。
- **目标 seam**：唯一 `SharedPackagePublicationGate` 输入当前投稿、资产身份和 `PackageScanEvidence`；服务 adapter 给稳定错误，SQL adapter 在事务内复核同一不变量。
- **最小迁移**：立即禁止 `manual_review_pending + shared_package + 无当前 scan pass` 的 approve；恢复新共享包 `uploading → system_reviewing → manual_review_pending`；worker 写入与当前 storageKey/size/hash 绑定的证据；同步 UI/runbook。反馈与建议继续人工。
- **TDD/动态验收**：服务与 SQL 均拒绝缺失/陈旧证据；有效当前 scan pass 才批准；开发环境运行干净包、EICAR、安全边界包、超时和重试 E2E；UI/服务/SQL 三层结论一致。

### W-S1-1：三个独立 CloudBase 函数被单一全量 CloudConfig 绑定

- **发现方式**：Graphify 的三个静态 `loadCloudConfig` import 是 `EXTRACTED/1.0/ast` 候选；独立部署拓扑与字段需求由图外配置/源码回源。
- **当前行为/触发**：API、moderation、cleanup 是三个独立部署单元，却都调用强制读取数据库、Bucket、管理员、风控、TMS/IMS 和 scanner 全集的 `loadCloudConfig`。
- **证据路径**：`cloudbaserc.json:3-24`；`apps/cloudbase-api/src/config.ts:2-18,41-87`；`apps/cloudbase-api/src/functions/api.ts:568-588`、`apps/cloudbase-api/src/functions/cleanup.ts:33-45` 证明实际需求更窄；配置测试只覆盖全集。
- **影响**：停用审核子系统的缺失/轮换配置会让公开 API 503 或阻断 cleanup，扩大可用性和数据保留故障域。
- **目标 seam**：`loadApiConfig`、`loadModerationWorkerConfig`、`loadCleanupConfig`，共享基础只含 env/region/key/bucket；每个 composition root 只接自己的 adapter。
- **最小迁移**：先写三套最小环境矩阵；抽共享读取器；按 cleanup→API→moderation 逐入口切换；全集检查仅保留为部署验证命令。
- **TDD 验收**：API 无 scanner/TMS 配置仍处理公开请求；cleanup 无 admin/scanner/TMS 仍构造；moderation 缺真实必需项必须失败关闭；三个 bundle 与 `cloudbaserc` 对齐。

### W-S1-2：CloudBase 与 scanner 的安全协议没有单一可执行 owner

- **发现方式**：Graphify 只能分别定位 client/server 本地 import，未表达跨应用 HTTP/HMAC seam；协议重复由人工回源。
- **当前行为/触发**：client 与 server 各自维护 body、timestamp、HMAC canonicalization、header、路径、schema、状态码和错误映射；两侧单测各自复制算法，没有真实 client 调临时 server 的契约测试。
- **证据路径**：`apps/cloudbase-api/src/adapters/scanner-client.ts:18-59,74-186`；`apps/package-scanner/src/request-signature.ts:97-143`；`apps/package-scanner/src/server.ts:176-323`。
- **影响**：任一侧单独演进后本侧测试仍绿，部署时却 unauthorized/unavailable/invalid-response，审核持续失败。失败关闭保住安全，但核心发布链被阻断。
- **目标 seam**：小型 `ScannerProtocol` contract module 拥有版本、request/response/error schema 和 canonical signing input；CloudBase/Scanner 分别是 HTTP client/server adapter，测试提供 in-memory adapter。
- **最小迁移**：先加真实 client↔server 契约测试锁现状；依次下沉 schema/常量和签名 canonicalization；逐侧替换后删除复制；双版本期只有明确 version adapter，设删除门。
- **TDD/构建验收**：成功、篡改、过期、重放、422、503、超大/畸形响应；两部署产物独立 build 后互通；HMAC 恒时比较、五分钟窗口、白名单和失败关闭不变。

### W-S2-1：网站共享包 adapter 绕过运行时 schema并保留旧审核状态

- **发现方式**：Graphify `EXTRACTED/1.0/ast` 显示该 adapter 仅 import `SubmissionReceipt` 类型而未 import schema；行为和文案由人工核验。
- **当前行为/证据**：共享包 adapter 只导入 `SubmissionReceipt` 类型，自建响应 interface并把 finalize 泛型写为 `system_reviewing`；后端已返回 `manual_review_pending`，共享包与反馈成功文案仍固定“系统审核”。见 `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts:12-32,80-135`、对应测试和 `apps/website/components/i18n/messages.ts`；反馈 adapter 已有 `submissionReceiptSchema.parse` 可复用。
- **影响/触发**：真实响应被错误类型掩盖，用户说明错误，畸形 DTO 延迟到渲染失败，测试假绿。
- **目标/迁移**：该 repository 成为唯一浏览器边界 adapter；未知 JSON 先经共享回执或本地公开 DTO schema，再映射 UI model；共享包和反馈均按 `receipt.status` 选文案。
- **TDD 验收**：manual/system 两状态文案正确；缺字段、错误日期/计数/URL 稳定映射 `INVALID_RESPONSE`；反馈现有解析不退化。

### W-S2-2：正式源码仍承载仅供历史测试的本地 repository

- **发现方式**：Graphify 只提供实现候选；生产可达性由 package/import/符号引用搜索人工确认，未用图缺边裁决。
- **当前行为/证据**：IndexedDB/LocalStorage 实现只被自身测试实例化，生产 registry 只创建 cloud adapters；为兼容旧实现，interface 含 test-only optional 方法和 Blob/URL 双字段。见 `apps/website/components/website-experience/community/shared-pet-types.ts:25-43,72-98` 与生产引用搜索。
- **影响/触发**：旧 prototype 浅化当前 interface，云端演进需继续理解两套能力。
- **目标/迁移**：正式 repository 只表达当前云端页面需求；tests/support 提供同 interface 的 in-memory adapter；迁移仍有价值的行为后删除旧 implementation、字段和内部存储测试。
- **TDD 验收**：生产仅 cloud adapter；interface 无 test-only optional；页面测试不穿透 IndexedDB/localStorage；语言偏好 localStorage 不受影响。

### W-S2-3：offset 被命名为 cursor，集合变化会跳项或重复

- **发现方式**：Graphify 只定位 repository→store 静态候选；分页语义、排序键和集合变化由人工回源。
- **当前行为/证据**：store 用 `.range(offset,offset+limit)` 并返回下个数字，网站又将页码换 offset；排序键没有进入 cursor。见 `apps/cloudbase-api/src/ports.ts:133-137`、`apps/cloudbase-api/src/adapters/cloudbase-postgres.ts:424-447,556-574`、网站两个 cloud repository。
- **影响/触发**：翻页间发布、下架或管理员处理记录，后页集合位移，造成重复/漏项。
- **目标/迁移**：store 隐藏 `(published_at,id)` / `(created_at,id)` 的版本化 keyset cursor；按单一公开列表→反馈→管理员队列纵向迁移，短期版本 adapter 后删除 numeric cursor。
- **TDD 验收**：页间插入、删除、状态变化无重复/跳项；非法/过期 cursor 稳定 400；同时间由 id 定序。

### W-S2-4：公开互动写入不可安全重放，下载计数早于签名

- **发现方式**：Graphify 可定位 API→服务候选；SQL事务和网络失败次序由人工回源。
- **当前行为/证据**：like 是 toggle，相同请求重放会反向；下载先记数再签名，签名失败仍计数。见 `apps/cloudbase-api/src/functions/api.ts:253-287`、`apps/cloudbase-api/src/services/public-content-service.ts:85-120,156-179`、`cloudbase/migrations/20260807000000_public_like_kinds.sql:36-64`。既有规格要求失败下载不计数。
- **影响/触发**：响应丢失重试使 UI 意图反转；签名依赖失败产生虚假“成功签发”计数。当前服务端不能证明浏览器真实传输或安装完成。
- **目标/迁移**：`PublicEngagementCommand` 使用 desired state + operationId；下载以 operationId 幂等记录“签名地址生成且计数成功后返回响应”，不混入客户端完成遥测。
- **TDD 验收**：同 operation 重放同结果且只计一次；签名失败不计数；计数失败不返回成功 URL；指标只称成功签发。

### W-S2-5：release manifest 生产者与消费者各自维护 schema

- **发现方式**：人工发现；Graphify 不覆盖 release JSON 与文件生成/消费关系，双 schema 由源码/package 搜索确认。
- **当前行为/证据**：release tool 自建 published-only schema，website 自建 published/unpublished schema；字段和测试重复，真实 generator 输出未直接喂 consumer。见 `tools/release/src/generate-manifest.ts:7-21`、`apps/website/lib/release-manifest.ts:3-26`。
- **影响/触发**：平台/字段演进要同步两份定义，遗漏会在生成或网站 build 不同阶段暴露；候选安装包、manifest、网站消费也没有单一联合门。
- **目标/迁移**：纯 `ReleaseManifest` discriminated contract；工具只生成 published variant，网站消费联合；先加真实产消契约测试，再切网站、切工具、删除复制，最后增加不上传的 release-candidate verifier。
- **TDD/构建验收**：generator 输出与 unpublished 模板均由唯一 schema解析；字段只改一处；最终 exe checksum、manifest 和网站展示一致；静态清单、未签名警告和人工批准发布门保留。

### W-S2-6：一条坏的公开记录可使整页列表失败

- **发现方式**：Graphify 只定位 store→PublicContentService 候选；SQL约束、资产数量和 `Promise.all` 故障传播由人工核验。
- **当前行为/证据**：发布资产缺少 cover/package 单值不变量；`toCommunity` 要求恰好一个并抛错，整页 `Promise.all` 使单条 mapping/签名失败拒绝全页。见 `cloudbase/migrations/20260730000000_moderation.sql:51-67`、`apps/cloudbase-api/src/services/public-content-service.ts:47-55,123-142`、`apps/cloudbase-api/src/adapters/cloudbase-postgres.ts:720-785`。
- **影响/触发**：历史/误写坏 published row 或单对象签名失败扩大为页级不可用；安全仍失败关闭。
- **目标/迁移**：`PublishedCommunityCatalog` 同时具备严格写入不变量和逐项读取隔离；只对 cover/package 建部分唯一约束，发布 RPC 要求各一、固定路径、`actual_size>0`，`derived` 保持多值。
- **TDD 验收**：缺失/重复/错误路径或大小不能发布；多个 derived 合法；坏记录隐藏而其他合法记录可见；先审计存量再加索引。

### W-S2-7：CloudBase RPC HTTP 调用没有自身超时和响应上限

- **发现方式**：Graphify 可定位 RPC client 构造候选；fetch deadline、流读取和平台超时由人工回源。
- **当前行为/证据**：SDK 有 15 秒 timeout，但独立 REST RPC fetch 无 AbortSignal，并无界 `response.text()`；三函数都使用。见 `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts:31-48`、`apps/cloudbase-api/src/adapters/cloudbase-postgres.ts:92-105,958-969`。
- **影响/触发**：网关卡住会占满 30/300/900 秒平台截止，延长 API 故障和 worker/cleanup 租约。
- **目标/迁移**：从 ScannerClient 已有分块读取提取最小 bounded JSON helper；两个 adapter 共享底层字节/JSON边界，各自保留错误、上限和 deadline。
- **TDD 验收**：scanner 既有错误分类不变；RPC 卡住按配置终止；超大/畸形响应不进入无界内存；源码只有一份底层有界读取实现。

### W-S2-8：网站默认角色测试直接穿透桌面内部目录

- **发现方式**：人工发现；`new URL`/`readFile` 资源边不属于 Graphify import 图。
- **当前行为/证据**：`apps/website/tests/default-character-assets.test.ts:6-41` 硬编码双方目录并比较真实字节；两端已有同构 `sprite-metadata.json`，桌面目录又被运行时和 builder 使用。
- **影响/触发**：测试有价值地保护投影一致性，却将网站固定到桌面内部布局，资源 owner 仅靠相对路径表达。
- **目标/迁移**：桌面默认资源目录及现有 metadata 为 owner，网站为发布投影；小型 adapter 集中路径和验证，不创建第三份资产或同义长期清单。
- **TDD 验收**：两端 metadata schema、逻辑 sprite、帧信息和真实字节一致；缺失/漂移仍失败；验证消费者不各自硬编码跨应用路径。

### W-S3-1：旧首页组件不可达但仍留在正式目录

- **发现方式**：Graphify 仅提供无入边候选；production import、路由与符号引用搜索人工确认不可达。
- **当前行为/证据**：当前 `app/page.tsx` 只渲染 `WebsiteExperience`；旧 `DownloadCard`、`Faq`、`FeatureGrid`、`Hero*`、`HowItWorks`、`InstallHelp`、`SafetySection`、`SiteHeader/Footer` 无生产入口引用。
- **影响/触发**：不进 bundle，但增加搜索、样式和维护噪声，容易修改错误入口。
- **目标/迁移**：当前 chapter registry 为唯一首页组合 interface；先 build/引用/CSS 证明不可达，再独立删除旧组件和专属资产，不与架构迁移混做。
- **TDD 验收**：website typecheck/test/build/E2E 不变；无孤立 CSS/资源；当前路由和章节不受影响。

## 6. 工程治理域问题

来源：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/reviews/04-engineering-governance.md`；独立复核最终 PASS：`.superpowers/sdd/2026-08-13-graphify-architecture-audit/task-6-review.md`。

### G-S1-1：Migration runner 永远只执行首份 migration，却被手册当作当前入口

- **发现方式**：人工发现；SQL文件顺序、runner 文件读取和部署手册均在 Graphify 有效覆盖外。
- **当前行为/触发**：runner 固定读取 `20260730000000_moderation.sql`；目录另有 08-07、08-08 两份前向 migration。新环境按手册停在旧 schema；已有环境重跑首份非幂等 SQL，而不是推进 pending。
- **证据路径**：`tools/apply-cloudbase-migrations.mjs:6-8,24-34`；`cloudbase/migrations/*`；`docs/operations/cloudbase-deployment.md:9,14-19`；当前服务要求 `manual_review_pending`。
- **影响**：投稿状态、点赞和批准语义可能与已部署函数分叉；仓库无法重复、可审计地恢复环境。
- **目标 seam**：`CloudBaseMigrationRunner.plan(environment)` 返回有序 pending，`apply(plan)` 写 immutable ledger；版本 SQL 与数据库 adapter 之间使用专用会话、整轮 PostgreSQL advisory lock，锁内重读 ledger。
- **最小迁移**：先 inventory/checksum 红测；确认 adapter 能证明同一会话、事务和锁生命周期，否则停止并更换 adapter；每份规范化 SQL body 与 ledger/checksum 同事务提交；安全剥离现有唯一外层 `BEGIN/COMMIT`，内部/嵌套/不兼容事务 plan 阶段拒绝；验证后删除旧单文件入口。
- **TDD/故障注入**：新环境 3/3、首份环境 2/3、完成环境 0；checksum/缺号/重复 fail closed；覆盖锁后、SQL 中途、DDL 后 ledger 前、ledger 写入、commit 前后失联、双 runner 并发和失败续跑；最终不跳过未提交、不重放已提交。

### G-S1-2：根 `test` 不是全仓测试，也没有 workspace→gate 总 owner

- **发现方式**：人工发现；workspace script→Vitest projects 的执行归属是配置语义，Graphify 不覆盖。
- **当前行为/触发**：根 `vitest.config.ts` 只覆盖五个共享包、desktop 和根 integration/security；website、cloudbase-api、scanner、release-tools 及两份 `node:test` 工具测试缺席。新增 workspace 不会使总门失败。
- **证据路径**：根 `package.json:7-21`、`vitest.config.ts:5-12`、10 个 workspace 的 `package.json`；仓库无 CI workflow。
- **影响**：`pnpm test` 全绿不能代表仓库完成，跨域契约和发布工具回归可逃逸；领域计划持续复制命令。
- **目标 seam**：`RepositoryVerification` 提供 `test:all`、`verify:repo` 和机器可读 workspace→gate 清单；各 package 保留自有 test/build adapter，根只编排。
- **最小迁移**：先写 workspace discovery 覆盖红测；将现有快速门明确为 `test:core`；建立不重复 project 的 `test:all`；再串联 typecheck/test/build contract，E2E/容器/人工门分层列明。
- **TDD/验收**：10/10 workspace 有 owner或显式理由；新增临时 workspace 令覆盖测试失败；同一 project 每轮一次；失败先定位 workspace/gate；两套 E2E 不并行。

### G-S2-1：网站 E2E 内存 API 复制云端状态机且已漂移

- **发现方式**：人工发现；Graphify 不能证明内存 HTTP adapter 与 SQL/CloudBase 状态机等价。
- **当前行为/证据**：`tests/memory-website-api.mjs` 自行实现投稿、审核、公开、互动和清理并仍返回 `system_reviewing`；当前服务/08-08 SQL 使用 `manual_review_pending`。
- **影响/触发**：网站 E2E 验证旧假后端，新增状态/错误/幂等变更可只改生产一侧而假绿。
- **目标/迁移**：`WebsiteApiContractSuite` 以共享 schema/route 行为表驱动，同一 cases 同跑 production in-process adapter 与 memory adapter；共享契约，不共享数据库 implementation。
- **TDD 验收**：receipt、401/403、409、幂等 replay、发布/删除/恢复、like/download 两 adapter 等价；仍不需要真实 CloudBase 或密钥。

### G-S2-2：扫描器源码测试与镜像发布之间没有 artifact gate

- **发现方式**：人工发现；Dockerfile、ClamAV 数据库、镜像 digest 与部署参数均在 Graphify 图外。
- **当前行为/证据**：`verify:cloudbase` 只跑 scanner typecheck/test，不跑 Vite build、Docker、ClamAV/health smoke；Dockerfile 还包含 Node22、freshclam、非 root 和运行目录事实。
- **影响/触发**：源码全绿仍可能在 bundle、pnpm deploy、sharp、病毒库或启动时失败；恢复扫描时无可追溯 image identity。
- **目标/迁移**：`ScannerReleaseCandidate` 返回 image digest、Node/ClamAV/病毒库版本及 health/clean/infected/timeout smoke；先将 scanner build 纳入门，再新增显式慢速 `verify:scanner-image`。
- **TDD/构建验收**：真实 `dist/server.js`；非 root health 成功；缺/旧病毒库、EICAR、并发、超时稳定失败；候选 digest 与部署一致；真实 IMS 保留部署环境门。

### G-S2-3：历史 SDD、当前 runbook 与验收证据没有统一生命周期

- **发现方式**：人工文档审查；本轮 Graphify 使用 `--code-only`，没有文档语义图。
- **当前行为/证据**：Windows 计划末尾声称已发布 GitHub Release，而较新的当前入口与 `release-manifest.json` 表示未上传/unpublished；计划要求的两份 operation/验收文件不存在，仓库没有 commit、checksum、URL、环境记录裁决真相。
- **影响/触发**：读者可能把历史 checkbox 当现状、复活已退役设计或跳过发布门。
- **目标/迁移**：架构、operation、历史 specs/plans、日期化验收各有 owner/更新触发/last-verified/superseded 规则；只修当前入口和危险矛盾，不批量改写历史 77 份文档。
- **TDD/验收**：先以当前断链/互斥状态写文档规则失败用例；修订后内部链接和 operation 命令存在，当前文档无互斥状态，发布状态只由 manifest + 当前验收记录裁决，安全状态变更同步 runbook。

### G-S2-4：根 `CONTEXT.md` 名称像全仓上下文，内容仅覆盖桌宠

- **发现方式**：人工领域词汇审查；上下文文档不在代码图内。
- **当前行为/证据**：`CONTEXT.md:1-44` 只定义文件授权、聊天、文件任务和当前会话；没有网站投稿/审核、scanner、release 或资源 owner，且“发布/包”在多个域含义不同。
- **影响/触发**：开发者/智能体可能把桌宠词汇误当全仓语言，让应用语义泄漏进共享包。
- **目标/迁移**：本轮 [`../system-map.md`](../system-map.md) 是唯一全仓上下文地图 owner；现有 `CONTEXT.md` 后续只需明确桌宠适用域并回链。没有真实薄索引消费者前，不预设第二份 `CONTEXT-MAP.md`。
- **TDD/验收**：先用链接/覆盖检查证明当前无法定位全部上下文；修订后两跳内定位每个 workspace 的上下文、owner、interface 与禁止方向，不复制地图、不一次性改代码术语。

### G-S3-1：`verify:website` 同序列重复构建网站

- **发现方式**：人工发现；命令组合与产物覆盖属于脚本配置语义，Graphify 不覆盖。
- **当前行为/证据**：根 `verify:website` 先普通 build，再由 `test:e2e:website` 执行 E2E 专用 build并覆盖前一产物；两次环境可能不同。
- **影响/触发**：耗时与失败定位成本增加，但不能不加验证就删除某一 profile。
- **目标/迁移**：显式 `WebsiteBuildProfile` 区分 deploy/e2e；若等价则一次构建复用，若不同则隔离目录并命名；用 commit marker 拒绝旧产物。
- **TDD/验收**：每个声明 profile 每轮一次；E2E 固定 API base、不继承本机环境；失败阶段和产物身份可见。

## 7. 未发现问题与受保护设计

- 已核验的生产依赖方向是 apps→packages，website/desktop 生产 implementation 互不 import，packages 不反向依赖 apps。
- Main 私有 verified action、一次性消费、路径授权和回收站事务整体成立；`D-S0-1` 只修最后一跳窗口授权。
- `CharacterStore`、Package ZIP trust boundary、Agent/Conversation 状态机是有深度的模块；大文件不是拆分理由。
- CloudBase 的管理员服务端复验、状态 token hash、公开 DTO 裁剪、RLS/service-role 与 SQL/服务双层校验是合理安全防线。
- scanner 的 HMAC、恒时比较、重放窗口、下载白名单、流式限制、非 root 和失败关闭应保留。
- V1 数据迁移、V2→legacy 只读投影、MCP 关闭但保留、休眠 scanner/历史审核状态均不能仅凭静态“未调用”删除。
- domain verify 的有意重复、Playwright 单 worker、preload/builder/Docker/resource 静态断言和人工云端/Windows 门具有真实价值。

## 8. 静态分析不能裁决的事项

后续必须动态或部署验证：真实 CloudBase migration/ledger 与 RLS；网关/CORS/CSP、Bucket 和定时触发器；scanner 容器、ClamAV DB、IMS、短签名 URL 与 client↔server；非聊天 Renderer 攻击测试；进程终止/文件写入 kill-point；NSIS 干净机安装、卸载、SmartScreen；远端安装包与 manifest 字节；浏览器真实传输或安装完成。静态审查不能证明具体恶意 ZIP 已成功利用，也不能证明线上当前配置与手册一致。

## 9. 仓库隔离与变更说明

Graphify 工具、缓存、JSON、报告和 HTML 全部位于 `D:\Python\Graphify`。仓库内没有 `graphify-out` 或 `.graphify*`，没有新增 Graphify 依赖，也没有修改 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 或 `.gitignore`。本轮仅创建三份批准的中文架构文档；业务源码、测试、配置和依赖均未修改。
