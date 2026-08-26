# 任务 1 实施报告

## 范围

- 日期：2026-08-27
- 分支：`AgentCoreExtension`
- 规格：`docs/superpowers/specs/2026-08-27-ai-pet-structured-control-repair-design.md`
- 任务：稳定统一控制计划契约与自然语言入口。
- 非范围：未修改 Agent 执行器、Provider、Scheduler、IPC、Renderer 或权限执行链。

## RED 证据

1. `pnpm.cmd --filter @myself/agent-core test`
   - 退出码：`1`。
   - 结果：既有 84 项通过；新增测试套件因 `capability-control-plan.ts` 尚不存在而失败。
2. `pnpm.cmd --filter @myself/character-runtime test`
   - 退出码：`1`。
   - 结果：既有 303 项通过；新增 12 项因 `movementControlPlanSchema` 尚不存在而失败。
3. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`
   - 退出码：`1`。
   - 结果：255 项中 245 项通过、10 项失败；截图原句及一个常见语序仍落入 `chat`，8 条运动归一化断言缺少 `movementControl`。新增否定、讨论、引用和代码安全负例均通过。
4. 相对方向补充 RED：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explicit-character-behavior-gate.test.ts`
   - 退出码：`1`。
   - 结果：78 项中 76 项通过、2 项失败；`up/down` 尚未归一为公开目标 `top/bottom`。

## GREEN 证据

- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、257/257 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

## 修改文件

- `packages/agent-core/src/capability-control-plan.ts`
- `packages/agent-core/src/index.ts`
- `packages/agent-core/package.json`
- `packages/agent-core/tests/capability-control-plan.test.ts`
- `packages/character-runtime/src/character-behavior-plan.ts`
- `packages/character-runtime/tests/character-behavior-plan.test.ts`
- `apps/desktop/src/main/conversation/capability-intent-router.ts`
- `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- `apps/desktop/tests/capability-intent-router.test.ts`
- `apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-08-27-ai-pet-structured-control-repair/task-1-report.md`

`packages/character-runtime/src/index.ts` 已经通过 `export * from './character-behavior-plan'` 公开新增契约，无需制造重复导出差异。Agent Core 直接使用仓库既有 `zod@3.25.76`，仅补充直接依赖声明与锁文件 importer，没有引入新版本或第二套校验器。

## 自审结论

- `CapabilityControlPlan` 与 `MovementControlPlan` 均为严格判别联合，额外字段、未知工具、越界模式、坐标目标和 `distance: none` 均被拒绝。
- 文件 Router 已删除依赖地点、礼貌词和操作固定排列的中文正则；正向路径只组合操作、本地对象、执行请求和同句关系，没有无界 `.*` 或 `.+`。
- 无空格的 `ab.txt文件` 通过目标槽线性裁剪识别；复合操作词和相对路径的既有用例保持通过。
- 否定、知识讨论、引用与代码块继续封闭；普通聊天不会因此获得文件或运动能力。
- 显式行为 Gate 规范化输出 `keep/set_mode/move_once`；旧显式指令仅为当前 Director 兼容保留，持久状态单入口删除由计划任务 3 完成。
- 未发现任务 1 范围外修改。

## 提交

- 提交信息：`feat(control): 统一桌宠能力与运动控制契约`
- 提交哈希：以本报告所在提交的 `git rev-parse HEAD` 输出为准；Git 提交不能在自身内容中内嵌自己的最终哈希。
