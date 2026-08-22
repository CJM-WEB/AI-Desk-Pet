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
- 本线程用户已明确授权本计划内的 Git 写入和逐任务提交，无需再次逐项确认；若用户撤回授权，立即停止后续提交并保留当前工作区供用户决定。

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
- Test: `apps/desktop/tests/explorer-layer-production-boundary.test.ts`

**Interfaces:**

- Consumes: 当前 `SettingsDashboardDto` 暂时仍含 `mcpServers`；Task 1 不改共享 API，并将该字段保留到 Task 3 与服务实现一次收口。
- Produces: `SettingsTab = 'models' | 'privacy' | 'local'`；`SettingsWorkspaceProps` 不含 `mcpActions`；Renderer 不再导入或渲染 `McpSettings`。

- [ ] **Step 1: 写 Renderer 物理删除失败测试**

先在 `multi-provider-settings.test.tsx` 增加类型契约：

```ts
expectTypeOf<'tools'>().not.toMatchTypeOf<SettingsTab>();
expectTypeOf<SettingsWorkspaceProps>().not.toHaveProperty('mcpActions');
```

该断言配合 `pnpm.cmd --filter @myself/desktop typecheck` 是 Task 1 的主 RED。另创建 `renderer-mcp-production-boundary.test.ts` 作为源码定位辅助，只检查 MCP 专属标记和组件文件：

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
    await expect(access(mcpSettingsUrl)).rejects.toThrow();
  });
});
```

该辅助测试只约束正式入口文件，不扫描保留的 Main 内部模块，也不把通用 `tools` 文案当作 MCP 证据。最终主证据由组件契约、typecheck、Task 4 bundle 和 Task 5 E2E 共同构成。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/renderer-mcp-production-boundary.test.ts
```

Expected: typecheck 因 `SettingsTab` 仍接纳 `tools` 或 Props 仍含 `mcpActions` 而失败；辅助测试同时显示 MCP import/Props 和 `McpSettings.tsx` 仍存在。不得只以源码正则失败作为 RED。

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
- 暂时保留 `emptyDashboard.mcpServers: []`，由 Task 3 随共享 DTO 与服务实现一起删除。

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
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explorer-layer-production-boundary.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: PASS；类型检查不再需要 `mcpActions`，Renderer 辅助边界证明组件文件和正式 import 已删除，Explorer 生产边界无回归。

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

**Interfaces:**

- Consumes: Task 1 已删除 Renderer 的 `mcpActions` 和 `tools` 分支。
- Produces: `MyselfApi` 与正式 preload 不含 8 个 MCP 方法；`ipcChannels` 和 `registerAdvancedSettingsIpc` 不含 8 个 MCP channel/handler。MCP DTO、`SettingsDashboardDto.mcpServers`、Dashboard fixture 与 `DesktopSettingsService` 暂时不变，留给 Task 3 单次收口。

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
  const apiKeys = new Set(Object.keys(exposedApi ?? {}));
  for (const key of removedMcpKeys) expect(apiKeys.has(key)).toBe(false);
  expect(removedMcpKeys.filter(key => apiKeys.has(key))).toEqual([]);
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

- [ ] **Step 3: 删除共享调用方法与 channel**

在 `myself-api.ts` 只删除 `MyselfApi` 的 8 个 MCP 方法。保留 `McpToolDto`、`McpServerDto`、`McpServerInput`、`McpLaunchSummaryDto` 与 `SettingsDashboardDto.mcpServers`，因为 Task 2 中的 `DesktopSettingsService` 仍编译并返回这些类型；Task 3 将在删除服务实现时同步删除它们。

在 `ipc-channels.ts` 删除 `settingsMcpUpsert` 至 `settingsMcpDelete` 的 8 个成员，不保留别名或注释占位。

- [ ] **Step 4: 删除正式 Preload 转发**

在 `preload/index.ts` 删除不再使用的 `McpServerInput` 类型导入和 8 个方法实现。保持其余 API 的既有顺序；`preload-api.test.ts` 的公开键精确列表同步删除这 8 项，并从“高级设置固定白名单”测试删除 MCP 正向调用与调用序号断言。公开键缺失断言逐键检查，不能用 `not.arrayContaining()` 只证明“并非八项全部同时存在”。

- [ ] **Step 5: 删除高级设置 IPC 的 MCP Schema 与 handler**

在 `register-ipc.ts` 删除：

- `serverIdSchema`、stdio/http transport、`mcpUpsertSchema`、确认、切换与授权 Schema；
- `AdvancedSettingsIpcService` 的 8 个 MCP 方法；
- `registerAdvancedSettingsIpc()` 的 8 个 MCP `replaceHandler()` 调用。

在 `advanced-settings-ipc.test.ts` 删除旧 MCP 成功转发测试和 service mock 方法，只保留“handler 不注册”的产品边界测试及其他高级设置覆盖。

- [ ] **Step 6: 验证 Task 2 中间提交契约仍自洽**

确认 `SettingsDashboardDto.mcpServers`、MCP DTO、Renderer Dashboard fixture 与 `DesktopSettingsService.getDashboard()` 均保持原状。Task 2 的唯一共享契约变化是 `MyselfApi` 删除 8 个调用方法；不允许为了便利提前拆掉 Dashboard 数据面。

- [ ] **Step 7: 运行共享边界定向回归**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/preload-production-boundary.test.ts `
  tests/preload-api.test.ts `
  tests/advanced-settings-ipc.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

Expected: PASS；公开键逐项无 MCP、handler Map 无旧 channel，且保留的 MCP DTO/Dashboard/服务路径使 Task 2 提交独立 typecheck 通过。

- [ ] **Step 8: 提交 Task 2**

```powershell
git add apps/desktop/src/shared/myself-api.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/tests/preload-production-boundary.test.ts apps/desktop/tests/preload-api.test.ts apps/desktop/tests/advanced-settings-ipc.test.ts
git commit -m "refactor(desktop): 删除 MCP 公开接口"
```

---

### Task 3: 删除 Main 实例化、设置服务和未消费 Agent seam

**Files:**

- Modify: `apps/desktop/src/main/mcp/mcp-tool-adapter.ts`
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Delete: `apps/desktop/src/shared/desktop-runtime-capabilities.ts`
- Modify: `apps/desktop/tests/desktop-settings-service.test.ts`
- Modify: `apps/desktop/tests/mcp-manager.test.ts`
- Modify: `apps/desktop/tests/main-conversation-composition.test.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Modify: `apps/desktop/tests/settings-toast.dom.test.tsx`
- Modify: `apps/desktop/tests/main-lifecycle.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `MyselfApi` 和 `AdvancedSettingsIpcService` 已无 MCP 调用方法，但 `SettingsDashboardDto.mcpServers` 与 MCP DTO 仍保留。
- Produces: MCP DTO 与 `SettingsDashboardDto.mcpServers` 在删除服务投影时同步消失；`DesktopSettingsServiceOptions` 只含普通设置、Secret、Provider、隐私会话、置顶回调；`MainConversationAgentSnapshot<TPrivacy>` 不含 `enabledReadTools`；正式 Main 不实例化 MCP。

- [ ] **Step 1: 写 Main 生产图失败测试**

在 `desktop-settings-service.test.ts` 增加结构断言，使用当前 fixture options 的键证明目标边界：

```ts
test('正式设置服务依赖不含 MCP Manager 或 Store', () => {
  const optionKeys = Object.keys(createFixture().options);
  for (const key of ['mcpStore', 'mcpManager']) expect(optionKeys).not.toContain(key);
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

在 `main-lifecycle.test.ts` 增加正式生命周期断言：启动依赖与清理注册表不构造、初始化或关闭 `McpManager` / `McpServerStore`。该测试必须复用现有 Main 依赖注入或源码 wiring fixture，不新增正式探针。

- [ ] **Step 2: 运行 Main 目标测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/desktop-settings-service.test.ts `
  tests/main-conversation-composition.test.ts `
  tests/main-lifecycle.test.ts
```

Expected: FAIL；设置服务 fixture 仍需要 Manager/Store，会话快照仍含 `enabledReadTools`，Main 生命周期仍构造或关闭 MCP 实例。

- [ ] **Step 3: 将风险解析器归入 MCP 内部模块**

把风险解析器迁入现有 `mcp-tool-adapter.ts`：

```ts
import type { ToolRisk } from '@myself/agent-core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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

函数与同文件既有 `mcpToolDefinitionFingerprint()` 共同维护，不新增 `mcp-risk-resolver.ts`。把 `desktop-settings-service.test.ts` 中两条风险解析测试迁到 `mcp-manager.test.ts`，从 `mcp-tool-adapter.ts` 导入。删除设置服务对 SDK 类型与 Adapter 的 import。

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

在同一步从 `myself-api.ts` 删除 `McpToolDto`、`McpServerDto`、`McpServerInput`、`McpLaunchSummaryDto` 与 `SettingsDashboardDto.mcpServers`；从 `SettingsView.emptyDashboard` 及 `multi-provider-settings.test.tsx`、`renderer-components.test.tsx`、`settings-toast.dom.test.tsx`、`desktop-settings-service.test.ts` 的 Dashboard fixture 删除 `mcpServers`。共享 DTO、服务返回对象和所有直接消费者必须在这个提交中一次完成，不能留下不可编译的中间状态。

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
  tests/main-lifecycle.test.ts `
  tests/multi-provider-settings.test.tsx `
  tests/renderer-components.test.tsx `
  tests/settings-toast.dom.test.tsx `
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
git add apps/desktop/src/main/mcp/mcp-tool-adapter.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/src/main/conversation/main-conversation-composition.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/src/shared/desktop-runtime-capabilities.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/tests/mcp-manager.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/settings-toast.dom.test.tsx apps/desktop/tests/main-lifecycle.test.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts
git commit -m "refactor(desktop): 删除 MCP Main 运行链"
```

---

### Task 4: 将 SDK 移入开发依赖并建立生产 bundle 门禁

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/scripts/verify-production-mcp-boundary.mjs`
- Create: `apps/desktop/tests/production-mcp-boundary.test.ts`
- Modify: `apps/desktop/tests/package-config.test.ts`

**Interfaces:**

- Consumes: Task 1 至 Task 3 已从正式源码依赖图删除 MCP import 与入口。
- Produces: `pnpm.cmd --filter @myself/desktop build` 在现有 preload 校验后追加精确 MCP 产物校验；SDK 仅为开发依赖；Main 显式 externalize SDK，使任何残留 import 保留可扫描包名并 fail-closed。

- [ ] **Step 1: 写依赖分类、构建脚本与 externalization 失败测试**

在 `package-config.test.ts` 读取 desktop `package.json` 并增加：

```ts
expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
expect(pkg.devDependencies?.['@modelcontextprotocol/sdk']).toBe('1.29.0');
expect(pkg.scripts.build).toContain('verify-production-mcp-boundary.mjs');
```

同一测试读取 `electron.vite.config.ts`，定位 `main.build.externalizeDeps` 配置段并断言明确包含：

```ts
expect(mainExternalizeSection).toContain("include: ['@modelcontextprotocol/sdk']");
```

断言说明中明确：externalization 是让残留 import 在 bundle 中保持包名的 fail-closed 检测手段，不是恢复生产依赖。

- [ ] **Step 2: 运行配置测试确认 RED**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts
```

Expected: FAIL；SDK 仍是生产依赖、构建脚本没有门禁、Main 也未显式 externalize SDK。该 RED 与 verifier 行为 RED 分开记录。

- [ ] **Step 3: 创建可执行 no-op verifier scaffold 并确认行为 RED**

先创建能正常执行、接收产物根参数但不拒绝任何内容的 `verify-production-mcp-boundary.mjs`：

```js
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const outputRoot = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../out', import.meta.url))
);
await access(outputRoot);
```

创建 `production-mcp-boundary.test.ts`，在临时目录写入 clean fixture，并对规则表中的每个 Main、Preload、Renderer 标记分别生成单标记脏 fixture，通过 `execFile(process.execPath, [script, root])` 验证：

```ts
await expect(runVerifier(cleanFixture)).resolves.toMatchObject({ code: 0 });
for (const fixture of dirtyFixtures) {
  await expect(runVerifier(fixture.root)).rejects.toMatchObject({ code: 1 });
}
```

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/production-mcp-boundary.test.ts
```

Expected: clean fixture PASS；每个单标记脏 fixture 都因 no-op scaffold 错误返回 0 而 FAIL。导入失败或脚本不存在不算 RED。

- [ ] **Step 4: 实现精确产物校验规则并确认 GREEN**

扩展 scaffold，允许第一个 CLI 参数覆盖产物根，默认使用 `apps/desktop/out`。固定规则如下：

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

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/production-mcp-boundary.test.ts
```

Expected: PASS；clean 为 0，每个规则标记的脏 fixture 均为 1，失败输出只包含产物类型和标记名。

- [ ] **Step 5: 配置 fail-closed externalization、移动依赖并接入构建**

在 `electron.vite.config.ts` 的 Main 配置增加：

```ts
externalizeDeps: {
  include: ['@modelcontextprotocol/sdk'],
  exclude: [
    '@myself/agent-core',
    '@myself/character-assets',
    '@myself/character-runtime',
    '@myself/file-tools',
    '@myself/shared-types'
  ]
}
```

该配置必须配结构性中文注释：SDK 已从正式图删除；显式 externalize 只为让未来残留 import 保留包名并被门禁拒绝，不能被解释为运行时允许列表。

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

- [ ] **Step 6: 运行配置、脚本测试与真实生产构建**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/production-mcp-boundary.test.ts
pnpm.cmd --filter @myself/desktop build
```

Expected: PASS；真实 Main、Preload、Renderer 产物不含规则表中的禁止标记。

- [ ] **Step 7: 确认保留的内部模块仍可编译和测试**

Run:

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/mcp-manager.test.ts tests/settings-store.test.ts tests/multi-provider-settings-store.test.ts
```

Expected: PASS；devDependency 足以支撑 TypeScript 与保留模块测试，SettingsStore 格式未删除。

- [ ] **Step 8: 提交 Task 4**

```powershell
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/electron.vite.config.ts apps/desktop/scripts/verify-production-mcp-boundary.mjs apps/desktop/tests/production-mcp-boundary.test.ts apps/desktop/tests/package-config.test.ts
git commit -m "build(desktop): 阻止 MCP 进入生产产物"
```

---

### Task 5: 验证持久化、Electron 边界并更新验收记录

**Files:**

- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/tests/multi-provider-settings-store.test.ts`
- Modify: `apps/desktop/tests/provider-secret-vault.test.ts`
- Modify: `apps/desktop/tests/settings-ipc.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/e2e/desktop-settings-layout.spec.ts`
- Reference: `tests/fixtures/electron-app.ts`
- Modify: `docs/operations/lightweight-agent-acceptance.md`

**Interfaces:**

- Consumes: Task 1 至 Task 4 的单一正式路径与构建门禁。
- Produces: 无设置变更生命周期的 MCP 设置/Secret 字节不变证据、全部非 MCP 原子写的逻辑保留矩阵、全量清除例外、真实 Electron API/UI/Agent 边界和完整质量门禁的当前证据。

- [ ] **Step 1: 写全部非 MCP atomicWrite mutator 的保留矩阵**

在 `settings-store.test.ts` 预置一条含 transport、tools、指纹和启用状态的完整 `mcpServers` fixture。每项 case 使用全新的隔离 Store，执行后读取 MCP 设置并深度比较：

```ts
test.each([
  ['saveProviderProfile', store => store.saveProviderProfile(profileFixture)],
  ['saveModelRoute', store => store.saveModelRoute(routeFixture)],
  ['deleteProviderProfile', store => store.deleteProviderProfile('secondary')],
  ['savePrivacySettings', store => store.savePrivacySettings(privacyFixture)],
  ['savePetAlwaysOnTop', store => store.savePetAlwaysOnTop(true)],
  ['revokeAuthorizedRoot', store => store.revokeAuthorizedRoot()],
  ['saveProviderMetadata', store => store.saveProviderMetadata(legacyProviderFixture)],
  ['saveAuthorizedRoot', store => store.saveAuthorizedRoot(rootFixture)],
  ['savePetPosition', store => store.savePetPosition({ x: 10, y: 20 })]
])('%s 原子重写逻辑保留完整 MCP 设置', async (_name, mutate) => {
  const { store, preservedMcpServers } = await createSeededStore();
  await mutate(store);
  expect(await store.getMcpServerSettings()).toEqual(preservedMcpServers);
});
```

`createSeededStore()` 必须为 `deleteProviderProfile` 预置可删除且不破坏路由的次要档案，为模型路由预置合法 tools 档案。若 `multi-provider-settings-store.test.ts` 已有更合适的 Provider fixture，可把 Provider 新格式保存、删除和路由三项放在该文件，但矩阵必须覆盖上述全部实际非 MCP `atomicWrite` mutator。旧 Provider 兼容入口 `saveProviderMetadata` 必须单独覆盖。

同时增加静态完整性断言：从 `settings-store.ts` 提取所有调用 `atomicWrite(this.file, settings)` 的公开非 MCP 方法名，与测试矩阵名称集合精确相等；以后新增普通 mutator 会使测试失败。排除 `saveMcpServerSettings`、`deleteMcpServerSettings` 和具有明确清除语义的 `clearAll`。逻辑结构比较不要求整个 `settings.json` 字节不变。

- [ ] **Step 2: 明确 Secret 单项清除与全量清除语义**

在 `provider-secret-vault.test.ts` 使用普通 Provider ID `provider-main` 与 MCP Secret ID `mcp:remote-tools`：

```ts
await store.save('provider-main', 'provider-secret', true);
await store.save('mcp:remote-tools', 'mcp-secret', true);
const mcpSlotFile = join(
  `${file}.profiles`,
  `${createHash('sha256').update('mcp:remote-tools').digest('hex')}.bin`
);
const beforeMcpSlot = await readFile(mcpSlotFile);

await store.clear('provider-main');
const afterMcpSlot = await readFile(mcpSlotFile);
expect(afterMcpSlot.equals(beforeMcpSlot)).toBe(true);
await expect(store.readForProviderCall('provider-main')).rejects.toThrow();
await expect(store.readForProviderCall('mcp:remote-tools')).resolves.toBe('mcp-secret');

await store.clearAll();
await expect(store.readForProviderCall('mcp:remote-tools')).rejects.toThrow();
```

原始槽文件 Buffer 相等是单项清除不影响 MCP Secret 的主证据；最后一条明文读取相等只作为辅助。`clearAll()` 后还要断言普通 Provider 槽和 MCP 槽文件都不存在。

在 `settings-store.test.ts` 明确 Settings 全量清除：

```ts
await store.clearAll();
expect(await store.getMcpServerSettings()).toEqual([]);
```

在 `settings-ipc.test.ts` 证明 `scope: 'secret', profileId: 'provider-main'` 只调用 `secrets.clear('provider-main')`，不调用 `clearAll()`；`scope: 'all'` 同时调用 `settings.clearAll()` 与 `secrets.clearAll()`。

- [ ] **Step 3: 运行持久化测试并判定结果**

Run:

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts `
  tests/settings-store.test.ts `
  tests/multi-provider-settings-store.test.ts `
  tests/settings-ipc.test.ts `
  tests/provider-secret-vault.test.ts
```

Expected: PASS。若 characterization 失败，先修复普通写入丢失 `mcpServers` 或 Secret 清除越界的最小原因；不得新增 MCP 专用迁移、启动读取或特殊清理。

- [ ] **Step 4: 用现有 restart 钩子增加完整文件字节快照 E2E**

在 `desktop.spec.ts` 直接复用现有 `createElectronAppFixture({ beforeRestart })` 与 `fixture.restart()`；不修改正式 preload，也不新增 E2E 进程、网络或文件探针。现有 `restart()` 已保证先 `cleanupCurrentProcess()`，再调用 `beforeRestart(directories)`，最后启动新进程。

测试使用 restart 序号执行以下严格顺序：

1. 首次启动正常完成 Provider 档案、模型路由、文件隐私授权和授权根配置；该阶段允许正常设置写入。
2. 调用第一次 `fixture.restart()`。第一次 `beforeRestart` 回调发生在旧进程关闭后：用保留的 `SettingsStore.saveMcpServerSettings(remoteToolsFixture)` 预置 MCP 设置；从已保存的普通 Provider Secret 槽复制一份合法加密 Buffer 到 `mcp:remote-tools` 槽。预置完成后立即读取整个 `settings.json` 和整个 MCP Secret 槽为基线 Buffer。测试代码不自行解析或重新序列化设置文件。
3. 第二次启动只发送普通聊天“你好呀”和一个隔离授权根内的只读文件任务。不得打开设置、保存隐私、改变授权根、移动桌宠、执行写文件或调用任何其他普通设置 mutator。
4. 调用第二次 `fixture.restart()`。第二次 `beforeRestart` 回调同样发生在旧进程关闭后：直接读取整个 `settings.json` 与整个 `mcp:remote-tools` 槽原始 Buffer，并与基线比较。

回调中的核心证据为：

```ts
if (restartCount === 1) {
  beforeSettingsBuffer = await readFile(settingsFile);
  beforeMcpSecretBuffer = await readFile(mcpSecretSlotFile);
} else if (restartCount === 2) {
  const afterSettingsBuffer = await readFile(settingsFile);
  const afterMcpSecretBuffer = await readFile(mcpSecretSlotFile);
  expect(afterSettingsBuffer.equals(beforeSettingsBuffer)).toBe(true);
  expect(afterMcpSecretBuffer.equals(beforeMcpSecretBuffer)).toBe(true);
}
```

禁止 `JSON.parse()`、`JSON.stringify()` 或只比较 `mcpServers` 字段；整个 `settings.json` 不允许任何非 MCP 字段变化。`dispose()` 会删除隔离 `userData`，因此两份基线读取、最终读取和 `Buffer.equals()` 必须全部在相应 `beforeRestart` 回调中完成；不能在 `dispose()` 之后补做断言。第二次 restart 会继续启动第三个进程，断言完成后只负责安全 `dispose()`。

本 E2E 不声明动态证明“零 MCP HTTP 请求”或“零 MCP 子进程”，因为当前没有可复用的明确命中计数器或进程哨兵。不可达性由 Task 3 Main 正式生产图与 Task 4 真实 bundle 门禁证明；退出后的子进程观察继续标记为待人工确认，不为本项新增检测机制。

- [ ] **Step 5: 增加 Electron 正式 API 边界断言**

在 `desktop.spec.ts` 的正式 preload 上下文逐键检查：

```ts
const apiKeys = new Set(await settingsWindow.evaluate(() => Object.keys(window.myself)));
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
for (const key of removedMcpKeys) expect(apiKeys.has(key)).toBe(false);
expect(removedMcpKeys.filter(key => apiKeys.has(key))).toEqual([]);
```

保留已有 Provider 工具名称不含 `mcp__` 的断言。不能使用 `not.arrayContaining()` 只证明“八项没有全部同时出现”。不要向正式 preload 新增探针。

- [ ] **Step 6: 收紧设置页三标签 E2E**

在 `desktop-settings-layout.spec.ts` 的 720×620 与 640×520 两条用例中，把“入口不可见”收紧为：

- 导航按钮文本精确为 `模型`、`隐私`、`本地数据`；
- 不存在 `工具` 按钮；
- 页面不含 `MCP 服务` 表单；
- 原有无横向溢出、无重叠断言继续通过。

所有等待使用 Playwright locator 或 `expect.poll()`；不增加固定休眠。

- [ ] **Step 7: 先列出并运行两个目标 E2E 集合**

Run:

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts `
  tests/e2e/desktop.spec.ts `
  tests/e2e/desktop-settings-layout.spec.ts `
  --grep "MCP|通过正式白名单完成设置、文件操作与聊天窗口状态" `
  --list
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts `
  tests/e2e/desktop.spec.ts `
  tests/e2e/desktop-settings-layout.spec.ts `
  --grep "MCP|通过正式白名单完成设置、文件操作与聊天窗口状态"
```

Expected: `--list` 同时列出两条布局标题（标题含 MCP）、“通过正式白名单完成设置、文件操作与聊天窗口状态”和新增隔离 userData 生命周期用例；实际运行全部 PASS。若新增用例标题未含 MCP，先把标题改为含“MCP 正式链”再执行。零匹配或只匹配布局不得写为通过。

- [ ] **Step 8: 执行完整桌面门禁**

Run:

```powershell
pnpm.cmd verify:desktop
```

Expected: 全仓 typecheck、单元、安全、集成、生产构建、精确 MCP bundle 门禁和全部 Electron E2E 退出 0。记录实际通过/跳过数量，不预填数字。

- [ ] **Step 9: 检查保留项、删除项和越界修改**

Run:

```powershell
rg -n "@modelcontextprotocol/sdk|McpManager|McpServerStore|MCP_MODULE_DISABLED|settings:mcp-|upsertMcpServer" `
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

- [ ] **Step 10: 更新验收记录**

在 `docs/operations/lightweight-agent-acceptance.md` 新增“2026-08-22 MCP 正式运行链清理验收”小节，只记录本轮实际执行结果：

- 起始与实现提交；
- 每条 RED 的真实失败原因；
- 定向测试、持久化测试、构建门禁与 `verify:desktop` 的命令、退出码和数量；
- 自动证明的 API、IPC、Main、Agent、依赖与 bundle 边界；
- 保留的源码、测试和三层持久化证据：无设置变更字节不变、普通 mutator 逻辑保留、全量清除例外；
- 开发态 Windows 人工观察结果；若未执行则明确“待用户人工确认”；
- 安装包未构建，明确“待正式打包阶段确认”，不得写成通过。

同步修正同文档旧的“正式 preload 仍存在 MCP 方法”未完成项，改为指向本轮实际证据，避免两个有效结论冲突。

- [ ] **Step 11: 提交 Task 5**

```powershell
git add apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts apps/desktop/tests/provider-secret-vault.test.ts apps/desktop/tests/settings-ipc.test.ts tests/e2e/desktop.spec.ts tests/e2e/desktop-settings-layout.spec.ts docs/operations/lightweight-agent-acceptance.md
git commit -m "test(desktop): 验收 MCP 正式链清理"
```

- [ ] **Step 12: 请求最终代码审查**

使用 `requesting-code-review` 对本计划起始提交到 Task 5 HEAD 的固定范围复审：

- 规格覆盖：正式 API/Preload/IPC/Renderer/Main/Agent/依赖/bundle 是否全部删除；
- 保留边界：`src/main/mcp`、内部测试和持久化 schema/data 是否保留；
- 持久化：三层证据是否分别覆盖无设置变更字节不变、全部普通 mutator 逻辑保留和全量清除例外；
- 减法收口：是否仍有恒假开关、空回调、弃用别名或第二条正式路径；
- 测试事实：验收记录是否只声明实际运行和观察到的结果；
- 越界：是否夹带拖拽、角色、缩放、文件能力、Provider 或工作台改动。

审查发现问题时，先增加或收紧最小失败测试，再由一个修复子智能体处理，并由同一审查者复核；不得跳过完整桌面门禁。
