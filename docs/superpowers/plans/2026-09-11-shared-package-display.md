# 共享角色包显示精简实施计划

依据：[用户已明确的视觉规格](../specs/2026-09-11-shared-package-display-design.md)。主智能体实施，子智能体独立核对样式与发布范围。

- [x] RED：更新 `apps/website/tests/shared-pet-card.test.tsx`、`shared-pet-dialogs.test.tsx` 和 `tests/e2e/website.spec.ts` 的过时展示断言，定向运行确认三项预期失败。
- [x] GREEN：最小修改两个组件和 `community.module.css`，删除失去调用方的 `SharedPetOverrideWarning.tsx`、对应组件测试和 `messages.ts` 的废弃显示词条；不改数据契约与后台逻辑。
- [x] 执行验证：相关 79 项定向测试通过；全站 typecheck、423 项单元测试和构建通过。E2E 首轮 18/20 通过，两项首页动效超时；定向复跑一项通过，390 像素首页动效仍超时，因此不记录全站门禁通过。`git diff --check` 通过；用户明确验收视觉和角色包均无问题。
- [x] 发布：生产静态构建复用现网公开配置和原有安装包信息。最终静态资源 33/33、页面入口 11/11 上传成功，保留 `/releases` 和其他非网站文件。用户要求只收尾四项视觉修改，不扩展其他任务。
