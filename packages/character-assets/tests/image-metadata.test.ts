import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RESOURCE_LIMITS,
  parseCharacterImageMetadata
} from '../src';

const PNG_BYTES = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
));
const WEBP_BYTES = new Uint8Array(Buffer.from(
  'UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA',
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

describe('角色图片结构元数据', () => {
  test.each([
    ['image/png', PNG_BYTES],
    ['image/webp', WEBP_BYTES]
  ] as const)('验证完整 %s 并返回格式与尺寸', (mimeType, bytes) => {
    expect(parseCharacterImageMetadata(bytes, mimeType)).toEqual({
      mimeType,
      width: 1,
      height: 1
    });
  });

  test('拒绝超过统一尺寸上限的完整 PNG 结构', () => {
    expect(() => parseCharacterImageMetadata(oversizedPng(), 'image/png'))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });

  test('拒绝格式声明与真实结构不一致', () => {
    expect(() => parseCharacterImageMetadata(WEBP_BYTES, 'image/png'))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });
});
