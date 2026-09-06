# 自定义状态与持续心情开发记录

日期：2026-09-06。依据[角色规格](../superpowers/specs/2026-09-05-ai-pet-custom-state-autonomy-design.md)与[实施计划](../superpowers/plans/2026-09-06-ai-pet-custom-state-autonomy.md)。状态：开发中，不能据此宣称整套角色能力已完成。

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

实际命令：

```powershell
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-schema.test.ts tests/character-v3-migration.test.ts tests/character-playback-view.test.ts tests/character-v2-schema.test.ts tests/character-v1-converter.test.ts
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-migration.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
git diff --check
```

Task 1 保留 V1/V2 输入 Schema 的既有含义，只新增必要复用导出。V3 草稿可明确表示尚未选择 idle；正式发布必须有有效兜底及素材几何。迁移返回的独立问题报告不能因文档结构可解析而被忽略。

Task 2 先由缺失接口的 4 项失败进入实现，之后用 3 项失败定位空计划停止、冷却恢复及跨实例令牌问题。最终定向命令使用 `pnpm.cmd --filter @myself/character-runtime exec vitest run --config vitest.config.ts tests/character-expression-engine.test.ts tests/behavior-scheduler.test.ts`；原 `test -- 文件` 写法实际运行整个包，不能误记为定向运行。引擎不调用模型、系统或文件，Main 接线仍待完成。

## 尚未完成

- Main／工作台的 V3 保存、迁移审阅、发布及正式 ID 播放接线。
- 持续心情、候选计划、动作轮换与失效处理的正式桌面接线。
- 人设系统提示词、状态／动作描述候选及真实模型效果。
- 无工具自主重评与三态运动解耦。
- 旧正式路径清理及整体基本体验验证。

真实 Windows 动画连续性、三态位移及真实人设效果尚待实际观察。当前开发记录不替代用户人工验收。
