# Task 6 执行报告

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

## 最终门禁

- `pnpm.cmd test:unit`：通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `pnpm.cmd test:integration`：4 个文件、34 项通过。
- `pnpm.cmd test:security`：1 个文件、20 项通过。
- `pnpm.cmd --filter @myself/desktop build`：通过；仅有既有 `lucide-react` 的 `use client` 打包提示。
- `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --reporter=line`：56 项通过；`tests/.playwright-output/.last-run.json` 为 `passed`。

## E2E 迁移事实

- 正式白名单场景覆盖创建、补丁、取消、PowerShell 成功、非零失败和取消；PowerShell 仅运行 `Write-Output` 与 `exit 7`。
- 回收站场景已迁移到 `delete_file`，通过真实回收站端口覆盖成功、角色切换中断和失败。
- 跨 Provider 披露按实际“预检 + 用户决定后续跑”更新为严格四步，并分别验证仅当前与单次共享的历史边界。
