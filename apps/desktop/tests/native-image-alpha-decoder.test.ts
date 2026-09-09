import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CHARACTER_RESOURCE_LIMITS } from '@myself/character-assets';

const { createFromBuffer } = vi.hoisted(() => ({ createFromBuffer: vi.fn() }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer } }));

import { decodeNativeImageAlpha } from '../src/main/characters/native-image-alpha-decoder';

const PNG_BYTES = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
));
const OVERSIZED_WEBP = new Uint8Array(Buffer.from(
  'UklGRsQAAABXRUJQVlA4ILgAAABwEQCdASoBEAEAPm02mUmkIyKhICgAgA2JaW7hd2Ee3AfgAAAT2Ae+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snH8AD+/uB7///yC5YXXI1///ID/kB/yA//j4pqtOBAAAAAAAAAA',
  'base64'
));

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function oversizedPng(): Uint8Array {
  const bytes = Uint8Array.from(PNG_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, CHARACTER_RESOURCE_LIMITS.maxFrameDimension + 1);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return bytes;
}

describe('Electron 原生角色 Alpha 解码', () => {
  beforeEach(() => createFromBuffer.mockReset());

  test('按 nativeImage bitmap 的第四字节提取 Alpha 并保留尺寸', async () => {
    createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([10, 20, 30, 40])
    });

    await expect(decodeNativeImageAlpha(PNG_BYTES, 'image/png')).resolves.toEqual({
      width: 1,
      height: 1,
      alpha: new Uint8Array([40])
    });
  });

  test.each([
    { size: { width: 1, height: 1 }, bitmap: Buffer.alloc(3), empty: false },
    { size: { width: 0, height: 1 }, bitmap: Buffer.alloc(0), empty: false },
    { size: { width: 2, height: 1 }, bitmap: Buffer.alloc(8), empty: false },
    { size: { width: 1, height: 1 }, bitmap: Buffer.alloc(4), empty: true }
  ])('拒绝空图、非法尺寸或 bitmap 长度不一致', async ({ size, bitmap, empty }) => {
    createFromBuffer.mockReturnValue({
      isEmpty: () => empty,
      getSize: () => size,
      toBitmap: () => bitmap
    });

    await expect(decodeNativeImageAlpha(PNG_BYTES, 'image/png'))
      .rejects.toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });

  test.each([
    ['image/png', oversizedPng()],
    ['image/webp', OVERSIZED_WEBP]
  ] as const)('超尺寸 %s 在调用 nativeImage 前拒绝', async (mimeType, bytes) => {
    await expect(decodeNativeImageAlpha(bytes, mimeType))
      .rejects.toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
    expect(createFromBuffer).not.toHaveBeenCalled();
  });
});
