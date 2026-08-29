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
