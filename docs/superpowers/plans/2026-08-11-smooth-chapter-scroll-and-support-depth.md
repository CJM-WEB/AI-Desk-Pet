# 官网章节平滑滚动、吸附与支持页按钮景深实施计划

> **面向智能体执行者：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实施。所有步骤使用复选框跟踪。

**目标：** 让官网滚轮章节切换连续平滑、稳定吸附并通过 800ms 惯性锁定保护停留，同时为最后一页左右两组重叠按钮增加真实 WebGL 景深模糊。

**架构：** 保留 `WebsiteExperience` 与各章节现有 `progress` 接口，在纯 `chapter-model` 中增加输入规范化、解锁累计和时间归一化阻尼；`useWebsiteController` 只负责浏览器事件、计时器与唯一动画帧循环。按钮景深继续由共享视觉模型决定 DOM 交互层级，并在现有液态玻璃着色器中根据活动索引派生柔化强度，不新增 React 逐帧状态。

**技术栈：** TypeScript、React 19、Next.js 15、Vitest、Testing Library、WebGL/GLSL、GSAP、Playwright。

## 全局约束

- 仅修改网站及网站测试，不触碰 `apps/desktop`、`packages/agent-core`、`packages/character-runtime`、`packages/character-assets`、`packages/file-tools`。
- 采用最小修改，不增加第三方依赖，不替换现有章节注册、业务内容或 API。
- 所有新增文档与结构性代码注释使用中文。
- 使用 TDD：每个行为先写失败测试、确认失败原因正确，再写最小实现。
- 滚轮停止检测固定为 120ms，吸附固定为 380ms，吸附后滚轮锁定固定为 800ms，新手势阈值固定为 240px。
- 显示进度使用 90ms 时间常数的指数阻尼，单帧时间差最多按 50ms 计算，目标差小于 0.0005 时直接收敛。
- 单次或连续巨大输入最多移动到稳定章节的相邻章节。
- 锁定只隔离滚轮惯性，不阻断键盘、导航按钮和独立触摸手势。
- 最后一页当前按钮模糊为 0px，中层为 2.5px，最深层为 5px；左右两组共用规则。
- `prefers-reduced-motion` 取消连续追赶和长缓动，但保留 800ms 滚轮隔离、240px 新手势阈值和最终静态景深。
- 每个实现或审查点最多投入 10 分钟；超时前必须记录已验证事实，并切换到更小复现、替代实现或更窄审查范围，不得直接跳过。

---

## 文件结构

**修改：**

- `apps/website/components/home-experience/types.ts`：扩展滚轮体验配置类型。
- `apps/website/components/home-experience/config.ts`：集中保存全部已确认参数。
- `apps/website/components/website-experience/chapter-model.ts`：增加纯滚轮模型、时间归一化阻尼与手势累计。
- `apps/website/components/website-experience/use-website-controller.ts`：接入目标进度、帧循环、停止吸附和滚轮锁定状态机。
- `apps/website/components/website-experience/donation/payment-model.ts`：增加循环按钮景深等级和模糊值。
- `apps/website/components/website-experience/support/SupportChapter.tsx`：把统一景深元数据接到左右按钮组。
- `apps/website/components/website-experience/support/support.module.css`：补充 DOM 降级层的透明度、模糊变量和同步过渡。
- `apps/website/components/home-experience/liquid-glass-shaders.ts`：对后层支持按钮文字和玻璃轮廓进行有限柔化采样。
- `apps/website/tests/chapter-model.test.ts`：覆盖纯滚轮状态和数学模型。
- `apps/website/tests/website-controller.test.tsx`：覆盖真实控制器计时与生命周期。
- `apps/website/tests/payment-model.test.ts`：覆盖按钮景深等级。
- `apps/website/tests/support-chapter.test.tsx`：覆盖左右按钮组的景深元数据和交互边界。
- `apps/website/tests/about-chapter.test.tsx`：扩展现有着色器源码契约断言。
- `tests/e2e/website.spec.ts`：增加真实滚轮、吸附锁定和末页景深浏览器验收。

不创建新的运行时模块；滚动纯模型继续放在已有 `chapter-model.ts`，避免只为少量函数增加目录层级。

---

### Task 1：建立纯滚轮输入、解锁和阻尼模型

**文件：**

- 修改：`apps/website/components/home-experience/types.ts`
- 修改：`apps/website/components/home-experience/config.ts`
- 修改：`apps/website/components/website-experience/chapter-model.ts`
- 测试：`apps/website/tests/chapter-model.test.ts`

**接口：**

- 产出 `WheelGestureState`、`normalizeWheelDelta`、`accumulateWheelUnlock`、`dampChapterProgress` 和 `hasChapterProgressSettled`。
- 后续控制器只调用这些纯函数，不自行重复阈值或阻尼公式。

- [ ] **Step 1：先写滚轮单位、解锁累计和阻尼失败测试**

在 `chapter-model.test.ts` 增加如下测试结构：

```ts
import {
  accumulateWheelUnlock,
  dampChapterProgress,
  hasChapterProgressSettled,
  normalizeWheelDelta
} from '../components/website-experience/chapter-model';

it('把像素、行和页面滚轮统一换算为像素并拒绝非有限值', () => {
  expect(normalizeWheelDelta(120, 0, 900)).toBe(120);
  expect(normalizeWheelDelta(3, 1, 900)).toBe(48);
  expect(normalizeWheelDelta(1, 2, 900)).toBe(900);
  expect(normalizeWheelDelta(Number.NaN, 0, 900)).toBe(0);
});

it('同方向累计到 240px 才释放且只返回超过阈值的余量', () => {
  const first = accumulateWheelUnlock({ direction: 0, accumulated: 0 }, 120, 240);
  expect(first).toEqual({ direction: 1, accumulated: 120, releasedDelta: 0 });
  const second = accumulateWheelUnlock(first, 120, 240);
  expect(second).toEqual({ direction: 1, accumulated: 240, releasedDelta: 0 });
  const third = accumulateWheelUnlock(second, 60, 240);
  expect(third.releasedDelta).toBe(60);
});

it('解锁累计方向反转时清空旧方向并从新方向重新计算', () => {
  const result = accumulateWheelUnlock(
    { direction: 1, accumulated: 180 },
    -100,
    240
  );
  expect(result).toEqual({ direction: -1, accumulated: 100, releasedDelta: 0 });
});

it('按帧间时间指数追赶目标并限制严重掉帧的时间差', () => {
  const normal = dampChapterProgress(0, 1, 16, 90, 50);
  const delayed = dampChapterProgress(0, 1, 500, 90, 50);
  expect(normal).toBeGreaterThan(0);
  expect(normal).toBeLessThan(1);
  expect(delayed).toBeCloseTo(dampChapterProgress(0, 1, 50, 90, 50));
  expect(hasChapterProgressSettled(0.9996, 1, 0.0005)).toBe(true);
});
```

- [ ] **Step 2：运行目标测试并确认以缺少导出失败**

运行：

```powershell
pnpm.cmd --filter @myself/website test -- chapter-model.test.ts
```

预期：FAIL，错误明确指向新增函数尚未导出，而不是现有测试或环境故障。

- [ ] **Step 3：扩展集中配置类型和值**

在 `ExperienceConfig['progress']` 与 `EXPERIENCE_CONFIG.progress` 增加完全一致的字段：

```ts
wheelIdleMs: 120,
wheelLockMs: 800,
wheelUnlockDelta: 240,
snapDurationMs: 380,
followTimeConstantMs: 90,
maxFrameDeltaMs: 50,
settleEpsilon: 0.0005
```

保留现有 `wheelScale`；删除实现后不再使用的进度参数前必须先用 `rg` 证明没有消费者。

- [ ] **Step 4：实现最小纯模型**

在 `chapter-model.ts` 增加：

```ts
export type WheelDirection = -1 | 0 | 1;

export interface WheelGestureState {
  direction: WheelDirection;
  accumulated: number;
}

export interface WheelUnlockResult extends WheelGestureState {
  releasedDelta: number;
}

export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight);
  return deltaY;
}

export function accumulateWheelUnlock(
  state: WheelGestureState,
  delta: number,
  threshold: number
): WheelUnlockResult {
  const direction = Math.sign(delta) as WheelDirection;
  if (direction === 0) return { ...state, releasedDelta: 0 };
  if (threshold <= 0) {
    return { direction, accumulated: 0, releasedDelta: delta };
  }
  const accumulated = direction === state.direction
    ? state.accumulated + Math.abs(delta)
    : Math.abs(delta);
  const released = Math.max(0, accumulated - threshold);
  return {
    direction,
    accumulated: Math.min(accumulated, threshold),
    releasedDelta: direction * released
  };
}

export function dampChapterProgress(
  current: number,
  target: number,
  deltaMs: number,
  timeConstantMs: number,
  maximumDeltaMs: number
): number {
  const safeDelta = Math.min(maximumDeltaMs, Math.max(0, deltaMs));
  const alpha = 1 - Math.exp(-safeDelta / Math.max(1, timeConstantMs));
  return current + (target - current) * alpha;
}

export function hasChapterProgressSettled(
  current: number,
  target: number,
  epsilon: number
): boolean {
  return Math.abs(target - current) < epsilon;
}
```

`accumulateWheelUnlock` 对零值不改变状态；`threshold <= 0` 时立即释放完整输入；所有累计量保存绝对值，`releasedDelta` 保留方向。

- [ ] **Step 5：运行纯模型与类型检查**

```powershell
pnpm.cmd --filter @myself/website test -- chapter-model.test.ts
pnpm.cmd --filter @myself/website typecheck
```

预期：目标测试和类型检查 PASS。

- [ ] **Step 6：提交纯模型**

```powershell
git add -- apps/website/components/home-experience/types.ts apps/website/components/home-experience/config.ts apps/website/components/website-experience/chapter-model.ts apps/website/tests/chapter-model.test.ts
git commit -m "feat(website): 建立平滑滚轮纯模型"
```

---

### Task 2：接入目标进度、自动吸附和 800ms 滚轮锁定

**文件：**

- 修改：`apps/website/components/website-experience/use-website-controller.ts`
- 测试：`apps/website/tests/website-controller.test.tsx`

**接口：**

- 消费 Task 1 的纯函数和 `EXPERIENCE_CONFIG.progress` 参数。
- 保持 `WebsiteControllerResult` 对外签名不变。
- 产出内部滚轮模式 `resting | locked | arming | tracking`，不得导出为跨组件状态。

- [ ] **Step 1：把旧的“滚轮直接写显示进度”测试改成失败的新契约**

在 `website-controller.test.tsx` 使用 fake timers 和已有动画帧桩增加以下断言：

```ts
it('滚轮先更新目标且显示进度通过动画帧连续追赶', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
  installAnimationFrameTimers();
  render(<ControllerHarness staticFallback={false} />);
  const state = screen.getByTestId('controller-state');

  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  expect(state.dataset.progress).toBe('0.0000');
  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  act(() => { vi.advanceTimersByTime(16); });
  expect(Number(state.dataset.progress)).toBeGreaterThan(0);
  expect(Number(state.dataset.progress)).toBeLessThan(0.132);
});

it('停止 120ms 后用 380ms 吸附并锁住后续 800ms 惯性', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
  installAnimationFrameTimers();
  render(<ControllerHarness staticFallback={false} />);
  const state = screen.getByTestId('controller-state');

  for (let index = 0; index < 7; index += 1) {
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(16); });
  }
  act(() => { vi.advanceTimersByTime(120 + 400); });
  expect(state.dataset.index).toBe('1');
  expect(state.dataset.progress).toBe('1.0000');

  fireEvent.wheel(window, { deltaY: 600, deltaMode: 0 });
  act(() => { vi.advanceTimersByTime(700); });
  expect(state.dataset.index).toBe('1');
  expect(state.dataset.progress).toBe('1.0000');
});

it('锁定结束后必须静止并重新累计 240px 才能离开', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
  installAnimationFrameTimers();
  render(<ControllerHarness staticFallback={false} />);
  const state = screen.getByTestId('controller-state');

  fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
  act(() => { vi.advanceTimersByTime(400); });
  act(() => { vi.advanceTimersByTime(700); });
  fireEvent.wheel(window, { deltaY: 40, deltaMode: 0 });
  act(() => { vi.advanceTimersByTime(220); });

  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  act(() => { vi.advanceTimersByTime(32); });
  expect(state.dataset.progress).toBe('1.0000');

  fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
  act(() => { vi.advanceTimersByTime(32); });
  expect(Number(state.dataset.progress)).toBeGreaterThan(1);
});
```

同步调整依赖旧行为的断言：不再断言“滚轮不自动吸附”，改为断言停止后自动吸附。

- [ ] **Step 2：运行控制器测试并确认旧实现失败**

```powershell
pnpm.cmd --filter @myself/website test -- website-controller.test.tsx
```

预期：FAIL，失败集中在显示进度立即变化、没有自动吸附或没有锁定。

- [ ] **Step 3：建立目标进度与唯一帧循环**

在控制器中保留 `progressRef` 表示显示进度，并新增：

```ts
type WheelMode = 'resting' | 'locked' | 'arming' | 'tracking';

const targetProgressRef = useRef(0);
const wheelModeRef = useRef<WheelMode>('resting');
const wheelGestureRef = useRef<WheelGestureState>({ direction: 0, accumulated: 0 });
const progressFrameRef = useRef<number | null>(null);
const lastFrameAtRef = useRef<number | null>(null);
const wheelIdleTimerRef = useRef<number | null>(null);
const wheelLockTimerRef = useRef<number | null>(null);
const lastWheelAtRef = useRef<number | null>(null);
```

帧循环只做三件事：按实际 `deltaMs` 调用 `dampChapterProgress`、提交显示进度、在误差小于 0.0005 时精确写入目标并停止。任何路径不得同时启动第二个进度动画帧。

- [ ] **Step 4：接入滚轮准备、跟随、停止和吸附状态**

`handleWheel` 的顺序必须固定：

1. 局部输入或暂停直接返回。
2. `preventDefault`，调用 `normalizeWheelDelta(event.deltaY, event.deltaMode, window.innerHeight)`。
3. 记录最后输入时间。
4. `locked` 时只记录惯性，不累计、不移动。
5. `resting`/`arming` 时调用 `accumulateWheelUnlock`；没有余量则保持整数章节。
6. 有释放余量时进入 `tracking`，把余量乘 `wheelScale` 后写入受相邻章节限制的目标进度。
7. `tracking` 的后续输入直接更新目标进度，并重置 120ms 停止计时。
8. 停止计时触发后，以目标进度的最近整数启动 380ms 吸附。

吸附结束时同时精确提交 `progress`、`targetProgress` 和 `settledIndex`，随后进入滚轮 `locked`。

- [ ] **Step 5：实现锁定结束与静止证明**

800ms 计时结束后：

- 如果距最后滚轮输入已达到 120ms，进入 `arming` 并清空累计。
- 如果惯性仍在发送，则仅安排“最后输入后 120ms”的一次检查。
- 键盘、导航按钮和触摸调用 `goToAdjacent` 时可以打断滚轮锁定并执行明确导航；完成后重新开始 800ms 滚轮锁定。

- [ ] **Step 6：统一暂停、回退和卸载清理**

现有 `teardown`、失焦和静态回退路径必须额外清理：

- `progressFrameRef`
- `wheelIdleTimerRef`
- `wheelLockTimerRef`
- `lastFrameAtRef`
- `wheelGestureRef`

恢复时将目标与显示进度收敛到最近章节，不能继续消费旧惯性。

- [ ] **Step 7：运行控制器、回退和类型检查**

```powershell
pnpm.cmd --filter @myself/website test -- website-controller.test.tsx website-fallback.test.tsx motion-disabled-contract.test.tsx chapter-model.test.ts
pnpm.cmd --filter @myself/website typecheck
```

预期：全部 PASS；无未清理计时器或 React 卸载后更新警告。

- [ ] **Step 8：提交控制器行为**

```powershell
git add -- apps/website/components/website-experience/use-website-controller.ts apps/website/tests/website-controller.test.tsx
git commit -m "feat(website): 平滑章节滚动并增加吸附锁定"
```

---

### Task 3：建立左右按钮组统一景深模型和 DOM 降级层

**文件：**

- 修改：`apps/website/components/website-experience/donation/payment-model.ts`
- 修改：`apps/website/components/website-experience/support/SupportChapter.tsx`
- 修改：`apps/website/components/website-experience/support/support.module.css`
- 测试：`apps/website/tests/payment-model.test.ts`
- 测试：`apps/website/tests/support-chapter.test.tsx`

**接口：**

- 新增 `paymentDepthIndex(index, active, length): number`。
- 修改 `paymentCardVisual(offset, depthIndex)`，返回已有字段以及 `blurPx`。
- 左右两组都输出 `data-depth-index`、`data-blur-px` 和对应 CSS 自定义属性。

- [ ] **Step 1：先写景深模型失败测试**

```ts
it('按循环前后顺序给三个按钮分配清晰、中层和最深层', () => {
  expect(paymentDepthIndex(0, 0, 3)).toBe(0);
  expect(paymentDepthIndex(1, 0, 3)).toBe(1);
  expect(paymentDepthIndex(2, 0, 3)).toBe(2);
  expect(paymentCardVisual(0, 0).blurPx).toBe(0);
  expect(paymentCardVisual(1, 1).blurPx).toBe(2.5);
  expect(paymentCardVisual(-1, 2).blurPx).toBe(5);
});
```

在 `support-chapter.test.tsx` 断言反馈和付款两组均包含 `[data-depth-index="0"]`、`1`、`2`，且只有深度 0 的按钮具有活动语义并能在点击时执行当前操作。

- [ ] **Step 2：运行模型和组件测试确认失败**

```powershell
pnpm.cmd --filter @myself/website test -- payment-model.test.ts support-chapter.test.tsx
```

预期：FAIL，新增函数或数据属性不存在。

- [ ] **Step 3：实现统一景深模型**

```ts
export function paymentDepthIndex(
  index: number,
  active: number,
  length: number
): number {
  return wrapPaymentIndex(index - active, length);
}

export function paymentCardVisual(offset: number, depthIndex = Math.abs(offset)) {
  const distance = Math.abs(offset);
  const scale = distance === 0 ? 1 : Math.max(0.72, 0.94 - distance * 0.06);
  return {
    translateYPercent: offset * 54,
    scale: Number(scale.toFixed(2)),
    opacity: distance === 0 ? 1 : Math.max(0.38, 0.78 - distance * 0.12),
    zIndex: distance === 0 ? 10 : Math.max(1, 8 - distance),
    activatable: distance === 0,
    blurPx: depthIndex === 0 ? 0 : depthIndex === 1 ? 2.5 : 5
  };
}
```

长度不是 3 时，深度 2 及以上统一限制为 5px，避免未来增加选项后产生无限模糊。

- [ ] **Step 4：把同一模型接到左右按钮组**

两处 `map` 都先计算：

```ts
const depthIndex = paymentDepthIndex(index, activeIndex, items.length);
const visual = paymentCardVisual(offset, depthIndex);
```

按钮输出：

```tsx
data-depth-index={depthIndex}
data-blur-px={visual.blurPx}
style={{
  '--support-button-offset': `${visual.translateYPercent}%`,
  '--support-button-scale': visual.scale,
  '--support-button-opacity': visual.opacity,
  '--support-button-blur': `${visual.blurPx}px`,
  zIndex: visual.zIndex
} as CSSProperties}
```

CSS 将透明 DOM 降级层的 `opacity`、`filter` 与现有 `transform` 一起纳入 420ms 过渡；不得让模糊元素获得新的点击能力。WebGL 可用时真正视觉仍由 Task 4 负责。

- [ ] **Step 5：运行景深模型、组件和无障碍回归**

```powershell
pnpm.cmd --filter @myself/website test -- payment-model.test.ts support-chapter.test.tsx motion-disabled-contract.test.tsx
pnpm.cmd --filter @myself/website typecheck
```

预期：全部 PASS；减少动态效果时过渡时间仍为 0s。

- [ ] **Step 6：提交景深模型和组件接线**

```powershell
git add -- apps/website/components/website-experience/donation/payment-model.ts apps/website/components/website-experience/support/SupportChapter.tsx apps/website/components/website-experience/support/support.module.css apps/website/tests/payment-model.test.ts apps/website/tests/support-chapter.test.tsx
git commit -m "feat(website): 增加支持页按钮景深层级"
```

---

### Task 4：在液态玻璃着色器中实现真实按钮柔化

**文件：**

- 修改：`apps/website/components/home-experience/liquid-glass-shaders.ts`
- 测试：`apps/website/tests/about-chapter.test.tsx`

**接口：**

- 消费已有 `u_supportFeedbackActive` 和 `u_supportPaymentActive`，不增加 React 状态或新 uniform。
- 产出 GLSL 帮助函数 `supportButtonDepthRank`、`supportButtonBlurPx` 和有限多点文字采样。

- [ ] **Step 1：先写着色器契约失败测试**

在现有读取 `liquid-glass-shaders.ts` 的测试中增加：

```ts
expect(shaderSource).toContain('float supportButtonDepthRank(float index)');
expect(shaderSource).toContain('float supportButtonBlurPx(float index)');
expect(shaderSource).toContain('supportBlurStep');
expect(shaderSource).toContain('supportButtonBlurPx(supportIndex)');
```

同时断言采样次数为固定常数，不允许基于运行时模糊量创建无界循环。

- [ ] **Step 2：运行着色器契约测试确认失败**

```powershell
pnpm.cmd --filter @myself/website test -- about-chapter.test.tsx
```

预期：FAIL，缺少景深帮助函数。

- [ ] **Step 3：实现连续景深等级**

在 `supportButtonPhase` 附近增加帮助函数。稳定索引时深度必须精确映射为 0、1、2；活动索引由 GSAP 连续变化时，使用相位和 `smoothstep` 在等级之间过渡，不能在循环边界突然闪变。

```glsl
float supportButtonDepthRank(float index) {
  float phase = supportButtonPhase(index);
  float frontAmount = clamp((cos(phase) + 0.5) / 1.5, 0.0, 1.0);
  float backOrder = smoothstep(-0.05, 0.05, sin(phase));
  return (1.0 - frontAmount) * mix(1.0, 2.0, backOrder);
}

float supportButtonBlurPx(float index) {
  float depth = supportButtonDepthRank(index);
  return depth <= 0.001 ? 0.0 : mix(2.5, 5.0, clamp(depth - 1.0, 0.0, 1.0));
}
```

若该公式在稳定索引的测试证据中不能得到 0、2.5、5，则先修正纯公式，不通过扩大测试容差掩盖错误。

- [ ] **Step 4：柔化后层文字且保持当前文字清晰**

增加固定五点采样帮助函数：

```glsl
vec4 sampleSupportText(vec2 uv, float blurPx) {
  vec4 sharp = texture2D(u_supportTextTexture, uv);
  if (blurPx <= 0.001) return sharp;
  vec2 supportBlurStep = vec2(blurPx) / u_resolution;
  vec4 softened = sharp * 0.40;
  softened += texture2D(u_supportTextTexture, uv + vec2(supportBlurStep.x, 0.0)) * 0.15;
  softened += texture2D(u_supportTextTexture, uv - vec2(supportBlurStep.x, 0.0)) * 0.15;
  softened += texture2D(u_supportTextTexture, uv + vec2(0.0, supportBlurStep.y)) * 0.15;
  softened += texture2D(u_supportTextTexture, uv - vec2(0.0, supportBlurStep.y)) * 0.15;
  return softened;
}
```

对每个支持按钮：

- `blurPx === 0` 时使用原始单次 `texture2D` 结果。
- 后层调用 `sampleSupportText(supportSampleUv, supportButtonBlurPx(supportIndex))`。
- 继续乘现有 `supportSourceMask`、`supportMask` 和 `u_supportTransition`，不得把文字采样扩散到其他按钮。

- [ ] **Step 5：柔化后层玻璃轮廓而不模糊整个画布**

增加只在按钮轮廓附近生效的帮助函数：

```glsl
float supportButtonEdgeBlur(vec2 pixel) {
  float nearestSdf = 100000.0;
  float nearestBlur = 0.0;
  float radius = min(u_resolution.x, u_resolution.y) * 0.060;
  for (int index = 0; index < 6; index++) {
    float supportIndex = float(index);
    float scale = supportButtonScale(supportIndex);
    float candidate = roundedBoxSdf(
      pixel - supportButtonCenter(supportIndex),
      u_resolution * vec2(0.145, 0.085) * scale,
      radius * scale
    );
    if (candidate < nearestSdf) {
      nearestSdf = candidate;
      nearestBlur = supportButtonBlurPx(supportIndex);
    }
  }
  return nearestSdf < 24.0 ? nearestBlur : 0.0;
}
```

计算全局 `glassMask` 时，仅在 `u_supportTransition` 生效且像素接近支持按钮时，把 `supportButtonEdgeBlur(pixel)` 加入原 `smoothstep` 两侧宽度。当前按钮得到 0，背景、英雄字和其他章节玻璃继续使用原清晰路径。

不得对最终 `color` 或整个 framebuffer 做全屏模糊。

- [ ] **Step 6：运行着色器、支持页和构建验证**

```powershell
pnpm.cmd --filter @myself/website test -- about-chapter.test.tsx support-chapter.test.tsx payment-model.test.ts
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/website build
```

预期：全部 PASS，GLSL 在生产构建中可编译。

- [ ] **Step 7：提交 WebGL 景深**

```powershell
git add -- apps/website/components/home-experience/liquid-glass-shaders.ts apps/website/tests/about-chapter.test.tsx
git commit -m "feat(website): 渲染支持页按钮景深模糊"
```

---

### Task 5：补充浏览器验收并执行完整网站门禁

**文件：**

- 修改：`tests/e2e/website.spec.ts`

**接口：**

- 不新增生产接口。
- 使用现有 `data-progress`、`data-active-chapter`、`data-depth-index` 和 `data-blur-px` 形成稳定浏览器证据。

- [ ] **Step 1：增加真实滚轮平滑与吸附 E2E**

新增桌面视口测试，避免仅检查最终章节：

```ts
test('普通滚轮连续追赶、吸附并隔离 800ms 惯性', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  const experience = page.locator(WEBSITE);

  // 三次 120px：前两次只完成 240px 解锁，第三次产生目标余量。
  await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, 120);
  expect(await readProgress(page)).toBe(0);
  await page.mouse.wheel(0, 120);

  const first = await readProgress(page);
  await page.waitForTimeout(32);
  const second = await readProgress(page);
  expect(second).toBeGreaterThan(first);

  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 120);
  }
  await expect.poll(() => experience.getAttribute('data-active-chapter'), {
    timeout: 1_500
  }).toBe('about');
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(700);
  await expect(experience).toHaveAttribute('data-active-chapter', 'about');
});
```

实际测试使用 `expect.poll` 代替固定等待最终状态；仅 32ms 的中间帧采样可以保留，用于证明进度不是事件内瞬跳。

- [ ] **Step 2：增加 800ms 后新手势阈值 E2E**

吸附后等待超过 800ms 和 120ms 静止期，再发送两次 120px，章节与显示进度必须保持整数；第三次输入后显示进度才开始离开。测试同时覆盖反向滚轮重新累计和巨大输入不跨章。

- [ ] **Step 3：增加左右按钮组景深 E2E 与截图**

进入 `feedback` 章节后分别读取两组按钮：

- 每组深度索引为 0、1、2。
- 对应 `data-blur-px` 为 0、2.5、5。
- 点击后层按钮只切换活动项，第二次点击活动项才打开业务弹窗。
- 切换后新的活动按钮模糊为 0，旧活动按钮进入后层。

在 1440×900 保存末页稳定态和切换中间态截图到现有 `tests/.playwright-output/website/screenshots` 证据目录；截图不提交仓库，除非仓库现有规则明确追踪该目录。

- [ ] **Step 4：先运行新增 E2E，修复测试本身的确定性问题**

```powershell
pnpm.cmd test:e2e:website -- --grep "滚轮|景深"
```

预期：新增测试 PASS。若浏览器服务器启动超过 10 分钟，读取现有日志并切换为单测试、单 worker 或已构建静态服务器，不在同一启动命令上重复等待。

- [ ] **Step 5：执行完整网站验证门禁**

```powershell
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website build
pnpm.cmd test:e2e:website
git diff --check
```

预期：类型检查、全部网站单元测试、生产构建、完整网站 E2E 和格式检查全部通过。

- [ ] **Step 6：检查严格范围和删除旧行为残留**

```powershell
git status --short
git diff --stat HEAD~4..HEAD
rg -n "SNAP_DURATION_MS|不自动吸附|直接驱动连续进度" apps/website
```

预期：没有桌宠或桌面端文件变化；旧的 300ms 常量和“滚轮不自动吸附”契约已经删除，未保留重复滚轮实现。

- [ ] **Step 7：提交浏览器验收**

```powershell
git add -- tests/e2e/website.spec.ts
git commit -m "test(website): 验收滚轮吸附与按钮景深"
```

---

## 最终审查门

完成五个任务后必须进行两阶段独立审查：

1. 规格符合性：逐条对照 `docs/superpowers/specs/2026-08-11-smooth-chapter-scroll-and-support-depth-design.md`。
2. 代码质量：检查计时器所有权、动画帧唯一性、状态闭包、GLSL 性能、无障碍与最小修改原则。

任何 P0/P1 问题必须回到对应任务修复并重跑相关测试；P2 问题若确实不影响本规格，也必须记录原因，不能静默跳过。
