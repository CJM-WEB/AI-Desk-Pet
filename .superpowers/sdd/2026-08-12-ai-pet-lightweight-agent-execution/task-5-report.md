# Task 5 执行报告

## 完成范围

- 将 `FileTaskAdapter` 与对应测试重命名为 `CapabilityTaskAdapter`，不保留旧类名、旧端口名或旧文件路径。
- 会话协调器统一使用 `CapabilityTaskKind` 与能力任务状态；文件和 PowerShell 共用准备、历史披露、确认、取消、重置与关闭路径。
- 明确 PowerShell 请求只提交 `taskKind: 'powershell'`，不会退回普通聊天或文件任务；后台请求稳定返回 `POWERSHELL_BACKGROUND_UNSUPPORTED`，不会静默改为前台执行。
- 组合根快照携带 `taskKind` 与 generation；普通聊天不读取授权根、也不构造能力工具。文件任务构造原有五文件工具；PowerShell 任务只构造一个 `PowerShellTool` 与 PowerShell registry。
- Main 保持唯一 `AgentService`、`PendingActionStore` 与 `AgentLoop` 组合；会话关闭继续经既有路径关闭活动 PowerShell 工具。IPC、preload 与共享 channel 未修改。
- PowerShell 确认卡沿用 Task 4 已实现的完整命令、工作目录摘要、前台非交互与非安全沙箱提示；确认/取消仍只传递 actionId。

## TDD 记录

- RED：将协调器测试改为要求 PowerShell 请求提交 `taskKind: 'powershell'`，旧实现仍抛出 `POWERSHELL_TASK_NOT_READY`。
- GREEN：泛化协调器和适配器端口、状态及任务快照后，`capability-task-adapter` 与 `conversation-coordinator` 66/66 通过。
- RED：新增后台 PowerShell 请求测试，旧实现错误地进入前台 PowerShell 路径。
- GREEN：路由证据标记请求模式，协调器稳定拒绝后台请求；全量 Task 5 定向回归通过。

## 修复轮次 1

- RED：PowerShell 确认卡仅包含“前台非交互执行”和“不是安全沙箱”两个片段，缺少完整风险声明。
- GREEN：确认卡逐字展示“以当前 Windows 用户权限在前台非交互执行；这不是安全沙箱”。
- RED：Main 能力会话工厂测试导入不存在的模块，证明原有 `index.ts` 内联分支不可独立验证。
- GREEN：新增可注入 `main-agent-session-factory`；PowerShell 会话只注册 `builtin.powershell.run` 并只构造 `PowerShellTool`，文件会话只注册五个文件工具且不构造 PowerShell。`index.ts` 仅注入平台依赖并调用该工厂。

## 验证

- Desktop 定向 Vitest：9 个测试文件、285 个测试通过。
- `@myself/file-tools`、`@myself/agent-core`、`@myself/shared-types`、`@myself/desktop` typecheck 均通过。
- `git diff --check` 通过；`apps/website` 无差异。
- 静态反查未命中 `FileTaskAdapter`、`ConversationFileTaskPort`、`POWERSHELL_TASK_NOT_READY` 及已废弃文件工具名称。

## 注意事项

- Task 5 主控账本由主控维护，本任务未改动其既有未提交内容。
- 依据仓库约束未执行 Git 暂存或提交；请主控在复核后精确提交 Task 5 范围内的文件。
