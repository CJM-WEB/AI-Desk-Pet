# DeepSeek 文件工具兼容性设计

**日期：** 2026-08-22  
**状态：** 用户已授权按推荐方案自主实施  
**范围：** 仅 Desktop 的 DeepSeek/OpenAI-compatible 文件能力规划边界

## 1. 背景与现状证据

用户在当前 Desktop 开发进程中发送“帮我把当前目录下的empty文件夹删除了”。普通聊天“你好呀”能够正常返回，证明 API Key、基础网络和普通聊天链可用；文件请求则稳定显示 `CAPABILITY_PLAN_PROTOCOL_INVALID` 的公开错误：“能力任务需要先调用真实工具，或提出格式正确的澄清问题。”

当前代码事实如下：

1. `CapabilityIntentRouter` 已把完全相同的句子判为 `file_task`，定向测试 151 项通过，因此本故障不是文件意图漏判。
2. `AgentLoop` 已禁止模型在首次真实工具结果前用普通文字自行索要执行确认；模型连续违约时稳定失败，定向测试 36 项通过。
3. `OpenAICompatibleProvider` 将内部工具定义原样发送给 DeepSeek。内部工具名使用 `builtin.files.delete_file` 等带点名称，并且请求没有携带 `tool_choice`。
4. DeepSeek Chat Completion 的工具名只允许字母、数字、下划线和连字符；存在工具时默认 `tool_choice=auto`，模型仍可选择返回文字。官方 `deepseek-v4-flash` 支持 Tool Calls，因此问题不是模型完全没有工具能力。
5. DeepSeek 思考模式的工具调用要求后续请求回传 `reasoning_content`；当前公共 `ModelMessage` 不保存该 Provider 私有字段。
6. 真正的文件执行层已经具备授权根、相对路径、链接/Junction 防护、独占创建、确认后身份复核和 Windows 回收站删除。本次错误发生在 `FileToolService` 被调用之前。

上游协议依据：

- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [开源复用候选调研](../../research/2026-08-22-file-tool-reuse-candidates.md)

## 2. 目标

- 让参数完整的 DeepSeek 文件能力请求在首次真实工具结果前必定产生结构化工具调用。
- 对 Provider 使用符合其协议的工具别名，同时保留内部可信工具名和现有安全裁决。
- 只有缺少执行必需参数时才允许模型通过无权限的结构化澄清工具提问；模型不得自行索要执行确认。
- 写操作只显示宿主生成的确认卡，确认后仍由现有 `FileToolService` 执行。
- 工具完成后只允许依据本地真实结果生成总结，不重复执行工具。
- 用真实 DeepSeek/OpenAI-compatible 请求与响应形状建立契约测试，避免脚本 Provider 掩盖兼容性问题。

## 3. 非目标

- 不替换 `packages/file-tools`、Node `fs/promises` 或 Electron `shell.trashItem`。
- 不引入 OpenAI Agents JS、Cline、Gemini CLI、Codex 或第二套 AgentLoop。
- 不开发、恢复或启用 MCP client、server、工具注册、Renderer 入口或运行时。
- 不在本子项目实现 PowerShell、角色行为、缩放、碰撞几何、拖拽或工作台发布一致性。
- 不把模型声明当成本地操作结果，不放宽逐次确认、授权根或路径安全规则。

## 4. 方案比较与裁决

### 4.1 采用：Provider 边界兼容层

在现有 OpenAI-compatible Provider 内完成工具名编码、响应名解码和工具选择策略序列化。内部状态机、权限策略和文件实现保持不变。

优点：修改面最小；故障修复位于真实断点；不会形成第二套权限系统。  
代价：需要维护一个严格、可测试的 Provider 工具名映射。

### 4.2 不采用：所有 Provider 共用的大型重构

统一重写 OpenAI、DeepSeek、Anthropic 和 Gemini 的工具协议可以降低长期重复，但当前只有 DeepSeek/OpenAI-compatible 边界有现场证据，立即跨 Provider 重构违反最小修改原则。

### 4.3 不采用：替换 Agent 框架或文件核心

开源框架提供成熟的审批生命周期，但不能替代本项目的授权 generation、真实路径和实体身份检查。整套引入会复制会话与权限状态机；替换文件 API也无法触及工具调用前的故障点。

## 5. 架构与接口

### 5.1 内外工具名分离

内部继续使用现有 `ToolName`：

```ts
type InternalToolName =
  | 'builtin.files.list_files'
  | 'builtin.files.read_file'
  | 'builtin.files.create_file'
  | 'builtin.files.apply_patch'
  | 'builtin.files.delete_file';
```

OpenAI-compatible 请求边界使用 Provider 安全名称：

```ts
type ProviderToolName = string;

interface ProviderToolNameCodec {
  encode(internalName: ToolName): ProviderToolName;
  decode(providerName: ProviderToolName): ToolName;
}
```

首版使用固定、可逆、无碰撞映射，例如：

```text
builtin.files.delete_file ↔ builtin_files_delete_file
```

不采用运行时简单替换后直接信任结果。构造 Codec 时必须验证：

- 外部名满足 `^[A-Za-z0-9_-]{1,64}$`；
- 一个外部名只映射一个内部名；
- 一个内部名只映射一个外部名；
- 响应中的未知外部名稳定失败，不能穿透到 `ToolRegistry`。

### 5.2 结构化澄清工具

能力规划工具表额外包含一个不具备文件、进程或系统权限的控制工具：

```ts
type CapabilityClarificationRequest = Readonly<{
  question: string;
}>;
```

其内部名固定为 `builtin.capability.request_clarification`，Provider 别名固定为合法名称 `builtin_capability_request_clarification`。`AgentLoop` 在 `ToolRuntime` 之前识别并严格校验该请求：问题必须非空、不超过 1000 字符，并且不能是“是否确认执行”一类宿主确认。合法请求只公开一条问题并结束本轮，不生成 `pending_action`，也不接触文件系统。

新路径通过后删除旧的文本 JSON `clarification_required` 解析器及只服务该协议的测试，避免同时保留“文本澄清”和“工具澄清”两条正式路径。

### 5.3 工具选择策略

`ModelRequest` 新增封闭策略，不让 Provider 自行猜测：

```ts
type ToolChoicePolicy = 'auto' | 'required' | 'none';
```

状态规则：

1. 普通聊天：`tools=[]`，策略为 `none`。
2. 能力规划首次真实工具结果前：真实能力工具与结构化澄清工具同时存在，策略为 `required`。
3. 只读工具结果后：策略为 `auto`，允许继续调用下一工具或根据真实结果总结。
4. 写工具完成后：工具表为空，策略为 `none`，只允许总结本地结果。
5. 参数缺失时不依赖普通文本自由发挥；Provider 必须调用结构化澄清工具。

Provider 只序列化自身支持的策略。DeepSeek/OpenAI-compatible 映射为 `tool_choice`；其他 Provider 本子项目不改变。

### 5.4 DeepSeek 能力任务推理模式

能力任务在 DeepSeek/OpenAI-compatible 请求上显式设置非思考模式，避免把 Provider 私有 `reasoning_content` 扩散到公共会话契约。普通聊天继续使用用户现有模型参数，不受本设计影响。

如果未来需要能力任务思考模式，必须另立规格，完整定义 `reasoning_content` 的仅 Main 内部保存、续传、取消、日志脱敏和跨 Provider 隔离；本次不提前实现。

## 6. 数据流

```text
用户明确文件请求
  → CapabilityIntentRouter: file_task
  → CapabilityTaskAdapter 冻结 Provider、授权与工具表
  → AgentLoop 首轮：toolChoice=required
  → OpenAICompatibleProvider 编码工具名并关闭能力任务思考模式
  → DeepSeek 返回真实能力 tool_call 或结构化澄清 tool_call
  → ProviderToolNameCodec 解码并拒绝未知名称
  → 澄清工具：AgentLoop 校验并只公开问题，然后结束本轮
  → ToolRegistry 校验内部名、参数、风险和权限
  → FileToolService.preview 生成不可伪造动作
  → Renderer 显示宿主确认卡
  → 用户确认
  → FileToolService.executeWrite / shell.trashItem
  → AgentLoop 续跑：tools=[]、toolChoice=none
  → DeepSeek 只能依据本地工具结果总结
```

模型从始至终拿不到授权根真实绝对路径、actionId 私有载荷、文件系统端口或 Electron 能力。

## 7. 错误处理

- 无工具可用却要求 `required`：在 Provider 调用前返回稳定内部错误，不发送畸形请求。
- 工具别名冲突：组合阶段失败，不启动能力任务。
- 未知响应别名：返回 `PROVIDER_UNKNOWN_TOOL_CALL`，不进入 ToolRegistry。
- 澄清工具问题为空、超长或伪装宿主确认：返回 `CAPABILITY_CLARIFICATION_INVALID`，不公开模型正文。
- DeepSeek 返回文字而非必需工具调用：保留一次协议修复；连续违约返回 `CAPABILITY_PLAN_PROTOCOL_INVALID`。
- 工具参数非法：保留一次 `INVALID_TOOL_REQUEST` 修复；第二次失败。
- 确认、授权、会话 generation 或目标身份变化：沿用现有 `ACTION_EXPIRED`/冲突错误。
- 本地写入成功但总结失败：保留“本地操作已成功，模型总结失败”的事实分离。
- 日志不得记录 API Key、Authorization、绝对路径、文件正文、原始 Provider 正文或工具私有参数。

## 8. 测试设计

执行 RED → GREEN → REFACTOR，并保持每个失败只指向一个兼容缺口。

### 8.1 Provider 单元契约

- RED：带点内部名不得原样出现在 DeepSeek 请求中。
- RED：外部工具名满足官方字符集和 64 字符上限。
- RED：合法外部别名反向恢复内部名；未知别名、冲突别名和伪造别名拒绝。
- RED：`required/auto/none` 精确序列化为 `tool_choice`。
- RED：能力任务显式关闭思考模式；普通聊天不覆盖用户模型参数。
- RED：工具调用与非空普通正文并存继续视为畸形响应。
- RED：结构化澄清工具使用合法 Provider 别名，并与全部真实工具别名无碰撞。

### 8.2 AgentLoop 状态测试

- RED：首次真实结果前请求策略为 `required`。
- RED：只读结果后允许 `auto` 继续规划。
- RED：写结果后工具表为空且策略为 `none`，不能重复删除或创建。
- RED：真正缺失参数必须通过澄清工具公开问题；空问题、超长问题和执行确认问题拒绝。
- RED：模型自行索要确认仍被拦截；确认只能来自宿主卡片。
- RED：旧文本 JSON `clarification_required` 不再作为正式成功路径。

### 8.3 Desktop 纵向测试

- 使用与 DeepSeek 官方相同的 OpenAI-compatible `tool_calls` fixture，覆盖“删除空目录”和“创建文件”。
- 断言首次公开确认是 `pending_action`，不是模型消息。
- 确认前文件系统不变；确认后读取本地真实结果。
- 删除失败、取消、超时和回收站失败不得发布成功。
- 普通“你好呀”继续走零工具聊天。
- 文件授权关闭或授权根缺失时不向 Provider暴露工具。

### 8.4 最低门禁

```powershell
pnpm.cmd --filter @myself/agent-core test
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
git diff --check
```

真实 DeepSeek API与真实 Windows 回收站仍需人工验证；没有实际观察时必须标记为“待用户人工确认”。

## 9. 迁移、删除与复用记录

- 不迁移持久数据；工具别名只存在于 Provider 请求边界。
- 不保留“内部点名原样发送”和“Provider 安全别名”两条生产路径；DeepSeek/OpenAI-compatible 统一走 Codec。
- 新路径通过后删除旧文本 JSON 澄清解析器、只服务原样工具名序列化的重复测试或 helper。
- 不复制上游源码。生命周期设计参考 OpenAI Agents JS、Cline、Gemini CLI 和 Codex，固定版本、许可证与裁决见开源调研文档。
- `diff@8.0.2 → 8.0.3` 安全升级是独立任务，不与本兼容修复混改。

## 10. 验收标准

1. `deepseek-v4-flash` 收到合法工具名和明确工具选择策略。
2. 完整删除请求不再公开模型文字确认，而是显示宿主生成的删除确认卡。
3. 用户确认后空目录由现有回收站端口处理，可恢复；取消时不执行。
4. 完整创建请求显示创建确认卡，同名目标不覆盖。
5. 参数缺失时只通过结构化澄清工具提出一条必要问题，不伪造确认。
6. 普通聊天、其他 Provider 和文件安全边界没有回归。
7. MCP 运行时、Agent 和 Renderer 入口继续禁用。
