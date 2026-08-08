import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPetPositionController,
  createQuitAfterPositionFlush,
  restorePetPosition
} from '../src/main/windows/pet-position';

class FakePetWindow {
  private readonly moveListeners: Array<() => void> = [];
  private position: [number, number] = [0, 0];

  on(event: 'move', listener: () => void): this {
    if (event === 'move') this.moveListeners.push(listener);
    return this;
  }

  getPosition(): number[] {
    return this.position;
  }

  moveTo(x: number, y: number): void {
    this.position = [x, y];
    for (const listener of this.moveListeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('桌宠位置恢复', () => {
  const primaryWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const windowSize = { width: 180, height: 220 };

  test('没有历史位置时使用主显示器右下角默认位置', () => {
    expect(restorePetPosition(null, windowSize, [primaryWorkArea])).toEqual({
      x: 1724,
      y: 804
    });
  });

  test('历史位置离屏时夹取到主显示器可见工作区', () => {
    expect(restorePetPosition(
      { x: 5000, y: 5000 },
      windowSize,
      [
        primaryWorkArea,
        { x: 1920, y: -200, width: 1280, height: 1024 }
      ]
    )).toEqual({ x: 1724, y: 804 });
  });

  test('历史位置仍完全可见时原样恢复', () => {
    expect(restorePetPosition(
      { x: 2100, y: 100 },
      windowSize,
      [
        primaryWorkArea,
        { x: 1920, y: -200, width: 1280, height: 1024 }
      ]
    )).toEqual({ x: 2100, y: 100 });
  });

  test('recall 优先恢复进入前桌面坐标，失效时回退到主显示器', () => {
    const workAreas = [
      primaryWorkArea,
      { x: -1280, y: -200, width: 1280, height: 1024 }
    ];
    expect(restorePetPosition({ x: -1000, y: 100 }, windowSize, workAreas))
      .toEqual({ x: -1000, y: 100 });
    expect(restorePetPosition({ x: -5000, y: -5000 }, windowSize, workAreas))
      .toEqual({ x: 1724, y: 804 });
  });
});

describe('桌宠位置控制器', () => {
  test('延迟合并连续移动事件并保存最新位置', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savedPositions: Array<{ x: number; y: number }> = [];
    createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        savedPositions.push(position);
      }
    });

    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(80);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(99);
    expect(savedPositions).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(savedPositions).toEqual([{ x: 300, y: 320 }]);
  });

  test('flush 会立即保存仍在等待的最后位置', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savedPositions: Array<{ x: number; y: number }> = [];
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        savedPositions.push(position);
      }
    });
    window.moveTo(420, 360);

    await controller.flush();

    expect(savedPositions).toEqual([{ x: 420, y: 360 }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(savedPositions).toHaveLength(1);
  });

  test('保存失败时调用错误回调且 flush 正常完成', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const failure = new Error('测试保存失败');
    const errors: unknown[] = [];
    const controller = createPetPositionController({
      window,
      savePosition: async () => {
        throw failure;
      },
      onError: error => {
        errors.push(error);
      }
    });
    window.moveTo(520, 460);

    await expect(controller.flush()).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
  });

  test('串行保存移动位置以避免较慢旧写入覆盖最新位置', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const saveCalls: Array<{ x: number; y: number }> = [];
    let releaseFirstSave = (): void => {};
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        saveCalls.push(position);
        if (position.x === 100) await firstSave;
      }
    });

    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(100);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(100);

    expect(saveCalls).toEqual([{ x: 100, y: 120 }]);
    releaseFirstSave();
    await controller.flush();
    expect(saveCalls).toEqual([
      { x: 100, y: 120 },
      { x: 300, y: 320 }
    ]);
  });

  test('flush 等待旧写入期间会继续排空新移动', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savedPositions: Array<{ x: number; y: number }> = [];
    let releaseFirstSave = (): void => {};
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        savedPositions.push(position);
        if (position.x === 100) await firstSave;
      }
    });
    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(100);

    const flushing = controller.flush();
    window.moveTo(500, 520);
    releaseFirstSave();
    await flushing;

    expect(savedPositions).toEqual([
      { x: 100, y: 120 },
      { x: 500, y: 520 }
    ]);
    expect(savedPositions.at(-1)).toEqual({ x: 500, y: 520 });
  });

  test('folder 模式只保存目录局部偏移，不覆盖桌面坐标', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const desktopPositions: Array<{ x: number; y: number }> = [];
    const localOffsets: Array<{ x: number; y: number }> = [];
    let localOffset = { x: 16, y: 24 };
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        desktopPositions.push(position);
      },
      getLocalOffset: () => localOffset,
      saveLocalOffset: async offset => {
        localOffsets.push(offset);
      }
    });

    controller.setPersistenceMode('folder');
    window.moveTo(900, 700);
    localOffset = { x: 40, y: 50 };
    window.moveTo(924, 726);
    await controller.flush();

    expect(localOffsets).toEqual([{ x: 40, y: 50 }]);
    expect(desktopPositions).toEqual([]);
  });

  test('desktop 模式保存绝对坐标，不依赖窗口可见性猜测', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow() as FakePetWindow & { isVisible(): boolean };
    window.isVisible = () => false;
    const desktopPositions: Array<{ x: number; y: number }> = [];
    const localOffsets: Array<{ x: number; y: number }> = [];
    const controller = createPetPositionController({
      window,
      savePosition: async position => {
        desktopPositions.push(position);
      },
      getLocalOffset: () => ({ x: 1, y: 2 }),
      saveLocalOffset: async offset => {
        localOffsets.push(offset);
      }
    });

    controller.setPersistenceMode('desktop');
    window.moveTo(320, 340);
    await controller.flush();

    expect(desktopPositions).toEqual([{ x: 320, y: 340 }]);
    expect(localOffsets).toEqual([]);
  });

  test('disabled 模式取消待写位置且后续 move 不写任何 Store', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savePosition = vi.fn(async () => undefined);
    const saveLocalOffset = vi.fn(async () => undefined);
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition,
      getLocalOffset: () => ({ x: 16, y: 24 }),
      saveLocalOffset
    });

    window.moveTo(100, 120);
    controller.setPersistenceMode('disabled');
    window.moveTo(500, 520);
    await vi.advanceTimersByTimeAsync(100);
    await controller.flush();

    expect(savePosition).not.toHaveBeenCalled();
    expect(saveLocalOffset).not.toHaveBeenCalled();
  });

  test('disabled 使已进入写队列但未执行的旧代位置失效', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savedPositions: Array<{ x: number; y: number }> = [];
    let releaseFirstSave = (): void => {};
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        savedPositions.push(position);
        if (position.x === 100) await firstSave;
      }
    });

    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(100);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(100);
    controller.setPersistenceMode('disabled');
    releaseFirstSave();
    await controller.flush();

    expect(savedPositions).toEqual([{ x: 100, y: 120 }]);
  });

  test('desktop 切到 folder 后不执行已排队的旧桌面代写入', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const desktopPositions: Array<{ x: number; y: number }> = [];
    const localOffsets: Array<{ x: number; y: number }> = [];
    let localOffset = { x: 16, y: 24 };
    let releaseFirstSave = (): void => {};
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        desktopPositions.push(position);
        if (position.x === 100) await firstSave;
      },
      getLocalOffset: () => localOffset,
      saveLocalOffset: async offset => {
        localOffsets.push(offset);
      }
    });

    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(100);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(100);
    controller.setPersistenceMode('folder');
    releaseFirstSave();
    await controller.flush();

    localOffset = { x: 40, y: 50 };
    window.moveTo(900, 700);
    await controller.flush();

    expect(desktopPositions).toEqual([{ x: 100, y: 120 }]);
    expect(localOffsets).toEqual([{ x: 40, y: 50 }]);
  });

  test('desktop 模式 ABA 后同名旧代队列项仍然失效', async () => {
    vi.useFakeTimers();
    const window = new FakePetWindow();
    const savedPositions: Array<{ x: number; y: number }> = [];
    let releaseFirstSave = (): void => {};
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const controller = createPetPositionController({
      window,
      debounceMs: 100,
      savePosition: async position => {
        savedPositions.push(position);
        if (position.x === 100) await firstSave;
      }
    });

    window.moveTo(100, 120);
    await vi.advanceTimersByTimeAsync(100);
    window.moveTo(300, 320);
    await vi.advanceTimersByTimeAsync(100);
    controller.setPersistenceMode('folder');
    controller.setPersistenceMode('desktop');
    releaseFirstSave();
    await controller.flush();

    expect(savedPositions).toEqual([{ x: 100, y: 120 }]);
  });
});

describe('主进程桌宠位置接入', () => {
  test('启动恢复位置并在人工退出前刷新最后移动', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main).toContain('restorePetPosition(');
    expect(main).toContain('createPetPositionController({');
    expect(main).toContain('await petPositionController.flush()');
    expect(main).toContain('createQuitAfterPositionFlush({');
    expect(main).toContain("app.on('before-quit', event => void handleBeforeQuit(event))");
  });
});

describe('退出前位置刷新', () => {
  test('首次退出等待刷新后再次退出且第二次事件直接放行', async () => {
    let releaseFlush = (): void => {};
    const flush = vi.fn(() => new Promise<void>(resolve => {
      releaseFlush = resolve;
    }));
    const quit = vi.fn();
    const handleBeforeQuit = createQuitAfterPositionFlush({ flush, quit });
    const firstEvent = { preventDefault: vi.fn() };

    const firstQuit = handleBeforeQuit(firstEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    releaseFlush();
    await firstQuit;
    expect(quit).toHaveBeenCalledOnce();

    const secondEvent = { preventDefault: vi.fn() };
    await handleBeforeQuit(secondEvent);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  test('刷新失败时报告错误并继续退出且不循环', async () => {
    const failure = new Error('测试刷新失败');
    const flush = vi.fn(async () => {
      throw failure;
    });
    const quit = vi.fn();
    const onError = vi.fn();
    const handleBeforeQuit = createQuitAfterPositionFlush({ flush, quit, onError });
    const firstEvent = { preventDefault: vi.fn() };

    await expect(handleBeforeQuit(firstEvent)).resolves.toBeUndefined();

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(quit).toHaveBeenCalledOnce();
    const secondEvent = { preventDefault: vi.fn() };
    await handleBeforeQuit(secondEvent);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
