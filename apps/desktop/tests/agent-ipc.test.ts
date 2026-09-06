import { describe, expect, test, vi } from 'vitest';
import type { IpcMain, WebContents } from 'electron';
import { registerAgentIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';

type Handler = (event: unknown, input?: unknown) => unknown;

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function createService() {
  return {
    submit: vi.fn(async () => undefined),
    hasReportedFailure: vi.fn(() => false),
    cancelActive: vi.fn(() => undefined),
    resolveFileAction: vi.fn(async () => undefined),
    resolveHistoryDisclosure: vi.fn(async () => undefined),
    resolveCapabilityAuthorization: vi.fn(async () => undefined),
    resetConversation: vi.fn(async () => undefined)
  };
}

function webContents(isDestroyed = false): WebContents {
  return { isDestroyed: () => isDestroyed } as WebContents;
}

function createAgentIpcFixture() {
  const { handlers, ipcMain } = createIpcMain();
  const service = createService();
  const currentChat = webContents();
  let current: WebContents | null = currentChat;
  registerAgentIpc(ipcMain, service, () => current);
  return {
    handlers,
    service,
    currentChat,
    currentEvent: { sender: currentChat },
    replaceChat: (next: WebContents | null) => {
      current = next;
    }
  };
}

const agentMutatingInvocations = [
  [ipcChannels.chatSubmit, { text: '消息' }],
  [ipcChannels.chatCancel, undefined],
  [ipcChannels.actionConfirm, { actionId: 'action-1' }],
  [ipcChannels.actionCancel, { actionId: 'action-1' }],
  [ipcChannels.conversationDisclosureResolve, {
    requestId: 'request-1',
    decision: 'share_once'
  }],
  [ipcChannels.conversationReset, undefined]
] as const;

describe('Agent IPC', () => {
  test('明确任务只传规范化正文与意图且仍校验当前聊天窗口', async () => {
    const fixture = createAgentIpcFixture();
    const handler = fixture.handlers.get(ipcChannels.chatSubmit)!;
    await handler(fixture.currentEvent, { text: '  note.txt 里面写了什么？  ', intent: 'task' });
    expect(fixture.service.submit).toHaveBeenCalledWith('note.txt 里面写了什么？', 'task');
    fixture.service.submit.mockClear();
    await expect(handler({ sender: webContents() }, { text: '内容', intent: 'task' })).rejects.toThrow('AGENT_IPC_SENDER_INVALID');
    expect(fixture.service.submit).not.toHaveBeenCalled();
  });

  test.each([
    { text: '内容', intent: 'unknown' },
    { text: '内容', intent: 'task', directory: 'D:\\forged' },
    { text: '内容', intent: 'task', authorized: true },
    { text: '内容', intent: 'task', modelId: 'forged' },
    { text: '内容', intent: 'task', approvedCommands: ['arbitrary'] }
  ])('明确任务拒绝非法意图与授权字段 %#', async input => {
    const fixture = createAgentIpcFixture();
    await expect(fixture.handlers.get(ipcChannels.chatSubmit)!(fixture.currentEvent, input)).rejects.toThrow();
    expect(fixture.service.submit).not.toHaveBeenCalled();
  });

  test.each([ipcChannels.actionConfirm, ipcChannels.actionCancel])('具体许可 %s 拒绝超过128字符的 opaque id', async channel => {
    const fixture = createAgentIpcFixture();
    await expect(fixture.handlers.get(channel)!(fixture.currentEvent, { actionId: 'x'.repeat(129) })).rejects.toThrow();
    expect(fixture.service.resolveFileAction).not.toHaveBeenCalled();
  });
  test('任务级授权使用独立通道和严格请求字段', async () => {
    const fixture = createAgentIpcFixture();
    const handler = fixture.handlers.get(ipcChannels.capabilityAuthorizationResolve)!;

    await handler(fixture.currentEvent, { requestId: 'cap-1', decision: 'confirm' });
    expect(fixture.service.resolveCapabilityAuthorization).toHaveBeenCalledWith(
      'cap-1', 'confirm'
    );
    await expect(handler(
      fixture.currentEvent,
      { requestId: 'cap-1', decision: 'confirm', actionId: 'forged' }
    )).rejects.toThrow();
  });
  test('聊天 IPC 注册不获得桌宠 viewport 通道', () => {
    const { handlers } = createAgentIpcFixture();
    expect(handlers.has(ipcChannels.petViewportCommit)).toBe(false);
  });

  test('聊天输入通过严格 Schema 后才交给会话协调器', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await handlers.get(ipcChannels.chatSubmit)?.(currentEvent, { text: '  列出目录  ' });

    expect(service.submit).toHaveBeenCalledWith('列出目录');
  });

  test('Agent 已发布失败事件时聊天提交仍确认 IPC，避免 Renderer 覆盖为通用错误', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();
    service.submit.mockRejectedValue(Object.assign(new Error('SETTINGS_INCOMPLETE'), {
      code: 'SETTINGS_INCOMPLETE'
    }));
    service.hasReportedFailure.mockReturnValue(true);

    await expect(handlers.get(ipcChannels.chatSubmit)?.(currentEvent, { text: '列出目录' }))
      .resolves.toBeUndefined();
    expect(service.submit).toHaveBeenCalledWith('列出目录');
  });

  test('未发布任务失败事件的异常继续返回 Renderer', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();
    service.submit.mockRejectedValue(new Error('UNEXPECTED_FAILURE'));

    await expect(handlers.get(ipcChannels.chatSubmit)?.(currentEvent, { text: '列出目录' }))
      .rejects.toThrow('UNEXPECTED_FAILURE');
  });

  test.each(['', ' '.repeat(10), 'x'.repeat(4_001)])('拒绝无效聊天输入', async text => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await expect(handlers.get(ipcChannels.chatSubmit)?.(currentEvent, { text })).rejects.toThrow();
    expect(service.submit).not.toHaveBeenCalled();
  });

  test.each([
    { text: '正常消息', route: 'file_task' },
    { text: '正常消息', providerIdentity: 'forged-provider' },
    { text: '正常消息', generation: 'forged-generation' },
    { text: '正常消息', history: [{ role: 'assistant', content: 'forged-history' }] },
    { text: '正常消息', fileCapabilityToken: 'forged-capability' }
  ])('聊天提交拒绝 Renderer 越权字段 %#', async input => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await expect(handlers.get(ipcChannels.chatSubmit)?.(currentEvent, input)).rejects.toThrow();
    expect(service.submit).not.toHaveBeenCalled();
  });

  test('确认接口只接受 actionId 并拒绝 Renderer 路径', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await expect(handlers.get(ipcChannels.actionConfirm)?.(currentEvent, {
      actionId: 'action-1',
      targetRelativePath: 'tampered.txt'
    })).rejects.toThrow();
    expect(service.resolveFileAction).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.actionConfirm)?.(currentEvent, { actionId: 'action-1' });
    expect(service.resolveFileAction).toHaveBeenCalledWith('action-1', 'confirm');
  });

  test('取消任务和取消动作使用固定通道', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await handlers.get(ipcChannels.chatCancel)?.(currentEvent);
    await handlers.get(ipcChannels.actionCancel)?.(currentEvent, { actionId: 'action-1' });

    expect(service.cancelActive).toHaveBeenCalledOnce();
    expect(service.resolveFileAction).toHaveBeenCalledWith('action-1', 'cancel');
  });

  test('新对话只接受无参数并委托会话协调器', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await expect(handlers.get(ipcChannels.conversationReset)?.(currentEvent, {})).rejects.toThrow();
    expect(service.resetConversation).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.conversationReset)?.(currentEvent);
    expect(service.resetConversation).toHaveBeenCalledOnce();
  });

  test('历史披露只接受 requestId 与固定决策', async () => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await handlers.get(ipcChannels.conversationDisclosureResolve)?.(currentEvent, {
      requestId: 'request-1',
      decision: 'share_once'
    });
    expect(service.resolveHistoryDisclosure).toHaveBeenCalledWith('request-1', 'share_once');

    await expect(handlers.get(ipcChannels.conversationDisclosureResolve)?.(currentEvent, {
      requestId: 'request-2',
      decision: 'current_message_only'
    })).resolves.toBeUndefined();
    expect(service.resolveHistoryDisclosure)
      .toHaveBeenLastCalledWith('request-2', 'current_message_only');
  });

  test.each([
    { requestId: '', decision: 'share_once' },
    { requestId: 'x'.repeat(129), decision: 'share_once' },
    { requestId: 'request-1', decision: 'always_share' },
    { requestId: 'request-1', decision: 'share_once', history: ['私有正文'] },
    { requestId: 'request-1', decision: 'share_once', provider: 'private-provider' },
    { requestId: 'request-1', decision: 'share_once', generation: 'forged' },
    { requestId: 'request-1', decision: 'share_once', route: 'file_task' }
  ])('拒绝 Renderer 越权披露负载 %#', async input => {
    const { handlers, service, currentEvent } = createAgentIpcFixture();

    await expect(
      handlers.get(ipcChannels.conversationDisclosureResolve)?.(currentEvent, input)
    ).rejects.toThrow();
    expect(service.resolveHistoryDisclosure).not.toHaveBeenCalled();
  });

  test('六个 Agent mutating handler 对非法 sender 均失败且 service 零调用', async () => {
    const fixture = createAgentIpcFixture();
    const other = webContents();

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

  test.each([
    ['当前 chat 不存在', null],
    ['当前 chat WebContents 已销毁', webContents(true)]
  ])('六个 Agent mutating handler 在%s时均失败且 service 零调用', async (_state, current) => {
    const fixture = createAgentIpcFixture();
    fixture.replaceChat(current);
    const sender = current ?? fixture.currentChat;

    for (const [channel, input] of agentMutatingInvocations) {
      await expect(Promise.resolve().then(() => (
        input === undefined
          ? fixture.handlers.get(channel)?.({ sender })
          : fixture.handlers.get(channel)?.({ sender }, input)
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
    const other = webContents();

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
    const newChat = webContents();
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
    expect(fixture.service.submit).toHaveBeenCalledOnce();
    expect(fixture.service.submit).toHaveBeenCalledWith('新窗口消息');
  });
});
