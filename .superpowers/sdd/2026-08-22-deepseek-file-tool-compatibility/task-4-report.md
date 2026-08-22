# Task 4：Desktop 纵向验收与状态记录

## 状态

自动化通过；真实 DeepSeek API、真实 Windows 回收站与开发模式窗口操作待用户人工确认。正式 preload 仍有既有 MCP 方法，因此“正式 preload 不出现 MCP API”未通过并转为独立 SDD 安全子项目。

## 修改文件

- `tests/integration/desktop-agent.test.ts`：新增 DeepSeek 真实 `message.tool_calls` 纵向 fixture，覆盖删除、创建/拒绝覆盖、澄清和文件数据授权关闭；旧集成 fixture 复用正式 Codec 输出外部别名。
- `apps/desktop/tests/conversation-coordinator.test.ts`：固定“你好呀”的零工具策略，并确认 MCP runtimeSupport 关闭。
- `tests/security/permission-boundary.test.ts`：经父任务批准的计划文件列表偏差；旧安全 fixture 复用正式 Codec 输出外部别名。
- `tests/e2e/desktop.spec.ts`：经父任务批准的计划文件列表偏差；旧 E2E fixture 和 Provider 可见白名单断言改为外部别名，并保留结构化澄清工具。
- `docs/operations/lightweight-agent-acceptance.md`：追加本次实际自动证据与未验证项。
- `.superpowers/sdd/2026-08-22-deepseek-file-tool-compatibility/task-4-report.md`：本报告。

生产代码未修改；`apps/desktop/src/main/conversation/main-conversation-composition.ts` 无差异，因为 RED 未证明 Provider 组合接线缺口。

## RED / GREEN

### RED

1. 指定纵向命令退出 1：`desktop-agent.test.ts` 38 条中 14 通过、24 失败，错误均为 `PROVIDER_UNKNOWN_TOOL_CALL`；新增的 4 条 DeepSeek 用例已通过，失败来自旧 fixture 仍返回内部点号工具名。
2. 指定 Coordinator 命令退出 0：56/56 通过，证明普通聊天与 runtimeSupport 边界已有实现。
3. `pnpm.cmd test:security` 首轮退出 1：15 通过、5 失败，同样由旧安全 fixture 内部名触发。
4. 第一次 `pnpm.cmd verify:desktop` 退出 1：Electron E2E 57 通过、5 失败；其余 typecheck、单元、安全、集成和构建阶段通过。只读检查和定向诊断证明 E2E `toolResponse` 与两处白名单断言仍使用内部点号名；PowerShell 首轮实际包含运行工具与结构化澄清工具。

### GREEN

1. 集成、安全与 E2E fixture 改为复用正式 `createOpenAIToolNameCodec`；新增 DeepSeek raw fixture 继续使用手写外部别名，避免期望值与被测 Codec 同源。
2. 定向集成 38/38、Coordinator 56/56、安全 20/20 通过。
3. 第一次失败的 5 条 Electron E2E 定向重跑 5/5 通过。
4. 未修改 Adapter、AgentLoop、文件工具、权限策略或组合根。

## 阶段门禁结果

| 命令 | 结果 |
| --- | --- |
| `pnpm.cmd --filter @myself/agent-core test` | 退出 0；51/51 通过 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 退出 0 |
| `pnpm.cmd --filter @myself/desktop test` | 退出 0；1823 通过、14 跳过 |
| `pnpm.cmd test:security` | 退出 0；20/20 通过 |
| `pnpm.cmd test:integration` | 退出 0；50/50 通过 |
| `pnpm.cmd verify:desktop` | 最终退出 0；typecheck、2270 单元（14 跳过）、20 安全、50 集成、生产构建、preload 外部依赖校验和 62 Electron E2E 全部通过 |
| `git diff --check` | 退出 0；仅输出工作区现有 LF→CRLF 提示，无空白错误 |

## 未验证项

- 真实 DeepSeek API、真实账号和远端模型响应：待用户人工确认。
- 真实 Windows 回收站中的可恢复性：待用户人工确认；自动测试只使用隔离端口。
- `pnpm.cmd --filter @myself/desktop dev` 下发送删除请求和“你好呀”的人工窗口观察：待用户人工确认。
- 正式 preload 不出现 MCP API：未通过。既有 MCP 方法仍存在；本次确认 runtimeSupport 为 false，且两个设置窗口 E2E 均观察到 MCP 入口不可见。该契约删除必须进入独立 SDD 安全子项目。

## 提交

- 起始提交：`d7d126f98722c9564ec4d3317aceaf964a4414dd`。
- 计划提交说明：`test(desktop): 验收 DeepSeek 文件能力闭环`。
- 本报告随上述 Task 4 提交纳入版本库；最终提交哈希以 Git 提交输出与交付消息为准，提交对象不能自包含自身哈希。

## Concerns

1. 正式 preload 仍暴露既有 MCP 方法，虽然 runtimeSupport 和正式 UI 均关闭；这是明确未通过项，不得宣传为 MCP API 已删除。
2. 本轮没有访问真实 DeepSeek API，也没有观察真实 Windows 回收站或开发模式窗口；自动 fixture 证据不能替代这些人工验收。
3. 为恢复 Tasks 1–3 后的既有门禁，修改范围比 brief 文件表多两个测试文件；父任务已逐项批准，且改动只涉及 fixture/断言，没有生产行为变化。
