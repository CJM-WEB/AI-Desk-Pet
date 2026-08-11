# 视觉几何与滚轮缩放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；每个任务使用 `test-driven-development`。

**Goal:** 以动作全部可见像素联合包围盒和脚底锚点替代固定透明窗口边界，实现像素命中滚轮缩放、贴边运动与按角色持久化。

**Architecture:** 角色编译阶段生成稳定视觉元数据；Renderer 只报告经过 schema 限制的当前表现几何和滚轮档位；Main `PetVisualGeometry` 校验并持有不可变快照，运动、位置恢复和窗口布局只能消费该快照。

## Task G1：为角色表现生成稳定视觉包围盒

**Files:**

- Modify: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Modify: `apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts`
- Modify: `apps/desktop/tests/character-atlas-compiler.test.ts`
- Modify: `packages/character-runtime/tests/character-v1-converter.test.ts`
- Modify: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Modify: `apps/desktop/src/main/characters/character-asset-service.ts`
- Modify: `apps/desktop/src/main/characters/character-migrations.ts`
- Modify: `apps/desktop/src/main/characters/character-store.ts`
- Modify: `apps/desktop/tests/character-asset-service.test.ts`
- Modify: `apps/desktop/tests/character-store.test.ts`

```ts
type PresentationGeometryV2 = Readonly<{
  visualBounds: { x: number; y: number; width: number; height: number };
  groundAnchor: { x: number; y: number };
  resourceRevision: string;
}>;
// 均按当前表现画布归一化；包围盒覆盖全部帧非透明像素，锚点来自并校验现有 anchors.ground。
```

- [ ] RED：透明边缘裁掉；多帧取联合而非当前帧；全透明资源失败；包围盒/groundAnchor 越界、NaN、零尺寸或资源 revision 不匹配时 schema 拒绝。
- [ ] GREEN：atlas 编译时从已解码 alpha 数据单次累计；把 `visualBounds + groundAnchor + resourceRevision` 作为同一不可拆元数据保存，播放时不逐帧扫描。
- [ ] RED/GREEN：V1/旧 V2 在可信导入时补齐；内置或既有角色绕过导入而首次加载时，由 `character-migrations` 在发布到运行态前原子生成并保存一次。生成失败使用经过 schema 验证的保守默认并报告资源错误，不保留运行双轨。
- [ ] 运行 character-runtime 和 atlas 定向测试；提交 `feat: 编译角色动作视觉包围盒`。

## Task G2：建立 Main 几何权威

**Files:**

- Create: `apps/desktop/src/main/characters/pet-visual-geometry.ts`
- Create: `apps/desktop/tests/pet-visual-geometry.test.ts`
- Modify: `apps/desktop/src/shared/character-motion-ipc.ts`
- Modify: `apps/desktop/tests/character-motion-ipc.test.ts`

```ts
type PetGeometrySnapshot = Readonly<{
  revision: number;
  characterId: string;
  scale: number;
  footAnchorDip: Point;
  visualBoundsInWindowDip: Rectangle;
  windowBoundsDip: Rectangle;
  displayId: string;
}>;
```

- [ ] RED：有限数值、正尺寸、50%–200%、角色/资源 revision、单调 revision；过期/伪造/错误角色拒绝。
- [ ] RED：主表现、modifier 和可见 overlay 取联合；动作内帧切换不改 revision，动作/overlay/scale 切换才更新。
- [ ] GREEN：快照始终 structuredClone/freeze；非法更新保持最后已验证快照并返回稳定错误码。
- [ ] 提交 `feat: 建立桌宠视觉几何权威`。

## Task G3：按角色持久缩放和脚底锚点位置

**Files:**

- Modify: `apps/desktop/src/main/storage/settings-store.ts`
- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/src/main/windows/pet-position.ts`
- Modify: `apps/desktop/tests/pet-position.test.ts`

```ts
type StoredPetPlacement = Readonly<{
  characterId: string;
  scale: number;
  footAnchorDip: Point;
  displayId: string;
}>;
```

- [ ] RED：角色 A/B 缩放独立；默认 1；范围钳制；旧 `{x,y}` 按默认几何一次转换为 foot anchor；成功后只写新格式。
- [ ] RED：显示器消失、负坐标、损坏设置安全恢复到主显示器可见默认；已有主动性和隐私设置不被覆盖。
- [ ] GREEN：设置 schema 新版本或兼容迁移一次完成，删除旧运行读取分支；提交 `refactor: 以脚底锚点持久桌宠位置`。

## Task G4：像素命中滚轮缩放与原子窗口布局

**Files:**

- Modify: `apps/desktop/src/shared/pet-window-interaction.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tests/agent-ipc.test.ts`
- Modify: `apps/desktop/tests/preload-api.test.ts`
- Modify: `apps/desktop/tests/preload-production-boundary.test.ts`
- Modify: `apps/desktop/tests/character-player.test.tsx`
- Modify: `apps/desktop/tests/pixi-character-player.test.ts`
- Modify: `apps/desktop/tests/main-lifecycle.test.ts`

- [ ] RED：只有现有 alpha hit 为 true 且指针悬浮时，wheel 才提交 `step:-1|1`；每格 10%，50%/200% 封顶；透明区域和聊天窗口滚轮不缩放。
- [ ] RED：缩放前后脚底全局 DIP 不变；窗口 bounds、Pixi canvas 和几何 revision 原子提交；失败回滚到旧快照。
- [ ] GREEN：Renderer 只传档位，不传比例、坐标、characterId；Main 根据活动角色和当前快照计算，保存成功后广播新几何。
- [ ] 运行 pet interaction、preload、CharacterPlayer 和 Main lifecycle 测试；提交 `feat: 支持桌宠像素命中滚轮缩放`。

## Task G5：运动和屏幕边界改用可见包围盒

**Files:**

- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/src/main/windows/window-manager.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Modify: `apps/desktop/tests/pet-position.test.ts`

- [ ] RED：50%、100%、200% 下可见矩形能贴工作区四边；透明窗口留白允许越界；可见像素绝不越界。
- [ ] RED：动作切换导致包围盒变化时保持脚底锚点，必要时最小位移回到可见区；跨显示器选择依据脚底/目标区域而非透明窗口中心。
- [ ] GREEN：`constrainTarget` 只消费 `PetGeometrySnapshot`；删除固定 window size 作为运动权威的代码，保留 BrowserWindow bounds 仅为布局结果。
- [ ] 提交 `fix: 以可见角色范围约束桌宠运动`。

## Task G6：视觉几何纵向验收

**Files:**

- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/fixtures/electron-app.ts`
- Create: `docs/operations/pet-visual-geometry-acceptance.md`

- [ ] E2E 覆盖 alpha 命中滚轮、50/200 封顶、脚底稳定、角色切换持久、四边贴边、动作切换无抖动。
- [ ] 测试探针只返回 scale 档位、几何 revision、可见矩形相对窗口的归一化摘要和“是否越界”布尔值，不返回屏幕绝对坐标。
- [ ] 运行阶段固定门和命名 Electron 场景；提交 `test: 验收桌宠视觉几何与缩放`。

## 阶段命令

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:e2e:desktop -- --grep "视觉几何与滚轮缩放"
git diff --check
git diff --name-only -- apps/website
```
