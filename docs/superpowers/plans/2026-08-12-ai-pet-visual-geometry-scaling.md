# 视觉几何与滚轮缩放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；每个任务使用 `test-driven-development`。

**Goal:** 以动作全部可见像素联合包围盒和脚底锚点替代固定透明窗口边界，实现像素命中滚轮缩放、贴边运动与按角色持久化。

**Architecture:** 角色编译阶段生成稳定视觉元数据；Renderer 后续只报告经过 schema 限制的 window-local viewport 矩形和滚轮档位，不报告最终几何或全局坐标；Main 从严格 Manifest、已授权动作、资源修订、方向、BrowserWindow 和 display 数据计算并持有不可变 `PetVisualGeometry` 快照，运动、位置恢复和窗口布局只能消费该快照。

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
- Modify: `apps/desktop/src/main/characters/pet-visual-geometry.ts`
- Modify: `apps/desktop/tests/pet-visual-geometry.test.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-service.ts`
- Modify: `apps/desktop/tests/character-behavior-service.test.ts`
- Create: `apps/desktop/src/main/windows/pet-geometry-coordinator.ts`
- Create: `apps/desktop/tests/pet-geometry-coordinator.test.ts`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/tests/pet-interaction-controller.test.ts`
- Modify: `apps/desktop/tests/pet-view.test.tsx`
- Modify: `apps/desktop/tests/pet-window-interaction-controller.test.ts`
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

## Task 2b（G2b）：建立 Main 私有几何权威纯模块

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

- [x] RED：有限数值、正尺寸、50%–200%、严格角色/action/resource revision、方向和单调几何 revision；同角色同 action revision 绑定 skin/action/resource，过期、绑定冲突、伪造、错误角色、未知动作和资源修订不匹配均返回稳定错误码；显式换角色只重置 action revision 基线。
- [x] RED：当前正式播放器只有一个可见主表现，`modifierStateIds` 只筛选动作且不进入几何输入，生产可见表现集合长度固定为 1；纯矩形联合 seam 只接收已转换到共同脚底 DIP 坐标系的矩形并支持多输入，但不得以合成测试宣称 overlay 已接入。
- [x] RED：逐帧通知不进入几何输入；角色、动作、direction、scale、viewport size 或真实可见表现集合变化才自增。窗口移动、viewport offset 和 display placement 更新不改变几何 revision；未来如需位置排序另设 `placementRevision`。
- [x] RED：完整 `PetGeometrySnapshot` 只在 Main 内可见；共享 IPC schema 只允许去全局坐标视图，拒绝 `characterId`、资源 hash、`displayId`、全局 foot anchor、全局 window bounds 和最终全局视觉 bounds。
- [x] GREEN：低频 `updateShape` 从严格 Manifest presentation、action/resource revision、direction、scale 和实际 window-local viewport size 计算 pending 共同脚底 DIP 形状，不修改 active 元数据或快照；廉价 `updatePlacement` 只收 `baseRevision`、同尺寸 viewport、BrowserWindow bounds 和 display，按 revision 选择 pending/active 且不解析 Manifest。pending placement 全部成功后才原子提交 active 与快照；失败后旧 active 仍可 placement，`discardPendingShape()` 幂等回滚 pending。viewport 是已应用缩放的实际窗口局部矩形；窗口与 display 工作区必须正面积相交。
- [x] GREEN：快照始终 structuredClone 并深层 freeze；矩形字段、右/下边界与最终派生几何均验证有限数值和正尺寸，非法 shape/placement 保持最后已验证快照并返回稳定错误码。Authority 不接收逐帧通知；revision 使用安全整数。G2b 只交付纯模块与契约测试，不注册 IPC、不接 Main 生命周期，也不宣称运行链已经启用。
- [x] 提交 `feat: 建立桌宠视觉几何权威`。

## Task 3（G3）：按角色持久缩放和脚底锚点位置

**Files:**

- Modify: `apps/desktop/src/main/storage/settings-store.ts`
- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/tests/provider-settings-migration.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings-store.test.ts`
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

- [x] RED：角色 A/B 缩放独立；默认 1；范围钳制；旧 `{x,y}` 只迁移为明确的 pending 状态，不用固定窗口或 CSS 留白猜脚底；取得真实 `footOffsetInViewportDip`，与 viewport 窗口内 offset 合成为 `footOffsetInWindowDip`，再连同 `visualBoundsFromFootDip` 完成一次转换，成功后只写 ready 新格式。
- [x] RED：显示器消失、负坐标、损坏设置安全恢复到主显示器可见默认；已有主动性和隐私设置不被覆盖。
- [x] GREEN：设置 schema 升至 V3 discriminated placement state；交付按角色持久化、只读 pending、legacy 坐标 CAS 提交和纯迁移/恢复 seam。G2 authority 同步提供不提交 pending 的 Main 私有 shape layout 只读投影；位置恢复只以视觉 bounds 约束脚底，透明窗口可越屏。因 G3 尚无 Renderer 实际 viewport，旧 Main/PublicSettings 兼容只保留到 G4；G4 首次成功几何提交后原子转为 ready，并删除旧运行读写分支。提交 `refactor: 以脚底锚点持久桌宠位置`。

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
- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `apps/desktop/tests/agent-ipc.test.ts`
- Modify: `apps/desktop/tests/preload-api.test.ts`
- Modify: `apps/desktop/tests/preload-production-boundary.test.ts`
- Modify: `apps/desktop/tests/character-player.test.tsx`
- Modify: `apps/desktop/tests/pixi-character-player.test.ts`
- Modify: `apps/desktop/tests/main-lifecycle.test.ts`

> 文件清单补缝：G2b 基线只有立即提交的 `updatePlacement`，缺少本任务原子布局失败时恢复旧 active 快照所需的事务 seam；G4 在同一几何权威中最小补充 prepare/commit/rollback/discard，不建立第二套权威。
>
> 协议补缝：G4 使用 `pet-window:viewport-commit`、`pet-window:scale-step` 两条 invoke 和 `pet-window:geometry-render` 单向事件；viewport invoke 同时作为 resize ack，Main 最多等待 2000ms。Main 以单 FIFO 串行布局，缩放使用 5–20 整数 tick，首次实际 viewport 与已提交 scale 构成 canonical base；Renderer 不提供身份、资源、全局坐标或最终 bounds。为验证真实 owner，补入交互控制器、PetView、Main 窗口 IPC、行为绑定与独立原子布局协调器测试。

- [x] RED：只有现有 alpha hit 为 true 且指针悬浮时，wheel 才提交 `step:-1|1`；每格 10%，50%/200% 封顶；透明区域和聊天窗口滚轮不缩放。
- [x] RED：Renderer 只可提交严格 window-local viewport 矩形；Main 绑定当前正式角色和动作后自行计算几何，拒绝 Renderer 提交角色 ID、资源 hash、全局坐标或最终 bounds。
- [x] RED：V3 pending legacy 只在首次真实几何提交后转换；转换失败保留 pending 与旧窗口位置，成功后 PublicSettings/Settings IPC 不再包含任何桌面全局位置。
- [x] RED：缩放前后脚底全局 DIP 不变；窗口 bounds、Pixi canvas 和几何 revision 原子提交；失败回滚到旧快照。
- [x] GREEN：G4 负责 viewport 与滚轮 IPC、Preload、Renderer 和 Main 生命周期接线；Renderer 滚轮只传档位，不传比例、全局坐标或 characterId，Main 保存成功后只广播去全局坐标的几何渲染视图；删除 `savePetPosition`、`restorePetPosition` 与 PublicSettings `petPosition` 旧运行路径，只保留 V3 ready placements。
- [x] 运行 pet interaction、preload、CharacterPlayer 和 Main lifecycle 测试；提交 `feat: 支持桌宠像素命中滚轮缩放`。

## Task 5（G5）：运动和屏幕边界改用可见包围盒

**Files:**

- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/src/main/windows/window-manager.ts`
- Modify: `apps/desktop/src/main/windows/pet-position.ts`
- Modify: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`
- Modify: `apps/desktop/src/main/windows/pet-geometry-coordinator.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Modify: `apps/desktop/tests/pet-position.test.ts`
- Modify: `apps/desktop/tests/pet-window-interaction-controller.test.ts`
- Modify: `apps/desktop/tests/pet-geometry-coordinator.test.ts`

> 文件清单补缝：只读调查确认用户拖拽虽使用“起点 + 光标总位移”而不存在逐帧累加，但边界仍调用固定窗口尺寸钳制；若只改自动运动，透明留白仍会让手动拖拽在右/下边提前停止。G5 因而让运动与拖拽共同复用一套 Main 私有的“脚底锚点 + 可见包围盒”约束，不扩展 Renderer 或 IPC 坐标权限。
>
> 事务补缝：动作与方向几何在自动运动期间发生变化时，旧 `isLayoutInFlight()` 只覆盖 viewport waiter，无法阻止持久化中的 motion tick；旧 layout blocker 又会把新动作形状延后到运动结束。G5 将 in-flight 扩为整个几何 FIFO，只允许 binding 在自动运动期间进入该 FIFO，真实用户拖拽期间仍冻结；普通缩放和 viewport settle 继续等待运动结束。

- [x] RED：50%、100%、200% 下可见矩形能贴工作区四边；透明窗口留白允许越界；可见像素绝不越界。
- [x] RED：小数可见边界在 Windows 整数窗口坐标上向内量化，贴右/下边不允许出现最多 0.5 DIP 的舍入溢出；视觉矩形大于工作区时稳定拒绝而不伪装成已约束。
- [x] RED：动作切换导致包围盒变化时保持脚底锚点，必要时最小位移回到可见区；跨显示器选择依据脚底/目标区域而非透明窗口中心。
- [x] RED：手动拖拽在 50% 与 200% 下也以可见矩形贴四边，保留负坐标副屏与“起点 + 总位移”既有语义。
- [x] RED：无 viewport waiter 但几何 FIFO 仍在持久化时暂停 motion tick；自动运动期间允许动作/方向 binding 原子提交，真实拖拽期间仍只保留最终 binding；布局改变窗口原点时活动运动目标按同一差值重基。
- [x] GREEN：G5 首次把 G2b Main 私有快照接入运动与拖拽边界；`constrainTarget` 只消费 `PetGeometrySnapshot`，删除固定 window size 作为正式运动权威的代码，保留 BrowserWindow bounds 仅为布局结果，并让位置恢复复用同一纯约束数学。
- [x] 提交 `fix: 以可见角色范围约束桌宠运动`。

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
