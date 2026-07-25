# AI Pet 官网首页视觉重做实施计划

> **供执行代理使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行。所有步骤使用复选框跟踪。

**目标：** 在不修改 Agent、后端和接口的前提下，将 `apps/website` 首页替换为可跳过开场、可由滚轮连续驱动、具有鼠标光场和漂浮文件预览的 AI Pet 沉浸式桌面端场景。

**架构：** 使用 GSAP 3.15.0 统一编排开场和场景进度，React DOM 承载品牌、文件图标和可访问文本，Canvas 承载鼠标光场。输入、状态、文件队列和内容池均隔离为纯 TypeScript 模块，组件只消费稳定接口。

**技术栈：** Next.js 15、React 19、TypeScript 5、GSAP 3.15.0、Vitest 3、Playwright 1.61。

## 全局约束

- 只修改 `apps/website`、网站端到端测试和本计划明确列出的根配置。
- 不修改 Agent、后端、桌面端、数据协议或发布清单。
- 不新增素材目录；复用 `apps/website/public` 中现有八张图片。
- 不删除旧官网组件；它们暂时退出页面入口，后续模块设计完成后再决定清理。
- 不引入运行时 AI 或后端请求；文件预览只读取本地结构化内容池。
- 页面背景稳定态为 `rgb(235, 235, 235)`，鼠标影响色为 `rgb(180, 180, 180)`。
- 同时最多显示 10 个文件图标，中央约 30% 视口为品牌安全区。
- 高频动画只改变 `transform`、`opacity` 或 Canvas 像素。
- 本轮重点验收桌面端；窄屏只保证不崩溃、不锁死。
- 所有新增文档和代码注释使用中文。
- 不执行 `git add`、`git commit` 或 `git push`。

## 文件结构

### 新增文件

- `apps/website/components/home-experience/types.ts`：共享领域类型。
- `apps/website/components/home-experience/config.ts`：集中动效与布局参数。
- `apps/website/components/home-experience/progress-model.ts`：进度、吸附和首页阶段纯逻辑。
- `apps/website/components/home-experience/pointer-model.ts`：品牌朝向、轨迹衰减和预览换边纯逻辑。
- `apps/website/components/home-experience/content-pool.ts`：七类本地预览内容。
- `apps/website/components/home-experience/swarm-model.ts`：随机种子、避让、队列和生命周期纯逻辑。
- `apps/website/components/home-experience/use-experience-controller.ts`：输入适配、页面暂停和统一进度。
- `apps/website/components/home-experience/use-intro-timeline.ts`：GSAP 开场时间轴。
- `apps/website/components/home-experience/APDrawMark.tsx`：Logo 描边遮罩。
- `apps/website/components/home-experience/BrandStage.tsx`：品牌组和 CSS 3D 朝向。
- `apps/website/components/home-experience/CursorField.tsx`：Canvas 光场与轨迹。
- `apps/website/components/home-experience/FilePreview.tsx`：跟随指针的预览层。
- `apps/website/components/home-experience/FileSwarm.tsx`：文件队列渲染和交互。
- `apps/website/components/home-experience/HomeExperience.tsx`：首页场景组合入口。
- `apps/website/components/home-experience/home-experience.module.css`：首页作用域样式。
- `apps/website/tests/progress-model.test.ts`：进度模型测试。
- `apps/website/tests/pointer-model.test.ts`：指针相关几何测试。
- `apps/website/tests/content-pool.test.ts`：内容池测试。
- `apps/website/tests/swarm-model.test.ts`：文件队列与布局测试。

### 修改文件

- `apps/website/package.json`：加入 GSAP 3.15.0。
- `pnpm-lock.yaml`：记录依赖解析结果。
- `apps/website/app/page.tsx`：切换到新首页入口。
- `apps/website/app/layout.tsx`：更新 AI Pet 元数据。
- `apps/website/app/globals.css`：收敛全局重置和页面锁定规则。
- `apps/website/tests/page.test.tsx`：改为验证新首页静态语义。
- `package.json`：让网站端到端测试使用独立 Playwright 配置。
- `tests/e2e/website.spec.ts`：覆盖开场、输入、文件预览和降级模式。
- `tests/playwright.website.config.ts`：为网站交互测试启动独立的本地 Next.js 服务。

---

### 任务 1：建立领域类型、集中配置和依赖基线

**文件：**

- 新增：`apps/website/components/home-experience/types.ts`
- 新增：`apps/website/components/home-experience/config.ts`
- 修改：`apps/website/package.json`
- 修改：`pnpm-lock.yaml`
- 新增：`apps/website/tests/progress-model.test.ts`

**接口：**

- 产出：`ExperiencePhase`、`ExperienceConfig`、`FileKind`、`PointerPoint`、`EXPERIENCE_CONFIG`。
- 依赖：无。

- [ ] **步骤 1：编写失败的配置约束测试**

```ts
import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';

describe('首页体验配置', () => {
  it('保持品牌安全区和文件数量约束', () => {
    expect(EXPERIENCE_CONFIG.swarm.maxActive).toBe(10);
    expect(EXPERIENCE_CONFIG.swarm.safeZoneRatio).toBe(0.3);
  });

  it('使用确认后的灰阶颜色', () => {
    expect(EXPERIENCE_CONFIG.colors.background).toBe('rgb(235, 235, 235)');
    expect(EXPERIENCE_CONFIG.colors.pointerField).toBe('rgb(180, 180, 180)');
  });
});
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：

```powershell
pnpm --filter @myself/website test -- progress-model.test.ts
```

预期：测试失败，错误包含 `Cannot find module '../components/home-experience/config'`。

- [ ] **步骤 3：安装并锁定 GSAP**

运行：

```powershell
pnpm --filter @myself/website add gsap@3.15.0
```

预期：`apps/website/package.json` 出现 `"gsap": "3.15.0"`，`pnpm-lock.yaml` 更新。GSAP 官方安装文档允许直接从 npm 安装，3.15.0 为计划编写时的当前 npm 版本。

- [ ] **步骤 4：实现共享类型**

```ts
export type ExperiencePhase =
  | 'loading'
  | 'drawing'
  | 'settling'
  | 'interactive'
  | 'exiting';

export type FileKind = 'txt' | 'pdf' | 'ppt' | 'xls' | 'img' | 'empty' | 'folder';

export interface PointerPoint {
  x: number;
  y: number;
}

export interface ExperienceConfig {
  colors: {
    background: string;
    pointerField: string;
  };
  intro: {
    drawSeconds: number;
    settleSeconds: number;
  };
  progress: {
    wheelScale: number;
    keyboardStep: number;
    snapThreshold: number;
  };
  swarm: {
    maxActive: number;
    safeZoneRatio: number;
    spawnIntervalMs: readonly [number, number];
    lifetimeMs: readonly [number, number];
  };
  pointer: {
    radius: number;
    trailSeconds: number;
    maxDevicePixelRatio: number;
  };
}
```

- [ ] **步骤 5：实现集中配置**

```ts
import type { ExperienceConfig } from './types';

export const EXPERIENCE_CONFIG = {
  colors: {
    background: 'rgb(235, 235, 235)',
    pointerField: 'rgb(180, 180, 180)'
  },
  intro: {
    drawSeconds: 1.4,
    settleSeconds: 0.8
  },
  progress: {
    wheelScale: 0.00065,
    keyboardStep: 0.12,
    snapThreshold: 0.06
  },
  swarm: {
    maxActive: 10,
    safeZoneRatio: 0.3,
    spawnIntervalMs: [480, 920],
    lifetimeMs: [6500, 10500]
  },
  pointer: {
    radius: 220,
    trailSeconds: 1.2,
    maxDevicePixelRatio: 1.75
  }
} as const satisfies ExperienceConfig;
```

- [ ] **步骤 6：运行配置测试、类型检查和差异检查**

运行：

```powershell
pnpm --filter @myself/website test -- progress-model.test.ts
pnpm --filter @myself/website typecheck
git diff --check
```

预期：测试和类型检查通过，`git diff --check` 无输出。

---

### 任务 2：实现统一进度、吸附和阶段状态机

**文件：**

- 新增：`apps/website/components/home-experience/progress-model.ts`
- 修改：`apps/website/tests/progress-model.test.ts`

**接口：**

- 消费：`ExperiencePhase`、`EXPERIENCE_CONFIG.progress`。
- 产出：`clampProgress(value)`、`applyProgressDelta(current, delta)`、`snapProgress(value, velocity)`、`reduceExperience(state, event)`。

- [ ] **步骤 1：扩展失败测试**

```ts
import {
  applyProgressDelta,
  reduceExperience,
  snapProgress
} from '../components/home-experience/progress-model';

it('把进度限制在零到一之间', () => {
  expect(applyProgressDelta(0.9, 0.3)).toBe(1);
  expect(applyProgressDelta(0.1, -0.3)).toBe(0);
});

it('仅在低速且接近边界时吸附', () => {
  expect(snapProgress(0.97, 0.005)).toBe(1);
  expect(snapProgress(0.8, 0.005)).toBe(0.8);
  expect(snapProgress(0.97, 0.2)).toBe(0.97);
});

it('开场输入直接进入稳定交互态', () => {
  const next = reduceExperience(
    { phase: 'drawing', progress: 0 },
    { type: 'SKIP_INTRO' }
  );
  expect(next).toEqual({ phase: 'interactive', progress: 0 });
});

it('进度进入退出区后切换到 exiting', () => {
  const next = reduceExperience(
    { phase: 'interactive', progress: 0.7 },
    { type: 'SET_PROGRESS', progress: 0.86 }
  );
  expect(next.phase).toBe('exiting');
});
```

- [ ] **步骤 2：运行测试并确认导入失败**

运行：

```powershell
pnpm --filter @myself/website test -- progress-model.test.ts
```

预期：失败原因指向尚未创建的 `progress-model.ts`。

- [ ] **步骤 3：实现纯状态模型**

```ts
import { EXPERIENCE_CONFIG } from './config';
import type { ExperiencePhase } from './types';

export interface ExperienceState {
  phase: ExperiencePhase;
  progress: number;
}

export type ExperienceEvent =
  | { type: 'ASSETS_READY' }
  | { type: 'DRAWING_DONE' }
  | { type: 'SETTLED' }
  | { type: 'SKIP_INTRO' }
  | { type: 'SET_PROGRESS'; progress: number };

export function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function applyProgressDelta(current: number, delta: number): number {
  return clampProgress(current + delta);
}

export function snapProgress(value: number, velocity: number): number {
  const threshold = EXPERIENCE_CONFIG.progress.snapThreshold;
  if (Math.abs(velocity) > 0.02) return value;
  if (value <= threshold) return 0;
  if (value >= 1 - threshold) return 1;
  return value;
}

export function reduceExperience(
  state: ExperienceState,
  event: ExperienceEvent
): ExperienceState {
  switch (event.type) {
    case 'ASSETS_READY':
      return { ...state, phase: 'drawing' };
    case 'DRAWING_DONE':
      return { ...state, phase: 'settling' };
    case 'SETTLED':
    case 'SKIP_INTRO':
      return { phase: 'interactive', progress: 0 };
    case 'SET_PROGRESS': {
      const progress = clampProgress(event.progress);
      return {
        progress,
        phase: progress >= 0.82 ? 'exiting' : 'interactive'
      };
    }
  }
}
```

- [ ] **步骤 4：运行模型测试**

运行：

```powershell
pnpm --filter @myself/website test -- progress-model.test.ts
```

预期：全部通过。

- [ ] **步骤 5：检查类型和未提交差异**

运行：

```powershell
pnpm --filter @myself/website typecheck
git diff --check
git status --short
```

预期：类型检查通过；状态中只有本计划允许的修改，不执行暂存。

---

### 任务 3：实现七类本地预览内容池

**文件：**

- 新增：`apps/website/components/home-experience/content-pool.ts`
- 新增：`apps/website/tests/content-pool.test.ts`

**接口：**

- 消费：`FileKind`。
- 产出：`PreviewContent`、`CONTENT_POOL`、`pickPreview(kind, random)`。

- [ ] **步骤 1：编写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  CONTENT_POOL,
  pickPreview
} from '../components/home-experience/content-pool';
import type { FileKind } from '../components/home-experience/types';

describe('文件预览内容池', () => {
  it('覆盖全部七种文件类型', () => {
    const kinds: FileKind[] = ['txt', 'pdf', 'ppt', 'xls', 'img', 'empty', 'folder'];
    expect(Object.keys(CONTENT_POOL).sort()).toEqual(kinds.sort());
    for (const kind of kinds) expect(CONTENT_POOL[kind].length).toBeGreaterThan(1);
  });

  it('使用传入随机源选择稳定条目', () => {
    expect(pickPreview('txt', () => 0)).toBe(CONTENT_POOL.txt[0]);
    expect(pickPreview('txt', () => 0.999)).toBe(
      CONTENT_POOL.txt[CONTENT_POOL.txt.length - 1]
    );
  });
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
pnpm --filter @myself/website test -- content-pool.test.ts
```

预期：失败原因是 `content-pool.ts` 不存在。

- [ ] **步骤 3：实现结构化内容与选择函数**

```ts
import type { FileKind } from './types';

export interface PreviewContent {
  title: string;
  meta: string;
  lines: readonly string[];
}

export const CONTENT_POOL: Record<FileKind, readonly PreviewContent[]> = {
  txt: [
    { title: '今日备忘', meta: 'TXT · 刚刚', lines: ['整理项目素材', '确认下一阶段计划'] },
    { title: '灵感片段', meta: 'TXT · 2 KB', lines: ['让文件主动说明自己。'] }
  ],
  pdf: [
    { title: '项目说明书', meta: 'PDF · 12 页', lines: ['目标、边界与验收标准'] },
    { title: '研究摘要', meta: 'PDF · 8 页', lines: ['本地优先的文件协作方式'] }
  ],
  ppt: [
    { title: '产品演示', meta: 'PPT · 16 页', lines: ['问题', '方案', '下一步'] },
    { title: '周会汇报', meta: 'PPT · 9 页', lines: ['本周进度', '风险与安排'] }
  ],
  xls: [
    { title: '任务统计', meta: 'XLS · 24 行', lines: ['已完成 18', '进行中 4'] },
    { title: '文件清单', meta: 'XLS · 7 列', lines: ['文档 12', '图片 36'] }
  ],
  img: [
    { title: '界面参考', meta: 'PNG · 1920×1080', lines: ['浅灰背景', '透明主体'] },
    { title: '产品截图', meta: 'PNG · 1.8 MB', lines: ['桌面助手运行画面'] }
  ],
  empty: [
    { title: '空文件夹', meta: '0 个项目', lines: ['这里暂时没有文件'] },
    { title: '新建目录', meta: '刚刚创建', lines: ['等待添加内容'] }
  ],
  folder: [
    { title: '项目资料', meta: '5 个项目', lines: ['需求说明.pdf', '视觉参考.png'] },
    { title: '本周工作', meta: '3 个项目', lines: ['计划.txt', '进度.xlsx'] }
  ]
};

export function pickPreview(
  kind: FileKind,
  random: () => number
): PreviewContent {
  const entries = CONTENT_POOL[kind];
  const index = Math.min(entries.length - 1, Math.floor(random() * entries.length));
  return entries[index]!;
}
```

- [ ] **步骤 4：运行内容池测试和类型检查**

运行：

```powershell
pnpm --filter @myself/website test -- content-pool.test.ts
pnpm --filter @myself/website typecheck
```

预期：全部通过。

---

### 任务 4：实现确定性文件队列、避让和生命周期

**文件：**

- 新增：`apps/website/components/home-experience/swarm-model.ts`
- 新增：`apps/website/tests/swarm-model.test.ts`

**接口：**

- 消费：`FileKind`、`PreviewContent`、`EXPERIENCE_CONFIG.swarm`、`pickPreview`。
- 产出：`FileParticle`、`createSeededRandom(seed)`、`spawnParticle(input)`、`advanceParticle(particle, deltaMs)`、`isPlacementAllowed(candidate, existing, viewport)`。

- [ ] **步骤 1：编写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  advanceParticle,
  createSeededRandom,
  isPlacementAllowed,
  spawnParticle
} from '../components/home-experience/swarm-model';

describe('文件漂浮模型', () => {
  it('固定种子产生相同序列', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it('拒绝中央品牌安全区中的位置', () => {
    expect(
      isPlacementAllowed(
        { x: 720, y: 450, width: 120, height: 120 },
        [],
        { width: 1440, height: 900, safeZoneRatio: 0.3 }
      )
    ).toBe(false);
  });

  it('悬停时冻结剩余生命周期', () => {
    const random = createSeededRandom(7);
    const particle = spawnParticle({
      id: 'file-1',
      now: 0,
      viewport: { width: 1440, height: 900, safeZoneRatio: 0.3 },
      existing: [],
      random
    });
    const frozen = advanceParticle({ ...particle, isHeld: true }, 1000);
    expect(frozen.remainingMs).toBe(particle.remainingMs);
  });
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
pnpm --filter @myself/website test -- swarm-model.test.ts
```

预期：失败原因是模型模块不存在。

- [ ] **步骤 3：实现数据结构和随机源**

```ts
import { EXPERIENCE_CONFIG } from './config';
import { pickPreview, type PreviewContent } from './content-pool';
import type { FileKind } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnViewport {
  width: number;
  height: number;
  safeZoneRatio: number;
}

export interface FileParticle extends Rect {
  id: string;
  kind: FileKind;
  preview: PreviewContent;
  rotation: number;
  scale: number;
  remainingMs: number;
  isHeld: boolean;
  phase: 'entering' | 'floating' | 'leaving';
}

export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
```

- [ ] **步骤 4：实现安全区、边界和重叠判断**

```ts
export function isPlacementAllowed(
  candidate: Rect,
  existing: readonly Rect[],
  viewport: SpawnViewport
): boolean {
  const margin = 24;
  if (
    candidate.x < margin ||
    candidate.y < margin ||
    candidate.x + candidate.width > viewport.width - margin ||
    candidate.y + candidate.height > viewport.height - margin
  ) return false;

  const safeWidth = viewport.width * viewport.safeZoneRatio;
  const safeHeight = viewport.height * viewport.safeZoneRatio;
  const safe: Rect = {
    x: (viewport.width - safeWidth) / 2,
    y: (viewport.height - safeHeight) / 2,
    width: safeWidth,
    height: safeHeight
  };

  const overlaps = (a: Rect, b: Rect, gap = 18) =>
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y;

  return !overlaps(candidate, safe, 0) && existing.every((item) => !overlaps(candidate, item));
}
```

- [ ] **步骤 5：实现生成与冻结生命周期**

生成器必须：

- 从七类文件中均匀选择类型。
- 在 24 次候选尝试内寻找有效位置。
- 无有效位置时返回 `null`，等待下一次生成周期，不强行重叠。
- 使用配置区间生成尺寸、旋转和生命周期。
- `isHeld` 为真时不减少 `remainingMs`。
- 剩余时间低于 500 毫秒时切换为 `leaving`。

核心签名：

```ts
export function spawnParticle(input: {
  id: string;
  now: number;
  viewport: SpawnViewport;
  existing: readonly Rect[];
  random: () => number;
}): FileParticle | null;

export function advanceParticle(
  particle: FileParticle,
  deltaMs: number
): FileParticle;
```

- [ ] **步骤 6：补充队列上限和恢复倒计时测试**

测试需要明确断言：

```ts
expect(particles.slice(0, EXPERIENCE_CONFIG.swarm.maxActive)).toHaveLength(10);
expect(advanceParticle({ ...particle, isHeld: false }, 1000).remainingMs)
  .toBe(particle.remainingMs - 1000);
```

- [ ] **步骤 7：运行模型测试与类型检查**

运行：

```powershell
pnpm --filter @myself/website test -- swarm-model.test.ts
pnpm --filter @myself/website typecheck
git diff --check
```

预期：全部通过。

---

### 任务 5：建立可静态渲染的首页骨架和 Logo 书写层

**文件：**

- 新增：`apps/website/components/home-experience/APDrawMark.tsx`
- 新增：`apps/website/components/home-experience/BrandStage.tsx`
- 新增：`apps/website/components/home-experience/HomeExperience.tsx`
- 新增：`apps/website/components/home-experience/home-experience.module.css`
- 修改：`apps/website/app/page.tsx`
- 修改：`apps/website/app/layout.tsx`
- 修改：`apps/website/app/globals.css`
- 修改：`apps/website/tests/page.test.tsx`

**接口：**

- 消费：`ExperiencePhase`、`PointerPoint`。
- 产出：静态可见的 `<h1>AI Pet</h1>`、`data-testid="home-experience"`、`data-phase`、Logo 描边路径引用。

- [ ] **步骤 1：先把页面测试改为新语义并确认失败**

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('AI Pet 官网首页', () => {
  it('在静态 HTML 中保留品牌和基础语义', () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain('<h1');
    expect(html).toContain('AI Pet');
    expect(html).toContain('data-testid="home-experience"');
    expect(html).toContain('src="/AP.png"');
  });

  it('不再渲染旧的传统纵向首页入口', () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).not.toContain('id="features"');
    expect(html).not.toContain('id="download"');
  });
});
```

- [ ] **步骤 2：运行测试并确认旧页面导致失败**

运行：

```powershell
pnpm --filter @myself/website test -- page.test.tsx
```

预期：新品牌断言失败，证明测试先于实现。

- [ ] **步骤 3：实现 Logo 描边遮罩**

`APDrawMark.tsx` 使用与原图一致的 `1536 1024` 视图框。三条粗描边按以下路径覆盖原图主体：

```tsx
const DRAW_PATHS = [
  'M586 91 L531 412 L935 257 L600 92 L713 292 L531 412',
  'M626 288 L493 655 L559 655 L625 370',
  'M680 374 L821 655 L939 655 L743 355'
] as const;
```

组件结构：

```tsx
export function APDrawMark() {
  return (
    <svg
      className="ap-draw-mark"
      viewBox="0 0 1536 1024"
      aria-hidden="true"
      data-testid="ap-draw-mark"
    >
      <defs>
        <mask id="ap-writing-mask">
          {DRAW_PATHS.map((path) => (
            <path
              key={path}
              className="ap-draw-path"
              d={path}
              fill="none"
              stroke="white"
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
        height="1024"
        mask="url(#ap-writing-mask)"
      />
    </svg>
  );
}
```

实现时用浏览器截图核对三条路径是否完整覆盖主体；只允许调整 `DRAW_PATHS` 和 `strokeWidth`，不得改动 `AP.png`。

- [ ] **步骤 4：实现静态品牌骨架**

`BrandStage` 必须始终包含：

```tsx
<div className={styles.brandStage} data-testid="brand-stage">
  <div className={styles.brandTransform}>
    <APDrawMark />
    <img className={styles.brandImage} src="/AP.png" alt="" />
    <h1 className={styles.wordmark}>AI Pet</h1>
  </div>
</div>
```

服务端输出默认显示最终品牌。动态开场使用绝对定位的遮罩层覆盖，不得让无 JavaScript 页面永久停留在黑屏。

- [ ] **步骤 5：实现首页组合入口与页面切换**

```tsx
import { HomeExperience } from '../components/home-experience/HomeExperience';

export default function Page() {
  return <HomeExperience />;
}
```

`HomeExperience` 先提供静态骨架：

```tsx
'use client';

export function HomeExperience() {
  return (
    <main
      className={styles.experience}
      data-testid="home-experience"
      data-phase="loading"
    >
      <BrandStage pointer={{ x: 0, y: 0 }} interactive={false} />
      <div className={styles.chapterPlaceholder} aria-hidden="true" />
    </main>
  );
}
```

- [ ] **步骤 6：收敛全局样式和更新元数据**

`globals.css` 只保留盒模型、字体、页面尺寸、背景和减少动态效果的全局规则。新视觉样式全部进入 CSS Module。`layout.tsx` 元数据改为：

```ts
export const metadata: Metadata = {
  title: 'AI Pet',
  description: 'AI Pet 是一款面向桌面文件工作的 AI 助手。'
};
```

- [ ] **步骤 7：运行页面测试、类型检查和构建**

运行：

```powershell
pnpm --filter @myself/website test -- page.test.tsx
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
```

预期：全部通过；静态导出生成 `apps/website/out/index.html`。

---

### 任务 6：实现输入适配器、统一控制器和 GSAP 开场

**文件：**

- 新增：`apps/website/components/home-experience/use-experience-controller.ts`
- 新增：`apps/website/components/home-experience/use-intro-timeline.ts`
- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/home-experience/home-experience.module.css`

**接口：**

- 消费：`reduceExperience`、`applyProgressDelta`、`snapProgress`、`EXPERIENCE_CONFIG`。
- 产出：`ExperienceControllerResult`，包含 `phase`、`progress`、`pointer`、`isPaused`、`skipIntro()` 和 DOM 引用。

- [ ] **步骤 1：为输入换算补充纯逻辑测试**

```ts
it('滚轮增量按配置缩放', () => {
  expect(applyProgressDelta(0.2, 100 * 0.00065)).toBeCloseTo(0.265);
});

it('键盘步长不会越过边界', () => {
  expect(applyProgressDelta(0.95, 0.12)).toBe(1);
  expect(applyProgressDelta(0.05, -0.12)).toBe(0);
});
```

- [ ] **步骤 2：运行测试并确认通过后再接入浏览器事件**

运行：

```powershell
pnpm --filter @myself/website test -- progress-model.test.ts
```

预期：通过，说明事件适配使用的底层换算已固定。

- [ ] **步骤 3：实现 `useExperienceController`**

Hook 必须：

- 使用 `wheel` 监听器且设置 `{ passive: false }`，只在首页体验激活时阻止传统滚动。
- `drawing` 或 `settling` 阶段收到滚轮、方向键或点击时调用 `skipIntro()`。
- `interactive` 和 `exiting` 阶段只把滚轮和键盘转换为统一进度。
- 使用 `requestAnimationFrame` 合并 `pointermove` 更新。
- `visibilitychange` 或窗口失焦时设置 `isPaused`，恢复时重置上一帧时间。
- 清理全部事件监听器和待执行动画帧。

返回类型固定为：

```ts
export interface ExperienceControllerResult {
  phase: ExperiencePhase;
  progress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  skipIntro: () => void;
}
```

- [ ] **步骤 4：实现 `useIntroTimeline`**

Hook 接收品牌、描边、背景覆盖层和字标引用。使用 `gsap.context()` 限定清理范围：

```ts
const timeline = gsap.timeline({
  paused: true,
  onComplete: onSettled
});

timeline
  .set(drawPaths, { strokeDasharray: 1, strokeDashoffset: 1 })
  .to(drawPaths, {
    strokeDashoffset: 0,
    duration: EXPERIENCE_CONFIG.intro.drawSeconds,
    stagger: 0.12,
    ease: 'power1.inOut'
  })
  .to(brand, { scale: 1.08, duration: 0.18, ease: 'power2.out' })
  .to(brand, { scale: 0.72, duration: 0.62, ease: 'back.out(1.8)' })
  .to(overlay, { backgroundColor: EXPERIENCE_CONFIG.colors.background, duration: 0.8 }, '<')
  .fromTo(wordmark, { opacity: 0, letterSpacing: '0.28em' }, {
    opacity: 1,
    letterSpacing: '0em',
    duration: 0.6
  }, '<0.15');
```

`skipIntro()` 必须调用 `timeline.progress(1).kill()`，再由控制器把所有属性设置为稳定状态。初始化捕获异常时隐藏开场覆盖层并进入 `interactive`。

- [ ] **步骤 5：接入阶段属性和分层离场**

`HomeExperience` 根节点持续输出 `data-phase` 与四位小数的 `data-progress`。通过 GSAP `quickTo` 或 CSS 自定义属性把进度映射为：

- 品牌缩放：`1 → 0.58`。
- 品牌透明度：`1 → 0`。
- 文件层缩放：`1 → 0.72`。
- 光场透明度：`1 → 0`。
- 占位章节透明度：`0 → 1`。

只在进度 `0.62` 后开始首页明显退场，避免用户轻微滚轮就破坏首屏。

- [ ] **步骤 6：实现减少动态效果分支**

使用 `window.matchMedia('(prefers-reduced-motion: reduce)')`。命中时不创建书写、弹性和 3D 时间轴，直接进入稳定首页；章节变化只使用不超过 120 毫秒的淡入淡出。

- [ ] **步骤 7：运行全量网站单元测试和构建**

运行：

```powershell
pnpm --filter @myself/website test
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
```

预期：全部通过。

---

### 任务 7：实现品牌朝向和 Canvas 鼠标光场

**文件：**

- 新增：`apps/website/components/home-experience/pointer-model.ts`
- 新增：`apps/website/tests/pointer-model.test.ts`
- 修改：`apps/website/components/home-experience/BrandStage.tsx`
- 新增：`apps/website/components/home-experience/CursorField.tsx`
- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/home-experience/home-experience.module.css`

**接口：**

- 消费：`PointerPoint`、`isPaused`、`progress`、`prefersReducedMotion`。
- 产出：`computeBrandTransform()`、`computePreviewPosition()`、`trailAlpha()`、`data-testid="cursor-field"` Canvas 和受限的品牌 3D 变换。

- [ ] **步骤 1：编写指针几何失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  computeBrandTransform,
  computePreviewPosition,
  trailAlpha
} from '../components/home-experience/pointer-model';

describe('指针几何模型', () => {
  it('把品牌旋转限制在确认幅度内', () => {
    expect(computeBrandTransform(
      { x: 1440, y: 0 },
      { width: 1440, height: 900 }
    )).toEqual({ rotateX: 4, rotateY: 5, x: 6, y: -4 });
  });

  it('在右下边缘把预览翻转到指针左上方', () => {
    expect(computePreviewPosition({
      pointer: { x: 1400, y: 860 },
      preview: { width: 260, height: 180 },
      viewport: { width: 1440, height: 900 },
      gap: 18
    })).toEqual({ x: 1122, y: 662 });
  });

  it('轨迹透明度随时间单调衰减', () => {
    expect(trailAlpha(0, 1200)).toBe(1);
    expect(trailAlpha(600, 1200)).toBe(0.5);
    expect(trailAlpha(1200, 1200)).toBe(0);
  });
});
```

- [ ] **步骤 2：运行测试并确认模块不存在**

运行：

```powershell
pnpm --filter @myself/website test -- pointer-model.test.ts
```

预期：失败原因是 `pointer-model.ts` 不存在。

- [ ] **步骤 3：实现纯指针几何函数**

```ts
import type { PointerPoint } from './types';

interface Size {
  width: number;
  height: number;
}

export function computeBrandTransform(pointer: PointerPoint, viewport: Size) {
  const normalizedX = Math.max(-1, Math.min(1, pointer.x / viewport.width * 2 - 1));
  const normalizedY = Math.max(-1, Math.min(1, pointer.y / viewport.height * 2 - 1));
  return {
    rotateX: normalizedY * -4,
    rotateY: normalizedX * 5,
    x: normalizedX * 6,
    y: normalizedY * 4
  };
}

export function computePreviewPosition(input: {
  pointer: PointerPoint;
  preview: Size;
  viewport: Size;
  gap: number;
}): PointerPoint {
  const { pointer, preview, viewport, gap } = input;
  return {
    x: pointer.x + gap + preview.width <= viewport.width
      ? pointer.x + gap
      : pointer.x - gap - preview.width,
    y: pointer.y + gap + preview.height <= viewport.height
      ? pointer.y + gap
      : pointer.y - gap - preview.height
  };
}

export function trailAlpha(ageMs: number, lifetimeMs: number): number {
  return Math.max(0, Math.min(1, 1 - ageMs / lifetimeMs));
}
```

- [ ] **步骤 4：实现品牌朝向**

将鼠标相对视口中心的位置归一化到 `[-1, 1]`，限制旋转幅度：

```ts
const rotateY = normalizedX * 5;
const rotateX = normalizedY * -4;
const translateX = normalizedX * 6;
const translateY = normalizedY * 4;
```

通过 CSS 变量写入 `transform`：

```css
.brandTransform {
  transform:
    perspective(900px)
    translate3d(var(--brand-x), var(--brand-y), 0)
    rotateX(var(--brand-rotate-x))
    rotateY(var(--brand-rotate-y));
  transform-style: preserve-3d;
  will-change: transform;
}
```

减少动态效果或非交互阶段时全部变量回到零。

- [ ] **步骤 5：实现 Canvas 光场**

`CursorField` 必须：

- 按 CSS 尺寸和 `min(devicePixelRatio, 1.75)` 设置画布。
- 维护最多 18 个轨迹采样点。
- 每帧根据时间衰减样本透明度。
- 使用径向渐变绘制 `rgb(180, 180, 180)` 到透明。
- 页面暂停、减少动态效果或进度进入完全退场时停止绘制并清空。
- ResizeObserver 只更新尺寸缓存，不在绘制循环中读取布局。

核心绘制形式：

```ts
const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
gradient.addColorStop(0, 'rgba(180, 180, 180, 0.72)');
gradient.addColorStop(0.55, 'rgba(180, 180, 180, 0.34)');
gradient.addColorStop(1, 'rgba(180, 180, 180, 0)');
context.fillStyle = gradient;
context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
```

- [ ] **步骤 6：运行指针测试、类型检查、构建和差异检查**

运行：

```powershell
pnpm --filter @myself/website test -- pointer-model.test.ts
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
git diff --check
```

预期：全部通过。

---

### 任务 8：实现文件队列、悬浮动画和跟随鼠标预览

**文件：**

- 新增：`apps/website/components/home-experience/FilePreview.tsx`
- 新增：`apps/website/components/home-experience/FileSwarm.tsx`
- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/home-experience/home-experience.module.css`
- 修改：`apps/website/tests/swarm-model.test.ts`

**接口：**

- 消费：`FileParticle`、`spawnParticle`、`advanceParticle`、`PointerPoint`、`isPaused`。
- 产出：最多 10 个可聚焦文件按钮、单一跟随鼠标预览层、`data-active-count`。

- [ ] **步骤 1：补充模型测试，确认空位不足时不强制生成**

```ts
it('找不到安全位置时返回 null', () => {
  const random = () => 0.5;
  const result = spawnParticle({
    id: 'blocked',
    now: 0,
    viewport: { width: 320, height: 240, safeZoneRatio: 0.3 },
    existing: [{ x: 0, y: 0, width: 320, height: 240 }],
    random
  });
  expect(result).toBeNull();
});
```

- [ ] **步骤 2：运行模型测试**

运行：

```powershell
pnpm --filter @myself/website test -- swarm-model.test.ts
```

预期：通过；若失败，修正模型而不是在组件内绕过约束。

- [ ] **步骤 3：实现文件素材映射**

```ts
export const FILE_ASSETS: Record<FileKind, string> = {
  txt: '/TxtIcon.png',
  pdf: '/PDFIcon.png',
  ppt: '/PPTIcon.png',
  xls: '/XLSIcon.png',
  img: '/IMGIcon.png',
  empty: '/empty.png',
  folder: '/Noempty.png'
};
```

- [ ] **步骤 4：实现 `FileSwarm` 调度**

组件规则：

- 只在 `interactive` 阶段开始生成。
- 使用 `crypto.getRandomValues()` 生成会话种子；测试通过 URL 参数 `?seed=42` 固定种子。
- 生成间隔取 `480–920` 毫秒。
- 每帧推进现有粒子，移除生命周期结束且未被保持的粒子。
- 使用 `button type="button"` 承载图标，提供可见焦点样式和 `aria-label`。
- `pointerenter`、`focus` 设置 `isHeld=true` 并激活预览。
- `pointerleave`、`blur` 设置 `isHeld=false` 并关闭预览。
- 图片 `onError` 把对应类型加入当前会话的禁用集合。

图标动画只通过 CSS 变量控制 `translate3d`、`rotate`、`scale` 和 `opacity`。

- [ ] **步骤 5：实现单一 `FilePreview`**

预览不得为每个图标重复创建。它接收当前粒子和目标指针坐标，使用 GSAP `quickTo` 实现阻尼：

```ts
const xTo = gsap.quickTo(element, 'x', { duration: 0.18, ease: 'power2.out' });
const yTo = gsap.quickTo(element, 'y', { duration: 0.18, ease: 'power2.out' });
```

定位调用任务 7 已测试的 `computePreviewPosition()`，固定预留 18 像素间距，并在右侧或底部空间不足时换边。

键盘聚焦时没有持续指针坐标，预览改为锚定到图标边界右侧，并使用同样的边缘翻转规则。

- [ ] **步骤 6：实现分类型预览布局**

- TXT、PDF、PPT、IMG：标题、元信息和文本行。
- XLS：文本行使用两列微型数据表视觉。
- 空文件夹：显示空状态，不显示伪造文件。
- 非空文件夹：将文本行显示为紧凑文件清单。

预览使用 `role="status"` 和 `aria-live="polite"`，但不得抢夺焦点。

- [ ] **步骤 7：运行网站测试、类型检查和构建**

运行：

```powershell
pnpm --filter @myself/website test
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
```

预期：全部通过。

---

### 任务 9：完成视觉层级、窄屏边界和异常降级

**文件：**

- 修改：`apps/website/components/home-experience/HomeExperience.tsx`
- 修改：`apps/website/components/home-experience/home-experience.module.css`
- 修改：`apps/website/app/globals.css`

**接口：**

- 消费：所有首页组件。
- 产出：确定的层级、桌面布局、窄屏防崩溃和初始化失败回退。

- [ ] **步骤 1：固定层级和稳定尺寸**

使用以下层级，不允许组件自行增加无约束的 `z-index`：

```css
.experience { position: fixed; inset: 0; overflow: hidden; }
.chapterPlaceholder { z-index: 0; }
.cursorLayer { z-index: 1; }
.fileLayer { z-index: 2; }
.brandStage { z-index: 3; }
.previewLayer { z-index: 4; }
.introOverlay { z-index: 5; }
```

品牌组使用 `clamp()` 限制物理尺寸，但字体大小不得随视口宽度连续缩放。使用离散媒体查询设置字号，保持字距为 `0`。

- [ ] **步骤 2：实现窄屏非阻塞回退**

在 `max-width: 760px` 下：

- 保留静态品牌和最多 4 个文件图标。
- 禁止锁定滚轮，页面允许正常浏览。
- 隐藏 Canvas 轨迹和 3D 倾斜。
- 预览宽度限制为 `min(280px, calc(100vw - 24px))`。
- 不实现触摸专属交互。

- [ ] **步骤 3：实现初始化和素材异常回退**

`HomeExperience` 的增强初始化包在 `try/catch` 中。失败时：

- 设置 `data-phase="interactive"`。
- 隐藏 `introOverlay`。
- 显示静态 `AP.png` 与 “AI Pet”。
- 不启动文件队列和 Canvas。

Logo 描边图片加载失败时只隐藏 `APDrawMark`，保留最终 Logo。文件素材失败由 `FileSwarm` 排除对应类型。

- [ ] **步骤 4：手动检查所有 CSS 颜色和文本容器**

运行：

```powershell
rg -n "#[0-9a-fA-F]{3,8}|rgb\\(" apps/website/app/globals.css apps/website/components/home-experience/home-experience.module.css
```

预期：整体保持黑、白和中性灰阶；没有大面积紫色、深蓝、米色或橙棕色主题。检查按钮、图标和预览文本在 `1440×900` 与 `1920×1080` 下均不溢出。

- [ ] **步骤 5：运行构建验证**

运行：

```powershell
pnpm --filter @myself/website test
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
git diff --check
```

预期：全部通过。

---

### 任务 10：建立真实浏览器验收和最终验证

**文件：**

- 修改：`package.json`
- 新增：`tests/playwright.website.config.ts`
- 修改：`tests/e2e/website.spec.ts`

**接口：**

- 消费：页面上的稳定测试标识和状态属性。
- 产出：桌面、减少动态效果、窄屏和交互端到端验证。

- [ ] **步骤 1：配置网站测试服务**

创建独立配置，避免网站服务影响 `test:e2e:desktop`：

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'website.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '.playwright-output',
webServer: {
  command: 'pnpm --filter @myself/website dev --hostname 127.0.0.1 --port 4173',
  url: 'http://127.0.0.1:4173',
  reuseExistingServer: !process.env.CI,
  timeout: 120_000
},
use: {
  baseURL: 'http://127.0.0.1:4173',
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure'
}
});
```

把根 `package.json` 的 `test:e2e:website` 改为：

```json
"test:e2e:website": "playwright test --config tests/playwright.website.config.ts"
```

- [ ] **步骤 2：先编写开场和跳过测试**

```ts
test('开场可播放并由首次输入直接跳过', async ({ page }) => {
  await page.goto('/?seed=42');
  const experience = page.getByTestId('home-experience');
  await expect(experience).toHaveAttribute('data-phase', /drawing|settling/);
  await page.mouse.wheel(0, 120);
  await expect(experience).toHaveAttribute('data-phase', 'interactive');
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
});
```

- [ ] **步骤 3：编写滚轮离场和键盘测试**

```ts
test('滚轮和键盘推动统一章节进度', async ({ page }) => {
  await page.goto('/?seed=42');
  await page.keyboard.press('ArrowDown');
  const experience = page.getByTestId('home-experience');
  await expect(experience).toHaveAttribute('data-phase', 'interactive');
  await page.keyboard.press('PageDown');
  await expect.poll(async () =>
    Number(await experience.getAttribute('data-progress'))
  ).toBeGreaterThan(0);
});
```

- [ ] **步骤 4：编写文件队列、悬停冻结和边缘翻转测试**

```ts
test('文件预览跟随悬停并在阅读期间保持', async ({ page }) => {
  await page.goto('/?seed=42');
  await page.keyboard.press('ArrowDown');
  const icon = page.getByTestId('file-icon').first();
  await expect(icon).toBeVisible({ timeout: 5_000 });
  await icon.hover();
  const preview = page.getByTestId('file-preview');
  await expect(preview).toBeVisible();
  const contentBefore = await preview.textContent();
  await page.waitForTimeout(1_200);
  await expect(preview).toHaveText(contentBefore ?? '');
  await page.mouse.move(1, 1);
  await expect(preview).toBeHidden();
});
```

增加一个将鼠标移到右下角图标的场景，断言预览边界 `x >= 0`、`y >= 0`、`right <= viewport.width`、`bottom <= viewport.height`。

- [ ] **步骤 5：编写减少动态效果与窄屏测试**

```ts
test('减少动态效果时直接显示稳定内容', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?seed=42');
  await expect(page.getByTestId('home-experience'))
    .toHaveAttribute('data-phase', 'interactive');
  await expect(page.getByTestId('cursor-field')).toBeHidden();
});

test('窄屏不会锁死页面', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?seed=42');
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
  await expect(page.getByTestId('home-experience')).toBeVisible();
});
```

- [ ] **步骤 6：执行四种截图检查**

通过 Playwright 分别截取：

- `1440×900` 稳定首页。
- `1920×1080` 文件预览打开状态。
- `1440×900` 首页退场中段。
- `390×844` 窄屏回退。

检查 Logo 居中、中央安全区、文件不被裁切、预览不越界、下一章节只作为无内容占位背景出现。截图保存到 Playwright 临时输出目录，不加入源码目录。

- [ ] **步骤 7：检查 Canvas 像素和动态层级**

在 Playwright 中读取 Canvas 像素，移动鼠标后断言存在非透明像素，等待轨迹时长后断言非透明像素数量下降。再用 `document.elementsFromPoint()` 检查预览层位于文件图标和品牌层之上。

- [ ] **步骤 8：运行最终网站验证**

运行：

```powershell
pnpm verify:website
git diff --check
git status --short
```

预期：

- 网站类型检查通过。
- 网站 Vitest 全部通过。
- Next.js 静态导出成功。
- Playwright 全部通过。
- `git diff --check` 无输出。
- 只存在计划允许的未暂存修改；不执行提交。

## 实施完成判定

满足以下全部条件才可声明实施完成：

- 首屏从黑色 Logo 书写自动进入浅灰稳定首页。
- 首次滚轮、点击或方向键可立即跳过开场。
- Logo 朝向鼠标但幅度克制，字标稳定居中。
- Canvas 光场颜色、半径、轨迹和消散符合配置。
- 文件图标最多 10 个，避开品牌区并尽量不重叠。
- 七类本地内容池均能显示正确预览。
- 悬停或聚焦期间图标不会消失，离开后恢复生命周期。
- 跟随鼠标预览在四个视口边缘均不会越界。
- 首页由连续进度缩小淡出，不产生传统纵向滚动。
- 减少动态效果和窄屏回退可访问、无锁死。
- `pnpm verify:website`、`git diff --check` 全部通过。
- 未暂存、未提交任何文件。
