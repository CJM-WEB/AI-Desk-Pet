import { describe, expect, test, vi } from 'vitest';
import { configureSingleInstance } from '../src/main/single-instance';

function appDouble(lockGranted: boolean) {
  let secondInstance: (() => void) | undefined;
  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => lockGranted),
      quit: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'second-instance') secondInstance = listener;
      })
    },
    emitSecondInstance: () => secondInstance?.()
  };
}

describe('桌面应用单实例门禁', () => {
  test('锁失败时立即退出且不注册第二实例回调', () => {
    const fixture = appDouble(false);

    expect(configureSingleInstance(fixture.app, () => null)).toBe(false);

    expect(fixture.app.quit).toHaveBeenCalledOnce();
    expect(fixture.app.on).not.toHaveBeenCalled();
  });

  test('第二实例请求会恢复、显示并聚焦现有桌宠窗口', () => {
    const fixture = appDouble(true);
    const pet = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    };

    expect(configureSingleInstance(fixture.app, () => pet)).toBe(true);
    fixture.emitSecondInstance();

    expect(pet.restore).toHaveBeenCalledOnce();
    expect(pet.show).toHaveBeenCalledOnce();
    expect(pet.focus).toHaveBeenCalledOnce();
  });
});
