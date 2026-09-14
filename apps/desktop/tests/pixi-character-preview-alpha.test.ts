// @vitest-environment jsdom

import type { DraftActionClip } from '@myself/character-runtime';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readAlphaMask } from '../src/renderer/src/characters/player/character-alpha-hit-tester';
import {
  createBrowserPixiCharacterScene,
  type PixiCharacterScene
} from '../src/renderer/src/characters/player/pixi-character-player';

const action: DraftActionClip = {
  id: 'preview', name: '预览动作', fps: 12, loop: true, weight: 1,
  anchors: { ground: { x: 0.5, y: 1 } },
  frames: [
    { assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 },
    { assetId: 'atlas', x: 32, y: 0, width: 40, height: 24 }
  ]
};

describe('预览 Alpha 资源策略', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test.each([false, undefined])('预览 Alpha 选项=%s 保留真实帧布局与默认命中', async captureAlphaMask => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const pixi = await import('pixi.js');
    const rgba = new Uint8ClampedArray(72 * 32 * 4);
    rgba[71 * 4 + 3] = 255;
    const getImageData = vi.fn(() => ({ data: rgba }));
    getContext.mockClear().mockReturnValue({
      drawImage: vi.fn(), getImageData
    } as never);
    const textures: InstanceType<typeof pixi.Texture>[] = [];
    // 图形设备与解码由夹具替代；纹理、精灵和布局仍使用安装版本的真实 Pixi。
    class TestTexture extends pixi.Texture {
      static override from(resource: Parameters<typeof pixi.Texture.from>[0]) {
        const image = resource as HTMLImageElement;
        const texture = new pixi.Texture({ source: new pixi.TextureSource({
          resource: image, width: image.naturalWidth, height: image.naturalHeight
        }) });
        textures.push(texture);
        return texture;
      }
    }
    class TestApplication {
      canvas = document.createElement('canvas');
      screen = new pixi.Rectangle(0, 0, 100, 100);
      stage = new pixi.Container();
      ticker = new pixi.Ticker();
      init = async () => undefined;
      render = () => undefined;
      destroy() { this.ticker.destroy(); this.stage.destroy(); }
    }
    vi.stubGlobal('Image', class {
      src = '';
      naturalWidth = 72;
      naturalHeight = 32;
      decode = async () => undefined;
    });
    let scene: PixiCharacterScene | undefined;
    try {
      scene = await createBrowserPixiCharacterScene(
        document.createElement('div'),
        async () => ({ ...pixi, Application: TestApplication, Texture: TestTexture }) as never,
        captureAlphaMask === undefined ? {} : { captureAlphaMask }
      );
      await scene.loadAssets(new Map([['atlas', 'blob:preview-atlas']]));
      scene.showAction(action, {
        direction: 'left', motionMode: 'static', frameIndex: 1, speed: 1.5, loop: true
      });

      expect(scene.getCurrentFrame()).toMatchObject({
        action, frameIndex: 1, bounds: { x: 0, y: 40, width: 100, height: 60 }
      });
      expect(textures[0]?.source).toMatchObject({ width: 72, height: 32 });
      expect(textures[0]?.source.resource).toMatchObject({ src: 'blob:preview-atlas' });
      if (captureAlphaMask === false) {
        expect(getContext).not.toHaveBeenCalled();
        expect(getImageData).not.toHaveBeenCalled();
        expect(scene.getHitSnapshot?.()).toBeNull();
      } else {
        expect(getImageData).toHaveBeenCalledOnce();
        expect(scene.getHitSnapshot?.()?.mask).toMatchObject({ width: 72, height: 32 });
        expect(readAlphaMask(scene.getHitSnapshot?.()?.mask, 71, 0)).toBe(255);
      }
      scene.destroy();
      expect(textures[0]?.destroyed).toBe(true);
    } finally {
      scene?.destroy();
    }
  });
});
