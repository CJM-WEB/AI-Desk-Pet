# AI Pet Desktop 验证覆盖设计

> 文档状态：已批准（用户于 2026-08-15 确认执行）
> 日期：2026-08-15
> 上位规格：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`
> 对应阶段：阶段 A / A1 Desktop 验证覆盖
> 适用范围：Desktop TypeScript、Vitest、Playwright 与根级 Desktop 验证入口
> 明确排除：网站、CloudBase、包扫描器及其业务代码、测试和验证入口

## 1. 文档目的

本规格细化上位规格中的 A1，建立一条可证明、可维护的 Desktop 专属验证闭环。它解决三个已由当前仓库配置和测试文件核实的问题：

1. `apps/desktop/tsconfig.json` 只显式包含 `tests/**/*.ts`，Desktop Vitest 却同时执行 `.ts` 与 `.tsx` 测试，导致部分测试没有进入 TypeScript 检查。
2. Desktop Playwright 配置没有显式声明测试文件 owner，根脚本又只点名 `desktop.spec.ts`，使其他 Desktop E2E 文件可能成为孤儿。
3. `tests/e2e/agent-mcp-flow.spec.ts` 的主体仍验证已退役的 MCP 启用链路，与当前 MCP 禁用契约冲突；其中仅设置页布局检查仍有保留价值。

本规格不创建全仓验证注册中心，不恢复 MCP，不改变任何生产功能。实施结果只收紧现有测试与验证入口。

## 2. 事实来源

### 2.1 上位约束

- `docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`
- `docs/superpowers/specs/2026-08-12-ai-pet-lightweight-agent-reuse-design.md`
- `docs/operations/lightweight-agent-acceptance.md`
- `CONTEXT.md`

上位规格规定：A1 必须覆盖 Desktop `.ts` 与 `.tsx` 测试、建立最小 rootNames 契约、裁决孤立 E2E、保证有效 Desktop E2E 只有一个入口，并证明 `verify:desktop` 可达安全、集成和 E2E 门禁。任何处理都不得恢复 MCP 运行时、Agent MCP 工具或 Renderer 可见入口。

### 2.2 当前配置事实

- `apps/desktop/vitest.config.ts` 匹配 `tests/**/*.test.{ts,tsx}`。
- `apps/desktop/tsconfig.json` 当前包含 `tests/**/*.ts`，没有包含 `tests/**/*.tsx`。
- `apps/desktop/tests/multi-provider-settings.test.ts` 与 `.tsx` 使用同一 basename；TypeScript rootNames 会优先保留 `.ts`，因此必须把 Store 测试职责化改名后才能同时检查两份源码。
- `tests/playwright.config.ts` 的 `testDir` 为 `./e2e`，但没有 `testMatch`。
- `tests/playwright.website.config.ts` 已用 `testMatch: 'website.spec.ts'` 拥有网站 E2E。
- 根 `test:e2e:desktop` 当前在命令行点名 `tests/e2e/desktop.spec.ts`。
- 根 `verify:desktop` 当前按顺序调用 `typecheck`、`test:unit`、`test:security`、`test:integration` 和 `test:e2e:desktop`。
- `tests/vitest.config.ts` 是根级安全与集成测试入口。

### 2.3 当前 MCP 禁用事实

- `apps/desktop/src/shared/desktop-runtime-capabilities.ts` 固定声明 `desktopRuntimeCapabilities.mcp === false`。
- `DesktopSettingsService` 在 MCP 禁用时不恢复 MCP 数据、不连接服务、不注册 MCP 工具，并以稳定错误码 `MCP_MODULE_DISABLED` 拒绝 MCP 操作。
- 设置页不公开“工具”导航；旧 `activeTab='tools'` 回退到模型页。
- `apps/desktop/tests/desktop-settings-service.test.ts` 已覆盖禁用时无恢复、无连接、无写入和统一失败。
- `apps/desktop/tests/multi-provider-settings.test.tsx` 已覆盖 Renderer 不显示 MCP 入口及旧 tab 回退。
- MCP Manager、Store、adapter、IPC/preload 类型、持久化 Schema 与测试桩属于获批保留的 dormant source，不能因运行时禁用而删除。

## 3. 目标与非目标

### 3.1 目标

1. Desktop `tests` 下所有 `.ts` 与 `.tsx` 源码都进入 `tsc --noEmit`。
2. 用一个基于 TypeScript 解析结果的配置契约发现当前和未来遗漏的测试源码。
3. 将仍有效的设置页布局覆盖从旧 MCP E2E 中迁出，并删除已退役的 MCP enable 流程。
4. 让每个有效 Desktop E2E 文件恰好由 Desktop Playwright 配置拥有一次。
5. 让根 `test:e2e:desktop` 只调用 Desktop Playwright 配置，不再维护第二份文件清单。
6. 用自动化契约证明 `verify:desktop` 可达安全、集成和 Desktop E2E 门禁。
7. 用真实 Provider 请求断言证明 MCP 禁用时不会向模型暴露 `mcp.*` 工具。
8. 形成独立验收记录，只记录实际运行结果和未覆盖项。

### 3.2 非目标

- 不恢复 MCP 运行时、MCP Agent 工具或 Renderer 工具页。
- 不改变 Desktop 生产行为、IPC、Provider、文件工具或角色行为。
- 不建立 `VerificationCatalog`、`verify:repo` 或覆盖全部 workspace 的验证框架。
- 不拆分 `tests/e2e/desktop.spec.ts` 的其他场景。
- 不删除 MCP Manager、Store、adapter、持久化数据或内部测试。
- 不修改或运行网站、CloudBase、包扫描器的业务验证链。

## 4. 设计决策

### 4.1 TypeScript rootNames 契约

新增 Desktop 单元测试，通过 TypeScript 官方 API读取 `apps/desktop/tsconfig.json`：

```ts
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  desktopRoot
);
```

测试递归枚举 `apps/desktop/tests` 下所有 `.ts` 和 `.tsx` 文件，并与 `parsed.fileNames` 比较。路径在 Windows 上必须统一分隔符并进行不区分大小写的规范化。断言比较动态枚举结果，不硬编码当前测试文件名单，确保未来新增文件也受约束。

生产配置只增加 `tests/**/*.tsx`。同时将 Main `SettingsStore` 测试改名为 `multi-provider-settings-store.test.ts`，Renderer `.tsx` 测试名称保持不变；不修改两份测试内容。该改名由用户于 2026-08-15 单独批准，用于消除 TypeScript 的同 basename 解析冲突。不创建第二份 tsconfig，不扩大到网站或其他 workspace。

### 4.2 旧 MCP E2E 裁决

`tests/e2e/agent-mcp-flow.spec.ts` 的职责拆解如下：

| 内容 | 裁决 | 原因 |
| --- | --- | --- |
| 从设置页新增、启动、授权 MCP 服务 | 删除 | 恢复了已退役能力，与 `mcp: false` 冲突 |
| 调用 `mcp.local-tools.echo` | 删除 | MCP 工具不得进入 Agent 工具白名单 |
| MCP 子进程存活与退出清理 | 随旧启用流程删除 | 当前正式运行时不会创建该进程；Manager 内部进程测试继续保留 |
| Provider 配置、文件确认/取消、失败/取消 | 不从旧文件迁移 | `desktop.spec.ts` 已有正式业务闭环覆盖，继续保留会重复验证 |
| 1200×720 与 960×640 设置页布局检查 | 迁移 | 仍是有效的真实 Electron UI 风险 |

迁移后的文件命名为 `tests/e2e/desktop-settings-layout.spec.ts`，只负责设置页在两种视口下的溢出、重叠与 MCP 入口不可见检查。旧文件在迁移完成并通过定向测试后单文件删除。

迁移 RED 证明现有 `.settings-header button` 的统一 `44×44px` 规则会真实裁剪带可见文字的“角色工作室”按钮。用户于 2026-08-15 批准在本任务内给该按钮增加职责化 class，并在 `styles.css` 中使用自适应宽度、44px 高度和单行文本修复；关闭按钮继续保持 `44×44px`。不得放宽通用 `+1px` 裁剪门禁、隐藏按钮文案或按按钮名称豁免检测。

### 4.3 MCP 禁用的 E2E 证据

设置页布局 E2E 必须验证：

- 可见导航只有模型、隐私和本地数据相关入口；
- “工具”按钮不存在；
- `服务 ID` 输入或“添加服务”按钮不存在；
- 两种视口下没有横向溢出和文字/控件重叠。

`tests/e2e/desktop.spec.ts` 的正式文件 Agent 请求检查必须继续验证 `builtin.files.*` 白名单，并追加：

```ts
const mcpToolNames = request.tools
  .map(tool => tool.function.name)
  .filter(name => name.startsWith('mcp.'));

if (mcpToolNames.length > 0) {
  throw new Error('MCP 禁用时不得向 Provider 暴露 mcp.* 工具');
}
```

该断言使用现有 `ProviderStep.inspect(request: ModelRequest)`，不为测试新增生产接口。

### 4.4 E2E 唯一 owner

Desktop Playwright 配置成为 Desktop E2E 文件清单的唯一事实来源：

```ts
testMatch: ['desktop.spec.ts', 'desktop-settings-layout.spec.ts']
```

根 `test:e2e:desktop` 只负责先构建 Desktop，再调用该配置：

```json
"test:e2e:desktop": "pnpm --filter @myself/desktop build && playwright test --config tests/playwright.config.ts"
```

新增的配置契约测试必须枚举 `tests/e2e/*.spec.ts`，明确识别现有网站 E2E 由网站配置拥有，并验证其余 Desktop E2E 恰好在 Desktop `testMatch` 中出现一次。测试还要拒绝数组内重复项、Desktop 配置误收网站文件，以及根脚本重新点名单个 spec。

### 4.5 Desktop 门禁可达性

根 `verify:desktop` 当前链路无需重写。配置契约只锁定以下可达关系各出现一次：

```text
verify:desktop
  -> test:security
  -> test:integration
  -> test:e2e:desktop
      -> Desktop build
      -> tests/playwright.config.ts
```

`test:security` 与 `test:integration` 必须继续使用 `tests/vitest.config.ts`。本规格不把网站门禁加入 `verify:desktop`。

## 5. 文件职责

### 5.1 创建

- `apps/desktop/tests/typescript-test-coverage.test.ts`：验证 Desktop 测试源码全部进入 TypeScript rootNames。
- `apps/desktop/tests/desktop-e2e-entry.test.ts`：验证 E2E 唯一 owner、根脚本单一入口和 Desktop 门禁可达性。
- `tests/e2e/desktop-settings-layout.spec.ts`：承接旧文件中仍有效的设置页布局场景，并验证 MCP UI 不可见。
- `docs/operations/desktop-validation-coverage-acceptance.md`：记录实际命令、结果、环境、未覆盖项和零差异检查。

### 5.2 修改

- `apps/desktop/tsconfig.json`：加入 `tests/**/*.tsx`。
- `apps/desktop/tests/multi-provider-settings.test.ts`：只改名为 `multi-provider-settings-store.test.ts`，不改变测试内容。
- `apps/desktop/src/renderer/src/settings/SettingsView.tsx`：只给“角色工作室”按钮增加专用样式 class。
- `apps/desktop/src/renderer/src/styles.css`：只为该专用 class 增加自适应宽度、单行文本和图标间距，保留关闭按钮尺寸。
- `tests/playwright.config.ts`：显式列出两个 Desktop E2E owner。
- `tests/e2e/desktop.spec.ts`：在现有 Provider 请求检查中断言不存在 `mcp.*` 工具。
- `package.json`：让 `test:e2e:desktop` 只调用 Desktop Playwright 配置；保留现有 `verify:desktop` 链路。

### 5.3 删除

- `tests/e2e/agent-mcp-flow.spec.ts`：在布局场景迁移并通过后执行单文件删除。

### 5.4 明确保留

- `apps/desktop/src/shared/desktop-runtime-capabilities.ts` 中的 `mcp: false`。
- `apps/desktop/src/main/mcp/**`。
- MCP Manager、Store、adapter、IPC/preload/shared type 与持久化 Schema。
- `apps/desktop/tests/mcp-manager.test.ts`。
- `apps/desktop/tests/desktop-settings-service.test.ts` 中的 MCP 禁用契约测试。
- `apps/desktop/tests/multi-provider-settings.test.tsx` 中的 MCP 隐藏与 tab 回退测试。
- `tests/fixtures/mcp-test-server.ts` 与 `tests/fixtures/mcp-http-test-server.ts`。
- `McpSettings` dormant component；运行时继续不可达。

## 6. 失败处理与安全边界

- rootNames 测试发现漏检文件时，必须报告完整相对路径列表；不得通过删除测试或增加 exclude 使其通过。
- E2E owner 测试发现零 owner 或多 owner 时必须失败；不得让根脚本和 Playwright 配置同时维护文件清单。
- MCP 禁用断言失败时，不得通过启用设置页或调整 capability 修复；应追查工具注册或 UI 路由泄漏。
- 布局测试失败时保留现有截图证据，不扩大为网站或其他窗口的 UI 重构。
- 旧 E2E 只允许在有效布局场景迁移、定向测试通过后删除。
- 本规格不赋予任何 Git 写权限；实施期间遵守仓库只读 Git 规则。

## 7. 验证与验收

### 7.1 自动化门禁

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
pnpm.cmd verify:desktop
git diff --check
```

### 7.2 验收标准

1. rootNames 契约动态枚举 `.ts` 与 `.tsx`；当前 Desktop 测试无遗漏。
2. `playwright --list` 只列出 `desktop.spec.ts` 和 `desktop-settings-layout.spec.ts` 的 Desktop 测试，不列出旧 MCP 文件或网站文件。
3. 两种设置页视口均无横向溢出、文字或控件重叠，且不显示 MCP 入口和表单。
4. 正式文件 Agent 请求只暴露批准的 `builtin.*` 工具，不含 `mcp.*`。
5. MCP 禁用单测与 Manager 内部测试继续通过。
6. `verify:desktop` 实际到达安全、集成和 Desktop E2E 门禁。
7. 验收文档只将实际执行并观察到的结果写为通过；未运行项目写为“未验证”。

### 7.3 零差异边界

以下路径必须保持零差异：

- `apps/website/**`
- `tests/e2e/website.spec.ts`
- `tests/playwright.website.config.ts`
- `apps/cloudbase-api/**`
- `apps/package-scanner/**`
- `cloudbase/**`

只允许使用只读差异命令检查这些路径；不得运行或修改网站、CloudBase、scanner 业务验证入口，也不得声称这些系统已通过本轮运行验收。
