# DeepSeek 宿主确认协议修复报告

## 根因

能力任务参数已经齐全时，模型仍可能返回严格的 `clarification_required` JSON，请用户再次确认删除或执行。AgentLoop 原先只校验 JSON 形状，因此把该模型确认句当成合法澄清公开；宿主没有收到工具调用，也就无法签发带 `actionId` 的正式确认卡。

## 最小修复

- AgentLoop 在首次可信工具结果前区分“缺少必需参数的澄清”和“模型自行索要执行确认”。后者进入既有的一次协议修复；第二次仍违规时返回 `CAPABILITY_PLAN_PROTOCOL_INVALID`。
- 分类使用中英文小型结构判断：缺参请求词与参数名优先保留为澄清；只有同时出现确认主干和操作意图时才判为模型确认。覆盖“确定”“真的”“是否”“要不要”和英文 `want me` 等表达，不使用任意词距正则。
- Main 能力会话提示明确：参数齐全立即调用工具；模型不得自行确认；确认卡完全由宿主在工具调用后生成；澄清只用于缺失执行必需参数。
- 未修改普通聊天、工具权限、确认卡、文件执行或 PowerShell 执行机制。

## TDD 证据

RED：

- AgentLoop：30 项中 2 项失败，证明确认型澄清被错误公开。
- Main 会话工厂与 AgentService：59 项中 3 项失败，证明职责提示缺失且截图原句没有生成正式确认卡。

GREEN：

- `packages/agent-core/tests/agent-loop.test.ts`：36/36 通过；允许“请提供要删除的文件名”“请说明要运行的脚本”，拒绝“确定要删除吗”“你真的要删除吗”“Do you want me to delete it?”及截图原句。
- `apps/desktop/tests/main-agent-session-factory.test.ts` 与 `agent-service.test.ts`：59/59 通过。
- `tests/integration/desktop-agent.test.ts`：34/34 通过；覆盖真实 Provider 确认 JSON、一次修复、`delete_file` 工具调用和正式确认卡。测试使用真实 `actionId` 完成既有播放开始与提交帧事务，受控回收站端口只调用一次，空目录确实被移动，模型确认句未进入聊天正文。
- `@myself/agent-core` 类型检查通过。
- `@myself/desktop` 类型检查通过。
- `git diff --check` 通过；网站目录零修改。

## 文字“确认执行”的边界

正式执行仍只接受确认卡携带的 `actionId`。当前既有会话契约允许新文字任务替换等待中的确认，因此对应测试准确命名为“等待确认时新文字任务会替换旧卡且不能冒充 actionId 确认”：文字“确认执行”会作为新任务处理并使旧 `actionId` 失效，不能直接执行此前删除动作。

## 独立审查修复轮次 1

本轮先取得真实 RED：AgentLoop 新增 6 个分类用例后 5 项失败；集成确认执行因未完成既有删除事务而在 5 秒超时。完成最小分类器与受控事务测试后，AgentLoop 36/36、桌面最窄测试 59/59、纵向集成 34/34 全部转为 GREEN，两项类型检查继续通过。
