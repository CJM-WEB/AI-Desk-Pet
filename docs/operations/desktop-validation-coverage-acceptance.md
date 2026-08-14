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

以下为 A1 已实际变更文件及职责摘要：

- `apps/desktop/src/renderer/src/settings/SettingsView.tsx`、`apps/desktop/src/renderer/src/styles.css`：获批的设置页工作室入口与窄视口布局修复。
- `apps/desktop/tests/desktop-e2e-entry.test.ts`、`apps/desktop/tests/typescript-test-coverage.test.ts`、`apps/desktop/tsconfig.json`：Desktop 测试源码的 TypeScript 覆盖和动态 E2E owner 契约。
- `apps/desktop/tests/character-action-editor.test.tsx`、`character-player.test.tsx`、`character-workshop-close-renderer.test.tsx`、`character-workshop-components.test.tsx`、`character-workshop-state-list.dom.test.tsx`、`draft-character-preview.test.tsx`、`multi-provider-settings-store.test.ts`、`multi-provider-settings.test.tsx`、`renderer-components.test.tsx`：与 TypeScript 测试纳入和设置页组件相关的既有 Desktop 测试调整；原 `multi-provider-settings.test.ts` 已更名为 `multi-provider-settings-store.test.ts`。
- `tests/e2e/agent-mcp-flow.spec.ts`（删除）、`tests/e2e/desktop-settings-layout.spec.ts`（新增）、`tests/e2e/desktop.spec.ts`、`tests/playwright.config.ts`、`package.json`：退役旧 MCP enable E2E，新增设置页布局 owner，并使 Desktop E2E 从统一配置执行。
- `docs/superpowers/specs/2026-08-15-desktop-validation-coverage-design.md`、`docs/superpowers/plans/2026-08-15-desktop-validation-coverage.md`、`docs/operations/desktop-validation-coverage-acceptance.md`：规格、计划和本验收记录。

`.superpowers/sdd/2026-08-15-desktop-validation-coverage/task-4-report.md` 是受忽略规则保护的执行报告，未纳入提交。

## 2. 自动化结果

| 命令 | 退出码 | 结果 | 关键实际输出摘要 |
| --- | --- | --- | --- |
| `pnpm.cmd verify:desktop` | 1 | 失败 | 在 `pnpm typecheck` 的 `apps/desktop` 阶段停止；`tests/desktop-e2e-entry.test.ts` 第 62、63、64 行均报 TS2345：`string \| undefined` 不能传给 `string`。该命令的内层 workspace 命令报告 `Exit status 2`；后续单元、安全、集成与 Desktop E2E 链未执行。 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 1 | 失败（定向复现） | 与完整门禁相同的三个 TS2345 错误；内层命令报告 `Exit status 2`。 |
| `pnpm.cmd test:e2e:desktop` | 0 | 通过 | 构建完成后 Playwright 输出 `59 passed (3.6m)`。构建期间观察到 `lucide-react` 的 `use client` 指令警告，以及 Node 关于 `NO_COLOR` 与 `FORCE_COLOR` 的警告；它们未使该命令失败。 |
| `git diff --check`（创建本记录前） | 0 | 通过 | 无输出。 |
| `git diff --name-only -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase`（创建本记录前） | 0 | 通过 | 无输出。 |
| `git status --short`（创建本记录前） | 0 | 通过 | 无输出。 |

首次 `verify:desktop` 的验收状态为**失败**；独立 Desktop E2E 的通过结果不改变该首次总体结论。修复后的第二次完整门禁结果见第 8 节。

## 3. E2E owner 结果

本次 `pnpm.cmd test:e2e:desktop` 的 Playwright 实际输出只列出以下两个 Desktop spec 文件，合计 59 项通过：

- `tests/e2e/desktop-settings-layout.spec.ts`：2 项通过。
- `tests/e2e/desktop.spec.ts`：57 项通过。

该次运行输出未列出 `tests/e2e/website.spec.ts`，也未列出网站 Playwright 配置文件；网站 E2E 未运行。

## 4. MCP 禁用证据

- Desktop E2E 实测通过了 `desktop-settings-layout.spec.ts` 中 1200×720 与 960×640 两项“设置页 MCP 入口不可见”断言。
- 首次完整门禁在类型检查阶段中止，因此该次未运行单元、安全或集成链。修复后的完整门禁已通过类型检查，但在单元链的超时失败后中止；安全、集成和由该命令触发的 E2E 链均未执行。Provider 请求不含 `mcp.*` 的直接自动化结果未在本次独立命令中单独采集，状态为“未验证”。
- 最终只读检索用于确认 MCP 禁用契约源码、内部测试和测试桩仍在仓库中；检索结果见第 5 节后的最终自检。

## 5. 零差异检查

在创建验收记录前，网站、CloudBase 和包扫描器路径的 `git diff --name-only` 检查退出码为 0 且无输出，说明这些业务文件无差异。

本次未运行 `verify:website`、CloudBase 门禁或包扫描器门禁；不得将其写为通过。

## 6. 未覆盖项

- 真实 Windows 窗口层级、视觉布局、鼠标拖拽、系统托盘和资源管理器交互：待用户人工确认。
- 干净环境安装、卸载与生产部署：未验证。
- 修复后的完整 Desktop 门禁：TypeScript 检查通过；单元链因 6 个 5 秒超时失败；安全、集成和该次门禁触发的 E2E 链未执行。
- Provider 请求不含 `mcp.*` 的单独运行时断言：未验证。

## 8. 修复后完整门禁复验

时间线与实际结果如下：

1. 首次 `pnpm.cmd verify:desktop` 退出码为 1，在 `apps/desktop/tests/desktop-e2e-entry.test.ts` 第 62、63、64 行的 TS2345 后停止。
2. 提交 `0ed1dee` 修复上述 E2E gate 的 TypeScript 问题。修复后的完整门禁实际通过全部 workspace TypeScript 检查，包括 `apps/desktop typecheck`。
3. 修复后再次执行 `pnpm.cmd verify:desktop`，退出码为 1。单元链输出为 `Test Files 3 failed | 103 passed (106)`、`Tests 6 failed | 2134 passed | 14 skipped (2154)`：`character-package-service.test.ts` 2 项、`character-store.test.ts` 1 项和 `official-default-character.test.ts` 3 项均在 5 秒后超时。由于 `&&` 链在 `test:unit` 失败处停止，`test:security`、`test:integration` 和该次门禁调用的 `test:e2e:desktop` 均未执行。
4. 未提高超时，对上述三个失败文件进行一次定向复跑：`pnpm.cmd --filter @myself/desktop exec vitest run --project desktop tests/character-package-service.test.ts tests/character-store.test.ts tests/official-default-character.test.ts` 退出码为 0，输出为 `Test Files 3 passed (3)`、`Tests 113 passed (113)`，耗时 35.39 秒。

因此，修复后的完整 Desktop 门禁当前状态仍为**失败**：定向复跑的通过结果仅说明该次失败表现为高并发下的 5 秒超时抖动，不能替代完整门禁通过。未调整测试超时，未再次重跑完整门禁。

## 9. 复验后零差异检查

- `git diff --check` 退出码为 0；输出了 Git 的 LF 将在下次触碰文件时替换为 CRLF 的工作副本警告，未输出空白格式错误。
- `git diff --name-only -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase` 退出码为 0 且无输出。
- `git status --short` 仅显示 `docs/operations/desktop-validation-coverage-acceptance.md` 被修改；本次没有网站、CloudBase 或包扫描器路径差异。

## 7. 最终只读自检

本记录创建后实际执行：

```text
rg -n "MCP_MODULE_DISABLED|desktopRuntimeCapabilities|agent-mcp-flow|desktop-settings-layout" apps/desktop tests docs/operations/desktop-validation-coverage-acceptance.md
git diff --check
git status --short
```

结果如下：

- 该条 `rg` 命令把本验收记录作为搜索路径；其模式包含 `agent-mcp-flow`，因此文档自身会命中。该命令不能证明旧 E2E 文件或运行入口不存在，原“没有匹配结果”的表述不实；已由第 12 节的拆分只读检查替代。
- `git diff --check` 退出码为 0 且无输出。
- `git status --short` 仅显示本验收记录为未跟踪文件。
- `git check-ignore -v .superpowers/sdd/2026-08-15-desktop-validation-coverage/task-4-report.md` 显示该执行报告由 `.gitignore` 第 27 行的 `.superpowers/` 规则忽略。

自检结论以命令的实际输出为准；不以旧验收记录或计划目标替代本次运行结果。

## 10. 门禁稳定性例外与本轮复验

本机有 24 个逻辑 CPU。此前完整单元测试在默认文件并发下随机出现多个独立 5 秒超时，且失败文件定向复跑可以通过。用户批准将 Desktop Vitest 的文件 worker 上限固定为 4；未修改 `testTimeout`，未增加重试或关闭文件并行。

| 命令 | 退出码 | 结果 | 实际输出摘要 |
| --- | --- | --- | --- |
| `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/vitest-worker-cap.test.ts`（RED） | 1 | 失败（符合预期） | 使用 Vitest 3.2.7 `resolveConfig` 读取实际解析配置，断言失败：接收值为 `undefined`，期望为 `4`。 |
| 同一命令（GREEN） | 0 | 通过 | `maxWorkers: 4` 写入 Desktop Vitest 配置后，1 个文件、1 项测试通过。 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 0 | 通过 | `tsc --noEmit` 通过。 |
| `pnpm.cmd test:unit` | 1 | 失败 | 2 个文件、4 项测试在 5 秒后超时：`character-package-service.test.ts` 2 项及 `official-default-character.test.ts` 2 项；总计 `Test Files 2 failed \| 105 passed (107)`、`Tests 4 failed \| 2137 passed \| 14 skipped (2155)`，耗时 55.37 秒。 |
| `pnpm.cmd verify:desktop` | 0 | 通过 | 全部 workspace TypeScript 检查通过；单元链为 `Test Files 107 passed (107)`、`Tests 2141 passed \| 14 skipped (2155)`，耗时 41.86 秒；security 为 20/20，integration 为 46/46，Desktop E2E 为 59/59（3.4 分钟）。 |

该节的完整门禁结果更新并覆盖第 6、8 节中“最新完整门禁失败”的状态：本轮最后一次 `verify:desktop` 已通过并实际到达 security、integration 和两个 Desktop E2E owner。此前独立 `test:unit` 的一次 4 项超时仍保留为稳定性风险，不能被后续完整门禁通过抹除。

完整 E2E 通过了设置页 MCP 入口不可见的两个视口断言，以及正式 Provider 白名单业务闭环；本轮没有恢复 MCP 运行时能力。真实 Windows 视觉、窗口层级、拖拽、托盘和资源管理器人工观察仍为待用户人工确认。

## 11. 提交范围最终差异证据

在修复轮 1 提交 `414b5fc` 后，针对本轮起点 `d523cb5` 至当前 `HEAD` 实际执行：

| 命令 | 退出码 | 实际输出 | 结论 |
| --- | --- | --- | --- |
| `git diff --check d523cb5..HEAD` | 0 | 无输出 | 本轮提交范围没有 Git 空白格式错误。 |
| `git diff --name-only d523cb5..HEAD -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase` | 0 | 无输出 | 本轮提交范围内网站、CloudBase、包扫描器及受保护 E2E/配置路径保持零差异。 |

上述命令覆盖的是已提交的修复轮 1 范围，不以工作副本状态替代提交范围证据。

## 12. A1 最终集中修复

用户于 2026-08-15 批准以生产设置窗口参数为准，布局 E2E 的两条场景已由历史的 `1200×720`、`960×640` 改为默认 `720×620` 与最小 `640×520`。测试名称与失败时的 CDP 截图文件名同步使用这两个真实尺寸；MCP 入口、表单不可见断言和严格 `+1px` 裁剪容差保持不变。

| 命令 | 退出码 | 结果 | 实际输出摘要 |
| --- | --- | --- | --- |
| `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop-settings-layout.spec.ts` | 0 | 通过 | 两条真实尺寸场景均通过，输出为 `2 passed (23.2s)`。 |
| `pnpm.cmd --filter @myself/desktop build` | 0 | 通过 | Electron main、preload 与 renderer 均完成构建；`lucide-react` 的 `use client` 指令警告未导致失败。 |
| `Test-Path tests/e2e/agent-mcp-flow.spec.ts` | 0 | 通过 | 输出 `False`，旧 E2E 文件不存在。 |
| `rg -n "agent-mcp-flow|mcp\.local-tools\.echo" tests/e2e apps/desktop` | 1 | 符合预期 | 无输出；退出码 1 表示运行时和 E2E 搜索范围没有匹配。 |
| `rg -n "MCP_MODULE_DISABLED|desktopRuntimeCapabilities|desktop-settings-layout" apps/desktop tests` | 0 | 通过 | 输出包含 Desktop Playwright 的两个 owner、MCP 能力开关、`MCP_MODULE_DISABLED` 拒绝路径及其测试。 |
| `pnpm.cmd verify:desktop` | 1 | 失败 | TypeScript、单元（107 个文件、2141 通过、14 跳过）、安全（20/20）和集成（46/46）均通过；Desktop E2E 的两条真实尺寸布局场景通过，但“真实角色工作室闭环：V2 人设、皮肤和精确表现重启后保留且导出回导等价”等待“动作 1”按钮 15 秒超时，最终为 58/59 通过。 |
| `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "V2 人设、皮肤和精确表现重启后保留且导出回导等价"` | 0 | 通过（定向复现） | 同一角色工作室场景独立复跑为 `1 passed (35.1s)`；该结果不替代完整门禁失败。 |

本轮将两条既有 E2E 改为真实尺寸后立即运行定向测试；它们直接通过，未形成 RED。这表明既有“角色工作室”按钮最小修复已覆盖真实尺寸，未观察到裁剪或重叠，故未修改 `SettingsView.tsx` 或 `styles.css`，也没有放宽任何布局门禁。此处记录实际结果，不将“应当失败”的预期写成已发生的 RED 证据。

历史规格、计划和验收文档可保留 `agent-mcp-flow` 的裁决背景，因而允许全文档检索命中；“旧文件不存在”和“运行入口不存在”的结论只依据上表中排除历史文档路径的两条只读命令。

完整门禁中的角色工作室失败不在本轮设置窗口测试、规格或验收文本变更范围内，且同一场景定向复跑通过；本轮不对此既有不稳定表现进行越界修复。完整 `verify:desktop` 的当前真实状态为失败。

提交前 `git diff --check` 退出码为 0，未报告空白格式错误；Git 仅提示这四个改动文件下次触碰时 LF 会转为 CRLF。`git diff --name-only -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase` 与 `git diff --name-only b686eca..HEAD -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase` 均无输出，前者覆盖本次工作副本，后者覆盖提交前既有 A1 提交范围。

## 13. 最终当前提交复验

主控制器在当前提交 `232c083` 上新鲜执行 `pnpm.cmd verify:desktop`，退出码为 0。该结果按时间覆盖第 12 节中“完整 `verify:desktop` 的当前真实状态为失败”的最新状态；第 12 节保留此前失败和定向复跑的历史证据，不作改写或删除。

| 链路 | 实际结果 |
| --- | --- |
| TypeScript | 全部通过。 |
| 单元测试 | `107/107` 个测试文件通过，`2141 passed`、`14 skipped`，耗时 36.69 秒。 |
| 安全测试 | `20/20` 通过。 |
| 集成测试 | `46/46` 通过。 |
| Desktop E2E | `59/59` 通过，耗时约 3.0 分钟；`720×620` 默认尺寸与 `640×520` 最小尺寸布局场景均通过，先前超时的角色工作室场景本轮也通过。 |

本次复验没有恢复 MCP 运行时或放宽布局门禁。真实 Windows 视觉、窗口层级、鼠标拖拽、系统托盘、资源管理器交互、干净环境安装卸载与生产部署仍待用户人工确认。
