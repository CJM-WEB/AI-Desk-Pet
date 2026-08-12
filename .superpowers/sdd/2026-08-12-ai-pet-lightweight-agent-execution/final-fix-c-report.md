# 最终修复 C 报告：PowerShell 清理与文件错误贯通

## 修改结果

- PowerShell 每次运行缓存唯一的完成 Promise；Abort、静默超时和 close 复用同一清理结果，`killTree` 清理结束后才释放活动运行。
- 新增集中式文件公开错误表，统一 AgentService 与 ConversationCoordinator 的安全中文消息和下一步建议。
- `ENTRY_CHANGED`、`ENTRY_TYPE_UNSUPPORTED`、`LINK_NOT_ALLOWED`、`RECYCLE_BIN_FAILED` 保持原错误码贯穿能力边界，不泄露底层绝对路径或原始异常消息。
- 删除文件事务仅保存白名单内的安全错误码；回收站端口失败不再被压成 `FILE_TASK_EXECUTION_FAILED`。
- Coordinator 对已经发布 error 与 error phase 的失败只转发一次；随后 Promise 拒绝不会降级为 `AGENT_INTERNAL_ERROR` 或重复发布。

## RED 证据

1. PowerShell 挂起清理后关闭：2 个用例失败，`closeSettled` 实际为 `true`，证明 close 提前完成。
2. AgentService 文件错误映射：4 个用例失败，事件保留 code，但消息为通用失败且缺少 `nextAction`。
3. Coordinator 文件错误贯通：4 个用例失败，拒绝全部降级为 `AGENT_INTERNAL_ERROR`。
4. 真实回收站失败：1 个用例失败，收到 `FILE_TASK_EXECUTION_FAILED` 而非 `RECYCLE_BIN_FAILED`。

## GREEN 证据

- PowerShell 竞态定向测试：2/2 通过。
- AgentService 文件错误映射：4/4 通过。
- Coordinator 文件错误贯通：4/4 通过。
- 真实回收站失败：1/1 通过。
- 完整定向回归：
  - `powershell-tool.test.ts`：34/34；
  - `agent-service.test.ts`：52/52；
  - `capability-task-adapter.test.ts`：19/19；
  - `conversation-coordinator.test.ts`：54/54；
  - 合计 4 个测试文件、159/159 通过。

## 静态验证

- `git diff --check`：通过。
- `git diff --name-only -- apps/website`：无输出，网站零差异。
- `pnpm.cmd --filter @myself/desktop typecheck`：当前被并行修复中的既有测试 fixture 阻塞；`apps/desktop/tests/pending-action-store.test.ts` 的 `privateAction()` 缺少另一修复新增的 `contentPreviewSuppressedReason`。本修复 C 未越界修改该文件。

## 修改文件

- `apps/desktop/src/main/agent/powershell-tool.ts`
- `apps/desktop/src/main/agent/agent-service.ts`
- `apps/desktop/src/main/agent/file-task-public-errors.ts`
- `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- `apps/desktop/tests/powershell-tool.test.ts`
- `apps/desktop/tests/agent-service.test.ts`
- `apps/desktop/tests/conversation-coordinator.test.ts`

## 注意事项

- 工作区由多个最终修复共享；`AgentService` 与测试中可见的 `contentPreviewSuppressedReason` 接线属于并行修复，本报告不将其归为修复 C。
- 未执行任何 Git 写操作，提交由主控统一完成。
