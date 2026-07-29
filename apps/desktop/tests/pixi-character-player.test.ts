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
      private readonly listeners = new Set<() => void>();

      constructor(readonly frames: Array<{ texture: TestTexture; time: number }>) {
        latestSprites.push(this);
      }

      play = vi.fn();
      stop = vi.fn();
      update = vi.fn();
      destroy = vi.fn();
      on = vi.fn((_event: string, listener: () => void) => this.listeners.add(listener));
      off = vi.fn((_event: string, listener: () => void) => this.listeners.delete(listener));
      gotoAndStop(index: number) { this.currentFrame = index; }
      getBounds() {
        return this.currentFrame === 0
          ? { x: 3, y: 4, width: 32, height: 32 }
          : { x: 9, y: 10, width: 40, height: 24 };
      }
      advanceTo(index: number) {
        this.currentFrame = index;
        for (const listener of this.listeners) listener();
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
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
