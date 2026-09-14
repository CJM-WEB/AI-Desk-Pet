# 本地大尺寸素材实施计划

依据：[获授权规格](../specs/2026-09-11-large-character-source-design.md)。采用当前工作区，只做本任务文件变更，不执行 Git 写操作。实施结果见[独立验收](../../operations/2026-09-11-large-character-source-acceptance.md)，门禁失败不按通过记载。

- [x] 源图入口及定向 RED／GREEN。
- [x] 分页布局、编译及失败清理。
- [x] 大源预览、表单和取消回归。
- [x] 发布契约、资源映射与真实 Electron 大图验证。
- [x] 独立代码复核、完整门禁运行及失败分类。
- [x] 正式工作室 E2E 与最终文档、差异检查收口。

## 1. 源图入口

文件：`packages/character-assets/src/image-metadata.ts` 及测试；`apps/desktop/src/main/characters/character-asset-service.ts` 及测试。

- RED：长图、大文件、超过旧总预算及重建服务读取测试确认旧限制触发。
- GREEN：区分 source／compiled 元数据策略，删除 source 字节预算，保留格式和身份检查。
- 完成：定向测试与相关 typecheck 通过；不改变默认解析器和包策略。

## 2. 分页编译

文件：`packages/character-assets/src/atlas-layout.ts`、`apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts` 及对应测试。

- RED：17 张 1024²、65 张 512² 布局及多页导出失败／取消测试。
- GREEN：唯一分页布局与 `pages` 返回结构；逐页几何扫描、缓存源摘要、释放临时画布。
- 完成：页内尺寸、帧映射、原始清晰度和异常清理有证据。

## 3. 预览

文件：`apps/desktop/src/renderer/src/characters/workshop/draft-preview-resource-cache.ts`、`DraftCharacterPreview.tsx`、`AtlasImportPanel.tsx`，必要时相关 player 接口及对应测试。

- RED：长图预览必须裁切而非整图上传、大列数导入、取消释放测试。
- GREEN：复用资源加载及帧映射，预览中间纹理有界，原编辑帧不变；移除表单 64 上限。
- 完成：小图行为与帧选择保持，晚到结果不覆盖新预览。

## 4. 发布契约与整合

依赖第 2 步的 `pages` 接口。文件：`packages/character-runtime/src/character-v2-schema.ts` 及 V2／V3 测试；`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts` 及测试。

- RED：多页表现可发布、越界帧拒绝，页摘要去重且所有帧映射正确。
- GREEN：移除单动作面积限制，保留页边界；store 按页编制资源及多摘要几何修订。
- 完成：现有事务一次性提交全部页，切换角色或编辑使旧编译失效。

## 5. 验证与减法收口

- 独立代理复核必要改动、权限与释放路径。
- 运行定向测试、类型检查及角色／桌面门禁，记录通过、失败、未运行的准确范围。
- 实际图像解码和 Canvas 长序列验证；不把模拟位图测试称为真实 GPU 观察。
- 同步 `tests/fixtures/character-compile-process.mjs` 和 `tests/integration/desktop-agent.test.ts` 的分页结果，保留编译不阻塞 Main 的断言；`tests/e2e/desktop.spec.ts` 中本次工作室闭环断言按当前 V3 播放视图取表现。
- 更新 `docs/operations/2026-09-11-large-character-source-acceptance.md`，检查中文编码、链接和 `git diff --check`。保留用户已有 research 修改。
