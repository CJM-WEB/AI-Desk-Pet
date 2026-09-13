# 普通聊天真实流式修复计划与执行核对

适用规格：[普通聊天真实流式修复](../specs/2026-09-13-conversation-streaming-fix.md)。用户已明确要求修复流式输出并补充气泡动态自适应。仅处理本链路，采用主任务整合与两个 Provider 子任务并行实施。

| 步骤 | 文件与依赖 | RED → GREEN 及完成标准 | 状态 |
| --- | --- | --- | --- |
| OpenAI 兼容 SSE | `apps/desktop/src/main/providers/openai-provider.ts`、`openai-event-stream.ts`、`apps/desktop/tests/openai-provider.test.ts` | 挂起结束帧时首段缺失先失败；接入 SSE 后正文即时回调，工具、取消、结束标记与 JSON 回退通过 | 自动化通过 |
| Qwen 正文投影 | `apps/desktop/src/main/providers/local-model-provider.ts`、`local-conversation-text-stream.ts`、`apps/desktop/tests/local-model-provider.test.ts`；依赖 SSE | 结束前正文缺失先失败；保持原单次判别，只逐段解码合法 chat 正文 | 自动化通过 |
| 主链接通 | `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`、`conversation-coordinator.ts`、`apps/desktop/tests/conversation-coordinator.test.ts` | 真实适配器与协调器在 Provider 挂起时首段测试先失败；移除整段缓冲后逐段显示，最终才提交历史 | 自动化通过 |
| 撤销与字符预算 | `apps/desktop/src/shared/conversation-transcript.ts`、`apps/desktop/src/renderer/src/chat/chat-presentation-controller.ts`、`packages/shared-types/src/contracts.ts` 及对应测试 | 工具晚到清草稿、四千 emoji 不丢失先失败；统一码点预算与未提交流清理后通过 | 自动化通过 |
| 气泡动态尺寸 | 既有 `ChatBubbleView.tsx`、`use-presentation-layout.ts`、CSS；新增 hook 增量用例与隔离浏览器夹具 | 确认已有自适应机制满足要求，复用而不增加另一套尺寸计算 | 实际浏览器观察通过 |
| 收口 | 精确测试文件、类型检查、构建、差异检查及验收记录 | 只验证当前链路，不修改额外问题；无 Git 写操作 | 已完成 |

实际命令和限制见[验收记录](../../operations/2026-09-13-conversation-streaming-acceptance.md)，计划本身不替代验证结果。
