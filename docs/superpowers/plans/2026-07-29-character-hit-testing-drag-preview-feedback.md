# AI Pet 角色命中、拖拽、实时预览与提示层修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让透明桌宠仅在当前帧可见像素上接收鼠标，以左键安全拖拽、右键打开菜单，并让角色工作台真正实时预览草稿和使用右上角临时提示层。

**Architecture:** 先把 Pixi 当前帧、坐标变换和 Alpha 命中抽成可测试端口，再通过受限 Main IPC 管理鼠标穿透和拖拽会话。工作台复用同一 Pixi 动作场景，以草稿源素材适配器驱动预览；保存状态灯与临时提示队列分离。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、PixiJS、Zustand、Zod、Vitest、Testing Library、Playwright。

## Global Constraints

- 目标平台为 Windows 10/11。
- Alpha 必须严格满足 `alpha > 16` 才命中；`0..16` 均穿透。
- 左键只拖拽，不打开聊天，不触发单击或双击扩展状态。
- 右键只有命中可见像素时打开现有 Main 菜单。
- 扩展状态协议和模块保留，本计划不继续开发左键扩展触发。
- 自动保存成功只更新绿灯和“草稿已保存”；失败显示红灯并进入错误提示队列。
- 成功/信息提示 3 秒，警告/错误提示 6 秒；悬停或焦点进入暂停剩余倒计时。
- 实时预览直接消费当前内存草稿，不调用保存、编译、发布、启用或真实文件工具。
- Renderer 不获得任意窗口句柄、任意目标位置或任意本地路径。
- 新增文档和结构性代码注释使用中文。
- 不新增运行时依赖；复用现有 Electron、PixiJS、Zustand、Zod 和测试工具。
- 每个 Git 暂存或提交步骤执行前都必须取得用户明确授权；未获授权时停在已验证工作树状态。

---

## 文件结构

### 新建文件

- `apps/desktop/src/renderer/src/characters/player/character-alpha-hit-tester.ts`：纯坐标换算、Alpha 缓存数据结构和当前帧命中。
- `apps/desktop/src/shared/pet-window-interaction.ts`：窗口交互 IPC 输入 Schema 与 DTO。
- `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`：Main 鼠标穿透、拖拽会话、超时和清理。
- `apps/desktop/src/renderer/src/pet/pet-interaction-controller.ts`：Renderer 命中协调、左键拖拽和右键意图。
- `apps/desktop/src/renderer/src/characters/workshop/WorkshopToastLayer.tsx`：提示队列、计时暂停和无障碍状态。
- `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`：草稿动作 Pixi 预览编排。
- `apps/desktop/src/renderer/src/characters/workshop/draft-preview-resource-cache.ts`：源素材读取、Blob URL 和资源释放。
- `apps/desktop/tests/character-alpha-hit-tester.test.ts`：Alpha 阈值与坐标变换。
- `apps/desktop/tests/pet-window-interaction-controller.test.ts`：Main 拖拽和穿透。
- `apps/desktop/tests/pet-interaction-controller.test.ts`：Renderer 指针状态机。
- `apps/desktop/tests/workshop-toast-layer.dom.test.tsx`：提示计时和交互。
- `apps/desktop/tests/draft-character-preview.test.tsx`：草稿预览与异步修订。

### 修改文件

- `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`：抽取共享动作场景资源入口，暴露当前帧命中端口。
- `apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`：发布命中端口及帧变化通知。
- `apps/desktop/src/renderer/src/pet/PetView.tsx`：移除打开聊天按钮，接入桌宠交互控制器。
- `apps/desktop/src/renderer/src/characters/workshop/PreviewControls.tsx`：改为受控组件。
- `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`：接入实时预览和提示层。
- `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`：提示队列、自动保存状态与显式操作反馈。
- `apps/desktop/src/renderer/src/styles.css`：删除旧矩形拖拽区，增加角色交互光标。
- `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`：浮动提示层和真实预览画布。
- `apps/desktop/src/shared/ipc-channels.ts`：固定窗口交互通道。
- `apps/desktop/src/shared/myself-api.ts`：受限桌宠窗口交互 API。
- `apps/desktop/src/preload/index.ts`：严格转发固定交互命令。
- `apps/desktop/src/main/ipc/register-ipc.ts`：注册并校验桌宠交互 IPC。
- `apps/desktop/src/main/index.ts`：创建控制器、接入菜单、运动服务和生命周期清理。
- `apps/desktop/src/main/windows/window-manager.ts`：初始鼠标穿透配置接线。
- `apps/desktop/tests/pixi-character-player.test.ts`：共享动作场景和命中快照。
- `apps/desktop/tests/character-player.test.tsx`：命中端口生命周期。
- `apps/desktop/tests/pet-view.test.tsx`：左键不打开聊天、交互接线。
- `apps/desktop/tests/character-action-editor.dom.test.tsx`：受控预览控制。
- `apps/desktop/tests/character-workshop-components.test.tsx`：真实预览与提示层结构。
- `apps/desktop/tests/character-workshop-store.test.ts`：保存反馈分离。
- `apps/desktop/tests/preload-api.test.ts`：新增 API 仍保持白名单。
- `apps/desktop/tests/window-security.test.ts`：透明窗口与初始穿透。
- `apps/desktop/tests/character-motion-controller.test.ts`：用户拖拽与自动运动所有权。
- `tests/e2e/desktop.spec.ts`：真实工作台预览、菜单和拖拽闭环。
- `docs/operations/character-workshop-acceptance.md`：新增人工鼠标穿透、拖拽和预览验收项。

---

### Task 1: 抽取共享 Pixi 动作场景资源入口

**Files:**
- Modify: `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- Test: `apps/desktop/tests/pixi-character-player.test.ts`

**Interfaces:**
- Consumes: `ActionClip`、`DraftActionClip`、现有 `CharacterAssetBundle`。
- Produces:

```ts
export type CharacterVisualAssets = ReadonlyMap<string, string>;

export interface PixiCharacterScene {
  loadAssets(assets: CharacterVisualAssets): Promise<void>;
  showAction(
    action: ActionClip | DraftActionClip,
    options: {
      direction: 'left' | 'right';
      motionMode: CharacterMotionMode;
      frameIndex?: number;
      speed: number;
      loop: boolean;
    }
  ): void;
  getCurrentFrame(): {
    action: ActionClip | DraftActionClip;
    frameIndex: number;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
  subscribeFrame(listener: () => void): () => void;
  destroy(): void;
}

export type PixiCharacterSceneFactory = (
  container: HTMLElement
) => Promise<PixiCharacterScene>;
```

- [ ] **Step 1: 为资源入口和帧订阅写失败测试**

```ts
test('共享动作场景按资源映射加载并在切帧时通知订阅者', async () => {
  const scene = await createSceneDouble();
  await scene.loadAssets(new Map([['idle-source', 'blob:idle']]));
  const unsubscribe = scene.subscribeFrame(frameChanged);

  scene.showAction(idleAction, {
    direction: 'right',
    motionMode: 'animated',
    speed: 1,
    loop: true
  });
  advancePixiTickerToFrame(1);

  expect(scene.getCurrentFrame()?.frameIndex).toBe(1);
  expect(frameChanged).toHaveBeenCalled();
  unsubscribe();
});
```

- [ ] **Step 2: 运行测试并确认因接口不存在而失败**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts
```

Expected: FAIL，提示 `loadAssets`、`showAction` 或 `subscribeFrame` 未定义。

- [ ] **Step 3: 抽取最小共享动作场景**

```ts
export type CharacterVisualAssets = ReadonlyMap<string, string>;

class BrowserPixiCharacterScene implements PixiCharacterScene {
  private readonly frameListeners = new Set<() => void>();

  async loadAssets(assets: CharacterVisualAssets): Promise<void> {
    // 只加载动作帧实际引用的白名单 Blob URL。
    await this.replaceBaseTextures(assets);
  }

  subscribeFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private notifyFrameChanged(): void {
    for (const listener of [...this.frameListeners]) listener();
  }
}
```

保留 `PixiCharacterPlayer.load(manifest, assets)` 作为运行时适配器，由它把 `CharacterAssetBundle.atlasUrls` 转为 `CharacterVisualAssets`，避免修改所有运行时调用方。

- [ ] **Step 4: 运行 Pixi 与角色播放器回归测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts character-player.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 请求授权并提交 Task 1**

```powershell
git add apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts apps/desktop/tests/pixi-character-player.test.ts
git commit -m "refactor：抽取共享角色动作场景"
```

---

### Task 2: 实现逐帧 Alpha 命中器

**Files:**
- Create: `apps/desktop/src/renderer/src/characters/player/character-alpha-hit-tester.ts`
- Modify: `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- Test: `apps/desktop/tests/character-alpha-hit-tester.test.ts`
- Test: `apps/desktop/tests/pixi-character-player.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getCurrentFrame()` 和资源图片解码结果。
- Produces:

```ts
export type AlphaMask = {
  width: number;
  height: number;
  bytes: Uint8Array;
};

export type CharacterHitSnapshot = {
  mask: AlphaMask;
  sourceRect: { x: number; y: number; width: number; height: number };
  frameBounds: { x: number; y: number; width: number; height: number };
  direction: 'left' | 'right';
};

export function hitTestCharacterAlpha(
  snapshot: CharacterHitSnapshot | null,
  point: { x: number; y: number },
  threshold?: number
): boolean;
```

- [ ] **Step 1: 写阈值、透明空洞、镜像和越界失败测试**

```ts
test.each([
  [0, false],
  [16, false],
  [17, true],
  [255, true]
])('Alpha %s 的命中结果为 %s', (alpha, expected) => {
  expect(hitTestCharacterAlpha(snapshotWithAlpha(alpha), { x: 5, y: 5 }))
    .toBe(expected);
});

test('左向镜像把画布左侧映射到源帧右侧', () => {
  const snapshot = twoPixelSnapshot({
    direction: 'left',
    alpha: [0, 255]
  });
  expect(hitTestCharacterAlpha(snapshot, { x: 0.25, y: 0.5 })).toBe(true);
});

test('命中快照缺失、透明空洞和越界坐标均穿透', () => {
  expect(hitTestCharacterAlpha(null, { x: 1, y: 1 })).toBe(false);
  expect(hitTestCharacterAlpha(hollowSnapshot, hollowPoint)).toBe(false);
  expect(hitTestCharacterAlpha(hollowSnapshot, { x: -1, y: 0 })).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认缺少模块**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- character-alpha-hit-tester.test.ts
```

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现纯命中函数**

```ts
const DEFAULT_ALPHA_THRESHOLD = 16;

export function hitTestCharacterAlpha(
  snapshot: CharacterHitSnapshot | null,
  point: { x: number; y: number },
  threshold = DEFAULT_ALPHA_THRESHOLD
): boolean {
  if (!snapshot) return false;
  const { frameBounds, sourceRect, mask, direction } = snapshot;
  if (
    frameBounds.width <= 0
    || frameBounds.height <= 0
    || point.x < frameBounds.x
    || point.y < frameBounds.y
    || point.x >= frameBounds.x + frameBounds.width
    || point.y >= frameBounds.y + frameBounds.height
  ) return false;

  const normalizedX = (point.x - frameBounds.x) / frameBounds.width;
  const normalizedY = (point.y - frameBounds.y) / frameBounds.height;
  const sourceX = sourceRect.x + Math.min(
    sourceRect.width - 1,
    Math.floor((direction === 'left' ? 1 - normalizedX : normalizedX) * sourceRect.width)
  );
  const sourceY = sourceRect.y + Math.min(
    sourceRect.height - 1,
    Math.floor(normalizedY * sourceRect.height)
  );
  return (mask.bytes[sourceY * mask.width + sourceX] ?? 0) > threshold;
}
```

- [ ] **Step 4: 在 Pixi 资源加载时一次性提取 Alpha**

使用离屏 Canvas 在图片解码后执行一次 `drawImage` 和 `getImageData`，只保留每像素 Alpha 字节。`getCurrentHitSnapshot()` 组合当前帧矩形、当前布局边界和方向；帧切换时不重新读取图片。

```ts
export interface CharacterPlayerPort {
  // 保留现有方法。
  hitTest(point: { x: number; y: number }, threshold?: number): boolean;
  subscribeHitRegion(listener: () => void): () => void;
}
```

- [ ] **Step 5: 运行命中与 Pixi 测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- character-alpha-hit-tester.test.ts pixi-character-player.test.ts
```

Expected: PASS，且测试断言鼠标命中期间没有调用 `getImageData`。

- [ ] **Step 6: 请求授权并提交 Task 2**

```powershell
git add apps/desktop/src/renderer/src/characters/player/character-alpha-hit-tester.ts apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts apps/desktop/tests/character-alpha-hit-tester.test.ts apps/desktop/tests/pixi-character-player.test.ts
git commit -m "feat：实现角色逐帧 Alpha 命中"
```

---

### Task 3: 实现 Main 受限窗口交互控制器

**Files:**
- Create: `apps/desktop/src/shared/pet-window-interaction.ts`
- Create: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/main/windows/window-manager.ts`
- Test: `apps/desktop/tests/pet-window-interaction-controller.test.ts`
- Test: `apps/desktop/tests/preload-api.test.ts`
- Test: `apps/desktop/tests/window-security.test.ts`

**Interfaces:**
- Consumes: `BrowserWindow.setIgnoreMouseEvents`、`screen.getCursorScreenPoint`、`CharacterMotionService.beginUserMove/endUserMove`。
- Produces:

```ts
export const petMousePassthroughInputSchema = z.object({
  ignore: z.boolean()
}).strict();

export interface PetWindowInteractionApi {
  setPetMousePassthrough(ignore: boolean): Promise<void>;
  beginPetDrag(): Promise<void>;
  endPetDrag(): Promise<void>;
  openPetContextMenu(): Promise<void>;
}

export class PetWindowInteractionController {
  setPassthrough(ignore: boolean): void;
  beginDrag(): void;
  endDrag(reason: 'released' | 'cancelled' | 'timeout' | 'disposed'): void;
  dispose(): void;
}
```

- [ ] **Step 1: 写 Main 控制器失败测试**

```ts
test('穿透开启时保留 Windows 鼠标移动转发', () => {
  controller.setPassthrough(true);
  expect(window.setIgnoreMouseEvents)
    .toHaveBeenCalledWith(true, { forward: true });
});

test('拖拽使用系统光标差值且不接受 Renderer 目标位置', () => {
  cursor.mockReturnValueOnce({ x: 100, y: 100 })
    .mockReturnValueOnce({ x: 130, y: 120 });
  controller.beginDrag();
  runNextDragTick();
  expect(window.setPosition).toHaveBeenCalledWith(230, 320);
  expect(motion.beginUserMove).toHaveBeenCalledOnce();
});

test.each(['timeout', 'disposed'] as const)('%s 会结束拖拽并清理计时器', reason => {
  controller.beginDrag();
  controller.endDrag(reason);
  expect(motion.endUserMove).toHaveBeenCalledOnce();
  expect(activeTimers()).toHaveLength(0);
});
```

- [ ] **Step 2: 运行测试并确认缺少控制器**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-window-interaction-controller.test.ts
```

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 Main 拖拽会话**

```ts
beginDrag(): void {
  if (this.drag) return;
  const cursor = this.options.getCursorScreenPoint();
  const [windowX, windowY] = this.options.window.getPosition();
  this.options.motion.beginUserMove();
  this.setPassthrough(false);
  this.drag = {
    cursor,
    window: { x: windowX, y: windowY },
    tick: this.options.setInterval(() => this.updateDrag(), 16),
    timeout: this.options.setTimeout(() => this.endDrag('timeout'), 30_000)
  };
}
```

`updateDrag()` 只使用 Main 的系统光标，经过 `clampPositionToVisibleWorkArea()` 后调用 `setPosition()`。

- [ ] **Step 4: 增加固定 IPC、preload API 和发送方校验**

```ts
replaceHandler(
  ipcMain,
  ipcChannels.petMousePassthroughSet,
  (event, raw) => {
    assertPetSender(event.sender);
    const input = petMousePassthroughInputSchema.parse(raw);
    controller.setPassthrough(input.ignore);
  }
);
```

拖拽开始、结束和菜单请求均不接受 Renderer 坐标或命令字符串。

- [ ] **Step 5: 运行 Main、preload 和安全测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-window-interaction-controller.test.ts preload-api.test.ts window-security.test.ts
```

Expected: PASS。

- [ ] **Step 6: 请求授权并提交 Task 3**

```powershell
git add apps/desktop/src/shared/pet-window-interaction.ts apps/desktop/src/main/windows/pet-window-interaction-controller.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/main/windows/window-manager.ts apps/desktop/tests/pet-window-interaction-controller.test.ts apps/desktop/tests/preload-api.test.ts apps/desktop/tests/window-security.test.ts
git commit -m "feat：实现受限桌宠窗口交互控制器"
```

---

### Task 4: 接入 Renderer 像素穿透、左键拖拽和右键菜单

**Files:**
- Create: `apps/desktop/src/renderer/src/pet/pet-interaction-controller.ts`
- Modify: `apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- Modify: `apps/desktop/src/renderer/src/pet/PetView.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/pet-interaction-controller.test.ts`
- Test: `apps/desktop/tests/character-player.test.tsx`
- Test: `apps/desktop/tests/pet-view.test.tsx`
- Test: `apps/desktop/tests/character-motion-controller.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `hitTest()`/`subscribeHitRegion()` 和 Task 3 的 `PetWindowInteractionApi`。
- Produces:

```ts
export type CharacterHitTestPort = {
  hitTest(point: { x: number; y: number }): boolean;
  subscribe(listener: () => void): () => void;
};

export function createElementBoundsHitTestPort(
  element: HTMLElement
): CharacterHitTestPort;

export class PetInteractionController {
  setHitTestPort(port: CharacterHitTestPort | null): void;
  handlePointerMove(point: { x: number; y: number }): void;
  handlePointerDown(event: Pick<PointerEvent, 'button' | 'pointerId'>): void;
  handlePointerUp(): void;
  handlePointerCancel(): void;
  handleContextMenu(): void;
  dispose(): void;
}
```

- [ ] **Step 1: 写 Renderer 手势失败测试**

```ts
test('透明像素保持穿透，可见像素恢复鼠标接收', async () => {
  hitTest.mockReturnValueOnce(false).mockReturnValueOnce(true);
  controller.handlePointerMove({ x: 10, y: 10 });
  controller.handlePointerMove({ x: 20, y: 20 });
  expect(api.setPetMousePassthrough.mock.calls).toEqual([[true], [false]]);
});

test('可见像素左键开始拖拽但不打开聊天', () => {
  hitTest.mockReturnValue(true);
  controller.handlePointerDown({ button: 0, pointerId: 7 });
  expect(api.beginPetDrag).toHaveBeenCalledOnce();
  expect(api.openChat).not.toHaveBeenCalled();
});

test('拖拽期间帧变透明也不会切回穿透', () => {
  beginVisibleDrag(controller);
  hitTest.mockReturnValue(false);
  emitFrameChanged();
  expect(api.setPetMousePassthrough).not.toHaveBeenLastCalledWith(true);
});

test('透明像素右键不打开菜单，可见像素右键打开菜单', () => {
  hitTest.mockReturnValueOnce(false).mockReturnValueOnce(true);
  controller.handleContextMenu();
  controller.handleContextMenu();
  expect(api.openPetContextMenu).toHaveBeenCalledOnce();
});

test('运行纹理失败时 CSS 备用角色只按自身几何边界命中', () => {
  const port = createElementBoundsHitTestPort(fallbackElement);
  expect(port.hitTest(pointInsideFallback)).toBe(true);
  expect(port.hitTest(pointOutsideFallback)).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认模块不存在**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-interaction-controller.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 Renderer 状态机**

```ts
private reevaluate(): void {
  if (this.dragging) return;
  const hit = this.lastPoint !== null
    && this.hitTestPort?.hitTest(this.lastPoint) === true;
  if (hit === this.lastHit) return;
  this.lastHit = hit;
  void this.api.setPetMousePassthrough(!hit);
}
```

帧变化订阅调用 `reevaluate()`；拖拽结束后再调用一次。

- [ ] **Step 4: 将 `CharacterPlayer` 命中端口交给 `PetView`**

```tsx
<CharacterPlayer
  stateId={characterState}
  motionMode={motionMode}
  onHitTestPortChange={setHitTestPort}
  // 保留运动、锚点、错误和扩展定义回调。
/>
```

删除 `PetOpenChatButton` 与其 250ms 单双击协调器。使用普通非按钮容器承载画布，不再设置矩形 `app-region: drag`。

运行纹理失败时，`PetCharacter` 的实际 DOM 边界通过 `createElementBoundsHitTestPort()` 提供保守几何命中；边界外继续穿透，不能退回整个窗口矩形。

- [ ] **Step 5: 将现有 Main 菜单构造函数注入控制器**

把 `tray?.popUpContextMenu(contextMenu)` 从无条件 `webContents` 事件改为 Task 3 的受限 `openPetContextMenu()` 命令；托盘菜单继续复用同一 `contextMenu`。

创建控制器后立即调用 `setPassthrough(true)`，并在 `pet.show()` 之前完成接线，确保角色资源尚未就绪时窗口默认穿透。

- [ ] **Step 6: 运行 Renderer、运动和 Main 接线测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-interaction-controller.test.ts character-player.test.tsx pet-view.test.tsx character-motion-controller.test.ts
```

Expected: PASS，且源码测试不再找到 `PetOpenChatButton` 或 `.pet-open-chat`。

- [ ] **Step 7: 请求授权并提交 Task 4**

```powershell
git add apps/desktop/src/renderer/src/pet/pet-interaction-controller.ts apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx apps/desktop/src/renderer/src/pet/PetView.tsx apps/desktop/src/renderer/src/styles.css apps/desktop/src/main/index.ts apps/desktop/tests/pet-interaction-controller.test.ts apps/desktop/tests/character-player.test.tsx apps/desktop/tests/pet-view.test.tsx apps/desktop/tests/character-motion-controller.test.ts
git commit -m "fix：按角色像素接管穿透与拖拽"
```

---

### Task 5: 分离保存状态与右上角提示队列

**Files:**
- Create: `apps/desktop/src/renderer/src/characters/workshop/WorkshopToastLayer.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- Test: `apps/desktop/tests/workshop-toast-layer.dom.test.tsx`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`
- Test: `apps/desktop/tests/character-workshop-components.test.tsx`

**Interfaces:**
- Consumes: 现有 `WorkshopNotice`。
- Produces:

```ts
export type WorkshopToast = {
  id: string;
  tone: 'success' | 'info' | 'warning' | 'error';
  text: string;
};

export interface WorkshopToastLayerProps {
  queue: readonly WorkshopToast[];
  onDismiss(id: string): void;
}

export function toastDurationMs(tone: WorkshopToast['tone']): 3000 | 6000;
```

- [ ] **Step 1: 写保存反馈和提示计时失败测试**

```ts
test('自动保存成功只更新 saved 状态，不创建提示', async () => {
  store.getState().updateCurrentAction({ name: '新动作名' });
  await vi.advanceTimersByTimeAsync(500);
  await settle();
  expect(store.getState().draftStatus).toBe('saved');
  expect(store.getState().toastQueue).toEqual([]);
});

test.each([
  ['success', 3000],
  ['info', 3000],
  ['warning', 6000],
  ['error', 6000]
] as const)('%s 提示在 %sms 后关闭', (tone, duration) => {
  render(<WorkshopToastLayer queue={[toast(tone)]} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(duration - 1));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismiss).toHaveBeenCalledOnce();
});

test('悬停和焦点暂停剩余时间，离开后继续计时', () => {
  render(<WorkshopToastLayer queue={[toast('error')]} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.mouseEnter(screen.getByRole('alert'));
  act(() => vi.advanceTimersByTime(10_000));
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.mouseLeave(screen.getByRole('alert'));
  act(() => vi.advanceTimersByTime(4000));
  expect(dismiss).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- workshop-toast-layer.dom.test.tsx character-workshop-store.test.ts
```

Expected: FAIL，提示提示层和 `toastQueue` 不存在。

- [ ] **Step 3: 把单一 `notice` 改为有序提示队列**

```ts
export interface CharacterWorkshopState {
  // 保留现有字段和方法。
  toastQueue: WorkshopToast[];
  dismissToast(id: string): void;
}

function enqueueToast(
  tone: WorkshopToast['tone'],
  text: string
): void {
  set(state => ({
    toastQueue: [
      ...state.toastQueue,
      { id: dependencies.createToastId?.() ?? crypto.randomUUID(), tone, text }
    ]
  }));
}
```

把创建、复制、删除、导入、导出、应用网格、编译、发布、启用和错误路径中的 `set({ notice })` 改为 `enqueueToast()`。`dismissToast(id)` 只删除匹配项，不能清空后续消息。

- [ ] **Step 4: 分离自动保存状态与提示**

```ts
// 自动保存成功。
set({ draftStatus: 'saved' });

// 自动保存失败。
set({ draftStatus: 'error' });
enqueueToast('error', errorText(error));
```

自动保存成功不得调用 `enqueueToast()`。

- [ ] **Step 5: 实现队首提示和可暂停的剩余时间计时器**

提示层只显示 `queue[0]`。它记录当前提示 ID、`deadline` 和 `remainingMs`；`mouseenter`/`focusin` 清除计时器并扣除已用时间，`mouseleave`/`focusout` 从剩余时间继续。队首 ID 变化或卸载时清理旧计时器并按新提示时长重新开始。当前提示关闭后，下一条按顺序成为队首。

- [ ] **Step 6: 将提示层改为覆盖定位**

```css
.workshop-toast-layer {
  position: fixed;
  z-index: 50;
  top: 68px;
  right: 16px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}

.workshop-toast {
  pointer-events: auto;
}
```

删除页面网格中的 `.workshop-notice` 行；提示层不得改变 `.workshop-columns` 高度。

- [ ] **Step 7: 运行 store、DOM 和组件测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- workshop-toast-layer.dom.test.tsx character-workshop-store.test.ts character-workshop-components.test.tsx
```

Expected: PASS。

- [ ] **Step 8: 请求授权并提交 Task 5**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop/WorkshopToastLayer.tsx apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/src/renderer/src/characters/workshop/character-workshop.css apps/desktop/tests/workshop-toast-layer.dom.test.tsx apps/desktop/tests/character-workshop-store.test.ts apps/desktop/tests/character-workshop-components.test.tsx
git commit -m "fix：改用工作台右上角临时提示层"
```

---

### Task 6: 实现草稿预览资源缓存

**Files:**
- Create: `apps/desktop/src/renderer/src/characters/workshop/draft-preview-resource-cache.ts`
- Test: `apps/desktop/tests/draft-character-preview.test.tsx`

**Interfaces:**
- Consumes: `CharacterWorkshopApi.readCharacterSource(characterId, assetId)`。
- Produces:

```ts
export type DraftPreviewBundle = {
  urls: ReadonlyMap<string, string>;
  release(): void;
};

export class DraftPreviewResourceCache {
  load(
    characterId: string,
    assetIds: readonly string[],
    signal: AbortSignal
  ): Promise<DraftPreviewBundle>;
  destroy(): void;
}
```

- [ ] **Step 1: 写去重、取消和释放失败测试**

```ts
test('同一动作多帧引用相同素材时只读取一次', async () => {
  const bundle = await cache.load('nova', ['sheet-a', 'sheet-a'], signal);
  expect(api.readCharacterSource).toHaveBeenCalledOnce();
  expect(bundle.urls.get('sheet-a')).toMatch(/^blob:/u);
});

test('新修订取消旧加载并释放旧 Blob URL', async () => {
  const first = cache.load('nova', ['slow'], firstSignal);
  firstAbort.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

test('destroy 释放全部 Blob URL 且后续加载被拒绝', async () => {
  cache.destroy();
  await expect(cache.load('nova', ['sheet-a'], signal))
    .rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
});
```

- [ ] **Step 2: 运行测试并确认模块不存在**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 实现按角色与素材标识缓存**

```ts
const key = `${characterId}:${assetId}`;
let entry = this.entries.get(key);
if (!entry) {
  entry = this.createEntry(characterId, assetId, signal);
  this.entries.set(key, entry);
}
```

每个 bundle 持有引用计数；`release()` 只释放自身引用，缓存销毁时强制回收全部 URL。读取到的字节通过现有 MIME 魔数判断创建 PNG 或 WebP Blob。

- [ ] **Step 4: 运行资源缓存测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 请求授权并提交 Task 6**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop/draft-preview-resource-cache.ts apps/desktop/tests/draft-character-preview.test.tsx
git commit -m "feat：实现草稿预览资源缓存"
```

---

### Task 7: 实现真实草稿预览与全部控制

**Files:**
- Create: `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/PreviewControls.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- Test: `apps/desktop/tests/draft-character-preview.test.tsx`
- Test: `apps/desktop/tests/character-action-editor.dom.test.tsx`
- Test: `apps/desktop/tests/character-workshop-components.test.tsx`

**Interfaces:**
- Consumes: Task 1 的共享动作场景、Task 6 的 `DraftPreviewResourceCache`、当前 `DraftActionClip`。
- Produces:

```ts
export interface DraftCharacterPreviewProps {
  characterId: string | null;
  draft: CharacterDraftV1 | null;
  stateId: CharacterStateId | null;
  actionId: string | null;
  selectedFrameId: string | null;
  preview: PreviewState;
  api: Pick<MyselfApi, 'readCharacterSource'>;
}

export interface PreviewControlsProps {
  state: PreviewState;
  frameCount: number;
  disabled?: boolean;
  onChange(next: PreviewState): void;
}
```

- [ ] **Step 1: 把 `PreviewControls` 改为受控组件并写失败测试**

```tsx
test('控制器把播放、逐帧、镜像、速度和文件挂载提交给父组件', () => {
  render(
    <ControlledPreviewControls initial={createPreviewState(4)} frameCount={4} />
  );
  fireEvent.click(screen.getByRole('button', { name: '播放' }));
  fireEvent.click(screen.getByRole('button', { name: '切换左右方向' }));
  fireEvent.change(screen.getByLabelText('速度'), { target: { value: '1.5' } });
  fireEvent.click(screen.getByRole('button', { name: '模拟文件挂载' }));
  expect(latestState()).toMatchObject({
    playing: true,
    direction: 'left',
    speed: 1.5,
    mountedFile: true
  });
});
```

- [ ] **Step 2: 运行控制器测试并确认受控接口缺失**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- character-action-editor.dom.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 写真实草稿渲染失败测试**

```tsx
test('草稿动作无需保存或发布即可加载源素材并播放', async () => {
  render(<DraftCharacterPreview {...previewProps(idleDraft)} />);
  await waitFor(() => expect(scene.loadAssets).toHaveBeenCalled());
  expect(scene.showAction).toHaveBeenCalledWith(
    idleDraft.states[0]!.actions[0],
    expect.objectContaining({ direction: 'right', speed: 1 })
  );
  expect(api.saveCharacterDraft).not.toHaveBeenCalled();
  expect(api.publishCharacter).not.toHaveBeenCalled();
});

test('旧素材请求晚到不能覆盖新动作', async () => {
  const view = render(<DraftCharacterPreview {...previewProps(slowDraft)} />);
  view.rerender(<DraftCharacterPreview {...previewProps(newDraft)} />);
  resolveSlowDraft();
  await settle();
  expect(scene.showAction).toHaveBeenLastCalledWith(
    newAction,
    expect.anything()
  );
});
```

- [ ] **Step 4: 实现 `DraftCharacterPreview` 修订门**

```ts
useEffect(() => {
  const revision = ++revisionRef.current;
  const abort = new AbortController();
  void loadPreviewBundle(action, abort.signal).then(bundle => {
    if (revision !== revisionRef.current) {
      bundle.release();
      return;
    }
    activeBundleRef.current?.release();
    activeBundleRef.current = bundle;
    return scene.loadAssets(bundle.urls);
  }).then(() => {
    if (revision === revisionRef.current) showCurrentAction();
  }).catch(error => {
    if (error.name !== 'AbortError') setPreviewError(stablePreviewError(error));
  });
  return () => abort.abort();
}, [characterId, actionFingerprint]);
```

- [ ] **Step 5: 接通所有预览控制**

- `playing` 和 `loop` 控制 Pixi ticker 与动作循环。
- `frameIndex` 使用 `gotoAndStop`。
- `direction` 调用共享镜像布局。
- `speed` 乘以帧持续时间或 ticker 速度。
- `darkBackground` 切换预览画布语义类。
- `showAnchors` 绘制当前整段或逐帧锚点。
- `mountedFile` 在 `carry` 锚点显示模拟文件图标，不调用文件工具。
- `tourAllStates` 按草稿状态和动作顺序巡览；核心或扩展状态动作为空时跳过。

- [ ] **Step 6: 实现空状态、局部错误和减少动态效果**

无动作、无帧、读取失败和矩形无效分别显示稳定文案。页面隐藏或 `prefers-reduced-motion` 时强制停止连续播放，但保留逐帧按钮。

- [ ] **Step 7: 运行预览、编辑器和工作台组件测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx character-action-editor.dom.test.tsx character-workshop-components.test.tsx
```

Expected: PASS。

- [ ] **Step 8: 请求授权并提交 Task 7**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx apps/desktop/src/renderer/src/characters/workshop/PreviewControls.tsx apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/src/renderer/src/characters/workshop/character-workshop.css apps/desktop/tests/draft-character-preview.test.tsx apps/desktop/tests/character-action-editor.dom.test.tsx apps/desktop/tests/character-workshop-components.test.tsx
git commit -m "feat：接通角色草稿实时预览"
```

---

### Task 8: 完成集成、E2E、性能守卫和验收文档

**Files:**
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/fixtures/electron-app.ts`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Modify: `docs/operations/character-workshop-acceptance.md`

**Interfaces:**
- Consumes: Tasks 1–7 的正式 UI、固定 IPC 和运行时行为。
- Produces: 可重复执行的完整验证证据与中文人工验收步骤。

- [ ] **Step 1: 增加 Electron E2E 失败断言**

```ts
test('角色工作室草稿编辑立即更新真实预览', async ({ electronApp }) => {
  const workshop = await electronApp.openCharacterWorkshop();
  await workshop.importFixtureSpriteSheet();
  await workshop.applyGrid({ rows: 2, columns: 2, frames: 4 });
  await expect(workshop.locator('[data-preview-status="ready"]')).toBeVisible();
  await workshop.setPreviewDirection('left');
  await expect(workshop.locator('[data-preview-direction="left"]')).toBeVisible();
  await workshop.setPreviewSpeed(1.5);
  await expect(workshop.locator('[data-preview-speed="1.5"]')).toBeVisible();
});
```

增加 Main 测试探针，只返回布尔穿透状态和拖拽会话状态，不暴露窗口句柄、真实路径或任意设置能力。

- [ ] **Step 2: 运行精确 E2E 并确认新断言失败**

Run:

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "像素命中|左键拖拽|草稿编辑立即更新真实预览|右上角提示"
```

Expected: FAIL，直到测试探针和 UI 语义标记接线完整。

- [ ] **Step 3: 补齐 E2E 可观察语义与测试夹具**

只在既有 E2E 边界中增加：

```ts
type PetInteractionProbe = {
  passthrough: boolean;
  dragging: boolean;
};
```

不得加入设置任意光标坐标、移动任意窗口或读取任意本地路径的测试 API。

- [ ] **Step 4: 增加 Alpha 高频路径性能守卫**

```ts
test('一万次命中只读取缓存 Alpha，不调用 GPU 或 Canvas 回读', () => {
  for (let index = 0; index < 10_000; index += 1) {
    hitTestCharacterAlpha(snapshot, { x: index % 100, y: index % 80 });
  }
  expect(getImageData).not.toHaveBeenCalled();
  expect(readPixels).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: 更新中文验收清单**

在 `docs/operations/character-workshop-acceptance.md` 增加：

- 透明像素对底层文件的左键、双击和右键穿透。
- 可见像素左键拖拽与位置恢复。
- 可见像素右键菜单和菜单聊天入口。
- 草稿未保存、未编译、未发布时的实时预览。
- 3 秒/6 秒提示、悬停暂停、焦点暂停和手动关闭。
- 五分钟空闲与播放 CPU 观察、纹理和 Blob URL 释放。

- [ ] **Step 6: 运行完整角色验证门禁**

Run:

```powershell
pnpm.cmd verify:characters
```

Expected:

- `character-runtime`、`character-assets`、Desktop、integration、security 和 Electron E2E 全部 PASS。
- 无残留 Electron/Node 测试进程。
- 无新增临时角色目录。

- [ ] **Step 7: 运行格式与敏感边界检查**

Run:

```powershell
git diff --check
git status --short
```

Expected: 无空白错误；只包含本计划内文件。

- [ ] **Step 8: 请求授权并提交 Task 8**

```powershell
git add tests/e2e/desktop.spec.ts tests/fixtures/electron-app.ts apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/character-motion-controller.test.ts docs/operations/character-workshop-acceptance.md
git commit -m "test：验收角色交互与实时预览闭环"
```

---

## 最终人工验收

- [ ] 在专用测试文件上方验证透明像素不阻挡选择、双击和右键。
- [ ] 在角色可见像素上按住左键拖拽，确认不打开聊天。
- [ ] 拖拽期间等待动画切帧，确认角色不会脱手。
- [ ] 可见像素右键打开菜单，并通过菜单打开聊天。
- [ ] 关闭并重启应用，确认最终位置恢复。
- [ ] 修改草稿帧顺序、FPS、循环、方向、速度、锚点和文件挂载，确认预览立即变化。
- [ ] 不保存、不编译、不发布时确认预览仍可用。
- [ ] 验证提示浮于右上角，不推动三栏布局。
- [ ] 验证成功/信息 3 秒、警告/错误 6 秒，悬停和焦点暂停计时。
- [ ] 开启系统“减少动态效果”，确认连续动画暂停且逐帧控制可用。
- [ ] 观察五分钟 CPU、内存和纹理释放，记录 Windows 版本、设备和电源模式。
