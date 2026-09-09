import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MyselfApi } from '../src/shared/myself-api';
import { ipcChannels } from '../src/shared/ipc-channels';
import { DEFAULT_WORKSHOP_LAYOUT } from '../src/shared/workshop-layout-ipc';

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
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
  test('只接受合法 token 与关闭原因，并把监听器决定写入固定确认', async () => {
    let releaseFlush: (result: boolean) => void = () => undefined;
    const flushPending = new Promise<boolean>(resolve => {
      releaseFlush = resolve;
    });
    const flushDraft = vi.fn(() => flushPending);
    const unsubscribe = exposedApi?.onCharacterWorkshopFlushRequested(flushDraft);
    const [channel, handler] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    expect(channel).toBe(ipcChannels.characterWorkshopFlushRequest);
    handler({}, { token: 7, reason: 'window_close' });
    handler({}, { token: 'flush-token', reason: 'unknown' });
    expect(flushDraft).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    handler({}, { token: 'flush-token', reason: 'window_close' });
    expect(flushDraft).toHaveBeenCalledWith('window_close');
    expect(send).not.toHaveBeenCalled();

    releaseFlush(true);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        ipcChannels.characterWorkshopFlushAcknowledgement,
        { token: 'flush-token', ok: true }
      );
    });

    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(channel, handler);
  });

  test('监听器拒绝关闭或抛错时均通过固定 ACK 报告未放行', async () => {
    const rejectClose = vi.fn(async () => false);
    exposedApi?.onCharacterWorkshopFlushRequested(rejectClose);
    let [, handler] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    handler({}, { token: 'denied-token', reason: 'window_close' });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        ipcChannels.characterWorkshopFlushAcknowledgement,
        { token: 'denied-token', ok: false }
      );
    });

    on.mockClear();
    send.mockClear();
    const flushDraft = vi.fn(async () => {
      throw new Error('SAVE_FAILED');
    });
    exposedApi?.onCharacterWorkshopFlushRequested(flushDraft);
    [, handler] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    handler({}, { token: 'failed-token', reason: 'app_quit' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        ipcChannels.characterWorkshopFlushAcknowledgement,
        { token: 'failed-token', ok: false }
      );
    });
    expect(flushDraft).toHaveBeenCalledWith('app_quit');
  });

  test('只暴露两个工作台布局方法，并把读取结果解析为严格布局契约', async () => {
    invoke.mockResolvedValueOnce(DEFAULT_WORKSHOP_LAYOUT);

    await expect(exposedApi?.getWorkshopLayout()).resolves.toEqual(DEFAULT_WORKSHOP_LAYOUT);
    expect(invoke).toHaveBeenCalledWith(ipcChannels.settingsWorkshopLayoutGet, {});
    expect(
      Object.keys(exposedApi ?? {}).filter(key => key.toLowerCase().includes('workshoplayout'))
    ).toEqual(['getWorkshopLayout', 'saveWorkshopLayout']);
  });

  test('工作台布局方法拒绝带私有字段或非法数值的 IPC payload', async () => {
    invoke.mockResolvedValueOnce({
      ...DEFAULT_WORKSHOP_LAYOUT,
      privatePath: 'C:\\private'
    });
    await expect(exposedApi?.getWorkshopLayout()).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ...DEFAULT_WORKSHOP_LAYOUT,
      stageHeight: Number.NaN
    });
    await expect(exposedApi?.saveWorkshopLayout(DEFAULT_WORKSHOP_LAYOUT)).rejects.toThrow();
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      ipcChannels.settingsWorkshopLayoutSave,
      DEFAULT_WORKSHOP_LAYOUT
    );
  });
});
