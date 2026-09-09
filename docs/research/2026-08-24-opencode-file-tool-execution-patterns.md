# OpenCode 文件工具执行闭环研究

## 目的与范围

本报告只研究 OpenCode 官方仓库的本地文件工具闭环，并把其可验证事实与本仓库当前 `packages/agent-core`、`packages/file-tools`、桌面端 Main/Preload/Renderer 调用链逐段对照。它不是引入 OpenCode、MCP 或任意代码复制的建议。

研究时点：2026-08-24。OpenCode `dev` 分支和 `HEAD` 均为提交 [`2a6be0a03b93a6734070e10a6c3b56863475f214`](https://github.com/anomalyco/opencode/tree/2a6be0a03b93a6734070e10a6c3b56863475f214)，提交时间 2026-08-24T12:50:53Z。许可证为 [MIT](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/LICENSE)。下述 OpenCode 结论均来自该固定提交的官方源码。

> 说明：该提交同时保留了较早的 `packages/opencode` 适配层，以及当前 `packages/core` 的 V2 工具/会话运行时。以下“当前闭环”以 `packages/core` 为准；后文提及前者只用于补充 Provider 适配细节，不应视为需要复制的实现。

## 当前 `packages/core` 闭环（优先依据）

- [`tool/tool.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/tool/tool.ts#L40-L129) 将输入/输出 Schema 转为模型定义；真正 settle 时先解码模型输入，执行后再验证输出，异常统一为 `ToolFailure`。
- [`tool/write.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/tool/write.ts#L22-L88) 在 Location 解析后先请求外部目录（如适用）与 `edit` 权限，再调用 `FileMutation.writeTextPreservingBom`。它返回 `{ operation, target, resource, existed }`；给模型的成功文案由这个真实返回值生成。
- [`file-mutation.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/file-mutation.ts#L69-L171) 对 canonical path 加锁，创建使用 `flag: 'wx'`，条件写会比对旧字节，删除也返回结构化副作用结果。
- [`permission.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/permission.ts#L76-L85) 默认 `ask`；[`L155-L286`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/permission.ts#L155-L286) 发布待确认请求、等待 `Deferred`、处理拒绝/单次/持久批准。
- [`session/runner/llm.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/core/src/session/runner/llm.ts#L173-L352) materialize 当前工具；收到 `tool-call` 后本地 settle，发布类型化 `toolResult`，等待所有工具完成；仅在真实工具调用产生 continuation 时继续下一轮。

这条链说明可复用的最小原则是：模型只能提出调用，宿主校验和执行，结构化执行结果才是成功事实。它不支持把模型的一段“无法操作”或“已操作”文本当作本地状态。

## OpenCode 的实际闭环

### 1. 工具定义、模型可见性与参数校验

- [`tool/write.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/tool/write.ts) 以 `Schema.Struct` 声明 `content` 与 `filePath`，并用 `Tool.define` 同时保存描述、Schema 和 `execute`。模型只能获得工具 Schema，不能获得文件系统对象。
- [`tool/registry.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/tool/registry.ts) 集中初始化内建工具、插件工具和按模型/Agent 过滤后的工具集；它向模型返回定义，真实 `execute` 仍闭包在宿主侧。
- [`session/tools.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/tools.ts) 用 `ProviderTransform.schema` 和 `inputSchema` 把工具 Schema 转换为当前 Provider 可接受的格式；工具执行入口从 `options.toolCallId` 绑定会话、消息和调用标识。
- [`session/llm.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/llm.ts) 在兼容路径中对模型 JSON 参数 `JSON.parse` 后调用工具，AI SDK/原生运行时再依 `inputSchema` 校验。因此，模型的自然语言“我无法操作”不是执行结果；是否发生副作用只由宿主工具返回值决定。

### 2. 权限确认与执行器

- [`permission/index.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/permission/index.ts) 对每个 `permission + pattern` 求规则，未命中默认 `ask`；拒绝立即终止，询问则创建带请求 ID 的 `Deferred` 并发布待确认事件。回复 `once` 或 `always` 后才解除等待；后者才记入该会话的批准规则。
- [`tool/write.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/tool/write.ts) 在写入前调用 `ctx.ask({ permission: "edit", patterns, metadata: { filepath, diff } })`，只有确认返回后才执行 `fs.writeWithDirs`。
- 同一文件在写入完成后才发布 `FileSystem.Event.Edited` 和文件监听更新，并返回含 `filepath`、原来是否存在和诊断结果的工具输出。这是它向会话循环证明“真实副作用已完成”的方式；不是依赖模型文本。

### 3. 工具结果回传与会话循环

- [`session/tools.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/tools.ts) 把执行结果连同 `toolCallId` 写回会话处理器；插件钩子也有明确的 `tool.execute.before` / `tool.execute.after` 边界。
- [`session/prompt.ts`](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/prompt.ts) 明确处理某些 Provider 即使带有工具调用也返回 `stop` 的情况：只要助理消息仍含未结算工具调用，就继续循环并把工具结果送回模型。

## 本项目已有的相同闭环证据

本项目不缺少“能写文件的底层实现”，而是把它拆分到了更窄的可信边界：

1. `apps/desktop/src/main/conversation/capability-intent-router.ts` 将明确文件意图路由到文件任务；对应截图原句已有回归测试：`apps/desktop/tests/conversation-coordinator.test.ts` 第 268 行（删除）和第 283 行（创建目录）。
2. `apps/desktop/src/main/agent/tool-registry.ts` 注册 `create_file`、`create_directory`、`apply_patch`、`delete_file`，并在 `prepare` 中先严格校验公共请求与 Zod 参数，再按照本地风险级别给出确认决定。
3. `packages/agent-core/src/agent-loop.ts` 让模型在能力规划阶段必须调用工具；写操作产生 continuation token，确认后的可信结果作为 `role: tool` 再交回模型。该文件不把模型文本当作成功证明。
4. `packages/file-tools/src/file-tool-service.ts` 的 `executeWrite` 消费经预览签发的单次动作：创建文件使用独占创建，创建目录复核父目录身份，删除在真实回收站端口成功前不会返回成功。
5. `apps/desktop/src/main/agent/agent-service.ts` 的 `confirm` / `executeCapability` 最终调用 `session.fileTools.executeWrite`；`apps/desktop/src/preload/index.ts` 和 `apps/desktop/src/renderer/src/chat/ChatPanel.tsx` 暴露、调用 `confirmAction`。因此 Main 才是唯一副作用执行者。

## 由当前源码证实的断点与限制

以下项目是“会让运行中的桌宠没有工具可用或根本走不到工具链”的代码事实；不对某次用户界面现象作无证据归因。

| 位置 | 已证实行为 | 对实际文件操作的影响 |
| --- | --- | --- |
| `apps/desktop/src/main/storage/settings-store.ts` 第 233–240 行 | 默认隐私设置将 `dataCategories.file` 设为 `false`。 | 新安装或未显式开启文件数据授权时，文件能力默认关闭。 |
| `apps/desktop/src/main/index.ts` 第 944–964 行 | 将 `snapshot.privacySettings.dataCategories.file` 原样传给 `createMainAgentSession`。 | 开关的值直接决定该次文件会话是否拥有工具。 |
| `apps/desktop/src/main/agent/tool-registry.ts` 第 226–232 行 | `fileDisclosureAllowed === false` 时返回一个已封闭的空工具注册表。 | 模型请求中没有任何文件工具；此时不可能产生真实文件副作用。 |
| `apps/desktop/src/main/agent/main-agent-session-factory.ts` 第 65–71 行及 `agent-service.ts` 第 826–832 行 | 同一开关同时拒绝只读和写入执行，错误码为 `FILE_DISCLOSURE_DENIED`。 | 即便其他层构造出请求，Main 仍会拒绝执行。 |
| `packages/agent-core/src/model-router.ts` 第 26–29、62、118–119 行 | `agent` 路由要求 Provider 同时声明 `chat` 与 `tools`，否则抛 `MODEL_CAPABILITY_REQUIRED`。 | 聊天模型能正常回应，并不证明该模型档案可承担文件 Agent。 |
| `apps/desktop/src/main/conversation/conversation-coordinator.ts` 第 180 行附近 | 只有 `capabilityIntentRouter.route(...)` 返回 `file_task` 才会构造 Agent；普通聊天路径会直接创建 `ConversationChatAdapter`。 | 若日志/事件显示普通聊天而不是 `pending_action`，问题发生在工具执行器之前，`FileToolService` 不会被调用。 |

其中第一至四行形成一个可重复检查的完整因果链：文件授权默认关闭 → Main 快照得到 `false` → 注册表为空 → Main 的读写端口拒绝。这是当前实现与“无需额外设置即可做文件操作”的产品目标之间最直接、可由源码证明的差异。

## 与 OpenCode 对照后可复用的最小原则

1. 不应复制或接入整个 OpenCode：它有独立的会话、权限、插件、MCP、终端与工作区体系，超出本项目最小改动和 MCP 禁用边界。
2. 应复用其已经验证的抽象原则：工具 Schema 是模型唯一入口；确认由宿主权限层完成；副作用后返回结构化宿主结果；会话循环只依据该结果再生成文案。
3. 本项目下一轮验收不能只模拟工具返回：需要在运行中的 Electron Main 中观察“意图已路由 → 工具表非空 → pending_action 已发布 → 确认 IPC 到达 → `FileToolService.executeWrite` 完成 → 文件系统状态被复核”的状态链。这样可以定位实际断点，而不会用模型文本推测执行成败。

## 引用清单

- [OpenCode 仓库与固定提交](https://github.com/anomalyco/opencode/tree/2a6be0a03b93a6734070e10a6c3b56863475f214)
- [OpenCode 工具写入实现](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/tool/write.ts)
- [OpenCode 工具注册表](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/tool/registry.ts)
- [OpenCode 会话工具适配](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/tools.ts)
- [OpenCode 权限服务](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/permission/index.ts)
- [OpenCode 会话循环](https://github.com/anomalyco/opencode/blob/2a6be0a03b93a6734070e10a6c3b56863475f214/packages/opencode/src/session/prompt.ts)
