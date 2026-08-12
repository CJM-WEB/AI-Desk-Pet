# 桌宠轻量 Agent 执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复用现有单 Agent、确认和生命周期模块，以五个文件工具和一个前台 PowerShell 工具完成可靠的本地能力闭环。

**Architecture:** `CapabilityIntentRouter` 继续作为唯一分流入口；文件与 PowerShell 共用现有 `AgentLoop`、PendingAction、确认 IPC、generation、取消和 reset。文件能力收敛在 `FileToolService`，PowerShell 收敛在单个 `PowerShellTool` 深模块；不引入第二套 Agent、权限系统或后台运行框架。

**Tech Stack:** TypeScript、Zod、Node `fs/promises`、Node `child_process`、Electron `shell.trashItem`、jsdiff `diff@8.0.2`、Vitest、Playwright。

## Global Constraints

- 仅修改智能桌宠桌面端；禁止修改、构建、启动或测试 `apps/website`。
- 第一版只开放 `list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file`、`powershell`。
- 不保留旧工具别名；被替换的搜索、目录创建、复制、移动、重命名和整文件写入代码必须删除。
- 保留已完成的可信意图路由、首次真实工具结果协议、跨 Provider 披露、确认 IPC、generation、取消和 reset。
- 文件路径只接受授权根内相对路径；拒绝绝对路径、UNC、设备路径、`..` 以及检查时可见的链接/Junction 越权。
- 第一版不承诺抵御同一 Windows 用户下恶意进程制造的毫秒级文件系统竞态。
- 所有 PowerShell 命令逐次确认；不实现 AST、后台任务、PTY、Job Object、提权或 OS 沙箱。
- PowerShell 仅前台非交互执行；`taskkill /T` 只是尽力清理，文案不得称为严格进程隔离。
- 文件正文、命令输出、绝对路径、API key、Authorization 和敏感环境变量不得进入普通诊断日志。
- 实施前确认工作区未提交差异仍只属于已知 Task 3 实验；禁止使用 `git reset --hard` 或 `git checkout --` 覆盖用户改动。
- 每个行为切片严格 RED → GREEN；同一问题超过 10 分钟立即缩小测试或改用成熟依赖。

---

### Task 1: 将文件深模块收敛为五个工具

**Files:**

- Modify: `packages/file-tools/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/file-tools/src/schemas.ts`
- Modify: `packages/file-tools/src/file-tool-service.ts`
- Modify: `packages/file-tools/src/errors.ts`
- Modify: `packages/file-tools/src/index.ts`
- Delete: `packages/file-tools/src/entry-snapshot.ts`
- Modify: `packages/file-tools/tests/file-tool-service.test.ts`
- Verify: `packages/file-tools/tests/path-policy.test.ts`

**Interfaces:**

- Consumes: 现有 `PathPolicy.resolveExisting()`、`PathPolicy.resolveTarget()`、`RecycleBinPort.moveToRecycleBin()`。
- Produces: `FileToolService.executeRead()`、`preview()`、`executeWrite()`；`VerifiedWriteAction` 只包含 Renderer 可见摘要，正文、基础哈希和补丁结果只保存在私有 WeakMap。

```ts
export type VerifiedWriteAction =
  | Readonly<{
      operation: 'create_file';
      authorizationGeneration: number;
      targetRelativePath: string;
      contentCharacters: number;
      contentPreview: string | null;
      previewTruncated: boolean;
    }>
  | Readonly<{
      operation: 'apply_patch';
      authorizationGeneration: number;
      targetRelativePath: string;
      addedLines: number;
      removedLines: number;
      diffPreview: string;
      previewTruncated: boolean;
    }>
  | Readonly<{
      operation: 'delete_file';
      authorizationGeneration: number;
      targetRelativePath: string;
      targetType: 'file' | 'empty_directory';
    }>;
```

- [ ] **Step 1: 固定已知未提交实验范围**

运行：

```powershell
git diff --name-only
```

预期仅包含：

```text
packages/file-tools/src/entry-snapshot.ts
packages/file-tools/src/errors.ts
packages/file-tools/src/file-tool-service.ts
packages/file-tools/tests/file-tool-service.test.ts
```

若出现其他文件，停止并先归属差异。不要恢复到 `c56d007` 再重写；直接用 `apply_patch` 把这四个实验差异收敛为本任务最终实现。

- [ ] **Step 2: 写五工具严格 schema 与旧名消失的 RED**

在 `file-tool-service.test.ts` 增加精确断言：

```ts
expect(Object.keys(toolArguments).sort()).toEqual([
  'apply_patch', 'create_file', 'delete_file', 'list_files', 'read_file'
]);
expect(() => toolArguments.create_file.parse({ relativePath: 'a.txt', extra: true })).toThrow();
expect((toolArguments as Record<string, unknown>)['copy_entry']).toBeUndefined();
```

运行：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "五个工具"
```

预期：FAIL，旧 schema 仍存在。

- [ ] **Step 3: 最小实现 schema 并删除旧工具结构**

`schemas.ts` 只保留：

```ts
export const toolArguments = {
  list_files: z.object({
    relativePath: relativePathSchema.default('.'),
    maxDepth: z.number().int().min(1).max(4).default(1),
    maxResults: z.number().int().min(1).max(200).default(100)
  }).strict(),
  read_file: z.object({
    relativePath: relativePathSchema,
    startLine: z.number().int().min(1).default(1),
    lineCount: z.number().int().min(1).max(500).default(200)
  }).strict(),
  create_file: z.object({ relativePath: relativePathSchema, content: z.string().default('') }).strict(),
  apply_patch: z.object({ relativePath: relativePathSchema, patch: z.string().min(1).max(262_144) }).strict(),
  delete_file: z.object({ relativePath: relativePathSchema }).strict()
} as const;
```

删除 `entry-snapshot.ts`，移除 `SecureFileSystemPort`、seal、search/copy/move/rename/create_directory/write_text_file 分支和相关错误码。

- [ ] **Step 4: 写 `list_files` 与 `read_file` RED**

覆盖：默认不递归、最大深度、最大结果、链接不下钻、相对摘要、行范围、UTF-8/二进制/大小限制、截断标志。关键断言：

```ts
expect(result.entries.every(entry => !('modifiedAt' in entry) && !('size' in entry))).toBe(true);
expect(result).toMatchObject({ toolName: 'read_file', startLine: 2, endLine: 3, truncated: true });
```

运行：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "list_files|read_file"
```

预期：FAIL，执行名和结果契约尚未迁移。

- [ ] **Step 5: 复用 PathPolicy 和有界读取实现只读 GREEN**

`list_files` 使用 `opendir` + `lstat`，链接只作为条目返回，绝不递归；扫描达到 `maxResults` 即停止并设置 `truncated`。`read_file` 继续使用 fatal UTF-8 解码，按行切片并保留不可信数据提示。

- [ ] **Step 6: 安装并锁定 jsdiff**

运行：

```powershell
pnpm.cmd add diff@8.0.2 --filter @myself/file-tools
```

只允许 `packages/file-tools/package.json` 与 `pnpm-lock.yaml` 出现依赖变化。

- [ ] **Step 7: 逐个写三个写工具 RED**

依次运行独立测试：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "create_file"
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "apply_patch"
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "delete_file"
```

每组先得到真实 RED，并覆盖：

- `create_file` 使用 `open('wx')`，正文只在私有动作中；
- `apply_patch` 的 `parsePatch()` 必须恰好返回一个补丁，`applyPatch(..., { fuzzFactor: 0 })` 返回 `false` 时拒绝；确认后基础 SHA-256 变化返回 `ENTRY_CHANGED`；临时文件使用随机名与 `wx`，成功后同目录 `rename`；
- `delete_file` 拒绝授权根、链接、特殊实体、非空目录；执行只调用回收站端口；
- 三类动作均绑定 authorization generation、只能执行一次、对象克隆与伪造均为 `ACTION_EXPIRED`。

- [ ] **Step 8: 实现三个写工具 GREEN**

私有记录使用封闭联合：

```ts
type InternalWriteAction =
  | { operation: 'create_file'; targetRelativePath: string; content: string }
  | { operation: 'apply_patch'; targetRelativePath: string; baseSha256: string; result: string }
  | {
      operation: 'delete_file';
      targetRelativePath: string;
      targetType: 'file' | 'empty_directory';
      expectedIdentity: Readonly<{ device: bigint; inode: bigint; size: bigint; modifiedAtNs: bigint }>;
    };
```

所有动作在解析路径或产生副作用前从 WeakMap 消费，失败后也不能重放。

- [ ] **Step 9: 运行文件包完整验证并提交**

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/file-tools typecheck
git diff --check
git diff --name-only -- apps/website
git add packages/file-tools pnpm-lock.yaml
git commit -m "refactor: 收敛桌宠轻量文件工具"
```

预期：测试/typecheck 退出 0，网站差异为空。

### Task 2: 迁移文件确认契约、注册表与 Renderer

**Files:**

- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `apps/desktop/src/main/agent/tool-registry.ts`
- Modify: `apps/desktop/src/main/agent/pending-action-store.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- Modify: `apps/desktop/tests/tool-permission-policy.test.ts`
- Modify: `apps/desktop/tests/pending-action-store.test.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `VerifiedWriteAction` 与五个 `toolArguments`。
- Produces: 文件 PendingAction 严格联合、恰好五个文件注册、现有确认卡对三个写动作的完整展示。

- [ ] **Step 1: 写公开 PendingAction 与注册表 RED**

期望文件分支：

```ts
type PendingFileAction = Readonly<{
  category: 'file';
  actionId: string;
  conversationId: string;
  risk: 'write';
  operation: 'create_file' | 'apply_patch' | 'delete_file';
  summary: string;
  targetRelativePath: string;
  contentCharacters?: number;
  contentPreview?: string | null;
  previewTruncated?: boolean;
  addedLines?: number;
  removedLines?: number;
  diffPreview?: string;
  targetType?: 'file' | 'empty_directory';
  createdAt: string;
  expiresAt: string;
}>;
```

断言 registry definitions 精确为：

```ts
[
  'builtin.files.apply_patch',
  'builtin.files.create_file',
  'builtin.files.delete_file',
  'builtin.files.list_files',
  'builtin.files.read_file'
]
```

旧工具名必须 `TOOL_UNKNOWN`。

- [ ] **Step 2: 运行 RED**

```powershell
pnpm.cmd --dir packages/shared-types exec vitest run --config vitest.config.ts tests/contracts.test.ts -t "PendingAction"
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/tool-permission-policy.test.ts
```

预期：旧四分支确认与旧六工具注册导致失败。

- [ ] **Step 3: 实现严格文件联合和五工具注册**

`pendingActionSchema` 使用 `z.discriminatedUnion('category', [...])`。`PendingActionStore` 不对联合直接使用非分布式 `Omit`，而是显式定义：

```ts
export type PendingActionDraft = PendingAction extends infer Action
  ? Action extends PendingAction
    ? Omit<Action, 'actionId' | 'createdAt' | 'expiresAt'>
    : never
  : never;
```

Registry 中只读风险为 `read`，三个写工具风险为 `recoverable`；`create_file` 的公开 JSON Schema 必须包含 `content`。

- [ ] **Step 4: 写 AgentService/Renderer RED**

覆盖：

- AgentService 使用 `action.operation` 而不是旧 `.toolName`；
- create 卡显示字符数和受限预览；
- patch 卡显示增删行和 diffPreview；
- delete 卡显示“进入 Windows 回收站”；
- Renderer 篡改公开摘要不改变私有执行；
- delete 继续复用现有 carry/commit 事务，create/patch 不等待动画。

- [ ] **Step 5: 实现文件纵向 GREEN**

`writeResult()` 返回 `{ ok: true, toolName: action.operation, targetRelativePath }`。`actionSummary()` 使用穷尽 switch；ConfirmationCard 同样使用 `assertNever` 保证三分支完整。

- [ ] **Step 6: 定向验证并提交**

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/tool-permission-policy.test.ts tests/pending-action-store.test.ts tests/agent-service.test.ts tests/renderer-components.test.tsx
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git diff --name-only -- apps/website
git add packages/shared-types apps/desktop/src/main/agent apps/desktop/src/renderer/src/chat apps/desktop/tests
git commit -m "refactor: 接通轻量文件确认契约"
```

### Task 3: 新增单模块前台 PowerShell 工具

**Files:**

- Create: `apps/desktop/src/main/agent/powershell-tool.ts`
- Create: `apps/desktop/tests/powershell-tool.test.ts`

**Interfaces:**

- Consumes: 授权根绝对路径、只用于展示的目录标签、session generation、AbortSignal。
- Produces: 不可伪造的 `VerifiedPowerShellAction` 和真实 `PowerShellRunResult`；调用方不接触 ChildProcess。

```ts
export type VerifiedPowerShellAction = Readonly<{
  kind: 'powershell';
  command: string;
  workingDirectoryLabel: string;
  runMode: 'foreground';
  generation: string;
  expiresAtMs: number;
}>;

export type PowerShellRunResult = Readonly<{
  ok: boolean;
  toolName: 'powershell';
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  timeoutKind: 'idle' | 'total' | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}>;
```

- [ ] **Step 1: 写模块不存在的 RED**

测试必须通过可注入 `ProcessPort` 驱动以下场景，不启动真实 PowerShell：固定 argv、`shell:false`、固定 cwd、环境白名单、秘密变量移除、stdout/stderr 分离、各 256 KiB 截断、非零退出、Abort、60 秒静默超时、10 分钟总超时、close 幂等、迟到 data/exit 无效、确认 TTL/generation/对象克隆/重放失效。

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/powershell-tool.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 2: 定义最小进程内部 seam**

该 seam 不导出到模块外：

```ts
interface ProcessPort {
  spawn(input: {
    file: 'powershell.exe';
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    shell: false;
  }): RunningProcess;
  killTree(pid: number): Promise<void>;
}
```

生产适配器固定 argv：

```ts
['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
```

- [ ] **Step 3: 实现 `PowerShellTool` GREEN**

外部 interface 只有：

```ts
preview(input: {
  command: string;
  workingDirectory: string;
  workingDirectoryLabel: string;
  generation: string;
}): VerifiedPowerShellAction;
execute(action: VerifiedPowerShellAction, signal: AbortSignal): Promise<PowerShellRunResult>;
close(): Promise<void>;
```

私有 WeakMap 绑定完整 cwd、命令 SHA-256、generation 和 expiresAt；公开动作克隆或过期均拒绝。命令限制 16 KiB。终止路径统一处理 Abort、静默超时、总超时和 close；先终止直接进程，再调用 `taskkill.exe /PID <pid> /T /F` 尽力清理。

- [ ] **Step 4: 增加明确硬拒绝测试**

只拒绝直接可识别的高风险语句：`Start-Process -Verb RunAs`、`runas.exe`、`Get-Credential`、`cmdkey`、`vaultcmd`、`Remove-Item ... -Recurse ... -Force`。测试必须同时证明普通命令不因未知 token 被本地规则误拒绝；其他命令进入逐次确认。

- [ ] **Step 5: 定向验证并提交**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/powershell-tool.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git diff --name-only -- apps/website
git add apps/desktop/src/main/agent/powershell-tool.ts apps/desktop/tests/powershell-tool.test.ts
git commit -m "feat: 增加前台 PowerShell 工具"
```

### Task 4: 泛化 Agent 协议、确认存储和执行事实

**Files:**

- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/src/agent-loop.ts`
- Modify: `packages/agent-core/tests/agent-loop.test.ts`
- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `apps/desktop/src/main/agent/tool-registry.ts`
- Modify: `apps/desktop/src/main/agent/pending-action-store.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/tests/tool-permission-policy.test.ts`
- Modify: `apps/desktop/tests/pending-action-store.test.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`

**Interfaces:**

- Consumes: Task 1 文件动作、Task 3 PowerShell 动作。
- Produces: 一个 capability planner 协议、一个 PendingActionStore、一个 AgentService；文件与 PowerShell 不建立平行状态机。

- [ ] **Step 1: 写协议替换和失败事实 RED**

将公开类型目标写入测试：

```ts
export type AgentRunProtocol = 'default' | 'capability_planner';
```

覆盖：旧 `file_planner` 不再编译/不存在；首次工具前普通拒绝仍只修复一次；PowerShell 非零退出传回模型后，最终 phase 必须为 `error`，不能因模型总结而变成 success；后续新工具成功可以恢复 success。

- [ ] **Step 2: 实现通用 planner 与可信结果状态**

把错误码改为 `CAPABILITY_PLAN_PROTOCOL_INVALID`，修复指令只描述“调用当前提供的工具或返回严格 clarification JSON”，不提文件。

`AgentLoop.resume()` 接收的工具结果约定 `ok?: boolean`；`ContinuationState` 保存最近可信结果状态。最终文本之后：

```ts
yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
```

这只决定终态，不隐藏模型总结。

- [ ] **Step 3: 写 PowerShell PendingAction RED**

新增联合分支：

```ts
type PendingPowerShellAction = Readonly<{
  category: 'powershell';
  actionId: string;
  conversationId: string;
  risk: 'shell';
  operation: 'powershell';
  summary: string;
  command: string;
  workingDirectoryLabel: string;
  runMode: 'foreground';
  createdAt: string;
  expiresAt: string;
}>;
```

Renderer 可见完整命令，但私有绝对 cwd、确认哈希和进程对象绝不进入 PendingAction。

- [ ] **Step 4: 泛化 PendingExecution 与 AgentSession**

```ts
type VerifiedCapabilityAction =
  | Readonly<{ category: 'file'; action: VerifiedWriteAction }>
  | Readonly<{ category: 'powershell'; action: VerifiedPowerShellAction }>;

type AgentSession = AgentSessionBase & (
  | Readonly<{ taskKind: 'file'; fileTools: AgentFileTools }>
  | Readonly<{ taskKind: 'powershell'; powershell: PowerShellTool }>
);
```

`AgentService.forward()` 根据 execution toolName 选择文件预览或 PowerShell 预览；`confirmAction()` 对文件复用原写入/回收站事务，对 PowerShell 直接等待 `execute(action, signal)`，不播放搬运动画。

- [ ] **Step 5: 工具注册只暴露当前任务能力**

```ts
createSessionToolRegistry(input: {
  taskKind: 'file' | 'powershell';
  fileDisclosureAllowed: boolean;
}): ToolRegistry
```

`file` 返回五个文件工具；`powershell` 只返回：

```ts
definition: builtin.powershell.run
executionToolName: powershell
arguments: { command: string(1..16384) }
risk: high
```

两种表均不得混入另一种执行能力；轻量第一版不向本地能力任务追加 MCP read tools。

- [ ] **Step 6: reset/close 竞态 RED→GREEN**

使用 deferred 假进程证明：等待确认 reset、运行中 reset、close、配置变化都会使旧 action 和迟到输出失效；close 等待 PowerShellTool 的终止 Promise 收敛，但普通不服从 Abort 的 Provider 不阻塞无限期。

- [ ] **Step 7: 定向验证并提交**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/tool-permission-policy.test.ts tests/pending-action-store.test.ts tests/agent-service.test.ts tests/powershell-tool.test.ts
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git diff --name-only -- apps/website
git add packages/agent-core packages/shared-types apps/desktop/src/main/agent apps/desktop/tests
git commit -m "refactor: 统一本地能力计划与确认执行"
```

### Task 5: 接通会话分流、组合根和确认 UI

**Files:**

- Rename: `apps/desktop/src/main/conversation/file-task-adapter.ts` → `apps/desktop/src/main/conversation/capability-task-adapter.ts`
- Rename: `apps/desktop/tests/file-task-adapter.test.ts` → `apps/desktop/tests/capability-task-adapter.test.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/conversation/capability-intent-router.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- Modify: `apps/desktop/tests/capability-intent-router.test.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `apps/desktop/tests/main-conversation-composition.test.ts`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Verify unchanged: `apps/desktop/src/main/ipc/register-ipc.ts`
- Verify unchanged: `apps/desktop/src/preload/index.ts`
- Verify unchanged: `apps/desktop/src/shared/ipc-channels.ts`

**Interfaces:**

- Consumes: Task 4 的 `taskKind`、唯一 AgentService、唯一 PendingAction。
- Produces: `ConversationCapabilityTaskPort` 与 `CapabilityTaskAdapter`；文件和 PowerShell 共用准备、披露、取消、reset 和 close。

- [ ] **Step 1: 写 PowerShell 路由纵向 RED**

覆盖：明确 PowerShell 请求不再产生 `POWERSHELL_TASK_NOT_READY`；只提交 `taskKind:'powershell'`；普通聊天、命令讨论、代码块和文件正文仍不创建能力目标；后台请求返回稳定 `POWERSHELL_BACKGROUND_UNSUPPORTED`，不静默改为前台。

- [ ] **Step 2: 重命名并泛化 Adapter**

使用 `git mv` 完成文件和测试重命名，随后将接口收敛为：

```ts
interface ConversationCapabilityTaskPort {
  prepareTarget(input: { generation: string; taskKind: 'file' | 'powershell' }): Promise<PreparedCapabilityTarget>;
  submit(input: { text: string; visibleHistory: readonly ModelMessage[]; taskKind: 'file' | 'powershell' }): Promise<void>;
  // 保留现有 resolveAction/cancel/reset/close/onEvent
}
```

不要保留 `FileTaskAdapter` 别名或第二实现。

- [ ] **Step 3: 泛化 Coordinator 状态并删除 NOT_READY**

状态统一为 `preparing_capability_task` / `running_capability_task` 并携带 `taskKind`。两种任务都复用历史披露与 Provider 目标快照；PowerShell 仍要求授权根，因为 cwd 和命令可访问该根。

- [ ] **Step 4: 构建 Main 唯一组合根**

`main-conversation-composition.ts` 的 agent snapshot 增加 `taskKind`。`main/index.ts`：

- 文件任务构造五工具 registry 与 FileToolService；
- PowerShell 任务只构造一个 PowerShell registry 与 PowerShellTool；
- 两者使用同一个 AgentService、PendingActionStore 和 AgentLoop；
- `shell.trashItem` 继续作为 delete_file 的唯一删除端口；
- close/reset 关闭活动 PowerShell，不增加新 IPC。

- [ ] **Step 5: 写并实现 PowerShell 确认卡**

卡片逐字显示 `command`，显示 `workingDirectoryLabel` 和“前台非交互执行”，明确“以当前 Windows 用户权限运行；这不是安全沙箱”。确认/取消仍只回传 actionId。

- [ ] **Step 6: 定向回归与静态反查**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/conversation-coordinator.test.ts tests/capability-task-adapter.test.ts tests/main-conversation-composition.test.ts tests/renderer-components.test.tsx tests/renderer-task-store.test.ts tests/agent-ipc.test.ts tests/preload-api.test.ts
rg -n "FileTaskAdapter|ConversationFileTaskPort|POWERSHELL_TASK_NOT_READY|search_entries|write_text_file|copy_entry|move_entry|rename_entry|create_directory" apps/desktop/src packages/file-tools/src packages/shared-types/src
```

预期：测试全过；静态反查无旧实现命中。

- [ ] **Step 7: typecheck 并提交**

```powershell
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git diff --name-only -- apps/website
git add apps/desktop packages/file-tools packages/agent-core packages/shared-types pnpm-lock.yaml
git commit -m "feat: 接通桌宠轻量本地能力"
```

### Task 6: 安全、集成与 Electron 纵向验收

**Files:**

- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/integration/provider-server.test.ts`
- Modify: `tests/fixtures/electron-app.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Create: `docs/operations/lightweight-agent-acceptance.md`
- Create: `.superpowers/sdd/2026-08-12-ai-pet-lightweight-agent-execution/task-6-report.md`

**Interfaces:**

- Consumes: Tasks 1–5 的最终生产组合。
- Produces: 可复现的安全、集成、Electron 和人工验收证据；不新增生产接口。

- [ ] **Step 1: 写安全边界 RED**

覆盖：Renderer 不能提交 taskKind、命令、cwd、generation 或能力 token；普通聊天不创建 FileToolService/PowerShellTool；文件正文中的命令不能触发 Shell；日志哨兵覆盖用户正文、模型正文、文件正文、命令、stdout/stderr、授权根和 API key。

- [ ] **Step 2: 写五工具纵向 RED**

使用真实临时授权根验证：列目录、分段读取、带正文独占创建、补丁确认与冲突拒绝、文件/空目录进入回收站、非空目录拒绝、旧工具名拒绝、模型口头拒绝后修复调用工具、连续伪成功稳定失败。

- [ ] **Step 3: 写 PowerShell 纵向 RED**

Provider 先产生 `builtin.powershell.run`；确认卡出现完整命令和目录摘要；确认后假进程返回真实 stdout/stderr/exit；非零退出最终 phase error；超时和 reset 后无迟到事件；后台请求显示不支持；普通聊天零进程。

- [ ] **Step 4: 最小调整 fixtures 并跑 GREEN**

fixtures 只增加去标识化进程摘要和可控假 PowerShell 端口，不将完整命令、正文或输出写入测试报告。

```powershell
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd --filter @myself/desktop build
pnpm.cmd test:e2e:desktop -- --grep "轻量文件与 PowerShell"
```

- [ ] **Step 5: 写中文验收文档**

文档逐项列出：自动证据、人工步骤、预期结果和失败恢复。人工项至少包括真实 PowerShell `Get-Location`、创建正文文件、补丁修改、回收站恢复、命令取消和设置变更后旧确认失效。

- [ ] **Step 6: 严格串行运行最终门禁**

禁止运行根递归 typecheck；逐包执行以排除 website：

```powershell
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/character-assets typecheck
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/release-tools typecheck
pnpm.cmd test:unit
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
pnpm.cmd verify:behavior
git diff --check
git diff --name-only -- apps/website
```

每道门记录退出码、测试文件数、通过/跳过数和耗时。E2E 后检查本工作树 Electron/Node/PowerShell 残留进程；不得为了通过而提高全局超时或添加固定 sleep。

- [ ] **Step 7: 双轴复审并提交验收证据**

独立规格审查核对新设计全部条款；独立质量审查核对权限、竞态、失败原子性、进程生命周期、日志隐私和假绿测试。Critical/Important 清零后：

```powershell
git add tests docs/operations/lightweight-agent-acceptance.md
git add -f .superpowers/sdd/2026-08-12-ai-pet-lightweight-agent-execution/task-6-report.md
git commit -m "test: 验收桌宠轻量本地能力"
```

---

## 完成定义

- 用户明确文件请求由真实文件工具完成，不再得到口头拒绝或终端建议。
- 五个文件工具和一个 PowerShell 工具是唯一公开能力；旧工具、旧类名和旧计划静态反查零命中。
- 所有 PowerShell 均逐次确认并以前台非交互方式运行；后台、AST、PTY、Job Object 和沙箱均未混入首版。
- reset、取消、配置变化和退出不会让旧确认、旧 Provider 或旧进程事件穿透新会话。
- 普通聊天不依赖授权目录，也不创建文件或 PowerShell 能力。
- 文件、命令和模型事实均来自真实工具结果；失败不能发布 success。
- 全部非网站门禁通过，`apps/website` 从设计基线到最终 HEAD 零差异。
