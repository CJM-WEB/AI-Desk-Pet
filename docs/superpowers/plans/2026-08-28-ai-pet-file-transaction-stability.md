# AI 桌宠文件事务稳定性实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 或 `executing-plans` 按任务实施；每项任务严格执行 RED → GREEN → REFACTOR。

**目标：** 让 Provider 与内置本地模型通过同一会话级能力事务，可靠完成创建、读取、编辑、移动、删除和受控 PowerShell 组合任务，并准确处理后续指代与格式故障。

**架构：** 保留现有 `AgentLoop`、`ToolRegistry`、`PendingActionStore`、`FileToolService` 和授权根安全边界；在 `ConversationCoordinator` 与 `AgentService` 之间增加短生命周期事务，工具结果建立可信引用，后续消息续接事务。显式文件任务获得任务级读取能力，普通聊天仍无工具；Provider 格式错误在 Adapter 边界分类并脱敏投影。

**技术栈：** TypeScript、Electron Main、Zod、Vitest、现有 Provider Adapter 与 pnpm workspace

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-28-ai-pet-agent-workshop-stability-design.md`。
- OpenCode 只参考 `D:\AgentLearning` 固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`；不得整体复制其 Agent、权限、Shell 或数据库。
- Renderer 不获得文件系统、进程或私有工具 transcript；Main 仍是唯一执行和事实裁决边界。
- 普通聊天工具表严格为空；写入、移动、删除与 PowerShell 继续逐次确认。
- MCP 运行时、Agent 和 Renderer保持禁用。
- 所有新文档与结构性注释使用中文。

---

### Task 1：显式文件事务统一公告完整受控工具

**文件：**
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 修改：`apps/desktop/src/main/agent/main-agent-session-factory.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/main/storage/settings-store.ts`
- 修改：`packages/shared-types/src/contracts.ts`
- 测试：`apps/desktop/tests/agent-service.test.ts`
- 测试：`apps/desktop/tests/main-agent-session-factory.test.ts`
- 测试：`apps/desktop/tests/settings-store.test.ts`
- 测试：`apps/desktop/tests/multi-provider-settings.test.tsx`

**接口：**
- 删除：`AgentSession.fileDisclosureAllowed` 与 `MainAgentSessionFactoryInput.fileDisclosureAllowed`。
- 保留：`createMainAgentSession(input)`，但显式文件任务的 `executeRead` 始终走现有受控文件端口。
- 产生：文件事务可见的完整 `FilePlanningTool[]`，PowerShell 仅在任务种类为 `powershell` 时追加。

- [ ] **步骤 1：写失败测试**

在 `main-agent-session-factory.test.ts` 写入旧隐私值为 false 时显式文件 Session 仍可调用真实 `executeRead` 的测试；在 `agent-service.test.ts` 写入首轮 `preferredTool='create_file'` 后第二轮仍可见 `read_file/edit_file/move_file` 的纵向测试；在设置测试中断言旧 `fileDisclosureAccepted` 和 `privacy.dataCategories.file` 不再影响文件任务工具表，普通聊天测试继续断言工具表为空。

- [ ] **步骤 2：验证 RED**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- main-agent-session-factory.test.ts agent-service.test.ts settings-store.test.ts multi-provider-settings.test.tsx
```

预期：至少因 `fileDisclosureAllowed=false` 阻断读取、首轮工具表被收窄或旧设置仍存在而失败。

- [ ] **步骤 3：最小实现**

删除运行期 `fileDisclosureAllowed` 过滤，显式文件任务始终公告完整受控文件工具；保留任务种类对 `powershell` 的独立限制。设置迁移读取旧字段后丢弃，隐私页删除只服务文件披露 Gate 的开关和文案，其他隐私设置保持原样。

- [ ] **步骤 4：验证 GREEN 与重构**

重复步骤 2，随后运行：

```powershell
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部通过且没有 TypeScript 错误。

- [ ] **步骤 5：提交**

```powershell
git add apps/desktop/src/main/agent apps/desktop/src/main/index.ts apps/desktop/src/main/storage/settings-store.ts packages/shared-types/src/contracts.ts apps/desktop/tests
git commit -m "fix: 统一显式文件任务工具权限"
```

### Task 2：建立可信文件引用与会话级能力事务

**文件：**
- 新增：`apps/desktop/src/main/conversation/capability-transaction.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 修改：`apps/desktop/src/main/conversation/capability-task-adapter.ts`
- 修改：`apps/desktop/src/main/conversation/capability-intent-router.ts`
- 测试：`apps/desktop/tests/capability-transaction.test.ts`
- 测试：`apps/desktop/tests/conversation-coordinator.test.ts`
- 测试：`apps/desktop/tests/capability-intent-router.test.ts`

**接口：**

```ts
export type CapabilityTransactionPhase =
  | 'planning' | 'awaiting_clarification' | 'awaiting_confirmation'
  | 'running' | 'completed' | 'failed';

export type TrustedFileReference = Readonly<{
  role: 'created' | 'read' | 'moved_source' | 'moved_target' | 'deleted';
  relativePath: string;
}>;

export class CapabilityTransactionStore {
  begin(input: CapabilityTransactionIdentity): void;
  apply(event: TaskEvent): void;
  classifyFollowUp(text: string): 'continue' | 'status' | 'new_task' | 'none';
  snapshot(): CapabilityTransactionSnapshot | null;
  invalidate(reason: CapabilityTransactionInvalidation): void;
}
```

- [ ] **步骤 1：写事务状态机失败测试**

在新测试中以字面事件验证：只有成功 `tool_result` 能建立引用；assistant 文本“已经移动”不能建立引用或成功；`awaiting_confirmation` 下“继续”返回等待确认而不执行；`completed/failed` 下“成功了吗”返回真实终态；generation、Provider、授权根变化会清空事务。

- [ ] **步骤 2：验证 RED**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-transaction.test.ts
```

预期：因模块不存在而失败。

- [ ] **步骤 3：实现最小状态机**

新增纯 Main 内存状态机。只保存任务内相对路径与稳定结果码；通过结构化 `TaskEvent` 迁移 phase，禁止从 assistant 自由文本推导成功和引用。

- [ ] **步骤 4：写 Coordinator 失败测试**

覆盖“创建 test.txt→确认成功→把刚创建的文件改为 hello”“把 order 文件放入 a 文件夹”“继续”“成功了吗”；断言第二轮使用同一事务与可信相对路径，确认前调用执行端次数为零，明确新任务会替换旧任务。

- [ ] **步骤 5：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- conversation-coordinator.test.ts capability-intent-router.test.ts
```

预期：当前后续输入会进入普通聊天或丢失引用，因此失败。

- [ ] **步骤 6：接入 Coordinator 并验证 GREEN**

让 Router 只做能力候选/否定 Gate；Coordinator 在调用聊天 Provider 前先检查有效事务后续语义，把指代信息作为私有规划上下文交给原 Agent Session。reset、新聊天、关闭、Provider/配置/授权根变化调用 `invalidate()`。

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- capability-transaction.test.ts conversation-coordinator.test.ts capability-intent-router.test.ts
```

预期：全部通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/desktop/src/main/conversation apps/desktop/tests/capability-transaction.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/capability-intent-router.test.ts
git commit -m "feat: 增加会话级文件能力事务"
```

### Task 3：工具协议修复与真实结果权威

**文件：**
- 修改：`packages/agent-core/src/agent-loop.ts`
- 修改：`packages/agent-core/src/types.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 测试：`packages/agent-core/tests/agent-loop.test.ts`
- 测试：`apps/desktop/tests/agent-service.test.ts`
- 测试：`apps/desktop/tests/provider-tool-error-history.test.ts`

**接口：**
- 产生：`AgentLoop` 在显式能力任务中，零工具的口头成功触发一次受限修复；修复后仍无工具则发出稳定协议错误。
- 保留：相同工具/参数三次熔断、Schema 二次校验、工具结果后继续循环。

- [ ] **步骤 1：写失败测试**

在 `agent-loop.test.ts` 增加：模型先口头“已完成”但无工具时进行一次修复；第二次仍无工具时为协议失败；工具参数非法回灌后只修复一次；真实工具失败后模型不能把 phase 改为 success。测试断言最终事件和真实 runtime 调用次数，不断言 mock 自身存在。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/agent-core test -- agent-loop.test.ts
```

预期：口头成功当前可结束或错误码不具体，测试失败。

- [ ] **步骤 3：最小实现并验证 GREEN**

复用现有 correction/fuse 结构，新增能力任务“必须产生工具或结构化澄清”的终态检查；不为普通聊天启用该规则。

```powershell
pnpm.cmd --filter @myself/agent-core test -- agent-loop.test.ts
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/desktop test -- agent-service.test.ts provider-tool-error-history.test.ts
```

预期：全部通过。

- [ ] **步骤 4：提交**

```powershell
git add packages/agent-core/src packages/agent-core/tests/agent-loop.test.ts apps/desktop/src/main/agent/agent-service.ts apps/desktop/tests/agent-service.test.ts apps/desktop/tests/provider-tool-error-history.test.ts
git commit -m "fix: 阻止文件任务口头伪成功"
```

### Task 4：细分 Provider 格式故障且保护普通聊天

**文件：**
- 新增：`apps/desktop/src/main/providers/provider-response-error.ts`
- 修改：`apps/desktop/src/main/providers/openai-provider.ts`
- 修改：`apps/desktop/src/main/providers/anthropic-provider.ts`
- 修改：`apps/desktop/src/main/providers/gemini-provider.ts`
- 修改：`apps/desktop/src/main/providers/local-model-provider.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 测试：`apps/desktop/tests/provider-contract.test.ts`
- 测试：`apps/desktop/tests/local-model-provider.test.ts`
- 测试：`apps/desktop/tests/conversation-chat-adapter.test.ts`

**接口：**

```ts
export type ProviderResponseErrorCode =
  | 'HTTP_BODY_NOT_JSON' | 'RESPONSE_SHAPE_INVALID'
  | 'CONTROL_SCHEMA_INVALID' | 'TOOL_ARGUMENTS_INVALID'
  | 'STREAM_TERMINAL_MISSING' | 'RESPONSE_FORMAT_UNSUPPORTED';

export class ProviderResponseError extends Error {
  readonly code: ProviderResponseErrorCode;
  readonly stage: 'transport' | 'chat_control' | 'tool_call' | 'stream';
}
```

- [ ] **步骤 1：写失败测试**

用完整协议 fixture 分别触发六类错误并断言稳定子码；普通聊天有 `text` 但缺控制字段时断言仍返回正文、无副作用且只记录 `CONTROL_SCHEMA_INVALID`；日志 fixture 中不得出现 API Key、文件正文、完整路径或原始响应。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- provider-contract.test.ts local-model-provider.test.ts conversation-chat-adapter.test.ts
```

预期：当前错误被折叠或普通聊天整体失败。

- [ ] **步骤 3：实现分类与一次修复**

在 Provider 边界把传输/协议异常包装为稳定错误；聊天 Adapter 单独解析可见正文和控制字段，控制字段失败时不执行副作用。只在无工具副作用的结构化计划阶段允许一次修复。

- [ ] **步骤 4：验证 GREEN 与提交**

```powershell
pnpm.cmd --filter @myself/desktop test -- provider-contract.test.ts local-model-provider.test.ts conversation-chat-adapter.test.ts conversation-coordinator.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git add apps/desktop/src/main/providers apps/desktop/src/main/conversation apps/desktop/tests
git commit -m "fix: 细分模型响应协议错误"
```

预期：测试和类型检查通过后提交。

### Task 5：真实文件纵向验收与文档收口

**文件：**
- 修改：`tests/integration/desktop-agent.test.ts`
- 修改：`tests/security/permission-boundary.test.ts`
- 修改：`apps/desktop/tests/conversation-coordinator.test.ts`
- 修改：`docs/operations/lightweight-agent-acceptance.md`

**接口：**
- 消费：任务 1–4 的完整工具表、事务状态机和 Provider 错误码。
- 产生：Provider/本地模型共享的创建→编辑→移动验收证据。

- [ ] **步骤 1：写纵向失败测试并验证 RED**

在隔离临时授权根中参数化两个 Provider fixture：创建 `test.txt`，确认；读取并编辑为字面内容 `hello`，确认；移动到 `a/test.txt`，确认；最终读取磁盘断言源不存在、目标内容为 `hello`。另加普通聊天零文件调用与跨根拒绝。

```powershell
pnpm.cmd test:integration -- desktop-agent.test.ts
pnpm.cmd test:security -- permission-boundary.test.ts
```

预期：在最终串联前至少一项失败。

- [ ] **步骤 2：只修复集成接线并验证 GREEN**

只处理纵向测试揭示的接线缺口，不增加第二套执行器或放宽安全策略。重复步骤 1，预期全部通过。

- [ ] **步骤 3：更新验收记录**

只记录实际运行命令、日期、环境、结果和未覆盖的人工项；将旧“文件披露开关阻断显式任务”描述标记为被本规格替代。

- [ ] **步骤 4：运行门禁并提交**

```powershell
pnpm.cmd verify:desktop
pnpm.cmd test:security
pnpm.cmd test:integration
git diff --check
git add tests docs/operations/lightweight-agent-acceptance.md apps/desktop/tests/conversation-coordinator.test.ts
git commit -m "test: 验证多步文件事务真实副作用"
```

预期：全部自动门禁通过；真实模型网络质量和用户目录不写为已验收。
