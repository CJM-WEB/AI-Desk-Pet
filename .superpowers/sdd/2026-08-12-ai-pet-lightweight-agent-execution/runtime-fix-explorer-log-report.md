# Explorer 图层桥日志澄清修复报告

## 修复范围

- 仅修改桌面端 Main 组合根中的 Explorer 图层桥错误日志。
- 保留原有 `EXPLORER_BRIDGE_FAILED` 等公开稳定错误码。
- 不修改 Explorer 桥接、聊天、文件工具、PowerShell、IPC 或确认流程。
- 不修改网站。

## 根因

生产组合根把负责桌宠与 Explorer 窗口相邻层级的桥简称为“Explorer 桥”。日志“Explorer 桥接不可用。”没有说明能力边界，容易被误解为聊天、文件或 PowerShell 桥接不可用。该日志来自 Explorer 图层组合的 `reportError`，并不来自本地能力执行链。

## TDD 证据

1. 先在 `apps/desktop/tests/main-lifecycle.test.ts` 增加生产组合边界测试，要求日志明确为“Explorer 图层桥不可用，不影响聊天、文件与 PowerShell 能力。”，并禁止旧文案继续存在。
2. RED：修改生产代码前运行测试，目标用例按预期失败，实际源码仍包含旧文案。
3. GREEN：仅替换 `apps/desktop/src/main/index.ts` 中一处日志文案；目标测试随后通过。

## 验证结果

- `pnpm.cmd --dir apps/desktop test tests/main-lifecycle.test.ts`：10/10 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `git diff --check`：通过，仅有工作树换行符提示，无补丁格式错误。
- `git diff --name-only -- apps/website`：空，网站零修改。

## 工作树说明

执行期间工作树还存在其他并行任务修改；本修复未触碰这些文件，也未执行任何 Git 写操作。
