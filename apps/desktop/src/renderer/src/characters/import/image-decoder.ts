export type CharacterImageMimeType = 'image/png' | 'image/webp';

export type ImageBitmapLike = {
  width: number;
  height: number;
  close(): void;
};

/**
 * 统一通过文件魔数识别角色图片，避免扩展名或调用方猜测内容类型。
 */
export function imageMimeType(bytes: Uint8Array): CharacterImageMimeType {
  const png = [0x89, 0x50, 0x4e, 0x47]
    .every((value, index) => bytes[index] === value);
  if (png) return 'image/png';

  const webp = bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
  if (webp) return 'image/webp';

  throw new Error('CHARACTER_IMAGE_MIME_UNSUPPORTED');
}

export async function decodeSource(
  bytes: Uint8Array,
  mimeType: string
): Promise<ImageBitmapLike> {
  if (mimeType !== 'image/png' && mimeType !== 'image/webp') {
    throw new Error('CHARACTER_IMAGE_MIME_UNSUPPORTED');
  }

  const safeBytes = Uint8Array.from(bytes);
  return createImageBitmap(new Blob([safeBytes.buffer], { type: mimeType }));
}
