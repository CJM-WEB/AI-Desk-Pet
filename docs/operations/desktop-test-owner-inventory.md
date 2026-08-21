# Desktop 变更测试唯一 owner 清单

## 1. 审计范围与裁决

- 审计日期：2026-08-21。
- 比较基线：`c7d951d`。
- `OWNER_AUDIT_HEAD`：`0ffc39c9589c3c67612c4d6fb52cd7374d81c7f9`。
- 审计路径：`apps/desktop/tests`、`tests/e2e`。
- Task 1 终局：三个获批 feedback seam 共 15 轮均为 GREEN，未建立合格 RED；未进入 Task 2、Task 3、Task 5 或 Task 6。本文只审计现有 owner，不把该历史绿色改写为开发门通过。
- 分类口径：`业务 owner` 直接经过公开 seam 观察业务不变量；`测试装配` 只构造或复用测试 adapter；`已删旧路径` 表示行为已由更深 interface 的 owner 替代；`纯移动/格式` 不改变测试表达。
- 层级口径：优先在深模块的公开 interface 建立最低合理 owner。Main、Preload、Renderer 和真实 Electron 是不同可信 seam；跨 seam 的安全证据不互相替代。
- RED 口径：下表的“RED 能力”只记录已存在的历史 RED、已记录 mutation 或可核验的最小破坏敏感点；本文没有伪称重新执行 mutation。
- 最终裁决：`零安全删除`。所有疑似重复均已在既有减法提交中替换，或仍是安全、竞态、持久化、严格跨进程边界、异步顺序、真实 Electron 生命周期的唯一 owner。不存在同时满足“精确替代 owner + 替代 seam 能捕获回归 + 非唯一关键证据”的新候选，故 `owner-subtraction-files.txt` 为空。

## 2. Agent、IPC 与窗口边界

### `apps/desktop/tests/agent-ipc-authorization.test.ts`（`+0/-57`）

- hunk/测试簇：整文件删除；分类为`已删旧路径`。
- 原不变量：空当前窗口、已销毁窗口、窗口替换和六个 mutating handler 的 sender 拒绝。
- 替代 seam/最低层：`registerAgentIpc` 的公开 handler interface；最低合理层为 `agent-ipc.test.ts` 的 Main 单元测试，而不是独立的单 adapter 浅模块测试。
- RED 能力：历史提交 `497bc2a` 先强化 handler sender 覆盖；移除动态 getter、`isDestroyed()` 或 sender 等值判断会使该文件的零 service 调用和窗口替换断言失败。
- 相邻 owner：`window-security.test.ts` 只拥有 Main 装配；`desktop.spec.ts` 只拥有真实跨窗口纵向证据，均不重复纯 handler 矩阵。
- 旧路径与裁决：生产 `AgentIpcAuthorization` 和本测试由 `1ba289b` 同批删除；保持删除，不恢复兼容层。

### `apps/desktop/tests/agent-ipc.test.ts`（`+29/-5`）

- hunk/测试簇：fixture 改为动态 `getCurrentChatWebContents`（`测试装配`）；六通道非法 sender、授权先于敏感负载解析、窗口替换后旧 sender 失效（当前约 177–258 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是六个 Agent IPC mutating handlers；Main 单元层直接证明空/销毁/异源 sender fail closed、service 零调用、动态身份不缓存。
- RED 能力：`497bc2a` 的历史 RED；最小破坏任一 handler 的首语句授权、复用旧 `WebContents` 或先解析负载，都会被矩阵或“授权先于解析”捕获。
- 疑似重复：E2E 只取一个已知 actionId 做真实窗口攻击；本文件是完整六通道矩阵，层级不同。
- 旧路径与裁决：不依赖 `AgentIpcAuthorization`；保留唯一 handler owner。

### `apps/desktop/tests/conversation-event-projection.test.ts`（`+6/-48`）

- hunk/测试簇：`pending_action` 完整投递、pet 严格 phase、非法额外字段零副作用、空/销毁 target、chat/pet/reporter 故障隔离（当前约 33–128 行，`业务 owner`）；全 TaskEvent variant 样例删除（`已删旧路径`）。
- 不变量/seam/层级：公开 seam 是 `ConversationEventProjection.publish()`；Main 单元层拥有投影行为，shared-types 契约测试拥有完整 TaskEvent Schema variant。
- RED 能力：历史提交 `948628c` 的替换式收敛；删除 pet 过滤、解析前置或单目标故障隔离会使保留的五类行为测试失败。
- 疑似重复：`desktop.spec.ts` 只保留真实多窗口信息最小化与票据授权纵向场景，不重复故障矩阵。
- 旧路径与裁决：完整 variant 列表已下移到共享契约 owner；保留当前五类行为 owner。

### `apps/desktop/tests/character-ipc.test.ts`（`+83/-48`）

- hunk/测试簇：恢复快照直接 Schema 的一个合法分层值与五类非法值完整矩阵（额外 `fallbackActive`、角色级码伪装 fallback、私有 owner 字段、播放器码伪装角色 issue、路径型角色 ID，约 33–72 行，`业务 owner`）；Main handler 严格空输入并返回注入的不可变合法快照（约 431–445 行，`业务 owner`）；`characterIpcHarness` 复用注册、service、dialog（约 212–239 行，`测试装配`）；其余调用点替换为 harness（`测试装配`）。
- 不变量/seam/层级：直接公开 seam 是 `characterRecoverySnapshotResultSchema.parse()`，本文件拥有恢复快照完整直接 Schema 矩阵；Main IPC seam 是 `characterRecoverySnapshotGet` handler，本文件另拥有严格输入和合法结果纵向用例。两者同在 Main 测试文件但职责不混写。
- RED 能力：既有 Main mutation 只破坏 handler 的空输入解析，证明严格输入 owner；直接 Schema 五类负例分别对额外状态、错误码分层、私有字段和路径型 ID 敏感。本文没有把该 mutation 误写为 Main 结果解析证据；合法结果纵向用例只登记其现有正向能力。
- 疑似重复：shared-types 不拥有此恢复快照矩阵；Preload 另拥有 Renderer 暴露 seam 的代表性非法结果。`fallbackActive` 仅为直接 Schema 严格负例，不是生产旧 owner。
- 旧路径与裁决：重复 Schema 样例已由 `4ef5d63` 删除；保留最小 Main 边界 owner 和装配复用。

### `apps/desktop/tests/preload-api.test.ts`（`+18/-0`）

- hunk/测试簇：固定通道返回合法快照、拒绝含私有路径字段的 Main 返回值（约 86–102 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是 `window.myself.getCharacterRecoverySnapshot()`；Preload 单元层证明 Renderer 不直接信任 Main 返回值，且只调用白名单通道。
- RED 能力：第二轮双边界 mutation 记录；移除 Preload 结果解析或改用通用 invoke 会使私有字段负例或固定通道断言失败。
- 疑似重复：Main handler 与 Preload 是两个可信 seam，不能合并为单边测试；恢复快照完整直接 Schema 矩阵由 `character-ipc.test.ts` 文件顶部拥有，Preload 这里只保留一个跨 seam 非法结果。
- 旧路径与裁决：重复样例已由 `4ef5d63` 删除；保留代表性非法值 owner。

### `apps/desktop/tests/window-security.test.ts`（`+2/-6`）

- hunk/测试簇：Main 以动态 current-chat getter 注册 Coordinator（约 248–254 行，`测试装配`）；删除对已退役授权对象和多条负字符串的断言（`已删旧路径`）。
- 目的/seam/层级：组合根源码装配 seam；只证明动态 getter 被传入和投影器独占窗口投递，不重测 handler 算法。
- RED 能力：把第三参数删掉或恢复缓存对象会使正向装配断言失败；handler 安全行为另由 `agent-ipc.test.ts` 捕获。
- 疑似重复：`main-lifecycle.test.ts` 的同义字符串断言已删除。
- 旧路径与裁决：不含 `AgentIpcAuthorization`；保留单一组合根装配 owner。

### `apps/desktop/tests/main-lifecycle.test.ts`（`+0/-6`）

- hunk/测试簇：从“生产组合根以会话协调器作为唯一聊天入口”中删除四条授权 wiring 字符串断言；分类为`已删旧路径`。
- 替代 seam/层级：`window-security.test.ts` 拥有组合根注册，`agent-ipc.test.ts` 拥有行为；生命周期文件只保留关闭、逆序清理、幂等和菜单串行化。
- RED 能力：替代 owner 的装配正断言和六通道行为矩阵可捕获回归；本文件的删除不会移除唯一 owner。
- 疑似重复/旧路径/裁决：这正是已裁决重复；保持删除，不新增字符串 helper。

## 3. 角色事务、包恢复与持久化

### `apps/desktop/tests/atomic-file-coordinator.test.ts`（`+96/-0`）

- hunk/测试簇：32 writer 只一成功、已有 final 字节不变、write/sync/link 三阶段失败无 final 且清理 temp、禁止 rename/copy fallback（整文件，`业务 owner`）；fault adapter（约 6–40 行，`测试装配`）。
- 不变量/seam/层级：公开 seam 是 `atomicWriteFileExclusive()`；真实临时文件系统的模块单元层是完整排他发布的最低合理层。
- RED 能力：角色导入恢复规格第 11 节固定此 RED；去掉 hard-link 排他、sync 或失败清理会直接破坏并发/阶段矩阵。`9dafdc9`、`5d2b34d` 已强化并 table-drive 该 owner。
- 疑似重复：PackageService 只验证业务发布顺序和调用结果，不重复原语完整错误矩阵。
- 旧路径与裁决：禁止 rename/copy 的非排他 fallback；保留并发安全唯一 owner。

### `apps/desktop/tests/character-package-service.test.ts`（`+761/-117`）

- hunk/测试簇 A：fs/atomic fault adapter、marker/seed/evidence/export helpers（约 32–321 行，`测试装配`）；重复导出和证据读取代码已替换（`已删旧路径`）。
- hunk/测试簇 B：导入失败只走 owner-token 回滚、blocked marker 不换 ID、marker 完整发布先于 Store owner、完成后复核清理、发布后替换竞态（约 1171–1348 行，`业务 owner`）。
- hunk/测试簇 C：真实 Store 重启回滚；半截 marker 隔离且后续合法 v3 继续；v1/v2 只保留证据；严格 Schema/归属、根目录扫描失败；rolled-back/absent 与 ownership-mismatch/active-character；读取后替换和 inert 证据（约 1352–1739 行，`业务 owner`）。
- hunk/测试簇 D：活动项位于第 257 位仍优先、无活动时第 257 项不读取、2000ms 后只 deferred 未开始项、inventory 跨预算首项仍完整执行、同根并发导入串行（约 1741–1923 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是 `CharacterPackageService.importCharacter()` 与 `initialize()`；带真实磁盘的 Main 模块测试拥有 v3 import saga、证据发布/保留、身份竞态、256/2000ms 调度和重启恢复。
- RED 能力：导入恢复规格第 11 节列出完整 RED 矩阵；提交链 `3622031`、`2ba3a2d`、`124bb49`、`c2455b2` 对应的测试会在普通 `store.delete()`、先建 owner 后写 marker、接受替代 marker、触碰 deferred 或错误截断时失败。第二轮 mutation 还证明“证据发布先于 marker 完成”由保留测试拥有。
- 疑似重复：原语错误矩阵在 atomic owner；Store 只拥有 owner token/活动角色/物理身份；E2E 只保留恢复重启纵向场景。
- 旧路径与裁决：旧普通删除回滚、v1/v2 执行式恢复及重复 helper 已删除；安全/竞态/持久化 owner 全部保留。

### `apps/desktop/tests/character-store.test.ts`（`+68/-71`）

- hunk/测试簇 A：不存在角色为 absent、活动角色即使 token 匹配也不删、checkpoint 后另一 Store 激活仍保留所有权、目录替换为 ownership-mismatch（约 416–511 行，`业务 owner`）。
- hunk/测试簇 B：真实坏 draft/publish marker、健康 runtime gate、V1 draft/compiled 字节不变、deferred 文件不触碰、Junction/EACCES、report 原子发布、显式 delete、索引集合清理（约 1859–2228 行，`业务 owner`）。
- hunk/测试簇 C：删除 `deferred`/`budgetExceeded` 断言、未发布坏 publish 与 tombstone 重复场景（`已删旧路径`）。
- 不变量/seam/层级：公开 seam 是 `CharacterStore` 的创建、带 token 回滚、`list()`/runtime/write gates 与 recovery report；真实磁盘 Store 集成层是持久化、重启和 Junction 的最低合理层。
- RED 能力：`6bf8126` 的活动角色竞态修复与 B1 历史 RED；去掉 token/活动复核、移动前后身份、原字节保留或 report 原子提交会让相应真实磁盘断言失败。
- 疑似重复：纯 256/2000ms 算法由 `character-transaction-recovery.test.ts` 拥有；PackageService 只拥有 package marker saga。
- 旧路径与裁决：可推导布尔字段和纯算法重复已删除；保留持久化与竞态唯一 owner。

### `apps/desktop/tests/character-transaction-recovery.test.ts`（`+137/-317`）

- hunk/测试簇：分面隔离/双分面/后续角色与能力门矩阵；第 257 位活动角色进入前 256 且输入不变；2000ms 等号边界；连续轮次、空轮次和未知角色 fail closed（约 23–264 行，`业务 owner`）。旧分散矩阵、`deferred`/`budgetExceeded`、重复 256/空输入用例删除（`已删旧路径`）。
- 不变量/seam/层级：公开 seam 是 `CharacterTransactionRecovery.recoverAll()`、`resultFor()` 和三个能力门；纯算法单元层拥有排序、预算、隔离和 fail-closed。
- RED 能力：`339dbf0` 前的 B1 RED/接口替换记录；最小破坏 256 截断、`>= 2000` 检查、单分面异常继续或新轮清空均由四个聚合测试捕获。
- 疑似重复：Store 集成层不再重复纯算法，仅保留真实文件边界。
- 旧路径与裁决：旧可推导字段和重复 owner 已删除；当前四簇是合并后的最低 owner，保留。

## 4. 启动、Renderer 与工作室

### `apps/desktop/tests/character-recovery.test.ts`（`+28/-1`）

- hunk/测试簇：B1/B2 五类 issue 映射为唯一中文说明、能力影响和建议；启动 fallback 错误码映射工作室入口（约 42–64 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是 Renderer 共享的 `characterRecoveryPresentation()`/`characterRecoveryMessage()`；纯函数单元层拥有公开展示映射。
- RED 能力：`f70ab3b`/`86aef44` 替换标量恢复链时建立；漏掉任一稳定码或泄漏原错误会使 literal 映射断言失败。
- 疑似重复：Pet 只拥有 fallback 展示，Workshop 只拥有当前选择过滤，不重复完整映射表。
- 旧路径与裁决：旧标量 message 测试被结构化映射替代；保留唯一展示 owner。

### `apps/desktop/tests/character-startup.test.ts`（`+182/-33`）

- hunk/测试簇 A：`recordingDependencies`/`start` factory 复用（约 18–48 行，`测试装配`），重复依赖对象已删除（`已删旧路径`）。
- hunk/测试簇 B：固定启动顺序与深冻结；B1/B2 投影去重排序；index recovered 仍先 runtime；白名单外异常脱敏；活动 runtime fallback 矩阵；最终 load 瞬时失败重读一次、持续失败不发布过期 B1；默认角色准备失败不虚报 fallback（约 51–203 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是 `prepareCharacterStartup()`；Main 启动编排单元层拥有启动顺序、fallback 诚实性、最终 load 两类失败和不可变快照。
- RED 能力：第二轮 mutation 明确证明最终 load 第二次读取仍由保留测试拥有；移除深冻结、重读、B1 抑制或 default 成功条件会破坏对应断言。
- 疑似重复：`official-default-character.test.ts` 只拥有真实 Store 的损坏索引纵向路径；这里拥有纯编排失败矩阵。
- 旧路径与裁决：旧 `loadIndex`/标量结果链和重复装配已替换；保留业务矩阵。

### `apps/desktop/tests/official-default-character.test.ts`（`+13/-3`）

- hunk/测试簇：损坏索引恢复后通过新 `prepareCharacterStartup` interface 完成 fallback，并证明有效用户角色、草稿和损坏证据保留（当前约 80–143 行，`业务 owner`）。
- 不变量/seam/层级：公开 seam 是 `CharacterStore.recoverCorruptIndex()` + `prepareCharacterStartup()` + `ensureOfficialDefaultCharacter()` 的真实磁盘纵向链；模块集成层是最低合理层。
- RED 能力：删除索引重建、最终 load、默认角色 fallback 或用户草稿保留会使返回值、角色清单、原草稿字节或 corrupt evidence 断言失败。
- 疑似重复：startup 单元层不使用真实 Store；本测试是损坏索引持久化唯一 owner，也是 Task 1 的 15/15 GREEN 目标，但这不构成删除证据。
- 旧路径与裁决：旧标量 startup 调用已替换；该用例具有持久化与恢复证据，保留。

### `apps/desktop/tests/pet-view.test.tsx`（`+115/-31`）

- hunk/测试簇 A：CharacterPlayer test adapter 和统一 `renderPet`（约 18–42、159–168 行，`测试装配`）；旧顶层标量恢复测试删除（`已删旧路径`）。
- hunk/测试簇 B：非活动 issues 不降级、fallback 提示与工作室入口、RPC 失败不伪造 fallback、启动快照与播放器故障两种乱序不互相清除（约 171–239 行，`业务 owner`）。
- hunk/测试簇 C：既有 SSR、StrictMode 控制器 dispose、拖拽/capture/blur/右键顺序继续作为 Renderer 生命周期 owner；本次恢复 adapter 与其共同装配（`业务 owner`/`测试装配`）。
- 不变量/seam/层级：公开 seam 是 `PetView` 的 DOM、`MyselfApi` 和播放器回调；jsdom Renderer 层拥有 fallback 消费、异步顺序与 StrictMode 生命周期。
- RED 能力：`2932531` 针对恢复反馈稳定性；移除 source precedence、RPC fail-closed 或 effect cleanup 会使乱序/StrictMode 断言失败。
- 疑似重复：startup 只产出快照，Pet 只消费 fallback；真实 Electron E2E 只证明重启后可见闭环。
- 旧路径与裁决：旧标量恢复入口已删除；保留异步与生命周期唯一 owner。

### `apps/desktop/tests/character-workshop-close-renderer.test.tsx`（`+95/-65`）

- hunk/测试簇 A：`workshopApi` adapter 复用（约 50–79 行，`测试装配`）；重复 API 对象删除（`已删旧路径`）。
- hunk/测试簇 B：StrictMode 下只读取一次快照、随当前选择过滤内存 issues、零写操作；RPC 失败只显示通用文案且不泄漏路径/token（约 80–138 行，`业务 owner`）。
- hunk/测试簇 C：Main 刷新等待当前 store flush、发布摘要不完整不能被当前草稿绕过（约 140–224 行，既有`业务 owner`，本次只改装配）。
- 不变量/seam/层级：公开 seam 是 `CharacterWorkshopView` 的 `CharacterWorkshopViewApi` 与可见 DOM；Renderer 集成层拥有 StrictMode 单请求、选择过滤、脱敏和关闭刷新顺序。
- RED 能力：第二轮定向记录明确保留 Workshop StrictMode、RPC 安全文案和路径/token 脱敏；移除缓存/cleanup/通用错误映射会使调用次数或 DOM 断言失败。
- 疑似重复：映射文字表在 `character-recovery.test.ts`；Workshop 只拥有选择与副作用边界。
- 旧路径与裁决：旧 scalar/重复 adapter 已删除；保留 Renderer 唯一 owner。

### `apps/desktop/tests/character-workshop-components.test.tsx`（`+6/-2`）

- hunk/测试簇：测试公开 API 类型加入 `getCharacterRecoverySnapshot`，默认 double 返回空快照（约 21–23、98–106 行，`测试装配`）。
- 目的/seam/层级：让工作室组件既有 SSR、Inspector、布局与可访问性测试经过当前 `CharacterWorkshopViewApi` interface；不新增恢复业务断言。
- RED 能力：若组件错误地要求额外恢复字段或 SSR 期间触发未注入全局，该文件既有 SSR owner 会失败；恢复选择/脱敏行为由 close-renderer 文件拥有。
- 疑似重复/旧路径/裁决：仅是现行 interface 的最小 adapter，无独立业务 owner；保留，禁止再建通用 helper。

## 5. 验证入口与真实 Electron

### `apps/desktop/tests/desktop-e2e-entry.test.ts`（`+9/-1`）

- hunk/测试簇：在唯一 Desktop E2E 入口契约中解析真实 Vitest 配置并断言 `maxWorkers=4`（约 39–87 行，`业务 owner`/验证契约）。
- 不变量/seam/层级：公开 seam 是根脚本、Playwright config 与 Vitest 最终解析配置；配置契约单元层拥有 E2E spec 归属、门禁可达性和 worker 上限。
- RED 能力：`7e7b92a` 先让合并 owner 同时通过再删旧文件；改变 `maxWorkers` 或从 `verify:desktop` 移除任一门会使契约失败。
- 疑似重复：已删除的 `vitest-worker-cap.test.ts` 不再存在；没有第二个 worker owner。
- 旧路径与裁决：保持合并后的单一入口 owner。

### `apps/desktop/tests/vitest-worker-cap.test.ts`（`+0/-14`）

- hunk/测试簇：整文件删除；分类为`已删旧路径`。
- 原不变量/seam/层级：解析 Desktop Vitest 配置并断言四个 worker；已合并到 `desktop-e2e-entry.test.ts` 的验证契约 seam。
- RED 能力：合并后 owner 对同一实际解析值敏感，`7e7b92a` 的删除前/后绿色记录证明替代关系。
- 疑似重复/旧路径/裁决：原文件是单断言重复 owner；保持删除。

### `tests/e2e/desktop.spec.ts`（`+308/-469`）

- hunk/测试簇 A：非空 `loadElectronFixtureModule()`、统一 `rendererPage`/`waitForRendererPage`，58 个调用点删除 nullable 断言与局部页面发现闭包（文件前部及各场景，`测试装配`/`已删旧路径`）。
- hunk/测试簇 B：Electron fixture 生命周期、诊断脱敏、进程探针、dispose/restart 竞态与窗口交互既有场景仅切换到共享 loader/page adapter（约 380–2275、2416–4497、4718–末尾，`业务 owner` + `测试装配`）。
- hunk/测试簇 C：两条“角色恢复”真实重启场景——非活动 Store/Package 问题不 fallback 且 Workshop 只显示选中角色、活动 publish 恢复受阻后切官方默认并保留证据（约 2255–2414 行，`业务 owner`）。
- hunk/测试簇 D：任务事件场景合并 pet 严格 phase、settings/characters 零事件、非 chat 不能执行已知 actionId、chat 卡片仍在且正式确认后落盘；独立票据攻击场景删除（约 4498–4717 行，`业务 owner`/`已删旧路径`）。
- 不变量/seam/层级：公开 seam 是构建后的 Electron Main/Preload/Renderer、多窗口、真实 userData 重启和操作系统进程；Playwright E2E 是生命周期、诊断、窗口交互和两条恢复重启的最低真实层。
- RED 能力：第二轮 loader mutation 证明模块装载失败直接抛出；`b1e24a6` 合并前后保留跨窗口攻击；恢复规格限定最多两条真实重启场景。移除 restart 持久化、证据原字节、非 chat sender 拒绝、pet 严格事件或清理竞态会破坏对应 E2E 断言。
- 疑似重复：Main 单元层拥有算法矩阵；E2E 仅拥有真实 Electron 生命周期、跨窗口和重启纵向证据。两条恢复场景已达规格上限，不按错误码横向扩张。
- 旧路径与裁决：nullable fixture 表达、局部页面 helper 和独立票据场景已删除；现有 loader、可选 `restart` 业务守卫、生命周期/诊断/窗口场景及两条恢复 E2E 均保留。

## 6. `numstat` 机械总账

下表取自 `git diff --numstat c7d951d..0ffc39c -- apps/desktop/tests tests/e2e`；删除文件的新增数为 0，新文件的删除数为 0。

| 路径 | 新增 | 删除 | 净值 |
| --- | ---: | ---: | ---: |
| `apps/desktop/tests/agent-ipc-authorization.test.ts` | 0 | 57 | -57 |
| `apps/desktop/tests/agent-ipc.test.ts` | 29 | 5 | +24 |
| `apps/desktop/tests/atomic-file-coordinator.test.ts` | 96 | 0 | +96 |
| `apps/desktop/tests/character-ipc.test.ts` | 83 | 48 | +35 |
| `apps/desktop/tests/character-package-service.test.ts` | 761 | 117 | +644 |
| `apps/desktop/tests/character-recovery.test.ts` | 28 | 1 | +27 |
| `apps/desktop/tests/character-startup.test.ts` | 182 | 33 | +149 |
| `apps/desktop/tests/character-store.test.ts` | 68 | 71 | -3 |
| `apps/desktop/tests/character-transaction-recovery.test.ts` | 137 | 317 | -180 |
| `apps/desktop/tests/character-workshop-close-renderer.test.tsx` | 95 | 65 | +30 |
| `apps/desktop/tests/character-workshop-components.test.tsx` | 6 | 2 | +4 |
| `apps/desktop/tests/conversation-event-projection.test.ts` | 6 | 48 | -42 |
| `apps/desktop/tests/desktop-e2e-entry.test.ts` | 9 | 1 | +8 |
| `apps/desktop/tests/main-lifecycle.test.ts` | 0 | 6 | -6 |
| `apps/desktop/tests/official-default-character.test.ts` | 13 | 3 | +10 |
| `apps/desktop/tests/pet-view.test.tsx` | 115 | 31 | +84 |
| `apps/desktop/tests/preload-api.test.ts` | 18 | 0 | +18 |
| `apps/desktop/tests/vitest-worker-cap.test.ts` | 0 | 14 | -14 |
| `apps/desktop/tests/window-security.test.ts` | 2 | 6 | -4 |
| `tests/e2e/desktop.spec.ts` | 308 | 469 | -161 |
| `apps/desktop/tests` 小计 | 1648 | 825 | +823 |
| `tests/e2e` 小计 | 308 | 469 | -161 |
| **Git 总账** | **1956** | **1294** | **+662** |

逐文件求和：新增 `1648 + 308 = 1956`，删除 `825 + 469 = 1294`，净值 `1956 - 1294 = +662`，与 Git 总账一致。本文如实记录“零安全删除”，不宣称安全减法已经穷尽；后续若要继续删除，必须以新的精确替代 owner、公开 seam 和 RED/mutation 证据重新通过删除门。
