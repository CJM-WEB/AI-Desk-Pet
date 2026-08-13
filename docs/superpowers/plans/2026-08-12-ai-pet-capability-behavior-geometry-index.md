# AI 桌宠可信能力、行为导演与视觉几何实施总计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` task-by-task；每个任务都必须使用 `test-driven-development`，完成声明前使用 `verification-before-completion`。

**Goal:** 按“文件与 PowerShell → 行为导演 → 视觉几何与缩放 → 拖拽诊断修复”的顺序，把已批准设计实现为可验证、可迁移且只有一条可信执行路径的桌宠能力。

**Architecture:** `ConversationCoordinator` 仍是 Prompt 唯一入口；Main 内由 `CapabilityIntentRouter`、`CapabilityTaskCoordinator`、`CharacterBehaviorDirector`、`PetVisualGeometry` 分别掌管能力分流、真实执行、行为仲裁和坐标几何。模型只提出受限计划，Main 才能授权工具、PowerShell、动作和窗口位置。

**Tech Stack:** TypeScript、Electron、React、Zod、Vitest、Playwright、PowerShell AST、pnpm workspace。

## 全局约束

- 禁止修改、构建、启动或测试 `apps/website`；禁止运行会递归进入网站的根 `pnpm typecheck`。
- 所有文档、结构性注释和测试标题使用中文；代码标识符沿用项目英文风格。
- 每个切片严格执行 RED → 最小 GREEN → 重构 → 定向回归；没有真实 RED 不写生产实现。
- 每个子项目完成后必须分别通过规格审查和质量审查，Critical/Important 清零后才进入下一子项目。
- 单个问题连续 10 分钟不收敛时，安全停止当前路径，保留证据并改用更窄测试、纯函数接缝或替代实现；不能直接跳过。
- 长测试可后台运行，但至少每 60 秒报告进度；测试结束后检查本工作树 Electron/Node/PowerShell 子进程残留。
- 不保存 Prompt、模型正文、文件正文、命令正文、绝对路径、屏幕绝对坐标、密钥或 Authorization 到普通日志。
- 写操作小步提交；用户已批准本计划所需依赖安装和 Git 写。大量删除仍需按仓库规则单独二次确认。
- 被新架构替换的旧分流、位置和动作路径必须在对应迁移任务中删除，不保留长期双轨。

---

## 串行阶段与依赖

| 阶段 | 详细计划 | 进入条件 | 退出证据 |
|---|---|---|---|
| 1 | [可信文件与 PowerShell 执行](./2026-08-12-ai-pet-trusted-capability-execution.md) | 本总计划批准 | 文件/终端定向、安全、集成、Electron E2E 全绿 |
| 2 | [行为导演与自主生命感](./2026-08-12-ai-pet-behavior-director.md) | 阶段 1 审查通过 | Prompt 动作、真实移动、停止锁和三档主动性全绿 |
| 3 | [视觉几何与滚轮缩放](./2026-08-12-ai-pet-visual-geometry-scaling.md) | 阶段 2 审查通过 | 动作联合包围盒、50%–200% 缩放、可见边界全绿 |
| 4 | [连续拖拽诊断与修复](./2026-08-12-ai-pet-drag-diagnostics-repair.md) | 阶段 3 审查通过 | 20 次连续拖拽、跨屏/DPI、缩放后拖拽全绿 |

## 子智能体执行规则

- 每个编号任务使用一个新的实现子智能体；同一时间最多并行执行没有共享生产文件的任务。
- 实现子智能体只修改任务 `Files` 清单；发现越界需求时先报告主控，由主控裁决最小扩围。
- 实现完成后另派只读规格审查与只读质量审查，不允许实现者自批。
- 每项提交包含实现、测试和中文任务报告；提交前执行 `git diff --check` 与网站零差异检查。
- 主控维护 `.superpowers/sdd/2026-08-12-ai-pet-capability-behavior-geometry/` 下的任务报告和最终验收记录。

## 每阶段固定收口

```powershell
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/character-assets typecheck
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/release-tools typecheck
pnpm.cmd test:security
pnpm.cmd test:integration
git diff --check
git diff --name-only -- apps/website
```

预期：所有命令退出码为 0；最后一条无输出。只有最终阶段运行完整 `pnpm.cmd test:e2e:desktop` 和 `pnpm.cmd verify:behavior`；中间阶段只运行计划指定的命名 Electron 场景，避免重复消耗但不降低纵向证据。

## 最终交付

- 四个子项目报告、规格审查、质量审查和人工验收清单齐全。
- `docs/operations/ai-pet-capability-behavior-geometry-acceptance.md` 记录自动门精确计数与待用户执行的真实 DeepSeek、混合 DPI、多角色资源人工项。
- 生产入口不存在旧 `ExplicitFileIntentGate` 双路由、固定 180×220 边界权威、旧窗口左上角持久化或第二套拖拽写位置路径。
- 网站文件差异为空，且执行记录中没有网站命令。
