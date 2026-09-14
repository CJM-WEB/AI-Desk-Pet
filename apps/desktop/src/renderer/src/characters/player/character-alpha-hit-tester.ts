export type AlphaMask = {
  width: number;
  height: number;
  bytes: Uint8Array;
} | RunLengthAlphaMask;

/** 内部索引只由RGBA构造入口生成并封装，查询无需反复验证或解压整张图。 */
class RunLengthAlphaMask {
  readonly #rows: Uint32Array;
  readonly #ends: Uint32Array;
  readonly #values: Uint8Array;
  readonly byteLength: number;

  constructor(readonly width: number, readonly height: number, rows: Uint32Array, ends: Uint32Array, values: Uint8Array) {
    this.#rows = rows;
    this.#ends = ends;
    this.#values = values;
    this.byteLength = rows.byteLength + ends.byteLength + values.byteLength;
    Object.freeze(this);
  }

  read(x: number, y: number): number {
    let low = this.#rows[y]!;
    let high = this.#rows[y + 1]! - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (x < this.#ends[middle]!) high = middle;
      else low = middle + 1;
    }
    return this.#values[low]!;
  }
}

/** 逐行保留完整8位Alpha；只在索引和游程总计更小时压缩，不额外保存raw副本。 */
export function createAlphaMask(width: number, height: number, rgba: Uint8ClampedArray): AlphaMask | null {
  if (!isPositiveInteger(width) || !isPositiveInteger(height)
    || !(rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) return null;
  const pixelCount = width * height;
  let runCount = 0;
  for (let y = 0; y < height; y++) {
    let previous = -1;
    for (let x = 0; x < width; x++) {
      const value = rgba[(y * width + x) * 4 + 3]!;
      if (value !== previous) { runCount++; previous = value; }
    }
  }
  if ((height + 1) * 4 + runCount * 5 >= pixelCount) {
    const bytes = new Uint8Array(pixelCount);
    for (let pixel = 0; pixel < pixelCount; pixel++) bytes[pixel] = rgba[pixel * 4 + 3]!;
    return { width, height, bytes };
  }
  const rows = new Uint32Array(height + 1);
  const ends = new Uint32Array(runCount);
  const values = new Uint8Array(runCount);
  let run = 0;
  for (let y = 0; y < height; y++) {
    rows[y] = run;
    let x = 0;
    while (x < width) {
      const value = rgba[(y * width + x) * 4 + 3]!;
      do { x++; } while (x < width && rgba[(y * width + x) * 4 + 3] === value);
      ends[run] = x;
      values[run++] = value;
    }
  }
  rows[height] = run;
  return new RunLengthAlphaMask(width, height, rows, ends, values);
}

/** 查询仅接纳图内整数像素；异常返回undefined，不能借负阈值命中非法数据。 */
export function readAlphaMask(mask: AlphaMask | null | undefined, x: number, y: number): number | undefined {
  if (!isValidMask(mask) || !isNonNegativeInteger(x) || !isNonNegativeInteger(y)
    || x >= mask.width || y >= mask.height) return undefined;
  return mask instanceof RunLengthAlphaMask ? mask.read(x, y) : mask.bytes[y * mask.width + x];
}

export type CharacterHitSnapshot = {
  mask: AlphaMask;
  sourceRect: { x: number; y: number; width: number; height: number };
  frameBounds: { x: number; y: number; width: number; height: number };
  direction: 'left' | 'right';
};

/**
 * 将画布坐标反算为源图 Alpha 像素。输入异常一律穿透，避免命中能力影响角色渲染。
 */
export function hitTestCharacterAlpha(
  snapshot: CharacterHitSnapshot | null,
  point: { x: number; y: number },
  threshold = 16
): boolean {
  try {
    if (!isValidSnapshot(snapshot) || !isFinitePoint(point) || !Number.isFinite(threshold)) {
      return false;
    }

    const { frameBounds, sourceRect } = snapshot;
    if (
      point.x < frameBounds.x || point.x >= frameBounds.x + frameBounds.width ||
      point.y < frameBounds.y || point.y >= frameBounds.y + frameBounds.height
    ) {
      return false;
    }

    const frameX = Math.floor((point.x - frameBounds.x) / frameBounds.width * sourceRect.width);
    const frameY = Math.floor((point.y - frameBounds.y) / frameBounds.height * sourceRect.height);
    if (frameX < 0 || frameX >= sourceRect.width || frameY < 0 || frameY >= sourceRect.height) {
      return false;
    }

    const sourceX = snapshot.direction === 'left'
      ? sourceRect.x + sourceRect.width - 1 - frameX
      : sourceRect.x + frameX;
    const sourceY = sourceRect.y + frameY;
    const alpha = readAlphaMask(snapshot.mask, sourceX, sourceY);
    return alpha !== undefined && alpha > threshold;
  } catch {
    return false;
  }
}

/** 仅接受能够安全映射到逐像素 Alpha 掩码的帧快照。 */
function isValidSnapshot(snapshot: CharacterHitSnapshot | null): snapshot is CharacterHitSnapshot {
  if (!snapshot || (snapshot.direction !== 'left' && snapshot.direction !== 'right')) return false;
  const { mask, sourceRect, frameBounds } = snapshot;
  if (!isValidMask(mask)) return false;
  if (![sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height].every(isNonNegativeInteger)) {
    return false;
  }
  if (sourceRect.width === 0 || sourceRect.height === 0) return false;
  if (sourceRect.x + sourceRect.width > mask.width || sourceRect.y + sourceRect.height > mask.height) {
    return false;
  }
  return [frameBounds.x, frameBounds.y, frameBounds.width, frameBounds.height]
    .every(Number.isFinite) && frameBounds.width > 0 && frameBounds.height > 0;
}

function isValidMask(mask: AlphaMask | null | undefined): mask is AlphaMask {
  if (!mask || !isPositiveInteger(mask.width) || !isPositiveInteger(mask.height)) return false;
  return mask instanceof RunLengthAlphaMask
    || ('bytes' in mask && mask.bytes instanceof Uint8Array && mask.bytes.length === mask.width * mask.height);
}

function isFinitePoint(point: { x: number; y: number }): boolean {
  return Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
