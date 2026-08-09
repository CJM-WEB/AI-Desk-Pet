import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPetPositionController,
  restorePetPosition
} from '../src/main/windows/pet-position';

class FakePetWindow {
  private readonly moveListeners: Array<() => void> = [];
  private position: [number, number] = [0, 0];

  on(event: 'move', listener: () => void): this {
    if (event === 'move') this.moveListeners.push(listener);
    return this;
  }

  getPosition(): number[] { return this.position; }

  moveTo(x: number, y: number): void {
    this.position = [x, y];
    for (const listener of this.moveListeners) listener();
  }
}

afterEach(() => vi.useRealTimers());

describe('桌宠位置恢复', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 180, height: 220 };

  test('没有历史位置时使用主显示器右下角默认位置', () => {
    expect(restorePetPosition(null, size, [primary])).toEqual({ x: 1724, y: 804 });
  });

  test('离屏位置夹取到主显示器且可见位置原样恢复', () => {
    const secondary = { x: 1920, y: -200, width: 1280, height: 1024 };
    expect(restorePetPosition({ x: 5000, y: 5000 }, size, [primary, secondary]))
      .toEqual({ x: 1724, y: 804 });
    expect(restorePetPosition({ x: 2100, y: 100 }, size, [primary, secondary]))
      .toEqual({ x: 2100, y: 100 });
  });
});

describe('桌宠桌面位置控制器', () => {
  test('延迟合并连续移动并保存最新桌面坐标', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const saved: Array<{ x: number; y: number }> = [];
    createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => { saved.push(position); }
    });
    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(80);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(100);
    expect(saved).toEqual([{ x: 300, y: 320 }]);
  });

  test('保存失败只上报错误且冻结刷新正常完成', async () => {
    const failure = new Error('SAVE_FAILED');
    const errors: unknown[] = [];
    const window = new FakePetWindow();
    const controller = createPetPositionController({
      window,
      savePosition: async () => { throw failure; },
      onError: error => errors.push(error)
    });
    window.moveTo(10, 20);
    await expect(controller.freezeAndFlush()).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
  });

  test('freezeAndFlush 保存最后位置并忽略后续移动', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const saved: Array<{ x: number; y: number }> = [];
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => { saved.push(position); }
    });
    window.moveTo(320, 340);
    await controller.freezeAndFlush();
    window.moveTo(900, 920);
    await vi.advanceTimersByTimeAsync(100);
    expect(saved).toEqual([{ x: 320, y: 340 }]);
  });
});
