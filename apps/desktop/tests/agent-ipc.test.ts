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
    cancelActive: vi.fn(() => undefined),
    confirm: vi.fn(async () => undefined),
    cancelAction: vi.fn(() => undefined)
  };
}

describe('Agent IPC', () => {
  test('聊天输入通过 Schema 后才交给 AgentService', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await handlers.get(ipcChannels.chatSubmit)?.({}, { text: '  列出目录  ' });

    expect(service.submit).toHaveBeenCalledWith('列出目录');
  });

  test.each(['', ' '.repeat(10), 'x'.repeat(4_001)])('拒绝无效聊天输入', async text => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.chatSubmit)?.({}, { text })).rejects.toThrow();
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
    expect(service.confirm).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.actionConfirm)?.({}, { actionId: 'action-1' });
    expect(service.confirm).toHaveBeenCalledWith('action-1');
  });

  test('取消任务和取消动作使用固定通道', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = createService();
    registerAgentIpc(ipcMain, service);

    await handlers.get(ipcChannels.chatCancel)?.({});
    await handlers.get(ipcChannels.actionCancel)?.({}, { actionId: 'action-1' });

    expect(service.cancelActive).toHaveBeenCalledOnce();
    expect(service.cancelAction).toHaveBeenCalledWith('action-1');
  });
});
