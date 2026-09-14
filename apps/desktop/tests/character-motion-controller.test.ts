import { describe, expect, test, vi } from 'vitest';
import {
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
import type {
  CharacterMotionServiceOptions,
  CharacterMotionWindow
} from '../src/main/characters/character-motion-service';
import type { PetGeometrySnapshot } from
  '../src/main/characters/pet-visual-geometry';
import type { Rectangle } from 'electron';
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

type MotionServiceTestOptions = Omit<
  CharacterMotionServiceOptions,
  'getDisplays' | 'getGeometrySnapshot'
> & {
  window: CharacterMotionWindow;
  getWorkAreas?: () => readonly Rectangle[];
  getDisplays?: CharacterMotionServiceOptions['getDisplays'];
  getGeometrySnapshot?: CharacterMotionServiceOptions['getGeometrySnapshot'];
};

/** 旧用例显式把整窗口当作可见区，仅保留其原本测试意图。 */
function createMotionService(options: MotionServiceTestOptions): CharacterMotionService {
  const { getWorkAreas, ...rest } = options;
  return new CharacterMotionService({
    ...rest,
    getDisplays: options.getDisplays ?? (() => (
      getWorkAreas?.().map((workAreaDip, index) => ({
        id: `legacy-display-${index}`,
        workAreaDip
      })) ?? []
    )),
    getGeometrySnapshot: options.getGeometrySnapshot ?? (() => {
      const window = options.window.getBounds();
      return {
        revision: 1,
        characterId: 'demo',
        scale: 1,
        footAnchorDip: { x: window.x + window.width / 2, y: window.y + window.height },
        visualBoundsInWindowDip: { x: 0, y: 0, width: window.width, height: window.height },
        windowBoundsDip: window,
        displayId: 'legacy-display-0'
      };
    })
  });
}

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

});

describe('Main 高频连续积分', () => {
  /** 窗口只保存整数，独立时钟与同步 move 回执用于复现真实原生边界的量化。 */
  function fixture(options: { offsetX?: number; failFirst?: boolean } = {}) {
    let now = 0;
    let bounds = { x: 100, y: 100, width: 180, height: 220 };
    let geometryReady = true;
    let failNext = options.failFirst ?? false;
    const service = createMotionService({
      now: () => now,
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => {
          if (failNext) { failNext = false; throw new Error('原生窗口拒绝定位'); }
          bounds = { ...bounds, x: x + (options.offsetX ?? 0), y };
          service.acknowledgeProgrammaticWindowMove();
        }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 3000, height: 2000 }],
      getGeometrySnapshot: () => geometryReady ? {
        revision: 1, characterId: 'demo', scale: 1,
        footAnchorDip: { x: bounds.x + 90, y: bounds.y + 220 },
        visualBoundsInWindowDip: { x: 0, y: 0, width: 180, height: 220 },
        windowBoundsDip: bounds, displayId: 'legacy-display-0'
      } : null
    });
    return { service, bounds: () => bounds,
      tick: (elapsedMs = 16) => { now += elapsedMs; return service.tick(); },
      setGeometryReady: (ready: boolean) => { geometryReady = ready; },
      place: (x: number, y: number) => { bounds = { ...bounds, x, y }; }
    };
  }

  test.each([0, 150])('16 ms 连续运动不改变速度，斜向短轴 %s 不被每步取整丢失', deltaY => {
    const f = fixture();
    f.service.moveTo({ x: 1100, y: 100 + deltaY });
    for (let step = 0; step < 62; step++) f.tick();
    const distance = 160 * 0.992;
    const length = Math.hypot(1000, deltaY);
    expect(Math.abs(f.bounds().x - 100 - distance * 1000 / length)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(f.bounds().y - 100 - distance * deltaY / length)).toBeLessThanOrEqual(0.5);
  });

  test.each([-2, 2])('同步原生回执存在 %s DIP 往返误差时不将误差反复积分', offsetX => {
    const f = fixture({ offsetX });
    f.service.moveTo({ x: 1100, y: 100 });
    for (let step = 0; step < 62; step++) f.tick();
    expect(Math.abs(f.bounds().x - 100 - 160 * 0.992)).toBeLessThanOrEqual(2.5);
    expect(f.service.getSnapshot().target).toEqual({ x: 1100, y: 100 });
  });

  test.each(['stop', 'moveTo', 'drag'] as const)('%s 后从实际窗口位置开始新段，不沿用旧小数位置', boundary => {
    const f = fixture();
    f.service.moveTo({ x: 1100, y: 100 });
    f.tick();
    if (boundary === 'stop') f.service.stop();
    if (boundary === 'drag') {
      f.service.beginUserMove(undefined, 'controller');
      f.place(300, 200);
      f.service.endUserMove('controller');
    }
    const origin = f.bounds();
    f.service.moveTo({ x: origin.x + 1000, y: origin.y });
    f.tick();
    expect(f.bounds().x).toBe(origin.x + 3);
    expect(f.bounds().y).toBe(origin.y);
  });

  test.each(['confirm', 'hidden', 'cancel'] as const)('几何重基 %s 保留小数进度，失败仅撤销尚未发生的布局', outcome => {
    const f = fixture();
    f.service.moveTo({ x: 1100, y: 100 });
    f.tick();
    const cancel = f.service.expectProgrammaticPosition({ x: 113, y: 100 });
    if (outcome === 'cancel') cancel();
    else {
      f.place(113, 100);
      if (outcome === 'confirm') { f.service.acknowledgeProgrammaticWindowMove(); cancel(); }
    }
    f.tick();
    expect(f.bounds().x).toBe(outcome === 'cancel' ? 105 : 115);
    expect(f.service.getSnapshot().target.x).toBe(outcome === 'cancel' ? 1100 : 1110);
  });

  test('未发生的原生定位失败撤销小数进度和预期回执，重试不多走一步', () => {
    const f = fixture({ failFirst: true });
    f.service.moveTo({ x: 1100, y: 100 });
    expect(() => f.tick()).toThrow('原生窗口拒绝定位');
    expect(f.service.hasPendingProgrammaticPosition()).toBe(false);
    f.tick(0);
    expect(f.bounds().x).toBe(103);
  });

  test('超出 DPI 容差的同步原生偏移同时重基目标与连续位置，不被 tick 覆盖', () => {
    const f = fixture({ offsetX: 12 });
    f.service.moveTo({ x: 1100, y: 100 });
    f.tick();
    f.tick();
    expect(f.bounds().x).toBe(129);
    expect(f.service.getSnapshot().target.x).toBe(1124);
  });

  test.each(['tick', 'intent'] as const)('几何丢失经 %s 撤销目标后，恢复不回放旧连续位置', boundary => {
    const f = fixture();
    f.service.moveTo({ x: 1100, y: 100 });
    f.tick();
    f.setGeometryReady(false);
    f.place(300, 200);
    if (boundary === 'tick') f.tick();
    else expect(f.service.requestIntent({ kind: 'relative', direction: 'right', distance: 'near' })).toBeNull();
    f.setGeometryReady(true);
    expect(f.tick()).toMatchObject({ position: { x: 300, y: 200 }, moving: false });
    f.service.moveTo({ x: 1300, y: 200 });
    expect(f.tick()).toMatchObject({ position: { x: 303, y: 200 }, moving: true });
  });
});

describe('Main 角色运动服务', () => {
  const geometrySnapshot = (input: {
    scale?: number;
    window: { x: number; y: number; width: number; height: number };
    visual: { x: number; y: number; width: number; height: number };
    foot?: { x: number; y: number };
    displayId?: string;
  }): PetGeometrySnapshot => ({
    revision: 1,
    characterId: 'demo',
    scale: input.scale ?? 1,
    footAnchorDip: input.foot ?? {
      x: input.window.x + input.visual.x + input.visual.width / 2,
      y: input.window.y + input.visual.y + input.visual.height
    },
    visualBoundsInWindowDip: input.visual,
    windowBoundsDip: input.window,
    displayId: input.displayId ?? 'primary'
  });

  test('仅随机远行进入 24 DIP 容差即停止，不强求精确到达目标点', () => {
    expect(advanceMotion({
      current: { x: 100, y: 100 },
      target: { x: 120, y: 110 },
      speed: 160,
      deltaMs: 50,
      arrivalToleranceDip: 24
    })).toEqual({ position: { x: 100, y: 100 }, arrived: true });
  });

  test.each([
    { scale: 0.5, visual: { x: 60, y: 70, width: 50, height: 60 } },
    { scale: 1, visual: { x: 40, y: 45, width: 100, height: 120 } },
    { scale: 2, visual: { x: 10, y: 5, width: 160, height: 210 } }
  ])('$scale 倍缩放时四边只约束可见矩形', ({ scale, visual }) => {
    let bounds = { x: 300, y: 200, width: 220, height: 260 };
    let geometry = geometrySnapshot({ scale, window: bounds, visual });
    const service = createMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x: number, y: number) => { bounds = { ...bounds, x, y }; }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_000, height: 800 }],
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
      }],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    } as unknown as ConstructorParameters<typeof CharacterMotionService>[0]);

    const cases = [
      { requested: { x: -5_000, y: 200 }, expected: { x: -visual.x, y: 200 } },
      { requested: { x: 5_000, y: 200 }, expected: {
        x: 1_000 - visual.x - visual.width, y: 200
      } },
      { requested: { x: 300, y: -5_000 }, expected: { x: 300, y: -visual.y } },
      { requested: { x: 300, y: 5_000 }, expected: {
        x: 300, y: 800 - visual.y - visual.height
      } }
    ];
    for (const sample of cases) {
      service.moveTo(sample.requested);
      expect(service.tick().target).toEqual(sample.expected);
      geometry = geometrySnapshot({ scale, window: bounds, visual });
    }
  });

  test('相对移动与长距闲逛使用可见尺寸和可见边界', () => {
    const bounds = { x: 400, y: 300, width: 300, height: 260 };
    let geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 80, y: 60, width: 60, height: 80 }
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_000, height: 800 }],
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
      }],
      getGeometrySnapshot: () => geometry,
      random: () => 1,
      now: () => 0
    } as unknown as ConstructorParameters<typeof CharacterMotionService>[0]);

    expect(service.requestIntent({ kind: 'relative', direction: 'left', distance: 'near' }))
      .toMatchObject({ target: { x: 370, y: 300 }, moving: true });
    expect(service.tick().target).toEqual({ x: 370, y: 300 });
    service.requestIntent({ kind: 'relative', direction: 'down', distance: 'far' });
    expect(service.tick().target).toEqual({ x: 400, y: 460 });
    service.requestIntent({ kind: 'wander', scope: 'work_area' });
    expect(service.tick().target).toEqual({ x: 860, y: 660 });
  });

  test('远距随机连续落在近点时改选当前单屏最远可达点', () => {
    const bounds = { x: 400, y: 300, width: 300, height: 260 };
    const randomValues = [
      480 / 940, 360 / 720,
      480 / 940, 360 / 720,
      480 / 940, 360 / 720
    ];
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
      }],
      getGeometrySnapshot: () => geometrySnapshot({
        window: bounds,
        visual: { x: 80, y: 60, width: 60, height: 80 }
      }),
      random: () => randomValues.shift() ?? 0.5,
      now: () => 0
    });

    expect(service.requestIntent({
      kind: 'wander', scope: 'work_area', distance: 'far'
    })).toMatchObject({ target: { x: -80, y: -60 }, moving: true });
  });

  test('负坐标多屏依脚底选当前屏，目标脚底进入相邻屏时切换约束', () => {
    const bounds = { x: 100, y: 100, width: 300, height: 240 };
    let geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 50, y: 20, width: 100, height: 100 },
      foot: { x: -100, y: 220 },
      displayId: 'left'
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getWorkAreas: () => [
        { x: -1_000, y: 0, width: 1_000, height: 600 },
        { x: 0, y: 0, width: 1_000, height: 600 }
      ],
      getDisplays: () => [
        { id: 'left', workAreaDip: { x: -1_000, y: 0, width: 1_000, height: 600 } },
        { id: 'right', workAreaDip: { x: 0, y: 0, width: 1_000, height: 600 } }
      ],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    } as unknown as ConstructorParameters<typeof CharacterMotionService>[0]);

    service.requestIntent({ kind: 'region', region: 'bottom_right' });
    expect(service.tick().target).toEqual({ x: -150, y: 480 });
    geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 50, y: 20, width: 100, height: 100 },
      foot: { x: 500, y: 220 },
      displayId: 'left'
    });
    service.moveTo({ x: -250, y: 100 });
    expect(service.tick().target).toEqual({ x: -50, y: 100 });
  });

  test('脚底位于屏间隙时先按当前可见交集选屏而不折返过期屏', () => {
    const bounds = { x: 500, y: 100, width: 300, height: 240 };
    const geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 80, y: 20, width: 100, height: 100 },
      foot: { x: 550, y: 220 },
      displayId: 'left'
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getDisplays: () => [
        { id: 'left', workAreaDip: { x: 0, y: 0, width: 400, height: 600 } },
        { id: 'right', workAreaDip: { x: 600, y: 0, width: 400, height: 600 } }
      ],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    });

    service.requestIntent({ kind: 'region', region: 'bottom_right' });

    expect(service.tick().target).toEqual({ x: 820, y: 480 });
  });

  test('脚底和可见矩形都在屏间隙时按脚底距离选最近屏', () => {
    const bounds = { x: 500, y: 100, width: 300, height: 240 };
    const geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 0, y: 20, width: 50, height: 100 },
      foot: { x: 550, y: 220 },
      displayId: 'left'
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getDisplays: () => [
        { id: 'left', workAreaDip: { x: 0, y: 0, width: 400, height: 600 } },
        { id: 'right', workAreaDip: { x: 600, y: 0, width: 400, height: 600 } }
      ],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    });

    service.requestIntent({ kind: 'region', region: 'top_left' });

    expect(service.tick().target).toEqual({ x: 600, y: -20 });
  });

  test('脚底同时落入重叠工作区时继续按可见交集选屏', () => {
    const bounds = { x: 600, y: 100, width: 300, height: 240 };
    const geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 50, y: 20, width: 200, height: 100 },
      foot: { x: 500, y: 220 },
      displayId: 'left'
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getDisplays: () => [
        { id: 'left', workAreaDip: { x: 0, y: 0, width: 700, height: 600 } },
        { id: 'right', workAreaDip: { x: 300, y: 0, width: 700, height: 600 } }
      ],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    });

    service.requestIntent({ kind: 'region', region: 'bottom_right' });

    expect(service.tick().target).toEqual({ x: 750, y: 480 });
  });

  test('几何快照未就绪时拒绝新目标且 tick 不写窗口', () => {
    const bounds = { x: 120, y: 80, width: 300, height: 240 };
    const setPosition = vi.fn();
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_000, height: 800 }],
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
      }],
      getGeometrySnapshot: () => null,
      now: () => 100
    } as unknown as ConstructorParameters<typeof CharacterMotionService>[0]);

    service.moveTo({ x: 900, y: 700 });
    expect(service.tick()).toMatchObject({
      position: { x: 120, y: 80 },
      target: { x: 120, y: 80 },
      moving: false
    });
    expect(setPosition).not.toHaveBeenCalled();
  });

  test('小数可见边界在右下边缘向内取整', () => {
    const bounds = { x: 20, y: 20, width: 100, height: 100 };
    const geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 10.2, y: 5.4, width: 50.2, height: 40.2 }
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getWorkAreas: () => [{ x: 0, y: 0, width: 100, height: 100 }],
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 100, height: 100 }
      }],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    } as unknown as ConstructorParameters<typeof CharacterMotionService>[0]);

    service.moveTo({ x: 1_000, y: 1_000 });
    expect(service.tick().target).toEqual({ x: 39, y: 54 });
  });

  test('对象化相对移动按当前窗口轴尺寸换算并经工作区钳制', () => {
    let bounds = { x: 400, y: 300, width: 200, height: 100 };
    const service = createMotionService({
      window: {
        getBounds: () => bounds,
        setPosition: (x, y) => { bounds = { ...bounds, x, y }; }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_000, height: 800 }],
      now: () => 0
    });

    service.requestIntent({ kind: 'relative', direction: 'left', distance: 'near' });
    expect(service.tick().target).toEqual({ x: 300, y: 300 });
    service.requestIntent({ kind: 'relative', direction: 'up', distance: 'far' });
    expect(service.tick().target).toEqual({ x: 400, y: 100 });
    service.requestIntent({ kind: 'relative', direction: 'right', distance: 'far' });
    expect(service.tick().target).toEqual({ x: 800, y: 300 });
  });

  test('对象化区域移动只接受区域名并使用当前显示器工作区', () => {
    const service = createMotionService({
      window: {
        getBounds: () => ({ x: 1_100, y: 200, width: 200, height: 100 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [
        { x: 0, y: 0, width: 1_000, height: 800 },
        { x: 1_000, y: 100, width: 800, height: 600 }
      ],
      now: () => 0
    });

    service.requestIntent({ kind: 'region', region: 'bottom_right' });

    expect(service.tick().target).toEqual({ x: 1_600, y: 600 });
  });

  test('短距闲逛保持在窗口尺度范围内且停止会立即撤销旧目标', () => {
    const service = createMotionService({
      window: {
        getBounds: () => ({ x: 400, y: 300, width: 200, height: 100 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_000, height: 800 }],
      random: () => 1,
      now: () => 0
    });

    service.requestIntent({ kind: 'wander', scope: 'short' });
    expect(service.tick().target).toEqual({ x: 600, y: 400 });
    service.stop();
    expect(service.tick().target).toEqual({ x: 400, y: 300 });
  });

  test('桌宠右键菜单不扩大像素命中且只保留 Main 原生尽力入口', () => {
    const source = readFileSync(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain("pet.webContents.on('context-menu', openPetContextMenu)");
    expect(source.match(/registerPetWindowInteractionIpc\(/gu)).toHaveLength(1);
    expect(source).not.toContain('petContextMenuOpen:');
  });

  test('窗口真实位置由 Main 推进并受工作区边界约束', () => {
    let now = 0;
    let bounds = { x: 10, y: 10, width: 180, height: 220 };
    const setPosition = vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    });
    const service = createMotionService({
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

  test('快照订阅可清理且每次修订只广播一次', () => {
    let now = 0;
    const service = createMotionService({
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
    const service = createMotionService({
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
    const service = createMotionService({
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
    const service = createMotionService({
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

  test('几何协调器可预登记 setBounds 的程序化位置且不会夺走既有运动目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    service.moveTo({ x: 400, y: 0 }, 100);
    service.expectProgrammaticPosition({ x: 40, y: 30 });
    (service.beginUserMove as unknown as (point: { x: number; y: number }) => void)({
      x: 40,
      y: 30
    });
    bounds = { ...bounds, x: 40, y: 30 };
    service.handleWindowMoved();

    now = 100;
    service.tick();
    expect(service.getSnapshot().target).toEqual({ x: 440, y: 30 });
    expect(() => service.expectProgrammaticPosition({ x: Number.NaN, y: 0 }))
      .toThrow('CHARACTER_MOTION_INPUT_INVALID');
  });

  test('活动运动期间几何布局改变窗口原点时以同一差值重基目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => now
    });
    service.moveTo({ x: 400, y: 100 }, 100);

    service.expectProgrammaticPosition({ x: 40, y: 30 });
    bounds = { ...bounds, x: 40, y: 30 };
    now = 10;

    expect(service.tick().target).toEqual({ x: 440, y: 130 });
  });

  test('运动期间可见形状变宽时在下一 tick 向内收紧旧目标', () => {
    const bounds = { x: 100, y: 100, width: 300, height: 240 };
    let geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 0, y: 0, width: 100, height: 100 }
    });
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition: vi.fn() },
      getDisplays: () => [{
        id: 'primary', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
      }],
      getGeometrySnapshot: () => geometry,
      now: () => 0
    });
    service.moveTo({ x: 900, y: 100 });
    expect(service.tick().target).toEqual({ x: 900, y: 100 });

    geometry = geometrySnapshot({
      window: bounds,
      visual: { x: 0, y: 0, width: 200, height: 100 }
    });

    expect(service.tick().target).toEqual({ x: 800, y: 100 });
  });

  test('静止窗口的程序化布局同步 motion target，后续 tick 不拉回旧位置', () => {
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn();
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 100
    });
    service.expectProgrammaticPosition({ x: 40, y: 30 });
    service.beginUserMove({ x: 40, y: 30 });
    bounds = { ...bounds, x: 40, y: 30 };
    service.handleWindowMoved();

    expect(service.tick()).toMatchObject({
      position: { x: 40, y: 30 },
      target: { x: 40, y: 30 },
      moving: false
    });
    expect(setPosition).not.toHaveBeenCalled();
  });

  test('隐藏窗口 setBounds 未发 move 事件时，预登记布局仍阻止首 tick 拉回', () => {
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn();
    const service = createMotionService({
      window: { getBounds: () => bounds, setPosition },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 100
    });
    service.expectProgrammaticPosition({ x: 40, y: 30 });
    bounds = { ...bounds, x: 40, y: 30 };

    expect(service.tick()).toMatchObject({
      position: { x: 40, y: 30 }, target: { x: 40, y: 30 }, moving: false
    });
    expect(setPosition).not.toHaveBeenCalled();
  });

  test('控制器拖拽在程序化位置积压时仍无条件接管并失效旧预期', () => {
    const service = createMotionService({
      window: {
        getBounds: () => ({ x: 40, y: 30, width: 180, height: 220 }),
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 100
    });
    service.expectProgrammaticPosition({ x: 40, y: 30 });

    service.beginUserMove(undefined, 'controller');

    expect(service.isUserMoving()).toBe(true);
    expect(service.hasPendingProgrammaticPosition()).toBe(false);
  });

  test('积压的程序化 moved 以 20→10 真正乱序确认时不会覆盖运动目标', () => {
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = createMotionService({
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
    const service = createMotionService({
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

  test('生产窗口接线使用 will-move 开始接管并在 moved 边界立即结束', () => {
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
    expect(service.handleWindowMoved).toHaveBeenCalledTimes(2);
    expect(service.endUserMove).toHaveBeenCalledOnce();
    release();
    expect(window.removeListener).toHaveBeenCalledTimes(3);
  });

  test('分段 moved 释放后，后续裸 move 只同步最终位置而不制造伪 owner', () => {
    let bounds = { x: 20, y: 10, width: 180, height: 220 };
    const listeners = new Map<string, Set<() => void>>();
    const emit = (name: string): void => {
      for (const listener of listeners.get(name) ?? []) listener();
    };
    const window = {
      on: (name: string, listener: () => void) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (name: string, listener: () => void) => {
        listeners.get(name)?.delete(listener);
      },
      getBounds: () => bounds,
      setPosition: vi.fn()
    };
    const service = createMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 0
    });
    const release = bindCharacterMotionWindow(window, service);

    emit('will-move');
    bounds = { ...bounds, x: 40 };
    emit('move');
    expect(service.isUserMoving()).toBe(true);

    bounds = { ...bounds, x: 80 };
    emit('move');
    expect(service.isUserMoving()).toBe(true);
    emit('moved');
    expect(service.isUserMoving()).toBe(false);
    bounds = { ...bounds, x: 100 };
    emit('move');
    expect(service.isUserMoving()).toBe(false);
    emit('moved');
    expect(service.isUserMoving()).toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      position: { x: 100, y: 10 },
      target: { x: 100, y: 10 }
    });
    release();
  });

  test('没有 will-move 的裸 move 只同步窗口位置且不建立用户 owner', () => {
    const listeners = new Map<string, Array<() => void>>();
    const window = {
      on: (name: string, listener: () => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeListener: vi.fn(),
      getBounds: () => ({ x: 20, y: 10, width: 180, height: 220 }),
      setPosition: vi.fn()
    };
    const service = {
      beginUserMove: vi.fn(),
      handleWindowMoved: vi.fn(),
      endUserMove: vi.fn()
    };
    bindCharacterMotionWindow(window, service);

    listeners.get('move')?.[0]?.();

    expect(service.beginUserMove).not.toHaveBeenCalled();
    expect(service.handleWindowMoved).toHaveBeenCalledOnce();
    expect(service.endUserMove).not.toHaveBeenCalled();
    listeners.get('moved')?.[0]?.();
    expect(service.endUserMove).not.toHaveBeenCalled();
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
    const service = createMotionService({
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
    vi.useFakeTimers();
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
    const service = createMotionService({
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

  test('程序化 setBounds 的实际坐标超过 DPI 容差时，首个 move 仍只消费预登记回执', () => {
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<string, Set<() => void>>();
    const emit = (name: string): void => {
      for (const listener of listeners.get(name) ?? []) listener();
    };
    const window = {
      getBounds: () => bounds,
      setPosition: vi.fn(),
      on: (name: string, listener: () => void) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (name: string, listener: () => void) => {
        listeners.get(name)?.delete(listener);
      }
    };
    const service = createMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 0
    });
    const release = bindCharacterMotionWindow(window, service);

    service.expectProgrammaticPosition({ x: 300, y: 200 });
    bounds = { ...bounds, x: 294, y: 196 };
    emit('move');

    expect(service.isUserMoving()).toBe(false);
    expect(service.hasPendingProgrammaticPosition()).toBe(false);
    release();
  });

  test('Windows 高 DPI 将程序化位置取整偏移两 DIP 时仍继续远端目标', () => {
    vi.useFakeTimers();
    let now = 0;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<
      string,
      Set<(event?: unknown, next?: typeof bounds) => void>
    >();
    const emit = (name: string, next?: typeof bounds): void => {
      for (const listener of listeners.get(name) ?? []) listener(undefined, next);
    };
    const window = {
      getBounds: () => bounds,
      setPosition: (x: number, y: number) => {
        const roundedByWindows = { ...bounds, x: x + 2, y };
        // Electron/Windows 的程序化 will-move 预告值可能尚未完成 DPI 归一化。
        emit('will-move', { ...roundedByWindows, x: roundedByWindows.x + 100 });
        bounds = roundedByWindows;
        emit('move');
        emit('moved');
      },
      on: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => listeners.get(name)?.delete(listener)
    };
    const service = createMotionService({
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
    expect(service.isUserMoving()).toBe(false);
    release();
  });

  test('控制器拖拽 owner 不被每帧原生 moved 提前释放', () => {
    vi.useFakeTimers();
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<string, Set<(event?: unknown, next?: typeof bounds) => void>>();
    const emit = (name: string, next?: typeof bounds): void => {
      for (const listener of listeners.get(name) ?? []) listener(undefined, next);
    };
    const window = {
      getBounds: () => bounds,
      setPosition: (x: number, y: number) => {
        const next = { ...bounds, x, y };
        emit('will-move', next);
        bounds = next;
        emit('move');
        emit('moved');
      },
      on: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => {
        listeners.get(name)?.delete(listener);
      }
    };
    const service = createMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 2_000, height: 1_200 }],
      now: () => 0
    });
    const release = bindCharacterMotionWindow(window, service);
    const ownedMotion = service as unknown as {
      beginUserMove(next?: { x: number; y: number }, source?: 'controller' | 'native'): void;
      endUserMove(source?: 'controller' | 'native'): void;
    };

    ownedMotion.beginUserMove(undefined, 'controller');
    for (let index = 1; index <= 100; index += 1) {
      window.setPosition(index, index);
      expect(service.isUserMoving()).toBe(true);
      expect(bounds).toMatchObject({ width: 180, height: 220 });
    }
    ownedMotion.endUserMove('controller');

    expect(service.isUserMoving()).toBe(false);
    release();
  });

  test('控制器结束时 getBounds 抛错仍释放 motion owner 且不打断清理链', () => {
    let failGetBounds = false;
    const service = createMotionService({
      window: {
        getBounds: () => {
          if (failGetBounds) throw new Error('GET_BOUNDS_FAILED');
          return { x: 0, y: 0, width: 180, height: 220 };
        },
        setPosition: vi.fn()
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
      now: () => 0
    });
    service.beginUserMove(undefined, 'controller');
    failGetBounds = true;

    expect(() => service.endUserMove('controller')).not.toThrow();
    expect(service.isUserMoving()).toBe(false);
  });

  test('控制器仍持有 owner 时原生事件不发布虚假拖拽边沿', () => {
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const listeners = new Map<string, Set<(event?: unknown, next?: typeof bounds) => void>>();
    const emit = (name: string, next?: typeof bounds): void => {
      for (const listener of listeners.get(name) ?? []) listener(undefined, next);
    };
    const window = {
      getBounds: () => bounds,
      setPosition: (x: number, y: number) => {
        const next = { ...bounds, x, y };
        emit('will-move', next);
        bounds = next;
        emit('move');
        emit('moved');
      },
      on: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => {
        const current = listeners.get(name) ?? new Set();
        current.add(listener);
        listeners.set(name, current);
      },
      removeListener: (
        name: string,
        listener: (event?: unknown, next?: typeof bounds) => void
      ) => {
        listeners.get(name)?.delete(listener);
      }
    };
    const service = createMotionService({
      window,
      getWorkAreas: () => [{ x: 0, y: 0, width: 2_000, height: 1_200 }],
      now: () => 0
    });
    const onUserMoveStarted = vi.fn();
    const onUserMoveEnded = vi.fn();
    const release = bindCharacterMotionWindow(window, service, {
      onUserMoveStarted,
      onUserMoveEnded
    });

    service.beginUserMove(undefined, 'controller');
    window.setPosition(20, 30);

    expect(service.isUserMoving()).toBe(true);
    expect(onUserMoveStarted).not.toHaveBeenCalled();
    expect(onUserMoveEnded).not.toHaveBeenCalled();

    service.endUserMove('controller');
    window.setPosition(40, 50);

    expect(service.isUserMoving()).toBe(false);
    expect(onUserMoveStarted).toHaveBeenCalledOnce();
    expect(onUserMoveEnded).toHaveBeenCalledOnce();
    release();
  });

  test('handleWindowMoved 在注入时钟倒退时保持快照时间单调', () => {
    let now = 100;
    let bounds = { x: 0, y: 0, width: 180, height: 220 };
    const service = createMotionService({
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

  test('可信 Main 搬运标志进入权威快照并可关闭', () => {
    const service = createMotionService({
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

  test('可见矩形大于工作区时保持当前位置', () => {
    const service = createMotionService({
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
    expect(service.getSnapshot().target).toEqual({ x: 0, y: 0 });
  });

  test('注入时钟倒退时快照时间戳保持单调', () => {
    let now = 100;
    const service = createMotionService({
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

  test('原生 setPosition 抛错时 timer 收口异常并停止后续原生调用', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const bounds = { x: 0, y: 0, width: 180, height: 220 };
      const setPosition = vi.fn(() => {
        throw new Error('NATIVE_POSITION_PRIVATE_DETAIL');
      });
      const service = createMotionService({
        window: { getBounds: () => bounds, setPosition },
        getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
        now: () => now
      });
      const reportError = vi.fn();
      const poll = vi.fn();
      service.moveTo({ x: 10, y: 0 }, 100);
      now = 100;
      const runtime = startCharacterMotionTimers({
        tick: () => { service.tick(); },
        poll,
        isDestroyed: () => false,
        tickIntervalMs: 10,
        idleIntervalMs: 20,
        reportError
      });

      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      expect(setPosition).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith('CHARACTER_MOTION_TIMER_FAILED');

      // 窗口保持存活，确认冻结来自 timer 清理而非销毁 guard 短路。
      vi.advanceTimersByTime(50);
      expect(setPosition).toHaveBeenCalledOnce();
      expect(poll).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();

      runtime.destroy();
      vi.advanceTimersByTime(50);
      expect(setPosition).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
