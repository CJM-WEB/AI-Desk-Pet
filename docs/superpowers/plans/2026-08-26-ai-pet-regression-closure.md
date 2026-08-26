# AI 桌宠四项回归收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复拖拽变大与延迟、云 Provider 非流式、文件任务验收分叉和运动布尔锁竞争。

**Architecture:** Main 保持窗口、文件副作用和运动模式的唯一可信权威；Provider 只流式公开普通聊天正文；四个切片分别完成 TDD 和提交，最后合并验证并把通过门禁的分支快进到干净主目录。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、OpenAI-compatible/Anthropic/Gemini SSE、Windows BrowserWindow。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-08-26-ai-pet-regression-closure-design.md`。
- 运动模式固定为 `0=持续静止`、`1=持续运动`、`2=间歇自主运动`。
- 间歇自主延迟固定为每轮从 10–30 秒抽取。
- 不恢复滚轮缩放，桌宠窗口运行尺寸固定为默认尺寸。
- 工具规划、工具参数和失败总结不得流式公开。
- MCP、任意 Shell、绝对路径、覆盖写、永久删除和递归删除继续禁用。
- 所有生产修改先取得对应 RED，再做最小 GREEN；文档和结构性注释使用中文。

---

### Task 1: 固定尺寸拖拽所有权

**Files:**
- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`
- Modify: `apps/desktop/src/main/windows/pet-geometry-coordinator.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/character-motion-controller.test.ts`
- Test: `apps/desktop/tests/pet-window-interaction-controller.test.ts`
- Test: `tests/e2e/desktop.spec.ts`

**Interfaces:**
- Produces: 自定义拖拽 owner，只有 Controller end 可释放；固定尺寸布局在拖拽期间不调用 `setBounds`。

- [ ] **Step 1: 写事件化 RED**

组合真实 `CharacterMotionService` 与会同步触发 `will-move/move/moved` 的 fake BrowserWindow；执行 begin、100 次系统光标更新、end，断言 end 前 `userMoving=true`、窗口宽高始终为初值且几何 `setBounds` 为零。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/pet-window-interaction-controller.test.ts tests/character-motion-controller.test.ts`

Expected: 第一次 `moved` 后 owner 被错误释放或出现非零 `setBounds`。

- [ ] **Step 3: 最小 GREEN**

给 Motion 窗口绑定增加明确来源；原生 moved 只释放 native owner，自定义 drag owner 由 `endDrag()` 释放。固定尺寸模式拒绝运行期宽高变化，保留位置提交和几何碰撞快照。

- [ ] **Step 4: 增加真实系统光标 E2E**

使用测试夹具内受限 Win32 `SetCursorPos` 移动系统光标至少 20 步并重复三轮；逐步断言窗口位置差等于光标差、宽高及视觉比例不变，测试结束恢复原光标位置并回收进程。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/pet-window-interaction-controller.test.ts tests/character-motion-controller.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Commit: `fix(desktop): 固定拖拽尺寸并保持系统光标跟随`

### Task 2: 云 Provider 普通聊天流式

**Files:**
- Create: `apps/desktop/src/main/providers/structured-text-stream.ts`
- Modify: `apps/desktop/src/main/providers/openai-provider.ts`
- Modify: `apps/desktop/src/main/providers/anthropic-provider.ts`
- Modify: `apps/desktop/src/main/providers/gemini-provider.ts`
- Test: `apps/desktop/tests/provider-contract.test.ts`
- Test: `apps/desktop/tests/openai-provider.test.ts`
- Test: `apps/desktop/tests/conversation-coordinator.test.ts`

**Interfaces:**
- Consumes: `ModelRequest.onTextDelta?: (delta: string) => void`。
- Produces: 有界 SSE 帧读取器和只投影完整解码顶层 `text` 的结构化增量器；最终仍返回完整 `ModelResponse`。

- [ ] **Step 1: 写三协议参数化 RED**

对 OpenAI-compatible、Anthropic、Gemini 分别构造 Unicode 与 JSON escape 跨 chunk 响应；普通无工具聊天必须发流式请求并依次回调文字，工具请求即使携带 callback 也必须保持 JSON 且回调零次。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/provider-contract.test.ts tests/openai-provider.test.ts`

Expected: 三类云 Provider 当前均没有增量回调。

- [ ] **Step 3: 实现共享有界投影器**

投影器接受协议已解码的正文 fragment，累计完整结构化 JSON，只在顶层 `text` 字符串产生新完整 Unicode 字符时回调；限制 SSE 总字节、事件数、单事件字节和公开正文长度。Abort、非法 JSON、缺终态或终态后尾数据抛稳定 Provider 错误。

- [ ] **Step 4: 接入三协议**

OpenAI-compatible 使用 `stream:true` 和 `[DONE]`；Anthropic 使用 `content_block_delta.text_delta` 与 `message_stop`；Gemini 使用 `streamGenerateContent?alt=sse`。云端 reasoning 不公开；工具回合和无 callback 调用不进入 SSE。自定义兼容端点仅在零 delta 且明确返回普通 JSON 时解析整段结果。

- [ ] **Step 5: 运行纵向 GREEN 并提交**

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/provider-contract.test.ts tests/openai-provider.test.ts tests/conversation-coordinator.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Commit: `feat(providers): 为云模型启用安全文字流式输出`

### Task 3: 文件任务事实与开发构建身份

**Files:**
- Modify: `packages/agent-core/tests/agent-loop.test.ts`
- Modify: `apps/desktop/tests/agent-service.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify only if RED proves necessary: `packages/agent-core/src/agent-loop.ts`
- Modify only if RED proves necessary: `apps/desktop/src/main/agent/agent-service.ts`
- Modify only if RED proves necessary: `apps/desktop/src/main/conversation/conversation-coordinator.ts`

**Interfaces:**
- Produces: 每个新任务为空调用状态；披露关闭时只读准确拒绝而写工具仍进入确认；E2E 能核对预期提交但不公开绝对路径。

- [ ] **Step 1: 写独立任务与披露矩阵 RED**

同一 AgentService 先执行 TARGET_EXISTS 失败任务，再提交全新 create 任务并确认真实成功。以 `fileDisclosureAllowed=false` 表驱动断言 list/read/glob/grep 返回稳定设置提示，而 create/create_directory/edit/move/delete 仍能产生受控确认。

- [ ] **Step 2: 写全部工具名矩阵**

覆盖公开 `builtin.files.*` → 内部工具名 → 成功/失败 `result.toolName`；包含 create/read/glob/grep/edit/apply_patch/move/delete，断言任何不一致都在确认前拒绝。

- [ ] **Step 3: 运行 RED 并只修真实缺口**

Run: `pnpm.cmd --filter @myself/agent-core test`

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/agent-service.test.ts`

Run: `pnpm.cmd test:integration`

若生产测试全部通过，不改生产工具链；只增加能阻止旧构建误验收的 E2E 构建短哈希断言和准确披露提示。不得为了“像 OpenCode”替换已经通过安全边界的 FileToolService。

- [ ] **Step 4: 真实七工具副作用**

在隔离授权根验证 create/read/glob/grep/edit/move/delete；每个写操作确认前零副作用，确认后检查磁盘，失败后新会话仍可成功。

- [ ] **Step 5: 提交**

Commit: `test(agent): 封闭文件任务与旧构建验收分叉`

### Task 4: 三态运动模式

**Files:**
- Modify: `apps/desktop/src/main/storage/settings-store.ts`
- Modify: `apps/desktop/src/shared/character-motion-ipc.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Modify: `apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- Modify: `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Test: `apps/desktop/tests/settings-store.test.ts`
- Test: `apps/desktop/tests/character-behavior-director.test.ts`
- Test: `apps/desktop/tests/character-proactivity-scheduler.test.ts`
- Test: `apps/desktop/tests/explicit-character-behavior-gate.test.ts`

**Interfaces:**
- Produces: `type CharacterMovementMode = 0 | 1 | 2`；Director 与 Scheduler 只消费这一持久 owner。

- [ ] **Step 1: 写迁移与状态转换 RED**

断言旧 true→0、旧 false→2；模式 0 的单次 move 执行后仍为 0；模式 1 到达后立即换随机目标直到 stop；模式 2 每轮等待手算的 10/20/30 秒再移动一次；保存失败零动作。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/settings-store.test.ts tests/character-behavior-director.test.ts tests/character-proactivity-scheduler.test.ts tests/explicit-character-behavior-gate.test.ts`

Expected: 当前布尔组合无法表达三态及稳定迁移。

- [ ] **Step 3: 最小 GREEN**

以 `movementMode` 替换 `movementStopped/autonomousMovementAllowed/continuousMovementRequested` 的状态 owner。stop 写 0；continuous 写 1；resume 写 2；once/方向/区域只执行一次。阻塞只暂停模式 1/2，不改变持久模式；解除阻塞后按各自语义继续。

- [ ] **Step 4: 删除旧路径并运行 GREEN**

删除旧字段、旧布尔派生和只服务旧锁的测试别名；保留兼容迁移读取但迁移写回后不再输出旧字段。

Run: `pnpm.cmd --filter @myself/desktop exec vitest run tests/settings-store.test.ts tests/character-behavior-director.test.ts tests/character-proactivity-scheduler.test.ts tests/explicit-character-behavior-gate.test.ts`

Run: `pnpm.cmd verify:behavior`

- [ ] **Step 5: 提交**

Commit: `fix(behavior): 以三态模式统一桌宠运动策略`

### Task 5: 集成、复审、主目录同步

**Files:**
- Create: `docs/operations/2026-08-26-ai-pet-regression-closure-acceptance.md`

- [ ] **Step 1: 运行定向与全量门禁**

Run: `pnpm.cmd typecheck`

Run: `pnpm.cmd test:security`

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd verify:behavior`

Run: `pnpm.cmd verify:desktop`

Run: `node apps/desktop/scripts/run-local-model-acceptance.mjs --backend vulkan`

- [ ] **Step 2: 独立复审**

分别复审拖拽 owner/固定尺寸、三协议 SSE、安全文件事实和三态迁移；Critical/Important 必须清零后才继续。

- [ ] **Step 3: 记录验收与差异检查**

记录实际命令、退出码、测试数量、真实系统光标与文件副作用证据、未人工验证项。

Run: `git diff --check`

- [ ] **Step 4: 提交验收**

Commit: `docs: 记录桌宠四项回归最终验收`

- [ ] **Step 5: 同步干净主目录**

确认 `D:\Python\Important\myself` 的 `main` 工作区干净且仍是当前分支祖先，使用 fast-forward-only 合并 `AgentCoreExtension`；禁止覆盖用户改动、禁止 force、禁止 rebase。合并后在主目录运行最小启动构建身份检查。
