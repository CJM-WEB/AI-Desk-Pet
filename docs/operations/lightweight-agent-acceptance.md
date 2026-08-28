# 轻量本地能力验收

## 现行验收补充

- 当前意图编排、可见正文与隐藏控制解耦、真实工具调用、层级状态动作生命周期及三态运动的自动化证据，见 [`2026-08-27-ai-pet-intent-and-behavior-orchestration-acceptance.md`](./2026-08-27-ai-pet-intent-and-behavior-orchestration-acceptance.md)。
- 该记录只在上述范围内替代 [`2026-08-27-ai-pet-structured-control-repair-acceptance.md`](./2026-08-27-ai-pet-structured-control-repair-acceptance.md) 的现行结论。旧记录仍是当时版本及 CPU/GGUF 复验的历史证据，不代表当前提交上的真实 DeepSeek 网络、真实窗口观感或回收站恢复已经人工通过。

## 2026-08-28 文件事务纠偏最终收口验收

### 范围与结论

- 本节记录 `2026-08-28-ai-pet-file-transaction-correction` Task 4 的最终收口，只覆盖旧测试夹具字段清理、门禁复跑与验收事实同步。
- `apps/desktop/tests/main-agent-session-factory.test.ts` 与 `apps/desktop/tests/agent-service.test.ts` 已删除只服务旧文件披露 gate 的 `fileDisclosureAllowed` 夹具字段与分支；`apps/desktop/tests/capability-transaction.test.ts` 本轮未发现 `providerId`、`authorizationRootId` 或 `fileDisclosureAllowed` 旧字段，无需改动。
- `apps/desktop/tests/agent-service.test.ts` 仍保留 1 处 `ProviderProfileV2.providerId`。这是现行共享契约 `providerProfileV2Schema` 的必填字段，用于构造内置本地模型 profile，不属于旧测试夹具字段，故未删除。
- 本节在“旧文件披露值为 false”相关描述范围内，覆盖上文 `2026-08-28 文件事务稳定性纵向自动验收` 的同类旧夹具表述；其余真实文件事务、安全边界和人工待验范围保持不变。

### 实际运行结果

- 环境：Windows，隔离 worktree `C:\Users\Administrator\.codex\worktrees\e43f\myself`；Task 4 起始基线提交 `6301a6b`；执行日期 `2026-08-28`。
- 定向复核：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/main-agent-session-factory.test.ts tests/agent-service.test.ts tests/capability-transaction.test.ts` 退出码 `0`，3 个测试文件、133 项通过。
- `pnpm.cmd --filter @myself/agent-core test`：退出码 `0`，4 个测试文件、100 项通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/desktop test`：退出码 `0`，107 个测试文件、2830 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `pnpm.cmd test:security`：退出码 `0`，1 个测试文件、28 项通过。
- `pnpm.cmd test:integration`：退出码 `0`，4 个测试文件、92 项通过。
- `pnpm.cmd verify:desktop`：退出码 `0`。workspace typecheck 覆盖 10/11 个存在脚本的项目；单元测试 136 个测试文件、3546 项通过；安全测试 28/28，通过集成测试 92/92；生产构建、preload 外部依赖校验与正式边界校验通过；Electron E2E 为 77 通过、1 条既有长时场景跳过、0 失败。
- 本轮 `desktop test`、`verify:desktop` 与相关角色/工作台测试输出中继续出现 `CHARACTER_IMPORT_RECOVERY_*`、角色运行失败码、`HTMLCanvasElement.getContext()` 未实现等既有受控 stderr；对应 suite 最终均为退出码 `0`，本节不把这些已断言的受控诊断误记为失败。
- `git diff --check`：见本节提交前最终差异检查，退出码 `0`；仅有 Windows 工作区 LF/CRLF 提示，没有 whitespace error。

### 未覆盖项

- 待用户人工确认：真实外部 Provider 网络与账号、真实本地 GGUF/CPU 或 Vulkan 模型重跑、真实 Windows 窗口交互与观感、真实回收站可恢复性，以及用户目录中的手工文件操作。
- 本轮没有新增或替换任何生产契约来迁就测试；也没有处理 progress ledger 中 Task 3 已登记的两个 deferred Minor。

## 2026-08-28 文件事务稳定性纵向自动验收

### 替代范围与环境

- 本节替代旧“文件数据授权关闭时，显式文件任务只公告结构化澄清工具”的描述。显式文件任务的受控工具面不再由文件披露开关阻断；授权根、相对路径、逐次确认、真实执行和公开脱敏边界保持不变。
- 环境：Windows 隔离 worktree `C:\Users\Administrator\.codex\worktrees\e43f\myself`，起始提交 `c9615798d0ac8a12f3bb8c5a4838f8748c91ad2e`。文件副作用仅写入测试以 `mkdtemp` 创建的临时授权根，清理后不保留用户目录文件。
- 两个 Provider fixture 分别覆盖 OpenAI-compatible 外部工具别名与内置本地模型环回协议；HTTP 服务、模型响应和回收站端口均为隔离夹具，`AgentLoop`、`AgentService`、`FileToolService`、路径策略与确认执行链均为正式实现。

### 实际运行结果

- `pnpm.cmd test:integration`：退出码 `0`，4 个测试文件、89 项通过。参数化事务在两种 Provider 下均依次完成：创建 `test.txt` 后确认、读取、编辑为字面 `hello` 后确认、移动到 `a/test.txt` 后确认；确认前后均直接断言临时磁盘副作用，最终源文件不存在且目标内容为 `hello`。
- 新增正式会话链事务复用 `MainConversationComposition`、`ConversationCoordinator`、`CapabilityTaskAdapter`、`AgentService` 与临时授权根。用户依次说“创建 test.txt”“把刚创建的文件内容改为 hello”“把刚才那个文件移动到 a 文件夹”，后两轮未直接传入路径或 `planningHint`；同一 Agent target/session 只创建一次，后续 Provider 请求只接收来自真实工具结果的私有 `create_file`、`edit_file` 引用，最终 `a/test.txt` 为 `hello` 且源不存在。
- `pnpm.cmd test:security`：退出码 `0`，1 个测试文件、28 项通过。普通聊天保持无工具请求且不触达文件或 PowerShell 能力；`..`、绝对路径、UNC 与授权根前缀碰撞继续被拒绝。
- `pnpm.cmd exec vitest run --config vitest.config.ts tests/capability-transaction.test.ts tests/capability-intent-router.test.ts tests/conversation-chat-adapter.test.ts tests/conversation-coordinator.test.ts tests/provider-contract.test.ts`（目录 `apps/desktop`）：退出码 `0`，5 个测试文件、599 项通过。普通聊天不会借用文件任务或旧澄清提权；已确认文件结果只作为下一轮私有规划上下文；诊断 sink 自身抛错时仍保留 Provider 原错误与聊天正文回退。
- 本任务最初的双 Provider 直接文件纵向测试首次为绿，说明它是对 Tasks 1–4 已完成接线的验收，不作为本任务的 RED 证据；本轮没有为了制造失败而修改生产实现、权限策略或测试夹具协议。
- 两条 Provider 会话 E2E 均先以 `assertComplete` 的“脚本化 Provider 收到 1 个额外请求”稳定 RED；根因是该场景的非故障聊天步骤返回裸文本，未遵守同文件完整控制对象契约。替换为既有 `characterChatResponse()` 后，两条精确用例均 GREEN，未放宽 Provider server 的 `assertComplete`。
- 文件工具 `glob_files` 预算用例与角色 V2 导出用例的隔离、所属 package suite 均通过。V2 导出在首次根级并行实际耗时 15.042 秒，超过原 15 秒局部预算；隔离约 1.4 秒、Desktop suite 约 2.7 秒，最终全量门禁为 7.836 秒。因此只将两条用例的局部预算分别设为 45 秒和 20 秒，未调整全局预算、产品逻辑、授权或 Provider 协议。
- `pnpm.cmd --filter @myself/desktop test`：退出码 `0`，107 个测试文件、2809 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- 最终 `pnpm.cmd verify:desktop`：退出码 `0`。全仓类型检查、单元测试 3525/3525、安全测试 28/28、集成测试 89/89、生产构建和 preload 外部依赖校验均通过；Electron E2E 为 77 通过、1 条既有长时场景跳过、0 失败。
- `git diff --check`：退出码 `0`；只有 Windows 工作区的 LF/CRLF 提示，没有 whitespace error。

### 未覆盖项

- 待用户人工确认：真实外部 Provider 网络与账号、真实 Windows 回收站可恢复性、开发模式窗口交互以及用户目录下的人工文件操作。本节的临时根自动测试不替代这些观察。

## 自动证据

- `pnpm.cmd test:security`：验证普通聊天不读取授权根、不创建文件或 PowerShell 能力；公开事件、诊断和 Provider 摘要不包含绝对路径、正文、命令输出或密钥。
- `pnpm.cmd test:integration`：使用临时授权根验证 `list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file` 的真实结果、确认、冲突、取消与回收站失败。
- PowerShell 集成用例只运行 `Write-Output`、标准错误写入和 `exit 0`，确认卡后校验真实 stdout、stderr 与退出码。
- `pnpm.cmd test:e2e:desktop`：验证 Electron 中的设置、普通聊天、文件确认、回收站和进程清理；夹具仅保留去标识化的泄露布尔证据。
- 内置本地模型的 CPU/Vulkan 真实验收结果见 [`2026-08-25-built-in-local-model-acceptance.md`](./2026-08-25-built-in-local-model-acceptance.md)。

## 人工验收步骤

1. 设置授权工作目录，要求创建带正文的文件；在确认卡核对相对路径、字符数和受限预览，确认后检查文件存在。
2. 要求修改该文件；确认卡应展示补丁摘要。确认后检查内容已变更；先在外部修改文件再确认时应得到冲突错误且不覆盖外部修改。
3. 删除空目录或文件并确认；从 Windows 回收站恢复，确认原条目可恢复。删除非空目录应被拒绝。
4. 输入“执行 PowerShell Get-Location”；确认卡应展示完整命令、授权工作目录标签、前台非交互和非安全沙箱提示。确认后检查输出；选择取消时不启动命令。
5. 在确认卡出现后变更授权目录或设置，再确认旧卡；应提示动作失效且不执行。
6. 发送普通聊天，或在文件正文中放入“执行 PowerShell”字样；不应出现能力确认卡，也不应要求授权目录。

## 预期结果与失败恢复

- 每个写入与 PowerShell 命令都须逐次确认；取消、超时、重置和配置变更均使旧动作失效。
- 工具失败必须以失败状态结束，不能发布成功；Provider 总结失败不改变本地真实结果。
- 如果确认动作失效，重新发起当前请求并审核新的确认卡；如果 PowerShell 返回非零退出码，查看受限结果后修正命令并重新确认。
- 若出现疑似隐私泄露或进程残留，停止验收，保留去标识化日志证据，并运行安全/E2E 门禁复核。

## 2026-08-22 DeepSeek 文件工具兼容自动验收

### 环境与范围

- 环境：Windows，隔离 worktree `C:\Users\Administrator\.codex\worktrees\e43f\myself`，起始提交 `d7d126f98722c9564ec4d3317aceaf964a4414dd`。
- 本轮使用真实 OpenAI-compatible `message.tool_calls` 响应结构和 DeepSeek 外部工具别名，远端 API 由进程内 HTTP/fetch fixture 隔离，回收站由隔离端口替代。
- 生产组合无需修改；RED 证明需要更新的是仍返回内部点号工具名的集成、安全和 E2E Provider fixture。

### RED 与 GREEN 证据

- RED：`pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts` 退出 1，38 条中 14 通过、24 失败；失败均为旧 fixture 返回内部点号名后触发 `PROVIDER_UNKNOWN_TOOL_CALL`。同轮新增的 4 条 DeepSeek 纵向用例已通过。
- RED：`pnpm.cmd test:security` 首轮退出 1，20 条中 15 通过、5 失败；5 条失败与上述旧 fixture 同源。
- RED：第一次 `pnpm.cmd verify:desktop` 退出 1；typecheck、2270 条单元测试（14 条跳过）、20 条安全测试、50 条集成测试和生产构建通过，Electron E2E 为 57 通过、5 失败。5 条失败均因 E2E `toolResponse` 仍返回内部点号名；诊断还确认 PowerShell 首轮会同时公开运行工具和结构化澄清工具。
- GREEN：`pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts` 退出 0，38/38 通过。
- GREEN：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/conversation-coordinator.test.ts` 退出 0，56/56 通过。
- GREEN：5 条曾失败的 Electron 用例定向重跑退出 0，5/5 通过。

### 阶段门禁

- `pnpm.cmd --filter @myself/agent-core test`：退出 0，51/51 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出 0。
- `pnpm.cmd --filter @myself/desktop test`：退出 0，1823 条通过、14 条跳过。
- `pnpm.cmd test:security`：退出 0，20/20 通过。
- `pnpm.cmd test:integration`：退出 0，50/50 通过。
- 最终 `pnpm.cmd verify:desktop`：退出 0；全仓 typecheck 通过，单元测试 2270 条通过、14 条跳过，安全测试 20/20，通过集成测试 50/50，生产构建与 preload 外部依赖校验通过，Electron E2E 62/62 通过。
- Electron E2E 的 720×620 与 640×520 设置页用例均观察到 MCP 入口不可见；单元测试确认 `desktopRuntimeCapabilities.mcp` 为 `false`。

### 已自动验证的纵向行为

- 删除空目录：第一个确认相关公开事件为 `pending_action`；确认前目录存在，确认后隔离回收站端口只调用一次；真实工具结果续传后只生成文字总结，第二轮为 `tools=[]`、`tool_choice:'none'`。
- 创建文件：确认前不落盘，确认后正文真实落盘；再次创建同名目标返回 `TARGET_EXISTS`，原正文不被覆盖。
- 缺少目标：DeepSeek 结构化澄清工具只公开一条问题，不产生确认卡或文件副作用。
- 普通聊天：“你好呀”请求为 `tools=[]`、`toolChoice:'none'`；未选择授权根时不创建 Agent，文件数据授权关闭时 Provider 只收到结构化澄清工具，不收到文件工具。

### 未验证与后续安全项

- 待用户人工确认：真实 DeepSeek API 网络调用、真实 DeepSeek 账号/模型响应、真实 Windows 回收站可恢复性，以及 `pnpm.cmd --filter @myself/desktop dev` 下的窗口人工操作。本轮自动测试不得替代这些观察。
- 当时“正式 preload 仍存在 MCP API”的结论已由本文后续“桌面端 MCP 正式运行链清理自动验收”替代；该独立安全子项目现已提供正式 preload 逐键缺失与生产产物边界证据。
- 计划文件列表偏差：为恢复既有安全和 E2E 门禁，额外最小修改 `tests/security/permission-boundary.test.ts` 与 `tests/e2e/desktop.spec.ts` 的 Provider fixture/协议边界断言；未修改生产代码或权限策略。

## 2026-08-22 结构化澄清枚举协议第二轮验收

### 替代范围

- 第一轮 `{ question: string }` 与确认/缺参关键词判定已由 `missingField` 六值枚举替代；Provider 不再决定公开文案。
- `AgentLoop` 在进入 `ToolRuntime` 前解析严格对象，并根据宿主固定中文映射公开一条提示；旧 `{ question }`、未知枚举和额外字段均拒绝。
- DeepSeek 与真实 OpenAI-compatible 修复轮夹具只返回 `missingField`；只服务旧模型确认自由文本协议的集成用例已删除。

### RED 与 GREEN 证据

- RED：`pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts` 退出 1，46 条中 35 通过、11 失败。失败明确覆盖 5 条旧 `{ question }` 拒绝断言（解析器 3 条、AgentLoop 2 条）和 6 个合法枚举宿主文案映射。
- GREEN：同一定向命令最终退出 0，47/47 通过；新增严格 Schema 边界断言确认 `additionalProperties:false`、唯一必填字段 `missingField` 与六值 enum。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-service.test.ts tests/provider-contract.test.ts`：退出 0，139/139 通过。
- `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts`：退出 0，38/38 通过。

### 阶段门禁

- `pnpm.cmd --filter @myself/agent-core test`：退出 0，60/60 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出 0。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出 0。
- `pnpm.cmd --filter @myself/desktop test`：退出 0，1823 条通过、14 条跳过。
- `pnpm.cmd test:security`：退出 0，20/20 通过。
- `pnpm.cmd test:integration`：退出 0，50/50 通过。
- `pnpm.cmd verify:desktop`：在实现提交 `a25cc10` 上仅运行一次并退出 0；workspace typecheck 覆盖 10/11 个存在脚本的项目，单元测试 2279 条通过、14 条跳过，安全测试 20/20、集成测试 50/50，生产构建与 preload 外部依赖校验通过，Electron E2E 62/62 通过。
- `git diff --check 03b3efc..a25cc10`：退出 0，未产生诊断输出；该范围覆盖桌宠开发解锁基线之后至本轮实现提交的全部差异。

### 未覆盖项

- 本轮没有再次调用真实 DeepSeek API，也没有代替用户执行 Windows 窗口与真实回收站人工观察；这些项目继续标记为“待用户人工确认”。
- 本轮不处理 MCP、角色行为、缩放、拖拽或工作台一致性；其中 MCP preload 契约的后续处理状态以本文下一节独立安全子项目验收为准。

## 2026-08-22 桌面端 MCP 正式运行链清理自动验收

### 环境、基线与范围

- 环境：Windows 隔离 worktree；Task 5 起始提交为 `0a15009a1fa2dba42a255ba37162d5bb0df6acc0`。
- Task 5 首轮实现提交：`0c8529287d22b67d031b8c1134db16b0eb907aa9`（`test(desktop): 验收 MCP 正式链清理`）。
- 本轮只补充持久化、Electron 产品边界和最终验收证据；未修改 SettingsStore、拖拽、角色行为、桌宠缩放、碰撞体积、文件能力、Provider 协议或角色工作台生产代码。
- 保留 `apps/desktop/src/main/mcp`、内部 MCP 单元测试、测试 Server、SettingsStore 的 MCP schema/data 和本机已有 MCP 数据；正式 API、Preload、IPC、Renderer、Main、Agent、生产依赖与 bundle 入口继续保持删除状态。

### Task 1—4 可追溯 RED 证据（历史补记）

以下记录仅补入各任务报告已经记载的命令、退出码与失败原因，不以当前工作区重跑替代历史 TDD 证据。

- Task 1（来源：`.superpowers/sdd/2026-08-22-desktop-mcp-production-chain-removal/task-1-report.md`）：`pnpm.cmd --filter @myself/desktop typecheck` 退出码 `2`，新增类型契约因 `SettingsTab` 仍含 `tools`、`SettingsWorkspaceProps` 仍含 `mcpActions` 失败；`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/renderer-mcp-production-boundary.test.ts` 退出码 `1`，`SettingsView.tsx` 仍命中 `McpSettings`、`mcpActions`、`McpLaunch` 与 `desktopRuntimeCapabilities`。
- Task 2（来源：`.superpowers/sdd/2026-08-22-desktop-mcp-production-chain-removal/task-2-report.md`）：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/preload-production-boundary.test.ts tests/advanced-settings-ipc.test.ts` 退出码 `1`，12 项中 2 项失败；旧 `upsertMcpServer` 等公开键仍存在，且 `settings:mcp-upsert` 等 handler 仍注册。
- Task 3（来源：`.superpowers/sdd/2026-08-22-desktop-mcp-production-chain-removal/task-3-report.md`）：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/desktop-settings-service.test.ts tests/main-conversation-composition.test.ts tests/main-lifecycle.test.ts` 退出码 `1`，3 个目标文件各有 1 条失败、共 3 条失败；设置服务 fixture 仍含 `mcpStore` / `mcpManager`，会话快照仍含 `enabledReadTools`，Main 仍构造 `McpServerStore` / `McpManager`。
- Task 4（来源：`.superpowers/sdd/2026-08-22-desktop-mcp-production-chain-removal/task-4-report.md`）：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts` 退出码 `1`，8 项中 4 项失败，分别证明 SDK 仍在 `dependencies`、未在 `devDependencies`、构建未串联 verifier、Main 未显式 externalize SDK。有效 verifier RED 为 `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/production-mcp-boundary.test.ts`，退出码 `1`：clean fixture 通过，17 个单标记 dirty fixture 因可执行 no-op verifier 错误返回 `0` 而失败。此前由 Windows `URL.pathname` 引起的 `MODULE_NOT_FOUND` 已在任务报告中明确标为无效 RED，不作为实施证据。

### 特征化测试与测试夹具修正

- 持久化生产实现没有出现有效 RED。首次定向测试为 49/50，通过项已证明普通 mutator 保留 MCP 数据；唯一失败来自测试读取源文件时把 `apps/desktop` 重复拼接，改用 `import.meta.url` 定位后通过。该失败不是产品缺陷，因此没有为制造 RED 修改生产代码。
- 生命周期 E2E 首次沿用强制重启时，第二进程的 `safeStorage.decryptStringAsync` 报出密文解密失败并被归一化为 `PROVIDER_NETWORK_ERROR`；改用同步解密同样失败且实验已回退。根因是旧夹具未保证 safeStorage 后端正常关闭，不是 MCP 产品链 RED。测试改为每次重启前调用正式 `window.myself.quit()` 并等待桌宠窗口关闭，Provider 密钥随后可正常恢复。
- 正式退出修正后，首次完整 `settings.json` Buffer 比较只观察到正常生命周期写入 `petPosition`。夹具随后在第一进程退出后，用保留的 SettingsStore 写入退出前捕获的精确坐标，再预置 MCP 数据并建立原始 Buffer 基线；基线建立后第二进程只执行普通聊天和只读 `list_files`，不调用设置 mutator。第二次重启时完整 `settings.json` 与 MCP Secret 原始 Buffer 均逐字节相等，未 parse 或重序列化。

### 定向证据

- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-store.test.ts tests/multi-provider-settings-store.test.ts tests/settings-ipc.test.ts tests/provider-secret-vault.test.ts`：首轮退出 0，4 个文件、50/50 通过；复审修正后退出 0，4 个文件、52/52 通过。
- 普通 SettingsStore 原子写入口采用表驱动矩阵覆盖 9 个方法；TypeScript AST 完整性守卫精确区分 9 个非 MCP mutator、2 个 MCP 专用 mutator，以及 `load` 迁移和 `clearAll` 全量重置语义。两条 MCP 配置在每次写后逻辑深度相等；删除场景保留主 Provider 与有效路由，只删除备用 Provider。单 Provider 密钥清除前后直接比较 `mcp:remote-tools` 槽文件 Buffer；全量清除前确认 Provider 与 MCP 两槽存在，清除后两槽均为 `ENOENT`，同时确认会话密钥也被清除。IPC 同时覆盖省略档案标识回退 `default` 与显式 `provider-main` 精确清除。
- `pnpm.cmd --filter @myself/desktop build`：退出 0；生产构建、preload 外部依赖校验和 MCP 生产边界校验通过。
- `node node_modules/@playwright/test/cli.js test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts tests/e2e/desktop-settings-layout.spec.ts --grep "MCP|设置页|通过正式白名单完成设置、文件操作与聊天窗口状态" --list`：退出 0，精确列出两个设置页尺寸、正式白名单业务闭环和 MCP 生命周期共 4 条；去掉 `--list` 后实际执行退出 0，4/4 通过。原计划的 `pnpm.cmd exec playwright` 形式会让 Windows `.cmd` 二次解释 grep 管道符，因此计划已同步为这个可原样复现的仓库 CLI 命令。
- 正式 preload 的 `Object.keys(window.myself)` 对 8 个旧 MCP key 逐键不存在且交集为空；720×620 与 640×520 设置页导航均精确为“模型、隐私、本地数据”，不存在“工具”按钮和“MCP 服务”文案；普通聊天工具表为空，只读文件任务工具表不含 `mcp__` 前缀且真实返回 `list_files` 结果。
- `pnpm.cmd test:security`：退出 0，20/20 通过。`pnpm.cmd test:integration`：退出 0，50/50 通过。
- 对 `apps/desktop/out/main`、`out/preload`、`out/renderer` 执行规格中的精确禁止标记扫描：退出 1 且无输出，表示没有命中；对 SettingsStore 与其测试执行保留项扫描：退出 0，仍可定位 MCP schema 和 get/save/delete 持久化入口。

### 完整门禁状态

- 第一次 `pnpm.cmd verify:desktop`：退出 1。workspace typecheck 通过；单元测试 2315/2317 通过，两个与本轮无关的角色测试分别在 5000ms 超时：默认角色“已有可用默认角色时不重写其运行版本”和角色包“V2 导出直接读取正式草稿与发布清单”，前者清理阶段另报 `ENOTEMPTY`。脚本因此在单元测试阶段停止，本次调用没有继续执行安全、集成、构建和完整 Electron E2E；这些后续边界已按上一节单独验证。
- 第二次、提交前最终 `pnpm.cmd verify:desktop`：退出 0。workspace typecheck 覆盖 10/11 个存在脚本的项目；单元测试 112 个文件、2317/2317 通过；安全测试 20/20、集成测试 50/50；生产构建、preload 外部依赖校验和 MCP 生产边界校验通过；Electron E2E 63/63 通过。重跑没有放宽测试超时，也没有修改角色代码；第一次失败仍保留在上一条作为真实历史。
- 复审修正轮最终 `pnpm.cmd verify:desktop`：退出 0。workspace typecheck 覆盖 10/11 个存在脚本的项目；单元测试 112 个文件、2319/2319 通过；安全测试 20/20、集成测试 50/50；生产构建、preload 外部依赖校验和 MCP 生产边界校验通过；Electron E2E 63/63 通过。本轮仍未修改角色或其他生产代码，也未放宽超时。

### 人工待确认与安装包边界

- 待用户人工确认：`pnpm.cmd --filter @myself/desktop dev` 下的真实 Windows 设置页与聊天交互，以及正式退出后不存在 MCP 子进程。自动测试没有声称动态证明“零 HTTP/零子进程”。
- 本轮没有构建安装包；干净环境安装、运行、退出和卸载后的生产依赖与进程观察均为“待正式打包阶段确认”，不得视为已通过。
- 真实 DeepSeek API、真实 Windows 回收站和其他既有人工项仍按前文保持“待用户人工确认”。

## 2026-08-25 OpenCode 模式文件闭环与三项核心交互修复验收

> 本节记录较早实现快照，不能证明随后“Main 直接确认执行、固定尺寸、四字段行为计划、Zen 匿名模型”改动后的最终状态。现行结果统一记录在 `docs/operations/2026-08-25-ai-pet-core-repair-acceptance.md`；下列计数不得复用为新代码证据。

### 文件能力实现边界

- 本轮参考 OpenCode 固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214` 的结构化工具模式：模型只返回 Schema 约束的相对路径与工具参数，Electron Main 负责授权根、路径裁决、逐次确认、真实执行和结果回传；没有引入 OpenCode 的 shell、权限框架或绝对路径模型。
- 删除了自然语言路径提取与目标许可的旧实现。文件隐私分类关闭时，明确写请求只获得 Router 当前 operation 精确对应的一项受控写工具与结构化澄清；只读请求只有澄清工具，PowerShell 与 MCP 不会因此获得权限。
- 自动纵向测试从用户输入开始，经 Router、Coordinator、真实 OpenAI-compatible HTTP `message.tool_calls` 解码、AgentService、FileToolService、确认，再检查隔离临时目录中的真实文件副作用；没有向内部直接注入工具响应来冒充 Provider。
- 正式白名单 Electron 闭环验证 `list_files + request_clarification` 的文件规划面，以及只含 `powershell.run` 的 PowerShell 面；MCP 正式入口继续保持禁用。

### 最终自动门禁

- `pnpm.cmd typecheck`、`pnpm.cmd test:security`、`pnpm.cmd test:integration`：均退出 0；安全 23/23、集成 71/71。
- `pnpm.cmd verify:desktop`：最终代码退出 0；单元 2846/2846、安全 23/23、集成 71/71、正式构建通过，Electron E2E 73 通过、1 条既有长时场景按配置跳过、0 失败。
- `pnpm.cmd verify:behavior`：最终代码退出 0；character-runtime 302/302、agent-core 72/72、Desktop 2286/2286、安全 23/23、集成 71/71，Electron E2E 73 通过、1 跳过、0 失败。
- `pnpm.cmd verify:characters`：本轮完整回归曾退出 0；其后最终改动只涉及 Desktop Director 的同轮运动授权复用，最终状态由上述 `verify:desktop` 与 `verify:behavior` 再次覆盖，不把较早命令冒充为最终代码重跑。
- 全局 `git diff --check` 退出 0；只有 Windows LF/CRLF 提示，没有 whitespace error。

### 历史失败与未验证项

- 门禁过程中真实发现并修正了普通聊天测试遗漏 `motionPlan:null`、文件/PowerShell E2E 白名单旧预期，以及动态 Alpha 帧造成的滚轮测试过度断言。最终返修另以 RED 证明 `behaviorPlan:none`、只读工具过宽和同轮运动计划自竞争，并完成最小修复。两项 5000ms 单元超时、一次工作室提示超时和一次四边运动超时均先保留失败事实，隔离复现通过后再重跑对应完整门禁；未放宽业务断言。
- 自动化使用本机 HTTP 兼容 Provider fixture，不代表真实 DeepSeek v4-flash 网络、账号与模型输出已通过。真实 Windows 回收站 UI/可恢复性、开发模式肉眼交互、干净安装卸载仍待用户人工确认；本轮没有制作安装包。

## 2026-08-26 内置本地模型生产链验收补充

- 真实验收 runner 复用生产 `LocalModelRuntime`、`LocalModelService`、Provider 路由、Main 会话组合、`AgentLoop` 与 `FileToolService`，不再维护第二套进程启动、health、Token、参数或清理实现。
- 本轮自动化确认 `required` 工具规划固定 `temperature: 0`；普通聊天和 `auto` 工具选择保持既有请求体，不新增 Renderer 可控采样参数，也未引入 seed。
- 真实矩阵契约包括创建、移动、删除、中文相对路径、缺目标澄清、用户拒绝、受控工具失败后恢复、Provider 取消后恢复、本地启用期间零云调用与关闭后云路由恢复。整体 deadline 超时后先取消活动会话并等待正式 Runtime 清理。
- Desktop 定向测试 120/120、AgentLoop 50/50、FileToolService 46/46、重复目标集成用例 1/1 及 Desktop typecheck 均退出 `0`。真实 GGUF 生产链 CPU/Vulkan 尚未在这轮代码上重跑，结果仍以 `2026-08-25-built-in-local-model-acceptance.md` 为准，不把 fixture 证据写成真实模型通过。
