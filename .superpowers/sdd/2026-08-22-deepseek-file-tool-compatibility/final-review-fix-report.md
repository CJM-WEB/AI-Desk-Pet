# DeepSeek 文件工具兼容终审修复报告

## 范围

- 起始提交：`a9635f62c949f8ffe05b389c7b693243c33a8505`。
- 仅处理终审简报中的修复提示泄露、澄清语义校验、固定范围空白门禁与规格证据；未修改 MCP 或其他桌宠功能。

## RED 证据

1. `pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts` 首轮退出 1：46 条中 40 通过、6 失败。失败分别证明英文合法缺参问题被误拒，中文“可以/是否”、英文 `Can I` 执行确认和无关问题被错误公开。
2. `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts` 首轮退出 1：39 条中 38 通过、1 失败。真实 `OpenAICompatibleProvider` 修复轮的系统提示包含内部名 `builtin.capability.request_clarification`。
3. 收敛检查新增“删除 empty 文件夹吗？  ”直接确认识别测试，定向命令退出 1：目标测试 0/1 通过，证明问句尾随空白未被确认识别器本身捕获。

## GREEN 实现

- `AgentLoop` 的一次修复提示只描述“当前提供的无权限结构化澄清工具”，不硬编码内部或外部工具名。
- 澄清控制边界先拒绝广义中英文 yes/no 执行确认，再正向要求路径、文件名、目录、内容、补丁、命令、工作目录、文件数据授权或对应疑问位置等缺参线索；合法中英文缺参问题继续通过，澄清仍不会进入 `ToolRuntime`。
- 真实 OpenAI-compatible 纵向测试从第二轮请求体识别当轮澄清定义，并使用请求体实际出现的外部别名返回工具调用。
- 固定范围内的尾随空格与 EOF 多余空行已清理；设计规格已固定 `.` → `__` 及 `builtin__capability__request_clarification`。

## 最终门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm.cmd --filter @myself/agent-core test` | 退出 0；61/61 通过 |
| `pnpm.cmd --filter @myself/desktop test` | 退出 0；1823 通过、14 跳过 |
| `pnpm.cmd test:integration` | 退出 0；51/51 通过 |
| `pnpm.cmd --filter @myself/agent-core typecheck` | 退出 0 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 退出 0 |
| `git diff --check 03b3efc..HEAD` | 提交实现后退出 0；无输出 |

## 未验证项与 Concerns

- 真实 DeepSeek API、真实账号模型响应、真实 Windows 回收站与开发模式窗口仍待用户人工确认；自动 fixture 不能替代这些观察。
- 缺参语义校验刻意采用有界中英文线索表；未覆盖的新表达会进入一次协议修复并稳定失败，而不会被放宽为本地执行。
- 本修复未处理既有 MCP 代码或契约，也未修改角色行为、缩放、碰撞、拖拽和工作台功能。

## 提交

- 提交说明：`fix(agent): 收口 DeepSeek 结构化澄清协议`。
- 最终提交哈希以修订提交后的 Git 输出为准。
