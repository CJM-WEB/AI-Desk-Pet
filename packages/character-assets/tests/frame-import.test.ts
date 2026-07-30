import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RESOURCE_LIMITS,
  planSpriteSheetFrames,
  sortFrameFiles
} from '../src';

describe('精灵图帧规划', () => {
  test('按水平优先生成精确坐标并忽略末尾空白格', () => {
    expect(planSpriteSheetFrames({
      imageWidth: 400,
      imageHeight: 200,
      rows: 2,
      columns: 4,
      frameCount: 6,
      order: 'row-major'
    })).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 100 },
      { x: 300, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 100, y: 100, width: 100, height: 100 }
    ]);
  });

  test('按垂直优先生成精确坐标', () => {
    expect(planSpriteSheetFrames({
      imageWidth: 300,
      imageHeight: 200,
      rows: 2,
      columns: 3,
      frameCount: 5,
      order: 'column-major'
    })).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 100, y: 100, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 100 }
    ]);
  });

  test.each([
    ['imageWidth', 0],
    ['imageHeight', -1],
    ['rows', 1.5],
    ['columns', Number.NaN],
    ['frameCount', Number.POSITIVE_INFINITY]
  ] as const)('%s 必须是正整数', (field, value) => {
    const input = {
      imageWidth: 200,
      imageHeight: 200,
      rows: 2,
      columns: 2,
      frameCount: 4,
      order: 'row-major' as const,
      [field]: value
    };

    expect(() => planSpriteSheetFrames(input)).toThrow('CHARACTER_FRAME_INPUT_INVALID');
  });

  test('拒绝无法整除的网格', () => {
    expect(() => planSpriteSheetFrames({
      imageWidth: 201,
      imageHeight: 200,
      rows: 2,
      columns: 2,
      frameCount: 4,
      order: 'row-major'
    })).toThrow('CHARACTER_SPRITE_GRID_NOT_DIVISIBLE');
  });

  test('拒绝超过网格容量或动作资源上限的帧数', () => {
    expect(() => planSpriteSheetFrames({
      imageWidth: 200,
      imageHeight: 200,
      rows: 2,
      columns: 2,
      frameCount: 5,
      order: 'row-major'
    })).toThrow('CHARACTER_FRAME_COUNT_EXCEEDED');

    expect(() => planSpriteSheetFrames({
      imageWidth: CHARACTER_RESOURCE_LIMITS.maxFramesPerAction + 1,
      imageHeight: 1,
      rows: 1,
      columns: CHARACTER_RESOURCE_LIMITS.maxFramesPerAction + 1,
      frameCount: CHARACTER_RESOURCE_LIMITS.maxFramesPerAction + 1,
      order: 'row-major'
    })).toThrow('CHARACTER_FRAME_COUNT_EXCEEDED');
  });

  test('拒绝超过单帧最大维度和无效读取顺序', () => {
    expect(() => planSpriteSheetFrames({
      imageWidth: CHARACTER_RESOURCE_LIMITS.maxFrameDimension + 1,
      imageHeight: 1,
      rows: 1,
      columns: 1,
      frameCount: 1,
      order: 'row-major'
    })).toThrow('CHARACTER_FRAME_DIMENSION_EXCEEDED');

    expect(() => planSpriteSheetFrames({
      imageWidth: 100,
      imageHeight: 100,
      rows: 1,
      columns: 1,
      frameCount: 1,
      order: 'diagonal' as 'row-major'
    })).toThrow('CHARACTER_FRAME_ORDER_INVALID');
  });

  test('规划过程不修改输入', () => {
    const input = {
      imageWidth: 200,
      imageHeight: 100,
      rows: 1,
      columns: 2,
      frameCount: 2,
      order: 'row-major' as const
    };
    const before = structuredClone(input);

    planSpriteSheetFrames(input);

    expect(input).toEqual(before);
  });
});

describe('独立帧自然排序', () => {
  test('按数字自然顺序稳定排序且不修改输入', () => {
    const names = ['frame10.png', 'frame2.png', 'frame01.png', 'frame1.png', 'frame01.png'];
    const before = [...names];

    expect(sortFrameFiles(names)).toEqual([
      'frame01.png',
      'frame1.png',
      'frame01.png',
      'frame2.png',
      'frame10.png'
    ]);
    expect(names).toEqual(before);
  });
});
