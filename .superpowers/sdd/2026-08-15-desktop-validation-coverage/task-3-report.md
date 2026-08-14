# Task 3：Desktop E2E 唯一 owner 与门禁可达契约报告

日期：2026-08-15
基线提交：`9069513b315bb7fe0e772b4b04bcca3f60051252`

## 改动

- 新增 `apps/desktop/tests/desktop-e2e-entry.test.ts`：读取根脚本和两份 Playwright 配置，枚举 `tests/e2e/*.spec.ts`，验证 Desktop spec 只有配置入口负责、Website spec 仅归 Website 配置，且 `verify:desktop` 恰好可达安全、集成和 Desktop E2E 三道门禁。
- `tests/playwright.config.ts` 明确声明 Desktop 的两份 E2E spec：`desktop.spec.ts` 与 `desktop-settings-layout.spec.ts`。
- 根 `test:e2e:desktop` 删除重复的单文件点名，保留构建后只通过 Desktop Playwright 配置执行的入口。

## RED → GREEN → REFACTOR

- RED：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/desktop-e2e-entry.test.ts` 失败，断言收到的 Desktop `testMatch` 为空数组；失败原因符合预期，尚未声明 Desktop E2E 的显式配置 owner。
- GREEN：配置和根脚本最小修改后，同一命令通过（1/1）。
- REFACTOR：新测试的路径规范化和匹配读取已由一个局部 helper 集中处理，无重复逻辑可在不扩大范围的情况下删除；未引入全局 catalog 或改动已有 `verify:desktop`。

## Playwright 清单检查

执行 `pnpm.cmd exec playwright test --list --config tests/playwright.config.ts`：仅列出 `desktop-settings-layout.spec.ts` 与 `desktop.spec.ts`，共 59 项；未出现 `agent-mcp-flow.spec.ts` 或 `website.spec.ts`。

## 门禁验证

- `pnpm.cmd test:security`：通过，20/20。
- `pnpm.cmd test:integration`：通过，46/46。
- `pnpm.cmd test:e2e:desktop`：通过，先构建一次，再由单 worker 执行两份 Desktop spec，59/59，耗时 3.2 分钟。

## 自审与风险

- 自审范围：只新增契约测试与本报告；只修改 Desktop Playwright 配置和根 E2E 脚本。Website Playwright 配置仅被测试读取，没有差异；网站、CloudBase 与扫描器没有差异。
- 风险：构建阶段仍输出 `lucide-react` 的既有 `"use client"` 指令警告，以及 Node 的 `NO_COLOR` 环境警告；三道门禁均通过，本任务未修改其来源。

## 提交

本报告与 Task 3 的实现改动位于同一个本地任务提交中；提交标识以提交完成后的 Git 记录为准。
