# 桌宠统一结构化控制修复实施计划

> **供 Agent 执行：** 必须使用 `subagent-driven-development` 逐任务实施并复审。所有实现步骤使用复选框跟踪。

**目标：** 让 Provider 与内置本地模型可靠地把自然语言转成真实文件/PowerShell 工具调用和 0/1/2 运动状态，并用 Main 的可信执行结果而非模型口头声明作为事实。

**架构：** 先建立唯一控制计划契约，再让无固定语序的本地证据 Gate 与模型结构化建议汇入该契约。文件和 PowerShell 共享一个 Agent 工具循环；运动持久状态只由 `MovementControlPlan` 写入，Scheduler 的 mode 2 每 10–30 秒请求一次真实移动。

**技术栈：** TypeScript、Zod、Electron Main/Preload/Renderer、Vitest、Playwright、现有 Provider Adapter、AgentLoop、FileToolService 与 PowerShellTool。

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-27-ai-pet-structured-control-repair-design.md`。
- OpenCode 只参考固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214` 的工具循环、Schema、修复与确认模式；不嵌入其运行时。
- Renderer 不获得文件、进程、密钥或任意系统能力。
- 写入、移动、删除与 PowerShell 每次确认；删除默认进入回收站。
- PowerShell 固定授权根工作目录、前台非交互、无管理员提权、有限输出、可取消和超时。
- MCP 的运行时、Agent 与 Renderer继续禁用。
- 所有文档、用户文案和结构性注释使用中文。
- 严格执行 RED → GREEN → REFACTOR；每项任务独立提交并经过规格与质量复审。
- 不制作安装包；最终只同步 `D:\Python\Important\myself` 并运行生产构建。

---

### 任务 1：稳定统一控制计划契约与自然语言入口

**文件：**

- 新建：`packages/agent-core/src/capability-control-plan.ts`
- 修改：`packages/agent-core/src/index.ts`
- 修改：`packages/character-runtime/src/character-behavior-plan.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 修改：`apps/desktop/src/main/conversation/capability-intent-router.ts`
- 修改：`apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- 测试：`packages/agent-core/tests/capability-control-plan.test.ts`
- 测试：`packages/character-runtime/tests/character-behavior-plan.test.ts`
- 测试：`apps/desktop/tests/capability-intent-router.test.ts`
- 测试：`apps/desktop/tests/explicit-character-behavior-gate.test.ts`

**接口：**

- 产出 `CapabilityControlPlan = {kind:'chat'} | {kind:'agent_task', preferredTool: AgentPlanningTool | null}`。
- 产出 `MovementControlPlan = {kind:'keep'} | {kind:'set_mode',mode:0|1|2} | {kind:'move_once',target,distance}`。
- `CapabilityIntentRouter.route()` 保持 Main 的同步安全入口，但文件正向证据不再依赖礼貌词、地点和操作的固定排列。
- `parseExplicitCharacterBehavior()` 输出的准备结果增加规范化 `movementControl`，不再用 stop/resume 行为动画类型写持久状态。

- [ ] **步骤 1：添加控制 Schema 与截图原句 RED 测试**

断言严格联合拒绝额外字段，并新增以下真实语句：

```ts
expect(capabilityIntentRouter.route('帮我在当前目录下创建ab.txt文件').kind)
  .toBe('file_task');
expect(capabilityIntentRouter.route('请在当前目录下创建 ab.txt 文件').kind)
  .toBe('file_task');
expect(parseExplicitCharacterBehavior('时不时动一下')?.movementControl)
  .toEqual({ kind: 'set_mode', mode: 2 });
```

同时保留否定、引用、代码块和知识讨论负例。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts
```

预期：新类型或新断言缺失导致失败，既有安全负例继续通过。

- [ ] **步骤 3：实现最小契约与与语序无关的正向证据组合**

本地 Gate 只组合操作词、本地对象、执行请求和拒绝证据；不得使用无界 `.*`。明确映射 stop→0、continuous→1、intermittent/resume→2、一次移动→`move_once`。

- [ ] **步骤 4：运行 GREEN、typecheck 与差异检查**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

- [ ] **步骤 5：提交**

```powershell
git add packages/agent-core packages/character-runtime apps/desktop/src/main/conversation apps/desktop/tests
git commit -m "feat(control): 统一桌宠能力与运动控制契约"
```

### 任务 2：统一文件与 PowerShell Agent 工具循环

**依赖：** 任务 1 的 `CapabilityControlPlan` 与 `AgentPlanningTool`。

**文件：**

- 修改：`apps/desktop/src/main/agent/tool-registry.ts`
- 修改：`apps/desktop/src/main/agent/main-agent-session-factory.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 修改：`apps/desktop/src/main/conversation/capability-task-adapter.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 修改：`packages/agent-core/src/agent-loop.ts`
- 修改：`packages/agent-core/src/types.ts`
- 测试：`apps/desktop/tests/tool-registry.test.ts`
- 测试：`apps/desktop/tests/agent-service.test.ts`
- 测试：`apps/desktop/tests/conversation-chat-adapter.test.ts`
- 测试：`apps/desktop/tests/conversation-coordinator.test.ts`
- 测试：`packages/agent-core/tests/agent-loop.test.ts`
- 测试：`tests/integration/desktop-agent.test.ts`

**接口：**

- `createBuiltinAgentToolRegistry()` 公告文件工具与 `builtin.powershell.run`，并且只存在这一条正式本地 Agent 注册路径。
- `AgentSession` 使用统一 `taskKind:'agent'`，保留 `initialCapability:'file'|'powershell'` 供披露与首轮规划裁决。
- 首轮使用 `preferredTool` 与澄清工具；第一次可信结果后可使用完整 Session 工具表。
- `AgentLoop` 最大轮数改为命名常量，允许多步任务；连续三次同工具同参数返回 `AGENT_REPEATED_TOOL_CALL`。
- 聊天结构化响应解析 `CapabilityControlPlan`；只有本地拒绝证据未命中时，`agent_task` 建议才能重新进入能力准备阶段。该补充分流不得先公开模型的口头执行结论。

- [ ] **步骤 1：添加真实入口与多步任务 RED 测试**

覆盖本地正向证据和模型补充控制计划：

```text
帮我在当前目录下创建ab.txt文件
创建 source.txt，然后移动到 archive 文件夹
读取 package.json，随后执行 PowerShell npm test
把 source.txt 复制到 archive 文件夹
用自然语言要求整理当前目录，但不使用固定“创建/删除”语序
```

断言截图原句不创建聊天 Adapter；首轮工具被正确收窄；确认前无副作用；确认后真实落盘；第一次结果后可调用另一类工具；复制走完整 PowerShell 确认。
对最后一条模糊但明确执行的请求，聊天结构化计划返回 `agent_task` 后进入 Agent；否定、引用或知识讨论即使模型建议执行也必须被 Main 拒绝。

- [ ] **步骤 2：添加参数修复和重复调用 RED 测试**

模型第一次提交非法参数时收到稳定 tool-result 并只修复一次；同名同参连续三次终止，且不产生第四次本地执行。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/tool-registry.test.ts tests/agent-service.test.ts tests/conversation-chat-adapter.test.ts tests/conversation-coordinator.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
```

- [ ] **步骤 4：实现统一 Registry、Session 与循环修复**

复用现有 `FileToolService`、`PowerShellTool`、`PendingActionStore` 和确认 IPC；不得创建第二套执行器。错误回灌只包含稳定码和有界建议，不包含绝对路径、正文或命令输出。

- [ ] **步骤 5：运行 GREEN 与安全定向测试**

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/tool-registry.test.ts tests/agent-service.test.ts tests/conversation-chat-adapter.test.ts tests/conversation-coordinator.test.ts tests/powershell-tool.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
pnpm.cmd test:security
git diff --check
```

- [ ] **步骤 6：提交**

```powershell
git add packages/agent-core apps/desktop tests/integration tests/security
git commit -m "feat(agent): 统一文件与PowerShell工具循环"
```

### 任务 3：让三态控制驱动真实间歇运动

**依赖：** 任务 1 的 `MovementControlPlan`。

**文件：**

- 修改：`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-director.ts`
- 修改：`apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- 修改：`packages/character-runtime/src/character-behavior-plan.ts`
- 测试：`apps/desktop/tests/conversation-chat-adapter.test.ts`
- 测试：`apps/desktop/tests/character-behavior-director.test.ts`
- 测试：`apps/desktop/tests/character-proactivity-scheduler.test.ts`
- 测试：`tests/integration/desktop-agent.test.ts`

**接口：**

- 聊天响应结构携带 `movementControl`，只允许 `keep/set_mode/move_once`。
- `CharacterBehaviorDirector.applyMovementControl()` 是持久模式唯一入口。
- `CharacterProactivityScheduler` 在 mode 2 下调用 `requestIntermittentMovement()`，不得只提交 move 动画。
- 到达或运动结束后释放 move 播放所有权，恢复 idle，并重新抽取 10–30 秒间隔。

- [ ] **步骤 1：添加三态语义和真实运动 RED 测试**

参数化断言：

```text
停止不动 -> 0
一直运动 -> 1
时不时动一下/偶尔动一下/自己偶尔走动 -> 2
跑远一点 -> move_once(far)，不改变当前持久模式
```

Scheduler 使用假时钟覆盖 10、20、30 秒，只在到期时产生一次真实 Motion intent；结束后 `moving=false`、动作回到 idle、下一周期重新计时。`proactivityMode=passive` 不得吞掉用户明确设置的 mode 2。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-chat-adapter.test.ts tests/character-behavior-director.test.ts tests/character-proactivity-scheduler.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
```

- [ ] **步骤 3：实现单一 MovementControlPlan 路径并删除旧双写入口**

保留 `behaviorPlan` 的动画候选选择；删除其 stop/resume 持久状态职责和旧提示。间歇移动复用现有随机工作区目标与 MotionService，不创建第二个位置计时器。

- [ ] **步骤 4：运行 GREEN、行为门禁与 typecheck**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-chat-adapter.test.ts tests/character-behavior-director.test.ts tests/character-proactivity-scheduler.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
pnpm.cmd verify:behavior
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

- [ ] **步骤 5：提交**

```powershell
git add packages/character-runtime apps/desktop tests/integration
git commit -m "fix(behavior): 以单一三态控制驱动真实运动"
```

### 任务 4：Provider、本地模型与 Electron 纵向验收

**依赖：** 任务 2、3。

**文件：**

- 修改：`apps/desktop/tests/provider-contract.test.ts`
- 修改：`apps/desktop/tests/local-model-provider.test.ts`
- 修改：`apps/desktop/scripts/local-model-acceptance-runner.ts`
- 修改：`tests/e2e/desktop.spec.ts`
- 新建：`docs/operations/2026-08-27-ai-pet-structured-control-repair-acceptance.md`

- [ ] **步骤 1：添加 Provider 与本地模型同契约 RED 测试**

OpenAI-compatible、Anthropic、Gemini 与 LocalModelProvider 均验证控制 Schema；工具回合保持缓冲，普通正文继续流式；原句不能返回“无法操作文件”完成态。

- [ ] **步骤 2：添加 Electron E2E RED 测试**

使用截图原句完成真实临时目录创建，确认卡后检查 `ab.txt`；运行安全 PowerShell `Write-Output`；通过只读诊断观察 mode 0→2、间歇移动开始→结束→重新计时。

- [ ] **步骤 3：运行 RED 并完成最小适配**

只修改 Provider 序列化或生产组合中实际失败的边界，不重写已通过的 Adapter。

- [ ] **步骤 4：运行分层 GREEN**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/provider-contract.test.ts tests/local-model-provider.test.ts
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
node apps/desktop/scripts/run-local-model-acceptance.mjs --backend vulkan
```

- [ ] **步骤 5：记录实际结果并提交**

验收记录必须区分自动通过、真实本地模型通过、待用户人工确认和失败；不得把未执行门禁写成通过。

```powershell
git add apps/desktop tests docs/operations/2026-08-27-ai-pet-structured-control-repair-acceptance.md
git commit -m "test(desktop): 验收统一控制与本地Agent链"
```

### 任务 5：最终复审、完整门禁与实际目录同步

**文件：**

- 修改：`docs/operations/2026-08-27-ai-pet-structured-control-repair-acceptance.md`
- 修改：`docs/superpowers/plans/2026-08-27-ai-pet-structured-control-repair.md`

- [ ] **步骤 1：逐项复核规格与旧路径删除**

确认固定语序执行结构、复制提前失败、文件/PowerShell 互斥 Registry、stop/resume 双写入口和错误提示旧分支均已按规格删除。

- [ ] **步骤 2：运行完整门禁**

```powershell
pnpm.cmd typecheck
pnpm.cmd test:unit
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
pnpm.cmd verify:behavior
git diff --check
```

若默认并发门禁受资源争用失败，必须记录原命令结果，并使用同一测试集合单 worker 复核；不得把替代命令写成原命令通过。

- [ ] **步骤 3：双轴最终代码复审**

由独立子智能体分别检查规格符合性和仓库标准。Critical 或 Important 必须修复并重新定向复审；不接受仅凭实现者报告结案。

- [ ] **步骤 4：提交最终验收记录**

```powershell
git add docs/operations/2026-08-27-ai-pet-structured-control-repair-acceptance.md docs/superpowers/plans/2026-08-27-ai-pet-structured-control-repair.md
git commit -m "docs: 记录统一控制修复最终验收"
```

- [ ] **步骤 5：快进同步实际目录并构建**

确认 `D:\Python\Important\myself` 干净且其 HEAD 是当前分支祖先，再执行 fast-forward-only。同步后运行：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd --filter @myself/desktop build
```

最终确认隔离 worktree 与实际目录位于同一提交且均无未提交改动。
