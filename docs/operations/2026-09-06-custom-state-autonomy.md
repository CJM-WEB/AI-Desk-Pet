# 自定义状态与持续心情开发记录

日期：2026-09-06。依据[角色规格](../superpowers/specs/2026-09-05-ai-pet-custom-state-autonomy-design.md)与[实施计划](../superpowers/plans/2026-09-06-ai-pet-custom-state-autonomy.md)。状态：开发中，不能据此宣称整套角色能力已完成。

当前进度：Task 1–3 已完成并经限定独立复审；V3 工作台、Main 状态引擎与正式播放器已接通。Task 4 正在接人设和模型描述决策，Task 5 自主重评与 Task 6 清理交付尚未完成。下表按证据产生时点保留中间失败及其后续修复，不以中间状态覆盖当前结论。

用户已确认文件能力实际验收并授权本阶段；工作台锚点与区域保留现有入口，本轮不扩展。保留三态运动，重点接通人设系统提示词、描述决策、自定义状态及随时间变化的心情。MCP 继续禁用，官网链不进入本轮，暂不打包、不 push。

## 已有证据

| 范围 | 结果 | 限制 |
| --- | --- | --- |
| Task 1 V3 作者 Schema、输入转换、ID 播放视图 | 自动化通过，提交 `d26a8a23` | 纯角色运行时数据模块，未切正式 Main／Renderer |
| V3/旧 V2/V1 定向兼容 | 5 文件64项通过，角色 package typecheck 通过 | 修复前该次命令的实际结果，不代表全仓验证 |
| V1 单击／双击／右键规则迁移修复 | 新3项先失败；修复后迁移文件9项通过，typecheck通过；提交 `9bff5dd2` | 原事件合并差异转为显式迁移问题，不静默视为等价 |
| Task 1 独立审查 | 规格与质量通过 | 只审本步，后续存储／界面仍须落实问题门禁 |
| Task 2 心情衰减、单状态计划及动作调度 | 自动化通过，提交 `881e9328`；包内 365 项、最终引擎与通用调度定向 29 项、typecheck 通过 | 尚未接入桌面播放 |
| 状态保持与退出事件修复 | 两例 RED 复现；修复后引擎 11 项与 typecheck 通过；提交 `0a6ac229`，限定独立复审通过 | 未重跑包全量；桌面接线属于 Task 3 |
| Task 3 Main V3 存储、迁移门禁与表达服务 | 提交 `0568b033`；存储与接线 90 项、导入导出定向 5 项、运行时定向 91 项通过 | 整体 Task 3 未完成；Renderer 与旧 fixture 尚在适配，桌面 typecheck 未通过 |
| 明确动作自主结束 | 无限循环素材的失败用例经修复通过；Main 按真实帧周期发出 `once`，开始反馈后计时，结束后恢复有效计划或 idle | Renderer 实际执行与真实模型描述决策仍在接线 |
| Main 子步骤固定差异审查 | 发现 3 项必要修复：旧清单只读恢复的素材读取、迁移原素材持久保留、运动请求生命周期登记 | 已核对接受，待顺序修复；不能记为整步审查通过 |
| Task 3 Renderer 工作台与正式播放 | V3 单状态编辑、逐项迁移处置和按 ID 播放已接通；桌面与运行时 typecheck、桌面开发构建通过 | 定向 309 通过、1 个已确认 Main 0 档自主移动缺口失败；整 Task 3 未完成 |
| 有界播放与资源复用 | Pixi／预览／V3 接线定向 83 项、作者方向 4 项通过；原保存／并发／素材定向 96 项通过 | 预览帧同步在与构建并发时曾有一次时序失败，无代码变化独立复跑通过，不称确定修复 |
| Main 三类限定修复 | 5 项失败用例修复后通过；存储与 Director 共 205 项、桌面 typecheck 通过；提交 `cdd752a`，限定复审通过 | 原素材独立保存，坏事务保持只读；运动登记与 0 档自主锁均关闭 |
| Renderer 固定差异审查 | 发现中断未终止 Pixi 内部播放，方向／可见性变化可能恢复旧动作 | 已接管最小修复；不把画面暂停当作播放生命周期终止 |
| Renderer 中断终态修复 | 真实 React＋Pixi 接缝先复现旧动作恢复，再修复；播放器 80 项与桌面 typecheck 通过；提交 `9ff40eb0`，限定复审通过 | 明确终止当前播放并清理计时器，普通暂停恢复保留；原问题关闭 |

实际命令：

```powershell
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-schema.test.ts tests/character-v3-migration.test.ts tests/character-playback-view.test.ts tests/character-v2-schema.test.ts tests/character-v1-converter.test.ts
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-migration.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
git diff --check
```

Task 1 保留 V1/V2 输入 Schema 的既有含义，只新增必要复用导出。V3 草稿可明确表示尚未选择 idle；正式发布必须有有效兜底及素材几何。迁移返回的独立问题报告不能因文档结构可解析而被忽略。

Task 2 先由缺失接口的 4 项失败进入实现，之后用 3 项失败定位空计划停止、冷却恢复及跨实例令牌问题。最终定向命令使用 `pnpm.cmd --filter @myself/character-runtime exec vitest run --config vitest.config.ts tests/character-expression-engine.test.ts tests/behavior-scheduler.test.ts`；原 `test -- 文件` 写法实际运行整个包，不能误记为定向运行。引擎不调用模型、系统或文件，Main 接线仍待完成。

Task 3 Main 的定向命令为 `pnpm.cmd --filter @myself/desktop test character-v3-cutover.test.ts character-store.test.ts`，以及 `pnpm.cmd --filter @myself/desktop test character-package-service.test.ts -t 'V3 导出|V1 角色包|复杂旧包|旧包资源校验|旧包图片结构'`。后者还有 69 项未运行，既有临时目录恢复扫描日志 `CHARACTER_IMPORT_RECOVERY_SCAN_FAILED` 仍出现，本轮未据该日志断言导入恢复失败或完全正常。正式开发实例在跨进程切换期间已结束，尚未在真实用户数据上启动新版本。

## 尚未完成

- 人设系统提示词、状态／动作描述候选及真实模型效果。
- 无工具自主重评及真实互动／任务事实的接线；三态运动与情绪动画的基础解耦已在 Task 3 完成。
- 旧正式路径清理及整体基本体验验证。

真实 Windows 动画连续性、三态位移及真实人设效果尚待实际观察。当前开发记录不替代用户人工验收。
