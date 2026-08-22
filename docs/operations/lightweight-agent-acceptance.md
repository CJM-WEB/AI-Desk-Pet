# 轻量本地能力验收

## 自动证据

- `pnpm.cmd test:security`：验证普通聊天不读取授权根、不创建文件或 PowerShell 能力；公开事件、诊断和 Provider 摘要不包含绝对路径、正文、命令输出或密钥。
- `pnpm.cmd test:integration`：使用临时授权根验证 `list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file` 的真实结果、确认、冲突、取消与回收站失败。
- PowerShell 集成用例只运行 `Write-Output`、标准错误写入和 `exit 0`，确认卡后校验真实 stdout、stderr 与退出码。
- `pnpm.cmd test:e2e:desktop`：验证 Electron 中的设置、普通聊天、文件确认、回收站和进程清理；夹具仅保留去标识化的泄露布尔证据。

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
- 未通过“正式 preload 不出现 MCP API”这一项：正式 preload 仍存在既有 MCP 方法。本兼容子项目没有新增或启用 MCP，且运行时能力与正式 UI 入口保持关闭；删除既有 preload/MyselfApi/IPC/Renderer 共享契约须由紧随其后的独立 SDD 安全子项目处理。
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
- `git diff --check`：退出 0。

### 未覆盖项

- 本轮没有再次调用真实 DeepSeek API，也没有代替用户执行 Windows 窗口与真实回收站人工观察；这些项目继续标记为“待用户人工确认”。
- 本轮不处理 MCP、角色行为、缩放、拖拽或工作台一致性；既有 MCP preload 契约问题仍按上节记录进入独立安全子项目。
