# 桌宠意图编排与状态动作生命周期设计

**日期：** 2026-08-27  
**状态：** 已获用户批准  
**替代范围：** 替代 `2026-08-27-ai-pet-structured-control-repair-design.md` 中“六字段严格聊天对象必须整体成功”、扁平行为候选以及 Router 精确猜测文件工具的设计；其余授权根、逐操作确认、Main 可信边界和三态定义继续有效。

## 1. 背景与现状证据

本轮处理的是同一个根问题：模型已经生成了可见回复或理解了用户意图，但当前编排层无法稳定把它转换成聊天、Agent 任务或角色行为。

1. `ConversationChatAdapter` 要求每次普通聊天都返回 `text/activity/status/movementControl/behaviorPlan/capabilityPlan` 六类完整字段，且 `allowPlainTextFallback=false`。DeepSeek Chat Completions 实际只接收 `response_format: json_object`，没有接收本地 JSON Schema；任一隐藏字段缺失、额外、截断或为空都会抛出 `PROVIDER_MALFORMED_RESPONSE`。
2. `ConversationCoordinator` 未公开该错误码，最终把正常聊天压成 `AGENT_INTERNAL_ERROR`，界面只显示“任务执行失败，请重试”。现有测试反而把普通纯文本失败写成了预期。
3. 文件任务同时经过正则 Router、聊天 `capabilityPlan`、任务级授权和 Agent 首轮工具收窄。多处重复判断会让正确意图在任一层被阻断；模型落入 `tools=[]` 的聊天请求后只能口头回答。
4. 角色 V2 清单真实保存“状态 → actionIds”，动作已有权重、冷却和重复抑制；但公开给模型的目录把状态和动作拍平成一张表，丢失归属关系，也没有状态/动作详细描述。
5. 本地相似度没有最低命中阈值，无关文本也会选择目录第一项。状态目标虽然会按权重随机选择一次动作，但动作结束后不会在同一状态生命周期中继续选择。

OpenCode 参考固定为 `anomalyco/opencode` 提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`（`packages/opencode` 1.18.21，MIT）。本项目只复用其“模型工具调用表达意图、确认挂起原调用、真实工具结果回注”的编排模式，不复制其绝对路径、默认 Shell 权限、Effect/AI SDK 或完整会话框架。

## 2. 目标

1. 普通聊天只要存在合法可见正文就必须成功；隐藏控制数据失败只能局部降级，不能杀死正文。
2. 文件、目录和 PowerShell 请求由单一意图链进入现有 Agent 工具循环；工具参数、确认和真实结果仍由 Main 裁决。
3. Provider 与内置本地模型使用同一意图、工具和行为契约，不维护两套业务逻辑。
4. 模型看到角色人设摘要以及“状态 → 多个动作”的层级目录、详细描述、语义和标签。
5. 用户明确指定动作时优先选择描述最相近的合格动作；只指定状态或没有具体动作时，在该状态内按权重、冷却和重复抑制随机选择。
6. 状态持续期间，一个动作结束后可以继续选择同状态的下一个合格动作；状态切换、停止、拖拽或会话失效必须终止旧生命周期。
7. 三态语义保持：`0` 持续静止、`1` 持续运动、`2` 每隔 10–30 秒间歇移动；一次性移动不修改持久模式。

## 3. 非目标

- 不启用 MCP，不恢复截图、剪贴板或长期记忆。
- 不把角色包脚本化，不让 Renderer、Provider 或角色素材获得文件系统与进程权限。
- 不整体引入 OpenCode、Effect、Bun、AI SDK、数据库、插件或子 Agent 系统。
- 不开放跨授权根路径、后台 PowerShell、静默覆盖、永久批量删除或无人确认写操作。
- 不要求模型决定私有资源 ID、真实屏幕坐标、授权结果或工具执行成败。
- 本轮不处理拖拽、碰撞、缩放、官网或安装包。

## 4. 模块与接口

### 4.1 对话解释模块

对话解释模块以一个窄接口向 Coordinator 返回可见正文和彼此独立的控制建议：

```ts
type InterpretedConversationTurn = Readonly<{
  text: string;
  capabilityPlan?: CapabilityControlPlan;
  movementControl?: MovementControlPlan;
  behaviorPlan?: CharacterBehaviorPlan;
  activity?: string;
  status?: string;
}>;
```

不再存在“六个字段必须同时合法”的接口不变量：

- `text` 是唯一必须成功的可见字段。
- 每个隐藏字段分别通过本地 Schema；单字段失败就丢弃该字段。
- JSON 截断时只允许现有顶层 `text` 安全恢复，不从嵌套对象猜控制数据。
- 完全没有合法正文时仍失败关闭，并公开为“模型响应格式不兼容”，不得伪装成文件任务失败。
- 对明确进入 Agent 的请求不先生成聊天正文；Coordinator 继续在创建聊天 Provider 前走能力路径。

DeepSeek `deepseek-v4-flash` 请求明确发送非思考模式，并为结构化聊天设置有界输出预算；遵守官方 JSON Output 对截断和偶发空内容的约束。空内容只允许一次同配置重试，仍为空则返回稳定 Provider 错误。

### 4.2 Agent 意图与工具编排

Main Router 只保留两类职责：

1. 确定性的安全阻断：否定、引用、代码块、讨论命令、后台 PowerShell 和越权形状。
2. 高置信直接命令的能力类别：`file` 或 `powershell`。

Router 不再把自然语言猜成唯一文件工具，也不再用猜测结果删除 Agent 的其他合法工具。进入 Agent 后：

- 文件任务获得完整受控文件工具集合；PowerShell 只获得受控 PowerShell 工具。
- `preferredTool` 与 Router 解析结果至多作为排序/提示，不形成 `expectedWriteOperation` 硬约束。
- 模型的真实 `tool_call` 是操作意图；参数由 Schema 解码，失败结果作为稳定工具错误回注，允许一次有界修复。
- 用户确认挂起当前 Action 和同一会话所有权；确认后恢复原 Action，执行真实工具，再把可信结果紧跟原工具调用回注。
- 只有本地工具返回值可以形成成功事件；模型文字不能替代执行事实。

当 Router 不能高置信判定、模型却给出 `capabilityPlan=agent_task` 时，仍先显示任务级授权卡。隐藏能力字段缺失时不得误触系统能力，也不得阻断普通聊天。

### 4.3 角色层级目录

角色 V2 状态和动作新增可选、受限长度的 `description`：

```ts
type PublicBehaviorState = Readonly<{
  name: string;
  semantic: string;
  description?: string;
  tags: readonly string[];
  actions: readonly PublicBehaviorAction[];
}>;

type PublicBehaviorAction = Readonly<{
  name: string;
  semantic: string;
  description?: string;
  tags: readonly string[];
}>;
```

- 旧 V2 清单省略 `description` 时继续合法，无需批量迁移。
- 工作台在状态和动作编辑器中提供详细描述输入，编译发布后原样进入运行清单。
- Provider 只获得公开名称、语义、描述、标签和层级，不获得 actionId、资源路径、帧信息或脚本。
- 角色 identity 只发送名称、description、background、traits、languageStyle、likes 和 behavioralTendencies 的有界公开副本；不得发送路径或素材正文。

### 4.4 行为意图与选择规则

模型仍返回受限行为计划，但选择对象改为层级目标：

```ts
type CharacterBehaviorPlan =
  | { kind: 'none'; emotion?: CharacterEmotionLabel }
  | {
      kind: 'play_state';
      state: string;
      action?: string;
      duration?: 'brief' | 'normal' | 'extended';
      emotion?: CharacterEmotionLabel;
    };
```

规则如下：

1. 用户明确指定具体动作：在目标状态的合格动作中按 `name/semantic/description/tags` 计算相似度，选择最高项。
2. 用户只指定状态：进入该状态，并由运行时按 `preference/cooldown/repeatSuppression` 随机选择动作。
3. 模型未返回精确目录名称：Main 可用 `activity/status` 做一次本地相似解析，但必须达到最低阈值；低于阈值返回 `none`。
4. Provider 精确给出动作时仍需验证该动作属于指定状态；跨状态组合无效，不能退回目录第一项。
5. `movementControl` 独占运动模式与位置策略；行为计划只控制状态/动画，不得写三态。

### 4.5 状态动作生命周期

状态信号在有效期内形成一个运行时生命周期：

- 进入时选择首个合格动作。
- 动作完成且状态仍有效时，从同状态剩余合格动作中重新按权重选择。
- 冷却和重复抑制继续生效；无合格动作时安全回到状态默认动作或 idle，不忙循环。
- `mode=0`、显式状态切换、拖拽/携带、角色切换、reset 和关闭立即失效旧生命周期。
- `mode=1` 的移动状态可以连续选择移动动作；`mode=2` 每段移动结束回到 idle，下一次只由 10–30 秒 Scheduler 重新触发。

## 5. 失败处理与隐私

- 普通聊天隐藏字段失败：保留正文，忽略失败字段，记录不含正文、路径和密钥的稳定诊断码。
- 正文缺失或空内容重试仍失败：公开 `PROVIDER_MALFORMED_RESPONSE` 对应文案，不显示“任务执行失败”。
- 行为目录缺失、非法或低置信：不播放新动作，不影响聊天。
- Agent 工具参数失败：回注稳定错误；达到修复上限后报告具体任务错误，不发布成功。
- 状态/动作描述属于用户创建的角色资料；进入云 Provider 前受长度限制，并沿用当前会话披露与 Provider 选择边界。
- 日志只记录 Provider 类别、完成原因、顶层字段名和 Schema 问题路径，不记录回复正文、API Key、绝对路径、工具输出或角色私有资源信息。

## 6. 删除与迁移范围

新路径通过后删除：

- “普通纯文本必须失败”和“六字段任一失败就拒绝正文”的测试及实现。
- PublicBehaviorCatalog 的扁平 `candidates` 正式运行路径。
- 无最低阈值时强制选择目录第一项的 fallback。
- Router/PlanningHint 对首轮 Agent 工具的硬删除和 `expectedWriteOperation` 重复裁决。
- 只服务旧 `play.target={kind,name}` 扁平计划的别名与测试夹具。

不删除受控文件工具、PowerShell 工具、授权根、逐操作确认、真实结果回注、三态持久化或 MCP 源码/持久化数据。

## 7. 测试与验收

### 7.1 自动化 RED/GREEN

1. Provider：DeepSeek 普通“你好”返回纯文本、部分 JSON、额外隐藏字段或截断控制对象时，合法正文成功；空正文有界重试后返回明确格式错误。
2. Coordinator：普通聊天不创建 Agent、不显示任务失败；明确文件请求进入 Agent，确认前无副作用，确认后检查真实临时目录副作用。
3. Agent：开放式移动/创建/编辑/PowerShell 组合任务获得完整合法工具集；错误参数回注后修复；错误 Router hint 不能删除正确工具。
4. Schema/工作台：状态和动作描述保存、发布、重载；旧清单无描述仍可读取；公开目录保持状态动作归属且不泄露 ID/路径。
5. Resolver：无关文本返回 none；明确动作选最高相似；只指定状态不固定动作；跨状态动作被拒绝。
6. Engine：固定随机源验证同一状态多动作轮换、权重、冷却、重复抑制和生命周期取消。
7. 三态：覆盖 `0→1→2→0`、自然改写、“让他时不时动一下”、持续运动和一次性远距离移动；`mode=2` 使用假时钟验证每轮重新抽取 10–30 秒。
8. Provider 与本地模型使用同一组意图/行为表驱动用例，不允许只用人工构造完美六字段 JSON。

### 7.2 门禁

- 定向测试后运行 `pnpm typecheck`、相关 package 测试、`pnpm test:security`、`pnpm test:integration`、`pnpm verify:desktop`、`pnpm verify:behavior` 和 `pnpm verify:characters`。
- `git diff --check` 必须无 whitespace error。
- 开发模式真实窗口、真实 DeepSeek 账号响应、鼠标交互和真实 Windows 回收站继续标记为待用户人工确认；自动化不得冒充人工证据。

