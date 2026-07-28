export type CharacterImageMimeType = 'image/png' | 'image/webp';

export type ImageBitmapLike = {
  width: number;
  height: number;
  close(): void;
};

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
