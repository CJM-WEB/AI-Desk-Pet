# 会话事件按窗口投影实施计划

> **面向执行智能体：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务执行；每个任务独立完成 RED、GREEN、复审和验证。Git 写操作需要用户另行明确授权。

**目标：** 将验证后的 `TaskEvent` 完整投递给 chat、以严格 phase 投影投递给 pet，并停止向 settings 与 character workshop 投递会话事件。

**架构：** `ConversationEventProjection` 使用现有 `taskEventSchema` 先验证，再调用 Main 内部角色行为服务，并按窗口发送。Preload 在 Renderer 边界再次 safeParse。模块无状态，不缓存、不重放、不实现展示恢复。

**技术栈：** Electron 43、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、pnpm workspace。

## 全局约束

- 批准规格：[会话事件按窗口投影设计](../specs/2026-08-15-conversation-event-projection-design.md)。
- 总规格：[AI Pet 桌宠架构优化与恢复开发门设计](../specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md)。
- 前置：[A2 计划](2026-08-15-current-chat-agent-ipc-authorization.md) 已完整执行并通过。
- 复用 A2 唯一 `getCurrentChatWebContents`，不建立第二份 chat 身份来源。
- Main 内部 `CharacterBehaviorService` 继续消费完整验证事件；pet Renderer 只收 phase。
- `taskEventSchema` 保持唯一 Schema owner；`MyselfApi` 签名不变。
- 一个目标失败不阻止另一个目标，失败日志不带事件正文。
- 本计划不包含 snapshot、revision、reload hydrate、持久化或重放。
- 新投影通过门后同批删除旧四窗口广播，不保留双轨。

---

### 任务 1：建立无状态会话事件投影器

**文件：**

- 新建：`apps/desktop/src/main/conversation/conversation-event-projection.ts`
- 新建：`apps/desktop/tests/conversation-event-projection.test.ts`

**接口：**

```ts
type TaskEventTarget = Pick<WebContents, 'isDestroyed' | 'send'>;

type ConversationEventProjectionOptions = Readonly<{
  getChatTarget(): TaskEventTarget | null;
  getPetTarget(): TaskEventTarget | null;
  applyCharacterBehavior(event: TaskEvent): void;
  reportDeliveryFailure?(target: 'chat' | 'pet'): void;
}>;

export class ConversationEventProjection {
  constructor(private readonly options: ConversationEventProjectionOptions) {}
  publish(rawEvent: unknown): TaskEvent;
}
```

- [ ] **步骤 1：写完整事件矩阵 RED**

新增以下测试：

```ts
function target() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  };
}

const validPendingFileActionEvent = {
  type: 'pending_action',
  action: {
    category: 'file',
    actionId: 'action-file-1',
    conversationId: 'conversation-1',
    risk: 'write',
    operation: 'create_file',
    summary: '创建测试文件',
    targetRelativePath: 'safe.txt',
    contentCharacters: 4,
    contentPreview: 'safe',
    contentPreviewSuppressedReason: null,
    previewTruncated: false,
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:05:00.000Z'
  }
} as const;

const validPowerShellActionEvent = {
  type: 'pending_action',
  action: {
    category: 'powershell',
    actionId: 'action-shell-1',
    conversationId: 'conversation-1',
    risk: 'shell',
    operation: 'powershell',
    summary: '运行测试命令',
    command: 'Write-Output safe',
    workingDirectoryLabel: '已授权工作目录',
    runMode: 'foreground',
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:05:00.000Z'
  }
} as const;

const validHistoryDisclosureEvent = {
  type: 'history_disclosure_required',
  requestId: 'request-1',
  targetProviderName: '目标模型',
  messageCount: 2,
  characterCount: 16
} as const;

test('pet 只接收 phase 且不接收票据命令正文或披露请求', () => {
  const chat = target();
  const pet = target();
  const applyCharacterBehavior = vi.fn();
  const projection = new ConversationEventProjection({
    getChatTarget: () => chat,
    getPetTarget: () => pet,
    applyCharacterBehavior
  });
  const phase = { type: 'phase', phase: 'awaiting_confirmation' } as const;
  projection.publish(phase);
  expect(chat.send).toHaveBeenCalledWith(ipcChannels.taskEvent, phase);
  expect(pet.send).toHaveBeenCalledWith(ipcChannels.taskEvent, phase);

  pet.send.mockClear();
  projection.publish(validPendingFileActionEvent);
  projection.publish(validPowerShellActionEvent);
  projection.publish(validHistoryDisclosureEvent);
  expect(pet.send).not.toHaveBeenCalled();
  expect(applyCharacterBehavior).toHaveBeenCalledWith(validPendingFileActionEvent);
});

test('无效 TaskEvent 在任何副作用前失败关闭', () => {
  const chat = target();
  const pet = target();
  const applyCharacterBehavior = vi.fn();
  const projection = new ConversationEventProjection({
    getChatTarget: () => chat,
    getPetTarget: () => pet,
    applyCharacterBehavior
  });
  expect(() => projection.publish({ type: 'phase', phase: 'thinking', actionId: 'leak' }))
    .toThrow();
  expect(applyCharacterBehavior).not.toHaveBeenCalled();
  expect(chat.send).not.toHaveBeenCalled();
  expect(pet.send).not.toHaveBeenCalled();
});

test('目标发送失败按窗口隔离且报告不含事件', () => {
  const chat = target();
  const pet = target();
  chat.send.mockImplementation(() => { throw new Error('PRIVATE_PAYLOAD'); });
  const reportDeliveryFailure = vi.fn();
  const projection = new ConversationEventProjection({
    getChatTarget: () => chat,
    getPetTarget: () => pet,
    applyCharacterBehavior: vi.fn(),
    reportDeliveryFailure
  });
  projection.publish({ type: 'phase', phase: 'thinking' });
  expect(reportDeliveryFailure).toHaveBeenCalledWith('chat');
  expect(pet.send).toHaveBeenCalledWith(
    ipcChannels.taskEvent,
    { type: 'phase', phase: 'thinking' }
  );
});
```

在同一文件定义 `validPendingFileActionEvent`、`validPowerShellActionEvent` 和 `validHistoryDisclosureEvent` 为完整合法常量；再用 `test.each` 对 phase、message、error、character_emotion、character_carrying、conversation_reset 补齐 chat 完整投递矩阵。日期字段使用固定合法 ISO 字符串，不放本机路径。

核心断言：chat `send(taskEvent,event)`；pet 只对 phase 发送严格二字段对象；行为 spy 接收解析后的完整事件；invalid 时全部 spy 为零；发送失败 reporter 只收到目标枚举。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-event-projection.test.ts
```

预期：投影模块不存在，测试失败。

- [ ] **步骤 3：实现最小 GREEN**

实现 `taskEventSchema.parse`、Main 行为调用、chat 完整投递、pet phase 投递和单目标发送异常隔离。settings/workshop 不出现在 options 或实现中。

发送辅助函数只接收目标枚举、目标对象和已验证事件；catch 只调用 `reportDeliveryFailure(target)`，不传原异常。

- [ ] **步骤 4：运行 GREEN**

重复步骤 2 的命令。预期：全部通过。

- [ ] **步骤 5：检查深度边界**

确认类中没有 event 数组、revision、timer、retry、queue 或持久化字段；没有复制 TaskEvent Schema。

---

### 任务 2：用投影器替换 Main 四窗口广播

**文件：**

- 修改：`apps/desktop/src/main/index.ts:733-741`
- 修改：`apps/desktop/tests/window-security.test.ts:248-255`
- 修改：`tests/e2e/desktop.spec.ts`

**接口：**

- 消费：任务 1 `ConversationEventProjection`
- 消费：A2 `getCurrentChatWebContents`
- 保留：`CharacterBehaviorService.handleTaskEvent(event: TaskEvent): void`
- 产出：Main 唯一会话事件窗口投递 owner

- [ ] **步骤 1：写四窗口投影 E2E RED**

新增测试：

```ts
for (const [name, page] of Object.entries({
  pet: petPage,
  chat: chatPage,
  settings: settingsPage,
  characters: charactersPage
})) {
  await page.evaluate(view => {
    const scope = globalThis as typeof globalThis & {
      __projectedTaskEvents?: Record<string, unknown[]>;
    };
    scope.__projectedTaskEvents ??= {};
    scope.__projectedTaskEvents[view] = [];
    window.myself.onTaskEvent(event => scope.__projectedTaskEvents?.[view]?.push(event));
  }, name);
}

await submitChatMessage(chatPage, '创建 projection-privacy.txt');
await expect(chatPage.getByRole('region', { name: '创建文件 projection-privacy.txt' }))
  .toBeVisible();

const readEvents = (page: Page, view: string) => page.evaluate(key => (
  globalThis as typeof globalThis & { __projectedTaskEvents?: Record<string, unknown[]> }
).__projectedTaskEvents?.[key] ?? [], view);
const petEvents = await readEvents(petPage, 'pet');
expect(petEvents.every(event => (
  JSON.stringify(Object.keys(event as object).sort()) === JSON.stringify(['phase', 'type'])
))).toBe(true);
expect(await readEvents(settingsPage, 'settings')).toEqual([]);
expect(await readEvents(charactersPage, 'characters')).toEqual([]);
```

在 pet、chat、settings、characters 四页分别订阅 `onTaskEvent`，触发普通聊天、文件确认和 PowerShell 确认。断言：

- chat 收到 message、pending_action 和 phase。
- pet 所有事件的排序键严格等于 `['phase', 'type']`。
- settings 和 characters 事件数组严格为空。
- 三个非 chat 数组的 JSON 不含 actionId、command、contentPreview、diffPreview、requestId、Provider 名、正文 sentinel 或绝对授权路径。

- [ ] **步骤 2：写 Main wiring RED**

将静态装配断言改为：存在 `ConversationEventProjection` 实例和 `publish(event)`；不存在旧 `[pet, chat, settings, characterWorkshopWindows.getCurrent()]` taskEvent 广播循环。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-event-projection.test.ts tests/window-security.test.ts
```

```powershell
pnpm.cmd --filter '@myself/desktop' build
```

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "会话任务事件只向 chat"
```

预期：当前 Main 仍全量广播，settings/workshop 与 pet 隐私断言失败。

- [ ] **步骤 4：接入最小 GREEN**

在 Main 中实例化投影器：

```ts
const conversationEventProjection = new ConversationEventProjection({
  getChatTarget: getCurrentChatWebContents,
  getPetTarget: () => (
    pet.isDestroyed() || pet.webContents.isDestroyed() ? null : pet.webContents
  ),
  applyCharacterBehavior: event => characterBehavior.handleTaskEvent(event),
  reportDeliveryFailure: target => console.error(
    '投递会话公开事件失败。',
    target === 'chat'
      ? 'CHAT_TASK_EVENT_DELIVERY_FAILED'
      : 'PET_TASK_EVENT_DELIVERY_FAILED'
  )
});
```

将 emitter 收敛为：

```ts
const emitConversationEvent = (event: TaskEvent): void => {
  const validated = conversationEventProjection.publish(event);
  if (validated.type === 'error') reportedSubmitErrorCode = validated.code;
};
```

删除原 `characterBehavior.handleTaskEvent(event)` 直调和四窗口广播循环，避免重复行为与双投递。

- [ ] **步骤 5：运行 GREEN**

重复步骤 3 的三条命令。预期：单测、wiring 和定向 E2E 全部通过。

---

### 任务 3：Preload 对 TaskEvent 进行运行时解析

**文件：**

- 修改：`apps/desktop/src/preload/index.ts:1-7,143-147`
- 修改：`apps/desktop/tests/preload-api.test.ts`

**接口：**

- 保持：`MyselfApi.onTaskEvent(listener: (event: TaskEvent) => void): () => void`
- 新运行时边界：`taskEventSchema.safeParse(payload: unknown)`

- [ ] **步骤 1：扩展 ipcRenderer 测试夹具**

为 mock 增加 `removeListener`，并从 `on.mock.calls` 取得 `ipcChannels.taskEvent` 的真实 handler。

- [ ] **步骤 2：写 Preload RED**

```ts
test('合法 TaskEvent 解析后只通知一次监听者', () => {
  const listener = vi.fn();
  const release = exposedApi!.onTaskEvent(listener);
  const handler = on.mock.calls.find(([channel]) => channel === ipcChannels.taskEvent)?.[1];
  handler?.({}, { type: 'phase', phase: 'thinking' });
  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith({ type: 'phase', phase: 'thinking' });
  release();
});

test('畸形 TaskEvent 不进入 Renderer listener', () => {
  const listener = vi.fn();
  exposedApi!.onTaskEvent(listener);
  const handler = on.mock.calls.find(([channel]) => channel === ipcChannels.taskEvent)?.[1];
  handler?.({}, { type: 'phase', phase: 'thinking', absolutePath: 'private' });
  expect(listener).not.toHaveBeenCalled();
});

test('退订只移除同一个 taskEvent handler', () => {
  const release = exposedApi!.onTaskEvent(vi.fn());
  const handler = on.mock.calls.find(([channel]) => channel === ipcChannels.taskEvent)?.[1];
  release();
  expect(removeListener).toHaveBeenCalledWith(ipcChannels.taskEvent, handler);
});
```

畸形输入覆盖未知 type、phase 额外键、pending action 缺字段和额外绝对路径字段。listener 零调用；测试不要求输出 payload 日志。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/preload-api.test.ts
```

预期：当前直接类型断言会把畸形 payload 交给 listener，测试失败。

- [ ] **步骤 4：实现最小 GREEN**

把 `taskEventSchema` 作为运行时 import；handler 参数改为 unknown；safeParse 成功才调用 listener。保持退订函数和公开 API 键顺序不变。

- [ ] **步骤 5：运行 GREEN**

重复步骤 3 的命令。预期：全部通过。

---

### 任务 4：行为、安全与旧路径删除总门

**文件：**

- 验证：`apps/desktop/tests/character-behavior-service.test.ts`
- 验证：`tests/integration/desktop-agent.test.ts`
- 验证：`tests/e2e/desktop.spec.ts`
- 更新：本规格对应的日期化验收记录，仅记录实际执行结果

**接口：**

- 保护：Main 行为服务继续接收完整验证 TaskEvent。
- 保护：pet 通过 `characterMotionEvent` 保持行为动作和 carrying 快照。
- 依赖：A2 已知 actionId 跨窗口拒绝测试继续通过。

- [ ] **步骤 1：运行定向单元回归**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc-authorization.test.ts tests/agent-ipc.test.ts tests/conversation-event-projection.test.ts tests/preload-api.test.ts tests/window-security.test.ts tests/character-behavior-service.test.ts
```

- [ ] **步骤 2：运行类型、包、安全和集成门**

```powershell
pnpm.cmd --filter '@myself/desktop' typecheck
pnpm.cmd --filter '@myself/desktop' test
pnpm.cmd test:security
pnpm.cmd test:integration
```

- [ ] **步骤 3：运行关键 Electron E2E**

```powershell
pnpm.cmd --filter '@myself/desktop' build
```

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "只有当前聊天窗口|会话任务事件只向 chat|自主行为|搬运"
```

断言 A2 known-action、防泄漏投影、listening/thinking/success/error 行为和 carrying 均通过。

- [ ] **步骤 4：运行完整桌面与行为门**

```powershell
pnpm.cmd verify:desktop
pnpm.cmd verify:behavior
```

- [ ] **步骤 5：验证旧路径已删除**

```powershell
rg -n "ipcChannels\.taskEvent" apps/desktop/src/main
rg -n "characterWorkshopWindows\.getCurrent\(\).*taskEvent|\[pet, chat, settings" apps/desktop/src/main/index.ts
```

预期：Main 的 taskEvent 窗口发送 owner 只有投影模块；第二条命令无旧广播命中。新投影测试和 E2E 全绿后，不保留旧循环、runtime flag 或兼容 wrapper。

- [ ] **步骤 6：检查范围和格式**

```powershell
git diff --check
git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase
```

预期：格式检查通过；网站与云端业务差异命令无输出。Git 命令只读。

---

## A3 旧广播删除门

旧四窗口 taskEvent 广播只有在以下条件全部满足时删除，并在任务 2 同批完成：

1. 八类合法事件与非法事件投影测试通过。
2. pet 只收 phase、settings/workshop 零事件的 E2E 通过。
3. A2 已知真实 actionId 跨窗口拒绝 E2E 继续通过。
4. CharacterBehavior、characterMotion、自主行为和 carrying 回归通过。
5. Preload runtime Schema 测试通过。

删除对象：Main 中直接 `characterBehavior.handleTaskEvent(event)` 加四窗口 taskEvent 循环的旧组合。新投影器成为唯一组合 owner；`CharacterBehaviorService` 自身和 `MyselfApi.onTaskEvent` 不删除。

## A2 → A3 依赖验收

A3 开始前必须看到 A2 六通道和已知 actionId E2E 的当前运行证据。A3 完成后再次运行同一 A2 E2E：actionId 从 chat 获取，再由非 chat 调用，确保授权测试不会因为 pet 已拿不到票据而假绿。
