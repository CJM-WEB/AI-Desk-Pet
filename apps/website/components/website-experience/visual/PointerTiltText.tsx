import type { CSSProperties, ReactNode } from 'react';
import type { PointerPoint } from '../../home-experience/types';
import styles from '../website-experience.module.css';
import {
  computePointerTilt
} from './pointer-tilt-model';
import type { ViewportSize } from './pointer-tilt-model';

interface PointerTiltTextProps {
  pointer: PointerPoint;
  viewport: ViewportSize;
  disabled: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * 为重点标题提供可在静态回退时归零的纯 transform 倾斜。
 */
export function PointerTiltText({
  pointer,
  viewport,
  disabled,
  children,
  className
}: PointerTiltTextProps) {
  const tilt = disabled
    ? { rotateX: 0, rotateY: 0 }
    : computePointerTilt(pointer, viewport);
  const classNames = [styles.pointerTiltText, className]
    .filter(Boolean)
    .join(' ');
  const style = {
    '--pointer-tilt-rotate-x': `${tilt.rotateX}deg`,
    '--pointer-tilt-rotate-y': `${tilt.rotateY}deg`
  } as CSSProperties;

  return (
    <span
      className={classNames}
      data-testid="pointer-tilt-text"
      data-motion-enabled={!disabled}
      style={style}
    >
      {children}
    </span>
  );
}
