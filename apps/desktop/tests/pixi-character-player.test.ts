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
  function lifecycleScene(options?: { failPlay?: boolean }) {
    let complete: (() => void) | undefined;
    const unsubscribeComplete = vi.fn();
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      showAction: vi.fn(() => {
        if (options?.failPlay) throw new Error('CHARACTER_RUNTIME_ASSET_MISSING');
      }),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      subscribeActionComplete: vi.fn(listener => {
        complete = listener;
        return unsubscribeComplete;
      }),
      resize: vi.fn(),
      destroy: vi.fn()
    };
    return { complete: () => complete?.(), scene, unsubscribeComplete };
  }

  test('播放器 resize 复用正式 Pixi 场景并刷新命中区域', () => {
    const fixture = lifecycleScene();
    const player = new PixiCharacterPlayer(fixture.scene);
    const hitRegionChanged = vi.fn();
    player.subscribeHitRegion(hitRegionChanged);

    player.resize(200, 160);

    expect(fixture.scene.resize).toHaveBeenCalledWith(200, 160);
    expect(hitRegionChanged).toHaveBeenCalledOnce();
  });

  test('非循环动作自然结束时只报告一次 completed', () => {
    const fixture = lifecycleScene();
    const currentManifest = manifest();
    currentManifest.states[0]!.actions[0]!.loop = false;
    const player = new PixiCharacterPlayer(fixture.scene);
    const listener = vi.fn();
    player.subscribePlaybackLifecycle(listener);

    const playbackId = player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated');
    fixture.complete();
    fixture.complete();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      playbackId,
      actionId: 'idle',
      status: 'completed'
    });
  });

  test('循环动作不会把场景完成信号报告为自然完成', () => {
    const fixture = lifecycleScene();
    const currentManifest = manifest();
    const player = new PixiCharacterPlayer(fixture.scene);
    const listener = vi.fn();
    player.subscribePlaybackLifecycle(listener);

    player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated');
    fixture.complete();

    expect(listener).not.toHaveBeenCalled();
  });

  test('新动作替换当前播放时报告旧播放 interrupted', () => {
    const fixture = lifecycleScene();
    const currentManifest = manifest();
    const player = new PixiCharacterPlayer(fixture.scene);
    const listener = vi.fn();
    player.subscribePlaybackLifecycle(listener);
    const firstPlaybackId = player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated');

    player.play({
      stateId: 'idle',
      action: { ...currentManifest.states[0]!.actions[0]!, id: 'idle-next' },
      reason: 'matched'
    }, 'animated');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      playbackId: firstPlaybackId,
      actionId: 'idle',
      status: 'interrupted'
    });
  });

  test('场景展示资源异常时报告 failed 且仍向调用方抛出稳定错误', () => {
    const fixture = lifecycleScene({ failPlay: true });
    const currentManifest = manifest();
    const player = new PixiCharacterPlayer(fixture.scene);
    const listener = vi.fn();
    player.subscribePlaybackLifecycle(listener);

    expect(() => player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated')).toThrow('CHARACTER_RUNTIME_ASSET_MISSING');
    expect(listener).toHaveBeenCalledWith({
      playbackId: 1,
      actionId: 'idle',
      status: 'failed'
    });
  });

  test('销毁时中断当前播放并清理场景完成订阅', () => {
    const fixture = lifecycleScene();
    const currentManifest = manifest();
    const player = new PixiCharacterPlayer(fixture.scene);
    const listener = vi.fn();
    player.subscribePlaybackLifecycle(listener);
    const playbackId = player.play({
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    }, 'animated');

    player.destroy();
    fixture.complete();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      playbackId,
      actionId: 'idle',
      status: 'interrupted'
    });
    expect(fixture.unsubscribeComplete).toHaveBeenCalledOnce();
  });

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
      clear: vi.fn(),
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
      clear: vi.fn(),
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

  test('播放器只将动作帧白名单 Blob URL 映射给共享场景，缺失发布倍速时使用默认值', async () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
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

  test.each([
    ['right', false, 'right'],
    ['left', false, 'left'],
    ['right', true, 'left'],
    ['left', true, 'right']
  ] as const)(
    '首次播放将运动方向 %s 与素材反转 %s 裁决为有效方向 %s',
    (direction, mirrorX, effectiveDirection) => {
      const scene: PixiCharacterScene = {
        loadAssets: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn(),
        showAction: vi.fn(),
        getCurrentFrame: vi.fn().mockReturnValue(null),
        subscribeFrame: vi.fn(() => vi.fn()),
        destroy: vi.fn()
      };
      const publishedAction: ActionClip = {
        ...manifest().states[0]!.actions[0]!,
        playbackRate: 1.5,
        mirrorX
      };
      const player = new PixiCharacterPlayer(scene);

      player.setDirection(direction);
      player.play({ stateId: 'idle', action: publishedAction, reason: 'matched' }, 'animated');

      expect(scene.showAction).toHaveBeenCalledWith(publishedAction, {
        direction: effectiveDirection,
        motionMode: 'animated',
        speed: 1.5,
        loop: true
      });
    }
  );

  test.each([
    ['right', false, { x: 0.2, y: 0.4 }],
    ['left', false, { x: 0.8, y: 0.4 }],
    ['right', true, { x: 0.8, y: 0.4 }],
    ['left', true, { x: 0.2, y: 0.4 }]
  ] as const)(
    '附着物锚点按运动方向 %s 与素材反转 %s 的有效画面方向定位',
    (direction, mirrorX, expectedAnchor) => {
      const scene: PixiCharacterScene = {
        loadAssets: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn(),
        showAction: vi.fn(),
        getCurrentFrame: vi.fn().mockReturnValue(null),
        subscribeFrame: vi.fn(() => vi.fn()),
        destroy: vi.fn()
      };
      const publishedAction: ActionClip = {
        ...manifest().states[0]!.actions[0]!,
        mirrorX,
        anchors: {
          ...manifest().states[0]!.actions[0]!.anchors,
          carry: { x: 0.2, y: 0.4 }
        }
      };
      const player = new PixiCharacterPlayer(scene);

      player.setDirection(direction);
      player.play({ stateId: 'idle', action: publishedAction, reason: 'matched' }, 'animated');

      expect(player.getAnchor('carry')).toEqual(expectedAnchor);
    }
  );

  test('加载阶段缺失动作帧资源时保持原有失败语义', async () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
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
      clear: vi.fn(),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const currentManifest = manifest();
    const publishedAction: ActionClip = {
      ...currentManifest.states[0]!.actions[0]!,
      playbackRate: 1.5,
      mirrorX: true
    };
    const selection: ActionSelectionResult = {
      stateId: 'idle',
      action: publishedAction,
      reason: 'matched'
    };
    const player = new PixiCharacterPlayer(scene);

    player.play(selection, 'animated');
    player.setDirection('left');

    expect(scene.showAction).toHaveBeenLastCalledWith(selection.action, {
      direction: 'right',
      motionMode: 'animated',
      speed: 1.5,
      loop: true
    });
  });

  test('运行时方向变更时保持非零当前帧', () => {
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
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

  test('方向重建失败后再次改变方向不会恢复已 failed 动作', () => {
    const directionalAction: ActionClip = {
      ...manifest().states[0]!.actions[0]!,
      anchors: {
        ...manifest().states[0]!.actions[0]!.anchors,
        carry: { x: 0.2, y: 0.4 }
      }
    };
    const showAction = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('CHARACTER_DIRECTION_REBUILD_FAILED');
      });
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      showAction,
      getCurrentFrame: vi.fn(() => ({
        action: directionalAction,
        frameIndex: 0,
        bounds: { x: 0, y: 0, width: 32, height: 32 }
      })),
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const player = new PixiCharacterPlayer(scene);
    const lifecycle = vi.fn();
    player.subscribePlaybackLifecycle(lifecycle);
    const playbackId = player.play({
      stateId: 'idle',
      action: directionalAction,
      reason: 'matched'
    }, 'animated');

    expect(() => player.setDirection('left'))
      .toThrow('CHARACTER_DIRECTION_REBUILD_FAILED');
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
      playbackId,
      actionId: directionalAction.id,
      status: 'failed'
    });
    expect(player.getAnchor('carry')).toEqual({ x: 0.8, y: 0.4 });

    player.setDirection('right');
    expect(showAction).toHaveBeenCalledTimes(2);
    expect(lifecycle).toHaveBeenCalledOnce();

    player.destroy();
    expect(lifecycle).toHaveBeenCalledOnce();
  });

  test('内部 ticker 状态能力会继续反映共享场景的动画状态', () => {
    const scene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn().mockReturnValue(null),
      subscribeFrame: vi.fn(() => vi.fn()),
      isTickerRunning: vi.fn().mockReturnValue(true),
      destroy: vi.fn()
    } satisfies PixiCharacterScene & { isTickerRunning(): boolean };

    expect(new PixiCharacterPlayer(scene).isTickerRunning()).toBe(true);
  });

  test('动作重建复用帧订阅，静态逐帧不启动 ticker 且取消后不再通知', async () => {
    const latestSprites: TestAnimatedSprite[] = [];
    const applications: TestApplication[] = [];
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
      roundPixels = false;
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
      renderer = {
        resize: vi.fn((width: number, height: number) => {
          this.screen = { width, height };
        })
      };
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

      constructor() {
        applications.push(this);
      }
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
      const anchoredAction: DraftActionClip = {
        ...action,
        frames: [
          { ...action.frames[0]!, anchors: { ground: { x: 0.5, y: 1 } } },
          { ...action.frames[1]!, anchors: { ground: { x: 0.25, y: 0.75 } } }
        ]
      };
      scene.showAction(anchoredAction, {
        direction: 'right',
        motionMode: 'animated',
        speed: 1,
        loop: true
      });
      const notify = vi.fn();
      const unsubscribe = scene.subscribeFrame(notify);

      expect(scene.getCurrentFrame()).toEqual({
        action: anchoredAction,
        frameIndex: 0,
        bounds: { x: 3, y: 4, width: 32, height: 32 }
      });
      expect(latestSprites[0]!.position.set).toHaveBeenCalledTimes(1);
      latestSprites[0]!.advanceTo(1);
      expect(scene.getCurrentFrame()).toEqual({
        action: anchoredAction,
        frameIndex: 1,
        bounds: { x: 9, y: 10, width: 40, height: 24 }
      });
      expect(latestSprites[0]!.anchor.set).toHaveBeenLastCalledWith(0.25, 0.75);
      expect(latestSprites[0]!.position.set).toHaveBeenCalledTimes(1);
      expect(latestSprites[0]!.roundPixels).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);

      scene.showAction(anchoredAction, {
        direction: 'left',
        motionMode: 'static',
        frameIndex: 1,
        speed: 1,
        loop: false
      });
      expect(latestSprites).toHaveLength(2);
      expect(latestSprites[1]!.anchor.set).toHaveBeenLastCalledWith(0.25, 0.75);
      expect(latestSprites[0]!.onFrameChange).toBeUndefined();
      expect(applications[0]!.ticker.start).toHaveBeenCalledOnce();
      latestSprites[0]!.advanceTo(0);
      expect(notify).toHaveBeenCalledTimes(1);
      latestSprites[1]!.advanceTo(0);
      expect(notify).toHaveBeenCalledTimes(2);
      (scene as PixiCharacterScene & {
        resize(width: number, height: number): void;
      }).resize(200, 120);
      expect(applications[0]!.renderer.resize).toHaveBeenCalledWith(200, 120);
      expect(applications[0]!.render).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(3);

      unsubscribe();
      latestSprites[1]!.advanceTo(1);
      expect(notify).toHaveBeenCalledTimes(3);
      scene.destroy();
      expect(latestSprites[1]!.onFrameChange).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('清空场景停止播放、移除精灵并立即重绘', async () => {
    const latestSprites: TestAnimatedSprite[] = [];
    const applications: TestApplication[] = [];
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
      getBounds() { return { x: 3, y: 4, width: 32, height: 32 }; }
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

      constructor() { applications.push(this); }
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
        direction: 'right', motionMode: 'animated', speed: 1, loop: true
      });
      const notify = vi.fn();
      scene.subscribeFrame(notify);
      const sprite = latestSprites[0]!;

      scene.clear();

      expect(applications[0]!.ticker.stop).toHaveBeenCalled();
      expect(applications[0]!.stage.removeChild).toHaveBeenCalledWith(sprite);
      expect(applications[0]!.render).toHaveBeenCalled();
      expect(scene.getCurrentFrame()).toBeNull();
      expect(scene.getHitSnapshot?.()).toBeNull();
      expect(notify).toHaveBeenCalled();
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

describe('稳定帧订阅', () => {
  test('把场景索引映射为清单帧 ID', () => {
    let sceneFrame: (() => void) | undefined;
    const stableAction = {
      ...action,
      frames: [
        { ...action.frames[0]!, id: 'frame-start' },
        { ...action.frames[1]!, id: 'frame-commit' }
      ]
    } as ActionClip;
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn(() => ({
        action: stableAction,
        frameIndex: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      })),
      subscribeFrame: vi.fn(listener => {
        sceneFrame = listener;
        return vi.fn();
      }),
      destroy: vi.fn()
    };
    const player = new PixiCharacterPlayer(scene);
    const notify = vi.fn();
    player.subscribeFrame(notify);

    sceneFrame?.();

    expect(notify).toHaveBeenCalledWith('frame-commit');
  });

  test('首帧或单帧动作在 showAction 成功后主动发布当前稳定帧 ID', () => {
    const singleFrameAction = {
      ...action,
      frames: [{ ...action.frames[0]!, id: 'frame-commit' }]
    } as ActionClip;
    const scene: PixiCharacterScene = {
      loadAssets: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      showAction: vi.fn(),
      getCurrentFrame: vi.fn(() => ({
        action: singleFrameAction,
        frameIndex: 0,
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      })),
      // 模拟 AnimatedSprite 首帧不触发 onFrameChange 的真实行为。
      subscribeFrame: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    };
    const player = new PixiCharacterPlayer(scene);
    const notify = vi.fn();
    player.subscribeFrame(notify);

    player.play({
      stateId: 'idle',
      action: singleFrameAction,
      reason: 'matched'
    }, 'animated');

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('frame-commit');
  });
});
