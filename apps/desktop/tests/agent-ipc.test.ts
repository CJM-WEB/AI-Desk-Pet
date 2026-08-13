import { describe, expect, test, vi } from 'vitest';
import type { IpcMain } from 'electron';
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
    resetConversation: vi.fn(async () => undefined)
  };
}

describe('Agent IPC', () => {
  test('聊天输入通过严格 Schema 后才交给会话协调器', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await handlers.get(ipcChannels.chatSubmit)?.({}, { text: '  列出目录  ' });

    expect(service.submit).toHaveBeenCalledWith('列出目录');
  });

  test('Agent 已发布失败事件时聊天提交仍确认 IPC，避免 Renderer 覆盖为通用错误', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    service.submit.mockRejectedValue(Object.assign(new Error('SETTINGS_INCOMPLETE'), {
      code: 'SETTINGS_INCOMPLETE'
    }));
    service.hasReportedFailure.mockReturnValue(true);
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.chatSubmit)?.({}, { text: '列出目录' }))
      .resolves.toBeUndefined();
    expect(service.submit).toHaveBeenCalledWith('列出目录');
  });

  test('未发布任务失败事件的异常继续返回 Renderer', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    service.submit.mockRejectedValue(new Error('UNEXPECTED_FAILURE'));
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.chatSubmit)?.({}, { text: '列出目录' }))
      .rejects.toThrow('UNEXPECTED_FAILURE');
  });

  test.each(['', ' '.repeat(10), 'x'.repeat(4_001)])('拒绝无效聊天输入', async text => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.chatSubmit)?.({}, { text })).rejects.toThrow();
    expect(service.submit).not.toHaveBeenCalled();
  });

  test.each([
    { text: '正常消息', route: 'file_task' },
    { text: '正常消息', providerIdentity: 'forged-provider' },
    { text: '正常消息', generation: 'forged-generation' },
    { text: '正常消息', history: [{ role: 'assistant', content: 'forged-history' }] },
    { text: '正常消息', fileCapabilityToken: 'forged-capability' }
  ])('聊天提交拒绝 Renderer 越权字段 %#', async input => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.chatSubmit)?.({}, input)).rejects.toThrow();
    expect(service.submit).not.toHaveBeenCalled();
  });

  test('确认接口只接受 actionId 并拒绝 Renderer 路径', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.actionConfirm)?.({}, {
      actionId: 'action-1',
      targetRelativePath: 'tampered.txt'
    })).rejects.toThrow();
    expect(service.resolveFileAction).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.actionConfirm)?.({}, { actionId: 'action-1' });
    expect(service.resolveFileAction).toHaveBeenCalledWith('action-1', 'confirm');
  });

  test('取消任务和取消动作使用固定通道', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await handlers.get(ipcChannels.chatCancel)?.({});
    await handlers.get(ipcChannels.actionCancel)?.({}, { actionId: 'action-1' });

    expect(service.cancelActive).toHaveBeenCalledOnce();
    expect(service.resolveFileAction).toHaveBeenCalledWith('action-1', 'cancel');
  });

  test('新对话只接受无参数并委托会话协调器', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.conversationReset)?.({}, {})).rejects.toThrow();
    expect(service.resetConversation).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.conversationReset)?.({});
    expect(service.resetConversation).toHaveBeenCalledOnce();
  });

  test('历史披露只接受 requestId 与固定决策', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await handlers.get(ipcChannels.conversationDisclosureResolve)?.({}, {
      requestId: 'request-1',
      decision: 'share_once'
    });
    expect(service.resolveHistoryDisclosure).toHaveBeenCalledWith('request-1', 'share_once');

    await expect(handlers.get(ipcChannels.conversationDisclosureResolve)?.({}, {
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
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(
      handlers.get(ipcChannels.conversationDisclosureResolve)?.({}, input)
    ).rejects.toThrow();
    expect(service.resolveHistoryDisclosure).not.toHaveBeenCalled();
  });
});
