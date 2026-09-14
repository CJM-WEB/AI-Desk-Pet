# 日常使用内存优化计划

依据[规格](../specs/2026-09-14-desktop-steady-memory-design.md)，承接已获批的功能效果不变资源优化。复用现有 worktree，无 Git 写操作。

## 1. 真实基线与独立审计

测量代理仅写忽略目录内的开发版/GPU探针与脱敏记录；预览代理只读审计隐藏预览。用户已取消内置模型优化，相关实现、配置和测量均不在本轮范围。记录真实配置、进程类别、操作阶段和清理结果。生产源码在基线完成前不修改。

## 2. 临时 Alpha 画布清理

文件：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`、`apps/desktop/tests/pixi-character-player.test.ts`。

- RED：在原 Alpha 提取测试中观察临时采样画布的像素尺寸，确认现代码在成功和错误路径仍保留 backing store；原命中结果和 texture 生命周期断言保留。
- GREEN：只增加临时画布 finally 清理；不改图像、纹理、Alpha 字节、阈值或正式画布。
- 定向测试与类型检查后，用同一真实 GPU/开发版探针复测，实测无收益时如实记录。

## 3. 根据证据继续优化

### 3.1 草稿预览跳过未消费的 Alpha 采样

文件：修改 `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts` 和 `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`；新增 `apps/desktop/tests/pixi-character-preview-alpha.test.ts`，补充 `apps/desktop/tests/draft-character-preview.test.tsx`。既有 Alpha 提取函数及其清理测试由主线程负责，子任务不得覆盖。

接口：保留工厂第二参数 `PixiModuleLoader`，增加第三参数 `options: { captureAlphaMask?: boolean } = {}`。初始化时传入 `options.captureAlphaMask ?? true`，场景仅以该值决定是否调用 `extractAlphaMask()`，不修改 `PixiCharacterScene` 的消费接口。

- [x] RED：新增真实 Pixi 场景测试，显式 `captureAlphaMask: false` 后加载素材、展示第二帧，断言无 `getContext`/像素读取、帧与边界为固定预期、`getHitSnapshot()` 为空；同一夹具以缺省选项验证默认 Alpha 字节仍存在。组件测试使用现有场景边界，断言草稿预览传入该选项且仍正常展示与切帧。旧实现应因仍采样及缺少选项而失败。
- [x] 执行 RED：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/pixi-character-preview-alpha.test.ts tests/draft-character-preview.test.tsx -t "预览 Alpha"`，记录失败断言及命令退出码。
- [x] 基线门：主线程确认真实开发版/GPU 基线结束后才修改生产代码。
- [x] GREEN：复用现有工厂传递选项，加载条目使用 `mask: this.captureAlphaMask ? extractAlphaMask(image) : null`；草稿预览使用 `createBrowserPixiCharacterScene(container, undefined, { captureAlphaMask: false })`。不增加依赖、不修改缓存、Store、窗口或帧播放逻辑。
- [x] 子任务 GREEN 验证：重跑 RED 命令、完整执行上述两个测试文件和桌面 `typecheck`，合并临时 Canvas 清理后运行相关 Pixi 与 Alpha 命中测试。
- [x] 主线程整合验证：统一执行构建及实测，子任务不独立构建或运行 E2E。
- [x] 完成标准：默认命中保持、预览不采样且显示参数不变、既有资源清理通过；实际命令、内存样本与限制见验收记录，不将理论容量等同于工作集降幅。

### 3.2 正式桌宠 Alpha 无损游程存储

文件：`apps/desktop/src/renderer/src/characters/player/character-alpha-hit-tester.ts`、`pixi-character-player.ts#extractAlphaMask`，以及 `apps/desktop/tests/character-alpha-hit-tester.test.ts`、`pixi-character-player.test.ts`、`pixi-character-preview-alpha.test.ts`。仅修改表示、构造和统一读取，保留上一阶段Canvas清理与预览选项。

- [x] RED：补充全部256值／阈值、多行游程、裁切与镜像、raw回退、异常输入／超界、存储字节测试；给现有真实采样测试补充存储减少断言，原字节断言改为统一精确Alpha读取，不丢现有命中覆盖。
- [x] 运行最小RED并记录失败；主线程正式构建完成后才修改生产源码。
- [x] GREEN：从现有RGBA两次扫描生成统一Uint32行索引和结束位置、Uint8原始Alpha值；不划算时直接保留raw；读取只查询目标行，不复制或解压整图。原坐标与阈值裁决不变。
- [x] 定向验证：运行三个对应测试文件和桌面typecheck，检查相关交互、过期加载及清理回归；独立审查后修复实际问题。
- [x] 整合验证：主线程统一构建和真实GPU内存复测，记录实际收益及开发版仍高于参考值的事实。本子任务不修改模型或运行模型测量。

其他隐藏预览资源方案需在独立审计与实测后具体化；保留状态与能力是前提，不预先承诺缓存压缩或休眠。由主线程整合最小方案、RED/GREEN、实际对照和独立复核。

## 4. 验收交付

独立记录 API 日常空闲的实际下降、与 500 MB 参考值的差距、相关功能验证和未覆盖情况。用户已明确 500 MB 不是硬性阈值，不为追逐数字扩大功能改动；本地模型明确记录为不在本轮范围。检查源码差异、中文文档和 `git diff --check`，不提交 Git。

执行结果见[验收记录](../../operations/2026-09-14-desktop-steady-memory-acceptance.md)：资源优化、真实 GPU 测量及定向回归已完成，完整角色门禁仍有 37 项前轮已复现失败，不记为全量通过。
