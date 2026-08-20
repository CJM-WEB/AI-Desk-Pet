# AI Pet 桌面架构优化减法收口设计

> 文档状态：待用户书面审阅
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

B3 不新增 `CharacterActions.getCharacterRecoverySnapshot()` 浅转发。原位扩展现有 recovery snapshot Schema、现有 `registerCharacterIpc()` callback、现有 Preload 方法和现有 Renderer loader。

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
