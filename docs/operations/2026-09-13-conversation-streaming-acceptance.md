# 普通聊天流式输出修复验收

日期：2026-09-13。环境：Windows，当前隔离工作区，使用本机 Edge 无头浏览器验证气泡排版。

## 修改与范围

原链路没有实际流式：Provider 等待完整 JSON，Qwen 固定 `stream:false`，聊天适配器没有转交增量回调，协调器还会缓存到完整响应后再发布。

修复后普通聊天复用已有 start/delta/commit 事件，网络正文到达即显示。DeepSeek 使用 SSE；Qwen 保留私有单次 chat/task 判别，仅逐段解码已确认 chat 的正文，最终仍执行原校验。JSON 回退不伪造打字，不重试已经产生增量的请求。

取消、错误及原生工具晚到时撤销未提交草稿；完整成功才保存历史。修正流式协议与展示中 UTF-16 计数不一致的问题，保持原有四千 Unicode 码点的正文上限。

气泡已有内容自适应与修订驱动重新测量，确认满足要求后直接复用。未改文件执行、授权判断、角色行为决策、模型选择、提示词任务语义及会话保存规则。此前视觉重构的既有改动保留；本次不执行 Git 写操作，不新增依赖。

## 实际验证

以下命令均退出 0：

```powershell
pnpm.cmd --filter @myself/desktop test tests/openai-provider.test.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts tests/conversation-chat-adapter.test.ts tests/conversation-coordinator.test.ts tests/conversation-transcript.test.ts tests/conversation-session-store.test.ts tests/chat-presentation-controller.test.ts tests/use-chat-presentation.test.tsx tests/chat-bubble-view.test.tsx tests/presentation-layout.test.tsx
pnpm.cmd --filter @myself/shared-types test tests/contracts.test.ts
pnpm.cmd typecheck
pnpm.cmd --filter @myself/desktop build
node .superpowers/sdd/2026-09-13-conversation-streaming/verify-bubble.mjs
git diff --check
```

- 桌面定向测试 403 项，共享契约测试 44 项，共 447 项通过。
- RED 实际复现：结束帧前无正文、回到准备阶段草稿未清理、四千码点 emoji 被误删；对应修改后转绿。
- SSE 测试覆盖 UTF8 分块、正文/工具隔离、空工具数组、结束标记缺失、取消及非流式回退。Qwen 测试覆盖字段顺序、JSON 转义、代理对、思考标签、无正文任务分支、非法最终字段及旧 generation。
- 类型检查通过。因流式字符预算位于共享契约，检查了 workspace 类型兼容；没有运行网站、角色或模型切换的功能回归。
- 桌面最终源码构建通过，包含现有 preload 和生产边界检查。构建仍有第三方 `eval` / `use client` 提示，未作为本任务扩展处理。
- 真实浏览器向同一气泡逐段注入正文：宽度 54 → 194 → 440 像素，高度约 66 → 223 → 439 像素。每次布局同步上报；最后文本滚动高度 1421 像素，显示高度 405 像素，完整文字保留。未发现页面错误。截图已实际查看。
- 差异检查通过，仅存在仓库 LF/CRLF 转换提示。复用视觉样式，无额外视觉设计改动。

浏览器证据：[尺寸与正文记录](../../.superpowers/sdd/2026-09-13-conversation-streaming/bubble-evidence/facts.json)、[增量截图](../../.superpowers/sdd/2026-09-13-conversation-streaming/bubble-evidence/increment-3.png)。规格与实施拆解见[修复规格](../superpowers/specs/2026-09-13-conversation-streaming-fix.md)和[计划](../superpowers/plans/2026-09-13-conversation-streaming-fix.md)。

## 尚未验证

本次没有读取真实密钥或调用真实 DeepSeek/Qwen，没有启动真实桌宠做原生窗口流式验收。真实服务首段延迟、用户模型配置与 Windows 头顶气泡体验仍待重启桌宠后人工确认；受控 SSE 与浏览器证据不替代这些事实。
