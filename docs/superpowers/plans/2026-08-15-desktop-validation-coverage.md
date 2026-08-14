# Desktop 验证覆盖实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可证明的 Desktop TypeScript 与 E2E 验证闭环，退役冲突的 MCP enable E2E，并让 `verify:desktop` 成为安全、集成和 Desktop E2E 的单一可达入口。

**Architecture:** 使用两个小型 Vitest 配置契约分别约束 TypeScript rootNames 和 Desktop E2E owner；Playwright 配置拥有唯一 Desktop E2E 清单，根脚本只负责构建并调用配置。旧 `agent-mcp-flow.spec.ts` 只迁移仍有效的设置布局场景，其余 MCP enable 流程删除，现有 MCP 禁用生产契约保持不变。

**Tech Stack:** TypeScript 5.9、Vitest 3、Playwright 1.61、Electron 43、pnpm workspace、Node.js `fs`/`path`、TypeScript Compiler API

## Global Constraints

- 已批准规格：`docs/superpowers/specs/2026-08-15-desktop-validation-coverage-design.md`。
- 上位规格：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md` 的 A1。
- 只修改本计划精确列出的 Desktop 测试、配置、根脚本和验收文档；唯一生产 UI 例外是用户于 2026-08-15 批准的 `SettingsView.tsx` 与 `styles.css` 角色工作室按钮裁剪修复。
- `desktopRuntimeCapabilities.mcp` 必须保持 `false`；不得恢复 MCP 运行时、Agent MCP 工具或 Renderer 工具页。
- 不创建 `VerificationCatalog`、`verify:repo`、第二套 Desktop tsconfig 或全 workspace 验证框架。
- 网站、CloudBase、包扫描器业务代码、测试和验证入口必须零差异。
- `tests/e2e/website.spec.ts` 与 `tests/playwright.website.config.ts` 必须零差异，且本计划不运行 `verify:website`。
- 旧 `tests/e2e/agent-mcp-flow.spec.ts` 只允许在有效布局覆盖迁移并通过后执行单文件删除。
- MCP Manager、Store、adapter、IPC/preload/shared type、持久化 Schema、内部测试和测试桩全部保留。
- 先 RED、再 GREEN、最后 REFACTOR；失败时不得通过删除测试、扩大 exclude 或恢复退役能力绕过。
- Git 只读；不得执行 `git add`、`commit`、`push`、建分支或其他 Git 写操作。

---

## 文件结构与职责

| 文件 | 操作 | 单一职责 |
| --- | --- | --- |
| `apps/desktop/tests/typescript-test-coverage.test.ts` | 创建 | 证明 Desktop `.ts`/`.tsx` 测试都进入 TypeScript rootNames |
| `apps/desktop/tsconfig.json` | 修改 | 补入 `tests/**/*.tsx` |
| `apps/desktop/tests/multi-provider-settings.test.ts` | 改名 | 改为 `multi-provider-settings-store.test.ts`，消除 TypeScript 同 basename 覆盖 |
| `apps/desktop/tests/desktop-e2e-entry.test.ts` | 创建 | 证明 Desktop E2E 唯一 owner 与根门禁可达性 |
| `tests/playwright.config.ts` | 修改 | 成为 Desktop E2E 文件清单唯一 owner |
| `tests/e2e/desktop-settings-layout.spec.ts` | 创建 | 保留两种视口布局检查并验证 MCP UI 隐藏 |
| `tests/e2e/desktop.spec.ts` | 修改 | 在正式 Agent 请求中验证不暴露 `mcp.*` |
| `tests/e2e/agent-mcp-flow.spec.ts` | 删除 | 移除冲突的 MCP enable 孤立测试 |
| `apps/desktop/src/renderer/src/settings/SettingsView.tsx` | 修改 | 为带文字的角色工作室按钮增加专用 class |
| `apps/desktop/src/renderer/src/styles.css` | 修改 | 修复该按钮真实文字裁剪且不放宽通用布局门禁 |
| `package.json` | 修改 | 让 `test:e2e:desktop` 只调用 Desktop Playwright 配置 |
| `docs/operations/desktop-validation-coverage-acceptance.md` | 创建 | 记录真实验证结果、未覆盖项与零差异证据 |

### Task 1: 用 rootNames 契约覆盖全部 Desktop TypeScript 测试

**Files:**
- Create: `apps/desktop/tests/typescript-test-coverage.test.ts`
- Modify: `apps/desktop/tsconfig.json`
- Rename: `apps/desktop/tests/multi-provider-settings.test.ts` → `apps/desktop/tests/multi-provider-settings-store.test.ts`
- Test: `apps/desktop/tests/typescript-test-coverage.test.ts`

**Interfaces:**
- Consumes: `ts.readConfigFile(fileName, readFile)`、`ts.parseJsonConfigFileContent(json, host, basePath).fileNames`、`apps/desktop/vitest.config.ts` 的 `tests/**/*.test.{ts,tsx}`。
- Produces: 配置不变量“`apps/desktop/tests` 下每个 `.ts` 和 `.tsx` 文件都存在于 Desktop tsconfig 的 parsed fileNames 中”；不产生生产接口。

- [ ] **Step 1: 创建递归枚举与路径规范化的失败测试**

在新文件中实现本地测试 helper。Windows 路径比较必须不区分大小写，枚举结果必须动态产生：

```ts
import { readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

function normalizePath(filePath: string): string {
  const normalized = resolve(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [entryPath] : [];
  });
}

describe('Desktop TypeScript 配置覆盖', () => {
  test('Desktop TypeScript 配置纳入 tests 下全部 .ts 与 .tsx 源码', () => {
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const configPath = resolve(desktopRoot, 'tsconfig.json');
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(loaded.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, desktopRoot);
    const rootNames = new Set(parsed.fileNames.map(normalizePath));
    const missingTestFiles = collectTypeScriptFiles(resolve(desktopRoot, 'tests'))
      .filter(filePath => !rootNames.has(normalizePath(filePath)))
      .map(filePath => relative(desktopRoot, filePath).replaceAll('\\', '/'))
      .sort();

    expect(missingTestFiles).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行定向测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/typescript-test-coverage.test.ts
```

Expected: FAIL；`missingTestFiles` 列出当前未进入 tsconfig 的 `.tsx` 测试。失败原因必须是 `tests/**/*.tsx` 缺失，而不是路径计算或配置解析错误。

- [ ] **Step 3: 用最小配置变更实现 GREEN**

在 `apps/desktop/tsconfig.json` 的 `include` 中增加一项：

```json
"tests/**/*.tsx"
```

把测试 Main `SettingsStore` 的 `apps/desktop/tests/multi-provider-settings.test.ts` 只改名为 `multi-provider-settings-store.test.ts`，不修改内容；Renderer `multi-provider-settings.test.tsx` 保持原名。该改名已由用户于 2026-08-15 批准，用于避免 TypeScript 在同 basename 下忽略 `.tsx`。不要创建新 tsconfig，不修改 Vitest include，不增加 exclude。

若纳入 `.tsx` 后暴露既有测试类型错误，按测试文件或同一类型根因拆成小聚类逐项最小修复；每个聚类受 15 分钟上限约束。不得修改生产接口来迁就测试，不得放宽 strictness、增加 exclude 或删除测试。

- [ ] **Step 4: 运行定向测试与 Desktop TypeScript 门禁**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/typescript-test-coverage.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: 两条命令均 PASS；若新纳入的 `.tsx` 暴露真实类型错误，只修正对应测试的最小类型问题，不放宽配置。

- [ ] **Step 5: REFACTOR 并复验 Desktop 单元测试**

检查 helper 只承担递归枚举和路径规范化，不把当前 12 个文件名缓存进测试。

Run:

```powershell
pnpm.cmd --filter @myself/desktop test
```

Expected: PASS。

### Task 2: 迁移有效设置布局场景并退役 MCP enable E2E

**Files:**
- Create: `tests/e2e/desktop-settings-layout.spec.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Delete: `tests/e2e/agent-mcp-flow.spec.ts`
- Test: `tests/e2e/desktop-settings-layout.spec.ts`
- Test: `tests/e2e/desktop.spec.ts`

**Interfaces:**
- Consumes: `createElectronAppFixture(options)`、设置窗口的 Playwright `Page`、旧文件中的 `assertNoHorizontalOverflow(page)`、`assertNoClippedTextOrControlOverlap(page)`、`capturePageViaCdp(page, path)`，以及 `ProviderStep.inspect(request: ModelRequest)`。
- Produces: 两个有效 Desktop E2E 文件 `desktop.spec.ts` 与 `desktop-settings-layout.spec.ts`；设置页 E2E 证明 MCP UI 不可见，正式 Agent Provider 请求证明 `mcp.*` 不可见。

- [ ] **Step 1: 创建只负责设置布局的 E2E，并先写 MCP 隐藏断言**

从旧文件复制且只复制布局所需 imports、三个布局/截图 helper、fixture 生命周期和两个 viewport 场景。测试名固定为：

```ts
test('1200x720 下设置页无横向溢出且 MCP 入口不可见', async () => {});
test('960x640 下设置页无文字或控件重叠且 MCP 入口不可见', async () => {});
```

每个场景打开设置窗口后先执行：

```ts
await expect(settingsPage.getByRole('button', { name: '工具' })).toHaveCount(0);
await expect(settingsPage.getByLabel('服务 ID')).toHaveCount(0);
await expect(settingsPage.getByRole('button', { name: '添加服务' })).toHaveCount(0);

for (const tab of ['模型', '隐私', '本地数据']) {
  await settingsPage.getByRole('button', { name: tab }).click();
  await assertNoHorizontalOverflow(settingsPage);
  await assertNoClippedTextOrControlOverlap(settingsPage);
}
```

1200×720 与 960×640 都保留失败截图；不得再点击“工具”页。

- [ ] **Step 2: 运行新布局测试确认当前行为与测试定位器**

Run:

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop-settings-layout.spec.ts
```

Expected: 两个场景 PASS；如果失败，只允许修正新测试的窗口获取、稳定定位器或布局 helper 迁移错误，不允许恢复 MCP UI。

若严格 `+1px` 裁剪门禁暴露“角色工作室”按钮真实文字裁剪，保持门禁不变：给按钮增加职责化 class，在 `styles.css` 中只覆盖为自适应宽度、44px 高度、单行文本和合理图标间距。关闭按钮继续保持 `44×44px`；不得隐藏可见文案、按名称跳过检测或提高通用容差。该范围扩展已由用户于 2026-08-15 批准。

- [ ] **Step 3: 在正式 Agent 请求检查中增加 MCP 工具不可见断言**

在 `tests/e2e/desktop.spec.ts` 已有正式文件 Agent 场景、检查 `builtin.files.list_files` 和 `builtin.files.create_file` 的 `ProviderStep.inspect` 内追加：

```ts
const names = request.tools.map(
  (tool: { function: { name: string } }) => tool.function.name
);
const mcpToolNames = names.filter(name => name.startsWith('mcp.'));

if (mcpToolNames.length > 0) {
  throw new Error('MCP 禁用时不得向 Provider 暴露 mcp.* 工具');
}
```

保留原有 builtin 文件工具断言，不能把断言替换成“所有工具都为空”。

- [ ] **Step 4: 运行正式 Agent 定向 E2E**

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "通过正式白名单完成设置、文件操作与聊天窗口状态"
```

Expected: 对应场景 PASS，且 `provider.inspectionErrors` 仍为 `[]`。

- [ ] **Step 5: 删除旧文件并完成 REFACTOR**

确认新布局测试已包含原文件末尾两个 viewport 场景后，只删除：

```text
tests/e2e/agent-mcp-flow.spec.ts
```

不得删除下列文件或能力：

```text
apps/desktop/src/main/mcp/**
apps/desktop/tests/mcp-manager.test.ts
apps/desktop/tests/desktop-settings-service.test.ts
apps/desktop/tests/multi-provider-settings.test.tsx
tests/fixtures/mcp-test-server.ts
tests/fixtures/mcp-http-test-server.ts
MCP Store / adapter / IPC / preload / shared type / 持久化 Schema
McpSettings dormant component
```

旧文件中 Provider 配置、文件确认/取消、Provider 失败/取消等重复场景不迁移；`desktop.spec.ts` 已拥有正式覆盖。删除后检查没有 E2E 引用旧文件名：

```powershell
rg -n "agent-mcp-flow|mcp\.local-tools\.echo" tests apps/desktop
```

Expected: 不再有旧 E2E 文件名或正式 E2E 的 `mcp.local-tools.echo` 引用；MCP 内部单元测试允许继续出现内部 MCP 标识。

### Task 3: 建立 E2E 唯一 owner 与 Desktop 门禁可达契约

**Files:**
- Create: `apps/desktop/tests/desktop-e2e-entry.test.ts`
- Modify: `tests/playwright.config.ts`
- Modify: `package.json`
- Read only: `tests/playwright.website.config.ts`
- Test: `apps/desktop/tests/desktop-e2e-entry.test.ts`

**Interfaces:**
- Consumes: `tests/e2e/*.spec.ts` 文件清单、Desktop/Website Playwright 配置的 `testMatch`、根 `package.json#scripts`。
- Produces: Desktop Playwright `testMatch: ['desktop.spec.ts', 'desktop-settings-layout.spec.ts']`；根 `test:e2e:desktop` 只执行 build 和 Desktop config；契约证明 `verify:desktop` 可达安全、集成和 E2E。

- [ ] **Step 1: 写 E2E owner 与门禁可达性的失败测试**

新测试读取根 `package.json`，导入 Desktop 与 Website Playwright 配置，并枚举 `tests/e2e/*.spec.ts`。实现局部 helper，把 `string | string[]` 的 `testMatch` 规范为 basename 数组。核心断言如下：

```ts
test('每个 Desktop E2E spec 恰由一个显式入口拥有且 verify:desktop 可达全部门禁', () => {
  expect(desktopMatches).toEqual([
    'desktop-settings-layout.spec.ts',
    'desktop.spec.ts'
  ]);
  expect(new Set(desktopMatches).size).toBe(desktopMatches.length);
  expect(desktopMatches).not.toContain('website.spec.ts');
  expect(websiteMatches).toContain('website.spec.ts');

  const desktopCandidates = allE2eSpecs.filter(
    fileName => !websiteMatches.includes(fileName)
  );
  expect(desktopMatches).toEqual(desktopCandidates.sort());

  expect(scripts['test:e2e:desktop']).toContain(
    'playwright test --config tests/playwright.config.ts'
  );
  expect(scripts['test:e2e:desktop']).not.toMatch(/tests\/e2e\/.*\.spec\.ts/u);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:security')).toBe(1);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:integration')).toBe(1);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:e2e:desktop')).toBe(1);
  expect(scripts['test:security']).toContain('--config tests/vitest.config.ts');
  expect(scripts['test:integration']).toContain('--config tests/vitest.config.ts');
});
```

`countCommand(script, command)` 必须按字面子串计数并返回 `number`；测试只解析配置和脚本，不启动网站测试。

- [ ] **Step 2: 运行定向测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/desktop-e2e-entry.test.ts
```

Expected: FAIL；原因是 Desktop Playwright 配置没有显式 `testMatch`，且根 `test:e2e:desktop` 仍点名单个 spec。若失败来自 Website 测试被执行，说明测试实现越界，必须改成只读配置检查。

- [ ] **Step 3: 将 Desktop E2E owner 收敛到 Playwright 配置**

在 `tests/playwright.config.ts` 的 `defineConfig` 对象中增加：

```ts
testMatch: ['desktop.spec.ts', 'desktop-settings-layout.spec.ts'],
```

不要修改 `testDir`、Electron worker 限制、超时、截图或 trace 策略。不要修改网站 Playwright 配置。

- [ ] **Step 4: 移除根脚本中的第二份文件清单**

在根 `package.json` 中将脚本精确改为：

```json
"test:e2e:desktop": "pnpm --filter @myself/desktop build && playwright test --config tests/playwright.config.ts"
```

保持现有 `verify:desktop` 内容和顺序，不加入网站、CloudBase 或 scanner 命令。

- [ ] **Step 5: 运行契约测试与 Playwright 清单检查确认 GREEN**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/desktop-e2e-entry.test.ts
pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
```

Expected: 契约 PASS；Playwright 清单只来源于 `desktop.spec.ts` 与 `desktop-settings-layout.spec.ts`，不出现 `agent-mcp-flow.spec.ts` 或 `website.spec.ts`。

- [ ] **Step 6: REFACTOR 并验证安全、集成和 Desktop E2E 入口**

不抽象全仓 catalog；只清理新测试内重复的路径规范化与 match 读取逻辑。

Run:

```powershell
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
```

Expected: 三条命令均 PASS；`test:e2e:desktop` 构建一次并执行两个 Desktop spec 文件。

### Task 4: 执行完整 Desktop 门禁并建立验收记录

**Files:**
- Create: `docs/operations/desktop-validation-coverage-acceptance.md`
- Read only: `apps/website/**`
- Read only: `tests/e2e/website.spec.ts`
- Read only: `tests/playwright.website.config.ts`
- Read only: `apps/cloudbase-api/**`
- Read only: `apps/package-scanner/**`
- Read only: `cloudbase/**`

**Interfaces:**
- Consumes: Tasks 1–3 的配置契约、两个 Desktop E2E owner、根 `verify:desktop`。
- Produces: 一份只记录实际观察结果的验收文档；不产生运行时接口。

- [ ] **Step 1: 运行完整 Desktop 门禁**

Run:

```powershell
pnpm.cmd verify:desktop
```

Expected: `typecheck`、Desktop 单元测试、安全测试、集成测试与两个 Desktop E2E 文件全部 PASS。任一步失败时，验收状态写“失败”，不得继续写成通过。

- [ ] **Step 2: 检查格式与越界差异**

Run:

```powershell
git diff --check
git diff --name-only -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase
git status --short
```

Expected: `git diff --check` 无输出；第二条命令空输出；`git status --short` 只显示本计划批准范围内的文件以及执行前已存在且已记录的用户改动。不得改动或清理用户已有文件。

- [ ] **Step 3: 创建独立验收记录**

先运行 `node --version` 与 `pnpm.cmd --version`，再创建验收文档。文档使用以下固定结构，环境行直接抄录两条命令的真实输出：

```markdown
# Desktop 验证覆盖验收记录

> 日期：2026-08-15
> 适用规格：`docs/superpowers/specs/2026-08-15-desktop-validation-coverage-design.md`
> 环境：Windows 10/11；Node.js 与 pnpm 版本见本节紧随其后的命令输出

## 1. 变更范围

记录实际创建、修改和删除的文件。

## 2. 自动化结果

逐条记录命令、退出码、通过/失败和关键输出摘要。

## 3. E2E owner 结果

记录 Desktop Playwright 实际列出的两个文件，并确认网站文件未进入 Desktop 配置。

## 4. MCP 禁用证据

记录设置页入口不可见、Provider 请求无 `mcp.*` 与现有禁用单测结果。

## 5. 零差异检查

记录网站、CloudBase、scanner 路径差异命令的实际空输出。

## 6. 未覆盖项

没有执行的人工或环境相关验证写“未验证”，不写成通过。
```

- [ ] **Step 4: 复核运行结果与验收措辞**

逐项确认验收记录中的每个“通过”都有本轮命令输出支撑；旧验收记录和计划目标不能作为当前结果。确认没有把网站、CloudBase 或 scanner 写成已运行通过，只能写“业务文件零差异，未运行其门禁”。

- [ ] **Step 5: 最终只读自检**

Run:

```powershell
rg -n "MCP_MODULE_DISABLED|desktopRuntimeCapabilities|agent-mcp-flow|desktop-settings-layout" apps/desktop tests docs/operations/desktop-validation-coverage-acceptance.md
git diff --check
git status --short
```

Expected: MCP 禁用契约仍存在；旧 E2E 文件名只允许出现在历史规格/计划或验收说明中，不得存在对应文件；新布局 E2E 有唯一 owner；差异检查无格式错误；未发生 Git 写操作。

## Task 4 修复轮 1：Desktop Vitest 门禁稳定性例外

用户已于 2026-08-15 批准以下最小稳定性例外：本机有 24 个逻辑 CPU，Desktop 文件级默认并发会随机触发多个 5 秒超时；仅在 `apps/desktop/vitest.config.ts` 设置 `test.maxWorkers: 4`，不得提高 `testTimeout`、增加重试或改变其他测试入口。

1. 先通过 Vitest 3.2.7 本地 `--help` 与 `resolveConfig` 核验 `maxWorkers` 可用，确认修改前的实际解析值为 `undefined`。
2. 新增 `apps/desktop/tests/vitest-worker-cap.test.ts`，使用 `resolveConfig` 断言已解析 `vitestConfig.maxWorkers` 为 4；先运行并确认 RED 的原因是未设置 worker 上限。
3. GREEN 仅在 `apps/desktop/vitest.config.ts` 的 `test` 对象加入 `maxWorkers: 4`，再运行定向契约测试及 Desktop typecheck。
4. 运行一次独立 `pnpm.cmd test:unit` 和一次完整 `pnpm.cmd verify:desktop`，两次结果均如实记录；不得用定向复跑替代失败的完整门禁。
5. 仅在 `git diff --check` 与网站、CloudBase、scanner 零差异检查后提交；验收记录保留此前失败时间线、RED/GREEN 与本轮真实结果。

## 完成定义

- Desktop `.ts` 与 `.tsx` 测试全部进入 TypeScript 检查，动态 rootNames 契约通过。
- 旧 MCP enable E2E 已在有效布局覆盖迁移后单文件删除。
- 设置页两种视口不显示 MCP 入口且布局检查通过。
- 正式 Agent Provider 请求不含 `mcp.*` 工具。
- 每个有效 Desktop E2E 文件恰好有一个 Playwright owner。
- 根 `test:e2e:desktop` 不再点名单个 spec；`verify:desktop` 实际到达安全、集成与 Desktop E2E。
- MCP dormant source、内部测试和测试桩完整保留。
- 验收记录只描述本轮实际执行结果和未覆盖项。
- 网站、CloudBase、包扫描器及其测试和验证入口保持零差异。
