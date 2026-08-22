# DeepSeek 文件工具兼容性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `deepseek-v4-flash` 的完整文件请求稳定产生真实工具调用和宿主确认卡，同时保留现有授权根、回收站和 Main 可信边界。

**Architecture:** 在 OpenAI-compatible Provider 边界编码/解码合法工具别名；`AgentLoop` 在首次真实结果前强制结构化工具调用，并提供无系统权限的澄清工具。DeepSeek 能力任务关闭思考模式，确认写入后禁用工具并仅总结本地结果。

**Tech Stack:** TypeScript、Zod、Vitest、Electron、DeepSeek OpenAI-compatible Chat Completion、现有 `@myself/agent-core` 与 `packages/file-tools`。

## Global Constraints

- 设计基线：`docs/superpowers/specs/2026-08-22-deepseek-file-tool-compatibility-design.md`。
- 只修改 DeepSeek/OpenAI-compatible 文件能力规划边界；不混入角色行为、几何、拖拽或工作台功能。
- 保留 `packages/file-tools`、Node `fs/promises` 和 Electron `shell.trashItem`。
- 不引入新 Agent 框架或第二套权限状态机。
- MCP client、server、Agent、Renderer 入口和运行时继续禁用。
- 普通聊天工具表为空；写操作继续逐次显示宿主确认卡。
- Provider 外部工具名必须满足 `^[A-Za-z0-9_-]{1,64}$`，未知别名不得进入 `ToolRegistry`。
- 结构性代码注释和新增文档使用中文。
- 每个任务严格执行 RED → GREEN → REFACTOR，并在提交前运行 `git diff --check`。

---

## 文件职责映射

- `apps/desktop/src/main/providers/openai-tool-name-codec.ts`：维护单次请求的内部名与 Provider 安全名双向映射；不做权限判断。
- `packages/agent-core/src/capability-clarification-tool.ts`：定义并校验无权限澄清工具；不接触 `ToolRuntime`。
- `packages/agent-core/src/types.ts`：声明 `ToolChoicePolicy`、`ReasoningMode` 与能力控制工具名的公共类型。
- `packages/agent-core/src/agent-loop.ts`：根据规划阶段生成工具表与选择策略，管理写后只总结状态。
- `apps/desktop/src/main/providers/openai-provider.ts`：序列化别名、`tool_choice` 与 DeepSeek 非思考模式，并解码响应工具名。
- `apps/desktop/tests/openai-tool-name-codec.test.ts`：Codec 的字符集、碰撞、未知名和克隆边界。
- `packages/agent-core/tests/agent-loop.test.ts`：强制工具、结构化澄清、只读续跑、写后总结与旧协议删除。
- `apps/desktop/tests/provider-contract.test.ts`：真实 OpenAI-compatible/DeepSeek 请求响应形状。
- `tests/integration/desktop-agent.test.ts`：创建与删除从 Provider fixture 到宿主确认和真实文件结果的纵向证据。
- `docs/operations/lightweight-agent-acceptance.md`：记录实际运行的自动化结果与待人工项。

---

### Task 1: Provider 工具名 Codec

**Files:**
- Create: `apps/desktop/src/main/providers/openai-tool-name-codec.ts`
- Create: `apps/desktop/tests/openai-tool-name-codec.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` 中的内部工具名字符串。
- Produces:

```ts
export interface OpenAIToolNameCodec {
  encode(internalName: string): string;
  decode(providerName: string): string;
}

export function createOpenAIToolNameCodec(
  definitions: readonly ToolDefinition[]
): OpenAIToolNameCodec;
```

- [ ] **Step 1: 写 Codec RED**

在新测试中构造 `builtin.files.delete_file`、`builtin.files.create_file` 和 `builtin.capability.request_clarification` 三个定义，断言：

```ts
const codec = createOpenAIToolNameCodec(definitions);
const external = codec.encode('builtin.files.delete_file');
expect(external).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
expect(external).not.toContain('.');
expect(codec.decode(external)).toBe('builtin.files.delete_file');
```

补充 RED：内部未知名、Provider 未知名、两个内部名编码碰撞、超长外部名均抛出带稳定 `code` 的错误；调用者修改原 definitions 后不得改变既有映射。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/openai-tool-name-codec.test.ts
```

Expected: FAIL，原因是模块不存在。

- [ ] **Step 3: 写最小 GREEN**

实现单次请求 Codec：把 `.` 编码为 `__`，构造时同时建立 `internalToProvider` 与 `providerToInternal`，并在构造阶段验证字符集、长度与碰撞。所有错误使用 `Object.assign(new Error(code), { code })`；只接受构造时登记的名称，不做响应时临时字符串替换。

- [ ] **Step 4: 运行 GREEN 与类型检查**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/openai-tool-name-codec.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

Expected: 全部退出 0。

- [ ] **Step 5: 提交 Task 1**

```powershell
git add apps/desktop/src/main/providers/openai-tool-name-codec.ts apps/desktop/tests/openai-tool-name-codec.test.ts
git commit -m "feat(desktop): 建立 Provider 工具名安全映射"
```

---

### Task 2: AgentLoop 强制工具策略与结构化澄清

**Files:**
- Modify: `packages/agent-core/src/types.ts`
- Create: `packages/agent-core/src/capability-clarification-tool.ts`
- Modify: `packages/agent-core/src/agent-loop.ts`
- Modify: `packages/agent-core/src/index.ts`
- Modify: `packages/agent-core/tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: Task 1 只在 Provider 层使用，本任务不依赖其实现。
- Produces:

```ts
export type ToolChoicePolicy = 'auto' | 'required' | 'none';
export type ReasoningMode = 'provider_default' | 'disabled';

export const CAPABILITY_CLARIFICATION_TOOL_NAME =
  'builtin.capability.request_clarification' as const;

export const capabilityClarificationToolDefinition: ToolDefinition;

export function parseCapabilityClarificationRequest(
  raw: unknown
): Readonly<{ question: string }>;
```

`ModelRequest` 新增必填字段：

```ts
toolChoice: ToolChoicePolicy;
reasoningMode: ReasoningMode;
```

- [ ] **Step 1: 写请求策略 RED**

修改 `ScriptedProvider` 测试夹具以记录完整 `ModelRequest`。新增断言：首次能力规划请求为：

```ts
expect(provider.requests[0]).toMatchObject({
  toolChoice: 'required',
  reasoningMode: 'disabled'
});
expect(provider.requests[0]?.tools.map(tool => tool.function.name))
  .toContain(CAPABILITY_CLARIFICATION_TOOL_NAME);
```

普通协议请求应为 `toolChoice: 'none'`、`reasoningMode: 'provider_default'` 且不含澄清工具。

- [ ] **Step 2: 写澄清工具 RED**

新增 Provider 返回：

```ts
{
  type: 'tool_request',
  request: {
    requestId: 'clarify-1',
    toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
    arguments: { question: '请提供目标文件名' }
  }
}
```

期望只产生一条公开问题和 `success`，不调用 `ToolRuntime.prepare`。空问题、1001 字符问题、额外字段，以及“请确认是否删除 empty 文件夹”均稳定失败。把原来成功接受文本 JSON `clarification_required` 的测试改为期望协议违约；保留连续两次普通文本失败断言。

- [ ] **Step 3: 写读后/写后策略 RED**

新增断言：

- 自动执行只读工具后下一轮为 `toolChoice: 'auto'`，仍可继续调用真实工具。
- `write_request` 经 `resume()` 获得本地结果后，下一轮 `tools=[]`、`toolChoice:'none'`，Provider 再返回工具调用时必须拒绝，不能重复写。
- 写后文本总结只依据传入的 `tool` 消息，失败结果最终 phase 为 `error`。

- [ ] **Step 4: 运行 RED**

```powershell
pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts
```

Expected: FAIL，缺少新类型、模块和阶段策略。

- [ ] **Step 5: 写最小 GREEN 并删除旧路径**

实现 `capability-clarification-tool.ts` 的严格对象解析和执行确认识别。`AgentLoop` 每次调用 Provider 前按以下规则构造请求：

```ts
const planning = context.protocol === 'capability_planner' && !hasTrustedToolResult;
const request = {
  messages,
  tools: finalizationOnly
    ? []
    : planning
      ? [...context.tools, capabilityClarificationToolDefinition]
      : context.tools,
  toolChoice: finalizationOnly ? 'none' : planning ? 'required' : 'auto',
  reasoningMode: context.protocol === 'capability_planner'
    ? 'disabled'
    : 'provider_default'
};
```

确认型 `ContinuationState` 保存 `finalizationOnly: true`；`resume()` 续跑时启用该标记。澄清工具在 `ToolRuntime.prepare` 之前消费。删除 `parseCapabilityPlannerClarification` 和文本 JSON 成功分支，不保留双轨。

- [ ] **Step 6: 运行 GREEN**

```powershell
pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

Expected: 全部退出 0。

- [ ] **Step 7: 提交 Task 2**

```powershell
git add packages/agent-core/src/types.ts packages/agent-core/src/capability-clarification-tool.ts packages/agent-core/src/agent-loop.ts packages/agent-core/src/index.ts packages/agent-core/tests/agent-loop.test.ts
git commit -m "feat(agent): 强制能力规划使用结构化工具"
```

---

### Task 3: DeepSeek/OpenAI-compatible 请求响应适配

**Files:**
- Modify: `apps/desktop/src/main/providers/openai-provider.ts`
- Modify: `apps/desktop/tests/provider-contract.test.ts`
- Modify: `apps/desktop/tests/main-conversation-composition.test.ts`

**Interfaces:**
- Consumes: `createOpenAIToolNameCodec()`、`ModelRequest.toolChoice`、`ModelRequest.reasoningMode`。
- Produces: `OpenAICompatibleProvider.respond()` 对外仍返回内部工具名的 `ModelResponse`，调用者不接触 Provider 别名。

- [ ] **Step 1: 写工具别名和 tool_choice RED**

在 `provider-contract.test.ts` 的 fetch fixture 中捕获 JSON body，使用内部工具 `builtin.files.delete_file`，断言请求满足：

```ts
expect(body.tools[0].function.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
expect(body.tools[0].function.name).not.toContain('.');
expect(body.tool_choice).toBe('required');
```

让响应使用捕获到的 Provider 别名，期望 `ModelResponse.request.toolName` 恢复为 `builtin.files.delete_file`。未知别名期望 `PROVIDER_UNKNOWN_TOOL_CALL`。

- [ ] **Step 2: 写 DeepSeek 推理模式 RED**

使用 `providerId:'deepseek'`、`reasoningMode:'disabled'`，断言 body 最终包含：

```ts
thinking: { type: 'disabled' }
```

即使 `additionalParameters` 尝试设置 enabled，也必须由能力请求覆盖。`providerId:'openai'` 或 `reasoningMode:'provider_default'` 不得注入 DeepSeek `thinking` 字段。

- [ ] **Step 3: 写续传消息别名 RED**

构造 assistant `toolRequest` 和后续 tool message，断言 assistant 消息中的 `tool_calls[].function.name` 仍使用同一 Provider 别名，`tool_call_id` 保持原值；工具结果正文不改变。

- [ ] **Step 4: 运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/provider-contract.test.ts tests/main-conversation-composition.test.ts
```

Expected: FAIL，当前仍原样发送带点名称、缺少 `tool_choice` 和 DeepSeek thinking 覆盖。

- [ ] **Step 5: 写最小 GREEN**

`OpenAICompatibleProvider.respond()` 为当前请求创建一次 Codec；请求 definitions 和 assistant tool request 都通过 `encode()`，响应 tool call 在构造 `ModelResponse` 前通过 `decode()`。请求体显式序列化：

```ts
{
  ...additionalParameters,
  model,
  messages,
  tools,
  tool_choice: request.toolChoice,
  ...(providerId === 'deepseek' && request.reasoningMode === 'disabled'
    ? { thinking: { type: 'disabled' } }
    : {})
}
```

空工具表配 `none`；非空表才允许 `auto/required`。不得记录原始响应、Authorization 或工具私有参数。

- [ ] **Step 6: 运行 GREEN 与 Provider 全组**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/provider-contract.test.ts tests/main-conversation-composition.test.ts
pnpm.cmd --filter @myself/desktop test
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

Expected: 全部退出 0。

- [ ] **Step 7: 提交 Task 3**

```powershell
git add apps/desktop/src/main/providers/openai-provider.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/main-conversation-composition.test.ts
git commit -m "fix(desktop): 兼容 DeepSeek 文件工具调用"
```

---

### Task 4: Desktop 纵向验收与状态记录

**Files:**
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `docs/operations/lightweight-agent-acceptance.md`

**Interfaces:**
- Consumes: Tasks 1–3 的完整 Provider/AgentLoop 行为。
- Produces: DeepSeek 兼容 fixture 下创建、删除、澄清和普通聊天的可执行验收证据。

- [ ] **Step 1: 写删除空目录纵向 RED**

使用临时授权根创建空目录 `empty`。Provider fixture 第一次返回外部别名工具调用，参数 `{ relativePath:'empty' }`；断言：

- 第一个确认相关公开事件是 `pending_action`，不是 assistant 文字；
- 用户确认前目录存在；
- 确认后只调用隔离 `RecycleBinPort` 一次；
- 本地结果传回 Provider 后只生成文本总结，不能出现第二次工具调用。

- [ ] **Step 2: 写创建文件与澄清纵向 RED**

创建场景返回 `create_file` 工具调用并显示确认卡；确认后文件存在且同名目标拒绝覆盖。缺少目标的场景调用结构化澄清工具，只公开一条问题，不产生 `pending_action` 或文件副作用。

- [ ] **Step 3: 写普通聊天和授权边界 RED**

断言“你好呀”请求 `tools=[]`、`toolChoice:'none'`；文件数据授权关闭或未选择授权根时，Provider 收不到文件工具。MCP runtimeSupport 继续为 false，正式 preload 不出现 MCP API。

- [ ] **Step 4: 运行 RED**

```powershell
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-coordinator.test.ts
```

Expected: 至少新增 DeepSeek 别名/策略断言失败。

- [ ] **Step 5: 仅补必要组合接线**

如果纵向测试显示组合根没有把 `providerId:'deepseek'` 传给 `OpenAICompatibleProvider`，只在 `main-conversation-composition.ts` 的既有 Provider 构造点补传该字段，并在相邻测试中断言；不得创建第二个 DeepSeek Adapter。

- [ ] **Step 6: 运行阶段门禁**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
git diff --check
```

Expected: 全部退出 0；若真实 Windows 窗口或 DeepSeek API未人工观察，记录为“待用户人工确认”，不得写成通过。

- [ ] **Step 7: 更新中文验收记录**

在 `docs/operations/lightweight-agent-acceptance.md` 追加 2026-08-22 小节，逐条记录实际执行命令、退出码、测试数量、未覆盖的真实 DeepSeek/API 与 Windows 回收站人工项。不得复制计划中的预期结果冒充事实。

- [ ] **Step 8: 提交 Task 4**

```powershell
git add tests/integration/desktop-agent.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/src/main/conversation/main-conversation-composition.ts docs/operations/lightweight-agent-acceptance.md
git commit -m "test(desktop): 验收 DeepSeek 文件能力闭环"
```

---

## 最终人工观察

自动门禁通过后，在当前 worktree 使用：

```powershell
pnpm.cmd --filter @myself/desktop dev
```

人工发送：

```text
帮我把当前目录下的empty文件夹删除了
```

预期：只出现宿主删除确认卡；确认前无副作用，确认后目标进入 Windows 回收站并可恢复。再发送“你好呀”，普通聊天继续成功。真实观察结果由用户确认后写入验收记录。
