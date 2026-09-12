import { describe, expect, test } from 'vitest';
import {
  CHARACTER_RESOURCE_LIMITS,
  planAtlas,
  type AtlasPlanInput
} from '../src';

function createInput(overrides: Partial<AtlasPlanInput> = {}): AtlasPlanInput {
  return {
    frames: [
      { frameId: 'frame-a', width: 4, height: 3 },
      { frameId: 'frame-b', width: 4, height: 3 },
      { frameId: 'frame-c', width: 5, height: 2 }
    ],
    maxDimension: 8,
    ...overrides
  };
}

describe('纹理图集规划', () => {
  test('按输入顺序逐行放置并返回实际占用尺寸', () => {
    expect(planAtlas(createInput())).toEqual([{
      width: 8,
      height: 5,
      placements: [
        { frameId: 'frame-a', rect: { x: 0, y: 0, width: 4, height: 3 } },
        { frameId: 'frame-b', rect: { x: 4, y: 0, width: 4, height: 3 } },
        { frameId: 'frame-c', rect: { x: 0, y: 3, width: 5, height: 2 } }
      ]
    }]);
  });

  test('未传最大维度时使用统一资源上限', () => {
    const plan = planAtlas({
      frames: [{ frameId: 'maximum', width: 4096, height: 4096 }]
    });

    expect(plan).toEqual([{
      width: 4096,
      height: 4096,
      placements: [
        {
          frameId: 'maximum',
          rect: { x: 0, y: 0, width: 4096, height: 4096 }
        }
      ]
    }]);
  });

  test.each([
    [{ frameId: '', width: 1, height: 1 }, 'CHARACTER_FRAME_ID_INVALID'],
    [{ frameId: 'frame', width: 0, height: 1 }, 'CHARACTER_FRAME_INPUT_INVALID'],
    [{ frameId: 'frame', width: 1.5, height: 1 }, 'CHARACTER_FRAME_INPUT_INVALID'],
    [{ frameId: 'frame', width: 1, height: Number.NaN }, 'CHARACTER_FRAME_INPUT_INVALID'],
    [
      { frameId: 'frame', width: CHARACTER_RESOURCE_LIMITS.maxFrameDimension + 1, height: 1 },
      'CHARACTER_FRAME_DIMENSION_EXCEEDED'
    ]
  ] as const)('拒绝无效帧 %#', (frame, errorCode) => {
    expect(() => planAtlas({
      frames: [frame],
      maxDimension: CHARACTER_RESOURCE_LIMITS.maxFrameDimension
    })).toThrow(errorCode);
  });

  test('拒绝空输入、重复帧标识和超出帧数量上限', () => {
    expect(() => planAtlas({ frames: [] }))
      .toThrow('CHARACTER_ATLAS_EMPTY');

    expect(() => planAtlas({
      frames: [
        { frameId: 'duplicate', width: 1, height: 1 },
        { frameId: 'duplicate', width: 1, height: 1 }
      ]
    })).toThrow('CHARACTER_FRAME_ID_DUPLICATED');

    expect(() => planAtlas({
      frames: Array.from(
        { length: CHARACTER_RESOURCE_LIMITS.maxFramesPerAction + 1 },
        (_, index) => ({ frameId: `frame-${index}`, width: 1, height: 1 })
      )
    })).toThrow('CHARACTER_FRAME_COUNT_EXCEEDED');
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097])(
    '拒绝无效最大维度 %s',
    (maxDimension) => {
      expect(() => planAtlas({
        frames: [{ frameId: 'frame', width: 1, height: 1 }],
        maxDimension
      })).toThrow('CHARACTER_ATLAS_DIMENSION_INVALID');
    }
  );

  test('拒绝单帧超页，累计行高超页时开启下一页', () => {
    expect(() => planAtlas({
      frames: [{ frameId: 'too-wide', width: 9, height: 1 }],
      maxDimension: 8
    })).toThrow('CHARACTER_ATLAS_OVERFLOW');

    expect(planAtlas({
      frames: [
        { frameId: 'first-row', width: 8, height: 5 },
        { frameId: 'second-row', width: 8, height: 4 }
      ],
      maxDimension: 8
    })).toEqual([
      { width: 8, height: 5, placements: [{ frameId: 'first-row', rect: { x: 0, y: 0, width: 8, height: 5 } }] },
      { width: 8, height: 4, placements: [{ frameId: 'second-row', rect: { x: 0, y: 0, width: 8, height: 4 } }] }
    ]);
  });

  test.each([[1024, 16, 1], [1024, 17, 2], [512, 64, 1], [512, 65, 2]])(
    '%s 像素的 %s 帧分页为 %s 页且顺序及边界不变', (dimension, count, pageCount) => {
      const frames = Array.from({ length: count }, (_, index) => ({
        frameId: `frame-${index}`, width: dimension, height: dimension
      }));
      const pages = planAtlas({ frames });
      expect(pages).toHaveLength(pageCount);
      expect(pages.flatMap(page => page.placements.map(placement => placement.frameId)))
        .toEqual(frames.map(frame => frame.frameId));
      for (const page of pages) {
        expect(page.width).toBeLessThanOrEqual(4096);
        expect(page.height).toBeLessThanOrEqual(4096);
        for (const [index, placement] of page.placements.entries()) {
          const rect = placement.rect;
          expect(rect.width).toBe(dimension);
          expect(rect.height).toBe(dimension);
          expect(rect.x + rect.width).toBeLessThanOrEqual(page.width);
          expect(rect.y + rect.height).toBeLessThanOrEqual(page.height);
          for (const previous of page.placements.slice(0, index)) {
            const other = previous.rect;
            expect(rect.x >= other.x + other.width || other.x >= rect.x + rect.width
              || rect.y >= other.y + other.height || other.y >= rect.y + rect.height).toBe(true);
          }
        }
      }
    }
  );

  test('规划过程不修改输入及帧对象', () => {
    const input = createInput();
    const before = structuredClone(input);

    planAtlas(input);

    expect(input).toEqual(before);
  });
});
