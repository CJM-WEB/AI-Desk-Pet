# AI Pet 持续行为与默认角色实施计划

> 执行要求：采用 subagent-driven-development 和 TDD；已有用户整体批准，连续执行各项，不再重复请求方案许可。

**目标：** 新默认角色可恢复安装，长期状态自然保持，描述驱动的表现与任务协同运行。

**架构：** 复用单一 CharacterExpressionEngine，增加独立 backgroundSelection 所有权；Main 在同一轮内独立调度表现和主请求，按真实任务事实仲裁。默认资源复用 V3 角色存储和源素材校验。

**技术：** Electron、TypeScript、Zod、Vitest、Playwright；不新增依赖。

## 全局约束

- 执行[已批准规格](../specs/2026-09-12-character-behavior-continuity-design.md)，同一时刻只有一个活动状态。
- 本仓库已是独立 worktree；不新建分支，不进行 Git 写操作。保留已有素材导入及研究文档改动。
- 文档和结构性注释使用中文。正式资源删除仅限获批九文件，先备份并核实路径；本机原创作角色保留。
- 表现请求无工具；授权前零文件/命令副作用；事实、时间、取消与播放 token 仍由 Main 管理。
- 描述预算上限不扩大。自主首次五分钟、后续十五分钟、滚动小时四次；表现推理十二秒、首帧一点五秒。
- 当前模型/密钥仅通过既有 Main Provider 接口使用，不输出密钥、私有原文或任务数据。
- 先定向验证，最后执行有必要的质量门禁；已有失败单独记录，不修改测试来伪造通过。

## 接口约定

运行时模块导出：

```ts
type CharacterBackgroundSelection = {
  stateId: string;
  actions: Array<{ actionId: string; score: number }>;
};
// 模型空值或缺省表示没有新的长期选择，保持现有选择。
// 正式输出 Schema 展示 backgroundSelection；宿主兼容缺省为空，不建立第二套协议。
type BackgroundInput = { backgroundSelection?: CharacterBackgroundSelection };
```

CharacterExpressionSelection / SelectionDecision / Engine.applyDecision 增加该字段。Engine 快照增加可选 `background: { stateId: string; enteredAtMs: number } | null` 和 `stateEnteredAtMs`，Main 转成经过时长给模型，不暴露可写时钟。

Main Adapter 接口：

```ts
type ConversationExpressionReply = Pick<ConversationChatReply,
  'moodUpdate' | 'expressionPlan' | 'backgroundSelection' | 'explicitPlayback' |
  'movementControl' | 'expressionStatus' | 'requestKind'>;
// 输入回调使表现能在主请求完成前交付；调用方提供独立取消信号。
// 没有回调的直接消费者仍等待并返回同一结果，避免测试工具另造正式路径。
// 内置单槽由 Main 创建 Adapter 时传 expressionFirst=true。
```

任务首帧准备继续复用 `prepareActivity(fact)`、`releasePreparedActivity()` 和 `started`，扩展 Main 端原有 moving 参数限制。

## Task 1: 新默认角色的资源与可恢复升级

**文件：** 修改 `apps/desktop/src/main/characters/official-default-character.ts`；必要的安装恢复细节放在同目录 `official-default-character-installation.ts`。按需要扩展 `character-store.ts` 内部 Main 接口。替换 `apps/desktop/resources/characters/default/`。测试为 `apps/desktop/tests/official-default-character.test.ts` 及新增安装恢复测试。测试夹具涉及 `tests/fixtures/character-workshop-assets.ts` 和 `apps/website/tests/default-character-assets.test.ts`。

**输入：** 本机已发布角色 `c9375270-c534-44ee-abe5-13aa3ac81ee4`；用户补充源素材目录 `D:/Python/resource/resource/resource/`，先比对，不重新猜测作者帧顺序。

**输出：** `ensureOfficialDefaultCharacter` 可安装/升级；另提供不改变活动角色的安装入口给启动集成。内部 ID 为 builtin-default，显示名为 AI Pet默认角色；source catalog 的 characterId 同步调整。

- [x] RED：真实临时 CharacterStore 安装后断言九状态、203帧、新名称及原字段；已有旧默认也升级而非直接复用。示例：

```ts
expect(manifest.name).toBe('AI Pet默认角色');
expect(manifest.states).toHaveLength(9);
expect(manifest.skins[0].presentations.flatMap(p => p.frames)).toHaveLength(203);
```

- [x] 运行 `pnpm.cmd exec vitest run apps/desktop/tests/official-default-character.test.ts`，记录旧八状态实现的失败。
- [x] GREEN：先校验并备份源/旧默认，安装源目录、保存草稿、发布编译版本、最后确认内置修订；用最小可恢复安装记录连接现有事务。源图缺失、草稿后/发布前中断不能被标记完成。
- [x] 删除前备份获批九文件。新资源核验成功后移除旧正式资源；测试改用独立合成小图，官网素材保留。
- [x] 验证首次安装、幂等、保留其他活动角色、损坏恢复与升级中断；报告资源哈希、文件范围、恢复位置。

## Task 2: 独立长期状态协议与 Engine

**文件：** `packages/character-runtime/src/character-expression-plan.ts`、`character-expression-selection.ts`、`character-expression-engine.ts`；对应 tests，必要时 `index.ts` 导出。此任务不编辑 behavior-target-resolver.ts。

**输入/输出：** 使用上文 CharacterBackgroundSelection；Engine.applyDecision 接纳独立长期选择，快照提供背景/状态开始时间；空值保持原背景。

- [x] RED：实时时钟可注入的真实 Engine 接纳休息长期状态后，推进三十秒和十分钟，观察所有 play effect 均不插入 idle；工作事实结束恢复休息。测试草图：

```ts
engine.applyDecision({ context: engine.context(), eventId: 'rest', source: 'chat',
  backgroundSelection: { stateId: 'rest', actions: [{ actionId: 'lie', score: 1 }] } });
now = 600_000;
expect(engine.advance().snapshot.stateId).toBe('rest');
```

- [x] 运行 runtime 定向测试，先确认新字段和持续规则未实现的失败。
- [x] GREEN：在现有 Engine 中新增背景所有权，按“明确/活动/短时优先，合法背景次之，应急idle最后”仲裁。心情失效不删除背景；同动画续播不借道idle；背景仍服从资源失败、退出条件和作者动作播放参数。
- [x] 验证空结果、模型失败、心情归零、动作冷却、换皮肤/reset、不同进入条件、活动与背景共用状态不串所有权；短时明确动作仍一遍，明确长期选择完成后保持。
- [x] 运行 `pnpm.cmd --filter @myself/character-runtime test` 和该包 typecheck。

## Task 3: 描述预算、独立验证与新状态默认值

**文件：** `apps/desktop/src/main/conversation/character-expression-adapter.ts`；`packages/character-runtime/src/behavior-target-resolver.ts`；`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`；`apps/desktop/src/renderer/src/characters/workshop/StateInspector.tsx`；对应测试。不编辑 conversation-chat-adapter.ts 或 Director。

**依赖：** Task 2 的 backgroundSelection 导出契约；可先写失败测试，接口名称已固定。背景空动作按本轮已展示作者动作补齐。

- [x] RED：合法明确目标加非法普通候选仍返回明确目标且不返回非法候选；状态/动作描述能区分无意义名称；在小预算内保护精确目标描述而先去掉无关项。

```ts
expect(reply.explicitPlayback).toEqual({ stateId: 'rest' });
expect(reply.expressionPlan?.states ?? []).not.toContainEqual(
  expect.objectContaining({ stateId: 'forbidden' }));
```

- [x] 运行 `pnpm.cmd exec vitest run apps/desktop/tests/character-expression-adapter.test.ts` 及目录投影/工作室定向测试，确认失败。
- [x] GREEN：扩展模型 Schema 与提示，按作者描述明确区分长期选择/短时/活动。独立校验背景、普通计划和明确目标；保留合法明确目标，非法部分不能变成自主权限。合法但无明确目标的请求保留 requestKind 供准确失败反馈。
- [x] 预算先减少无关候选，保留精确目标、当前背景和关键描述；保持总预算与目录配对检查。
- [x] 新建状态默认推断开启，开关说明说明关闭仍可明确指定，已有作者关闭保持。保留本文件已有素材修改。
- [x] 测试通过并报告各失败原因和修复范围。

## Task 4: 同轮并行表现、单槽先行及任务生命周期

**文件：** `conversation-chat-adapter.ts`、`conversation-coordinator.ts`、`main-conversation-composition.ts`、`character-behavior-director.ts`、`character-behavior-service.ts`、Main `index.ts`；对应单元及集成测试。

**依赖：** Task 2/3 契约。回调交付、独立 owner、任务准备全部由 Main 管理；Provider 选择沿现有路由和披露检查。

- [x] RED：挂起主请求时表现可交付；任务申请也产生表现；单槽模式表现完成之前主请求尚未开始。

```ts
expect(order).toEqual(['expression-start']);
releaseExpression();
await nextTurn();
expect(order).toEqual(['expression-start', 'expression-ready', 'main-start']);
```

- [x] RED：授权卡出现后同轮表现仍可接纳；取消/过期/准备失败使迟到表现失效；Core 前零副作用，taskRunning 准备阶段保持 false。
- [x] GREEN：主请求和表现分别交付。远程并行，Qwen 创建 Adapter 时采用 expressionFirst。独立 owner 绑定 turn、generation、角色修订和取消信号；主请求完成不等于撤销表现。
- [x] GREEN：扩展 prepareActivity 支持 taskRunning；首帧等待有界，失败提示后继续已授权任务。任务实际阶段和终态记录到既有可信事件；终态请求独立，不能让旧运行中响应覆盖结果。
- [x] 验证权限、生命周期、聊天正文及真实任务结果不受可选表现失败影响。定向运行 coordinator、chat-adapter、director、service、composition 测试。

## Task 5: Main 情境摘要和自主判断

**文件：** 以 `character-behavior-director.ts`、`character-proactivity-runtime.ts` 及独立 `character-situation.ts`（仅当有足够独立职责）承载时钟和摘要；`main-conversation-composition.ts` 传入自主/任务情境。测试使用可注入时钟。

**输出：** ConversationBehaviorContext 的可选 situation 包含 `idleForMs`、`lastInteractionKind`、`interactionCount`、`sessionForMs`、`localHour`、`stateForMs`、`backgroundForMs`、活动经过时间、最近任务结果和经过时间。摘要不含任务路径/正文，不持久化。

- [x] RED：五/二十/四十分钟未陪伴、当前休息经过时间和真实任务终态准确；模型回应和工具进度不重置互动。

```ts
expect(context.situation.idleForMs).toBe(2_400_000);
expect(context.situation.lastTask?.outcome).toBe('success');
expect(JSON.stringify(context.situation)).not.toContain(privateToolText);
```

- [x] GREEN：复用真实用户交互事件和 Main 逻辑时钟；任务事实与推測心情分离，模型仅解释摘要。自主保持当前长期状态不算无效果失败。
- [x] 保留五分钟首次、十五分钟后续及每小时四次额度；关闭自主不妨碍明确动作和任务反馈，休眠不补跑请求。
- [x] 定向测试 autonomy/proactivity-runtime 及真实上下文消费。

## Task 6: 集成、审查和实际角色验证

**文件：** Main 启动接入 Task 1 的非激活升级入口；`CONTEXT.md`、相关规格索引及 `docs/operations/2026-09-12-character-behavior-continuity-acceptance.md`。按必要范围修正真实 E2E 夹具和断言。

- [x] 使用真实新默认九状态验证发布资源、精确动作ID播放及首帧反馈；实际 Electron 休息连续 31 秒不插 idle、开心结束恢复休息，真实文件任务首帧与终态反应通过。
- [x] 复用真实 DeepSeek/Qwen Provider 进行有限描述匹配/行为与任务验证；明确休息、开心及任务反馈已有实际结果，40 分钟未互动后的自主长期选择仍有语义限制，详见验收记录。
- [x] 完成受影响类型检查和定向测试后执行 desktop/behavior/characters 的去重门禁；类型、构建及最终安全集成88项通过。38 项旧桌面单元失败保留；完整 Electron E2E 首轮63通过／5失败／14未执行，本次发现的失败均有后续定向转绿证据，含最后8项、核心3项与B7快速状态。没有重跑全量，B7长时及人工观感未覆盖，门禁整体尚未通过。
- [x] 规格与代码审查分开检查；已修复默认恢复、背景计时、明确目标预算、并行取消与首次加载的具体发现，并完成定向复审。
- [x] 用户确认退出后备份本机旧默认和索引，安装并启用新默认；隔离验证结束后正常重启开发版并确认进程响应。21 个安装文件复核及两个原创作角色全文件散列通过。
- [x] 更新领域词汇及验收，执行正常仓库配置下 `git diff --check`；仅保留本地改动，没有 Git 提交或发布。人工观感和未通过门禁继续按验收记录标注。
