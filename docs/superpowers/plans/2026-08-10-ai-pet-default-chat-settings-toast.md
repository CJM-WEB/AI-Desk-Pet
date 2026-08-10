# 默认聊天与设置浮层提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通输入稳定进入自由聊天，只有具备明确本地文件操作证据的请求才进入文件任务；同时把设置页行内提示替换为统一三秒、可手动关闭且不挤压布局的浮层 Toast。

**Architecture:** 在可信 Main 进程新增纯规则 `ExplicitFileIntentGate`，先于模型调用决定“聊天/文件任务”；聊天分支改用只接收自然文本的 `ConversationChatAdapter`，文件分支继续复用现有授权、披露、确认与 Agent 安全链。Renderer 提取通用 `TransientToastLayer`，角色工作室与设置页共同复用计时、暂停、关闭及无障碍语义，设置页只维护最新一条提示。

**Tech Stack:** TypeScript、Electron、React、Vitest、Testing Library、Playwright、pnpm workspace。

## Global Constraints

- 只修改智能桌宠相关代码、测试与文档；禁止修改、构建、启动或验证 `apps/website`。
- 严格执行 RED→GREEN→REFACTOR；每个任务先保存失败证据，再写最小生产实现。
- 所有新增文档、注释、测试名称和用户可见文本使用中文；代码标识符沿用项目英文风格。
- Main 规则是唯一分流权威。模型提示不能提升文件权限或绕过分流规则。
- 文件任务的授权根、相对路径限制、历史披露、写入确认、重置和迟到事件隔离保持不变。
- 普通聊天仍只有当前进程内的 20 回合、16,000 Unicode 字符有界历史；本计划不伪装实现长期记忆、截图、剪贴板或主动性。
- 替换完成后删除旧 JSON 规划器、固定澄清回退和工作室重复计时代码，不保留兼容壳。
- 不记录用户正文、文件正文、密钥、绝对路径或 Provider 原始响应。
- 用户已批准本任务必要的 Git 写操作；每项通过定向测试和审查后再做小步提交。

---

## Task 1：建立可信 Main 明确文件意图门

**Files:**

- Create: `apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
- Create: `apps/desktop/tests/explicit-file-intent-gate.test.ts`
- Modify: `CONTEXT.md`（仅在实现暴露新歧义时补充）

- [ ] **Step 1：写纯分类器 RED 合同测试**

  表驱动固定以下核心边界：

  ```ts
  test.each([
    '你好', '聊天呀', '我想和你聊天', '帮我整理一下',
    '如何更安全地删除文件', '不要删除 a.txt'
  ])('默认按聊天处理：%s', text => {
    expect(gate.classify(text)).toEqual({ kind: 'chat' });
  });

  test.each([
    '读取 a.txt', '请列出当前文件夹',
    '删除当前文件夹里的 a.txt', '把 report.md 重命名为 archive.md'
  ])('只有明确执行请求进入文件任务：%s', text => {
    expect(gate.classify(text)).toEqual({ kind: 'file_task' });
  });
  ```

  额外覆盖：空白、英文教学问句、英文直接命令、只含操作词、只含文件对象、路径但无操作、否定请求和 Unicode 归一化。测试断言行为，不锁死内部正则。

- [ ] **Step 2：运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/explicit-file-intent-gate.test.ts
  ```

  预期因新模块不存在失败，而不是环境或夹具错误。

- [ ] **Step 3：实现最小三证据分类器**

  ```ts
  export type ConversationRoute =
    | Readonly<{ kind: 'chat' }>
    | Readonly<{ kind: 'file_task' }>;

  export class ExplicitFileIntentGate {
    classify(text: string): ConversationRoute {
      const normalized = normalizeIntentText(text);
      if (isNegatedOrInstructional(normalized)) return CHAT_ROUTE;
      return hasFileObject(normalized)
        && hasFileOperation(normalized)
        && hasExecutionRequest(normalized)
        ? FILE_TASK_ROUTE
        : CHAT_ROUTE;
    }
  }
  ```

  三个证据必须同时成立：明确文件对象、明确文件操作、要求桌宠实际执行。直接祈使句算执行请求；“如何/教程/解释/how to/what is”和“不要/别/do not”优先降为聊天。不得把“整理”“看看”“帮我”单独当作文件任务。

- [ ] **Step 4：GREEN、变异与自审**

  重跑定向测试。临时删除任一证据判断时至少一组边界测试必须 RED，随后恢复。确认返回值只含 `kind`，不携带正文或路径。

- [ ] **Step 5：提交**

  ```powershell
  git add apps/desktop/src/main/conversation/explicit-file-intent-gate.ts apps/desktop/tests/explicit-file-intent-gate.test.ts CONTEXT.md
  git commit -m "feat: 新增明确文件意图门"
  ```

---

## Task 2：用自由文本聊天适配器替代 JSON 规划响应

**Files:**

- Create: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Create: `apps/desktop/tests/conversation-chat-adapter.test.ts`
- Modify: `apps/desktop/tests/provider-contract.test.ts`

- [ ] **Step 1：写自然文本聊天 RED**

  固定请求为 `system + 获准历史 + 当前 user` 且 `tools: []`。普通中文、Markdown、代码块和合法 emotion 原样通过；空白、超过 8,000 Unicode 字符、`tool_request` 均抛 `PROVIDER_MALFORMED_RESPONSE`，错误不带 Provider 原始正文。

  ```ts
  await expect(adapter.respond({ history, text: '你好', signal }))
    .resolves.toEqual({ text: '晚上好！今天过得怎么样？' });
  expect(provider.requests[0]).toMatchObject({ tools: [] });
  ```

  明确断言系统提示不要求 JSON、不包含 `file_task`、不禁止 Markdown。

- [ ] **Step 2：运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/conversation-chat-adapter.test.ts
  ```

- [ ] **Step 3：实现 `ConversationChatAdapter`**

  ```ts
  export type ConversationChatReply = Readonly<{
    text: string;
    emotion?: CharacterEmotionLabel;
  }>;

  export class ConversationChatAdapter {
    constructor(private readonly provider: ModelProvider) {}
    async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
      const response = await this.provider.respond({
        messages: [SYSTEM_MESSAGE, ...input.history, { role: 'user', content: input.text }],
        tools: []
      }, input.signal);
      if (response.type !== 'text') throw malformedResponse();
      return normalizeReply(response);
    }
  }
  ```

  `normalizeReply` 以 `Array.from(text).length` 限长，拒绝 trim 后为空但保留合法格式；emotion 只复用 Provider 已归一化标签。错误复用现有 `ProviderError('PROVIDER_MALFORMED_RESPONSE', false)`。

- [ ] **Step 4：迁移三类 Provider 合同**

  `provider-contract.test.ts` 保留 OpenAI-compatible、Anthropic、Gemini 请求体精确断言，更新为自然文本可返回、工具为空、聊天工具调用被适配层拒绝、Abort/Timeout 分类不变。为 DeepSeek 预置增加自然文本无需 JSON 包装的回归证据。

- [ ] **Step 5：GREEN 与静态反查**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/conversation-chat-adapter.test.ts tests/provider-contract.test.ts
  rg -n "JSON.parse|clarify|file_task" apps/desktop/src/main/conversation/conversation-chat-adapter.ts
  ```

  最后一条应无命中。

- [ ] **Step 6：提交**

  ```powershell
  git add apps/desktop/src/main/conversation/conversation-chat-adapter.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/provider-contract.test.ts
  git commit -m "feat: 支持自由文本聊天回复"
  ```

---

## Task 3：迁移 Coordinator 唯一入口并删除旧规划器

**Files:**

- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`
- Modify: `apps/desktop/tests/main-conversation-composition.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Delete: `apps/desktop/src/main/conversation/conversation-turn-adapter.ts`
- Delete: `apps/desktop/tests/conversation-turn-adapter.test.ts`

- [ ] **Step 1：写 Coordinator 分流 RED**

  夹具注入新 Gate 与 ChatAdapter，覆盖：普通聊天只调用 chat factory；明确文件请求只调用 `fileTasks.prepareTarget`；Markdown 原样写历史和 Renderer；聊天 Provider 工具请求公开稳定错误且不追加历史；reset/cancel/披露/迟到响应保持既有隔离。

- [ ] **Step 2：运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/conversation-coordinator.test.ts tests/main-conversation-composition.test.ts
  ```

- [ ] **Step 3：把分流提前到 Provider 调用前**

  ```ts
  const route = this.options.intentGate.classify(context.text);
  if (route.kind === 'file_task') {
    await this.prepareFileTask(context);
    return;
  }
  await this.prepareChat(context);
  ```

  聊天分支才创建 chat target、计算聊天历史披露并 `adapter.respond`；文件分支直接复用 `prepareFileTask`。把 pending 的 `chat_plan` 改为 `chat_reply`，删除 `runPlan` 的三分支判断。

- [ ] **Step 4：迁移组合根与 Electron Main**

  `createChatAdapter` 改为返回 `ConversationChatAdapter`；组合根创建并注入意图门；`index.ts` 从同一 ProviderRegistry 和同一快照构造新适配器。不得添加 DeepSeek 特例或权限参数。

- [ ] **Step 5：迁移安全/集成夹具并删除旧实现**

  迁移两个根测试的 import/factory，保留密钥、路径、文件正文和公共事件哨兵。普通聊天把文件 Agent、授权和工具设为调用即抛并断言零调用。随后删除旧适配器和测试，不留 re-export、别名或固定澄清函数。

- [ ] **Step 6：GREEN 与静态反查**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/conversation-coordinator.test.ts tests/main-conversation-composition.test.ts tests/provider-contract.test.ts
  pnpm.cmd exec vitest run --config vitest.config.ts tests/security/permission-boundary.test.ts tests/integration/desktop-agent.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  rg -n "ConversationTurnAdapter|conversation-turn-adapter|chat_plan|我还不确定你是想聊天" apps/desktop/src apps/desktop/tests tests
  ```

  最后检索应无命中。

- [ ] **Step 7：提交**

  ```powershell
  git add apps/desktop/src/main apps/desktop/tests tests/security/permission-boundary.test.ts tests/integration/desktop-agent.test.ts
  git commit -m "refactor: 默认聊天并收紧文件任务分流"
  ```

---

## Task 4：提取通用瞬时 Toast 深模块

**Files:**

- Create: `apps/desktop/src/renderer/src/components/TransientToastLayer.tsx`
- Create: `apps/desktop/tests/transient-toast-layer.dom.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- Modify: `apps/desktop/tests/character-workshop-components.test.tsx`
- Delete: `apps/desktop/src/renderer/src/characters/workshop/WorkshopToastLayer.tsx`
- Delete: `apps/desktop/tests/workshop-toast-layer.dom.test.tsx`

- [ ] **Step 1：迁移既有生命周期合同为通用组件 RED**

  覆盖：只显示队首、自动/手动关闭、hover/focus 独立及叠加暂停、ID 切换清 timer、卸载清理、回调异常不重复关闭、最新回调引用、warning/error 为 `alert`、其余为 `status`。

  ```tsx
  <TransientToastLayer
    queue={queue}
    onDismiss={onDismiss}
    durationMs={toast => toast.tone === 'error' ? 6000 : 3000}
    ariaLabel="工作台提示"
  />
  ```

- [ ] **Step 2：运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx
  ```

- [ ] **Step 3：抽取显示与计时深模块**

  ```ts
  export type TransientToast = Readonly<{
    id: string;
    tone: 'success' | 'info' | 'warning' | 'error';
    text: string;
  }>;
  ```

  迁移旧 timer/pause/resume/dismiss 逻辑。结构性注释说明组件只消费队首、队列归调用方；关闭按钮有明确 `aria-label` 且不抢焦点。

- [ ] **Step 4：工作室直接复用并删除旧层**

  工作室持续时间保持 success/info 3 秒、warning/error 6 秒，避免意外改变其他功能。移除旧组件和旧 DOM 测试，把有效测试迁入通用测试；把通用 layer/toast 基础视觉迁入 `styles.css`，再清理工作室重复计时代码和专属样式，保证本任务提交后工作室不会出现无样式中间态。

- [ ] **Step 5：GREEN 与提交**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx tests/character-workshop-components.test.tsx
  pnpm.cmd --filter @myself/desktop typecheck
  git add apps/desktop/src/renderer/src/components apps/desktop/src/renderer/src/characters apps/desktop/tests
  git commit -m "refactor: 提取通用瞬时提示层"
  ```

---

## Task 5：设置页改为统一三秒 Toast

**Files:**

- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Create: `apps/desktop/tests/settings-toast.dom.test.tsx`
- Modify: `apps/desktop/tests/renderer-components.test.tsx`
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx`

- [ ] **Step 1：写设置 Toast RED**

  fake timers + 真实 `SettingsView` API 夹具覆盖四种 tone 均恰好 3,000ms；2,999ms 仍在、3,000ms 消失；手动关闭；hover/focus 暂停；新提示替换旧提示并重新计时；提示出现/消失不改变主体布局。连接测试成功提示必须位于 fixed 浮层，不在 `.settings-shell` 文档流。

- [ ] **Step 2：运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/settings-toast.dom.test.tsx tests/renderer-components.test.tsx tests/multi-provider-settings.test.tsx
  ```

- [ ] **Step 3：接入通用 Toast**

  给每条设置提示生成单调 `id`，全部 `setNotice` 收敛到 `showNotice`；新提示覆盖旧提示。`SettingsWorkspace` 增加 `onDismissNotice`，渲染：

  ```tsx
  <TransientToastLayer
    queue={notice ? [notice] : []}
    onDismiss={id => setNotice(current => current?.id === id ? null : current)}
    durationMs={() => 3000}
    ariaLabel="设置提示"
  />
  ```

  ID 比对防止旧 timer 清除新提示。初始读取、成功、信息与错误均复用同一入口。

- [ ] **Step 4：固定布局与无障碍样式**

  在 `styles.css` 添加通用 layer/toast 样式：设置窗右上、避开标题栏按钮、合理层级、窄窗最大宽度、`overflow-wrap:anywhere`；只动画 opacity/transform；`prefers-reduced-motion` 下关闭过渡。删除两处 `.settings-notice`。

- [ ] **Step 5：GREEN、反查与提交**

  ```powershell
  pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/settings-toast.dom.test.tsx tests/transient-toast-layer.dom.test.tsx tests/renderer-components.test.tsx tests/multi-provider-settings.test.tsx tests/character-workshop-components.test.tsx
  pnpm.cmd --filter @myself/desktop typecheck
  rg -n "settings-notice|WorkshopToastLayer" apps/desktop/src apps/desktop/tests
  git add apps/desktop/src/renderer apps/desktop/tests
  git commit -m "feat: 设置提示改为三秒浮层"
  ```

---

## Task 6：纵向安全回归、Electron 验收与文档

**Files:**

- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/fixtures/provider-server.ts`（仅现有能力不足时）
- Modify: `tests/integration/provider-server.test.ts`（仅夹具扩展时）
- Create: `docs/operations/default-chat-settings-toast-acceptance.md`
- Create: `.superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/task-6-report.md`

- [ ] **Step 1：写 Electron RED 场景**

  使用本地脚本 Provider，覆盖：连续三次普通聊天均为不同自然回复且无旧固定澄清；Markdown 原样显示且请求 `tools=[]`；“帮我整理一下/如何安全删除文件”不触发文件链；“列出当前文件夹”进入既有安全文件链；连接测试提示浮层 3 秒消失，另一提示可手动关闭，主体位置不变。

- [ ] **Step 2：聚焦运行 RED**

  ```powershell
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test tests/e2e/desktop.spec.ts -g "默认聊天与设置浮层提示"
  ```

  不增加固定 sleep。夹具不足时只扩展去标识化请求摘要或显式 gate。

- [ ] **Step 3：只修纵向接线缺口并 GREEN**

  不新增生产 preload 探针；复用 CDP 可见 DOM、Provider 摘要和受控响应 gate。任何生产修正都必须先有更窄 RED。

  ```powershell
  pnpm.cmd exec playwright test tests/e2e/desktop.spec.ts -g "默认聊天与设置浮层提示"
  pnpm.cmd test:security
  pnpm.cmd test:integration
  ```

- [ ] **Step 4：执行完整非网站门禁**

  明确排除 website 的类型门：

  ```powershell
  pnpm.cmd --filter @myself/shared-types typecheck
  pnpm.cmd --filter @myself/file-tools typecheck
  pnpm.cmd --filter @myself/agent-core typecheck
  pnpm.cmd --filter @myself/character-runtime typecheck
  pnpm.cmd --filter @myself/character-assets typecheck
  pnpm.cmd --filter @myself/desktop typecheck
  pnpm.cmd --filter @myself/release-tools typecheck
  ```

  再顺序运行：

  ```powershell
  pnpm.cmd test:unit
  pnpm.cmd test:security
  pnpm.cmd test:integration
  pnpm.cmd test:e2e:desktop
  pnpm.cmd verify:behavior
  git diff --check
  git diff --name-only -- apps/website
  ```

  网站 diff 必须为空。禁止运行根 `pnpm typecheck`，它会递归进入 website。

- [ ] **Step 5：写验收文档与报告**

  文档记录自动证据和人工项：真实 DeepSeek 连续聊天自然度、Markdown 观感、不同窗宽 Toast 位置、hover/focus 暂停和手动关闭。明确长期记忆、截图、剪贴板、主动性仍未实现，选项继续禁用并显示“尚未接入运行时”。报告记录 RED/GREEN、计数、耗时、文件清单、网站零修改，不记录正文或密钥。

- [ ] **Step 6：两轴独立审查**

  使用 `requesting-code-review`：规格轴逐项检查 `CHAT-DEFAULT-*`、`CHAT-INTENT-*`、`CHAT-REPLY-*`、`SETTINGS-TOAST-*`；质量轴检查竞态、reset、历史污染、错误泄露、权限升级、timer 清理、焦点和响应式。Critical/Important 必须先补 RED 再最小修复并重跑受影响门。

- [ ] **Step 7：提交验收变更**

  ```powershell
  git add tests/e2e/desktop.spec.ts tests/fixtures/provider-server.ts tests/integration/provider-server.test.ts docs/operations/default-chat-settings-toast-acceptance.md
  git add -f .superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/task-6-report.md
  git commit -m "test: 验收默认聊天与设置浮层提示"
  ```

---

## 规格覆盖矩阵

| 规格 | 自动证据 |
|---|---|
| `CHAT-DEFAULT-001..004` | Task 1 分类器；Task 3 Coordinator；Task 6 连续聊天 E2E |
| `CHAT-INTENT-001..006` | Task 1 正反例/变异；Task 3 文件端口零/单调用；安全测试 |
| `CHAT-REPLY-001..008` | Task 2 ChatAdapter/Provider；Task 3 历史/reset/错误；Task 6 E2E |
| `SETTINGS-TOAST-001..009` | Task 4 通用生命周期；Task 5 设置 DOM/CSS；Task 6 E2E/人工视觉 |

## 后续规格顺序（本计划不实现）

1. 本地长期记忆：数据模型、显式开关、无痕隔离、查看/删除/导出和跨 Provider 披露。
2. 截图与剪贴板：按任务临时授权、最小采集、来源标记和泄露测试。
3. 主动性：事件源、频率预算、静默时间、用户中断和关闭开关。

只有对应运行时、权限边界、删除路径和验收证据完成后，设置项才可从“尚未接入运行时”变为可操作。
