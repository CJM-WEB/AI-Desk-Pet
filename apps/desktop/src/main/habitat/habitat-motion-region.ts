import type { Rectangle } from 'electron';

type WindowSize = Pick<Rectangle, 'width' | 'height'>;

export interface HabitatMovementRegionInput {
  explorerBounds: Rectangle;
  workAreas: readonly Rectangle[];
  windowSize: WindowSize;
}

function isFiniteRectangle(rectangle: Rectangle): boolean {
  return Number.isFinite(rectangle.x)
    && Number.isFinite(rectangle.y)
    && Number.isFinite(rectangle.width)
    && Number.isFinite(rectangle.height)
    && rectangle.width > 0
    && rectangle.height > 0;
}

/**
 * 只计算 Explorer 外框与显示器工作区的可行交集，不接触窗口句柄或目录状态。
 */
export function calculateHabitatMovementRegions(
  input: HabitatMovementRegionInput
): Rectangle[] {
  if (
    !isFiniteRectangle(input.explorerBounds)
    || !Number.isFinite(input.windowSize.width)
    || !Number.isFinite(input.windowSize.height)
    || input.windowSize.width <= 0
    || input.windowSize.height <= 0
  ) return [];

  const explorerRight = input.explorerBounds.x + input.explorerBounds.width;
  const explorerBottom = input.explorerBounds.y + input.explorerBounds.height;
  const regions: Rectangle[] = [];
  for (const workArea of input.workAreas) {
    if (!isFiniteRectangle(workArea)) continue;
    const x = Math.max(input.explorerBounds.x, workArea.x);
    const y = Math.max(input.explorerBounds.y, workArea.y);
    const right = Math.min(explorerRight, workArea.x + workArea.width);
    const bottom = Math.min(explorerBottom, workArea.y + workArea.height);
    const width = right - x;
    const height = bottom - y;
    if (width < input.windowSize.width || height < input.windowSize.height) continue;
    regions.push({ x, y, width, height });
  }
  return regions;
}
