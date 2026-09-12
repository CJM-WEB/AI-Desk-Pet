import { deflateSync } from 'node:zlib';
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

function pngWithDimensions(width: number, height = 1): Uint8Array {
  const bytes = Uint8Array.from(PNG_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return bytes;
}

/** 真实宽图只占一行像素，避免把元数据策略测试变成内存压力测试。 */
function widePng(): Uint8Array {
  const header = pngWithDimensions(65_536).subarray(0, 33);
  const compressed = deflateSync(Buffer.alloc(65_536 * 4 + 1));
  const data = Buffer.alloc(compressed.byteLength + 12);
  data.writeUInt32BE(compressed.byteLength, 0);
  data.write('IDAT', 4);
  compressed.copy(data, 8);
  data.writeUInt32BE(crc32(data.subarray(4, -4)), data.byteLength - 4);
  return Buffer.concat([header, data, PNG_BYTES.subarray(-12)]);
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

  test('默认运行资源仍拒绝超过图集尺寸上限的 PNG', () => {
    expect(() => parseCharacterImageMetadata(
      pngWithDimensions(CHARACTER_RESOURCE_LIMITS.maxFrameDimension + 1), 'image/png'
    ))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });

  test('源图解析接受 65536 像素宽的真实 PNG，不借用单帧上限', () => {
    expect(parseCharacterImageMetadata(widePng(), 'image/png', { purpose: 'source' }))
      .toEqual({ mimeType: 'image/png', width: 65_536, height: 1 });
  });

  test.each([[0, 1], [1, 0], [0x80000000, 1], [1, 0x80000000]])(
    '源图继续拒绝 PNG 格式无效尺寸 %s×%s', (width, height) => {
      expect(() => parseCharacterImageMetadata(
        pngWithDimensions(width!, height!), 'image/png', { purpose: 'source' }
      )).toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
    }
  );

  test('源图尺寸放宽后仍拒绝 CRC 损坏与格式伪装', () => {
    const broken = widePng();
    broken[29] = broken[29]! ^ 1;
    expect(() => parseCharacterImageMetadata(broken, 'image/png', { purpose: 'source' }))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
    expect(() => parseCharacterImageMetadata(WEBP_BYTES, 'image/png', { purpose: 'source' }))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });

  test('拒绝格式声明与真实结构不一致', () => {
    expect(() => parseCharacterImageMetadata(WEBP_BYTES, 'image/png'))
      .toThrow('CHARACTER_IMAGE_STRUCTURE_INVALID');
  });
});
