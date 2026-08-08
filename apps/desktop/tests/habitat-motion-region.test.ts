import { describe, expect, test } from 'vitest';

import { calculateHabitatMovementRegions } from
  '../src/main/habitat/habitat-motion-region';

describe('目录空间运动区域', () => {
  test('Explorer 外框与工作区取交集，避开负坐标屏幕的任务栏', () => {
    expect(calculateHabitatMovementRegions({
      explorerBounds: { x: -1800, y: -40, width: 1700, height: 1120 },
      workAreas: [
        { x: -1920, y: 0, width: 1920, height: 1040 },
        { x: 0, y: 0, width: 1920, height: 1040 }
      ],
      windowSize: { width: 180, height: 220 }
    })).toEqual([
      { x: -1800, y: 0, width: 1700, height: 1040 }
    ]);
  });

  test('只保留能完整容纳桌宠窗口的多显示器交集', () => {
    expect(calculateHabitatMovementRegions({
      explorerBounds: { x: 900, y: 100, width: 300, height: 500 },
      workAreas: [
        { x: 0, y: 0, width: 1000, height: 800 },
        { x: 1000, y: 0, width: 1000, height: 800 }
      ],
      windowSize: { width: 180, height: 220 }
    })).toEqual([
      { x: 1000, y: 100, width: 200, height: 500 }
    ]);
  });

  test('非有限、非正尺寸与无交集输入均不产生可行区域', () => {
    expect(calculateHabitatMovementRegions({
      explorerBounds: { x: 0, y: 0, width: Number.NaN, height: 500 },
      workAreas: [{ x: 0, y: 0, width: 1000, height: 800 }],
      windowSize: { width: 180, height: 220 }
    })).toEqual([]);
    expect(calculateHabitatMovementRegions({
      explorerBounds: { x: 0, y: 0, width: 100, height: 100 },
      workAreas: [{ x: 200, y: 200, width: 100, height: 100 }],
      windowSize: { width: 180, height: 220 }
    })).toEqual([]);
  });
});
