# 视觉几何与滚轮缩放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；每个任务使用 `test-driven-development`。

**Goal:** 以动作全部可见像素联合包围盒和脚底锚点替代固定透明窗口边界，实现像素命中滚轮缩放、贴边运动与按角色持久化。

**Architecture:** 角色编译阶段生成稳定视觉元数据；Renderer 只报告经过 schema 限制的当前表现几何和滚轮档位；Main `PetVisualGeometry` 校验并持有不可变快照，运动、位置恢复和窗口布局只能消费该快照。

## Task 1（G1）：为角色表现生成稳定视觉包围盒

**Files:**

- Create: `packages/character-assets/src/alpha-geometry.ts`
- Create: `packages/character-assets/tests/alpha-geometry.test.ts`
- Create: `packages/character-assets/src/image-metadata.ts`
- Create: `packages/character-assets/tests/image-metadata.test.ts`
- Modify: `packages/character-assets/src/index.ts`
- Modify: `packages/character-assets/src/resource-limits.ts`
- Modify: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Modify: `apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts`
- Modify: `apps/desktop/tests/character-atlas-compiler.test.ts`
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Modify: `apps/desktop/tests/character-workshop-store.test.ts`
- Modify: `packages/character-runtime/tests/character-v1-converter.test.ts`
- Modify: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Modify: `apps/desktop/src/main/characters/character-asset-service.ts`
- Modify: `apps/desktop/src/main/characters/character-migrations.ts`
- Modify: `apps/desktop/src/main/characters/character-store.ts`
- Modify: `apps/desktop/src/main/characters/character-package-service.ts`
- Modify: `apps/desktop/src/main/characters/official-default-character.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/characters/native-image-alpha-decoder.ts`
- Create: `apps/desktop/tests/native-image-alpha-decoder.test.ts`
- Modify: `apps/desktop/tests/character-asset-service.test.ts`
- Modify: `apps/desktop/tests/character-store.test.ts`
- Modify: `apps/desktop/tests/character-package-service.test.ts`
- Modify: `apps/desktop/tests/official-default-character.test.ts`
- Modify: `apps/desktop/tests/character-ipc.test.ts`

```ts
type PresentationGeometryV2 = Readonly<{
  visualBounds: { x: number; y: number; width: number; height: number };
  groundAnchor: { x: number; y: number };
  resourceRevision: string;
}>;
// 均按当前表现画布归一化；包围盒覆盖全部帧非透明像素，锚点来自并校验现有 anchors.ground。
```

- [x] RED：共享纯函数按表现 ground 对齐各帧 Alpha；透明边缘裁掉；多帧取联合而非当前帧；全透明资源失败。包围盒/groundAnchor 越界、NaN、零尺寸或资源 revision 不匹配时严格 manifest 校验拒绝。
- [x] GREEN：atlas 编译时复用 `character-assets` 的纯 Alpha 联合函数单次累计；`compileBrowserAction()` 和工作室正式 manifest 组装点必须把 `visualBounds + groundAnchor + resourceRevision` 作为同一不可拆元数据保存，播放时不逐帧扫描。草稿允许暂缺 geometry，正式 manifest 必须具备完整 geometry。
- [x] RED/GREEN：V1/旧 V2 使用两阶段迁移。纯结构转换只产生不可运行的 prepared document；`CharacterStore`、角色包导入和内置角色安装必须在资源完整性校验后注入 `nativeImage` 解码器、复用同一纯 Alpha 函数补齐，再通过严格 manifest schema 并原子保存一次。任何运行读取只返回最终严格 document；不得让 optional geometry 成为长期运行双轨。生成失败使用经过 schema 验证的保守默认并发布稳定、无路径诊断。
- [x] 安全收口：PNG/WebP 在进入 `nativeImage` 前复用共享结构与尺寸解析并核对解码尺寸；prepared/正式表现限制帧数、单帧尺寸和累计面积，可信迁移删除旧 V2 空表现且不修补默认播放链；Alpha 联合使用 stride 累计器按资源串行解码，禁止全局解码缓存、并行解码和逐帧裁切副本形成峰值路径。
- [x] 运行 character-runtime 和 atlas 定向测试；提交 `feat: 编译角色动作视觉包围盒`。

## Task 2a（G2a）：收口准备态与正式清单静态类型

**Files:**

- Modify: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/src/character-v1-converter.ts`
- Modify: `packages/character-runtime/src/character-presentation-resolver.ts`
- Modify: `packages/character-runtime/src/behavior-action-selector.ts`
- Modify: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Modify: `packages/character-runtime/tests/behavior-action-selector.test.ts`
- Modify: `packages/character-runtime/tests/behavior-scheduler.test.ts`
- Modify: `packages/character-runtime/tests/behavior-target-resolver.test.ts`
- Modify: `packages/character-runtime/tests/character-behavior-engine.test.ts`
- Modify: `packages/character-runtime/tests/legacy-runtime-projection.test.ts`
- Modify: `apps/desktop/src/main/characters/character-migrations.ts`
- Modify: `apps/desktop/src/main/characters/character-store.ts`
- Modify: `apps/desktop/src/main/characters/character-package-service.ts`
- Modify: `apps/desktop/src/main/characters/official-default-character.ts`
- Modify: `apps/desktop/tests/character-behavior-service.test.ts`
- Modify: `apps/desktop/tests/character-package-service.test.ts`
- Modify: `apps/desktop/tests/character-store.test.ts`
- Modify: `apps/desktop/tests/character-ipc.test.ts`
- Modify: `apps/desktop/tests/character-workshop-store.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/fixtures/character-compile-process.mjs`
- Modify: `tests/fixtures/character-workshop-assets.ts`

- [x] RED：类型断言证明正式 `CharacterManifestV2` 的 `geometry` 必填，`PreparedCharacterManifestV2` 仍可缺失。
- [x] GREEN：V1 converter 只返回 Prepared；迁移结果用 `requiresPersistence` 判别准备态与正式态，且 `characterManifestV2Schema.parse()` 是唯一类型提升点。
- [x] GREEN：Store、Package 和内置角色在资源校验前只持有 Prepared；behavior 与 legacy projection 仍只接受正式清单，resolver 与选择结果保留 Published 表现的必填几何。
- [x] 验收：character-runtime 与 desktop 相关定向测试、typecheck 及 integration 通过，无 `as CharacterManifestV2` 掩盖；behavior 单元与集成清单均由严格 Schema 自证。同时补齐 G1 遗漏的编译子进程 Canvas Alpha double，保持真实几何编译链可验收。

## Task 2（G2）：建立 Main 几何权威

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

## Task 3（G3）：按角色持久缩放和脚底锚点位置

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

## Task 4（G4）：像素命中滚轮缩放与原子窗口布局

**Files:**

- Modify: `apps/desktop/src/shared/pet-window-interaction.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/pet/pet-interaction-controller.ts`
- Modify: `apps/desktop/src/renderer/src/pet/PetView.tsx`
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

## Task 5（G5）：运动和屏幕边界改用可见包围盒

**Files:**

- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/src/main/windows/window-manager.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Modify: `apps/desktop/tests/pet-position.test.ts`

- [ ] RED：50%、100%、200% 下可见矩形能贴工作区四边；透明窗口留白允许越界；可见像素绝不越界。
- [ ] RED：动作切换导致包围盒变化时保持脚底锚点，必要时最小位移回到可见区；跨显示器选择依据脚底/目标区域而非透明窗口中心。
- [ ] GREEN：`constrainTarget` 只消费 `PetGeometrySnapshot`；删除固定 window size 作为运动权威的代码，保留 BrowserWindow bounds 仅为布局结果。
- [ ] 提交 `fix: 以可见角色范围约束桌宠运动`。

## Task 6（G6）：视觉几何纵向验收

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
