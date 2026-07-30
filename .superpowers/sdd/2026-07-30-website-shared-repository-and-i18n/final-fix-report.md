# 官网共享仓库与国际化最终修复报告

## 修复映射

1. `SharedPetDetailDialog` 增加 `onDownload`、`downloadDisabled` 与下载 footer；`SharedPetChapter` 统一复用 `handleDownload`，下载锁同时禁用卡片和详情入口，成功后同步更新详情与当前页面计数。
2. 共享仓库标题与 CTA 精确更新为“AI Pet 共享仓库”“分享您的 AI Pet”及“AI Pet Community”“Share Your AI Pet”，并更新精确断言和流程查询。
3. `SharedPetComposerDialog` 按 `invalidField` 将 ZIP、封面、名称、描述错误放回对应字段容器；非字段提交错误保留单一全局节点，字段的 `aria-describedby` 关联不变。
4. `LanguageMenu` 在选择后恢复 trigger 焦点，并为 `menuitemradio` 增加 ArrowUp、ArrowDown、Home、End 循环焦点；未改变 `WebsiteExperience` 中仅首页挂载语言菜单的条件。
5. `WebsiteExperience` 将 `feedbackVisualProfile.setTranslate(t)` 从 render 移入 `useEffect`；新增 I18nProvider 到 WebsiteExperience 再到真实反馈预览粒子的中文转英文切换测试。
6. `community.module.css` 的桌面与窄屏弹窗 padding 均复用 `max(..., env(safe-area-inset-*))` 项目模式。
7. `i18n.test.tsx` 保存并逐测试恢复 `navigator.language` 描述符；新增预置 `en` 优先于中文浏览器语言的重新挂载测试，以及非法存储值回退测试。

## TDD 与验证

- RED：首次聚焦运行确认文案、焦点导航、字段错误位置、安全区、CTA 与详情下载流程共 10 个预期失败；存储优先级和非法值回退在基线实现上通过。
- GREEN：`pnpm.cmd exec vitest run --config vitest.config.ts tests/i18n.test.tsx tests/shared-pet-dialogs.test.tsx tests/shared-pet-chapter.test.tsx tests/website-fallback.test.tsx`
  - 结果：4 个测试文件、59 项测试全部通过。
- 全量网站 Vitest：`pnpm.cmd test`
  - 结果：33 个测试文件、307 项测试全部通过。
- 类型检查：`pnpm.cmd typecheck`
  - 结果：通过，`tsc --noEmit` 退出码为 0。
- 生产构建：`pnpm.cmd build`
  - 结果：通过，Next.js 完成编译、类型校验、4 个静态页面生成与 2 个导出任务。
- 提交前格式检查：对本轮允许文件运行 `git diff --check`
  - 结果：无空白错误；仅报告 Windows 工作区 LF/CRLF 转换提示。

## SHA

- 基线 SHA：`c098968a88e1e36d8d37247d7ea10c761713a591`
- 修复提交 SHA：本报告随唯一修复提交一同固化，提交对象无法在自身内容中自引用最终 SHA；最终 SHA 以本报告所属 Git 提交元数据和最终回执为准。

## 风险与边界

- 按明确要求未打开浏览器、未执行人工验收；风险由 jsdom 流程测试、全量 Vitest、typecheck 与 production build 覆盖。
- IndexedDB 工作明确延期；未编辑、未暂存 `community/indexed-db-shared-pet-repository.ts` 和 `tests/indexed-db-shared-pet-repository.test.ts`。
- 未读取、未编辑、未暂存 `.next-corrupt-20260730/`。
- 详情下载沿用现有浏览器对象 URL 和原始文件名流程，没有新增仓储或持久化行为。
