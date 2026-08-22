# 桌面端 MCP 正式运行链清理设计

## 状态与替代范围

本文是桌面端 MCP 正式运行链的现行规格。

本文只替代 [2026-07-31 桌宠 MCP 暂停开放与边缘拖拽修复设计](./2026-07-31-desktop-mcp-disable-edge-drag-design.md) 中以下 MCP 条款：

- 保留正式 MCP IPC、Preload、Renderer 设置组件和服务操作入口；
- 通过 `desktopRuntimeCapabilities.mcp = false` 与 `MCP_MODULE_DISABLED` 将正式入口保持为“存在但不可用”；
- Main 仍实例化 `McpServerStore`、`McpManager` 并在退出时关闭空 Manager；
- `@modelcontextprotocol/sdk` 继续作为桌面端生产依赖；
- Agent 会话组合继续携带未消费的外部只读工具快照。

旧设计中的拖拽根因、窗口位置写入所有权、工作区边界、异常清理和拖拽验收继续有效，本文不修改、不替代这些内容。旧计划中的拖拽任务也继续按原边界解释。

路线图“保留 MCP 源码与持久化数据，但运行时、Agent 和 Renderer 均保持禁用”的约束继续有效。本文将“禁用”收紧为：正式生产依赖图中不存在 MCP 的公开接口、注册、实例化和打包入口；保留的内部源码与数据格式不构成产品能力。

## 背景与现状证据

2026-08-22 的当前实现已经做到正常 UI 不显示 MCP，`DesktopSettingsService` 也会在静态能力关闭时拒绝操作，但这不是正式运行链的物理隔离：

```text
app.whenReady()
  -> new McpServerStore()
  -> new McpManager()
  -> DesktopSettingsService.initialize()
       -> mcp:false，因此不读取、不连接

pet / chat / settings / characters 四个窗口
  -> 共用正式 preload
  -> window.myself 暴露 8 个 MCP 方法
  -> settings:mcp-* IPC 已注册
  -> DesktopSettingsService 在守卫处返回 MCP_MODULE_DISABLED
```

Renderer 的“工具”标签虽被静态能力过滤，但 `SettingsView` 仍导入 `McpSettings`、构造 MCP 回调并把相关组件与样式带入生产构建。Main 仍导入 Manager 和 SDK，`MainConversationComposition` 还会读取 `enabledReadTools`，但当前 Agent 工厂并未消费该字段。

当前生产构建可观察到：

- Main bundle 含 `@modelcontextprotocol/sdk` 和完整 `McpManager`；
- Preload bundle 含 `settings:mcp-*` 与 8 个公开方法；
- Renderer bundle 含 MCP 设置状态、回调、文案和样式；
- `@modelcontextprotocol/sdk` 位于 `apps/desktop/package.json` 的 `dependencies`。

因此当前状态是“UI 隐藏、服务拒绝”，不是“正式运行链不存在”。所有窗口共用 preload，使这组无产品用途的系统调用表面同时暴露给四类 Renderer；继续保留恒假入口会扩大攻击面，也会让测试误把历史扩展边界当作现行产品契约。

## 目标

1. 正式 `MyselfApi` 和 `window.myself` 不再包含任何 MCP DTO、字段或方法。
2. 正式 Preload 不再暴露 MCP 调用，正式 IPC 不再定义或注册 `settings:mcp-*` handler。
3. 正式 Renderer 不再包含 `tools` 标签、MCP 状态、回调、设置组件或专用样式。
4. Main 正式启动、会话与退出图不再导入、实例化、读取、执行或关闭 MCP Manager/Store。
5. 删除未被 Agent 消费的 `readEnabledReadTools` / `enabledReadTools` seam，不以恒空回调替代。
6. `@modelcontextprotocol/sdk` 从生产依赖移动到开发依赖，使保留的 MCP 内部测试仍可编译和执行，但正式安装依赖与生产 bundle 不携带该 SDK。
7. 保留 MCP Manager、Store、Adapter 源码、内部单元测试、测试 Server、持久化 schema 和既有本地数据。
8. 通过精确的生产边界门禁证明正式产物没有 MCP SDK、公开方法、IPC、Manager 或 Renderer 设置入口。

## 非目标

- 不恢复、开发、替换或新增 MCP 功能、传输、服务配置或工具执行能力。
- 不接入桌宠 MCP、外部 Agent 框架或第二套工具运行时。
- 不删除 `apps/desktop/src/main/mcp`、Manager/Store/Adapter 单元测试、测试 Server 或持久化 schema。
- 不迁移、清空、重命名或重写已有 `mcpServers` 与 `mcp:*` Secret。
- 不把验收泛化为“任意源码或 bundle 中不得出现 `mcp` 字符串”。共享工具名 Schema、保留模块测试和持久化格式可以合法包含该词。
- 不修改 2026-07-31 旧设计的拖拽实现与验收结论。
- 不顺带修改角色行为、桌宠缩放、碰撞体积、窗口拖拽、文件能力、Provider 协议或角色工作台。
- 当前不构建或安装 Windows 安装包；本轮的“不得打包”通过生产依赖分类和 Electron 生产 bundle 门禁约束，干净安装包验收留到正式打包阶段。

## 方案选择

### 采用：保留内部实现，物理删除正式生产图

正式产品只保留模型、隐私、授权根、文件任务、PowerShell 与桌宠现有能力。MCP 代码作为未接入的内部开发资产留在 `src/main/mcp`，仅由其单元测试和测试夹具直接引用。

该方案把“是否存在正式能力”落实为可静态检查的模块边界：如果未来恢复 MCP，必须通过新的安全规格重新增加 API、Preload、IPC、Renderer、Main 生命周期和生产依赖，不能只翻转布尔值。

### 未采用：继续保留恒假 API

恒假 API 仍向所有 Renderer 暴露方法并注册 Main handler，只是在深层守卫处失败。它保留了无产品用途的攻击面、契约和打包依赖，也容易被后续改动意外重新接通。

### 未采用：删除全部 MCP 代码和数据

这会破坏路线图明确要求保留的内部实现、测试资产和用户本地数据，也会把“当前不开放”误实现成不可恢复的数据删除。本轮只清理正式生产链。

## 目标架构

### 正式生产图

```text
Renderer
  -> 最小 window.myself API
  -> 非 MCP 白名单 IPC
  -> DesktopSettingsService 的 Provider / 隐私 / 置顶 / 授权根职责
  -> 普通聊天与受控文件/PowerShell Agent
```

上述图中不再出现 MCP DTO、方法、channel、handler、设置页、Manager/Store 实例、工具快照或关闭钩子。

### 保留的内部开发图

```text
apps/desktop/tests/mcp-manager.test.ts
  -> src/main/mcp/mcp-manager.ts
  -> src/main/mcp/mcp-server-store.ts
  -> src/main/mcp/mcp-tool-adapter.ts
  -> @modelcontextprotocol/sdk（devDependency）
  -> tests/fixtures/mcp-*-test-server.ts
```

`createTrustedMcpRiskResolver` 属于 MCP Adapter 的内部风险逻辑，从 `DesktopSettingsService` 迁入现有 `src/main/mcp/mcp-tool-adapter.ts`，并由 MCP 内部测试直接覆盖。这样不新增单用途模块，设置服务也不再为保留测试承担 SDK 类型依赖。

## 分层减法

### Renderer

- `SettingsTab` 只保留现行的 `local`、`models`、`privacy` 三类标签；
- 删除 `tools` 回退兼容逻辑，不保留永远不可达的标签联合成员；
- 删除 `McpSettings.tsx`、`mcpActions` Props、MCP 状态和全部回调；
- 删除 MCP 专用 CSS；组合选择器只移除 MCP 成员，保留其他模块仍使用的 `.segmented-control`、`.dialog-actions` 等共享样式；
- 设置导航使用精确三列布局。

### 共享 API、Preload 与 IPC

- 第一阶段只从 `MyselfApi` 删除 8 个 MCP 方法，从 Preload 与 IPC 删除相同调用面；`McpServerInput`、MCP DTO 和 `SettingsDashboardDto.mcpServers` 暂时保留，使该中间提交不要求提前拆开 `DesktopSettingsService`；
- 从 Preload 删除相关类型导入、方法与 `ipcRenderer.invoke`；
- 从 `ipcChannels` 删除 8 个 `settings:mcp-*` channel；
- 从 `registerAdvancedSettingsIpc` 删除 MCP Schema、服务接口成员和 8 个 handler；
- 删除只服务这些入口的正向转发测试，不用“handler 存在但拒绝”替代“handler 不注册”。

### Main 服务与会话

- `DesktopSettingsServiceOptions` 不再接收 `mcpStore` 或 `mcpManager`；
- 在同一中间提交中从 `SettingsDashboardDto` 删除 `mcpServers`，删除 MCP DTO、输入类型、Dashboard 投影与全部消费者 fixture，避免共享契约先于服务实现进入不可编译状态；
- 设置服务删除 MCP 初始化、Dashboard 投影、状态、配置、连接、授权、执行和关闭代码；
- `close()` 继续注销隐私会话，但不再关闭不存在的 Manager；
- `main/index.ts` 删除 MCP Store/Manager 导入、实例化、风险解析注入、初始化接线和退出所有权；
- `MainConversationComposition` 删除 `readEnabledReadTools`、`enabledReadTools` 及对应泛型；能力任务快照仍保留 Provider、授权根、任务类型和隐私设置；
- 删除 `desktop-runtime-capabilities.ts`。正式入口物理不存在后不保留恒假开关或稳定失败码。

### 依赖与生产 bundle

- `@modelcontextprotocol/sdk` 从 `dependencies` 移到 `devDependencies`，版本保持 `1.29.0`；
- 更新 `pnpm-lock.yaml` 的 desktop importer 分类；
- `electron.vite.config.ts` 的 Main `externalizeDeps.include` 显式包含 `@modelcontextprotocol/sdk`；这只用于 fail-closed 检测：若正式 Main 仍残留 SDK import，产物必须保留可扫描的包名并让门禁失败，不代表恢复生产依赖或允许运行时加载；
- 正式构建完成后执行精确标记扫描；
- 不删除 `tldts` 等仍被非 MCP 生产模块使用的依赖。

## 持久化裁决

### 保留内容

以下内容继续保留：

- `settings-store.ts` 中 `mcpServerSettingsSchema`、`StoredSettings.mcpServers`、V1/V2 读取与迁移兼容；
- `getMcpServerSettings`、`saveMcpServerSettings`、`deleteMcpServerSettings` 及其单元测试，作为持久化格式的内部开发接口；
- SecretStore 中既有 `mcp:<serverId>` 数据；
- 用户磁盘上的既有 MCP 设置、密钥和启动确认指纹。

### 第一层：无设置变更的生命周期字节不变

正式启动、设置 Dashboard、会话准备、普通聊天、文件任务与应用关闭不得调用 MCP 专用 getter、save、delete、Secret 读取或清理方法。不存在静默迁移、禁用标记写入或后台格式修复。隔离 `userData` 在上述无设置变更流程前后，MCP 设置文件片段与 `mcp:remote-tools` Secret 必须逐字节不变。

### 第二层：普通设置原子重写逻辑保留

`mcpServers` 与 Provider、隐私、置顶等普通设置位于同一个 `settings.json`。普通设置保存会加载完整对象并原子重写共享文件，因此不要求文件字节完全不变；它必须保证重写前后的 `mcpServers` 逻辑值深度相等，包括未知顺序之外的全部已建模字段，不得丢失、归零或规范化为另一组内容。

SettingsStore 为格式兼容保留的 MCP schema 和专用访问器可能随 SettingsStore 留在 Main bundle，但正式生产代码不得调用这些访问器。它们与 `mcpServers` 字段同属“持久化格式保留”例外，不代表 Manager、连接、工具执行或设置入口被打包；生产门禁只检查下文列出的运行时标记。

characterization 矩阵必须覆盖 SettingsStore 现有的全部非 MCP `atomicWrite` mutator，包括 Provider 新旧格式保存、Provider 删除、模型路由、Provider metadata、隐私、置顶、授权根保存与撤销、桌宠位置，以及实际代码中其他非 MCP 原子写入口。每项都证明完整 `mcpServers` 逻辑值保持一致；新增 mutator 时也必须进入该矩阵。这类整体原子写不是 MCP 专用读写。

### 第三层：用户明确清除全部本地数据

用户明确选择“清除全部本地数据”时，`SettingsStore.clearAll()` 和 `SecretStore.clearAll()` 继续清除全部设置与 Secret，其中包括 MCP 数据。这是全局清除语义，不属于 MCP 专用删除，也不得为 MCP 增加例外保留。

Secret characterization 使用普通 Provider ID 与 `mcp:remote-tools` 两个独立条目：清除普通 Provider 只删除前者并逐字节保留后者；`SecretStore.clearAll()` 明确清除二者。

## 安全与隐私

- 所有四类 Renderer 共用的正式 preload 不再暴露 MCP 系统能力表面。
- Main 不注册 MCP IPC，Renderer 即使构造旧 channel 字符串也没有正式 handler 可达。
- Main 不实例化 Manager，因此应用启动、普通聊天、文件任务和退出均不能启动 MCP 子进程或建立 HTTP 连接。
- 正式 Agent 工具集合继续由现有受控文件与 PowerShell链决定；不得从保留源码动态发现或注册 `mcp.*` 工具。
- 保留数据不进入 Dashboard、Renderer、普通日志、Provider 请求或公开事件。
- 生产边界测试使用公开键、handler Map 与 bundle 精确标记，不读取或输出用户的 MCP 设置、URL、命令、密钥或路径。

## 生命周期与失败处理

### 启动

启动链不构造 MCP Store/Manager，也不调用 MCP 初始化。删除 Manager 后不存在“构造但不连接”的中间状态，启动失败清理表也不再持有 MCP close 回调。

### 运行

旧 Renderer 与新 Main、或新 Renderer 与旧 Main 的跨版本混用不受支持；Electron 更新后必须重启所有窗口。新 Renderer 调用表中没有 MCP 方法，旧 MCP channel 在新 Main 上没有 handler。

普通聊天、文件任务、设置、角色和窗口模块的失败处理保持不变。MCP 内部单元测试失败不得通过恢复生产入口来修复，应在保留的 `src/main/mcp` 内部处理。

### 退出

`DesktopSettingsService.close()` 继续负责隐私会话注销和既有非 MCP 清理。由于正式运行中不存在 MCP Manager，不再调用防御性 `McpManager.close()`，也不保留空实现。

### 构建门禁失败

生产 bundle 若出现任一禁止标记，构建必须失败并报告“产物类型 + 标记名称”，不得输出整段 bundle。实现者先定位残留 import 或调用点，不扩大扫描为任意 `mcp` 字符串。

Main 构建显式 externalize SDK 是检测手段而非豁免：残留 import 必须以 `@modelcontextprotocol/sdk` 明文留在 bundle 并触发失败。配置测试同时锁定该 externalization 和 SDK 仅位于 `devDependencies`；任何人不得通过移除 externalization、改写包名或把 SDK 移回生产依赖制造假绿。

## 兼容与迁移

- 这是有意的仓库内接口删除：旧 `MyselfApi` MCP 方法、Dashboard 字段和 IPC channel 不提供弃用别名。
- 全部正式窗口必须随应用一同更新并重启；不支持新旧 preload/Renderer 混用。
- 本地 MCP 设置与 Secret 不迁移、不改写，未来如重新批准 MCP，可由新规格决定是否复用。
- `packages/shared-types` 中允许 `mcp.*` 工具名的底层格式契约可以保留，因为保留的 Manager/Adapter 测试仍使用它；它不代表正式 Agent 已注册 MCP。
- SDK 移入开发依赖后，保留模块的类型检查和单元测试仍可使用 SDK；正式构建若仍有运行时 import，应因生产 bundle 门禁失败，而不是把 SDK 移回生产依赖。

## 删除与保留清单

### 删除

- `apps/desktop/src/renderer/src/settings/McpSettings.tsx`
- `apps/desktop/src/shared/desktop-runtime-capabilities.ts`
- `MyselfApi`、`SettingsDashboardDto`、Preload、IPC 与 Renderer 中的 MCP 正式入口
- `DesktopSettingsService` 的 MCP 运行职责
- Main 的 MCP 实例化、初始化、执行和退出接线
- `MainConversationComposition` 未消费的外部只读工具 seam
- MCP 专用 Renderer 样式
- 只服务旧正式入口、恒假开关或稳定拒绝行为的测试

### 保留

- `apps/desktop/src/main/mcp/mcp-manager.ts`
- `apps/desktop/src/main/mcp/mcp-server-store.ts`
- `apps/desktop/src/main/mcp/mcp-tool-adapter.ts`，包括迁入的风险解析器
- `apps/desktop/tests/mcp-manager.test.ts`
- `apps/desktop/tests/fixtures/mcp-test-server.ts`
- `apps/desktop/tests/fixtures/mcp-http-test-server.ts`
- SettingsStore 的 MCP schema、读写方法、迁移兼容和测试
- “会话建立后不能追加远程读取工具”等不依赖正式 MCP 入口的通用权限测试
- 设置页和 E2E 中“没有工具/MCP 入口”的现行产品边界断言

## 测试策略

### RED 证据

实施必须先证明以下现状：

1. Renderer 组件契约仍接受 `tools` 与 `mcpActions`，生产 bundle 与 E2E 仍能观察到 MCP 设置残留；源码正则只作为定位辅助，不作为主验收证据。
2. `Object.keys(window.myself)` 仍包含 8 个 MCP 方法。
3. `registerAdvancedSettingsIpc` 仍注册 8 个 `settings:mcp-*` handler。
4. `DesktopSettingsServiceOptions` 和 Main 启动仍需要 Manager/Store，能力任务快照仍含 `enabledReadTools`。
5. `@modelcontextprotocol/sdk` 仍在生产依赖，当前生产 bundle 仍含精确禁止标记；verifier 的 RED 使用可执行 no-op scaffold，使干净 fixture 通过、脏 fixture 因未被拒绝而失败。

RED 失败必须来自目标入口仍存在；导入错误、测试夹具错误或无关断言失败不算有效证据。

### 定向自动测试

- Renderer：组件类型契约精确三标签、无 MCP Props/文案/组件，typecheck、生产 bundle 和 Electron E2E 共同作为主证据；源码正则只辅助定位，共享 CSS 与 Explorer 生产边界无回归。
- API/Preload/IPC：8 个公开键逐键不存在且与实际键集合交集为空；8 个旧 channel 均无 handler。
- Main：设置服务无 MCP Options/方法；会话快照无未消费工具 seam；Manager 内部测试继续通过。
- 持久化：无设置变更的启动/聊天/文件任务/关闭前后 MCP 设置与 Secret 字节不变；全部非 MCP 原子写入口逻辑保留完整 `mcpServers`；单 Provider Secret 清除保留 `mcp:remote-tools`；`clearAll` 明确清除二者。
- 生产构建：Main、Preload、Renderer 不含规定的正式入口标记。
- 安全与集成：普通聊天、文件工具、PowerShell、权限和配置失效语义无回归。
- Electron E2E：设置页无入口，`window.myself` 对 8 个 MCP key 逐键不存在且交集为空，Provider 工具表无 MCP 工具；定向执行前用 `--list` 证明布局用例、正式白名单纵向用例和隔离 `userData` 生命周期用例均被匹配。

### 精确生产门禁

构建后检查以下禁止标记：

| 产物 | 禁止标记 |
| --- | --- |
| Main | `@modelcontextprotocol/sdk`、`McpManager`、`McpServerStore`、`MCP_MODULE_DISABLED`、`settings:mcp-` |
| Preload | `settings:mcp-`、`upsertMcpServer`、`confirmMcpLaunch`、`testMcpServer`、`setMcpServerEnabled`、`setMcpToolEnabled`、`authorizeMcpToolReadOnly`、`revokeMcpToolReadOnly`、`deleteMcpServer` |
| Renderer | `upsertMcpServer`、`MCP 服务`、`.mcp-server` |

门禁不扫描任意 `mcp` 字符串，也不扫描测试产物。

## 验收标准

### 自动验收

- `SettingsTab` 精确为三类，正式 Renderer 不导入或渲染 MCP 设置组件。
- `SettingsDashboardDto` 与 `MyselfApi` 不含 MCP 字段和方法。
- 正式 preload 的 8 个 MCP 公开键逐键不存在，旧键集合与实际键集合交集为空。
- 正式 IPC channel 表和 handler Map 不含 8 个 `settings:mcp-*` 入口。
- Main 启动、会话、设置与退出代码不导入、实例化或调用 MCP Manager/Store。
- 正式 Agent 工具表不含 MCP 工具，且不存在未消费的 `enabledReadTools` seam。
- SDK 版本 `1.29.0` 只位于 desktop `devDependencies`；生产构建和精确 bundle 门禁通过。
- Main externalization 显式包含 SDK，残留 import 会保留包名并 fail-closed；该配置没有恢复生产依赖。
- MCP Manager、Store、Adapter、测试 Server 和 SettingsStore MCP 测试继续通过。
- 隔离 `userData` 的无设置变更 E2E 证明启动、聊天、文件任务与关闭前后 MCP 设置和 `mcp:remote-tools` Secret 字节不变；全部非 MCP 原子写逻辑保留 `mcpServers`；全量本地数据清除仍清除 MCP 设置与 Secret。
- `pnpm.cmd verify:desktop`、`git diff --check` 和固定范围差异检查通过。

### 人工验收边界

自动化不能替代真实 Windows 窗口观察。开发态启动后人工确认：

1. 桌宠、聊天、设置和角色工作台正常打开。
2. 设置页只有“模型”“隐私”“本地数据”三类入口，不出现“工具”或 MCP 表单。
3. 普通聊天和一项受控文件任务仍可进入各自现有流程。
4. 退出应用后没有新出现的 MCP 子进程。

当前不生成安装包，因此“干净环境安装包不携带 MCP SDK”标记为待正式打包阶段人工确认，不能由本轮生产 bundle 结果冒充通过。

## 完成定义

只有以下条件同时满足才能关闭本子项目：

- 正式 API、Preload、IPC、Renderer、Main 与 Agent seam 已物理删除；
- 保留的内部 MCP 源码、测试和持久化数据未被删除；
- SDK 已移入开发依赖，精确生产 bundle 门禁通过；
- 旧正式入口与只服务旧入口的测试已删除，不存在第二条恒假路径；
- 定向测试、完整桌面门禁和差异检查通过；
- 验收记录只写入实际执行的命令、结果和未覆盖项；
- 不包含拖拽、角色、缩放、文件能力或工作台的顺带改动。
