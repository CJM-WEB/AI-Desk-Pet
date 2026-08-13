# 轻量本地能力最终实施报告

## 结果

本计划已完成。桌面端复用现有 Agent、权限确认、会话隔离、Renderer 与生命周期体系，收敛为五个文件工具和一个前台非交互 PowerShell 工具；旧工具名、旧文件任务适配器和重复执行路径已删除。`apps/website` 未修改、未构建、未测试。

## 最终能力

- 文件工具恰好五个：`list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file`。
- 创建、补丁和删除均逐次确认；补丁有冲突检查，删除只进入 Windows 回收站。
- PowerShell 仅支持当前 Windows 用户下的前台非交互执行，每次必须确认；没有后台任务、PTY、AST、Job Object、第二套 IPC 或本地能力 MCP。
- 普通聊天、文件正文中的命令和讨论性 PowerShell 文本不触发本地能力。
- 显式 `运行/执行 PowerShell` 支持真实脚本载荷，非空且 UTF-8 不超过 16 KiB；超限请求在文件扫描前拒绝。

## 最终审查修复

- 文件创建与补丁失败时按实体身份清理本方临时目标，避免遗留敏感正文或误删竞争方文件。
- PowerShell 的 Abort、超时和关闭共用唯一完成屏障，`close()` 会等待已开始的清理。
- 文件工具错误使用集中映射，`ENTRY_CHANGED`、`RECYCLE_BIN_FAILED` 等具体事实不会被泛化或重复发布。
- `read_file` 公开正文限制为 64 KiB；敏感或过长的创建预览只公开抑制原因。
- 显式 PowerShell 路由不再受通用 16 参数限制；文件 Gate 前的早期裁决将 16 KiB 边界用例从秒级扫描降为毫秒级，并以 Gate 调用计数验证。
- 最终规格复审与质量复审均为 PASS，无 Critical 或 Important。

## 新鲜自动门禁

- 七个非网站工作区 typecheck：shared-types、file-tools、agent-core、character-runtime、character-assets、desktop、release-tools 全部退出 0。
- `pnpm.cmd test:unit`：102/102 测试文件；2109 passed、14 skipped；退出 0，60.98 秒。
- `pnpm.cmd test:security`：1/1 文件，20/20 测试；退出 0。
- `pnpm.cmd test:integration`：4/4 文件，45/45 测试；退出 0。
- `pnpm.cmd test:e2e:desktop`：构建和 preload 校验通过；Electron 57/57；退出 0，2.9 分钟。
- `pnpm.cmd verify:behavior`：character-runtime 221、agent-core 41、Desktop 1695 passed/14 skipped、安全 20、集成 45、Electron 57；合计 2079 passed、14 skipped；退出 0。
- `tests/.playwright-output/.last-run.json`：`status=passed`、失败列表为空。
- 工作区相关 Node、Electron、PowerShell 残留进程：0。
- `git diff --check`：退出 0。
- 工作区差异及 `9052aa1..HEAD` 范围内的 `apps/website` 文件：均为空。

## 非阻断提示

- 构建仍输出第三方 `lucide-react` 的 `use client` 忽略提示。
- jsdom 的 Canvas 提示只出现在既有回退/失败测试，不影响门禁结果。
- 首次聚合单元门曾在高并发负载下触发三个固定 5 秒超时；其中新增路由边界已通过早期裁决彻底修复，两个既有角色用例聚焦分别为 555ms、871ms，随后完整 `test:unit` 与 `verify:behavior` 均新鲜通过。

## 提交尾链

- `6f0c7fd`：收紧轻量能力最终边界。
- `6861c28`：放宽显式 PowerShell 脚本载荷。
- `26d6d1a`：同步安全与集成公开错误契约。
- `c7c2322`：提前裁决显式 PowerShell 请求。
- `d7d1e63`：同步回收站失败提示。
