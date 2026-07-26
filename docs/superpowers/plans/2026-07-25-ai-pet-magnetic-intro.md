# AI Pet 官网磁吸开场 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用六块真实 `AP.png` 裁切层实现克制的“磁吸归位”开场，并将 Logo 的鼠标跟随幅度提高到已确认边界。

**Architecture:** 保留现有首页状态机、最终 Logo、整体弹动、背景过渡和文字显现，只将 `APDrawMark` 替换为读取集中配置的 `MagneticAPMark`。磁吸几何与时间参数由纯配置和纯函数提供，GSAP 时间线只消费这些数据；完整 Logo 继续作为跳过动画、减少动态效果和异常回退的统一稳定终态。

**Tech Stack:** Next.js 15、React 19、TypeScript、CSS Modules、GSAP 3.15、Vitest 3、Playwright 1.61、pnpm 11

## Global Constraints

- 整个实施过程禁止执行任何 Git 命令，包括只读查询、切分支、建工作树、暂存、提交、合并和推送。
- 所有修改直接写入当前工作区，由用户自行决定后续版本管理方式。
- 真实 `apps/website/public/AP.png` 是唯一 Logo 图形成品，不生成近似 SVG，不引入新图片素材。
- 磁吸层固定为 6 块；每块初始缩放为 `0.72`，单块时长 `720ms`，首块延迟 `80ms`，间隔 `230ms`。
- 黑场稳定 `120ms`，完整 Logo 锁定交叉淡入 `160ms`，整个开场保持约 3 秒。
- 相邻裁切区域必须重叠；稳定终态只能看见完整 `AP.png`，不得残留可见切片或细白缝。
- 鼠标边缘映射上限固定为 `rotateX ±8°`、`rotateY ±10°`、`x ±10px`、`y ±8px`。
- 首次滚轮、点击或方向键仍跳过开场且不增加章节进度。
- `prefers-reduced-motion: reduce`、素材失败和动画初始化失败均直接进入稳定终态。
- 文件粒子、文件预览、Canvas 光场、滚轮章节模型、接口、Agent 和部署配置不在本轮修改范围内。
- 本轮不新增移动端专项动画，只保留当前窄屏回退。
- 所有新增文档与代码注释使用中文；不新增依赖，不重构无关模块。

---

## 文件结构

- 新建 `apps/website/components/home-experience/magnetic-intro-model.ts`：提供裁切路径和时间节点纯函数。
- 新建 `apps/website/components/home-experience/MagneticAPMark.tsx`：渲染六个真实图片切片。
- 新建 `apps/website/tests/magnetic-intro-model.test.ts`：验证切片覆盖关系和时间节点。
- 新建 `apps/website/tests/magnetic-intro.test.tsx`：验证磁吸组件静态结构。
- 修改 `apps/website/components/home-experience/types.ts`：声明磁吸配置和品牌变换配置类型。
- 修改 `apps/website/components/home-experience/config.ts`：集中保存六块几何、运动参数、时间参数和倾斜边界。
- 修改 `apps/website/components/home-experience/BrandStage.tsx`：以磁吸组件替换书写遮罩。
- 修改 `apps/website/components/home-experience/HomeExperience.tsx`：收集最终 Logo 和六块切片引用。
- 修改 `apps/website/components/home-experience/use-intro-timeline.ts`：编排磁吸、锁定、弹动和稳定终态。
- 修改 `apps/website/components/home-experience/pointer-model.ts`：消费集中配置并提高跟随边界。
- 修改 `apps/website/components/home-experience/home-experience.module.css`：定义切片层、终态和减少动态效果样式。
- 修改 `apps/website/tests/pointer-model.test.ts`：验证新的四边和异常输入边界。
- 修改 `apps/website/tests/page.test.tsx`：验证首页输出六块切片和完整 Logo。
- 修改 `tests/e2e/website.spec.ts`：将旧书写路径断言替换为磁吸中间态、终态和回退断言。
- 删除 `apps/website/components/home-experience/APDrawMark.tsx`：移除已无引用的旧书写实现。

---

### Task 1: 建立磁吸配置、几何模型与时间模型

**Files:**
- Create: `apps/website/components/home-experience/magnetic-intro-model.ts`
- Create: `apps/website/tests/magnetic-intro-model.test.ts`
- Modify: `apps/website/components/home-experience/types.ts`
- Modify: `apps/website/components/home-experience/config.ts`

**Interfaces:**
- Consumes: 现有 `EXPERIENCE_CONFIG` 导出。
- Produces: `MagneticClipBounds`、`MagneticPieceConfig`、`BrandTransformLimits`、`toClipPath(bounds)`、`hasPositiveAreaOverlap(first, second)`、`getMagneticLockAtSeconds(config)`。

- [x] **Step 1: 先写裁切与时间节点失败测试**

在 `apps/website/tests/magnetic-intro-model.test.ts` 写入：

```ts
import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';
import {
  getMagneticLockAtSeconds,
  hasPositiveAreaOverlap,
  toClipPath
} from '../components/home-experience/magnetic-intro-model';

describe('磁吸开场配置', () => {
  it('使用六块真实 AP 素材并保留横向与纵向重叠', () => {
    const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

    expect(magnetic.assetPath).toBe('/AP.png');
    expect(magnetic.pieces).toHaveLength(6);
    expect(magnetic.pieces.every((piece) => piece.from.scale === 0.72)).toBe(true);

    expect(hasPositiveAreaOverlap(magnetic.pieces[0].clip, magnetic.pieces[1].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[2].clip, magnetic.pieces[3].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[4].clip, magnetic.pieces[5].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[0].clip, magnetic.pieces[2].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[2].clip, magnetic.pieces[4].clip)).toBe(true);
  });

  it('将相对裁切边界转换为稳定的 polygon 路径', () => {
    expect(toClipPath({ left: 0, top: 0, right: 54, bottom: 38 }))
      .toBe('polygon(0% 0%, 54% 0%, 54% 38%, 0% 38%)');
  });

  it('在最后一块落位后开始完整 Logo 锁定', () => {
    expect(getMagneticLockAtSeconds(EXPERIENCE_CONFIG.intro.magnetic)).toBeCloseTo(2.07);
  });
});
```

- [x] **Step 2: 运行测试并确认因接口不存在而失败**

Run:

```powershell
pnpm --filter @myself/website test -- magnetic-intro-model.test.ts
```

Expected: FAIL，错误包含 `magnetic-intro-model` 不存在或 `intro.magnetic` 不存在。

- [x] **Step 3: 声明明确配置类型**

在 `apps/website/components/home-experience/types.ts` 增加：

```ts
export interface MagneticClipBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MagneticPieceConfig {
  id: string;
  clip: MagneticClipBounds;
  transformOrigin: string;
  from: {
    x: number;
    y: number;
    rotation: number;
    scale: number;
  };
}

export interface MagneticIntroConfig {
  assetPath: string;
  blackHoldSeconds: number;
  firstPieceDelaySeconds: number;
  pieceSeconds: number;
  pieceStaggerSeconds: number;
  lockSeconds: number;
  ease: string;
  pieces: readonly MagneticPieceConfig[];
}

export interface BrandTransformLimits {
  maxRotateX: number;
  maxRotateY: number;
  maxX: number;
  maxY: number;
}
```

将 `ExperienceConfig.intro` 改为：

```ts
intro: {
  settleSeconds: number;
  magnetic: MagneticIntroConfig;
};
```

并在 `ExperienceConfig` 增加：

```ts
brandTransform: BrandTransformLimits;
```

- [x] **Step 4: 写入六块重叠裁切和独立时间配置**

在 `apps/website/components/home-experience/config.ts` 将 `intro.drawSeconds` 替换为：

```ts
intro: {
  settleSeconds: 0.8,
  magnetic: {
    assetPath: '/AP.png',
    blackHoldSeconds: 0.12,
    firstPieceDelaySeconds: 0.08,
    pieceSeconds: 0.72,
    pieceStaggerSeconds: 0.23,
    lockSeconds: 0.16,
    ease: 'back.out(0.45)',
    pieces: [
      {
        id: 'top-left',
        clip: { left: 0, top: 0, right: 54, bottom: 38 },
        transformOrigin: '27% 19%',
        from: { x: -80, y: -60, rotation: -12, scale: 0.72 }
      },
      {
        id: 'top-right',
        clip: { left: 46, top: 0, right: 100, bottom: 38 },
        transformOrigin: '73% 19%',
        from: { x: 90, y: -28, rotation: 9, scale: 0.72 }
      },
      {
        id: 'middle-left',
        clip: { left: 0, top: 29, right: 54, bottom: 71 },
        transformOrigin: '27% 50%',
        from: { x: -92, y: 74, rotation: -8, scale: 0.72 }
      },
      {
        id: 'middle-right',
        clip: { left: 46, top: 29, right: 100, bottom: 71 },
        transformOrigin: '73% 50%',
        from: { x: -38, y: 8, rotation: 14, scale: 0.72 }
      },
      {
        id: 'bottom-left',
        clip: { left: 0, top: 62, right: 54, bottom: 100 },
        transformOrigin: '27% 81%',
        from: { x: 92, y: 78, rotation: 11, scale: 0.72 }
      },
      {
        id: 'bottom-right',
        clip: { left: 46, top: 62, right: 100, bottom: 100 },
        transformOrigin: '73% 81%',
        from: { x: 0, y: 100, rotation: -7, scale: 0.72 }
      }
    ]
  }
},
brandTransform: {
  maxRotateX: 8,
  maxRotateY: 10,
  maxX: 10,
  maxY: 8
},
```

- [x] **Step 5: 实现无 DOM 依赖的纯函数**

在 `apps/website/components/home-experience/magnetic-intro-model.ts` 写入：

```ts
import type {
  MagneticClipBounds,
  MagneticIntroConfig
} from './types';

export function toClipPath(bounds: MagneticClipBounds): string {
  return [
    `polygon(${bounds.left}% ${bounds.top}%`,
    `${bounds.right}% ${bounds.top}%`,
    `${bounds.right}% ${bounds.bottom}%`,
    `${bounds.left}% ${bounds.bottom}%)`
  ].join(', ');
}

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

export function getMagneticLockAtSeconds(config: MagneticIntroConfig): number {
  return config.blackHoldSeconds
    + config.firstPieceDelaySeconds
    + ((config.pieces.length - 1) * config.pieceStaggerSeconds)
    + config.pieceSeconds;
}
```

- [x] **Step 6: 运行模型测试和类型检查**

Run:

```powershell
pnpm --filter @myself/website test -- magnetic-intro-model.test.ts
pnpm --filter @myself/website typecheck
```

Expected: 两条命令均 PASS。

---

### Task 2: 用六块真实图片替换书写遮罩

**Files:**
- Create: `apps/website/components/home-experience/MagneticAPMark.tsx`
- Create: `apps/website/tests/magnetic-intro.test.tsx`
- Modify: `apps/website/components/home-experience/BrandStage.tsx`
- Modify: `apps/website/components/home-experience/home-experience.module.css`
- Modify: `apps/website/tests/page.test.tsx`
- Delete: `apps/website/components/home-experience/APDrawMark.tsx`

**Interfaces:**
- Consumes: `EXPERIENCE_CONFIG.intro.magnetic`、`toClipPath(bounds)`。
- Produces: `[data-testid="magnetic-ap-mark"]`、六个 `[data-testid="magnetic-logo-piece"]`、`[data-testid="brand-logo"]`。

- [x] **Step 1: 先写磁吸组件静态结构失败测试**

在 `apps/website/tests/magnetic-intro.test.tsx` 写入：

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MagneticAPMark } from '../components/home-experience/MagneticAPMark';

describe('磁吸 Logo 舞台', () => {
  it('渲染六块来自真实 AP.png 的重叠裁切图片', () => {
    const html = renderToStaticMarkup(createElement(MagneticAPMark));

    expect(html).toContain('data-testid="magnetic-ap-mark"');
    expect(html.match(/data-testid="magnetic-logo-piece"/g) ?? []).toHaveLength(6);
    expect(html.match(/src="\/AP.png"/g) ?? []).toHaveLength(6);
    expect(html).toContain('clip-path:polygon(');
  });
});
```

在 `apps/website/tests/page.test.tsx` 的首页语义测试中增加：

```ts
expect(html).toContain('data-testid="brand-logo"');
expect(html.match(/data-testid="magnetic-logo-piece"/g) ?? []).toHaveLength(6);
expect(html).not.toContain('data-testid="ap-draw-mark"');
```

- [x] **Step 2: 运行测试并确认组件不存在**

Run:

```powershell
pnpm --filter @myself/website test -- magnetic-intro.test.tsx page.test.tsx
```

Expected: FAIL，错误包含无法导入 `MagneticAPMark`。

- [x] **Step 3: 实现磁吸切片组件**

在 `apps/website/components/home-experience/MagneticAPMark.tsx` 写入：

```tsx
import type { CSSProperties } from 'react';
import { EXPERIENCE_CONFIG } from './config';
import { toClipPath } from './magnetic-intro-model';
import styles from './home-experience.module.css';

interface MagneticAPMarkProps {
  onImageError?: () => void;
}

export function MagneticAPMark({ onImageError }: MagneticAPMarkProps = {}) {
  const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

  return (
    <div
      className={styles.magneticMark}
      data-testid="magnetic-ap-mark"
      aria-hidden="true"
    >
      {magnetic.pieces.map((piece) => {
        const style = {
          clipPath: toClipPath(piece.clip),
          transformOrigin: piece.transformOrigin
        } as CSSProperties;

        return (
          <img
            key={piece.id}
            className={styles.magneticPiece}
            data-testid="magnetic-logo-piece"
            data-piece-id={piece.id}
            src={magnetic.assetPath}
            alt=""
            style={style}
            onError={onImageError}
          />
        );
      })}
    </div>
  );
}
```

- [x] **Step 4: 在品牌舞台中替换旧书写层**

在 `BrandStage.tsx`：

1. 将 `APDrawMark` 导入改为 `MagneticAPMark`。
2. 将 `drawAssetFailed`、`onDrawAssetError` 重命名为 `magneticAssetFailed`、`onMagneticAssetError`。
3. 给最终图片增加 `data-testid="brand-logo"`。
4. 将旧组件调用替换为：

```tsx
{!magneticAssetFailed ? (
  <MagneticAPMark onImageError={onMagneticAssetError} />
) : null}
```

- [x] **Step 5: 增加切片层样式并删除旧样式**

在 `home-experience.module.css` 中用以下结构替换 `.drawMark` 相关规则：

```css
.brandLogo,
.magneticMark,
.magneticPiece {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.brandLogo,
.magneticPiece {
  object-fit: contain;
}

.brandLogo {
  opacity: 1;
  transition: opacity 160ms linear;
}

.magneticMark {
  pointer-events: none;
}

.magneticPiece {
  opacity: 0;
  visibility: hidden;
  will-change: transform, opacity;
}

.experience[data-phase='interactive'] .magneticMark,
.experience[data-phase='exiting'] .magneticMark {
  visibility: hidden;
}
```

在减少动态效果媒体查询中：

```css
.brandStage:not([data-final-image-failed='true']) .magneticMark {
  display: none;
}

.introOverlay,
.brandLogo,
.magneticPiece,
.brandTransform[data-motion-enabled='true'],
.fileIconMotion {
  transition: none;
}
```

- [x] **Step 6: 删除旧实现并运行组件测试**

删除 `apps/website/components/home-experience/APDrawMark.tsx`，然后运行：

```powershell
pnpm --filter @myself/website test -- magnetic-intro.test.tsx page.test.tsx
pnpm --filter @myself/website typecheck
```

Expected: 两条命令均 PASS，`rg "APDrawMark|ap-draw-mark|drawMark" apps/website` 无匹配。

---

### Task 3: 将磁吸编排接入现有 GSAP 开场时间线

**Files:**
- Modify: `apps/website/components/home-experience/HomeExperience.tsx`
- Modify: `apps/website/components/home-experience/use-intro-timeline.ts`

**Interfaces:**
- Consumes: 六个 `[data-testid="magnetic-logo-piece"]`、`[data-testid="brand-logo"]`、`getMagneticLockAtSeconds(config)`。
- Produces: `IntroTimelineRefs.finalLogo: RefObject<HTMLImageElement | null>`、`IntroTimelineRefs.magneticPieces: RefObject<HTMLImageElement[]>`；稳定终态为最终 Logo 可见且切片不可见。

- [x] **Step 1: 先让首页测试要求新的终态标记**

在 `apps/website/tests/page.test.tsx` 增加：

```ts
expect(html).toContain('data-final-image-failed="false"');
expect(html).toContain('data-piece-id="top-left"');
expect(html).toContain('data-piece-id="bottom-right"');
```

Run:

```powershell
pnpm --filter @myself/website test -- page.test.tsx
```

Expected: 在 Task 2 尚未输出完整标记时 FAIL；若标记已由 Task 2 满足，则记录该测试为现有结构保护测试并继续下一步。

- [x] **Step 2: 将 DOM 引用从路径改为最终图与切片**

在 `HomeExperience.tsx`：

```ts
const [magneticAssetFailed, setMagneticAssetFailed] = useState(false);
const finalLogoRef = useRef<HTMLImageElement | null>(null);
const magneticPiecesRef = useRef<HTMLImageElement[]>([]);
```

`introRefs` 改为：

```ts
const introRefs = useMemo(() => ({
  scope: scopeRef,
  overlay: overlayRef,
  brand: brandRef,
  wordmark: wordmarkRef,
  finalLogo: finalLogoRef,
  magneticPieces: magneticPiecesRef
}), []);
```

`setScope` 内改为：

```ts
wordmarkRef.current = node.querySelector('h1');
finalLogoRef.current = node.querySelector('[data-testid="brand-logo"]');
magneticPiecesRef.current = Array.from(
  node.querySelectorAll<HTMLImageElement>('[data-testid="magnetic-logo-piece"]')
);
```

向 `BrandStage` 传入：

```tsx
magneticAssetFailed={magneticAssetFailed}
onMagneticAssetError={() => setMagneticAssetFailed(true)}
```

- [x] **Step 3: 修改时间线引用和统一稳定终态**

将 `IntroTimelineRefs` 改为：

```ts
interface IntroTimelineRefs {
  scope: RefObject<HTMLElement | null>;
  overlay: RefObject<HTMLDivElement | null>;
  brand: RefObject<HTMLDivElement | null>;
  wordmark: RefObject<HTMLHeadingElement | null>;
  finalLogo: RefObject<HTMLImageElement | null>;
  magneticPieces: RefObject<HTMLImageElement[]>;
}
```

在 `applyStableVisualState` 中写入：

```ts
const finalLogo = refs.finalLogo.current;

if (finalLogo) {
  finalLogo.style.opacity = '1';
  finalLogo.style.visibility = 'visible';
}
for (const piece of refs.magneticPieces.current) {
  piece.style.opacity = '0';
  piece.style.visibility = 'hidden';
  piece.style.transform = '';
}
```

删除所有 `strokeDasharray` 与 `strokeDashoffset` 写入。

- [x] **Step 4: 用配置数据建立磁吸时间线**

在 `use-intro-timeline.ts` 导入 `getMagneticLockAtSeconds`，并将路径动画段替换为：

```ts
const finalLogo = refs.finalLogo.current;
const pieces = refs.magneticPieces.current;
const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

if (
  !scope
  || !overlay
  || !brand
  || !wordmark
  || !finalLogo
  || pieces.length !== magnetic.pieces.length
) {
  finishWithoutMotion();
  return;
}
```

时间线初始化与磁吸编排：

```ts
timeline
  .set(finalLogo, { autoAlpha: 0 })
  .set(wordmark, { opacity: 0, letterSpacing: '0.28em' });

magnetic.pieces.forEach((pieceConfig, index) => {
  const piece = pieces[index];
  const startsAt = magnetic.blackHoldSeconds
    + magnetic.firstPieceDelaySeconds
    + (index * magnetic.pieceStaggerSeconds);

  timeline.fromTo(
    piece,
    {
      autoAlpha: 0,
      x: pieceConfig.from.x,
      y: pieceConfig.from.y,
      rotation: pieceConfig.from.rotation,
      scale: pieceConfig.from.scale
    },
    {
      autoAlpha: 1,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      duration: magnetic.pieceSeconds,
      ease: magnetic.ease
    },
    startsAt
  );
});

const lockAt = getMagneticLockAtSeconds(magnetic);
timeline
  .to(finalLogo, {
    autoAlpha: 1,
    duration: magnetic.lockSeconds,
    ease: 'none'
  }, lockAt)
  .to(pieces, {
    autoAlpha: 0,
    duration: magnetic.lockSeconds,
    ease: 'none',
    onComplete: () => {
      if (!suppressCallbacksRef.current) {
        callbacksRef.current.onDrawingDone();
      }
    }
  }, lockAt)
  .to(brand, { scale: 1.08, duration: 0.18 })
  .to(brand, { scale: 0.72, duration: 0.62, ease: 'back.out(1.8)' })
  .to(overlay, {
    backgroundColor: EXPERIENCE_CONFIG.colors.background,
    duration: EXPERIENCE_CONFIG.intro.settleSeconds
  }, '<')
  .to(wordmark, {
    opacity: 1,
    letterSpacing: '0em',
    duration: 0.6
  }, '<');
```

- [x] **Step 5: 核对跳过、暂停、减少动态效果与异常路径**

确认以下现有入口全部调用同一个 `applyStableVisualState()`：

```ts
finishWithoutMotion();
skip();
catch {
  applyStableVisualState();
}
```

确认 `isPaused` 仍只调用：

```ts
timelineRef.current?.pause();
timelineRef.current?.resume();
```

- [x] **Step 6: 运行网站单元测试和类型检查**

Run:

```powershell
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website test
```

Expected: 类型检查通过，网站 Vitest 全部 PASS。

---

### Task 4: 提高并约束鼠标跟随倾斜

**Files:**
- Modify: `apps/website/components/home-experience/pointer-model.ts`
- Modify: `apps/website/tests/pointer-model.test.ts`

**Interfaces:**
- Consumes: `EXPERIENCE_CONFIG.brandTransform`。
- Produces: `computeBrandTransform(pointer, viewport, limits?)`，默认使用集中配置，中心与无效视口返回零值。

- [x] **Step 1: 先把边缘期望改为新边界**

在 `apps/website/tests/pointer-model.test.ts` 将右上角断言改为：

```ts
expect(computeBrandTransform(
  { x: 1440, y: 0 },
  { width: 1440, height: 900 }
)).toEqual({ rotateX: 8, rotateY: 10, x: 10, y: -8 });
```

增加视口外限制测试：

```ts
it('将视口外指针限制在已配置的最大倾斜与位移', () => {
  expect(computeBrandTransform(
    { x: -500, y: 1400 },
    { width: 1440, height: 900 }
  )).toEqual({ rotateX: -8, rotateY: -10, x: -10, y: 8 });
});
```

同步更新水平中心线和垂直中心线断言：

```ts
{ rotateX: 0, rotateY: 10, x: 10, y: 0 }
{ rotateX: 8, rotateY: 0, x: 0, y: -8 }
```

- [x] **Step 2: 运行测试并确认旧边界导致失败**

Run:

```powershell
pnpm --filter @myself/website test -- pointer-model.test.ts
```

Expected: FAIL，实际值仍为旧的 `4/5/6/4`。

- [x] **Step 3: 让纯模型消费可替换边界配置**

在 `pointer-model.ts` 增加导入：

```ts
import { EXPERIENCE_CONFIG } from './config';
import type { BrandTransformLimits, PointerPoint } from './types';
```

将函数签名和返回值改为：

```ts
export function computeBrandTransform(
  pointer: PointerPoint,
  viewport: ViewportSize,
  limits: BrandTransformLimits = EXPERIENCE_CONFIG.brandTransform
): { rotateX: number; rotateY: number; x: number; y: number } {
  const normalizedX = normalizeFromCenter(pointer.x, viewport.width);
  const normalizedY = normalizeFromCenter(pointer.y, viewport.height);

  return {
    rotateX: canonicalizeZero(normalizedY * -limits.maxRotateX),
    rotateY: canonicalizeZero(normalizedX * limits.maxRotateY),
    x: canonicalizeZero(normalizedX * limits.maxX),
    y: canonicalizeZero(normalizedY * limits.maxY)
  };
}
```

- [x] **Step 4: 运行指针测试、全量网站测试和类型检查**

Run:

```powershell
pnpm --filter @myself/website test -- pointer-model.test.ts
pnpm --filter @myself/website test
pnpm --filter @myself/website typecheck
```

Expected: 三条命令均 PASS。

---

### Task 5: 更新浏览器验收并检查真实中间帧

**Files:**
- Modify: `tests/e2e/website.spec.ts`
- Generated verification evidence: `tests/.playwright-output/website/screenshots/desktop-1440-magnetic.png`
- Generated verification evidence: `tests/.playwright-output/website/screenshots/desktop-1440-home.png`

**Interfaces:**
- Consumes: `magnetic-ap-mark`、`magnetic-logo-piece`、`brand-logo`、现有 `data-phase`。
- Produces: 自动化证明磁吸中间态、完整终态、跳过开场、减少动态效果及原有首页行为均正确。

- [x] **Step 1: 将旧书写 E2E 断言改为磁吸断言**

把测试标题改为：

```ts
test('自动开场在约三秒内完成磁吸归位并保持最终 Logo 与 1440 安全布局', async ({ page }) => {
```

删除 `ap-draw-mark`、三条路径和 `strokeDashoffset` 断言，改为：

```ts
const pieces = page.locator('[data-testid="magnetic-logo-piece"]');
await expect(pieces).toHaveCount(6);
await expect(pieces.first()).toHaveAttribute('src', '/AP.png');
await expect.poll(async () => Number.parseFloat(
  await pieces.first().evaluate((piece) => getComputedStyle(piece).opacity)
)).toBeGreaterThan(0);
```

中间层证据改为：

```ts
const magneticLayers = await page.evaluate(() => {
  const logo = document.querySelector<HTMLElement>('[data-testid="brand-logo"]');
  const pieces = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="magnetic-logo-piece"]')
  );
  return {
    logoOpacity: Number(getComputedStyle(logo!).opacity),
    visiblePieceCount: pieces.filter(
      (piece) => Number(getComputedStyle(piece).opacity) > 0
    ).length,
    pieceSources: pieces.map((piece) => piece.getAttribute('src'))
  };
});
expect(magneticLayers.logoOpacity).toBeLessThan(1);
expect(magneticLayers.visiblePieceCount).toBeGreaterThan(0);
expect(new Set(magneticLayers.pieceSources)).toEqual(new Set(['/AP.png']));
```

保存中间帧：

```ts
await page.screenshot({
  path: resolve(SCREENSHOT_DIRECTORY, 'desktop-1440-magnetic.png'),
  fullPage: true
});
```

稳定终态增加：

```ts
await expect(page.locator('[data-testid="brand-logo"]')).toBeVisible();
for (const piece of await pieces.all()) {
  await expect(piece).toBeHidden();
}
```

- [x] **Step 2: 强化跳过开场测试**

在三个 `introSkipCases` 的共享测试中增加：

```ts
await expect(page.locator('[data-testid="brand-logo"]')).toBeVisible();
for (const piece of await page.locator('[data-testid="magnetic-logo-piece"]').all()) {
  await expect(piece).toBeHidden();
}
```

- [x] **Step 3: 更新减少动态效果断言**

将旧 `drawMark` 读取替换为：

```ts
const magneticMark = brand.querySelector('[data-testid="magnetic-ap-mark"]');
const pieces = Array.from(
  brand.querySelectorAll<HTMLElement>('[data-testid="magnetic-logo-piece"]')
);
```

返回并断言：

```ts
magneticDisplay: magneticMark ? getComputedStyle(magneticMark).display : null,
pieceTransitions: pieces.map((piece) => getComputedStyle(piece).transitionDuration)
```

```ts
expect(reducedMotionEvidence.magneticDisplay).toBe('none');
expect(reducedMotionEvidence.pieceTransitions.every((duration) => duration === '0s')).toBe(true);
```

- [x] **Step 4: 先构建静态网站并运行目标 E2E**

Run:

```powershell
pnpm --filter @myself/website build
pnpm exec playwright test --config tests/playwright.website.config.ts tests/e2e/website.spec.ts --grep "磁吸归位|跳过开场|减少动态效果直接进入"
```

Expected: 目标测试全部 PASS，自动开场在 `3300ms` 超时范围内进入 `interactive`。

- [x] **Step 5: 用截图检查 Logo 几何和层级**

打开并检查：

```text
tests/.playwright-output/website/screenshots/desktop-1440-magnetic.png
tests/.playwright-output/website/screenshots/desktop-1440-home.png
```

验收记录必须同时满足：

- 中间帧至少有一块正在从不同方向接近中心。
- 切片只显示 AP 本体像素，不显示图片矩形背景。
- 相邻切片接近落位时无明显细白缝。
- 稳定帧与原始 `AP.png` 轮廓一致。
- Logo 未被视口裁切，`AI Pet` 与 Logo 不重叠。

若截图不满足，只允许调整 `EXPERIENCE_CONFIG.intro.magnetic.pieces` 的 `clip`、`transformOrigin`、`from` 或 `ease`；不得在时间线中硬编码补丁值。

---

### Task 6: 全量验证与审查

**Files:**
- Review: 本计划列出的全部源码与测试文件。

**Interfaces:**
- Consumes: Tasks 1-5 的工作区修改。
- Produces: 当前工作区内已验证的磁吸开场。

- [x] **Step 1: 扫描旧实现、占位内容和非预期资源**

Run:

```powershell
rg -n "APDrawMark|ap-draw-mark|drawMark|drawPaths|drawSeconds" apps/website tests/e2e/website.spec.ts
Get-ChildItem apps/website/public -File | Select-Object -ExpandProperty Name | Sort-Object
```

Expected:

- 第一条命令无匹配。
- 资源列表仍恰好是 `AP.png`、`empty.png`、`IMGIcon.png`、`Noempty.png`、`PDFIcon.png`、`PPTIcon.png`、`TxtIcon.png`、`XLSIcon.png`。

- [x] **Step 2: 运行完整网站验证**

Run:

```powershell
pnpm verify:website
```

Expected:

- website TypeScript 类型检查 PASS。
- website Vitest 全部 PASS。
- Next.js 静态导出构建 PASS。
- website Playwright 全部 PASS。

- [x] **Step 3: 使用完成前验证技能核对证据**

调用 `superpowers:verification-before-completion`，逐项确认最新命令输出，而不是复用旧测试结果。不得使用 Git 查询工作区状态。

- [x] **Step 4: 请求代码审查并处理发现**

调用 `superpowers:requesting-code-review`，审查重点固定为：

```text
1. 六块切片是否全部由 /AP.png 构成且有重叠。
2. 时间线是否在锁定后隐藏切片并显示完整 Logo。
3. 跳过、减少动态效果、暂停和异常回退是否共享稳定终态。
4. 倾斜是否严格限制为 8/10/10/8。
5. 是否误改文件粒子、Canvas、章节或移动端逻辑。
```

若审查发现问题，先补失败测试，再修复并重新运行 `pnpm verify:website`。

- [x] **Step 5: 在审查修正后再次验证**

Run:

```powershell
pnpm verify:website
```

Expected: 全部验证再次 PASS；整个实施过程没有执行 Git 命令。
