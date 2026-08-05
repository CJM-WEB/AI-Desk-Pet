import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MODEL_ASSETS = [
  'newWindows.glb',
  'newMac.glb'
];

describe('下载模块原始模型资源', () => {
  it.each(MODEL_ASSETS)('%s 是结构完整的未压缩 GLB', async (fileName) => {
    const model = await readFile(path.join(process.cwd(), 'public', fileName));

    expect(model.subarray(0, 4).toString('ascii')).toBe('glTF');
    expect(model.readUInt32LE(4)).toBe(2);
    expect(model.readUInt32LE(8)).toBe(model.length);
  });
});
