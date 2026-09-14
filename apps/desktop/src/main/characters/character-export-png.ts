import { promisify } from 'node:util';
import { crc32, deflate, inflate } from 'node:zlib';

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxExpandedBytes = 128 * 1024 * 1024;
const maxOptimizationChunks = 8192;
const supportedChunks = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT',
  'sRGB', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'tIME', 'iTXt', 'tEXt', 'zTXt', 'eXIf'
]);

// 仅替换静态 PNG 的压缩表示；不解码像素，也不承担导入安全裁决。
export async function optimizePngForExport(input: Buffer): Promise<Buffer> {
  try {
    if (!input.subarray(0, 8).equals(signature)) return input;
    const chunks: { type: string; bytes: Buffer; data: Buffer }[] = [];
    let offset = 8;
    let idatEnded = false;
    let sawIdat = false;
    while (offset < input.length) {
      // 块对象与后续 filter/map 同受此预算约束，避免空块放大工作内存。
      if (chunks.length >= maxOptimizationChunks) return input;
      if (input.length - offset < 12) return input;
      const length = input.readUInt32BE(offset);
      const end = offset + length + 12;
      if (end > input.length) return input;
      const type = input.toString('ascii', offset + 4, offset + 8);
      const bytes = input.subarray(offset, end);
      const typeBytes = bytes.subarray(4, 8);
      if (!typeBytes.every(value => (value >= 65 && value <= 90) || (value >= 97 && value <= 122)) ||
        !supportedChunks.has(type) || crc32(bytes.subarray(4, -4)) !== bytes.readUInt32BE(bytes.length - 4)) return input;
      if (type === 'IDAT') {
        if (idatEnded) return input;
        sawIdat = true;
      } else if (sawIdat) idatEnded = true;
      chunks.push({ type, bytes, data: bytes.subarray(8, -4) });
      offset = end;
      if (type === 'IEND') break;
    }
    const header = chunks[0];
    if (offset !== input.length || header?.type !== 'IHDR' || header.data.length !== 13 ||
      chunks.filter(c => c.type === 'IHDR').length !== 1 || !sawIdat ||
      chunks.at(-1)?.type !== 'IEND' || chunks.at(-1)?.data.length !== 0) return input;
    const width = header.data.readUInt32BE(0);
    const height = header.data.readUInt32BE(4);
    const depth = header.data[8]!;
    const color = header.data[9]!;
    const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(color);
    const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
    // Adam7 及不确定结构保留原字节；预算检查不分配声明尺寸的内存。
    if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !channels || !depths.includes(depth) ||
      header.data[10] !== 0 || header.data[11] !== 0 || header.data[12] !== 0) return input;
    const rowLength = 1 + Math.ceil(width * channels * depth / 8);
    const expandedLength = rowLength * height;
    if (expandedLength > maxExpandedBytes) return input;
    const palettes = chunks.filter(c => c.type === 'PLTE');
    if (palettes.length > 1 || (color === 3 && palettes.length !== 1) ||
      ((color === 0 || color === 4) && palettes.length !== 0) ||
      (color === 3 && palettes[0]!.data.length / 3 > 2 ** depth) ||
      palettes.some(c => c.data.length === 0 || c.data.length > 768 || c.data.length % 3 !== 0 || chunks.indexOf(c) > chunks.findIndex(v => v.type === 'IDAT'))) return input;
    const compressed = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
    const filtered = await inflateAsync(compressed, { maxOutputLength: expandedLength });
    if (filtered.length !== expandedLength) return input;
    for (let row = 0; row < height; row++) if (filtered[row * rowLength]! > 4) return input;
    // 顺序尝试两个内置配置，避免同时持有多张展开图或多个压缩工作区。
    let smallest = await deflateAsync(filtered, { level: 9, memLevel: 8 });
    const alternate = await deflateAsync(filtered, { level: 9, memLevel: 9 });
    if (alternate.length < smallest.length) smallest = alternate;
    const idat = Buffer.alloc(smallest.length + 12);
    idat.writeUInt32BE(smallest.length);
    idat.write('IDAT', 4, 'ascii');
    smallest.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
    let replaced = false;
    const output = Buffer.concat([signature, ...chunks.flatMap(c => {
      if (c.type !== 'IDAT') return [c.bytes];
      if (replaced) return [];
      replaced = true;
      return [idat];
    })]);
    return output.length < input.length ? output : input;
  } catch {
    // 优化失败只影响收益；服务层的来源校验与归档错误继续独立传播。
    return input;
  }
}
