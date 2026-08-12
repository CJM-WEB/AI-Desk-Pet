# Task 4 执行报告

## 完成范围

- 将 `AgentRunProtocol` 收敛为 `default | capability_planner`，删除 `file_planner` 协议与错误码；首次工具前仅允许当前工具调用或严格澄清 JSON。
- `AgentLoop` 将本地工具结果的 `ok` 作为唯一终态事实：失败结果即使模型继续总结也发出 `error`；后续真实成功结果可以恢复 `success`。
- `PendingAction`、私有 `PendingExecution` 与 `AgentSession` 均改为文件/PowerShell 判别联合。公开 PowerShell 分支仅含完整命令、目录标签、前台模式和时间信息，不含绝对目录、确认摘要或进程对象。
- 会话注册表按 `taskKind` 隔离：文件任务恰有五个文件工具，PowerShell 任务恰有一个 `builtin.powershell.run` 高风险确认工具。
- `AgentService` 复用同一确认、续跑、generation、reset 与关闭路径；文件删除继续使用既有回收站动画事务，普通文件写入保持原行为，PowerShell 直接以前台结果续跑且不发布搬运动画。
- PowerShell 确认卡展示完整命令、工作目录摘要、前台非交互方式及“不是安全沙箱”的风险提示。

## TDD 记录

- 协议与公共契约测试覆盖失败事实、后续成功恢复和 PowerShell 确认联合。
- PowerShell 确认卡 RED：旧组件将 `powershell` 视为未处理动作；定向测试 1 失败、23 通过。GREEN 后 24/24 通过。
- PowerShell Service RED：预览收到硬编码空 cwd、`授权工作目录` 和 `session` generation，而非会话上下文；定向测试 1 失败、41 通过。GREEN 后 42/42 通过。
- 原有文件写入 carrying/reset 竞态在泛化时暴露缺少动画事件后的所有权复核；补回复核后定向回归恢复通过。

## 验证

- Desktop 定向：`tool-permission-policy`、`pending-action-store`、`agent-service`、`powershell-tool`、`renderer-components` 共 133/133 通过。
- Agent Core：41/41 通过；Shared Types：18/18 通过。
- `@myself/agent-core`、`@myself/shared-types`、`@myself/desktop` typecheck 均通过。
- `git diff --check` 通过；`apps/website` 无差异。

## 注意事项

- Task 4 不触及 Task 5 的会话意图分流与组合根接线；现有组合根仍仅构造文件会话。
- `close()` 与 reset 会等待活动 PowerShell 工具的有界关闭承诺，但不把前台进程清理描述为 OS 级隔离。

## 审查修复轮次 1

- 第四轮确认恢复先计算本次工具结果的 `ok`，再决定中性“本地能力操作”终态；前三轮成功、第四轮失败会稳定进入 `error`。
- 当失败 PowerShell 续跑再次产生确认请求时，`AgentService` 保留 owner 与会话；第二次确认可继续并以新的真实结果决定终态。
- 本地能力会话注册表签发后冻结，Main 不再追加 MCP 读取工具，也不再分支到 MCP 执行入口；文件会话保持精确五工具。
- `workingDirectoryLabel` 在共享公开契约边界拒绝驱动器绝对路径、UNC、设备路径和 Unix 绝对路径；Service 因而不会发布含绝对目录的确认卡。
- 模型总结失败时按能力类别与真实 `ok` 区分：成功文件保持既有结果文案；失败 PowerShell 采用中性能力结果文案，不伪称文件写入成功。

### 审查轮 TDD 与验证

- RED：第四轮确认使用旧成功事实；GREEN：AgentLoop 28/28。
- RED：失败 PowerShell 后第二确认 `ACTION_EXPIRED`，以及失败 PowerShell 总结失败伪称文件成功；GREEN：AgentService 45/45。
- RED：能力会话可以追加 MCP 工具；GREEN：工具注册表 18/18。
- RED：四种绝对目录标签均能通过公开契约；GREEN：Shared Types 18/18。

## 审查修复轮次 2

- `AgentService` 的前台 PowerShell 分支显式 `await execute()`，使不可逆执行屏障覆盖真实命令执行及其终止清理承诺；reset 和 close 不会在该承诺收敛前结束。
- RED：deferred PowerShell 执行已开始但未完成时，reset 与 close 都会提前 resolve；两条 AgentService 测试失败。
- GREEN：执行承诺完成前 reset/close 均保持未完成，随后迟到工具结果和模型总结不会穿透已失效任务；AgentService 定向测试 47/47 通过。
