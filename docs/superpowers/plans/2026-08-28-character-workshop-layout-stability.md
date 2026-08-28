# 角色工作台布局稳定性实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 或 `executing-plans` 按任务实施；每项任务严格执行 RED → GREEN → REFACTOR。

**目标：** 修复被预览覆盖的模态弹窗，提供可持久化且受约束的工作台分隔器，并删除皮肤编辑界面而保持角色包兼容。

**架构：** 复用现有原生 `dialog.showModal()` 和 `AnchorEditor` Pointer Capture 模式；布局尺寸以 CSS 变量驱动，通过 SettingsStore 的最小强类型 IPC 在交互结束时保存；皮肤只删除工作台编辑入口，不修改 V2 契约与运行时。

**技术栈：** React、TypeScript、CSS Grid、Electron IPC、Zod、Vitest、Playwright/Electron E2E

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-28-ai-pet-agent-workshop-stability-design.md`。
- 只删除皮肤编辑 UI；必须保留 `skins`、`defaultSkinId` 与多皮肤导入/编译/发布/运行时兼容。
- 分隔器在响应式堆叠布局中隐藏，桌面布局恢复持久值前必须 clamp。
- Renderer 不直接写设置文件，只经强类型 preload IPC。
- 所有新文档与结构性注释使用中文。

---

### 任务 1：让问题弹窗进入浏览器原生顶层

**文件：**
- 新增：`apps/desktop/src/renderer/src/characters/workshop/use-modal-dialog.ts`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 测试：`apps/desktop/tests/character-workshop-components.test.tsx`
- 测试：`tests/e2e/desktop.spec.ts`

**接口：**

```ts
export function useModalDialog(open: boolean): RefObject<HTMLDialogElement | null>;
```

- [ ] **步骤 1：写失败测试**

组件测试使用真实 `HTMLDialogElement.showModal/close` 可观察替身，断言扩展状态和发布要求打开时各调用一次 `showModal()`、关闭时调用 `close()`；E2E 在预览覆盖区域用鼠标点击“创建扩展状态”并断言状态实际创建，禁止用 Enter 代替点击。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx
pnpm.cmd test:e2e:desktop -- tests/e2e/desktop.spec.ts
```

预期：现有 `<dialog open>` 不调用 `showModal()`，点击被预览层截获。

- [ ] **步骤 3：最小实现与 GREEN**

复用仓库 `IncompleteCharacterDialog` 生命周期抽成 hook；替换两个 `<dialog open>`，保留表单、Escape 和关闭逻辑。

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx
pnpm.cmd test:e2e:desktop -- tests/e2e/desktop.spec.ts
```

预期：组件与真实点击 E2E 通过。

- [ ] **步骤 4：提交**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop apps/desktop/tests/character-workshop-components.test.tsx tests/e2e/desktop.spec.ts
git commit -m "fix: 提升工作台模态弹窗层级"
```

### 任务 2：建立工作台布局设置契约与持久化

**文件：**
- 新增：`apps/desktop/src/shared/workshop-layout-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/storage/settings-store.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 测试：`apps/desktop/tests/settings-store.test.ts`
- 测试：`apps/desktop/tests/settings-ipc.test.ts`
- 测试：`apps/desktop/tests/character-workshop-close-preload.test.ts`

**接口：**

```ts
export type WorkshopLayoutSettings = Readonly<{
  leftWidth: number;
  rightWidth: number;
  sidebarTopHeight: number;
  stageHeight: number;
}>;

export const DEFAULT_WORKSHOP_LAYOUT: WorkshopLayoutSettings;
export const workshopLayoutSettingsSchema: z.ZodType<WorkshopLayoutSettings>;
```

`MyselfApi` 新增 `getWorkshopLayout(): Promise<WorkshopLayoutSettings>` 与 `saveWorkshopLayout(value): Promise<WorkshopLayoutSettings>`。

- [ ] **步骤 1：写失败测试**

断言缺失旧设置返回默认值；合法值可原子保存与重载；NaN、Infinity、负值和超预算值被 Schema 拒绝；Preload 只暴露两个最小方法且 IPC payload 经过解析。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- settings-store.test.ts settings-ipc.test.ts character-workshop-close-preload.test.ts
```

预期：契约和 IPC 尚不存在而失败。

- [ ] **步骤 3：最小实现与 GREEN**

把布局对象作为 SettingsStore 新字段保存；使用现有原子写队列和 IPC 注册模式；不在 pointermove 时保存。

```powershell
pnpm.cmd --filter @myself/desktop test -- settings-store.test.ts settings-ipc.test.ts character-workshop-close-preload.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部通过。

- [ ] **步骤 4：提交**

```powershell
git add apps/desktop/src/shared apps/desktop/src/preload/index.ts apps/desktop/src/main/storage/settings-store.ts apps/desktop/src/main/index.ts apps/desktop/tests
git commit -m "feat: 持久化角色工作台布局"
```

### 任务 3：实现四条可访问分隔器

**文件：**
- 新增：`apps/desktop/src/renderer/src/characters/workshop/WorkshopSplitter.tsx`
- 新增：`apps/desktop/src/renderer/src/characters/workshop/workshop-layout.ts`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- 测试：`apps/desktop/tests/character-workshop-layout.dom.test.tsx`
- 测试：`tests/e2e/desktop.spec.ts`

**接口：**

```ts
export type WorkshopLayoutBounds = Readonly<{ width: number; height: number }>;
export function clampWorkshopLayout(
  value: WorkshopLayoutSettings,
  bounds: WorkshopLayoutBounds
): WorkshopLayoutSettings;
```

`WorkshopSplitter` 接收 `orientation`、`value/min/max`、`onChange` 和 `onCommit`；方向键步长 8px，Shift+方向键 32px。

- [ ] **步骤 1：写纯函数与 DOM 失败测试**

以手算字面期望验证四个尺寸在 1920×1080、1280×720 和小于响应式阈值时的 clamp；DOM 测试验证 pointer capture、方向键、ARIA 值、只在 pointerup/键盘提交时调用保存，以及保存失败时显示非阻塞提示。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-layout.dom.test.tsx
```

预期：模块不存在而失败。

- [ ] **步骤 3：最小实现**

复用 `AnchorEditor` 的 Pointer Capture；用 CSS 变量 `--workshop-left-width`、`--workshop-right-width`、`--workshop-sidebar-top-height`、`--workshop-stage-height` 驱动网格。窗口 resize 时只 clamp 内存值；交互提交时经 `MyselfApi` 保存。

- [ ] **步骤 4：验证 GREEN 与真实 E2E**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-layout.dom.test.tsx
pnpm.cmd test:e2e:desktop -- tests/e2e/desktop.spec.ts
```

E2E 真实拖动每条分隔器，断言目标板块边界变化；关闭并重开工作台后恢复；缩小窗口后各面板不低于最小值；窄屏不显示 separator。

- [ ] **步骤 5：提交**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop apps/desktop/tests/character-workshop-layout.dom.test.tsx tests/e2e/desktop.spec.ts
git commit -m "feat: 增加工作台可调分隔器"
```

### 任务 4：删除皮肤编辑界面并验证包兼容

**文件：**
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 删除：`apps/desktop/src/renderer/src/characters/workshop/SkinList.tsx`
- 删除：`apps/desktop/src/renderer/src/characters/workshop/SkinInspector.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- 修改：`apps/desktop/tests/character-workshop-components.test.tsx`
- 修改：`apps/desktop/tests/character-workshop-store.test.ts`
- 修改：`tests/e2e/desktop.spec.ts`

**接口：**
- 保留：角色包 V2 的 `skins`、`defaultSkinId`、多皮肤导入/导出/编译/发布及运行时读取。
- 删除：只服务工作台皮肤增删改的组件 props、事件和样式。

- [ ] **步骤 1：写失败测试**

断言工作台无“皮肤”板块、无皮肤增删改按钮；导入含两个皮肤的 V2 fixture 后仍保留两个皮肤，编译发布产物的 `defaultSkinId` 与运行时默认素材不变。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-store.test.ts
```

预期：现有 UI 仍渲染皮肤板块而失败。

- [ ] **步骤 3：最小删除与 GREEN**

从 View 删除两个组件入口和相关编辑 handler，删除组件文件及只服务它们的 CSS；不得改角色包 Schema/Store 的兼容数据路径。

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-store.test.ts
pnpm.cmd verify:characters
```

预期：工作台 UI 测试和角色兼容门禁通过。

- [ ] **步骤 4：提交**

```powershell
git add -A apps/desktop/src/renderer/src/characters/workshop apps/desktop/tests tests/e2e/desktop.spec.ts
git commit -m "refactor: 移除工作台皮肤编辑界面"
```

### 任务 5：工作台验收记录与总门禁

**文件：**
- 修改：`docs/operations/character-workshop-acceptance.md`

- [ ] **步骤 1：运行新鲜门禁**

```powershell
pnpm.cmd verify:characters
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

预期：全部通过。

- [ ] **步骤 2：记录实际证据并提交**

只记录实际命令、结果、日期、环境和仍待用户人工确认的窗口层级/拖动手感。

```powershell
git add docs/operations/character-workshop-acceptance.md
git commit -m "docs: 更新角色工作台稳定性验收"
```
