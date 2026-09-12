# Agent 框架与执行套件参考资料

研究日期：2026-09-10。

文档性质：为 AI Pet 后续文件操作与任务执行改造提供资料依据；**不是框架采用决定、实施规格或验收报告**。

关联阅读：[项目执行链现状与架构评估](2026-09-10-agent-execution-architecture-review.md)、[现行文件任务规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)、[领域词汇](../../CONTEXT.md)。

## 1. 研究目标与证据边界

本资料回答三个问题：已有实现能接手哪些职责；仍需适配哪些桌宠职责；如何判断替换是否减少维护成本。

本次只阅读官方文档与项目既有约束，没有安装候选框架，没有调用用户的 DeepSeek 凭据，没有运行本地 Qwen 对照实验，也没有修改业务代码。

证据分为以下四类：

| 标记 | 含义 | 能得出的结论 |
| --- | --- | --- |
| 官方资料 | 已核对官方页面内容，关键事实就近链接 | 框架公开提供或描述了相应能力 |
| 项目约束 | 来自现行规格、领域词汇与用户确认 | 候选必须满足的产品条件 |
| 适配判断 | 根据官方能力与项目条件作出的分析 | 值得验证的方向，不代表已经成功 |
| 待验证 | 固定版本、源码或实际运行尚未检查 | 不能据此承诺支持、稳定性或安全性 |

“有完整文档”“有现成接口”“上游宣称适用于生产”均不等于本项目的双模型、Windows、打包和权限边界已经跑通。本资料不以 GitHub 星数替代可靠性证据，也不对未核查的 GA／Beta 状态和许可证作具体结论。

官方站点会更新；搜索索引还可能滞后。进入实施前必须锁定实际版本，再核对该版本的源码、声明文件和发布说明，不能照搬滚动文档中的最新示例。

## 2. 先区分框架、运行时与执行套件

为便于选型，本文采用下列工作分类。产品边界可能重叠，不把一个项目永久归为单一类别。

| 层次 | 主要解决的问题 | 本项目需要注意 |
| --- | --- | --- |
| 模型 SDK／适配层 | 请求、流式输出、工具协议、不同 Provider 的差异 | 能连上接口不代表模型会正确调用工具 |
| Agent 运行时 | 模型与工具之间的连续循环、停止、结果关联、恢复 | 应避免在外面再套一个平行自研循环 |
| 工作流运行时 | 显式步骤、分支、状态、暂停与恢复 | 确定性权限判断不应交给模型反复推测 |
| 执行套件（harness） | 在运行时上整合文件、命令、规划、上下文等能力 | 更接近编程助手，但默认工具与权限仍需逐项审查 |
| 完整产品 | 执行套件加界面、账户、配置、发布与其他产品功能 | 用户需要执行能力，不是把桌宠替换成另一个产品 |

例如，AI SDK 提供 `ToolLoopAgent`；LangGraph 提供底层有状态执行；Deep Agents 在 LangChain／LangGraph 上整合执行套件。三者承担的职责范围不同，不能只比较示例代码行数。[AI SDK 工具循环](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)、[LangGraph 总览](https://docs.langchain.com/oss/javascript/langgraph/overview)、[Deep Agents 总览](https://docs.langchain.com/oss/javascript/deepagents/overview)

Mastra 已有独立 Harness 能力，Pydantic AI 也已有单独的 Harness／Coder。不能沿用“这些框架只有空循环、没有编程能力”的旧印象；需要分清具体选择的是基础包、附加包还是完整产品。[Mastra Harness](https://mastra.ai/docs/harness/overview)、[Pydantic AI Harness](https://pydantic.dev/docs/ai/harness/)

## 3. AI Pet 的比较前提

以下来自现行项目约束，不因采用框架自动改变：

1. 保持 Electron、TypeScript、Windows 桌宠产品结构与单一发送入口。
2. 保持 DeepSeek Provider 和内置 Qwen3.5-4B 量化模型；本地运行器仍为已有 llama.cpp，不以换更强模型掩盖协议问题。
3. Main 持有凭据、真实路径、任务范围、具体许可、命令执行与取消清理的可信裁决权。
4. 普通聊天可以提出无副作用的任务授权申请；实际文件或命令能力只能在 Main 确认范围后开放。
5. 角色人设、动作描述、模型文本、文件正文和角色自主事件均不能扩大授权；角色自主反应不得创建文件任务。
6. 会话上下文与授权生命周期分别设计；保留上下文不等于保留访问许可，持久化恢复也不等于批准继续执行。
7. MCP 保持禁用，网站、CloudBase 与包扫描器的业务、配置和依赖解析保持隔离。
8. 文件正文、路径、截图和剪贴板不得自动进入长期记忆；诊断和遥测不能带走凭据或私有原文。

依据：[领域词汇](../../CONTEXT.md)、[文件任务重构规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)。当前实现与这些约束是否一致，由[项目评估文档](2026-09-10-agent-execution-architecture-review.md)独立记录。

## 4. 候选框架逐项资料

### 4.1 Vercel AI SDK

**定位与语言。** TypeScript 模型与 Agent SDK。`ToolLoopAgent` 封装多步工具调用、结果回注、文本生成和流式响应，提供停止条件及取消信号；工具使用仍要求底层模型支持工具调用。[工具循环 API](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)

**可复用部分。** 模型请求与流处理、工具调用关联、循环推进、停止控制。适合检验我们是否可以删除聊天与任务之间重复的模型协议转换。

**双模型方向。** 官方有独立 `@ai-sdk/deepseek` Provider，也有可配置地址的 OpenAI 兼容 Provider。因此存在保留 DeepSeek 和现有本地接口的接入路径；这是接口层依据，不是本机 Qwen 工具调用成功的证明。[DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)、[OpenAI 兼容 Provider](https://ai-sdk.dev/providers/openai-compatible-providers)

**适配成本与限制。** 采用工具循环不自动得到完整的文件搜索、编辑、补丁、任务范围授权和 Windows 进程管理。应先列清已存在且可复用的工具，再判断剩余适配是否足够小；不能把工具重新实现一遍后称为“换框架”。

**对本项目的用途判断。** 优先作为“简化模型协议和执行循环”的候选。适合已有文件能力可保留、主要问题在入口及会话衔接的情形。

建议阅读顺序：工具循环 API → DeepSeek Provider → OpenAI 兼容 Provider。重点核对 `toolChoice`、停止条件、取消、工具结果形状和 Provider 专用字段，不照搬默认模型或云网关。

### 4.2 Mastra

**定位与语言。** TypeScript Agent 应用框架。官方 Agent 接口包含多步工具使用、完整结果与流式结果；同一体系还组织 Memory、Storage 和 Workflows。[Agent 总览](https://mastra.ai/docs/agents/overview)

**可复用部分。** Agent 循环、对话组织、过程事件、运行恢复与审批衔接。官方人工参与机制区分执行前审批与工具运行中暂停；暂停快照需要配置存储，不能只接一个确认按钮。[人工参与与审批](https://mastra.ai/docs/agents/human-in-the-loop)

**双模型方向。** 模型文档明确介绍 OpenAI 兼容的本地服务，也支持使用 AI SDK Provider 模块。可据此调查现有 DeepSeek／llama.cpp 接入，但仍需核对模型名路由、请求参数和流式工具结果。[模型与本地服务](https://mastra.ai/models)

**Harness 的区别。** Mastra 的 Harness 是围绕长期运行、恢复、观察和人工干预的一组能力，可以按需采用。不要把文档中“支持 coding agents”的例子直接理解成默认附带满足桌宠策略的全部文件工具。[Harness 总览](https://mastra.ai/docs/harness/overview)

**适配成本与限制。** 必须决定哪些状态留在运行期、哪些快照允许落盘、审批恢复如何重新检查 Main 的有效授权；不能为框架存储机制放宽当前隐私边界。平台和开发 Studio 不应被当成桌宠运行必需服务。

**对本项目的用途判断。** 优先作为“统一 Agent、会话、审批和执行记录”的候选；是否比 AI SDK 更划算，取决于额外存储和框架概念能否替代现有代码。

建议阅读顺序：Agent 总览 → 人工参与与审批 → 模型文档 → Harness 总览。把恢复、对话历史和诊断记录视为三个不同问题逐一核对。

### 4.3 OpenAI Agents SDK

**定位与语言。** 官方提供 TypeScript 与 Python SDK，用于定义 Agent、运行工具循环、组织流式执行和状态。SDK 路线允许应用自行管理工具实现、存储和审批。[官方 SDK 总览](https://developers.openai.com/api/docs/guides/agents)

**可复用部分。** 运行循环、运行结果、续接状态和人工审查机制；值得学习如何把一次执行的返回值与后续恢复分开表达。[运行结果与状态](https://developers.openai.com/api/docs/guides/agents/results)、[护栏与人工审查](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)

**双模型方向。** 需要沿官方模型与 Provider 文档核查非 OpenAI 模型的适配方式、传输接口和功能差异，不能把 Responses API 的能力默认映射到 Chat Completions 兼容服务。[模型与 Provider](https://developers.openai.com/api/docs/guides/agents/models)

**适配成本与限制。** 文件工具、Windows 本地执行、权限范围及密钥隔离仍须明确接入；云端托管工具不等于用户电脑上的同名操作。引入追踪前必须审计默认导出与脱敏设置。[集成与可观察性](https://developers.openai.com/api/docs/guides/agents/integrations-observability)

**对本项目的用途判断。** 作为简洁运行状态与审批恢复的参考，也保留为候选；先证明双模型协议适配足够直接，再与 AI SDK／Mastra 比较，不能因为名称而要求用户更换模型。

建议阅读顺序：SDK 总览 → 模型与 Provider → 运行结果与状态 → 人工审查 → 可观察性。首先选择 TypeScript 对应接口，避免混抄 Python 的示例。

### 4.4 Pydantic AI 与 Pydantic AI Harness

**定位与语言。** Python AI SDK，强调类型化的 Agent 与模型接口；它与附加的 Harness 是相关但不同的包层次。[Pydantic AI 总览](https://pydantic.dev/docs/ai/overview/)

**可复用部分。** 工具参数在执行前按类型验证，验证失败可回注给模型修正；框架区分可修正的工具请求与普通异常传播。这对当前“多个失败最后都显示同一句错误”的问题有直接设计参考价值。[高级工具与失败处理](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/)

**编程套件。** 官方 Harness 的 `Coder` 组合文件访问、shell、仓库上下文、规划和上下文控制，并允许拆开使用相应能力。因此它不应仅作为“类型校验工具”列入资料。[Harness 与 Coder](https://pydantic.dev/docs/ai/harness/)

**适配成本与限制。** 直接嵌入当前 TypeScript 桌宠需要新增 Python 运行与分发方案，或维护跨进程桥接；Windows 路径和命令白名单还必须逐项对照。这样的成本不能仅用 Python 示例短来忽略。

**双模型方向。** 官方模型抽象是有价值的调查起点，但本次没有运行 DeepSeek 或当前 GGUF 模型的 Pydantic AI 栈。尤其不能把同系列非量化模型的示例作为本地模型通过的证据。

**对本项目的用途判断。** 优先参考工具契约、可修正错误和 Harness 能力组合；只有确有收益时，才进一步评估增加 Python 执行进程。

建议阅读顺序：总览 → 高级工具 → 重试边界 → Harness。重试应有明确原因与上限，框架提供重试能力不代表文件副作用可以重复执行。[重试说明](https://pydantic.dev/docs/ai/core-concepts/retries/)

### 4.5 Google ADK

**定位与语言。** Google 的 Agent Development Kit；官方资料覆盖 Python、TypeScript 等多种语言，提供 Agent、工具、运行时与工作流组织方式。[ADK 总览](https://adk.dev/)

**可复用部分。** 会话、事件与状态的组织方式，以及工具执行前确认。对桌宠有参考价值的是这些职责如何串成运行链，而非其云部署示例。[会话](https://adk.dev/sessions/session/)、[操作确认](https://adk.dev/tools-custom/confirmation/)

**已发现的能力边界。** 本次读取的操作确认页面明确标注该功能为 Experimental，并说明 TypeScript 需要在工具执行函数中手动接入确认逻辑。这一页的功能状态不能泛化为整个 ADK 的状态，但会影响我们复用审批机制的成本。[操作确认的语言差异](https://adk.dev/tools-custom/confirmation/)

**双模型方向。** 必须核对 TypeScript 版本实际拥有的 Provider 与扩展接口；不能用 Python 的 LiteLLM 适配示例来证明 TypeScript 已经支持同样链路。

**适配成本与限制。** TypeScript 快速入门有运行时版本前提；选型时需核对 Electron 内嵌 Node，而非只检查系统 Node。多语言项目的 API、示例和功能成熟程度不能默认一致。[TypeScript 入门](https://adk.dev/get-started/typescript/)

**对本项目的用途判断。** 作为会话与工具事件组织的参考候选。若 TypeScript 双模型接入与已有桌面事件能直接衔接，再提升评估优先级。

建议阅读顺序：TypeScript 入门 → 会话 → 操作确认 → 所选版本的模型适配文档。明确语言、版本和运行入口后再作兼容性结论。

### 4.6 Microsoft Agent Framework

**定位与语言。** 微软 Agent Framework 的 FAQ 列出 .NET／C# 与 Python；总览把它定位为 AutoGen 与 Semantic Kernel 的后继方向，整合 Agent、会话状态、中间件及工作流。[语言 FAQ](https://learn.microsoft.com/en-us/agent-framework/support/faq)、[框架总览](https://learn.microsoft.com/en-us/agent-framework/overview/)

**可复用部分。** 会话状态、中间件、显式工作流以及长任务和人工参与的组织思路。它有助于讨论哪些步骤需要模型判断，哪些步骤应由确定性代码执行。

**适配成本与限制。** 对目前 TypeScript 桌宠而言，直接采用要评估额外运行时或进程协议。其企业服务生态不是本项目的默认依赖，不因产品运行于 Windows 就自动更合适。

**双模型方向。** 需要针对选定语言和模型连接器核查 DeepSeek 与 llama.cpp；本次不把“多 Provider”泛化为当前两款模型已满足所有工具协议。

**对本项目的用途判断。** 主要作为状态管理与中间件设计参考。若只是一个本地工具循环，不应为了未来可能的复杂工作流先引入整套新运行时。

建议阅读顺序：FAQ → 框架总览 → 实际选定语言的工具、会话与中间件章节。对 AutoGen／Semantic Kernel 的旧资料只保留机制参考，不直接当作新项目选型结论。

### 4.7 CrewAI

**定位与语言。** 以 Python 为主组织 Agent、任务与工作流。官方区分 Crews 的自主协作和 Flows 的事件、状态、条件与执行顺序控制。[CrewAI 总览](https://docs.crewai.com/en/introduction)

**可复用部分。** 可以参考如何把明确步骤和开放任务分开组织，如何让子任务的输出回到主流程。多角色协作是可选的组织手段，不是稳定文件读取的前置条件。

**适配成本与限制。** 直接采用仍需新增 Python 分发或桥接；若把一次读取拆成规划者、执行者和审查者，可能增加延迟与上下文传递，并不能修复错误的 Provider 协议。这里是针对桌宠目标的适配判断。

**双模型方向。** 需要分别核对模型连接器、工具协议和本地服务行为。本次没有实测 CrewAI 双模型，也没有启用它的 MCP、追踪或任何外部集成。

**对本项目的用途判断。** 当前以流程组织参考为主；只有出现确定的协作需求时才评估多 Agent，而不是为了“Agent 框架完整”增加分工。

建议阅读顺序：总览中的 Crews／Flows 区别 → 所选版本的自定义工具 → LLM 接入 → 人工输入与追踪配置。此次总览地址重定向到带版本页面，实施时仍应重新确认实际锁定版本。

### 4.8 LangGraph：与 LangChain 相关，但可独立使用

**定位与语言。** LangChain 团队提供的底层有状态工作流与 Agent 运行基础设施，具有 JavaScript／TypeScript 文档入口；官方明确可不依赖上层 LangChain 使用。[LangGraph 总览](https://docs.langchain.com/oss/javascript/langgraph/overview)

**可复用部分。** 显式状态、执行控制、暂停恢复与持久化基础。适合研究授权等待、用户补充、取消和任务继续怎样进入同一状态模型。

**适配成本与限制。** 更底层意味着应用仍需决定节点、工具、上下文和恢复策略。若无需求就把普通工具循环画成复杂图，可能再次扩大自研范围。

**对本项目的用途判断。** 作为运行时与状态恢复参考；只有简单 Agent 接口不能表达已确认流程时，才考虑直接编排。不能因为掌握了 LangChain 就默认需要自己重建一张 Agent 图。

建议阅读顺序：总览 → 与审批场景对应的中断／持久化文档 → 固定版本的执行重放规则。会话恢复必须与任务授权失效分开验证。

### 4.9 Deep Agents：LangChain 生态中的执行套件

**定位与语言。** 在 LangChain 核心组件和 LangGraph 运行能力上提供更完整的 Agent Harness，具有 JavaScript／TypeScript 使用入口。整合文件工具、上下文管理、规划与可选分工等能力，比只有工具循环更接近本项目的编程助手目标。[Deep Agents 总览](https://docs.langchain.com/oss/javascript/deepagents/overview)

**文件后端的关键区别。** 官方默认 `StateBackend` 管理会话中的虚拟文件，并非直接读取用户电脑；实际文件需选择或接入相应后端。仅成功调用 `read_file` 不足以证明读到用户文件。[后端说明](https://docs.langchain.com/oss/javascript/deepagents/backends)

**可复用部分。** 文件工具组织、上下文卸载、工具结果管理和审批暂停。人工参与机制建立在 LangGraph 中断之上，恢复时需要正确的检查点和会话身份。[人工参与](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)

**适配成本与限制。** 文件后端的根目录配置不等于 OS 沙箱；官方说明本地 shell 在宿主上执行，不能靠文件虚拟路径限制约束任意命令。直接文件后端还可能写入运行内部资料，必须与用户项目和长期记忆边界分开。[后端与本地 shell 边界](https://docs.langchain.com/oss/javascript/deepagents/backends)

**双模型方向。** 先在固定的 TypeScript 版本检查模型与工具接口，再对接当前 DeepSeek 和 llama.cpp。内置系统提示、工具数量及上下文管理策略也应纳入 Qwen 实测，不能只测 HTTP 连通。

**对本项目的用途判断。** 优先作为“最大程度复用编程执行套件”的候选；重点调查能否通过一个后端接口接入现有 Main 权限和 Windows 执行，而不在外层新建第二套循环。

建议阅读顺序：总览 → 后端 → 人工参与 → 上下文管理。页面包含跨语言说明，具体默认值、构造参数及能力开关必须回到固定 TypeScript 包核对，本文不以滚动文档替代 API 规格。[上下文说明](https://docs.langchain.com/oss/javascript/deepagents/context-engineering)

## 5. 面向本项目的比较结论

以下是评估顺序建议，不是采用授权，也不是框架通用排名。

| 路线 | 希望交给成熟实现的职责 | 本项目仍要负责 | 最先回答的问题 |
| --- | --- | --- | --- |
| AI SDK | 模型协议、流式响应、连续工具循环 | 文件工具接入、会话策略、Main 安全和界面 | 能否消除重复模型协议，同时保留已工作的工具？ |
| Mastra | 上述职责以及会话、运行状态、审批衔接 | 数据保存策略、Main 安全、桌面生命周期 | 引入的存储和运行概念是否真能减少现有代码？ |
| Deep Agents | 更完整的文件执行与上下文套件 | 真实文件后端、Windows 命令、授权和产品边界 | 默认能力是否可收敛，后端能否直接受 Main 管理？ |
| 原产品 OpenCode 链 | 与现有工具来源一致的连贯产品执行链 | 当前模型与桌宠适配、Windows 及授权策略 | 原产品实际使用的链路是否比当前嵌入方式更合适？ |
| 其他候选 | 类型契约、审批、状态和工作流等机制 | 按语言增加桥接或按需借鉴 | 是否存在足以抵消新增依赖与运行时的明确收益？ |

OpenCode 是对照基线。其产品入口、嵌入核心、SDK 和版本关系，以[项目评估文档](2026-09-10-agent-execution-architecture-review.md)的本地证据为准，不能凭名称判断是同一执行链。

选择指标应是“移除哪些自研职责、剩余适配是否集中、失败是否能定位、现有模型是否能用”。需要保留的 Windows 或权限职责多，并不自动说明某框架无价值；反过来，多一个包装层而原逻辑全保留，也不能算完成替换。

## 6. 后续验证应聚焦什么

不建议九套框架全部做完整原型。先读源码和固定版本接口，排除明显冲突，再选少量候选做相同场景对照；具体实验仍需形成单独方案。

| 场景 | 应观察的事实 | 排除的误判 |
| --- | --- | --- |
| 普通聊天 | 有效正文正常显示，没有实际本地工具副作用 | 聊天提到文件就立即读盘 |
| 含糊文件话题再同意 | 先说明未查看；明确同意后申请范围并读取 | 靠模型口头描述目录冒充已读取 |
| 读取未知内容 | 随机内容来自真实工具并显示在最终正文 | 只出现 read 名称就算成功 |
| 连续跟进 | 保留必要上下文与工具事实；授权独立判断 | 任务结束就丢掉全部工具历史，或历史自动延长权限 |
| 编辑并验证 | 真实修改、命令退出和结果回注能关联 | 模型总结成功覆盖工具失败 |
| 拒绝与取消 | 无未批准副作用，迟到事件不污染新会话 | 只停止 UI 等待，进程仍执行 |
| 非法格式与工具失败 | 区分 Provider、工具参数、权限和宿主错误 | 所有异常被归为“模型不兼容” |

两个模型分别记录；一款通过不能代表另一款通过。每轮保留足够定位的阶段信息与调用标识，但不保存用户 API Key、文件原文和私有路径作为公开诊断材料。

完成这些基本对照后，应作出继续、淘汰或缩小范围的决定，不进行没有新问题驱动的反复全量测试。

## 7. 采用前必须补齐的资料

下面是尚未执行的选型工作，不能在实施或发布时直接跳过。

| 项目 | 需要记录的内容 |
| --- | --- |
| 固定来源 | 包名、精确版本、上游 tag／commit、源码入口、发布日期与变更日志 |
| 许可证 | 实际采用包及传递依赖的许可证、NOTICE、分发义务；区分框架与托管平台条款 |
| 运行兼容 | Electron 内嵌 Node、ESM／CJS、原生模块、worker、打包与资源路径 |
| 模型兼容 | DeepSeek 实际模型配置、本地 GGUF／llama.cpp 版本、工具和流式参数差异 |
| 权限衔接 | 工具执行前与恢复后均由 Main 检查；参数、真实路径和授权 generation 绑定 |
| 副作用恢复 | 已执行工具不可因重放而再次执行；恢复记录不包含可无限续用的授权 |
| 遥测与存储 | 默认导出端点、默认开关、敏感字段、关闭方式、检查点位置和保留期限 |
| 包体与依赖 | 新增体积、传递依赖、离线启动条件、是否意外携带 CLI／MCP／开发服务 |
| 删除范围 | 被替换的入口、Provider 转换、任务循环、旧测试与依赖；没有第二条正式执行链 |
| 网站隔离 | 桌面依赖变化不改变网站、CloudBase、扫描器的业务及依赖解析 |

本次不锁定版本、不下载候选源码、不改变锁文件、不做许可证审核结论。正式采用时，上述信息与实际实验结果一起进入新的规格与独立验收记录。

## 8. 官方资料索引与核验说明

所有来源均于 2026-09-10 访问或检索。下表“内容核验”表示本次看到相应页面内容，不表示其中所有功能均已逐项源码审计。

| 编号 | 官方资料 | 阅读用途与本次核验情况 |
| --- | --- | --- |
| A1 | [AI SDK：ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) | 循环、流式、停止和取消；官方域搜索结果内容核验 |
| A2 | [AI SDK：DeepSeek](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek) | 专用 Provider 与配置；官方域搜索结果内容核验 |
| A3 | [AI SDK：OpenAI 兼容 Provider](https://ai-sdk.dev/providers/openai-compatible-providers) | 自定义服务地址与模型接口；官方域搜索结果内容核验 |
| M1 | [Mastra：Agents](https://mastra.ai/docs/agents/overview) | 基础循环、结果与流式接口；页面内容核验 |
| M2 | [Mastra：Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop) | 执行前批准、运行暂停、快照；页面内容核验 |
| M3 | [Mastra：Models](https://mastra.ai/models) | 本地兼容接口与 Provider 接入；页面内容核验 |
| M4 | [Mastra：Harness](https://mastra.ai/docs/harness/overview) | 长期运行能力范围；页面内容核验 |
| O1 | [OpenAI：Agents SDK](https://developers.openai.com/api/docs/guides/agents) | TypeScript／Python 与应用职责；页面内容核验 |
| O2 | [OpenAI：Models and providers](https://developers.openai.com/api/docs/guides/agents/models) | 模型和传输差异；已打开，具体适配待版本核验 |
| O3 | [OpenAI：Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals) | 审查与暂停机制；页面内容核验，实施前核对语言接口 |
| O4 | [OpenAI：Results and state](https://developers.openai.com/api/docs/guides/agents/results) | 返回值与恢复状态；页面内容核验，实施前核对语言接口 |
| O5 | [OpenAI：Integrations and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability) | 集成与追踪；已打开，默认配置待源码核验 |
| P1 | [Pydantic AI：Overview](https://pydantic.dev/docs/ai/overview/) | Python 核心与附加 Harness 区别；页面内容核验 |
| P2 | [Pydantic AI：Advanced Tool Features](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/) | 校验与工具失败；官方域搜索结果内容核验 |
| P3 | [Pydantic AI：Retries](https://pydantic.dev/docs/ai/core-concepts/retries/) | 不同重试边界；官方域搜索结果内容核验 |
| P4 | [Pydantic AI：Harness](https://pydantic.dev/docs/ai/harness/) | Coder 与组合能力；页面内容核验 |
| G1 | [Google ADK：总览](https://adk.dev/) | 语言、运行时和模型入口；页面内容核验 |
| G2 | [Google ADK：TypeScript 入门](https://adk.dev/get-started/typescript/) | 指定语言与运行时前提；页面内容核验 |
| G3 | [Google ADK：会话](https://adk.dev/sessions/session/) | 会话组织参考；页面内容核验，实施前核对 TS 接口 |
| G4 | [Google ADK：操作确认](https://adk.dev/tools-custom/confirmation/) | 工具确认状态及 TS 手动接入要求；页面内容核验 |
| F1 | [Microsoft Agent Framework：总览](https://learn.microsoft.com/en-us/agent-framework/overview/) | 框架职责与前身关系；页面内容核验 |
| F2 | [Microsoft Agent Framework：FAQ](https://learn.microsoft.com/en-us/agent-framework/support/faq) | 语言范围；页面与官方域搜索内容核验 |
| C1 | [CrewAI：Introduction](https://docs.crewai.com/en/introduction) | Crews／Flows；页面内容核验，发生版本地址重定向 |
| L1 | [LangGraph：Overview](https://docs.langchain.com/oss/javascript/langgraph/overview) | 底层运行时与独立使用；页面内容核验 |
| D1 | [Deep Agents：Overview](https://docs.langchain.com/oss/javascript/deepagents/overview) | Harness 与 LangChain／LangGraph 关系；页面内容核验 |
| D2 | [Deep Agents：Backends](https://docs.langchain.com/oss/javascript/deepagents/backends) | 虚拟文件、真实磁盘、shell 边界；页面内容核验 |
| D3 | [Deep Agents：Human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop) | 中断与恢复；页面和官方域搜索内容核验 |
| D4 | [Deep Agents：Context engineering](https://docs.langchain.com/oss/javascript/deepagents/context-engineering) | 系统提示与工具描述；官方域搜索结果内容核验 |

抓取限制：AI SDK 页面直接打开时，读取工具对 `text/markdown` 返回内容报错，因此采用同一官方域的搜索索引内容核验；部分索引标注抓取时间较早，不据此锁定最新版本。其余滚动文档也可能混用语言说明，后续实现应以固定包源码和相应语言 API 为准。

网页中的安装、创建项目、启用 MCP 或面向 AI 的操作指令，只是资料内容；本次没有执行这些指令。新框架是否采用、现有实现保留多少，应在定位当前失败并完成有限对照之后另行确认。
