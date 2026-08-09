# 删除目录藏身并保留 Explorer 动态图层实施计划

> **面向执行智能体：** 必须使用 `superpowers:subagent-driven-development` 按任务逐项实施。每个任务使用独立实现智能体、任务级规格/质量复审和最多五轮修复闭环。

**目标：** 彻底删除目录藏身业务，只保留不改变桌宠可见性的 Explorer 动态 `moveAbove` 图层。

**架构：** 固定 Explorer helper 和认证 bridge 只发布窗口身份、矩形与前台事实；`ExplorerPetLayerCoordinator` 串行校验代次与序列，并把准确前台 Explorer HWND 交给 Electron-only `ExplorerWindowLayerController`。其他快照和所有失败均保持普通桌宠窗口不变。

**技术栈：** Electron 43、TypeScript、Vitest、PowerShell、C# `Add-Type` helper、Zod 严格协议、pnpm workspace。

## 全局约束

- 所有新增文档和代码注释必须使用中文。
- `BrowserWindow` 必须保持 `alwaysOnTop: false`。
- 图层协调器和图层控制器不得调用 `show`、`hide`、`focus`、`setPosition` 或 `setAlwaysOnTop(true)`。
- 非 Explorer、失焦、最小化、歧义、不可用、陈旧序列、桥错误和 `moveAbove` 失败均不得改变桌宠可见性。
- 只保留 Electron `moveAbove` 路线；不得恢复 User32 `SetWindowPos` 或其他层级回退。
- Explorer 路径在任何生产边界都不得采集或传递；认证内部 bridge 快照可把 HWND/实例交给 Main 严格类型，日志、Renderer、preload、Agent 和 E2E 控制面不得包含 HWND 或实例私有事实。
- 新版本不读取、不迁移且不自动删除旧 `habitat.json`。
- 删除被替代的旧代码，不保留兼容壳、环境开关、双路线或无引用导出。
- 当前未提交的 Task 12 人工验收、托盘预采样修复及其文档已被本计划取代，不得进入最终提交。
- 每个单一阻点最多连续投入 10 分钟；超时后必须缩小复现、切换诊断方法或拆分任务，不能直接跳过安全门。
- 测试必须先取得与目标缺口一致的 RED，再写最小 GREEN；不得用源码字符串断言替代真实行为测试。

---

### Task 1：建立不改变可见性的 Explorer 图层核心

**文件：**

- 新建：`apps/desktop/src/main/explorer/explorer-pet-layer-coordinator.ts`
- 新建：`apps/desktop/tests/explorer-pet-layer-coordinator.test.ts`
- 修改：`apps/desktop/src/main/habitat/explorer-window-layer-controller.ts`
- 修改：`apps/desktop/tests/explorer-window-layer-controller.test.ts`

**接口：**

- 输入：严格快照的 `{ nonce, sequence, status, instanceId?, hwnd?, foreground?, minimized? }` 子集或桥错误。
- 输出：`ExplorerPetLayerCoordinator.accept(observation): Promise<void>`、`close(): Promise<void>`。
- 图层端口：`activate({ explorerHwnd }): Promise<void>`、`dispose(): Promise<void>`；不再暴露 `invalidate`、`leave` 或 `hide`。

- [ ] **Step 1：编写协调器 RED**

```ts
test('只有当前代次内递增的准确前台 Explorer 才调整层级', async () => {
  const effects: string[] = [];
  const coordinator = new ExplorerPetLayerCoordinator({
    layer: {
      activate: async ({ explorerHwnd }) => { effects.push(`move:${explorerHwnd}`); },
      dispose: async () => { effects.push('dispose'); }
    },
    reportError: code => effects.push(`error:${code}`)
  });

  await coordinator.accept({
    nonce: 'a'.repeat(32), sequence: 1, status: 'ready', instanceId: 'i-1',
    hwnd: '101', foreground: true, minimized: false
  });
  await coordinator.accept({
    nonce: 'a'.repeat(32), sequence: 1, status: 'ready', instanceId: 'i-1',
    hwnd: '101', foreground: true, minimized: false
  });
  await coordinator.accept({
    nonce: 'a'.repeat(32), sequence: 2, status: 'none'
  });

  expect(effects).toEqual(['move:101']);
});
```

另写行为用例验证：新 nonce 重置水位；旧异步完成不覆盖新窗口；失焦、最小化、歧义、不可用和错误不调用窗口可见性接口；`close` 等待当前调用并拒绝后续动作。

- [ ] **Step 2：运行 RED**

运行：

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explorer-pet-layer-coordinator.test.ts tests/explorer-window-layer-controller.test.ts
```

预期：因协调器不存在、旧控制器仍要求 `hide` 并在错误时隐藏而失败。

- [ ] **Step 3：实现最小 GREEN**

协调器使用单一 Promise 队列和 `{ nonce, sequence }` 水位。`ready` 之外的状态只推进水位；层级失败只调用 `reportError('EXPLORER_LAYER_FAILED')`。控制器窗口端口缩减为：

```ts
export interface ExplorerLayerWindow {
  moveAbove(mediaSourceId: string): void;
  isDestroyed(): boolean;
  isAlwaysOnTop(): boolean;
}
```

删除旧 `hideSafely`、`invalidate`、`leave` 和所有隐藏调用；保留规范十进制 HWND、非 topmost 与 destroyed 校验。

- [ ] **Step 4：运行 GREEN 与类型检查**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explorer-pet-layer-coordinator.test.ts tests/explorer-window-layer-controller.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **Step 5：提交**

```powershell
git add -- apps/desktop/src/main/explorer/explorer-pet-layer-coordinator.ts apps/desktop/src/main/habitat/explorer-window-layer-controller.ts apps/desktop/tests/explorer-pet-layer-coordinator.test.ts apps/desktop/tests/explorer-window-layer-controller.test.ts
git commit -m "feat: 建立独立 Explorer 动态图层"
```

---

### Task 2：删除目录空间公开入口

**文件：**

- 删除：`apps/desktop/src/renderer/src/settings/HabitatSettings.tsx`
- 删除：`apps/desktop/src/shared/habitat-ipc.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-settings-service.ts`
- 删除：`apps/desktop/tests/habitat-settings.test.tsx`
- 删除：`apps/desktop/tests/habitat-ipc.test.ts`
- 修改：`apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/main/windows/window-commands.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/preload-api.test.ts`
- 修改：`apps/desktop/tests/preload-production-boundary.test.ts`
- 修改：`apps/desktop/tests/multi-provider-settings.test.tsx`
- 修改：`apps/desktop/tests/pet-summon.test.ts`
- 修改：`apps/desktop/tests/window-commands.test.ts`

**接口：**

- 删除全部 `habitat:*` IPC、8 个 preload 方法、Habitat Dashboard DTO 和设置页空间标签。
- 托盘恢复为普通显示/隐藏、聊天、角色工作室、设置与退出。

- [ ] **Step 1：编写公开行为 RED**

更新真实设置页、preload 边界和托盘测试，期望：

```ts
expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);
expect(Object.keys(exposedApi)).not.toContain('getHabitatDashboard');
expect(trayLabels).not.toEqual(expect.arrayContaining(['藏到目录', '呼唤桌宠', '召回桌面']));
```

使用真实 `SettingsView`、生产 preload 工厂和 `Menu.buildFromTemplate` 结果，不用源码扫描代替行为。

- [ ] **Step 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/habitat-settings.test.tsx tests/preload-api.test.ts tests/preload-production-boundary.test.ts tests/multi-provider-settings.test.tsx tests/pet-summon.test.ts tests/habitat-ipc.test.ts
```

预期：空间标签、API、IPC 与托盘命令仍存在。

- [ ] **Step 3：删除公开入口和被替代代码**

删除组件、schema、service、注册函数和导出；从 `index.ts` 删除 Habitat settings 组合与托盘命令。普通 `togglePetVisibility` 保留且执行时只读取窗口可见性，不读取 Habitat 状态。

- [ ] **Step 4：运行 GREEN 与类型检查**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/preload-api.test.ts tests/preload-production-boundary.test.ts tests/multi-provider-settings.test.tsx tests/pet-summon.test.ts tests/window-commands.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **Step 5：提交**

只暂存本任务列出的公开入口文件及对应测试，提交：

```powershell
git commit -m "refactor: 删除目录空间公开入口"
```

---

### Task 3：删除目录空间角色表现语义

**文件：**

- 修改：`packages/character-runtime/src/behavior-contracts.ts`
- 修改：`packages/character-runtime/src/behavior-state-inference.ts`
- 修改：`packages/character-runtime/src/behavior-action-selector.ts`
- 修改：`packages/character-runtime/src/character-behavior-engine.ts`
- 修改：`packages/character-runtime/src/character-v2-schema.ts`
- 修改：`packages/character-runtime/src/character-v1-converter.ts`
- 修改：`packages/character-runtime/src/legacy-runtime-projection.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 修改：`apps/desktop/src/main/characters/official-default-character.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`packages/character-runtime/tests/behavior-contracts.test.ts`
- 修改：`packages/character-runtime/tests/behavior-state-inference.test.ts`
- 修改：`packages/character-runtime/tests/behavior-action-selector.test.ts`
- 修改：`packages/character-runtime/tests/character-behavior-engine.test.ts`
- 修改：`packages/character-runtime/tests/character-v2-schema.test.ts`
- 修改：`packages/character-runtime/tests/character-v1-converter.test.ts`
- 修改：`packages/character-runtime/tests/legacy-runtime-projection.test.ts`
- 修改：`apps/desktop/tests/character-behavior-service.test.ts`
- 修改：`apps/desktop/tests/official-default-character.test.ts`
- 修改：`apps/desktop/tests/character-action-editor.test.tsx`

**接口：**

- 从标准语义删除 `habitat-enter`、`habitat-found`、`habitat-hidden`、`habitat-lost`。
- 删除专用 `hide`、`emerge` 状态、调度方法、等待令牌和固定 move/idle 回退。
- 保留通用 `semanticFallbacks` 机制以及 carry 等非 Habitat 语义。

- [ ] **Step 1：编写兼容行为 RED**

更新 V1 转换、V2 schema、行为推断和默认角色测试，以普通角色行为为手工期望：

```ts
expect(STANDARD_CHARACTER_SEMANTICS).toEqual(['carry-start', 'carry-stop']);
expect(converted.skins[0]?.semanticFallbacks).toEqual([]);
expect(official.actions.map(action => action.state)).not.toEqual(
  expect.arrayContaining(['hide', 'emerge'])
);
```

同时验证 carry fallback 和 idle/moving 推断仍正常。

- [ ] **Step 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/character-behavior-service.test.ts tests/official-default-character.test.ts tests/character-action-editor.test.tsx
```

- [ ] **Step 3：最小删除 Habitat 语义**

删除所有专用事实、分支、API 和 Main 调用；同步清理无引用私有方法、timer 与测试 helper。不得把 generic `semanticFallbacks` 整体删除。

- [ ] **Step 4：运行 GREEN**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/character-behavior-service.test.ts tests/official-default-character.test.ts tests/character-action-editor.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **Step 5：提交**

```powershell
git commit -m "refactor: 删除目录空间角色表现"
```

---

### Task 4：用纯图层组合替换 Habitat Main 状态机

**文件：**

- 删除：`apps/desktop/src/main/habitat/folder-identity-resolver.ts`
- 删除：`apps/desktop/src/main/habitat/foreground-fullscreen-probe.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-autonomy-policy.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-directory-policy.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-errors.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-motion-region.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-service.ts`
- 删除：`apps/desktop/src/main/habitat/habitat-window-controller.ts`
- 删除：`apps/desktop/src/main/habitat/pet-habitat-store.ts`
- 删除：`apps/desktop/tests/habitat-directory-policy.test.ts`
- 删除：`apps/desktop/tests/habitat-autonomy-policy.test.ts`
- 删除：`apps/desktop/tests/habitat-motion-region.test.ts`
- 删除：`apps/desktop/tests/habitat-service.test.ts`
- 删除：`apps/desktop/tests/habitat-window-controller.test.ts`
- 删除：`apps/desktop/tests/pet-habitat-store.test.ts`
- 新建：`apps/desktop/src/main/lifecycle/main-lifecycle.ts`
- 新建：`apps/desktop/tests/main-lifecycle.test.ts`
- 新建：`apps/desktop/tests/explorer-main-wiring.test.ts`
- 修改并最终删除：`apps/desktop/src/main/habitat/habitat-main-lifecycle.ts`
- 修改并最终删除：`apps/desktop/tests/habitat-main-lifecycle.test.ts`
- 修改并最终删除：`apps/desktop/tests/habitat-main-wiring.test.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/main/windows/pet-position.ts`
- 修改：`apps/desktop/src/main/characters/character-motion-service.ts`
- 修改：生命周期、位置、运动、Main wiring 与安全测试。

**接口：**

- Main 启动 Explorer client 后，把快照直接交给 `ExplorerPetLayerCoordinator`。
- bridge 启动或运行失败只报告稳定码，桌宠照常显示。
- `PetPositionController` 只保留 desktop 坐标写入和 `freezeAndFlush`。
- `CharacterMotionService` 删除仅供目录区域使用的 `setMovementRegions`；若 `setSuspended` 无其他生产调用则一并删除。

- [ ] **Step 1：编写 Main 组合 RED**

使用可注入的真实协调器端口验证：

```ts
await composition.onExplorerSnapshot(readySnapshot);
expect(effects).toEqual(['move:101']);

await composition.onExplorerSnapshot({ ...readySnapshot, sequence: 2, status: 'none' });
await composition.onExplorerError(new Error('PRIVATE'));
expect(effects).toEqual(['move:101', 'error:EXPLORER_BRIDGE_FAILED']);
expect(windowVisible).toBe(true);
```

另验证启动失败仍执行普通桌宠显示、退出顺序为 timer/协调器/bridge/位置/既有服务。

- [ ] **Step 2：运行 RED**

运行 Main wiring、生命周期、位置、运动和 window-security 精确测试；预期旧组合仍创建 Habitat Store/Service 并控制隐藏。

- [ ] **Step 3：原子切换 Main**

复用现有 Explorer client、完整性校验、退出协调和 startup cleanup；删除 Store、目录策略、HabitatService、HabitatWindowController、自动策略、全屏探针与目录状态恢复。普通桌宠显示意图不再依赖 Habitat 状态。

将仍被角色/退出复用的通用生命周期函数迁移到 `main/lifecycle/main-lifecycle.ts`，更新全部导入后删除旧文件。删除 folder/localOffset 持久化分支及其 generation 代码，但保留退出前 `freezeAndFlush`。

- [ ] **Step 4：运行 GREEN**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explorer-pet-layer-coordinator.test.ts tests/habitat-main-wiring.test.ts tests/habitat-main-lifecycle.test.ts tests/pet-position.test.ts tests/character-motion-controller.test.ts tests/window-security.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

删除测试文件后，命令中只保留迁移后的新文件名；不得为让命令通过保留空旧测试。

- [ ] **Step 5：提交**

```powershell
git commit -m "refactor: 用 Explorer 图层替换目录状态机"
```

---

### Task 5：删除 Explorer 路径事实并迁移模块

**文件：**

- 修改：`apps/desktop/resources/windows/explorer-space-shell-tab-helper.cs`
- 修改：`apps/desktop/resources/windows/explorer-space-bridge.ps1`
- 迁移：`apps/desktop/src/main/habitat/explorer-space-protocol.ts` → `apps/desktop/src/main/explorer/explorer-space-protocol.ts`
- 迁移：`apps/desktop/src/main/habitat/explorer-space-client.ts` → `apps/desktop/src/main/explorer/explorer-space-client.ts`
- 迁移：`apps/desktop/src/main/habitat/explorer-window-layer-controller.ts` → `apps/desktop/src/main/explorer/explorer-window-layer-controller.ts`
- 删除：`apps/desktop/src/main/habitat/explorer-candidate-selector.ts`
- 修改：所有生产导入、helper/bridge/protocol/client/controller 测试与固定 manifest。

**接口：**

- `ready` 快照固定字段：`version,type,nonce,sequence,status,windowType,instanceId,hwnd,rect,foreground,minimized`。
- 不再包含 `path` 或 `search`；搜索窗口作为普通 Explorer 窗口参与层级。
- helper 不再调用 Shell item 的 `LocationURL`/`Path`，不再做路径规范化、路径竞态或路径 HMAC。

- [ ] **Step 1：编写协议与 helper RED**

协议行为测试使用带 `path` 的 JSON，期望严格解析失败；使用无 `path` 的完整 ready JSON，期望成功。helper 固定场景断言唯一映射成功时路径 getter 调用数为零，并验证前后标签/外层 HWND/PID/矩形竞态仍返回 `ambiguous`。

- [ ] **Step 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explorer-space-protocol.test.ts tests/explorer-space-client.test.ts tests/explorer-space-shell-tab-helper.test.ts
```

预期：旧协议要求 `path`，helper 仍读取路径。

- [ ] **Step 3：删除路径路线并迁移**

删除 `PathReadResult`、路径 normalizer、`ReadPath`、双路径比较、路径 fingerprint 和对应 self-test 分支；保留标签唯一映射前后两次采样。bridge 不再输出路径。完成模块迁移并更新 import，不保留旧 re-export。

重新计算 `apps/desktop/resources/windows/explorer-space-integrity-manifest.json` 中 bridge/helper SHA-256；不得更改资源白名单数量或加入 fixture。

- [ ] **Step 4：运行 GREEN 与真实构建**

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explorer-space-protocol.test.ts tests/explorer-space-client.test.ts tests/explorer-space-shell-tab-helper.test.ts tests/explorer-window-layer-controller.test.ts tests/explorer-window-layer-validation.test.ts tests/package-config.test.ts
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop build
```

- [ ] **Step 5：提交**

```powershell
git commit -m "refactor: 收敛无路径 Explorer 图层协议"
```

---

### Task 6：清理 E2E、文档与最终边界

**文件：**

- 修改：`apps/desktop/src/main/e2e-boundary.ts`
- 修改：`apps/desktop/tests/fixtures/electron-app.ts`
- 修改：`apps/desktop/tests/e2e-boundary.test.ts`
- 修改：`apps/desktop/e2e/desktop.spec.ts`
- 删除：仅服务目录空间的 fixture、测试和未提交验收/前台探针修复文档。
- 修改：`docs/superpowers/specs/2026-08-01-ai-pet-reference-architecture-evolution-design.md`
- 修改：阶段 3B 活跃计划与 `docs/operations/explorer-shell-com-feasibility.md`。
- 新建：`apps/desktop/tests/explorer-layer-production-boundary.test.ts`

**接口：**

- E2E 只保留 Explorer 图层事件注入和 Main-only 只读层级状态，不含目录、路径、Habitat 命令或状态。
- 活跃文档明确“目录藏身退役、Explorer 动态图层保留”。

- [ ] **Step 1：编写最终生产边界 RED**

边界测试导入生产 API 和构建产物，验证：

- preload 不存在 Habitat API；
- 设置和托盘没有目录空间入口；
- bridge ready 快照不含路径；
- 图层错误后测试窗口保持可见且非 topmost；
- packaged 资源只有固定 bridge/helper；
- E2E 控制面无法注入目录路径或 Habitat 命令。

不得通过 grep 单独宣称行为通过；源码扫描只作为无死代码的补充门。

- [ ] **Step 2：运行 RED 并清理旧 fixture**

先运行新边界测试确认旧 E2E Habitat 控制面仍使其失败，再删除对应 token、schema、fixture 分支和测试步骤。

- [ ] **Step 3：更新中文文档**

删除当前未提交的：

- `docs/operations/directory-habitat-explorer-space-acceptance.md`
- `docs/superpowers/specs/2026-08-09-directory-habitat-manual-entry-probe-fix-design.md`
- `docs/superpowers/plans/2026-08-09-directory-habitat-manual-entry-probe-fix.md`

在活跃总设计、阶段计划和 feasibility 文档中记录退役决定、保留架构、自动证据与未执行的数据删除。历史计划只标记为已退役，不改写成已通过。

- [ ] **Step 4：运行最终自动门**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts --maxWorkers=2
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop build
pnpm.cmd test:security
pnpm.cmd test:integration
```

长时间全量允许后台运行；每 60 秒记录一次仍在运行的状态。单点超过 10 分钟未给出首错时，检查进程与日志后调整 worker 或拆成精确套件，不放宽断言和 timeout。

- [ ] **Step 5：运行 Electron 图层验收**

自动 E2E 验证：Explorer 准确快照触发 `moveAbove`；非 Explorer/失焦/最小化保持窗口可见；设置与托盘无目录空间。

人工验收：

1. Explorer 前台时桌宠在其上方；
2. 普通应用前台时覆盖桌宠，桌宠没有自行隐藏；
3. 切回 Explorer 后图层重新建立；
4. 最小化/关闭 Explorer 后桌宠仍作为普通窗口可见。

- [ ] **Step 6：提交**

```powershell
git commit -m "test: 验收独立 Explorer 动态图层"
```

---

## 最终复审

完成六个任务后，对本计划起始提交到 HEAD 生成完整 review package。最终 reviewer 必须逐项确认：目录空间生产能力为零、路径事实为零、图层不控制可见性、`alwaysOnTop: false`、无旧 re-export/环境开关/死依赖、自动门与人工门证据一致。任何 Critical/Important 进入一次统一修复波和一次定向复审；仍属承重问题时停止交付，不用“用户不需要次要功能”作为放宽图层安全性的理由。
