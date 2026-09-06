# AI Pet 自定义状态与持续心情实施计划

> 执行要求：使用 subagent-driven-development 分项实施；主智能体维护规格、整合和提交。每项使用最小 RED → GREEN 定向检查，独立审查不重复运行已通过测试。

**目标：** 让用户编写的人设成为角色系统提示词，角色按描述选择自定义状态与动画，并在没有下一轮聊天时自然演进心情与表现，保留三态自主运动。

**架构：** 沿用 Electron Main、现有 Provider、素材编译与播放器；用 V3 稳定 ID、单活动状态及 Main 时间模型替代 V2 官方语义和主／修饰组合。模型提供有界心情更新及候选计划，本地调度负责时间、播放和真实运动；已验收文件 Core 保持独立。

**技术栈：** 当前仓库的 TypeScript、Zod、React、Zustand、Pixi、Electron、Vitest；不新增依赖或另一套框架。

**依据：** [获批规格](../specs/2026-09-05-ai-pet-custom-state-autonomy-design.md)。基线 `d8a25f47`，分支 `AgentCoreExtension`，现有隔离 worktree。用户于 2026-09-06 批准开工及现有锚点入口保留。

**后续真实反馈：** 用户报告不切动画、不移动及移动时仍用 idle，Task 7 已开启。已完成相对距离／正文截停和发布修订修复，真实工作台发布及明确状态有限播放通过；运动表现同步仍待执行时序确认。Task 1–6 的勾选仅证明对应限定工作，不代表真实角色体验整体完成。

## Global Constraints

- 面向人的文档和结构性注释使用中文。保留用户原始数据与无关改动。
- 桌宠与官网严格隔离：不修改 `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 的业务、配置、入口及依赖解析。
- MCP 运行时保持禁用；不改写已验收文件任务 Core、任务授权、许可或命令边界。
- 同一时刻一个活动状态；唯一保留语义是 `idleStateId` 指向的兜底。状态和动作不附属官方分类。
- 人设是角色系统提示词的一部分；模型不能修改宿主权限。自主心情请求 `tools: []`，不发消息、不发起文件任务、不改变运动模式。
- 保留 `0=静止 / 1=一直运动 / 2=间断运动`；模式 2 沿用 10–30 秒本地等待；运动和情绪动画互相独立。
- 锚点与区域保留现有入口、数据及底层实现，本轮不扩展。不得为情绪动画重新诊断无关原生拖拽问题。
- 不打包、不 push。用户允许分步 git 提交；删除大量旧文件前列出精确清单并取得第二次批准。
- V1/V2 只作为输入兼容，最终正式创作、发布和运行只有 V3 一条路径；过渡提交不宣称全部链路完成。
- 采用有意义的定向验证与受影响包类型检查；结束时去重验证关键整合路径，不反复运行完整矩阵。

### Task 1: V3 作者契约、无损输入转换与按 ID 解析

**文件：**
- 新增 `packages/character-runtime/src/character-v3-schema.ts`、`character-v3-migration.ts`、`character-playback-view.ts`。
- 修改 `packages/character-runtime/src/character-v2-schema.ts`（仅导出复用 Schema，不改变 V2 含义）、`index.ts`。
- 定向测试 `packages/character-runtime/tests/character-v3-schema.test.ts`、`character-v3-migration.test.ts`、`character-playback-view.test.ts`。

**接口：** 导出 `CharacterDraftV3`、`PreparedCharacterManifestV3`、`CharacterManifestV3` 及严格对应 Schema。V3 为 `version: 3`、`idleStateId`、原 identity/skins/states/actionIds/actions；删除 kind/semantic/共存/主修饰约束。复用原人设、帧、几何、资源预算与动作播放字段，不复制整个 V2 文件。状态保留名称、描述、标签、intensity、建议时长、agentInferable、actionIds、可信事件进入/退出条件；事件名按规格 4.2，条件为 `{mode:'all'|'any', clauses:[{kind:'event',event:事件名}]}`。迁移未选定 idle 的草稿保持键并用 null，Prepared/Published 必须有效非空引用；资源清单尚有迁移问题时可使用专用 `CharacterMigrationManifestV3` 类型承载，不能直接作为正式包。V2 实际 Schema 的 512 状态/每状态128引用上限保持，不在本轮收紧旧包输入。

转换接口 `migrateCharacterDraftToV3(raw)` / `migrateCharacterManifestToV3(raw)` 返回 `{document, issues, sourceVersion}`；V1 沿用现有转换器进入 V2 输入。issue 为稳定 code、对象 ID、中文说明及原规则摘要，至少覆盖 idle 歧义、修饰状态/组合条件、无法表达的动作约束。严格合法 V3 原样解析，非法输入拒绝。V2 简单所有权可直接转换；语义回退按旧资源解析结果展开为相同逻辑动作的表现，不能丢皮肤或改逻辑 ID；不能无损解释的情况带 issue，不能作为发布就绪。

播放接口 `resolveCharacterPresentationV3(document, skinId, stateId, actionId)` 先检查归属，再取请求皮肤精确表现/默认皮肤相同动作；返回真实 stateId/actionId/表现/来源。单独 `createCharacterPlaybackView(manifest, skinId)` 与 `characterPlaybackViewSchema` 生成并验证严格只读 ID 视图：states 仅含播放身份/归属，presentations 按 actionId 唯一保存资源，idle 为真实目标对；共享动作不能按状态重复嵌入整份资源。素材回退不伪造逻辑动作，时间/暂停命令留给调度事件。此步不切正式 Main/Renderer。

- [x] RED：自定义中文名称仍按稳定 ID；旧字段被 V3 拒绝；非归属动作不能播放；V2 多皮肤/描述/锚点保留，复杂旧规则产生问题且输入不变。
- [x] GREEN：最小 Schema、转换、解析实现；有问题的迁移保留可编辑 document 与报告，不掩盖规则损失。
- [x] 验证：运行上述 3 个文件与 `pnpm.cmd --filter @myself/character-runtime typecheck`，检查 V2 原输入契约没有被改变。
- [x] 审查并提交：提供实际 RED/GREEN 结果及后续接线所需接口，不宣称桌面已经 V3。

### Task 2: 单状态调度、持续心情和表现计划

**文件：** 新增 `packages/character-runtime/src/character-mood.ts`、`character-expression-plan.ts`、`character-expression-engine.ts`；复用并精简 `behavior-scheduler.ts` 中通用播放生命周期，必要时提取不依赖 V2 的部分；导出入口与相应测试。

**接口：** `CharacterMood` 保存 summary、targetStrength、startedAtMs、fadeInMs、halfLifeMs、revision、sourceEventId；`sampleMood(now)` 纯时间求值。聊天默认立即进入，自主默认 60 秒渐入，默认半衰期 5 分钟，范围 30 秒至 30 分钟，强度不足 0.02 清除。注入时钟和随机，不读系统/调用 Provider。

`CharacterExpressionPlan` 使用 V3 stateId/actionId 候选与 0..1 分数、强度区间、有效期和 moodRevision，最多 8 状态/32 动作、默认 20 分钟/最多 30 分钟。`CharacterExpressionEngine` 提供更新心情/应用计划/明确播放/可信事件/advance/feedback/replace/reset/snapshot；产出真实 ID 播放事件、唯一 stateId 和 mood。动作冷却、重复抑制、loop、中断、失败回退及播放 token 复用通用机制；有可用替代时不连续选同一动作，状态最短保持 2 秒。全冷却不忙循环，idle 有效帧可静止。旧 token、角色/情境/心情修订不匹配不能复活。

**供后续接线的具体约定：**
- 导出严格 `characterMoodUpdateSchema`（`summary/strength/fadeInMs?/halfLifeMs?`）与 `characterExpressionPlanSchema`（`states:[{stateId,score,minStrength,maxStrength,actions:[{actionId,score}]}], validForMs`）。解析补默认有效期；空候选表示没有匹配状态。动作候选为空时使用该状态作者动作权重。
- 模型不提供修订号；Main 捕获请求上下文，Engine 将计划绑定 contextRevision/moodRevision。提供 `context()` 返回不可变修订标记；`applyDecision({context,eventId,source:'chat'|'autonomous',moodUpdate?,expressionPlan?})` 校验标记后一次提交心情与配套计划。无更新表示继续演进，新心情无合法计划清旧计划。
- Engine 构造器接 `manifest/skinId?/now/random/createPlaybackToken`；导出 `advance()`、`playExplicit(stateId,actionId?)`、`applyFeedback(feedback)`、`recordEvent({id,type,occurredAtMs})`、`invalidateContext()`、`replaceCharacter(manifest,skinId?)`、`reset()`、`snapshot()`。具体返回类型统一为 `{snapshot,effects}`；snapshot 至少含 stateId/skinId/mood/contextRevision/moodRevision/schedule，便于 Main 原几何绑定和令牌反馈复用。
- 普通 advance 不递增情境修订；真实新交互或角色/配置变化由 Main 显式 invalidate。事件条件按规格 4.2 的 2 分钟边沿消费，idle 兜底和明确指定可越过可选条件但仍校验资源。
- `behavior-scheduler.ts` 只需要动作 id、interrupt、loopPolicy、fallback ID 与选择的 stateId/actionId，可把参数改成最小结构型接口供 V2/V3 同时调用，避免复制整套归约器。必要通用历史类型可移到此模块；不要让新引擎依赖旧状态推断/语义选择器。
- 模型计划时效、心情变化及明确停止表现能够结束持续循环；“until-interrupted”不允许过期计划永久续播。动态静止/循环/时长应由播放 effect 明确表达，后续 Renderer 依此执行；帧播放器不自行选择状态。
- 本步原 Main/UI 尚未切换，新增 V3 引擎接线由 Task 3 完成；不得用临时 any/旧主修饰快照假装接口兼容。

- [x] RED：开心→弱开心→idle 无需下一条消息；同状态两个动作轮换；新心情丢弃旧计划；迟到反馈和非法 ID 无效；无可用候选稳定 idle。
- [x] GREEN：独立可复用引擎，解释计划与窗口位移无关。
- [x] 验证：相应定向测试与角色包 typecheck；不按真实分钟等待测试，不调用真实模型。
- [x] 审查并提交接口与事件定义，供正式接线使用。

### Task 3: 正式工作台、发布、播放器与 Main 切换 V3

**文件：** `apps/desktop/src/shared/character-ipc.ts`、`apps/desktop/src/shared/myself-api.ts`、`apps/desktop/src/shared/character-motion-ipc.ts`；Main `characters/character-migrations.ts`、`character-store.ts`、`character-actions.ts`、`character-package-service.ts`、`character-asset-service.ts`、`official-default-character.ts`、`pet-visual-geometry.ts`、`character-behavior-service.ts`；Renderer `characters/store/character-workshop-store.ts`、`characters/workshop/{StateList,StateInspector,ActionInspector,CharacterWorkshopView,DraftCharacterPreview}.tsx`、现有编译与播放器适配文件。只修改这些链路实际消费者，不重写事务/素材/布局。

**接口：** Main 的草稿、发布及活动清单输出 V3，运行快照使用 Task 1 ID 视图；character-behavior-service 接 Task 2 引擎并保持现有 token/反馈安全边界。工作台状态直接创建名称和描述；删除主/修饰和官方语义选择及组合控件，保留人设和所有素材/播放设置；锚点入口不动。动作以状态 actionIds 归属；按真实 ID 预览与播放。

旧版本输入先经原完整性/资源校验再转换；报告随迁移草稿保留，原包字节与素材不覆盖。有 issue 时在现有工作台恢复/发布流程中显示受影响规则，作者明确处理后才能发布，不能以一次隐形标记清空全部问题。正常 V2 自动迁移，歧义 idle 要明确选取，未完成转换的包不替换活动指针。不得继续维护 V2 正式运行补偿路径。

接线顺序补充：现有 Director 和公开目录直接依赖 V2 Service 的语义授权。为避免临时伪造 V2 对象，本步可提前完成 Task 4 的 V3 目录 ID 类型适配及 Task 5 的运动／动画解耦；后续任务仍分别负责完整人设与描述决策、自主请求生命周期。只调整实现顺序，不扩大功能范围。

用户本轮再次强调两级决策与自主结束后，本步追加验证 Task 2 的明确播放接缝：指定动作默认一遍、指定状态按作者时长或缺省3秒；即使素材设置无限循环，也必须在本次明确表现结束后恢复有效心情计划或idle。优先落实这个核心，不以播放器接线代替行为决策交付。

- [x] RED：选择自定义状态及动作在草稿预览/发布运行中 ID 一致；保存不丢人设和几何；复杂旧包不会静默启用；旧 token 不影响新角色。
- [x] GREEN：复用已有导入、事务、编译和播放器接通 V3；在同一任务中修正全部直接类型消费者。
- [x] 验证：工作台/store/player 定向检查、桌面与角色包 typecheck、一次桌面 build；保留已验收文件链和网站差异为零。
- [x] 审查并提交。只证明创作运行接线，模型自主决策由后续任务完成。

### Task 4: 人设系统提示词、描述候选和分区模型决策

**文件：** `packages/character-runtime/src/character-behavior-plan.ts`、`behavior-target-resolver.ts`（退役旧语义目录，复用文本匹配）；新增 `character-persona.ts`（必要时）；`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`、`conversation-coordinator.ts`、`apps/desktop/src/main/characters/character-behavior-director.ts`；必要的 Provider 响应解析和共享建议字段。

**接口：** 人设完整包含 description/background/traits/languageStyle/formsOfAddress/likes/dislikes/behavioralTendencies/boundaries/exampleLines，按当前角色生成明确系统消息段，输出协议与 Main 权限独立。候选按描述、当前输入/心情/当前状态/近期动作选取，最多 24 状态、32 动作，保留探索位置，不能永久只有前 N 项；直接描述命中超过旧目录位置的状态仍能进入候选。不引入向量库。默认宿主 64 KiB 上限同时服从模型真实上下文；人设与动作目录分配预算，不能用名称首字代替全部描述。

输出 `text`、`moodUpdate`、`expressionPlan`、既有 `movementControl`、既有 `capabilityPlan` 各自严格解析；相互引用的心情/计划原子校验。合法聊天正文不被坏行为字段吞掉，至多一次无工具修复；原任务建议及授权路径独立保留。模型分数是偏好，Main 决定实际状态、动作与生命周期。

- [x] RED：两套人设的全部字段进入各自系统消息；相关描述能检索末尾候选；坏行为字段不覆盖合法正文/重复文件任务；人设文字不能使请求获得工具。
- [x] GREEN：替换旧固定 emotion/semantic 输出与名称补偿路径；按当前 DeepSeek/Qwen 适配器复用模型请求。
- [x] 验证：聊天适配/Provider 控制解析/候选目录定向测试、相关类型检查；真实 DeepSeek／Qwen 代表场景通过，具体范围见验收记录。
- [x] 审查并提交。最后修复 `2e5bd423` 已限定复核通过，真实模型请求未因修复轮合并调整而重复运行。

### Task 5: 自主时间推进、感知和三态运动独立接线

**文件：** `apps/desktop/src/main/characters/character-proactivity-runtime.ts`、`character-proactivity-scheduler.ts`、`character-behavior-director.ts`、`character-behavior-service.ts`、`apps/desktop/src/main/conversation/main-conversation-composition.ts`、`apps/desktop/src/main/index.ts`，现有设置 Schema/service/UI 仅加入自主心情开关所必需部分。

**接口：** 本地 advance 推进衰减/状态/动作，不发模型请求。5 分钟未互动可自主重评，后续至少 15 分钟；全应用滚动小时最多 4 次、请求开始计费、失败/修复/取消计数，60 秒超时，只有一个在途请求。使用当前聊天 Provider 及现有披露条件，工具为空，只接收心情/表现。新互动/角色/配置/reset/关闭中止或失效旧结果；任务和用户聊天优先。休眠间隔有界计入一次，不补跑；不持久化心情和私密聊天正文。

保留独立的 `MovementControlPlan`、0/1/2 设置、原子写、Scheduler 10–30 秒与真实 MotionService。删除 move 动画触发运动及移动前必须有 move 动画两向耦合；模式变化/段落结束只清运动，不取消心情与状态。人物没有“运动”状态也能移动，0 档原地情绪动画正常。只投影实际任务结果、聊天、点击/拖拽与时间事实，不读其他应用/截图/剪贴板。

- [x] RED：0 档仍推进心情；没有 move 动画仍按模式 1/2 位移；动作名不能启动位移；超时/换角色迟到结果不生效；自主请求工具为空且不会向聊天发消息/启动任务。
- [x] GREEN：复用现有 runtime 生命周期和 Provider 工厂，不新增第二套会话/权限引擎。
- [x] 验证：虚拟时钟自主调度、现有三态关键回归、相关类型检查；不把无关原生拖拽矩阵带入。
- [x] 审查并提交。实现 `10543a7d`，限定审查通过；实际 Windows 连续体验仍待用户反馈。

### Task 6: 旧路径清理与基本交付

**文件：** 前述模块中仅服务退役语义/主修饰/旧情绪的实现与测试；`CONTEXT.md`、旧角色规格状态标记、`docs/operations/2026-09-06-custom-state-autonomy.md`。

- [x] 确认正式入口仅 V3，列出旧代码与引用；大量文件删除先提交精确清单申请第二次批准。保留 V1/V2 输入解析、原包恢复、既有锚点数据与素材，不按目录批量清空。用户二次批准后，14 个整文件已逐个移入回收站，旧导出与残余引用已清理，相关测试和直接消费者类型检查通过。
- [x] 定向结果通过后进行一次范围明确的规格和质量审查；只修功能、安全或契约问题，不追加假设风险框架。最终单帧一次播放修复 `6d9e8847` 已限定复审 Approved。
- [x] 去重运行受影响包类型检查、必要安全/集成及一条角色创作→发布→聊天表现基本流程；记录命令、结果、未观察项目。网站业务差异为零；唯一 Electron 闭环49秒通过，详见验收记录。
- [x] 更新领域词汇与验收记录，报告实际功能、已知限制及用户体验待确认处；提交，不 push、不打包。功能和获批清理已完成，持续体验待用户反馈。
