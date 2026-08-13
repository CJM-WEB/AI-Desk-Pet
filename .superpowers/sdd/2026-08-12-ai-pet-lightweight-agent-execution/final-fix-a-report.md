# 最终修复 A 报告：文件工具边界

## RED 证据

- `read_file`：单行接近 1 MiB 的有效 UTF-8 文本被完整返回，字符上限断言失败。
- `create_file`：API key、带前缀 API key、Bearer、PEM、password、secret、token 与超过 200 字符的正文仍进入公开预览。
- `create_file`：注入写入失败、关闭失败后，新建目标未被可靠清理。
- `apply_patch`：注入临时文件写入、关闭、改名失败后，临时文件未被可靠清理；竞争方替换同名临时路径时缺少所有权保护。
- 共享确认契约与 Renderer：新增抑制原因字段及对应中文提示在实现前分别得到严格 schema RED 和渲染 RED。

## GREEN 实现

- `read_file` 的返回正文限制为 64 Ki 个 UTF-16 字符单元，并避免截断代理项；保留 fatal UTF-8 解码、请求行范围和 `truncated` 语义。
- `create_file` 按 Unicode code point 统计字符数；敏感正文返回 `sensitive`，过长正文返回 `too_long`，两者公开预览均为 `null`。
- `create_file` 与 `apply_patch` 复用单一的新文件写入辅助；写入、关闭、改名失败均尽力清理。
- 清理前使用本次打开句柄取得的 `dev/ino` 核对路径实体，仅删除仍属于本次创建的目标或临时文件，不删除竞争方替换文件。
- Main、共享类型、严格 Zod schema 和确认卡同步 `contentPreviewSuppressedReason`；确认卡只展示字符数和中文抑制原因。

## 验证

- `@myself/file-tools`：2 个测试文件，52/52 通过。
- `@myself/shared-types`：1 个测试文件，18/18 通过。
- Desktop 定向：`renderer-components`、`agent-service`、`pending-action-store` 共 3 个测试文件，92/92 通过。
- `@myself/file-tools`、`@myself/shared-types` typecheck 通过；`@myself/desktop` 在字段收紧前通过，字段收紧暴露的 7 个旧测试夹具已同步，但按主控停止长命令的要求尚未新鲜复验。
- `git diff --check` 通过；`git diff --name-only -- apps/website` 无输出。

## 文件范围

- `packages/file-tools/src/file-tool-service.ts`
- `packages/file-tools/tests/file-tool-service.test.ts`
- `packages/shared-types/src/contracts.ts`
- `packages/shared-types/tests/contracts.test.ts`
- `apps/desktop/src/main/agent/agent-service.ts`
- `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- `apps/desktop/tests/agent-service.test.ts`
- `apps/desktop/tests/pending-action-store.test.ts`
- `apps/desktop/tests/renderer-components.test.tsx`
- `apps/desktop/tests/character-behavior-service.test.ts`
- `apps/desktop/tests/conversation-coordinator.test.ts`
- `apps/desktop/tests/renderer-task-store.test.ts`

## 注意事项

- 未扩大既定 TOCTOU 威胁模型；实体身份核对只用于防止失败清理误删竞争方文件。
- 未修改、构建、启动或测试网站。
- 未执行 Git 写操作；提交由主控统一完成。
