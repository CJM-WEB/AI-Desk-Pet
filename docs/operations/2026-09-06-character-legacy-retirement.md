# 旧角色运行逻辑退役清单

日期：2026-09-06。状态：**待用户批准本批删除，尚未执行**。

新 V3 工作台、Main 表达引擎与正式播放器已接通，定向测试、类型检查及限定复审通过，证据见[开发记录](2026-09-06-custom-state-autonomy.md)。本批移除被替代的旧运行逻辑及专用测试；人设模型决策和自主重评仍在继续开发，不将旧代码清理当作该能力完成。

精确作用域是 `C:\Users\Administrator\.codex\worktrees\e43f\myself` 下的以下 **14 个普通文件**，合计 187,873 字节。执行前重新核对路径、文件身份、引用和内容指纹；不会按通配符或目录递归删除。

| 旧模块 | 源文件 | 专用测试 |
| --- | --- | --- |
| V2 行为引擎 | `packages/character-runtime/src/character-behavior-engine.ts` | `packages/character-runtime/tests/character-behavior-engine.test.ts` |
| 主／修饰状态推断 | `packages/character-runtime/src/behavior-state-inference.ts` | `packages/character-runtime/tests/behavior-state-inference.test.ts` |
| V2 动作选择 | `packages/character-runtime/src/behavior-action-selector.ts` | `packages/character-runtime/tests/behavior-action-selector.test.ts` |
| 旧语义运行投影 | `packages/character-runtime/src/legacy-runtime-projection.ts` | `packages/character-runtime/tests/legacy-runtime-projection.test.ts` |
| Renderer 旧动作选择 | `packages/character-runtime/src/action-selector.ts` | `packages/character-runtime/tests/action-selector.test.ts` |
| 旧主／扩展状态仲裁 | `packages/character-runtime/src/state-arbiter.ts` | `packages/character-runtime/tests/state-arbiter.test.ts` |
| 关键词／固定情绪触发 | `apps/desktop/src/renderer/src/characters/player/extension-trigger-controller.ts` | `apps/desktop/tests/extension-trigger-controller.test.ts` |

删除方式：逐个移入 Windows 回收站；同时移除索引导出和只属于这批旧模块的残余引用。以上文件均已在 Git 中保存，回收站和提交记录都可用于恢复；本轮不清空回收站、不推送。

保留 V1/V2 输入 Schema、V1 转换器、V3 迁移器及旧包解析所需的表现解析器。角色包、用户素材、迁移原文和原始素材备份不在删除范围；官网、CloudBase、scanner 及文件任务 Core 也不在本批范围。

批准来源与实际删除结果将在执行后记录，当前不标记为已删除。
