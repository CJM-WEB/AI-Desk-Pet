# 桌宠意图编排与状态动作生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通聊天、受控 Agent 任务和角色状态动作通过一条可降级、可验证的意图编排链稳定工作。

**Architecture:** 对话解释模块只把可见正文设为强制字段，隐藏能力与行为计划分别校验；现有 Main 授权和工具执行链继续作为可信事实边界。角色公开目录恢复“状态→动作”层级，运行时在显式动作语义匹配与状态内加权随机之间执行已批准的优先规则。

**Tech Stack:** TypeScript、Electron、Zod、Vitest、Playwright、pnpm workspace

## Global Constraints

- MCP 正式运行链继续禁用；不得恢复 Renderer、Preload、Agent 或 Main 的 MCP 入口。
- Provider 和角色包没有系统权限；Electron Main 独占授权、确认、文件/PowerShell 执行与结果事实。
- 所有路径工具继续使用授权根标识与根内相对路径；写入、移动、删除和 PowerShell 每次确认。
- DeepSeek `deepseek-v4-flash` 与内置本地模型共用业务契约，并显式关闭思考模式。
- 用户明确动作优先匹配最高相似动作；仅指定状态时才在状态内按权重随机。
- 普通聊天正文不得因隐藏控制字段缺失或非法而失败。
- 文档和结构性注释使用中文；采用最小修改并删除被替代旧路径。
- 不制作安装包；真实窗口和真实 DeepSeek 网络结果保留为人工验收。

---

### Task 1: 解耦可见聊天与隐藏控制字段

**Files:**
- Modify: `packages/agent-core/src/response-contract.ts`
- Modify: `packages/agent-core/tests/response-contract.test.ts`
- Modify: `apps/desktop/src/main/providers/openai-provider.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Test: `apps/desktop/tests/provider-contract.test.ts`
- Test: `apps/desktop/tests/conversation-chat-adapter.test.ts`
- Test: `apps/desktop/tests/conversation-coordinator.test.ts`

**Interfaces:**
- Consumes: `ModelResponseContract`、现有 Provider SSE 解码和 `ConversationChatReply`。
- Produces: 正文成功、隐藏字段独立校验的 `ConversationChatReply`；明确公开 `PROVIDER_MALFORMED_RESPONSE`。

- [ ] **Step 1: 写普通聊天回归 RED**

新增表驱动用例：纯文本、只有 `text` 的 JSON、合法 `text` 加非法 `movementControl`、截断于控制字段的 JSON 都返回正文；空正文重试耗尽后返回格式错误。每条用例断言不创建 Agent、不发布“任务执行失败”。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts`

Expected: FAIL，旧契约拒绝纯文本/部分结构，Coordinator 把错误改成 `AGENT_INTERNAL_ERROR`。

- [ ] **Step 3: 实现最小解耦**

调整响应契约解码：合法 `text` 独立成功；各隐藏字段仍由 Adapter 分别 `safeParse`。仅完全没有合法正文时失败。Coordinator 为 `PROVIDER_MALFORMED_RESPONSE` 提供准确公开文案。删除整体 `capabilityCharacterChatResponseSchema.safeParse` 作为正文成功前置条件。

- [ ] **Step 4: 显式关闭 DeepSeek 思考并设置结构化输出预算**

在 DeepSeek Chat Completions 映射中对桌宠聊天发送 `thinking:{type:'disabled'}`，设置有界 `max_tokens`；空 content 只在 Provider 内重试一次，不改变写任务确认语义。

- [ ] **Step 5: 运行 GREEN 与类型检查**

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/agent-core/src/response-contract.ts packages/agent-core/tests/response-contract.test.ts apps/desktop/src/main/providers/openai-provider.ts apps/desktop/src/main/conversation/conversation-chat-adapter.ts apps/desktop/src/main/conversation/conversation-coordinator.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts
git commit -m "fix(conversation): 解耦聊天正文与隐藏控制"
```

### Task 2: 收口 Agent 工具意图为单一工具调用链

**Files:**
- Modify: `apps/desktop/src/main/conversation/capability-intent-router.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/src/main/agent/agent-service.ts`
- Modify: `packages/agent-core/src/agent-loop.ts`
- Test: `apps/desktop/tests/capability-intent-router.test.ts`
- Test: `apps/desktop/tests/agent-service.test.ts`
- Test: `packages/agent-core/tests/agent-loop.test.ts`
- Test: `tests/integration/desktop-agent.test.ts`

**Interfaces:**
- Consumes: Router 的能力类别、`AgentLoop`、现有工具 Schema、Action 确认续跑。
- Produces: Router 提示不再删除正确工具；真实 `tool_call` 成为唯一操作选择事实。

- [ ] **Step 1: 写错误工具提示与组合任务 RED**

构造 Router 猜测 `create_file`、模型正确选择 `move_file` 的场景，以及同一任务连续文件工具和 PowerShell 的场景。断言正确工具仍在公告集合，确认后真实临时目录发生预期副作用，错误参数只允许一次修复。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/capability-intent-router.test.ts apps/desktop/tests/agent-service.test.ts`

Run: `pnpm.cmd --filter @myself/agent-core test`

Run: `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts`

Expected: FAIL，旧 planning hint/expected operation 删除或拒绝正确工具。

- [ ] **Step 3: 实现单一操作选择**

Router 只决定 `file/powershell/chat` 和安全阻断；`FilePlanningHint.operation` 改为非约束提示或从执行路径删除。Agent 文件会话公告完整受控文件工具，操作类型由 Provider `tool_call` 决定；保留参数 Schema、重复调用保护、确认所有权和真实结果回注。

- [ ] **Step 4: 删除旧硬约束路径**

删除只服务 `expectedWriteOperation` 和精确工具收窄的实现、别名及测试；不得删除授权根、逐操作确认或工具错误修复上限。

- [ ] **Step 5: 运行 GREEN**

重复 Step 2 三条命令，Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/conversation/capability-intent-router.ts apps/desktop/src/main/conversation/conversation-coordinator.ts apps/desktop/src/main/agent/agent-service.ts packages/agent-core/src/agent-loop.ts apps/desktop/tests/capability-intent-router.test.ts apps/desktop/tests/agent-service.test.ts packages/agent-core/tests/agent-loop.test.ts tests/integration/desktop-agent.test.ts
git commit -m "fix(agent): 以真实工具调用统一操作意图"
```

### Task 3: 发布层级角色目录与详细描述

**Files:**
- Modify: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/src/character-behavior-plan.ts`
- Modify: `packages/character-runtime/src/behavior-target-resolver.ts`
- Modify: `apps/desktop/src/renderer/src/characters/components/StateInspector.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/components/ActionInspector.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Test: `packages/character-runtime/tests/character-v2-schema.test.ts`
- Test: `packages/character-runtime/tests/behavior-target-resolver.test.ts`
- Test: `apps/desktop/tests/character-workshop-components.test.tsx`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`

**Interfaces:**
- Consumes: V2 `states[].actionIds`、动作权重字段、角色 identity。
- Produces: 可选 `description` 字段和不含私有 ID/路径的层级 `PublicBehaviorCatalog`。

- [ ] **Step 1: 写 Schema、工作台和公开目录 RED**

断言状态/动作描述可保存、发布、重载；旧清单省略描述仍合法；公开目录包含状态及其动作，且没有 actionId、资源路径或帧数据。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-store.test.ts`

Expected: FAIL，旧 Schema/UI/目录没有 description 或层级 actions。

- [ ] **Step 3: 实现最小字段与编辑界面**

给状态和动作增加可选、受长度限制的 `description`；在两个 Inspector 中加入受控输入；Store 沿用现有草稿更新和发布路径，不新增第二套持久化。

- [ ] **Step 4: 深化公开目录模块**

以状态作为外层目录，嵌套公开动作；加入有界角色 identity 摘要。删除扁平 `candidates` 正式路径和只服务它的聚合字段，保持私有 ID/资源信息不出 Main。

- [ ] **Step 5: 运行 GREEN 与消费者类型检查**

重复 Step 2；再运行 `pnpm.cmd typecheck`。Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/character-runtime/src/character-v2-schema.ts packages/character-runtime/src/character-behavior-plan.ts packages/character-runtime/src/behavior-target-resolver.ts apps/desktop/src/renderer/src/characters/components/StateInspector.tsx apps/desktop/src/renderer/src/characters/components/ActionInspector.tsx apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts packages/character-runtime/tests/character-v2-schema.test.ts packages/character-runtime/tests/behavior-target-resolver.test.ts apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-store.test.ts
git commit -m "feat(character): 发布层级状态动作描述"
```

### Task 4: 实现语义优先与状态内随机动作生命周期

**Files:**
- Modify: `packages/character-runtime/src/character-behavior-plan.ts`
- Modify: `packages/character-runtime/src/behavior-target-resolver.ts`
- Modify: `packages/character-runtime/src/behavior-action-selector.ts`
- Modify: `packages/character-runtime/src/character-behavior-engine.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Test: `packages/character-runtime/tests/character-behavior-plan.test.ts`
- Test: `packages/character-runtime/tests/behavior-target-resolver.test.ts`
- Test: `packages/character-runtime/tests/behavior-action-selector.test.ts`
- Test: `packages/character-runtime/tests/character-behavior-engine.test.ts`
- Test: `apps/desktop/tests/character-behavior-director.test.ts`

**Interfaces:**
- Consumes: Task 3 层级目录与描述。
- Produces: `play_state` 计划、最低相似阈值和可取消的状态动作生命周期。

- [ ] **Step 1: 写解析和选择 RED**

覆盖四类可观察行为：无关文本返回 none；明确动作选择同状态最高相似项；只指定状态时固定随机源可选择不同动作；跨状态动作计划被拒绝。

- [ ] **Step 2: 写生命周期 RED**

给 Engine 注入固定时钟/随机源：动作完成而状态有效时选择下一个；冷却和重复抑制生效；停止、切换状态、拖拽、reset 后不再续播。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts`

Expected: FAIL，旧 resolver 强选第一项、旧计划扁平、旧 Engine 完成后清空。

- [ ] **Step 4: 实现最小计划与解析规则**

实现 `play_state`；精确动作先验证归属，模糊解析比较名称、语义、描述、标签并应用最低阈值。只指定状态时把动作选择留给 Selector，不在 Provider 层固定具体动作。

- [ ] **Step 5: 实现状态生命周期**

Engine 仅在同一有效状态信号内续选；复用现有 Selector 的权重、冷却和重复抑制。所有取消路径清除生命周期，无法选择时回到安全 idle，禁止零延迟忙循环。

- [ ] **Step 6: 运行 GREEN**

重复 Step 3，Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/character-runtime/src/character-behavior-plan.ts packages/character-runtime/src/behavior-target-resolver.ts packages/character-runtime/src/behavior-action-selector.ts packages/character-runtime/src/character-behavior-engine.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/src/main/conversation/conversation-chat-adapter.ts packages/character-runtime/tests/character-behavior-plan.test.ts packages/character-runtime/tests/behavior-target-resolver.test.ts packages/character-runtime/tests/behavior-action-selector.test.ts packages/character-runtime/tests/character-behavior-engine.test.ts apps/desktop/tests/character-behavior-director.test.ts
git commit -m "feat(behavior): 驱动状态内语义与随机动作"
```

### Task 5: 独立修复三态意图与持久运动状态机

**Files:**
- Modify: `packages/character-runtime/src/character-behavior-plan.ts`
- Modify: `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Modify: `apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- Test: `packages/character-runtime/tests/character-behavior-plan.test.ts`
- Test: `apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- Test: `apps/desktop/tests/character-behavior-director.test.ts`
- Test: `apps/desktop/tests/character-proactivity-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 4 的行为计划和状态动作生命周期；现有 `MovementControlPlan`。
- Produces: 唯一持久模式 `0 | 1 | 2`、可观察的模式切换和严格区分的持续/间歇运动调度。

- [ ] **Step 1: 写真实自然表达 RED**

表驱动覆盖“停止不动”“不要再走了”“让他一直运动”“保持跑动”“让他时不时运动”“偶尔动一下”“不要一直跑，隔一会儿动一下”。断言分别产生 `set_mode(0)`、`set_mode(1)`、`set_mode(2)`，且否定和引用语境不误触。

- [ ] **Step 2: 写状态切换和 Scheduler RED**

使用假时钟与固定随机源覆盖 `0→2`、`2→1`、`1→2`、`2→0`：mode 0 永不产生目标；mode 1 到达后继续生成目标；mode 2 只移动一段、回到 idle、重新抽取 10–30 秒后再移动。断言旧 timer、旧目标和旧 completion 不能跨模式生效。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-character-behavior-gate.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-proactivity-scheduler.test.ts`

Run: `pnpm.cmd --filter @myself/character-runtime test`

Expected: FAIL，现有自然改写或模式切换把间歇运动错误保持为持续运动，或旧调度跨模式继续生效。

- [ ] **Step 4: 实现唯一三态仲裁**

所有显式 Gate、模型 `movementControl` 和主动调度统一写入 Director 的单一数值模式；模式变更先取消旧 timer、目标和 pending completion，再启动新策略。禁止 behaviorPlan 或动画反馈反写持久模式。

- [ ] **Step 5: 实现严格间歇循环**

mode 2 每轮独立随机等待 10–30 秒，仅请求一次中距离随机工作区移动；到达附近或结束后立即切回 idle 表现，但持久模式仍为 2，并重新计时。mode 1 不使用该等待器，mode 0 不保留任何移动调度。

- [ ] **Step 6: 运行 GREEN 和行为门禁**

重复 Step 3；再运行 `pnpm.cmd verify:behavior`。Expected: PASS；若无关用例超时，隔离复现并保留完整事实。

- [ ] **Step 7: 提交**

```bash
git add packages/character-runtime/src/character-behavior-plan.ts apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts apps/desktop/src/main/characters/character-behavior-director.ts apps/desktop/src/main/characters/character-proactivity-scheduler.ts packages/character-runtime/tests/character-behavior-plan.test.ts apps/desktop/tests/explicit-character-behavior-gate.test.ts apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-proactivity-scheduler.test.ts
git commit -m "fix(behavior): 严格区分三态运动策略"
```

### Task 6: 建立真实表达意图矩阵与纵向回归

**Files:**
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `apps/desktop/tests/provider-contract.test.ts`
- Modify: `apps/desktop/tests/local-model-provider.test.ts`
- Modify: `apps/desktop/tests/character-behavior-director.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–5 的稳定接口。
- Produces: Provider/本地模型共用的中文自然表达与纵向副作用证据。

- [ ] **Step 1: 写用户原句和自然改写 RED**

表格至少包含：“你好呀”、“帮我在当前目录下创建ab.txt文件”、“把 A 移动到 B”、“执行 PowerShell 测试”、“停止不动”、“让他一直运动”、“让他时不时动一下”、“跑远一点”、“挥手一会儿”。Provider 与本地模型使用相同期望。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/local-model-provider.test.ts apps/desktop/tests/character-behavior-director.test.ts`

Run: `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts`

Expected: 若前五项尚有遗漏则 FAIL，并精确指向聊天、任务或行为结果。

- [ ] **Step 3: 补最小集成修正与旧夹具迁移**

只修改暴露真实缺口的生产 seam；所有 Provider fixture 模拟真实协议完整结构，不再只注入内部完美对象。删除旧六字段强制成功夹具和扁平行为目标。

- [ ] **Step 4: 运行 GREEN 与桌面 E2E 定向用例**

重复 Step 2；再运行与聊天、文件确认、三态和动作切换相关的 Playwright grep。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/local-model-provider.test.ts apps/desktop/tests/character-behavior-director.test.ts tests/integration/desktop-agent.test.ts tests/e2e/desktop.spec.ts
git commit -m "test(core): 覆盖真实意图与状态动作闭环"
```

### Task 7: 完整门禁、减法收口与验收记录

**Files:**
- Modify: `docs/operations/lightweight-agent-acceptance.md`
- Create: `docs/operations/2026-08-27-ai-pet-intent-and-behavior-orchestration-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-27-ai-pet-structured-control-repair-design.md`

**Interfaces:**
- Consumes: Tasks 1–6 的实现和测试证据。
- Produces: 单一现行设计入口、可复现命令结果和人工验收边界。

- [ ] **Step 1: 扫描并删除旧正式路径**

确认扁平 candidates、六字段整体 fail-close、expectedWriteOperation 硬约束和旧 play target 不再被生产入口引用；删除只服务旧设计的实现和测试，不做大量文件删除。

- [ ] **Step 2: 运行完整门禁**

Run: `pnpm.cmd typecheck`

Run: `pnpm.cmd test:security`

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd verify:desktop`

Run: `pnpm.cmd verify:behavior`

Run: `pnpm.cmd verify:characters`

Run: `git diff --check`

Expected: 全部退出 0；偶发超时必须隔离复现，不能静默改写为通过。

- [ ] **Step 3: 更新替代关系与验收记录**

旧结构化控制规格标记为被本规格在明确范围内替代；验收记录逐条写入实际命令、退出码、测试数量、未验证的真实 DeepSeek/窗口/回收站事项，不把 fixture 当真实网络证据。

- [ ] **Step 4: 提交**

```bash
git add docs/operations/lightweight-agent-acceptance.md docs/operations/2026-08-27-ai-pet-intent-and-behavior-orchestration-acceptance.md docs/superpowers/specs/2026-08-27-ai-pet-structured-control-repair-design.md
git commit -m "docs: 记录意图编排与状态动作验收"
```
