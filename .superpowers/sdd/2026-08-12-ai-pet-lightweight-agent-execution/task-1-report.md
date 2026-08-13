# Task 1 执行报告

## 范围

将 `@myself/file-tools` 从旧的宽泛文件操作收敛为五个工具：`list_files`、`read_file`、`create_file`、`apply_patch`、`delete_file`。

## TDD 记录

- 五工具严格 schema：先验证旧 schema 导致断言失败，再收敛为五个 `.strict()` schema。
- 只读工具：先验证新工具名未被识别，再实现有界目录扫描与 UTF-8 行范围读取。
- `create_file`：先验证写预览尚未实现，再实现 WeakMap 私有正文与 `open('wx')`。
- `apply_patch`：先验证新工具名未被识别，再用 `diff@8.0.2` 实现单补丁解析、零模糊匹配、SHA-256 基础校验与同目录原子替换。
- `delete_file`：先验证新工具名未被识别，再实现空目录/普通文件校验、私有身份校验与回收站端口调用。
- 审查修复轮次 1：先验证 hunk 正文 `---`/`+++` 被错误计数，再改为基于 `parsePatch()` 的 hunk 行计数；先验证回收站端口异常被错误映射，再恢复稳定 `RECYCLE_BIN_FAILED` 错误且保持动作一次性。

## 验证

- `pnpm.cmd --filter @myself/file-tools test`：2 个测试文件、36 个测试通过。
- `pnpm.cmd --filter @myself/file-tools typecheck`：通过。
- `git diff --check`：通过。
- `git diff --name-only -- apps/website`：无输出，未触碰网站。

## 注意事项

Vitest 在受限沙箱中加载现有配置时无法读取工作区上级目录；已使用获得批准的本地外执行完成每个 RED/GREEN 和最终验证。Windows 不允许创建 Junction 时，两个链接测试按 Vitest 标记为跳过。
