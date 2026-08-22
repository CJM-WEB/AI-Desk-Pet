# Task 3 实施报告：复用现有引擎的 Main Director

## 范围

- 新增公开行为清单与目标解析器，把模型可见语义、状态名称、动作名称和标签解析为 Main 私有目标。
- 给既有动作选择器、行为引擎和行为服务增加窄的定向授权接口；继续复用原状态、硬约束、冷却、重复抑制、调度器和播放令牌。
- 新增 Main Director，负责来源优先级、generation、停止锁、可信任务阶段与聊天计划的 success 令牌排队。
- 仅定义 `ConversationBehaviorContext`、`ConversationBehaviorPort`、显式指令和对象化运动接口；真实上下文填充、运动执行和生产接线留给 Task 4。
- 未改 Provider、文件、PowerShell、MCP 或生产组合根，未启动 Electron/GUI，未新增依赖。

## RED 证据

首次运行 Task 3 两组定向测试：

```powershell
pnpm.cmd exec vitest run --project character-runtime packages/character-runtime/tests/behavior-target-resolver.test.ts packages/character-runtime/tests/character-behavior-engine.test.ts packages/character-runtime/tests/behavior-action-selector.test.ts
pnpm.cmd exec vitest run --project desktop apps/desktop/tests/character-behavior-director.test.ts apps/desktop/tests/character-behavior-service.test.ts
```

结果均为退出码 1。character-runtime 新增 15 项按预期失败，原因是公开解析器、定向选择器和 `dispatchDirected()` 尚不存在；既有 42 项通过。desktop 新增 Director 测试因模块不存在而失败，Service 新增 2 项因窄接口不存在而失败；既有 45 项通过。

自查修复继续遵循 TDD：

1. “旧 thinking 令牌后 success 无动作”回归测试先以退出码 1 失败，证明旧可信来源会阻塞聊天计划。
2. “定向动作缺少当前皮肤精确表现”回归测试先以退出码 1 失败，证明普通默认状态表现可能被误作定向成功。

## GREEN 实现

- `createPublicBehaviorCatalog()` 只公开当前皮肤有精确表现的标准语义、`agentInferable` 状态名称、动作名称和标签，不返回 stateId/actionId。
- `resolveBehaviorTarget()` 使用 NFKC、去首尾空白和大小写折叠；未知、歧义、不可推断或无当前皮肤表现统一抛出 `CHARACTER_ACTION_UNAVAILABLE`。
- `selectDirectedCharacterBehaviorAction()` 对私有目标继续执行当前状态约束、方向、冷却、重复抑制和当前皮肤精确表现检查，不走默认 idle 冒充路径。
- `CharacterBehaviorEngine.dispatchDirected()` 复用同一个选择与 `reduceCharacterActionSchedule()` 调度路径，不复制状态或 schedule。
- `CharacterBehaviorService` 新增公开清单、私有解析和同步定向授权；返回真实 actionId、playbackToken 与标准 semantic，Renderer 事件仍只由既有 `publish()` 发布。
- `CharacterBehaviorDirector` 固定优先级为“关闭/停止锁 → 明确指令 → 可信任务/拖拽 → 聊天 → 反思 → 本地待机”；明确/聊天动作不可用发布稳定提示，低优先级来源静默跳过。
- 聊天计划先保存；可信 success 有动作时绑定其 playbackToken，并在 completed/interrupted/failed 后提交；success 无动作时立即提交。旧 generation、角色切换、reset 与 close 均清理待提交状态。
- 新可信任务阶段会释放旧阶段来源占用，避免旧 thinking 令牌阻塞 success 无动作后的聊天计划。

## 验证

- character-runtime 定向测试：3 个文件，58/58 通过。
- desktop 定向测试：2 个文件，59/59 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 0。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 0。
- `git diff --check`：退出码 0。

## 自查结论与后续

- 未发现现有接口冲突；原搬运、任务阶段、V1 fallback、播放反馈和运动语义用例均保留并通过。
- Director 没有保存第二份角色状态、动作调度或窗口位置，只保存仲裁所需的来源、运行事实、generation、停止锁、待提交计划和令牌。
- Task 4 仍需填充真实 `ConversationBehaviorContext`、实现显式移动指令和对象化运动端口，并完成生产接线。
- 真实 Electron/GUI 按总计划在后续任务与最终门禁统一验收；本任务未执行 GUI。
