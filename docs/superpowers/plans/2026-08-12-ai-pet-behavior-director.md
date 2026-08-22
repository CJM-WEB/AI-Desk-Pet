# 行为导演与自主生命感实施计划

> **面向执行智能体：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务实施；每个功能任务同时使用 `test-driven-development`。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让普通聊天在同一次 Provider 调用中返回合法正文与可选无权限行为计划，并由 Electron Main 复用现有行为引擎、运动服务和 Renderer 反馈完成显式动作、受限移动、持久停止锁与三档主动性。

**架构：** `ModelRequest.responseContract` 只描述无权限响应格式，三类 Provider 将同一个聊天结果归一化为正文与 `structured_output`；它既不是 `ToolDefinition`，也不能进入 `ToolRuntime`。`CharacterBehaviorDirector` 只做来源优先级、停止锁、待提交计划和主动性协调，动作选择、播放令牌、运动 tick 与 Renderer 生命周期继续分别由现有 `CharacterBehaviorService`、`CharacterBehaviorEngine`、`CharacterMotionService` 和 `CharacterPlayer` 掌管，不建立第二套状态机。

**技术栈：** Electron 43、React 19、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、pnpm 11；不新增运行时依赖。

## 全局约束

- 本计划只实施仍有效的 [行为章节规格](../specs/2026-08-12-ai-pet-capability-behavior-geometry-design.md#7-角色行为导演)；文件与 PowerShell 继续遵守已经替代旧章节的轻量 Agent 规格。
- 普通聊天只调用当前聊天 Provider 一次；该调用同时返回 `text` 与可选 `behaviorPlan`，不得追加逐消息行为模型调用。
- DeepSeek `deepseek-v4-flash` 与其他 OpenAI-compatible 聊天请求使用官方 JSON Output：请求体精确包含 `response_format: { type: 'json_object' }`，系统提示必须出现 `json` 并给出精确对象示例。
- JSON 中行为字段缺失或非法时只丢弃行为；完整 `text` 必须保留。截断 JSON 只可提取已经完整闭合的 `text` 字符串；非 JSON 纯文本只走有界兼容分支；不得把 JSON 包装展示给用户。
- `ModelRequest.responseContract` 不能进入 `tools`、`ToolDefinition`、`ToolRuntime.prepare()` 或任何文件、PowerShell、MCP 权限链。
- 本地明确 stop、resume、relative、region、wander 在创建 Provider 请求前执行；模型建议只在本轮聊天结果返回后提交。
- 只有本地 Gate 生成的明确 stop/resume 可以写入 `movementStopped`；Provider 与反思返回的 stop/resume 只作为无效建议丢弃，绝不改变持久锁、设置或运动。
- 普通聊天正式路径不读取 `message.metadata.behaviorIntent`。能力任务现有 `CharacterAgentBehaviorIntent`、`ModelResponse.behaviorIntent`、`AgentEvent.behavior_intent` 与 `AgentService.emitBehaviorIntent` 本阶段保留，只允许在 `responseContract` 缺席的能力任务请求中继续兼容；不做无关迁移或删除。
- Director 只包装现有服务。Renderer 继续只消费 `behavior-action` 并回报 started/completed/interrupted/failed；Provider 与 Renderer 都不能提交 actionId 或绝对坐标。
- 只有 move 语义动作获得现有引擎与播放调度授权后，Director 才能请求封闭的 `relative`、`region` 或 `wander` 运动意图。
- 本阶段运动边界仅使用 `BrowserWindow.getBounds()` 的当前窗口矩形与 Electron `Display.workArea` 做保守钳制；不得声称已解决视觉包围盒、碰撞范围或可见角色贴边。后续视觉几何计划将替换该临时边界。
- `movementStopped` 跨重启；新安装默认 `autonomous`；设置必须先成功原子落盘，再用一个完整快照通知 Director。新增 `SettingsStore` 写入口必须加入现有 TypeScript AST 写路径矩阵，并证明 `mcpServers` 逻辑值逐字段不变。
- passive 只执行明确 Prompt；assistive 每次随机 20–60 秒只做原地动作；autonomous 每次随机 20–60 秒做原地动作或短距移动，并在 2–5 分钟持续空闲后做一次无工具反思。
- 聊天、拖拽、移动、文件/PowerShell 执行、确认等待和停止锁会暂停主动计时；恢复不补跑；同一动作不连续；失败退避；close 取消计时器并使在途反思失效。
- “停下并删除……”必须先持久停止，再把去除行为前缀后的剩余请求送入文件任务；“别移动这个文件”不停止桌宠；讨论、引用、代码块与否定性文件表达不执行角色行为。
- 明确或聊天请求的动作缺失、歧义或不可播放时发布 `CHARACTER_ACTION_UNAVAILABLE` 稳定提示并保持当前画面，不用 idle 冒充完成。停止锁不阻止 listening/thinking/speaking/success/error 等聊天关联原地动作。
- 行为聊天与反思的 `tools` 永远为空；不得持有文件、PowerShell 或 MCP 端口。普通日志不得记录用户/模型正文、文件正文、绝对路径或屏幕绝对坐标。
- 任务 1–3 不启动 GUI；任务 4、5、6 各在 `pnpm.cmd --filter @myself/desktop dev` 中完成一次可见窗口里程碑验收；任务 7 依次运行 `verify:desktop` 与 `verify:behavior` 两个完整门禁。任务 4–6 的可见窗口操作、观察和记录均由执行智能体通过窗口控制完成，不要求用户代测；Windows 跨显示器观感与长期动作自然度仍标记为“待用户人工确认”。
- 所有新增文档与结构性注释使用中文。用户已明确授权本阶段计划范围内自主执行 Git 提交；不得扩大到本计划外的 Git 写操作。

## 当前基线与复用边界

- `ConversationChatAdapter` 当前只返回 `{ text, emotion? }`，普通聊天不生成行为计划。
- `OpenAICompatibleProvider` 当前仅在无声明契约的 `message.metadata.behaviorIntent` 中解析旧能力任务意图；Anthropic 与 Gemini 没有该扩展槽。
- `CharacterBehaviorService` 已拥有 V2 引擎、播放令牌、Renderer 事件和 move 语义到 `wander` 的旧最小闭环；本计划扩展其窄接口，不复制其状态。
- `CharacterMotionService.tick()` 是唯一 `window.setPosition()` 写入点；新意图只计算目标并继续复用该 tick。
- `SettingsStore` 已用串行队列与同目录临时文件原子重写 `settings.json`；`settings-store.test.ts` 已用 TypeScript AST 枚举全部写入口并验证每个普通入口保留 MCP 配置。

## 固定参考与许可证边界

- [`coglabss/deskcat@b5718472223bdb23d01abf92dae7bbd8d7de39b1`](https://github.com/coglabss/deskcat/tree/b5718472223bdb23d01abf92dae7bbd8d7de39b1)：MIT 源码许可；只借鉴 `Mood → BehaviorController → Mover/AnimationPlayer` 分责和纯逻辑测试。其 LICENSE 明确排除角色素材与声音，本项目不复制源码、素材、声音或测试正文。
- [`Louis-7/deskopilot@b23e28533be4cd2f1bbd5427435d472a6a57ab2b`](https://github.com/Louis-7/deskopilot/tree/b23e28533be4cd2f1bbd5427435d472a6a57ab2b)：MIT；只借鉴事件解释、纯状态归约与渲染分层，不复制 reducer 或渲染代码。
- [`bestxiangest/clawd-buddy@2c9d95ed9cf7588e447ba2520f9b47027410220b`](https://github.com/bestxiangest/clawd-buddy/tree/2c9d95ed9cf7588e447ba2520f9b47027410220b)：MIT；只借鉴随机自主调度、阻塞/勿扰暂停和可控时钟测试，不复制动作池、素材或实现。
- 由于本计划不复制外部代码或素材，不新增第三方源码归属文件；若实施时决定复制任何片段，必须暂停并先记录源文件、固定提交、许可证与本地改动。

## Provider 官方协议依据

- DeepSeek/OpenAI-compatible：使用 [DeepSeek JSON Output 指南](https://api-docs.deepseek.com/guides/json_mode/) 与 [创建聊天完成接口](https://api-docs.deepseek.com/api/create-chat-completion)。当前适配器在 `responseContract` 存在时发送 `response_format: { type: 'json_object' }`，并在系统提示中包含小写 `json` 与精确对象示例。
- Anthropic：使用 [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。当前适配器在 `responseContract` 存在时发送 `output_config.format`，其 `type` 为 `json_schema`。
- Gemini：使用 [Gemini 结构化输出](https://ai.google.dev/gemini-api/docs/structured-output) 与 [Gemini Interactions 迁移说明](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)。当前适配器仍使用 legacy `generateContent` 请求形状，因此在 `responseContract` 存在时发送 `generationConfig.responseMimeType: 'application/json'` 与 `generationConfig.responseJsonSchema`，不迁移到 Interactions API。

---

### 任务 1（B1）：冻结无权限行为计划与响应协议

**文件：**

- 新建：`packages/character-runtime/src/character-behavior-plan.ts`
- 新建：`packages/character-runtime/tests/character-behavior-plan.test.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建：`packages/agent-core/src/response-contract.ts`
- 新建：`packages/agent-core/tests/response-contract.test.ts`
- 修改：`packages/agent-core/src/types.ts`
- 修改：`packages/agent-core/src/index.ts`
- 修改：`packages/agent-core/tests/agent-loop.test.ts`

**接口：**

- 消费：`CharacterStandardSemantic`、`CharacterEmotionLabel` 和现有 `ModelRequest`/`ModelResponse`。
- 产出：`BehaviorTarget`、`CharacterBehaviorPlan`、`PublicBehaviorCatalog`、`characterBehaviorPlanSchema`、`characterChatResponseJsonSchema`、`ModelResponseContract`、`decodeResponseContractText()`。
- 保留：`CharacterAgentBehaviorIntent` 与 `ModelResponse.behaviorIntent` 仅供现有能力任务；本任务不删除 `AgentEvent.behavior_intent`。

```ts
export type BehaviorTarget =
  | Readonly<{ kind: 'semantic'; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'state_name'; name: string }>
  | Readonly<{ kind: 'action_name'; name: string }>
  | Readonly<{ kind: 'tag'; tag: string }>;

export type MoveDirection = 'left' | 'right' | 'up' | 'down';
export type MoveDistance = 'near' | 'medium' | 'far';
export type ScreenRegion =
  | 'left' | 'right' | 'top' | 'bottom'
  | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';

export type CharacterBehaviorPlan =
  | Readonly<{ kind: 'none'; emotion?: CharacterEmotionLabel }>
  | Readonly<{ kind: 'play'; target: BehaviorTarget; emotion?: CharacterEmotionLabel }>
  | Readonly<{ kind: 'move'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'move_region'; region: ScreenRegion }>
  | Readonly<{ kind: 'stop_movement' }>
  | Readonly<{ kind: 'resume_movement' }>;

export type ModelResponseContract = Readonly<{
  type: 'json_object';
  name: 'character_chat';
  jsonSchema: Readonly<Record<string, unknown>>;
  textField: 'text';
  allowPlainTextFallback: true;
}>;
```

- [x] **步骤 1：写严格协议 RED**

  在 `character-behavior-plan.test.ts` 构造合法六类计划；逐项断言 actionId、`x/y`、工具名、绝对路径、未知枚举、额外字段、空名称和超长名称被拒绝。断言公开清单只有角色名称、语义、状态/动作名称与标签，没有 id、路径或能力引用。

- [x] **步骤 2：运行 RED 并确认失败原因**

  运行：`pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/character-behavior-plan.test.ts`

  预期：FAIL，模块 `character-behavior-plan.ts` 或导出不存在；不能是既有测试失败。

- [x] **步骤 3：写响应协议与解码 RED**

  在 `response-contract.test.ts` 固定以下四个输入：合法对象返回正文与 `structured_output`；`{"text":"保留正文","behaviorPlan":` 只恢复完整闭合的正文；`普通纯文本` 走有界兼容；`{}`、空白和无法恢复正文的 JSON 返回 `invalid`。在 `agent-loop.test.ts` 让 Provider 返回带 `structured_output` 的文本响应，断言只产生 message/phase，`ToolRuntime.prepare()` 未调用，旧 `behaviorIntent` 用例保持不变。

- [x] **步骤 4：运行 agent-core RED**

  运行：`pnpm.cmd exec vitest run --project agent-core packages/agent-core/tests/response-contract.test.ts packages/agent-core/tests/agent-loop.test.ts`

  预期：FAIL，缺少 `responseContract`、`structured_output` 或解码函数；既有能力任务行为意图用例仍应编译。

- [x] **步骤 5：写最小 GREEN**

  使用 `.strict()` Zod 联合和冻结的 JSON Schema 常量；`decodeResponseContractText(raw, contract)` 只返回以下封闭结果，不解释行为字段：

  ```ts
  export type ResponseContractDecodeResult =
    | Readonly<{ kind: 'structured'; text: string; structured_output: Record<string, unknown> }>
    | Readonly<{ kind: 'plain_text'; text: string }>
    | Readonly<{ kind: 'invalid' }>;
  ```

  在 `ModelRequest` 增加可选 `responseContract`，在文本 `ModelResponse` 增加可选 `structured_output`；不修改 `ToolDefinition`、`ToolRuntime` 或 `RunContext.tools`。

- [x] **步骤 6：运行 GREEN 与类型检查**

  依次运行以下命令，均须通过：

  ```powershell
  pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/character-behavior-plan.test.ts
  pnpm.cmd exec vitest run --project agent-core packages/agent-core/tests/response-contract.test.ts packages/agent-core/tests/agent-loop.test.ts
  pnpm.cmd --filter @myself/character-runtime typecheck
  pnpm.cmd --filter @myself/agent-core typecheck
  ```

  预期：PASS；旧能力任务 `behavior_intent` 用例仍通过。

- [x] **步骤 7：提交任务**

  ```powershell
  git add packages/character-runtime/src/character-behavior-plan.ts packages/character-runtime/tests/character-behavior-plan.test.ts packages/character-runtime/src/index.ts packages/agent-core/src/response-contract.ts packages/agent-core/tests/response-contract.test.ts packages/agent-core/src/types.ts packages/agent-core/src/index.ts packages/agent-core/tests/agent-loop.test.ts
  git commit -m "feat: 定义无权限角色行为响应协议"
  ```

---

### 任务 2（B2）：同一次聊天返回正文与可选计划

**文件：**

- 修改：`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- 修改：`apps/desktop/tests/conversation-chat-adapter.test.ts`
- 修改：`apps/desktop/src/main/providers/openai-provider.ts`
- 修改：`apps/desktop/src/main/providers/anthropic-provider.ts`
- 修改：`apps/desktop/src/main/providers/gemini-provider.ts`
- 修改：`apps/desktop/src/main/providers/provider-registry.ts`
- 修改：`apps/desktop/tests/openai-provider.test.ts`
- 修改：`apps/desktop/tests/provider-contract.test.ts`

**接口：**

- 消费：任务 1 的 `ModelResponseContract`、`characterChatResponseJsonSchema` 与 `characterBehaviorPlanSchema`。
- 产出：能解码无权限 `structured_output` 的扩展 `ConversationChatReply`；不在本任务注入角色运行时上下文。
- 适配映射：OpenAI-compatible → `response_format`；Anthropic → `output_config.format`；Gemini → `generationConfig.responseMimeType/responseJsonSchema`。

```ts
export type ConversationChatReply = Readonly<{
  text: string;
  emotion?: CharacterEmotionLabel;
  behaviorPlan?: CharacterBehaviorPlan;
}>;
```

- [x] **步骤 1：写三类 Provider RED**

  在 `provider-contract.test.ts` 为三类 Provider 发出 `responseContract` 聊天请求并断言 `tools` 为空。OpenAI-compatible 与 DeepSeek 请求体必须精确含 `response_format: { type: 'json_object' }`；Anthropic 含 `output_config.format.type === 'json_schema'`；Gemini 含 `generationConfig.responseMimeType === 'application/json'` 和 `responseJsonSchema`。再断言 contract 与非空 tools/非 none toolChoice 冲突时 fetch 前返回 `PROVIDER_RESPONSE_CONTRACT_CONFLICT`。

- [x] **步骤 2：写正文保留 RED**

  覆盖合法 JSON、非法 `behaviorPlan`、非法 emotion、行为字段后的截断、普通纯文本兼容和空对象。预期均保留完整合法 `text`，只丢行为/情绪；无法恢复正文才返回 `PROVIDER_MALFORMED_RESPONSE`，且错误不含原始正文。

- [x] **步骤 3：写 ChatAdapter 解码 RED**

  断言单次 `provider.respond()`、`responseContract` 存在、`tools: []`、`toolChoice: 'none'`；`structured_output.behaviorPlan` 合法时返回，非法时只返回正文。额外构造 `behaviorIntent`，断言普通聊天忽略它。本任务不要求 `ConversationChatInput` 携带 `behaviorContext`，也不把角色清单或运行态写入系统消息。

- [x] **步骤 4：运行 RED**

  运行：`pnpm.cmd exec vitest run --project desktop apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/openai-provider.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts`

  预期：FAIL，现有 Provider 未序列化 `responseContract`，ChatAdapter 尚未解码计划。

- [x] **步骤 5：写最小 GREEN**

  三个 Provider 在有 contract 时调用任务 1 解码器；无 contract 时保持既有自然文本/工具协议。`OpenAICompatibleProvider` 仅在 `request.responseContract === undefined` 时兼容解析 `message.metadata.behaviorIntent`，从而保留能力任务而切断普通聊天依赖。ChatAdapter 只处理已解码的正文、emotion 与 plan；任务 4 在 Director 上下文可用后再将必填 `behaviorContext` 与动态 JSON 系统消息接入。`provider-registry.ts` 把 `response_format` 与 `output_config` 加入保留参数集合，防止自定义参数覆盖宿主契约。

- [x] **步骤 6：运行 GREEN 与静态旧路径检查**

  前两条命令须通过；第三条是反向断言，只有不存在普通聊天旧 intent 依赖时才成功：

  ```powershell
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/openai-provider.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  if (rg -n "behaviorIntent" apps/desktop/src/main/conversation) { throw 'CONVERSATION_LEGACY_BEHAVIOR_INTENT_FOUND' }
  ```

  预期：测试与 typecheck PASS；反向断言无输出。Provider/Agent 能力任务文件中的旧 intent 命中不属于删除范围。

- [x] **步骤 7：提交任务**

  ```powershell
  git add apps/desktop/src/main/conversation/conversation-chat-adapter.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/src/main/providers/openai-provider.ts apps/desktop/src/main/providers/anthropic-provider.ts apps/desktop/src/main/providers/gemini-provider.ts apps/desktop/src/main/providers/provider-registry.ts apps/desktop/tests/openai-provider.test.ts apps/desktop/tests/provider-contract.test.ts
  git commit -m "feat: 同次聊天生成正文与受限行为计划"
  ```

---

### 任务 3（B3）：建立复用现有引擎的 Main Director

**文件：**

- 新建：`packages/character-runtime/src/behavior-target-resolver.ts`
- 新建：`packages/character-runtime/tests/behavior-target-resolver.test.ts`
- 修改：`packages/character-runtime/src/character-behavior-engine.ts`
- 修改：`packages/character-runtime/src/behavior-action-selector.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 修改：`packages/character-runtime/tests/character-behavior-engine.test.ts`
- 修改：`packages/character-runtime/tests/behavior-action-selector.test.ts`
- 新建：`apps/desktop/src/main/characters/character-behavior-director.ts`
- 新建：`apps/desktop/tests/character-behavior-director.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 修改：`apps/desktop/tests/character-behavior-service.test.ts`

**接口：**

- 消费：当前 `CharacterManifestV2`、`resolveCharacterPresentation()`、`CharacterBehaviorEngine`、`CharacterBehaviorService` 和任务 1 计划。
- 产出：私有 `ResolvedBehaviorTarget`、`CharacterBehaviorAuthorization`、显式指令/运动对象类型、`ConversationBehaviorContext` 和 `ConversationBehaviorPort`；任务 4 才填充真实上下文并接线。
- `CharacterBehaviorAuthorization.semantic` 必须精确使用现有 `CharacterActionDefinitionV2['semantic']` 对应的 `CharacterStandardSemantic`；状态的自定义 semantic 只用于解析状态，不能作为动作授权的 semantic。

```ts
export type ResolvedBehaviorTarget =
  | Readonly<{ kind: 'semantic'; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'state'; stateId: string }>
  | Readonly<{ kind: 'action'; actionId: string }>;

export type CharacterBehaviorAuthorization =
  | Readonly<{ kind: 'play'; actionId: string; playbackToken: string; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'none'; diagnosticCode?: 'CHARACTER_ACTION_UNAVAILABLE' }>;

export type CharacterMotionIntent =
  | Readonly<{ kind: 'wander'; scope: 'short' | 'work_area' }>
  | Readonly<{ kind: 'relative'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'region'; region: ScreenRegion }>
  | Readonly<{ kind: 'return-visible' }>;

export type ExplicitBehaviorDirective =
  | Readonly<{ kind: 'stop_movement' }>
  | Readonly<{ kind: 'resume_movement' }>
  | Readonly<{ kind: 'move'; motion: Exclude<CharacterMotionIntent, { kind: 'return-visible' }> }>;

export type PreparedBehaviorPrompt = Readonly<{
  originalText: string;
  capabilityText: string;
  explicitDirective: ExplicitBehaviorDirective | null;
}>;

export type ConversationBehaviorContext = Readonly<{
  character: PublicBehaviorCatalog;
  runtime: Readonly<{
    moving: boolean;
    dragging: boolean;
    carrying: boolean;
    movementStopped: boolean;
  }>;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  recentActions: readonly string[];
}>;

export interface ConversationBehaviorPort {
  prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt>;
  getChatContext(): ConversationBehaviorContext;
  completeUserPrompt(input: Readonly<{
    generation: string;
    explicitDirective: ExplicitBehaviorDirective | null;
    providerPlan: CharacterBehaviorPlan | null;
  }>): void;
  handleTaskEvent(event: TaskEvent): void;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  reset(generation: string): void;
  close(): Promise<void>;
}
```

- [x] **步骤 1：写清单解析 RED**

  断言标准语义、`agentInferable` 状态名称、动作名称和标签可解析；NFKC 与不区分大小写匹配稳定；未知或多项同名/同标签返回 `CHARACTER_ACTION_UNAVAILABLE`；模型永远拿不到 stateId/actionId。缺少当前皮肤 presentation 的动作不得成为成功结果。

- [x] **步骤 2：写 Director/Service RED**

  覆盖优先级“关闭/安全与停止锁 → 当前明确指令 → 可信任务/拖拽 → 聊天计划 → 反思 → 本地 idle”。断言 Director 只把解析后的私有目标交给 Service；Service 仍通过 Engine 硬约束、表现解析、冷却、重复抑制和播放令牌授权。对明确/聊天来源不可用动作发布固定 `{ code:'CHARACTER_ACTION_UNAVAILABLE', message:'当前角色没有可播放的对应动作。' }`，不发布 idle；反思/本地来源静默跳过。

- [x] **步骤 3：写 success 排队 RED**

  `completeUserPrompt()` 先保存聊天计划；随后可信 success 若排程了动作，计划等待该 playbackToken 的 completed/interrupted/failed；success 无可播放动作时立即提交计划。旧 generation、角色切换、reset 与 close 均丢弃待提交计划。

- [x] **步骤 4：运行 RED**

  分别运行以下命令，确认失败源于本任务尚未存在的 resolver、Director 或定向授权接口：

  ```powershell
  pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/behavior-target-resolver.test.ts packages/character-runtime/tests/character-behavior-engine.test.ts packages/character-runtime/tests/behavior-action-selector.test.ts
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-behavior-service.test.ts
  ```

  预期：FAIL，新 resolver、Director 与定向授权接口不存在。

- [x] **步骤 5：写最小 GREEN**

  给现有 Engine 增加 `dispatchDirected()`，内部复用 `authorizeCharacterBehaviorAction()`/`selectCharacterBehaviorAction()` 与同一 schedule；不要复制 state/schedule。给 Service 增加 `getPublicBehaviorCatalog()` 与 `requestDirectedBehavior()`，返回同步授权结果并继续通过现有 `publish()` 发 Renderer 事件。Director 只保存来源、generation、停止锁与待提交 token，不保存第二份角色状态。

- [x] **步骤 6：运行 GREEN**

  依次运行以下命令，均须通过：

  ```powershell
  pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/behavior-target-resolver.test.ts packages/character-runtime/tests/character-behavior-engine.test.ts packages/character-runtime/tests/behavior-action-selector.test.ts
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-behavior-service.test.ts
  pnpm.cmd --filter @myself/character-runtime typecheck
  pnpm.cmd --filter @myself/desktop typecheck
  ```

  预期：PASS；既有搬运、任务阶段、V1 fallback 与播放反馈用例不回归。

- [x] **步骤 7：提交任务**

  ```powershell
  git add packages/character-runtime/src/behavior-target-resolver.ts packages/character-runtime/tests/behavior-target-resolver.test.ts packages/character-runtime/src/character-behavior-engine.ts packages/character-runtime/src/behavior-action-selector.ts packages/character-runtime/src/index.ts packages/character-runtime/tests/character-behavior-engine.test.ts packages/character-runtime/tests/behavior-action-selector.test.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/src/main/characters/character-behavior-service.ts apps/desktop/tests/character-behavior-service.test.ts
  git commit -m "feat: 增加可信角色行为导演"
  ```

---

## 可见窗口会话与受限进程收口

任务 4–7 的每次 GUI 会话都复用以下流程：启动前记录当前时间、工作区路径和所有命令行含该工作区的 `electron.exe`/`node.exe` 的 PID、父 PID、创建时间与命令行，作为基线；随后用带 `-PassThru` 的受控会话启动桌宠或测试并记录根 PID 与启动时间。退出后重新枚举进程，只有同时满足“非基线 PID、创建时间不早于本次启动、父进程链可追溯到本次会话根 PID、命令行属于本工作区”的进程才是候选。先列出候选 PID 与证明字段，再通过原会话或逐个精确 PID 清理；绝不对所有 Electron/Node 进程执行广泛 `Stop-Process`。

```powershell
$workspacePath = 'C:\Users\Administrator\.codex\worktrees\e43f\myself'
$baselineAt = Get-Date
$baseline = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('electron.exe', 'node.exe') -and $_.CommandLine -like "*$workspacePath*"
} | Select-Object ProcessId, ParentProcessId, CreationDate, Name, CommandLine
$devStartedAt = Get-Date
$sessionKey = [guid]::NewGuid().ToString('N')
$stdoutLog = Join-Path $env:TEMP "ai-pet-$sessionKey.stdout.log"
$stderrLog = Join-Path $env:TEMP "ai-pet-$sessionKey.stderr.log"
$devSession = Start-Process -FilePath 'pnpm.cmd' -ArgumentList @('--filter', '@myself/desktop', 'dev') -WorkingDirectory $workspacePath -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
$devRootPid = $devSession.Id
```

任务 7 分别以 `@('verify:desktop')` 和 `@('verify:behavior')` 替换开发参数并各自记录测试根 PID。实现时以当前 `Win32_Process` 父 PID 映射向上追溯验证每个候选的父链；不得只按进程名、工作区路径或创建时间单独认定。需要观察运行诊断时，只读取本次 `$stdoutLog`/`$stderrLog`，不得从其他终端或全局日志猜测；会话结束并记录必要的稳定诊断码后，用两个已解析的精确临时路径删除日志。每项里程碑记录必须包含基线时间、会话根 PID、启动时间、候选清单、实际清理方式和会话日志清理结果。

---

### 任务 4（B4）：显式动作、受限移动与最小生产接线

**文件：**

- 新建：`apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- 新建：`apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-director.ts`
- 修改：`apps/desktop/tests/character-behavior-director.test.ts`
- 修改：`apps/desktop/src/main/characters/character-motion-service.ts`
- 修改：`apps/desktop/tests/character-motion-controller.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 修改：`apps/desktop/tests/character-behavior-service.test.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- 修改：`apps/desktop/tests/conversation-chat-adapter.test.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 修改：`apps/desktop/tests/conversation-coordinator.test.ts`
- 修改：`apps/desktop/src/main/conversation/main-conversation-composition.ts`
- 修改：`apps/desktop/tests/main-conversation-composition.test.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-event-projection.ts`
- 修改：`apps/desktop/tests/conversation-event-projection.test.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/main-lifecycle.test.ts`

**接口：**

- 消费：任务 3 的 `ConversationBehaviorPort` 与 `ConversationBehaviorContext`、现有 `CharacterMotionService.tick()`、TaskEvent 投影和主进程组合根。
- 产出：任务 3 已定义类型的解析、真实上下文填充与对象化运动执行；上下文只包含公开角色清单、运行态布尔值、主动性档位和最近动作，不含路径、正文、token 或 actionId。
- 生产接线：任务 4 即创建唯一的 Service/Motion/Director 实例，Coordinator 在 capability router 与 Provider 前调用 `prepareUserPrompt()`，投影与播放反馈先交 Director；任务 5、6 只向同一实例补充设置和调度依赖，绝不建立第二条运行路径。

- [x] **步骤 1：写 Gate、运动和接线 RED**

  覆盖“停下/别走了/恢复活动/可以动了/向左一点/往上远一点/去右下角/走一走”和等价英文命令；“停下并删除 old.txt”必须保留 `capabilityText === '删除 old.txt'`；“别移动这个文件”、讨论、引用和代码块返回 null。`relative` 使用当前窗口轴尺寸 `0.5/1/2` 倍，`region` 使用当前显示器 workArea，所有目标经 `constrainTarget()` 钳制且接口没有 x/y。断言 Coordinator 在分流前 await Gate，local move 在创建 Provider 前完成授权；普通聊天在披露确认后重新读取 Director 的 `getChatContext()`，以必填 `behaviorContext` 构造 JSON 系统消息，不能复用确认前快照。

- [x] **步骤 2：写 Director、Projection 与 Main RED**

  断言 `main-conversation-composition.ts` 给 Coordinator 注入同一个端口，`ConversationEventProjection` 与播放反馈 IPC 先交 Director 再委托 Service，`index.ts` 只有一组 Service/Motion/Director。move 授权为 none 时不调用 `requestIntent()` 且发布 `CHARACTER_ACTION_UNAVAILABLE`；授权为 play 才请求 relative/region/wander。任务 4 的停止锁仅为内存初始 `false`，聊天/模型计划的 `stop_movement` 与 `resume_movement` 不得改变该锁；持久化入口留给任务 5。额外断言现有 500ms idle 来源先调用 Director 的旧主动授权门：锁为 false 时保持 V2 idle/V1 wander 既有行为，锁为 true 时不派发 idle、不调用 `pollLegacyIdle()`、不请求 wander，且不新增第二份状态。

- [x] **步骤 3：运行 RED**

  运行：`pnpm.cmd exec vitest run --project desktop apps/desktop/tests/explicit-character-behavior-gate.test.ts apps/desktop/tests/character-motion-controller.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/tests/main-lifecycle.test.ts`

  预期：FAIL，缺少 Gate、对象化运动、必填上下文或唯一生产组合；失败不得来自既有无关测试。

- [x] **步骤 4：写最小 GREEN 并运行单元门**

  Gate 只解析命令式首句并屏蔽引号/代码；Coordinator 保留原始用户文本。Director 先请求动作授权再请求 MotionService，停止先取消当前目标。现有 500ms poll 在进入 V1/V2 idle 候选前必须经过同一个 Director 授权门，未停止时保留旧行为，停止时拦截旧主动动作。任务 2 的 Adapter 此时才要求 `behaviorContext`，系统消息必须包含小写 `json`、精确对象示例与公开清单；Provider 调用仍只有一次且 `tools: []`。不得增加视觉包围盒、碰撞、缩放或 Renderer 坐标写入。

  ```powershell
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/explicit-character-behavior-gate.test.ts apps/desktop/tests/character-motion-controller.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/tests/main-lifecycle.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  ```

  预期：PASS；测试明确使用“窗口矩形保守边界”，不声称视觉贴边完成。

- [x] **步骤 5：启动桌宠受控验收并清理进程**

  按“可见窗口会话与受限进程收口”启动本次开发会话。

  执行智能体先从运行时公开清单选取一个确定可播放的标准语义或自定义动作名称，以 Prompt 请求该动作，观察对应动画启动且不是 idle；里程碑只记录所选公开名称/语义和结果，绝不记录 actionId。随后在同一受控会话中依次输入“向左一点”“去右下角”和当前角色不具备的动作请求。观察前两项产生相符的方向/区域移动，第三项显示 `CHARACTER_ACTION_UNAVAILABLE` 且不以 idle 冒充完成，并把观察结果写入里程碑记录。完成后结束该开发会话并按“可见窗口会话与受限进程收口”列出、验证并逐个处理候选进程。

  预期：验收项按观察记录；候选清单和清理方式可追溯，且不影响基线或其他 Electron/Node 进程。

- [x] **步骤 6：提交任务**

  ```powershell
  git add apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts apps/desktop/tests/explicit-character-behavior-gate.test.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/src/main/characters/character-motion-service.ts apps/desktop/tests/character-motion-controller.test.ts apps/desktop/src/main/characters/character-behavior-service.ts apps/desktop/tests/character-behavior-service.test.ts apps/desktop/src/main/conversation/conversation-chat-adapter.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/src/main/conversation/conversation-coordinator.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/src/main/conversation/main-conversation-composition.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/src/main/conversation/conversation-event-projection.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/src/main/index.ts apps/desktop/tests/main-lifecycle.test.ts
  git commit -m "feat: 接通显式桌宠动作与受限移动"
  ```

---

### 任务 5（B5）：持久停止锁、设置接线与重启验收

**文件：**

- 修改：`apps/desktop/src/main/storage/settings-store.ts`
- 修改：`apps/desktop/tests/settings-store.test.ts`
- 修改：`apps/desktop/tests/multi-provider-settings-store.test.ts`
- 修改：`apps/desktop/src/main/settings/desktop-settings-service.ts`
- 修改：`apps/desktop/tests/desktop-settings-service.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-director.ts`
- 修改：`apps/desktop/tests/character-behavior-director.test.ts`
- 修改：`apps/desktop/src/main/conversation/main-conversation-composition.ts`
- 修改：`apps/desktop/tests/main-conversation-composition.test.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/tests/advanced-settings-ipc.test.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/main-lifecycle.test.ts`

**接口：**

- 消费：现有 `privacy.proactivityMode`、`atomicWrite()`、SettingsStore 写队列和任务 4 的唯一 Director。
- 产出：`CharacterBehaviorSettingsSnapshot`、`getCharacterBehaviorSettings()`、`saveMovementStopped()` 与一次性生产设置接线；不新增 Renderer 设置入口。
- 权限不变量：只有本地 Gate 产出的 `explicitDirective` 能调用 `saveMovementStopped()`；Provider `behaviorPlan` 与反思中的 `stop_movement`/`resume_movement` 一律丢弃并不得触及 Store、Director 持久锁或 MotionService。

```ts
export type CharacterBehaviorSettingsSnapshot = Readonly<{
  movementStopped: boolean;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
}>;
```

- [ ] **步骤 1：写迁移与权限 RED**

  新建或清空设置默认 `autonomous/false`；既有 V1 与缺失 `privacy` 的 V2 都保留 `assistive`，已有明确 passive/assistive/autonomous 原样保留，缺 `movementStopped` 一律补 false。stop 保存后重建 Store 为 true，resume 后为 false。分别构造 local Gate、Provider plan 与反思 plan，断言只有 Gate 调用 `saveMovementStopped()`；后两者零 Store、零锁、零运动副作用。将持久快照 true 应用到任务 4 的同一 Director 后，原 500ms idle、V2 idle 和 V1 wander 都被旧主动授权门挡住；恢复 false 后才恢复任务 4 的既有未停止行为。

- [ ] **步骤 2：扩展 AST/MCP 与生产接线 RED**

  把 `saveMovementStopped` 加入 `nonMcpMutationCases`。写入 HTTP 与 stdio MCP fixture 后运行每个普通写入口，断言 `getMcpServerSettings()` 深相等；AST 枚举与 `atomicWrite(this.file, settings)` 一一对应。断言 `index.ts` 在创建 Director 后先读取 `getCharacterBehaviorSettings()`，成功落盘后才经 DesktopSettingsService/IPC 把完整快照通知同一 Director；失败时 Provider、运动和锁均不变。

- [ ] **步骤 3：运行 RED**

  运行：`pnpm.cmd exec vitest run --project desktop apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/tests/main-lifecycle.test.ts`

  预期：FAIL，缺迁移分支、锁写权限或生产设置接线；失败不得来自其他模块。

- [ ] **步骤 4：写最小 GREEN 并运行单元门**

  `movementStopped` 位于 V2 根对象并作为 optional 迁移字段；`privacy` 保持原结构。`saveMovementStopped()` 与 `savePrivacySettings()` 在同一队列内原子写入并返回冻结完整快照。DesktopSettingsService 仅在 await 成功后调用 Director sink，并启用既有三档 UI；启动时用 Store 快照初始化同一个 Director。锁为 true 时该 Director 的旧主动授权门同时拦截原 idle 和 V1 wander，直至本地 Gate 成功恢复。

  ```powershell
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/tests/main-lifecycle.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  ```

  预期：PASS；AST 与 MCP 两类 fixture 保真，Provider/反思无权写停止锁。

- [ ] **步骤 5：启动桌宠重启验收并清理进程**

  按“可见窗口会话与受限进程收口”启动本次开发会话。

  执行智能体通过可见窗口控制输入“停下”，确认包含原 idle/V1 wander 在内的自主或空间移动均被挡住；关闭开发会话、按上述流程处理候选后重启，确认仍停止；输入“恢复活动”，确认锁解除且后续允许移动，并记录观察。每次关闭都复用“可见窗口会话与受限进程收口”的基线、父链验证和逐 PID 处理流程。

- [ ] **步骤 6：提交任务**

  ```powershell
  git add apps/desktop/src/main/storage/settings-store.ts apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/src/main/conversation/main-conversation-composition.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/src/main/index.ts apps/desktop/tests/main-lifecycle.test.ts
  git commit -m "feat: 持久桌宠停止锁与生产设置接线"
  ```

---

### 任务 6（B6）：唯一主动性调度、反思与运行时验收

**文件：**

- 新建：`apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- 新建：`apps/desktop/tests/character-proactivity-scheduler.test.ts`
- 新建：`apps/desktop/src/main/characters/behavior-reflection-adapter.ts`
- 新建：`apps/desktop/tests/behavior-reflection-adapter.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-director.ts`
- 修改：`apps/desktop/tests/character-behavior-director.test.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 修改：`apps/desktop/tests/character-behavior-service.test.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-event-projection.ts`
- 修改：`apps/desktop/tests/conversation-event-projection.test.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/main-lifecycle.test.ts`

**接口：**

- 消费：Director 阻塞快照、任务 2 同一无权限响应契约与当前聊天 Provider 工厂。
- 产出：唯一的主动候选 Scheduler、无公开正文 Reflection Adapter 和生产组合；不接触现有文件工具 `ProactivityPolicy`。
- 唯一来源不变量：原 500ms poll 只调用 `CharacterBehaviorService.advance()` 推进 V2 引擎超时，并推进既有文件事务；它不得派发 `idle-due`、调用 `pollLegacyIdle()`、请求 `wander` 或产生任何主动候选。V1 与 V2 都只能由 Scheduler 在 passive/assistive/autonomous 规则下向 Director 提交候选。
- 诊断不变量：反思只发布经过测试的脱敏稳定事件 `BEHAVIOR_REFLECTION_STARTED`、`BEHAVIOR_REFLECTION_COMPLETED` 或 `BEHAVIOR_REFLECTION_DROPPED`；字段只允许 `phase`、布尔值、`durationMs` 与稳定 `reasonCode`，不得含正文、路径、坐标、角色私有 ID 或 Provider 返回原文。

```ts
export type CharacterActivityBlockers = Readonly<{
  chatting: boolean;
  dragging: boolean;
  moving: boolean;
  capabilityTask: boolean;
  awaitingConfirmation: boolean;
  movementStopped: boolean;
  closed: boolean;
}>;

export interface BehaviorReflectionAdapter {
  reflect(input: Readonly<{
    context: ConversationBehaviorContext;
    signal: AbortSignal;
  }>): Promise<CharacterBehaviorPlan | null>;
  close(): Promise<void>;
}

export type BehaviorReflectionDiagnostic = Readonly<{
  code: 'BEHAVIOR_REFLECTION_STARTED' | 'BEHAVIOR_REFLECTION_COMPLETED' | 'BEHAVIOR_REFLECTION_DROPPED';
  phase: 'started' | 'completed' | 'dropped';
  hadPlan?: boolean;
  durationMs?: number;
  reasonCode?:
    | 'NO_PLAN'
    | 'INVALID_PLAN'
    | 'BLOCKED'
    | 'ABORTED'
    | 'PROVIDER_ERROR'
    | 'STALE_GENERATION';
}>;
```

- [ ] **步骤 1：写调度、poll 与反思 RED**

  用 fake timers 和固定 random 覆盖 20/60 秒、2/5 分钟：passive 无 timer，assistive 只候选原地动作，autonomous 候选原地动作或短距移动并可反思。单独断言每次 500ms poll 对 V1/V2 都不产生 idle/wander；唯一候选源是 Scheduler。任一 blocker 暂停并保存剩余时间，恢复不补跑；close Abort 反思并使迟到 Promise 无效。同 actionId 连续候选静默跳过并重排。

- [ ] **步骤 2：写生产 Provider 工厂与安全 RED**

  Reflection factory 只接收当前 Provider 工厂与去标识化 `ConversationBehaviorContext`，请求必须是 `tools: []`、`toolChoice: 'none'` 与 `responseContract`；依赖对象没有文件、PowerShell、MCP、history 或 message 端口，返回正文永不公开。失败退避 2/4/8/16/30 分钟。为 started/completed/dropped 分别写诊断 RED，逐项覆盖 `NO_PLAN`、`INVALID_PLAN`、`BLOCKED`、`ABORTED`、`PROVIDER_ERROR`、`STALE_GENERATION` 有限原因码，并断言其他字符串与额外字段被拒绝；payload 不能含正文、路径、坐标、角色私有 ID 或 Provider 原始输出。断言 index 创建一个 Scheduler、一个 Reflection Adapter 和会话专属输出可订阅的脱敏诊断端口；投影的聊天、拖拽、移动、文件任务、确认等待和 close 更新同一个 blockers 快照。

- [ ] **步骤 3：运行 RED**

  运行：`pnpm.cmd exec vitest run --project desktop apps/desktop/tests/character-proactivity-scheduler.test.ts apps/desktop/tests/behavior-reflection-adapter.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-behavior-service.test.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/tests/main-lifecycle.test.ts`

  预期：FAIL，Scheduler、反思、500ms poll 收口或生产组合不存在。

- [ ] **步骤 4：写最小 GREEN 并运行单元门**

  Scheduler 只发布候选到期，Director 复用任务 3 Service 授权，绝不保存角色状态。反思只读取去标识化上下文，失败只影响下一次退避，并在每次尝试按时序发布白名单诊断；受控终端只订阅该诊断端口。原 `handleIdleDue()` 拆为无候选的 `advance()`；删除或收口旧 V1 `pollLegacyIdle()` 主动路径，避免两个调度器并存。

  ```powershell
  pnpm.cmd exec vitest run --project desktop apps/desktop/tests/character-proactivity-scheduler.test.ts apps/desktop/tests/behavior-reflection-adapter.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-behavior-service.test.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/tests/main-lifecycle.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  ```

  预期：PASS；fake timers 结束时无挂起 timer，V1/V2 均没有非 Scheduler 主动动作。

- [ ] **步骤 5：启动桌宠三档验收并清理进程**

  按“可见窗口会话与受限进程收口”启动本次开发会话。

  执行智能体通过可见窗口控制，分别在既有设置界面设为 passive、assistive、autonomous。passive 连续观察超过 60 秒无自主候选；assistive 观察最多三个 20–60 秒区间，只出现原地动作；autonomous 同样观察最多三个区间，记录原地或短距移动。持续空闲 2–5 分钟后，只读取本次会话的 `$stdoutLog`/`$stderrLog`，观察 `BEHAVIOR_REFLECTION_STARTED`，随后观察 `BEHAVIOR_REFLECTION_COMPLETED` 或带有限原因码的 `BEHAVIOR_REFLECTION_DROPPED`，以此证明静默反思真实发生且没有用户可见正文。聊天、拖拽、文件确认与“停下”期间计时必须暂停。关闭后复用“可见窗口会话与受限进程收口”的基线、父链验证、逐 PID 处理和精确临时日志清理流程。

- [ ] **步骤 6：提交任务**

  ```powershell
  git add apps/desktop/src/main/characters/character-proactivity-scheduler.ts apps/desktop/tests/character-proactivity-scheduler.test.ts apps/desktop/src/main/characters/behavior-reflection-adapter.ts apps/desktop/tests/behavior-reflection-adapter.test.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/src/main/characters/character-behavior-service.ts apps/desktop/tests/character-behavior-service.test.ts apps/desktop/src/main/conversation/conversation-event-projection.ts apps/desktop/tests/conversation-event-projection.test.ts apps/desktop/src/main/index.ts apps/desktop/tests/main-lifecycle.test.ts
  git commit -m "feat: 接通唯一桌宠主动性调度"
  ```

---

### 任务 7（B7）：汇总安全、完整 E2E 与终验

**文件：**

- 修改：`apps/desktop/src/shared/character-motion-ipc.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/tests/character-motion-ipc.test.ts`
- 修改：`tests/fixtures/provider-server.ts`
- 修改：`tests/integration/desktop-agent.test.ts`
- 修改：`tests/security/permission-boundary.test.ts`
- 修改：`tests/e2e/desktop.spec.ts`
- 新建：`docs/operations/behavior-director-acceptance.md`

**接口：**

- 消费：任务 1–6 的已接线生产能力。
- 产出：仅在 `--myself-e2e-probe` 下存在的去标识化运动 delta，以及最终安全/集成/E2E 证据。
- E2E probe 只能在测试标志启用时注册；未带标志的生产 Preload 公开 API、IPC 通道和返回值保持不变。

- [ ] **步骤 1：写汇总安全与 E2E RED**

  `desktop-agent.test.ts` 覆盖同次正文与标准/自定义动作、relative、region、缺动作、停止/恢复和跨 Provider 披露后上下文重读；`permission-boundary.test.ts` 断言 chat/reflection `tools=[]`，文件 runtime、PowerShellTool 与 MCP adapter 零调用，Provider/反思 stop/resume 零持久锁调用，并验证反思诊断只含白名单字段、不含正文/路径/坐标/私有 ID。E2E 使用 JSON Output fixture 覆盖四向/区域 delta、缺动作不 idle、停止跨重启、停止后聊天原地动作、三档差异、反思零工具和 close 后无迟到动作；位置只读 delta。

- [ ] **步骤 2：运行 RED**

  运行：`pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts`

  预期：FAIL，缺完整纵向安全断言或 E2E probe；不在本步骤启动 Electron。

- [ ] **步骤 3：写最小 GREEN 并运行非 GUI 门**

  probe 只返回 `{ moved, horizontal, vertical }`，不返回绝对位置。日志探针只允许稳定 code、阶段、布尔值、计数和耗时，禁止正文、绝对路径与绝对坐标。

  ```powershell
  pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts
  pnpm.cmd --filter @myself/character-runtime test
  pnpm.cmd --filter @myself/agent-core test
  pnpm.cmd --filter @myself/desktop typecheck
  pnpm.cmd --filter @myself/desktop test
  pnpm.cmd test:security
  pnpm.cmd test:integration
  ```

  预期：PASS；上述命令不启动 Electron/Playwright。

- [ ] **步骤 4：运行两个完整终验门并检查残留进程**

  用户已允许两次完整 E2E；依次运行：

  ```powershell
  pnpm.cmd verify:desktop
  pnpm.cmd verify:behavior
  ```

  两者都会启动真实 Electron/Playwright，必须分别通过。每个命令都严格执行“命令前记录基线与启动时间 → 以受控会话启动并记录测试根 PID → 结束后枚举父链候选 → 列出证明字段后逐 PID 精确清理”；完成第一个完整流程后才启动下一条，不能在命令结束后补记基线。若出现 Windows 错误报告弹窗，记录时间与可见错误码后继续门禁。只有桌宠或测试进程实际崩溃、命令测试失败，或出现反复弹窗、系统无响应等系统不稳定迹象时，才停止后续 GUI 命令并转入诊断；未完成门禁不得写成通过。

- [ ] **步骤 5：记录验收、差异检查与最终提交**

  `behavior-director-acceptance.md` 只在两个完整门禁都通过后记录真实日期、环境、命令、退出码、测试计数、每个里程碑观察与未覆盖项。Windows 窗口边界、跨显示器观感与动作自然度仍写“待用户人工确认”；明确本阶段只用窗口矩形，视觉包围盒/碰撞/贴边尚未完成。

  ```powershell
  git diff --check
  git diff --name-only -- apps/website
  if (rg -n "responseContract|structured_output|movementStopped|CHARACTER_ACTION_UNAVAILABLE" packages apps tests docs/operations/behavior-director-acceptance.md) { exit 0 } else { throw 'BEHAVIOR_IMPLEMENTATION_EVIDENCE_MISSING' }
  ```

  预期：`git diff --check` 无输出；website 差异为空；证据断言至少命中新协议、实现、测试与验收记录。随后才可提交：

  ```powershell
  git add apps/desktop/src/shared/character-motion-ipc.ts apps/desktop/src/preload/index.ts apps/desktop/tests/character-motion-ipc.test.ts tests/fixtures/provider-server.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts tests/e2e/desktop.spec.ts docs/operations/behavior-director-acceptance.md
  git commit -m "feat: 完成桌宠行为导演终验"
  ```

## 最终完成定义

完成必须同时满足：普通聊天单次 Provider 正文与行为纵向通过；显式指令在 Provider 前执行；任务 4、5、6 的真实桌宠里程碑分别通过并完成受限进程清理；旧能力任务 intent 保留；Service/Motion/Renderer 仍为唯一后半链；设置/MCP 完整性通过；Scheduler 是 V1/V2 唯一主动候选源；Provider/反思不能持久停止桌宠；安全测试证明零工具与日志脱敏；`verify:desktop` 与 `verify:behavior` 均通过；人工 Windows 项保持“待用户人工确认”。
