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

## 修复轮 1/5：封闭拒绝证据与跨句绑定

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`
- 退出码：`1`。
- 结果：2 个文件共 271 项，261 项通过、10 项失败。
- Router 的 6 项预期失败覆盖：省略“在”的本地点状语、`不用`/`不必` 否定同义词、分析流程、无成对引号的引用语境，以及英文请求跨句借用后续操作和目标。
- 行为 Gate 的 4 项预期失败覆盖：动作短语后接“是什么意思”“为什么”“怎么”等知识问句。

### GREEN 与门禁证据

- 同一 Desktop 定向命令：2 个文件、271/271 通过。
- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 最小修复与自审

- 文件 Router 补齐否定、分析流程和引用语境的拒绝证据；省略“在”的本地点状语作为独立执行句式证据，不新增固定动宾排列。
- `hasExecutionStructure` 只接收已绑定的操作槽；英文直接请求只授权首个已绑定操作，并继续要求操作与目标同句，后续句子不能借用前句请求权限。
- 行为 Gate 在动作解析后、边界接受前拒绝知识问句后缀，保留既有组合能力分流。
- 修复只修改 Router、行为 Gate 及其测试，没有触碰 Agent 执行器、Provider、Scheduler、IPC 或权限执行链。
- 未发现新的人工验收项；剩余风险是自然语言拒绝词表仍为封闭集合，后续新增表达应继续以安全负例驱动扩展。

## 修复轮 2/5：对象名边界与可行性咨询

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
- 退出码：`1`。
- 结果：196 项中 190 项通过、6 项失败。
- 预期失败覆盖：`别` 否定漏判；`流程文件夹`、`分析文件` 两个合法对象名被全局知识词误伤；三种句尾可行性咨询错误进入文件任务。
- 保护性正例 `可以帮我创建a.txt吗` 在 RED 阶段已经通过，证明测试没有把所有“可以……吗”一律拒绝。

### GREEN 与门禁证据

- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`：196/196 通过。
- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、278/278 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 最小修复与自审

- 恢复 `别` 的否定证据，与 `不要`、`不用`、`不必` 保持同一拒绝边界。
- `分析`、`引用` 只在请求句首作为讨论行为生效；`流程`、`这句话` 不再作为无边界全局黑名单，因此对象名称内部同字不被误伤，既有真实讨论和引用负例仍通过。
- 可行性证据只匹配句尾的 `可行吗`、`是否可以`、`可以吗` 等完整咨询结构，不拦截前置礼貌请求。
- 本轮只修改 Router、Router 测试和本报告；未触碰 Agent 执行器、Provider、Scheduler、IPC 或权限执行链。
- 剩余风险仍是自然语言表达无法穷举；新增咨询或否定表达应继续先增加安全负例，再扩展有界结构。
