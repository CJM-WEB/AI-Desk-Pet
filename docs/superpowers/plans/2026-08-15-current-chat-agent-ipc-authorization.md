# 当前聊天窗口 Agent IPC 授权实施计划

> **面向执行智能体：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务执行；每个任务独立完成 RED、GREEN、复审和验证。Git 写操作需要用户另行明确授权。

**目标：** 为六个 Agent mutating IPC 增加动态当前聊天窗口授权，确保非 chat 和被替换的旧 chat 无法触发任何会话业务调用。

**架构：** Electron Main 中的 `AgentIpcAuthorization` 每次调用动态读取当前 chat WebContents。`registerAgentIpc` 强制接收该授权器，并在参数解析与 service 调用前执行。现有会话、确认、文件与 PowerShell 权威保持不变。

**技术栈：** Electron 43、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、pnpm workspace。

## 全局约束

- 批准规格：[当前聊天窗口 Agent IPC 授权设计](../specs/2026-08-15-current-chat-agent-ipc-authorization-design.md)。
- 总规格：[AI Pet 桌宠架构优化与恢复开发门设计](../specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md)。
- A2 完整通过后才实施 [A3 计划](2026-08-15-conversation-event-projection.md)。
- 普通 close 仅 hide 并复用同一 BrowserWindow；旧 sender 仅指 BrowserWindow 已销毁并由新窗口替换后的旧 WebContents。
- handler 必须先授权，再解析参数，再调用 service。
- 错误与日志只使用固定码，不包含票据、命令、正文、路径或 Provider 信息。
- 保持共享 Preload 与 `MyselfApi` 不变；保持现有 `lockNavigation`。
- 本计划不包含 snapshot、revision、事件恢复或通用 IPC 重写。
- 每个任务先运行定向测试；未观察的人工项记录为“待用户人工确认”。

---

### 任务 1：建立动态当前聊天窗口授权器

**文件：**

- 新建：`apps/desktop/src/main/ipc/agent-ipc-authorization.ts`
- 新建：`apps/desktop/tests/agent-ipc-authorization.test.ts`

**接口：**

- 输入：`() => WebContents | null`
- 输出：`assertCurrentChatSender(event: Pick<IpcMainInvokeEvent, 'sender'>): void`
- 稳定失败：`AGENT_IPC_SENDER_INVALID`

- [ ] **步骤 1：写授权器 RED 测试**

新增以下测试：

```ts
function webContents(destroyed = false): WebContents {
  return { isDestroyed: () => destroyed } as WebContents;
}

test('拒绝未注册的聊天窗口且不缓存空身份', () => {
  const sender = webContents();
  const authorization = new AgentIpcAuthorization(() => null);
  expect(() => authorization.assertCurrentChatSender({ sender }))
    .toThrow('AGENT_IPC_SENDER_INVALID');
});

test('拒绝已销毁的当前聊天 WebContents', () => {
  const sender = webContents(true);
  const authorization = new AgentIpcAuthorization(() => sender);
  expect(() => authorization.assertCurrentChatSender({ sender }))
    .toThrow('AGENT_IPC_SENDER_INVALID');
});

test('窗口替换后旧 sender 立即失效且新 sender 立即生效', () => {
  const oldChat = webContents();
  const newChat = webContents();
  let current: WebContents | null = oldChat;
  const authorization = new AgentIpcAuthorization(() => current);
  expect(() => authorization.assertCurrentChatSender({ sender: oldChat })).not.toThrow();

  current = newChat;
  expect(() => authorization.assertCurrentChatSender({ sender: oldChat }))
    .toThrow('AGENT_IPC_SENDER_INVALID');
  expect(() => authorization.assertCurrentChatSender({ sender: newChat })).not.toThrow();
});

test.each(['pet', 'settings', 'workshop'])(
  '拒绝 %s 等非当前聊天 sender',
  () => {
    const currentChat = webContents();
    const other = webContents();
    const authorization = new AgentIpcAuthorization(() => currentChat);
    expect(() => authorization.assertCurrentChatSender({ sender: other }))
      .toThrow('AGENT_IPC_SENDER_INVALID');
  }
);
```

核心断言：null、destroyed 和非同一对象均抛固定码；可变 `current` 从 old 切换到 new 后，old 从成功变为失败，new 成功。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc-authorization.test.ts
```

预期：因授权器模块不存在或接口未实现而失败。

- [ ] **步骤 3：实现最小 GREEN**

```ts
import type { IpcMainInvokeEvent, WebContents } from 'electron';

export class AgentIpcAuthorization {
  constructor(
    private readonly getCurrentChatWebContents: () => WebContents | null
  ) {}

  assertCurrentChatSender(event: Pick<IpcMainInvokeEvent, 'sender'>): void {
    const current = this.getCurrentChatWebContents();
    if (!current || current.isDestroyed() || event.sender !== current) {
      throw new Error('AGENT_IPC_SENDER_INVALID');
    }
  }
}
```

- [ ] **步骤 4：运行 GREEN**

重复步骤 2 的命令。预期：全部通过。

- [ ] **步骤 5：检查任务完成条件**

确认实现没有窗口角色表、URL 策略、日志、缓存或通用授权抽象。未取得 Git 写授权时仅报告差异，不执行 add 或 commit。

---

### 任务 2：六个 Agent handler 先授权后解析

**文件：**

- 修改：`apps/desktop/src/main/ipc/register-ipc.ts:102-141`
- 修改：`apps/desktop/tests/agent-ipc.test.ts`

**接口：**

- 消费：`AgentIpcAuthorization['assertCurrentChatSender']`
- 产出：

```ts
export function registerAgentIpc(
  ipcMain: IpcMain,
  service: AgentIpcService,
  authorization: Pick<AgentIpcAuthorization, 'assertCurrentChatSender'>
): void;
```

- [ ] **步骤 1：把现有测试夹具改为显式当前 sender**

测试夹具创建 `currentChat`、可变 getter、授权器和 `{ sender: currentChat }`。所有既有成功用例显式传当前 sender；第三参数不得提供默认值。

- [ ] **步骤 2：写六通道 RED 矩阵**

```ts
function createAgentIpcFixture() {
  const { handlers, ipcMain } = createIpcMain();
  const service = createService();
  const currentChat = { isDestroyed: () => false } as WebContents;
  let current: WebContents | null = currentChat;
  const authorization = new AgentIpcAuthorization(() => current);
  registerAgentIpc(ipcMain, service, authorization);
  return {
    handlers,
    service,
    currentChat,
    replaceChat: (next: WebContents | null) => { current = next; }
  };
}

test('六个 Agent mutating handler 对非法 sender 均失败且 service 零调用', async () => {
  const fixture = createAgentIpcFixture();
  const other = { isDestroyed: () => false } as WebContents;
  for (const [channel, input] of agentMutatingInvocations) {
    await expect(Promise.resolve().then(() => (
      input === undefined
        ? fixture.handlers.get(channel)?.({ sender: other })
        : fixture.handlers.get(channel)?.({ sender: other }, input)
    ))).rejects.toThrow('AGENT_IPC_SENDER_INVALID');
  }
  expect(fixture.service.submit).not.toHaveBeenCalled();
  expect(fixture.service.hasReportedFailure).not.toHaveBeenCalled();
  expect(fixture.service.cancelActive).not.toHaveBeenCalled();
  expect(fixture.service.resolveFileAction).not.toHaveBeenCalled();
  expect(fixture.service.resolveHistoryDisclosure).not.toHaveBeenCalled();
  expect(fixture.service.resetConversation).not.toHaveBeenCalled();
});

test('授权先于敏感负载解析', async () => {
  const fixture = createAgentIpcFixture();
  const other = { isDestroyed: () => false } as WebContents;
  await expect(Promise.resolve().then(() => fixture.handlers.get(
    ipcChannels.actionConfirm
  )?.({ sender: other }, {
    actionId: '',
    targetRelativePath: 'private.txt'
  }))).rejects.toThrow('AGENT_IPC_SENDER_INVALID');
  expect(fixture.service.resolveFileAction).not.toHaveBeenCalled();
});

test('旧 chat sender 在窗口替换后不能调用任一 Agent mutating handler', async () => {
  const fixture = createAgentIpcFixture();
  const oldChat = fixture.currentChat;
  const newChat = { isDestroyed: () => false } as WebContents;
  fixture.replaceChat(newChat);
  for (const [channel, input] of agentMutatingInvocations) {
    await expect(Promise.resolve().then(() => (
      input === undefined
        ? fixture.handlers.get(channel)?.({ sender: oldChat })
        : fixture.handlers.get(channel)?.({ sender: oldChat }, input)
    ))).rejects.toThrow('AGENT_IPC_SENDER_INVALID');
  }
  await expect(fixture.handlers.get(ipcChannels.chatSubmit)?.(
    { sender: newChat },
    { text: '新窗口消息' }
  )).resolves.toBeUndefined();
});
```

表驱动以下通道和合法最小参数：

```ts
const agentMutatingInvocations = [
  [ipcChannels.chatSubmit, { text: '消息' }],
  [ipcChannels.chatCancel, undefined],
  [ipcChannels.actionConfirm, { actionId: 'action-1' }],
  [ipcChannels.actionCancel, { actionId: 'action-1' }],
  [ipcChannels.conversationDisclosureResolve,
    { requestId: 'request-1', decision: 'share_once' }],
  [ipcChannels.conversationReset, undefined]
] as const;
```

用 `Promise.resolve().then(() => handler(...))` 统一同步和异步 handler。非法 sender 时固定授权错误优先于 Zod 错误，`submit`、`cancelActive`、`resolveFileAction`、`resolveHistoryDisclosure`、`resetConversation` 和 `hasReportedFailure` 全部零调用。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc.test.ts tests/agent-ipc-authorization.test.ts
```

预期：当前 handler 未调用授权器，RED 矩阵失败。

- [ ] **步骤 4：接入最小 GREEN**

为 `registerAgentIpc` 增加必需第三参数。六个 handler 的第一条业务语句统一为：

```ts
authorization.assertCurrentChatSender(event);
```

保留既有 Schema、错误吞吐和 service 调用逻辑，不调整其他 IPC。

- [ ] **步骤 5：运行 GREEN 与既有 Agent IPC 回归**

重复步骤 3 的命令。预期：新旧用例全部通过。

---

### 任务 3：Main 动态装配与已知票据 Electron 验收

**文件：**

- 修改：`apps/desktop/src/main/index.ts:252-253,589-602,807-828`
- 修改：`apps/desktop/tests/window-security.test.ts:248-255`
- 修改：`tests/e2e/desktop.spec.ts`

**接口：**

- 产出：`getCurrentChatWebContents(): WebContents | null`
- 消费：任务 1 授权器、任务 2 三参数 `registerAgentIpc`
- 后续：A3 复用同一个 getter，不创建第二份 chat 身份来源。

- [ ] **步骤 1：写 Main wiring RED**

将静态装配测试命名为：

```ts
it('Main 用动态当前 chat 授权器注册 Coordinator 入口', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  expect(main).toContain('new AgentIpcAuthorization(getCurrentChatWebContents)');
  expect(main).toContain(
    'registerAgentIpc(ipcMain, conversationIpcService, agentIpcAuthorization)'
  );
  expect(main).not.toContain('registerAgentIpc(ipcMain, conversationIpcService);');
});
```

断言 Main 实例化 `AgentIpcAuthorization(getCurrentChatWebContents)`，使用三参数 `registerAgentIpc`，且旧两参数调用不存在。

- [ ] **步骤 2：写跨窗口已知 actionId E2E RED**

新增测试：

```ts
await chatPage.evaluate(() => {
  const scope = globalThis as typeof globalThis & { __pendingActionId?: string };
  window.myself.onTaskEvent(event => {
    if (event.type === 'pending_action') scope.__pendingActionId = event.action.actionId;
  });
});
await submitChatMessage(chatPage, '创建 sender-guard.txt');
await expect.poll(() => chatPage.evaluate(() => (
  globalThis as typeof globalThis & { __pendingActionId?: string }
).__pendingActionId)).toBeTruthy();
const actionId = await chatPage.evaluate(() => (
  globalThis as typeof globalThis & { __pendingActionId?: string }
).__pendingActionId!);

for (const page of [petPage, settingsPage, charactersPage]) {
  const error = await page.evaluate(async id => {
    try {
      await window.myself.confirmAction(id);
      return null;
    } catch (caught) {
      return String(caught);
    }
  }, actionId);
  expect(error).toContain('AGENT_IPC_SENDER_INVALID');
}
await expect(chatPage.getByRole('region', { name: '创建文件 sender-guard.txt' }))
  .toBeVisible();
expect(await pathExistsForAssertion(join(authorizedRootDirectory, 'sender-guard.txt')))
  .toBe(false);
```

在 chat 订阅 `pending_action` 并保存真实 `actionId`；从 pet、settings、characters 页面分别调用 `confirmAction(actionId)`。三次调用均拒绝并包含固定授权码，确认卡仍存在且文件未创建；最后由 chat 确认按钮执行，文件才出现。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/window-security.test.ts
```

```powershell
pnpm.cmd --filter '@myself/desktop' build
```

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "只有当前聊天窗口"
```

预期：Main 尚未装配授权器，测试失败。

- [ ] **步骤 4：实现 Main 最小装配**

导入 `WebContents` 类型与 `AgentIpcAuthorization`，定义唯一动态 getter，实例化授权器，并向 `registerAgentIpc` 传第三参数。保持 `ensureChatWindow`、hide/open 和其他窗口生命周期原样。

- [ ] **步骤 5：运行 GREEN**

重复步骤 3 的三条命令。预期：定向单测和 E2E 全部通过。

- [ ] **步骤 6：执行 A2 阶段门**

```powershell
pnpm.cmd --filter '@myself/desktop' typecheck
pnpm.cmd --filter '@myself/desktop' test
pnpm.cmd test:security
pnpm.cmd test:integration
```

完成条件：六通道非法 sender service 零调用、已知票据跨窗口攻击失败、当前 chat 正常。BrowserWindow 真实销毁替换未人工观察时记录为“待用户人工确认”。

---

## A2 旧路径删除门

满足以下条件后，在任务 2/3 同批删除旧入口，不保留双轨：

1. 授权器动态身份测试通过。
2. 六通道 RED 矩阵转绿。
3. 已知 actionId E2E 转绿。
4. 所有现有 `registerAgentIpc` 消费者已传授权器。

删除对象：两参数 `registerAgentIpc` 调用方式和不带 sender 校验的 handler 实现。不得保留 optional authorization、默认放行或运行时开关。

## A2 完整验证

```powershell
pnpm.cmd verify:desktop
git diff --check
git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase
rg -n "registerAgentIpc\(" apps/desktop/src apps/desktop/tests tests
```

预期：`verify:desktop` 通过；网站与云端差异命令无输出；每个注册调用都有明确授权依赖。Git 命令仅做只读检查。
