# DeepSeek Harness 轻量 Agent 复用审查

**日期：** 2026-08-22

**上游范围：** `deepseek-ai/deepseek-harness` 的 `dsh-v0.1.1-rc.2`，固定提交 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

**本地范围：** `packages/agent-core`、`packages/file-tools`、`apps/desktop` 的 Provider、工具注册、确认与 PowerShell 运行链

**约束：** 只读研究；没有复制上游代码、安装依赖、修改生产实现、启用 MCP 或运行 GUI

**结论状态：** 可作为后续规格与 TDD 任务输入，不等同于功能已通过真实 DeepSeek 或 Windows 人工验收

## 1. 裁决摘要

DeepSeek Harness 是有价值的一手参考，但不应整套接入，也不应替换本项目已有轻量 Agent。固定版本仍明确处于“开发者预览”，并警告未来存在破坏性兼容变更；它采用 Cordis 驱动的“一切皆插件”架构，能力面覆盖 Web/TUI、持久会话、并行工具、后台任务、沙箱、MCP、子 Agent、技能、图像与 Files API，远大于桌宠当前的五个文件工具和一个前台 PowerShell 工具。[上游说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/README.zh.md#L5-L11)

本项目当前已经具备用户最关心的核心链路：

- `AgentLoop` 已实现“模型请求 → 结构化工具请求 → Main 端校验与确认 → 真实工具结果回填 → 模型总结”的有界循环，并把首次可信工具结果作为成功事实边界。
- `FileToolService` 已实现列表、读取、独占创建、精确补丁和回收站删除；路径只能是授权根内相对路径，禁止绝对路径、UNC、`..`、符号链接和 Junction。
- `PowerShellTool` 已实现固定工作目录、非交互前台执行、环境白名单、总超时、静默超时、取消、进程树清理和每流 256 KiB 输出上限。
- `OpenAICompatibleProvider` 已按 DeepSeek Chat Completions 工具协议发送 `tools` / `tool_choice`，解析 `message.tool_calls`，回传 assistant 工具调用与 `role: tool` 结果，并在能力任务中关闭 thinking。
- 2026-08-22 自动验收已用 DeepSeek 兼容 fixture 覆盖创建、删除、澄清和普通聊天，最终 `verify:desktop` 通过；但真实 DeepSeek API、真实回收站和开发模式窗口仍被准确标为“待用户人工确认”。这意味着当前最优下一步是运行真实桌宠纵向验收，而不是先换 Agent 框架。

建议只吸收四类边界思想：

1. 工具调用结果必须按模型顺序持久化或回填；取消后不再启动新调用，已启动调用收敛后再结束。
2. Provider 自身设置请求/流空闲超时，而不是只依赖外层取消信号。
3. 命令输出保留尾部或稳定头尾，并显式标记截断；本项目不应照搬可暴露绝对路径的 spill 文件。
4. DeepSeek thinking 模式若未来用于工具调用，应保留并回传 `reasoning_content`；当前能力任务固定关闭 thinking，因此不是现有文件操作阻塞项。

当前不建议复制任何 Harness 源码，也不建议增加 `@deepseek-ai/dsh-*` 运行时依赖。已有安全实现比上游默认文件工具更贴合桌宠边界：Harness 的 `write` 会覆盖既有文件，公开的 `tool-fs` 也没有专用删除工具；本项目则禁止创建时覆盖，并只把单个文件或空目录送入 Windows 回收站。

| 上游部分 | 复用级别 | 当前裁决 |
| --- | --- | --- |
| 工具结果封闭联合、按模型顺序回填、取消后排空 | 借鉴架构 | 转化为现有 `AgentLoop` / `AgentService` 的测试不变量 |
| Provider 空闲 deadline、输出尾部/头尾保留 | 可最小实现同等行为 | 只在真实验收证明缺口后，在现有模块中自行实现，不复制运行时 |
| 文件 `write` / `edit`、PowerShell result DTO | 借鉴接口与展示思想 | 保留本项目独占创建、精确补丁、回收站和逐次确认语义 |
| Cordis、完整 AgentLoop、并行池、持久会话、后台 job、沙箱框架 | 不采用 | 过重且会形成第二套核心/权限体系 |
| MCP、subagent、技能、Files API、Web/TUI | 明确排除 | 与用户和项目边界冲突或不属于简单本地操作 |

## 2. 上游身份、成熟度与许可证

| 项目 | 固定版本 | 固定提交 | 许可证 | 本次复制情况 |
| --- | --- | --- | --- | --- |
| `deepseek-ai/deepseek-harness` | `dsh-v0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | MIT，Copyright © 2026 DeepSeek | 无；只引用永久链接并借鉴设计思想 |

固定提交由官方仓库 `HEAD`、指向同一对象的 tag 和根 `package.json` 的 `0.1.1-rc.2` 交叉确认。仓库许可证允许使用、复制、修改、合并和分发，但复制软件或其实质部分时必须保留版权声明与许可文本；软件按“原样”提供且不承担担保责任。[MIT 原文](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE#L1-L20)

本次没有复制代码，因此没有新增随包许可证文件或第三方声明义务。若后续复制任何函数或实质代码片段，实施报告必须重新记录：固定提交、源文件与行、复制片段、本地修改、测试，以及在分发物中保留 MIT 版权和许可文本的具体位置。若直接打包上游 package，还需要同步审查其 [`THIRD_PARTY_NOTICES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/THIRD_PARTY_NOTICES.md)。

## 3. 上游可复用部分

### 3.1 工具调用循环：借鉴架构，不移植运行时

Harness 的具体循环在 `dsh-agent-loop` 中保持唯一，其他行为通过插件扩展。[包职责](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/README.zh.md#L5-L15) 循环在模型返回工具块后执行工具，再进入后续步骤；取消由同一 `AbortSignal` 贯穿请求与工具执行。[循环入口](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/agent.ts#L334-L415)

它最有价值的部分是调用调度不变量：独占调用形成屏障，并行调用使用有界池；策略、结果与结果上下文始终保持模型顺序；取消阻止新调用启动，已启动调用被排空；未启动调用产生明确的取消结果而不是伪造成功。[工具调度](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L41-L96) [结果提交](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L113-L156) [取消结果](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts#L199-L285)

Harness 还把工具结果定义为关闭联合：成功带 `isError:false`、值和展示内容；失败带 `isError:true`、错误和展示内容，不能同时携带成功值；结果先经过声明的输出 Schema，再成为 `tools/result`。[工具结果类型](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts#L556-L580) [结果校验与物化](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts#L1793-L1822) 这一点适合用于复核本项目“本地工具返回值是成败唯一事实来源”的测试，而不需要复制类型实现。

对本项目的裁决：

- **借鉴：** “结果按请求顺序回填”“取消后不补充新调用”“内部调度失败不能伪造工具结果”。这些适合成为当前 `AgentLoop` 和 `AgentService` 的回归测试语言。
- **不移植：** 并行工具池、持久 session event log、inbox/steer/followup、插件事件总线。桌宠当前每轮只接受一个 `tool_call`、最多四轮，文件与命令又全部需要宿主安全裁决；并行化会扩大确认与竞态复杂度，没有当前收益。
- **不依赖 package：** `@deepseek-ai/dsh-agent-loop` 的 peer 依赖包含 Agent、LLM、Scope、Session、持久化、System Prompt、Tools、Settings 和 Cordis，接入会形成第二套核心体系。[依赖清单](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/package.json#L32-L59)

### 3.2 文件创建与修改：借鉴预览，不复用执行语义

Harness `write` 工具先解析模型参数、解析 session 工作目录与沙箱策略，再调用文件后端写入，并把调用前和结果时差异作为展示元数据。[写入工具](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/write.ts#L58-L147) `edit` 工具用字面量唯一匹配进行定向替换，并在结果中携带实际差异。[编辑工具](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/edit.ts#L42-L165)

上游本地文件 Provider 自身也有值得参考的“目标加锁 + 创建/版本意图 + 原子发布”边界，能拒绝盲覆盖、目标消失或版本变化。[写入锁与版本意图](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts#L166-L218) [锁内定向修改](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts#L221-L254) 本项目已通过独占创建、基础正文 SHA-256、原子替换和确认后身份复核实现同类目标，无需再引入该 Provider。

但其默认语义不适合直接用于桌宠：

- `write` 的提示明确说明既有文件会被覆盖；本项目 `create_file` 使用独占创建并拒绝 `TARGET_EXISTS`，安全边界更严格。
- Harness `tool-fs` 对外只声明 `read`、`write`、`edit`，没有专用删除工具。[包说明与依赖](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/package.json#L1-L49) 通过 PowerShell 删除会绕过桌宠“单条目、空目录、回收站、逐次确认”的专用契约。
- Harness 路径可由模型提供绝对路径并由沙箱策略约束；本项目要求模型只能拿到授权根内相对路径，不能降低为普通 `cwd` 约束。

对本项目的裁决：

- **借鉴架构：** 调用前差异卡与执行后真实差异分离；失败结果不展示成功差异。
- **不移植代码：** `write.ts`、`edit.ts` 或其 Cordis 工具注册层。
- **保留现有实现：** `FileToolService.preview → executeWrite`、独占创建、补丁基础哈希、原子替换、删除身份复核与回收站端口。

### 3.3 PowerShell 与程序执行：局部借鉴结果 DTO

Harness 的 `pwsh` 工具把命令、说明、超时、工作目录、后台执行与沙箱升级组合成一个大能力面；前台结果显式返回退出码、信号、超时、取消、stdout/stderr 和截断状态。[参数与结果](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/tool-pwsh/src/index.ts#L62-L114) [执行路径](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/tool-pwsh/src/index.ts#L347-L407)

其本地执行器为请求填充并封顶 timeout，固定 cwd，分别限制 stdout/stderr，使用同一 deadline 合并上游取消与运行超时。[执行规格](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/pwsh-local/src/index.ts#L185-L206) [运行与取消](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/pwsh-local/src/index.ts#L255-L285) 底层 subprocess 在 Windows 使用 `taskkill /T /F` 做进程树终止，并用有界内存尾部加可选 spill 文件处理长输出。[进程树终止](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subprocess/subprocess-local/src/spawn.ts#L258-L307) [有界输出](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/subprocess/subprocess-local/src/spawn.ts#L95-L248)

本项目已经具备更窄的前台版本：模型不能提供任意 cwd，所有 PowerShell 逐次确认，使用 `-NoProfile -NonInteractive`、`shell:false`、环境白名单、静默与总超时、取消和 Windows 进程树清理。通过 PowerShell 可以启动普通命令行程序，因此当前没有必要增加第二个“程序执行”工具。

可做的最小改进只有一个候选：当前 `appendBounded` 保留流的开头，超限后丢弃尾部；命令失败诊断通常位于末尾。可借鉴 Harness 的尾部保留思想，改为稳定头尾或尾部，并保留 `stdoutTruncated` / `stderrTruncated`。不要照搬 spill 文件路径：完整命令输出和绝对路径不得进入 Renderer 非必要状态或模型历史。

明确排除：后台 job、PTY、持久 shell、模型自选 workdir、`danger-full-access`、沙箱模式升级、Windows ACL runner。它们会扩大进程生命周期和权限面，不符合当前前台轻量执行目标。

### 3.4 确认、失败事实与取消：借鉴 fail-closed，不替换宿主确认

Harness 的 approval service 把请求限定在当前 turn，只有 `allowed-once` 是授权；缺少或抛错的答复器归一化为 `unavailable`，abort 返回 `cancelled`，迟到答复被丢弃；ask/outcome 成对记录。[请求契约](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/index.ts#L150-L174) [关闭式裁决](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-approval/src/index.ts#L239-L343)

这验证了本项目现有方向，但不能取代它：桌宠的确认还绑定授权根、Provider、配置、会话 generation、过期时间、不可伪造的 `VerifiedWriteAction` 对象和确认后的目标身份。Harness 的 approval 只回答一次工具调用是否允许，并不自动满足这些文件系统不变量。

尤其要注意，Harness 正式文件/命令组合中的 approval 主要服务于沙箱拒绝后的权限升级重试，不等同于桌宠要求的“每次创建、修改、删除和 PowerShell 都先确认”；其权限预设还包含无沙箱且不询问的 `danger-full-access` 组合，不能进入本项目。[升级审批](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sandbox/sandbox/src/escalation.ts#L143-L187) [权限预设](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/permission-presets.md#L9-L44)

对本项目的裁决：继续使用 `PendingActionStore` 和 Electron Main 确认卡；把上游“无答复器、答复器抛错、取消、迟到答复一律 fail-closed”作为测试补充检查，不引入 `@deepseek-ai/dsh-user-approval`。

### 3.5 DeepSeek 协议适配：当前主干已匹配，保留两个审查点

DeepSeek 官方协议明确：模型只返回函数调用，具体函数必须由调用方执行；调用方把 assistant 工具调用和带相同 `tool_call_id` 的 `role: tool` 结果加入消息，再请求模型总结。[官方 Tool Calls 指南](https://api-docs.deepseek.com/guides/tool_calls/#non-thinking-mode) Chat Completions 参考支持 `tools`、`tool_choice` 的 `none` / `auto` / `required`，以及 `message.tool_calls`。[官方 API 参考](https://api-docs.deepseek.com/api/create-chat-completion/#request)

Harness 的 DeepSeek adapter 做了三件值得核对的事：

1. assistant 历史序列化保留 `tool_calls`，tool 结果转为 `role: tool` 并回填 `tool_call_id`。[消息序列化](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/serialize.ts#L198-L267)
2. thinking 模式下，携带推理的 assistant 历史回传 `reasoning_content`；工具调用只含工具时使用空字符串而不是 `null`。[thinking 回传](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/serialize.ts#L198-L230)
3. adapter 自己设置流空闲 watchdog，取消或空闲超时均终止 fetch/迭代器；不把传输失败误写成模型成功。[空闲超时与取消](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/adapter.ts#L433-L508) [HTTP 失败事实](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/adapter.ts#L601-L663)

本项目当前能力任务固定 `reasoningMode: 'disabled'`，Provider 对 DeepSeek 发送 `thinking: { type: 'disabled' }`，因此不需要为文件/PowerShell 任务移植 `reasoning_content` 回传。当前 Provider 也已正确实现 assistant `tool_calls`、tool 结果和 `tool_choice`。

仍有两个真实审查点：

- `OpenAICompatibleProvider` 只把外层 `AbortSignal` 传给 fetch，静态代码中未看到 adapter 自身的总请求或空闲超时。可在真实 API 验收后，以最小 TDD 增加 Provider deadline；不要引入 Harness 全套 streaming adapter。
- Provider 明确拒绝一次响应中的多个 `tool_calls`。这符合当前“简单操作、逐次确认、串行工具”的产品边界，不是当前缺陷；只有真实需求证明需要无依赖的多个只读调用时，才单独设计有界串行或并行策略。

Harness 的 SSE 解析会按 `call.index` 累积被拆分到多个 delta 的工具 id、名称与参数，并要求最终出现 `[DONE]`；未知结束原因或截断流会形成失败事实，而不是成功。[工具调用 delta](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/translate.ts#L127-L184) [SSE 完整性](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek/src/sse.ts#L17-L40) 本项目当前使用非流式 Chat Completions，简单文件/命令任务不需要为了这一能力引入 SSE；若以后正式增加流式聊天，再以独立规格处理增量 JSON、取消与截断，不与当前修复捆绑。

DeepSeek `strict` 工具模式仍是 Beta，需要 `/beta` base URL、每个 function 设置 `strict:true`，并受限于其 JSON Schema 子集；例如 string 的 `minLength` / `maxLength` 不受支持。[官方 strict 说明](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta) 当前工具 schema 使用这些长度限制，且宿主会再次严格校验参数并只允许一次协议修复，所以本阶段不应为 strict 模式改 endpoint 或削弱本地 Schema。

## 4. 本项目现状对照

| 能力 | 当前事实 | 与 Harness 对比 | 裁决 |
| --- | --- | --- | --- |
| 工具循环 | `packages/agent-core/src/agent-loop.ts:113-253` 最多四轮；首次工具结果前普通文本只修复一次；确认后仅允许无工具总结 | Harness 更通用、可并行、可持久化 | 保留现有轻循环 |
| 工具 Schema 与权限 | `apps/desktop/src/main/agent/tool-registry.ts:51-105` 先校验注册、启用状态和严格参数，再由本地风险策略裁决 | Harness 依赖 Cordis tools/approval/sandbox 插件 | 保留现有 Main 裁决 |
| 路径安全 | `packages/file-tools/src/path-policy.ts:31-150` 拒绝绝对路径、UNC、`..`、链接/Junction 和越界真实路径 | Harness 允许更宽的 cwd/沙箱模式 | 本项目更符合授权根契约 |
| 文件创建 | `packages/file-tools/src/file-tool-service.ts:288-299,343-355` 预览后独占创建且不覆盖 | Harness `write` 可覆盖 | 不移植 |
| 文件修改 | `packages/file-tools/src/file-tool-service.ts:301-320,357-363` 精确补丁、基础 SHA-256、原子替换 | Harness `edit` 是字面量替换 | 保留 jsdiff 路线 |
| 文件删除 | `packages/file-tools/src/file-tool-service.ts:322-375` 只允许单文件或空目录，确认后复核身份，再进回收站 | Harness `tool-fs` 无专用删除工具 | 本项目更适合桌宠 |
| 确认票据 | `apps/desktop/src/main/agent/pending-action-store.ts:43-98` 一次性 token、TTL、覆盖/取消/配置变化/退出清理 | Harness approval 提供 turn 内 fail-closed | 保留现有并补充竞态测试即可 |
| PowerShell | `apps/desktop/src/main/agent/powershell-tool.ts:76-86,107-265` 固定前台、cwd、环境、超时、取消和有界结果；`269-306` 隐藏窗口并终止进程树 | Harness 还支持后台 job、沙箱升级与 spill | 不扩大能力面；可改进输出截断策略 |
| DeepSeek 工具协议 | `apps/desktop/src/main/providers/openai-provider.ts:112-177,213-248` 序列化/解析 tool call，使用外部工具名 codec，发送 `tool_choice` 和 thinking 开关 | Harness 支持 streaming、thinking 回传、多调用 | 当前简单任务足够；补 Provider deadline 评估 |
| 自动/人工证据 | `docs/operations/lightweight-agent-acceptance.md` 记录 fixture 与门禁；真实 API、真实回收站、dev 窗口待确认 | Harness 源码不能替代本项目纵向证据 | 优先真实桌宠验收 |

## 5. 真实缺口与建议顺序

### 5.1 当前必须先验证

1. 使用用户当前 `deepseek-v4-flash` 配置启动开发版桌宠。
2. 先发“你好呀”确认普通聊天链，再分别验证创建文件、修改文件、删除空目录和受控 PowerShell。
3. 检查每个能力任务是否先出现宿主确认卡；确认前无副作用；确认后以本地工具结果为事实；失败时不发布成功。
4. 验证取消、reset、设置变更和窗口关闭会清理请求、确认与进程。

这些步骤能区分真实缺口位于 Provider 未生成 `tool_calls`、adapter 解析、意图路由、确认链、底层文件端口还是启动了旧进程。仅从截图或 Harness 源码无法再安全缩小根因。

### 5.2 证据成立后可做的最小 TDD 候选

1. **Provider 请求 deadline：** 若真实 DeepSeek 请求能长时间无响应，先写 fake fetch 延迟 RED，再为当前 Provider 加总时限；无需 streaming、SSE 或 Harness adapter。
2. **输出头尾保留：** 先写超长 stderr 尾部错误被丢失的 RED，再修改 `appendBounded`；继续只返回文本、截断布尔与退出事实，不暴露 spill 文件。
3. **thinking 工具回传：** 只有产品决定允许 thinking 模式执行工具时，才为 `reasoning_content` 加协议字段与多轮 fixture；现有能力任务关闭 thinking，不先做。
4. **专用复制/移动/建目录：** 当前可经逐次确认 PowerShell 完成。只有使用数据证明高频且命令预览体验不足时，才增加窄工具；不得为凑齐 Harness 能力面扩展。

### 5.3 明确排除

- 不引入 Cordis、“一切皆插件”运行时、第二套 AgentLoop、第二套会话历史或第二套审批状态机。
- 不启用、开发或恢复任何 MCP client/server、MCP 工具注册、MCP 设置页或 MCP 进程。
- 不引入 Web/TUI、subagent、技能系统、长期记忆、Files API、图像请求、后台 job、持久 shell、PTY 或完整 sandbox 框架。
- 不开放 `danger-full-access`，不允许模型指定任意绝对 cwd，不把逐次确认宣传为 OS 沙箱。
- 不用 Harness 的覆盖式 `write` 或 PowerShell 永久删除替换本项目的独占创建和回收站删除。
- 不直接依赖 `@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-tool-fs`、`@deepseek-ai/dsh-tool-pwsh` 或 `@deepseek-ai/dsh-llm-deepseek`；其 package 依赖图和生命周期远超当前目标。

## 6. 最终建议

把 DeepSeek Harness 当作官方“边界校验表”，而不是要搬进桌宠的内核：

- **现在零代码移植。** 现有文件与 PowerShell 核心已经比上游默认工具更窄、更符合桌宠安全契约。
- **优先真实运行验收。** 当前自动证据已通过，用户实际失败与真实 DeepSeek/启动进程链仍需在开发模式下观察。
- **只在证据对应的 seam 上补强。** 最值得预留的是 Provider deadline 和命令输出头尾保留；均可在现有 TypeScript 模块中小改完成。
- **保持 MCP 禁用。** Harness 的 MCP 与插件生态不进入复用范围，也不因“官方 Agent”身份而改变项目既定安全边界。

## 7. 一手来源索引

- [DeepSeek Harness 中文 README（固定提交）](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/README.zh.md)
- [DeepSeek Harness MIT LICENSE（固定提交）](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/LICENSE)
- [DeepSeek Harness AgentLoop](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop)
- [DeepSeek Harness 文件工具](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs)
- [DeepSeek Harness PowerShell 工具](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/tool-pwsh)
- [DeepSeek Harness DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-deepseek)
- [DeepSeek 官方 Tool Calls 指南](https://api-docs.deepseek.com/guides/tool_calls/)
- [DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
