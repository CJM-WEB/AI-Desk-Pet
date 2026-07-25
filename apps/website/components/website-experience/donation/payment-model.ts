export function wrapPaymentIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function paymentRelativeOffset(index: number, active: number, length: number): number {
  if (length <= 0) return 0;
  const forward = wrapPaymentIndex(index - active, length);
  return forward > length / 2 ? forward - length : forward;
}

export function paymentCardVisual(offset: number) {
  const distance = Math.abs(offset);
  const scale = distance === 0 ? 1 : Math.max(0.72, 0.94 - distance * 0.06);
  return {
    translateYPercent: offset * 54,
    scale: Number(scale.toFixed(2)),
    opacity: distance === 0 ? 1 : Math.max(0.38, 0.78 - distance * 0.12),
    zIndex: distance === 0 ? 10 : Math.max(1, 8 - distance),
    activatable: distance === 0
  };
}
