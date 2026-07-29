// @vitest-environment jsdom

import type {
  ActionClip,
  ActionSelectionResult,
  CharacterManifestV1,
  DraftActionClip
} from '@myself/character-runtime';
import { describe, expect, test, vi } from 'vitest';
import type { CharacterAssetBundle } from '../src/renderer/src/characters/player/character-resource-cache';
import {
  createBrowserPixiCharacterScene,
  PixiCharacterPlayer,
  type PixiCharacterScene
} from '../src/renderer/src/characters/player/pixi-character-player';
import {
  hitTestCharacterAlpha,
  type CharacterHitSnapshot
} from '../src/renderer/src/characters/player/character-alpha-hit-tester';

const action: DraftActionClip = {
  id: 'idle',
  name: '待机',
  fps: 12,
  loop: true,
  weight: 1,
  anchors: { ground: { x: 0.5, y: 1 } },
  frames: [
    { assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 },
    { assetId: 'atlas', x: 32, y: 0, width: 40, height: 24 }
  ]
};

function manifest(): CharacterManifestV1 {
  return {
    version: 1,
    id: 'character-a',
    name: '测试角色',
    thumbnailAssetId: 'atlas',
    compilerVersion: 'test',
    resources: [
      { assetId: 'atlas', fileName: 'atlas.png', sha256: 'a'.repeat(64), byteLength: 4 },
      { assetId: 'unused', fileName: 'unused.png', sha256: 'b'.repeat(64), byteLength: 4 }
    ],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{ ...action, frames: action.frames as ActionClip['frames'] }]
    }]
  };
}

describe('共享 Pixi 角色动作场景', () => {
  test('播放器使用正式场景快照命中，并将帧变更通知给可取消订阅者', () => {
    let frameListener: (() => void) | undefined;
    const unsubscribeFrame = vi.fn();
    const currentSnapshot: CharacterHitSnapshot = {
      mask: { width: 1, height: 1, bytes: new Uint8Array([255]) },
      sourceRect: { x: 0, y: 0, width: 1, height: 1 },
      frameBounds: { x: 10, y: 20, width: 20, height: 20 },
      direction: 'right'
    };
    const scene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      getHitSnapshot: vi.fn(() => currentSnapshot),
      subscribeFrame: vi.fn(listener => {
        frameListener = listener;
        return unsubscribeFrame;
      }),
      destroy: vi.fn()
    } satisfies PixiCharacterScene & { getHitSnapshot(): CharacterHitSnapshot | null };
    const player = new PixiCharacterPlayer(scene);
    const notify = vi.fn();
    const unsubscribe = player.subscribeHitRegion(notify);

    expect(player.hitTest({ x: 20, y: 30 })).toBe(true);
    frameListener?.();
    expect(notify).toHaveBeenCalledTimes(1);

    unsubscribe();
    frameListener?.();
    expect(notify).toHaveBeenCalledTimes(1);
    player.destroy();
    expect(unsubscribeFrame).toHaveBeenCalledTimes(1);
    frameListener?.();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('加载、播放、方向变化和切帧分别通知命中区域', async () => {
    let frameListener: (() => void) | undefined;
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(listener => { frameListener = listener; return vi.fn(); }),
      destroy: vi.fn()
    };
    const player = new PixiCharacterPlayer(scene);
    const notify = vi.fn();
    player.subscribeHitRegion(notify);
    const currentManifest = manifest();
    const selection: ActionSelectionResult = {
      stateId: 'idle', action: currentManifest.states[0]!.actions[0]!, reason: 'matched'
    };

    await player.load(currentManifest, { characterId: 'character-a', atlasUrls: new Map([['atlas', 'blob:atlas']]) });
    expect(notify).toHaveBeenCalledTimes(1);
    player.play(selection, 'static');
    expect(notify).toHaveBeenCalledTimes(2);
    player.setDirection('left');
    expect(notify).toHaveBeenCalledTimes(3);
    frameListener?.();
    expect(notify).toHaveBeenCalledTimes(4);
  });

  test('播放器只将动作帧白名单 Blob URL 映射给共享场景并展示动作', async () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const player = new PixiCharacterPlayer(scene);
    const currentManifest = manifest();
    const selection: ActionSelectionResult = {
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    };
    const assets: CharacterAssetBundle = {
      characterId: 'character-a',
      atlasUrls: new Map([
        ['atlas', 'blob:atlas'],
        ['unused', 'blob:unused']
      ])
    };

    await player.load(currentManifest, assets);
    player.play(selection, 'animated');

    expect(scene.loadAssets).toHaveBeenCalledWith(new Map([['atlas', 'blob:atlas']]));
    expect(scene.showAction).toHaveBeenCalledWith(selection.action, {
      direction: 'right',
      motionMode: 'animated',
      speed: 1,
      loop: true
    });
  });

  test('加载阶段缺失动作帧资源时保持原有失败语义', async () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const currentManifest = manifest();
    currentManifest.states[0]!.actions[0]!.frames = [
      ...currentManifest.states[0]!.actions[0]!.frames,
      { assetId: 'missing', x: 0, y: 0, width: 16, height: 16 }
    ];
    const player = new PixiCharacterPlayer(scene);

    await expect(player.load(currentManifest, {
      characterId: 'character-a',
      atlasUrls: new Map([['atlas', 'blob:atlas']])
    })).rejects.toThrow('CHARACTER_RUNTIME_ASSET_MISSING');
    expect(scene.loadAssets).not.toHaveBeenCalled();
  });

  test('运行时方向变更时以新方向重新展示当前动作', () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const currentManifest = manifest();
    const selection: ActionSelectionResult = {
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    };
    const player = new PixiCharacterPlayer(scene);

    player.play(selection, 'animated');
    player.setDirection('left');

    expect(scene.showAction).toHaveBeenLastCalledWith(selection.action, {
      direction: 'left',
      motionMode: 'animated',
      speed: 1,
      loop: true
    });
  });

  test('运行时方向变更时保持非零当前帧', () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue({
        action,
        frameIndex: 1,
        bounds: { x: 9, y: 10, width: 40, height: 24 }
      }),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const currentManifest = manifest();
    const player = new PixiCharacterPlayer(scene);

    player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated');
    player.setDirection('left');

    expect(scene.showAction).toHaveBeenLastCalledWith(
      currentManifest.states[0]!.actions[0]!,
      expect.objectContaining({ direction: 'left', frameIndex: 1 })
    );
  });

  test('内部 ticker 状态能力会继续反映共享场景的动画状态', () => {
    const scene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      isTickerRunning: vi.fn().mockReturnValue(true),
      destroy: vi.fn()
    } satisfies PixiCharacterScene & { isTickerRunning(): boolean };

    expect(new PixiCharacterPlayer(scene).isTickerRunning()).toBe(true);
  });

  test('切帧后更新当前帧并且取消订阅后不再通知', async () => {
    const latestSprites: TestAnimatedSprite[] = [];
    class TestTexture {
      source: unknown;
      frame: { x: number; y: number; width: number; height: number };

      constructor(options: { source: unknown; frame: { x: number; y: number; width: number; height: number } }) {
        this.source = options.source;
        this.frame = options.frame;
      }

      static from(image: unknown) {
        return new TestTexture({
          source: image,
          frame: { x: 0, y: 0, width: 1, height: 1 }
        });
      }

      destroy = vi.fn();
    }
    class TestAnimatedSprite {
      currentFrame = 0;
      loop = false;
      anchor = { set: vi.fn() };
      scale = { set: vi.fn() };
      position = { set: vi.fn() };
      onFrameChange?: (currentFrame: number) => void;

      constructor(readonly frames: Array<{ texture: TestTexture; time: number }>) {
        latestSprites.push(this);
      }

      play = vi.fn();
      stop = vi.fn();
      update = vi.fn();
      destroy = vi.fn();
      gotoAndStop(index: number) { this.currentFrame = index; }
      getBounds() {
        return this.currentFrame === 0
          ? { x: 3, y: 4, width: 32, height: 32 }
          : { x: 9, y: 10, width: 40, height: 24 };
      }
      advanceTo(index: number) {
        this.currentFrame = index;
        this.onFrameChange?.(index);
      }
    }
    class TestApplication {
      canvas = document.createElement('canvas');
      screen = { width: 100, height: 100 };
      stage = { addChild: vi.fn(), removeChild: vi.fn() };
      ticker = {
        started: false,
        add: vi.fn(),
        remove: vi.fn(),
        start: vi.fn(() => { this.ticker.started = true; }),
        stop: vi.fn(() => { this.ticker.started = false; })
      };
      init = vi.fn(async () => undefined);
      render = vi.fn();
      destroy = vi.fn();
    }
    class TestImage {
      src = '';
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal('Image', TestImage);
    try {
      const scene = await createBrowserPixiCharacterScene(
        document.createElement('div'),
        async () => ({
          Application: TestApplication,
          Texture: TestTexture,
          AnimatedSprite: TestAnimatedSprite,
          Rectangle: class {
            constructor(
              readonly x: number,
              readonly y: number,
              readonly width: number,
              readonly height: number
            ) {}
          }
        }) as never
      );

      await scene.loadAssets(new Map([['atlas', 'blob:atlas']]));
      scene.showAction(action, {
        direction: 'right',
        motionMode: 'animated',
        speed: 1,
        loop: true
      });
      const notify = vi.fn();
      const unsubscribe = scene.subscribeFrame(notify);

      expect(scene.getCurrentFrame()).toEqual({
        action,
        frameIndex: 0,
        bounds: { x: 3, y: 4, width: 32, height: 32 }
      });
      latestSprites[0]!.advanceTo(1);
      expect(scene.getCurrentFrame()).toEqual({
        action,
        frameIndex: 1,
        bounds: { x: 9, y: 10, width: 40, height: 24 }
      });
      expect(notify).toHaveBeenCalledTimes(1);

      unsubscribe();
      latestSprites[0]!.advanceTo(0);
      expect(notify).toHaveBeenCalledTimes(1);
      scene.destroy();
      expect(latestSprites[0]!.onFrameChange).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('动作构建第二帧缺失资源时释放已创建的子纹理', async () => {
    const textures: TestTexture[] = [];
    class TestTexture {
      source: unknown;
      frame: { x: number; y: number; width: number; height: number };
      destroy = vi.fn();

      constructor(options: { source: unknown; frame: { x: number; y: number; width: number; height: number } }) {
        this.source = options.source;
        this.frame = options.frame;
        textures.push(this);
      }

      static from(image: unknown) {
        return new TestTexture({
          source: image,
          frame: { x: 0, y: 0, width: 1, height: 1 }
        });
      }
    }
    class TestApplication {
      canvas = document.createElement('canvas');
      screen = { width: 100, height: 100 };
      stage = { addChild: vi.fn(), removeChild: vi.fn() };
      ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), started: false };
      init = vi.fn(async () => undefined);
      render = vi.fn();
      destroy = vi.fn();
    }
    class TestImage {
      src = '';
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal('Image', TestImage);
    try {
      const scene = await createBrowserPixiCharacterScene(
        document.createElement('div'),
        async () => ({
          Application: TestApplication,
          Texture: TestTexture,
          AnimatedSprite: class {},
          Rectangle: class {
            constructor(
              readonly x: number,
              readonly y: number,
              readonly width: number,
              readonly height: number
            ) {}
          }
        }) as never
      );
      await scene.loadAssets(new Map([['atlas', 'blob:atlas']]));

      expect(() => scene.showAction({
        ...action,
        frames: [
          action.frames[0]!,
          { assetId: 'missing', x: 0, y: 0, width: 16, height: 16 }
        ]
      }, {
        direction: 'right', motionMode: 'static', speed: 1, loop: false
      })).toThrow('CHARACTER_RUNTIME_ASSET_MISSING');

      expect(textures.find(texture => texture.frame.width === 32)?.destroy)
        .toHaveBeenCalledWith(false);
      scene.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('图片解码时仅采样一次 Alpha，命中快照读取不再访问 Canvas', async () => {
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => {
      const rgba = new Uint8ClampedArray(72 * 32 * 4);
      rgba[71 * 4 + 3] = 255;
      return { data: rgba };
    });
    const textures: TestTexture[] = [];
    const sprites: TestAnimatedSprite[] = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      getImageData
    } as never);
    class TestTexture {
      source: unknown;
      frame: { x: number; y: number; width: number; height: number };
      constructor(options: { source: unknown; frame: { x: number; y: number; width: number; height: number } }) {
        this.source = options.source;
        this.frame = options.frame;
        textures.push(this);
      }
      static from(image: unknown) { return new TestTexture({ source: image, frame: { x: 0, y: 0, width: 1, height: 1 } }); }
      destroy = vi.fn();
    }
    class TestAnimatedSprite {
      currentFrame = 0;
      loop = false;
      anchor = { x: 0, y: 0, set: vi.fn((x: number, y: number) => { this.anchor.x = x; this.anchor.y = y; }) };
      scale = { x: 1, y: 1, set: vi.fn((x: number, y: number) => { this.scale.x = x; this.scale.y = y; }) };
      position = { x: 0, y: 0, set: vi.fn((x: number, y: number) => { this.position.x = x; this.position.y = y; }) };
      gotoAndStop(index: number) { this.currentFrame = index; }
      play = vi.fn();
      stop = vi.fn();
      update = vi.fn();
      destroy = vi.fn();
      getBounds = () => {
        const frame = this.frames[this.currentFrame]!.texture.frame;
        const left = this.position.x - this.anchor.x * frame.width * this.scale.x;
        const right = this.position.x + (1 - this.anchor.x) * frame.width * this.scale.x;
        const top = this.position.y - this.anchor.y * frame.height * this.scale.y;
        const bottom = this.position.y + (1 - this.anchor.y) * frame.height * this.scale.y;
        return { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.abs(right - left), height: Math.abs(bottom - top) };
      };
      constructor(readonly frames: Array<{ texture: TestTexture; time: number }>) { sprites.push(this); }
    }
    class TestApplication {
      canvas = document.createElement('canvas');
      screen = { width: 100, height: 100 };
      stage = { addChild: vi.fn(), removeChild: vi.fn() };
      ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), started: false };
      init = vi.fn(async () => undefined);
      render = vi.fn();
      destroy = vi.fn();
    }
    class TestImage {
      src = '';
      naturalWidth = 72;
      naturalHeight = 32;
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal('Image', TestImage);
    try {
      const scene = await createBrowserPixiCharacterScene(document.createElement('div'), async () => ({
        Application: TestApplication,
        Texture: TestTexture,
        AnimatedSprite: TestAnimatedSprite,
        Rectangle: class { constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {} }
      }) as never);
      await scene.loadAssets(new Map([['atlas', 'blob:atlas']]));
      scene.showAction(action, { direction: 'right', motionMode: 'static', speed: 1, loop: false });

      const hitScene = scene as PixiCharacterScene & { getHitSnapshot(): CharacterHitSnapshot | null };
      expect(hitScene.getHitSnapshot()?.mask).toMatchObject({ width: 72, height: 32 });
      expect(hitScene.getHitSnapshot()?.mask.bytes[0]).toBe(0);
      expect(hitScene.getHitSnapshot()?.sourceRect).toEqual({ x: 0, y: 0, width: 32, height: 32 });
      expect(hitScene.getHitSnapshot()?.frameBounds).toEqual({ x: 10, y: 20, width: 80, height: 80 });
      scene.showAction(action, {
        direction: 'left', motionMode: 'static', frameIndex: 1, speed: 1, loop: false
      });
      expect(hitScene.getHitSnapshot()).toMatchObject({
        sourceRect: { x: 32, y: 0, width: 40, height: 24 },
        frameBounds: { x: 0, y: 40, width: 100, height: 60 },
        direction: 'left'
      });
      expect(hitTestCharacterAlpha(hitScene.getHitSnapshot(), { x: 0, y: 40 })).toBe(true);
      expect(hitTestCharacterAlpha(hitScene.getHitSnapshot(), { x: 99.999, y: 40 })).toBe(false);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(getImageData).toHaveBeenCalledTimes(1);
      getContext.mockReturnValueOnce(null);
      await scene.loadAssets(new Map([['atlas', 'blob:no-context']]));
      scene.showAction(action, { direction: 'right', motionMode: 'static', speed: 1, loop: false });
      expect(hitScene.getHitSnapshot()).toBeNull();
      expect(sprites[0]?.destroy).toHaveBeenCalled();
      expect(textures[0]?.destroy).toHaveBeenCalledWith(true);

      getContext.mockReturnValueOnce({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => { throw new Error('CANVAS_READ_FAILED'); })
      } as never);
      await scene.loadAssets(new Map([['atlas', 'blob:read-error']]));
      scene.showAction(action, { direction: 'right', motionMode: 'static', speed: 1, loop: false });
      expect(hitScene.getHitSnapshot()).toBeNull();
      scene.destroy();
    } finally {
      getContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  test('过期资源加载提取的 Alpha 不覆盖较新资源快照', async () => {
    let resolveOldDecode: (() => void) | undefined;
    let sampledUrl = '';
    const textures: TestTexture[] = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn((image: { src: string }) => { sampledUrl = image.src; }),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(32 * 32 * 4).map((_, index) => index % 4 === 3 && sampledUrl === 'blob:new' ? 255 : 0)
      }))
    } as never);
    class TestTexture {
      source: unknown;
      frame: { x: number; y: number; width: number; height: number };
      constructor(options: { source: unknown; frame: { x: number; y: number; width: number; height: number } }) { this.source = options.source; this.frame = options.frame; textures.push(this); }
      static from(image: unknown) { return new TestTexture({ source: image, frame: { x: 0, y: 0, width: 1, height: 1 } }); }
      destroy = vi.fn();
    }
    class TestAnimatedSprite {
      currentFrame = 0;
      loop = false;
      anchor = { set: vi.fn() };
      scale = { set: vi.fn() };
      position = { set: vi.fn() };
      gotoAndStop = vi.fn(); play = vi.fn(); stop = vi.fn(); update = vi.fn(); destroy = vi.fn();
      getBounds = () => ({ x: 0, y: 0, width: 32, height: 32 });
      constructor(readonly frames: Array<{ texture: TestTexture; time: number }>) {}
    }
    class TestApplication {
      canvas = document.createElement('canvas'); screen = { width: 100, height: 100 };
      stage = { addChild: vi.fn(), removeChild: vi.fn() };
      ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), started: false };
      init = vi.fn(async () => undefined); render = vi.fn(); destroy = vi.fn();
    }
    class TestImage {
      src = ''; naturalWidth = 32; naturalHeight = 32;
      decode = vi.fn(() => this.src === 'blob:old'
        ? new Promise<void>(resolve => { resolveOldDecode = resolve; })
        : Promise.resolve());
    }
    vi.stubGlobal('Image', TestImage);
    try {
      const scene = await createBrowserPixiCharacterScene(document.createElement('div'), async () => ({
        Application: TestApplication, Texture: TestTexture, AnimatedSprite: TestAnimatedSprite,
        Rectangle: class { constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {} }
      }) as never);
      const oldLoad = scene.loadAssets(new Map([['atlas', 'blob:old']]));
      await scene.loadAssets(new Map([['atlas', 'blob:new']]));
      resolveOldDecode?.();
      await oldLoad;
      scene.showAction(action, { direction: 'right', motionMode: 'static', speed: 1, loop: false });

      const hitScene = scene as PixiCharacterScene & { getHitSnapshot(): CharacterHitSnapshot | null };
      expect(hitScene.getHitSnapshot()?.mask.bytes[0]).toBe(255);
      expect(textures.find(texture => (texture.source as TestImage).src === 'blob:old')?.destroy)
        .toHaveBeenCalledWith(true);
      scene.destroy();
    } finally {
      getContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
