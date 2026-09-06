# 自定义角色情境执行实施计划

> 执行要求：采用 `subagent-driven-development`，按任务进行 TDD 与独立规格／质量复核。当前工作树已隔离，用户已授权开发与 Git 提交；不 push。

**目标：** 任意作者状态与动作按真实情境保持同步、有限播放并自主回退。

**架构：** 扩展唯一 Expression Engine 的候选资格与有限生命周期；Main 注入已有可信布尔事实，Director 复用唯一 pending 槽协调明确位移。Adapter 在同一 DeepSeek／Qwen 请求中生成条件计划，不增加模型请求或能力。

**技术栈：** TypeScript、Zod、Vitest、Electron Main、现有角色播放与 MotionService。

依据：[已授权补充规格](../specs/2026-09-06-character-motion-expression-followup.md)。本计划不把预期标为已实现。

## 全局约束

- 桌宠与官网链严格隔离；不改 `apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、锁文件或依赖。
- 只修改下列角色运行、Main 接线与对应测试；文件任务授权、MCP 禁用、锚点区域、用户素材与三态运动设置保留。
- 所有作者 ID／名称／描述完全自定义，唯一兜底由 `idleStateId` 指定，禁止增加官方状态语义或名称映射。
- 真实事实由 Main 注入；模型条件只控制表现资格，不能改变事实或启动运动／工具。
- 新增字段严格校验，有界；复用一个引擎、一个待执行位移槽和现有推进时钟，不增加后台循环、缓存框架或模型调用。
- 中文文档和结构性注释；最小修改；用户授权提交但不 push、不打包。按有意义的定向测试和真实观察交付，不重复整套验收矩阵。

### Task 1: 通用候选条件与有限表现生命周期

**文件：** 修改 `packages/character-runtime/src/character-expression-plan.ts`、`character-expression-engine.ts`、`character-behavior-plan.ts`、必要导出 `src/index.ts`；测试 `packages/character-runtime/tests/character-expression-engine.test.ts` 与 `character-behavior-plan.test.ts`。

**接口：**

```ts
type CharacterRuntimeFacts = {
  moving: boolean; dragging: boolean; carrying: boolean;
  chatting: boolean; taskRunning: boolean; awaitingConfirmation: boolean;
};
// 状态和动作候选均可包含 when: Partial<CharacterRuntimeFacts>。
// 状态另含 lifetime?: 'episode' | 'condition'，缺省 episode。
// condition 要求状态 when 至少一个 true。
engine.updateRuntimeFacts(facts: Partial<CharacterRuntimeFacts>): CharacterExpressionResult;
engine.hasEligibleExpressionFor(facts: Partial<CharacterRuntimeFacts>, requiredFact?: keyof CharacterRuntimeFacts): boolean;
```

默认六项事实 false；更新不递增推断 contextRevision，迟到计划按当前事实筛选。资格查询只读，不改变随机源、事件消费、冷却或状态；requiredFact 要求状态或动作条件对此事实明确为 true，并有合格资源和动作。查询遵守计划有效期、心情强度、推断开关、事件资格、冷却及休息期；无计划时 false。

- [ ] RED：在既有 fixture 上使用 `bright`／`soft` 等非运动语义 ID。计划 `when:{moving:true}, lifetime:'condition'` 在静止时 idle，移动时 bright，停止在两秒内立即 idle；再次移动可立即恢复。同状态内动作分别 `when:{carrying:true}`／`when:{carrying:false}`，事实改变即换动作。加入 `taskRunning` 条件示例，证明不是移动专用代码。
- [ ] RED：停止后才接纳 movement 条件计划仍 idle；失败回退也不能选不合格动作；requiredFact 查询不把无条件状态当移动匹配；严格 Schema 拒绝未知键、非布尔和没有真活动条件的 condition。
- [ ] RED：episode 以状态进入时刻计作者时长，缺省 3000ms、最少 2000ms，动作轮换不刷新；结束休息10000ms而心情保留，时钟推进后可再次出现。condition 在真实条件持续时不按 episode 休息。明确状态／动作结束后，同轮 preserve token 对应计划（包括晚于结束到达）不能重新选同一明确状态；后续独立新互动仍可显式播放。
- [ ] 运行新增测试，记录正确失败。实现统一资格过滤，立即撤销不适用播放，再依层级择优；idle 兜底和明确播放越过模型条件，但保留资源、归属及作者硬冷却。新心情、新计划、reset／角色切换清理相应有限记录，不建立无界历史。
- [ ] Zod 与面向 Qwen 的 JSON Schema 保持一致。运行 runtime 两个定向测试文件及 runtime typecheck，检查差异后仅提交本任务文件。

完成标准：上述失败用例转绿，已有真实生命周期测试仍有效；仅保留一个表达路径。报告写明 RED/GREEN 命令、结果和具体接口。

### Task 2: Main 事实接线、模型条件与同步位移

**依赖：** Task 1 的事实类型及两个 Engine 接口。

**文件：** `apps/desktop/src/main/characters/character-behavior-service.ts`、`character-behavior-director.ts`、`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`；对应 `apps/desktop/tests/character-behavior-service.test.ts`、`character-behavior-director.test.ts`、`conversation-chat-adapter.test.ts`。仅在真实接线需要时调整 `apps/desktop/src/main/characters/character-runtime.ts` 或现有 Coordinator，不修改其他业务链。

**接口：**

```ts
// Service 转发 Engine；update 发布真实播放效果。
updateRuntimeFacts(facts: Partial<CharacterRuntimeFacts>): void;
hasEligibleExpressionFor(facts: Partial<CharacterRuntimeFacts>, requiredFact?: keyof CharacterRuntimeFacts): boolean;
// Director options 增可选 now?: () => number，默认 performance.now。
// runtime 保留 moving/dragging/carrying/movementMode，加 chatting/taskRunning/awaitingConfirmation。
// runtime.pendingMovement?: true，仅当 Main 已有等待中的明确位移。
```

Service 从真实 MotionSnapshot 更新 moving/carrying；Director 从已有活动字段同步其他事实（taskRunning 对应现有 capabilityTask，占用事实不声明工具成功）。初始化、换角色后重新注入；事实变化不依赖下一条聊天或模型调用。

唯一待执行槽保存精确 `MotionRequest`、来源、generation、turnEpoch、lifecycle、等待截止与是否已完成模型响应；相对方向距离不可改为区域。明确短移动若已有未来 moving=true 的匹配计划可立即执行，否则等待同轮模型。完成模型接纳后或8000ms超时降级只执行一次，先清槽再提交；同轮聊天的 thinking 不能撤销明确等待。停止立即清理，真正任务／确认、取消、新输入、拖拽、角色／Provider／配置、reset、close 使等待失效且不得降级。模型 move_once 保留成功阶段后提交规则。匹配失败走已有不可用提示，不增产品诊断面板。

保留0/1/2模式及独立 Scheduler，不为自主移动新增模型请求；运行事实变化仍重判已有计划，不能用播放 source 的同优先级锁阻挡同轮授权位移。

- [ ] RED：用 Service 实际 Engine 验证运动开始／停止与 carrying 更新产生不同合法动作；任务占用条件解除及时回退。
- [ ] RED：Director 明确相对移动先 pending、不造 moving；完成后保持方向／距离只启动一次；已有条件计划可立即启动；超时与模型错误仅降级明确请求；停止／取消／拖拽／切换／新输入不复活；一例0/1/2保留，明确原地动作不移动。
- [ ] RED：Adapter 文本指令、JSON 输出及修复保留状态与动作 when/lifetime；根据描述为位移提出 moving=true/condition，而不是按名称本地补丁。明确动画请求不转位移，自主请求仍 tools=[]。
- [ ] 运行新增失败测试，再最小实现上述接线与 pending 替换；删除被替代的旧 pendingMovementControl 分支。
- [ ] 运行三个定向测试文件、desktop typecheck；主智能体检查没有网站／文件能力差异，提交本任务文件。

完成标准：真实 Main 接线覆盖通用资格，模型只作建议；时序测试有 RED/GREEN，未引入第二个运动入口或残留旧槽。

### Task 3: 实际窗口验证与交付记录

**文件：** 更新 `docs/operations/2026-09-06-custom-state-autonomy.md`、本计划、现行角色规格状态；不修改用户角色数据来假造通过。

- [ ] 主智能体使用 computer-use 观察实际运行的用户角色。实际聊天发送一次相对移动、一次明确状态／动作及一条开心交流，观察状态／动作变化、有限结束和真实位置；工具不可靠时记录限制，业务快照只作补充。
- [ ] 实际缺陷优先缩小成定向测试，修复并复查；不把测试 fixture 或模型口头回复当实际播放证据。
- [ ] 独立最终审查覆盖本计划差异中的条件、退出、待执行位移及可信边界。按变更范围运行尚未覆盖的必要检查、`git diff --check`；不重复已绿全矩阵，不打包。
- [ ] 记录观察到／未观察到的结果及剩余限制，留下普通 dev 桌宠供用户体验，提交文档，不 push。

完成标准：有真实窗口与代码两类证据，未通过项明确保留；没有官网链改动。
