import { nativeImage } from 'electron';
import {
  parseCharacterImageMetadata,
  type CharacterImageMimeType
} from '@myself/character-assets';
import type { CharacterAlphaImage } from './character-migrations';

/** Electron bitmap 在 Windows 返回 BGRA；只提取第四字节，避免向迁移层暴露原生对象。 */
export async function decodeNativeImageAlpha(
  bytes: Uint8Array,
  mimeType: CharacterImageMimeType
): Promise<CharacterAlphaImage> {
  const metadata = parseCharacterImageMetadata(bytes, mimeType);
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error('CHARACTER_IMAGE_STRUCTURE_INVALID');
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width !== metadata.width
    || height !== metadata.height
    || bitmap.byteLength !== width * height * 4
  ) {
    throw new Error('CHARACTER_IMAGE_STRUCTURE_INVALID');
  }
  const alpha = new Uint8Array(width * height);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    alpha[pixel] = bitmap[pixel * 4 + 3]!;
  }
  return { width, height, alpha };
}
