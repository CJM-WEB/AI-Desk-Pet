# 行为导演与自主生命感 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`；每个任务使用 `test-driven-development`。

**Goal:** 让同一次聊天生成自然回复和受限行为计划，使 Prompt 能可靠驱动标准/自定义动作与真实移动，并实现可持久停止锁和三档主动性。

**Architecture:** Provider 的行为结果是无工具响应协议；`CharacterBehaviorDirector` 在 Main 中融合本地显式指令、可信运行状态、模型建议、主动性和角色清单，只有通过本地解析与行为引擎授权的动作才能播放或移动。

**Tech Stack:** TypeScript、Zod、character-runtime、agent-core、Electron、React、Vitest、Playwright。

## Task B1：定义无权限行为计划协议

**Files:**

- Create: `packages/character-runtime/src/character-behavior-plan.ts`
- Create: `packages/character-runtime/tests/character-behavior-plan.test.ts`
- Modify: `packages/character-runtime/src/index.ts`
- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/tests/agent-loop.test.ts`

```ts
type CharacterBehaviorPlan =
  | { kind: 'none'; emotion?: CharacterEmotionLabel }
  | { kind: 'play'; target: BehaviorTarget; emotion?: CharacterEmotionLabel }
  | { kind: 'move'; direction: MoveDirection; distance: MoveDistance }
  | { kind: 'move_region'; region: ScreenRegion }
  | { kind: 'stop_movement' }
  | { kind: 'resume_movement' };
```

- [ ] RED：严格拒绝 actionId、绝对坐标、工具名、额外字段和未知枚举；允许标准语义以及当前角色名称/标签引用。
- [ ] GREEN：导出严格 Zod schema 和冻结类型；增加 `ModelRequest.responseContract` 与 `ModelResponse.structured_output`，明确它不是 ToolDefinition，不能进入 ToolRuntime。
- [ ] 运行 `pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/character-behavior-plan.test.ts` 和 agent-core contracts；提交 `feat: 定义无权限角色行为计划`。

## Task B2：同一次聊天返回正文与行为

**Files:**

- Modify: `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
- Modify: `apps/desktop/tests/conversation-chat-adapter.test.ts`
- Modify: `apps/desktop/src/main/providers/openai-provider.ts`
- Modify: `apps/desktop/src/main/providers/anthropic-provider.ts`
- Modify: `apps/desktop/src/main/providers/gemini-provider.ts`
- Modify: `apps/desktop/tests/provider-contract.test.ts`
- Modify: `apps/desktop/tests/openai-provider.test.ts`
- Modify: `apps/desktop/tests/provider-contract.test.ts`

```ts
type ConversationBehaviorContext = Readonly<{
  character: PublicBehaviorCatalog;
  runtime: { moving: boolean; dragging: boolean; carrying: boolean; movementStopped: boolean };
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  recentActions: readonly string[];
}>;
```

- [ ] RED：OpenAI-compatible、Anthropic、Gemini 将“回复+行为”序列化为各自原生结构化响应；请求仍为单次调用且 tools 为空。
- [ ] RED：Provider 忽略 contract 返回纯文本时聊天仍成功；结构非法时只丢弃行为，不丢正文、不显示 JSON。
- [ ] GREEN：Adapter 返回 `{ text, emotion?, behaviorPlan? }`；移除对非标准 `message.metadata.behaviorIntent` 的生产依赖，迁移后静态检索旧路径无命中。
- [ ] 运行 Provider contract + ChatAdapter 定向测试；提交 `feat: 同次聊天生成受限行为计划`。

## Task B3：建立 Main 行为导演和清单解析

**Files:**

- Create: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Create: `apps/desktop/tests/character-behavior-director.test.ts`
- Create: `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- Create: `apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- Modify: `apps/desktop/src/main/characters/character-behavior-service.ts`
- Modify: `apps/desktop/tests/character-behavior-service.test.ts`
- Modify: `packages/character-runtime/src/character-behavior-engine.ts`
- Modify: runtime engine/selector tests

**Output:** `CharacterDirectedBehavior = play(validatedAction) | motion(restrictedIntent) | none | capabilityError`。

- [ ] RED：按动作名称、状态名称、标签和标准语义解析当前角色；未知/歧义目标返回 `CHARACTER_ACTION_UNAVAILABLE`，不能退回 idle 假装执行。
- [ ] RED：优先级固定为安全/停止锁 → 用户明确指令 → 任务/拖拽状态 → 聊天计划 → 反思 → 本地 idle。
- [ ] RED：普通聊天结束的可信 success 动作不能永久吞掉本轮聊天计划；Director 持有待提交计划，等 success 播放终态或确认无可播放 success 后再提交。播放反馈先回 Director，再由其委托 BehaviorService 并释放队列。
- [ ] GREEN：Director 只输出已验证 actionId；BehaviorService 仍通过引擎状态条件、表现可用性、冷却和 playback token 授权，不增加直接播放旁路。
- [ ] 运行 director、service、engine、selector 定向测试；提交 `feat: 增加可信角色行为导演`。

## Task B4：显式停止、恢复和受限空间移动

**Files:**

- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/src/shared/character-motion-ipc.ts`
- Modify: `apps/desktop/src/main/conversation/conversation-coordinator.ts`
- Modify: `apps/desktop/tests/character-behavior-director.test.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Modify: `apps/desktop/tests/character-behavior-service.test.ts`
- Modify: `apps/desktop/tests/conversation-coordinator.test.ts`

- [ ] RED：中英文“停下/别走了/恢复活动/向左一点/去右下角/走一走”由本地规则稳定识别；关于这些词的讨论不执行。
- [ ] RED：“别移动这个文件”属于文件操作否定/讨论，不能触发桌宠停止；显式行为 Gate 不读取文件或 Shell 权限。
- [ ] RED：停止锁仅禁止空间移动和自主活动；listening/thinking/speaking/success/error 等聊天原地动作继续。
- [ ] RED：move 动作未取得播放授权时窗口不动且发布稳定能力提示；授权成功后才发 `wander|relative|region|return-visible`，永不接受绝对坐标。
- [ ] GREEN：按当前可见角色尺寸换算 near/medium/far，并把目标限制到当前/指定显示器安全区域。
- [ ] 运行 Coordinator、Director、Motion、BehaviorService 定向测试；提交 `feat: 让提示词可靠驱动桌宠移动`。

## Task B5：持久停止锁和新用户默认主动性

**Files:**

- Modify: `apps/desktop/src/main/storage/settings-store.ts`
- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Modify: `apps/desktop/tests/desktop-settings-service.test.ts`
- Modify: `apps/desktop/src/renderer/src/settings/PrivacySettings.tsx`
- Modify: `apps/desktop/tests/settings-store.test.ts`
- Modify: `apps/desktop/tests/desktop-settings-service.test.ts`
- Modify: `apps/desktop/tests/privacy-and-proactivity.test.ts`

- [ ] RED：新安装默认 `autonomous`；现有 v2 明确档位不覆盖；缺失 `movementStopped` 迁移为 false；明确停止后重启仍 true，恢复后 false。
- [ ] GREEN：Settings schema 新增 `movementStopped`；runtimeSupport 将 proactivity 标为已接入；复用现有三档控件，不新增重复设置入口。
- [ ] 保存失败不得让内存状态假成功；设置变更触发 Director 原子更新；提交 `feat: 持久桌宠停止锁与主动性`。

## Task B6：主动性调度与低频无权限反思

**Files:**

- Modify: `apps/desktop/src/main/characters/character-behavior-director.ts`
- Create: `apps/desktop/src/main/characters/character-proactivity-scheduler.ts`
- Create: `apps/desktop/tests/character-proactivity-scheduler.test.ts`
- Create: `apps/desktop/src/main/characters/behavior-reflection-adapter.ts`
- Create: `apps/desktop/tests/behavior-reflection-adapter.test.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Coordinator port:**

```ts
interface ConversationBehaviorPort {
  prepareUserPrompt(text: string): Promise<{ explicitDirective: ExplicitBehaviorDirective | null }>;
  getChatContext(): ConversationBehaviorContext;
  completeUserPrompt(input: { explicitDirective: ExplicitBehaviorDirective | null; providerPlan: CharacterBehaviorPlan | null }): void;
}
```

- [ ] 用可控时钟写 RED：passive 无自主；assistive 每次随机 20–60 秒后只做本地原地动作；autonomous 的本地原地动作或短距离走动也严格每次随机 20–60 秒，另在 2–5 分钟后一次反思；边界值 20/60 秒、2/5 分钟和同一动作不连续重复均覆盖。
- [ ] RED：聊天、拖拽、文件/PowerShell执行、确认等待、停止锁期间计时暂停；恢复后从剩余/新抖动周期继续，不突发补跑。
- [ ] RED：反思请求 `tools: []`、无文件/PowerShell端口、不向用户发布正文；失败静默跳过且有退避。
- [ ] GREEN：随机源和时钟由构造器注入，生产使用安全随机；close 取消所有计时器并等待在途反思失效；提交 `feat: 实现三档桌宠主动行为`。

## Task B7：组合接线与纵向验收

**Files:**

- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`

- [ ] Electron RED：标准动作、自定义动作、方向/区域移动、缺失动作提示、停止跨重启、停止后聊天动作仍播放、恢复后移动。
- [ ] `prepareUserPrompt` 在文件/PowerShell 分流前执行，使“停下并删除…”先持久停止；本地明确 stop/resume/move 在本地校验与动作授权成功后立即执行，不依赖 Provider 或任务成功。只有模型附带行为计划等待本轮回复/可信 success 动作时序；跨 Provider 披露结束后重新读取行为上下文。
- [ ] Electron RED：被动/辅助/自主差异和反思零工具；位置变化通过去标识化 delta 探针，不公开绝对坐标。
- [ ] 完成组合生命周期，确保关闭、角色切换、重置和迟到行为计划幂等；运行完整阶段门。
- [ ] 提交 `feat: 接通桌宠行为导演与自主活动`。

## 阶段命令

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop -- --grep "行为导演与自主活动"
git diff --check
git diff --name-only -- apps/website
```
