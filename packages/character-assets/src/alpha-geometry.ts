export type AlphaGeometryPoint = Readonly<{ x: number; y: number }>;

export type PresentationAlphaFrame = Readonly<{
  width: number;
  height: number;
  alpha: Uint8Array;
}>;

export type PresentationAlphaGeometry = Readonly<{
  visualBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  groundAnchor: AlphaGeometryPoint;
}>;

type FrameSize = Readonly<{ width: number; height: number }>;

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * 先固定共同画布，再允许调用方按源图 stride 逐帧扫描；累计器只保留四个边界值。
 * 因此迁移层无需复制裁切 Alpha，也无需同时持有多份解码资源。
 */
export function createPresentationAlphaGeometryAccumulator(input: Readonly<{
  groundAnchor: AlphaGeometryPoint;
  frames: readonly FrameSize[];
}>): Readonly<{
  addFrame(input: Readonly<{
    frameIndex: number;
    sourceWidth: number;
    sourceHeight: number;
    sourceAlpha: Uint8Array;
    sourceRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>): void;
  finish(): PresentationAlphaGeometry;
}> {
  const { groundAnchor, frames } = input;
  if (!Number.isFinite(groundAnchor.x) || !Number.isFinite(groundAnchor.y)
    || groundAnchor.x < 0 || groundAnchor.x > 1
    || groundAnchor.y < 0 || groundAnchor.y > 1
    || frames.length === 0
    || frames.some(frame => !validPositiveInteger(frame.width)
      || !validPositiveInteger(frame.height))) {
    throw new Error('CHARACTER_PRESENTATION_GEOMETRY_INVALID');
  }
  const canvasWidth = Math.max(...frames.map(frame => frame.width));
  const canvasHeight = Math.max(...frames.map(frame => frame.height));
  const scanned = new Set<number>();
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;

  return {
    addFrame(scan) {
      const frame = frames[scan.frameIndex];
      const rect = scan.sourceRect;
      if (!frame || scanned.has(scan.frameIndex)
        || !validPositiveInteger(scan.sourceWidth)
        || !validPositiveInteger(scan.sourceHeight)
        || scan.sourceAlpha.length !== scan.sourceWidth * scan.sourceHeight
        || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y)
        || rect.x < 0 || rect.y < 0
        || rect.width !== frame.width || rect.height !== frame.height
        || rect.x + rect.width > scan.sourceWidth
        || rect.y + rect.height > scan.sourceHeight) {
        throw new Error('CHARACTER_PRESENTATION_GEOMETRY_INVALID');
      }
      scanned.add(scan.frameIndex);
      const offsetX = canvasWidth * groundAnchor.x - frame.width * groundAnchor.x;
      const offsetY = canvasHeight * groundAnchor.y - frame.height * groundAnchor.y;
      for (let y = 0; y < rect.height; y += 1) {
        const sourceRow = (rect.y + y) * scan.sourceWidth + rect.x;
        for (let x = 0; x < rect.width; x += 1) {
          if (scan.sourceAlpha[sourceRow + x] === 0) continue;
          minimumX = Math.min(minimumX, offsetX + x);
          minimumY = Math.min(minimumY, offsetY + y);
          maximumX = Math.max(maximumX, offsetX + x + 1);
          maximumY = Math.max(maximumY, offsetY + y + 1);
        }
      }
    },
    finish() {
      if (scanned.size !== frames.length) {
        throw new Error('CHARACTER_PRESENTATION_GEOMETRY_INVALID');
      }
      if (!Number.isFinite(minimumX)) {
        throw new Error('CHARACTER_PRESENTATION_FULLY_TRANSPARENT');
      }
      return {
        visualBounds: {
          x: minimumX / canvasWidth,
          y: minimumY / canvasHeight,
          width: (maximumX - minimumX) / canvasWidth,
          height: (maximumY - minimumY) / canvasHeight
        },
        groundAnchor: { ...groundAnchor }
      };
    }
  };
}

/** 为浏览器编译链保留便捷入口，内部同样使用 stride 累计器。 */
export function computePresentationAlphaGeometry(input: Readonly<{
  groundAnchor: AlphaGeometryPoint;
  frames: readonly PresentationAlphaFrame[];
}>): PresentationAlphaGeometry {
  const accumulator = createPresentationAlphaGeometryAccumulator(input);
  input.frames.forEach((frame, frameIndex) => accumulator.addFrame({
    frameIndex,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    sourceAlpha: frame.alpha,
    sourceRect: { x: 0, y: 0, width: frame.width, height: frame.height }
  }));
  return accumulator.finish();
}
