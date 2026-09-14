import { describe, expect, test } from 'vitest';
import {
  createAlphaMask,
  hitTestCharacterAlpha,
  readAlphaMask,
  type AlphaMask,
  type CharacterHitSnapshot
} from '../src/renderer/src/characters/player/character-alpha-hit-tester';

function snapshot(
  bytes: number[],
  direction: 'left' | 'right' = 'right'
): CharacterHitSnapshot {
  return {
    mask: { width: 4, height: 1, bytes: new Uint8Array(bytes) },
    sourceRect: { x: 0, y: 0, width: 4, height: 1 },
    frameBounds: { x: 10, y: 20, width: 40, height: 10 },
    direction
  };
}

describe('角色逐帧 Alpha 命中', () => {
  test('仅将大于默认阈值 16 的不透明像素判为命中', () => {
    const current = snapshot([0, 16, 17, 255]);

    expect(hitTestCharacterAlpha(current, { x: 15, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 25, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 35, y: 25 })).toBe(true);
    expect(hitTestCharacterAlpha(current, { x: 45, y: 25 })).toBe(true);
  });

  test('将画布左向布局镜像映射到源帧右侧 Alpha', () => {
    const current = snapshot([0, 0, 0, 255], 'left');

    expect(hitTestCharacterAlpha(current, { x: 15, y: 25 })).toBe(true);
    expect(hitTestCharacterAlpha(current, { x: 45, y: 25 })).toBe(false);
  });

  test('透明空洞、负坐标、右边界和下边界均不命中', () => {
    const current = snapshot([255, 0, 255, 255]);

    expect(hitTestCharacterAlpha(current, { x: 25, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: -1, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 50, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 15, y: 30 })).toBe(false);
  });

  test('右向的左边界映射到源帧首列', () => {
    expect(hitTestCharacterAlpha(snapshot([255, 0, 0, 0]), { x: 10, y: 25 })).toBe(true);
  });

  test('上边界映射到源帧首行', () => {
    expect(hitTestCharacterAlpha(snapshot([255, 0, 0, 0]), { x: 15, y: 20 })).toBe(true);
  });

  test('左上角属于半开帧矩形', () => {
    expect(hitTestCharacterAlpha(snapshot([255, 0, 0, 0]), { x: 10, y: 20 })).toBe(true);
  });

  test('左向的左边界映射到源帧末列', () => {
    expect(hitTestCharacterAlpha(snapshot([0, 0, 0, 255], 'left'), { x: 10, y: 25 })).toBe(true);
  });

  test('无效快照和异常数据均 fail-open，不抛出异常', () => {
    expect(hitTestCharacterAlpha(null, { x: 10, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(snapshot([255]), { x: Number.NaN, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(snapshot([255]), { x: 10, y: Infinity })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      frameBounds: { x: 0, y: 0, width: 0, height: 1 }
    }, { x: 0, y: 0 })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      sourceRect: { x: 3, y: 0, width: 2, height: 1 }
    }, { x: 15, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      mask: { width: 4, height: 1, bytes: new Uint8Array(3) }
    }, { x: 15, y: 25 })).toBe(false);
  });
});

/** RGBA夹具的Alpha直接来自给定原值，RGB故意不同以识别错误通道。 */
function rgbaFromAlpha(values: readonly number[]): Uint8ClampedArray {
  return Uint8ClampedArray.from(values.flatMap(value => [91, 37, 201, value]));
}

function storageBytes(mask: AlphaMask): number {
  return 'bytes' in mask ? mask.bytes.byteLength : mask.byteLength;
}

describe('Alpha 无损游程存储', () => {
  test('保留全部256种Alpha与全部阈值关系，并且只保存小于raw的存储', () => {
    const values = Array.from({ length: 256 }, (_, value) => Array<number>(32).fill(value)).flat();
    const mask = createAlphaMask(8192, 1, rgbaFromAlpha(values));
    expect(mask).not.toBeNull();
    expect(storageBytes(mask!)).toBeLessThan(values.length / 4);
    expect(mask).not.toHaveProperty('bytes');
    const current: CharacterHitSnapshot = {
      mask: mask!, sourceRect: { x: 0, y: 0, width: 8192, height: 1 },
      frameBounds: { x: 0, y: 0, width: 8192, height: 1 }, direction: 'right'
    };
    for (let value = 0; value < 256; value++) {
      expect(readAlphaMask(mask, value * 32, 0)).toBe(value);
      expect(readAlphaMask(mask, value * 32 + 31, 0)).toBe(value);
      for (let threshold = 0; threshold < 256; threshold++) {
        expect(hitTestCharacterAlpha(current, { x: value * 32, y: 0 }, threshold)).toBe(value > threshold);
      }
      for (const threshold of [-1, 0.5, 16.5, 254.5, 256]) {
        expect(hitTestCharacterAlpha(current, { x: value * 32, y: 0 }, threshold)).toBe(value > threshold);
      }
    }
  });

  test('行首末列、透明整行、裁切多帧与左右镜像沿用原像素', () => {
    const values = [...Array<number>(64).fill(0), ...Array<number>(32).fill(16),
      ...Array<number>(32).fill(255), ...Array<number>(64).fill(17)];
    const mask = createAlphaMask(64, 3, rgbaFromAlpha(values));
    expect(storageBytes(mask!)).toBeLessThan(values.length);
    for (const [x, y, expected] of [[0,0,0], [63,0,0], [0,1,16], [31,1,16], [32,1,255], [63,1,255], [0,2,17], [63,2,17]]) {
      expect(readAlphaMask(mask, x!, y!)).toBe(expected);
    }
    const current: CharacterHitSnapshot = {
      mask: mask!, sourceRect: { x: 16, y: 1, width: 32, height: 2 },
      frameBounds: { x: 10, y: 20, width: 64, height: 40 }, direction: 'right'
    };
    expect(hitTestCharacterAlpha(current, { x: 10, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 42, y: 20 })).toBe(true);
    expect(hitTestCharacterAlpha({ ...current, direction: 'left' }, { x: 10, y: 20 })).toBe(true);
    expect(hitTestCharacterAlpha({ ...current, direction: 'left' }, { x: 73.999, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 10, y: 59.999 })).toBe(true);
    expect(hitTestCharacterAlpha(current, { x: 74, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 10, y: 60 })).toBe(false);
  });

  test('高频变化与单像素回退raw，不保留RGBA引用或额外大副本', () => {
    const rgba = rgbaFromAlpha([0, 128, 255, 16]);
    const mask = createAlphaMask(2, 2, rgba)!;
    expect(storageBytes(mask)).toBe(4);
    expect(mask).toHaveProperty('bytes');
    rgba.fill(0);
    expect(readAlphaMask(mask, 1, 0)).toBe(128);
    expect(readAlphaMask(mask, 0, 1)).toBe(255);
    const single = createAlphaMask(1, 1, rgbaFromAlpha([91]))!;
    expect(storageBytes(single)).toBe(1);
    expect(readAlphaMask(single, 0, 0)).toBe(91);
  });

  test('拒绝异常尺寸或RGBA长度，非法坐标、阈值和伪造压缩对象始终穿透', () => {
    for (const [width, height] of [[0,1], [-1,1], [1.5,1], [1,0], [Infinity,1], [1,Number.NaN]]) {
      expect(createAlphaMask(width!, height!, rgbaFromAlpha([255]))).toBeNull();
    }
    expect(createAlphaMask(2, 2, rgbaFromAlpha([255]))).toBeNull();
    const mask = createAlphaMask(64, 2, rgbaFromAlpha(Array<number>(128).fill(255)))!;
    for (const [x,y] of [[-1,0], [64,0], [0,2], [0.5,0], [0,Infinity], [Number.NaN,0]]) {
      expect(readAlphaMask(mask, x!, y!)).toBeUndefined();
    }
    const current: CharacterHitSnapshot = { mask, sourceRect: { x:0,y:0,width:64,height:2 },
      frameBounds: { x:0,y:0,width:64,height:2 }, direction:'right' };
    for (const threshold of [Infinity, -Infinity, Number.NaN]) {
      expect(hitTestCharacterAlpha(current, { x:0,y:0 }, threshold)).toBe(false);
    }
    expect(hitTestCharacterAlpha({ ...current, sourceRect: {x:63,y:0,width:2,height:1} }, {x:0,y:0})).toBe(false);
    expect(hitTestCharacterAlpha({ ...current, mask: { width:64,height:2,byteLength:9 } as AlphaMask }, {x:0,y:0}, -1)).toBe(false);
    expect(readAlphaMask(null, 0, 0)).toBeUndefined();
  });
});
