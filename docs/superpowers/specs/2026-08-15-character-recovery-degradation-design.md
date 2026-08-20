# AI Pet 角色恢复公开反馈与降级设计

> 文档状态：已批准（用户于 2026-08-20 确认采用原位深化方案，并授权自主复审后执行）
> 日期：2026-08-15；2026-08-20 按减法原则原位重写
> 上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 覆盖关系：[桌面架构优化减法收口设计](./2026-08-20-desktop-code-subtraction-design.md)覆盖本文旧版“新增 Actions getter”和跨 IPC 派生字段设计；本文已按该裁决重写
> 前置规格：[角色 Store 事务分面恢复设计](./2026-08-15-character-transaction-recovery-design.md)、[角色包导入 Journal 设计](./2026-08-15-character-import-journal-design.md)
> 对应阶段：B3 恢复体验与降级

## 1. 背景与问题

正常的角色导入、切换和播放链已经可用，B3 不重做这些业务。需要处理的是异常恢复后的公开反馈：B1 已能区分每个角色的草稿与发布恢复结果，B2 会返回每个角色的导入恢复问题，而当前启动链只保存一个 `startupRecoveryErrorCode`。这个标量不能准确表达非活动角色问题、同一角色的多个问题，也不能让角色工作室只显示当前所选角色的结果。

本规格把 B1/B2 的 Main 内部结果收敛成一份最小、不可变的启动快照。活动角色确实无法运行时才切换官方默认角色；非活动角色故障只留给角色工作室处理；无论角色恢复结果如何，普通聊天都继续独立启动和使用。

## 2. 目标

1. 在现有 `character-startup` 启动裁决中汇总 B1、B2 与活动角色运行校验，不新增第二个恢复 owner。
2. 沿现有 Character IPC、Preload 和 Renderer 读取链返回最小结构化快照，严格隐藏磁盘与事务细节。
3. Pet 只呈现活动角色已经发生的 fallback；角色工作室只呈现当前选中角色的问题；Chat 不读取恢复快照。
4. 新快照贯通后，同任务删除旧标量链、可推导字段和只服务旧载荷的代码与测试。

## 3. 非目标

- 不在 Renderer 修复 marker、journal 或角色文件，也不让 Renderer 决定回滚、隔离或删除。
- 不新增 `CharacterActions.getCharacterRecoverySnapshot()`；Actions 继续负责正常角色操作，不成为启动恢复的浅转发层。
- 不新增 Renderer 恢复 Store、全局恢复状态机或第二条 IPC 通道。
- 不改变 B1/B2 的磁盘恢复算法、预算、证据保留和所有权规则。
- 不改变正常角色导入、编辑、发布、切换和播放流程。
- 不自动上传角色包或恢复证据，不修改网站、CloudBase 或 package scanner。

## 4. Owner 与数据流

`character-startup.ts` 是 B3 唯一的启动裁决 owner。它接收 B2 `initialize()` 的最小问题报告、索引恢复结果、现有活动运行版本校验、B1 最终分面报告读取和官方默认角色准备依赖，完成以下工作：

1. B2 恢复完成后只执行最后一次 Store/活动 runtime load；该次 load 完成后立即读取 `CharacterStore.getTransactionRecoveryReport()`，把这一个一致性点上的 B1 每个非空分面码投影为公开 issue。不得在随后再次触发会刷新 B1 report 的 Store load；同一角色的草稿和发布均受阻时保留两个 issue，不新增 `BOTH` 派生状态。
2. 直接接收 B2 的 `{ characterId, errorCode }` 问题项，不读取 marker 路径、正文、事务令牌或哈希。
3. 对相同 `characterId + errorCode` 去重，并采用稳定顺序发布，保证测试和界面不会因文件枚举顺序抖动。
4. 将此前 `recoverCorruptIndex()` 的索引恢复结果与最后一次活动 runtime load 一并裁决 fallback，并在返回非空 `fallbackErrorCode` 前完成官方默认角色准备。非活动角色和单纯导入恢复问题不得触发 fallback。
5. 返回启动所需的内部结果与一份只读公开快照。Main 只保存这份已完成裁决的快照，后续调用只读取该快照，不重新执行恢复。

现有数据流原位深化为：

```text
B1 Store 分面报告 ─┐
B2 Package 最小报告 ├─> character-startup ─> Main 不可变快照
活动角色运行校验 ──┘                         │
                                             └─> 现有 Character IPC
                                                  └─> 现有 Preload 方法
                                                       ├─> Pet
                                                       └─> Workshop View
```

`CharacterActions` 不参与快照转发。Chat 不在该数据流中。

## 5. 最小公开契约

现有 `characterRecoverySnapshotResultSchema` 原位替换为严格 Schema。公开载荷只包含：

```ts
type CharacterRecoveryIssueErrorCode =
  | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
  | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
  | 'CHARACTER_RECOVERY_DEFERRED'
  | 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
  | 'CHARACTER_IMPORT_RECOVERY_DEFERRED';

type CharacterRecoveryFallbackErrorCode =
  | 'CHARACTER_INDEX_UNAVAILABLE'
  | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
  | 'CHARACTER_RECOVERY_DEFERRED'
  | 'CHARACTER_MANIFEST_INVALID'
  | 'CHARACTER_MIGRATION_FAILED'
  | 'CHARACTER_RESOURCE_INTEGRITY_FAILED'
  | 'CHARACTER_RESOURCE_NOT_FOUND'
  | 'CHARACTER_RUNTIME_UNAVAILABLE'
  | 'CHARACTER_VERSION_UNSUPPORTED'
  | 'CHARACTER_OPERATION_FAILED';

type CharacterRecoveryIssueDto = Readonly<{
  characterId: string;
  errorCode: CharacterRecoveryIssueErrorCode;
}>;

type CharacterRecoverySnapshotDto = Readonly<{
  fallbackErrorCode: CharacterRecoveryFallbackErrorCode | null;
  issues: readonly CharacterRecoveryIssueDto[];
}>;
```

实际 Schema 必须继续使用现有安全角色 ID 规则，并严格使用上述两个互不混用的封闭集合；不能仅接受任意字符串。Package issue 码不能进入 `fallbackErrorCode`，启动 fallback 码也不能伪装成逐角色 issue。对象与嵌套 issue 均拒绝额外字段。

契约不包含：

- `fallbackActive`：它可由 `fallbackErrorCode !== null` 唯一表达。
- `affectedCapabilities`、`suggestion`：它们是界面展示映射，不是恢复事实。
- 绝对路径、marker/journal 正文、证据文件名、事务令牌、哈希、物理磁盘身份和内部异常文本。
- 可从 `issues` 推导的计数、是否 deferred 或组合错误状态。

`fallbackErrorCode` 非空表示 Main 已决定并完成官方默认角色 fallback，而不是 Renderer 提出的切换建议。若活动角色健康，则该字段必须为 `null`，即使 `issues` 中存在非活动角色问题。

## 6. Main、IPC 与 Preload

- Main 先完成索引损坏恢复与 B2，再调用现有启动模块。启动模块执行最后一次 Store/活动 runtime load，随后读取不再被刷新的一份 B1 report；只有活动角色不可运行、活动 publish 恢复受阻/推迟或索引整体不可用时，才通过注入依赖确保官方默认角色可用并形成 fallback 快照。
- 现有 `registerCharacterIpc()` 仍负责固定通道。其旧 `() => string | null` 标量 callback 原位替换为已经完成启动裁决的只读快照值，不保留无动态行为的 callback，也不增加新 handler 或 Actions 方法。
- IPC 输入仍必须是严格空对象；输出必须经过新的严格快照 Schema。一次坏 issue 不得通过绕过 Schema 的方式进入 Renderer。
- 现有 Preload `getCharacterRecoverySnapshot()` 方法保留并更新返回类型，仍对 Main 返回值再次执行同一 Schema 校验；不暴露第二个恢复方法。
- Main 只记录稳定错误码，不记录路径、原始错误、marker 正文或令牌。恢复工具返回值仍是磁盘操作成败的唯一事实来源。

## 7. Renderer 呈现职责

### 7.1 Pet

Pet 只读取 `fallbackErrorCode`。非空时使用现有 `character-recovery.ts` 映射为中文降级说明，并表明当前已经使用官方默认角色；`issues` 中的非活动角色问题不得生成 Pet 横幅或替换当前桌宠。

旧 `loadCharacterStartupRecovery(api, applyErrorCode)` 只服务单标量载荷，新链路贯通后删除。Pet 直接消费结构化快照，不保留新旧 loader 双轨。

### 7.2 Character Workshop

角色工作室 View 通过现有 Preload 方法读取快照，只筛选 `issue.characterId === 当前选中角色 ID` 的问题并展示。恢复快照不写入 `character-workshop-store`，不与草稿编辑状态混合，也不因切换选择而重新触发 Main 恢复。

现有共享 `character-recovery.ts` 根据稳定错误码映射中文说明、受影响能力和可执行建议。`affectedCapabilities` 与 `suggestion` 只存在于这个 Renderer 展示映射中，不跨 IPC、不持久化，也不成为第二份权威状态。

### 7.3 Chat

Chat 的创建、Provider 配置、消息提交和工具状态均不读取恢复快照。B1/B2 失败、非活动角色损坏或活动角色 fallback 都不得阻断普通聊天；角色提示也不得混入聊天事件协议。

## 8. 错误与降级规则

- B1 的 `draftErrorCode` 与 `publishErrorCode` 分别映射为 issue；不合并成新的组合码。`CHARACTER_RECOVERY_DEFERRED` 在同一角色上只保留一项。
- B2 只向 B3 提供经过自身校验的最小 `{ characterId, errorCode }` 报告。无法可靠确认角色 ID 的损坏 marker 只在 Main 内隔离并记录固定错误码，不伪造公开 issue。
- 活动角色只有草稿恢复受阻、但现有 compiled runtime 仍健康时继续运行；发布恢复受阻、运行清单或资源校验失败、活动运行版本缺失，或索引整体不可用时执行 fallback。
- 非活动角色的任何 Store 或 Package 问题只进入 `issues`，不设置 `fallbackErrorCode`。
- 未知内部异常统一收敛为允许公开的稳定错误码，不回显异常正文。公开映射缺少文案时使用统一安全兜底文案，不把未知字符串原样展示。
- B1/B2 的 256 项上限和 2000ms 角色间软预算继续由各自恢复 owner 执行；B3 只投影其结果，不重复计时或调度恢复。

## 9. 替换与删除

新结构化快照通过定向测试并贯穿启动、IPC、Preload、Pet 与 Workshop 后，同一实施任务删除：

- Main 的 `startupRecoveryErrorCode` 标量及其赋值路径；
- `registerCharacterIpc()` 的旧错误码 callback 形状以及同义的快照 getter/callback；
- 旧 `{ errorCode }` recovery snapshot Schema 与 `MyselfApi` 返回类型；
- Pet 内只服务旧标量的 `loadCharacterStartupRecovery()` 及对应测试；
- 旧规格中计划新增但未实施的 `CharacterActions.getCharacterRecoverySnapshot()`；
- 任何跨 IPC 的 `fallbackActive`、`affectedCapabilities`、`suggestion` 设计或兼容别名；
- 只重复 B1/B2 错误矩阵、而不验证 IPC 或真实界面结果的测试。

仓库只保留一个启动恢复 owner、一条快照读取通道和一种公开载荷。不得保留旧标量兼容期，也不得为了测试新增公开 fault seam。

## 10. 自动化测试

按 replace-don't-layer 分配证据：

- `character-startup` 测试完整覆盖 B2 完成后最后一次 Store/runtime load、随后读取 B1 report 且不再刷新这一顺序，以及 B1/B2 报告投影、去重与稳定顺序、活动/非活动裁决、草稿受阻但健康 runtime 继续运行、发布或 runtime 受阻触发 fallback；Chat 不作为依赖。
- Character IPC 与 Preload 测试各保留一条纵向证据，证明严格空输入、最小快照返回、额外字段和非白名单错误码被拒绝。
- `character-recovery.ts` 测试公开错误码到中文说明、能力影响和建议的映射；Pet 测试只验证 fallback，Workshop View 测试只验证当前选中角色过滤且不写入 Store。
- B1/B2 的损坏 marker、预算、所有权和逐项隔离矩阵留在各自模块测试，不在 B3 重复。

真实 Electron E2E 最多保留两个重启场景：

1. 非活动 Store 坏 marker 与多个 Package marker 隔离合并为一个场景，证明健康活动角色不 fallback、工作室只显示选中角色问题且聊天可提交。
2. 活动角色 publish 或 runtime 不可用场景，证明已切换官方默认角色、Pet 显示降级提示、原始恢复证据仍保留且聊天可提交。

不得为每个错误码新增 Electron 场景。

## 11. 人工验收

在真实 Windows 10/11 环境确认：

- 非活动角色问题不会替换当前桌宠，切换角色工作室选择时只显示对应问题。
- 活动角色无法运行时确实显示官方默认角色，Pet 降级文案可读且不会遮挡正常交互。
- 角色工作室的能力说明与建议可理解，不展示绝对路径、marker 正文、令牌或内部异常。
- 角色异常期间聊天窗口可打开并提交普通消息。
- 窗口层级、焦点、提示布局和重启后的视觉结果符合预期。

没有真实窗口观察证据时，这些项目必须记录为“待用户人工确认”，不能用单元测试或 mocked Electron 结果代替。

## 12. 完成门

- 新快照的所有消费者均通过严格 Schema；旧标量符号和旧公开载荷零正式引用。
- `CharacterActions` 没有新增恢复 getter，Workshop Store 没有新增恢复状态。
- Pet、Workshop 与 Chat 的职责符合本规格，Electron E2E 不超过两个恢复场景。
- 相关 Desktop 定向测试、类型检查、`verify:desktop`、`verify:characters`、安全与集成测试按实际影响范围通过；任何失败或人工未验收项如实记录。
- `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 及网站 E2E 零差异。
- 新增代码必须对应旧标量链和重复测试的删除，正式 owner、公开接口和运行路径数量不得增加。
