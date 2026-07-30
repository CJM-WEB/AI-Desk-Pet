export type AlphaMask = {
  width: number;
  height: number;
  bytes: Uint8Array;
};

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
    return snapshot.mask.bytes[sourceY * snapshot.mask.width + sourceX]! > threshold;
  } catch {
    return false;
  }
}

/** 仅接受能够安全映射到逐像素 Alpha 掩码的帧快照。 */
function isValidSnapshot(snapshot: CharacterHitSnapshot | null): snapshot is CharacterHitSnapshot {
  if (!snapshot || (snapshot.direction !== 'left' && snapshot.direction !== 'right')) return false;
  const { mask, sourceRect, frameBounds } = snapshot;
  if (!mask || !(mask.bytes instanceof Uint8Array)) return false;
  if (!isPositiveInteger(mask.width) || !isPositiveInteger(mask.height)) return false;
  if (mask.bytes.length !== mask.width * mask.height) return false;
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

function isFinitePoint(point: { x: number; y: number }): boolean {
  return Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
