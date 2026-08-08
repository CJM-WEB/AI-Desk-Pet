import { describe, expect, test, vi } from 'vitest';
import {
  CharacterMotionController,
  advanceMotion,
  resolveDesktopAnchor
} from '../src/renderer/src/characters/player/character-motion-controller';
import { hitTestCharacterAlpha } from
  '../src/renderer/src/characters/player/character-alpha-hit-tester';
import { CharacterMotionService } from '../src/main/characters/character-motion-service';
import {
  bindCharacterMotionWindow,
  startCharacterMotionTimers
} from '../src/main/characters/character-motion-service';
import type { CharacterManifestV1 } from '@myself/character-runtime';
import { readFileSync } from 'node:fs';

const manifest = {
  version: 1,
  id: 'demo',
  name: '测试角色',
  thumbnailAssetId: 'atlas',
  compilerVersion: 'test',
  resources: [{
    assetId: 'atlas',
    fileName: 'atlas.png',
    sha256: 'a'.repeat(64),
    byteLength: 1
  }],
  states: [{
    id: 'idle',
    kind: 'core',
    actions: [
      {
        id: 'idle-a',
        name: '待机 A',
        fps: 12,
        loop: true,
        weight: 1,
        frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      },
      {
        id: 'idle-b',
        name: '待机 B',
        fps: 12,
        loop: true,
        weight: 1,
        frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      }
    ]
  }]
} satisfies CharacterManifestV1;

describe('Renderer 角色运动控制器', () => {
  test('一万次 Alpha 命中只读取缓存掩码，不触发 Canvas 或 GPU 回读', () => {
    class TestCanvasRenderingContext2D {
      getImageData(): never {
        throw new Error('不应回读 Canvas');
      }
    }
    class TestWebGLRenderingContext {
      readPixels(): never {
        throw new Error('不应回读 GPU');
      }
    }
    vi.stubGlobal('CanvasRenderingContext2D', TestCanvasRenderingContext2D);
    vi.stubGlobal('WebGLRenderingContext', TestWebGLRenderingContext);
    vi.stubGlobal('WebGL2RenderingContext', TestWebGLRenderingContext);
    const canvasReadback = vi.spyOn(
      TestCanvasRenderingContext2D.prototype,
      'getImageData'
    );
    const webglReadback = vi.spyOn(
      TestWebGLRenderingContext.prototype,
      'readPixels'
    );
    const snapshot = {
      mask: {
        width: 100,
        height: 80,
        bytes: new Uint8Array(100 * 80).fill(255)
      },
      sourceRect: { x: 0, y: 0, width: 100, height: 80 },
      frameBounds: { x: 0, y: 0, width: 100, height: 80 },
      direction: 'right' as const
    };

    for (let index = 0; index < 10_000; index += 1) {
      expect(hitTestCharacterAlpha(snapshot, {
        x: index % 100,
        y: index % 80
      })).toBe(true);
    }

    expect(canvasReadback).not.toHaveBeenCalled();
    expect(webglReadback).not.toHaveBeenCalled();
    expect(hitTestCharacterAlpha.toString()).not.toMatch(
      /getImageData|readPixels/u
    );
    vi.unstubAllGlobals();
  });

  test('按速度单调推进且不会越过目标', () => {
    expect(advanceMotion({
      current: { x: 10, y: 20 },
      target: { x: 110, y: 20 },
      speed: 100,
      deltaMs: 500
    }).position).toEqual({ x: 60, y: 20 });

    expect(advanceMotion({
      current: { x: 109, y: 20 },
      target: { x: 110, y: 20 },
      speed: 100,
      deltaMs: 500
    }).position).toEqual({ x: 110, y: 20 });
  });

  test('限制系统唤醒大时间差并约束屏幕边界', () => {
    const next = advanceMotion({
      current: { x: 0, y: 0 },
      target: { x: 1_000, y: -20 },
      speed: 100,
      deltaMs: 60_000,
      maxDeltaMs: 100,
      bounds: { x: 0, y: 0, width: 300, height: 200 }
    });
    expect(next.position.x).toBeCloseTo(10);
    expect(next.position.y).toBe(0);
  });

  test.each([
    { speed: Number.NaN },
    { speed: -1 },
    { deltaMs: Number.POSITIVE_INFINITY },
    { deltaMs: -1 }
  ])('拒绝负数和非有限运动输入 %#', input => {
    expect(() => advanceMotion({
      current: { x: 0, y: 0 },
      target: { x: 1, y: 1 },
      speed: input.speed ?? 1,
      deltaMs: input.deltaMs ?? 1
    })).toThrow('CHARACTER_MOTION_INPUT_INVALID');
  });

  test('桌面锚点消费播放器已镜像坐标，不会按方向二次镜像', () => {
    const frame = { x: 100, y: 200, width: 120, height: 160 };
    expect(resolveDesktopAnchor({ x: 0.75, y: 0.5 }, frame, 'right'))
      .toEqual({ x: 190, y: 280 });
    expect(resolveDesktopAnchor({ x: 0.25, y: 0.5 }, frame, 'left'))
      .toEqual({ x: 130, y: 280 });
  });

  test('忽略乱序和重复快照并限制插值时间差', () => {
    const controller = new CharacterMotionController({
      position: { x: 0, y: 0 },
      speed: 100,
      maxDeltaMs: 100
    });
    expect(controller.accept({
      revision: 1,
      timestampMs: 0,
      position: { x: 0, y: 0 },
      target: { x: 100, y: 0 },
      direction: 'right',
      moving: true,
      carrying: false
    })).toBe(true);
    expect(controller.accept({
      revision: 2,
      timestampMs: 9_000_000,
      position: { x: 20, y: 0 },
      target: { x: 100, y: 0 },
      direction: 'right',
      moving: true,
      carrying: false
    })).toBe(true);
    expect(controller.accept({
      revision: 2,
      timestampMs: 101,
      position: { x: 99, y: 0 },
      target: { x: 99, y: 0 },
      direction: 'left',
      moving: false,
      carrying: false
    })).toBe(false);
    expect(controller.advance(1_000).position.x).toBe(0);
    expect(controller.advance(1_050).position.x).toBe(5);
    expect(controller.advance(10_000).position.x).toBe(15);
  });

  test('Main 时间戳远大于或小于 RAF 时间原点时仍只使用本地 delta', () => {
    for (const mainTimestamp of [1, 9_000_000_000]) {
      const controller = new CharacterMotionController({
        position: { x: 0, y: 0 },
        speed: 100,
        maxDeltaMs: 100
      });
      controller.accept({
        revision: 1,
        timestampMs: mainTimestamp,
        position: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        direction: 'right',
        moving: false,
        carrying: false
      });
      controller.accept({
        revision: 2,
        timestampMs: mainTimestamp + 10,
        position: { x: 20, y: 0 },
        target: { x: 100, y: 0 },
        direction: 'right',
        moving: true,
        carrying: false
      });
      expect(controller.advance(500).position.x).toBe(0);
      expect(controller.advance(550).position.x).toBe(5);
    }
  });

  test('连续接收 Main 160px/s 长距离快照时视觉残差有界并最终收敛', () => {
    const controller = new CharacterMotionController({
      position: { x: 0, y: 0 },
      maxDeltaMs: 100
    });
    controller.accept({
      revision: 1,
      timestampMs: 0,
      position: { x: 0, y: 0 },
      target: { x: 320, y: 0 },
      direction: 'right',
      moving: true,
      carrying: false
    });
    controller.advance(0);

    for (let index = 1; index <= 20; index += 1) {
      const mainX = index * 8;
      controller.accept({
        revision: index + 1,
        timestampMs: index * 50,
        position: { x: mainX, y: 0 },
        target: { x: 320, y: 0 },
        direction: 'right',
        moving: true,
        carrying: false
      });
      const visual = controller.advance(index * 50);
      expect(Math.abs(visual.position.x - mainX)).toBeLessThanOrEqual(48);
    }

    controller.accept({
      revision: 22,
      timestampMs: 1_050,
      position: { x: 160, y: 0 },
      target: { x: 160, y: 0 },
      direction: 'right',
      moving: false,
      carrying: false
    });
    for (let frame = 1; frame <= 10; frame += 1) {
      controller.advance(1_050 + frame * 50);
    }
    expect(controller.advance(1_600).position.x).toBe(160);
  });
});

describe('Main 角色运动服务', () => {
  test('桌宠右键菜单只保留受限 IPC 入口并复用同一弹出回调', () => {
    const source = readFileSync(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8'
    );

    expect(source).not.toContain("pet.webContents.on('context-menu'");
    expect(source.match(/registerPetWindowInteractionIpc\(/gu)).toHaveLength(1);
    expect(source).toMatch(
      /registerPetWindowInteractionIpc\(\s*ipcMain,\s*petWindowInteraction,\s*pet\.webContents,\s*openPetContextMenu/u
    );
    expect(source).toContain("{ label: '打开聊天'");
  });

  test('窗口真实位置由 Main 推进并受工作区边界约束', () => {
    let now = 0;
    let bounds = { x: 10, y: 10, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 400, height: 400 }],
      now: () => now,
      maxDeltaMs: 100
    });
    service.moveTo({ x: 500, y: 500 }, 100);
    now = 10_000;
    const snapshot = service.tick();

    expect(setPosition).toHaveBeenCalledWith(18, 16);
    expect(snapshot.position).toEqual({ x: 18, y: 16 });
    expect(snapshot.target).toEqual({ x: 220, y: 180 });
  });

  test('暂停期间 tick 不写窗口、不发布快照且不消耗待机时间', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const selectAction = vi.fn(() => ({
      stateId: 'idle' as const,
      action: manifest.states[0]!.actions[0]!,
      reason: 'matched' as const
    }));
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      idleIntervalMs: 1_000,
      selectAction
    });
    const listener = vi.fn();
    service.subscribe(listener);
    service.moveTo({ x: 400, y: 0 }, 100);
    service.setSuspended(true);

    now = 10_000;
    const suspended = service.tick();

    expect(setPosition).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(suspended).toEqual(service.getSnapshot());
    expect(suspended).toMatchObject({
      revision: 0,
      timestampMs: 0,
      position: { x: 0, y: 0 },
      moving: false
    });
    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    expect(selectAction).not.toHaveBeenCalled();

    service.setSuspended(false);
    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    now = 11_000;
    expect(service.pollIdle(manifest, 'right', () => 0)?.action.id).toBe('idle-a');
  });

  test('目录运动区域将整个窗口限制在 Explorer 安全矩形内', () => {
    let now = 0;
    let bounds = { x: 110, y: 60, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1920, height: 1040 }],
      now: () => now,
      maxDeltaMs: 10_000
    });
    service.setMovementRegions([{ x: 100, y: 50, width: 250, height: 300 }]);
    service.moveTo({ x: 1900, y: 1000 }, 10_000);

    now = 10_000;
    const snapshot = service.tick();

    expect(snapshot.target).toEqual({ x: 170, y: 130 });
    expect(snapshot.position).toEqual({ x: 170, y: 130 });
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(350);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(350);
  });

  test('多个不相连目录区域不允许运动路径穿越非安全间隙', () => {
    let bounds = { x: 10, y: 10, width: 180, height: 220 };
    const service = new CharacterMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => { bounds = { ...bounds, x, y }; }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1200, height: 800 }],
      now: () => 0
    });
    service.setMovementRegions([
      { x: 0, y: 0, width: 400, height: 500 },
      { x: 800, y: 0, width: 400, height: 500 }
    ]);

    service.moveTo({ x: 900, y: 100 });
    service.tick();

    expect(service.getSnapshot().target).toEqual({ x: 220, y: 100 });
  });

  test('运动中未暂停时拒绝切到不包含当前窗口的区域', () => {
    let now = 0;
    let bounds = { x: 10, y: 10, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1200, height: 800 }],
      now: () => now,
      maxDeltaMs: 100
    });
    service.setMovementRegions([{ x: 0, y: 0, width: 400, height: 500 }]);
    service.moveTo({ x: 200, y: 100 }, 100);
    now = 100;
    service.tick();
    const targetBeforeRejectedSwitch = service.getSnapshot().target;

    expect(() => service.setMovementRegions([
      { x: 800, y: 0, width: 400, height: 500 }
    ])).toThrow('CHARACTER_MOTION_REGION_TRANSITION_UNSAFE');
    expect(service.getSnapshot().target).toEqual(targetBeforeRejectedSwitch);

    service.setSuspended(true);
    expect(() => service.setMovementRegions([
      { x: 800, y: 0, width: 400, height: 500 }
    ])).not.toThrow();
    bounds = { ...bounds, x: 820, y: 20 };
    service.handleWindowMoved();
    service.setSuspended(false);
    service.moveTo({ x: 900, y: 100 }, 100);
    now = 200;
    service.tick();

    expect(setPosition.mock.calls.at(-1)).toEqual([827, 27]);
    expect(bounds.x).toBeGreaterThanOrEqual(800);
  });

  test('切换 Explorer 候选可先暂停、重设区域和坐标后再恢复', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const writtenPositions: Array<{ x: number; y: number }> = [];
    const service = new CharacterMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => {
          writtenPositions.push({ x, y });
          bounds = { ...bounds, x, y };
        }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1200, height: 800 }],
      now: () => now,
      maxDeltaMs: 100
    });
    const listener = vi.fn();
    service.subscribe(listener);
    service.moveTo({ x: 400, y: 0 }, 100);

    service.setSuspended(true);
    service.setMovementRegions([{ x: 600, y: 100, width: 400, height: 500 }]);
    bounds = { ...bounds, x: 620, y: 120 };
    service.handleWindowMoved();
    now = 5_000;
    service.tick();

    expect(writtenPositions).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    service.setSuspended(false);
    service.moveTo({ x: 990, y: 590 }, 100);
    now = 5_100;
    service.tick();
    expect(writtenPositions[0]).toEqual({ x: 626, y: 128 });
    expect(writtenPositions.every(position => position.x >= 600 && position.y >= 100))
      .toBe(true);
  });

  test('待机间隔未到不选择，到达后只选择一次并传入最近 N 个动作', () => {
    let now = 0;
    const selectAction = vi.fn((input: Parameters<typeof import('@myself/character-runtime').selectCharacterAction>[0]) => ({
      stateId: 'idle' as const,
      action: manifest.states[0]!.actions[0]!,
      reason: 'matched' as const,
    }));
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 400, height: 400 }],
      now: () => now,
      idleIntervalMs: 1_000,
      recentActionLimit: 2,
      selectAction
    });
    service.recordPlayedAction('old-a');
    service.recordPlayedAction('old-b');
    service.recordPlayedAction('old-c');

    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    now = 999;
    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    now = 1_000;
    expect(service.pollIdle(manifest, 'right', () => 0)?.action.id).toBe('idle-a');
    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    expect(selectAction).toHaveBeenCalledOnce();
    expect(selectAction.mock.calls[0]?.[0].recentActionIds).toEqual(['old-b', 'old-c']);
    now = 2_000;
    service.pollIdle(manifest, 'right', () => 0);
    expect(selectAction.mock.calls[1]?.[0].recentActionIds).toEqual(['old-b', 'old-c']);
    service.recordPlayedAction('idle-a');
    service.recordPlayedAction('idle-a');
    now = 3_000;
    service.pollIdle(manifest, 'right', () => 0);
    expect(selectAction.mock.calls[2]?.[0].recentActionIds).toEqual(['old-c', 'idle-a']);
  });

  test('快照订阅可清理且每次修订只广播一次', () => {
    let now = 0;
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 400, height: 400 }],
      now: () => now
    });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    now = 16;
    service.tick();
    unsubscribe();
    now = 32;
    service.tick();
    expect(listener).toHaveBeenCalledOnce();
  });

  test('接纳用户拖动后的真实位置且不会被旧目标拉回', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });

    bounds = { ...bounds, x: 300, y: 200 };
    service.handleWindowMoved();
    now = 100;
    expect(service.tick().position).toEqual({ x: 300, y: 200 });
    expect(setPosition).not.toHaveBeenCalled();
  });

  test('用户拖拽期间 tick 不写窗口且采用拖拽中的真实位置', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });

    service.moveTo({ x: 0, y: 0 }, 100);
    service.beginUserMove();
    bounds = { ...bounds, x: 48, y: 64 };
    now = 16;
    const dragging = service.tick();

    expect(setPosition).not.toHaveBeenCalled();
    expect(dragging.position).toEqual({ x: 48, y: 64 });
    expect(dragging.target).toEqual({ x: 48, y: 64 });

    bounds = { ...bounds, x: 96, y: 112 };
    service.endUserMove();
    now = 32;
    const released = service.tick();
    expect(setPosition).not.toHaveBeenCalled();
    expect(released.position).toEqual({ x: 96, y: 112 });
  });

  test('忽略自身 setPosition 产生的 moved 事件并继续原运动目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      maxDeltaMs: 100
    });
    service.moveTo({ x: 400, y: 0 }, 100);
    now = 100;
    service.tick();
    service.handleWindowMoved();
    now = 200;
    service.tick();

    expect(setPosition).toHaveBeenNthCalledWith(1, 10, 0);
    expect(setPosition).toHaveBeenNthCalledWith(2, 20, 0);
  });

  test('积压的程序化 moved 以 20→10 真正乱序确认时不会覆盖运动目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = new CharacterMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => { bounds = { ...bounds, x, y }; }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      maxDeltaMs: 100
    });
    service.moveTo({ x: 400, y: 0 }, 100);
    now = 100; service.tick();
    now = 200; service.tick();
    bounds = { ...bounds, x: 20 }; service.handleWindowMoved();
    bounds = { ...bounds, x: 10 }; service.handleWindowMoved();
    now = 300; service.tick();
    expect(service.getSnapshot().target.x).toBe(400);
  });

  test('will-move 清空程序化积压，用户经过历史程序坐标也立即接管', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = new CharacterMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => { bounds = { ...bounds, x, y }; }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    service.moveTo({ x: 400, y: 0 }, 100);
    now = 100; service.tick();
    now = 200; service.tick();
    service.beginUserMove();
    bounds = { ...bounds, x: 10, y: 100 };
    service.handleWindowMoved();
    expect(service.getSnapshot().target).toEqual({ x: 10, y: 100 });
    now = 300;
    expect(service.tick().position).toEqual({ x: 10, y: 100 });
  });

  test('生产窗口接线使用 will-move 开始接管并由 move/moved 同步位置', () => {
    const listeners = new Map<string, Array<() => void>>();
    const window = {
      on: vi.fn((name: string, listener: () => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      }),
      removeListener: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
      setPosition: vi.fn()
    };
    const service = {
      beginUserMove: vi.fn(),
      handleWindowMoved: vi.fn(),
      endUserMove: vi.fn()
    };
    const release = bindCharacterMotionWindow(window, service);

    listeners.get('will-move')?.[0]?.();
    listeners.get('move')?.[0]?.();
    listeners.get('moved')?.[0]?.();

    expect(service.beginUserMove).toHaveBeenCalledOnce();
    expect(service.handleWindowMoved).toHaveBeenCalledOnce();
    expect(service.endUserMove).toHaveBeenCalledOnce();
    release();
    expect(window.removeListener).toHaveBeenCalledTimes(3);
  });

  test('真实接线忽略同一次程序化 move→moved 重复回调并继续远端目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<string, Set<() => void>>();
    const window = {
      getBounds: () => bounds,
      setPosition: (x: number, y: number) => {
        bounds = { ...bounds, x, y };
        for (const listener of listeners.get('move') ?? []) listener();
        for (const listener of listeners.get('moved') ?? []) listener();
      },
      on: (name: string, listener: () => void) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (name: string, listener: () => void) => {
        listeners.get(name)?.delete(listener);
      }
    };
    const service = new CharacterMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      maxDeltaMs: 100
    });
    const release = bindCharacterMotionWindow(window, service);

    service.moveTo({ x: 400, y: 0 }, 100);
    now = 100;
    service.tick();
    expect(service.getSnapshot().target).toEqual({ x: 400, y: 0 });

    now = 200;
    expect(service.tick().position).toEqual({ x: 20, y: 0 });
    expect(service.getSnapshot().target).toEqual({ x: 400, y: 0 });
    release();
  });

  test('真实接线的 will-move→move→moved 完整序列由用户位置接管', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<string, Set<() => void>>();
    const emit = (name: string): void => {
      for (const listener of listeners.get(name) ?? []) listener();
    };
    const window = {
      getBounds: () => bounds,
      setPosition: (x: number, y: number) => {
        bounds = { ...bounds, x, y };
        emit('move');
        emit('moved');
      },
      on: (name: string, listener: () => void) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (name: string, listener: () => void) => {
        listeners.get(name)?.delete(listener);
      }
    };
    const service = new CharacterMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    const release = bindCharacterMotionWindow(window, service);
    service.moveTo({ x: 400, y: 0 }, 100);

    emit('will-move');
    bounds = { ...bounds, x: 120, y: 80 };
    emit('move');
    bounds = { ...bounds, x: 140, y: 90 };
    emit('moved');

    expect(service.getSnapshot()).toMatchObject({
      position: { x: 140, y: 90 },
      target: { x: 140, y: 90 },
      moving: false
    });
    now = 100;
    expect(service.tick().position).toEqual({ x: 140, y: 90 });
    release();
  });

  test('handleWindowMoved 在注入时钟倒退时保持快照时间单调', () => {
    let now = 100;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = new CharacterMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    service.beginUserMove();
    bounds = { ...bounds, x: 30 };
    service.handleWindowMoved();
    now = 50;
    bounds = { ...bounds, x: 40 };
    service.handleWindowMoved();
    expect(service.getSnapshot().timestampMs).toBe(100);
  });

  test('idle 播放令牌绑定角色和动作且只能消费一次', () => {
    let now = 1_000;
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      createPlaybackToken: () => 'opaque-token'
    });
    const token = service.issueIdlePlayback({
      actionId: 'idle-a',
      characterId: 'demo',
      revision: 3
    });

    expect(() => service.confirmIdlePlayback({
      playbackToken: token,
      actionId: 'idle-b',
      characterId: 'demo'
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(() => service.confirmIdlePlayback({
      playbackToken: token,
      actionId: 'idle-a',
      characterId: 'demo'
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');

    const validToken = service.issueIdlePlayback({
      actionId: 'idle-a',
      characterId: 'demo',
      revision: 4
    });
    service.confirmIdlePlayback({
      playbackToken: validToken,
      actionId: 'idle-a',
      characterId: 'demo'
    });
    expect(() => service.confirmIdlePlayback({
      playbackToken: validToken,
      actionId: 'idle-a',
      characterId: 'demo'
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');

    const expired = service.issueIdlePlayback({
      actionId: 'idle-a',
      characterId: 'demo',
      revision: 5
    });
    now += 31_000;
    expect(() => service.confirmIdlePlayback({
      playbackToken: expired,
      actionId: 'idle-a',
      characterId: 'demo'
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('可信 Main 搬运标志进入权威快照并可关闭', () => {
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 0
    });
    service.setCarrying(true);
    expect(service.getSnapshot().carrying).toBe(true);
    service.setCarrying(false);
    expect(service.getSnapshot().carrying).toBe(false);
  });

  test('工作区小于窗口时仍钳制到工作区原点', () => {
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 50, y: 60, width: 100, height: 100 }],
      now: () => 0
    });
    service.moveTo({ x: 999, y: 999 });
    expect(service.getSnapshot().position).toEqual({ x: 0, y: 0 });
    service.tick();
    expect(service.getSnapshot().target).toEqual({ x: 50, y: 60 });
  });

  test('注入时钟倒退时快照时间戳保持单调', () => {
    let now = 100;
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    service.tick();
    now = 50;
    expect(service.tick().timestampMs).toBe(100);
  });

  test('任务活动期间不选择 idle 且不污染最近动作', () => {
    let now = 0;
    const selectAction = vi.fn();
    const service = new CharacterMotionService({
      window: {
        getBounds: () => ({ x: 0, y: 0, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now,
      idleIntervalMs: 100,
      selectAction
    });
    service.applyTaskEvent({ type: 'phase', phase: 'acting' });
    now = 10_000;
    expect(service.pollIdle(manifest, 'right', () => 0)).toBeNull();
    expect(selectAction).not.toHaveBeenCalled();
  });

  test('窗口销毁后清理定时器且不再 tick 或 poll', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const poll = vi.fn();
    let destroyed = false;
    const runtime = startCharacterMotionTimers({
      tick,
      poll,
      isDestroyed: () => destroyed,
      tickIntervalMs: 10,
      idleIntervalMs: 20
    });
    vi.advanceTimersByTime(25);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(1);
    destroyed = true;
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(2);
    runtime.destroy();
    vi.useRealTimers();
  });
});
