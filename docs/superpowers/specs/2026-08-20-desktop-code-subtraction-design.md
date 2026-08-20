# AI Pet 桌面架构优化减法收口设计

> 文档状态：当前代码 `957ec00` 的 `verify:desktop` 单元阶段仍有一次既有 5 秒超时；测试与 E2E 总门为净增 `662` 行，仍未满足，不得宣称全局减法完成
> 日期：2026-08-20
> 上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 适用范围：A1/A2/A3/B1 已实现内容的减法收口，以及 B2/B3 的实施约束

在本规格明确列出的减法范围内，本规格覆盖 2026-08-15 的 A2/A3/B1 接口形状，以及 B2“必须新建独立 Journal”和 B3“必须新增 Actions getter”的旧计划表述；未明确变更的安全不变量、磁盘格式和验收要求继续有效。

## 1. 背景与裁决

以本轮优化开始前的 `b686eca` 为基线，到 B1 修复提交 `c7d951d`：

- 桌面生产代码约 `+454/-45`，净增 409 行；
- 测试与 E2E 约 `+2259/-531`，净增 1728 行；
- 网站、CloudBase 与 package scanner 业务路径零差异。

安全边界已经增强，旧 MCP E2E、四窗口 `taskEvent` 广播、无授权 Agent IPC 入口和 Store 旧全量恢复调度也已删除，但新增速度仍显著高于删除速度。用户据此确立最高原则：**能不加就不加，能减则减；新增安全能力时必须同步删除无用、重复或已被替代的旧代码。**

用户已于 2026-08-20 二次批准本规格第 5 节列出的较大删除范围。

## 2. 目标

1. 删除 A1/A2/A3/B1 中已经证明为浅转发、重复断言或重复场景的代码。
2. 保留真正隐藏复杂度和安全策略的深模块，不以机械追求行数破坏安全边界。
3. 把 B2/B3 从“新增一层”改为“原位替换旧 owner”；新路径通过后同任务删除旧路径。
4. 使正式运行路径、状态 owner 和维护接口数量不增加；测试按接口分层，避免同一矩阵在纯模块、Store 和 E2E 重复三遍。

## 3. 非目标

- 不删除已批准的 sender 授权、事件隐私投影、角色恢复预算、marker 字节保留或 fail-closed 行为。
- 不为了净行数减少而合并安全职责、降低 Schema 严格性、取消真实 Windows/Electron 证据或放宽测试超时。
- 不修改网站、CloudBase、package scanner 或网站 E2E。
- 不批量清理与本轮优化无关的历史代码。
- 不删除有真实当前消费者或磁盘兼容 inventory 证明仍需要的兼容路径。

## 4. 减法决策规则

每个任务按以下优先级选择方案：

1. 能删除旧代码解决时，直接删除。
2. 能修改现有模块解决时，不新增模块。
3. 能复用现有接口解决时，不新增接口。
4. 只有安全不变量无法自然放入现有 owner 时，才新增深模块；同任务必须删除旧 owner、旧入口和只服务旧实现的测试。

每个拟新增模块必须通过 deletion test：删除它后，复杂度会重新散落到多个调用点，才说明它提供了深度；如果复杂度只回到一个调用点或直接消失，该模块默认不建立。

测试采用 replace-don't-layer：纯模块测试算法，Store/IPC 测真实边界，E2E 测跨进程业务结果。同一不变量只在最能证明它的一层做完整矩阵；其他层保留一项纵向证据。

行数只作为预警指标，不作为安全裁决。完成门以“单一正式运行路径、单一 owner、旧符号零引用、必要行为证据仍在”为准。

## 5. 已批准的立即删除与收敛范围

### 5.1 A2 sender 授权去浅层

删除：

- `apps/desktop/src/main/ipc/agent-ipc-authorization.ts`
- `apps/desktop/tests/agent-ipc-authorization.test.ts`

把当前 chat getter 直接作为 `registerAgentIpc()` 的第三个依赖。授权判断在 `register-ipc.ts` 内集中实现一次，六个 mutating handler 继续在解析敏感参数和调用服务之前执行同一判断。

必须保留的行为证据：无当前 chat、已销毁 chat、非当前 sender、窗口替换、六个通道、授权先于解析、真实跨窗口已知 actionId 攻击失败。删除类不等于删除安全策略。

删除 `main-lifecycle.test.ts` 与 `window-security.test.ts` 中重复的 Main wiring 字符串断言，只保留一处真正保护装配的静态断言；行为由 `agent-ipc.test.ts` 和 Electron E2E 负责。

### 5.2 A1 浅配置测试合并

把 `apps/desktop/tests/vitest-worker-cap.test.ts` 的 `maxWorkers: 4` 断言并入现有 Desktop 验证配置契约测试，随后删除该文件。不得删除 `maxWorkers: 4` 配置或 worker 活性行为测试。

### 5.3 A2/A3 重复 Electron 场景合并

把 `tests/e2e/desktop.spec.ts` 中：

- `只有当前聊天窗口能使用已知 actionId 确认文件动作`

的非 chat sender 拒绝、磁盘无副作用和 chat 最终确认断言，合入：

- `会话任务事件只向 chat 完整投递并向 pet 投递 phase`

删除第二套窗口发现、Provider 配置、fixture 初始化和重复聊天流程。合并后必须独立证明两道防线：非 chat 即使知道 actionId 也不能执行；非 chat 同时收不到完整票据。

### 5.4 A3 测试按接口收敛

`conversation-event-projection.test.ts` 保留：

- 一个完整非 phase 事件只进 chat；
- 一个 phase 同时进入 chat 和 pet，pet 只有严格 `{type, phase}`；
- 无效 Schema 输入零副作用；
- destroyed/send/reporter 失败按目标隔离。

完整 TaskEvent variant 严格性继续由 `packages/shared-types` 的 Schema 契约拥有。删除仅重复验证 variant 枚举、而不增加投影行为证据的样本构造和断言。

### 5.5 B1 重复状态与测试收敛

`CharacterTransactionRecoveryResult` 只保留：

```ts
type CharacterTransactionRecoveryResult = Readonly<{
  characterId: string;
  draftErrorCode:
    | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
  publishErrorCode:
    | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
}>;
```

删除可由两个分面码唯一推导的 `kind` 和 `deferred`，并删除可由报告中是否存在 `CHARACTER_RECOVERY_DEFERRED` 推导的 `budgetExceeded`。能力门仍只读取相应分面码。

协调器测试完整拥有分面、活动优先、256 和 2000ms 算法边界；Store 测试只保留真实坏 marker 字节、V1 只读投影、能力门、活动角色纵向优先、deferred 文件不触碰、Junction/权限和 report 原子发布。删除纯算法在 Store 层的重复排列组合。

## 6. 必须保留的深模块

### 6.1 `ConversationEventProjection`

该模块以一个 `publish()` 接口隐藏 Schema 验证、Main 行为消费、chat 完整投递、pet phase 投影、销毁检查和单目标失败隔离。删除后策略会整体回流 `main/index.ts` 并重新扩大泄漏风险，因此保留。

### 6.2 `CharacterTransactionRecovery`

该模块隐藏活动角色优先、数量/时间预算、逐分面失败隔离、fail-closed 结果和多个 Store 操作的能力门。删除后复杂度会回流至少保存、发布、启用和多个 runtime 读取入口，因此保留；仅删除重复结果字段和重复测试。

## 7. B2 实施约束：新增必须替换旧 owner

B2 先只增加真正通用且现有代码没有的 exclusive hard-link publish 原语。`atomicWriteText()` 的 replacement 语义保持不变。

Import journal 的首选方案是修改现有 `CharacterPackageService` 私有实现并删除旧 marker owner。只有预实施 deletion test 证明 durable publish、逐 marker 隔离、证据保留和所有权恢复无法在现有模块内保持清晰时，才允许建立内部深模块 `CharacterImportJournal`。

若建立该模块，必须在同一任务删除 `CharacterPackageService` 中的：

- import marker schemas 与 regexp；
- `writePendingImport()`；
- `recoverPendingRollbacks()`；
- `preserveRollback()`；
- v1/v2 缺少当前 owner token 仍可能删除目录的旧分支；
- 只服务旧 marker owner 的 helper 和测试。

正式运行时只能存在一个 import journal schema、一个 create/complete/recover owner 和一条启动恢复路径。不得为了测试把 I/O fault seam 扩散为公开产品接口。

## 8. B3 实施约束：原位扩展现有快照链

B3 不新增 `CharacterActions.getCharacterRecoverySnapshot()` 浅转发。原位扩展现有 recovery snapshot Schema、现有 `registerCharacterIpc()` 注册参数位置、现有 Preload 方法和现有 Renderer loader；启动快照已经固定，因此直接注入不可变值，不保留 getter/callback。

公开 issue 最小化为：

```ts
type CharacterRecoveryIssueDto = Readonly<{
  characterId: string;
  errorCode: CharacterRecoveryPublicErrorCode;
}>;

type CharacterRecoverySnapshotDto = Readonly<{
  fallbackErrorCode: string | null;
  issues: readonly CharacterRecoveryIssueDto[];
}>;
```

删除 `fallbackActive`；其真假由 `fallbackErrorCode !== null` 唯一表达。`affectedCapabilities` 和 `suggestion` 不跨 IPC 传输，由现有 `character-recovery.ts` 根据稳定 error code 映射，避免三份可互相矛盾的状态。

新结构化快照贯通后，同任务删除 `startupRecoveryErrorCode` 标量、旧 `{errorCode}` Schema、旧 callback 形状和只服务单错误横幅的测试，不保留双轨兼容。

B3 E2E 最多保留两个重启场景：非活动 Store 坏 marker 与 Package 多 marker 隔离可合并；活动 publish fallback 与聊天独立保留一个。细分矩阵属于 Store/Package 接口测试。

## 9. 验收与停止条件

每个减法任务必须记录：

- 删除的文件、符号和运行路径；
- 新增与删除的生产代码、测试代码行数；
- 新接口替代的旧接口；
- `rg` 证明旧 owner 零正式引用；
- 定向测试与适用门禁的真实结果；
- 网站、CloudBase、scanner 零差异。

出现下列任一情况立即停止，不以补更多层解决：

- 为删除浅模块而复制安全判断到多个调用者；
- 新旧 owner 同时存在；
- 新状态可从已有状态完全推导却仍被持久化或跨 IPC 传输；
- 测试只能通过新增源码字符串断言证明；
- 单点排障或命令超过 15 分钟仍未收敛。

完成本规格后，生产代码不要求机械净负数，但正式运行路径和 owner 数量必须减少；测试总量应相对 `c7d951d` 净减少，并保持 `verify:desktop`、`verify:behavior`、`verify:characters` 所需安全证据。

## 10. 恢复方式

所有删除按小任务独立提交，可由 Git 单提交恢复。不得使用破坏性 reset 或批量清理；不得删除用户未授权范围或未列入本规格的文件。

## 11. 2026-08-20 Task 6 最终门禁记录

按 Task 6 简报串行执行且未放宽超时。`pnpm.cmd --filter @myself/desktop typecheck`、`pnpm.cmd --filter @myself/desktop test`（85 个文件、1741 项通过、14 项跳过）、`pnpm.cmd test:security`（20/20）和 `pnpm.cmd test:integration`（46/46）均退出 0。`pnpm.cmd verify:behavior` 与 `pnpm.cmd verify:characters` 均退出 0，各自的 Electron E2E 为 60/60。

`pnpm.cmd verify:desktop` 一次退出 1：其 workspace typecheck、108 个单元文件 2178 项、security 20/20 和 integration 46/46 均通过，但 Electron E2E 在“默认聊天与设置浮层提示”关闭设置时出现页面或上下文已关闭，最终 59/60。该历史失败保留。该场景一次构建后定向复现为 1/1（11.3 秒），`verify:behavior` 与 `verify:characters` 的完整 Electron E2E 均为 60/60。只读诊断显示减法没有触及窗口 owner、Electron fixture 或失败场景主体；页面/上下文关闭的细根因尚未证实。没有命令达到 15 分钟。

旧 owner 扫描无输出（`rg` 退出码 1，表示零命中）；受保护路径在 `875048c..HEAD` 零差异；`git diff --check 875048c..HEAD` 退出 0、无输出。相对 `875048c`，生产代码 +42/-74（净 -32），Desktop 测试 +193/-522（净 -329），E2E +37/-147（净 -110）；相对 `c7d951d`，测试与 E2E 合计 +230/-669（净 -439）。

主裁决采用上述等价证据放行：本规格达到“自动化完成”状态。B2/B3 仍不得直接按旧计划执行，必须先按本减法规格重写计划并再次审查删除门；一次性 E2E 波动作为 concern 保留。真实 Windows 人工项继续保持待用户确认。

## 12. 2026-08-21 Task 6 新鲜门禁与状态裁决（`035fd96`）

本节只更新实测账本和状态，不改变第 5 至 8 节的安全门。此前 `c715f13` 的全绿结果只保留为历史证据，不能替代本节的新基线结果。

在 `035fd96` 上，定向聚合（8 文件、182 项，39.11 秒）、Desktop typecheck（10.39 秒）、Desktop test（86 文件、1808 通过、14 跳过，54.18 秒）、security（20/20，2.70 秒）、integration（46/46，6.13 秒）和 `verify:characters`（runtime 221、assets 92、Desktop 1808/14、security 20/20、integration 46/46、Electron E2E 62/62，335.74 秒）均退出 0。所有命令均在 15 分钟硬上限内结束。

`verify:desktop` 唯一执行一次并退出 1（73.15 秒）：workspace typecheck 已通过，unit 为 108 文件通过、1 文件失败，2252 通过、1 失败、14 跳过；因此该脚本的 security、integration 与 Electron 阶段未执行。失败用例为 `draft-character-preview.test.tsx` 的“场景播放帧回写父级，纯索引同步不重建且后续控制从实际帧继续”：`showAction` 期望 2 次、实际 3 次。按一次失败定向复现约束，同一用例随后单独运行退出 0，1/1 通过、3.50 秒；这不能把原完整门禁改写为通过，也未触发完整重跑。

相对 `c7d951d`，`apps/desktop/tests` 为 `+1661/-822`（净 `+839`），`tests/e2e` 为 `+297/-313`（净 `-16`），合计 `+1958/-1135`（净 `+823`）。**行数门未满足，不得宣称全局减法完成。**本轮没有新鲜的“安全减法已耗尽”owner 审计，亦不作该项宣称；后续仅可在保留唯一安全证据的前提下继续收敛。

生产旧符号 `startupRecoveryErrorCode`、`loadCharacterStartupRecovery`、`fallbackActive`、`CharacterActions.*getCharacterRecoverySnapshot` 和 `export { characterRecoveryMessage }` 均为零命中；`fallbackActive` 仅在 `character-ipc.test.ts:48` 的严格 Schema 负例保留 1 个命中。Workshop StrictMode 单请求、RPC 失败通用文案与路径/token 脱敏、Pet RPC 失败不伪造完成 fallback 均仍有定向聚合证据。网站、CloudBase、scanner 与网站 E2E/配置保护路径在已提交、工作树和暂存区均为零差异，三项 `git diff --check` 均退出 0。

Task 5 fix round 2 已由主任务独立复审通过，清除了此前局部 Renderer 页面发现闭包与全局 helper 重复的 Important；本次规格自核未发现新的 replace-don't-layer、旧路径残留或保护路径偏离。真实 Windows 窗口层级、焦点、布局、文案可读性、重启视觉和拖拽体验仍待用户人工确认。

## 13. 2026-08-21 第二轮测试表达减法状态（`957ec00`）

第二轮只在既有测试 owner 内做替换式收敛：非空 Electron fixture loader 替代 58 个调用点的 nullable 表达，启动入口复用既有依赖 factory，Main/Preload 删除同 seam 的重复 Schema 样例，包恢复测试复用既有证据读取 helper。没有新增生产 seam、共享测试框架、依赖或第二条运行路径。相对实施基线 `a11f59f`，五个任务文件 `+22/-183`，净减 `161` 行；四项 mutation 分别证明模块装载失败直接抛出、最终 load 第二次读取、Main/Preload 双边界解析和证据发布先于 marker 完成仍由保留测试拥有，恢复后生产文件零差异。四个任务的独立复审均为 C0/I0/M0。

最终代码定向聚合 140/140、shared-types 31/31、Desktop typecheck、Desktop test（1807 通过、14 跳过）、security 20/20、integration 46/46 均通过。`verify:characters` 退出 0，含 character-runtime 221/221、character-assets 92/92、上述 Desktop/security/integration 结果和 Electron E2E 62/62。`verify:desktop` 唯一执行一次并在 unit 阶段退出 1：108 文件通过、1 文件失败，2251 项通过、1 项失败、14 项跳过；失败为既有官方默认角色损坏索引恢复用例达到 5000ms，随后唯一一次定向复现 1/1 约 1.06 秒通过。该定向结果不把完整门改写为通过；第 12 节第一轮的另一项并行波动也继续作为历史事实保留。所有顶层命令均低于 15 分钟硬上限。

Task 5 最终阶段没有把 build、完整 Desktop E2E 和 `--list` 再各自作为独立顶层命令重复执行。对应证据来自 Task 1 在提交 `14ae339` 的同一 `tests/e2e/desktop.spec.ts` 最终实现上执行的恢复后 build 通过、完整 E2E 62/62 与清单 62 项；Tasks 2–4 未再修改 E2E 文件。最终 `957ec00` 上的 `verify:characters` 又通过脚本内嵌 build 与完整 E2E 62/62 覆盖了最终代码。这里不把脚本内嵌步骤或 Task 1 历史命令伪称为 Task 5 单独执行的顶层命令。

相对 `c7d951d`，`apps/desktop/tests` 为 `+1648/-825`（净 `+823`），`tests/e2e` 为 `+308/-469`（净 `-161`），合计 `+1956/-1294`（净 `+662`）。**第二轮安全表达减法完成，但测试行数总门仍未满足，不能宣称全局减法完成。**剩余正值仍由角色包导入与恢复安全矩阵、启动恢复顺序和失败矩阵、Main/Preload 双边界、Pet/Workshop 异步与脱敏边界、Electron 生命周期与窗口交互、两条真实角色恢复重启 E2E 以及本规格既有唯一 owner 承担；本轮没有证明“安全减法已耗尽”，不得据此删除这些 owner。

旧生产符号扫描为零命中；58 个 loader 调用点、可选 `restart` 业务守卫、最终 load 重试、完整共享 Schema 矩阵、Preload 代表非法值、两份证据原字节断言和三类证据发布失败 owner 均保留。受保护网站、CloudBase、scanner 与网站 E2E/配置路径在提交历史、工作树和暂存区零差异，三项 diff-check 无输出。真实 Windows 人工验收项继续保持待用户确认。
