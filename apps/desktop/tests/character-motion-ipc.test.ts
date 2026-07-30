import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';
import { registerCharacterMotionIpc } from '../src/main/ipc/register-ipc';

type Handler = (event: unknown, input?: unknown) => unknown;
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, on, removeListener }
}));

await import('../src/preload/index');

function snapshot(revision = 1) {
  return {
    revision,
    timestampMs: 100,
    position: { x: 10, y: 20 },
    target: { x: 30, y: 40 },
    direction: 'right' as const,
    moving: true,
    carrying: false
  };
}

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    ipcMain: {
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
    } as unknown as IpcMain
  };
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe('角色运动严格 IPC', () => {
  test('Main 只接受空输入并严格校验无路径快照结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { id: 1 };
    const service = {
      getSnapshot: vi.fn(() => snapshot()),
      reportPlayedAction: vi.fn(async () => undefined)
    };
    registerCharacterMotionIpc(ipcMain, service, petSender as never);
    const handler = handlers.get(ipcChannels.characterMotionSnapshotGet);

    await expect(handler?.({}, {})).resolves.toEqual({ snapshot: snapshot() });
    await expect(handler?.({}, { x: 1 })).rejects.toMatchObject({
      code: 'CHARACTER_INPUT_INVALID'
    });
    service.getSnapshot.mockReturnValueOnce({
      ...snapshot(),
      path: 'C:\\private'
    } as never);
    await expect(handler?.({}, {})).rejects.toMatchObject({
      code: 'CHARACTER_OPERATION_FAILED'
    });

    const report = handlers.get(ipcChannels.characterActionPlayed);
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a'
    })).resolves.toEqual({ ok: true });
    expect(service.reportPlayedAction).toHaveBeenCalledWith('opaque-token', 'idle-a');
    await expect(report?.({ sender: { id: 2 } }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a'
    })).rejects.toThrow('CHARACTER_PLAYBACK_SENDER_INVALID');
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a',
      path: 'C:\\private'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
  });

  test('preload 只暴露快照读取和固定事件订阅，不暴露任意坐标写入', async () => {
    invoke.mockResolvedValueOnce({ snapshot: snapshot() });
    await expect(exposedApi?.getCharacterMotionSnapshot()).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterMotionSnapshotGet, {});
    expect(exposedApi).not.toHaveProperty('setPosition');
    expect(exposedApi).not.toHaveProperty('moveCharacterTo');

    const listener = vi.fn();
    const unsubscribe = exposedApi?.subscribeCharacterMotion(listener);
    const wrapped = on.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => void;
    wrapped({ sender: '不得暴露' }, { type: 'snapshot', snapshot: snapshot(2) });
    wrapped({}, { type: 'unknown', path: 'C:\\private' });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: 'snapshot',
      snapshot: snapshot(2)
    });
    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(
      ipcChannels.characterMotionEvent,
      wrapped
    );
  });
});
