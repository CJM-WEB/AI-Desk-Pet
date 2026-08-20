# AI Pet 桌面架构优化减法收口实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 删除 A1/A2/A3/B1 已被替代的浅模块、重复状态和重复测试，同时完整保留 sender 授权、事件投影、角色恢复和 Windows/Electron 安全证据。

**架构：** 授权策略回收到唯一调用者 `registerAgentIpc`；A3/B1 深模块保留但缩小测试与结果接口；所有减法先建立等价行为证据，再删除旧文件或旧字段，不保留双轨。

**技术栈：** Electron 43、TypeScript、Zod、Vitest、Playwright、pnpm workspace。

**设计规格：** [桌面架构优化减法收口设计](../specs/2026-08-20-desktop-code-subtraction-design.md)

**计划边界：** 本计划只执行 A1/A2/A3/B1 的立即减法。B2/B3 是后续独立实施子项目；本计划完成后先按新规格改写各自计划，再进入其生产实现。

## 全局约束

- 最高原则是“能不加就不加，能减则减”；新增安全能力时必须同步删除已被替代的旧代码。
- 不得削弱 sender fail-closed、TaskEvent Schema、pet 仅 phase、角色恢复预算、marker 字节保留或未分类异常向上抛出。
- 不创建新的生产模块、IPC、状态字段或测试专用产品接口。
- 每个任务必须记录生产代码与测试代码的增删行；新旧实现不得同时存在。
- 测试采用 replace-don't-layer：算法矩阵、真实边界和 E2E 纵向证据各归唯一层级。
- 不修改网站、CloudBase、package scanner、网站 E2E 或其配置。
- 单个排障点或命令超过 15 分钟立即终止、切分或换方案；不得提高超时掩盖问题。
- 用户已二次批准本计划列出的文件删除，并已批准本地 Git 暂存与提交；不得推送、合并、变基或破坏性回退。

---

### Task 1：删除 A2 浅授权模块并保留单一安全 owner

**文件：**

- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/tests/agent-ipc.test.ts`
- 修改：`apps/desktop/tests/main-lifecycle.test.ts`
- 修改：`apps/desktop/tests/window-security.test.ts`
- 删除：`apps/desktop/src/main/ipc/agent-ipc-authorization.ts`
- 删除：`apps/desktop/tests/agent-ipc-authorization.test.ts`

**接口：**

- `registerAgentIpc()` 第三个参数改为：

```ts
getCurrentChatWebContents: () => WebContents | null
```

- `register-ipc.ts` 内保留一个非导出的集中判断：

```ts
function assertCurrentChatSender(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  getCurrentChatWebContents: () => WebContents | null
): void {
  const current = getCurrentChatWebContents();
  if (!current || current.isDestroyed() || event.sender !== current) {
    throw new Error('AGENT_IPC_SENDER_INVALID');
  }
}
```

- 六个 mutating handler 的第一条业务语句继续调用该判断；不得缓存 `WebContents`。

- [ ] **步骤 1：把授权类的必要行为迁入现有 handler 测试**

修改 `createAgentIpcFixture()`，直接把动态 getter 传给 `registerAgentIpc()`。补齐现有文件中尚缺的两个行为：getter 返回 `null`；当前 `WebContents.isDestroyed()` 返回 `true`。两者均对六个 mutating channel 返回 `AGENT_IPC_SENDER_INVALID`，所有 service spy 为零。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc.test.ts
```

预期：新 fixture 传 getter，而生产接口仍要求授权对象，测试或类型编译失败；失败原因必须是接口尚未收敛。

- [ ] **步骤 3：内联唯一授权判断**

删除 `AgentIpcAuthorization` import；在 `registerAgentIpc()` 内调用上述私有函数。Main 删除实例化，只保留：

```ts
registerAgentIpc(ipcMain, conversationIpcService, getCurrentChatWebContents);
```

- [ ] **步骤 4：删除浅模块与重复 wiring 断言**

删除两个授权文件。`window-security.test.ts` 保留一处 Main 三参数动态 getter 的装配断言；`main-lifecycle.test.ts` 删除同义的四条源码字符串断言，不添加替代字符串断言。

- [ ] **步骤 5：运行 GREEN 与安全回归**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc.test.ts tests/window-security.test.ts tests/main-lifecycle.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS；`rg -n "AgentIpcAuthorization|agent-ipc-authorization" apps/desktop/src apps/desktop/tests` 零命中。

- [ ] **步骤 6：统计并提交**

记录本任务生产/测试净增减，确认总行数减少；提交只包含上述文件。

---

### Task 2：合并 A1 单断言配置测试

**文件：**

- 修改：`apps/desktop/tests/desktop-e2e-entry.test.ts`
- 删除：`apps/desktop/tests/vitest-worker-cap.test.ts`

**接口：**

- 不修改 `apps/desktop/vitest.config.ts` 的 `maxWorkers: 4`。
- 现有 Desktop 门禁契约测试同时验证 Playwright owner、根脚本可达性和 Vitest 实际解析后的 worker 上限。

- [ ] **步骤 1：把实际配置解析断言迁入现有契约测试**

在 `desktop-e2e-entry.test.ts` 导入 `resolveConfig`，把测试函数改为 `async`，并在既有断言尾部加入：

```ts
const desktopRoot = resolve(import.meta.dirname, '..');
const { vitestConfig } = await resolveConfig({
  root: desktopRoot,
  config: resolve(desktopRoot, 'vitest.config.ts')
});
expect(vitestConfig.maxWorkers).toBe(4);
```

- [ ] **步骤 2：先运行合并后的测试**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/desktop-e2e-entry.test.ts tests/vitest-worker-cap.test.ts
```

预期：两项均 PASS，证明新 owner 已具有旧断言。

- [ ] **步骤 3：删除旧文件并复验**

删除 `vitest-worker-cap.test.ts`，再次只运行 `desktop-e2e-entry.test.ts`，预期 PASS。使用 `rg -n "固定使用四个文件 worker|maxWorkers.*toBe\(4\)" apps/desktop/tests` 确认只剩一个 owner。

- [ ] **步骤 4：统计并提交**

本任务不得修改生产代码；测试代码必须净减少。

---

### Task 3：合并 A2/A3 重复 Electron 安全场景

**文件：**

- 修改：`tests/e2e/desktop.spec.ts`

**接口：**

- 保留最终测试名：`会话任务事件只向 chat 完整投递、向 pet 只投递 phase 且非 chat 不能执行票据`。
- 删除独立测试：`只有当前聊天窗口能使用已知 actionId 确认文件动作`。

- [ ] **步骤 1：把已知票据攻击断言移入投影场景**

在投影场景已经从 chat 捕获文件 `pending_action.actionId` 后，依次从 pet、settings、characters 调用 `confirmAction(actionId)`：

```ts
for (const page of [petPage, settingsPage, charactersPage]) {
  await expect(page.evaluate(async id => {
    await window.myself.confirmAction(id);
  }, actionId)).rejects.toThrow(/AGENT_IPC_SENDER_INVALID/u);
}
```

随后断言确认卡仍存在、目标文件不存在；从 chat 正式确认后文件存在。保持既有数组断言：pet 事件全部严格为 `phase` 双键，settings/characters 为空且序列化结果不含 actionId、命令、正文、路径或 requestId。

- [ ] **步骤 2：运行合并场景**

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "会话任务事件只向 chat"
```

预期：PASS，且同一场景独立证明信息最小化与 sender 授权两道防线。

- [ ] **步骤 3：删除第二套场景并检查无遗漏 helper**

删除旧测试完整代码块；删除仅被旧测试使用的局部变量、Provider step 或 fixture helper。不得删除其他 E2E 使用的通用 helper。

- [ ] **步骤 4：复验与提交**

再次运行同一 grep；`rg -n "只有当前聊天窗口能使用已知 actionId" tests/e2e/desktop.spec.ts` 零命中。测试文件必须净减少，不修改生产代码。

---

### Task 4：收敛 A3 投影测试到行为接口

**文件：**

- 修改：`apps/desktop/tests/conversation-event-projection.test.ts`

**接口：**

- 不修改 `ConversationEventProjection` 生产实现。
- 完整事件 Schema variant 由 `packages/shared-types/tests/contracts.test.ts` 拥有；本文件只验证投影行为。

- [ ] **步骤 1：建立保留清单并运行当前基线**

必须保留以下行为：

1. 一个 `pending_action` 完整进入 chat 与 Main behavior，但 pet 为零；
2. 一个 `phase` 完整进入 chat，pet 只得到严格 `{type, phase}`；
3. 一个带额外字段的非法事件在任何副作用前失败；
4. 空/销毁 target 不发送；
5. chat 或 pet send 失败不阻止另一目标，reporter 抛错也被隔离。

先运行当前文件，记录测试数与通过结果。

- [ ] **步骤 2：删除重复 variant 样本与断言**

删除 `validPowerShellActionEvent`、`validHistoryDisclosureEvent` 和 `completeChatEvents` 全 variant 列表；把第一项参数化测试改成单个 `pending_action` 行为测试。pet 非 phase 断言只复用该 pending action，不再遍历 Schema 已覆盖的所有 variant。

- [ ] **步骤 3：运行定向与共享 Schema 测试**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-event-projection.test.ts
pnpm.cmd --filter @myself/shared-types test
```

预期：投影文件保留上述五类行为；共享类型包继续覆盖完整 TaskEvent variant。

- [ ] **步骤 4：统计并提交**

本任务生产代码零差异，测试代码净减少；不得新增 fixture 文件或共享测试 helper。

---

### Task 5：删除 B1 可推导状态并收敛重复矩阵

**文件：**

- 修改：`apps/desktop/src/main/characters/character-transaction-recovery.ts`
- 修改：`apps/desktop/src/main/characters/character-store.ts`
- 修改：`apps/desktop/tests/character-transaction-recovery.test.ts`
- 修改：`apps/desktop/tests/character-store.test.ts`
- 修改：`docs/superpowers/specs/2026-08-15-character-transaction-recovery-design.md`
- 修改：`docs/superpowers/plans/2026-08-15-character-transaction-recovery.md`
- 修改：`docs/superpowers/specs/2026-08-15-character-recovery-degradation-design.md`
- 修改：`docs/superpowers/plans/2026-08-15-character-recovery-degradation.md`

**接口：**

```ts
export type CharacterTransactionRecoveryResult = Readonly<{
  characterId: string;
  draftErrorCode:
    | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
  publishErrorCode:
    | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
}>;

export type CharacterTransactionRecoveryReport = Readonly<{
  characters: readonly CharacterTransactionRecoveryResult[];
}>;
```

- 删除 `CharacterTransactionRecoveryKind`、`kind`、`deferred`、`budgetExceeded`、`recoveryKind()`。
- deferred 由任一分面码等于 `CHARACTER_RECOVERY_DEFERRED` 表达；预算是否超限由报告中存在 deferred 角色表达。

- [ ] **步骤 1：先把结果断言改为最小形状并运行 RED**

把协调器与 Store 测试的精确对象断言改为新接口。例如：

```ts
expect(report).toEqual({
  characters: [{
    characterId: 'deferred-role',
    draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
    publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
  }]
});
```

运行两文件，预期因生产结果仍含旧字段而 FAIL。

- [ ] **步骤 2：删除派生字段与实现**

`recoverCandidate()` 直接返回角色 ID 和两个分面码；`deferredResult()` 只返回相同三字段；`recoverAll()` 不维护 `budgetExceeded` 变量，只在触发数量/时间门时填充剩余 deferred 后结束。

Store 初始 report 改为 `{ characters: [] }`。不得新增替代布尔值、getter 或派生 helper。

- [ ] **步骤 3：收敛协调器测试**

保留唯一 owner：

- 分面隔离、双分面继续执行和能力门合并成一个矩阵；
- 未分类异常向上抛出单独保留；
- 活动优先与 257 上限合并，仍证明活动角色位于第 257 位时进入前 256；
- 2000ms 精确等号边界保留；
- 连续轮次与空轮次合并，仍证明旧结果 fail closed；
- 删除只重复证明 `budgetExceeded === false`、`kind` 或 `deferred` 的用例。

- [ ] **步骤 4：收敛 Store 测试但保留真实边界**

保留真实坏 marker 主矩阵、bad draft 健康 runtime、bad publish 三个 active runtime gate、V1 draft/compiled 字节不变、deferred 文件不触碰、Junction、EACCES、report 原子发布、显式 delete、索引集合清理。

删除只重复协调器纯算法的 Store 断言；不得删除 marker Buffer 前后比较或真实路径安全测试。

- [ ] **步骤 5：同步既有规格与计划**

在四份既有 B1/B3 文档中删除旧字段和依赖它们的描述，明确 B3 从两个 error code 推导公开错误。不得新增第二份迁移文档；引用本减法规格作为覆盖依据。

- [ ] **步骤 6：运行 B1 RED/GREEN 与角色回归**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-transaction-recovery.test.ts tests/character-store.test.ts tests/character-startup.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS；`rg -n "CharacterTransactionRecoveryKind|budgetExceeded|\.deferred|kind: 'draft-recovery-blocked'|kind: 'publish-recovery-blocked'" apps/desktop/src/main/characters apps/desktop/tests/character-*` 对 B1 旧字段零命中。

- [ ] **步骤 7：统计并提交**

生产接口与测试代码均必须净减少；若实现需要新增字段或模块，停止并返回 NEEDS_CONTEXT，不得以新状态替代旧状态。

---

### Task 6：全门禁、减法验收与 B2/B3 进入条件

**文件：**

- 修改：`docs/operations/desktop-validation-coverage-acceptance.md`
- 修改：`docs/operations/conversation-security-boundary-acceptance.md`
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`

**接口：**

- 不新增验收文档；在三个现有 owner 中分别记录 A1/A2、A3、B1 的实际减法与验证。
- 本减法规格通过后状态改为“自动化完成，B2/B3 可按减法门重新规划”；未执行的人工 Windows 项继续保持待确认。

- [ ] **步骤 1：运行分段门禁**

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
pnpm.cmd verify:behavior
pnpm.cmd verify:characters
```

每个命令只运行一次；若某项失败，定向复现一次后诊断。任何单命令 15 分钟未结束则终止并记录超时，不重复无限运行。

- [ ] **步骤 2：运行旧 owner 与越界扫描**

```powershell
rg -n "AgentIpcAuthorization|agent-ipc-authorization|只有当前聊天窗口能使用已知 actionId|CharacterTransactionRecoveryKind|budgetExceeded" apps/desktop/src apps/desktop/tests tests/e2e
git diff --name-only 875048c..HEAD -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
git diff --check 875048c..HEAD
```

预期：旧 owner 扫描零命中；受保护路径零差异；diff check 无错误。

- [ ] **步骤 3：记录净减证据**

分别记录 `875048c..HEAD` 的生产代码、测试/E2E 和文档 `--numstat/--shortstat`。完成门：正式运行路径与 owner 数量减少；测试总量相对 `c7d951d` 净减少。不得因验收文字新增过多而掩盖代码减法。

- [ ] **步骤 4：更新现有验收记录**

每份文档只追加一个紧凑日期段，记录真实命令、退出码、删除文件/符号、净增减和未覆盖人工项。没有运行成功的门不得写通过。

- [ ] **步骤 5：提交文档收口**

提交只包含四份文档；完成后 B2/B3 仍不得直接按旧计划执行，必须先根据本规格修订其计划并再次审查删除门。
