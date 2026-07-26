# AI Pet 官网剩余章节与视觉统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一五章节官网视觉层，修复图层与滚轮体验，重构下载和捐款章节，并正式交付 AI Pet 介绍与本地持久化反馈建议章节。

**Architecture:** 使用共享背景、图层令牌、鼠标倾斜标题和可配置文件粒子内容源构成统一场景基座；各章节保持独立组件和状态模型。反馈数据只通过 `FeedbackRepository` 访问，当前使用 `localStorage`，未来可替换为 API 实现。

**Tech Stack:** Next.js 15、React 19、TypeScript、CSS Modules、GSAP、Lucide React、Zod、Vitest、JSDOM、Playwright。

## Global Constraints

- 所有文档和代码注释使用中文。
- 实施代理不得执行 `git add`、`git commit`、合并、推送或其他 Git 写操作；每项任务完成后只报告变更范围，由用户自行提交。
- 不覆盖用户现有付款码资源；PayPal 必须使用主工作区现有 `apps/website/public/Paypal.jpg`。
- 六阶背景固定使用 `rgb(200)`、`rgb(205)`、`rgb(210)`、`rgb(215)`、`rgb(220)`、`rgb(225)`。
- 图层顺序固定为背景、光场、文件、功能、重点、预览、模态。
- 普通鼠标连续 3 至 5 个刻度切换一章，一次输入突发仍最多进入相邻章节。
- 桌面端 AI Pet 介绍区域只使用悬停或键盘聚焦，不提供点击锁定。
- 下载两侧说明桌面端只使用悬停或焦点；移动端允许轻触展开、点空白处关闭。
- 反馈和建议分别最多保留 1000 条，按点赞数降序、更新时间降序、稳定 ID 排序裁剪。
- 昵称最多 24 个字符；正文去除首尾空格后限制为 10 至 1000 个字符。
- 保持 `760px / 761px` 响应式断点。
- 禁止 `vw` 字号、负字距、横向页面滚动、手绘重复 SVG 和卡片嵌套卡片。
- 所有触摸目标至少 44×44 像素；模态必须具备焦点约束、Escape 关闭和焦点恢复。
- `prefers-reduced-motion`、页面失焦、隐藏标签页和静态回退时停止持续动效。

---

## 文件结构

### 新增共享视觉文件

- `apps/website/components/website-experience/visual/ChapterBackdrop.tsx`：六阶放射背景。
- `apps/website/components/website-experience/visual/chapter-backdrop.module.css`：章节背景面片和分章变体。
- `apps/website/components/website-experience/visual/PointerTiltText.tsx`：标题倾斜容器。
- `apps/website/components/website-experience/visual/pointer-tilt-model.ts`：纯函数倾斜计算。
- `apps/website/components/website-experience/layer-contract.ts`：共享图层常量。

### 新增 AI Pet 介绍文件

- `apps/website/components/website-experience/about/about-content.ts`：五区文案、图标和层级配置。
- `apps/website/components/website-experience/about/about-model.ts`：活动区、移动锁定和安全区状态。
- `apps/website/components/website-experience/about/AboutChapter.tsx`：章节编排。
- `apps/website/components/website-experience/about/AboutFeaturePanel.tsx`：单个功能示意区域。
- `apps/website/components/website-experience/about/AboutFeaturePreview.tsx`：跟随鼠标的说明预览。
- `apps/website/components/website-experience/about/about.module.css`：非对称布局和动效。

### 新增反馈建议文件

- `apps/website/components/website-experience/feedback/feedback-types.ts`：领域类型与仓储接口。
- `apps/website/components/website-experience/feedback/feedback-content.ts`：官方示例与主场景文案。
- `apps/website/components/website-experience/feedback/feedback-model.ts`：排序、裁剪、验证和随机绑定纯函数。
- `apps/website/components/website-experience/feedback/local-storage-feedback-repository.ts`：本地仓储实现。
- `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`：反馈主场景和三项滚筒。
- `apps/website/components/website-experience/feedback/FeedbackListDialog.tsx`：反馈或建议查看层。
- `apps/website/components/website-experience/feedback/FeedbackComposerDialog.tsx`：投稿编辑器。
- `apps/website/components/website-experience/feedback/DiscardDraftDialog.tsx`：放弃草稿确认。
- `apps/website/components/website-experience/feedback/feedback.module.css`：主场景、列表和编辑器样式。

### 修改现有文件

- `apps/website/components/website-experience/WebsiteExperience.tsx`
- `apps/website/components/website-experience/chapter-registry.tsx`
- `apps/website/components/website-experience/SharedVisualLayers.tsx`
- `apps/website/components/website-experience/shared-visual-model.ts`
- `apps/website/components/website-experience/types.ts`
- `apps/website/components/website-experience/use-website-controller.ts`
- `apps/website/components/website-experience/website-experience.module.css`
- `apps/website/components/home-experience/BrandStage.tsx`
- `apps/website/components/home-experience/FileSwarm.tsx`
- `apps/website/components/home-experience/FilePreview.tsx`
- `apps/website/components/home-experience/home-experience.module.css`
- `apps/website/components/website-experience/download/DownloadChapter.tsx`
- `apps/website/components/website-experience/download/download.module.css`
- `apps/website/components/website-experience/donation/donation-content.ts`
- `apps/website/components/website-experience/donation/DonationChapter.tsx`
- `apps/website/components/website-experience/donation/donation.module.css`
- `tests/e2e/website.spec.ts`

---

### Task 1：建立共享图层、背景和标题倾斜原语

**Files:**
- Create: `apps/website/components/website-experience/layer-contract.ts`
- Create: `apps/website/components/website-experience/visual/ChapterBackdrop.tsx`
- Create: `apps/website/components/website-experience/visual/chapter-backdrop.module.css`
- Create: `apps/website/components/website-experience/visual/PointerTiltText.tsx`
- Create: `apps/website/components/website-experience/visual/pointer-tilt-model.ts`
- Create: `apps/website/tests/chapter-visual-primitives.test.tsx`
- Modify: `apps/website/components/website-experience/website-experience.module.css`

**Interfaces:**
- Produces: `CHAPTER_LAYERS`。
- Produces: `ChapterBackdrop({ chapterId })`。
- Produces: `computePointerTilt(pointer, viewport, maxDegrees)`。
- Produces: `PointerTiltText({ pointer, viewport, disabled, children, className })`。

- [ ] **Step 1: 编写视觉原语失败测试**

```tsx
expect(CHAPTER_LAYERS).toEqual({
  backdrop: 0,
  field: 10,
  files: 20,
  feature: 40,
  focal: 60,
  preview: 80,
  modal: 100
});
expect(computePointerTilt(
  { x: 1440, y: 0 },
  { width: 1440, height: 900 },
  5
)).toEqual({ rotateX: 5, rotateY: 5 });
```

静态标记必须包含六个面片和当前章节 ID。

- [ ] **Step 2: 运行测试并确认模块不存在**

Run:

```powershell
apps\website\node_modules\.bin\vitest.CMD run --config apps/website/vitest.config.ts apps/website/tests/chapter-visual-primitives.test.tsx
```

Expected: FAIL，无法解析共享视觉模块。

- [ ] **Step 3: 实现共享接口**

```ts
export const CHAPTER_LAYERS = {
  backdrop: 0,
  field: 10,
  files: 20,
  feature: 40,
  focal: 60,
  preview: 80,
  modal: 100
} as const;

export function computePointerTilt(
  pointer: PointerPoint,
  viewport: ViewportSize,
  maxDegrees = 5
): { rotateX: number; rotateY: number };
```

背景根节点使用：

```tsx
<div
  className={styles.backdrop}
  data-testid="chapter-backdrop"
  data-chapter-id={chapterId}
  aria-hidden="true"
>
  {BACKDROP_TONES.map((tone) => (
    <span key={tone} style={{ '--backdrop-tone': tone } as CSSProperties} />
  ))}
</div>
```

- [ ] **Step 4: 完成 CSS 契约**

六个面片只使用规格中的六个 RGB 值。不同章节通过 `data-chapter-id` 调整 `clip-path`、旋转和 `transform-origin`，不得改变色表。

- [ ] **Step 5: 运行聚焦测试和类型检查**

Run:

```powershell
apps\website\node_modules\.bin\vitest.CMD run --config apps/website/vitest.config.ts apps/website/tests/chapter-visual-primitives.test.tsx
apps\website\node_modules\.bin\tsc.CMD --noEmit -p apps/website/tsconfig.json
```

Expected: PASS。

- [ ] **Step 6: 用户 Git 检查点**

报告新增文件和验证结果。实施代理停止，等待用户自行提交；不得执行 Git 写操作。

---

### Task 2：统一官网图层并扩展共享文件内容源

**Files:**
- Modify: `apps/website/components/website-experience/WebsiteExperience.tsx`
- Modify: `apps/website/components/website-experience/SharedVisualLayers.tsx`
- Modify: `apps/website/components/website-experience/shared-visual-model.ts`
- Modify: `apps/website/components/home-experience/BrandStage.tsx`
- Modify: `apps/website/components/home-experience/FileSwarm.tsx`
- Modify: `apps/website/components/home-experience/FilePreview.tsx`
- Modify: `apps/website/components/home-experience/home-experience.module.css`
- Create: `apps/website/tests/shared-layer-contract.test.tsx`

**Interfaces:**
- Consumes: `CHAPTER_LAYERS`、`ChapterBackdrop`。
- Produces: `FilePreviewContentSource`。
- Produces: `SharedVisualProfile.previewSource` 和 `SharedVisualProfile.fieldEnabled`。

- [ ] **Step 1: 编写失败测试**

```ts
export interface FilePreviewContentSource {
  getPreview(particle: FileParticle): readonly string[];
}
```

测试首页 Logo、章节重点层、文件层和预览层的 z-index 顺序，并验证重点层 `pointer-events` 不被文件层截获。

- [ ] **Step 2: 运行测试确认现有层级不满足契约**

Run:

```powershell
apps\website\node_modules\.bin\vitest.CMD run --config apps/website/vitest.config.ts apps/website/tests/shared-layer-contract.test.tsx
```

Expected: FAIL，缺少内容源与图层令牌。

- [ ] **Step 3: 实现配置化共享视觉**

```ts
export interface SharedVisualProfile {
  id: string;
  maxActive: number;
  safeZoneRatio: number;
  fieldEnabled: boolean;
  fieldColor: RgbColor;
  previewSource: FilePreviewContentSource;
}
```

首页、下载和捐款使用现有文件内容源；反馈章节在 Task 8 注入反馈内容源；介绍章节关闭共享文件层。

- [ ] **Step 4: 应用统一图层**

`BrandStage`、所有章节标题和主要操作放入 focal 层。文件层保留粒子自身命中，但不得覆盖 focal/feature 元素；预览 Portal 保持在 preview 层。

- [ ] **Step 5: 验证**

运行共享层测试、首页现有测试、TypeScript。

- [ ] **Step 6: 用户 Git 检查点**

报告文件和测试；等待用户自行提交。

---

### Task 3：提高章节滚轮灵敏度并保持吸附安全

**Files:**
- Modify: `apps/website/components/website-experience/use-website-controller.ts`
- Modify: `apps/website/components/home-experience/config.ts`
- Modify: `apps/website/tests/website-controller.test.tsx`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Produces: `WHEEL_PROGRESS_PER_DELTA` 或等价配置，使 `3–5 × deltaY=120` 达到相邻章节阈值。
- 保持: `scheduleWheelSnap()` 和边界恢复语义。

- [ ] **Step 1: 编写真实刻度失败测试**

```ts
for (let index = 0; index < 4; index += 1) {
  fireWheel(120);
  advanceTimersByTime(70);
}
advanceTimersByTime(WHEEL_SNAP_DELAY_MS + 400);
expect(activeChapter()).toBe('about');
```

同时保留：

```ts
fireWheel(24);
advanceUntilSettled();
expect(activeChapter()).toBe('home');
```

- [ ] **Step 2: 运行测试确认当前灵敏度不足**

运行控制器聚焦测试，预期普通刻度用例失败。

- [ ] **Step 3: 调整纯配置与吸附**

只调整归一化比例、阈值或突发累计策略，不允许直接按滚轮事件次数跳章。

- [ ] **Step 4: 增加浏览器回归**

Playwright 使用 4 次 `mouse.wheel(0, 120)`，每次间隔 70ms，断言最终进入 `about`；单次巨大输入仍只进入相邻章。

- [ ] **Step 5: 验证并交给用户提交**

运行控制器测试、相关 E2E、TypeScript；报告结果后停止。

---

### Task 4：重构下载章节视觉和仅悬停侧栏

**Files:**
- Modify: `apps/website/components/website-experience/download/DownloadChapter.tsx`
- Modify: `apps/website/components/website-experience/download/download-model.ts`
- Modify: `apps/website/components/website-experience/download/download.module.css`
- Modify: `apps/website/tests/download-model.test.ts`
- Modify: `apps/website/tests/download-chapter.test.tsx`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: `ChapterBackdrop`、`PointerTiltText`、共享文件 profile。
- Produces: 桌面 `hover/focus` 临时侧栏状态。
- 保持: 平台滚筒、Windows 真实链接、macOS 禁用。

- [ ] **Step 1: 编写新行为失败测试**

测试：

- 根节点不再含青蓝渐变标记。
- 桌面侧栏触发器没有 `aria-pressed` 和点击锁定。
- pointer enter/focus 展开，pointer leave/blur 关闭。
- 移动模式点击展开、点空白关闭。
- 两行标题使用倾斜容器。

- [ ] **Step 2: 运行测试确认旧点击锁定行为失败**

- [ ] **Step 3: 精简下载状态模型**

桌面事件只保留 preview holds；移动状态单独使用：

```ts
export type DownloadSideMode =
  | { kind: 'desktop-preview'; side: VisibleDownloadSide | null }
  | { kind: 'mobile-open'; side: VisibleDownloadSide | null };
```

- [ ] **Step 4: 重做视觉**

移除青蓝背景、可见箭头和点击锁定样式。边缘感应区提供弱提示线或文字，不形成传统按钮。平台内容和标题位于 focal 层，文件粒子在其后。

- [ ] **Step 5: 保留下载导航行为**

Windows 链接保持普通 `href`，不得增加 `download` 属性；macOS 不得生成链接。

- [ ] **Step 6: 验证并交给用户提交**

运行下载模型、组件、页面和 E2E 测试。

---

### Task 5：扩展 PayPal 并重构捐款背景

**Files:**
- Modify: `apps/website/components/website-experience/donation/donation-content.ts`
- Modify: `apps/website/components/website-experience/donation/DonationChapter.tsx`
- Modify: `apps/website/components/website-experience/donation/donation.module.css`
- Modify: `apps/website/tests/payment-model.test.ts`
- Modify: `apps/website/tests/donation-chapter.test.tsx`
- Modify: `tests/e2e/website.spec.ts`
- Ensure: `apps/website/public/Paypal.jpg`

**Interfaces:**
- Consumes: `PointerTiltText`、`ChapterBackdrop`。
- Produces: 三项 `PAYMENT_METHODS`。

- [ ] **Step 1: 将现有 PayPal 资源带入开发工作树**

若当前工作树缺少该文件，从主工作区复制用户已有文件：

```powershell
Copy-Item -LiteralPath 'D:\Python\Important\myself\apps\website\public\Paypal.jpg' `
  -Destination 'apps\website\public\Paypal.jpg'
```

复制后比较 SHA-256，必须完全一致。

- [ ] **Step 2: 编写三支付失败测试**

```ts
expect(PAYMENT_METHODS.map((item) => item.id))
  .toEqual(['wechat', 'alipay', 'paypal']);
expect(PAYMENT_METHODS.find((item) => item.id === 'paypal')?.qrImagePath)
  .toBe('/Paypal.jpg');
```

- [ ] **Step 3: 实现配置并移除黄色光场**

捐款 profile 设置 `fieldEnabled: false`，保留文件粒子。标题改用 `PointerTiltText`。

- [ ] **Step 4: 浏览器验证**

滚动到 PayPal，点击当前项，断言图片 `naturalWidth > 0`、`object-fit: contain`、Escape 关闭并恢复焦点。

- [ ] **Step 5: 验证并交给用户提交**

运行支付模型、捐款组件、页面和支付 E2E。

---

### Task 6：建立 AI Pet 介绍内容和状态模型

**Files:**
- Create: `apps/website/components/website-experience/about/about-content.ts`
- Create: `apps/website/components/website-experience/about/about-model.ts`
- Create: `apps/website/tests/about-model.test.ts`

**Interfaces:**
- Produces: `AboutFeature`、`ABOUT_FEATURES`。
- Produces: `reduceAboutInteraction()`、`isInsideAboutSafeZone()`。

- [ ] **Step 1: 编写模型失败测试**

```ts
expect(ABOUT_FEATURES.map((item) => item.id)).toEqual([
  'security',
  'file-management',
  'text-editor',
  'companion-chat',
  'desktop-organizer'
]);
```

测试桌面 hover 离开即恢复、桌面 click 不锁定、移动 tap 锁定、空白复位和中央安全区。

- [ ] **Step 2: 运行测试确认模块不存在**

- [ ] **Step 3: 实现内容类型**

```ts
export interface AboutFeature {
  id: AboutFeatureId;
  title: string;
  eyebrow: string;
  summary: string;
  details: readonly string[];
  layer: number;
  entryOrder: number;
  icon: LucideIcon;
  illustration: AboutIllustrationKind;
}
```

- [ ] **Step 4: 实现纯状态模型**

```ts
export interface AboutInteractionState {
  hoveredId: AboutFeatureId | null;
  focusedId: AboutFeatureId | null;
  mobileLockedId: AboutFeatureId | null;
}
```

可见活动项按移动锁定、焦点、悬停顺序派生；桌面 click 事件不得进入 reducer。

- [ ] **Step 5: 验证并交给用户提交**

---

### Task 7：实现 AI Pet 介绍视觉与交互

**Files:**
- Create: `apps/website/components/website-experience/about/AboutChapter.tsx`
- Create: `apps/website/components/website-experience/about/AboutFeaturePanel.tsx`
- Create: `apps/website/components/website-experience/about/AboutFeaturePreview.tsx`
- Create: `apps/website/components/website-experience/about/about.module.css`
- Create: `apps/website/tests/about-chapter.test.tsx`
- Modify: `apps/website/components/website-experience/chapter-registry.tsx`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: Task 6 内容和状态模型。
- Produces: `[data-testid="about-chapter"]`。

- [ ] **Step 1: 编写静态与交互失败测试**

测试五个功能区、中央标题、安全区、进入序号、桌面 hover/focus、移动锁定和预览 Portal。

- [ ] **Step 2: 运行测试确认正式组件不存在**

- [ ] **Step 3: 实现五种示意面板**

每种 illustration 使用独立小组件或分支：

```tsx
switch (feature.illustration) {
  case 'security': return <SecurityMockup />;
  case 'file-management': return <FileManagerMockup />;
  case 'text-editor': return <TextEditorMockup />;
  case 'companion-chat': return <CompanionChatMockup />;
  case 'desktop-organizer': return <DesktopOrganizerMockup />;
}
```

使用 Lucide 图标和现有文件图标，不嵌入参考截图。

- [ ] **Step 4: 实现入场时间线**

使用根节点作用域 `gsap.context()`：

```ts
timeline.fromTo(
  '[data-about-feature]',
  { autoAlpha: 0, scale: 1.16 },
  { autoAlpha: 1, scale: 1, duration: 0.48, stagger: 0.09, ease: 'power3.out' }
);
```

清理调用 `context.revert()`；异常进入统一回退。减少动态效果不创建时间线。

- [ ] **Step 5: 实现悬停置顶和预览**

活动功能区使用 feature 层内最高 z-index，其他区域模糊。预览使用现有 `computePreviewPosition()`，中央安全区不触发面板。

- [ ] **Step 6: 注册章节并完成响应式**

用 `AboutChapter` 替换 `about` 占位。移动端把五区压缩为可读的重叠列阵，轻触锁定。

- [ ] **Step 7: 验证并交给用户提交**

运行 about 模型、组件、页面、类型和相关 E2E。

---

### Task 8：建立反馈领域模型与本地仓储

**Files:**
- Create: `apps/website/components/website-experience/feedback/feedback-types.ts`
- Create: `apps/website/components/website-experience/feedback/feedback-content.ts`
- Create: `apps/website/components/website-experience/feedback/feedback-model.ts`
- Create: `apps/website/components/website-experience/feedback/local-storage-feedback-repository.ts`
- Create: `apps/website/tests/feedback-model.test.ts`
- Create: `apps/website/tests/local-storage-feedback-repository.test.ts`

**Interfaces:**
- Produces: `FeedbackEntry`、`FeedbackKind`、`FeedbackRepository`。
- Produces: `sortFeedbackEntries()`、`trimFeedbackEntries()`、`validateDraft()`。
- Produces: `LocalStorageFeedbackRepository`。

- [ ] **Step 1: 编写排序、裁剪和验证失败测试**

```ts
expect(trimFeedbackEntries(entries, 1000)).toHaveLength(1000);
expect(trimmed[0]?.likeCount).toBeGreaterThanOrEqual(trimmed[999]?.likeCount ?? 0);
expect(validateDraft({ authorName: 'a'.repeat(25), content: '有效内容超过十个字', kind: 'feedback' }))
  .toMatchObject({ valid: false });
```

分别生成 1005 条反馈和 1005 条建议，确认各自独立裁剪。

- [ ] **Step 2: 编写仓储失败测试**

覆盖首次示例、创建、刷新读取、点赞、取消点赞、损坏 JSON 回退、配额写入失败保留草稿所需错误对象、`storage` 同步。

- [ ] **Step 3: 实现领域类型**

```ts
export interface FeedbackRepository {
  list(kind: FeedbackKind): readonly FeedbackEntry[];
  create(input: CreateFeedbackInput): FeedbackEntry;
  toggleLike(id: string, localUserId: string): FeedbackEntry;
  subscribe(listener: () => void): () => void;
}
```

- [ ] **Step 4: 实现版本化本地结构**

```ts
interface FeedbackStorageDocument {
  version: 1;
  localUserId: string;
  entries: FeedbackEntry[];
  likedEntryIds: string[];
}
```

使用 Zod 或结构化校验解析。写入失败抛出领域错误，不吞掉编辑内容。

- [ ] **Step 5: 验证并交给用户提交**

运行两个聚焦测试和 TypeScript。

---

### Task 9：让反馈内容驱动文件粒子预览

**Files:**
- Create: `apps/website/components/website-experience/feedback/feedback-preview-source.ts`
- Create: `apps/website/tests/feedback-preview-source.test.ts`
- Modify: `apps/website/components/website-experience/SharedVisualLayers.tsx`
- Modify: `apps/website/components/home-experience/FileSwarm.tsx`

**Interfaces:**
- Consumes: `FeedbackRepository`、`FilePreviewContentSource`。
- Produces: `createFeedbackPreviewSource(repository, random)`。

- [ ] **Step 1: 编写随机绑定失败测试**

```ts
const first = source.bindToSpawn('particle-1');
expect(source.read('particle-1')).toEqual(first);
source.release('particle-1');
const second = source.bindToSpawn('particle-1');
expect(random).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: 运行测试确认适配器不存在**

- [ ] **Step 3: 实现生成时绑定接口**

内容包括类型、昵称、正文摘要和点赞数。粒子存活期间不因列表重新排序而变化。

- [ ] **Step 4: 接入共享粒子生命周期**

粒子 spawn 时绑定，remove 时 release。首页、下载和捐款现有内容源不得回归。

- [ ] **Step 5: 验证并交给用户提交**

---

### Task 10：实现反馈主场景、列表和点赞

**Files:**
- Create: `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`
- Create: `apps/website/components/website-experience/feedback/FeedbackListDialog.tsx`
- Create: `apps/website/components/website-experience/feedback/feedback.module.css`
- Create: `apps/website/tests/feedback-chapter.test.tsx`
- Modify: `apps/website/components/website-experience/chapter-registry.tsx`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: `FeedbackRepository` 和现有支付滚筒循环模型。
- Produces: `[data-testid="feedback-chapter"]`、`[data-testid="feedback-roller"]`。

- [ ] **Step 1: 编写主场景失败测试**

测试三项配置、标题倾斜、局部 wheel/keyboard/pointer、非当前项先选择、当前反馈/建议项打开列表。

- [ ] **Step 2: 编写列表失败测试**

测试排序行、点赞/取消、局部滚动隔离、Portal 语义、Escape、遮罩关闭和焦点恢复。

- [ ] **Step 3: 实现反馈主场景**

复用 `paymentRelativeOffset()` 和 `paymentCardVisual()`，但建立反馈专用配置，不能把支付文案写入通用模型。

- [ ] **Step 4: 实现列表查看层**

每条使用一行式结构：

```tsx
<article data-feedback-id={entry.id}>
  <header>{entry.authorName}<time>{formattedTime}</time></header>
  <p>{entry.content}</p>
  <button aria-pressed={entry.likedByCurrentBrowser}>
    <ThumbsUp aria-hidden="true" />
    {entry.likeCount}
  </button>
</article>
```

- [ ] **Step 5: 注册正式章节并接入共享文件 profile**

用 `FeedbackChapter` 替换占位；反馈章启用文件粒子、关闭光场。

- [ ] **Step 6: 验证并交给用户提交**

---

### Task 11：实现投稿编辑器和放弃草稿确认

**Files:**
- Create: `apps/website/components/website-experience/feedback/FeedbackComposerDialog.tsx`
- Create: `apps/website/components/website-experience/feedback/DiscardDraftDialog.tsx`
- Modify: `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`
- Modify: `apps/website/components/website-experience/feedback/feedback.module.css`
- Modify: `apps/website/tests/feedback-chapter.test.tsx`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: `validateDraft()`、`FeedbackRepository.create()`。
- Produces: 投稿、错误保稿和放弃确认流程。

- [ ] **Step 1: 编写编辑器失败测试**

覆盖匿名昵称、24 字限制、10 至 1000 字正文、类型分段控件、发布后进入对应列表。

- [ ] **Step 2: 编写放弃确认失败测试**

无内容直接关闭；有内容时遮罩、取消和 Escape 打开确认；选择继续编辑恢复焦点；确认放弃清空草稿。

- [ ] **Step 3: 实现编辑器状态机**

```ts
type ComposerState =
  | { phase: 'editing'; draft: FeedbackDraft; error: string | null }
  | { phase: 'confirm-discard'; draft: FeedbackDraft }
  | { phase: 'submitting'; draft: FeedbackDraft };
```

- [ ] **Step 4: 处理写入失败**

仓储写入失败时返回 `editing`，保留全部字段，在正文附近显示 `role="alert"`，不关闭 Portal。

- [ ] **Step 5: 浏览器验证**

投稿、刷新、点赞、取消点赞、未保存确认和焦点恢复均使用真实生产路径。

- [ ] **Step 6: 验证并交给用户提交**

---

### Task 12：完成全站响应式、生命周期和视觉验收

**Files:**
- Modify: `apps/website/components/website-experience/website-experience.module.css`
- Modify: `apps/website/components/website-experience/about/about.module.css`
- Modify: `apps/website/components/website-experience/feedback/feedback.module.css`
- Modify: `apps/website/components/website-experience/download/download.module.css`
- Modify: `apps/website/components/website-experience/donation/donation.module.css`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: 所有正式章节和共享视觉原语。
- Produces: 最终跨视口与降级验收证据。

- [ ] **Step 1: 增加目标视口布局断言**

对 `390×844`、`375×667`、`760×900`、`761×900`、`1440×900`、`1920×1080`、`568×320` 检查：

- `scrollWidth === innerWidth`
- 所有可见重点内容位于视口内
- 文件粒子与重点内容无命中遮挡
- 模态安全边距
- 介绍面板与反馈滚筒无文字裁切

- [ ] **Step 2: 增加生命周期断言**

验证 blur/focus、hidden/visible、reduced-motion、GSAP/Canvas/存储异常和最终卸载。

- [ ] **Step 3: 增加关键交互 E2E**

覆盖：

- 普通滚轮灵敏度
- 下载悬停与移动轻触
- 介绍错峰、悬停置顶、移动锁定
- 反馈列表、点赞、投稿、刷新持久化、跨标签同步
- 三支付付款码

- [ ] **Step 4: 生成视觉截图**

保存到忽略目录：

```text
tests/.playwright-output/website/screenshots/
```

文件名包括：

```text
home-layer-contract-1440.png
chapter-backdrops-1440.png
download-hover-1440.png
about-default-1440.png
about-hover-1440.png
feedback-roller-1440.png
feedback-list-1440.png
feedback-composer-390.png
donation-paypal-1440.png
website-1920.png
website-568x320.png
```

- [ ] **Step 5: 运行完整门禁**

Run:

```powershell
pnpm.cmd verify:website
git diff --check
git status --short
```

Expected:

- TypeScript 通过。
- Vitest 全部通过。
- Next.js 生产构建和静态导出通过。
- Playwright 全部通过。
- 无残留测试服务。
- 只存在本计划文件、规格文件和明确列出的产品变更。

- [ ] **Step 6: 人工浏览器复核**

在隔离端口启动本地开发服务器，依次检查五章节、所有悬停/轻触、反馈数据刷新、三个付款码、减少动态效果和控制台错误。

- [ ] **Step 7: 用户最终 Git 检查点**

向用户报告最终文件范围、测试数量、截图路径和残余风险。不得执行任何 Git 写操作，由用户自行决定提交、合并或推送。

