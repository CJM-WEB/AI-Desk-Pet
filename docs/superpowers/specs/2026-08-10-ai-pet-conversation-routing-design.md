# AI 桌宠自由聊天与文件任务分流设计

> 文档状态：待用户书面审阅  
> 基准日期：2026-08-10  
> 目标分支：`AgentCoreExtension`  
> 开发方式：规格驱动开发；实施阶段采用 TDD 与子智能体驱动开发  
> 范围：仅智能桌宠 Desktop，不包含网站

## 1. 文档目的

本文定义 AI 桌宠首个陪伴认知切片：在保留单一聊天输入框的前提下，将普通聊天、澄清和文件任务安全分流。普通聊天不再依赖文件授权；文件任务继续复用现有 Agent、文件权限、确认卡、回收站事务和角色行为链。

本文是后续实施计划的唯一需求基准。实施计划和测试必须引用本文的稳定需求编号。需求变化时先更新本文和覆盖关系，再调整实施计划与代码。

## 2. 背景与现状

当前 Renderer 的全部输入通过同一个 `chat:submit` IPC 进入 `AgentService.submit()`。Main 创建会话时无条件执行以下操作：

1. 读取模型设置、授权目录和隐私设置；
2. 要求存在授权目录；
3. 选择支持工具的 Agent 模型；
4. 创建 `PathPolicy`、文件工具和权限策略；
5. 注入文件助手系统提示。

因此，即使用户只进行普通问候，也会受到授权目录和文件 Agent 配置约束。现有 `ModelRouter` 已支持独立的 `chat` 与 `agent` 路由，现有隐私模块已具有会话 generation、对话披露类别和跨 Provider 授权基础；本设计复用这些能力，不重建 Provider、文件工具或隐私体系。

## 3. 目标

1. 普通聊天在没有文件授权时仍能工作。
2. 保留单一输入框，由 Main 自动区分普通聊天、澄清和文件任务。
3. 普通聊天默认不加载任何本地文件工具。
4. 意图不明确时先澄清，不能擅自进入文件任务。
5. 当前运行期间提供有界的多轮上下文，不写入磁盘。
6. 用户可通过“新对话”原子清空当前上下文并撤销旧任务能力。
7. 共享可见对话与任务私有工具上下文严格隔离。
8. 既有可见历史跨 Provider 发送前必须取得明确的单次授权。
9. 现有文件确认、路径守卫、回收站提交帧和错误恢复行为不得退化。

## 4. 非目标

- 不实现长期记忆、记忆管理界面或主动陪伴。
- 不实现语音、联网信息工具、视觉模型或桌面自动化。
- 不恢复或启用 MCP。
- 不改变角色包、角色工作室或 Explorer 动态层级。
- 不在本切片实现单文件夹/此电脑双授权、固定磁盘枚举、受保护区域或卷身份绑定；这些规则已经确认，但必须形成独立规格和实施计划。
- 不修改、测试或重构 `apps/website` 及任何网站模块。

## 5. 稳定需求

### 5.1 范围与入口

- `CONV-SCOPE-001`：Renderer 保留一个聊天输入框，不增加 Chat/Work 手动模式切换。
- `CONV-SCOPE-002`：普通聊天不得依赖授权目录、`PathPolicy` 或文件数据类别授权。
- `CONV-SCOPE-003`：普通聊天模型请求的工具列表必须为空。
- `CONV-SCOPE-004`：文件任务继续通过现有 Agent 和文件安全链执行。

### 5.2 分流

- `CONV-ROUTE-001`：所有用户输入由 Electron Main 中的可信模块分流，Renderer 不得提交路由类型。
- `CONV-ROUTE-002`：严格规划结果只允许 `chat_reply`、`clarify` 和 `file_task` 三种。
- `CONV-ROUTE-003`：无效、矛盾或无法解析的规划结果必须降级为固定澄清，不能启用工具。
- `CONV-ROUTE-004`：只有 `file_task` 结果能够创建文件任务会话。
- `CONV-ROUTE-005`：明确文件任务缺少活动授权范围时，必须在 Agent 工具调用前返回稳定引导，不得降级为普通聊天或假装完成。

### 5.3 当前会话

- `CONV-HISTORY-001`：Main 仅保存当前应用运行期间的可见对话，不写入磁盘。
- `CONV-HISTORY-002`：模型上下文最多保存 20 个已完成用户—助手回合和 16,000 个 Unicode 字符。
- `CONV-HISTORY-003`：超过限制时必须按完整回合从最旧开始淘汰，不生成隐藏摘要。
- `CONV-HISTORY-004`：共享历史只包含用户和 Renderer 实际看见的助手消息。
- `CONV-HISTORY-005`：工具请求、目录列表、文件正文、原始工具结果、`VerifiedWriteAction`、续跑令牌和播放令牌不能进入共享历史。

### 5.4 披露

- `CONV-DISCLOSE-001`：当前用户主动提交的消息可发送给本次选中的模型。
- `CONV-DISCLOSE-002`：既有可见历史发送给不同 Provider 前必须取得明确授权。
- `CONV-DISCLOSE-003`：历史授权只绑定当前会话 generation、当前请求、目标 Provider 身份和本次历史清单。
- `CONV-DISCLOSE-004`：用户选择仅发送当前消息时继续处理，不视为错误。
- `CONV-DISCLOSE-005`：文件任务私有上下文在任何情况下都不能进入对话披露清单。
- `CONV-DISCLOSE-006`：无痕模式不能降低跨 Provider 披露要求。

### 5.5 重置与并发

- `CONV-RESET-001`：“新对话”必须先使旧 generation 失效，再撤销旧能力并清空上下文。
- `CONV-RESET-002`：重置必须撤销活动模型请求、披露确认、待确认文件动作、Agent 续跑令牌和未提交的动画文件能力。
- `CONV-RESET-003`：旧 generation 的迟到响应和事件不能进入新会话。
- `CONV-RESET-004`：不可逆文件提交已经开始时，重置必须等待真实结果收敛，不得伪装为已取消。
- `CONV-RESET-005`：重置不删除设置、审计数据或未来的长期记忆。
- `CONV-CONCURRENCY-001`：任一时刻最多存在一个活动请求或待确认事项。

### 5.6 安全与可观察性

- `CONV-SAFE-001`：对话模型失败不能自动升级为文件 Agent。
- `CONV-SAFE-002`：文件授权检查失败不能退回聊天路径并声称任务完成。
- `CONV-SAFE-003`：披露校验失败时不得发送既有历史。
- `CONV-SAFE-004`：日志与审计不得记录聊天正文、文件正文、API Key 或完整绝对路径。
- `CONV-SAFE-005`：重置清理部分失败时，旧 generation 与旧能力仍必须保持失效，Coordinator 在安全清理完成前拒绝新提交。

## 6. 架构

在 Electron Main 新增深模块 `ConversationCoordinator`，作为聊天 IPC 的唯一业务入口。

```text
ChatPanel / Preload / IPC
           │
           ▼
ConversationCoordinator
  ├─ 当前会话 generation
  ├─ 有界可见消息历史
  ├─ 意图规划与安全降级
  ├─ Chat / Agent 路由
  ├─ 跨 Provider 披露状态
  ├─ 活动请求与确认状态
  └─ 新对话原子重置
           │
           ├─ ConversationTurnAdapter
           │    └─ 对话模型；始终 tools: []
           │
           ├─ FileTaskAdapter
           │    └─ 现有 AgentService
           │         └─ 文件工具、确认、回收站事务
           │
           └─ DisclosureAdapter
                └─ 现有 DisclosurePolicy
```

### 6.1 `ConversationCoordinator`

该模块负责：

- 当前会话状态与 generation；
- 有界可见历史；
- 普通聊天、澄清和文件任务分流；
- Provider 选择和历史披露暂停/恢复；
- 活动请求、披露确认和文件确认的串行化；
- 新对话重置和迟到事件过滤；
- 公开错误归一化。

该模块不负责解析绝对路径、判断受保护目录、执行文件操作、播放角色动画或持久化长期记忆。

### 6.2 `ConversationTurnAdapter`

该 Adapter 使用 `ModelRouter.select('chat')` 选择对话模型，以严格的无工具请求返回规划结果。其请求必须满足：

- `tools` 固定为空数组；
- 不读取活动授权范围；
- 不创建 `PathPolicy`、`FileToolService` 或 `PermissionPolicy`；
- 只接收获准的可见历史和当前用户消息；
- 结果经过严格 Schema 解析。

首个切片不建立通用能力注册表。未来的信息协助、语音或长期记忆只能在新的规格批准后接入。

### 6.3 `FileTaskAdapter`

该 Adapter 包装现有 `AgentService`，继续复用：

- `AgentLoop`；
- Agent 模型路由；
- 授权范围与 `PathPolicy`；
- `FileToolService`；
- 工具注册与 `PermissionPolicy`；
- `PendingActionStore`；
- `FileTaskTransactionCoordinator`；
- 回收站提交帧和角色播放授权。

本切片不得重写或复制上述文件事务实现。

### 6.4 `DisclosureAdapter`

该 Adapter 复用 `PrivacySessionRegistry` 与 `DisclosurePolicy`，只为可见对话生成 `conversation` 类别清单。它不接收文件任务私有上下文。

## 7. 外部接口

`ConversationCoordinator` 对 IPC 组合根提供以下窄化接口：

```ts
interface ConversationCoordinator {
  submit(text: string): Promise<void>;
  cancelActive(): void;
  resolveFileAction(
    actionId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void>;
  resolveHistoryDisclosure(
    requestId: string,
    decision: 'share_once' | 'current_message_only'
  ): Promise<void>;
  resetConversation(): Promise<void>;
}
```

Renderer 不接收分流类型，也不能指定目标 Provider、历史正文、文件工具或 Agent 模式。

## 8. 会话状态

内部状态只允许：

```text
idle
running_chat
awaiting_history_disclosure
running_file_task
awaiting_file_confirmation
resetting
closed
```

状态转换由 Coordinator 串行化。运行请求与待确认事项互斥；重复提交、重复确认、过期确认和状态不匹配全部失败关闭。

## 9. 数据流

### 9.1 提交与规划

1. 校验并规范化 1–4000 字用户输入。
2. 检查 Coordinator 处于可提交状态。
3. 将用户文本作为可见消息广播给 Renderer。
4. 发布 `listening` 和 `thinking` 阶段。
5. 选择对话模型并计算可发送历史。
6. 若需要跨 Provider 披露，保存当前请求并进入等待确认状态。
7. 获得可发送上下文后调用 `ConversationTurnAdapter`。
8. 严格解析规划结果。

规划结果契约为：

```ts
type TurnPlan =
  | {
      kind: 'chat_reply';
      text: string;
      emotion?: CharacterEmotionLabel;
    }
  | {
      kind: 'clarify';
      question: string;
    }
  | {
      kind: 'file_task';
    };
```

非法结构统一替换为固定澄清问题，不向用户暴露内部解析详情。

### 9.2 普通聊天

1. 广播助手可见回复和可选角色情绪。
2. 将完成的用户—助手回合加入 Main 内存历史。
3. 按完整回合执行数量和字符上限裁剪。
4. 发布 `success`，随后复用现有瞬态恢复到 `idle` 的表现。

### 9.3 澄清

澄清问题作为普通助手可见消息处理并加入当前会话。该路径不读取授权范围、不选择 Agent 模型、不加载工具。

### 9.4 文件任务

1. 规划结果为 `file_task` 后才读取活动授权快照。
2. 没有活动授权范围时发布 `FILE_AUTHORIZATION_REQUIRED` 和打开设置的下一步，终止本次任务。
3. 有授权范围时选择 Agent 模型。
4. 计算 Agent Provider 所需的可见历史披露。
5. 未授权时显示披露确认；用户可单次共享历史或仅发送当前消息。
6. 通过 `FileTaskAdapter` 调用现有 `AgentService`。
7. 文件工具私有上下文只在现有 Agent 会话中流转。
8. 最终公开回复或脱敏结果摘要作为助手可见消息加入当前会话。

## 10. 跨 Provider 披露

新增公开事件：

```ts
type HistoryDisclosureRequiredEvent = {
  type: 'history_disclosure_required';
  requestId: string;
  targetProviderName: string;
  messageCount: number;
  characterCount: number;
};
```

事件不得包含聊天正文、Provider 密钥、文件路径或工具事实。

Renderer 只能返回：

```ts
type HistoryDisclosureDecision =
  | 'share_once'
  | 'current_message_only';
```

`share_once` 授权必须在 Main 绑定当前 generation、当前请求、目标 Provider 身份和精确历史清单。`current_message_only` 直接继续本次请求，不记录为错误，也不为后续请求建立隐式授权。

## 11. 新对话

Renderer 增加“新对话”按钮。调用 `resetConversation()` 时固定执行：

1. 递增 generation，使后续旧事件失效；
2. 中止活动模型请求；
3. 撤销历史披露请求与本会话披露授权；
4. 取消待确认文件动作并丢弃 Agent 续跑令牌；
5. 撤销尚未提交的动画文件能力；
6. 清空可见历史和任务私有上下文；
7. 广播 `conversation_reset`；
8. Renderer 清空消息、披露卡和文件确认卡；
9. 返回 `idle`。

新增事件：

```ts
type ConversationResetEvent = {
  type: 'conversation_reset';
  generation: string;
};
```

如果文件系统不可逆提交已经开始，Coordinator 保持 `resetting`，等待真实结果成功或失败收敛；该结果不进入新会话，完成后再广播重置事件。

## 12. Renderer 与 IPC

### 12.1 Renderer

`ChatPanel` 只新增：

- “新对话”按钮；
- 历史披露确认卡；
- 重置等待状态；
- 文件授权缺失错误中的打开设置入口；本切片不新增此电脑授权控件。

不新增模式切换、Provider 选择、文件工具入口或路由调试信息。

### 12.2 IPC

保留现有消息提交、活动取消和文件确认通道，新增：

```ts
resetConversation(): Promise<void>;

resolveHistoryDisclosure(input: {
  requestId: string;
  decision: 'share_once' | 'current_message_only';
}): Promise<void>;
```

Preload 继续只暴露严格白名单接口；Main 对所有输入执行严格 Schema 校验。Renderer 不能提交 generation、Provider 身份或历史正文。

## 13. 错误处理

### 13.1 公开错误码

| 错误码 | 用户行为 |
| --- | --- |
| `CHAT_SETTINGS_REQUIRED` | 打开设置并配置可用于聊天的模型与密钥 |
| `FILE_AUTHORIZATION_REQUIRED` | 打开设置并配置当前版本支持的文件授权范围；此电脑入口由后续独立子项目提供 |
| `AGENT_SETTINGS_REQUIRED` | 配置支持工具调用的 Agent 模型 |
| `FILE_DISCLOSURE_DENIED` | 在隐私设置中启用文件数据类别 |
| `TASK_ALREADY_ACTIVE` | 等待、取消或重置当前事务 |
| `DISCLOSURE_REQUEST_EXPIRED` | 重新提交当前消息 |

现有 Provider、路径、写入确认、回收站和动画事务错误继续使用既有稳定映射。

### 13.2 内部降级

- 规划结构无效：生成固定澄清问题。
- 用户拒绝共享历史：仅发送当前消息。
- 旧 generation 事件：静默丢弃，只记录不含正文的稳定诊断码。
- 重置期间旧请求取消：不向新会话追加取消错误。
- 对话 Provider 失败：发布聊天错误，不切换到文件路径。
- 文件授权或隐私检查失败：发布稳定文件错误，不调用 Agent。

## 14. 安全不变量

1. 普通聊天请求的工具列表恒为空。
2. 普通聊天路径不读取授权范围或创建文件安全对象。
3. Renderer 不能控制分流结果。
4. 低置信或无效规划不能进入文件任务。
5. 文件任务必须重新经过当前授权和隐私检查。
6. 任务私有数据不能进入共享历史或对话披露。
7. 跨 Provider 历史必须先生成有效披露清单。
8. 旧 generation、旧请求 ID 和重复确认全部拒绝。
9. 日志与审计不记录聊天正文、文件正文、密钥或完整绝对路径。
10. 重置失败不能恢复旧 generation 或旧文件能力。

## 15. 性能与资源约束

- 普通聊天正常路径只进行一次模型请求。
- 文件任务在现有 Agent 循环前最多增加一次无工具规划请求。
- Main 可见历史最多 20 个完整回合和 16,000 个 Unicode 字符。
- 当前会话不写磁盘，不生成后台摘要。
- 不持续轮询模型，不持续读取文件系统。
- 新模块的状态变化必须事件驱动。

## 16. 测试设计

### 16.1 纯单元测试

- 历史按完整回合和字符上限裁剪；
- 严格规划结果解析；
- 无效规划安全降级；
- generation 递增和迟到事件拒绝；
- Provider 身份比较和披露清单计算；
- 状态机拒绝非法并发与重复确认。

### 16.2 Coordinator 测试

- 无授权范围仍可普通聊天；
- 普通聊天不读取授权设置且 `tools` 为空；
- 模糊输入只产生澄清；
- 明确文件任务才调用 `FileTaskAdapter`；
- 缺少授权范围时不调用 Agent；
- 跨 Provider 单次共享与仅当前消息；
- 过期、伪造和重复披露确认；
- 新对话撤销活动请求、确认卡和旧令牌；
- 不可逆文件提交期间安全等待；
- 任务私有数据不进入共享历史。

### 16.3 Provider 契约测试

- OpenAI 兼容、Anthropic 和 Gemini 能处理严格无工具规划回合；
- 请求工具数组恒为空；
- 非法、混合或缺字段结果只能安全澄清；
- Provider 取消和超时不会触发文件任务。

### 16.4 IPC、Preload 与 Renderer 测试

- 新通道与 preload 接口严格白名单；
- 披露输入拒绝未知字段、未知决策和过长 ID；
- “新对话”按钮清空消息与确认卡；
- 披露卡只显示 Provider 名称和数量摘要；
- Renderer 不能提交路由类型、历史正文或 Provider 身份；
- 重置等待期间禁止重复提交。

### 16.5 安全测试

- 普通聊天不读取授权根、不创建 `PathPolicy`；
- 文件私有上下文不进入历史或披露；
- 日志不包含聊天正文、文件正文、API Key 和完整绝对路径；
- 旧 generation、旧确认 ID 和重复确认全部拒绝；
- 现有文件路径、Junction、确认和回收站门禁保持通过。

### 16.6 集成与 Electron E2E

- 未授权范围时完成有界多轮普通聊天；
- 模糊请求出现澄清且无文件副作用；
- 明确文件任务引导授权；
- 跨 Provider 的单次共享与仅当前消息两条路径；
- 运行中建立新对话后旧响应不回流；
- 现有安全文件任务、确认卡和回收站搬运继续通过。

E2E 必须使用隔离 userData、脚本 Provider 和临时授权目录，不读取用户真实对话、文件或密钥。

## 17. 规格驱动与 TDD 执行规则

### 17.1 规格驱动

- 每个实施任务必须引用本规格的需求编号。
- 每个任务必须写明失败测试、最小实现、禁止修改范围、验证命令和完成证据。
- 新行为先更新规格和覆盖矩阵，再进入实现。
- 代码行为与规格冲突时先确认产品决策，不默认代码正确。

### 17.2 TDD

每个任务固定执行：

1. 编写能证明目标行为缺失的失败测试；
2. 运行聚焦测试并确认因目标行为缺失而失败；
3. 编写使当前测试通过的最小实现；
4. 运行聚焦测试和相关类型检查；
5. 只清理由当前任务产生的重复或浅层接口；
6. 重新运行测试；
7. 完成规格核对和代码审查。

不得通过放宽断言、增加无依据的 timeout、跳过用例或事后补测试制造通过结果。

### 17.3 子智能体驱动执行

- 单个实现子智能体一次只负责一个计划任务。
- 共享核心文件上的任务串行执行，不并行写入。
- 每个任务依次接受规格审查和代码质量审查。
- 审查问题交回原实现子智能体修正；审查通过后才进入下一任务。
- 子智能体不得修改网站、执行未获授权的 Git 写操作或扩大文件权限范围。

## 18. 验证门

每个任务至少运行其聚焦测试和涉及 package 的类型检查。全部任务完成后运行：

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:security
pnpm test:integration
pnpm test:e2e:desktop
```

涉及角色行为、播放反馈或回收站事务时额外运行：

```powershell
pnpm verify:behavior
```

不得运行 `verify:website`，不得修改网站测试来处理桌面端失败。

## 19. 人工验收

1. 在没有授权范围时连续进行至少三轮普通聊天，确认上下文连贯。
2. 输入含糊的“帮我整理一下”，确认桌宠先询问对象且不产生文件副作用。
3. 明确请求列出本地文件但未授权时，确认出现打开设置的引导。
4. 配置不同 Provider 的 Chat 与 Agent 模型，分别验证单次共享历史和仅发送当前消息。
5. 在模型请求期间点击“新对话”，确认旧回复不进入新会话。
6. 在待确认文件动作期间点击“新对话”，确认旧动作失效且文件未改变。
7. 完成一次既有安全文件任务，确认预览、确认、动画提交和结果反馈未退化。
8. 检查日志，确认不包含测试聊天正文、文件正文、API Key 或授权根绝对路径。

## 20. 完成标准

- 所有稳定需求均有自动测试或明确的 Windows 人工验收证据；
- 普通聊天不依赖文件授权且不加载工具；
- 模糊意图不能进入文件任务；
- 当前会话有界、仅驻留内存并可安全重置；
- 跨 Provider 历史披露必须显式确认；
- 文件任务私有上下文不进入共享历史；
- 现有文件安全和回收站事务门禁全部通过；
- 生产源码、测试和文档不包含新的 Chat/Work 手动模式；
- 网站源码、测试和文档未被修改；
- 规格覆盖矩阵、实施计划、测试证据和人工验收记录保持一致。

## 21. 后续独立子项目

本规格完成并验收后，再为广域文件授权编写独立规格。该规格必须以根 `CONTEXT.md` 中已经确认的领域语言为基准，至少覆盖：

- 单一活动授权范围；
- 单文件夹授权与此电脑授权互斥；
- 当前本机固定磁盘快照；
- 授权根标识与根内相对路径；
- 不可绕过的受保护区域；
- 卷身份绑定；
- 移动设备、光驱、网络盘和新挂载卷不自动加入；
- 切换授权范围时撤销旧任务和旧权限令牌。
