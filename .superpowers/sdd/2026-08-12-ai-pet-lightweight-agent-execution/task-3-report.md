# Task 3 执行报告

## 完成范围

- `PowerShellTool` 通过固定前台参数、授权工作目录和环境白名单启动非交互 PowerShell，调用方不接触子进程对象。
- 一次性确认动作以私有 `WeakMap` 绑定完整目录、命令摘要、会话 generation 和有效期；克隆、过期与重放均不能启动进程。
- stdout 与 stderr 独立收集并分别限制为 256 KiB；Abort、静默超时、总超时和 close 统一收敛到有界的进程树清理路径。
- 轻量词法扫描器拒绝直接可识别的高风险静态调用；展示文本、帮助参数、注释、未知命令和动态调用仍进入逐次确认。

## TDD 记录

- 初始实现覆盖固定 argv、环境脱敏、输出边界、进程生命周期、一次性确认和明确硬拒绝规则。
- 审查修复轮次 4 RED：普通分组 `(Get-Credential)` 未被递归扫描；定向测试 1 失败、31 通过。
- 审查修复轮次 4 GREEN：复用现有定界符查找与递归扫描处理普通 `()`；`(Get-Credential)` 和 `if (Get-Credential) {}` 被拒绝，`('Get-Credential')` 保持放行，定向测试 32/32 通过。

## 验证

- Task 3 定向测试：32/32 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `git diff --check`：通过；`apps/website` 无改动。

## 注意事项

扫描器只提取静态可执行命令位置，不构建 PowerShell AST，也不猜测动态调用的运行时值。普通分组复用既有递归能力，不改变“动态调用仍需逐次确认”的边界。
