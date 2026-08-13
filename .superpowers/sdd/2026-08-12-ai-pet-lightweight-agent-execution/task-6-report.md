# Task 6 定向验收报告

## 范围

- 将安全与集成验收从旧六文件工具迁移到五工具：`list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file`。
- 增加真实前台 PowerShell 确认纵向验证；命令仅使用受控输出、标准错误和 `exit 0`。
- 新增中文验收操作文档。

## TDD 记录

- RED：完整 integration 基线 33 项中 14 项失败，原因是旧工具名、旧回收站动作形态和缺失的 `taskKind: 'file'` 测试会话。
- GREEN：迁移后 `tests/integration/desktop-agent.test.ts` 21/21 通过；新增 PowerShell 成功确认测试 1/1 通过。
- RED：security 基线 20 项中 10 项失败，原因是旧六工具和旧公开动作形态。
- GREEN：迁移后 `pnpm.cmd test:security` 20/20 通过。

## 已验证门禁

- `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts`：22 项通过（含 PowerShell）。
- `pnpm.cmd test:security`：20 项通过。

## 最终修复轮次证据

- `pnpm.cmd test:integration`：4 个文件、45 项通过。
- `pnpm.cmd test:security`：1 个文件、20 项通过。
- 主控上一轮 fresh Electron E2E：56/56 通过、exit 0、3.2 分钟；本轮六 sentinel 敏感性与正式白名单聚焦 E2E 2/2 通过（14.7 秒）。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。

## 审查 finding 闭环

- 文件工具：真实 `list_files` 条目、分页 `read_file`、带正文且独占的 `create_file`、确认后外部改动的 `apply_patch` 冲突、`delete_file` 空目录回收站成功与非空目录拒绝均有纵向断言；旧工具名稳定为 `TOOL_UNKNOWN`。
- 能力协议：口头拒绝在同一 `submit` 内只触发一次协议修复后进入真实工具调用；连续伪成功稳定报告 `CAPABILITY_PLAN_PROTOCOL_INVALID`。
- PowerShell：真实受控进程端口覆盖成功、非零退出、确认取消零 spawn、reset 后迟到 close 隔离，以及组合入口的 background 拒绝；`AgentService` 纵向测试以假时钟触发静默超时，公开 `error`，并验证超时后的 stdout、stderr、close 不增加事件或续跑 Provider。
- 原始日志：六个 sentinel 已真实经过用户输入、Provider assistant 文本、`create_file` 正文、完整 PowerShell 命令、stdout、stderr；正式白名单断言脱敏前捕获布尔值全为 `false`。夹具敏感性测试模拟每一路 console 泄漏，均使相应原始证据为 `true`，且不保留生产变异。
- 行为集成：自主行为闭环已通过真实 `AgentService`、provider-server、`CharacterBehaviorService` 和窗口运动事件连接，而非手工 `AgentLoop`。

## E2E 迁移事实

- 正式白名单场景覆盖创建、补丁、取消、PowerShell 成功、非零失败和取消；PowerShell 仅运行受控 `Write-Output`、标准错误写入和 `exit 7`，取消场景保留零 spawn 证据。
- 回收站场景已迁移到 `delete_file`，通过真实回收站端口覆盖成功、角色切换中断和失败。
- 跨 Provider 披露按实际“预检 + 用户决定后续跑”更新为严格四步，并分别验证仅当前与单次共享的历史边界。
