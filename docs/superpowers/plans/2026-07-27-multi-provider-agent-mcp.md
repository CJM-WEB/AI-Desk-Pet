# AI 桌宠多模型、Agent 与 MCP 实施计划

> **供智能执行代理使用：** 实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按复选框逐项执行和复核。

**目标：** 在现有单一 OpenAI 兼容 Agent 上增加可选择的国内外模型、多档案路由、统一权限层和安全 MCP 客户端。

**架构：** 先扩展共享契约和设置迁移，再建立 Provider Registry、Model Router 与动态 Tool Registry；MCP 通过官方 SDK 接入 Main，最后完成设置界面、隐私控制和端到端验证。

**技术栈：** TypeScript、Electron、React、Zod、Vitest、Playwright、Electron `safeStorage`、官方 MCP TypeScript SDK。

**设计规格：** [AI 桌宠多模型、Agent 与 MCP 系统设计](../specs/2026-07-27-multi-provider-agent-mcp-design.md)

## 全局约束

- 所有密钥只进入安全存储，不进入普通设置、日志、导出和 Renderer 回包。
- Renderer 不直接请求模型、不启动 MCP、不执行工具。
- 所有工具调用在 Main 中经过 Schema、权限和数据范围校验。
- 不允许 Shell 成为模型可调用的通用工具。
- 实施期间只允许 Git 只读命令；提交、暂存、分支和推送必须另行获得用户同意。

---

### 任务 1：模型目录与设置迁移

**文件：**

- 新建：`packages/shared-types/src/provider-catalog.ts`
- 修改：`packages/shared-types/src/contracts.ts`
- 修改：`apps/desktop/src/main/storage/settings-store.ts`
- 新建测试：`apps/desktop/tests/provider-settings-migration.test.ts`

**产出：** `ProviderCatalogEntry`、`ModelCapability`、`ProviderProfileV2`、`ModelRouteConfig` 和设置 v1→v2 迁移。

- [ ] 先写测试，覆盖旧单档案迁移、预置档案、高级自定义档案和未知字段拒绝。
- [ ] 运行 `pnpm --filter @myself/desktop test -- provider-settings-migration.test.ts`，确认测试先失败。
- [ ] 实现版本化目录与原子设置迁移；内置目录至少包含 OpenAI、Anthropic、Gemini、DeepSeek、Kimi、通义千问、智谱、豆包、腾讯混元和 MiniMax。
- [ ] 再次运行测试和 `pnpm --filter @myself/desktop typecheck`。

### 任务 2：多密钥安全存储

**文件：**

- 修改：`apps/desktop/src/main/storage/secret-store.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 新建测试：`apps/desktop/tests/provider-secret-vault.test.ts`

**产出：** 以 `profileId` 隔离的密钥保存、读取、替换和删除接口。

- [ ] 写失败测试，证明档案之间不能读取对方密钥，公开设置只返回 `hasStoredSecret`。
- [ ] 实现密钥槽及旧默认密钥迁移，失败时保留旧密钥文件。
- [ ] 验证清除单个档案不会清除其他档案，`all` 才清除全部密钥。
- [ ] 运行目标测试、桌面端完整测试和类型检查。

### 任务 3：Provider 适配器与统一事件

**文件：**

- 新建：`apps/desktop/src/main/providers/provider-registry.ts`
- 新建：`apps/desktop/src/main/providers/anthropic-provider.ts`
- 新建：`apps/desktop/src/main/providers/gemini-provider.ts`
- 修改：`apps/desktop/src/main/providers/openai-provider.ts`
- 新建测试：`apps/desktop/tests/provider-contract.test.ts`

**产出：** 三类协议到统一 `ModelResponse` 的适配，以及中国模型 OpenAI 兼容契约样例。

- [ ] 建立共享契约测试，覆盖文本、工具调用、取消、认证错误、限流和畸形响应。
- [ ] 让现有 OpenAI 兼容适配器先通过契约，并把品牌差异放入目录配置。
- [ ] 实现 Anthropic 与 Gemini 适配器，不把各家原始响应泄漏到 Agent Core。
- [ ] 使用固定 Mock 验证 DeepSeek、Kimi和至少一个其他中国提供商配置。
- [ ] 运行 `pnpm --filter @myself/desktop test -- provider-contract.test.ts` 和类型检查。

### 任务 4：模型路由和故障转移

**文件：**

- 新建：`packages/agent-core/src/model-router.ts`
- 修改：`packages/agent-core/src/types.ts`
- 修改：`packages/agent-core/src/index.ts`
- 新建测试：`packages/agent-core/tests/model-router.test.ts`

**产出：** 默认单模型、按用途路由、能力检查和受授权故障转移。

- [ ] 写失败测试，覆盖工具能力不足、视觉路由、同提供商回退和跨提供商未授权拒绝。
- [ ] 实现 `ModelRouter.select(requestKind, disclosure)`，返回明确档案和披露目标。
- [ ] 保留“工具已执行但总结失败不重放工具”的现有语义。
- [ ] 运行 Agent Core 测试、桌面 Agent 回归测试和类型检查。

### 任务 5：动态工具注册与三级权限

**文件：**

- 修改：`packages/agent-core/src/types.ts`
- 修改：`packages/agent-core/src/agent-loop.ts`
- 新建：`apps/desktop/src/main/agent/tool-registry.ts`
- 新建：`apps/desktop/src/main/agent/permission-policy.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 新建测试：`apps/desktop/tests/tool-permission-policy.test.ts`

**产出：** 命名空间工具标识、只读/可恢复/高风险分级，以及统一确认流程。

- [ ] 写测试证明未知、禁用、越权和伪造低风险工具调用均被拒绝。
- [ ] 将固定 `ToolName` 枚举改为经过格式约束的命名空间标识；每次调用仍必须匹配注册项。
- [ ] 将权限决策放在工具参数验证之后、执行之前，并记录可公开审计摘要。
- [ ] 迁移现有五个文件工具，保持原有路径守卫和禁止覆盖语义。
- [ ] 运行 Agent Core、文件工具和桌面 Agent 全部测试。

### 任务 6：MCP 客户端与服务管理

**文件：**

- 修改：`apps/desktop/package.json`
- 新建：`apps/desktop/src/main/mcp/mcp-manager.ts`
- 新建：`apps/desktop/src/main/mcp/mcp-server-store.ts`
- 新建：`apps/desktop/src/main/mcp/mcp-tool-adapter.ts`
- 新建测试：`apps/desktop/tests/mcp-manager.test.ts`
- 新建夹具：`apps/desktop/tests/fixtures/mcp-test-server.ts`

**产出：** 基于官方 SDK 的 `stdio`、HTTP 连接，能力发现、启停、超时、取消和崩溃隔离。

- [ ] 经用户允许后安装官方 `@modelcontextprotocol/sdk`，锁定实际版本。
- [ ] 先写本地测试服务和失败测试，覆盖服务发现、禁用工具、超时、进程退出和输出超限。
- [ ] 实现最小环境的 `stdio` 启动及 HTTPS/本机回环 HTTP 策略。
- [ ] 将 MCP 工具适配到 Tool Registry；MCP 自报风险不得降低本地权限等级。
- [ ] 运行 MCP 测试，并确认测试结束后没有残留子进程。

### 任务 7：隐私、记忆和主动性

**文件：**

- 新建：`apps/desktop/src/main/agent/disclosure-policy.ts`
- 新建：`apps/desktop/src/main/memory/local-memory-store.ts`
- 新建：`apps/desktop/src/main/agent/proactivity-policy.ts`
- 修改：`apps/desktop/src/main/audit/audit-writer.ts`
- 新建测试：`apps/desktop/tests/privacy-and-proactivity.test.ts`

**产出：** 本地记忆、无痕会话、逐类数据授权和被动/辅助/自主三级策略。

- [ ] 写测试证明文件、截图、剪贴板和记忆权限互不联动。
- [ ] 实现请求级披露清单和目标提供商校验，审计仅保存类别与脱敏摘要。
- [ ] 实现本地长期记忆的查看、修改、删除和完全禁用。
- [ ] 实现主动性策略；辅助模式只建议，自主模式只自动执行规则允许的低风险调用。
- [ ] 运行隐私、安全和 Agent 回归测试。

### 任务 8：设置界面与端到端验收

**文件：**

- 修改：`apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- 新建：`apps/desktop/src/renderer/src/settings/ProviderSettings.tsx`
- 新建：`apps/desktop/src/renderer/src/settings/McpSettings.tsx`
- 新建：`apps/desktop/src/renderer/src/settings/PrivacySettings.tsx`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 新建测试：`apps/desktop/tests/multi-provider-settings.test.tsx`
- 新建 E2E：`apps/desktop/e2e/agent-mcp-flow.spec.ts`

**产出：** 普通模型选择、高级自定义、MCP 管理、权限中心和完整任务流程。

- [ ] 写组件测试，确保普通模式只要求提供商、模型和 API Key，高级字段默认折叠。
- [ ] 实现模型能力提示、连接测试、路由选择、MCP 逐项开关和权限撤销。
- [ ] 验证无工具能力模型不能保存为 Agent 模型，跨提供商回退需要明确授权。
- [ ] 使用 Mock Provider 与 MCP 夹具完成聊天、工具确认、取消、失败和角色状态 E2E。
- [ ] 运行 `pnpm --filter @myself/desktop test`、`typecheck`、`build` 和目标 E2E。

## 完成门禁

- [ ] 设计规格的十项验收标准均有对应自动化或明确人工验收记录。
- [ ] `rg` 检查普通设置、日志、夹具和构建产物中不存在真实 API Key。
- [ ] 关闭应用后无 MCP 子进程残留。
- [ ] 未经用户另行许可，不执行任何 Git 写操作。
