import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createCharacterWorkshopCloseHandshake
} from '../src/main/windows/character-workshop-close';

type CloseListener = (event: { preventDefault(): void }) => void;
type IpcListener = (
  event: { sender: FakeWebContents },
  payload: unknown
) => void;

class FakeWebContents {
  readonly send = vi.fn();

  isDestroyed(): boolean {
    return false;
  }
}

class FakeWindow {
  readonly webContents = new FakeWebContents();
  readonly hide = vi.fn();
  private closeListener: CloseListener | null = null;

  isDestroyed(): boolean {
    return false;
  }

  on(event: 'close', listener: CloseListener): this {
    if (event === 'close') this.closeListener = listener;
    return this;
  }

  closeByUser(): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { preventDefault: vi.fn() };
    this.closeListener?.(event);
    return event;
  }
}

function createIpcDouble() {
  const listeners = new Map<string, IpcListener>();
  return {
    ipc: {
      on: vi.fn((channel: string, listener: IpcListener) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string, listener: IpcListener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      })
    },
    emit(channel: string, sender: FakeWebContents, payload: unknown): void {
      listeners.get(channel)?.({ sender }, payload);
    }
  };
}

const requestChannel = 'character-workshop:flush-request';
const acknowledgementChannel = 'character-workshop:flush-acknowledgement';

afterEach(() => {
  vi.useRealTimers();
});

describe('角色工作室关闭握手', () => {
  test('用户关闭时等待相同 sender 和 token 的成功确认后才隐藏窗口', async () => {
    const ipc = createIpcDouble();
    const window = new FakeWindow();
    const reportError = vi.fn();
    const handshake = createCharacterWorkshopCloseHandshake({
      ipcMain: ipc.ipc,
      requestChannel,
      acknowledgementChannel,
      timeoutMs: 100,
      createToken: () => 'close-token',
      reportError
    });
    handshake.bindWindow(window, () => false);

    const closeEvent = window.closeByUser();

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(requestChannel, {
      token: 'close-token',
      reason: 'window_close'
    });
    expect(window.hide).not.toHaveBeenCalled();

    ipc.emit(acknowledgementChannel, new FakeWebContents(), {
      token: 'close-token',
      ok: true
    });
    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'other-token',
      ok: true
    });
    await Promise.resolve();
    expect(window.hide).not.toHaveBeenCalled();

    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'close-token',
      ok: true
    });
    await vi.waitFor(() => expect(window.hide).toHaveBeenCalledOnce());
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  test('用户关闭与退出链并发时，退出链在关闭判断后独立请求显式保存', async () => {
    const ipc = createIpcDouble();
    const window = new FakeWindow();
    const handshake = createCharacterWorkshopCloseHandshake({
      ipcMain: ipc.ipc,
      requestChannel,
      acknowledgementChannel,
      timeoutMs: 100,
      createToken: vi.fn()
        .mockReturnValueOnce('close-token')
        .mockReturnValueOnce('quit-token')
    });
    handshake.bindWindow(window, () => false);

    window.closeByUser();
    const beforeQuitFlush = handshake.flush(window);

    expect(window.webContents.send).toHaveBeenCalledWith(requestChannel, {
      token: 'close-token',
      reason: 'window_close'
    });
    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'close-token',
      ok: false
    });

    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(
      requestChannel,
      { token: 'quit-token', reason: 'app_quit' }
    ));
    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'quit-token',
      ok: true
    });
    await expect(beforeQuitFlush).resolves.toBe(true);
    expect(window.hide).not.toHaveBeenCalled();
  });

  test('Renderer 拒绝窗口关闭时视为正常交互，不记录错误也不隐藏', async () => {
    const ipc = createIpcDouble();
    const window = new FakeWindow();
    const reportError = vi.fn();
    const handshake = createCharacterWorkshopCloseHandshake({
      ipcMain: ipc.ipc,
      requestChannel,
      acknowledgementChannel,
      timeoutMs: 100,
      createToken: () => 'failed-token',
      reportError
    });
    handshake.bindWindow(window, () => false);

    window.closeByUser();
    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'failed-token',
      ok: false
    });

    await vi.waitFor(() => expect(reportError).not.toHaveBeenCalled());
    expect(window.hide).not.toHaveBeenCalled();
  });

  test('Renderer 无响应时在超时后记录错误但保持窗口打开', async () => {
    vi.useFakeTimers();
    const ipc = createIpcDouble();
    const window = new FakeWindow();
    const reportError = vi.fn();
    const handshake = createCharacterWorkshopCloseHandshake({
      ipcMain: ipc.ipc,
      requestChannel,
      acknowledgementChannel,
      timeoutMs: 50,
      createToken: () => 'timeout-token',
      reportError
    });
    handshake.bindWindow(window, () => false);

    window.closeByUser();
    await vi.advanceTimersByTimeAsync(49);
    expect(window.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(window.hide).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'CHARACTER_WORKSHOP_FLUSH_TIMEOUT'
    }));
  });

  test('退出应用请求携带 app_quit，失败时仍保留原有错误证据', async () => {
    const ipc = createIpcDouble();
    const window = new FakeWindow();
    const reportError = vi.fn();
    const handshake = createCharacterWorkshopCloseHandshake({
      ipcMain: ipc.ipc,
      requestChannel,
      acknowledgementChannel,
      timeoutMs: 100,
      createToken: () => 'quit-token',
      reportError
    });

    const flushing = handshake.flush(window);
    expect(window.webContents.send).toHaveBeenCalledWith(requestChannel, {
      token: 'quit-token',
      reason: 'app_quit'
    });
    ipc.emit(acknowledgementChannel, window.webContents, {
      token: 'quit-token',
      ok: false
    });

    await expect(flushing).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'CHARACTER_WORKSHOP_FLUSH_FAILED'
    }));
  });
});

describe('角色工作室关闭握手接入', () => {
  test('用户关闭和 before-quit 使用同一个握手，Renderer 不再依赖 beforeunload', async () => {
    const [main, renderer] = await Promise.all([
      readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
      readFile(new URL(
        '../src/renderer/src/characters/workshop/CharacterWorkshopView.tsx',
        import.meta.url
      ), 'utf8')
    ]);

    expect(main).toContain(
      'prepare: window => workshopCloseHandshake.bindWindow(window, () => isQuitting)'
    );
    expect(main).toContain(
      'async () => { await workshopCloseHandshake.flush(characterWorkshopWindows.getCurrent()); }'
    );
    expect(renderer).not.toContain("window.addEventListener('beforeunload'");
  });
});
