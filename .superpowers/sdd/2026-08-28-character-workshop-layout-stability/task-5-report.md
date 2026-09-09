# Task 5：角色工作台稳定性验收报告

## 范围

本任务只在最终代码基线 `a2514f44af00c2351c866b4c72fa1657df0976d9` 上重跑门禁，并向既有验收文档追加 2026-08-29 的新鲜事实。没有修改生产代码、测试、旧验收历史或角色包数据。

## 新鲜门禁

| 命令 | 结果 | 计数 | 墙钟耗时 |
| --- | --- | --- | --- |
| `pnpm.cmd verify:characters`（首次） | 退出 1 | runtime 341/341、assets 99/99、Desktop 2856/2857；security、integration、Electron 未执行 | 104.01 秒 |
| `pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx`（一次诊断） | 退出 0；既有参数转发实际运行 Desktop 全组 | 108/108 文件、2857/2857 | 92.62 秒 |
| `pnpm.cmd verify:characters`（唯一一次完整重跑） | 退出 0 | runtime 341/341、assets 99/99、Desktop 2857/2857、security 28/28、integration 92/92、Electron 79 通过/1 跳过 | 653 秒 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 退出 0 | TypeScript 无错误 | 12.34 秒 |
| `git diff --check`（文档修改前） | 退出 0 | 无输出 | 0.16 秒 |
| `git diff --check`（文档修改后） | 退出 0 | 无输出 | 0.17 秒 |

首次总门唯一失败位于 `apps/desktop/tests/draft-character-preview.test.tsx:1149`：“场景播放帧回写父级，纯索引同步不重建且后续控制从实际帧继续”的 `showAction` 期望 1 次、实际 3 次。一次诊断和第二次完整门均通过该场景，因此按并发时序波动登记；没有循环重跑，也没有把首次失败改写成通过或宣称根因已经定位。

## 自动化覆盖结论

- 原生模态：组件测试覆盖 `showModal()`/`close()` 生命周期；真实 Electron 工作室闭环以鼠标点击“创建扩展状态”完成创建。
- 四条分隔器：DOM 测试覆盖 Pointer Capture、键盘、ARIA、clamp、提交持久化和失败提示；真实 Electron 覆盖四条鼠标拖动、重开恢复、窄窗隐藏及恢复。
- 皮肤兼容：工作台皮肤编辑 UI 不再出现；双皮肤 fixture integration 和真实 Electron 覆盖导入、编译、默认皮肤运行表现、导出与回导，保留 V2 `skins`、`defaultSkinId` 和运行时链。

## 人工边界

真实 Windows 顶层模态的视觉观感、不同 DPI/缩放比例下的布局，以及四条分隔器长期反复拖动的手感均没有本次人工证据，继续标记为“待用户人工确认”。

## 文档变更

- 仅在 `docs/operations/character-workshop-acceptance.md` 末尾追加 2026-08-29 验收节。
- 没有重写 2026-08-29 之前的任何历史记录。
