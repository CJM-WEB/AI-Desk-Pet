import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';

const defaultAssetDirectory = new URL('../public/characters/default/', import.meta.url);

describe('官网默认角色静态资源', () => {
  test('包含八张四帧透明测试素材及开发流程元数据', async () => {
    const metadata = JSON.parse(await readFile(
      new URL('sprite-metadata.json', defaultAssetDirectory),
      'utf8'
    )) as {
      generatedBy?: string;
      sprites: Record<string, { fileName: string; frameCount: number }>;
    };

    expect(metadata.generatedBy).toBe('development-workflow');
    expect(Object.keys(metadata.sprites)).toHaveLength(8);
    for (const sprite of Object.values(metadata.sprites)) {
      expect(sprite.frameCount).toBe(4);
      const websiteBytes = await readFile(new URL(sprite.fileName, defaultAssetDirectory));
      const image = sharp(websiteBytes);
      const [imageMetadata, statistics] = await Promise.all([
        image.metadata(),
        image.stats()
      ]);

      expect(imageMetadata).toMatchObject({
        width: 1024,
        height: 256,
        format: 'png',
        hasAlpha: true,
        channels: 4
      });
      expect(statistics.channels[3]?.min).toBe(0);
      expect(statistics.channels[3]?.max).toBe(255);
    }
  });
});
