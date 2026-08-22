# 桌面端 MCP 正式运行链清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 MCP 内部源码、测试和持久化数据的前提下，物理删除桌面端正式 API、Preload、IPC、Renderer、Main、Agent seam 与生产 bundle 中的 MCP 运行链。

**Architecture:** 按 Renderer、共享可信边界、Main 生命周期、依赖与产物门禁的顺序做减法，每个阶段先用失败测试证明旧入口仍存在，再删除只服务旧正式路径的实现与测试。`src/main/mcp` 只作为由单元测试直接引用的内部开发模块保留；持久化 schema 继续兼容既有数据，但正式生产图不调用 MCP 专用读写。

**Tech Stack:** TypeScript 5.9、Electron 43、React 19、Vitest 3、Playwright 1.61、pnpm 11、Windows 10/11。

## Global Constraints

- 现行规格为 [桌面端 MCP 正式运行链清理设计](../specs/2026-08-22-desktop-mcp-production-chain-removal-design.md)。
- 本计划只替代 2026-07-31 旧规格与旧计划中的 MCP 保留入口条款；旧拖拽设计与实现继续有效。
- 严格执行 RED → GREEN → REFACTOR；RED 必须因目标正式入口仍存在而失败。
- 使用子智能体逐任务实施；每个任务由新实现者完成，再由独立审查者做规格与质量复审。
- 只做最小减法；正式入口删除后不保留恒 `false` UI、API、IPC、服务方法、空 Manager 或兼容别名。
- 保留 `apps/desktop/src/main/mcp`、Manager/Store/Adapter 单元测试、测试 Server、SettingsStore MCP schema/data 和持久化测试。
- `@modelcontextprotocol/sdk` 固定版本 `1.29.0`，只从 desktop `dependencies` 移到 `devDependencies`，不新增框架或运行时。
- 普通设置整体原子重写必须逻辑保留 `mcpServers`；用户明确“清除全部本地数据”仍可清除全部设置与 Secret，包括 MCP。
- 不把生产门禁泛化为任意 `mcp` 字符串扫描，只检查规格列出的正式入口标记。
- 不修改拖拽、角色行为、桌宠缩放、碰撞体积、文件能力、Provider 协议或角色工作台。
- 中文文档、测试名称与结构性注释使用中文；代码标识符与协议字段保留英文。
- 每个任务先运行定向测试，再运行该任务影响范围的回归；最终执行 `pnpm.cmd verify:desktop`。
- 每个任务独立提交；禁止夹带其他任务或用户已有改动。

---

### Task 1: 删除 Renderer MCP 设置路径

**Files:**

- Delete: `apps/desktop/src/renderer/src/settings/McpSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Create: `apps/desktop/tests/renderer-mcp-production-boundary.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Modify: `apps/desktop/tests/settings-toast.dom.test.tsx`

**Interfaces:**

- Consumes: 当前 `SettingsDashboardDto` 暂时仍含 `mcpServers`；Task 1 不改共享 API。
- Produces: `SettingsTab = 'models' | 'privacy' | 'local'`；`SettingsWorkspaceProps` 不含 `mcpActions`；Renderer 不再导入或渲染 `McpSettings`。

- [ ] **Step 1: 写 Renderer 物理删除失败测试**

创建 `renderer-mcp-production-boundary.test.ts`，从仓库源文件验证正式 Renderer 图：

```ts
import { access, readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const settingsViewUrl = new URL(
  '../src/renderer/src/settings/SettingsView.tsx',
  import.meta.url
);
const mcpSettingsUrl = new URL(
  '../src/renderer/src/settings/McpSettings.tsx',
  import.meta.url
);

describe('Renderer MCP 正式生产边界', () => {
  test('设置入口不再引用 MCP 组件、回调或恒假能力开关', async () => {
    const source = await readFile(settingsViewUrl, 'utf8');
    expect(source).not.toMatch(/McpSettings|mcpActions|McpLaunch|desktopRuntimeCapabilities/u);
    expect(source).not.toMatch(/['"]tools['"]/u);
    await expect(access(mcpSettingsUrl)).rejects.toThrow();
  });
});
```

该测试只约束正式入口文件，不扫描保留的 Main 内部模块。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/renderer-mcp-production-boundary.test.ts
```

Expected: FAIL，失败明确显示 `SettingsView.tsx` 仍含 MCP import/Props/标签，且 `McpSettings.tsx` 仍存在。

- [ ] **Step 3: 将设置工作区收敛为三类标签**

在 `SettingsView.tsx` 做以下最小删除：

```ts
import { Bot, Box, Database, ShieldCheck, X } from 'lucide-react';

export type SettingsTab = 'models' | 'privacy' | 'local';

const tabs = [
  ['models', '模型', Bot],
  ['privacy', '隐私', ShieldCheck],
  ['local', '本地数据', Database]
] as const;

export function availableSettingsTabs(): readonly SettingsTab[] {
  return tabs.map(([id]) => id);
}
```

同时：

- 删除 `McpServerInput`、`McpSettings`、`McpLaunchConfirmation` 与能力常量 import；
- 删除 `SettingsWorkspaceProps.mcpActions`；
- 删除 `resolveSettingsTab()`，`activeTab` 直接使用 `props.activeTab`；
- 删除 `McpSettings` 渲染分支；
- 删除 `launchSummary` 状态和整段 `mcpActions` 回调；
- `onTabChange` 直接 `setActiveTab(tab)`；
- 暂时保留 `emptyDashboard.mcpServers: []`，由 Task 2 随共享 DTO 一起删除。

- [ ] **Step 4: 删除 MCP 组件和专用样式**

删除 `McpSettings.tsx`。清理 `styles.css` 时逐个处理组合选择器：

- 从共享组合中只移除 `.server-actions`、`.safety-inline`、`.tool-row`、`.mcp-*`、`.server-*`、`.tool-*` 成员；
- 删除只服务 MCP 状态、启动摘要和服务卡片的独立规则；
- `.settings-tabs` 改为三列；
- 保留隐私页仍使用的 `.segmented-control`；
- 保留角色工作台仍使用的 `.dialog-actions`；
- 不重排其余 CSS。

- [ ] **Step 5: 删除只服务旧 Renderer 入口的测试并补三标签契约**

在 `multi-provider-settings.test.tsx`：

- 删除 `McpSettings` import；
- 删除“MCP 展示状态”和“stdio 启动摘要”两条测试；
- 将旧 `tools` 回退测试替换为：

```ts
test('设置导航只公开三个现行分类', () => {
  expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);
});
```

从所有 `SettingsWorkspace` fixture 删除 `mcpActions`。同步更新 `renderer-components.test.tsx` 与 `settings-toast.dom.test.tsx`，只删除 MCP Props，不改变 Provider、隐私、Toast 或角色工作台断言。

- [ ] **Step 6: 运行 Renderer 定向测试确认 GREEN**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/renderer-mcp-production-boundary.test.ts `
  tests/multi-provider-settings.test.tsx `
  tests/renderer-components.test.tsx `
  tests/settings-toast.dom.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: PASS；类型检查不再需要 `mcpActions`，Renderer 边界测试证明组件文件和正式 import 已删除。

- [ ] **Step 7: 检查 Task 1 删除范围**

Run:

```powershell
git diff --check
git diff -- apps/desktop/src/renderer apps/desktop/tests/renderer-mcp-production-boundary.test.ts apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/settings-toast.dom.test.tsx
```

Expected: 没有修改共享 API、Preload、IPC、Main、拖拽、角色或文件能力；组合 CSS 未误删共享规则。

- [ ] **Step 8: 提交 Task 1**

```powershell
git add apps/desktop/src/renderer/src/settings apps/desktop/src/renderer/src/styles.css apps/desktop/tests/renderer-mcp-production-boundary.test.ts apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/settings-toast.dom.test.tsx
git commit -m "refactor(desktop): 删除 MCP Renderer 路径"
```

---

### Task 2: 物理删除共享 API、Preload 与 IPC 入口

**Files:**

- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/tests/preload-production-boundary.test.ts`
- Modify: `apps/desktop/tests/preload-api.test.ts`
- Modify: `apps/desktop/tests/advanced-settings-ipc.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Modify: `apps/desktop/tests/settings-toast.dom.test.tsx`
- Modify: `apps/desktop/tests/desktop-settings-service.test.ts`

**Interfaces:**

- Consumes: Task 1 已删除 Renderer 的 `mcpActions` 和 `tools` 分支。
- Produces: `SettingsDashboardDto` 不含 `mcpServers`；`MyselfApi` 与正式 preload 不含 8 个 MCP 方法；`ipcChannels` 和 `registerAdvancedSettingsIpc` 不含 8 个 MCP channel/handler。

- [ ] **Step 1: 为正式 Preload 与 IPC 写失败断言**

在 `preload-production-boundary.test.ts` 增加精确旧键表：

```ts
const removedMcpKeys = [
  'upsertMcpServer',
  'confirmMcpLaunch',
  'testMcpServer',
  'setMcpServerEnabled',
  'setMcpToolEnabled',
  'authorizeMcpToolReadOnly',
  'revokeMcpToolReadOnly',
  'deleteMcpServer'
] as const;

test('生产 preload 不公开 MCP 方法', () => {
  expect(Object.keys(exposedApi ?? {})).not.toEqual(
    expect.arrayContaining([...removedMcpKeys])
  );
});
```

在 `advanced-settings-ipc.test.ts` 使用注册 fixture 的 handler Map 断言以下值全部不存在：

```ts
const removedChannels = [
  'settings:mcp-upsert',
  'settings:mcp-confirm-launch',
  'settings:mcp-test',
  'settings:mcp-server-toggle',
  'settings:mcp-tool-toggle',
  'settings:mcp-tool-authorize-read',
  'settings:mcp-tool-revoke-read',
  'settings:mcp-delete'
];

for (const channel of removedChannels) expect(handlers.has(channel)).toBe(false);
```

- [ ] **Step 2: 运行边界测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/preload-production-boundary.test.ts `
  tests/advanced-settings-ipc.test.ts
```

Expected: FAIL；公开 API 仍有 8 个方法，handler Map 仍有 8 个旧 channel。

- [ ] **Step 3: 删除共享 DTO、方法与 channel**

在 `myself-api.ts` 删除：

- `McpToolDto`、`McpServerDto`、`McpServerInput`、`McpLaunchSummaryDto`；
- `SettingsDashboardDto.mcpServers`；
- `MyselfApi` 的 8 个 MCP 方法。

在 `ipc-channels.ts` 删除 `settingsMcpUpsert` 至 `settingsMcpDelete` 的 8 个成员，不保留别名或注释占位。

- [ ] **Step 4: 删除正式 Preload 转发**

在 `preload/index.ts` 删除 `McpServerInput` 类型导入和 8 个方法实现。保持其余 API 的既有顺序；`preload-api.test.ts` 的公开键精确列表同步删除这 8 项，并从“高级设置固定白名单”测试删除 MCP 正向调用与调用序号断言。

- [ ] **Step 5: 删除高级设置 IPC 的 MCP Schema 与 handler**

在 `register-ipc.ts` 删除：

- `serverIdSchema`、stdio/http transport、`mcpUpsertSchema`、确认、切换与授权 Schema；
- `AdvancedSettingsIpcService` 的 8 个 MCP 方法；
- `registerAdvancedSettingsIpc()` 的 8 个 MCP `replaceHandler()` 调用。

在 `advanced-settings-ipc.test.ts` 删除旧 MCP 成功转发测试和 service mock 方法，只保留“handler 不注册”的产品边界测试及其他高级设置覆盖。

- [ ] **Step 6: 同步 Dashboard 消费者和 fixture**

从以下 fixture 删除 `mcpServers`：

```text
apps/desktop/src/renderer/src/settings/SettingsView.tsx
apps/desktop/tests/multi-provider-settings.test.tsx
apps/desktop/tests/renderer-components.test.tsx
apps/desktop/tests/settings-toast.dom.test.tsx
apps/desktop/tests/desktop-settings-service.test.ts
```

`DesktopSettingsService.getDashboard()` 的字段删除留在 Task 3；Task 2 期间应在同一任务内最小删除该返回对象的 `mcpServers` 属性以恢复共享契约编译，但不改其他 MCP 服务职责。Task 3 再删除完整 Main 运行路径。

- [ ] **Step 7: 运行共享边界定向回归**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/preload-production-boundary.test.ts `
  tests/preload-api.test.ts `
  tests/advanced-settings-ipc.test.ts `
  tests/multi-provider-settings.test.tsx `
  tests/renderer-components.test.tsx `
  tests/settings-toast.dom.test.tsx `
  tests/desktop-settings-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: PASS；公开键与 handler Map 无 MCP，全部 Dashboard fixture 与新 DTO 一致。

- [ ] **Step 8: 提交 Task 2**

```powershell
git add apps/desktop/src/shared/myself-api.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/tests/preload-production-boundary.test.ts apps/desktop/tests/preload-api.test.ts apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/settings-toast.dom.test.tsx apps/desktop/tests/desktop-settings-service.test.ts
git commit -m "refactor(desktop): 删除 MCP 公开接口"
```

---

### Task 3: 删除 Main 实例化、设置服务和未消费 Agent seam

**Files:**

- Create: `apps/desktop/src/main/mcp/mcp-risk-resolver.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Delete: `apps/desktop/src/shared/desktop-runtime-capabilities.ts`
- Modify: `apps/desktop/tests/desktop-settings-service.test.ts`
- Modify: `apps/desktop/tests/mcp-manager.test.ts`
- Modify: `apps/desktop/tests/main-conversation-composition.test.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `SettingsDashboardDto`、`MyselfApi` 与 `AdvancedSettingsIpcService` 已无 MCP。
- Produces: `DesktopSettingsServiceOptions` 只含普通设置、Secret、Provider、隐私会话、置顶回调；`MainConversationAgentSnapshot<TPrivacy>` 不含 `enabledReadTools`；正式 Main 不实例化 MCP。

- [ ] **Step 1: 写 Main 生产图失败测试**

在 `desktop-settings-service.test.ts` 增加结构断言，使用当前 fixture options 的键证明目标边界：

```ts
test('正式设置服务依赖不含 MCP Manager 或 Store', () => {
  const optionKeys = Object.keys(createFixture().options);
  expect(optionKeys).not.toEqual(expect.arrayContaining(['mcpStore', 'mcpManager']));
});
```

如果 `createFixture()` 当前不公开 `options`，只为测试返回其原始 options，不新增生产探针。

在 `main-conversation-composition.test.ts` 将期望快照改为：

```ts
expect(harness.factoryInputs[0]?.snapshot).toEqual({
  providerSettings: harness.providerSettings,
  authorizedRootPath: harness.authorizedRoot,
  taskKind: 'file',
  privacySettings: harness.privacySettings
});
expect(harness.options).not.toHaveProperty('readEnabledReadTools');
```

- [ ] **Step 2: 运行 Main 目标测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/desktop-settings-service.test.ts `
  tests/main-conversation-composition.test.ts
```

Expected: FAIL；设置服务 fixture 仍需要 Manager/Store，会话快照仍含 `enabledReadTools`。

- [ ] **Step 3: 将风险解析器归入 MCP 内部模块**

创建 `mcp-risk-resolver.ts`：

```ts
import type { ToolRisk } from '@myself/agent-core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mcpToolDefinitionFingerprint } from './mcp-tool-adapter';

export type TrustedMcpFingerprintLookup = (
  serverId: string,
  toolName: string
) => string | undefined;

/** 该解析器只服务保留的 MCP 内部适配器测试，不进入正式设置或 Agent 图。 */
export function createTrustedMcpRiskResolver(
  trustedFingerprint: TrustedMcpFingerprintLookup
): (serverId: string, tool: Tool) => ToolRisk {
  return (serverId, tool) => (
    trustedFingerprint(serverId, tool.name) === mcpToolDefinitionFingerprint(tool)
      ? 'read'
      : 'recoverable'
  );
}
```

把 `desktop-settings-service.test.ts` 中两条风险解析测试迁到 `mcp-manager.test.ts`，从新内部文件导入。删除设置服务对 SDK 类型与 Adapter 的 import。

- [ ] **Step 4: 删除 DesktopSettingsService 的 MCP 职责**

从 `desktop-settings-service.ts` 删除：

- `SettingsAccess` 的 MCP 专用方法；
- `McpManagerAccess`、`mcpStore`、`mcpManager` Options；
- `McpServerDto`、状态表、发现工具表、MCP 配置与 Secret 解析 helper；
- `initialize()` 的 MCP 恢复逻辑；若删除后方法为空，同时删除方法和 Main 调用；
- 全部 MCP upsert、确认、测试、切换、授权、撤销、删除、工具读取与执行方法；
- `MCP_MODULE_DISABLED` 守卫与能力常量 import；
- `close()` 中的 Manager close，只保留隐私会话注销与已有非 MCP 清理。

删除 `desktop-settings-service.test.ts` 中只验证 MCP 启用、恒假守卫、空 Dashboard 和 Manager close 的测试；保留 Provider、隐私、置顶、授权根、配置失效和失败恢复测试。

- [ ] **Step 5: 删除 Main 启动与退出接线**

在 `main/index.ts` 删除：

- `McpServerStore`、`McpManager`、`createTrustedMcpRiskResolver` import；
- Store/Manager 构造、风险解析注入和 SettingsService Options；
- 空 `initialize()` 调用；
- `readEnabledReadTools` 接线；
- 只服务 Manager 的启动失败与退出清理。

不要删除 `DesktopSettingsService.close()` 的隐私会话生命周期调用。

- [ ] **Step 6: 删除会话中的未消费外部工具 seam**

把会话类型收敛为：

```ts
export type MainConversationAgentSnapshot<TPrivacy> = Readonly<{
  taskKind: CapabilityTaskKind;
  providerSettings: ProviderSettingsSnapshot;
  authorizedRootPath: string;
  privacySettings: TPrivacy;
}>;
```

同步删除 `MainConversationCompositionOptions.readEnabledReadTools`、`TReadTool` 泛型、`Promise.all` 的第四项和快照字段。更新 `main-conversation-composition.test.ts`、`tests/integration/desktop-agent.test.ts`、`tests/security/permission-boundary.test.ts` 的 fixture；删除只验证该历史 seam 读取/不读取的断言，不改变授权根、普通聊天与文件任务的安全断言。

删除 `conversation-coordinator.test.ts` 对 `desktopRuntimeCapabilities.mcp` 的恒假断言，再删除 `desktop-runtime-capabilities.ts`。

- [ ] **Step 7: 运行 Main、内部 MCP 与纵向回归**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/desktop-settings-service.test.ts `
  tests/main-conversation-composition.test.ts `
  tests/conversation-coordinator.test.ts `
  tests/mcp-manager.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts `
  tests/security/permission-boundary.test.ts `
  tests/integration/desktop-agent.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: PASS；MCP 内部 Manager/Adapter 测试保留，正式设置与会话类型不再依赖 MCP，普通聊天和文件任务纵向行为无回归。

- [ ] **Step 8: 用精确源码查询检查正式 Main 图**

Run:

```powershell
rg -n "McpManager|McpServerStore|MCP_MODULE_DISABLED|enabledReadTools|readEnabledReadTools|settingsMcp" `
  apps/desktop/src/main/index.ts `
  apps/desktop/src/main/settings `
  apps/desktop/src/main/conversation `
  apps/desktop/src/preload `
  apps/desktop/src/shared `
  apps/desktop/src/renderer
```

Expected: 无输出。该查询不包含 `apps/desktop/src/main/mcp`、持久化 schema 或测试目录。

- [ ] **Step 9: 提交 Task 3**

```powershell
git add apps/desktop/src/main/mcp/mcp-risk-resolver.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/src/main/conversation/main-conversation-composition.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/desktop-runtime-capabilities.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/tests/mcp-manager.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/conversation-coordinator.test.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts
git commit -m "refactor(desktop): 删除 MCP Main 运行链"
```

---

### Task 4: 将 SDK 移入开发依赖并建立生产 bundle 门禁

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/scripts/verify-production-mcp-boundary.mjs`
- Create: `apps/desktop/tests/production-mcp-boundary.test.ts`
- Modify: `apps/desktop/tests/package-config.test.ts`

**Interfaces:**

- Consumes: Task 1 至 Task 3 已从正式源码依赖图删除 MCP import 与入口。
- Produces: `pnpm.cmd --filter @myself/desktop build` 在现有 preload 校验后追加精确 MCP 产物校验；SDK 仅为开发依赖。

- [ ] **Step 1: 写依赖分类与构建门禁失败测试**

在 `package-config.test.ts` 读取 desktop `package.json` 并增加：

```ts
expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
expect(pkg.devDependencies?.['@modelcontextprotocol/sdk']).toBe('1.29.0');
expect(pkg.scripts.build).toContain('verify-production-mcp-boundary.mjs');
```

创建 `production-mcp-boundary.test.ts`，在临时目录写入 Main、Preload、Renderer 三类假 bundle，通过 `execFile(process.execPath, [script, root])` 验证：

```ts
await expect(runVerifier(cleanFixture)).resolves.toMatchObject({ code: 0 });
await expect(runVerifier(mainSdkFixture)).rejects.toMatchObject({ code: 1 });
await expect(runVerifier(preloadMethodFixture)).rejects.toMatchObject({ code: 1 });
await expect(runVerifier(rendererUiFixture)).rejects.toMatchObject({ code: 1 });
```

失败输出只断言包含产物类型和标记名，不包含整段假 bundle。

- [ ] **Step 2: 运行配置测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/production-mcp-boundary.test.ts
```

Expected: FAIL；SDK 仍是生产依赖、构建脚本没有门禁、校验脚本尚不存在。

- [ ] **Step 3: 实现精确产物校验脚本**

创建 `verify-production-mcp-boundary.mjs`，允许第一个 CLI 参数覆盖产物根，默认使用 `apps/desktop/out`。固定规则如下：

```js
const rules = {
  main: [
    '@modelcontextprotocol/sdk',
    'McpManager',
    'McpServerStore',
    'MCP_MODULE_DISABLED',
    'settings:mcp-'
  ],
  preload: [
    'settings:mcp-',
    'upsertMcpServer',
    'confirmMcpLaunch',
    'testMcpServer',
    'setMcpServerEnabled',
    'setMcpToolEnabled',
    'authorizeMcpToolReadOnly',
    'revokeMcpToolReadOnly',
    'deleteMcpServer'
  ],
  renderer: ['upsertMcpServer', 'MCP 服务', '.mcp-server']
};
```

脚本递归读取：

```text
out/main
out/preload
out/renderer
```

只扫描普通文件；命中时输出 `MCP_PRODUCTION_BOUNDARY_FAILED <kind> <marker>` 并设 `process.exitCode = 1`。不打印文件正文、整段 bundle 或任意用户数据。

- [ ] **Step 4: 移动依赖并接入构建**

在 `apps/desktop/package.json`：

- 从 `dependencies` 删除 `@modelcontextprotocol/sdk`；
- 在 `devDependencies` 增加同版本 `1.29.0`；
- 把 `build` 改为：

```json
"build": "electron-vite build && node scripts/verify-preload-bundle.mjs && node scripts/verify-production-mcp-boundary.mjs"
```

运行锁文件更新命令，不手工重写 lock：

```powershell
pnpm.cmd install --lockfile-only
```

Expected: `pnpm-lock.yaml` 的 desktop importer 将 SDK 从 `dependencies` 移到 `devDependencies`，版本不变。

- [ ] **Step 5: 运行脚本测试与真实生产构建**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/production-mcp-boundary.test.ts
pnpm.cmd --filter @myself/desktop build
```

Expected: PASS；真实 Main、Preload、Renderer 产物不含规则表中的禁止标记。

- [ ] **Step 6: 确认保留的内部模块仍可编译和测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/mcp-manager.test.ts tests/settings-store.test.ts tests/multi-provider-settings-store.test.ts
```

Expected: PASS；devDependency 足以支撑 TypeScript 与保留模块测试，SettingsStore 格式未删除。

- [ ] **Step 7: 提交 Task 4**

```powershell
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/scripts/verify-production-mcp-boundary.mjs apps/desktop/tests/production-mcp-boundary.test.ts apps/desktop/tests/package-config.test.ts
git commit -m "build(desktop): 阻止 MCP 进入生产产物"
```

---

### Task 5: 验证持久化、Electron 边界并更新验收记录

**Files:**

- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings-store.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/e2e/desktop-settings-layout.spec.ts`
- Modify: `docs/operations/lightweight-agent-acceptance.md`

**Interfaces:**

- Consumes: Task 1 至 Task 4 的单一正式路径与构建门禁。
- Produces: 普通设置重写保留 MCP 数据、全量清除例外、真实 Electron API/UI/Agent 边界和完整质量门禁的当前证据。

- [ ] **Step 1: 先写共享设置保留 characterization 测试**

在 `settings-store.test.ts` 预置一条完整 `mcpServers`，依次执行普通设置写入并在每次后读取完整隔离文件：

```ts
const preservedMcpServers = [mcpServerFixture()];

await store.savePrivacySettings(nextPrivacy);
expect(await store.getMcpServerSettings()).toEqual(preservedMcpServers);

await store.savePetAlwaysOnTop(true);
expect(await store.getMcpServerSettings()).toEqual(preservedMcpServers);

await store.saveAuthorizedRoot(rootFixture);
expect(await store.getMcpServerSettings()).toEqual(preservedMcpServers);
```

在 `multi-provider-settings-store.test.ts` 覆盖：

```ts
await store.saveProviderProfile(profileFixture);
await store.saveModelRoute(routeFixture);
expect(await store.getMcpServerSettings()).toEqual(preservedMcpServers);
```

测试比较逻辑结构，不比较整个 `settings.json` 字节。

- [ ] **Step 2: 明确全量清除例外**

补足或收紧现有 `clearAll` 测试：

```ts
await store.clearAll();
expect(await store.getMcpServerSettings()).toEqual([]);
```

同时保留 IPC/SecretStore 既有测试，证明 `scope: 'all'` 会调用 `settings.clearAll()` 和 `secrets.clearAll()`，而单 Provider Secret 清除不调用全量清除。

- [ ] **Step 3: 运行持久化测试并判定结果**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/settings-store.test.ts `
  tests/multi-provider-settings-store.test.ts `
  tests/settings-ipc.test.ts `
  tests/provider-secret-vault.test.ts
```

Expected: PASS。若新 characterization 失败，先修复普通写入丢失 `mcpServers` 的最小原因；不得新增 MCP 专用迁移、启动读取或特殊清理。

- [ ] **Step 4: 增加 Electron 正式 API 边界断言**

在 `desktop.spec.ts` 的正式 preload 上下文中读取：

```ts
const apiKeys = await settingsWindow.evaluate(() => Object.keys(window.myself));
expect(apiKeys).not.toEqual(expect.arrayContaining([
  'upsertMcpServer',
  'confirmMcpLaunch',
  'testMcpServer',
  'setMcpServerEnabled',
  'setMcpToolEnabled',
  'authorizeMcpToolReadOnly',
  'revokeMcpToolReadOnly',
  'deleteMcpServer'
]));
```

保留已有 Provider 工具名称不含 `mcp__` 的断言。不要向正式 preload 新增探针；复用现有窗口发现与 E2E 参数。

- [ ] **Step 5: 收紧设置页三标签 E2E**

在 `desktop-settings-layout.spec.ts` 的 720×620 与 640×520 两条用例中，把“入口不可见”收紧为：

- 导航按钮文本精确为 `模型`、`隐私`、`本地数据`；
- 不存在 `工具` 按钮；
- 页面不含 `MCP 服务` 表单；
- 原有无横向溢出、无重叠断言继续通过。

所有等待使用 Playwright locator 或 `expect.poll()`；不增加固定休眠。

- [ ] **Step 6: 运行目标 Electron E2E**

Run:

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts `
  tests/e2e/desktop.spec.ts `
  tests/e2e/desktop-settings-layout.spec.ts `
  --grep "MCP|设置页"
```

Expected: PASS；正式 preload 无 MCP key，设置页精确三标签，Agent 工具表无 MCP。若现有测试标题不匹配 grep，先使用 `--list` 确认标题，再按精确标题运行；不得把零匹配写为通过。

- [ ] **Step 7: 执行完整桌面门禁**

Run:

```powershell
pnpm.cmd verify:desktop
```

Expected: 全仓 typecheck、单元、安全、集成、生产构建、精确 MCP bundle 门禁和全部 Electron E2E 退出 0。记录实际通过/跳过数量，不预填数字。

- [ ] **Step 8: 检查保留项、删除项和越界修改**

Run:

```powershell
rg -n "@modelcontextprotocol/sdk|McpManager|MCP_MODULE_DISABLED|settings:mcp-|upsertMcpServer" `
  apps/desktop/out/main `
  apps/desktop/out/preload `
  apps/desktop/out/renderer
rg -n "mcpServerSettingsSchema|getMcpServerSettings|saveMcpServerSettings|deleteMcpServerSettings" `
  apps/desktop/src/main/storage/settings-store.ts `
  apps/desktop/tests/settings-store.test.ts
git diff --check
git status --short
git diff --stat
```

Expected:

- 第一条查询无输出；
- 第二条查询仍能看到持久化 schema、内部访问器和测试；
- `src/main/mcp` 与内部测试仍存在；
- 差异不含拖拽、角色、缩放、文件能力或角色工作台实现。

- [ ] **Step 9: 更新验收记录**

在 `docs/operations/lightweight-agent-acceptance.md` 新增“2026-08-22 MCP 正式运行链清理验收”小节，只记录本轮实际执行结果：

- 起始与实现提交；
- 每条 RED 的真实失败原因；
- 定向测试、持久化测试、构建门禁与 `verify:desktop` 的命令、退出码和数量；
- 自动证明的 API、IPC、Main、Agent、依赖与 bundle 边界；
- 保留的源码、测试和持久化语义；
- 开发态 Windows 人工观察结果；若未执行则明确“待用户人工确认”；
- 安装包未构建，明确“待正式打包阶段确认”，不得写成通过。

同步修正同文档旧的“正式 preload 仍存在 MCP 方法”未完成项，改为指向本轮实际证据，避免两个有效结论冲突。

- [ ] **Step 10: 提交 Task 5**

```powershell
git add apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts tests/e2e/desktop.spec.ts tests/e2e/desktop-settings-layout.spec.ts docs/operations/lightweight-agent-acceptance.md
git commit -m "test(desktop): 验收 MCP 正式链清理"
```

- [ ] **Step 11: 请求最终代码审查**

使用 `requesting-code-review` 对本计划起始提交到 Task 5 HEAD 的固定范围复审：

- 规格覆盖：正式 API/Preload/IPC/Renderer/Main/Agent/依赖/bundle 是否全部删除；
- 保留边界：`src/main/mcp`、内部测试和持久化 schema/data 是否保留；
- 持久化：普通原子重写是否逻辑保留 `mcpServers`，全量清除例外是否准确；
- 减法收口：是否仍有恒假开关、空回调、弃用别名或第二条正式路径；
- 测试事实：验收记录是否只声明实际运行和观察到的结果；
- 越界：是否夹带拖拽、角色、缩放、文件能力、Provider 或工作台改动。

审查发现问题时，先增加或收紧最小失败测试，再由一个修复子智能体处理，并由同一审查者复核；不得跳过完整桌面门禁。
