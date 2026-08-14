# Desktop 验证覆盖验收记录

> 日期：2026-08-15
> 适用规格：`docs/superpowers/specs/2026-08-15-desktop-validation-coverage-design.md`
> 环境：Windows 10/11；Node.js 与 pnpm 版本见本节紧随其后的命令输出

```text
node --version
v24.18.0

pnpm.cmd --version
11.9.0
```

## 1. 变更范围

本次实际创建以下文件：

- `docs/operations/desktop-validation-coverage-acceptance.md`：本验收记录。
- `.superpowers/sdd/2026-08-15-desktop-validation-coverage/task-4-report.md`：任务执行报告；该文件受忽略规则保护，未纳入提交。

本次未修改或删除生产代码、测试和配置文件。

## 2. 自动化结果

| 命令 | 退出码 | 结果 | 关键实际输出摘要 |
| --- | --- | --- | --- |
| `pnpm.cmd verify:desktop` | 1 | 失败 | 在 `pnpm typecheck` 的 `apps/desktop` 阶段停止；`tests/desktop-e2e-entry.test.ts` 第 62、63、64 行均报 TS2345：`string \| undefined` 不能传给 `string`。该命令的内层 workspace 命令报告 `Exit status 2`；后续单元、安全、集成与 Desktop E2E 链未执行。 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 1 | 失败（定向复现） | 与完整门禁相同的三个 TS2345 错误；内层命令报告 `Exit status 2`。 |
| `pnpm.cmd test:e2e:desktop` | 0 | 通过 | 构建完成后 Playwright 输出 `59 passed (3.6m)`。构建期间观察到 `lucide-react` 的 `use client` 指令警告，以及 Node 关于 `NO_COLOR` 与 `FORCE_COLOR` 的警告；它们未使该命令失败。 |
| `git diff --check`（创建本记录前） | 0 | 通过 | 无输出。 |
| `git diff --name-only -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase`（创建本记录前） | 0 | 通过 | 无输出。 |
| `git status --short`（创建本记录前） | 0 | 通过 | 无输出。 |

完整 `verify:desktop` 的验收状态为**失败**；独立 Desktop E2E 的通过结果不改变该总体结论。

## 3. E2E owner 结果

本次 `pnpm.cmd test:e2e:desktop` 的 Playwright 实际输出只列出以下两个 Desktop spec 文件，合计 59 项通过：

- `tests/e2e/desktop-settings-layout.spec.ts`：2 项通过。
- `tests/e2e/desktop.spec.ts`：57 项通过。

该次运行输出未列出 `tests/e2e/website.spec.ts`，也未列出网站 Playwright 配置文件；网站 E2E 未运行。

## 4. MCP 禁用证据

- Desktop E2E 实测通过了 `desktop-settings-layout.spec.ts` 中 1200×720 与 960×640 两项“设置页 MCP 入口不可见”断言。
- 完整门禁在类型检查阶段中止，因此本次未通过 `verify:desktop` 运行单元、安全或集成链。Provider 请求不含 `mcp.*` 的直接自动化结果未在本次独立命令中单独采集，状态为“未验证”。
- 最终只读检索用于确认 MCP 禁用契约源码、内部测试和测试桩仍在仓库中；检索结果见第 5 节后的最终自检。

## 5. 零差异检查

在创建验收记录前，网站、CloudBase 和包扫描器路径的 `git diff --name-only` 检查退出码为 0 且无输出，说明这些业务文件无差异。

本次未运行 `verify:website`、CloudBase 门禁或包扫描器门禁；不得将其写为通过。

## 6. 未覆盖项

- 真实 Windows 窗口层级、视觉布局、鼠标拖拽、系统托盘和资源管理器交互：待用户人工确认。
- 干净环境安装、卸载与生产部署：未验证。
- 完整 Desktop 门禁中的单元、安全和集成链：因 typecheck 失败未执行。
- Provider 请求不含 `mcp.*` 的单独运行时断言：未验证。

## 7. 最终只读自检

本记录创建后实际执行：

```text
rg -n "MCP_MODULE_DISABLED|desktopRuntimeCapabilities|agent-mcp-flow|desktop-settings-layout" apps/desktop tests docs/operations/desktop-validation-coverage-acceptance.md
git diff --check
git status --short
```

结果如下：

- `rg` 退出码为 0。输出显示 `tests/playwright.config.ts` 的 `testMatch` 仅包含 `desktop.spec.ts` 和 `desktop-settings-layout.spec.ts`；MCP 能力开关、`MCP_MODULE_DISABLED` 拒绝路径及其内部测试仍存在。`agent-mcp-flow` 没有匹配结果。
- `git diff --check` 退出码为 0 且无输出。
- `git status --short` 仅显示本验收记录为未跟踪文件。
- `git check-ignore -v .superpowers/sdd/2026-08-15-desktop-validation-coverage/task-4-report.md` 显示该执行报告由 `.gitignore` 第 27 行的 `.superpowers/` 规则忽略。

自检结论以命令的实际输出为准；不以旧验收记录或计划目标替代本次运行结果。
