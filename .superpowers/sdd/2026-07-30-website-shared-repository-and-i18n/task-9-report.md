# Task 9 最终自动化回归报告

## 完成内容

- 国际化资源回归同时校验中英文键集一致，并确认每条文本非空。
- 回归覆盖从首页切换英文、导航至 `community` 后语言入口消失、社区标题保持英文，以及返回首页后入口和英文选中态恢复。
- 六章节视觉回归补齐 `community` 背景变体，并覆盖社区 `safeZoneRatio` 复用和 `3.5`、`4.5` 视觉过渡边界。
- 更新 `WebsiteExperience.tsx` 与 `shared-visual-model.ts` 的六章节中文结构性注释，明确包含社区。

## 验证命令与结果

| 命令 | 精确结果 |
| --- | --- |
| `pnpm.cmd --filter @myself/website test -- tests/i18n.test.tsx tests/website-fallback.test.tsx tests/chapter-visual-primitives.test.tsx tests/shared-visual-model.test.ts` | 初始红灯：`chapter-visual-primitives.test.tsx` 缺少 `[data-chapter-id='community']`，共 `1 failed / 299 passed`。 |
| `..\\..\\node_modules\\.bin\\vitest.cmd run --config vitest.config.ts tests/i18n.test.tsx tests/website-fallback.test.tsx tests/chapter-visual-primitives.test.tsx tests/shared-visual-model.test.ts`（在 `apps/website`） | 通过：`4 passed` 文件，`36 passed` 测试。 |
| `pnpm.cmd --filter @myself/website test` | 通过：`33 passed` 文件，`300 passed` 测试，退出码 `0`。 |
| `pnpm.cmd --filter @myself/website typecheck` | 通过：`tsc --noEmit`，退出码 `0`。 |
| `pnpm.cmd --filter @myself/website build` | 通过：Next.js `15.5.21` 完成编译、类型检查、4 个静态页面生成和 2 个导出页面，退出码 `0`。 |
| `git diff --check` | 通过：无差异格式错误。 |

Vitest 的 esbuild 配置在受限沙箱内无法读取，测试、类型检查与构建均在获得许可后于沙箱外执行。未打开浏览器，未执行逐页浏览、截图对比或人工视觉验收。

## 提交

功能变更提交 SHA：`0903dff`（`test(website): 完成共享仓库与国际化回归`）。

## 风险

- 未进行浏览器人工验收，风险由自动化章节导航、国际化、视觉模型和生产构建覆盖缓解。
- 工作区保留用户既有改动：`apps/website/components/website-experience/community/indexed-db-shared-pet-repository.ts`、`apps/website/tests/indexed-db-shared-pet-repository.test.ts` 与 `apps/website/.next-corrupt-20260730/`；本任务未修改、未暂存这些路径。
