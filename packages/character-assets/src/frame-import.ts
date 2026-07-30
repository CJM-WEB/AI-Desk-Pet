import { CHARACTER_RESOURCE_LIMITS } from './resource-limits';

export type FrameRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SpriteSheetPlanInput = {
  imageWidth: number;
  imageHeight: number;
  rows: number;
  columns: number;
  frameCount: number;
  order: 'row-major' | 'column-major';
};

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function planSpriteSheetFrames(input: SpriteSheetPlanInput): FrameRect[] {
  const numericValues = [
    input.imageWidth,
    input.imageHeight,
    input.rows,
    input.columns,
    input.frameCount
  ];

  if (!numericValues.every(isPositiveInteger)) {
    throw new Error('CHARACTER_FRAME_INPUT_INVALID');
  }

  if (input.order !== 'row-major' && input.order !== 'column-major') {
    throw new Error('CHARACTER_FRAME_ORDER_INVALID');
  }

  if (
    input.imageWidth % input.columns !== 0
    || input.imageHeight % input.rows !== 0
  ) {
    throw new Error('CHARACTER_SPRITE_GRID_NOT_DIVISIBLE');
  }

  if (
    input.frameCount > CHARACTER_RESOURCE_LIMITS.maxFramesPerAction
    || input.frameCount > input.rows * input.columns
  ) {
    throw new Error('CHARACTER_FRAME_COUNT_EXCEEDED');
  }

  const frameWidth = input.imageWidth / input.columns;
  const frameHeight = input.imageHeight / input.rows;

  if (
    frameWidth > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
    || frameHeight > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
  ) {
    throw new Error('CHARACTER_FRAME_DIMENSION_EXCEEDED');
  }

  return Array.from({ length: input.frameCount }, (_, index) => {
    const row = input.order === 'row-major'
      ? Math.floor(index / input.columns)
      : index % input.rows;
    const column = input.order === 'row-major'
      ? index % input.columns
      : Math.floor(index / input.rows);

    return {
      x: column * frameWidth,
      y: row * frameHeight,
      width: frameWidth,
      height: frameHeight
    };
  });
}

const naturalNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'variant'
});

export function sortFrameFiles(names: readonly string[]): string[] {
  return names
    .map((name, index) => ({ name, index }))
    .sort((left, right) => (
      naturalNameCollator.compare(left.name, right.name)
      || left.index - right.index
    ))
    .map(({ name }) => name);
}
