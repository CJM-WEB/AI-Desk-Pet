import type {
  MagneticClipBounds,
  MagneticIntroConfig
} from './types';

/** 将相对裁切边界转换为 CSS polygon 路径。 */
export function toClipPath(bounds: MagneticClipBounds): string {
  return [
    `polygon(${bounds.left}% ${bounds.top}%`,
    `${bounds.right}% ${bounds.top}%`,
    `${bounds.right}% ${bounds.bottom}%`,
    `${bounds.left}% ${bounds.bottom}%)`
  ].join(', ');
}

/** 判断两个裁切区域是否存在正面积重叠。 */
export function hasPositiveAreaOverlap(
  first: MagneticClipBounds,
  second: MagneticClipBounds
): boolean {
  const overlapWidth = Math.min(first.right, second.right)
    - Math.max(first.left, second.left);
  const overlapHeight = Math.min(first.bottom, second.bottom)
    - Math.max(first.top, second.top);
  return overlapWidth > 0 && overlapHeight > 0;
}

/** 计算最后一块磁吸切片完成落位后开始 Logo 锁定的时间点。 */
export function getMagneticLockAtSeconds(config: MagneticIntroConfig): number {
  return config.blackHoldSeconds
    + config.firstPieceDelaySeconds
    + ((config.pieces.length - 1) * config.pieceStaggerSeconds)
    + config.pieceSeconds;
}
