# AI Pet 官网剩余模块实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** （目标）在现有首页之上实现五章节连续推拉官网，交付可扩展的下载安装模块、两个正式占位章节以及带支付方式滚筒和付款码弹层的捐款模块。

**Architecture:** （架构）新增 `WebsiteExperience` 作为整站单视口舞台，通过纯章节进度模型和统一输入控制器驱动相邻章节。现有 `HomeExperience` 改为受控首页章节；文件粒子、预览和 Canvas 光场提升为共享视觉层；下载平台、侧栏内容和支付方式全部配置驱动。

**Tech Stack:** （技术栈）Next.js 15、React 19、TypeScript、GSAP 3.15.0、CSS Modules、Zod、Vitest、React DOM 静态渲染、Playwright。

## Global Constraints（全局约束）

- 设计依据：`docs/superpowers/specs/2026-07-26-ai-pet-website-remaining-modules-design.md`。
- 章节顺序固定为：首页、AI Pet 介绍占位、AI Pet 下载安装、用户反馈与建议箱占位、捐款。
- 全局章节进度范围为 `0–4`，一次连续输入最多跨越一个相邻章节。
- 页面不得退化为传统纵向滚动；桌面端使用连续推拉和章节吸附。
- `rgb(235, 235, 235)` 为中央背景，下载侧色为 `rgb(0, 255, 200)`，捐款光场为 `rgb(255, 255, 0)`。
- Windows 必须读取现有真实发行清单；macOS 只能显示“即将支持”，不能拥有下载链接。
- 当前支付方式为微信和支付宝，但平台和支付滚筒逻辑不得依赖固定数量。
- 所有文档和代码注释使用中文；注释只解释结构边界和不直观的算法。
- 桌面完整体验断点为 `min-width: 761px`；`max-width: 760px` 使用触屏可用降级。
- 所有交互必须支持键盘，点击目标至少为 `44×44px`，并尊重 `prefers-reduced-motion`。
- 不新增支付接口、反馈接口、macOS 安装包、付款码图片或部署行为。
- 所有 Git 写操作必须先获得用户明确许可；未获许可时跳过每个任务的提交步骤并记录已完成验证。

---

## 文件结构

### 新增

- `apps/website/components/website-experience/types.ts`：章节、输入和共享视觉主题类型。
- `apps/website/components/website-experience/chapter-model.ts`：章节进度、相邻限制、吸附和视觉状态纯函数。
- `apps/website/components/website-experience/use-website-controller.ts`：滚轮、键盘、触屏、暂停和首页开场状态。
- `apps/website/components/website-experience/chapter-registry.tsx`：五章节顺序及渲染注册表。
- `apps/website/components/website-experience/WebsiteExperience.tsx`：整站舞台、章节层级、共享视觉层和静态回退。
- `apps/website/components/website-experience/website-experience.module.css`：章节推拉、占位章节、移动端和减少动态效果样式。
- `apps/website/components/website-experience/PlaceholderChapter.tsx`：可配置的正式占位章节。
- `apps/website/components/website-experience/SharedVisualLayers.tsx`：首页与捐款共用的粒子、预览和 Canvas 组合层。
- `apps/website/components/website-experience/shared-visual-model.ts`：共享视觉主题和激活规则纯函数。
- `apps/website/components/website-experience/download/download-content.ts`：平台、FAQ 和安装须知配置。
- `apps/website/components/website-experience/download/download-model.ts`：平台循环索引和左右面板状态机。
- `apps/website/components/website-experience/download/DownloadChapter.tsx`：下载章节结构与交互。
- `apps/website/components/website-experience/download/download.module.css`：下载渐变、卡片滚筒、侧移和移动抽屉样式。
- `apps/website/components/website-experience/donation/donation-content.ts`：微信与支付宝配置。
- `apps/website/components/website-experience/donation/payment-model.ts`：支付滚筒循环位置纯函数。
- `apps/website/components/website-experience/donation/DonationChapter.tsx`：捐款章节和支付滚筒。
- `apps/website/components/website-experience/donation/QrDialog.tsx`：付款码弹层、缺图回退和焦点管理。
- `apps/website/components/website-experience/donation/donation.module.css`：捐款标题、滚筒和弹层样式。
- `apps/website/tests/chapter-model.test.ts`
- `apps/website/tests/shared-visual-model.test.ts`
- `apps/website/tests/download-model.test.ts`
- `apps/website/tests/download-chapter.test.tsx`
- `apps/website/tests/payment-model.test.ts`
- `apps/website/tests/donation-chapter.test.tsx`

### 修改

- `apps/website/app/page.tsx`：入口改为 `WebsiteExperience`。
- `apps/website/package.json`、`pnpm-lock.yaml`：加入 `lucide-react`，复用标准箭头与关闭图标。
- `apps/website/components/home-experience/HomeExperience.tsx`：移除全局输入职责，改为受控首页章节。
- `apps/website/components/home-experience/CursorField.tsx`：接收显式激活状态和 RGB 主题。
- `apps/website/components/home-experience/FileSwarm.tsx`：接收生成、运行、退出、安全区和数量配置。
- `apps/website/components/home-experience/config.ts`：保留首页参数并增加共享视觉默认配置。
- `apps/website/components/home-experience/types.ts`：移除不再属于首页的整站状态类型。
- `apps/website/components/home-experience/home-experience.module.css`：从固定整页容器改为章节内部视觉层。
- `apps/website/tests/progress-model.test.ts`：保留首页开场相关测试，迁移整站进度断言。
- `apps/website/tests/page.test.tsx`：断言五章节静态语义和配置内容。
- `tests/e2e/website.spec.ts`：扩展五章节、局部交互、弹层、响应式和视觉验收。

### 删除

- `apps/website/components/home-experience/progress-model.ts`：整站进度职责迁移到章节模型后移除。
- `apps/website/components/home-experience/use-experience-controller.ts`：全局输入职责迁移到 `use-website-controller.ts` 后移除。

---

### Task 1：建立五章节纯进度模型

**文件：**

- 新建：`apps/website/components/website-experience/types.ts`
- 新建：`apps/website/components/website-experience/chapter-model.ts`
- 新建：`apps/website/tests/chapter-model.test.ts`

**接口：**

- 产出：`ChapterId`、`ChapterDirection`、`ChapterVisualState`。
- 产出：`clampChapterProgress(value, chapterCount)`。
- 产出：`applyChapterDelta(progress, delta, settledIndex, chapterCount)`。
- 产出：`snapChapterProgress(progress, chapterCount)`。
- 产出：`deriveChapterVisualState(index, progress, reducedMotion)`。

- [ ] **步骤 1：编写失败的章节进度测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  applyChapterDelta,
  clampChapterProgress,
  deriveChapterVisualState,
  snapChapterProgress
} from '../components/website-experience/chapter-model';

describe('官网章节进度模型', () => {
  it('限制进度并阻止一次输入跨越相邻章节', () => {
    expect(clampChapterProgress(-1, 5)).toBe(0);
    expect(clampChapterProgress(8, 5)).toBe(4);
    expect(applyChapterDelta(0, 8, 0, 5)).toBe(1);
    expect(applyChapterDelta(2, -8, 2, 5)).toBe(1);
  });

  it('吸附到最近章节并保持硬边界', () => {
    expect(snapChapterProgress(1.49, 5)).toBe(1);
    expect(snapChapterProgress(1.51, 5)).toBe(2);
    expect(snapChapterProgress(4.8, 5)).toBe(4);
  });

  it('以同一模型生成对称的退出和进入视觉', () => {
    expect(deriveChapterVisualState(0, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 0.79,
      interactive: false
    });
    expect(deriveChapterVisualState(1, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 1.16,
      interactive: false
    });
    expect(deriveChapterVisualState(1, 1, false)).toMatchObject({
      opacity: 1,
      scale: 1,
      interactive: true
    });
  });

  it('减少动态效果时只保留交叉渐隐', () => {
    expect(deriveChapterVisualState(1, 0.5, true)).toMatchObject({
      opacity: 0.5,
      scale: 1,
      blurPx: 0
    });
  });
});
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/chapter-model.test.ts
```

预期：失败，提示无法解析 `chapter-model`。

- [ ] **步骤 3：实现章节类型和纯函数**

```ts
export type ChapterId = 'home' | 'about' | 'download' | 'feedback' | 'donation';
export type ChapterDirection = -1 | 0 | 1;

export interface ChapterVisualState {
  opacity: number;
  scale: number;
  blurPx: number;
  contrast: number;
  zIndex: number;
  visible: boolean;
  interactive: boolean;
}

export function clampChapterProgress(value: number, chapterCount: number): number {
  const maximum = Math.max(0, chapterCount - 1);
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, value));
}

export function applyChapterDelta(
  progress: number,
  delta: number,
  settledIndex: number,
  chapterCount: number
): number {
  const minimum = Math.max(0, settledIndex - 1);
  const maximum = Math.min(chapterCount - 1, settledIndex + 1);
  return Math.min(maximum, Math.max(minimum, progress + delta));
}

export function snapChapterProgress(progress: number, chapterCount: number): number {
  return clampChapterProgress(Math.round(progress), chapterCount);
}

export function deriveChapterVisualState(
  index: number,
  progress: number,
  reducedMotion: boolean
): ChapterVisualState {
  const distance = index - progress;
  const visible = Math.abs(distance) <= 1;
  const opacity = visible ? 1 - Math.min(1, Math.abs(distance)) : 0;
  const exiting = distance < 0;
  const scale = reducedMotion
    ? 1
    : exiting
      ? 1 - Math.min(1, -distance) * 0.42
      : 1 + Math.min(1, distance) * 0.32;

  return {
    opacity,
    scale,
    blurPx: reducedMotion ? 0 : Math.min(1, Math.abs(distance)) * 10,
    contrast: 1 - Math.min(1, Math.abs(distance)) * 0.18,
    zIndex: exiting ? 1 : 2,
    visible,
    interactive: Math.abs(distance) < 0.0001
  };
}
```

- [ ] **步骤 4：运行测试并确认通过**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/chapter-model.test.ts
```

预期：4 个测试全部通过。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/types.ts apps/website/components/website-experience/chapter-model.ts apps/website/tests/chapter-model.test.ts
git commit -m "feat(website): add multi-chapter progress model"
```

---

### Task 2：实现统一输入与章节控制器

**文件：**

- 新建：`apps/website/components/website-experience/use-website-controller.ts`
- 修改：`apps/website/tests/chapter-model.test.ts`

**接口：**

- 消费：任务 1 的章节纯函数。
- 产出：`useWebsiteController(options)`。
- 产出：`isLocalInputTarget(target)` 和 `calculateSwipeDelta(startY, currentY)` 供测试。
- 产出结果：`phase`、`progress`、`settledIndex`、`pointer`、`isPaused`、`prefersReducedMotion`、`initializationFailed`、`drawingDone()`、`settled()`、`registerIntroSkip()`、`goToAdjacent()`。

- [ ] **步骤 1：为局部输入和触屏阈值补充失败测试**

```ts
import {
  calculateSwipeDelta,
  isLocalInputElement
} from '../components/website-experience/use-website-controller';

it('识别局部滚筒输入并忽略短触屏移动', () => {
  const local = {
    closest: (selector: string) => selector === '[data-input-scope="local"]'
      ? {}
      : null
  };

  expect(isLocalInputElement(local)).toBe(true);
  expect(calculateSwipeDelta(500, 470)).toBe(0);
  expect(calculateSwipeDelta(500, 430)).toBe(1);
  expect(calculateSwipeDelta(500, 570)).toBe(-1);
});
```

- [ ] **步骤 2：运行测试并确认导出不存在**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/chapter-model.test.ts
```

预期：失败，提示 `calculateSwipeDelta` 或 `isLocalInputElement` 未导出。

- [ ] **步骤 3：实现统一控制器**

控制器必须从现有 `use-experience-controller.ts` 迁移并复用以下能力：

```ts
export interface WebsiteControllerOptions {
  chapterCount: number;
  onInitializationError?: () => void;
}

export interface WebsiteControllerResult {
  phase: ExperiencePhase;
  progress: number;
  settledIndex: number;
  pointer: PointerPoint;
  isPaused: boolean;
  prefersReducedMotion: boolean;
  initializationFailed: boolean;
  drawingDone: () => void;
  settled: () => void;
  registerIntroSkip: (skip: (() => void) | null) => void;
  goToAdjacent: (direction: -1 | 1) => void;
}

export function isLocalInputElement(
  target: { closest: (selector: string) => unknown } | null
): boolean {
  return Boolean(target?.closest('[data-input-scope="local"]'));
}

export function calculateSwipeDelta(startY: number, currentY: number): -1 | 0 | 1 {
  const distance = startY - currentY;
  if (Math.abs(distance) < 48) return 0;
  return distance > 0 ? 1 : -1;
}
```

实现时遵守以下状态规则：

- 首页开场期间滚轮、点击或方向键只调用已注册的 `introSkip`。
- 交互阶段滚轮增量乘 `EXPERIENCE_CONFIG.progress.wheelScale`。
- 全局处理器遇到 `data-input-scope="local"` 时直接返回。
- `ArrowDown`、`PageDown` 前进，`ArrowUp`、`PageUp` 后退。
- 触屏只在 `pointerType === 'touch'` 时记录起点，并在抬起时跨过 48px 阈值后前进一个章节。
- 输入结束后使用 `requestAnimationFrame` 在 `240–360ms` 内吸附到最近章节。
- 吸附完成才更新 `settledIndex`，因此连续输入不能越过相邻章节。
- 页面失焦或隐藏时取消动画帧，恢复时从当前进度继续。

- [ ] **步骤 4：运行模型测试和类型检查**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/chapter-model.test.ts
pnpm --filter @myself/website typecheck
```

预期：模型测试通过；控制器暂未接入页面但 TypeScript 无错误。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/use-website-controller.ts apps/website/tests/chapter-model.test.ts
git commit -m "feat(website): add unified chapter input controller"
```

---

### Task 3：搭建五章节舞台并接入现有首页

**文件：**

- 新建：`apps/website/components/website-experience/PlaceholderChapter.tsx`
- 新建：`apps/website/components/website-experience/chapter-registry.tsx`
- 新建：`apps/website/components/website-experience/WebsiteExperience.tsx`
- 新建：`apps/website/components/website-experience/website-experience.module.css`
- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/home-experience/home-experience.module.css`
- 修改：`apps/website/app/page.tsx`
- 修改：`apps/website/tests/page.test.tsx`
- 修改：`apps/website/tests/progress-model.test.ts`
- 删除：`apps/website/components/home-experience/progress-model.ts`
- 删除：`apps/website/components/home-experience/use-experience-controller.ts`

**接口：**

- 消费：任务 1 的视觉状态和任务 2 的控制器。
- 产出：`CHAPTER_REGISTRY`，包含五个稳定 `ChapterId`。
- 产出：受控 `HomeExperienceProps`。
- 产出：页面根节点 `[data-testid="website-experience"]` 和章节节点 `[data-chapter-id]`。

- [ ] **步骤 1：把静态页面测试改成五章节失败断言**

```tsx
it('静态 HTML 注册五章节和两个明确占位状态', () => {
  const html = renderToStaticMarkup(<Page />);

  expect(html).toContain('data-testid="website-experience"');
  expect(html.match(/data-chapter-id=/g) ?? []).toHaveLength(5);
  expect(html).toContain('data-chapter-id="home"');
  expect(html).toContain('data-chapter-id="about"');
  expect(html).toContain('data-chapter-id="download"');
  expect(html).toContain('data-chapter-id="feedback"');
  expect(html).toContain('data-chapter-id="donation"');
  expect(html).toContain('AI Pet 介绍');
  expect(html).toContain('用户反馈与建议箱');
  expect(html.match(/内容准备中/g) ?? []).toHaveLength(2);
});
```

- [ ] **步骤 2：运行页面测试并确认仍只有首页**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/page.test.tsx
```

预期：失败，缺少 `website-experience` 和四个后续章节。

- [ ] **步骤 3：实现注册表、舞台和受控首页**

注册表使用稳定顺序：

```tsx
export const CHAPTER_REGISTRY = [
  { id: 'home', label: '首页' },
  { id: 'about', label: 'AI Pet 介绍' },
  { id: 'download', label: 'AI Pet 下载安装' },
  { id: 'feedback', label: '用户反馈与建议箱' },
  { id: 'donation', label: '捐款' }
] as const;
```

占位章节保持明确语义：

```tsx
interface PlaceholderChapterProps {
  title: string;
}

export function PlaceholderChapter({ title }: PlaceholderChapterProps) {
  return (
    <div className={styles.placeholderContent}>
      <h2>{title}</h2>
      <p>内容准备中</p>
    </div>
  );
}
```

`WebsiteExperience` 对每章应用纯视觉状态：

```tsx
const visual = deriveChapterVisualState(index, controller.progress, controller.prefersReducedMotion);
const style = {
  '--chapter-opacity': visual.opacity,
  '--chapter-scale': visual.scale,
  '--chapter-blur': `${visual.blurPx}px`,
  '--chapter-contrast': visual.contrast,
  zIndex: visual.zIndex
} as CSSProperties;
```

章节节点必须设置：

```tsx
<section
  data-chapter-id={chapter.id}
  data-visible={visual.visible}
  data-interactive={visual.interactive}
  aria-hidden={!visual.visible}
  inert={!visual.interactive ? true : undefined}
  style={style}
/>
```

`HomeExperience` 改为接收全局控制器状态，不再注册 `window` 级滚轮、键盘和指针监听：

```ts
export interface HomeExperienceProps {
  phase: ExperiencePhase;
  exitProgress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  reducedMotion: boolean;
  registerIntroSkip: (skip: (() => void) | null) => void;
  onDrawingDone: () => void;
  onSettled: () => void;
  onInitializationError: () => void;
}
```

迁移完成后，原 `progress-model.ts` 和 `use-experience-controller.ts` 不得保留未引用的重复状态机。原测试中的开场跳过、输入速度和吸附插值断言迁移到 `chapter-model.test.ts`，首页磁吸时间线断言继续保留在原首页测试中。

`page.tsx` 只渲染整站舞台：

```tsx
import { WebsiteExperience } from '../components/website-experience/WebsiteExperience';

export default function Page() {
  return <WebsiteExperience />;
}
```

- [ ] **步骤 4：运行页面、首页模型测试和类型检查**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/page.test.tsx tests/progress-model.test.ts
pnpm --filter @myself/website typecheck
```

预期：页面测试包含五章节；首页磁吸开场测试仍通过；类型检查通过。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/app/page.tsx apps/website/components/website-experience apps/website/components/home-experience/HomeExperience.tsx apps/website/components/home-experience/home-experience.module.css apps/website/tests/page.test.tsx apps/website/tests/progress-model.test.ts
git commit -m "feat(website): add five-chapter experience stage"
```

---

### Task 4：把首页粒子与光场提升为共享视觉层

**文件：**

- 新建：`apps/website/components/website-experience/shared-visual-model.ts`
- 新建：`apps/website/components/website-experience/SharedVisualLayers.tsx`
- 新建：`apps/website/tests/shared-visual-model.test.ts`
- 修改：`apps/website/components/home-experience/CursorField.tsx`
- 修改：`apps/website/components/home-experience/FileSwarm.tsx`
- 修改：`apps/website/components/home-experience/config.ts`
- 修改：`apps/website/components/home-experience/types.ts`
- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/website-experience/WebsiteExperience.tsx`

**接口：**

- 产出：`RgbColor`、`SharedVisualProfile`、`resolveSharedVisualProfile()`。
- 产出：`CursorField` 新属性 `active` 和 `color`。
- 产出：`FileSwarm` 新属性 `running`、`generating`、`exitProgress`、`maxActive`、`safeZoneRatio`。
- 产出：单例 `SharedVisualLayers`，主题切换时通过 `profile.id` 重置内部资源。

- [ ] **步骤 1：编写共享主题失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from '../components/website-experience/shared-visual-model';

describe('共享视觉主题', () => {
  it('首页使用灰色光场且捐款使用黄色光场', () => {
    expect(VISUAL_PROFILES.home.fieldColor).toEqual([180, 180, 180]);
    expect(VISUAL_PROFILES.donation.fieldColor).toEqual([255, 255, 0]);
  });

  it('只在首页和捐款附近启用共享视觉层', () => {
    expect(resolveSharedVisualProfile(0, 'interactive')?.id).toBe('home');
    expect(resolveSharedVisualProfile(2, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(4, 'interactive')?.id).toBe('donation');
  });
});
```

- [ ] **步骤 2：运行测试并确认模块不存在**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/shared-visual-model.test.ts
```

预期：失败，无法解析 `shared-visual-model`。

- [ ] **步骤 3：实现主题和共享层**

```ts
export type RgbColor = readonly [number, number, number];

export interface SharedVisualProfile {
  id: 'home' | 'donation';
  fieldColor: RgbColor;
  maxActive: number;
  safeZoneRatio: number;
}

export const VISUAL_PROFILES = {
  home: {
    id: 'home',
    fieldColor: [180, 180, 180],
    maxActive: 10,
    safeZoneRatio: 0.3
  },
  donation: {
    id: 'donation',
    fieldColor: [255, 255, 0],
    maxActive: 8,
    safeZoneRatio: 0.34
  }
} as const satisfies Record<string, SharedVisualProfile>;

export function resolveSharedVisualProfile(
  progress: number,
  phase: ExperiencePhase
): SharedVisualProfile | null {
  if (phase !== 'interactive' && phase !== 'exiting') return null;
  if (progress < 1) return VISUAL_PROFILES.home;
  if (progress > 3) return VISUAL_PROFILES.donation;
  return null;
}
```

`CursorField` 的绘制函数不得再写死颜色：

```ts
function toRgba(color: RgbColor, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}
```

`FileSwarm` 生成门禁改为显式参数：

```ts
export function canGenerateParticle(input: {
  generating: boolean;
  isPaused: boolean;
  activeCount: number;
  disabledKindCount: number;
  maxActive: number;
}): boolean {
  return input.generating
    && !input.isPaused
    && input.activeCount < input.maxActive
    && input.disabledKindCount < FILE_KINDS.length;
}
```

`SharedVisualLayers` 只挂载一个 Canvas 和一个粒子群：

```tsx
<CursorField
  active={running}
  pointer={pointer}
  isPaused={isPaused}
  reducedMotion={reducedMotion}
  color={profile.fieldColor}
  onInitializationError={onInitializationError}
/>
<FileSwarm
  key={profile.id}
  running={running}
  generating={generating}
  exitProgress={exitProgress}
  pointer={pointer}
  isPaused={isPaused}
  reducedMotion={reducedMotion}
  maxActive={profile.maxActive}
  safeZoneRatio={profile.safeZoneRatio}
  previewContainer={previewContainer}
  onInitializationError={onInitializationError}
/>
```

- [ ] **步骤 4：运行共享视觉、首页粒子和类型测试**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/shared-visual-model.test.ts tests/swarm-model.test.ts tests/pointer-model.test.ts tests/page.test.tsx
pnpm --filter @myself/website typecheck
```

预期：共享主题、原粒子模型、指针模型和页面静态语义全部通过。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/shared-visual-model.ts apps/website/components/website-experience/SharedVisualLayers.tsx apps/website/components/home-experience/CursorField.tsx apps/website/components/home-experience/FileSwarm.tsx apps/website/components/home-experience/config.ts apps/website/components/home-experience/types.ts apps/website/components/home-experience/HomeExperience.tsx apps/website/components/website-experience/WebsiteExperience.tsx apps/website/tests/shared-visual-model.test.ts
git commit -m "refactor(website): share particle and pointer visual layers"
```

---

### Task 5：建立下载平台内容与交互状态模型

**文件：**

- 新建：`apps/website/components/website-experience/download/download-content.ts`
- 新建：`apps/website/components/website-experience/download/download-model.ts`
- 新建：`apps/website/tests/download-model.test.ts`

**接口：**

- 产出：区分 `available` 和 `coming-soon` 的 `DownloadPlatform`。
- 产出：`DOWNLOAD_PLATFORMS`、`FAQ_ITEMS`、`INSTALL_NOTICE_ITEMS`。
- 产出：`rotatePlatformIndex()`、`reduceDownloadInteraction()`、`visibleDownloadSide()`。

- [ ] **步骤 1：编写平台和面板状态失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_PLATFORMS } from '../components/website-experience/download/download-content';
import {
  initialDownloadInteraction,
  reduceDownloadInteraction,
  rotatePlatformIndex,
  visibleDownloadSide
} from '../components/website-experience/download/download-model';

describe('下载模块数据与状态', () => {
  it('Windows 可下载而 macOS 只显示即将支持', () => {
    expect(DOWNLOAD_PLATFORMS[0]).toMatchObject({
      id: 'windows-x64',
      status: 'available'
    });
    expect(DOWNLOAD_PLATFORMS[1]).toMatchObject({
      id: 'macos',
      status: 'coming-soon'
    });
    expect('downloadUrl' in DOWNLOAD_PLATFORMS[1]!).toBe(false);
  });

  it('平台索引可循环且不依赖两个固定项目', () => {
    expect(rotatePlatformIndex(0, -1, 3)).toBe(2);
    expect(rotatePlatformIndex(2, 1, 3)).toBe(0);
  });

  it('临时面板、锁定面板和复位互斥', () => {
    const hovered = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'PREVIEW_SIDE',
      side: 'faq'
    });
    expect(visibleDownloadSide(hovered)).toBe('faq');

    const locked = reduceDownloadInteraction(hovered, {
      type: 'TOGGLE_LOCK',
      side: 'notice'
    });
    expect(visibleDownloadSide(locked)).toBe('notice');

    expect(reduceDownloadInteraction(locked, { type: 'RESET' }))
      .toEqual(initialDownloadInteraction);
  });
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/download-model.test.ts
```

预期：失败，下载内容与状态模块不存在。

- [ ] **步骤 3：实现内容适配和纯状态机**

平台使用判别联合：

```ts
export type DownloadPlatform =
  | {
      id: string;
      name: string;
      status: 'available';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
      downloadUrl: string;
      fileName: string;
      sha256: string;
    }
  | {
      id: string;
      name: string;
      status: 'coming-soon';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
    };
```

Windows 数据必须通过 `releaseManifestSchema.parse(rawManifest)` 构造；macOS 对象不得出现 `downloadUrl`。

面板状态机使用以下事件：

```ts
export type DownloadInteractionEvent =
  | { type: 'SELECT_PLATFORM'; index: number }
  | { type: 'PREVIEW_SIDE'; side: DownloadSide }
  | { type: 'CLEAR_PREVIEW'; side: Exclude<DownloadSide, null> }
  | { type: 'TOGGLE_LOCK'; side: Exclude<DownloadSide, null> }
  | { type: 'RESET' };
```

`visibleDownloadSide(state)` 必须返回 `state.lockedSide ?? state.previewSide`，并确保左右状态互斥。

```ts
export const initialDownloadInteraction: DownloadInteractionState = {
  activePlatformIndex: 0,
  previewSide: null,
  lockedSide: null
};

export function rotatePlatformIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function visibleDownloadSide(state: DownloadInteractionState): DownloadSide {
  return state.lockedSide ?? state.previewSide;
}

export function reduceDownloadInteraction(
  state: DownloadInteractionState,
  event: DownloadInteractionEvent
): DownloadInteractionState {
  switch (event.type) {
    case 'SELECT_PLATFORM':
      return { ...state, activePlatformIndex: event.index };
    case 'PREVIEW_SIDE':
      return state.lockedSide ? state : { ...state, previewSide: event.side };
    case 'CLEAR_PREVIEW':
      return state.previewSide === event.side
        ? { ...state, previewSide: null }
        : state;
    case 'TOGGLE_LOCK':
      return {
        ...state,
        previewSide: null,
        lockedSide: state.lockedSide === event.side ? null : event.side
      };
    case 'RESET':
      return initialDownloadInteraction;
  }
}
```

- [ ] **步骤 4：运行下载模型和发行清单测试**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/download-model.test.ts tests/release-manifest.test.ts
```

预期：下载模型测试通过，原 Windows 发行清单契约保持通过。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/download/download-content.ts apps/website/components/website-experience/download/download-model.ts apps/website/tests/download-model.test.ts
git commit -m "feat(website): add configurable download content model"
```

---

### Task 6：实现下载安装视觉与交互

**文件：**

- 新建：`apps/website/components/website-experience/download/DownloadChapter.tsx`
- 新建：`apps/website/components/website-experience/download/download.module.css`
- 新建：`apps/website/tests/download-chapter.test.tsx`
- 修改：`apps/website/components/website-experience/chapter-registry.tsx`
- 修改：`apps/website/package.json`
- 修改：`pnpm-lock.yaml`

**接口：**

- 消费：任务 5 的配置与状态模型。
- 产出：`DownloadChapter`，根节点 `[data-testid="download-chapter"]`。
- 产出：局部输入根节点 `[data-input-scope="local"]`。

- [ ] **步骤 1：安装标准图标依赖**

运行：

```powershell
pnpm --filter @myself/website add lucide-react
```

预期：`apps/website/package.json` 出现 `lucide-react`，锁文件更新。

- [ ] **步骤 2：编写下载章节静态失败测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

describe('下载安装章节', () => {
  it('渲染配置平台、真实下载和两侧信息', () => {
    const html = renderToStaticMarkup(<DownloadChapter interactive />);

    expect(html).toContain('data-testid="download-chapter"');
    expect(html).toContain('Windows');
    expect(html).toContain('macOS');
    expect(html).toContain('即将支持');
    expect(html).toContain('.exe');
    expect(html).toContain('常见问题');
    expect(html).toContain('安装前须知');
    expect(html).toContain('data-input-scope="local"');
  });
});
```

- [ ] **步骤 3：运行测试并确认组件不存在**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/download-chapter.test.tsx
```

预期：失败，无法解析 `DownloadChapter`。

- [ ] **步骤 4：实现下载章节**

组件必须满足以下结构：

```tsx
<div
  className={styles.downloadChapter}
  data-testid="download-chapter"
  data-visible-side={visibleSide ?? 'none'}
>
  <button type="button" aria-label="显示常见问题">
    <ChevronRight aria-hidden="true" />
  </button>
  <aside aria-label="常见问题" aria-hidden={visibleSide !== 'faq'} />
  <div
    className={styles.platformStack}
    data-input-scope="local"
    onWheel={handlePlatformWheel}
    onKeyDown={handlePlatformKeyDown}
  />
  <aside aria-label="安装前须知" aria-hidden={visibleSide !== 'notice'} />
  <button type="button" aria-label="显示安装前须知">
    <ChevronLeft aria-hidden="true" />
  </button>
</div>
```

交互要求：

- 卡片样式根据与当前索引的循环距离计算 `translateY`、`scale`、`opacity` 和 `z-index`。
- 点击非当前卡片只切换当前项。
- Windows 当前卡片渲染真实 `<a href>`。
- macOS 当前卡片渲染禁用按钮并显示“即将支持”。
- `onWheel` 调用 `preventDefault()` 和 `stopPropagation()`，按 `deltaY` 正负切换平台。
- 左右按钮同时处理 pointer enter/leave、focus/blur 和 click 锁定。
- `Esc` 和中央卡片点击派发 `RESET`。
- 侧栏列表使用 `gsap.context()` 做 `300–500ms` 的短距离错峰，并在 effect 清理时 `context.revert()`。

CSS 必须包含：

```css
.downloadChapter {
  min-height: 100%;
  background:
    linear-gradient(
      90deg,
      rgb(0, 255, 200) 0%,
      rgb(235, 235, 235) 24%,
      rgb(235, 235, 235) 76%,
      rgb(0, 255, 200) 100%
    );
}
```

卡片、箭头和焦点目标必须保持至少 `44px`，卡片背景使用 `rgb(235, 235, 235)`。

- [ ] **步骤 5：运行下载测试、页面测试和类型检查**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/download-model.test.ts tests/download-chapter.test.tsx tests/page.test.tsx
pnpm --filter @myself/website typecheck
```

预期：下载内容、状态、静态语义和整页注册全部通过。

- [ ] **步骤 6：在获得 Git 授权后提交**

```powershell
git add apps/website/package.json pnpm-lock.yaml apps/website/components/website-experience/download apps/website/components/website-experience/chapter-registry.tsx apps/website/tests/download-chapter.test.tsx
git commit -m "feat(website): build interactive download chapter"
```

---

### Task 7：建立支付方式配置与循环滚筒模型

**文件：**

- 新建：`apps/website/components/website-experience/donation/donation-content.ts`
- 新建：`apps/website/components/website-experience/donation/payment-model.ts`
- 新建：`apps/website/tests/payment-model.test.ts`

**接口：**

- 产出：`PaymentMethod`、`PAYMENT_METHODS`。
- 产出：`wrapPaymentIndex()`、`paymentRelativeOffset()`、`paymentCardVisual()`。

- [ ] **步骤 1：编写支付滚筒失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '../components/website-experience/donation/donation-content';
import {
  paymentCardVisual,
  paymentRelativeOffset,
  wrapPaymentIndex
} from '../components/website-experience/donation/payment-model';

describe('支付方式滚筒', () => {
  it('配置微信和支付宝且路径可替换', () => {
    expect(PAYMENT_METHODS.map((item) => item.id)).toEqual(['wechat', 'alipay']);
    expect(PAYMENT_METHODS.every((item) => item.qrImagePath.startsWith('/payments/')))
      .toBe(true);
  });

  it('任意数量都能循环并计算最短相对距离', () => {
    expect(wrapPaymentIndex(-1, 3)).toBe(2);
    expect(wrapPaymentIndex(3, 3)).toBe(0);
    expect(paymentRelativeOffset(3, 0, 4)).toBe(-1);
    expect(paymentRelativeOffset(1, 0, 2)).toBe(1);
  });

  it('当前卡片最大且只有当前卡片可打开付款码', () => {
    expect(paymentCardVisual(0)).toMatchObject({
      scale: 1,
      opacity: 1,
      zIndex: 10,
      activatable: true
    });
    expect(paymentCardVisual(1)).toMatchObject({
      scale: 0.88,
      activatable: false
    });
  });
});
```

- [ ] **步骤 2：运行测试并确认模块不存在**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/payment-model.test.ts
```

预期：失败，支付配置和模型不存在。

- [ ] **步骤 3：实现配置和循环位置函数**

```ts
export interface PaymentMethod {
  id: string;
  name: string;
  qrImagePath: string;
  imageAlt: string;
}

export const PAYMENT_METHODS = [
  {
    id: 'wechat',
    name: '微信',
    qrImagePath: '/payments/wechat.png',
    imageAlt: '微信付款码'
  },
  {
    id: 'alipay',
    name: '支付宝',
    qrImagePath: '/payments/alipay.png',
    imageAlt: '支付宝付款码'
  }
] as const satisfies readonly PaymentMethod[];
```

```ts
export function wrapPaymentIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function paymentRelativeOffset(index: number, active: number, length: number): number {
  const forward = wrapPaymentIndex(index - active, length);
  return forward > length / 2 ? forward - length : forward;
}

export function paymentCardVisual(offset: number) {
  const distance = Math.abs(offset);
  return {
    translateYPercent: offset * 54,
    scale: distance === 0 ? 1 : Math.max(0.72, 0.94 - distance * 0.06),
    opacity: distance === 0 ? 1 : Math.max(0.38, 0.78 - distance * 0.12),
    zIndex: distance === 0 ? 10 : Math.max(1, 8 - distance),
    activatable: distance === 0
  };
}
```

- [ ] **步骤 4：运行支付模型测试**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/payment-model.test.ts
```

预期：3 个测试全部通过。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/donation/donation-content.ts apps/website/components/website-experience/donation/payment-model.ts apps/website/tests/payment-model.test.ts
git commit -m "feat(website): add configurable payment carousel model"
```

---

### Task 8：实现捐款章节和付款码弹层

**文件：**

- 新建：`apps/website/components/website-experience/donation/DonationChapter.tsx`
- 新建：`apps/website/components/website-experience/donation/QrDialog.tsx`
- 新建：`apps/website/components/website-experience/donation/donation.module.css`
- 新建：`apps/website/tests/donation-chapter.test.tsx`
- 修改：`apps/website/components/website-experience/chapter-registry.tsx`
- 修改：`apps/website/components/website-experience/WebsiteExperience.tsx`

**接口：**

- 消费：任务 4 的捐款视觉主题和任务 7 的支付配置。
- 产出：`DonationChapter` 根节点 `[data-testid="donation-chapter"]`。
- 产出：`QrDialog`，使用 `role="dialog"`、`aria-modal="true"` 和缺图回退。

- [ ] **步骤 1：编写捐款静态失败测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DonationChapter } from '../components/website-experience/donation/DonationChapter';

describe('捐款章节', () => {
  it('渲染标题、支付方式和局部输入区域', () => {
    const html = renderToStaticMarkup(<DonationChapter interactive />);

    expect(html).toContain('data-testid="donation-chapter"');
    expect(html).toContain('助力开发，你便也是我不可或缺的参与者');
    expect(html).toContain('微信');
    expect(html).toContain('支付宝');
    expect(html).toContain('data-input-scope="local"');
  });
});
```

- [ ] **步骤 2：运行测试并确认组件不存在**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/donation-chapter.test.tsx
```

预期：失败，无法解析 `DonationChapter`。

- [ ] **步骤 3：实现支付滚筒**

`DonationChapter` 必须：

```tsx
<section data-testid="donation-chapter" className={styles.donationChapter}>
  <h2>助力开发，你便也是我不可或缺的参与者</h2>
  <div
    className={styles.paymentRoller}
    data-input-scope="local"
    tabIndex={interactive ? 0 : -1}
    onWheel={handleWheel}
    onKeyDown={handleKeyDown}
    onPointerDown={handlePointerDown}
    onPointerUp={handlePointerUp}
  >
    {PAYMENT_METHODS.map((method, index) => (
      <button
        key={method.id}
        type="button"
        aria-label={`${method.name}付款方式`}
        onClick={() => handleCardClick(index)}
      >
        {method.name}
      </button>
    ))}
  </div>
</section>
```

行为规则：

- 局部滚轮调用 `preventDefault()` 和 `stopPropagation()`。
- 方向键、滚轮和超过 40px 的触屏拖动切换当前索引。
- 非当前按钮点击只切换索引。
- 当前按钮点击打开对应弹层。
- `interactive=false` 时所有按钮 `tabIndex=-1` 且不响应内部操作。

- [ ] **步骤 4：实现付款码弹层**

`QrDialog` 必须通过 `createPortal` 挂载到 `document.body`，并实现：

```tsx
<div
  className={styles.qrBackdrop}
  role="dialog"
  aria-modal="true"
  aria-labelledby={titleId}
  onClick={onClose}
>
  <div className={styles.qrPanel}>
    <h3 id={titleId}>{method.name}付款码</h3>
    {!imageFailed ? (
      <img
        src={method.qrImagePath}
        alt={method.imageAlt}
        onError={() => setImageFailed(true)}
      />
    ) : (
      <p role="status">付款码暂未配置</p>
    )}
    <button type="button" aria-label="关闭付款码" onClick={onClose}>
      <X aria-hidden="true" />
    </button>
  </div>
</div>
```

弹层 effect 必须：

- 保存打开前的 `document.activeElement`。
- 把焦点移动到关闭按钮。
- `Tab` 和 `Shift+Tab` 在弹层可聚焦元素内循环。
- `Esc` 调用 `onClose`。
- 清理时移除监听并把焦点还给原按钮。
- 弹层内点击不阻止关闭，以符合“点任意处关闭图片”。

- [ ] **步骤 5：运行捐款、支付和页面测试**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/payment-model.test.ts tests/donation-chapter.test.tsx tests/page.test.tsx
pnpm --filter @myself/website typecheck
```

预期：支付模型、捐款静态结构、五章节页面和类型检查全部通过。

- [ ] **步骤 6：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience/donation apps/website/components/website-experience/chapter-registry.tsx apps/website/components/website-experience/WebsiteExperience.tsx apps/website/tests/donation-chapter.test.tsx
git commit -m "feat(website): build donation carousel and qr dialog"
```

---

### Task 9：完成响应式、减少动态效果与静态回退

**文件：**

- 修改：`apps/website/components/website-experience/WebsiteExperience.tsx`
- 修改：`apps/website/components/website-experience/website-experience.module.css`
- 修改：`apps/website/components/website-experience/download/download.module.css`
- 修改：`apps/website/components/website-experience/donation/donation.module.css`
- 修改：`apps/website/components/home-experience/home-experience.module.css`
- 修改：`apps/website/tests/page.test.tsx`

**接口：**

- 产出：移动端上一章节和下一章节按钮。
- 产出：`data-static-fallback`、`data-reduced-motion` 和 `data-active-chapter` 验收属性。
- 保证：初始化失败时当前章节保持静态可操作，Windows 下载入口不消失。

- [ ] **步骤 1：为静态回退和移动控制补充失败测试**

```tsx
it('静态 HTML 保留章节导航和真实下载回退', () => {
  const html = renderToStaticMarkup(<Page />);

  expect(html).toContain('data-static-fallback="ready"');
  expect(html).toContain('aria-label="上一章节"');
  expect(html).toContain('aria-label="下一章节"');
  expect(html).toContain('Myself-0.1.0-alpha.1-windows-x64.exe');
  expect(html).toContain('即将支持');
});
```

- [ ] **步骤 2：运行页面测试并确认移动控制缺失**

```powershell
pnpm --filter @myself/website exec vitest run --config vitest.config.ts tests/page.test.tsx
```

预期：失败，缺少上一章节和下一章节控制。

- [ ] **步骤 3：实现移动导航和异常回退**

舞台必须始终服务端渲染导航按钮：

```tsx
<nav className={styles.chapterControls} aria-label="章节导航">
  <button
    type="button"
    aria-label="上一章节"
    disabled={controller.settledIndex === 0}
    onClick={() => controller.goToAdjacent(-1)}
  >
    <ChevronUp aria-hidden="true" />
  </button>
  <button
    type="button"
    aria-label="下一章节"
    disabled={controller.settledIndex === CHAPTER_REGISTRY.length - 1}
    onClick={() => controller.goToAdjacent(1)}
  >
    <ChevronDown aria-hidden="true" />
  </button>
</nav>
```

异常回退规则：

- `initializationFailed` 后停止 Canvas、粒子和 GSAP 持续动画。
- 章节视觉状态改为稳定比例 `1` 和无模糊。
- 仍允许上一章节、下一章节和章节内部静态操作。
- 当前章节以外内容保留在 DOM，但保持不可交互。

移动端 CSS 必须：

```css
@media (max-width: 760px) {
  .chapter {
    filter: none;
  }

  .chapterControls {
    display: flex;
    position: fixed;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  .chapter {
    transform: none !important;
    filter: none !important;
    transition-duration: 200ms;
  }
}
```

下载模块在移动端把左右 aside 放到卡片下方；捐款弹层使用 `width: min(92vw, 560px)` 和 `max-height: calc(100svh - 32px)`。

- [ ] **步骤 4：运行网站单元、类型和构建验证**

```powershell
pnpm --filter @myself/website test
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
```

预期：全部测试通过；静态构建成功；没有缺失付款码资源导致的构建失败。

- [ ] **步骤 5：在获得 Git 授权后提交**

```powershell
git add apps/website/components/website-experience apps/website/components/home-experience/home-experience.module.css apps/website/tests/page.test.tsx
git commit -m "feat(website): add responsive and accessible chapter fallbacks"
```

---

### Task 10：扩展端到端与视觉验收

**文件：**

- 修改：`tests/e2e/website.spec.ts`

**接口：**

- 消费：`data-testid`、`data-chapter-id`、`data-active-chapter`、`data-input-scope` 和弹层语义。
- 产出：五章节、下载、捐款、响应式、减少动态效果、初始化失败和 Canvas 像素证据。

- [ ] **步骤 1：新增章节导航辅助函数和失败测试**

```ts
const WEBSITE = '[data-testid="website-experience"]';

async function enterChapter(page: Page, chapterId: string): Promise<void> {
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-phase', 'interactive');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.locator(WEBSITE).getAttribute('data-active-chapter') === chapterId) return;
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(420);
  }
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', chapterId);
}

test('逐章节推拉且快速输入不能跳过占位章节', async ({ page }) => {
  await enterInteractive(page);
  await page.mouse.wheel(0, 5000);
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
  await page.keyboard.press('PageDown');
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'download');
  await page.keyboard.press('PageUp');
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
});
```

- [ ] **步骤 2：运行单个 E2E 并确认新断言失败**

```powershell
pnpm --filter @myself/website build
pnpm exec playwright test --config tests/playwright.website.config.ts --grep "逐章节推拉"
```

预期：失败，因为旧 E2E 辅助函数或新章节属性尚未完全对齐。

- [ ] **步骤 3：补齐下载与捐款交互 E2E**

新增以下独立用例：

```ts
test('下载平台滚筒消费局部滚轮并保持当前章节', async ({ page }) => {
  await enterInteractive(page);
  await enterChapter(page, 'download');
  const stack = page.locator('[data-testid="download-platform-stack"]');
  await stack.hover();
  await page.mouse.wheel(0, 160);
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'download');
  await expect(stack).toHaveAttribute('data-active-platform', 'macos');
  await expect(page.getByRole('button', { name: /即将支持/ })).toBeDisabled();
});

test('下载侧栏支持锁定、切换、复位和真实 Windows 链接', async ({ page }) => {
  await enterInteractive(page);
  await enterChapter(page, 'download');
  await page.getByRole('button', { name: '显示常见问题' }).click();
  await expect(page.getByRole('complementary', { name: '常见问题' })).toBeVisible();
  await page.getByRole('button', { name: '显示安装前须知' }).click();
  await expect(page.getByRole('complementary', { name: '安装前须知' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /下载 Myself/ }))
    .toHaveAttribute('href', /\.exe$/);
});

test('支付滚筒消费局部滚轮并提供付款码缺图回退', async ({ page }) => {
  await enterInteractive(page);
  await enterChapter(page, 'donation');
  const roller = page.locator('[data-testid="payment-roller"]');
  await roller.hover();
  await page.mouse.wheel(0, 160);
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'donation');
  await page.getByRole('button', { name: '支付宝付款方式' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('付款码暂未配置');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '支付宝付款方式' })).toBeFocused();
});
```

- [ ] **步骤 4：补齐响应式、减少动态效果和视觉截图**

增加并保留截图：

- `chapter-transition-1440.png`
- `download-faq-1440.png`
- `download-notice-1440.png`
- `donation-yellow-field-1440.png`
- `donation-dialog-390.png`
- `website-1920.png`

移动端用例必须检查：

```ts
await page.setViewportSize({ width: 390, height: 844 });
await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
await page.getByRole('button', { name: '下一章节' }).click();
await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
```

减少动态效果用例必须断言章节 `transform` 为 `none`、Canvas 不运行、所有五章节仍可由按钮到达。

Canvas 像素检查保留现有首页灰色光场断言，并在捐款章节增加黄色通道占优的像素采样。

- [ ] **步骤 5：运行完整官网验证**

```powershell
pnpm verify:website
```

预期：

- 网站 TypeScript 检查通过。
- Vitest 全部通过。
- Next.js 静态构建通过。
- Playwright 官网套件全部通过。
- `390px`、`768px`、`1440px`、`1920px` 无横向溢出、重叠或裁切。
- 首页与捐款 Canvas 均通过非空像素检查。

- [ ] **步骤 6：人工浏览器复核**

启动开发服务器：

```powershell
pnpm --filter @myself/website dev
```

在浏览器依次检查：

1. 首页开场和首页到介绍占位的首个推拉。
2. 下载模块左右青蓝渐变、卡片堆叠和左右侧移。
3. 两个占位章节不会呈现空白或加载失败。
4. 捐款黄色光场、文件预览、支付滚筒和付款码弹层。
5. `390px` 触屏控制、下载抽屉和付款码安全边距。
6. 系统减少动态效果开启后的交叉渐隐。

验收期间记录控制台错误、布局溢出和动画重叠；发现问题时先添加可复现测试，再修改实现。

- [ ] **步骤 7：在获得 Git 授权后提交**

```powershell
git add tests/e2e/website.spec.ts
git commit -m "test(website): verify multi-chapter interactive experience"
```

---

## 最终完成门禁

- [ ] 运行 `pnpm verify:website` 并保存通过输出。
- [ ] 运行 `git diff --check`，确认没有空白错误。
- [ ] 运行 `git status --short`，确认变更范围仅包含本计划列出的官网、测试和锁文件。
- [ ] 对照设计规格第 16、17 节逐项确认测试与成功标准。
- [ ] 在任何“已完成”“已修复”或“全部通过”的结论前，使用 `superpowers:verification-before-completion` 复核最新命令证据。
- [ ] 未获用户 Git 授权时不执行暂存、提交、推送或创建分支。
