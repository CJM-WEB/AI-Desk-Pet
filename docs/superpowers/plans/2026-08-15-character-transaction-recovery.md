# AI Pet 角色 Store 事务分面恢复实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 实现 B1 `CharacterTransactionRecovery`，隔离每个角色的 draft/publish 恢复失败，并按批准预算安全延后未处理角色。

**架构：** 新协调器只拥有恢复调度、预算与分面结果；`CharacterStore` 继续拥有两套既有事务 schema 和恢复算法。Store 公开方法通过分面能力门阻止覆盖证据的操作。

**技术栈：** Electron 43、TypeScript、Node.js 文件系统、Zod、Vitest。

**设计规格：** [角色 Store 事务分面恢复设计](../specs/2026-08-15-character-transaction-recovery-design.md)

**覆盖规格：** [桌面架构优化减法收口设计](../specs/2026-08-20-desktop-code-subtraction-design.md)；B1 结果接口与测试 owner 以该规格为准。

## 全局约束

- 活动角色优先；最多 256 个索引角色；2000ms 软预算只在角色之间检查。
- 不打断单角色 draft/publish 事务；超限保留原文件并标记 deferred。
- 不修改 Package import journal、磁盘格式、Renderer 或网站/CloudBase 代码。
- 原 marker 字节不得被覆盖或删除；不自动删除角色目录。
- Git 暂存和提交仅在用户另行明确授权后执行。

## 文件结构

- 新增 `apps/desktop/src/main/characters/character-transaction-recovery.ts`：恢复排序、预算、分面结果和能力门。
- 新增 `apps/desktop/tests/character-transaction-recovery.test.ts`：纯协调器矩阵。
- 修改 `apps/desktop/src/main/characters/character-store.ts`：接入协调器并暴露报告。
- 修改 `apps/desktop/tests/character-store.test.ts`：真实 Store marker 与能力回归。

---

### Task 1：建立分面恢复协调器

**文件：**

- 新增：`apps/desktop/src/main/characters/character-transaction-recovery.ts`
- 新增：`apps/desktop/tests/character-transaction-recovery.test.ts`

**接口：**

- 产出：规格中定义的 `CharacterTransactionRecoveryResult`、`CharacterTransactionRecoveryReport`；结果只包含角色 ID 与两个分面错误码。
- 产出：`recoverAll(candidates)`、`resultFor()`、`assertDraftSaveAllowed()`、`assertPublishAllowed()`、`assertRuntimeAllowed()`。
- 构造依赖：`activeCharacterId: () => string | null`、`now: () => number`，生产默认 `Date.now`。

- [ ] **步骤 1：写分面与继续执行 RED 测试**

用 `vi.fn()` 建立三个 candidate：第一个 draft 抛错但 publish 成功，第二个 publish 抛错，第三个全部成功。精确断言各角色的 `draftErrorCode` 与 `publishErrorCode`，且六个 closure 全部调用一次。双失败角色的两个 closure 都必须执行，并分别保留 draft 与 publish 稳定码。

- [ ] **步骤 2：运行 RED 并确认因模块不存在而失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-transaction-recovery.test.ts
```

预期：FAIL，导入文件不存在或接口未定义。

- [ ] **步骤 3：实现最小分面协调器**

按角色分别 `try/catch` draft 和 publish，只记录两个 error code；不得在一个 facet 失败时跳过另一个 facet，也不得把原始异常文本写入结果。

- [ ] **步骤 4：写能力门 RED 测试**

断言 draft blocked 只使 draft-save/publish 拒绝，publish blocked 只使 publish/runtime 拒绝，both 叠加，healthy 全部允许。异常 `message` 必须是规格中的稳定码。

- [ ] **步骤 5：实现能力门并运行定向测试**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-transaction-recovery.test.ts
```

预期：PASS。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

仅在用户明确授权后暂存上述两个文件并提交；未授权时保留工作树改动并继续评审，不执行 Git 写操作。

---

### Task 2：实现活动角色优先与批准预算

**文件：**

- 修改：`apps/desktop/src/main/characters/character-transaction-recovery.ts`
- 修改：`apps/desktop/tests/character-transaction-recovery.test.ts`

**接口：**

- 消费：Task 1 的 `recoverAll()`。
- 产出：固定常量 `MAX_RECOVERY_CHARACTERS = 256`、`RECOVERY_SOFT_BUDGET_MS = 2_000`。
- 产出：超限角色的两个分面码均使用 `CHARACTER_RECOVERY_DEFERRED`；报告中存在该码即表示本轮触发预算。

- [ ] **步骤 1：写排序与数量边界 RED 测试**

输入顺序为 `other-a, active, other-b`，断言调用顺序为 `active, other-a, other-b`，报告顺序仍按输入稳定。构造 257 个 candidate，断言只执行 256 个完整角色，最后一个不调用任何 closure、两个分面码均为 `CHARACTER_RECOVERY_DEFERRED`，原 candidate 不受修改。

- [ ] **步骤 2：写软时间预算 RED 测试**

注入时钟序列，使第一个角色开始时为 0、完成后为 2000，精确覆盖 `>= 2_000` 边界。断言第一个角色的 draft/publish 均完成，第二个角色不开始且 deferred；证明预算只在角色边界检查。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-transaction-recovery.test.ts
```

预期：FAIL，当前实现没有排序或预算结果。

- [ ] **步骤 4：实现最小排序和边界检查**

建立不修改输入的排序副本；活动角色放首位。在开始下一个角色前检查已处理数量和 `now() - startedAt`，超限后为剩余 candidate 建立 deferred 结果，不调用其 closure。

- [ ] **步骤 5：运行测试并确认 GREEN**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-transaction-recovery.test.ts
```

预期：PASS。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

只提交协调器及其测试；未授权时不执行 Git 写操作。

---

### Task 3：接入 CharacterStore 并删除重复调度

**文件：**

- 修改：`apps/desktop/src/main/characters/character-store.ts`
- 修改：`apps/desktop/tests/character-store.test.ts`

**接口：**

- 消费：`CharacterTransactionRecovery.recoverAll()` 与三种能力门。
- 产出：`CharacterStore.getTransactionRecoveryReport(): CharacterTransactionRecoveryReport`。
- 保留：`recoverDraftTransaction()`、`recoverPublishTransaction()` 及其现有 Store journal schema。

- [ ] **步骤 1：写 Store 失败矩阵 RED 测试**

建立 active/non-active × bad draft/bad publish/both 表格用例。每例记录 marker 的 `Buffer`，调用 `list()` 后断言所有健康角色仍返回、坏 marker 字节不变、健康活动 runtime 可读；活动角色 bad draft 且 compiled 健康时 runtime 仍可读。

- [ ] **步骤 2：写操作能力 RED 测试**

断言 bad draft 下 `getDraft()` 可读但 `saveDraft()`/`publishCompiled()` 拒绝；bad publish 下 `saveDraft()` 成功而 `publishCompiled()`/`setActive()`/该角色 runtime 拒绝；其他角色不受影响。

- [ ] **步骤 3：写多角色和 deferred RED 测试**

混合两个坏角色、一个健康角色和超限 candidate，断言健康恢复完成、deferred 文件不变、`list()` 不抛出全局异常。Junction/权限 fault injection 只改变对应角色分面且不触碰链接目标。

- [ ] **步骤 4：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts
```

预期：FAIL，当前单 marker 异常中断 `loadIndex()`，且没有分面报告。

- [ ] **步骤 5：最小接入协调器**

在 `loadIndex()` 得到有效索引后构造 candidate；将 active ID 交给协调器。公开写入、发布、启用和 runtime 方法在触碰文件前调用相应能力门；读取现存草稿不因 draft blocked 自动失败。

- [ ] **步骤 6：删除旧调度路径**

仅在新矩阵通过后删除 `recoverAllCharacterTransactions()` 和公开方法中重复的无条件恢复调用。不得删除两个底层恢复算法，不得引入 Package marker schema。

- [ ] **步骤 7：运行 B1 回归与类型检查**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-transaction-recovery.test.ts character-store.test.ts character-startup.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS。

- [ ] **步骤 8：运行阶段门禁**

```powershell
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
```

预期：全部 PASS；B3 尚未实施的公开 fallback 行为不得提前写成通过。

- [ ] **步骤 9：在获得 Git 授权后提交本任务**

只在用户明确授权后提交 B1 文件；未授权时不执行 Git 写操作。
