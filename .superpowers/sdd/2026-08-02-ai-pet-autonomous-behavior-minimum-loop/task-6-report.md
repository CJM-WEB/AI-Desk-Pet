# Task 6 实施报告：转发可选结构化行为意图

## 状态

DONE

## RED 失败证据

已在未实现行为转发时运行以下命令：

```powershell
pnpm.cmd --filter @myself/agent-core test -- agent-loop.test.ts
pnpm.cmd --filter @myself/desktop test -- openai-provider.test.ts provider-contract.test.ts agent-service.test.ts
```

- Agent Core 的“合法行为意图在助手消息之前发出”失败：实际事件缺少 `behavior_intent`。
- 桌面测试中 OpenAI Provider 的合法意图规范化失败：实际文本响应缺少 `behaviorIntent`。
- AgentService 的内部回调测试失败：回调调用次数为 0。
- RED 期间其余既有测试均通过，失败均指向尚未实现的行为意图转发。

## GREEN 与回归结果

```powershell
pnpm.cmd --filter @myself/agent-core test
# 通过：2 个测试文件，31 项测试

pnpm.cmd --filter @myself/agent-core typecheck
# 通过

pnpm.cmd --filter @myself/desktop test -- agent-service.test.ts openai-provider.test.ts provider-contract.test.ts
# 通过：实际执行桌面测试集，59 个测试文件，1018 项通过，14 项跳过

pnpm.cmd --filter @myself/desktop typecheck
# 通过
```

## 变更摘要

- Agent Core 直接复用 `@myself/character-runtime` 的 `CharacterAgentBehaviorIntent` 与严格 Schema；文本响应可选携带行为意图，循环在助手消息前二次校验并发出 `behavior_intent`。
- OpenAI-compatible Provider 仅读取既有 `message.metadata.behaviorIntent`；非法元数据会被丢弃，文本保持成功；工具请求不携带行为意图。
- Anthropic 与 Gemini 没有此业务意图的标准响应扩展槽，契约测试明确验证其保持无意图并忽略伪造元数据，不进行额外模型请求。
- AgentService 仅调用新增的内部 `emitBehaviorIntent` 回调，不向 Renderer 的 `TaskEvent` 广播解释文本。

## 提交哈希

`e1a0852aa56e5dbe91d5d3b9e28feb42212fd1a4`（`feat：转发智能体行为意图`）

## 自审与关注点

- 已检查 `git diff --check`，无空白错误；改动未触及 Website 或 WebsiteExtension。
- 仅新增角色运行时依赖及对应锁文件条目；没有新增工具、模型请求或重复 Schema。
- 无阻塞关注点。
