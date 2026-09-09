# 单一发送入口与表现隔离实施计划

> **执行要求：** 使用 `subagent-driven-development` 按任务实施；遵守 SDD／TDD，每项独立审查。步骤使用复选框记录。

**目标：** 普通发送能申请真实任务，聊天不因表现失败而失败，角色在有对应动画时才移动并保持独立心情。

**架构：** 复用现有 Provider、Main Coordinator、有限 OpenCode Core 和一个角色 Engine。原生聊天／任务请求与无工具表现请求顺序执行；Main 持有仲裁、时间与播放回报。

**技术栈：** Electron、TypeScript、Zod、Vitest、pnpm；现有 Qwen Runtime 与 DeepSeek，无新依赖。

## 全局约束

- 适用规格：`docs/superpowers/specs/2026-09-08-single-send-expression-isolation-design.md`。用户已批准该路线和额外请求的取舍。
- 所有面向人的文档、结构性注释使用中文；不得修改网站、CloudBase、扫描器、锁文件及依赖解析。
- 保留现有 DeepSeek／Qwen、有限 OpenCode Core 和 Main 授权；MCP 禁用；不打包、不 push。
- 单一发送入口由模型理解任务；主请求无角色 JSON，申请工具严格 `{}`，只触发范围卡；范围前没有文件执行。
- 普通聊天先主请求、后无工具表现请求；表现最多 12 秒、不重试、不接纳迟到结果；失败仍交付已成功正文。
- 表现模型不接收文件工具输出、目录快照或任务历史正文，不决定毫秒数、事实或文件权限。
- 状态 ID 自定义，仅 idle 必需；移动优先，心情独立，缺动画不移动，首帧回报最多等 1.5 秒。
- 新路径验证后删除被替代的旧运行分支；不删除用户角色数据，不批量删除文件。
- 每个诊断点／修复点 15 分钟无可判定结果即换更小 seam；不无限重试模型或重复大门禁。

## Task 1: 语义表现契约与单引擎活动仲裁

**文件：**
- 修改 `packages/character-runtime/src/character-behavior-plan.ts`、`character-expression-engine.ts`、`index.ts`。
- 新增 `packages/character-runtime/src/character-expression-selection.ts`，集中精简模型 Schema 和到宿主计划的转换。
- 测试 `packages/character-runtime/tests/character-expression-engine.test.ts`，新增 `character-expression-selection.test.ts`。

**接口：**
- 导出 `characterExpressionSelectionSchema`、`characterExpressionSelectionJsonSchema`、`CharacterExpressionSelection`。字段严格对应规格；自主投影由下一任务从同一 Shape 派生。
- 导出 `toCharacterExpressionDecision(selection, source)`，输出 `{moodUpdate?,expressionPlan?,explicitPlayback?,movementControl,requestKind}`；`source` 为 `chat | autonomous`。自主输出不得带运动或明确播放。转换器无时钟、无 Provider。
- Engine 增加 `prepareActivity(fact: keyof CharacterRuntimeFacts): CharacterExpressionResult` 与 `releasePreparedActivity(): CharacterExpressionResult`，准备状态独立于真实 facts；继续复用既有 `hasEligibleExpressionFor` 和 token。
- 保持已有宿主 `CharacterExpressionPlanInput` 及 Service 依赖的方法签名，活动候选与心情候选分开保存所有权但仍只有一个当前状态和一个调度器。

- [x] RED：用任意 ID 的 fixture 验证活动分低于心情分仍在 moving 时获选；mood 更新不删除既有行走候选；无条件 episode 不因聊天结束而失效。

```ts
engine.applyDecision({context: engine.context(), eventId: 'mood', source: 'chat', moodUpdate: {summary: '愉快', strength: .8}, expressionPlan: mixedPlan});
engine.updateRuntimeFacts({moving: true});
expect(engine.snapshot().stateId).toBe('motion-custom');
engine.updateRuntimeFacts({moving: false});
expect(engine.snapshot().mood?.strength).toBeGreaterThan(0);
expect(engine.snapshot().stateId).not.toBe('motion-custom');
```

- [x] RED：当前动作收到 started 后注入空计划／新心情无匹配，token 和原截止不变，推进到原截止正常结束；reset、资源失败、活动事实结束仍能撤销。
- [x] RED：精简 Schema 拒绝模型毫秒数、非法事实、重复 ID；转换活动区间为 0..1，episode 无聊天条件；准备 moving 时 snapshot 不伪造真实事实，释放／reset 清准备。
- [x] 运行 `pnpm.cmd --filter @myself/character-runtime test -- character-expression-engine.test.ts character-expression-selection.test.ts`，确认以上新断言因现状失败。
- [x] GREEN：在已有 Engine 选择和生命周期中实施上述规则；不增加第二状态机、不按状态名称猜行走。准备方法复用实际筛选与调度，无候选不返回行走 token。
- [x] 运行同一组测试及 `pnpm.cmd --filter @myself/character-runtime typecheck`；记录 RED/GREEN 和公开接口，提交本任务文件。

## Task 2: 原生正文／任务与独立表现适配器

**文件：**
- 修改 `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`。
- 必要时抽取 `apps/desktop/src/main/conversation/character-expression-adapter.ts`，只承载表现请求投影、严格解码和预算。
- 修改 `packages/agent-core/src/types.ts`、`response-contract.ts` 及 `apps/desktop/src/main/providers/openai-provider.ts`、`local-model-provider.ts`；Anthropic/Gemini 仅作相同契约消费兼容。
- 测试 `apps/desktop/tests/conversation-chat-adapter.test.ts`、`provider-contract.test.ts`、`local-model-provider.test.ts`、`openai-provider.test.ts`；新增 `apps/desktop/tests/character-expression-adapter.test.ts` 验证精简表现适配。

**接口：**
- `ConversationChatAdapter.respond(input)` 保持当前调用形状。宿主返回类型暂复用 `ConversationChatReply` 中的 `capabilityPlan`：该值仅由严格原生工具解析生成，不再解析模型 JSON 的同名字段。申请返回 `agent_task`，正文为空也合法；普通正文返回 `chat`。
- 主请求提供唯一 `request_task_authorization`，严格空对象；自然正文、合法调用及正文加合法调用均可解码，非法调用不得借正文降级成成功。
- `respond` 对普通正文调用独立表现请求，返回 `expressionStatus: 'ready' | 'no_match' | 'failed'` 及 Task 1 转换后的字段、`requestKind`；新增字段在整合任务前可以为可选以保持现有宿主类型兼容，不新增旧协议备用路径。
- `respondAutonomous` 保持原公开参数和预算回调，内部使用同一精简语义契约，仅 mood/plan。新增 `respondActivity(input)` 用于仅匹配 `moving` 的无工具准备，保持同样的 `beforeProviderCall`、取消、目录投影和无正文约束；返回宿主 `expressionPlan`，不更新心情或发起位移。
- ModelRequest 可添加 Main 自有 `purpose:'conversation'` 标记，给新自然聊天保留 DeepSeek 的非思考和有界输出策略；不以角色 `response_format` 开关冒充用途。

- [x] RED：记录实际发出的主请求，断言没有 `responseContract`，`tools` 恰含申请工具；已有会话人设／正文历史保留；静态 JSON `capabilityPlan` 文本不得申请。

```ts
const reply = await adapter.respond(input);
expect(requests[0].responseContract).toBeUndefined();
expect(requests[0].tools.map(t => t.function.name)).toEqual(['request_task_authorization']);
expect(reply.capabilityPlan?.kind).toBe('agent_task');
expect(requests).toHaveLength(1);
```

- [x] RED：合法正文后的表现请求只携带当前用户文字与公开角色情境，无会话任务正文、无工具、无正文 text 字段；表现空白／非法／12秒超时仍返回首次正文，父取消仍取消全轮，迟到结果无效。
- [x] RED：主模型 task 请求缺 ID、未知工具、多工具、额外参数失败；合法混合正文不阻断申请。Qwen 首条 system 合并、8192/6400 预算、无思考、连接 generation 保持。
- [x] GREEN：删除旧联合 JSON 主请求和表现修复循环，复用已有 Provider、codec、请求字节裁剪；不复制传输层。普通请求先后执行，表现使用独立 AbortController 与 12 秒 race，并清理计时和监听。
- [x] GREEN：语义请求由 Task 1 Shape 派生严格 JSON Schema；为了理解固定 Gate 之外的明确表达，公开目录可包含用于明确查找的不可推断状态，严格接纳时仅 `state/action` 能选择它们，`ambient` 仍只能选择可推断候选；输出不接受自行生成的时间／条件字段。
- [x] 运行对应定向测试、`pnpm.cmd --filter @myself/agent-core typecheck` 和 desktop typecheck；对尚待 Task 3 迁移的夹具明确列出，不能删除未受影响的安全断言；提交本任务。

## Task 3: 单一发送与原授权链整合

**文件：**
- 修改 `apps/desktop/src/main/conversation/conversation-coordinator.ts`、`main-conversation-composition.ts`。
- 修改 `apps/desktop/src/shared/myself-api.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc/register-ipc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/src/chat/ChatPanel.tsx`。
- 定向搜索并移除 `ChatSubmissionIntent`、`submissionIntent`、`作为任务发送` 的运行分支；删除 `capability-intent-router.ts` 的正式入口引用及只服务旧分流的代码。
- 迁移 `apps/desktop/tests/conversation-coordinator.test.ts`、`main-conversation-composition.test.ts`、`chat-panel.test.tsx`、`preload-api.test.ts`、`agent-ipc.test.ts`、`tests/e2e/desktop.spec.ts` 及 `apps/desktop/scripts/local-model-acceptance-runner.ts` 的显式提交调用。

**接口：**
- 产品 `submitMessage`／Coordinator `submit` 只接收文本；不保留 `auto/task` 别名。
- 主模型原生申请仍映射到既有 `prepareCapabilityTask(context,'file')`；Core 的工具／命令能力由原任务范围定义，不从前置语义分类器决定。
- `CompletedCharacterPrompt` 传递 Task 2 的 `expressionStatus`、`requestKind`；接口新增到 Director，行为处理留给 Task 4。

- [x] RED：同一个提交 API 的自然文件问句通过原生调用展示范围卡；范围确认前执行器计数为 0；拒绝后为 0；同意后 Core 收到当前原文和原披露历史。
- [x] RED：用受控模型模拟“目录乱？”→诚实未查看→“可以，先看看”→原生申请，断言历史连续且没有继承旧许可。
- [x] RED：坏表现仍提交正文，任务申请不等待表现；reset／关闭／Provider 切换让旧范围、请求和回复失效；单个发送按钮和 Enter 都调用同一 API。
- [x] GREEN：去掉句式分流与显式提交分支，保留确认 follow-up、可信上次任务事实摘要、披露和授权生命周期；原始用户输入始终保留。
- [x] 更新受影响真实模型／E2E 夹具，让普通发送的主响应使用原生 task 调用或纯正文；不能通过另开内部显式入口绕过待验收路径。
- [x] 运行 Coordinator／composition／UI／IPC 定向测试和 desktop typecheck；提交本任务及旧入口退役。

## Task 4: 统一运动准备、有限动作与缺失反馈

**文件：**
- 修改 `apps/desktop/src/main/characters/character-behavior-service.ts`、`character-behavior-director.ts`、`character-proactivity-runtime.ts`、`character-proactivity-scheduler.ts`（仅必要接线）。
- 修改 `apps/desktop/src/main/conversation/main-conversation-composition.ts`、`apps/desktop/src/main/index.ts` 的活动匹配回调与播放回报接线。
- 必要时补充 `packages/character-runtime/src/character-expression-engine.ts` 的明确播放释放接口及其定向测试，供新的明确移动打断旧明确播放；保持已有心情和活动缓存，不以全引擎 reset 代替。
- 测试对应 Service／Director／Runtime／composition 文件；实际 Renderer `started` 含义若需修正，仅改 `src/renderer/src/characters/player/CharacterPlayer.tsx` 及其直接测试。

**接口：**
- Service 暴露 Task 1 的 `prepareActivity/releasePreparedActivity`，以原 `CharacterExpressionAuthorization` 返回准备 token；不增加公开系统能力或新的 IPC。
- Director 统一持有待移动请求、目标 token 和 1.5 秒首帧截止；只有同一 token 的合法 started 才提交位移。已确认的当前行走 token 可复用；失败／中断／取消／角色失效清除准备并停止位移。
- `getChatContext` 继续用 pendingMovement 标记准备事实，真实 moving 来自 MotionService。
- Runtime 的唯一在途槽增加按需活动匹配用途；空闲时复用 composition→adapter `respondActivity`，每个角色／Provider／运动模式生命周期最多一次自动缺失匹配尝试。用户明确请求可重新匹配；后台心情额度不被零成本 tick 绕过。

- [x] RED：一次、持续、间断、续行均无适用动画时，`motion.requestIntent` 为 0；相同自动失败不逐 tick 反复调用模型或提示。
- [x] RED：准备返回 token 后未 started 时零位移；相同 token started 后一次位移；错误 token、1500ms 超时、failed、reset 后 started 均零位移。

```ts
director.requestPersistentMovement();
expect(motion.requestIntent).not.toHaveBeenCalled();
director.applyPlaybackFeedback({playbackToken: token, actionId, status: 'started', occurredAtMs: now});
expect(motion.requestIntent).toHaveBeenCalledTimes(1);
```

- [x] RED：已移动过程中行走播放失败即停；停止后心情仍有效且择态恢复；新普通心情没有匹配不重置当前 token 的截止。
- [x] RED：明确 `state/action` 无匹配提示配置；表现请求失败只提示本次未执行，不误报缺素材；日常无匹配静默；“表现开心一点”不要求固定名称 Gate 才能进入明确播放。
- [x] GREEN：所有运动入口进入同一准备／提交方法，删八秒 idle 降级和错误回合启动位移分支。应用精确动作前停掉不兼容位移；不按作者名称写分支。
- [x] GREEN：复用已匹配活动候选，后台首次按需匹配与用户回合互斥；reset、模式切换、角色切换和配置变化清理当前活动准备与缺失提示去重。
- [x] 运行相关定向测试及 character-runtime/desktop typecheck；提交本任务。

## Task 5: 有限真实检查、死路径清理与交付记录

**文件：** 只修改受本计划影响的残留死路径和测试夹具；更新本规格、对应旧规格状态入口、`CONTEXT.md`、`docs/operations/2026-09-08-single-send-expression-acceptance.md`。

**验收发现的原契约缺口：** DeepSeek 的 `json_object` 请求没有传输 `responseContract.jsonSchema`，而新的表现提示未给出完整输出形状，真实明确开心／行走均形状失败。需在 `character-expression-adapter.ts` 和直接测试中复用现有 Schema 补齐模型可见约定，并明确请求目标与移动准备语义；保持本文已批准的字段、两请求、12秒边界和严格 Main 校验。Qwen 的完整形状已传输，但明确目标／活动匹配仍有真实失败，修正后仅重验相应代表场景，不增加新的协议或执行框架。

**原生申请语义补齐：** 真实讨论→同意场景中，DeepSeek 把讨论文件是否需要整理提前解释为正式任务申请，范围确认前仍保持零执行。在 `conversation-chat-adapter.ts` 的原提示和申请工具说明中区分“聊天征求同意”与“正式任务申请”，同时保留明确查询文件实际内容或承接前文同意时的申请能力；不恢复正则分流或增加第二分类器。修正后仅复验失败的 DeepSeek 代表场景，保留 Qwen 既有通过事实。

- [x] 搜索旧联合 JSON、explicit submit 和 router 的正式引用，逐个确认已无调用再清理；不批量删除用户数据或无关文件。
- [x] 使用同一发送入口完成 DeepSeek／Qwen 的问候、自然读取、讨论→同意→读取；真实工具只在授权的隔离测试目录读取可核对标记。
- [x] 使用自定义描述和任意 ID，检查明确开心、行走、停止后剩余心情；无行走素材时保持位置并提示。优先一次代表场景，不跑旧44项重复矩阵。
- [x] 程序观测与原生视觉分别记录；无法可靠操控或观察时写明未验证，不用单元测试代替。
- [x] 定向 GREEN 后按根 package.json 运行受影响门禁并合并等价重复覆盖；保留真实失败与取消／权限检查，15分钟无结果转为较小 seam。
- [x] 独立复核本计划范围的规格与代码质量；确认 `git diff --check`、模块边界、进程清理、没有依赖／网站改动。
- [x] 提交验收文档，说明通过范围、真实未验证项和启动步骤。只提交不推送、不打包。

执行记录：五项实施与任务复核已完成，收尾实现提交 `75ea43cb`；整体复核发现的移动活动优先级和明确无匹配提示已在 `ee068811` 修正，定向复审通过，无剩余 Critical／Important。另一个当前正式转换无法生成的内部输入兼容边界作为 Minor 记录。以上勾选表示执行和记录步骤完成，不表示所有门禁通过：真实 Renderer 与原生移动同步待人工确认，反馈拒绝尚未归因，广跑中的旧夹具失败和未执行范围继续保留。事实以[有限验收记录](../../operations/2026-09-08-single-send-expression-acceptance.md)为准。
