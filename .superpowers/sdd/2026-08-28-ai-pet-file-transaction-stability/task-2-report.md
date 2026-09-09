# Task 2 实施报告：可信文件引用与会话级能力事务

日期：2026-08-28

基线：`862b7b0563b0af6902352117d22c98739a383b8d`

范围：仅实施 Task 2；未修改 Provider Adapter 的格式错误分类，未新增共享 `TaskEvent`，未向 Preload 或 Renderer 投影私有结果。

## RED 证据

1. 首个事务测试按 brief 命令运行时失败：`capability-transaction.test.ts` 找不到目标模块；同轮既有 Desktop 测试 106 个文件、2724 项通过，证明失败来自新需求而非既有回归。
2. 精确定向运行 `capability-transaction.test.ts` 与 `agent-service.test.ts`：事务模块缺失；只读与确认写的私有结果数组为空。
3. Adapter 私有订阅测试失败：`onTrustedToolResult` 不存在。
4. Coordinator 与 Router 新用例共 5 项失败：确认前“继续”触发 `TASK_ALREADY_ACTIVE`；“成功了吗”和事务指代进入普通聊天；“把 order 文件放入 a 文件夹”未生成移动提示。
5. 追加失败终态测试后，失败工具结果会被后续 `thinking` 覆盖；追加澄清测试后，结构化澄清仍停留在 planning。
6. 自审追加两项 RED：目标快照变化时未释放新 owner；明确新任务预检失败后仍保留旧成功终态。

以上 RED 均先观察到预期失败，再进入实现；没有通过先写完整实现后补形式测试来制造 RED。

## GREEN 与实现

### Main 私有事实端口

- 在 `AgentService` 增加仅限 Main 的 `AgentTrustedToolResult` 和可选 `emitTrustedToolResult`。
- 受控只读工具真实返回后发布一次；确认写真实完成后发布一次。
- 工具失败只发布 `ok=false`，取消与过期不发布成功结果。
- 私有载荷只保留工具名、真假结果和再次校验过的根内相对路径；正文、绝对路径、PowerShell 输出均不进入载荷。
- 私有观察者异常不会改写已经发生的本地工具事实。

### 会话级能力事务

- 新增纯 Main 内存 `CapabilityTransactionStore`，保存 identity、phase、稳定工具结果码和可信相对路径引用。
- 公开 `TaskEvent` 只迁移阶段；assistant 自由文本不能建立引用，也不能把失败改写成成功。
- 只有 `AgentTrustedToolResult.ok=true` 建立引用；失败终态对后续模型口头成功保持稳定。
- 支持创建、读取、移动源/目标和删除引用；快照及内部数组对外冻结。
- generation、Provider、授权能力修订、明确新任务、重置/新会话和关闭均清空旧事务。

### 所有权绑定与续跑

- `ConversationCapabilityTaskPort`/`CapabilityTaskAdapter` 增加独立 `onTrustedToolResult` 订阅。
- Adapter 仅在当前 owner、active submission、generation 和同一 target 均成立时转发；提交结束后的迟到结果被丢弃。
- Coordinator 在 Provider 之前识别事务续接与终态询问；可信引用只作为私有规划上下文交回原文件 Agent 链，不进入公开用户消息。
- 等待确认时收到“继续”只返回宿主固定等待文案，执行次数保持为零。
- Provider 或能力修订变化时拒绝续接、清空事务并释放刚准备的 owner；明确新任务从开始预检时即替换旧事务。
- Router 只增加“放入”移动表达及编辑同义词识别，未扩大否定/引用 Gate。

### 必要生产接线

- `main-conversation-composition.ts` 与 `main/index.ts` 只透传 Main 私有回调到 `AgentService`。
- 没有修改 `packages/shared-types`、Preload 或 Renderer。

## 修改文件

- `apps/desktop/src/main/agent/agent-service.ts`
- `apps/desktop/src/main/conversation/capability-transaction.ts`（新增）
- `apps/desktop/src/main/conversation/capability-task-adapter.ts`
- `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- `apps/desktop/src/main/conversation/capability-intent-router.ts`
- `apps/desktop/src/main/conversation/main-conversation-composition.ts`（必要生产接线）
- `apps/desktop/src/main/index.ts`（必要生产接线）
- `apps/desktop/tests/agent-service.test.ts`
- `apps/desktop/tests/capability-transaction.test.ts`（新增）
- `apps/desktop/tests/capability-task-adapter.test.ts`（所有权与迟到结果边界）
- `apps/desktop/tests/conversation-coordinator.test.ts`
- `apps/desktop/tests/capability-intent-router.test.ts`

## 验证结果

- 六文件精确定向：6 个文件、466 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- brief 原样 GREEN 命令：因 Desktop 脚本参数转发语义实际运行全套 Desktop 测试，107 个文件、2751 项通过。
- `pnpm.cmd test:security`：1 个文件、28 项通过。
- `pnpm.cmd test:integration`：4 个文件、87 项通过。
- `pnpm.cmd test:e2e:desktop`：构建与边界校验通过；Playwright 首跑 76 项通过、1 项跳过、1 项失败。失败为无关角色工作室用例等待“运行版本已编译并发布。”提示 10 秒超时。
- 失败角色工作室用例精确重跑：1 项通过，耗时 51 秒。
- `git diff --check`：通过；仅显示仓库现有行尾转换提示，没有空白错误。
- 私有端口符号扫描：仅位于 `apps/desktop/src/main`，未出现在 `packages/shared-types`、Preload 或 Renderer。

## 自审

- 规格一致性：可信引用只来自真实工具端口；assistant 口头成功、公开事件和 Renderer 均不能建立引用。
- 生命周期：reset/close 先失效事务；Adapter 关闭清空私有监听；旧 owner 和迟到结果均被丢弃。
- 隐私：测试向只读结果注入正文和绝对路径，私有结果仍只包含允许的相对路径；公共事件不含 `relativePaths`。
- 最小修改：复用既有 Agent、Adapter、Coordinator、目标快照与 Router；没有创建第二套执行器或修改 Provider 格式错误分类。
- 自审中发现并修复：目标变化只报错但未失效/清理、明确新任务预检失败仍保留旧事务，两项均先补 RED 再修复。

## 提交

提交消息：`feat: 增加会话级文件能力事务`。本报告与实现一同提交；最终提交哈希以任务返回为准。

## 疑虑与未覆盖项

- 全套 Desktop E2E 的角色工作室用例在并发负载下发生一次 10 秒提示等待超时，隔离重跑通过；这是与本任务无文件重叠的时序波动，本次未修改角色代码。其余 Task 2 定向、Desktop 全套单测、安全、集成与类型检查均稳定通过。
- 未执行人工 Windows UI 验收；本任务新增链路没有 Renderer 变更，自动化证据覆盖 Main 事务、真实工具集成和既有 Electron E2E。

## Fix round 1/5（2026-08-28）

### RED 证据

1. 事务终态定向测试先出现 4 项预期失败：读取成功后编辑失败被公开 `phase:success` 误放大为 completed；真实写入成功后的 `PROVIDER_SUMMARY_FAILED_AFTER_WRITE` 被 `phase:error` 改写为 failed；PowerShell 成功与失败均没有 Main 私有结果。
2. Adapter 续接测试先观察到 `createAgentTarget` 被调用 2 次；AgentService 续接测试先观察到 `createSession` 被调用 2 次，证明原实现未复用同一事务 Agent/Session。
3. 预算测试先出现 4 项预期失败：去重后引用保留 40 条而非 16 条；两个 Coordinator 用例仍把私有上下文拼入 `submit.text`；AgentService 未注入独立私有 system message。
4. 早期失效测试先观察到：新任务的行为预处理抛错后，旧事务仍能回答成功终态。
5. “真实写入成功但模型总结失败”的状态询问测试先失败：实现只回答“上一个本地任务已成功完成”，未携带 summary warning。
6. 真实 TTL 用例使用可控 `now`、不先 cancel，在 120000 ms 到期后确认无执行且无私有成功结果。此用例在基线已通过，属于对现有 TTL 行为的真实覆盖补强，没有伪造 RED。

### GREEN 与修改

- 事务终态改为结合“最后一条可信工具结果”与公开错误类别：后续失败不会被历史成功放大；真实写提交后的模型总结失败保留 completed，并记录去重后的 warning code。
- PowerShell 真实执行成功或失败各发布一次 Main 私有结果；载荷只有 `toolName`/`ok`/`relativePaths: []`，不包含命令、输出或绝对路径。
- 同一有效事务续接时，Adapter 复核授权根和新目标快照；owner、generation、旧目标与新快照均一致时，复用原 `PreparedTarget`、OwnedAgent 和 AgentService。AgentService 在事务生命期内复用原 AgentSession，reset/close 时统一释放。
- 可信引用去重后最多 16 条，转录保留最新 32 条，私有规划上下文序列化不超过 1200 字符。新增独立 `privatePlanningContext?: string`，以 Main 私有 system message 输入 Agent；用户原文仍独立享有 4000 字符预算，`submit.text` 不再拼入私有内容。
- 在输入规范化与 follow-up/new-task 分类后、任何行为预处理前清除明确新文件/PowerShell 任务的旧事务；因此预处理失败也不会保留旧终态。
- 终态询问对 summary warning 使用宿主固定文案：“上一个本地操作已成功，但模型总结失败。”
- 本轮未修改 Provider Adapter 格式错误分类，未新增共享 `TaskEvent`，未把私有事实暴露到 Preload 或 Renderer。

### 验证结果

- Task 2 六文件定向：6 个文件、478 项通过。
- `pnpm.cmd --filter @myself/desktop test`：107 个文件、2763 项通过。
- `pnpm.cmd test:security`：1 个文件、28 项通过。
- `pnpm.cmd test:integration`：4 个文件、87 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `pnpm.cmd typecheck`：10 个 workspace 的可用 typecheck 全部通过。
- `git diff --check`：通过；只有仓库行尾转换提示，无空白错误。

### 自审与疑虑

- 逐项对照 5 条 Important 和 TTL Minor，每项均有定向测试；实现只修改 Main 内既有 Agent/Adapter/Coordinator/事务 seam。
- PowerShell 私有载荷测试明确断言不包含命令和输出；独立规划上下文测试断言不进入 `submit.text`。
- 未执行新的人工 Windows UI 验收；本轮仍只改 Main 链路，无 Renderer 改动。
- 本轮没有剩余的已知功能阻塞。

### 提交

提交消息：`fix: 稳定会话级能力事务`。最终提交哈希以任务返回为准。

## Fix round 2/5（2026-08-28）

### RED 证据

1. 四文件定向首跑共观察到 7 项预期失败：`CapabilityTransactionStore.beginTurn` 尚不存在；16 条引用满额后创建/移动新路径被丢弃；Adapter 没有向 AgentService 传入 submission owner；旧 submission abort 后的迟到读取结果污染了同 generation/target 新回合；AgentService 没有原样回传 owner；新一轮未调用工具的文件续接借用历史成功终态；明确 PowerShell 新任务在行为预处理抛错后仍保留旧事务。
2. 这些测试各自捕获错误分支、迟到副作用或可观察终态；迟到结果用例使用可控 Promise 屏障，不依赖墙钟竞态。

### GREEN 与修改

- `CapabilityTransactionStore.beginTurn()` 在每个实际文件能力续接开始时重置当前回合的 `lastTrustedResultOk`、warning 和终态，但保留有界 references 与 transcript。因此公开 `phase:success` 只能由当前回合的 trusted ok 结果进入 completed。
- Coordinator 在 normalize 后使用无副作 `capabilityIntentRouter.route` 识别明确 PowerShell 新任务，并在 `behavior.prepareUserPrompt` 前清除旧事务；该阶段不签发权限或创建 Agent。
- Adapter 每次 `submit` 独立创建 Main 私有 symbol owner，通过 `AgentFileTaskSubmission` 传入 AgentService；AgentService 只在内部 task owner 仍有效时原样附到 `AgentTrustedToolResult`。Adapter 转发前同时比对 Agent owner、submission owner、generation 与 target。
- submission symbol 没有进入共享 `TaskEvent`、日志、Preload 或 Renderer；等待写确认时保留原 submission owner，确认结束、取消、reset 或 close 后清理。
- references 改为“最近且去重”的 16 条：新可信路径先删除旧同路径，再追加到队尾；超过 16 时淘汰最旧条目，不再用 `break` 丢弃最新创建/移动事实。
- 本轮未修改 Provider Adapter 格式错误分类，未增加共享公开事件或 Renderer 能力。

### 验证结果

- 四文件 GREEN：4 个文件、225 项通过。
- Task 2 六文件定向：6 个文件、483 项通过。
- `pnpm.cmd --filter @myself/desktop test`：107 个文件、2768 项通过。
- `pnpm.cmd test:security`：1 个文件、28 项通过。
- `pnpm.cmd test:integration`：最终单独全套复跑 4 个文件、87 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：通过。
- `pnpm.cmd typecheck`：10 个 workspace 的可用 typecheck 全部通过。
- `git diff --check`：通过；只有仓库行尾转换提示，无空白错误。

### 自审与疑虑

- 逐项对照本轮 4 条 Important：回合事实、PowerShell 早期失效、submission 所有权与引用淘汰均有会在旧实现上失败的回归测试。
- symbol 扫描只命中 `apps/desktop/src/main` 与测试，未命中 `packages/shared-types`、Preload 或 Renderer。
- 集成门禁与安全/typecheck 并行首跑时，无文件重叠的角色素材夹具在固定 5 秒上限超时，其余 86 项通过；该夹具隔离复跑 1/1 通过（2.23 秒），随后单独完整集成套件 87/87 通过。本轮未修改角色代码，记录为并行资源竞争时序，未调整无关超时。
- 未执行新的人工 Windows UI 验收；本轮仍仅改 Main 会话/事务链路。

### 提交

计划提交消息：`fix: 隔离能力事务回合结果`。最终提交哈希以任务返回为准。
