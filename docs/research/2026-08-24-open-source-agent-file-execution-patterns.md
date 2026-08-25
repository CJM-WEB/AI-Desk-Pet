# 成熟开源 Agent 的本地文件执行模式研究

**日期：** 2026-08-24
**范围：** 只读研究；不修改生产代码、不安装依赖、不启用 MCP
**目标：** 解释模型为何会口头回复“无法操作”，并给出适合 AI Pet 现有可信边界的最小 tool-call loop 复用方案
**结论状态：** 可作为缺陷诊断和后续规格输入；不等同于实现完成或人工验收通过

## 1. 结论摘要

截图中的问题首先不是 Node 文件 API、Electron 回收站 API 或路径实现失败，而是**模型没有形成可执行的结构化工具请求，或请求没有进入能力任务链**。成熟 Agent 都把“模型文字”和“真实副作用”分成两类事实：模型只能产生 Action/tool call；宿主执行后产生 Observation/tool result；下一轮模型只能基于工具结果总结。OpenHands 的固定源码甚至直接表明：响应有 `tool_calls` 时才转换为可运行 Action；没有时就转换为普通 `MessageAction`。[OpenHands 响应分流](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/function_calling.py#L73-L99) [OpenHands 普通消息回退](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/function_calling.py#L311-L328)

因此，可靠性不能只靠提示词“请使用工具”，必须由协议和宿主共同保证：

1. 明确文件任务进入专用能力链，首次请求只公开白名单工具，并使用 `tool_choice: "required"`；DeepSeek 官方定义 `auto` 允许模型在文字和工具之间自行选择，而 `required` 强制至少调用一个工具。[DeepSeek Chat Completions `tool_choice`](https://api-docs.deepseek.com/api/create-chat-completion/#request)
2. 首次可信工具结果出现前，普通文字拒绝、口头成功或“我不能操作”都不是合法完成；最多进行一次协议修复，仍不调用工具则稳定失败，不把该文字直接显示成任务结果。
3. Electron Main 校验参数、授权根、相对路径、确认状态和目标身份后才执行；工具结果携带原 `tool_call_id` 回灌历史，随后再让模型总结。DeepSeek 官方同时警告工具参数可能是无效 JSON或包含幻觉字段，因此调用方必须自行校验，不能把 Provider 的参数视为授权。[DeepSeek 工具参数边界](https://api-docs.deepseek.com/api/create-chat-completion/#responses)

本项目当前静态代码已经表达上述方向：`packages/agent-core/src/agent-loop.ts:119-157` 对 `capability_planner` 使用 `required` 并拒绝首次普通文字；`apps/desktop/src/main/providers/openai-provider.ts:249-292` 把工具、`tool_choice` 和历史发给 OpenAI-compatible Provider；`packages/file-tools/src/file-tool-service.ts:288-373` 负责预览、可信动作和真实执行。故截图更像以下两类问题之一，需用运行期证据区分：

- 消息被路由到普通聊天链，因而请求实际是 `tools=[]`、`toolChoice='none'`；
- 用户正在运行旧构建，未包含当前能力规划协议或最新 Provider 适配。

在没有去敏运行日志前，不能断言是哪一种，也不应再重写一遍文件底层。

## 2. 研究对象、固定版本与许可证

| 项目 | 固定 tag / commit | 许可证 | 本次复用裁决 |
| --- | --- | --- | --- |
| `deepseek-ai/deepseek-harness` | `dsh-v0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE) | 借鉴有界循环、顺序结果、失败联合、版本保护和原子发布；不引入 Cordis、完整 Harness、MCP、并行池或后台任务 |
| `OpenHands/OpenHands`（原 `All-Hands-AI/OpenHands`） | `0.57.0` / `135d3aea09780748db552d0c73f1f1c795191ed8` | [`enterprise/` 外为 MIT](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/LICENSE) | 借鉴 Action → Runtime → Observation 和确认挂起；不复用其绝对路径、沙箱或文件编辑器 |
| `cline/cline` | `v4.1.12` / `db6d18a98a34f5c0559175b5c49ce0c5031f33f1` | [Apache-2.0](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/LICENSE) | 借鉴工具拒绝/失败回传和逐工具 policy；不复用其完整 AgentRuntime、编辑器或永久删除/移动实现 |

选择 OpenHands `0.57.0` 是为了固定研究用户指定仓库中仍包含 `AgentController`、Action/Observation 和 Runtime 的成熟实现；当前仓库已把 Agent/工具核心迁移到独立 SDK，直接研究当前前端主干无法回答原执行链问题。[OpenHands `0.57.0` 发布页](https://github.com/OpenHands/OpenHands/releases/tag/0.57.0)

本次没有复制任何上游源码，所以没有新增第三方代码或分发义务。若后续复制实质代码，必须重新记录源文件、固定提交、复制片段、本地修改和许可证保留位置。

## 3. 为什么模型会口头说“无法操作”

### 3.1 `tools` 只是能力声明，不是执行保证

DeepSeek 官方协议中，`tools` 只是可供模型选择的函数清单；当 `tool_choice` 为 `auto` 时，模型可以返回普通消息，也可以返回工具调用。只有 `required` 或指定具体函数时，协议才强制工具调用。[DeepSeek Chat Completions 请求契约](https://api-docs.deepseek.com/api/create-chat-completion/#request)

三个开源项目均能观察到“无工具调用即结束/普通消息”的明确分支：

- DeepSeek Harness 把 assistant 消息持久化后筛选 `tool-call`；若数量为零，步骤直接以 `completed` 结束。[Harness AgentLoop](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/agent.ts#L400-L418)
- OpenHands 只在 `assistant_msg.tool_calls` 存在时解析为 Action；否则创建等待用户响应的 `MessageAction`。[OpenHands function calling](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/function_calling.py#L73-L99) [普通消息分支](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/function_calling.py#L322-L328)
- Cline `AgentRuntime` 将 assistant 消息加入历史后提取 `tool-call`；没有调用时结束运行，有调用时才执行并加入 tool result 后继续循环。[Cline 主循环](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/agents/src/agent-runtime.ts#L689-L865)

所以，“我无法直接创建文件”并不是文件端口返回的失败；它只是模型选择了文字通道。若应用把这段文字原样当作文件任务结果展示，就绕开了真正的 Agent 执行链。

### 3.2 正式 loop 必须区分三类结果

文件任务至少要把模型输出分成三个互斥分支：

| 模型输出 | 宿主处理 | 是否可公开为任务结果 |
| --- | --- | --- |
| 合法业务工具调用 | 严格解析 → Main 裁决 → 预览/确认/执行 | 只有真实工具结果产生后才可总结 |
| 合法结构化澄清调用 | Main 根据固定枚举生成问题，不赋予文件权限 | 可以公开固定澄清文案 |
| 普通文字、未知工具、无效参数 | 首次只允许一次协议修复；再次出现则稳定失败 | 不得当作“操作结果”直接展示 |

单靠自由文本提示不能建立这个不变量。DeepSeek Harness 会把工具调用参数解析、工具注册、执行结果与持久 session event 分层，并把每个结果与原调用关联；其工具调度在取消时停止新调用、排空已启动调用，并按模型顺序提交结果。[Harness 调度入口](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L59-L100) [Harness 顺序提交](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L145-L180) [Harness 调用/结果关联](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L248-L288)

Cline 也把未知工具、policy 拒绝、审批失败和执行异常都归一化为带 `isError` 的 tool-result 消息，再进入下一轮，而不是伪造成成功或丢失该调用。[Cline 工具准备与审批](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/agents/src/agent-runtime.ts#L1670-L1807) [Cline 执行与结果回传](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/agents/src/agent-runtime.ts#L1809-L1913)

### 3.3 工具结果才是本地事实

DeepSeek Harness 的 DeepSeek adapter 会保留 assistant 的 `tool_calls`，并把结果序列化为带相同 `tool_call_id` 的 `role: 'tool'` 消息；这正是下一轮模型知道“宿主实际做了什么”的依据。[Harness DeepSeek 历史序列化](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/serialize.ts#L213-L267)

OpenHands 使用同等的 Action/Observation 模型：Agent 产生 Action，Runtime 执行并产生 Observation，EventStream 把 Observation 送回 Controller。[OpenHands 架构与控制流](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/README.md#L1-L49) Controller 还明确要求 runnable action 必须有 Observation，否则 reset 时会补 ErrorObservation，避免历史中存在“有调用、无结果”的半条记录。[OpenHands pending action 完整性](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/controller/agent_controller.py#L519-L547) [OpenHands reset 完整性](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/controller/agent_controller.py#L590-L623)

对 AI Pet 的直接含义是：

- UI 的“已创建”“已删除”只能来自 Main 工具结果；
- 模型总结失败不能回滚已经完成的本地操作；
- 模型口头成功不能创建成功事件；
- 工具失败必须以失败状态结束，后续模型只能解释失败，不能改写事实。

## 4. 创建、删除与重命名的上游实现裁决

### 4.1 DeepSeek Harness：创建/修改机制成熟，但不满足本项目授权模型

Harness 的 `write` 工具先解析参数和沙箱策略，再由文件策略产生 `createIfAbsent` 或 `replaceIfVersion` 意图，最终调用后端写入；结果包含真实 operation 与前后文本，用于结果时差异展示。[Harness `write` 工具](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/write.ts#L100-L148)

本地后端对同一目标使用 FIFO 锁，将探测、版本校验和写入串在一起；`createIfAbsent` 遇到既有目标会拒绝，`replaceIfVersion` 遇到缺失或版本变化会拒绝，并通过原子发布写入。[Harness 目标锁](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts#L74-L104) [Harness 版本保护与原子写](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts#L166-L218)

可最小复用的是**不变量**，不是代码：

- 预览时的目标状态必须绑定到确认后的执行；
- 确认后目标变化必须拒绝；
- 新建不得盲覆盖；
- 成功展示使用执行后真实结果。

不直接复用的原因：Harness 的模型侧路径允许普通执行世界路径并由沙箱约束，能力面还包含插件、沙箱、后台任务和 MCP；本项目要求模型只提交“授权根标识 + 根内相对路径”，且 MCP 保持禁用。Harness 的公开文件工具也没有本项目需要的“Windows 回收站删除”语义。

### 4.2 OpenHands：Action/Observation 分层值得借鉴，文件执行语义不应复制

OpenHands 的结构化编辑工具声明 `view/create/str_replace/insert/undo_edit`，并要求创建前确认父目录、编辑前先读取；`create` 不能用于已存在文件。[OpenHands 编辑工具说明](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/tools/str_replace_editor.py#L12-L42) 其 parser 将合法工具调用转换为 `FileReadAction` 或 `FileEditAction`，未知参数和未知工具形成稳定协议错误。[OpenHands 文件工具解析](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/function_calling.py#L173-L228)

Runtime 只执行 Action，再返回包含输出和 diff 的 `FileEditObservation`；工具异常被转换为错误字符串，而不是由模型自称成功。[OpenHands 编辑执行器边界](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/runtime/action_execution_server.py#L100-L159) [OpenHands Observation 生成](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/runtime/action_execution_server.py#L565-L589)

不应复制其文件工具：固定版本的 Schema 要求绝对路径，运行时依赖 workspace/sandbox；它没有专用回收站删除或安全重命名工具，也不具备本项目的授权根标识、相对路径、generation 和 Electron Main 确认卡契约。[OpenHands 工具 Schema](https://github.com/OpenHands/OpenHands/blob/135d3aea09780748db552d0c73f1f1c795191ed8/openhands/agenthub/codeact_agent/tools/str_replace_editor.py#L108-L159)

### 4.3 Cline：覆盖增删移动，但其执行语义比桌宠边界更宽

Cline 的 apply-patch grammar 支持 Add、Delete，以及 Update 后的 Move；parser 会拒绝重复操作、缺失源文件和已存在的 Add 目标。[Cline patch grammar](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts#L7-L35) [Cline Update/Move 解析](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts#L131-L172) [Cline Delete/Add 解析](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts#L264-L308)

但其执行器不适合桌宠直接复用：

- 删除调用 `fs.rm(..., { force: true })`，不是 Windows 回收站；
- Add 会递归创建父目录并普通 `writeFile`；
- Move 是“写入目标后删除源”，不是受保护的原子 rename；
- editor 对绝对路径直接放行，`cwd` 限制只应用于相对路径；
- editor 创建文件也使用递归 `mkdir` 和普通 `writeFile`。[Cline patch 执行](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts#L281-L324) [Cline 路径解析](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/editor.ts#L37-L60) [Cline 创建语义](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/editor.ts#L151-L168)

Cline 值得吸收的只是逐工具 policy、审批失败回传和循环继续。其官方文档说明未配置 policy 的工具默认启用并自动批准，这与 AI Pet 的 fail-closed 规则相反；写入工具必须在本项目显式注册并逐次确认。[Cline 权限文档](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/docs/sdk/guides/permission-handling.mdx#L7-L33) 拒绝应成为工具结果，使模型能够解释或调整，而不是让循环卡住。[Cline 拒绝回传](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/docs/sdk/guides/permission-handling.mdx#L153-L161)

## 5. 适合 AI Pet 的正式 tool-call loop

```text
用户消息
  → CapabilityIntentRouter（确定是普通聊天还是明确文件任务）
     ├─ 普通聊天：tools=[]，tool_choice=none
     └─ 文件任务：白名单文件工具 + 结构化澄清工具，tool_choice=required
          → Provider 仅提出结构化请求
          → AgentLoop 严格解析
             ├─ 澄清：Main 映射固定问题后结束
             ├─ 业务工具：Electron Main 裁决
             │    ├─ 只读：立即执行
             │    ├─ 写/删：生成绑定 generation/目标身份的确认卡
             │    └─ 拒绝：生成失败 tool result
             → 真实工具结果按原 tool_call_id 回灌
             → 最终总结请求：tools=[]，tool_choice=none
             → UI 以工具结果决定成功/失败，模型文字只作说明
```

这不是建议建立第二套循环，而是对现有 `AgentLoop`、`ToolRegistry`、`FileToolService`、`PendingActionStore` 和 Provider adapter 的不变量复核。最小修复应先证明请求到底在哪个分支偏离。

### 5.1 创建

继续使用现有 `create_file`：授权根标识 + 相对路径；父目录必须存在；排他创建；不覆盖；确认后重新解析路径与 generation；写入或关闭失败时不发布成功。

### 5.2 删除

继续使用现有 `delete_file`：只允许单个普通文件或空目录；确认后复核目标类型与身份；只调用 Electron Main 注入的 `shell.trashItem`；失败返回稳定错误。不要复用 Cline 的 `fs.rm`，也不要让 Provider 生成 PowerShell 永久删除来绕过专用工具。

### 5.3 重命名

当前已批准的轻量规格没有专用重命名工具；重命名仍应通过逐次确认的 PowerShell 路径处理。截图验收涉及创建和删除，不能借本次缺陷修复擅自扩大工具面。

若以后真实频率证明需要专用 `rename_entry`，应另行批准规格并至少满足：同一授权范围内两个“授权根标识 + 相对路径”；源目标都拒绝链接/Junction；目标必须不存在；确认卡同时显示源和目标；确认后复核源身份、授权 generation 和目标仍不存在；执行结果是唯一成功事实。Cline 的“写目标再删源”不能直接采用，因为中途失败会留下两个条目或丢失源语义。[Cline Move 执行证据](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts#L298-L320)

## 6. 对截图故障的最小诊断顺序

不记录绝对路径、文件正文、API Key 或 Provider 原始全文，只增加或读取以下去敏证据：

1. 记录路由结果：`chat` / `file_task` / `powershell_task`。
2. 记录发往 Provider 的协议元数据：`protocol`、工具名称集合、`toolChoice`，不记录参数正文。
3. 记录响应变体：`text` / `tool_request`、工具名、参数 Schema 是否通过，不记录完整内容。
4. 记录 Main 阶段：`prepared_read` / `pending_confirmation` / `denied` / `executed_ok` / `executed_error`。
5. 用同一纵向用例断言：
   - “在授权目录下创建 abc 文件夹”不能进入普通聊天；若创建目录不是当前工具能力，必须返回宿主固定的结构化澄清或“不支持此操作”状态，不能让模型声称已执行；
   - “创建 empty.txt”必须先出现确认，确认前不落盘，确认后真实存在；
   - “删除 empty 空目录”必须先出现确认，确认后只调用一次回收站端口；
   - 首轮普通文字只触发一次修复，第二次仍为文字则以稳定协议错误结束；
   - 最终总结请求必须是 `tools=[]`、`tool_choice=none`，且总结失败不改变已经发生的本地结果。

需要特别区分“创建文件”和“创建文件夹”。本项目当前正式文件工具有 `create_file`，没有 `create_directory`；截图中用户要求“创建 abc 文件夹”时，系统不应伪装支持，也不应泛化为“完全无法操作文件”。应由现行规格决定是走逐次确认 PowerShell，还是明确提示当前专用文件工具不支持创建目录。该产品决策不同会导致不同实现，必须由主任务规格或用户确认后再改代码。

## 7. 最小复用清单与明确排除项

### 7.1 可在现有模块中实现等价行为

- DeepSeek 官方 `tool_choice: required`：仅用于已经被可信路由认定的能力规划首轮。
- DeepSeek Harness：调用/结果关联、结果顺序、取消后停止新调用、失败联合、目标版本保护和原子发布的不变量。
- OpenHands：Action 与 Observation 分离；挂起确认时不得执行；每个 runnable action 必须有结果。
- Cline：未知工具、拒绝、审批失败和执行异常都回传为明确 tool result；写工具显式配置为需审批。

### 7.2 不采用

- 不引入 DeepSeek Harness、OpenHands 或 Cline 的完整运行时、Agent loop、会话系统或权限系统。
- 不启用或恢复任何 MCP client/server、MCP 工具注册或 Renderer 入口。
- 不把模型、Renderer 或 Preload 变成文件系统执行边界。
- 不接受模型提供绝对路径、UNC、设备路径、`..` 或任意 cwd。
- 不复用 Cline 的永久删除、递归建目录、普通覆盖写或“写后删”的移动实现。
- 不复用 OpenHands 的绝对 workspace 路径与沙箱信任模型。
- 不因 Provider 未调用工具而更换 Node `fs/promises` 或 Electron `shell.trashItem`。

## 8. 最终裁决

此次研究没有发现一个适合整包接入的开源框架；反而证明现有分层方向正确。真正需要严格验证的是**路由、Provider 请求契约、响应解析和工具结果回灌的纵向闭环**。只要首轮允许普通文字直接结束，模型就仍可能说“无法操作”；只要 Main 的真实结果不是唯一事实，模型就仍可能口头伪造成功。

推荐主任务按以下优先级处理：

1. 先用去敏证据确认截图请求进入了 `chat` 还是 `file_task`，并确认正在运行的构建版本。
2. 保持现有 Main/FileToolService，不重写文件底层；对偏离点先补 RED 纵向测试。
3. 修复后强制首轮 `required`、一次协议修复、真实结果回灌和最终 `none` 总结；创建与删除继续沿用现有安全契约。
