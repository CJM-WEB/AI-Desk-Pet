# 角色发布播放参数实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作台设置的动作播放倍速与素材水平反转进入正式角色包，并由实际桌宠稳定消费。

**Architecture:** 在 V2 动作表现与旧播放器 `ActionClip` 中复用同一组可选字段，编译与投影只负责保真传递；工作台把当前动作预览控件写回正式草稿表现；实际播放器统一裁决默认倍速和“运动方向 XOR 素材反转”。不改动图片资源和权限边界。

**Tech Stack:** TypeScript、Zod、React、Zustand、PixiJS、Vitest、Playwright、pnpm workspace

## Global Constraints

- `playbackRate` 范围固定为 `0.25` 至 `2`，缺失时等价于 `1`。
- `mirrorX` 缺失时等价于 `false`，不得复用 `action.direction`。
- 参数按“皮肤 × 动作”保存；预览播放状态、当前帧和背景不进入角色包。
- 不新增依赖、运行时、MCP、脚本权限或资源烘焙路径。
- 全部生产改动执行 RED → GREEN → REFACTOR；文档与结构性注释使用中文。
- 保留用户既有未提交修改，不修改无关模块。

---

### Task 1: 稳定正式契约与投影

**Files:**
- Modify: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/src/character-schema.ts`
- Modify: `packages/character-runtime/src/legacy-runtime-projection.ts`
- Test: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Test: `packages/character-runtime/tests/legacy-runtime-projection.test.ts`

**Interfaces:**
- Produces: `CharacterActionPresentationV2.playbackRate?: number`、`mirrorX?: boolean`。
- Produces: `ActionClip.playbackRate?: number`、`mirrorX?: boolean`，供工作台和播放器消费。

- [ ] **Step 1: 写 V2 Schema RED 测试**

覆盖 `0.25`、`2`、字段缺失可通过，并断言 `0.24`、`2.01`、`NaN` 被拒绝；断言 `mirrorX` 只接受布尔值。

- [ ] **Step 2: 运行 Schema 测试并确认因字段被严格 Schema 拒绝而失败**

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-v2-schema.test.ts`

- [ ] **Step 3: 最小扩展 V2 与 ActionClip Schema**

在表现字段和动作片段公共字段中增加相同的可选受限字段，不给旧清单增加迁移要求。

- [ ] **Step 4: 写投影 RED 测试**

断言显式 `playbackRate: 1.5`、`mirrorX: true` 被保留；字段缺失时投影仍可解析且播放器可采用默认值。

- [ ] **Step 5: 运行投影测试并确认字段当前丢失**

Run: `pnpm.cmd --filter @myself/character-runtime test -- legacy-runtime-projection.test.ts`

- [ ] **Step 6: 最小实现投影并运行定向包测试**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Expected: PASS。

### Task 2: 工作台把预览参数写入正式表现

**Files:**
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`
- Test: `apps/desktop/tests/character-action-editor.dom.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `CharacterActionPresentationV2.playbackRate` 与 `mirrorX`。
- Produces: `updateCurrentAction` 可写入两个表现字段；选中表现向预览提供归一化值。

- [ ] **Step 1: 写 store RED 测试**

断言当前表现可保存两字段；回退表现首次编辑时克隆当前皮肤覆盖；编译后的发布输入保留显式字段。

- [ ] **Step 2: 运行 store 测试并确认字段尚未进入草稿或编译输出**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts`

- [ ] **Step 3: 最小扩展 store 更新与编译映射**

把字段纳入 `LegacyWorkshopActionPatch` 对应表现分支和编译表现对象；继续复用现有回退克隆与草稿脏标记流程。

- [ ] **Step 4: 写 DOM RED 测试**

断言切换动作/皮肤时倍速和方向从解析表现恢复；控件变化既更新即时预览，也调用 store 写入当前表现；播放/暂停与当前帧不写入表现。

- [ ] **Step 5: 运行 DOM 测试并确认当前仅改变 React 预览状态**

Run: `pnpm.cmd --filter @myself/desktop test -- character-action-editor.dom.test.tsx`

- [ ] **Step 6: 最小修改工作台绑定并运行两组定向测试**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts character-action-editor.dom.test.tsx`

Expected: PASS。

### Task 3: 实际桌宠消费发布参数

**Files:**
- Modify: `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- Test: `apps/desktop/tests/pixi-character-player.test.ts`
- Test: `apps/desktop/tests/character-player.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ActionClip.playbackRate` 与 `mirrorX`。
- Produces: 实际场景调用的 `speed` 为发布倍速，`direction` 为运动方向与 `mirrorX` 的异或结果。

- [ ] **Step 1: 写播放器 RED 测试**

断言首次播放使用显式倍速，缺失时使用 `1`；断言四种运动方向与 `mirrorX` 组合产生规格表中的有效方向。

- [ ] **Step 2: 运行播放器测试并确认失败原因是固定 `speed: 1` 与未消费反转**

Run: `pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts character-player.test.tsx`

- [ ] **Step 3: 最小实现统一播放参数裁决**

提取一个模块内私有解析函数，在首次播放和方向切换重建时共同使用；Pixi 场景接口与布局算法保持不变。

- [ ] **Step 4: 运行播放器定向测试**

Run: `pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts character-player.test.tsx`

Expected: PASS。

### Task 4: 集成验证与事实记录

**Files:**
- Create: `docs/operations/character-published-playback-acceptance.md`

**Interfaces:**
- Consumes: Task 1–3 的正式链路。
- Produces: 仅记录实际运行证据与用户待验收项的独立中文验收记录。

- [ ] **Step 1: 运行角色包定向测试和类型检查**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Run: `pnpm.cmd --filter @myself/desktop test`

- [ ] **Step 2: 运行角色质量门禁**

Run: `pnpm.cmd verify:characters`

Expected: 所有自动化命令退出码为 `0`；真实 Windows 视觉效果标记为“待用户人工确认”。

- [ ] **Step 3: 检查最小差异与无意文件**

Run: `git diff --check`

Run: `git status --short`

只读复核不得包含用户原有两处未提交文档修改之外的无关文件。

- [ ] **Step 4: 写独立验收记录**

记录日期、环境、实际命令、通过/失败数量、未覆盖项和用户需要执行的最终总体验验收；不得把未观察的窗口效果写成通过。
