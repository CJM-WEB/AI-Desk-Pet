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
    expect(planAtlas(createInput())).toEqual({
      width: 8,
      height: 5,
      placements: [
        { frameId: 'frame-a', rect: { x: 0, y: 0, width: 4, height: 3 } },
        { frameId: 'frame-b', rect: { x: 4, y: 0, width: 4, height: 3 } },
        { frameId: 'frame-c', rect: { x: 0, y: 3, width: 5, height: 2 } }
      ]
    });
  });

  test('未传最大维度时使用统一资源上限', () => {
    const plan = planAtlas({
      frames: [{ frameId: 'maximum', width: 4096, height: 4096 }]
    });

    expect(plan).toEqual({
      width: 4096,
      height: 4096,
      placements: [
        {
          frameId: 'maximum',
          rect: { x: 0, y: 0, width: 4096, height: 4096 }
        }
      ]
    });
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

  test('拒绝单帧宽高或累计行高导致的图集溢出', () => {
    expect(() => planAtlas({
      frames: [{ frameId: 'too-wide', width: 9, height: 1 }],
      maxDimension: 8
    })).toThrow('CHARACTER_ATLAS_OVERFLOW');

    expect(() => planAtlas({
      frames: [
        { frameId: 'first-row', width: 8, height: 5 },
        { frameId: 'second-row', width: 8, height: 4 }
      ],
      maxDimension: 8
    })).toThrow('CHARACTER_ATLAS_OVERFLOW');
  });

  test('规划过程不修改输入及帧对象', () => {
    const input = createInput();
    const before = structuredClone(input);

    planAtlas(input);

    expect(input).toEqual(before);
  });
});
