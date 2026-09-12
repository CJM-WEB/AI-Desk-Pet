import type { FrameRect } from './frame-import';
import { CHARACTER_RESOURCE_LIMITS } from './resource-limits';

export type AtlasFrameInput = {
  frameId: string;
  width: number;
  height: number;
};

export type AtlasPlanInput = {
  frames: readonly AtlasFrameInput[];
  maxDimension?: number;
};

export type AtlasPlan = {
  width: number;
  height: number;
  placements: Array<{ frameId: string; rect: FrameRect }>;
};

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function planAtlas(input: AtlasPlanInput): AtlasPlan[] {
  const maxDimension = input.maxDimension
    ?? CHARACTER_RESOURCE_LIMITS.maxFrameDimension;

  if (
    !isPositiveInteger(maxDimension)
    || maxDimension > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
  ) {
    throw new Error('CHARACTER_ATLAS_DIMENSION_INVALID');
  }

  if (input.frames.length === 0) {
    throw new Error('CHARACTER_ATLAS_EMPTY');
  }

  if (input.frames.length > CHARACTER_RESOURCE_LIMITS.maxFramesPerAction) {
    throw new Error('CHARACTER_FRAME_COUNT_EXCEEDED');
  }

  const seenFrameIds = new Set<string>();

  for (const frame of input.frames) {
    if (typeof frame.frameId !== 'string' || frame.frameId.trim().length === 0) {
      throw new Error('CHARACTER_FRAME_ID_INVALID');
    }

    if (seenFrameIds.has(frame.frameId)) {
      throw new Error('CHARACTER_FRAME_ID_DUPLICATED');
    }
    seenFrameIds.add(frame.frameId);

    if (!isPositiveInteger(frame.width) || !isPositiveInteger(frame.height)) {
      throw new Error('CHARACTER_FRAME_INPUT_INVALID');
    }

    if (
      frame.width > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
      || frame.height > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
    ) {
      throw new Error('CHARACTER_FRAME_DIMENSION_EXCEEDED');
    }
  }

  let page: AtlasPlan = { width: 0, height: 0, placements: [] };
  const pages = [page];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const frame of input.frames) {
    if (frame.width > maxDimension || frame.height > maxDimension) {
      throw new Error('CHARACTER_ATLAS_OVERFLOW');
    }

    // 当前行放不下时换行，保持输入顺序和布局结果确定。
    if (cursorX > 0 && cursorX + frame.width > maxDimension) {
      cursorY += rowHeight;
      cursorX = 0;
      rowHeight = 0;
    }

    // 新行超出当前页时续到下一页，帧尺寸与原始顺序不变。
    if (cursorY + frame.height > maxDimension) {
      page = { width: 0, height: 0, placements: [] };
      pages.push(page);
      cursorX = 0;
      cursorY = 0;
      rowHeight = 0;
    }

    page.placements.push({
      frameId: frame.frameId,
      rect: {
        x: cursorX,
        y: cursorY,
        width: frame.width,
        height: frame.height
      }
    });

    cursorX += frame.width;
    rowHeight = Math.max(rowHeight, frame.height);
    page.width = Math.max(page.width, cursorX);
    page.height = cursorY + rowHeight;
  }

  return pages;
}
