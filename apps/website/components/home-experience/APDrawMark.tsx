import styles from './home-experience.module.css';

const DRAW_PATHS = [
  'M586 91 L531 412 L935 257 L600 92 L713 292 L531 412',
  'M626 288 L493 655 L559 655 L625 370',
  'M680 374 L821 655 L939 655 L743 355'
] as const;

interface APDrawMarkProps {
  onImageError?: (() => void) | undefined;
}

export function APDrawMark({ onImageError }: APDrawMarkProps = {}) {
  return (
    <svg
      className={styles.drawMark}
      viewBox="0 0 1536 960"
      aria-hidden="true"
      data-testid="ap-draw-mark"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* 书写遮罩保留为独立层，供后续 GSAP 控制路径进度。 */}
        <mask id="ap-draw-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect width="1536" height="960" fill="#000" />
          {DRAW_PATHS.map((path) => (
            <path
              key={path}
              d={path}
              fill="none"
              stroke="#fff"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="96"
              pathLength="1"
            />
          ))}
        </mask>
      </defs>
      <image
        href="/AP.png"
        width="1536"
        height="960"
        preserveAspectRatio="xMidYMid meet"
        mask="url(#ap-draw-mask)"
        onError={onImageError}
      />
    </svg>
  );
}
