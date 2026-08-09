# AI 桌宠自由聊天与文件任务分流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持单一聊天输入框和既有文件安全事务不变的前提下，交付不依赖文件授权的有界多轮普通聊天、保守文件任务分流、跨 Provider 历史披露确认和可原子重置的新对话。

**Architecture:** 在 Electron Main 的 IPC 与既有 `AgentService` 之间新增深模块 `ConversationCoordinator`。Coordinator 持有当前会话 generation、可见历史、规划与披露状态；无工具 `ConversationTurnAdapter` 负责普通聊天和意图规划，`FileTaskAdapter` 继续复用现有 Agent、路径守卫、确认卡和回收站事务。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Zustand 5、Vitest 3、Playwright 1.61、pnpm 11、Windows 10/11。

## Global Constraints

- 唯一需求基准是 `docs/superpowers/specs/2026-08-10-ai-pet-conversation-routing-design.md`。
- 采用规格驱动开发；任务行为与规格冲突时先停止并更新规格，不默认代码正确。
- 每个任务严格采用 RED–GREEN–REFACTOR；不得先写实现再补测试。
- 目标分支为 `AgentCoreExtension`；不得合并到 `main`。
- 只修改智能桌宠 Desktop、共享 package、桌宠测试和中文文档；禁止修改或运行 `apps/website` 及网站测试。
- 普通聊天请求的 `tools` 必须恒为 `[]`，且不得读取授权范围或创建 `PathPolicy`。
- 只有严格规划结果 `file_task` 可以进入现有文件 Agent。
- 当前会话只驻留 Main 内存，最多 20 个完整回合和 16,000 个 Unicode 字符。
- 文件正文、目录列表、工具请求、工具结果和能力令牌不能进入共享历史或对话披露清单。
- 跨 Provider 发送既有历史必须获得绑定当前 generation、当前请求和目标 Provider 的单次授权。
- MCP 保持禁用；不增加长期记忆、语音、联网工具、主动陪伴或桌面自动化。
- 此计划不实现“此电脑”授权；缺少授权时只引导配置当前版本支持的授权范围。
- 所有新增文档、用户文案和结构性注释使用中文。
- 采用最小修改；不进行无关重构，不保留被替代的双路线或兼容壳。
- Git 默认只读。每个任务末尾的提交步骤仅是交接点；没有用户对 Git 写操作的明确授权时，不得执行 `git add`、`git commit`、建分支或推送。

---

## 1. 文件结构与职责

### 1.1 新增文件

| 文件 | 单一职责 |
| --- | --- |
| `apps/desktop/src/main/conversation/conversation-history.ts` | 保存、裁剪和清空当前运行期可见回合 |
| `apps/desktop/src/main/conversation/conversation-turn-adapter.ts` | 通过无工具模型请求生成严格 `TurnPlan` |
| `apps/desktop/src/main/conversation/conversation-disclosure-adapter.ts` | 把可见历史映射到既有 `DisclosurePolicy` 的单次清单与授权 |
| `apps/desktop/src/main/conversation/conversation-coordinator.ts` | 持有会话状态、分流、generation、确认与重置事务 |
| `apps/desktop/src/main/conversation/file-task-adapter.ts` | 在进入既有 `AgentService` 前执行文件授权预检，并适配会话历史 |
| `apps/desktop/src/renderer/src/chat/HistoryDisclosureCard.tsx` | 展示跨 Provider 历史披露摘要并提交固定决策 |
| `apps/desktop/tests/conversation-history.test.ts` | 验证历史边界与裁剪 |
| `apps/desktop/tests/conversation-turn-adapter.test.ts` | 验证无工具规划契约与降级 |
| `apps/desktop/tests/conversation-disclosure-adapter.test.ts` | 验证同 Provider、跨 Provider、过期和重放 |
| `apps/desktop/tests/conversation-coordinator.test.ts` | 验证会话状态、分流、generation 和重置 |
| `apps/desktop/tests/file-task-adapter.test.ts` | 验证授权预检与既有 Agent 适配 |
| `docs/operations/conversation-routing-acceptance.md` | 记录自动门和 Windows 人工验收事实 |

### 1.2 修改文件

| 文件 | 修改原因 |
| --- | --- |
| `packages/shared-types/src/contracts.ts` | 新增披露事件、重置事件与固定决策 Schema |
| `packages/shared-types/tests/contracts.test.ts` | 锁定新增共享契约的严格性 |
| `apps/desktop/src/main/agent/disclosure-policy.ts` | 允许 Main 为混合来源可见历史显式提供保守来源身份 |
| `apps/desktop/src/main/agent/agent-service.ts` | 接收 Coordinator 已发布的文件任务和获准可见历史，不重复发布用户消息 |
| `apps/desktop/src/main/ipc/register-ipc.ts` | 将聊天 IPC 指向 Coordinator，并注册重置与披露决策 |
| `apps/desktop/src/main/index.ts` | 组合 Chat Adapter、Disclosure Adapter、File Task Adapter 与 Coordinator |
| `apps/desktop/src/shared/ipc-channels.ts` | 增加两个严格白名单通道 |
| `apps/desktop/src/shared/myself-api.ts` | 暴露重置和披露决策的窄化 Renderer 类型 |
| `apps/desktop/src/preload/index.ts` | 暴露两个白名单调用，不暴露路由或历史正文 |
| `apps/desktop/src/renderer/src/stores/task-store.ts` | 保存披露卡、处理重置事件并清空界面状态 |
| `apps/desktop/src/renderer/src/chat/ChatPanel.tsx` | 增加“新对话”、披露卡和打开设置入口 |
| `apps/desktop/tests/agent-service.test.ts` | 锁定 Coordinator 所需的文件任务输入契约 |
| `apps/desktop/tests/agent-ipc.test.ts` | 锁定新增 IPC Schema 和 Coordinator 委托 |
| `apps/desktop/tests/preload-api.test.ts` | 锁定 preload 白名单 |
| `apps/desktop/tests/renderer-task-store.test.ts` | 锁定披露与重置归约 |
| `apps/desktop/tests/renderer-components.test.tsx` | 锁定新按钮和确认卡 |
| `apps/desktop/tests/provider-contract.test.ts` | 锁定三类 Provider 的无工具规划请求 |
| `apps/desktop/tests/privacy-and-proactivity.test.ts` | 锁定显式来源披露和会话 generation 失效 |
| `tests/security/permission-boundary.test.ts` | 锁定普通聊天不读取文件授权及私有数据不披露 |
| `tests/integration/desktop-agent.test.ts` | 覆盖 Chat/Clarify/File 三条纵向路径 |
| `tests/e2e/desktop.spec.ts` | 覆盖无授权聊天、披露和新对话迟到事件 |

---

### Task 1：建立共享会话事件与 IPC 决策契约

**Requirements:** `CONV-DISCLOSE-002`、`CONV-DISCLOSE-003`、`CONV-DISCLOSE-004`、`CONV-RESET-001`、`CONV-ROUTE-001`

**Files:**
- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`

**Interfaces:**
- Consumes: 既有 `TaskEvent`、`taskEventSchema` 与 `ipcChannels`
- Produces:

```ts
export const historyDisclosureDecisionSchema = z.enum([
  'share_once',
  'current_message_only'
]);
export type HistoryDisclosureDecision = z.infer<
  typeof historyDisclosureDecisionSchema
>;

export type HistoryDisclosureRequiredEvent = {
  type: 'history_disclosure_required';
  requestId: string;
  targetProviderName: string;
  messageCount: number;
  characterCount: number;
};

export type ConversationResetEvent = {
  type: 'conversation_reset';
  generation: string;
};
```

- [ ] **Step 1：为严格共享契约编写 RED**

在 `contracts.test.ts` 增加测试，断言两类事件通过、未知字段被拒绝、负数和过长标识被拒绝：

```ts
it('只接受严格的历史披露和会话重置事件', () => {
  expect(taskEventSchema.parse({
    type: 'history_disclosure_required',
    requestId: 'disclosure-1',
    targetProviderName: 'OpenAI',
    messageCount: 4,
    characterCount: 120
  })).toMatchObject({ type: 'history_disclosure_required' });

  expect(() => taskEventSchema.parse({
    type: 'conversation_reset',
    generation: 'generation-2',
    history: ['不得进入 Renderer']
  })).toThrow();
});
```

- [ ] **Step 2：运行 RED**

Run:

```powershell
pnpm --filter @myself/shared-types test -- --run tests/contracts.test.ts
```

Expected: FAIL，原因是 `history_disclosure_required` 与 `conversation_reset` 尚未属于 `taskEventSchema`。

- [ ] **Step 3：实现最小共享契约**

在 `contracts.ts` 增加严格 Zod 对象，并把它们加入 `taskEventSchema`。数值限制固定为：`messageCount` 取 `0..40`，`characterCount` 取 `0..16_000`，标识和 Provider 显示名取 `1..128` 字符。

在 `ipc-channels.ts` 增加：

```ts
conversationReset: 'conversation:reset',
conversationDisclosureResolve: 'conversation:disclosure-resolve',
```

- [ ] **Step 4：运行 GREEN 与类型检查**

Run:

```powershell
pnpm --filter @myself/shared-types test -- --run tests/contracts.test.ts
pnpm --filter @myself/shared-types typecheck
pnpm --filter @myself/desktop typecheck
```

Expected: 全部 PASS。

- [ ] **Step 5：任务交接与条件提交**

检查：

```powershell
git diff --check
git diff -- packages/shared-types/src/contracts.ts packages/shared-types/tests/contracts.test.ts apps/desktop/src/shared/ipc-channels.ts
```

若用户已明确授权 Git 写操作，建议提交：

```powershell
git add packages/shared-types/src/contracts.ts packages/shared-types/tests/contracts.test.ts apps/desktop/src/shared/ipc-channels.ts
git commit -m "feat: 建立会话分流共享契约"
```

未获授权时停止在交接点并报告建议提交信息。

---

### Task 2：实现有界可见会话历史

**Requirements:** `CONV-HISTORY-001` 至 `CONV-HISTORY-005`

**Files:**
- Create: `apps/desktop/src/main/conversation/conversation-history.ts`
- Create: `apps/desktop/tests/conversation-history.test.ts`

**Interfaces:**
- Consumes: 无外部 I/O
- Produces:

```ts
export type VisibleConversationTurn = Readonly<{
  userText: string;
  assistantText: string;
  providerIdentity: string;
}>;

export class ConversationHistory {
  append(turn: VisibleConversationTurn): void;
  turns(): readonly VisibleConversationTurn[];
  modelMessages(): ModelMessage[];
  itemCount(): number;
  characterCount(): number;
  sourceProviderIdentities(): ReadonlySet<string>;
  clear(): void;
}
```

- [ ] **Step 1：为完整回合裁剪编写 RED**

```ts
it('同时按完整回合和 Unicode 字符上限裁剪', () => {
  const history = new ConversationHistory({ maxTurns: 2, maxCharacters: 12 });
  history.append(turn('甲', '乙', 'provider:a'));
  history.append(turn('丙', '丁', 'provider:a'));
  history.append(turn('😀😀', '戊', 'provider:b'));

  expect(history.turns()).toEqual([
    turn('丙', '丁', 'provider:a'),
    turn('😀😀', '戊', 'provider:b')
  ]);
  expect(history.characterCount()).toBe(5);
});
```

另写测试证明：返回值不可修改、工具消息类型无法写入、`clear()` 清空、单个超限回合保留尾部文本属于禁止行为并应拒绝输入，而不是截断正文。

- [ ] **Step 2：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-history.test.ts
```

Expected: FAIL，原因是模块不存在。

- [ ] **Step 3：实现最小内存历史**

使用 `Array.from(text).length` 计算 Unicode 字符数；`append()` 先验证单回合不超过 16,000 字符，再追加并从最旧完整回合开始淘汰。`modelMessages()` 只生成 `user` 与 `assistant` 文本消息，不接受工具消息。

构造器默认值固定为：

```ts
constructor(options: {
  maxTurns?: number;
  maxCharacters?: number;
} = {})
```

默认 `maxTurns=20`、`maxCharacters=16_000`。

- [ ] **Step 4：运行 GREEN**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-history.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 5：任务交接与条件提交**

建议提交信息：`feat: 添加有界内存会话历史`。未获 Git 写授权时只报告文件与验证结果。

---

### Task 3：实现严格无工具规划 Adapter

**Requirements:** `CONV-SCOPE-002`、`CONV-SCOPE-003`、`CONV-ROUTE-002`、`CONV-ROUTE-003`、`CONV-SAFE-001`

**Files:**
- Create: `apps/desktop/src/main/conversation/conversation-turn-adapter.ts`
- Create: `apps/desktop/tests/conversation-turn-adapter.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`、`ModelMessage`、获准可见历史与当前用户文本
- Produces:

```ts
export type TurnPlan =
  | { kind: 'chat_reply'; text: string; emotion?: CharacterEmotionLabel }
  | { kind: 'clarify'; question: string }
  | { kind: 'file_task' };

export interface ConversationTurnInput {
  history: readonly ModelMessage[];
  text: string;
  signal: AbortSignal;
}

export class ConversationTurnAdapter {
  constructor(provider: ModelProvider);
  plan(input: ConversationTurnInput): Promise<TurnPlan>;
}
```

- [ ] **Step 1：为三类结果与安全降级编写 RED**

使用脚本 Provider 捕获请求并分别返回：合法聊天 JSON、合法澄清 JSON、合法文件任务 JSON、Markdown 包裹 JSON、未知字段、混合结果、工具调用。

```ts
it('规划请求恒为空工具并严格解析文件任务', async () => {
  const provider = scriptedProvider({
    type: 'text',
    text: '{"kind":"file_task"}'
  });
  const adapter = new ConversationTurnAdapter(provider.model);

  await expect(adapter.plan(input('列出桌面文件'))).resolves.toEqual({
    kind: 'file_task'
  });
  expect(provider.requests[0]?.tools).toEqual([]);
});
```

非法结果预期固定为：

```ts
{
  kind: 'clarify',
  question: '我还不确定你是想聊天，还是希望我处理本地文件。可以再具体说明一下吗？'
}
```

- [ ] **Step 2：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-turn-adapter.test.ts
```

Expected: FAIL，原因是 Adapter 不存在。

- [ ] **Step 3：实现严格规划协议**

请求第一条系统消息固定说明：只输出单个 JSON 对象；聊天结果含 `kind/text`，澄清结果含 `kind/question`，文件任务仅含 `kind`；不得输出 Markdown、工具请求或其他字段。

使用严格 Zod 判别联合解析 `JSON.parse(response.text)`。以下任一情况返回固定澄清：

- Provider 返回工具调用；
- 文本不是单个 JSON 对象；
- 未知字段；
- 空回复或超长回复；
- 非法 emotion；
- 同时包含两类字段。

`chat_reply.text` 与 `clarify.question` 的上限固定为 8,000 个 Unicode 字符，确保单个 4,000 字用户输入与助手回复组成的完整回合不会超过 16,000 字符历史上限。

Provider 网络、认证、超时和取消错误继续抛出，不能伪装为澄清。

- [ ] **Step 4：运行 GREEN 与 Provider 回归**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-turn-adapter.test.ts tests/openai-provider.test.ts tests/provider-contract.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 5：任务交接与条件提交**

建议提交信息：`feat: 添加无工具对话规划适配器`。

---

### Task 4：扩展对话披露策略并建立 Adapter

**Requirements:** `CONV-DISCLOSE-001` 至 `CONV-DISCLOSE-006`、`CONV-SAFE-003`

**Files:**
- Modify: `apps/desktop/src/main/agent/disclosure-policy.ts`
- Modify: `apps/desktop/tests/privacy-and-proactivity.test.ts`
- Create: `apps/desktop/src/main/conversation/conversation-disclosure-adapter.ts`
- Create: `apps/desktop/tests/conversation-disclosure-adapter.test.ts`

**Interfaces:**
- Consumes: `DisclosurePolicy`、`PrivacySessionRegistry`、`ConversationHistory`
- Produces:

```ts
export type ConversationDisclosureResult =
  | { kind: 'ready'; messages: ModelMessage[] }
  | {
      kind: 'confirmation_required';
      requestId: string;
      targetProviderName: string;
      messageCount: number;
      characterCount: number;
    };

export class ConversationDisclosureAdapter {
  prepare(input: {
    requestId: string;
    targetProfileId: string;
    targetProviderIdentity: string;
    targetProviderName: string;
    history: ConversationHistory;
  }): ConversationDisclosureResult;

  resolve(input: {
    requestId: string;
    targetProfileId: string;
    decision: HistoryDisclosureDecision;
  }): ModelMessage[];

  reset(): void;
}
```

- [ ] **Step 1：为显式来源清单编写 RED**

在 `privacy-and-proactivity.test.ts` 增加测试，要求 `DisclosurePolicy` 能由 Main 显式提供保守来源身份，并仍绑定目标 Provider、requestId 与 session generation：

```ts
expect(() => policy.createManifestForSource(request, 'conversation:mixed'))
  .toThrow('DISCLOSURE_CROSS_PROVIDER_NOT_AUTHORIZED');
```

授权一次后第一次构造成功，第二次重放必须再次失败。

- [ ] **Step 2：运行策略 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/privacy-and-proactivity.test.ts
```

Expected: FAIL，原因是 `createManifestForSource` 不存在。

- [ ] **Step 3：最小扩展既有 DisclosurePolicy**

新增 Main-only 方法：

```ts
createManifestForSource(
  request: DisclosureRequest,
  sourceProviderIdentity: string
): DisclosureManifest
```

既有 `createManifest()` 继续从 `resolveCurrentSourceProvider()` 读取来源，然后委托同一私有实现。显式来源必须通过 `providerIdentitySchema`；不得暴露到 Renderer 或 preload。

- [ ] **Step 4：为 ConversationDisclosureAdapter 编写 RED**

覆盖：空历史、历史全部来自目标 Provider、混合来源、`share_once`、`current_message_only`、伪造 ID、过期 generation、reset 后重放。

来源计算规则固定为：

```ts
const sourceIdentity = sourceIds.size === 1
  ? [...sourceIds][0]!
  : 'conversation:mixed';
```

若唯一来源等于目标 Provider，直接返回历史；空历史同样直接返回。其他情况必须产生确认。

- [ ] **Step 5：实现 Adapter 并运行 GREEN**

`share_once` 创建 `scope:'request'`、`category:'conversation'`、`allowCrossProvider:true` 的 grant，再以精确 `itemCount` 和 `byteLength` 构造清单。`current_message_only` 返回空历史。任何私有任务数据均不进入此接口。

`characterCount` 使用 Unicode 字符数，仅用于 Renderer 摘要；`DisclosurePolicy` 的 `byteLength` 使用 `Buffer.byteLength(serializedHistory, 'utf8')`，不得把字符数误当字节数。

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/privacy-and-proactivity.test.ts tests/conversation-disclosure-adapter.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 6：任务交接与条件提交**

建议提交信息：`feat: 建立会话历史披露适配器`。

---

### Task 5：实现 Coordinator 的聊天、澄清与会话状态

**Requirements:** `CONV-SCOPE-001` 至 `CONV-SCOPE-003`、`CONV-ROUTE-001` 至 `CONV-ROUTE-004`、`CONV-CONCURRENCY-001`、`CONV-HISTORY-001` 至 `CONV-HISTORY-004`

**Files:**
- Create: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Create: `apps/desktop/tests/conversation-coordinator.test.ts`

**Interfaces:**
- Consumes:

```ts
interface ChatTurnFactory {
  create(signal: AbortSignal): Promise<{
    adapter: ConversationTurnAdapter;
    profileId: string;
    providerIdentity: string;
    providerName: string;
  }>;
}

interface ConversationFileTaskPort {
  onEvent(listener: (
    event: TaskEvent,
    generation: string
  ) => void): () => void;
  submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
  }): Promise<void>;
  cancelActive(): void;
  resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void>;
  resetForNewConversation(): Promise<void>;
}
```

- Produces:

```ts
export class ConversationCoordinator {
  submit(text: string): Promise<void>;
  cancelActive(): void;
  resolveFileAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void>;
  resolveHistoryDisclosure(
    requestId: string,
    decision: HistoryDisclosureDecision
  ): Promise<void>;
  resetConversation(): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1：为普通聊天和澄清编写 RED**

测试必须证明：

- 用户消息只广播一次；
- 状态顺序为 `listening → thinking → success`；
- `chat_reply` 加入完整回合；
- `clarify` 加入完整回合且不调用文件端口；
- 第二个并发提交得到 `TASK_ALREADY_ACTIVE`；
- Provider 错误不会调用文件端口；
- 事件携带当前 generation 的内部封装，旧 generation 不能写入历史。

```ts
await coordinator.submit('今天有点累');
expect(fileTasks.submit).not.toHaveBeenCalled();
expect(history.turns()).toEqual([
  expect.objectContaining({
    userText: '今天有点累',
    assistantText: '我在这里。'
  })
]);
```

- [ ] **Step 2：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-coordinator.test.ts
```

Expected: FAIL，原因是 Coordinator 不存在。

- [ ] **Step 3：实现最小状态机和聊天路径**

内部状态使用判别联合：

```ts
type ConversationState =
  | { kind: 'idle' }
  | { kind: 'running_chat'; generation: string; controller: AbortController }
  | { kind: 'awaiting_history_disclosure'; generation: string; requestId: string }
  | { kind: 'running_file_task'; generation: string }
  | { kind: 'awaiting_file_confirmation'; generation: string }
  | { kind: 'resetting'; generation: string }
  | { kind: 'closed' };
```

Coordinator 在调用 Chat Adapter 前通过 Disclosure Adapter 准备历史；若需要确认，保存当前文本、目标模型和 generation，不发送历史也不调用模型。

Coordinator 只订阅 `ConversationFileTaskPort.onEvent()`，并且只转发 generation 与当前会话匹配的文件事件；`AgentService` 不得再直接向 Renderer 广播。

- [ ] **Step 4：运行 GREEN**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-coordinator.test.ts tests/conversation-history.test.ts tests/conversation-turn-adapter.test.ts tests/conversation-disclosure-adapter.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 5：任务交接与条件提交**

建议提交信息：`feat: 建立对话协调器聊天闭环`。

---

### Task 6：将既有 AgentService 收敛为文件任务端口

**Requirements:** `CONV-SCOPE-004`、`CONV-ROUTE-004`、`CONV-ROUTE-005`、`CONV-SAFE-002`、`CONV-HISTORY-005`

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`
- Create: `apps/desktop/src/main/conversation/file-task-adapter.ts`
- Create: `apps/desktop/tests/file-task-adapter.test.ts`

**Interfaces:**
- Consumes: 既有 `AgentService`、授权根查询函数、获准可见 `ModelMessage[]`
- Produces: Task 5 的 `ConversationFileTaskPort`

- [ ] **Step 1：为 Coordinator 所有权编写 AgentService RED**

新增测试要求 `AgentService` 接收：

```ts
type AgentFileTaskSubmission = {
  text: string;
  visibleHistory: readonly ModelMessage[];
};
```

并证明：

- `AgentService` 不再重复发布用户消息和 `listening`；
- `AgentService` 的事件只交给 `FileTaskAdapter`，不再直接广播到 Renderer；
- `visibleHistory` 只追加在文件 Agent 系统提示之后、当前用户消息之前；
- 工具请求和工具结果不回写调用方历史；
- 现有确认、回收站和 Provider 总结流程不变。

- [ ] **Step 2：运行 AgentService RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/agent-service.test.ts
```

Expected: FAIL，原因是 `submit()` 尚不接受结构化文件任务输入且仍发布用户/倾听事件。

- [ ] **Step 3：最小调整 AgentService**

将公开入口改为：

```ts
submitFileTask(input: AgentFileTaskSubmission): Promise<void>
```

输入校验、文件确认、续跑、回收站事务和错误映射继续保留。`runContext()` 使用：

```ts
messages: [...session.messages, ...input.visibleHistory]
```

`AgentLoop.run(input.text, context)` 仍负责追加当前用户消息。删除不再使用的旧 `submit(text)`，不保留双路线。

- [ ] **Step 4：为 FileTaskAdapter 授权预检编写 RED**

```ts
await expect(adapter.submit({
  text: '列出桌面文件',
  visibleHistory: [],
  generation: 'g1'
})).rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

expect(agent.submitFileTask).not.toHaveBeenCalled();
```

另覆盖：授权存在、授权在二次会话创建时被撤销、文件数据类别拒绝、可见历史透传但不含任务私有数据。

- [ ] **Step 5：实现 FileTaskAdapter 并运行 GREEN**

Adapter 首先调用 Main-only `getAuthorizedRootPath()`；空值立即抛出带稳定 `code` 的 `FILE_AUTHORIZATION_REQUIRED`。存在时调用 `AgentService.submitFileTask()`；Agent 创建真实会话时继续重新读取授权根，防止检查与执行之间的授权变化。

`FileTaskAdapter` 通过工厂创建由自己持有的 `AgentService`：

```ts
createAgentService: (
  emit: (event: TaskEvent) => void
) => AgentService
```

Adapter 在开始文件任务时保存当前 generation，把所有 Agent 事件标记该 generation 后交给 `onEvent()` 订阅者；重置或关闭后清除订阅与活动 generation。这样旧文件任务事件不能绕过 Coordinator。

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/agent-service.test.ts tests/file-task-adapter.test.ts tests/file-task-transaction-coordinator.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 6：任务交接与条件提交**

建议提交信息：`refactor: 将文件 Agent 接入会话协调器`。

---

### Task 7：完成文件分流、确认与新对话原子重置

**Requirements:** `CONV-RESET-001` 至 `CONV-RESET-005`、`CONV-CONCURRENCY-001`、`CONV-SAFE-005`

**Files:**
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/src/main/conversation/file-task-adapter.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `apps/desktop/tests/file-task-adapter.test.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`

**Interfaces:**
- Consumes: Task 5 Coordinator 与 Task 6 File Task Port
- Produces: 完整 `file_task` 路径、文件确认委托与 `resetConversation()`

- [ ] **Step 1：为明确文件任务和披露恢复编写 RED**

覆盖：

- `file_task` 才调用文件端口；
- 缺少授权返回 `FILE_AUTHORIZATION_REQUIRED`；
- Agent Provider 跨来源时先确认；
- `share_once` 恢复原请求一次；
- `current_message_only` 传入空历史；
- 伪造、重复和旧 requestId 返回 `DISCLOSURE_REQUEST_EXPIRED`。

- [ ] **Step 2：为重置竞态编写 RED**

使用可控 Promise 覆盖：运行中聊天、等待披露、等待文件确认、动画提交前、不可逆执行中、旧 Provider 迟到回复。

```ts
const reset = coordinator.resetConversation();
oldProvider.resolve(chatReply('不得进入新会话'));
await reset;

expect(events).toContainEqual(expect.objectContaining({
  type: 'conversation_reset'
}));
expect(events).not.toContainEqual(expect.objectContaining({
  text: '不得进入新会话'
}));
```

- [ ] **Step 3：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-coordinator.test.ts tests/file-task-adapter.test.ts tests/agent-service.test.ts
```

Expected: FAIL，原因是文件分流和原子重置尚未组合。

- [ ] **Step 4：实现 generation 与安全重置**

固定顺序：

1. 生成新 generation 并先替换旧 generation；
2. 进入 `resetting`；
3. abort 活动对话请求；
4. Disclosure Adapter `reset()`；
5. File Task Adapter `resetForNewConversation()`；
6. 清空 History；
7. 广播 `conversation_reset`；
8. 进入 `idle`。

`AgentService.resetForNewConversation()` 在提交前取消事务并丢弃续跑令牌；已进入系统执行时等待当前 `activeFileTask` 结果 Promise 收敛，但禁止后续总结事件穿过旧 generation。

- [ ] **Step 5：运行 GREEN 与文件事务回归**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/conversation-coordinator.test.ts tests/file-task-adapter.test.ts tests/agent-service.test.ts tests/file-task-transaction-coordinator.test.ts tests/pending-action-store.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS。

- [ ] **Step 6：任务交接与条件提交**

建议提交信息：`feat: 完成文件分流与新对话重置`。

---

### Task 8：接入 Main、IPC 与 Preload 白名单

**Requirements:** `CONV-ROUTE-001`、`CONV-DISCLOSE-003`、`CONV-RESET-001`、`CONV-SAFE-004`

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/tests/agent-ipc.test.ts`
- Modify: `apps/desktop/tests/preload-api.test.ts`
- Modify: `apps/desktop/tests/main-lifecycle.test.ts`

**Interfaces:**
- Consumes: 完整 `ConversationCoordinator`
- Produces:

```ts
resetConversation(): Promise<void>;
resolveHistoryDisclosure(
  requestId: string,
  decision: HistoryDisclosureDecision
): Promise<void>;
```

- [ ] **Step 1：为 IPC 严格输入和委托编写 RED**

覆盖：合法决策、未知决策、未知字段、空/过长 requestId、重置、已发布错误吞吐边界。

```ts
await handlers.get(ipcChannels.conversationDisclosureResolve)?.({}, {
  requestId: 'request-1',
  decision: 'share_once',
  history: ['Renderer 不得提交正文']
});
```

预期严格 Schema 拒绝上述输入。

- [ ] **Step 2：为 preload 白名单编写 RED**

断言仅新增 `resetConversation` 和 `resolveHistoryDisclosure`；不得出现 `routeIntent`、`selectProvider`、`submitHistory` 或文件工具接口。

- [ ] **Step 3：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/agent-ipc.test.ts tests/preload-api.test.ts tests/main-lifecycle.test.ts
```

Expected: FAIL，原因是新通道和组合尚不存在。

- [ ] **Step 4：最小接入组合根**

在 Main 中把当前单一 `createSession` 拆为：

- `createChatTurn`：读取模型设置和密钥，使用 `router.select('chat')`，不读取授权根；
- `createAgentSession`：保留现有 Agent、文件工具和权限组合；
- `ConversationDisclosureAdapter`；
- `FileTaskAdapter`，由它持有 `AgentService` 并把事件标记 generation 后交给 Coordinator；
- `ConversationCoordinator`。

`registerAgentIpc` 改为只调用 Coordinator。删除 Main 直接把 `AgentService` 注册为聊天 IPC 的旧路线。应用退出顺序中先 `coordinator.close()`，再执行既有角色、Explorer 和窗口清理。

- [ ] **Step 5：运行 GREEN、类型检查与生产边界**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/agent-ipc.test.ts tests/preload-api.test.ts tests/main-lifecycle.test.ts tests/preload-production-boundary.test.ts
pnpm --filter @myself/desktop typecheck
pnpm --filter @myself/desktop build
```

Expected: PASS。

- [ ] **Step 6：任务交接与条件提交**

建议提交信息：`feat: 接入会话协调器 IPC`。

---

### Task 9：实现 Renderer 披露卡与新对话交互

**Requirements:** `CONV-SCOPE-001`、`CONV-DISCLOSE-002` 至 `CONV-DISCLOSE-004`、`CONV-RESET-001` 至 `CONV-RESET-003`

**Files:**
- Create: `apps/desktop/src/renderer/src/chat/HistoryDisclosureCard.tsx`
- Modify: `apps/desktop/src/renderer/src/chat/ChatPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/stores/task-store.ts`
- Modify: `apps/desktop/tests/renderer-task-store.test.ts`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`

**Interfaces:**
- Consumes: Task 1 事件、Task 8 preload 接口
- Produces:

```ts
type PendingHistoryDisclosure = {
  requestId: string;
  targetProviderName: string;
  messageCount: number;
  characterCount: number;
};
```

- [ ] **Step 1：为 Store 归约编写 RED**

覆盖：披露事件设置卡片；新披露替换旧卡必须被拒绝而不是静默覆盖；`conversation_reset` 清空消息、披露卡、文件确认卡和瞬态计时器；旧 generation 事件不恢复内容。

- [ ] **Step 2：为 UI 编写 RED**

断言：

- 仍只有一个 textarea；
- 不存在 Chat/Work 切换；
- 披露卡显示 Provider 名称、消息数和字符数，不显示正文；
- 两个按钮分别调用 `share_once` 与 `current_message_only`；
- “新对话”调用 reset 并在等待时禁用重复点击；
- `FILE_AUTHORIZATION_REQUIRED` 显示打开设置按钮，但不显示尚未实现的“此电脑”控件。

- [ ] **Step 3：运行 RED**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/renderer-task-store.test.ts tests/renderer-components.test.tsx
```

Expected: FAIL，原因是 Store 和 UI 尚不认识新事件。

- [ ] **Step 4：实现最小 Renderer 交互**

`HistoryDisclosureCard` 只接收展示 DTO 和两个回调。所有用户可见文案使用中文。`ChatPanel` 不实现路由逻辑；提交按钮在披露、文件确认、活动请求或重置期间禁用。

- [ ] **Step 5：运行 GREEN 与无障碍回归**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/renderer-task-store.test.ts tests/renderer-components.test.tsx tests/multi-provider-settings.test.tsx
pnpm --filter @myself/desktop typecheck
```

Expected: PASS；确认卡具有可访问标题、按钮名称和 `aria-live` 反馈。

- [ ] **Step 6：任务交接与条件提交**

建议提交信息：`feat: 添加会话披露与新对话界面`。

---

### Task 10：补全 Provider、安全与纵向集成门

**Requirements:** `CONV-SAFE-001` 至 `CONV-SAFE-005`、`CONV-DISCLOSE-005`、`CONV-DISCLOSE-006`、`CONV-SCOPE-002` 至 `CONV-SCOPE-004`

**Files:**
- Modify: `apps/desktop/tests/provider-contract.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/fixtures/provider-server.ts`
- Modify: `tests/fixtures/electron-app.ts`

**Interfaces:**
- Consumes: 完整生产组合
- Produces: 三类 Provider 契约、安全证据和 Chat/Clarify/File 纵向集成证据

- [ ] **Step 1：扩展 Provider 合同 RED**

对 OpenAI 兼容、Anthropic 和 Gemini 分别捕获规划请求，断言工具集合为空；返回合法 JSON、非法 JSON、工具调用和超时，验证只有合法 `file_task` 可升级。

- [ ] **Step 2：扩展安全门 RED**

在生产组合中注入会在调用时抛错的授权根读取器与 `PathPolicy` 工厂；普通聊天必须成功且两个依赖均未调用。加入唯一聊天正文、文件正文、密钥和绝对路径哨兵，断言捕获日志不含哨兵。

- [ ] **Step 3：扩展集成 RED**

覆盖：

1. 无授权普通聊天两轮上下文；
2. 模糊请求只澄清；
3. 明确文件任务无授权时返回 `FILE_AUTHORIZATION_REQUIRED`；
4. 有授权后执行既有只读文件任务；
5. 跨 Provider 只发送当前消息；
6. 跨 Provider 单次共享历史后授权被消费。

- [ ] **Step 4：运行 RED 并确认失败来自接线缺口**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/provider-contract.test.ts
pnpm test:security
pnpm test:integration
```

Expected: 新增用例 FAIL；既有用例不得新增失败。

- [ ] **Step 5：只修复纵向接线暴露的问题**

允许修改范围限于本计划已列出的 Conversation、Main 组合和测试 fixture。不得修改路径策略、回收站语义或降低安全断言。

- [ ] **Step 6：运行 GREEN**

Run:

```powershell
pnpm --filter @myself/desktop test -- --run tests/provider-contract.test.ts
pnpm test:security
pnpm test:integration
```

Expected: PASS。

- [ ] **Step 7：任务交接与条件提交**

建议提交信息：`test: 验证会话分流安全闭环`。

---

### Task 11：完成 Electron E2E、验收记录与完整门禁

**Requirements:** 全部 `CONV-*` 需求

**Files:**
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/fixtures/electron-app.ts`
- Create: `docs/operations/conversation-routing-acceptance.md`

**Interfaces:**
- Consumes: 完整生产功能
- Produces: Electron 纵向证据、自动门结果和待人工清单

- [ ] **Step 1：编写 Electron E2E RED**

使用隔离 userData 和脚本 Provider，覆盖：

- 未授权时至少三轮普通聊天；
- “帮我整理一下”出现澄清且临时目录无变化；
- 明确文件请求出现授权引导；
- 不同 Chat/Agent Provider 的两种披露决策；
- 模型请求挂起时点击“新对话”，释放旧响应后不回流；
- 待确认文件动作时新建对话，旧 actionId 被拒绝且文件不变；
- 现有回收站搬运成功路径继续通过。

- [ ] **Step 2：运行 E2E RED**

Run:

```powershell
pnpm test:e2e:desktop
```

Expected: 新场景因 E2E 探针或接线缺失而 FAIL；记录精确失败，不修改超时掩盖问题。

- [ ] **Step 3：补足最小 E2E 可观察性**

只允许在既有固定 E2E 参数下暴露去标识化字段：generation、公开阶段、可见消息数量、是否存在披露卡、是否存在文件确认卡。不得暴露聊天正文、Provider 密钥、历史正文、文件路径或能力令牌。生产 preload 边界测试必须证明无 E2E 参数时不存在探针。

- [ ] **Step 4：运行聚焦 E2E GREEN**

Run:

```powershell
pnpm test:e2e:desktop
```

Expected: 全部 Electron E2E PASS，无残留 Electron/Node 测试进程。

- [ ] **Step 5：运行完整自动门**

按顺序运行，避免并发 Electron：

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:security
pnpm test:integration
pnpm test:e2e:desktop
pnpm verify:behavior
```

Expected: 全部 PASS。不得运行 `verify:website`。

- [ ] **Step 6：编写中文验收记录**

`docs/operations/conversation-routing-acceptance.md` 必须记录：

- 日期、系统、分支基线；
- 每道自动门命令、通过数、跳过数和耗时；
- Chat/Clarify/File/Disclosure/Reset 场景证据；
- 日志脱敏证据；
- 未执行的 Windows 人工验收，不得虚构通过。

- [ ] **Step 7：执行人工验收交接**

交给用户的清单：

1. 无授权连续三轮聊天并观察上下文；
2. 模糊请求只澄清；
3. 明确文件任务引导设置；
4. 跨 Provider 两种披露选择；
5. 请求中与文件确认中分别新建对话；
6. 完成一次真实安全文件任务；
7. 检查日志不含测试正文、密钥和绝对路径。

- [ ] **Step 8：完成前验证与条件提交**

重新运行与最终声明直接相关的验证命令，检查：

```powershell
git diff --check
git status --short
git diff --name-only -- apps/website
```

网站 diff 必须为空。若用户已明确授权 Git 写操作，建议最终提交：

```powershell
git add tests/e2e/desktop.spec.ts tests/fixtures/electron-app.ts docs/operations/conversation-routing-acceptance.md
git commit -m "test: 验收自由聊天与文件任务分流"
```

未获授权时不执行提交，只提供建议提交边界。

---

## 2. 规格覆盖矩阵

| 需求 | 实施任务 |
| --- | --- |
| `CONV-SCOPE-001` | Task 5、9 |
| `CONV-SCOPE-002`、`CONV-SCOPE-003` | Task 3、5、10 |
| `CONV-SCOPE-004` | Task 6、7、10 |
| `CONV-ROUTE-001` | Task 1、5、8 |
| `CONV-ROUTE-002`、`CONV-ROUTE-003` | Task 3、5 |
| `CONV-ROUTE-004`、`CONV-ROUTE-005` | Task 6、7 |
| `CONV-HISTORY-001` 至 `CONV-HISTORY-005` | Task 2、5、6、10 |
| `CONV-DISCLOSE-001` 至 `CONV-DISCLOSE-006` | Task 1、4、7、9、10 |
| `CONV-RESET-001` 至 `CONV-RESET-005` | Task 1、7、8、9、11 |
| `CONV-CONCURRENCY-001` | Task 5、7 |
| `CONV-SAFE-001` 至 `CONV-SAFE-005` | Task 3、4、7、8、10、11 |

## 3. 子智能体执行顺序

共享核心文件存在顺序依赖，必须按以下顺序串行执行：

```text
Task 1 → Task 2 → Task 3 → Task 4 → Task 5
       → Task 6 → Task 7 → Task 8 → Task 9
       → Task 10 → Task 11
```

每个任务采用独立实现子智能体，并在进入下一任务前完成：

1. 实现子智能体提交 RED、GREEN 和验证证据；
2. 规格审查子智能体逐项核对本任务需求编号；
3. 代码质量审查子智能体检查最小修改、深模块接口、安全边界和测试质量；
4. 审查问题交回原实现子智能体修正；
5. 两道审查均通过后关闭该实现任务。

Task 2、3、4 的文件互不重叠，但不得为了追求并行而提前实施；Task 5 的接口依赖三者真实结果，串行执行能避免计划接口与实际实现漂移。

## 4. 完成定义

只有同时满足以下条件，才能声明本计划完成：

- 规格覆盖矩阵中的每项需求均有自动或明确人工证据；
- 普通聊天在无授权范围时完成三轮多轮上下文；
- 普通聊天请求工具列表恒为空且不读取授权根；
- 模糊规划只澄清，非法规划不能进入文件任务；
- 文件任务继续经过授权、隐私、确认和回收站事务；
- 可见历史有界、仅驻留 Main 内存；
- 私有工具上下文未进入共享历史或披露；
- 跨 Provider 历史只能在单次确认后发送；
- 新对话使旧 generation、旧请求、旧确认和旧能力令牌失效；
- 不可逆文件执行保持真实结果，不伪造取消；
- 全部自动门通过，人工未执行项如实记录；
- 网站目录无变更，未运行网站验证；
- 没有为旧聊天单路线保留兼容壳或重复入口。

## 5. 后续独立计划门

本计划验收后，才为“单文件夹授权 / 此电脑授权”编写独立设计与实施计划。该后续计划以根 `CONTEXT.md` 为领域基准，不得在本计划中预埋磁盘枚举、受保护目录黑名单、根标识或卷身份实现。
