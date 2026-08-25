# AI Pet 核心交互第二轮失败修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实默认隐私配置下文件工具不可用、停止/持续运动命令不生效，以及真实 Windows mousemove 未解锁滚轮缩放三项失败。

**Architecture:** 保留 Electron Main 作为唯一可信执行边界。文件链把“读取新文件数据”与“明确写请求的逐次确认”分开；行为链由两个布尔状态和受限隐藏运动计划驱动现有 Motion/Behavior 服务；鼠标链让 mouse 与 pointer 事件复用同一命中控制器。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、pnpm 11、Windows 10/11。

## Global Constraints

- MCP 运行时、Agent 和 Renderer 保持禁用。
- 第 4、5、6 项已通过人工验收，除必要回归测试外不修改其业务实现。
- `privacy.dataCategories.file=false` 继续禁止列目录、读取文件和向 Provider 披露新文件数据。
- 明确写能力只适用于 `create_file`、`create_directory`、`apply_patch`、`delete_file`；目标与内容由 Provider 的结构化工具参数提供，Main 只接受授权根内相对路径并逐次展示准确确认，不从自然语言正则抽取路径。
- 删除只进入 Windows 回收站；测试只删除本轮在隔离临时根创建的实体。
- 自主随机间隔保持每轮独立 10,000–30,000ms，随机远行到达容差保持 24 DIP。
- `motionPlan.durationSeconds` 只允许 `null` 或 1–600；目标只允许当前点、当前单屏随机点或九个公开区域值。
- wheel 缩放保持 50%–200%，每次只改变一个 10% 档位；按压或拖动时拒绝 wheel。
- 文档、测试名称和结构性注释使用中文；采用 TDD 与最小修改，不引入大型 Agent 框架。
- 不提交、合并或改写 Git 历史；保留用户现有未提交改动。

---

### Task 1: 默认隐私配置下的明确文件写闭环

**Files:**
- Modify: `apps/desktop/src/main/agent/main-agent-session-factory.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `apps/desktop/src/main/agent/tool-registry.ts`
- Test: `apps/desktop/tests/main-agent-session-factory.test.ts`
- Test: `apps/desktop/tests/agent-service.test.ts`
- Test: `tests/integration/desktop-agent.test.ts`
- Test: `tests/security/permission-boundary.test.ts`

**Interfaces:**
- Consumes: 文件任务类别、现有 `AgentSession` 与 Provider 结构化工具参数。
- Produces: 受控写工具可见面和绑定 `VerifiedWriteAction` 的逐次确认；不新增 Renderer IPC。

- [x] **Step 1: 写失败的 Session 工具可见性测试**

在 `main-agent-session-factory.test.ts` 构造 `fileDisclosureAllowed=false` 的文件 Session，断言内部注册表仍能被 AgentService 按本轮提示筛选，同时直接执行只读仍返回 `FILE_DISCLOSURE_DENIED`。生产改动前测试应因 `session.tools` 为空失败。

- [x] **Step 2: 运行 RED 并确认失败原因**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/main-agent-session-factory.test.ts`

Expected: FAIL，失败点是默认隐私配置清空全部文件工具，而不是夹具或导入错误。

- [x] **Step 3: 写失败的单任务许可与越权测试**

在 `agent-service.test.ts` 表驱动覆盖：四项结构化写工具可产生准确确认；`list_files`、`read_file`、普通聊天、未公开工具、篡改后的待确认动作和下一任务复用全部拒绝。

- [x] **Step 4: 实现最小许可判断**

Session 内部保留完整文件注册表；`runContext` 在 `file=false` 的明确写任务中只公开四项受控写工具里与 Router 操作类别精确对应的一项，结构化澄清工具由 AgentLoop 唯一追加，读取工具始终不可见。删除自然语言 `targetRelativePath` 提取与许可绑定；AgentService 以 Schema 校验后的 `VerifiedWriteAction` 和准确确认卡为事实，在确认与不可逆提交入口重新检查当前任务、授权 generation 和动作 token。

- [x] **Step 5: 运行定向 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/main-agent-session-factory.test.ts tests/agent-service.test.ts tests/tool-permission-policy.test.ts`

Expected: PASS，且无未处理拒绝或警告。

- [x] **Step 6: 写并运行真实文件副作用集成测试**

在 `tests/integration/desktop-agent.test.ts` 使用 `fileDisclosureAllowed=false`、临时授权根和 DeepSeek 兼容 `tool_calls`：Provider 从用户原文自行生成结构化相对路径，创建目录或文件在确认前不存在，确认后 `lstat/readFile` 成功；随后删除同一测试实体并验证回收站端口。测试不得手工注入自然语言解析出的目标路径；只读请求不得发送读取工具。

Run: `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts tests/security/permission-boundary.test.ts`

Expected: PASS，实际文件系统断言成立。

### Task 2: 停止布尔锁、持续运动与隐藏运动计划

**Files:**
- Modify: `packages/character-runtime/src/character-behavior-plan.ts`
- Test: `packages/character-runtime/tests/character-behavior-plan.test.ts`
- Modify: `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Modify: `apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- Test: `apps/desktop/tests/conversation-chat-adapter.test.ts`
- Test: `apps/desktop/tests/character-behavior-director.test.ts`
- Test: `apps/desktop/tests/character-proactivity-scheduler.test.ts`
- Test: `tests/integration/desktop-agent.test.ts`

**Interfaces:**
- Consumes: 现有 `movementStopped` 持久化字段、`CharacterMotionService.subscribe()` 和当前角色公开候选目录。
- Produces: `MotionPlan`、`autonomousMovementAllowed`、`continuousMovementRequested` 与只读 `CharacterBehaviorDiagnosticSnapshot`。

- [x] **Step 1: 写停止与持续命令 RED**

加入“静止不动、保持静止、不要再动、别乱跑”映射 `stop_movement`；“保持运动、一直走、继续跑”映射持续运动指令。生产改动前前述句子应返回 `null` 或一次性移动，从而稳定失败。

- [x] **Step 2: 运行 Gate RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explicit-character-behavior-gate.test.ts`

Expected: FAIL，失败点为实际短语未识别。

- [x] **Step 3: 扩展隐藏 `motionPlan` 契约并先写 Schema RED**

定义严格对象：`mode` 为 `none|stop|once|continuous`，`durationSeconds` 为 `null` 或 1–600 整数，`target` 为 `current|random_work_area|left|right|top|bottom|top_left|top_right|bottom_left|bottom_right`。将其加入聊天 JSON Schema 的 required，并验证越界时长、额外字段和任意坐标均失败。

- [x] **Step 4: 实现 Provider 提示与 Adapter 校验**

更新中文 JSON 示例和系统消息；Adapter 只把本地 Schema 通过的 `motionPlan` 交给 Director。纯文本回退继续显示文字，但不得改变运动状态。

- [x] **Step 5: 写 Director 状态机 RED**

测试初始 `movementStopped=false` 对应 `autonomousMovementAllowed=true`；停止落盘成功后为 false 并停止 Motion；落盘失败时状态不变；持续运动到达第一个目标后请求第二个不同 `wander(work_area)`；到期或停止后不再请求。

- [x] **Step 6: 实现两个布尔状态与 Motion 到达反馈**

Director 用 `autonomousMovementAllowed` 直接控制 Scheduler 资格，用 `continuousMovementRequested` 控制到达后的续行。`index.ts` 将现有 Motion snapshot 回调交给 Director；只复用现有 MotionService，不增加第二时钟。

- [x] **Step 7: 实现受限时长与目标**

`once` 只提交一个现有 Motion intent；`continuous` 在每次到达后按相同公开目标类型续行；非空时长以 Main 单调时钟截止，超过截止立即清除持续布尔并停止。停止计划优先级最高。

- [x] **Step 8: 运行行为 GREEN 与纵向状态验收**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explicit-character-behavior-gate.test.ts tests/conversation-chat-adapter.test.ts tests/character-behavior-director.test.ts tests/character-proactivity-scheduler.test.ts`

Run: `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts`

Expected: PASS；快照证明停止跨 30 秒无自主移动、持续运动经历两个目标、一次运动终止回 idle。

### Task 3: 真实 mousemove 解锁与 wheel 数值验收

**Files:**
- Modify: `apps/desktop/src/renderer/src/pet/PetView.tsx`
- Modify: `apps/desktop/src/renderer/src/pet/pet-interaction-controller.ts`
- Test: `apps/desktop/tests/pet-view.test.tsx`
- Test: `apps/desktop/tests/pet-interaction-controller.test.ts`
- Test: `tests/e2e/desktop.spec.ts`

**Interfaces:**
- Consumes: `PetInteractionController.handlePointerMove/Leave()`、现有 Alpha/fallback hit-test 和 `window.myself.stepPetScale()`。
- Produces: mouse 与 pointer 共用的 `handleHoverMove/Leave()` 入口；不改 Main 缩放数学和拖拽边界。

- [x] **Step 1: 写真实 mousemove RED**

在 `pet-view.test.tsx` 只派发 `MouseEvent('mousemove')` 到 shell，随后 wheel；断言当前实现没有更新命中/调用 `stepPetScale`。不得预先派发 PointerEvent。

- [x] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/pet-view.test.tsx tests/pet-interaction-controller.test.ts`

Expected: FAIL，失败点为 mousemove 未进入控制器。

- [x] **Step 3: 实现共享 hover 入口**

`onMouseMove/onMouseLeave` 与 Pointer 对应事件调用同一控制器方法；同坐标重复事件只刷新一次穿透目标。wheel 继续使用事件自身坐标复核命中，按压/拖动规则不变。

- [x] **Step 4: 运行 Renderer GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/pet-view.test.tsx tests/pet-interaction-controller.test.ts tests/pet-window-interaction-controller.test.ts`

Expected: PASS。

- [x] **Step 5: 改写 Electron E2E 去除合成 PointerEvent**

可见点扫描只使用 Playwright mouse move 和 Main 穿透探针，不在页面调用 `dispatchEvent`。滚轮后同时断言 Main geometry `revision/scaleTick` 和 `settings.json` 当前角色 `scale` 变化；长按前后 scaleTick 相等。

- [x] **Step 6: 运行真实 Electron 缩放验收**

Run: `pnpm.cmd exec playwright test --config tests/playwright.config.ts -g "视觉几何与滚轮缩放|左键长按"`

Expected: PASS，日志中不存在为解锁穿透而合成 PointerEvent 的步骤。

### Task 4: 全门禁、真实副作用复核与独立终审

**Files:**
- Modify: `docs/operations/lightweight-agent-acceptance.md`
- Modify: `docs/operations/character-workshop-acceptance.md` only if an actual behavior result must be recorded
- Inspect: all files changed by Tasks 1–3

**Interfaces:**
- Consumes: 三项定向测试报告和真实状态快照。
- Produces: 只记录实际运行结果的中文验收记录。

- [x] **Step 1: 运行 workspace 类型检查与定向门禁**

Run: `pnpm.cmd typecheck`

Run: `pnpm.cmd test:security`

Run: `pnpm.cmd test:integration`

Expected: 全部退出 0。

- [x] **Step 2: 运行三个桌面门禁**

Run: `pnpm.cmd verify:desktop`

Run: `pnpm.cmd verify:behavior`

Run: `pnpm.cmd verify:characters`

Expected: 全部退出 0；长时间环境门禁若明确跳过，必须在验收记录中写明而不能算通过。

- [x] **Step 3: 检查差异和格式**

Run: `git diff --check`

Run: `git status --short`

Expected: 无空白错误；只包含本轮范围和用户原有改动。

- [x] **Step 4: 独立规格与质量复审**

Reviewer 必须逐项检查默认 `file=false` 的真实写副作用、停止/持续状态快照和无 DOM 注入 wheel E2E。所有 P0/P1/P2 返回对应任务修复并重跑覆盖测试。

- [x] **Step 5: 更新验收记录**

只写执行命令、环境、退出码、文件系统状态、行为快照和 scale 数值；真实 DeepSeek 外部网络若未运行，必须标为未验证。
