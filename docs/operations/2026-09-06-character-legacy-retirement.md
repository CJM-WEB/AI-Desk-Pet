# 旧角色运行逻辑退役清单

日期：2026-09-06。状态：**用户已二次批准，14 个文件已逐个移入 Windows 回收站，相关检查通过**。

新 V3 工作台、Main 表达引擎与正式播放器已接通，人设模型决策和自主重评已实现；真实 DeepSeek／Qwen 代表场景和一条 Electron 工作台闭环通过，证据见[开发记录](2026-09-06-custom-state-autonomy.md)。本批只移除被替代的旧运行逻辑及专用测试，旧包输入与用户数据保留。

精确作用域是 `C:\Users\Administrator\.codex\worktrees\e43f\myself` 下的以下 **14 个普通文件**，合计 187,873 字节。执行前已重新核对解析路径、普通文件身份、长度和 SHA-256 与获批清单一致；没有使用通配符或目录递归删除。

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

批准来源：用户对本清单的二次确认回复“批准按清单清理”。执行使用 PowerShell 原生 `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile`，明确指定 `SendToRecycleBin`，逐项完成后检查源文件不再存在；未清空回收站。精确清单和逐项结果保存在本地 SDD 记录 `retirement-inventory.json`、`retirement-result.json`；删除前 Git 版本为 `6d9e8847`，可按上表路径恢复历史文件。

同时删除 6 个旧索引导出，并将 3 个直接测试文件中的旧类型或无用导入改为当前播放器／调度接口。退役模块与关键符号在运行源码及测试中的残余引用为 0。角色运行时定向 42 项、桌面存储与播放器 120 项通过；运行时及其直接消费者 agent-core、character-assets、desktop、package-scanner 类型检查通过。`git diff --check` 通过；相对本阶段基线的官网、CloudBase、scanner 业务和锁文件差异均为空。
