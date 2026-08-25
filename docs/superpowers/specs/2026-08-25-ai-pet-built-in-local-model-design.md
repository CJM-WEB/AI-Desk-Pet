# AI 桌宠内置本地模型设计

日期：2026-08-25

状态：用户已批准总体路线，并预授权后续设计自审、实施与 Git 写操作

## 1. 目标

在不替换现有云端 Provider 配置、不引入第二套 Agent、不启用 MCP 的前提下，为 Windows x64 桌宠增加随安装包分发的内置本地模型：

1. 安装包直接携带 llama.cpp 运行时和 Qwen3.5-4B GGUF，不在用户设备上首次下载模型。
2. 本地模型默认开启；桌宠界面先出现，模型随后在后台异步加载。
3. 开启时，普通聊天和 Agent 均只使用本地模型；原 DeepSeek、自定义 Provider 等配置保持原样但暂停调用。
4. 关闭时停止本地模型进程并恢复原云端路由，不删除、不迁移、不改写用户的模型档案。
5. 本地模型必须通过现有 `AgentLoop`、工具 Schema、授权、确认卡和 Electron Main 工具链调用真实工具。
6. 本地模型始终使用非思考模式，不向用户显示或保留模型思考内容。

## 2. 非目标与硬边界

- 不采用 Ollama、OpenCode Agent、Qwen-Agent、LangGraph 或其他第二套运行时。
- 不启用 llama.cpp 内建 `--tools`、`--agent`、MCP、Shell、文件访问或媒体路径。
- 不恢复桌宠 MCP；其正式运行链继续保持禁用。
- 不让 Renderer 获得模型文件、运行时路径、动态端口、会话密钥、进程句柄或原始日志。
- 不声明本地视觉能力，不打包 `mmproj`；开启本地模式时视觉请求稳定拒绝，不回退云端。
- 不提供多本地模型、用户导入 GGUF、微调、RAG、长期模型服务或局域网监听。
- 不把环回地址、Bearer Token 或逐次确认描述成 OS 级沙箱。
- 不在普通开发构建、应用启动或用户运行期间静默联网下载或升级模型。

## 3. 已确认产品决策

### 3.1 默认启用与路由

- SettingsStore 新版本增加 `localModel.enabled`，新安装与旧版本迁移的默认值均为 `true`。
- 本地模型开启时，Main 只在内存中注入不可编辑的内置 Provider 档案和临时路由覆盖；持久化的云端档案与 `modelRoute` 不变。
- 临时路由把 `primary`、`chat`、`agent` 和 `vision` 都指向内置档案，清空备用模型并关闭跨 Provider 回退。
- 内置档案只声明 `chat`、`tools`；因此聊天和 Agent 可用，视觉因能力不满足而失败，绝不调用云端视觉档案。
- 切换开关先取消当前会话、失效待确认动作并递增会话 generation，再切换路由和进程，避免把本地历史意外发送给云端。

### 3.2 启动与后端

- 第一版只正式支持 Windows x64。
- 应用窗口完成初始化后立即异步启动本地模型，不阻塞桌宠、设置或托盘窗口出现。
- 优先探测并启动 Vulkan；Vulkan 在接受首个模型请求前失败时，清理该进程后切换 CPU。
- CPU 降级必须在聊天与设置界面明确显示“CPU 兼容模式”，不能静默降级。
- 已经接受模型请求后不得把同一请求静默改在另一后端重跑。

### 3.3 非思考模式

同时使用三道版本锁定的约束：

1. llama-server 启动参数固定 `--reasoning off`。
2. 每次请求固定 `reasoning_effort: "none"`。
3. 每次请求固定 `chat_template_kwargs: { "enable_thinking": false }`。

Provider 对非空 `reasoning_content`、`<think>` 或等价思考区块返回稳定协议错误，不把内容显示给 Renderer。`--reasoning-format none` 只改变解析方式，不能用来代替关闭思考。

## 4. 固定发行物

### 4.1 模型

首版锁定：

| 字段 | 值 |
| --- | --- |
| 原模型 | `Qwen/Qwen3.5-4B` |
| 原模型固定 revision | `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` |
| 量化仓库 | `unsloth/Qwen3.5-4B-GGUF` |
| 量化固定 revision | `e87f176479d0855a907a41277aca2f8ee7a09523` |
| 文件 | `Qwen3.5-4B-Q4_K_M.gguf` |
| 文件大小 | `2,740,937,888` bytes |
| SHA-256 | `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4` |
| 许可证 | Apache License 2.0 |
| 本地能力 | `chat`、`tools` |

纯文本聊天与文本工具调用不需要视觉投影文件，首版不携带 `mmproj`。量化仓库没有独立许可证文件，因此安装包必须携带原模型 Apache-2.0 文本、来源、固定 revision、量化说明和哈希清单。

### 4.2 llama.cpp

开发与首次正式验收锁定：

| 字段 | 值 |
| --- | --- |
| Release | `b10516` |
| commit | `b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9` |
| 许可证 | MIT |

官方 Windows Vulkan ZIP 只包含 Vulkan 插件，官方 CPU ZIP 又包含来源于 `debug_nonredist` 的 OpenMP DLL，因此不得把官方 ZIP 原样作为生产安装包内容。生产资源从该固定 commit 自建最小运行时：

- CPU 与 Vulkan 分开构建和存放；
- `GGML_RPC=OFF`；
- `GGML_OPENMP=OFF`，避免分发许可不清的 OpenMP DLL；
- 只构建和打包 `llama-server` 及其实际依赖；
- 不打包 CLI、benchmark、RPC server、转换器和内建工具前端；
- Vulkan 构建只依赖目标机器显卡驱动提供的 Vulkan loader/device，不分发 Vulkan SDK。

构建脚本必须从固定源码提交生成产物清单和 SHA-256；`package:win` 在清单、许可证、模型或运行时缺失时失败。普通 `build` 不联网，也不要求仓库中存在 2.55 GiB 模型。

## 5. 总体架构

```text
用户输入
  → ConversationCoordinator / CapabilityIntentRouter
  → 现有 ModelRouter（Main 注入内置档案与内存路由覆盖）
  → LocalModelProvider
  → LocalModelRuntime 管理的 llama-server
  → OpenAI-compatible text 或 tool_calls
  → 现有 AgentLoop / ToolRegistry / 授权与确认
  → Electron Main 执行真实工具
  → 真实 ToolResult 回传同一模型
  → 最终文字与桌宠行为响应
```

### 5.1 `LocalModelRuntime`

只负责推理进程生命周期：

- 从固定开发资源目录或 `process.resourcesPath/local-model` 读取严格 manifest；
- 校验平台、版本、文件大小与 SHA-256；
- 生成高强度会话密钥文件和候选环回端口；
- 使用绝对路径、分项参数、`shell:false`、`windowsHide:true` 启动子进程；
- 监视 stdout/stderr、子进程退出和 `/health`；
- Vulkan 预检、一次 CPU 降级、有限端口冲突重试；
- 取消请求、幂等停止、应用退出清理和迟到连接失效；
- 只输出稳定、脱敏的公开状态。

Main 私有连接句柄包含 Base URL、Bearer Token、模型 ID 和 generation。它不能进入 Settings Dashboard、IPC、Renderer、普通日志或持久化设置。

### 5.2 `LocalModelProvider`

实现现有 `ModelProvider` 接口并复用 OpenAI-compatible 的消息序列化、工具名编码、响应 Schema 和错误归一化：

- 每次请求从 Runtime 获取当前 ready generation 的连接；
- 强制非思考、非流式、单工具调用；
- 固定 `parallel_tool_calls:false`、`parse_tool_calls:true`；
- 保留现有 `tool_choice`、响应契约和 AbortSignal；
- Runtime 未 ready 或 generation 已变化时不发送请求；
- 不执行工具、不读取授权根、不接触文件内容。

### 5.3 `LocalModelService`

协调设置、路由和公开状态：

- 读取/保存唯一用户选项 `enabled`；
- 启动后异步预热；
- 切换时先 reset 会话与确认，再启动/停止 Runtime；
- 生成只存在于 Main 内存的内置档案、目录项和路由覆盖；
- 向聊天与设置窗口广播严格过滤的状态。

不得把本地档案写入 `providerProfiles`，也不得使用伪造的 `hasStoredSecret:true`。会话组合通过 Main 私有 Provider 就绪裁决区分“云档案需要 Secret”和“本地档案需要 Runtime ready”。

## 6. llama-server 契约

基线启动参数：

```text
--model <固定绝对路径>
--alias ai-pet-local
--host 127.0.0.1
--port <Main 候选高端口>
--ctx-size 8192
--parallel 1
--jinja
--reasoning off
--api-key-file <本次会话密钥文件>
--offline
--no-ui
--no-slots
--no-cors-credentials
```

CPU 增加 `--device none --gpu-layers 0`。Vulkan 先通过 `--list-devices` 解析真实设备，再使用被探测到的 Vulkan device 和 `--gpu-layers all`；不得假定设备永远名为 `Vulkan0`。

明确不传：`--tools`、`--agent`、`--mcp-servers-*`、`--media-path`、`--props`、`--models-dir`、`--model-url`、`--hf-repo` 或 RPC 参数。

`GET /health` 只用于加载状态：503 表示加载中，200 且严格状态为 `ok` 才可进入 ready。健康端点本身是公开端点，真正模型请求仍须携带会话 Bearer Token。端口先探测后启动存在竞争，因此只在日志和退出码符合端口占用时更换端口，最多重试三次。

## 7. 设置与用户体验

模型设置页顶部新增独立“内置本地模型”卡片，不放进云 Provider 编辑表单：

- 一个默认开启的开关；
- 固定模型名称和“无需 API Key”；
- 状态：已关闭、检查资源、正在加载、Vulkan 已就绪、CPU 兼容模式、启动失败；
- CPU 模式的资源提示；
- 稳定错误原因和重试入口；
- 明确说明开启期间聊天与 Agent 不调用已配置云模型，视觉暂不可用。

聊天窗口订阅同一公开状态：

- `loading` 时显示“本地模型加载中”并禁止发送；
- `ready` 时正常发送；
- `faulted` 时显示稳定错误和设置入口，不回退云端；
- Renderer 禁用发送只属于体验层，Main 在真正发送前再次检查 generation 与 Runtime 状态。

公开状态只允许：

```ts
{
  enabled: boolean;
  phase: 'disabled' | 'validating' | 'loading' | 'ready' | 'faulted' | 'stopping';
  backend: 'vulkan' | 'cpu' | null;
  reasonCode: LocalModelReasonCode | null;
}
```

禁止包含端口、Token、绝对路径、命令行、PID、文件哈希、Prompt 或原始 stderr。

## 8. 工具调用保证

“llama.cpp 支持 tools”不能作为完成证据。必须使用锁定 GGUF 和锁定 Windows CPU/Vulkan 运行时执行真实纵向验收：

1. 普通聊天返回文字，不产生工具请求。
2. 创建文件由模型返回一个合法 OpenAI `tool_calls`；确认前无副作用，确认后真实落盘。
3. 移动文件返回 `move_file`，确认后真实源消失、目标出现。
4. 删除文件或空目录显示准确确认，执行结果以本地工具为准。
5. 工具结果回填后，第二轮只生成真实总结，不重复调用。
6. 参数对象、中文路径、缺少目标、工具失败、用户拒绝、重复调用和非法 JSON 均有稳定行为。
7. 开启本地模式时抓取所有 Provider 请求，证明云 Provider 调用次数为零。
8. 模型响应不得包含思考内容。

只有 CPU 和 Vulkan 两条真实链都完成至少普通聊天、单次文件工具、工具结果回填和非思考验收，内置档案才声明 `tools`。若锁定组合失败，先更新并重新锁定 llama.cpp build 或 GGUF 清单，不得通过正则猜测工具意图或绕开模型工具调用协议。

## 9. 安全、隐私与失败处理

- 模型与 Runtime 永远没有本地工具对象；只有 AgentLoop 获得经任务收窄的工具定义。
- 文件、PowerShell、授权根、确认、冲突和回收站策略完全复用现有 Main 安全链。
- 模型口头成功不替代 ToolResult；本地工具失败不能发布成功事件。
- Runtime 资源只从固定应用资源根加载，拒绝 Renderer、授权目录、用户输入或环境变量指定的任意可执行文件和 GGUF。
- GGUF 首次运行、应用版本变化或文件元数据变化时执行完整 SHA-256；小型 runtime 文件每次启动校验。校验缓存不替代安装包签名和发布清单。
- 会话密钥使用临时文件传给 llama-server，退出、故障和切换后删除；同一 Windows 用户下的恶意进程仍可能观察本机资源，因此不宣传为强隔离。
- stderr 只保留有界环形缓冲并映射到稳定错误；普通日志不写模型路径、Prompt、文件正文、命令输出或密钥。
- Vulkan 失败只允许在首个请求前降级一次；CPU 也失败后进入 `faulted`，不循环重启。
- 应用退出按“停止接受请求 → Abort HTTP → 终止记录的子进程树 → 等待退出 → 删除密钥 → 失效连接”顺序清理，不按进程名批量终止。

稳定错误至少覆盖：资源缺失、哈希不匹配、运行时不兼容、Vulkan 不可用、CPU 启动失败、模型加载超时、端口冲突、进程崩溃、模型协议不兼容和工具调用格式错误。

## 10. 资源与打包

仓库只提交：

- 固定来源与哈希 manifest；
- 许可证和第三方说明；
- 可复现的下载、构建、暂存和校验脚本；
- 空载测试 fixture。

2.55 GiB GGUF 与构建后的 EXE/DLL 位于被 Git 忽略的 `apps/desktop/resources/local-model/payload/`。发布暂存脚本使用固定 URL、revision 和 SHA 下载模型，并从固定 llama.cpp commit 构建运行时；普通用户安装后不执行这些脚本。

`electron-builder` 通过 `extraResources` 将完整 `local-model` 目录放入 asar 外。`package:win` 必须先运行资源 verifier，验证精确允许清单、大小、SHA、许可证与禁止文件；发现 `llama-cli`、RPC server、内建工具配置、额外模型或缺失资源时失败。

卸载沿用当前 `deleteAppDataOnUninstall:false`，但内置模型位于安装目录并随应用卸载；用户配置继续保留。后续自动更新不得在 llama-server 读取 GGUF 时原地覆盖资源。

## 11. TDD 与验收

### 11.1 单元与契约测试

- SettingsStore 迁移默认开启且完整保留 Provider、路由、MCP 持久化数据、角色和隐私设置。
- 本地路由覆盖是纯函数；关闭后原路由逐字段相等，开启时无 fallback、无云调用、视觉拒绝。
- Runtime 覆盖 manifest、哈希、端口竞争、Vulkan 成功、Vulkan 到 CPU、双失败、取消、崩溃、重复 start/stop/close 和日志脱敏。
- Provider 覆盖文本、`tool_calls`、历史续传、响应契约、取消、generation 失效、非思考与 Runtime 未就绪。
- IPC 使用严格 Schema；公开 DTO 泄露扫描不含端口、Token、路径、PID、命令行或 stderr。
- Renderer 覆盖默认开启、加载中禁发、CPU 状态、故障和云档案仍可编辑。
- 打包测试验证资源 allowlist、版本、许可证和 `extraResources`。

### 11.2 自动纵向测试

- 使用假的 llama-server 进程和真实环回 HTTP 覆盖生命周期、认证、健康检查与工具协议。
- 使用现有临时授权根完成本地 Provider 的创建、移动、删除和真实结果续传。
- 安全测试证明 Runtime/Provider 不拥有文件与 PowerShell执行端口。
- Electron E2E 证明窗口先出现、加载状态可见、切换会话失效、禁云回退和退出无残留测试进程。

### 11.3 真实模型验收

- 下载并校验固定 GGUF；构建并校验固定 CPU/Vulkan 运行时。
- 分别执行普通中文聊天、非思考、文件工具调用、工具结果回填、取消与异常恢复探针。
- 状态探针记录 backend、phase、工具名和本地副作用布尔值，不记录 Prompt、正文、绝对路径或密钥。

### 11.4 门禁

依次运行定向测试、相关 package typecheck、`pnpm.cmd test:security`、`pnpm.cmd test:integration` 和 `pnpm.cmd verify:desktop`。涉及角色结构化响应时追加 `pnpm.cmd verify:behavior`。

自动化不能替代真实 Windows Vulkan/CPU 性能、任务管理器进程、干净安装卸载、安装包体积、SmartScreen 和回收站恢复观察；未执行的项目必须标记“待用户人工确认”。

## 12. 最小修改与旧路径清理

- 不修改 `ModelRouter` 核心算法；通过 Main 私有档案、目录项和路由覆盖复用它。
- 不扩展持久化 `ProviderProfileV2` 为第三种 local mode。
- ProviderRegistry 只增加一个固定身份的 Main 私有 factory，不接受 Renderer 提供本地 URL 或可执行路径。
- OpenAI-compatible 公共序列化能力若需抽取，只抽取 LocalModelProvider 复用所需的最小 seam，不复制整份 Provider。
- 新状态事件替代轮询，不保留两条本地模型状态路径。
- 若实施中产生临时开发 Provider、旧别名、占位模型入口或下载时运行路径，在真实纵向测试通过后全部删除。

## 13. 参考来源

- llama.cpp b10516 Release：<https://github.com/ggml-org/llama.cpp/releases/tag/b10516>
- llama.cpp 固定 commit：<https://github.com/ggml-org/llama.cpp/commit/b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9>
- llama.cpp Server：<https://github.com/ggml-org/llama.cpp/blob/b10516/tools/server/README.md>
- llama.cpp Function Calling：<https://github.com/ggml-org/llama.cpp/blob/b10516/docs/function-calling.md>
- llama.cpp License：<https://github.com/ggml-org/llama.cpp/blob/b10516/LICENSE>
- Qwen3.5-4B 原模型：<https://huggingface.co/Qwen/Qwen3.5-4B/tree/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a>
- 固定 GGUF：<https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/e87f176479d0855a907a41277aca2f8ee7a09523>
