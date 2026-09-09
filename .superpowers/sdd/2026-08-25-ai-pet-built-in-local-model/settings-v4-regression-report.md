# Settings V4 全桌面回归修复报告

## 范围

- 基线：`0434cc53fc58461f786f51920c693bac420e161b`
- 修改文件：`apps/desktop/tests/provider-settings-migration.test.ts`
- 未修改生产实现，也未修改 SDD ledger。

## 根因与修复

目标测试中两处 V1 设置迁移断言仍写死 `version: 3`，而 Task 1 已将迁移结果升级为 V4。按现行 `SettingsStore` 契约，最小修复为：

- 将两处版本断言更新为 `version: 4`；
- 在迁移后的完整设置断言中增加默认 `localModel.enabled === true`。

## 验证

- 基线定向回归：8 项测试中 `2 failed / 6 passed`；失败均为实际 `version: 4` 与旧断言 `version: 3` 不一致。
- 修复后定向测试：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/provider-settings-migration.test.ts`，1 个测试文件、8 项测试全部通过。
- Desktop typecheck：`pnpm.cmd --filter @myself/desktop typecheck`，`tsc --noEmit` 退出码为 0。
- `git diff --check`：通过，未报告空白错误；Git 仅提示工作文件存在 LF/CRLF 行尾转换提示。

## 未覆盖项

未执行真实 Electron 窗口、安装包或 Windows 人工验收；本次仅修正设置迁移回归断言。
