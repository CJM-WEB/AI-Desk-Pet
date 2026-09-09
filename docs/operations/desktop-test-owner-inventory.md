# Desktop 变更测试唯一 owner 清单

## 1. 审计范围与裁决

- 审计日期：2026-08-21；2026-08-22 完成一次补充减法复核。
- 比较基线：`c7d951d`。
- `OWNER_AUDIT_HEAD`：`0c541f33a56bb47b49635f4ecf605b30eb50b370`。
- 审计路径：`apps/desktop/tests`、`tests/e2e`。
- Task 1 终局：三个获批 feedback seam 共 15 轮均为 GREEN，未建立合格 RED；未进入 Task 2、Task 3、Task 5 或 Task 6。本文只审计现有 owner，不把该历史绿色改写为开发门通过。
- 分类口径：`业务 owner` 直接经过公开 seam 观察业务不变量；`测试装配` 只构造或复用测试 adapter；`已删旧路径` 表示行为已由更深 interface 的 owner 替代；`纯移动/格式` 不改变测试表达。
- 层级口径：优先在深模块的公开 interface 建立最低合理 owner。Main、Preload、Renderer 和真实 Electron 是不同可信 seam；跨 seam 的安全证据不互相替代。
- RED 口径：下表的“RED 能力”只记录已存在的历史 RED、已记录 mutation 或可核验的最小破坏敏感点；本文没有伪称重新执行 mutation。
- 最终裁决：原审计为`零安全删除`；2026-08-22 的真实门禁 RED 暴露 `CharacterStore` 六场景磁盘矩阵仍与纯协调器 owner 重复，因此在 `0c541f3` 删除该 51 行用例。独立复审确认其余安全、竞态、持久化、跨进程和真实 Electron owner 均继续保留。

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

### `apps/desktop/tests/character-store.test.ts`（`+67/-121`）

- hunk/测试簇 A：不存在角色为 absent、活动角色即使 token 匹配也不删、checkpoint 后另一 Store 激活仍保留所有权、目录替换为 ownership-mismatch（约 416–511 行，`业务 owner`）。
- hunk/测试簇 B：真实坏 draft/publish marker、健康 runtime gate、V1 draft/compiled 字节不变、deferred 文件不触碰、Junction/EACCES、report 原子发布、显式 delete、索引集合清理（约 1859–2228 行，`业务 owner`）。
- hunk/测试簇 C：删除 `deferred`/`budgetExceeded` 断言、未发布坏 publish 与 tombstone 重复场景（`已删旧路径`）。
- 补充减法：删除 active/non-active × bad draft/bad publish/both 的六场景完整磁盘排列；分面矩阵继续由 `character-transaction-recovery.test.ts` 拥有，Store 保留两条真实坏 marker 纵向证据。
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

## 6. 逐零上下文 hunk 机械映射（历史基座 259/259 + 当前减法增量 1/1）

### 6.1 编号与封闭规则

- 原始 hunk ID 按 `git diff --unified=0 c7d951d..d2672b7 -- apps/desktop/tests tests/e2e` 的输出顺序固定为 `H001..H259`，作为不可变历史审计基座。当前树 `0c541f3` 相对该基座只有 `character-store.test.ts` 的 `0/-51` 单一减法增量；不再声称历史 raw hunk 编号与当前 257 个 raw hunk 一一相同。
- 下表的“位置”逐字保存 Git hunk header；文件码解析为精确路径。每个原始 ID 必须出现一次；只有混合 hunk 使用 `-a/-b` 拆成两个有效簇，且不得同时保留无后缀行。
- 分类字段只能是 `业务 owner`、`测试装配`、`已删旧路径`、`纯移动/格式` 之一。非业务项固定写“不适用”并指向承接业务测试；已删旧路径还必须引用下列可重复执行的零命中证据。
- 历史基座共 259 个原始 ID、268 个有效簇；`tests/e2e/desktop.spec.ts` 精确占 `H166..H259` 共 94 个原始 hunk。机械复核 `c7d951d..0c541f3` 为 257 个 raw hunk，其中 F08 从 20 个降为 18 个；当前 owner 覆盖由本历史基座与下述唯一减法增量共同表达。

- 当前减法增量 `S001`：`git diff --unified=0 d2672b7..0c541f3 -- apps/desktop/tests/character-store.test.ts` 精确为 `@@ -1874,51 +1873,0 @@ describe('CharacterStore', () => {`；分类为`已删旧路径`，由 O08 的纯协调器矩阵与 O07 的真实 Store 纵向边界共同承接。增量命令 `git diff --numstat d2672b7..0c541f3 -- apps/desktop/tests/character-store.test.ts` 精确为 `0/51`。

### 6.2 文件码

| 文件码 | 精确路径 |
| --- | --- |
| F01 | `apps/desktop/tests/agent-ipc-authorization.test.ts` |
| F02 | `apps/desktop/tests/agent-ipc.test.ts` |
| F03 | `apps/desktop/tests/atomic-file-coordinator.test.ts` |
| F04 | `apps/desktop/tests/character-ipc.test.ts` |
| F05 | `apps/desktop/tests/character-package-service.test.ts` |
| F06 | `apps/desktop/tests/character-recovery.test.ts` |
| F07 | `apps/desktop/tests/character-startup.test.ts` |
| F08 | `apps/desktop/tests/character-store.test.ts` |
| F09 | `apps/desktop/tests/character-transaction-recovery.test.ts` |
| F10 | `apps/desktop/tests/character-workshop-close-renderer.test.tsx` |
| F11 | `apps/desktop/tests/character-workshop-components.test.tsx` |
| F12 | `apps/desktop/tests/conversation-event-projection.test.ts` |
| F13 | `apps/desktop/tests/desktop-e2e-entry.test.ts` |
| F14 | `apps/desktop/tests/main-lifecycle.test.ts` |
| F15 | `apps/desktop/tests/official-default-character.test.ts` |
| F16 | `apps/desktop/tests/pet-view.test.tsx` |
| F17 | `apps/desktop/tests/preload-api.test.ts` |
| F18 | `apps/desktop/tests/vitest-worker-cap.test.ts` |
| F19 | `apps/desktop/tests/window-security.test.ts` |
| F20 | `tests/e2e/desktop.spec.ts` |

### 6.3 owner 码

| owner | 不变量 | 公开 seam / 最低合理层 |
| --- | --- | --- |
| O01 | Agent IPC 六通道动态 sender 授权与组合根 | `registerAgentIpc` handlers / Main 装配 |
| O02 | 完整排他文件发布 | `atomicWriteFileExclusive()` |
| O03 | 恢复快照直接 Schema 与 Main handler | `characterRecoverySnapshotResultSchema.parse()` / `characterRecoverySnapshotGet` |
| O04 | 角色包导入、v3 marker、恢复调度与证据 | `CharacterPackageService.importCharacter()` / `initialize()` |
| O05 | Renderer 恢复展示映射 | `characterRecoveryPresentation()` / `characterRecoveryMessage()` |
| O06 | 启动顺序、fallback、最终 load 与不可变快照 | `prepareCharacterStartup()` |
| O07 | Store owner token、真实磁盘恢复和报告发布 | `CharacterStore` 公开 interface |
| O08 | 分面恢复、256/2000ms 与轮次 fail-closed | `CharacterTransactionRecovery` 公开 interface |
| O09 | Workshop 恢复提示、StrictMode 与关闭刷新 | `CharacterWorkshopView` 注入 interface / DOM |
| O10 | 会话事件投影 | `ConversationEventProjection.publish()` |
| O11 | Desktop E2E/worker 唯一入口契约 | 根脚本与最终解析配置 |
| O12 | 损坏索引到官方默认角色的真实磁盘纵向链 | Store + startup + default installer |
| O13 | Pet fallback、RPC 失败和乱序消费 | `PetView` 的 `MyselfApi` / DOM |
| O14 | Preload 恢复快照白名单边界 | `window.myself.getCharacterRecoverySnapshot()` |
| O15 | Main 动态 getter 唯一装配 | 组合根源码装配 seam |
| O16 | Electron fixture、生命周期、诊断、窗口与既有纵向场景 | 构建后 Electron / Playwright |
| O17 | 两条角色恢复重启纵向场景 | 真实 Electron / userData 重启 |
| O18 | 多窗口事件最小化与非 chat 票据拒绝 | 真实 Electron 多窗口 |

### 6.4 已删旧路径零命中证据

- `Z1`：`rg -n "AgentIpcAuthorization|agent-ipc-authorization" apps/desktop/src apps/desktop/tests`，预期退出码 `1`。
- `Z2`：`rg -n "rollback marker 不得删除复用同一 ID 的新角色" apps/desktop/tests/character-package-service.test.ts`，预期退出码 `1`。
- `Z3`：`rg -n "事务恢复协调：未发布角色的坏 publish|事务恢复协调：tombstone 恢复异常|恰好 256 个候选时完整恢复所有角色|空候选的新恢复轮次|空候选、空活动角色和未命中活动角色|CharacterTransactionRecoveryKind|budgetExceeded|\.deferred" apps/desktop/src/main/characters apps/desktop/tests/character-store.test.ts apps/desktop/tests/character-transaction-recovery.test.ts`，预期退出码 `1`。
- `Z4`：`rg -n "validPowerShellActionEvent|validHistoryDisclosureEvent|completeChatEvents|applyCharacterBehavior.*character_carrying" apps/desktop/tests/conversation-event-projection.test.ts`，预期退出码 `1`。
- `Z5`：`rg -n "new AgentIpcAuthorization|getCurrentChatWebContents\)\)|agentIpcAuthorization|registerAgentIpc\(ipcMain, conversationIpcService\);|registerAgentIpc\(ipcMain, agentService\)" apps/desktop/tests/main-lifecycle.test.ts apps/desktop/tests/window-security.test.ts`，预期退出码 `1`；同时精确覆盖 H165 删除的两个旧负断言表达。
- `Z6`：`rg -n "loadCharacterStartupRecovery|Renderer 就绪后读取启动恢复快照|启动恢复快照读取失败时映射" apps/desktop/tests/pet-view.test.tsx apps/desktop/src`，预期退出码 `1`。
- `Z7` 路径正控制：`rg --files apps/desktop/tests | rg '(^|[\\/])desktop-e2e-entry\.test\.ts$'`，预期管道退出码 `0`，证明该跨平台路径表达可命中现存测试文件。
- `Z7` 路径证据：`rg --files apps/desktop/tests | rg '(^|[\\/])vitest-worker-cap\.test\.ts$'`，预期管道退出码 `1`，精确证明 H161 删除的测试文件路径不存在。
- `Z7` 内容证据：`rg -n "Desktop Vitest 解析后固定使用四个文件 worker" apps/desktop/tests`，预期退出码 `1`；路径与内容两项共同承接 H161 整文件删除。
- `Z8`：`rg -n "只有当前聊天窗口能使用已知 actionId 确认文件动作" tests/e2e/desktop.spec.ts`，预期退出码 `1`。
- `Z9`：`rg -n "characterRecoveryMessage|稳定错误码提供中文说明和角色工作室修复入口" apps/desktop/tests/character-startup.test.ts`，预期退出码 `1`；同时精确覆盖 H065-b 删除的 import/符号和 H076-b 删除的旧标题。

### 6.5 逐 hunk 映射

| 有效簇 | 文件 | 精确 Git 位置 | 单一分类 | owner / 非业务承接 |
| --- | --- | --- | --- | --- |
| H001 | F01 | `@@ -1,57 +0,0 @@` | 已删旧路径 | 不适用；承接 O01；旧测试表达已由该 owner 替代；零命中 Z1。 |
| H002 | F02 | `@@ -3 +2,0 @@ import type { IpcMain, WebContents } from 'electron';` | 已删旧路径 | 不适用；承接 O01；旧测试表达已由该 owner 替代；零命中 Z1。 |
| H003 | F02 | `@@ -29,2 +28,2 @@ function createService() {` | 测试装配 | 不适用；承接 O01 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H004-a | F02 | `@@ -38,2 +37 @@ function createAgentIpcFixture() {` | 已删旧路径 | 不适用；承接 O01；删除浅授权对象注入；零命中 Z1。 |
| H004-b | F02 | `@@ -38,2 +37 @@ function createAgentIpcFixture() {` | 测试装配 | 不适用；承接 O01 的业务测试；改为动态 current-chat getter 装配。 |
| H005 | F02 | `@@ -198,0 +197,24 @@ describe('Agent IPC', () => {` | 业务 owner | 适用：O01；该 hunk 的业务断言或场景归此唯一 owner。 |
| H006 | F02 | `@@ -229,0 +252,2 @@ describe('Agent IPC', () => {` | 业务 owner | 适用：O01；该 hunk 的业务断言或场景归此唯一 owner。 |
| H007-a | F03 | `@@ -0,0 +1,96 @@` | 测试装配 | 不适用；承接 O02 的业务测试；新增真实文件 fault adapter 与临时目录装配。 |
| H007-b | F03 | `@@ -0,0 +1,96 @@` | 业务 owner | 适用：O02；新增并发排他、原字节和 write/sync/link 失败矩阵。 |
| H008 | F04 | `@@ -11,0 +12 @@ import {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H009 | F04 | `@@ -12,0 +14 @@ import {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H010 | F04 | `@@ -23 +25 @@ type CharacterRegistration = (` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H011-a | F04 | `@@ -25,0 +28,46 @@ type CharacterRegistration = (` | 测试装配 | 不适用；承接 O03 的业务测试；新增空恢复快照 fixture。 |
| H011-b | F04 | `@@ -25,0 +28,46 @@ type CharacterRegistration = (` | 业务 owner | 适用：O03；新增恢复快照直接 Schema 的一正五负矩阵。 |
| H012 | F04 | `@@ -164,0 +213,15 @@ function requireCharacterRegistration(): CharacterRegistration {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H013 | F04 | `@@ -185,3 +248 @@ describe('V2 角色 IPC 边界', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H014 | F04 | `@@ -221,2 +282 @@ describe('V2 角色 IPC 边界', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H015 | F04 | `@@ -234,2 +293,0 @@ describe('V2 角色 IPC 边界', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H016 | F04 | `@@ -252,2 +310 @@ describe('V2 角色 IPC 边界', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H017 | F04 | `@@ -255 +311,0 @@ describe('V2 角色 IPC 边界', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H018 | F04 | `@@ -290,2 +346 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H019 | F04 | `@@ -298,2 +352,0 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H020 | F04 | `@@ -319,3 +372 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H021 | F04 | `@@ -337,3 +388 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H022 | F04 | `@@ -371,3 +420 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H023 | F04 | `@@ -384,9 +431,7 @@ describe('角色白名单 IPC', () => {` | 业务 owner | 适用：O03；该 hunk 的业务断言或场景归此唯一 owner。 |
| H024 | F04 | `@@ -396,4 +441,2 @@ describe('角色白名单 IPC', () => {` | 业务 owner | 适用：O03；该 hunk 的业务断言或场景归此唯一 owner。 |
| H025 | F04 | `@@ -404,3 +447 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H026 | F04 | `@@ -426,4 +467 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H027 | F04 | `@@ -487,2 +525 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H028 | F04 | `@@ -494,2 +530,0 @@ describe('角色白名单 IPC', () => {` | 测试装配 | 不适用；承接 O03 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H029 | F05 | `@@ -12,0 +13 @@ import {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H030 | F05 | `@@ -24 +25 @@ import { ZipFile } from 'yazl';` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H031 | F05 | `@@ -31,0 +33,35 @@ import { CharacterStore } from '../src/main/characters/character-store';` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H032 | F05 | `@@ -36,0 +73,18 @@ const PNG_BYTES = Buffer.from(` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H033 | F05 | `@@ -181,0 +236,8 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H034 | F05 | `@@ -184,0 +247,40 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H035 | F05 | `@@ -200,0 +303,9 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H036 | F05 | `@@ -203,4 +314 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H037 | F05 | `@@ -303,3 +411 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H038 | F05 | `@@ -602,4 +708 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H039 | F05 | `@@ -777,3 +880 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H040 | F05 | `@@ -834,3 +935 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H041 | F05 | `@@ -859,3 +958 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H042 | F05 | `@@ -887,3 +984 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H043 | F05 | `@@ -914,3 +1009 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H044 | F05 | `@@ -984,3 +1077 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H045 | F05 | `@@ -1020,3 +1111 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H046 | F05 | `@@ -1048,3 +1137 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H047 | F05 | `@@ -1084 +1171 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H048 | F05 | `@@ -1086,3 +1173 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H049 | F05 | `@@ -1095,2 +1180,5 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H050 | F05 | `@@ -1098,0 +1187,3 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H051 | F05 | `@@ -1105 +1196 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H052 | F05 | `@@ -1109 +1200,7 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H053 | F05 | `@@ -1111,4 +1208,142 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H054 | F05 | `@@ -1118,12 +1353,7 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H055 | F05 | `@@ -1130,0 +1361,19 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H056 | F05 | `@@ -1132,2 +1381,2 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H057 | F05 | `@@ -1134,0 +1384,2 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H058 | F05 | `@@ -1136 +1387 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H059 | F05 | `@@ -1138,6 +1389,445 @@ describe('角色包 Main 服务', () => {` | 业务 owner | 适用：O04；该 hunk 的业务断言或场景归此唯一 owner。 |
| H060 | F05 | `@@ -1148,3 +1838 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H061 | F05 | `@@ -1191,42 +1878,0 @@ describe('角色包 Main 服务', () => {` | 已删旧路径 | 不适用；承接 O04；旧测试表达已由该 owner 替代；零命中 Z2。 |
| H062 | F05 | `@@ -1280,3 +1926 @@ describe('角色包 Main 服务', () => {` | 测试装配 | 不适用；承接 O04 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H063 | F06 | `@@ -4 +4,3 @@ import {` | 测试装配 | 不适用；承接 O05 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H064 | F06 | `@@ -38,0 +41,25 @@ describe('角色稳定错误反馈', () => {` | 业务 owner | 适用：O05；该 hunk 的业务断言或场景归此唯一 owner。 |
| H065-a | F07 | `@@ -4 +4 @@ import {` | 测试装配 | 不适用；承接 O06 的业务测试；切换为启动依赖 interface 类型。 |
| H065-b | F07 | `@@ -4 +4 @@ import {` | 已删旧路径 | 不适用；承接 O05；删除启动文件内的旧展示 mapper import；零命中 Z9。 |
| H066 | F07 | `@@ -6,0 +7,43 @@ import {` | 测试装配 | 不适用；承接 O06 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H067 | F07 | `@@ -8 +51 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H068 | F07 | `@@ -10,4 +53 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H069 | F07 | `@@ -18 +58,36 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H070 | F07 | `@@ -20,4 +95,12 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H071 | F07 | `@@ -24,0 +108,15 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H072 | F07 | `@@ -27,4 +125,2 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H073 | F07 | `@@ -32,3 +128,2 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H074 | F07 | `@@ -37,3 +132,17 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H075 | F07 | `@@ -41 +150,4 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H076-a | F07 | `@@ -44,11 +156,13 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；新增最终 Store load 瞬时失败重读 owner。 |
| H076-b | F07 | `@@ -44,11 +156,13 @@ describe('角色启动恢复', () => {` | 已删旧路径 | 不适用；承接 O05；删除已迁移到展示 mapper 文件的旧测试；零命中 Z9。 |
| H077 | F07 | `@@ -55,0 +170,35 @@ describe('角色启动恢复', () => {` | 业务 owner | 适用：O06；该 hunk 的业务断言或场景归此唯一 owner。 |
| H078 | F08 | `@@ -426 +426 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H079 | F08 | `@@ -429 +429 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H080 | F08 | `@@ -433,0 +434,55 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H081 | F08 | `@@ -450 +505 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H082 | F08 | `@@ -1806,2 +1861 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H083 | F08 | `@@ -1811,2 +1865 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H084 | F08 | `@@ -1858,5 +1910,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H085 | F08 | `@@ -1864,2 +1912 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H086 | F08 | `@@ -1867 +1913,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H087 | F08 | `@@ -1954,16 +1999,0 @@ describe('CharacterStore', () => {` | 已删旧路径 | 不适用；承接 O07；旧测试表达已由该 owner 替代；零命中 Z3。 |
| H088 | F08 | `@@ -2071 +2100,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H089 | F08 | `@@ -2073,2 +2102 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H090 | F08 | `@@ -2077 +2104,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H091 | F08 | `@@ -2079,4 +2106,2 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H092 | F08 | `@@ -2112 +2136,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H093 | F08 | `@@ -2114,2 +2138 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H094 | F08 | `@@ -2118 +2140,0 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H095 | F08 | `@@ -2120,4 +2142,2 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H096 | F08 | `@@ -2160,22 +2179,0 @@ describe('CharacterStore', () => {` | 已删旧路径 | 不适用；承接 O07；旧测试表达已由该 owner 替代；零命中 Z3。 |
| H097 | F08 | `@@ -2227,2 +2225 @@ describe('CharacterStore', () => {` | 业务 owner | 适用：O07；该 hunk 的业务断言或场景归此唯一 owner。 |
| H098 | F09 | `@@ -4,2 +3,0 @@ import {` | 测试装配 | 不适用；承接 O08 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H099 | F09 | `@@ -25,2 +23,2 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H100 | F09 | `@@ -29,3 +27,3 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H101 | F09 | `@@ -34,47 +32,2 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H102 | F09 | `@@ -82 +35 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H103 | F09 | `@@ -85,17 +38,2 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H104 | F09 | `@@ -103,20 +40,0 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H105 | F09 | `@@ -124,20 +42,6 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H106 | F09 | `@@ -145,6 +49,30 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H107 | F09 | `@@ -152,6 +80,43 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H108 | F09 | `@@ -177 +142 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H109 | F09 | `@@ -179,5 +144,8 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H110 | F09 | `@@ -189,6 +157 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H111 | F09 | `@@ -206,4 +169,4 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H112 | F09 | `@@ -213,38 +176,3 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H113 | F09 | `@@ -252,2 +180,6 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H114 | F09 | `@@ -257 +189 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H115 | F09 | `@@ -264 +196 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H116 | F09 | `@@ -275 +206,0 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H117 | F09 | `@@ -282,17 +213,9 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H118-a | F09 | `@@ -302,75 +225 @@ describe('CharacterTransactionRecovery', () => {` | 已删旧路径 | 不适用；承接 O08；删除独立 exact-256 与重复 active-priority 测试；零命中 Z3。 |
| H118-b | F09 | `@@ -302,75 +225 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；以连续轮次聚合测试承接现行 interface。 |
| H119 | F09 | `@@ -378,0 +228,5 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H120 | F09 | `@@ -388 +241,0 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H121 | F09 | `@@ -390,2 +243 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H122 | F09 | `@@ -399,8 +250,0 @@ describe('CharacterTransactionRecovery', () => {` | 已删旧路径 | 不适用；承接 O08；旧测试表达已由该 owner 替代；零命中 Z3。 |
| H123 | F09 | `@@ -409,4 +253,2 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；该 hunk 的业务断言或场景归此唯一 owner。 |
| H124 | F09 | `@@ -414 +255,0 @@ describe('CharacterTransactionRecovery', () => {` | 已删旧路径 | 不适用；承接 O08；旧测试表达已由该 owner 替代；零命中 Z3。 |
| H125-a | F09 | `@@ -416,13 +257,5 @@ describe('CharacterTransactionRecovery', () => {` | 已删旧路径 | 不适用；承接 O08；删除空活动/未命中活动重复矩阵；零命中 Z3。 |
| H125-b | F09 | `@@ -416,13 +257,5 @@ describe('CharacterTransactionRecovery', () => {` | 业务 owner | 适用：O08；在连续轮次测试内保留空轮与 fail-closed 断言。 |
| H126 | F09 | `@@ -430,13 +262,0 @@ describe('CharacterTransactionRecovery', () => {` | 已删旧路径 | 不适用；承接 O08；旧测试表达已由该 owner 替代；零命中 Z3。 |
| H127 | F10 | `@@ -3 +3 @@` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H128 | F10 | `@@ -4,0 +5 @@ import { afterEach, describe, expect, test, vi } from 'vitest';` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H129 | F10 | `@@ -7 +7,0 @@ import type { CharacterSummaryDto } from '../src/shared/character-ipc';` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H130-a | F10 | `@@ -50,0 +51,89 @@ afterEach(() => {` | 测试装配 | 不适用；承接 O09 的业务测试；新增 Workshop API adapter。 |
| H130-b | F10 | `@@ -50,0 +51,89 @@ afterEach(() => {` | 业务 owner | 适用：O09；新增 StrictMode 单请求、选择过滤与脱敏测试。 |
| H131 | F10 | `@@ -60,6 +149 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H132 | F10 | `@@ -67,8 +150,0 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H133 | F10 | `@@ -79,18 +155 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H134 | F10 | `@@ -153 +212 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H135 | F10 | `@@ -155,2 +213,0 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H136 | F10 | `@@ -158,5 +214,0 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H137 | F10 | `@@ -164,23 +216 @@ describe('角色工作室 Renderer 关闭刷新', () => {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H138 | F11 | `@@ -23 +23 @@ type CharacterWorkshopViewApi = CharacterWorkshopApi & Pick<` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H139 | F11 | `@@ -100 +100,5 @@ function apiDouble(): CharacterWorkshopViewApi {` | 测试装配 | 不适用；承接 O09 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H140 | F12 | `@@ -32,37 +31,0 @@ const validPendingFileActionEvent = {` | 已删旧路径 | 不适用；承接 O10；旧测试表达已由该 owner 替代；零命中 Z4。 |
| H141 | F12 | `@@ -70 +33 @@ describe('ConversationEventProjection', () => {` | 业务 owner | 适用：O10；该 hunk 的业务断言或场景归此唯一 owner。 |
| H142 | F12 | `@@ -80,3 +43,4 @@ describe('ConversationEventProjection', () => {` | 业务 owner | 适用：O10；该 hunk 的业务断言或场景归此唯一 owner。 |
| H143 | F12 | `@@ -104,3 +68 @@ describe('ConversationEventProjection', () => {` | 业务 owner | 适用：O10；该 hunk 的业务断言或场景归此唯一 owner。 |
| H144 | F12 | `@@ -110,4 +71,0 @@ describe('ConversationEventProjection', () => {` | 已删旧路径 | 不适用；承接 O10；旧测试表达已由该 owner 替代；零命中 Z4。 |
| H145 | F13 | `@@ -3,0 +4 @@ import { expect, test } from 'vitest';` | 测试装配 | 不适用；承接 O11 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H146 | F13 | `@@ -38 +39 @@ function requiredScript(scripts: Record<string, string>, name: string): string {` | 测试装配 | 不适用；承接 O11 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H147 | F13 | `@@ -78,0 +80,7 @@ test('每个 Desktop E2E spec 都由一个显式入口拥有且 verify:desktop ` | 业务 owner | 适用：O11；该 hunk 的业务断言或场景归此唯一 owner。 |
| H148 | F14 | `@@ -28,6 +27,0 @@ describe('Main 通用生命周期', () => {` | 已删旧路径 | 不适用；承接 O15；旧测试表达已由该 owner 替代；零命中 Z5。 |
| H149 | F15 | `@@ -116,3 +116,13 @@ describe('官方默认角色安装', () => {` | 业务 owner | 适用：O12；该 hunk 的业务断言或场景归此唯一 owner。 |
| H150 | F16 | `@@ -3 +3 @@` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H151 | F16 | `@@ -7 +7 @@ import { afterEach, describe, expect, test, vi } from 'vitest';` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H152 | F16 | `@@ -10 +9,0 @@ import {` | 已删旧路径 | 不适用；承接 O13；旧测试表达已由该 owner 替代；零命中 Z6。 |
| H153 | F16 | `@@ -16,0 +16,27 @@ import type { PetInteractionController } from '../src/renderer/src/pet/pet-inter` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H154 | F16 | `@@ -25,0 +52,2 @@ afterEach(() => {` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H155 | F16 | `@@ -29,26 +56,0 @@ afterEach(() => {` | 已删旧路径 | 不适用；承接 O13；旧测试表达已由该 owner 替代；零命中 Z6。 |
| H156 | F16 | `@@ -125 +127 @@ function createPetViewApi(): MyselfApi {` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H157 | F16 | `@@ -132 +134,2 @@ function createPetViewApi(): MyselfApi {` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H158 | F16 | `@@ -155,0 +159,11 @@ function installPetViewBrowserApi(api: MyselfApi): void {` | 测试装配 | 不适用；承接 O13 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H159 | F16 | `@@ -156,0 +171,70 @@ describe('桌宠像素交互接线', () => {` | 业务 owner | 适用：O13；该 hunk 的业务断言或场景归此唯一 owner。 |
| H160 | F17 | `@@ -85,0 +86,18 @@ describe('preload 公开 API', () => {` | 业务 owner | 适用：O14；该 hunk 的业务断言或场景归此唯一 owner。 |
| H161 | F18 | `@@ -1,14 +0,0 @@` | 已删旧路径 | 不适用；承接 O11；旧测试表达已由该 owner 替代；零命中 Z7。 |
| H162 | F19 | `@@ -248 +248 @@ describe('preload 白名单', () => {` | 业务 owner | 适用：O15；该 hunk 的业务断言或场景归此唯一 owner。 |
| H163 | F19 | `@@ -251,2 +250,0 @@ describe('preload 白名单', () => {` | 已删旧路径 | 不适用；承接 O15；旧测试表达已由该 owner 替代；零命中 Z5。 |
| H164 | F19 | `@@ -254 +252 @@ describe('preload 白名单', () => {` | 业务 owner | 适用：O15；该 hunk 的业务断言或场景归此唯一 owner。 |
| H165 | F19 | `@@ -256,2 +253,0 @@ describe('preload 白名单', () => {` | 已删旧路径 | 不适用；承接 O15；旧测试表达已由该 owner 替代；零命中 Z5。 |
| H166 | F20 | `@@ -3 +3 @@ import { EventEmitter } from 'node:events';` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H167 | F20 | `@@ -9,0 +10 @@ import { expect, test, type Page } from '@playwright/test';` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H168 | F20 | `@@ -340,9 +341,36 @@ async function submitChatMessage(page: Page, text: string): Promise<void> {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H169 | F20 | `@@ -354,2 +381,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H170 | F20 | `@@ -402,2 +427,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H171 | F20 | `@@ -423,2 +446,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H172 | F20 | `@@ -471,2 +492,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H173 | F20 | `@@ -543,2 +562,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H174 | F20 | `@@ -589,2 +606,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H175 | F20 | `@@ -613,2 +628,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H176 | F20 | `@@ -656,2 +669,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H177 | F20 | `@@ -689,2 +700,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H178 | F20 | `@@ -726,2 +735,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H179 | F20 | `@@ -774,2 +781,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H180 | F20 | `@@ -813,2 +818,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H181 | F20 | `@@ -853,2 +856,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H182 | F20 | `@@ -913,2 +914,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H183 | F20 | `@@ -955,2 +954,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H184 | F20 | `@@ -989,2 +986,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H185 | F20 | `@@ -1029,2 +1024,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H186 | F20 | `@@ -1070,2 +1063,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H187 | F20 | `@@ -1103,2 +1094,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H188 | F20 | `@@ -1141,2 +1130,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H189 | F20 | `@@ -1175,2 +1162,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H190 | F20 | `@@ -1194,2 +1179,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H191 | F20 | `@@ -1231,2 +1214,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H192 | F20 | `@@ -1245,2 +1226,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H193 | F20 | `@@ -1299,2 +1278,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H194 | F20 | `@@ -1341,2 +1318,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H195 | F20 | `@@ -1371,2 +1346,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H196 | F20 | `@@ -1409,2 +1382,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H197 | F20 | `@@ -1443,2 +1414,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H198 | F20 | `@@ -1483,2 +1452,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H199 | F20 | `@@ -1512,2 +1479,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H200 | F20 | `@@ -1595,2 +1560,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H201 | F20 | `@@ -1643,2 +1606,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H202 | F20 | `@@ -1683,2 +1644,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H203 | F20 | `@@ -1753,2 +1712,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H204 | F20 | `@@ -1808,2 +1765,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H205 | F20 | `@@ -1852,2 +1807,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H206 | F20 | `@@ -1916,2 +1869,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H207 | F20 | `@@ -2004,2 +1955,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H208 | F20 | `@@ -2071,2 +2020,0 @@ test.describe('直接启动 Electron 的 CDP 夹具边界', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H209 | F20 | `@@ -2144,2 +2091,0 @@ test.describe('真实 Electron CDP smoke', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H210 | F20 | `@@ -2153,11 +2099,3 @@ test.describe('真实 Electron CDP smoke', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H211 | F20 | `@@ -2211,2 +2148,0 @@ test.describe('真实桌宠像素命中与左键拖拽', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H212 | F20 | `@@ -2220,12 +2156 @@ test.describe('真实桌宠像素命中与左键拖拽', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H213-a | F20 | `@@ -2330,0 +2256,159 @@ test.describe('真实桌宠像素命中与左键拖拽', () => {` | 测试装配 | 不适用；承接 O17 的业务测试；新增恢复 E2E 的 fixture/open/import helper。 |
| H213-b | F20 | `@@ -2330,0 +2256,159 @@ test.describe('真实桌宠像素命中与左键拖拽', () => {` | 业务 owner | 适用：O17；新增两条真实恢复重启 E2E。 |
| H214 | F20 | `@@ -2335,2 +2418,0 @@ test.describe('真实角色工作室闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H215 | F20 | `@@ -2844,2 +2925,0 @@ test.describe('真实角色工作室闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H216 | F20 | `@@ -2908,2 +2987,0 @@ test.describe('自主行为最小闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H217 | F20 | `@@ -2938,0 +3017 @@ test.describe('自主行为最小闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H218 | F20 | `@@ -2953,6 +3031,0 @@ test.describe('自主行为最小闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H219 | F20 | `@@ -2965,9 +3037,0 @@ test.describe('自主行为最小闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H220 | F20 | `@@ -2975,3 +3039,7 @@ test.describe('自主行为最小闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H221 | F20 | `@@ -3171,2 +3238,0 @@ test.describe('Explorer 动态图层自动验收', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H222 | F20 | `@@ -3228,0 +3295 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H223 | F20 | `@@ -3299,6 +3365,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H224 | F20 | `@@ -3470,0 +3532 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H225 | F20 | `@@ -3522,6 +3583,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H226 | F20 | `@@ -3534,10 +3590,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H227 | F20 | `@@ -3571 +3624 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H228 | F20 | `@@ -3579 +3632 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H229 | F20 | `@@ -3598,0 +3652 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H230 | F20 | `@@ -3612,6 +3665,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H231 | F20 | `@@ -3624,11 +3672,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H232 | F20 | `@@ -3696,0 +3741 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H233 | F20 | `@@ -3762,7 +3806,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H234 | F20 | `@@ -3776,11 +3814,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H235 | F20 | `@@ -3930,0 +3965 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H236 | F20 | `@@ -3951,6 +3985,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H237 | F20 | `@@ -3963,11 +3992,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H238 | F20 | `@@ -4051,0 +4077 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H239 | F20 | `@@ -4077,6 +4102,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H240 | F20 | `@@ -4089,11 +4109,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H241 | F20 | `@@ -4179,0 +4196 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H242 | F20 | `@@ -4223,6 +4239,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H243 | F20 | `@@ -4237,9 +4247,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H244 | F20 | `@@ -4247,3 +4249,7 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H245 | F20 | `@@ -4493 +4499 @@ test.describe('真实 Provider 业务闭环', () => {` | 业务 owner | 适用：O18；该 hunk 的业务断言或场景归此唯一 owner。 |
| H246 | F20 | `@@ -4495,2 +4500,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O18 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H247 | F20 | `@@ -4508,0 +4513 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O18 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H248 | F20 | `@@ -4529,18 +4533,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O18 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H249 | F20 | `@@ -4554,3 +4541,3 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O18 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H250 | F20 | `@@ -4585 +4572 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O18 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H251 | F20 | `@@ -4614,2 +4601,36 @@ test.describe('真实 Provider 业务闭环', () => {` | 业务 owner | 适用：O18；该 hunk 的业务断言或场景归此唯一 owner。 |
| H252 | F20 | `@@ -4697,144 +4717,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 已删旧路径 | 不适用；承接 O18；旧测试表达已由该 owner 替代；零命中 Z8。 |
| H253 | F20 | `@@ -4844,2 +4720,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H254 | F20 | `@@ -5015,17 +4889,0 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H255 | F20 | `@@ -5055,4 +4913,4 @@ test.describe('真实 Provider 业务闭环', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H256 | F20 | `@@ -5234,2 +5091,0 @@ test.describe('真实桌宠位置重启恢复', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H257 | F20 | `@@ -5244,17 +5099,0 @@ test.describe('真实桌宠位置重启恢复', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H258 | F20 | `@@ -5263 +5102 @@ test.describe('真实桌宠位置重启恢复', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |
| H259 | F20 | `@@ -5299 +5138 @@ test.describe('真实桌宠位置重启恢复', () => {` | 测试装配 | 不适用；承接 O16 的业务测试；仅调整 import、fixture、adapter、helper 或调用装配。 |


## 7. `numstat` 机械总账

下表取自 `git diff --numstat c7d951d..0c541f3 -- apps/desktop/tests tests/e2e`；删除文件的新增数为 0，新文件的删除数为 0。

| 路径 | 新增 | 删除 | 净值 |
| --- | ---: | ---: | ---: |
| `apps/desktop/tests/agent-ipc-authorization.test.ts` | 0 | 57 | -57 |
| `apps/desktop/tests/agent-ipc.test.ts` | 29 | 5 | +24 |
| `apps/desktop/tests/atomic-file-coordinator.test.ts` | 96 | 0 | +96 |
| `apps/desktop/tests/character-ipc.test.ts` | 83 | 48 | +35 |
| `apps/desktop/tests/character-package-service.test.ts` | 761 | 117 | +644 |
| `apps/desktop/tests/character-recovery.test.ts` | 28 | 1 | +27 |
| `apps/desktop/tests/character-startup.test.ts` | 182 | 33 | +149 |
| `apps/desktop/tests/character-store.test.ts` | 67 | 121 | -54 |
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
| `apps/desktop/tests` 小计 | 1647 | 875 | +772 |
| `tests/e2e` 小计 | 308 | 469 | -161 |
| **Git 总账** | **1955** | **1344** | **+611** |

逐文件求和：新增 `1647 + 308 = 1955`，删除 `875 + 469 = 1344`，净值 `1955 - 1344 = +611`，与 Git 总账一致。相对上一账本继续净减 51 行；本文不宣称安全减法已经穷尽，后续删除仍必须具有精确替代 owner、公开 seam 和 RED/mutation 证据。
