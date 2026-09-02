# 官网最终视觉恢复实施计划

> **面向智能体执行者：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务实施；每一步使用复选框追踪。

**目标：** 在不回退当前网站业务的前提下，恢复 `963df613e35f8cafc1a9ea076ab878f0bae782d6` 已验收的五章节液态视觉，并建立能捕获同类空白页回归的自动化与人工双门。

**架构：** 当前 `WebsiteExtension` 继续作为业务权威；`94785ee91b0ed88f7aa2b1023bb7a4cd662b86d3` 作为“最终视觉 + 当前减少动态效果优化”的首选代码捐赠点，`963df613e35f8cafc1a9ea076ab878f0bae782d6` 作为最终画面对照。恢复范围只包含跨五章 WebGL 生命周期、着色器／纹理、四类既有视觉事件和最小生产者接线；业务 DOM、Repository、下载计数、审核和静态降级继续使用当前实现。

**技术栈：** Next.js 15、React 19、TypeScript、WebGL 1、GSAP 3、Vitest、Testing Library、Playwright、CloudBase Hosting。

## 全局约束

- 只修改官网及其测试、规格、计划和验收证据；桌宠黑名单路径必须保持零差异。
- 不整体回退分支，不用旧提交整文件覆盖包含现行业务的章节组件。
- 不恢复 `useWebsiteController.pointer`，不新增全局状态库、动画库、测试 runner、retry 或 timeout。
- 必须保留当前 `reducedMotion`／`staticFallback` 无 GPU 路径及完整资源释放。
- 必须保留官方下载计数、计数失败不阻断下载、`publicationBasis` 风险提示与首下阻断、现行 i18n、管理员两步强制发布和投稿 Fragment 令牌。
- 不改变 CloudBase API、数据库、migration、函数、Scanner、远端内容数据或共享包投稿关闭状态。
- 不购买套餐，不开启按量付费；最终只覆盖上海开发／测试 Hosting，不表述为正式生产。
- 只在 `WebsiteExtension` 分支提交，不执行 merge、rebase 或 push。
- 每个实现任务必须经历 RED → GREEN → REFACTOR、差异复核、规格复核和代码质量复核。

---

## 文件职责图

- `apps/website/components/home-experience/HomeExperience.tsx`：决定跨五章液态画布生命周期，并把章节进度传给 WebGL。
- `apps/website/components/home-experience/LiquidGlassHome.tsx`：唯一正常动效 WebGL Adapter；消费四类视觉事件、维护七张纹理和清理 GPU／监听器资源。
- `apps/website/components/home-experience/liquid-glass-shaders.ts`：唯一最终液态渲染程序，负责五章背景、玻璃、文字、景深和交接。
- `apps/website/components/website-experience/WebsiteExperience.tsx`：保持 Home WebGL 宿主在五章期间可见；继续传播当前降级状态。
- `LanguageMenu.tsx`、`AboutChapter.tsx`、`DownloadChapter.tsx`、`SharedPetCard.tsx`、`SharedPetChapter.tsx`、`SupportChapter.tsx`：只发布当前 DOM 已拥有状态的最小视觉快照。
- `apps/website/tests/*.test.tsx`：锁定生命周期、事件、着色器职责和现行业务不变量。
- `tests/e2e/website.spec.ts`：增加一个 1440×900 正常动效五章结构门，不做动态 WebGL 像素阻断。
- `docs/operations/evidence/website-final-visual-restoration-2026-09-02/`：保存五张正常动效与两张减少动态效果人工权威截图及 SHA-256 清单。
- `docs/operations/website-chain-verification-acceptance.md`、`docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`：分别记录本地视觉验收和上海测试站覆盖结果。

## Task 1：恢复跨五章生命周期与宿主可见性

**文件：**

- Modify: `apps/website/tests/magnetic-intro.test.tsx`
- Modify: `apps/website/tests/website-fallback.test.tsx`
- Modify: `apps/website/components/home-experience/HomeExperience.tsx`
- Modify: `apps/website/components/website-experience/WebsiteExperience.tsx`

**接口：**

- Consumes: `HomeExperienceProps.exitProgress: number`、`deriveChapterVisualState(...)`、当前 `reducedMotion`／`staticFallback`。
- Produces: `data-liquid-home-active` 在 `[0, 4]` 为 `true`，`4.08` 为 `false`；正常动效五章期间 Home 宿主可见，减少动态效果仍走当前静态路径。

- [ ] **Step 1.1：RED——替换错误的 1.08 生命周期测试**

把 `magnetic-intro.test.tsx` 中“介绍交接结束后立即释放”测试替换为参数化契约：

```tsx
it.each([0, 1, 2, 3, 4])('进度 %s 时保留五章节液态玻璃', (exitProgress) => {
  render(<HomeExperience exitProgress={exitProgress} isPaused={false} reducedMotion={false} />);
  expect(screen.getByTestId('home-experience').dataset.liquidHomeActive).toBe('true');
});

it('离开支持章节后释放液态玻璃', () => {
  render(<HomeExperience exitProgress={4.08} isPaused={false} reducedMotion={false} />);
  expect(screen.getByTestId('home-experience').dataset.liquidHomeActive).toBe('false');
});
```

- [ ] **Step 1.2：RED——锁定正常动效宿主与减少动态效果降级的分流**

在 `website-fallback.test.tsx` 复用现有控制器替身，新增两项可观察断言：正常动效进度为 `2`、`3`、`4` 时 Home 章节 `data-visible="true"`；减少动态效果时仍由当前章节 DOM 可见且 WebGL 不建立。不得把 `staticFallback={reducedMotion}` 改回旧版写法。

- [ ] **Step 1.3：运行 RED**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx website-fallback.test.tsx
```

预期：生命周期断言在当前 `< 1.08` 实现失败；正常动效后续章节的 Home 宿主可见性断言失败。

- [ ] **Step 1.4：GREEN——最小恢复生命周期和宿主可见性**

在 `HomeExperience.tsx` 恢复：

```ts
// 前五个模块连续复用首页液态玻璃；离开合并支持模块后再释放上下文。
const active = exitProgress < 4.08;
```

在 `WebsiteExperience.tsx` 只恢复 Home 可见性分支，同时保留当前下载交互分支与 `staticFallback={reducedMotion}`：

```ts
const visual = chapter.id === 'home' && !reducedMotion && controller.progress <= 4
  ? { ...derived, opacity: 1, scale: 1, blurPx: 0, contrast: 1, visible: true }
  : chapter.id === 'download'
      && controller.progress > 1
      && controller.progress <= 2
    ? { ...derived, opacity: 1, scale: 1, blurPx: 0, contrast: 1, visible: true }
    : derived;
```

- [ ] **Step 1.5：运行 GREEN、复核并提交**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx website-fallback.test.tsx motion-disabled-contract.test.tsx
pnpm.cmd --filter @myself/website typecheck
git diff --check
git diff -- apps/website/components/home-experience/HomeExperience.tsx apps/website/components/website-experience/WebsiteExperience.tsx apps/website/tests/magnetic-intro.test.tsx apps/website/tests/website-fallback.test.tsx
git add -- apps/website/components/home-experience/HomeExperience.tsx apps/website/components/website-experience/WebsiteExperience.tsx apps/website/tests/magnetic-intro.test.tsx apps/website/tests/website-fallback.test.tsx
git commit -m "fix(web): 恢复五章节液态画布生命周期"
```

完成标准：错误的 `1.08` 契约已被删除；五章正常动效共享同一个 Home WebGL 宿主；现行减少动态效果测试仍为绿。

## Task 2：原子恢复 WebGL 五章渲染内核

**文件：**

- Modify: `apps/website/tests/about-chapter.test.tsx`
- Modify: `apps/website/tests/download-chapter.test.tsx`
- Modify: `apps/website/tests/support-chapter.test.tsx`
- Modify: `apps/website/tests/magnetic-intro.test.tsx`
- Modify: `apps/website/components/home-experience/LiquidGlassHome.tsx`
- Modify: `apps/website/components/home-experience/liquid-glass-shaders.ts`

**接口：**

- Consumes: `transitionProgress` 范围 `[0, 4]`；四个 `window` 自定义事件；当前 i18n 文案；`reducedMotion` 与 `isPaused`。
- Produces: `LIQUID_GLASS_RIPPLE_EVENT`、`LIQUID_GLASS_INTERACTION_EVENT`、`LIQUID_GLASS_COMMUNITY_CARDS_EVENT`、`LIQUID_GLASS_SUPPORT_SELECTION_EVENT`；`LiquidGlassInteractionDetail`；七张纹理与对应 uniform；卸载时零遗留监听器／ticker／GPU 对象。

- [ ] **Step 2.1：RED——恢复最终版渲染职责测试**

从 `94785ee91b0ed88f7aa2b1023bb7a4cd662b86d3` 的同名测试逐条移植并适配当前测试文件，只恢复以下可验证职责：

```ts
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_downloadTextTexture');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_communityTextTexture');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_supportTextTexture');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_supportFeedbackActive');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_supportPaymentActive');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('supportButtonBlurPx');
expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('return clamp(depth, 0.0, 2.0) * 2.5;');
```

扩展 `createWebGlContext()` 替身，只加入恢复代码真实调用的 `uniform1fv`、`uniform2fv` 等接口；保留“减少动态效果不获取 WebGL”和资源删除断言。

在 `magnetic-intro.test.tsx` 通过同一个 WebGL 替身渲染 `LiquidGlassHome`，依次 dispatch 四个事件并手动执行已捕获的 ticker frame；断言对应 `u_ripples[0]`、`u_hoveredBlob`／`u_blobOffsets[0]`、`u_communityCardCount`、`u_supportFeedbackActive`／`u_supportPaymentActive` uniform 收到新值。这样 shader 字符串断言只负责接口形状，事件到 uniform 的运行时断言负责 Adapter 行为。

- [ ] **Step 2.2：运行 RED**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx about-chapter.test.tsx download-chapter.test.tsx support-chapter.test.tsx
```

预期：缺失下载／社区／支持 shader uniform、支持景深函数或视觉事件消费而失败。

- [ ] **Step 2.3：GREEN——以 94785ee 为首选捐赠点恢复内核**

先只读生成精确差异：

```powershell
git diff 94785ee91b0ed88f7aa2b1023bb7a4cd662b86d3 -- apps/website/components/home-experience/LiquidGlassHome.tsx apps/website/components/home-experience/liquid-glass-shaders.ts
```

按 hunk 恢复以下原子集合，不能只恢复 shader 或只恢复 TypeScript Adapter：

1. 四个事件常量、`RippleEventDetail`、`LiquidGlassInteractionDetail`。
2. `glassInteraction`、`supportSelection`、六项 `blobOffsets` 与社区页码快照。
3. `u_downloadTransition`、`u_communityTransition`、`u_supportTransition`、支持活动索引、社区数量、拖拽与 hover uniform。
4. `logo`、首页文字、角落文字、About 玻璃文字、Download、Community、Support 共七张纹理。
5. 五章 SDF、折射、焦散、高光、背景和 `0 / 2.5 / 5px` 支持按钮柔化分支。
6. 四个事件的 add/remove listener、ticker、Image、纹理、buffer、shader、program 对称清理。

必须保留 `94785ee` 已有的下列结构，不从更早提交覆盖：

```ts
let systemReducedMotion = reducedMotion;
systemReducedMotion ||= window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!active || systemReducedMotion) {
  setInitializationFailed(false);
  return;
}
```

`liquid-glass-home.module.css` 保持当前版本，不从历史提交恢复；当前规则已经负责 reduced-motion 与初始化失败时隐藏 Canvas、显示静态 fallback。

- [ ] **Step 2.4：运行 GREEN 与资源清理门**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx about-chapter.test.tsx download-chapter.test.tsx support-chapter.test.tsx motion-disabled-contract.test.tsx website-fallback.test.tsx
pnpm.cmd --filter @myself/website typecheck
git diff --check
```

- [ ] **Step 2.5：做减法复核并提交**

确认未恢复 `useWebsiteController.pointer`、旧 Repository、旧 DTO、旧发布清单键或重复 CSS 渲染层；确认所有新建纹理和监听器都有对应释放，然后提交：

```powershell
git add -- apps/website/components/home-experience/LiquidGlassHome.tsx apps/website/components/home-experience/liquid-glass-shaders.ts apps/website/tests/magnetic-intro.test.tsx apps/website/tests/about-chapter.test.tsx apps/website/tests/download-chapter.test.tsx apps/website/tests/support-chapter.test.tsx
git commit -m "fix(web): 恢复五章节液态视觉内核"
```

完成标准：Adapter、shader、纹理和事件消费者作为一个集合通过测试；减少动态效果不创建 GPU；没有第二套视觉实现。

## Task 3：恢复语言、介绍与下载的最小视觉投影

**文件：**

- Modify: `apps/website/components/i18n/LanguageMenu.tsx`
- Modify: `apps/website/components/website-experience/about/AboutChapter.tsx`
- Modify: `apps/website/components/website-experience/download/DownloadChapter.tsx`
- Modify: `apps/website/tests/about-chapter.test.tsx`
- Modify: `apps/website/tests/download-chapter.test.tsx`
- Test: `apps/website/tests/official-download-click.test.tsx`
- Test: `apps/website/tests/i18n.test.tsx`

**接口：**

- Consumes: Task 2 的 `LIQUID_GLASS_RIPPLE_EVENT`、`LIQUID_GLASS_INTERACTION_EVENT` 和 `LiquidGlassInteractionDetail`。
- Produces: 语言菜单与下载玻璃点击波纹；About hover／drag／回位偏移；不改变下载业务结果。

- [ ] **Step 3.1：RED——恢复事件边界测试**

在当前测试上恢复并适配 `94785ee` 的四项行为：语言菜单 pointer down 发布 ripple；About hover 发布 `hovered`；About drag 发布归一化六项 offsets 和 ripple；Download 安装提示区域在正常动效且进入完成时发布一次 ripple。事件 detail 必须是：

```ts
type LiquidGlassInteractionDetail = {
  hovered: -1 | 0 | 1 | 2;
  dragging: boolean;
  offsets: readonly [number, number, number, number, number, number];
};
```

在 `i18n.test.tsx` 给语言菜单按钮增加一次 pointer down，断言 DOM ripple 与 `LIQUID_GLASS_RIPPLE_EVENT` 各发生一次；不得通过重复触发 click 改变现有语言切换断言。

- [ ] **Step 3.2：运行 RED**

```powershell
pnpm.cmd --filter @myself/website test -- about-chapter.test.tsx download-chapter.test.tsx i18n.test.tsx
```

- [ ] **Step 3.3：GREEN——逐 hunk 恢复生产者**

从 `94785ee` 只移植以下接线：

- `LanguageMenu` 在现有 DOM ripple 创建后发布 `{ clientX, clientY, strength: 1.35 }`。
- `AboutChapter` 的 `publishInteraction`、hover、drag、弹性回位 `onUpdate/onComplete` 和卸载归零事件。
- `DownloadChapter` 在安装提示／FAQ 语义区域 pointer down 时发布 `{ strength: 1.65 }`。

不得覆盖 `DownloadChapter` 当前 `recordOfficialDownloadClick()` 调用、失败吞吐规则、发布清单类型、3D 模型 reduced-motion 分支、当前文案或链接。

- [ ] **Step 3.4：运行业务保护门、复核并提交**

```powershell
pnpm.cmd --filter @myself/website test -- about-chapter.test.tsx download-chapter.test.tsx official-download-click.test.tsx official-download-metric-client.test.ts i18n.test.tsx motion-disabled-contract.test.tsx
pnpm.cmd --filter @myself/website typecheck
git diff --check
git add -- apps/website/components/i18n/LanguageMenu.tsx apps/website/components/website-experience/about/AboutChapter.tsx apps/website/components/website-experience/download/DownloadChapter.tsx apps/website/tests/about-chapter.test.tsx apps/website/tests/download-chapter.test.tsx
git commit -m "fix(web): 恢复介绍与下载视觉投影"
```

完成标准：三个生产者只发布视觉快照；下载计数、下载链接、i18n 和减少动态效果行为保持通过。

## Task 4：恢复共享仓库视觉投影并保护人工覆盖业务

**文件：**

- Create: `apps/website/tests/community-ripple.test.tsx`
- Modify: `apps/website/components/website-experience/community/SharedPetCard.tsx`
- Modify: `apps/website/components/website-experience/community/SharedPetChapter.tsx`
- Modify: `apps/website/tests/shared-pet-card.test.tsx`
- Modify: `apps/website/tests/shared-pet-chapter.test.tsx`

**接口：**

- Consumes: `LIQUID_GLASS_RIPPLE_EVENT`、`LIQUID_GLASS_COMMUNITY_CARDS_EVENT`。
- Produces: 卡片主体 ripple；`{ count, currentPage, totalPages }` 当前页视觉快照。

- [ ] **Step 4.1：RED——恢复社区水波与分页快照测试**

从 `963df61` 恢复 `community-ripple.test.tsx`，但测试数据必须补齐当前类型要求：

```ts
publicationBasis: 'standard'
```

在 `shared-pet-chapter.test.tsx` 新增监听器，等待并断言：

```ts
expect(details.at(-1)).toEqual({
  count: expectedVisibleCount,
  currentPage: 1,
  totalPages: expectedTotalPages
});
```

- [ ] **Step 4.2：运行 RED**

```powershell
pnpm.cmd --filter @myself/website test -- community-ripple.test.tsx shared-pet-card.test.tsx shared-pet-chapter.test.tsx
```

- [ ] **Step 4.3：GREEN——只恢复两个社区视觉生产者**

- `SharedPetCard` 仅在 article 主体 pointer down 发布 ripple；点赞和下载按钮继续阻止冒泡，不触发第二次 ripple。
- `SharedPetChapter` 用一个 RAF effect 发布可见页 items 数、当前页和总页数，并在 cleanup 取消 RAF。

不得覆盖或删除 `publicationBasis`、管理员人工覆盖三处警示、服务端依据与列表依据不一致时的首下阻断、pending like、游标、重试和 Repository。

- [ ] **Step 4.4：运行完整社区业务保护门、复核并提交**

```powershell
pnpm.cmd --filter @myself/website test -- community-ripple.test.tsx shared-pet-card.test.tsx shared-pet-chapter.test.tsx shared-pet-dialogs.test.tsx shared-pet-override-warning.test.tsx cloud-shared-pet-repository.test.ts indexed-db-shared-pet-repository.test.ts
pnpm.cmd --filter @myself/website typecheck
git diff --check
git add -- apps/website/components/website-experience/community/SharedPetCard.tsx apps/website/components/website-experience/community/SharedPetChapter.tsx apps/website/tests/community-ripple.test.tsx apps/website/tests/shared-pet-card.test.tsx apps/website/tests/shared-pet-chapter.test.tsx
git commit -m "fix(web): 恢复共享仓库液态投影"
```

完成标准：社区标题／页码／玻璃能够获得实时视觉数据，且人工覆盖风险语义与下载安全门零回归。

## Task 5：恢复支持页活动索引与景深投影

**文件：**

- Modify: `apps/website/components/website-experience/support/SupportChapter.tsx`
- Modify: `apps/website/tests/support-chapter.test.tsx`
- Test: `apps/website/tests/cloud-feedback-repository.test.ts`
- Test: `apps/website/tests/motion-disabled-contract.test.tsx`

**接口：**

- Consumes: `LIQUID_GLASS_SUPPORT_SELECTION_EVENT`。
- Produces: `{ feedbackIndex: number, paymentIndex: number }`，与现有两组 DOM 的活动项、键盘和滚轮选择同步。

- [ ] **Step 5.1：RED——锁定支持选择同步**

在 `support-chapter.test.tsx` 的现有景深测试旁增加事件监听；初始值应为 `{ feedbackIndex: 0, paymentIndex: 0 }`，分别滚动两组后最终值为 `{ feedbackIndex: 1, paymentIndex: 1 }`。继续保留 DOM `data-depth-index` 的 `0 / 1 / 2` 和 `data-blur-px` 的 `0 / 2.5 / 5` 断言。

- [ ] **Step 5.2：运行 RED**

```powershell
pnpm.cmd --filter @myself/website test -- support-chapter.test.tsx
```

- [ ] **Step 5.3：GREEN——恢复单向视觉同步 effect**

在当前 `SupportChapter` 中加入且只加入：

```ts
useEffect(() => {
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_SUPPORT_SELECTION_EVENT, {
    detail: {
      feedbackIndex: activeFeedbackIndex,
      paymentIndex: activePaymentIndex
    }
  }));
}, [activeFeedbackIndex, activePaymentIndex]);
```

不得改动反馈 Repository、草稿、放弃确认、提交回执、二维码、焦点恢复、首次点击只切换活动层或第二次点击才执行的业务规则。

- [ ] **Step 5.4：运行支持业务保护门、复核并提交**

```powershell
pnpm.cmd --filter @myself/website test -- support-chapter.test.tsx cloud-feedback-repository.test.ts motion-disabled-contract.test.tsx
pnpm.cmd --filter @myself/website typecheck
git diff --check
git add -- apps/website/components/website-experience/support/SupportChapter.tsx apps/website/tests/support-chapter.test.tsx
git commit -m "fix(web): 恢复支持页液态景深同步"
```

完成标准：键盘、滚轮、点击与 WebGL 景深使用同一活动索引；反馈和支付业务测试全部通过。

## Task 6：建立正常动效五章 E2E 与 mutation 敏感性证据

**文件：**

- Modify: `tests/e2e/website.spec.ts`
- Modify: `docs/operations/website-chain-verification-acceptance.md`

**接口：**

- Consumes: 现有 `enterInteractive(page)`、`enterChapter(page, chapterId)`、`expectInsideViewport(...)`、`CHAPTER_IDS`。
- Produces: 一个 `1440×900` 正常动效五章节结构门；一次可重复的 `< 4.08` → `< 1.08` mutation RED 记录。

- [ ] **Step 6.1：RED——新增唯一一个桌面正常动效五章测试**

测试固定条件：

```ts
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.setViewportSize({ width: 1440, height: 900 });
await page.addInitScript(() => localStorage.setItem('ai-pet-locale', 'zh-CN'));
await page.goto('/?seed=42');
```

依次进入 `home/about/download/community/feedback`，每章断言：

```ts
await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', chapterId);
await expect(page.locator(LIQUID_HOME)).toHaveAttribute('data-active', 'true');
await expect(page.locator(LIQUID_HOME)).toHaveAttribute('data-initialization-failed', 'false');
await expect(page.locator(`${LIQUID_HOME} canvas`)).toBeVisible();
```

读取 Canvas 的 `width/height` 与 `getBoundingClientRect()`，断言缓冲区非零并覆盖视口。章节核心定位器固定为：About 的三个 `[data-glass-id]`；Download 的平台选择组和安装提示 region；Community 的上传按钮或稳定空状态；Feedback 的两组操作及六个非零按钮边界。不得使用 `toHaveScreenshot` 阻断动态 WebGL 像素。

- [ ] **Step 6.2：运行 RED**

```powershell
pnpm.cmd build:website:e2e
pnpm.cmd exec playwright test --config tests/playwright.website.config.ts tests/e2e/website.spec.ts --grep "正常动效五章节液态视觉职责"
```

当前回归版应在 About 或后续章节因液态层失活／核心前景不可见而失败；若恢复任务已先完成，则使用 Step 6.4 的 mutation 明确证明 RED。

- [ ] **Step 6.3：GREEN——只调整恢复代码的真实缺陷**

如果 E2E 失败，先区分 shader 初始化、宿主隐藏、纹理未更新、事件未同步或真实业务加载；只修根因，不增加 timeout、retry、固定 sleep、截图掩码或放宽可见性断言。

- [ ] **Step 6.4：mutation 敏感性验证**

临时把 `HomeExperience.tsx` 的 `< 4.08` 改为 `< 1.08`，只运行新测试并确认 RED；立即恢复 `< 4.08`，再次运行并确认 GREEN。用 `git diff` 确认临时 mutation 没有残留。

- [ ] **Step 6.5：运行现行全部网站门并提交**

```powershell
pnpm.cmd verify:website
pnpm.cmd verify:cloudbase
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git add -- tests/e2e/website.spec.ts docs/operations/website-chain-verification-acceptance.md
git commit -m "test(web): 阻断五章节液态视觉回归"
```

完成标准：新门能被生命周期 mutation 稳定打红；恢复后全绿；没有扩大 runner 或等待策略。

## Task 7：逐章真实视觉验收与独立代码审查

**文件：**

- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/home-1440x900-normal.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/about-1440x900-normal.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/download-1440x900-normal.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/community-1440x900-normal.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/feedback-1440x900-normal.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/feedback-390x844-reduced.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/website-568x320-reduced.png`
- Create: `docs/operations/evidence/website-final-visual-restoration-2026-09-02/manifest.sha256`
- Modify: `docs/operations/website-chain-verification-acceptance.md`

**接口：**

- Consumes: `963df61` 本地基线站、当前候选站、Task 6 的结构门。
- Produces: 带 commit、Chromium 版本、视口、DPR、媒体模式、日期和 SHA-256 的人工视觉证据。

- [ ] **Step 7.1：构建并启动发布候选**

使用与 E2E 相同的静态导出，不复用开发服务器作为发布证据。等待 `document.fonts.ready`、`data-static-fallback=ready`、`data-initialization-failed=false`、目标章节整数吸附、Canvas 缓冲区非零以及社区成功／明确空状态。

- [ ] **Step 7.2：生成并逐张查看 5+2 证据**

正常动效固定 Chromium、1440×900、DPR 1、缩放 100%、中文、`?seed=42`；分别截图五章。再用 390×844 与 568×320 验证减少动态效果。逐张与 `963df61` 对照，至少确认：

- About 显示深色液态 `AI / PET / YOUR / AGENT` 与三块能力玻璃；
- Download 显示深色液态信息层、平台区和 3D 模型；
- Community 显示液态标题、页码和当前内容；
- Feedback 显示两组三项景深按钮，而不是只有两个标题。

视觉查看后再执行数值门：对比 donor 与候选的 shader／生命周期关键常量；在 `1440×900` Community 页面读取前三张卡片的 `getBoundingClientRect()`、Canvas CSS 尺寸、drawing buffer 与 DPR，按生产 helper 上传的列／行归一化值换算 WebGL 基础中心，逐卡记录 `dx`、`dy` 和欧氏距离，要求基础中心误差不超过 1 CSS px。同步记录 CSS computed padding、gap、columns、rows 与 helper 结果；`900px` 及以下正常动效验证卡片玻璃计数为 0，DOM 卡片与业务继续可用。动态浮动只作为独立动效，不得用它掩盖基础网格错位。

- [ ] **Step 7.3：执行两阶段独立审查**

规格审查只核对 `2026-09-02-website-final-visual-restoration-design.md` 的目标／非目标／保护项；质量审查检查事件清理、GPU 释放、类型、重复逻辑、业务覆盖和桌宠零差异。任何 P0/P1/P2 问题修复后重跑对应 Task 门，P3 记录但不以无关重构扩大范围。

- [ ] **Step 7.4：记录证据并提交**

```powershell
Get-FileHash -Algorithm SHA256 docs/operations/evidence/website-final-visual-restoration-2026-09-02/*.png
git diff --check
git add -- docs/operations/evidence/website-final-visual-restoration-2026-09-02 docs/operations/website-chain-verification-acceptance.md
git commit -m "docs(web): 记录最终视觉恢复验收"
```

完成标准：自动结构门与真实画面对照同时通过；验收记录只写实际观察，不把未验证项目写成通过。

## Task 8：覆盖上海测试 Hosting 并复验双域名

**文件：**

- Modify: `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`
- Modify only if procedure changed: `docs/operations/cloudbase-deployment.md`

**接口：**

- Consumes: Task 7 已验收的同一静态导出；现有上海环境 `ai-pet-scanner-dev-d0cpbc8094826` 与既有公开前端变量。
- Produces: 上海默认域名和 `https://cjmwebsite.cn` 的新视觉测试部署；不改变数据库和函数。

- [ ] **Step 8.1：部署前只读预览**

记录当前远端 Hosting 对象清单、本地候选清单、Git commit 与环境 ID。确认套餐仍为免费体验、按量付费关闭、共享包投稿关闭；不得输出 Publishable Key 值。

- [ ] **Step 8.2：上传同一已验收候选**

使用 `NEXT_PUBLIC_API_BASE_URL=https://cjmwebsite.cn/api/v1` 和现有上海公开配置重新构建／校验哈希后覆盖 Hosting。本任务默认不删除任何远端对象；若上传后需要清理不再被新 `index.html` 引用的旧哈希前端产物，必须先列出精确对象与恢复方式，并在行动时取得大量删除的第二次明确批准。无论如何都不得删除 `__auth`、`cloud-admin`、用户对象、数据库或函数。

- [ ] **Step 8.3：线上逐章与业务 smoke**

默认域名和 `cjmwebsite.cn` 都验证首页、About、Download、Community、Feedback 五章；再验证公开 API 200、官方下载跳转与计数失败不阻断、共享资源列表／风险标记、反馈入口和默认域名管理员入口。不得制造真实共享包投稿数据。

- [ ] **Step 8.4：费用与状态复核**

确认未创建新套餐、按量服务、日志资源包、函数、数据库、Bucket 或密钥；记录本次只覆盖 Hosting。若视觉或业务 smoke 失败，使用部署前 commit 和相同公开配置恢复上一候选，数据库与远端内容不回滚。

- [ ] **Step 8.5：最终验证与提交记录**

```powershell
pnpm.cmd verify:website
pnpm.cmd verify:cloudbase
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git add -- docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md docs/operations/cloudbase-deployment.md
git commit -m "docs(web): 记录上海测试站视觉恢复"
git status --short
```

完成标准：两个域名均呈现最终五章节视觉且业务 smoke 通过；本次仍明确是上海开发／测试站，不是正式生产上线；工作区无意外修改。

## 最终需求追踪

| 规格要求 | 实施任务 |
| --- | --- |
| 五章生命周期和连续交接 | Task 1、Task 2 |
| 历史删码 + 真实画面对照双重保障 | Task 2、Task 7 |
| About／Download 视觉投影 | Task 3 |
| Community 标题、页码、卡片和 ripple | Task 4 |
| Support 两组三项景深 | Task 2、Task 5 |
| 保留 reduced-motion／WebGL 失败路径 | Task 1、Task 2、Task 6 |
| 保留当前业务、安全与 CloudBase | Task 3、Task 4、Task 5、Task 6 |
| 自动化视觉职责门 | Task 1、Task 2、Task 6 |
| 5+2 人工视觉证据 | Task 7 |
| 上海零额外费用测试部署 | Task 8 |
| 桌宠零修改、无 merge/rebase/push | 全局约束、Task 6、Task 8 |
