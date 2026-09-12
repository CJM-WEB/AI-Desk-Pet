# 真实事件表现修复计划

依据：[用途匹配规格](../specs/2026-09-12-behavior-event-bindings-design.md)。执行 SDD、组合 RED → GREEN 和最小替换；视觉由用户验收。

下文源码简称以 `apps/desktop/src/main/` 为基准；桌面测试以 `apps/desktop/tests/` 为基准。实际命令、首次失败与后续结果只写入[验收记录](../../operations/2026-09-12-behavior-event-bindings-acceptance.md)，本文不替代完成证据。

1. `conversation/character-expression-adapter.ts` 与用途契约：用默认角色及改名目录复现复杂输出问题；新增小型用途匹配与逐轮选择校验，保留零工具、预算、超时、合法配对和描述数据边界。
2. `characters/character-behavior-director.ts`：将组合红例纳入正式测试，接纳生命周期内用途表，复用现有 Engine；事件边沿选择活动、终态反应和长期背景；修复授权卡等待事实与迟到清理。
3. `characters/character-proactivity-runtime.ts`、`conversation/main-conversation-composition.ts`：启动时准备完整用途并有界恢复，分开准备与五分钟评估时钟；冷启动 0/1/2、失败后恢复、后台额度与取消测试。
4. `conversation/conversation-chat-adapter.ts`、`conversation/conversation-coordinator.ts`：用途先准备，单槽正文与表现按生命周期调度，远程继续并行；用挂起请求证明思考／工作真正同时播放，终态复用用途而非等待模型。
5. 定向测试、类型检查、真实模型与隔离 Electron，清理退役路径，更新验收记录与索引。完整门禁记录现有基线，不修改无关业务，不自动提交 Git。

## 精确验收对应

| 步骤 | RED / GREEN 与完成标准 |
| --- | --- |
| 1 | `character-bindings-adapter.test.ts` 复现缺少用途入口、错配与 Qwen 背景运动；`character-expression-adapter.test.ts` 校验公开目录和预算；`packages/character-runtime/src/character-expression-selection.ts` 只保留内部类型，原专用模型 Schema 测试退役 |
| 2 | `character-behavior-bindings.test.ts` 结合真实默认目录、Service 和 Engine 验证条件保持、终态片段、同用途重选与互动清理；`character-cold-start.test.tsx` 使用真实 CharacterPlayer 挂起加载，证明当前实例首帧后才自动运动 |
| 3 | `character-proactivity-runtime.test.ts`、`character-autonomy.test.ts`、`main-conversation-composition.test.ts` 证明时钟分离、失败恢复、三档调度及后台取消 |
| 4 | `conversation-event-bindings.test.ts`、`conversation-bindings-lifecycle.test.ts`、`conversation-bound-behavior.test.ts` 覆盖远程并行、Qwen 单槽、慢正文、真实阶段、历史披露、快捷结果追问和迟到清理 |
| 5 | `tests/e2e/character-event-bindings.spec.ts` 覆盖默认角色、真实任务与原生拖拽；`character-motion-continuity.spec.ts` 保留原有尺寸及连续运动证据；`desktop.spec.ts` 迁移旧模型夹具并退役已被新用例承接的旧 B7 长时脚本 |

退役范围包含 `respondActivity`、`needsActivityMatch`、`applyActivityDecision`、`expressionFirst`、终态再推理函数与旧嵌套模型 Schema／转换器。仍使用的 Engine 内部计划和权限协议不退役。
