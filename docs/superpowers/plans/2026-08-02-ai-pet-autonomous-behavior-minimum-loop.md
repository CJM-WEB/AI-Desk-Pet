# AI 桌宠自主行为最小闭环实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development` 按任务逐项实施；每个任务先使用 `superpowers:test-driven-development` 写失败测试，阶段完成前使用 `superpowers:verification-before-completion` 复核。不得并行修改共享核心文件。

**目标：** 在现有角色包 V2 和桌面角色播放器上完成“可信本地事件 → 状态推断 → Agent 高层语义 → 动作过滤与排序 → 单主动作调度 → 播放反馈”的最小纵向闭环，首批覆盖待机、倾听、思考、移动、成功和错误，同时保留模型不可用时的本地降级能力。

**架构：** `@myself/character-runtime` 提供与平台无关的行为契约、状态推断、V2 动作决策和调度归约器；`@myself/agent-core` 只转发经过严格校验的可选高层行为意图；Electron Main 的 `CharacterBehaviorService` 是行为状态和播放令牌的唯一权威，并复用现有 `CharacterMotionService` 执行真实窗口移动；Renderer 只播放 Main 已批准的动作并报告生命周期反馈。角色包、Agent 和 Renderer 均不能直接移动窗口、指定素材路径或绕过调度器。

**技术栈：** TypeScript 5.9、Zod 3、Electron 43、React 19、PixiJS 8、Vitest 3、Playwright 1.61、pnpm workspace。

**设计依据：** [AI 桌宠参考架构演进设计](../specs/2026-08-01-ai-pet-reference-architecture-evolution-design.md)

---

## 实施边界

### 本计划包含

- 可信本地行为信号的标准化与顺序保证。
- V2 主状态、修饰状态、进入条件、退出条件、共存和禁止规则。
- Agent 可选结构化意图：状态意图、动作语义、紧急度和简短解释。
- V2 动作的状态约束、方向、表现可用性、冷却、重复抑制、语义和偏好排序。
- 同一时间一个身体主动作、中断规则、失败/中断回退和播放反馈。
- 待机、倾听、思考、移动、成功和错误的 Main 到 Renderer 纵向接线。
- V1 运行投影和旧动作选择器作为兼容降级，不删除旧代码。

### 本计划不包含

- 文件实体动画、回收站删除、动画提交关键帧和目录藏身。
- 自由聊天重构、长期记忆、主动聊天和主动性等级 UI。
- 语音、口型、Live2D、VRM、Windows UIA 或视觉自动化。
- MCP 恢复、MCP 设置修改或 MCP 数据迁移。
- 网站、WebsiteExtension 分支或任何网站资源。
- 角色包执行脚本、任意系统命令或新增系统权限。

### 固定安全规则

- Agent 意图只能表达状态、标准动作语义、紧急度和简短解释。
- Agent 意图不得包含动作 ID、素材 ID、路径、坐标、命令、工具名或权限。
- 本地任务、用户直接交互和系统安全状态的优先级高于 Agent 意图。
- Agent 意图非法、过期、不可满足或模型不可用时，继续使用本地状态和 V1 兼容回退。
- Renderer 不能主动请求任意动作；只能确认 Main 发放的单次播放令牌。
- 行为反馈第一版只保存在内存中，不永久修改角色偏好或角色包。
- 所有决策使用注入时钟和随机源，测试中必须可复现。
- 本计划编写阶段不执行任何 Git 操作；实施阶段若需要 Git 写操作，必须以用户当时授权为准。

---

## 目标数据流

```text
TaskEvent / 用户交互 / 运动状态 / 空闲到期
                    │
                    ▼
          CharacterBehaviorService（Main）
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
本地可信信号              AgentBehaviorIntent（可选）
        └───────────┬───────────┘
                    ▼
       inferCharacterBehaviorState
                    ▼
       selectCharacterBehaviorAction
                    ▼
       reduceCharacterActionSchedule
                    ▼
       behavior-action + playbackToken
                    ▼
          CharacterPlayer（Renderer）
                    ▼
 started / completed / interrupted / failed
                    ▼
          CharacterBehaviorService
```

---

### Task 1：建立自主行为输入、意图、状态和反馈契约

**文件：**

- 新建：`packages/character-runtime/src/behavior-contracts.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/behavior-contracts.test.ts`

**产出接口：**

```ts
export type CharacterBehaviorSignal =
  | { type: 'idle-due'; occurredAtMs: number }
  | { type: 'user-interaction'; occurredAtMs: number }
  | { type: 'conversation-start'; occurredAtMs: number }
  | { type: 'listening'; active: boolean; occurredAtMs: number }
  | { type: 'thinking'; active: boolean; occurredAtMs: number }
  | { type: 'task'; phase: 'start' | 'success' | 'failure'; occurredAtMs: number }
  | { type: 'movement'; active: boolean; occurredAtMs: number };

export type CharacterAgentBehaviorIntent = {
  stateIntent: { stateId: string } | { semantic: CharacterStandardSemantic } | null;
  actionSemantic: CharacterStandardSemantic | null;
  urgency: number;
  explanation: string;
};

export type CharacterBehaviorStateSnapshot = {
  revision: number;
  primaryStateId: string;
  modifierStateIds: string[];
  activeSignals: TrustedBehaviorSignal[];
  desiredActionSemantic: CharacterStandardSemantic | null;
};

export type CharacterPlaybackFeedback = {
  playbackToken: string;
  actionId: string;
  status: 'started' | 'completed' | 'interrupted' | 'failed';
  occurredAtMs: number;
};
```

`CharacterStandardSemantic` 必须直接从现有 `STANDARD_CHARACTER_SEMANTICS` 推导，不能复制第二份枚举。所有外部输入使用严格 Zod Schema；时间为非负有限数，紧急度为 0 至 100，解释去除首尾空白后长度为 1 至 240。

- [ ] **步骤 1：写严格解析失败测试**

覆盖：合法本地信号、合法 Agent 意图、合法播放反馈、未知字段、未知语义、非法状态 ID、超长解释、`NaN`/`Infinity` 时间和越界紧急度。

- [ ] **步骤 2：运行测试并确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-contracts.test.ts
```

预期：因 `behavior-contracts.ts` 和导出不存在而失败；不得接受测试夹具或导入路径错误以外的伪红灯。

- [ ] **步骤 3：实现最小严格契约**

复用 `TRUSTED_BEHAVIOR_SIGNALS`、安全标识符规则和标准语义。若安全标识符当前未导出，只在 `character-v2-schema.ts` 导出对应 Schema，不复制正则。

- [ ] **步骤 4：运行聚焦测试和类型检查**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-contracts.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
```

预期：全部通过。

---

### Task 2：实现 V2 状态推断与主状态/修饰状态仲裁

**文件：**

- 新建：`packages/character-runtime/src/behavior-state-inference.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/behavior-state-inference.test.ts`

**产出接口：**

```ts
export type CharacterBehaviorInferenceInput = {
  manifest: CharacterManifestV2;
  previous: CharacterBehaviorStateSnapshot;
  signal: CharacterBehaviorSignal;
  agentIntent?: CharacterAgentBehaviorIntent;
};

export function createInitialBehaviorState(
  manifest: CharacterManifestV2
): CharacterBehaviorStateSnapshot;

export function inferCharacterBehaviorState(
  input: CharacterBehaviorInferenceInput
): CharacterBehaviorStateSnapshot;
```

**确定性规则：**

1. `createInitialBehaviorState` 使用 `defaultStateId`，且默认状态必须是主状态；修饰状态为空。
2. 本地信号映射标准语义：`idle-due → idle`、`conversation-start/listening → listen`、`thinking → think`、`movement(active) → move`、`task(success) → celebrate`、`task(failure) → fail`。
3. 多个状态匹配同一语义时，先选满足进入条件者，再按 `intensity` 降序，最后按清单顺序稳定决定。
4. Agent 指定状态 ID 时，该状态必须存在且 `agentInferable=true`；指定语义时也只能从 `agentInferable=true` 的状态中选择。
5. 本地明确事件覆盖冲突的 Agent 意图；Agent 不能覆盖任务失败、任务成功、思考中或移动中的主状态。
6. 同时只能有一个 `primary`；`modifier` 必须同时满足进入条件、共存白名单和禁止列表。
7. 退出条件满足时移除修饰状态；主状态退出后重新执行本次信号推断，最终回到默认状态。
8. 条件中的 `signal`、`semantic` 和 `state` 分别读取本次活动信号、候选语义和推断后的状态集合；`all`/`any` 不允许短路造成顺序差异。
9. 无匹配状态或意图非法时使用默认状态，不抛出可传播到 UI 的异常。

- [ ] **步骤 1：写首批语义状态失败测试**

覆盖待机、倾听、思考、移动、成功和错误；使用状态 ID 与语义不同的夹具，证明运行时不是依赖写死状态名称。

- [ ] **步骤 2：写自定义状态、条件和共存失败测试**

覆盖：`all`/`any`、主状态唯一、修饰状态共存、禁止关系、退出条件、相同强度清单顺序、不可由 Agent 推断状态，以及非法 Agent 状态安全回退。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-state-inference.test.ts
```

- [ ] **步骤 4：实现纯函数推断器**

拆分为职责单一的内部函数：`signalSemantic()`、`conditionMatches()`、`eligibleStates()`、`selectPrimaryState()` 和 `selectModifierStates()`。禁止读取时间、随机数、Electron 或全局可变状态。

- [ ] **步骤 5：运行运行时回归**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-state-inference.test.ts character-v2-schema.test.ts state-arbiter.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
```

预期：新旧状态测试全部通过；旧 `state-arbiter.ts` 保留供 V1 兼容路径使用。

---

### Task 3：实现 V2 动作硬过滤、语义排序和可播放回退

**文件：**

- 新建：`packages/character-runtime/src/behavior-action-selector.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/behavior-action-selector.test.ts`

**产出接口：**

```ts
export type CharacterActionHistoryEntry = {
  actionId: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  outcome: 'completed' | 'interrupted' | 'failed' | null;
};

export type CharacterBehaviorActionSelectionInput = {
  manifest: CharacterManifestV2;
  skinId: string;
  state: CharacterBehaviorStateSnapshot;
  direction: 'left' | 'right';
  nowMs: number;
  history: readonly CharacterActionHistoryEntry[];
  random: () => number;
};

export type CharacterBehaviorActionSelection = {
  actionId: string;
  stateId: string;
  presentation: CharacterActionPresentationV2;
  reason: 'semantic' | 'state-preference' | 'default-fallback';
};

export function selectCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput
): CharacterBehaviorActionSelection;
```

**筛选与排序顺序必须固定：**

1. 动作必须被当前主状态或活动修饰状态的 `actionIds` 引用。
2. 检查 `allowedPrimaryStateIds`、`forbiddenPrimaryStateIds`、`requiredModifierStateIds` 和 `forbiddenModifierStateIds`。
3. 检查方向；`any` 接受左右两侧。
4. 使用现有 `resolveCharacterPresentation()` 确认可播放表现，不能直接访问资源路径。
5. 检查 `cooldownMs` 和 `repeatSuppressionMs`；冷却是硬约束，重复抑制在没有其他候选时才允许降级恢复。
6. 优先匹配 `desiredActionSemantic`，再使用 `preference`；权重随机使用注入的 `random()`。
7. 没有候选时，从 `defaultStateId` 走同一过滤流程；仍失败则抛出稳定错误 `CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE`，由 Main 保留当前画面。

- [ ] **步骤 1：写硬约束失败测试**

覆盖四类状态过滤、方向、冷却、重复抑制和缺失表现；证明 `preference` 不能让违反硬约束的动作重新入选。

- [ ] **步骤 2：写语义、偏好和回退失败测试**

覆盖语义优先、固定随机源可复现、当前皮肤精确动作、皮肤语义回退、默认皮肤和默认状态降级。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-action-selector.test.ts
```

- [ ] **步骤 4：实现最小选择器**

复用 `character-presentation-resolver.ts`，不得复制皮肤回退算法；复用现有权重选择思想，但不要修改 V1 `action-selector.ts`。

- [ ] **步骤 5：运行选择器与表现回归**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-action-selector.test.ts character-presentation-resolver.test.ts action-selector.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
```

---

### Task 4：实现单主动作调度、中断和反馈归约器

**文件：**

- 新建：`packages/character-runtime/src/behavior-scheduler.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/behavior-scheduler.test.ts`

**产出接口：**

```ts
export type CharacterScheduledAction = {
  actionId: string;
  stateId: string;
  playbackToken: string;
  startedAtMs: number | null;
  expectedEndAtMs: number | null;
};

export type CharacterBehaviorSchedule = {
  revision: number;
  current: CharacterScheduledAction | null;
  history: CharacterActionHistoryEntry[];
};

export type CharacterScheduleCommand =
  | { type: 'schedule'; selection: CharacterBehaviorActionSelection; playbackToken: string; nowMs: number; urgency: number; systemForced: boolean }
  | { type: 'feedback'; feedback: CharacterPlaybackFeedback; nowMs: number }
  | { type: 'expire'; nowMs: number };

export type CharacterScheduleEffect =
  | { type: 'play'; action: CharacterScheduledAction }
  | { type: 'interrupt'; playbackToken: string; fallbackActionId: string | null }
  | { type: 'fallback'; actionId: string }
  | { type: 'none' };

export function reduceCharacterActionSchedule(
  schedule: CharacterBehaviorSchedule,
  command: CharacterScheduleCommand,
  actions: readonly CharacterActionDefinitionV2[]
): { schedule: CharacterBehaviorSchedule; effects: CharacterScheduleEffect[] };
```

**调度规则：**

- 同一时间只有一个身体主动作。
- 普通新动作不能打断 `interrupt='resistant'` 的当前动作。
- 用户直接交互、任务成功、任务失败和应用关闭属于 `systemForced`，可以打断，但必须产生 `interrupt` 效果。
- `until-interrupted` 不设置自然结束时间；`never` 和 `presentation` 使用动作 `durationMs`，缺失时由 Main 根据表现帧时长计算后传入调度命令。
- `started` 后才写入开始时间；`completed`、`interrupted` 和 `failed` 只接受当前令牌。
- 失败使用 `failureFallbackActionId`，中断使用 `interruptedFallbackActionId`；回退 ID 已由 V2 Schema 保证无环。
- 重放、伪造、过期或动作不匹配的反馈返回稳定错误 `CHARACTER_PLAYBACK_UNAUTHORIZED`，不得改变调度状态。
- 历史最多保留 64 条，且只保存在内存。

- [ ] **步骤 1：写单动作和中断失败测试**

覆盖普通动作互斥、抗中断动作、系统强制中断、正确回退和无回退。

- [ ] **步骤 2：写反馈鉴权和过期失败测试**

覆盖开始、完成、失败、重复确认、错误动作 ID、旧令牌、自然超时和历史上限。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-scheduler.test.ts
```

- [ ] **步骤 4：实现纯归约器**

归约器不自行生成 UUID、不读取系统时钟、不发送 IPC；所有外部值必须由调用方注入。

- [ ] **步骤 5：运行运行时完整测试**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/character-runtime typecheck
```

---

### Task 5：组合事件驱动行为引擎

**文件：**

- 新建：`packages/character-runtime/src/character-behavior-engine.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/character-behavior-engine.test.ts`

**产出接口：**

```ts
export class CharacterBehaviorEngine {
  constructor(options: {
    manifest: CharacterManifestV2;
    skinId: string;
    now: () => number;
    random: () => number;
    createPlaybackToken: () => string;
  });

  dispatch(input: {
    signal: CharacterBehaviorSignal;
    agentIntent?: CharacterAgentBehaviorIntent;
    direction: 'left' | 'right';
  }): CharacterBehaviorDecision;

  applyFeedback(feedback: CharacterPlaybackFeedback): CharacterBehaviorDecision;
  replaceCharacter(manifest: CharacterManifestV2, skinId: string): CharacterBehaviorDecision;
  snapshot(): CharacterBehaviorEngineSnapshot;
}
```

`CharacterBehaviorDecision` 只包含状态快照、调度效果和可公开诊断码，不包含素材字节或路径。

- [ ] **步骤 1：写六类语义纵向失败测试**

逐项验证待机、倾听、思考、移动、成功和错误从信号进入状态、选择动作并产生单个播放效果。

- [ ] **步骤 2：写离线和角色切换失败测试**

覆盖无 Agent 意图、非法 Agent 意图、无动作保持当前画面、切换角色中断旧令牌、固定随机种子重现相同序列。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- character-behavior-engine.test.ts
```

- [ ] **步骤 4：组合已有纯函数**

引擎只负责持有快照和依次调用 Task 2 至 Task 4，不在类内复制条件、筛选或中断规则。

- [ ] **步骤 5：运行完整运行时验证**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/character-runtime typecheck
```

---

### Task 6：让 Agent Core 转发可选的结构化行为意图

**文件：**

- 修改：`packages/agent-core/package.json`
- 修改：`packages/agent-core/src/types.ts`
- 修改：`packages/agent-core/src/agent-loop.ts`
- 修改：`packages/agent-core/tests/agent-loop.test.ts`
- 修改：`apps/desktop/src/main/providers/openai-provider.ts`
- 修改：`apps/desktop/src/main/providers/anthropic-provider.ts`
- 修改：`apps/desktop/src/main/providers/gemini-provider.ts`
- 修改测试：`apps/desktop/tests/openai-provider.test.ts`
- 修改测试：`apps/desktop/tests/provider-contract.test.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 修改测试：`apps/desktop/tests/agent-service.test.ts`

**接口变化：**

```ts
export type ModelResponse =
  | {
      type: 'text';
      text: string;
      emotion?: CharacterEmotionLabel;
      behaviorIntent?: CharacterAgentBehaviorIntent;
    }
  | { type: 'tool_request'; request: unknown };

export type AgentEvent =
  | ExistingAgentEvent
  | { type: 'behavior_intent'; intent: CharacterAgentBehaviorIntent };
```

`AgentServiceOptions` 增加可选内部回调：

```ts
emitBehaviorIntent?(intent: CharacterAgentBehaviorIntent): void;
```

**提供商兼容策略：**

- 三个 Provider 都只解析各自响应中明确存在的可选结构化行为字段，不从普通回复文本、工具参数或错误文案猜测意图。
- 字段不存在时保持当前响应行为。
- 字段存在但 Schema 非法时丢弃该字段并保留正常文本回复；不得让角色表现元数据导致聊天失败。
- OpenAI-compatible 继续复用当前 `message.metadata` 边界；Anthropic 和 Gemini 仅在其标准响应扩展元数据位置存在时读取。若协议没有该位置，则明确返回无意图，不发起第二次模型请求。
- 不增加伪工具，不把行为动作注册为文件工具，不增加额外模型调用。

- [ ] **步骤 1：写 Agent Loop 失败测试**

覆盖合法意图在消息之前发出、无意图不发事件、非法意图不影响文本与成功阶段。

- [ ] **步骤 2：写三个 Provider 的契约测试**

使用同一测试矩阵证明：合法元数据被规范化、缺失元数据保持兼容、非法元数据被忽略、工具请求不能夹带行为意图。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/agent-core test -- agent-loop.test.ts
pnpm.cmd --filter @myself/desktop test -- openai-provider.test.ts provider-contract.test.ts agent-service.test.ts
```

- [ ] **步骤 4：实现最小可选转发**

`AgentLoop` 使用角色运行时导出的 Schema 进行二次校验；`AgentService.forward()` 只调用内部回调，不把解释文本广播到 Renderer 的 `TaskEvent`。

- [ ] **步骤 5：运行 Agent 与 Provider 回归**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/desktop test -- agent-service.test.ts openai-provider.test.ts provider-contract.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 7：在 Main 建立行为权威并替换旧待机编排

**文件：**

- 修改：`apps/desktop/src/main/characters/character-store.ts`
- 修改测试：`apps/desktop/tests/character-store.test.ts`
- 修改：`apps/desktop/src/main/characters/character-actions.ts`
- 修改测试：`apps/desktop/tests/character-ipc.test.ts`
- 新建：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 新建测试：`apps/desktop/tests/character-behavior-service.test.ts`
- 修改：`apps/desktop/src/main/characters/character-motion-service.ts`
- 修改测试：`apps/desktop/tests/character-motion-controller.test.ts`
- 修改：`apps/desktop/src/main/index.ts`

**新增内部接口：**

```ts
// CharacterStore：只供 Main 内部行为引擎读取，不经 Preload 暴露。
getActiveManifestV2(): Promise<CharacterManifestV2>;

export class CharacterBehaviorService {
  initialize(): Promise<void>;
  handleTaskEvent(event: TaskEvent): void;
  handleAgentIntent(intent: CharacterAgentBehaviorIntent): void;
  handleMovement(snapshot: CharacterMotionSnapshot): void;
  handleUserInteraction(): void;
  handleIdleDue(): void;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  handleActiveCharacterChanged(): Promise<void>;
  subscribe(listener: (event: CharacterBehaviorPlaybackEvent) => void): () => void;
  close(): void;
}
```

**Main 映射规则：**

- `TaskEvent.phase=listening/thinking/success/error` 分别形成对应本地信号。
- `idle/cancelled` 结束任务状态；`pending_action/acting` 阻止随机待机，但不产生文件动作。
- 运动快照只在 `moving` 边沿变化时产生 `movement(active)`，不得每 50ms 重复决策。
- 桌宠点击/拖拽开始产生 `user-interaction`，但 Renderer 不能传入语义或动作 ID。
- 空闲计时继续由 Main 定时器触发，但定时器只调用 `handleIdleDue()`；删除 `index.ts` 中直接调用 V1 `pollIdle()` 和直接发送 `idle-action` 的编排。
- 行为引擎选中 `move` 语义且调度通过时，才调用现有 `CharacterMotionService.requestIntent('wander')`；行为引擎不直接写窗口坐标。
- 活动角色变化时读取 V2 清单、撤销旧令牌、重建引擎并发出默认状态动作。
- V2 清单读取失败时不破坏当前播放器；记录脱敏错误并使用现有 V1 待机路径作为兼容降级。

- [ ] **步骤 1：为活动 V2 清单读取写失败测试**

证明 `getActiveManifestV2()` 返回发布清单原文，而现有 `getActive()` 继续返回 V1 运行投影；两者读取同一活动角色且不新增 Renderer API。

- [ ] **步骤 2：为 Main 行为服务写纵向失败测试**

覆盖 TaskEvent、Agent 意图、移动边沿、用户交互、空闲到期、角色切换、服务关闭和本地降级。

- [ ] **步骤 3：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts character-behavior-service.test.ts character-motion-controller.test.ts
```

- [ ] **步骤 4：实现行为服务并接入现有服务**

行为服务持有 `CharacterBehaviorEngine`，注入 `now`、`random` 和令牌生成器；测试不得依赖真实计时器。`CharacterMotionService` 只新增只读方向/移动快照消费所需的最小接口，不迁移其窗口所有权逻辑。

- [ ] **步骤 5：替换 `index.ts` 旧待机编排**

保持 `startCharacterMotionTimers()` 的 50ms 运动 tick；将 500ms poll 回调改为检查 Main 空闲期限并触发行为服务。`AgentService.emit` 仍广播原有 TaskEvent，同时先交给行为服务；`emitBehaviorIntent` 只交给行为服务。

- [ ] **步骤 6：运行 Main 相关回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-behavior-service.test.ts character-motion-controller.test.ts character-ipc.test.ts agent-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 8：扩展窄化 IPC 并让 Renderer 回报完整播放生命周期

**文件：**

- 修改：`apps/desktop/src/shared/character-motion-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改测试：`apps/desktop/tests/character-motion-ipc.test.ts`
- 修改测试：`apps/desktop/tests/preload-api.test.ts`
- 修改：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- 修改：`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- 修改测试：`apps/desktop/tests/pixi-character-player.test.ts`
- 修改测试：`apps/desktop/tests/character-player.test.tsx`

**复用通道的扩展事件：**

```ts
type CharacterMotionEvent =
  | ExistingSnapshotEvent
  | ExistingIdleActionEvent // 只为旧调用兼容，Main 新路径不再发出
  | {
      type: 'behavior-action';
      revision: number;
      stateId: string;
      actionId: string;
      playbackToken: string;
    };

type CharacterActionFeedbackInput = {
  playbackToken: string;
  actionId: string;
  status: 'started' | 'completed' | 'interrupted' | 'failed';
};
```

`reportCharacterActionPlayed()` 保留为旧兼容方法；新增 `reportCharacterActionFeedback()` 使用同一固定 IPC 通道族。输入不得包含状态、素材、路径、坐标或任意错误文本。

**Renderer 规则：**

- 收到 `behavior-action` 后，只能从当前活动 V1 运行投影中查找同 ID 可播放动作；找不到则报告 `failed`。
- 调用 `player.play()` 成功后报告 `started`。
- 非循环动画自然结束报告 `completed`；被新令牌替换、角色切换或卸载时报告 `interrupted`。
- Pixi 资源/播放异常报告 `failed`，但不得把异常堆栈经 IPC 发回 Main。
- 每个令牌的终态只报告一次；旧 revision 或重复事件必须忽略。
- `stateId` 只用于可观察状态和动作查找，不允许 Renderer 据此发起新行为。

- [ ] **步骤 1：写 IPC Schema 与白名单失败测试**

覆盖四种状态、严格字段、伪造令牌、未知字段、Preload 只映射固定参数，以及旧 `idle-action` 仍可解析。

- [ ] **步骤 2：写 Pixi 生命周期失败测试**

为播放器端口增加最小生命周期订阅，覆盖自然完成、循环不自然完成、替换中断、资源失败和销毁清理。

- [ ] **步骤 3：写 CharacterPlayer 反馈失败测试**

覆盖 started/completed/interrupted/failed、重复终态、旧 revision、未知动作和角色切换。

- [ ] **步骤 4：运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-motion-ipc.test.ts preload-api.test.ts pixi-character-player.test.ts character-player.test.tsx
```

- [ ] **步骤 5：实现最小 IPC 与播放器接线**

复用当前 `subscribeCharacterMotion()`，不新增任意动作请求 API；Main 注册器把反馈直接交给 `CharacterBehaviorService.applyPlaybackFeedback()`。

- [ ] **步骤 6：运行 Renderer 和安全回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-motion-ipc.test.ts preload-api.test.ts pixi-character-player.test.ts character-player.test.tsx pet-view.test.tsx
pnpm.cmd test:security
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 9：完成集成、Electron E2E、降级和验收记录

**文件：**

- 修改：`tests/integration/desktop-agent.test.ts`
- 修改：`tests/e2e/desktop.spec.ts`
- 修改：`tests/fixtures/electron-app.ts`（仅当现有探针不足）
- 新建：`docs/operations/autonomous-behavior-minimum-loop-acceptance.md`
- 修改：`package.json`

**验收脚本：**

```json
{
  "verify:behavior": "pnpm --filter @myself/character-runtime test && pnpm --filter @myself/agent-core test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop"
}
```

- [ ] **步骤 1：写服务组合集成失败测试**

使用 V2 测试角色和固定随机源，按以下顺序验证：

1. 应用空闲产生待机动作。
2. 用户开始对话，中断普通待机并进入倾听。
3. Agent 进入思考并选择思考语义动作。
4. Agent 可选意图选择一个 `agentInferable` 自定义状态；非法意图回退本地思考状态。
5. 移动开始产生移动动作且窗口位移仍由运动服务完成。
6. 任务成功产生庆祝动作；任务失败产生失败动作。
7. Renderer 反馈完成后进入允许的下一动作。
8. 模型不返回行为意图时，六类本地状态仍完整工作。

- [ ] **步骤 2：增加 Electron E2E 可观察探针**

优先复用已有角色、运动和交互探针。仅在无法观察行为状态时增加只读结构：

```ts
type CharacterBehaviorProbe = {
  revision: number;
  primaryStateId: string;
  modifierStateIds: string[];
  actionId: string | null;
  playbackStatus: 'scheduled' | 'started' | 'completed' | 'interrupted' | 'failed' | null;
};
```

探针不得返回 Agent 解释、聊天内容、素材 ID、文件路径、窗口句柄或播放令牌。

- [ ] **步骤 3：写 Electron E2E 失败场景**

覆盖：待机动作、打开聊天后的倾听/思考、成功/错误、移动、普通待机被用户交互中断、模型无意图降级、角色切换后旧动作不再生效。所有等待使用 `expect.poll()` 或可见状态条件，不使用固定休眠。

- [ ] **步骤 4：运行聚焦集成和 E2E**

```powershell
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "自主行为最小闭环"
```

预期：全部通过，且无残留 Electron/Node 测试进程。

- [ ] **步骤 5：编写中文人工验收记录**

`docs/operations/autonomous-behavior-minimum-loop-acceptance.md` 至少记录：

- 测试日期、Windows 版本、应用版本和使用角色。
- 六类首批语义的实际动作与回退结果。
- 用户交互中断、抗中断动作和失败回退。
- Agent 合法意图、非法意图和无意图三种情况。
- 角色切换、应用重启和模型不可用降级。
- 连续运行五分钟的动作重复、CPU、内存和错误日志观察。
- 明确确认未开放文件实体、长期记忆、语音、MCP 和桌面自动化。

- [ ] **步骤 6：运行完整验证门禁**

```powershell
pnpm.cmd verify:behavior
pnpm.cmd verify:characters
pnpm.cmd verify:desktop
```

预期：

- `character-runtime`、`agent-core`、Desktop 单元测试全部通过。
- 类型检查、安全、集成和 Electron E2E 全部通过。
- 旧角色 V1 投影、角色工作室、像素命中、拖拽和 MCP 禁用无回归。
- 无固定等待、未处理 Promise、敏感信息输出或新增高权限 IPC。

- [ ] **步骤 7：使用完成前验证和代码审查技能**

依次使用：

1. `superpowers:verification-before-completion`
2. `superpowers:requesting-code-review`

审查重点：行为权威是否只在 Main、Agent 是否只能输出高层意图、硬约束是否先于偏好、播放令牌是否防重放、模型不可用是否降级、是否误入阶段 3 及后续范围。

---

## 子智能体执行顺序

实施时使用 `superpowers:subagent-driven-development`，按以下依赖顺序派发；共享文件任务不得并行：

1. Task 1：行为契约。
2. Task 2：状态推断。
3. Task 3：动作选择。
4. Task 4：调度归约器。
5. Task 5：行为引擎组合。
6. Task 6：Agent 意图转发。
7. Task 7：Main 行为服务。
8. Task 8：IPC 与 Renderer 反馈。
9. Task 9：集成、E2E 和验收。

每个 Task 使用新的实现子智能体；实现完成后由独立审查子智能体检查规格符合性，再由另一独立审查子智能体检查代码质量。前一 Task 的测试和审查未通过时，不开始依赖它的下一 Task。

### 超时与换方案规则

- 单个问题先定位根因，不因第一次失败直接跳过。
- 同一定位路径连续三次没有新增证据时，立即换为更小夹具、纯函数测试或替代观察点。
- 单点累计 30 分钟仍未解决视为超时：保留失败测试和诊断证据，停止扩大修改范围，改用兼容降级或拆分为独立后续任务。
- 安全边界、数据完整性、令牌鉴权和行为权威测试不得放宽。
- 仅允许放宽非关键表现断言，例如动画精确帧时序；放宽后仍需验证状态、动作 ID 和反馈终态。
- 长时间构建或 E2E 可以后台运行，但每 60 秒检查一次输出和进程状态。

---

## 完成定义

只有同时满足以下条件，才可宣称“自主行为最小闭环”完成：

- 六类首批语义全部通过真实 Main → Renderer 播放闭环。
- V2 状态条件、主状态/修饰状态、共存和禁止规则已进入运行时。
- V2 动作硬约束、冷却、中断、重复抑制和回退已进入运行时。
- Agent 合法意图可参与决策，非法或缺失意图安全降级。
- 同一时间只有一个身体主动作，播放反馈经过单次令牌鉴权。
- 角色切换、模型不可用和表现缺失不会破坏基础桌宠。
- `verify:behavior`、`verify:characters` 和 `verify:desktop` 使用新鲜输出全部通过。
- 人工验收记录完成，且没有实施阶段 3 或更后面的功能。
