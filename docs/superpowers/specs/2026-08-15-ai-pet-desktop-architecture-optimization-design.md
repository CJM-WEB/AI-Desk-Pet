# AI Pet 桌宠架构优化与恢复开发门设计

> 文档状态：已批准（用户于 2026-08-15 审阅并确认执行）
> 日期：2026-08-15
> 目标分支：`AgentCoreExtension`
> 适用范围：桌宠 AI Agent、角色系统及其桌面验证链
> 明确排除：网站、CloudBase、包扫描器及其业务代码

## 1. 文档目的

本设计整合并复核 `D:\Python\Project Optimization\1` 与 `D:\Python\Project Optimization\2` 的两套全仓审查结果，为桌宠业务建立一条可执行、可回滚、可逐项验收的架构优化路线。

本轮优化不是按文件行数拆分代码，也不是推倒现有 Electron、TypeScript 或轻量 Agent 体系。它解决三个已经影响后续开发的根因：

1. 安全和恢复不变量分散，一次修改需要同步多个实现点。
2. 部分测试越过正式接口，内部重构会引发大面积测试改写。
3. 新旧路径长期并存，形成多个 writer、状态权威和契约表示。

恢复常规功能开发不以“全部架构债务清零”为条件。先关闭高风险安全问题、补齐桌面验证闭包并保证角色恢复可靠，再恢复常规功能开发；其余结构治理继续按独立纵向规格实施。

## 2. 事实来源与证据裁决

### 2.1 当前事实来源

本设计遵循以下事实优先级：

1. 当前 `AgentCoreExtension` 代码、配置和测试入口。
2. 当前适用的产品规格、路线图与验收记录。
3. 两套外置审查中的源码证据和机器产物。
4. 审查报告中的架构推断和建议。

审查报告不能替代当前代码核验；历史验收记录不能证明当前版本通过；计划中的目标结构不能当作已实现结构。

### 2.2 两套审查材料的有效结论

当前代码已经回源确认：

- Agent 的 submit、cancel、confirm、disclosure 和 reset IPC 没有校验当前聊天窗口 sender。
- 完整 `TaskEvent` 仍会广播到 pet、chat、settings 和 character workshop 窗口。
- Desktop `tsconfig.json` 只包含 `tests/**/*.ts`，没有包含 `tests/**/*.tsx`。
- `tests/e2e/agent-mcp-flow.spec.ts` 不在当前 `test:e2e:desktop` 入口中。
- `CharacterPackageService` 的部分 rollback marker 仍直接写最终文件，并在恢复阶段直接解析 JSON。
- Store、Asset 和 Package 对角色持久化、恢复、文件身份和目录布局拥有重叠知识。

需要在各子规格中继续用 RED 测试证明的风险：

- 单个损坏 draft/publish journal 是否会阻断整个桌宠启动。
- 截断 package journal 的精确启动影响和恢复行为。
- 设置保存成功是否早于会话 reset 收敛，以及失败后的状态恢复矩阵。
- legacy compiled recovery 是否仍会触碰当前 V2 writer 拥有的数据。
- 工作室异步状态、角色组合和 V1/V2 动作权威的真实维护成本。

### 2.3 审查材料的已知限制

第一套审查材料存在以下内部不一致：

- 主报告写 56 条规则，当前 `full.json` 和最终验证记录为 63 条。
- 主报告写外置测试 6/6，实际 GREEN 与最终验证记录为 9/9。
- 主报告记录的 `full.json` SHA-256 与当前附件及最终验证记录不一致。
- 实施计划实际是 7 个审查任务，交付指南却称其包含 17 个优化 epic。
- 完整业务门禁未运行，但最终记录使用了 `READY`；该状态只能表示依赖审查工具产物可用。

因此，本设计只吸收可被当前代码或原始机器产物支持的结论，不复制旧报告的 READY 状态、哈希或优先级门。

## 3. 修改范围

### 3.1 允许修改

- `apps/desktop`
- `packages/agent-core`
- `packages/file-tools`
- `packages/shared-types`
- `packages/character-runtime`
- `packages/character-assets`
- 根级与桌宠验证直接相关的脚本、配置和桌面测试入口
- 本设计及其后续桌宠规格、计划和验收记录

`packages/shared-types` 只能修改桌宠专属契约。任何变更都不得改变网站当前使用的导出、Schema 或运行时行为。

### 3.2 禁止修改

- `apps/website` 业务代码和测试
- `apps/cloudbase-api` 业务代码和测试
- `apps/package-scanner` 业务代码和测试
- `cloudbase` 迁移与部署代码
- 投稿、审核、分页、互动、网站 UI 和云端发布链

允许只读检查上述目录是否产生差异，但不得通过“顺带修复”扩大本轮范围。

### 3.3 不在本设计范围

- 本地模型、语音、UI 自动化和视觉控制
- MCP 运行时恢复
- 新 Agent 框架、LangGraph 或多 Agent 产品运行时
- OS 级沙箱、Job Object、交互式终端和后台 Shell
- 仅因文件行数进行的拆分
- 没有真实旧数据 inventory 支撑的长期兼容框架
- 全仓 migration runner 和全仓 `verify:repo`

## 4. 总体路线

```text
阶段 A：可信基线与安全止血
  ↓
阶段 B：角色恢复可靠性
  ↓
恢复常规功能开发门
  ├─ 常规功能开发恢复
  └─ 阶段 C：高收益结构深化
       ↓
     阶段 D：旧路径删除与持续治理
```

阶段 A 和阶段 B 是恢复常规功能开发前的必做范围。阶段 C 和阶段 D 不继续冻结所有功能开发，但后续功能若触及对应模块，必须优先完成相关治理切片。

## 5. 设计原则

### 5.1 纵向替换

每个任务沿一条可观察业务流修改：用户入口、可信裁决、模块接口、实现、可观察结果和旧路径删除。禁止按 Controller、Store、Schema 或 helper 类型横向批量重写。

### 5.2 深模块

新模块必须以小接口隐藏有价值的行为和失败规则，为调用者提供杠杆并让修改保持局部性。

- 接口是调用者和测试共同使用的表面。
- 进程内纯逻辑不为测试额外创建 port。
- 只有生产与测试两个真实适配器，或两个真实实现确实存在时，才建立 port。
- 如果删除一个模块后复杂度直接消失，它是浅转发，应删除。
- 如果删除后复杂度会重新散落到多个调用者，该模块才真正提供深度。

### 5.3 替换而非叠层

新接口的行为测试稳定后，必须在同一规格的收尾任务删除：

- 被替换的 writer 或状态权威
- 旧入口和旧别名
- 重复契约与 Schema owner
- 只验证旧实现的测试
- 为永久双轨服务的兼容 wrapper

真实磁盘兼容、V1 读取转换和已批准的失败回退不按名称直接删除，必须经过独立 inventory 和退役门。

## 6. 阶段 A：可信基线与安全止血

### 6.1 A1 Desktop 验证覆盖

目标是建立桌宠专属、可证明的验证闭包，不建设全仓验证框架。

范围：

- 将 Desktop `.ts` 和 `.tsx` 测试全部纳入 TypeScript 检查。
- 为测试 rootNames 建立最小配置契约，新增或遗漏测试时稳定失败。
- 裁决 `tests/e2e/agent-mcp-flow.spec.ts` 的当前职责。
- 让所有仍有效的桌面 E2E 文件各自拥有且只拥有一个明确入口。
- 确认 `verify:desktop` 能到达批准的桌面安全、集成和 E2E 门。

MCP 裁决规则：

- 如果该 E2E 包含仍有效的禁用、安全或进程清理场景，将这些场景接入明确的桌面门。
- 如果它只验证已退役的 MCP 启用路径，将仍有价值的断言迁入 MCP 禁用契约测试，再删除孤立测试。
- 任何处理都不得恢复 MCP 运行时、Agent 工具或 Renderer 可见入口。

本阶段不创建 `VerificationCatalog`、`verify:repo` 或覆盖所有 workspace 的新框架。

### 6.2 A2 `AgentIpcAuthorization`

职责：判断一次 Agent IPC 是否来自当前有效聊天窗口。

概念接口：

```ts
assertCurrentChatSender(event): void
```

接口不缓存旧窗口身份。它在调用时动态读取当前 chat `WebContents`；窗口未注册、已销毁、被替换、发生不允许的导航或 sender 不匹配时失败关闭。

首批保护：

- `chatSubmit`
- `chatCancel`
- `actionConfirm`
- `actionCancel`
- `conversationDisclosureResolve`
- `conversationReset`

sender 校验必须发生在业务模块调用和敏感参数处理之前。非法 sender 时 service 调用次数为零。

角色、设置和桌宠交互 IPC 不套用聊天窗口 guard。它们在各自规格中按窗口职责审查，避免建立一个拥有所有窗口策略的万能授权器。

### 6.3 A3 `ConversationEventProjection`

职责：从权威 `TaskEvent` 产生按窗口裁剪的公开展示投影。

- chat：接收完整、经过运行时 Schema 验证的公开任务事件。
- pet：只接收角色行为所需的最小 phase、成功或失败投影。
- settings 和 character workshop：不接收会话任务事件。

pet 投影不得包含：

- `actionId`
- PowerShell 命令
- 文件正文或预览
- 历史披露请求票据
- 绝对路径、Provider 私有信息或 continuation

该模块不拥有会话状态、Agent continuation、确认对象或文件事务。阶段 A 只完成事件隔离；聊天 reload 的 snapshot/revision 是后续可选规格，不能借本阶段建立第二套会话状态机。

### 6.4 Agent IPC 数据流

```text
Renderer 调用
  → Preload 固定方法
  → Main IPC handler
  → AgentIpcAuthorization
  → 严格 Schema
  → ConversationCoordinator / AgentService
  → 权威 TaskEvent
  → ConversationEventProjection
      ├─ chat：完整公开事件
      ├─ pet：最小行为投影
      └─ settings/workshop：不投递
```

### 6.5 阶段 A 失败边界

- 旧 chat、pet、settings、workshop 和已销毁 chat sender 均拒绝。
- 当前 chat 正常工作。
- 已知 `actionId` 不能帮助非 chat 窗口确认或取消动作。
- 拒绝日志不记录完整 `actionId`、命令、正文或路径。
- 当前 chat Renderer 本身被完全攻陷不属于本阶段承诺；本阶段解决跨窗口权限扩大。
- 文件和 PowerShell 的 verified action、generation、TTL、确认和真实结果事实源保持不变。

## 7. 阶段 B：角色恢复可靠性

### 7.1 B1 `CharacterTransactionRecovery`

职责：隔离 `CharacterStore` 的 draft 和 publish 恢复结果。

每个角色返回分面结果：

```text
Healthy
DraftRecoveryBlocked
PublishRecoveryBlocked
DraftAndPublishRecoveryBlocked
```

约束：

- 坏 draft 不影响健康 compiled runtime。
- 非活动角色坏 publish 不阻断其他角色或应用启动。
- 活动角色坏 publish 才进入现有默认角色 fallback。
- 一个角色或 marker 失败不能中止其余角色恢复循环。
- 损坏 marker 的原字节保留。
- draft blocked 只禁止会覆盖证据的 draft save/publish。
- publish blocked 只限制受影响角色 runtime。
- 活动角色始终优先恢复；单次启动最多检查 256 个索引角色。
- 恢复使用 2000ms 软时间预算，只在两个角色之间检查，不中断单个角色事务。
- 超出数量或时间预算的角色保持原文件不变并标记为“待后续恢复”，不得阻断应用或普通聊天启动。

该模块只拥有 Store draft/publish journal 的恢复状态，不接管 Package import journal。

### 7.2 B2 `CharacterImportJournal`

职责：拥有 Package import marker 的创建、读取、完成和损坏隔离。

约束：

- marker 先写唯一临时文件并完成适用的 flush。
- 最终发布必须是 exclusive、不可覆盖的原子操作。
- Windows 上不得未经测试假设普通 `rename` 具有 no-overwrite 语义。
- 只有 owner token、角色 ID 和物理文件身份全部匹配时才能回滚。
- 空文件、半 JSON、未知版本、权限失败和冲突逐 marker 隔离。
- 损坏 marker 保留为不可覆盖的诊断证据。
- 任一隔离失败都不得记录导入或恢复成功。

该模块不接管：

- ZIP 路径、大小、链接和内容安全策略
- source 安装事务
- Store publish
- 外层导入 saga

Store journal 与 Package journal 可以共享最小的安全读取、损坏证据命名和故障注入方法，但保持两个独立状态模型。

### 7.3 B3 恢复体验与降级

恢复结果使用稳定公开错误码。Renderer 只收到用户需要的角色标识、受影响能力和恢复建议，不接收绝对路径、marker 正文、哈希或 owner token。

基础降级不变量：

- 角色恢复失败时普通文字聊天仍可用。
- 非活动角色损坏不影响活动健康角色。
- 活动角色不可用时回退官方默认角色。
- 恢复过程不删除无法证明归属的目录。
- 磁盘满、权限失败、临时冲突和证据保留失败可解释且不伪报成功。

### 7.4 角色恢复数据流

```text
启动
  → 加载角色索引
  → 按角色读取 draft/publish journal
  → CharacterTransactionRecovery 返回分面结果
  → 健康角色继续启动
  → 仅受影响能力 blocked
  → 活动 runtime 不可用时默认角色 fallback
  → 桌宠和基础聊天继续可用
```

```text
隔离 ZIP 校验
  → 创建 exclusive import journal
  → 安装 source / owner / publish
  → 提交点更新恢复证据
  → 成功后完成 journal
  → 失败或重启时只回滚身份完全匹配对象
  → 损坏 journal 独立隔离并保留证据
```

## 8. 恢复常规功能开发门

阶段 A 和阶段 B 全部满足以下条件后，恢复常规功能开发：

1. Agent IPC 非法 sender 红测、当前 chat 正常测试和相关 Electron E2E 通过。
2. 非 chat 窗口收不到 `actionId`、命令、文件预览和披露票据。
3. Desktop `.ts`、`.tsx` 测试全部进入 TypeScript 检查。
4. 有效桌面 E2E 文件都有明确入口；MCP 运行时继续关闭。
5. 坏 draft、坏 publish 和坏 package marker 均不能使无关角色或基础聊天不可用。
6. 角色恢复只回滚身份完全匹配的对象，并保留无法安全处理的证据。
7. `verify:desktop`、`test:security`、`test:integration` 和相关角色门实际执行通过。
8. `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 和 `cloudbase` 业务文件零差异。
9. 未完成的 Windows 人工验收明确记录为“待用户人工确认”，不能写成通过。

若某项未通过，不得以“风险较低”“已有旧测试”或“依赖审查无 error”替代。

## 9. 阶段 C：恢复开发后的高收益深化

每项建立独立规格；按后续功能触达、风险和维护收益排序，不一次实施。

### 9.1 C1 设置 mutation 单一权威

让 `DesktopSettingsService` 或经批准的等价深模块拥有 Provider 设置事务。legacy 保存路径先委托同一 implementation；配置变化生命周期返回 Promise 并由 IPC await；失败后进入明确可恢复状态。消费者清单和补偿矩阵通过后删除旧 channel、preload 方法和测试。

### 9.2 C2 compiled writer 与 legacy recovery 裁决

先对真实旧磁盘格式和运行时消费者做 inventory：

- 有真实兼容数据：设计有明确版本和截止条件的一次性 handoff。
- 没有真实兼容数据：直接删除不可达 legacy writer/recovery，不创建长期模块。

`CharacterStore` 保持 compiled 正式 writer；Asset 最终只拥有 source。

### 9.3 C3 source 安装收口

Package 不再自行拼装 `source/` 和 catalog。优先深化现有 Asset lease/catalog 事务；只有生产与测试两个真实适配器成立时才引入 `CharacterSourceImportPort`。ZIP trust、package marker、Store owner 和外层 rollback 继续由原模块拥有。

### 9.4 C4 测试接缝治理

逐类裁决根安全/集成测试：

- 单 workspace 组合测试迁回 `apps/desktop/tests`。
- 跨包或进程级场景保留在根测试。
- 测试通过 `MainConversationComposition`、`CharacterActions` 或批准的窄测试入口观察行为。
- 不为消除静态告警导出所有内部类。
- 行为 seam 建立后才删除相应源码字符串断言；preload、builder、Docker 和 wiring 的有效静态断言保留。

### 9.5 C5 工作室深模块

按失败模式逐步建立：

- `CharacterDraftEditor`：纯进程内身份、皮肤、状态、动作和引用完整性。
- `CharacterWorkshopSession`：load、select、autosave、compile、flush 和 dispose 异步状态。

Zustand Store 作为 React 适配器，不复制领域规则。先抽一个能消除真实失败模式的模块，不因文件大同时建立两套空壳抽象。

### 9.6 C6 角色运行组合

只有在方法替换、激活协调和关闭所有权已经通过测试证明是维护问题时，提取 `CharacterRuntimeComposition`。构造时注入激活协调，返回 actions、必要 IPC 端口和统一 close；删除运行时替换 `activateCharacter`。组合根高出依赖本身不作为重构理由。

### 9.7 C7 IPC 契约试点

先选择一个低风险域，用带输入/输出 Schema 的描述表验证：

- 公开方法与固定 channel 一一对应。
- 请求和响应都经过运行时 Schema。
- 未知键拒绝。
- 事件退订有效。
- 不暴露通用 `invoke(channel)`。
- 实际代码量和维护表示数量下降。

试点证明收益后才逐域扩展；禁止一次生成全部 IPC。

### 9.8 C8 Main 单一动作权威

Main 接受 V2 或一次性 V1 投影并发送完整可播放动作授权。Renderer 只解析资源、播放和反馈。保留真实 V1 读取、转换和失败回退；在 V1 迁移失败、角色切换和乱序 token 行为等价后，删除 Renderer 本地 selector 与双权威模式。

### 9.9 C9 可选展示快照

只有产品确认 chat reload 或显式销毁重建必须恢复展示时实施。projection 必须有界、仅含公开展示 DTO 和 revision，不复制 Conversation/Agent 权威状态；应用重启恢复不自动包含在此范围。

### 9.10 C10 Provider fallback 诚实化

拆成三个独立决策：

1. UI 和保存契约只声明当前真实矩阵。
2. 普通聊天 same-provider fallback。
3. 跨 Provider disclosure 和重放安全。

跨 Provider 必须有独立隐私规格。不可重试错误、已产生工具副作用或已有部分输出时，默认不重放。

## 10. 阶段 C 依赖关系

- C2 必须先完成旧数据 inventory。
- C3 不与 B2 并行修改 PackageService。
- C5 和 C6 前先改善其触及的测试接缝。
- C8 在 C6 和必要 IPC 契约稳定后实施。
- C9 在 A2 和 A3 后实施。
- C10 的跨 Provider 部分必须单独获得隐私与副作用设计批准。
- 触及同一大文件或状态机的规格串行实施，不让子智能体并行编辑共享状态。

## 11. 阶段 D：删除与持续治理

删除任务随对应阶段 C 规格执行，不建立一次性大扫除提交。最终治理检查：

- 被替换的 writer、channel、selector 和恢复入口引用归零。
- V1 保留项仅为批准的读取、转换和失败回退。
- MCP 源码和持久化数据可保留，但运行时、Agent 和 Renderer 继续禁用。
- 当前架构文档区分 `current`、`proposed`、`historical`、`superseded` 和 `dormant`。
- 旧审查材料中的错误规则数、测试数、哈希和 READY 口径不再作为当前事实入口。
- 依赖规则只有在违规归零并连续通过相关门后逐条升级，不能批量转为 error。
- 大量删除前列出精确目标、影响和恢复方式，并再次取得用户批准。

## 12. TDD 与验证策略

### 12.1 每个切片的固定流程

1. RED：写一个稳定复现当前缺陷的最小失败测试。
2. 确认 RED 因正确原因失败。
3. GREEN：实现使该场景通过的最小改动。
4. REFACTOR：只在测试持续绿色时收敛重复。
5. 删除旧路径：新接口覆盖原行为后，同批删除旧 owner 和旧测试。
6. 先运行定向测试和 package typecheck。
7. 再运行受影响的桌面质量门。
8. 使用 `git diff --check`、只读差异和网站零差异检查收尾。

### 12.2 关键 RED 矩阵

Agent IPC：

- pet、settings、workshop、旧 chat、已销毁 chat 拒绝。
- 当前 chat 成功。
- 非法 sender 时 service 零调用。
- 窗口替换后旧 sender 立即失效。

事件投影：

- 非 chat 不收到确认票据、命令、文件预览和披露请求。
- pet 行为反馈保持可用。
- 非法 TaskEvent 不进入 Renderer Store。

Store journal：

- active/non-active × bad draft/bad publish/两者并存。
- 多个坏角色不阻断健康角色。
- 默认角色 fallback 只在需要时发生。

Package journal：

- 空 marker、半 JSON、未知 Schema。
- open、write、flush、publish、owner、source、Store publish 各 checkpoint 中断。
- owner token 或物理身份不匹配时不回滚。
- 损坏证据命名冲突、权限失败和磁盘满。

验证覆盖：

- 漏掉任一 Desktop `.ts` 或 `.tsx` 测试时配置契约失败。
- 有效 E2E 文件无 owner 或重复 owner 时失败。
- MCP 启用路径出现时禁用契约失败。

### 12.3 最低自动门禁

根据改动范围执行：

```powershell
pnpm.cmd --filter '@myself/desktop' typecheck
pnpm.cmd --filter '@myself/desktop' test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
```

涉及角色时追加：

```powershell
pnpm.cmd verify:characters
```

涉及行为权威时追加：

```powershell
pnpm.cmd verify:behavior
```

实际执行前必须重新读取 `package.json`，确认脚本仍存在。不得运行网站验证来掩盖网站零差异要求；网站零差异通过只读文件差异检查证明。

## 13. 人工验收边界

自动测试不能替代：

- 真实 Windows 多窗口确认卡只在聊天窗口出现。
- chat 关闭、重开后旧窗口调用失效。
- 损坏角色隔离提示和默认角色 fallback。
- 真实回收站、窗口层级、拖拽、托盘和角色工作室操作。
- CPU、内存、纹理释放和最大素材编译响应性。

没有实际人工观察时统一记录为“待用户人工确认”。

## 14. 后续功能的架构准入问题

恢复开发后的每个新功能规格必须回答：

1. 功能进入哪个现有深模块？
2. 调用者需要学习哪些新接口事实？
3. 是否引入第二个 writer、状态权威或 Schema owner？
4. 替换什么旧路径，何时删除？
5. 哪个 RED 测试证明需求？
6. 哪些安全、外部环境和人工门仍未验证？

无法回答时，不进入实施。

## 15. 文档与实施拆分

本文件是桌宠架构优化总规格。恢复开发前还需分别建立以下独立规格及实施计划：

1. A1 Desktop 验证覆盖。
2. A2 当前聊天窗口 IPC 授权。
3. A3 会话事件投影。
4. B1 Store journal 分面隔离。
5. B2 Package import journal 原子发布。
6. B3 恢复体验与降级验收。

A1 至 B3 可以在一份总实施路线中表达依赖，但每项必须是可独立 RED、GREEN、复审和回滚的任务。阶段 C/D 在恢复开发后按实际触达分别进行 brainstorming、规格确认和计划编写。

## 16. 完成定义

本设计完成不等于代码优化完成。只有以下条件同时满足，才可宣布“恢复开发前优化达标”：

- A1–A3、B1–B3 的批准规格和实施计划已经执行。
- 恢复开发门的九项条件均有当前代码和运行结果证据。
- 新接口后没有永久双轨，获批保留的兼容路径有 owner 和退役条件。
- 相关旧路径与只维护旧实现的测试已删除。
- 文档只记录实际运行结果，人工项未观察时保持待确认。
- 网站及云端业务代码零差异。
