import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { optimizePngForExport } from '../src/main/characters/character-export-png';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function fixture(depth = 8, color = 6, interlace = 0, level = 0, width = 32): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(8, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  const channels = color === 3 ? 1 : 4;
  const rows = Buffer.alloc(8 * (1 + 32 * channels * depth / 8));
  // 全透明像素仍带非零 RGB；优化必须保留这些隐藏通道。
  if (color === 6) for (let row = 0; row < 8; row++) {
    for (let x = 0; x < 32; x++) rows[row * (1 + 32 * channels * depth / 8) + 1 + x * channels * depth / 8] = 73;
  }
  const compressed = deflateSync(rows, { level, memLevel: 8 });
  const split = Math.floor(compressed.length / 2);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('gAMA', Buffer.from('0000b18f', 'hex')),
    ...(color === 3 ? [chunk('PLTE', Buffer.from([73, 2, 3])), chunk('tRNS', Buffer.from([0]))] : []),
    chunk('tEXt', Buffer.from('key\0中文')), chunk('IDAT', compressed.subarray(0, split)),
    chunk('IDAT', compressed.subarray(split)), chunk('IEND')]);
}
function chunks(input: Buffer): { type: string; bytes: Buffer; data: Buffer }[] {
  const result = [];
  for (let offset = 8; offset < input.length;) {
    const size = input.readUInt32BE(offset);
    result.push({ type: input.toString('ascii', offset + 4, offset + 8), bytes: input.subarray(offset, offset + size + 12), data: input.subarray(offset + 8, offset + 8 + size) });
    offset += size + 12;
  }
  return result;
}
describe('角色导出 PNG 无损优化', () => {
  test.each([[8, 6], [16, 6], [8, 3]])('缩小 %ibit 类型 %i 并保留过滤流和全部元数据', async (depth, color) => {
    const input = fixture(depth, color);
    const snapshot = Buffer.from(input);
    const output = await optimizePngForExport(input);
    expect(output.length).toBeLessThan(input.length);
    const raw = (value: Buffer) => inflateSync(Buffer.concat(chunks(value).filter(c => c.type === 'IDAT').map(c => c.data)));
    expect(raw(output)).toEqual(raw(input));
    expect(chunks(output).filter(c => c.type !== 'IDAT').map(c => c.bytes)).toEqual(chunks(input).filter(c => c.type !== 'IDAT').map(c => c.bytes));
    expect(input).toEqual(snapshot);
    for (const c of chunks(output)) expect(c.bytes.readUInt32BE(c.bytes.length - 4)).toBe(crc32(c.bytes.subarray(4, -4)));
  });
  test('已最小压缩不重复改写', async () => {
    const once = await optimizePngForExport(fixture());
    expect(await optimizePngForExport(once)).toBe(once);
  });
  test('大量连续空 IDAT 超出优化块预算时直接回退', async () => {
    const originalChunks = chunks(fixture());
    const firstIdat = originalChunks.findIndex(c => c.type === 'IDAT');
    // 空 IDAT 不改变合法压缩流；小数据即可复现解析对象膨胀。
    const input = Buffer.concat([signature,
      ...originalChunks.slice(0, firstIdat).map(c => c.bytes),
      ...Array.from({ length: 10000 }, () => chunk('IDAT')),
      ...originalChunks.slice(firstIdat).map(c => c.bytes)]);
    expect((await optimizePngForExport(input)) === input).toBe(true);
  });
  test('损坏、截断、未知块、动画、交错及超预算回退原 Buffer', async () => {
    const input = fixture();
    const corrupt = Buffer.from(input); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    const invalidZlib = Buffer.concat([signature, ...chunks(input).map(c => c.type === 'IDAT' ? chunk('IDAT', Buffer.from([1, 2, 3])) : c.bytes)]);
    const originalChunks = chunks(input);
    const separatedIdat = Buffer.concat([signature, ...originalChunks.flatMap(c => c.type === 'IDAT' ? [c.bytes, chunk('tEXt', Buffer.from('key\0value'))] : [c.bytes])]);
    for (const value of [Buffer.from('not png'), corrupt, input.subarray(0, -1),
      Buffer.concat([input.subarray(0, 33), chunk('vpAg'), input.subarray(33)]),
      Buffer.concat([input.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), input.subarray(33)]),
      fixture(8, 6, 1), fixture(8, 6, 0, 0, 0xffffffff), invalidZlib, separatedIdat,
      Buffer.concat([input, Buffer.from([0])]),
      Buffer.concat([signature, originalChunks[0]!.bytes, ...originalChunks.map(c => c.bytes)])]) {
      expect(await optimizePngForExport(value)).toBe(value);
    }
  });
});
