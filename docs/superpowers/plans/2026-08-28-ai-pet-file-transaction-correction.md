# AI Pet 文件事务纠偏实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 按任务实施；每项任务严格执行 RED → GREEN → REFACTOR。

**目标：** 关闭文件事务最终复审遗留的四个承重缺口，使普通聊天零工具、每回合操作结果匹配、失败重试不重放写入、按文件名读取可确定执行。

**架构：** Router 产生唯一的文件意图与 `FilePlanningHint`，Coordinator 将它作为本回合操作票据传入事务和 AgentLoop；事务只保存可信结果及防重放账本。文件名内容问句在 AgentService 内复用受控 `glob_files/read_file` 完成确定性解析。

**技术栈：** TypeScript、Electron Main、Zod、Vitest、Playwright/Electron E2E、pnpm workspace

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-28-ai-pet-file-transaction-correction-design.md`。
- MCP 运行时继续禁用；Renderer 不获得文件系统或进程能力。
- 普通聊天、否定、引用、代码块和嵌入正文固定 `tools: []`。
- 文件工具继续使用授权根相对路径、PathPolicy、逐次确认和真实工具结果。
- OpenCode 只参考 `D:\AgentLearning` 固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214` 的工具循环模式，许可证 MIT；不得引入其完整框架。
- 文档与结构性注释使用中文；每项先观察 RED，再写最小生产实现。

---

### Task 1：统一事务续接意图与本回合操作票据

**文件：**
- 修改：`apps/desktop/src/main/conversation/capability-intent-router.ts`
- 修改：`apps/desktop/src/main/conversation/capability-transaction.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 测试：`apps/desktop/tests/capability-intent-router.test.ts`
- 测试：`apps/desktop/tests/capability-transaction.test.ts`
- 测试：`apps/desktop/tests/conversation-coordinator.test.ts`
- 测试：`packages/agent-core/tests/agent-loop.test.ts`

**接口：**

```ts
interface CapabilityIntentRouter {
  route(prompt: string): CapabilityIntent;
  routeTrustedFileContinuation(prompt: string): CapabilityIntent;
}

type TransactionControl = 'continue' | 'retry' | 'status' | 'none';
```

`routeTrustedFileContinuation()` 在持有可信引用时识别显式动作和封闭内容问句；`classifyFollowUp()` 只返回控制词，不再返回语义 `new_task`。

- [ ] **步骤 1：写普通评论与显式续接的失败测试**

增加字面断言：

```ts
expect(router.routeTrustedFileContinuation('这个文件内容是好的').kind).toBe('chat');
expect(router.routeTrustedFileContinuation('把刚创建的文件内容改为 hello').kind).toBe('file_task');
expect(createFilePlanningHint('把刚创建的文件内容改为 hello')).toEqual({ operation: 'edit_file' });
```

Coordinator 测试断言前者 Provider 请求 `tools: []` 且能力端口零调用；后者提交 `planningHint.operation === 'edit_file'`。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-intent-router.test.ts capability-transaction.test.ts conversation-coordinator.test.ts
```

预期：普通评价仍被事务提升，事务续接缺少 `planningHint`。

- [ ] **步骤 3：实现单一 Router 权威**

删除事务层“可信指代 + 动作/内容是”的并行正则；Coordinator 先调用 Router 的事务续接入口，再以 `createFilePlanningHint()` 生成操作票据。否定、引用、代码块和嵌入正文必须复用 Router 的现有阻断函数。

- [ ] **步骤 4：验证只读结果不能为写意图背书**

新增测试：续接 `edit_file` 回合仅收到成功 `read_file` 后模型口头完成，AgentLoop 返回协议错误且事务为 failed；收到成功 `edit_file` 后才 completed。

```powershell
pnpm.cmd --filter @myself/agent-core test -- agent-loop.test.ts
pnpm.cmd --filter @myself/desktop test -- capability-intent-router.test.ts capability-transaction.test.ts conversation-coordinator.test.ts
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **步骤 5：提交**

```powershell
git add apps/desktop/src/main/conversation apps/desktop/tests packages/agent-core/tests/agent-loop.test.ts
git commit -m "fix: 统一文件事务操作票据"
```

### Task 2：用可信 mutation 账本阻止失败重放

**文件：**
- 修改：`apps/desktop/src/main/conversation/capability-transaction.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 测试：`apps/desktop/tests/capability-transaction.test.ts`
- 测试：`apps/desktop/tests/conversation-coordinator.test.ts`
- 测试：`tests/integration/desktop-agent.test.ts`

**接口：**

```ts
type CapabilityTransactionSnapshot = Readonly<{
  hasSuccessfulMutation: boolean;
}>;
```

`hasSuccessfulMutation` 每个能力回合在 `beginTurn()` 清零，只能由成功的 `create_file`、`create_directory`、`apply_patch`、`edit_file`、`delete_file` 或 `move_file` 可信结果置为 `true`。

- [ ] **步骤 1：写失败测试**

覆盖两条路径：失败前没有成功 mutation 时“重试”重新提交一次；失败前已有成功 mutation 时“重试”只输出“任务已部分执行，不能自动重试”，Agent 调用数和磁盘写次数不增加。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-transaction.test.ts conversation-coordinator.test.ts
pnpm.cmd test:integration -- tests/integration/desktop-agent.test.ts
```

预期：现有 `prepareFailedFileRetry()` 会重放原始请求。

- [ ] **步骤 3：最小实现与 GREEN**

事务从可信工具名维护 mutation 布尔账本；Coordinator 在重试前硬检查该值。已成功写入但总结失败继续保持 completed warning，不进入 failed retry。

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-transaction.test.ts conversation-coordinator.test.ts
pnpm.cmd test:integration
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **步骤 4：提交**

```powershell
git add apps/desktop/src/main/conversation apps/desktop/tests tests/integration/desktop-agent.test.ts
git commit -m "fix: 阻止文件写入失败重放"
```

### Task 3：实现按文件名读取的确定性闭环

**文件：**
- 修改：`packages/agent-core/src/types.ts`
- 修改：`apps/desktop/src/main/conversation/capability-intent-router.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 测试：`apps/desktop/tests/capability-intent-router.test.ts`
- 测试：`apps/desktop/tests/agent-service.test.ts`
- 测试：`tests/integration/desktop-agent.test.ts`

**接口：**

```ts
type FilePlanningHint = Readonly<{
  operation: FilePlanningOperation;
  missingField?: 'target_path';
  targetNameQuery?: string;
}>;
```

`targetNameQuery` 只允许单个 NFKC 文件名，不含 `/`、`\\`、`*`、`?`、控制字符或绝对路径前缀；长度 1 到 120 个字符。

- [ ] **步骤 1：写 Router RED**

```ts
expect(createFilePlanningHint('请告诉我目录下的 test 文件内容是什么')).toEqual({
  operation: 'read_file',
  targetNameQuery: 'test'
});
```

补充带扩展名、分隔符、通配符和引用文本的拒绝用例。

- [ ] **步骤 2：写真实临时授权根 RED**

AgentService 测试使用真实 `FileToolService`：

- 唯一 `nested/test.txt` 时真实读取并公开相对路径和正文；Provider 调用数为 0。
- `a/test.txt` 与 `b/test.md` 同时存在时返回 `target_path` 澄清，仅列相对候选且最多 10 项。
- 不存在时返回 `target_path` 澄清，不索要绝对路径。
- `glob_files.truncated === true` 时不得把单个已返回项视为唯一。

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-intent-router.test.ts agent-service.test.ts
```

- [ ] **步骤 3：实现确定性预解析**

AgentService 在创建同一事务 Agent session 后、进入 AgentLoop 前调用既有 `glob_files`。候选按相对路径 basename 精确比较；无扩展查询同时允许 stem 精确相等。唯一候选再调用既有 `read_file`，并通过现有 `emitTrustedToolResult()` 发布真实结果。

实现只接受以下受控结果形状：

```ts
type NamedReadResolution =
  | { kind: 'resolved'; relativePath: string; content: string; truncated: boolean }
  | { kind: 'clarification'; candidates: readonly string[]; reason: 'not_found' | 'ambiguous' | 'search_truncated' };
```

- [ ] **步骤 4：参数化正式 Provider 链**

在 `tests/integration/desktop-agent.test.ts` 使用 OpenAI-compatible 和内置本地模型两种 fixture 验证原句；文件副作用来自真实临时授权根，唯一候选正文实际返回，重名与不存在不调用 Provider。

```powershell
pnpm.cmd --filter @myself/desktop test -- agent-service.test.ts capability-intent-router.test.ts
pnpm.cmd test:integration
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/desktop typecheck
```

- [ ] **步骤 5：提交**

```powershell
git add packages/agent-core/src/types.ts apps/desktop/src/main apps/desktop/tests tests/integration/desktop-agent.test.ts
git commit -m "feat: 确定解析按名称读取文件"
```

### Task 4：清理旧字段并完成门禁

**文件：**
- 修改：`apps/desktop/tests/capability-transaction.test.ts`
- 修改：`apps/desktop/tests/agent-service.test.ts`
- 修改：`apps/desktop/tests/main-agent-session-factory.test.ts`
- 修改：`docs/operations/lightweight-agent-acceptance.md`

- [ ] **步骤 1：清理旧测试夹具**

删除测试数据中的 `providerId`、`authorizationRootId` 与 `fileDisclosureAllowed`；不得修改生产兼容契约来迁就旧夹具。

- [ ] **步骤 2：运行新鲜门禁**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
git diff --check
```

- [ ] **步骤 3：更新验收记录**

只记录实际命令、计数、日期、Windows 环境与未覆盖的真实 Provider 网络/人工窗口观察；不得把未运行事项写为通过。

- [ ] **步骤 4：提交**

```powershell
git add apps/desktop/tests docs/operations/lightweight-agent-acceptance.md
git commit -m "test: 收口文件事务纠偏验收"
```
