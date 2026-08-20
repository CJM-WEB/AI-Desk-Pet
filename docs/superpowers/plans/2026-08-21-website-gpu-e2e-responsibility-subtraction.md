# 网站 GPU E2E 职责再减法 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将两条不稳定且职责层级过高的网站 GPU E2E 下沉到确定性的组件、模型与最小浏览器接线测试，使当前正式 E2E 清单从 16 项减为 14 项，并恢复阶段 1 Task 11 的可复现最终裁决。

**Architecture:** 滚轮阈值、追赶、吸附和锁定继续由既有模型/控制器测试持有，真实浏览器只在既有 reduced-motion 用例中证明一次全局 wheel 接线；DPR 缓冲、pointer uniform 与 ripple 数据流由 `LiquidGlassHome` 的现有组件测试和 WebGL 替身持有。两条高层 E2E 仅在四项 mutation 均取得预期 RED、恢复后定向测试全部 GREEN 且三个临时生产文件最终零差异后删除；随后统一同步当前 14 项事实来源和阶段 1 Task 11 证据。

**Tech Stack:** TypeScript 5.9、React 19、Vitest 3、Testing Library、Playwright 1.61、GSAP、WebGL、pnpm 11 workspace。

## Global Constraints

- 设计基线：`docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md`；本计划只能实施该规格明确批准的职责再减法。
- 最终代码/测试差异只允许修改 `apps/website/tests/magnetic-intro.test.tsx` 与 `tests/e2e/website.spec.ts`；三个生产文件只允许用于短时 mutation，正式 GREEN、审查与提交前必须零差异。
- 不修改 `LiquidGlassHome`、章节控制器、shader、CSS 或任何网站产品行为；不新增生产接口、测试钩子、`data-*` 属性、产品分支或测试文件。
- 不修改 Playwright 配置、timeout、retry、worker、runner、fixture、trace、截图策略或验证门；不增加固定等待，不保留 `skip`、注释块、兼容别名或同义 E2E。
- 不新增、升级或删除依赖；不访问外部服务，不连接 CloudBase、Scanner 或数据库，不执行 migration，不部署正式网站。
- 不触碰 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**` 及其测试。
- 两条 E2E 必须在替代职责取得 mutation RED/GREEN、生产 mutation 全部恢复且定向门通过后才可删除；任何 mutation 未产生预期 RED 时立即停止删除并重新审查测试职责。
- 组件测试及替身增强新增不超过 60 行，既有 reduced-motion E2E 接线断言新增不超过 4 行；最终测试代码净减少至少 40 行，以 `git diff --numstat` 为准。
- 任一命令或单一问题累计达到 15 分钟，终止当前命令及相关子进程，记录首错与最后通过项，改用更小的目标命令；不得用测试外围改动掩盖失败。
- 所有面向人的文档和结构性代码注释使用中文；历史失败与 2026-08-20 的 16/16 结果保持原样，只追加有日期和范围的接替说明。
- 实施使用 `apply_patch` 做精确修改；不得用 `git restore`、`git checkout` 或批量重写恢复临时 mutation，必须用反向补丁恢复精确行并用只读差异证明零生产 diff。
- 用户已授权本轮 Git 写操作；每个 Task 仅在独立复审、目标验证和差异检查通过后按本计划给出的边界提交，不暂存或提交其他工作树内容。

---

## 文件职责与变更地图

### Task 1 正式差异

- Modify: `apps/website/tests/magnetic-intro.test.tsx`：最小增强现有 WebGL 替身，并新增唯一一项 normal-motion 组件契约，承接 DPR、viewport、pointer uniform 与 ripple 数据流。
- Modify: `tests/e2e/website.spec.ts`：向既有 `减少动态效果直接进入稳定首页` 合并一次全局 wheel 接线断言，并精确删除两条退役 E2E。

### Task 1 临时 mutation（提交前必须零差异）

- Temporary only: `apps/website/components/home-experience/config.ts`：将 `wheelUnlockDelta: 240` 临时改为 `360`，证明既有滚轮模型/控制器测试会 RED，然后精确恢复 `240`。
- Temporary only: `apps/website/components/website-experience/use-website-controller.ts`：临时移除 `registerWindowListener('wheel', handleWheel, { passive: false });`，证明 reduced-motion 浏览器接线断言会 RED，然后精确恢复同一注册。
- Temporary only: `apps/website/components/home-experience/LiquidGlassHome.tsx`：分别临时把 1440 档 `resolutionScale` 从 `0.9` 改为 `1`、把 `handleCanvasPointerDown` 的 `updatePointer(event, true)` 改为 `updatePointer(event, false)`，证明组件契约会分别 RED，然后逐项精确恢复。

### Task 2 当前事实来源

> **跟踪裁决（2026-08-21）：** 下列十份事实来源均需同步，但 `.superpowers/` 下的 `progress.md` 与 `task-11-report.md` 从未进入 Git，且被仓库 `.gitignore` 明确排除；它们继续作为本地执行证据，不使用 `git add -f` 强制纳入仓库。Task 2 正式提交只包含其余八份受跟踪文档。

- Modify: `docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md`：仅在实际通过后把状态和实施证据从“待实施”收敛为真实结果。
- Modify: `docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md`：追加本规格对当前两条用例和当前计数的接替说明，不改写历史 44→16 与 16/16 事实。
- Modify: `docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md`：把当前 normal-motion 专项职责指向两条保留的 390 E2E 和组件 DPR/指针契约，不改写历史阶段 0 结果。
- Modify: `docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md`：追加 2026-08-21 接替说明，保留原计划历史实施状态。
- Modify: `docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md`：追加当前两条 normal-motion E2E 与组件契约的接替说明，保留过去 16/16。
- Modify: `docs/operations/website-chain-verification-acceptance.md`：保留 2026-08-20 历史表，新增 2026-08-21 的 14 项清单、组件契约、命令、计数、耗时与实际结果。
- Modify: `docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md`：只在全部门通过后把 Task 11 标为自动化通过，并保留外部状态边界。
- Modify: `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/progress.md`：追加 Task 11 职责减法、复审与完成提交范围，不重写 Task 1—10。
- Modify: `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/task-11-report.md`：保留首轮 14 passed / 2 failed，追加诊断、mutation、14/14 和最终门的实际证据；未通过时继续保持失败裁决。
- Track during execution: `docs/superpowers/plans/2026-08-21-website-gpu-e2e-responsibility-subtraction.md`：仅勾选实际完成且有证据的步骤。

---

### Task 1: 下沉测试职责并删除两条高层 E2E

**Files:**

- Modify: `apps/website/tests/magnetic-intro.test.tsx`
- Modify: `tests/e2e/website.spec.ts`
- Temporary mutation only, final zero diff: `apps/website/components/home-experience/config.ts`
- Temporary mutation only, final zero diff: `apps/website/components/website-experience/use-website-controller.ts`
- Temporary mutation only, final zero diff: `apps/website/components/home-experience/LiquidGlassHome.tsx`
- Test: `apps/website/tests/chapter-model.test.ts`
- Test: `apps/website/tests/website-controller.test.tsx`

**Interfaces:**

- Consumes: `LiquidGlassHome({ active, isPaused, reducedMotion, transitionProgress? })` 的现有公开组件接口、现有 `createWebGlContext()`、`gsap.quickTo`、`gsap.ticker.add/remove`、Testing Library `fireEvent`，以及 Playwright 既有 `page` fixture、`WEBSITE` 和 `LIQUID_HOME` 定位器。
- Produces: 一项组件契约，证明 1440×900、DPR 2 下后备缓冲和 viewport 为 1296×810，并证明 pointer move/down 的归一化坐标进入 `u_pointer` 与 `u_ripples[0]`；一项既有 reduced-motion E2E 内的全局 wheel 接线断言；精确 14 项 E2E 清单。
- Does not produce: 新生产导出、测试专用产品接口、新测试文件、新 E2E 条目、新 fixture 或 Playwright 配置。

- [x] **Step 1: 建立删除前基线与精确范围证据**

```powershell
git status --short
git diff -- apps/website/tests/magnetic-intro.test.tsx tests/e2e/website.spec.ts apps/website/components/home-experience/config.ts apps/website/components/website-experience/use-website-controller.ts apps/website/components/home-experience/LiquidGlassHome.tsx
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --list
rg -n "普通滚轮吸附、隔离惯性并重计新手势|液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针|减少动态效果直接进入稳定首页|390 离开再返回首页|390 宽度液态玻璃" tests/e2e/website.spec.ts
```

Expected: 列表仍为 16 项；两个退役标题、一个承接标题和两条保留的 390 标题各命中一次；记录任何既有差异并禁止覆盖。若三个临时生产文件已有非本任务差异，停止 mutation 并交由主智能体裁决。

- [x] **Step 2: 最小增强现有 WebGL 替身，使调用可按 uniform 名称观察**

在 `magnetic-intro.test.tsx` 保留一个 `createWebGlContext()`，不得建立第二套替身。对当前 helper 做以下精确结构调整：定义四个命名 spy；从 `objectMethods` 删除 `getUniformLocation`；从 `noopMethods` 删除 `uniform2f`、`uniform4fv`、`viewport`；在 Proxy 的现有分支前返回对应命名 spy；最后返回 context 与四个 spy。现有 Logo 失败用例只把 `webGl` 改为 `webGl.context`，行为不变：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { gsap } from 'gsap';

function createWebGlContext() {
  const viewport = vi.fn();
  const uniform2f = vi.fn();
  const uniform4fv = vi.fn();
  const getUniformLocation = vi.fn((_program: WebGLProgram, name: string) => (
    { name } as unknown as WebGLUniformLocation
  ));

  // 保留当前 constants、objectMethods、successfulMethods 与 noopMethods，
  // 仅按本步骤从两个 Set 删除四个已命名方法。
  const context = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (name === 'getUniformLocation') return getUniformLocation;
      if (name === 'viewport') return viewport;
      if (name === 'uniform2f') return uniform2f;
      if (name === 'uniform4fv') return uniform4fv;
      if (constants.has(name)) return 1;
      if (objectMethods.has(name)) return () => ({});
      if (successfulMethods.has(name)) return () => true;
      if (name === 'getAttribLocation') return () => 0;
      if (name === 'getProgramInfoLog' || name === 'getShaderInfoLog') return () => '';
      if (noopMethods.has(name)) return noop;
      throw new Error(`测试 WebGL 替身未定义接口：${name}`);
    }
  }) as WebGLRenderingContext;

  return { context, viewport, uniform2f, uniform4fv };
}
```

其中 Set 的完整成员以当前 helper 为事实来源，除上述四个方法的归属变化外不得增删；必须保留“未定义接口立即抛错”防线。

- [x] **Step 3: 在同一文件写唯一一项 DPR 与指针组件契约**

使用 360×225 作为内部点，使归一化坐标不是默认的 0.5/0.5。通过 `gsap.quickTo` 的现有入参直接写回目标对象，通过 `gsap.ticker.add` 捕获实际 render callback；不新增生产钩子。核心断言结构为：

```tsx
it('按性能比例建立缓冲区并把指针与点击写入 WebGL uniform', () => {
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('devicePixelRatio', 2);
  const webGl = createWebGlContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());

  vi.spyOn(gsap, 'quickTo').mockImplementation((target, property) => {
    const setter = vi.fn((value: number) => {
      Reflect.set(target, property, value);
      return {} as gsap.core.Tween;
    });
    return Object.assign(setter, {
      tween: {} as gsap.core.Tween
    }) as ReturnType<typeof gsap.quickTo>;
  });
  let renderFrame: Parameters<typeof gsap.ticker.add>[0] | undefined;
  vi.spyOn(gsap.ticker, 'add').mockImplementation((callback) => {
    renderFrame = callback;
    return callback;
  });

  render(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);
  const canvas = screen.getByLabelText('AI PET 互动液态玻璃画布');
  expect(canvas).toHaveProperty('width', 1296);
  expect(canvas).toHaveProperty('height', 810);
  expect(webGl.viewport).toHaveBeenCalledWith(0, 0, 1296, 810);

  fireEvent.pointerMove(window, { clientX: 360, clientY: 225 });
  fireEvent.pointerDown(canvas, { clientX: 360, clientY: 225 });
  expect(renderFrame).toBeDefined();
  renderFrame?.(1, 16, 1, 0.016);

  const pointerCall = webGl.uniform2f.mock.calls.find(([location]) => (
    (location as unknown as { name: string }).name === 'u_pointer'
  ));
  expect(pointerCall?.slice(1)).toEqual([0.25, 0.75]);
  const rippleCall = webGl.uniform4fv.mock.calls.find(([location]) => (
    (location as unknown as { name: string }).name === 'u_ripples[0]'
  ));
  const rippleValues = Array.from(rippleCall?.[1] as Float32Array);
  expect(rippleValues.slice(0, 3)).toEqual([0.25, 0.75, 0]);
  expect(rippleValues[3]).toBeCloseTo(1.65, 5);
});
```

实施时必须用 `uniform2f.mock.calls` 和 `uniform4fv.mock.calls` 的真实参数完成最后两项断言，不能只断言“被调用”。`u_pointer` 调用应为 `(_, 0.25, 0.75)`；`u_ripples[0]` 的第二参数转换为数组后，前三项必须精确等于 `[0.25, 0.75, 0]`，第四项使用 `toBeCloseTo(1.65, 5)` 处理 `Float32Array` 精度。不得新增 pointer/resize 监听、ticker 或资源卸载断言：原高 DPR E2E 未持有这些生命周期职责，释放/重建继续由 `website-fallback.test.tsx` 的 `运行期切换动态偏好会释放 WebGL 并可重新初始化` 承担。

- [x] **Step 4: 运行组件契约的当前行为 GREEN**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx
```

Expected: 新增组件契约与现有 Logo 回退测试全部通过。若 jsdom 无法稳定表达 uniform/ripple 数据流，停止；不得修改生产接口或增加等待。

- [x] **Step 5: 用 DPR mutation 取得预期 RED 并恢复**

用 `apply_patch` 只临时改动 `LiquidGlassHome.tsx` 的 1440 档：

```diff
-              ? 0.9
+              ? 1
```

运行：

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx
```

Expected: 新增用例因实际缓冲/viewport 变为 1440×900 而失败，失败点必须是 1296×810 契约。立即用反向 `apply_patch` 恢复 `0.9`，重跑同一命令必须 GREEN。

- [x] **Step 6: 用指针 mutation 取得预期 RED 并恢复**

用 `apply_patch` 只临时改动：

```diff
-      const handleCanvasPointerDown = (event: PointerEvent) => updatePointer(event, true);
+      const handleCanvasPointerDown = (event: PointerEvent) => updatePointer(event, false);
```

运行：

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx
```

Expected: pointer uniform 仍正确，但 ripple 保持未写入状态，使前三项精确断言或第四项强度容差断言 RED；失败原因必须指向点击数据未进入 `u_ripples[0]`。立即用反向 `apply_patch` 恢复 `true`，重跑同一命令必须 GREEN。

- [x] **Step 7: 向既有 reduced-motion E2E 合并最小全局 wheel 接线断言**

只在 `减少动态效果直接进入稳定首页` 的现有稳定首页断言之后、runtime error 最终断言之前增加一次真实 wheel 和一个章节断言；不得改名、复制或新增 E2E：

```tsx
await page.mouse.wheel(0, 360);
await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
```

该用例必须继续显式使用 `reducedMotion: 'reduce'`，不得启动 WebGL，也不得增加 `waitForTimeout`、poll、timeout 或重试。

- [x] **Step 8: 运行 reduced-motion 接线 GREEN，再用监听 mutation 取得 RED 并恢复**

```powershell
pnpm.cmd exec playwright test --config tests/playwright.website.config.ts --grep "减少动态效果直接进入稳定首页"
```

Expected: 1/1 通过。随后用 `apply_patch` 临时删除且只删除：

```tsx
registerWindowListener('wheel', handleWheel, { passive: false });
```

再次运行同一 E2E。Expected: 用例因 `data-active-chapter` 仍为 `home` 而 RED；不得接受构建、启动或其他断言失败作为敏感性证据。立即用反向 `apply_patch` 在原位置恢复同一注册，重跑必须 1/1 GREEN。

- [x] **Step 9: 用阈值 mutation 证明既有滚轮状态机测试敏感，再恢复 GREEN**

用 `apply_patch` 只临时改动 `config.ts`：

```diff
-    wheelUnlockDelta: 240,
+    wheelUnlockDelta: 360,
```

运行：

```powershell
pnpm.cmd --filter @myself/website test -- chapter-model.test.ts website-controller.test.tsx
```

Expected: 至少一项明确锁定 240px 解锁/重新累计的现有测试因输入未释放而 RED；编译或无关失败不算证据。立即用反向 `apply_patch` 恢复 `240`，重跑同一命令必须 GREEN。

- [x] **Step 10: 证明三个生产文件最终零差异，才进入删除门**

```powershell
git diff --exit-code -- apps/website/components/home-experience/config.ts apps/website/components/website-experience/use-website-controller.ts apps/website/components/home-experience/LiquidGlassHome.tsx
git diff -- apps/website/tests/magnetic-intro.test.tsx tests/e2e/website.spec.ts
```

Expected: 第一条退出 0 且无输出；第二条只含组件契约/替身增强和 reduced-motion wheel 接线。若第一条非零，先逐行恢复本 Task 的 mutation，绝不使用 Git 覆盖其他改动。

- [x] **Step 11: 精确删除两个完整 E2E 测试块**

从 `tests/e2e/website.spec.ts` 使用 `apply_patch` 删除：

```text
普通滚轮吸附、隔离惯性并重计新手势
液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针
```

第二块独占的 `browser`/`baseURL` 参数、`browser.newContext({ deviceScaleFactor: 2 })`、五点轨迹与 `finally context.close()` 必须随测试块完整消失。只在删除后产生零引用时删除局部孤儿；共用 fixture、helper、定位器和其他 14 项 E2E 不得修改。

- [x] **Step 12: 验证精确 14 项清单和退役标题零命中**

```powershell
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --list
rg -n "普通滚轮吸附、隔离惯性并重计新手势|液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针" tests/e2e/website.spec.ts
```

Expected: `--list` 精确列出 14 项；`rg` 退出 1 且零输出。不得新增计数常量或第二份运行清单。

- [x] **Step 13: 运行职责承接的定向 GREEN 门**

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx chapter-model.test.ts website-controller.test.tsx
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd exec playwright test --config tests/playwright.website.config.ts --grep "390 离开再返回首页|390 宽度液态玻璃|减少动态效果直接进入稳定首页"
```

Expected: 三个 Vitest 文件全部通过；typecheck 退出 0；三条保留/承接 E2E 为 3/3。若任一 390 用例失败，停止并检查真实 WebGL 接缝，不继续删除。

- [x] **Step 14: 运行完整 14 项网站 E2E**

```powershell
pnpm.cmd test:e2e:website
```

Expected: 生产构建成功且 14/14 通过。若出现同类 GPU stall，停止继续做 E2E 数量减法，保留产物路径和首错；不得更改 timeout、retry、worker、runner、fixture 或 trace。

- [x] **Step 15: 审查净减法、范围与格式**

```powershell
git diff --numstat -- apps/website/tests/magnetic-intro.test.tsx tests/e2e/website.spec.ts
git diff --check -- apps/website/tests/magnetic-intro.test.tsx tests/e2e/website.spec.ts
git diff --name-only
git diff --exit-code -- apps/website/components/home-experience/config.ts apps/website/components/website-experience/use-website-controller.ts apps/website/components/home-experience/LiquidGlassHome.tsx
```

Expected: 测试代码净减少至少 40 行；组件/替身新增不超过 60 行，reduced-motion E2E 新增不超过 4 行；格式检查无输出；正式差异不含产品文件、Playwright 配置、依赖、桌宠或其他受保护模块。

- [x] **Step 16: 独立复审 Task 1 后提交测试职责减法**

复审必须逐项核对：四项 mutation 的 RED 原因正确、三个生产文件零差异、14 项清单准确、两条保留 390 WebGL 接缝未被放宽、无配置/依赖/产品改动、净行数达标。通过后只提交两个测试文件：

```powershell
git add -- apps/website/tests/magnetic-intro.test.tsx tests/e2e/website.spec.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test: 下沉网站 GPU E2E 职责"
```

Expected: 暂存区只含上述两个文件；提交成功后工作树仍保留尚未提交的新规格/计划文档，不得一并暂存。

---

### Task 2: 同步当前事实来源并完成阶段 1 Task 11 裁决

**Files:**

- Modify: `docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md`
- Modify: `docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md`
- Modify: `docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md`
- Modify: `docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md`
- Modify: `docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md`
- Modify: `docs/operations/website-chain-verification-acceptance.md`
- Modify: `docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md`
- Modify: `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/progress.md`
- Modify: `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/task-11-report.md`
- Modify: `docs/superpowers/plans/2026-08-21-website-gpu-e2e-responsibility-subtraction.md`

**Interfaces:**

- Consumes: Task 1 的独立提交、四项 mutation RED/GREEN 记录、精确 14 项清单、3/3 定向 E2E 与 14/14 完整 E2E 证据，以及阶段 1 Task 1—10 已通过记录。
- Produces: 14 项当前单一事实来源、带日期/环境/命令/计数/耗时/首错的验收记录，以及只有在全部门实际通过时才成立的 Task 11“自动化通过”裁决。
- Preserves: 2026-08-20 的历史 44→16、16/16 结果和 2026-08-21 首轮 14 passed / 2 failed；外部 PostgreSQL、runner、Scanner、生产投稿与正式部署状态不变。

- [x] **Step 1: 按阶段 1 Task 11 固定顺序重新运行定向与包级门**

每条命令独立记录 exit、测试文件数、测试数和耗时；首错立即停止当前序列并写入 `task-11-report.md`，不得把未运行项记为通过。

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts submission-service.test.ts admin-service.test.ts api.test.ts cloudbase-postgres.test.ts
pnpm.cmd --filter @myself/website test -- admin-app.test.tsx admin-api-client.test.ts
node --test tools/cloudbase-migration-inventory.test.mjs
node --test tools/plan-cloudbase-migrations.test.mjs
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/cloudbase-api build
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd verify:cloudbase
pnpm.cmd test:cloudbase-tools
```

Expected: 全部退出 0；网站全测包含 Task 1 新增的唯一组件契约，CloudBase/Scanner/migration 工具结果不得用旧记录代替本次实际输出。

- [x] **Step 2: 运行网站链快速门、完整门和独立范围守卫**

```powershell
pnpm.cmd verify:web-chain:fast
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
```

Expected: 三条命令均退出 0；完整门内网站 E2E 为 14/14。若完整门失败，只记录实际完成的前置子门和首错，不声称 Task 11 通过。

- [x] **Step 3: 运行 migration dry-run 与当前入口负向检查**

```powershell
pnpm.cmd plan:cloudbase-migrations
rg -n "applyCloudBaseMigrations|readMigrationCredentials|executePGSql|node tools/apply-cloudbase-migrations.mjs" tools package.json docs/operations
rg -n "无需系统扫描|直接人工审核共享包|扫描异常即通过" apps/website apps/cloudbase-api docs/operations
```

Expected: dry-run 退出 0 且只输出既有脱敏计划；两条 `rg` 均退出 1 且零输出。不得连接数据库或执行 migration。

- [x] **Step 4: 用实际证据同步 2026-08-21 GPU E2E 规格与两个历史规格**

仅当 Step 1—3 全部通过时：

1. 在 `2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md` 把文档状态改为“已实施并自动化通过”，写入 Task 1 提交、14/14 和完整门实际结果；不写成 Chromium/GPU 阻塞已修复。
2. 在 `2026-08-20-website-e2e-responsibility-reduction-design.md` 顶部或第 3/6/7 节追加“当前 14 项由 2026-08-21 规格接替”的明确指针；保留原 16 项历史列表和 16/16 表述并标注其日期语境。
3. 在 `2026-08-20-website-liquid-glass-deep-module-reduction-design.md` 第 6/9 节追加：当前 normal-motion 真实浏览器专项只保留两条 390 E2E；1440 DPR 与指针数据流由 `magnetic-intro.test.tsx` 组件契约承接；历史四项与阶段 0 结果不改写。

若任一门未通过，2026-08-21 规格状态保持“待实施”或改为“实施中/验证失败”，不得把预期结果写成实际结果。

- [x] **Step 5: 同步两个历史计划与本计划的接替状态**

1. 在 `2026-08-20-website-e2e-responsibility-reduction.md` 保留历史 Task 1—4，追加 2026-08-21 接替段：当前 14 项、退役标题、组件/模型承接与最新验收链接。
2. 在 `2026-08-20-website-liquid-glass-deep-module-reduction.md` 保留历史 Task 4 的 16/16，追加当前两条 390 E2E 与组件 DPR/指针契约。
3. 只勾选本计划有实际命令和审查证据的 checkbox；任何失败项保持未勾选并附首错。

- [x] **Step 6: 更新网站链验收记录，不覆盖历史表**

在 `docs/operations/website-chain-verification-acceptance.md` 新增独立的 `2026-08-21 GPU E2E 职责再减法` 小节，精确记录：

- 四项 mutation 的目标、预期 RED 原因和恢复后的 GREEN；
- `magnetic-intro.test.tsx`、三文件定向 Vitest、typecheck、3/3 接缝 E2E、`--list` 14 项、退役标题零命中和完整 14/14 E2E；
- `verify:web-chain:fast`、`verify:web-chain`、`verify:web-chain:scope` 的实际 exit、计数和耗时；
- 测试文件的增加/删除/净行数；
- 2026-08-20 历史 16/16 继续有效于当日范围，当前清单由 2026-08-21 规格接替；
- 人工视觉与正式部署仍不在本次自动化结论内。

不得删除或修改历史失败轮次与历史 16/16 行。

- [x] **Step 7: 更新阶段 1 Task 11 计划、台账与报告**

1. `2026-08-15-website-publication-stopgap-and-migration-freeze.md`：只有 Step 1—3 全部退出 0 才把 Task 11 标为“自动化通过”，并引用本次职责减法规格、计划和验收记录。
2. `progress.md`：追加 Task 11 的职责减法提交、规格复审、代码质量复审与最终验证提交范围；不修改 Task 1—10。
3. `task-11-report.md`：保留原首轮 14 passed / 2 failed 表和未运行项，新增“职责层级裁决”“mutation 证据”“最终固定顺序复验”三节；每条命令写实际 exit、计数、耗时，失败时写首错和未运行项。
4. 无论成功或失败，报告末尾保持以下外部状态原文语义：CloudBase PostgreSQL 实际防线 `待阶段 2 开发环境确认`；事务型 migration runner `不在本次范围`；Scanner 协议、镜像与完整扫描证据 `不在本次范围`；共享包投稿生产开启 `不在本次范围，继续关闭`；正式部署与上线 `不在本次范围`。

- [x] **Step 8: 对最终文档差异重新运行范围与一致性检查**

```powershell
git diff --name-only
git diff --check
pnpm.cmd verify:web-chain:scope
rg -n "当前.*16 项|当前清单.*16|当前.*16/16" docs/superpowers/specs docs/superpowers/plans docs/operations .superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze
rg -n "普通滚轮吸附、隔离惯性并重计新手势|液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针" tests/e2e/website.spec.ts
git diff --exit-code -- apps/website/components/home-experience/config.ts apps/website/components/website-experience/use-website-controller.ts apps/website/components/home-experience/LiquidGlassHome.tsx tests/playwright.website.config.ts package.json pnpm-lock.yaml
```

Expected: 差异文件仅在本计划白名单；`git diff --check` 与范围守卫通过；“当前 16 项”零有效命中，允许保留明确标为 2026-08-20 历史结果的 16/16；两个退役标题在运行 E2E 零命中；产品、Playwright 配置、依赖与锁文件零差异。

- [x] **Step 9: 独立复审 Task 2 的规格覆盖与证据真实性**

复审者必须逐份核对十个当前事实来源，确认：

- 当前 14 项和历史 16 项有清晰日期/替代边界；
- Task 11 报告没有把首次失败、未运行项或外部待确认项改写为通过；
- 完整门的计数与耗时来自本轮命令输出，不复用旧值；
- 正式部署、数据库、Scanner 和生产投稿没有被扩大范围；
- `d602d87` 的职责迁移只修改两个测试文件；`aea8e03` 另修改两份精确 scope policy/test 文件；Task 2 当前工作树只包含八份受跟踪文档，且文档未触碰桌宠业务；
- 计划不存在未定义接口、类型名漂移、空泛步骤或未覆盖规格要求。

- [x] **Step 10: 提交规格、计划与验收证据**

独立复审与 `git diff --check` 均通过后，只暂存八份受跟踪文档；两份 `.superpowers/` 本地执行证据不得强制跟踪：

```powershell
git add -- docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md docs/superpowers/plans/2026-08-21-website-gpu-e2e-responsibility-subtraction.md docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md docs/operations/website-chain-verification-acceptance.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: 记录网站 GPU E2E 职责减法"
```

Expected: 暂存区只含精确列出的八份受跟踪文档；两份 ignored 本地证据保持未跟踪。若任何最终门失败，提交信息和文档状态必须明确为“验证失败/待继续”，不得使用完成语义。

实际提交：`9ef9117 docs: 记录网站 GPU E2E 职责减法`；包含八份受跟踪文档，两份 ignored 本地执行证据未强制跟踪。

## 完成裁决

只有以下条件同时成立，才可宣布本计划和阶段 1 Task 11 自动化通过：

1. 四项临时 mutation 均因指定断言取得 RED，恢复后同一目标命令 GREEN；三个生产文件最终零差异。
2. `magnetic-intro.test.tsx` 只有一项新增组件契约；reduced-motion 接线合并到既有用例；两个退役 E2E 运行标题零命中。
3. Playwright `--list` 精确 14 项，定向 3/3 与完整 14/14 E2E 通过，保留的两条 390 WebGL 接缝未放宽。
4. 网站/CloudBase/Scanner/migration 工具的阶段 1 固定顺序门、fast/full 网站链和范围守卫全部实际退出 0。
5. 测试代码净减少至少 40 行，无产品、依赖、Playwright 配置、timeout、retry、worker、runner、fixture、trace 或部署改动。
6. 十份当前事实来源一致，历史结果、首次失败和外部未验证状态均被保留。

任一条件不成立时，保持“验证失败”或“待验证”，记录首错并停止扩大减法范围。
