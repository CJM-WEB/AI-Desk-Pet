# 最终收尾修复报告

## 状态

已完成指定的三个 Minor，未扩展修改范围。

## 修复内容

1. `FeedbackStorageError` 新增显式 `code`，取值为 `STORAGE_UNAVAILABLE` 或 `WRITE_FAILED`。`FeedbackChapter` 改为判别 `code`，不再依赖 `cause === null`，两条用户提示文案保持不变。
2. `storage: null` 的创建写入失败后重新调用 `list`，断言反馈列表与失败前完全一致，证明内存文档未被污染。
3. 可控 RAF 与 React Profiler 测试新增直接断言：进入 `leaving` 时新增一次 React commit 且 DOM `data-phase` 更新；随后自然移除时再新增一次 commit 且 DOM 图标消失。未修改 FileSwarm 生产逻辑。

## TDD 记录

- 覆盖增强验证：先仅加入第 2、3 项断言，在未修改生产代码时运行网站测试，27 个测试文件、210 个测试全部通过。因此这两项记录为现有正确行为的覆盖增强，不记作 RED。
- RED：加入第 1 项判别码契约后，三个精确目标文件共 38 个测试中有 3 个按预期失败：缺少 `WRITE_FAILED`、缺少 `STORAGE_UNAVAILABLE`，以及章节仍按旧 `cause` 分支显示通用提示。
- GREEN：完成最小实现后，三个精确目标文件全部通过，共 38 个测试通过。

## 验证

- 目标测试：`local-storage-feedback-repository.test.ts`、`feedback-chapter.test.tsx`、`feedback-preview-source.test.ts`，38/38 通过。
- 类型检查：`pnpm.cmd --filter @myself/website typecheck` 通过。
- 差异检查：`git diff --check` 通过，仅输出工作树 LF 将来可能转换为 CRLF 的提示，无空白错误。

## 关注点

- `FeedbackStorageError.cause` 仅保留底层写入异常用于诊断，业务分支只使用 `code`。
- FileSwarm 的阶段提交策略由新增 Profiler/DOM 断言锁定，生产逻辑保持原状。
