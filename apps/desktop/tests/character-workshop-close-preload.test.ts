import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MyselfApi } from '../src/shared/myself-api';
import { ipcChannels } from '../src/shared/ipc-channels';

const invoke = vi.fn(async () => undefined);
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, send, on, removeListener }
}));

await import('../src/preload/index');

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
  on.mockClear();
  removeListener.mockClear();
});

describe('角色工作室关闭握手 Preload 边界', () => {
  test('只接受带字符串 token 的固定请求，并在 flush 完成后确认', async () => {
    let releaseFlush = (): void => {};
    const flushPending = new Promise<void>(resolve => {
      releaseFlush = resolve;
    });
    const flushDraft = vi.fn(() => flushPending);
    const unsubscribe = exposedApi?.onCharacterWorkshopFlushRequested(flushDraft);
    const [channel, handler] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    expect(channel).toBe(ipcChannels.characterWorkshopFlushRequest);
    handler({}, { token: 7 });
    expect(flushDraft).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    handler({}, { token: 'flush-token' });
    expect(flushDraft).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    releaseFlush();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        ipcChannels.characterWorkshopFlushAcknowledgement,
        { token: 'flush-token', ok: true }
      );
    });

    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(channel, handler);
  });

  test('flushDraft 拒绝时通过固定 ACK 报告失败且不产生未处理拒绝', async () => {
    const flushDraft = vi.fn(async () => {
      throw new Error('SAVE_FAILED');
    });
    exposedApi?.onCharacterWorkshopFlushRequested(flushDraft);
    const [, handler] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    handler({}, { token: 'failed-token' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        ipcChannels.characterWorkshopFlushAcknowledgement,
        { token: 'failed-token', ok: false }
      );
    });
  });
});
