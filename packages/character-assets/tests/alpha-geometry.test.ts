import { describe, expect, test } from 'vitest';
import {
  computePresentationAlphaGeometry,
  createPresentationAlphaGeometryAccumulator
} from '../src';

describe('角色表现 Alpha 几何', () => {
  test('按共同脚底对齐不同尺寸帧并裁掉透明边缘后取联合范围', () => {
    const result = computePresentationAlphaGeometry({
      groundAnchor: { x: 0.5, y: 1 },
      frames: [{
        width: 4,
        height: 4,
        alpha: new Uint8Array([
          0, 0, 0, 0,
          0, 1, 1, 0,
          0, 1, 1, 0,
          0, 0, 0, 0
        ])
      }, {
        width: 2,
        height: 2,
        alpha: new Uint8Array([
          1, 0,
          0, 0
        ])
      }]
    });

    expect(result).toEqual({
      visualBounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      groundAnchor: { x: 0.5, y: 1 }
    });
  });

  test('全部帧透明时拒绝生成伪造包围盒', () => {
    expect(() => computePresentationAlphaGeometry({
      groundAnchor: { x: 0.5, y: 1 },
      frames: [{ width: 2, height: 2, alpha: new Uint8Array(4) }]
    })).toThrow('CHARACTER_PRESENTATION_FULLY_TRANSPARENT');
  });

  test('按源图 stride 直接累计多个帧矩形而不复制裁切数组', () => {
    const accumulator = createPresentationAlphaGeometryAccumulator({
      groundAnchor: { x: 0.5, y: 1 },
      frames: [{ width: 2, height: 2 }, { width: 2, height: 2 }]
    });
    accumulator.addFrame({
      frameIndex: 0,
      sourceWidth: 4,
      sourceHeight: 2,
      sourceAlpha: new Uint8Array([
        255, 0, 0, 0,
        0, 0, 0, 0
      ]),
      sourceRect: { x: 0, y: 0, width: 2, height: 2 }
    });
    accumulator.addFrame({
      frameIndex: 1,
      sourceWidth: 4,
      sourceHeight: 2,
      sourceAlpha: new Uint8Array([
        0, 0, 0, 0,
        0, 0, 0, 255
      ]),
      sourceRect: { x: 2, y: 0, width: 2, height: 2 }
    });

    expect(accumulator.finish()).toEqual({
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 }
    });
  });
});
