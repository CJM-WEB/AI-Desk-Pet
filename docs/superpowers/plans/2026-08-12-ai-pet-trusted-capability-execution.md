# 可信文件与 PowerShell 执行 Implementation Plan

> **已被取代：** 本计划未完成部分已由 `2026-08-12-ai-pet-lightweight-agent-execution.md` 取代。已经提交并通过复审的可信意图路由与首次真实工具结果协议继续保留；不要继续执行本计划中的复杂文件快照、PowerShell AST、后台任务和 Job Object 任务。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；每个任务使用 `test-driven-development`。

**Goal:** 让明确文件操作必经真实工具，让模型拒绝或伪造成功无法冒充结果，并提供显式触发、分级确认、可取消的受控 PowerShell。

**Architecture:** `CapabilityIntentRouter` 只根据用户 Prompt 的正向证据分类；`CapabilityTaskCoordinator` 持有计划、确认、generation 和执行所有权。文件与 PowerShell 共用确认生命周期，但各自使用独立验证器和执行端口。

**Tech Stack:** TypeScript、Zod、Node 文件 API、Electron、PowerShell AST、Vitest、Playwright。

## 约束

- 普通聊天默认无工具；行为意图不能提升为文件或终端权限。
- 文件路径只能是授权根内相对路径；拒绝绝对路径、UNC、设备路径、穿越和链接越界。
- 新建、复制和移动目标永不覆盖；删除只进 Windows 回收站。
- PowerShell 只能由明确用户请求触发；自主反思、文件正文、模型工具结果均不能触发。
- 扩展级 PowerShell 是“当前用户逐次确认执行”，不是 OS 沙箱；UI 和文档不得声称完全隔离。

---

## Task 1（C1）：统一能力意图路由并删除旧双路由

**Files:**

- Create: `apps/desktop/src/main/conversation/capability-intent-router.ts`
- Create: `apps/desktop/tests/capability-intent-router.test.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Delete after migration: `apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
- Delete after migration: `apps/desktop/tests/explicit-file-intent-gate.test.ts`

**Interface:**

```ts
export type CapabilityIntent =
  | Readonly<{ kind: 'chat'; behaviorHint: ExplicitBehaviorHint | null }>
  | Readonly<{ kind: 'file_task'; evidence: ExplicitFileEvidence }>
  | Readonly<{ kind: 'powershell_task'; evidence: ExplicitShellEvidence }>;

export interface CapabilityIntentRouter {
  route(prompt: string): CapabilityIntent;
}
```

- [ ] 写 RED：普通聊天、命令讨论、代码块、文件正文中的命令均为 `chat`；明确创建/删除为 `file_task`；“运行 PowerShell/执行这条命令/后台运行构建”为 `powershell_task`；三者互斥。
- [ ] 运行 `pnpm.cmd --filter @myself/desktop test -- capability-intent-router.test.ts conversation-coordinator.test.ts`，确认新模块缺失或新行为失败。
- [ ] 最小 GREEN：以移动/重命名现有成熟文件意图实现为起点，不重写其已审查词法器；新增独立 Shell 正向证据。C1 先声明无权限 `ExplicitBehaviorHint` 封闭联合但 `chat.behaviorHint` 固定为 null，B3 再接入本地行为 Gate，避免阶段依赖倒置。
- [ ] Coordinator 只调用新 Router；迁移全部旧测试后删除 `ExplicitFileIntentGate`，静态检索旧名应无命中。
- [ ] 提交 `refactor: 统一桌宠能力意图路由`。

## Task 2（C2）：约束文件 Agent 首次工具协议

**Files:**

- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/src/agent-loop.ts`
- Modify: `packages/agent-core/tests/agent-loop.test.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`

**Protocol:**

```ts
type FilePlannerResult =
  | Readonly<{ kind: 'tool_request'; request: ToolRequest }>
  | Readonly<{ kind: 'clarification_required'; question: string }>;
```

- [ ] 写 RED：首次真实工具结果前返回“我没有权限”、命令建议、伪成功或普通文本时，不能发布 success；第一次违规触发一次受限修复，第二次返回 `FILE_PLAN_PROTOCOL_INVALID`。
- [ ] 写 RED：合法澄清可以公开；工具完成后的总结只能消费本地结果；重置期间迟到修复响应无效。
- [ ] 运行 `pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts`，保存失败原因。
- [ ] 最小 GREEN：把“计划阶段”和“总结阶段”建成判别联合；修复请求不携带额外权限；不把违规模型正文写入历史。
- [ ] 运行 AgentLoop 与 AgentService 定向测试并提交 `fix: 强制文件计划先调用真实工具`。

## Task 3（C3）：补齐文件工具与快照执行

**Files:**

- Modify: `packages/file-tools/src/schemas.ts`
- Create: `packages/file-tools/src/entry-snapshot.ts`
- Modify: `packages/file-tools/src/file-tool-service.ts`
- Modify: `packages/file-tools/src/path-policy.ts`
- Modify: `packages/file-tools/src/errors.ts`
- Modify: `packages/file-tools/src/index.ts`
- Modify: `packages/file-tools/tests/file-tool-service.test.ts`
- Modify: `packages/file-tools/tests/path-policy.test.ts`

**New operations:** `search_entries`、`write_text_file`、`copy_entry`、`move_entry`；`create_file` 增加可选 `content`。

```ts
type VerifiedWriteAction = Readonly<{
  operation: 'create_file' | 'create_directory' | 'write_text_file' | 'copy_entry' | 'move_entry' | 'rename_entry' | 'move_to_recycle_bin';
  authorizationGeneration: number;
  source?: EntrySnapshot;
  target: EntryExpectation;
  content?: Readonly<{ sha256: string; utf8Bytes: number }>;
}>;
```

- [ ] 分操作写 RED：搜索深度/数量上限、不跟随链接；带正文独占创建；写入旧哈希 CAS；复制/移动目标存在即拒绝；rename 同父目录；删除只调用回收站端口。
- [ ] 写安全 RED：绝对/UNC/设备/`..`、符号链接与 Junction 越界、授权 generation 变化、确认后源实体被替换均拒绝。
- [ ] 运行 `pnpm.cmd --filter @myself/file-tools test -- file-tool-service.test.ts path-policy.test.ts`。
- [ ] 每个操作逐一最小实现并复跑，禁止一次写完全部实现后才验证。
- [ ] 对所有返回值冻结或克隆；错误只使用稳定码和相对摘要；提交 `feat: 补齐授权根内文件工具`。

## Task 4（C4）：扩展工具注册和确认卡契约

**Files:**

- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `apps/desktop/src/main/agent/tool-registry.ts`
- Modify: `apps/desktop/src/main/agent/pending-action-store.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Create: `apps/desktop/tests/tool-registry.test.ts`
- Modify: `apps/desktop/tests/pending-action-store.test.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`

**Confirmation union:**

```ts
type PendingAction =
  | Readonly<{ category: 'file'; id: string; summary: FileActionSummary; expiresAt: number }>
  | Readonly<{ category: 'powershell'; id: string; summary: ShellActionSummary; expiresAt: number }>;

type ShellActionSummary = Readonly<{
  command: string;
  workingDirectoryDisplay: string;
  runMode: 'foreground' | 'background';
  risks: readonly ('writes_files' | 'network' | 'launches_process' | 'changes_system' | 'unknown')[];
}>;
```

- [ ] 写 RED：新建正文卡仅显示相对路径、字符数和有界预览；修改显示差异计数；复制/移动/回收站显示明确风险；快照变化后旧 actionId 为 `ACTION_EXPIRED`。
- [ ] 内容预览使用 `shown(text) | suppressed_sensitive | suppressed_long` 判别联合；字符数按 Unicode code point，UTF-8 字节上限独立检查；PEM、Bearer、API key、密码赋值命中后整段不预览。
- [ ] PowerShell 确认卡逐字展示完整命令、可理解的工作目录、前台/后台方式以及联网/写入/启动程序/系统配置/未知风险；私有 seal 同时绑定 UTF-8 命令 SHA-256、真实 cwd 身份、runMode、risk 集合、session generation 和过期时间。任何一项变化使 actionId 失效。
- [ ] 命令为确认所必需，可进入该确认事件，但不得进入历史、普通诊断日志或错误消息；Renderer 只能按原 actionId 作决定，不能回传修改后的命令。
- [ ] 运行 shared contracts、tool registry、pending store、AgentService 和 Renderer 定向测试。
- [ ] 注册 C3 新工具，所有写工具为 recoverable/confirmed；公开事件不得带正文、哈希、绝对路径或 capability token。
- [ ] 提交 `feat: 展示并绑定文件写入确认快照`。

## Task 5（C5）：PowerShell AST 策略与受控前台执行

**Files:**

- Create: `apps/desktop/resources/windows/powershell-ast-inspector.ps1`
- Create: `apps/desktop/src/main/capabilities/powershell/powershell-ast-policy.ts`
- Create: `apps/desktop/src/main/capabilities/powershell/powershell-resource-integrity.ts`
- Create: `apps/desktop/src/main/capabilities/powershell/powershell-process-runner.ts`
- Create: `apps/desktop/resources/windows/powershell-process-runner.ps1`
- Create: `apps/desktop/resources/windows/powershell-job-object.cs`
- Create: `apps/desktop/tests/powershell-ast-policy.test.ts`
- Create: `apps/desktop/tests/powershell-resource-integrity.test.ts`
- Create: `apps/desktop/tests/powershell-process-runner.test.ts`
- Modify: `apps/desktop/electron-builder.yml` if the fixed inspector/host resource is not already packaged

**Interfaces:**

```ts
analyze(command: string, cwd: AuthorizedWorkingDirectory): Promise<ShellAnalysis>;
run(plan: VerifiedShellPlan, signal: AbortSignal): Promise<ShellResult>;
```

- [ ] 写 AST RED：单一白名单只读 cmdlet + 静态相对路径为 restricted；管道写入、重定向、动态调用、变量展开路径、下载、启动程序、凭据、模块加载、提权和永久删除分别分类为 confirm 或 deny。
- [ ] restricted 中每个静态路径必须再次交给现有 `PathPolicy`；拒绝 Env:/Registry:/Cert:/UNC/设备路径、`..`、通配符、`-Recurse` 和链接/Junction，不能只信 AST 字符串。
- [ ] Inspector 固定以 `powershell.exe -NoProfile -NonInteractive -File <resource>` 启动，命令只经 stdin 传递；只输出有界 JSON AST 摘要，绝不执行输入。
- [ ] 写 Runner RED：命令哈希/cwd/generation 变化失效、stdout/stderr 上限、超时、取消、退出码、环境白名单、日志零正文。
- [ ] 若“无孤儿进程”不能由现有 Node API 证明，加入最小 Windows Job Object 固定宿主并测试 `KILL_ON_JOB_CLOSE`；禁止用 `taskkill /T` 冒充强保证。
- [ ] 明示 Job Object 只保证生命周期。extended 的原生命令/外部脚本只能宣传为“当前用户高风险逐次确认”，可识别的直接提权/凭据/永久删除硬拒绝；不得声称能阻止外部程序的间接越权。
- [ ] 运行 `pnpm.cmd --filter @myself/desktop test -- powershell-ast-policy.test.ts powershell-process-runner.test.ts`，提交 `feat: 增加受控 PowerShell 前台执行`。

## Task 6（C6）：受管理后台 PowerShell 任务

**Files:**

- Create: `apps/desktop/src/main/capabilities/powershell/powershell-task-manager.ts`
- Create: `apps/desktop/tests/powershell-task-manager.test.ts`
- Modify: `packages/shared-types/src/contracts.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/tests/agent-ipc.test.ts`
- Modify: `apps/desktop/tests/preload-api.test.ts`
- Modify: `apps/desktop/tests/preload-production-boundary.test.ts`

```ts
interface PowerShellTaskManager {
  start(plan: VerifiedShellPlan): Promise<{ taskId: string }>;
  status(taskId: string): ShellTaskStatus;
  readOutput(taskId: string, cursor: number): ShellOutputPage;
  stop(taskId: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] 写 RED：只有用户明确“后台运行”才能 start；taskId 不可伪造；输出分页有界；stop/close 幂等；退出不留进程；重启不把旧任务当活动任务。
- [ ] 最小 GREEN：内存任务表只保存状态、计数和有界脱敏输出；Renderer 不得到 PID、绝对 cwd 或原始环境。
- [ ] IPC 输入严格 `.strict()`，preload 精确白名单；提交 `feat: 管理后台 PowerShell 任务`。

## Task 7（C7）：统一协调器、Renderer 和纵向验收

**Files:**

- Create: `apps/desktop/src/main/conversation/capability-task-adapter.ts`
- Create: `apps/desktop/tests/capability-task-adapter.test.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Delete after migration: `apps/desktop/src/main/conversation/file-task-adapter.ts`

- [ ] 先写纵向 RED：截图中的“创建/删除 empty”必须出现真实文件确认；模型口头拒绝被修复；回收站结果来自本地；普通聊天零文件/PowerShell能力。
- [ ] 写 PowerShell RED：只读自动执行、写入确认、命令哈希失效、后台状态/停止、自主/文件正文不能触发。
- [ ] 新 Adapter 统一文件与 Shell reset/close/generation；迁移组合根后删除旧 Adapter，静态检索不得存在双入口。
- [ ] 运行定向 desktop、安全、集成和命名 Electron 场景；审查通过后执行阶段固定门。
- [ ] 写 `task-c7-report.md`，提交 `feat: 接通可信文件与 PowerShell 执行`。

## 阶段验收命令

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop -- --grep "可信文件与 PowerShell"
git diff --check
git diff --name-only -- apps/website
```

预期：全部退出 0，网站差异无输出，PowerShell/Electron/Node 残留扫描为空。
