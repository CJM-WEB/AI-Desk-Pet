# AI Pet 角色恢复公开反馈与降级实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 实现 B3 结构化恢复快照、最小 IPC/Renderer 反馈和正确的官方默认角色降级，同时保证普通聊天独立可用。

**架构：** Main 汇总 B1 Store report、B2 Package report 与 startup runtime 校验，`CharacterActions` 映射为严格白名单 DTO；Pet 只消费活动 fallback，Workshop 消费逐角色 issue，Chat 不依赖角色恢复。

**技术栈：** Electron 43、React 19、TypeScript、Zod、Vitest、Testing Library、Playwright。

**设计规格：** [角色恢复公开反馈与降级设计](../specs/2026-08-15-character-recovery-degradation-design.md)

**覆盖规格：** [桌面架构优化减法收口设计](../specs/2026-08-20-desktop-code-subtraction-design.md)；B1 输入映射以该规格的双分面码接口为准。

**前置计划：** [B1 Store 事务分面恢复](./2026-08-15-character-transaction-recovery.md) → [B2 角色包导入 Journal](./2026-08-15-character-import-journal.md) → 本计划。

## 全局约束

- B1、B2 必须先完成并通过各自定向测试；不得在 B3 重写两个 journal。
- 活动角色优先；最多 256 个索引角色；2000ms 软预算只在角色之间检查，超限不阻断应用或聊天。
- Renderer 只接收角色 ID、受影响能力、稳定错误码、恢复建议和 fallback 状态。
- 不公开绝对路径、marker 正文、哈希、owner token、物理身份或 evidence 文件名。
- Git 暂存和提交仅在用户另行明确授权后执行。

## 文件结构

- 修改 `character-startup.ts`/测试：活动角色专属 fallback 判定。
- 修改 `main/index.ts`：结构化汇总并保证聊天继续初始化。
- 修改 `character-actions.ts`：唯一公开快照映射入口。
- 修改 `character-ipc.ts`、`myself-api.ts`、`register-ipc.ts`、Preload：严格 DTO。
- 修改 `character-recovery.ts`、`PetView.tsx`、Workshop 及测试：安全文案与能力提示。
- 修改 `tests/e2e/desktop.spec.ts`，必要时最小扩展 `tests/fixtures/electron-app.ts`：真实重启闭环。

---

### Task 1：实现活动角色专属启动裁决

**文件：**

- 修改：`apps/desktop/src/main/characters/character-startup.ts`
- 修改：`apps/desktop/tests/character-startup.test.ts`
- 修改：`apps/desktop/src/main/index.ts`

**接口：**

- 消费：`CharacterTransactionRecoveryReport`、`CharacterImportJournalRecoveryReport`。
- 产出：

```ts
export type CharacterStartupResult =
  | { kind: 'active'; activeCharacterId: string; issues: readonly CharacterRecoveryIssue[] }
  | { kind: 'fallback'; errorCode: string | null; issues: readonly CharacterRecoveryIssue[] };
```

- [ ] **步骤 1：写 active/non-active RED 矩阵**

覆盖非活动 bad draft/bad publish/both，断言健康活动角色保持 `kind:'active'` 且 issues 包含故障角色。覆盖活动 bad draft + 健康 compiled，断言不 fallback；覆盖活动 bad publish，断言 fallback 且不调用任何 remove。

- [ ] **步骤 2：写 Package 与 deferred RED 测试**

传入 quarantined、blocked、deferred issue，断言启动继续、issues 保留稳定码。只有活动 publish/runtime 或索引整体不可用触发 fallback；Package 问题不触发全局 fallback。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts
```

预期：FAIL，当前结果只有单个 errorCode 且所有异常统一 fallback。

- [ ] **步骤 4：实现最小启动裁决**

按活动角色 ID 查询 B1 的 `draftErrorCode` 与 `publishErrorCode`；publish 分面码受阻时跳过用户 runtime 并返回 fallback，只有 draft 分面码受阻时仍校验健康 runtime。把 B2 issues 合并但不据此退出应用。未知内部异常只返回 `CHARACTER_OPERATION_FAILED`。

- [ ] **步骤 5：改 Main 启动编排并运行 GREEN**

Main 接收 `characterPackageService.initialize()` report；即使存在 quarantined/blocked 项也继续 `prepareCharacterStartup()`、Secret/Settings、聊天 IPC 和窗口初始化。仅 `CharacterStartupResult.kind === 'fallback'` 时安装/启用官方默认角色。

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts
```

预期：PASS。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 2：建立公开恢复 DTO 与 Actions 映射

**文件：**

- 修改：`apps/desktop/src/shared/character-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/main/characters/character-actions.ts`
- 修改：`apps/desktop/tests/character-ipc.test.ts`
- 修改：`apps/desktop/tests/character-recovery.test.ts`

**接口：**

- 产出：规格定义的 `CharacterRecoveryIssueDto`、`CharacterRecoverySnapshotDto` 及 Zod schemas。
- 产出：`CharacterActions.getCharacterRecoverySnapshot(): Promise<CharacterRecoverySnapshotDto>`。
- 消费：Task 1 的 startup result、B1/B2 内部 reports。

- [ ] **步骤 1：写严格 Schema RED 测试**

断言合法 snapshot 通过；在 issue 中逐项加入 `path`、`markerText`、`hash`、`ownerToken`、`physicalIdentity`、`evidenceFile`，每项都被 `.strict()` 拒绝。非法 capability、suggestion 和未知 recovery error code 也必须拒绝。

- [ ] **步骤 2：写映射 RED 测试**

分别输入 B1 的 draft 分面码、publish 分面码、两码同时受阻、任一分面 deferred，以及 B2 的 import-invalid、ownership-mismatch、evidence-failed 内部结果，断言派生的公开错误、角色 ID、capabilities 和 suggestion 精确匹配规格。B3 不接收 B1 的替代布尔值或分类字段；内部错误对象含私有路径 sentinel，序列化 DTO 后不得包含 sentinel。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts character-recovery.test.ts
```

预期：FAIL，当前 schema 只有 `{errorCode}`。

- [ ] **步骤 4：实现封闭 schemas 和白名单映射**

所有 DTO 从字段白名单重新构造，不 spread 内部对象。`fallbackErrorCode` 继续只接受 `CHARACTER_*` 稳定码；未知异常映射 `CHARACTER_OPERATION_FAILED`。

- [ ] **步骤 5：运行 GREEN**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts character-recovery.test.ts
```

预期：PASS。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 3：贯通 Main IPC 与 Preload

**文件：**

- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/tests/character-ipc.test.ts`

**接口：**

- 消费：`CharacterActions.getCharacterRecoverySnapshot()`。
- 产出：`MyselfApi.getCharacterRecoverySnapshot(): Promise<CharacterRecoverySnapshotDto>`。
- 删除：`registerCharacterIpc(..., recoveryErrorCode: () => string | null)` 参数。

- [ ] **步骤 1：写 IPC RED 测试**

断言 recovery channel 只接受 `{}`；返回完整结构化 snapshot；带路径的 Renderer 输入被 `CHARACTER_INPUT_INVALID` 拒绝且 service 不调用；service 返回额外私有字段时结果 schema 拒绝。

- [ ] **步骤 2：写 Preload RED 测试**

mock IPC 返回合法 snapshot，断言 Preload 返回解析后的相同值；返回含 `ownerToken` 的 issue 时 Promise 拒绝；订阅面和通道数量不增加。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts
```

预期：FAIL，register 仍依赖标量 callback。

- [ ] **步骤 4：最小替换 handler 与 Preload**

handler 调用 Actions 方法并以新 schema parse；Main 注册不再传 callback；Preload 继续在固定通道解析结果，不增加任何写入或路径参数。

- [ ] **步骤 5：删除旧标量路径并运行 GREEN**

删除 `startupRecoveryErrorCode`、旧 callback 参数、旧 `{errorCode}` schema 和只服务标量返回的测试。

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts character-startup.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：PASS。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 4：实现 Pet 与 Workshop 的最小降级反馈

**文件：**

- 修改：`apps/desktop/src/shared/character-recovery.ts`
- 修改：`apps/desktop/src/renderer/src/pet/PetView.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 必要时修改：`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- 修改：`apps/desktop/tests/pet-view.test.tsx`
- 修改：`apps/desktop/tests/character-workshop-components.test.tsx`
- 修改：`apps/desktop/tests/character-recovery.test.ts`

**接口：**

- 消费：`CharacterRecoverySnapshotDto`。
- 产出：`loadCharacterStartupRecovery(api, applySnapshot): Promise<void>`。
- 产出：稳定中文 issue 文案，不接收或插入内部详情。

- [ ] **步骤 1：写 Pet RED 测试**

活动 publish blocked + `fallbackActive:true` 时显示官方默认角色说明和“打开角色工作室”；非活动 issue + `fallbackActive:false` 时不显示全局 fallback，也不替换健康播放器。

- [ ] **步骤 2：写 Workshop RED 测试**

draft blocked 显示草稿保存/发布受限但草稿仍可查看；publish blocked 允许草稿保存但发布/启用显示稳定说明；deferred 显示后续恢复建议。渲染文本不得包含传入测试 sentinel 路径/token。

- [ ] **步骤 3：写 IPC 失败安全文案 RED 测试**

让 recovery snapshot RPC 抛包含绝对路径的错误，断言只显示通用 `CHARACTER_OPERATION_FAILED` 文案，不回显 RPC 原文。

- [ ] **步骤 4：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-view.test.tsx character-workshop-components.test.tsx character-recovery.test.ts
```

预期：FAIL，Renderer 仍消费单错误码。

- [ ] **步骤 5：实现最小 Renderer 映射**

Pet 只读取 `fallbackActive/fallbackErrorCode`；Workshop 以角色 ID 匹配 issue 并复用现有 alert/toast/按钮。不要建立第二个 journal store，也不要在 Renderer 推导路径或删除操作。

- [ ] **步骤 6：运行 GREEN 与聊天回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-view.test.tsx character-workshop-components.test.tsx character-workshop-store.test.ts character-recovery.test.ts main-conversation-composition.test.ts
```

预期：PASS；角色恢复失败不得改变现有聊天 Main 组合和初始化结果。

- [ ] **步骤 7：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 5：建立真实 Windows 重启与降级 E2E

**文件：**

- 修改：`tests/e2e/desktop.spec.ts`
- 必要时修改：`tests/fixtures/electron-app.ts`
- 复用：`tests/fixtures/character-storage-snapshot.ts`

**接口：**

- 消费：正式工作室 UI、`fixture.restart()`/`prepareUserData()`、`window.myself.getCharacterRecoverySnapshot()`。
- 产出：Store 与 Package 坏 marker 的真实 Electron 证据。

- [ ] **步骤 1：写非活动 Store marker RED 场景**

通过正式工作室创建、发布并启用健康角色，再建立非活动角色；退出后写入半截非活动 publish marker。重启断言 Electron 就绪、健康活动播放器 `data-status="ready"`、快照包含非活动 issue 且 `fallbackActive:false`。

- [ ] **步骤 2：补充聊天与泄漏断言**

从 pet 打开 chat，提交现有测试消息并断言既有模型设置提示出现。序列化 snapshot，断言不含 userData 绝对路径、marker sentinel、哈希或 token。

- [ ] **步骤 3：写活动 publish marker RED 场景**

损坏活动角色 publish marker 后重启，断言官方默认 fallback 和修复入口可见；存储快照证明损坏 marker 原字节未改写；工作室仍列出其他健康角色。

- [ ] **步骤 4：写 Package 多 marker RED 场景**

准备一个半截 marker 与一个合法可恢复 marker，重启断言坏项被 quarantined/blocked、合法项仍处理、应用和聊天可用。不得通过 E2E 直接调用 Journal 内部方法。

- [ ] **步骤 5：运行真实 Windows E2E**

```powershell
pnpm.cmd test:e2e:desktop
```

预期：PASS。窗口层级和人工文案可读性若未实际人工观察，验收记录写“待用户人工确认”。

- [ ] **步骤 6：运行最终门禁**

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:characters
pnpm.cmd verify:desktop
```

预期：全部 PASS；`verify:characters` 与 `verify:desktop` 均包含桌面 E2E，记录重复覆盖而不虚构未运行结果。

- [ ] **步骤 7：检查旧路径已清理**

使用 `rg` 确认 `startupRecoveryErrorCode`、旧 recovery callback 和旧单字段 snapshot schema 均无正式运行引用；B1/B2 内部状态类型仍保持独立。

- [ ] **步骤 8：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。
