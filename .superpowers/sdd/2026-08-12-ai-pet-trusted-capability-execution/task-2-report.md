# Task 2（C2）执行报告：文件 Agent 首次工具协议

## 范围与接口

- 新增 `AgentRunProtocol` 和 `FilePlannerResult`，`RunContext.protocol` 为可选字段。
- 仅 `AgentService` 的文件任务运行显式传入 `file_planner`；默认 `AgentLoop` 和聊天语义仍允许普通文本。
- 首个可信工具结果前，文件任务只接受工具请求或严格的澄清 JSON。第一次文本违约只追加一条不写回会话历史的受限修复指令；第二次抛出 `FILE_PLAN_PROTOCOL_INVALID`。
- 读取工具或确认后真实写入的工具结果进入本地 tool message 后，模型自然语言总结恢复允许。

## RED / GREEN 记录

1. RED：新增“工具前普通文本连续两次违约”与“合法严格 JSON 澄清”测试。
   - 命令：`pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts`
   - RED：20 项中 2 项失败。普通文本被公开并产生 `success`；合法 JSON 被原样公开。
   - GREEN：实现受限协议后，24/24 通过。
2. RED：新增 Markdown、额外字段、空白问题和超长问题的非法澄清用例。
   - 变异验证：临时移除“字段数必须为 2”校验后，额外字段用例失败（24 项中 1 项失败），说明测试能阻止该生产错误。
   - GREEN：恢复校验后 AgentLoop 24/24 通过。
3. GREEN：文件任务连续伪成功会公开稳定错误码而不公开模型正文；合法澄清仅公开问题；修复请求的工具定义保持与原请求一致。
4. RED：新增“重置后迟到的协议修复响应”测试。
   - 变异验证：临时移除 `forward` 与 `publish` 的 owner 隔离后，定向测试失败，暴露旧任务消息和 `success`。
   - GREEN：恢复 owner 隔离后，迟到修复响应不会公开也不会写入会话历史。
5. GREEN：AgentService 定向测试 40/40 通过，覆盖确认暂停/恢复、取消、owner/reset/迟到响应隔离与写入后总结。

## 验证命令与计数

- `pnpm.cmd exec vitest run --config packages/agent-core/vitest.config.ts packages/agent-core/tests/agent-loop.test.ts`：24/24 通过。
- `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/agent-service.test.ts`：40/40 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `git diff --check`：通过。
- `git diff --name-only -- apps/website` 与 `git status --short -- apps/website`：均为空，未修改、未运行网站。

说明：受限沙箱内运行 Vitest 时，esbuild 无法读取工作区外层目录；使用已获批准的受限沙箱外同一命令后完成 RED/GREEN 与最终验证。

## 修改文件

- `packages/agent-core/src/types.ts`
- `packages/agent-core/src/agent-loop.ts`
- `packages/agent-core/tests/agent-loop.test.ts`
- `apps/desktop/src/main/agent/agent-service.ts`
- `apps/desktop/tests/agent-service.test.ts`
- 本报告

## 自审

- 修复指令不改变 tools，也不携带新增权限；违规模型正文不追加到模型消息或会话历史。
- 严格澄清要求无额外字段、非空且上限 1000 字符；Markdown 与非 JSON 均拒绝。
- 首次真实工具结果的标记只由内部读取执行结果或受控确认续跑建立。
- 变更未触及 Router、Coordinator 或网站目录，未复制 AgentLoop。

## 提交

- 实现提交：`77b5f98 fix: 强制文件计划先调用真实工具`；子智能体审批拒绝后由主控依据用户直接授权提交。
