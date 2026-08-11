# 连续拖拽诊断与修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；诊断任务先使用 `systematic-debugging`，修复任务使用 `test-driven-development`。

**Goal:** 用真实可重复证据定位连续拖拽向左上漂移，建立单一拖拽坐标权威，并验证多显示器、混合 DPI 和缩放后的稳定拖拽。

**Architecture:** Main 每次拖拽冻结 `PetGeometrySnapshot` 并创建 epoch；每帧都以初始全局 DIP 光标和初始脚底锚点计算总位移，钳制可见矩形后反推透明窗口原点。拖拽期间只有控制器能写窗口位置。

## Task D1：建立不触边的真实漂移 RED

**Files:**

- Modify: `tests/fixtures/electron-app.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `apps/desktop/src/shared/pet-window-interaction.ts` only for a bounded de-identified probe

- [ ] 新增命名场景：在同一显示器中央以相同相对抓取点连续拖拽至少 20 次，每次都不接触边缘；记录每次期望 delta 与实际 delta 的差值，不读取绝对屏幕坐标。
- [ ] 探针仅返回 `dragEpoch`、`geometryRevision`、量化后的 delta/error 和 ownership 状态；禁止返回窗口/光标绝对坐标。
- [ ] 运行 desktop build + `pnpm.cmd test:e2e:desktop -- --grep "连续拖拽不向左上漂移"`，要求旧实现真实失败；若 10 分钟内不能复现，依次改用缩放 100%、固定动作、禁用自动行为的更窄矩阵，不能先写修复。
- [ ] 保存事件序列：Renderer pointer、Main begin/end、window move/will-move/moved、Motion userMoving、geometry revision；只记录类别和相对计数。

## Task D2：把拖拽数学提取为单一纯模块

**Files:**

- Create: `apps/desktop/src/main/windows/pet-drag-session.ts`
- Create: `apps/desktop/tests/pet-drag-session.test.ts`

```ts
type DragSession = Readonly<{
  epoch: string;
  initialCursorDip: Point;
  initialFootAnchorDip: Point;
  grabOffsetInVisualBoundsDip: Point;
  geometryRevision: number;
}>;
```

- [ ] RED：每帧结果只等于初始锚点 + 当前光标总 delta；重复调用同一输入幂等；不得读取上一帧窗口位置。
- [ ] RED：按可见包围盒钳制后反推 window origin；支持负坐标工作区、不同缩放、四边和跨屏目标显示器。
- [ ] GREEN：导出 `createDragSession` 和 `resolveDragFrame` 两个小接口；纯函数不访问 Electron、计时器或设置。
- [ ] 运行 `pnpm.cmd --filter @myself/desktop test -- pet-drag-session.test.ts`，提交 `feat: 建立桌宠拖拽纯坐标模型`。

## Task D3：Main 独占拖拽 epoch 和窗口写入

**Files:**

- Modify: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`
- Modify: `apps/desktop/tests/pet-window-interaction-controller.test.ts`
- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`

- [ ] RED：重复 begin、旧 epoch tick、释放后迟到 tick、cancel/timeout/dispose/窗口销毁均不再写位置；end 幂等恢复鼠标穿透。
- [ ] RED：拖拽期间 Motion 不写窗口、不通过 `move/moved` 回调重设 target；释放时只接收最终脚底锚点一次。
- [ ] GREEN：Controller 消费 D2 纯模块和冻结几何；`setPosition` 是拖拽期唯一写端；Motion 仅有 `beginUserMove/finalizeUserMove` 状态端口。
- [ ] 删除被替代的 expected-position/事件重入补偿分支；若删除范围超过少量局部代码，先由主控按“大量删除”规则取得二次批准。
- [ ] 提交 `fix: 让 Main 独占桌宠拖拽位置`。

## Task D4：拖拽期间冻结几何并原子收口

**Files:**

- Modify: `apps/desktop/src/main/characters/pet-visual-geometry.ts`
- Modify: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`
- Modify: `apps/desktop/tests/pet-visual-geometry.test.ts`
- Modify: `apps/desktop/tests/pet-window-interaction-controller.test.ts`

- [ ] RED：拖拽中动作切换、overlay、角色缩放和显示器变化只排队，不改变 session revision；释放后以最终光标锚点应用最新几何一次。
- [ ] RED：队列应用失败时保持最后合法几何、结束 epoch、停止写位置并恢复穿透；不得半应用窗口大小。
- [ ] GREEN：Geometry 提供 `beginDragSnapshot/commitDeferredUpdates/cancelDeferredUpdates`；Controller close 等待原子收口。
- [ ] 提交 `fix: 原子处理拖拽期间几何变化`。

## Task D5：迁移位置持久化和跨屏/DPI

**Files:**

- Modify: `apps/desktop/src/main/windows/pet-position.ts`
- Modify: `apps/desktop/tests/pet-position.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] RED：一次拖拽只持久化最终 foot anchor；连续 drag 不读取刚保存的 window top-left 作为下一次视觉位置。
- [ ] RED：左侧负坐标显示器、上方显示器、相同 DPI 与不同 DPI 模型中抓取点不跳；计算全程使用 Electron DIP，不手工乘 `scaleFactor`。
- [ ] GREEN：保存队列以 geometry revision 去重；退出 freeze/flush 等待最后合法位置；旧 top-left 读取路径在 G3 迁移后删除。
- [ ] 提交 `fix: 持久化桌宠拖拽脚底锚点`。

## Task D6：真实 Electron 复验与最终门禁

**Files:**

- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/fixtures/electron-app.ts`
- Create: `docs/operations/ai-pet-capability-behavior-geometry-acceptance.md`

- [ ] 原始 20 次中央拖拽场景 GREEN，累计误差为 0 或仅允许 Electron 整数 DIP 舍入的非累积 ±1 DIP。
- [ ] 加入触边、50%/200%、动作切换、自动运动竞争、失焦、指针丢失、负坐标和混合 DPI 场景；不通过放宽全局 timeout 获绿。
- [ ] 运行完整 Desktop E2E；检查本工作树 Electron/Node/PowerShell 进程残留为空。
- [ ] 严格顺序运行 7 个非网站 workspace typecheck、unit、security、integration、Desktop E2E、`verify:behavior`；记录精确计数与耗时。
- [ ] 双轴独立审查通过后提交 `fix: 根治桌宠连续拖拽坐标漂移` 和最终验收文档。

## 最终命令

```powershell
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/character-assets typecheck
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/release-tools typecheck
pnpm.cmd test:unit
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
pnpm.cmd verify:behavior
git diff --check
git diff --name-only -- apps/website
```
