# 桌宠本地文件工具与工具调用循环开源复用调研

**日期：** 2026-08-22
**范围：** 只读调研，不修改生产代码、不安装依赖、不启用或恢复 MCP 运行时
**结论状态：** 可用于后续规格评审；不等同于实施批准或验收通过

## 1. 结论摘要

当前最小且符合可信边界的路线不是替换文件系统实现，而是继续保留现有 `packages/file-tools`、Electron Main 宿主确认和 `shell.trashItem`，只从成熟项目借鉴工具调用、确认和错误回传模式。

- `packages/file-tools` 已经实现相对路径 Schema、授权根内真实路径解析、链接/Junction 拒绝、独占创建、确认后目标身份复核和回收站端口；Main 已把该端口接到 Electron `shell.trashItem`。
- 截图所反映的创建/删除失败发生在 Provider 返回普通文本、尚未产生结构化 `tool_request` 时。此时 `FileToolService.preview`、`executeWrite`、Node 文件 API 和 `shell.trashItem` 都没有被调用。因此，把 Node `fs/promises` 或 `shell.trashItem` 换成另一套文件库不能修复该故障。
- Cline 与 Gemini CLI 都是 TypeScript，包含成熟的工具注册、确认和结果回传设计，但直接嵌入会引入第二套 Agent 循环、权限语义与会话状态；其文件写入默认行为也不满足本项目的“不覆盖、不隐式创建目录、授权根标识 + 相对路径”契约。结论为仅借鉴。
- OpenAI Agents JS 提供 TypeScript 工具 Schema、动态审批、暂停/恢复、超时和取消机制，是最贴近当前技术栈的循环候选；但完整接入仍会形成第二套 Agent 状态机。Codex 的审批、沙箱和有界输出设计值得借鉴，但主体是 Rust 且安全模型远重于当前 Electron/TypeScript 边界。两者都不适合直接替换现有循环。
- `jsdiff` 是唯一适合继续直接复用的小模块，但仓库当前锁定的 `diff@8.0.2` 受上游 `CVE-2026-24001` 影响。后续应单独批准并以 TDD 将其最小升级到已修复的 `8.0.3`；该升级只修复补丁解析拒绝服务风险，不解决工具调用前的 Provider 协议故障。
- 本调研明确排除所有候选仓库中的 MCP client/server、MCP 工具注册和扩展路径；不建议桌宠恢复、开发或启用 MCP。

## 2. 当前代码事实与问题定位

### 2.1 已存在的可信文件边界

静态检查得到以下事实：

1. `packages/file-tools/src/schemas.ts` 对五个文件工具使用严格 Zod Schema，并限制相对路径、列表深度、结果数量、读取行数和补丁长度。
2. `packages/file-tools/src/path-policy.ts` 拒绝绝对路径、盘符、UNC、NUL 和 `..`，逐段拒绝符号链接/Junction；现有目标通过 `realpath` 校验，新增目标通过已存在父目录的真实路径校验。
3. `packages/file-tools/src/file-tool-service.ts` 的 `create_file` 在确认后重新解析目标并使用独占创建；`delete_file` 只接受单个文件或空目录，确认后重新捕获类型与文件身份，再调用 `RecycleBinPort`。
4. `apps/desktop/src/main/index.ts` 在 Main 组合根中把 `RecycleBinPort.moveToRecycleBin` 接到 `shell.trashItem`。Electron 官方文档说明该 API 在 Windows 将目标移动到回收站，完成时 resolve，失败时 reject：[Electron `shell.trashItem`](https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath)。
5. `packages/agent-core/src/agent-loop.ts` 先调用 Provider；如果能力任务在首次可信工具结果前收到普通文本，只允许一次协议修复。只有 Provider 返回工具请求后，流程才进入 `toolRuntime.prepare`、宿主确认和文件工具执行。

以上是代码静态证据；本次纯文档任务没有重新运行桌面测试，也不把 `docs/operations/lightweight-agent-acceptance.md` 中列出的预期命令误写为本次已通过。

### 2.2 为什么替换底层文件 API 无法修复截图故障

故障链和正常链的分叉发生在文件 API 之前：

```text
用户明确文件请求
  → Provider.respond
  → 普通文本拒绝/伪成功                ← 截图故障点
  → AgentLoop 协议修复或稳定失败

用户明确文件请求
  → Provider.respond
  → 结构化 tool_request
  → ToolRegistry Schema 与权限裁决
  → FileToolService.preview
  → 用户确认
  → FileToolService.executeWrite
  → fs 独占创建 / Electron shell.trashItem
```

因此应把修复关注点放在 Provider 工具调用兼容性、工具定义、响应解析、协议修复与纵向契约测试上。只有在工具请求已经形成、确认已经完成、底层 API 实际返回失败时，替换或修复文件端口才可能相关。

## 3. 候选矩阵

| 候选 | 固定版本与提交 | 语言 / 许可证 | 可复用内容 | 与当前可信边界的主要冲突 | 裁决 |
| --- | --- | --- | --- | --- | --- |
| [Cline](https://github.com/cline/cline) | `v4.1.12` / `db6d18a98a34f5c0559175b5c49ce0c5031f33f1` | TypeScript / [Apache-2.0](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/LICENSE) | 自定义工具、逐工具 policy、审批回调、拒绝结果回传循环 | 未显式配置的工具默认启用且自动批准；编辑器使用 `cwd`/路径而非授权根标识；创建会递归建父目录，普通写入不提供本项目的独占创建与确认后身份复核；引入 SDK 会形成第二套 Agent/会话/权限系统 | **仅借鉴** |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `v0.56.0` / `b6e23a7dc29eb15fede4bbe646d91869e948b45a` | TypeScript / [Apache-2.0](https://github.com/google-gemini/gemini-cli/blob/b6e23a7dc29eb15fede4bbe646d91869e948b45a/LICENSE) | `ToolInvocation` 的位置、预览、确认、执行分层；policy engine；可信目录的安全模式 | 与 Gemini 认证、CLI 配置和调度器紧耦合；可信目录主要控制项目配置/扩展能力，不等同于逐次授权根令牌；`write_file` 会递归创建父目录并覆盖现有文件；包含 MCP 路径且本项目必须排除 | **仅借鉴** |
| [OpenAI Agents JS](https://github.com/openai/openai-agents-js) | `v0.17.0` / `0319b657e64e0c132629fe9ed4d524f7cde93445` | TypeScript / [MIT](https://github.com/openai/openai-agents-js/blob/0319b657e64e0c132629fe9ed4d524f7cde93445/LICENSE) | 严格工具参数、动态 `needsApproval`、审批后恢复、输入/输出 guardrail、timeout 与 abort | 审批状态不能替代 Electron Main 的授权根、真实路径和 generation 检查；完整 Runner 会形成第二套 Agent/会话状态；仓库包含 MCP 能力但必须排除 | **仅借鉴；如未来重构需独立获批规格** |
| [OpenAI Codex](https://github.com/openai/codex) | `rust-v0.149.0` / `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0` | Rust / [Apache-2.0](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/LICENSE) | 审批按 turn/call 归属、拒绝/取消终态、命令与补丁审批、有界 head/tail 输出 | Rust 核心、沙箱与 app-server 协议会引入第二运行时；能力面远大于五文件工具；包含 MCP 相关实现且不得接入；不能直接替代 Electron Main 的授权 generation 与确认卡 | **仅借鉴** |
| [jsdiff](https://github.com/kpdecker/jsdiff) | 推荐 `v8.0.3` / `13576bfbcc444ce48f71cfd1e08529bd13962411`；当前仓库为 `8.0.2` | TypeScript/JavaScript / [BSD-3-Clause](https://github.com/kpdecker/jsdiff/blob/13576bfbcc444ce48f71cfd1e08529bd13962411/LICENSE) | `parsePatch`、`applyPatch`，避免自研 unified diff 解析与应用 | 不提供路径授权、确认、竞态复核、原子替换或回收站；必须继续包在 `FileToolService` 内。`8.0.2` 存在补丁解析拒绝服务漏洞 | **可直接复用小模块，但先单独升级到 8.0.3** |

## 4. 候选详查

### 4.1 Cline：借鉴 policy 与拒绝回传，不嵌入 SDK

固定源码：

- 工具与 policy 文档：[`docs/sdk/tools.mdx`](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/docs/sdk/tools.mdx)
- 审批文档：[`docs/sdk/guides/permission-handling.mdx`](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/docs/sdk/guides/permission-handling.mdx)
- 审批适配器：[`sdk/packages/core/src/runtime/tools/tool-approval.ts`](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/runtime/tools/tool-approval.ts)
- 编辑执行器：[`sdk/packages/core/src/extensions/tools/executors/editor.ts`](https://github.com/cline/cline/blob/db6d18a98a34f5c0559175b5c49ce0c5031f33f1/sdk/packages/core/src/extensions/tools/executors/editor.ts)

值得复用的是接口思想：工具可被隐藏、只读工具可自动批准、写工具可要求审批；拒绝也作为一次工具结果进入后续模型循环。Cline SDK 还允许宿主实现 `requestToolApproval`，这与“模型建议、宿主裁决”方向一致。

但它不应直接替换当前实现：官方文档明确写明未列入 `toolPolicies` 的工具默认启用且自动批准，这与本项目“能力默认不暴露、写操作逐次确认”相反；编辑执行器以 `cwd` 限制路径，创建文件时会递归创建目录，普通 `writeFile` 也没有本项目的独占创建和确认后身份复核。若嵌入完整 SDK，还会替换现有 `AgentLoop`、Provider、历史和审批状态机，违反最小修改与单一正式路径原则。

**本地修改记录：** 无；本调研没有复制 Cline 源码。若未来借鉴，只允许在现有 `ToolRegistry`/`AgentLoop` 上实现等价的小接口，并在实施报告中重新记录固定提交和差异。

### 4.2 Gemini CLI：借鉴 ToolInvocation 生命周期，不复用写文件实现

固定源码：

- 工具调用接口：[`packages/core/src/tools/tools.ts`](https://github.com/google-gemini/gemini-cli/blob/b6e23a7dc29eb15fede4bbe646d91869e948b45a/packages/core/src/tools/tools.ts)
- 写文件工具：[`packages/core/src/tools/write-file.ts`](https://github.com/google-gemini/gemini-cli/blob/b6e23a7dc29eb15fede4bbe646d91869e948b45a/packages/core/src/tools/write-file.ts)
- Policy engine：[`packages/core/src/policy/policy-engine.ts`](https://github.com/google-gemini/gemini-cli/blob/b6e23a7dc29eb15fede4bbe646d91869e948b45a/packages/core/src/policy/policy-engine.ts)
- 可信目录文档：[`docs/cli/trusted-folders.md`](https://github.com/google-gemini/gemini-cli/blob/b6e23a7dc29eb15fede4bbe646d91869e948b45a/docs/cli/trusted-folders.md)

`ToolInvocation` 把 `toolLocations`、执行前描述、`shouldConfirmExecute` 和 `execute` 明确分开，适合用来检查本项目现有接口是否遗漏“预览”和“副作用执行”的分层。可信目录在不受信任工作区禁用自动接受和项目级配置，也证明“目录信任”和“工具批准”应当是不同层次。

不能直接复用 `write_file`：它在执行时会递归创建父目录并调用写入服务，成功消息明确区分“新建”与“覆盖”；这与本项目“父目录必须已存在、禁止覆盖”的契约冲突。其可信目录还是 CLI 工作区配置的信任开关，不是模型只持有授权根标识和根内相对路径的 capability。Gemini CLI 的 MCP 代码、扩展系统和 Gemini 认证均不在本次范围。

**本地修改记录：** 无；不复制 Gemini CLI 源码，不引入其 package 或运行时。

### 4.3 OpenAI Agents JS：借鉴工具生命周期，不替换现有 AgentLoop

固定源码：

- 工具定义与审批规则：[`packages/agents-core/src/tool.ts`](https://github.com/openai/openai-agents-js/blob/0319b657e64e0c132629fe9ed4d524f7cde93445/packages/agents-core/src/tool.ts)
- 工具执行与审批衔接：[`packages/agents-core/src/runner/toolExecution.ts`](https://github.com/openai/openai-agents-js/blob/0319b657e64e0c132629fe9ed4d524f7cde93445/packages/agents-core/src/runner/toolExecution.ts)
- 官方 HITL 示例：[`examples/docs/human-in-the-loop/toolApprovalDefinition.ts`](https://github.com/openai/openai-agents-js/blob/0319b657e64e0c132629fe9ed4d524f7cde93445/examples/docs/human-in-the-loop/toolApprovalDefinition.ts)

它在 TypeScript 中提供严格参数 Schema、静态或按参数计算的 `needsApproval`、审批中断后的状态恢复、工具 timeout/abort，以及输入输出 guardrail。最值得吸收的是“参数先成为可检查对象，再做动态审批，批准后仍通过正常校验和执行路径”的生命周期。这与本项目的 `ToolRegistry.prepare → write_request → resume` 方向相符。

但它的 RunState 审批只说明某次工具调用是否获批，不能证明文件路径仍位于授权根、授权 generation 未变化、目标身份未变化或回收站操作成功。整体引入 Runner 也会复制现有 Provider、`AgentLoop`、continuation 和历史职责。因此当前只把其生命周期当作定向测试与接口审查参考；若未来要直接依赖任何 package，必须先有独立、获批的替换规格，并删除被替代的旧循环。仓库中的 MCP 工具不在候选范围。

**本地修改记录：** 无；不引入 `@openai/agents`，不复制其 Runner 或 MCP 源码。

### 4.4 Codex：借鉴审批作用域与输出截断，不引入 Rust 核心

固定源码：

- App-server 审批协议：[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/app-server/README.md#approvals)
- 审批路由：[`codex-rs/core/src/tools/approvals.rs`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/tools/approvals.rs)
- 有界输出：[`codex-rs/core/src/unified_exec/head_tail_buffer.rs`](https://github.com/openai/codex/blob/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0/codex-rs/core/src/unified_exec/head_tail_buffer.rs)

可借鉴两点：审批请求带 thread/turn/call 归属，避免迟到决定作用到新任务；输出保留稳定头尾并显式标记省略字节，优于无界输出或只保留开头。当前项目已有 conversation、generation、过期与取消机制，因此只需把这些模式当作审查清单，不需要复制实现。

Codex 主体为 Rust，审批、沙箱、命令执行和 app-server 彼此耦合。引入它会增加第二进程协议和远超五文件工具的能力面，也无法直接沿用 `VerifiedWriteAction` 的不可伪造对象身份。仓库中的 MCP handler 和 MCP 审批代码明确排除。

**本地修改记录：** 无；不复制 Rust 或生成的协议代码。

### 4.5 jsdiff：继续作为窄依赖，但必须升级安全修复版

固定源码：

- 补丁应用：[`src/patch/apply.ts`](https://github.com/kpdecker/jsdiff/blob/13576bfbcc444ce48f71cfd1e08529bd13962411/src/patch/apply.ts)
- 官方安全公告：[`GHSA-73rr-hh4g-fpgx` / `CVE-2026-24001`](https://github.com/kpdecker/jsdiff/security/advisories/GHSA-73rr-hh4g-fpgx)

`applyPatch` 默认 `fuzzFactor` 为 0，补丁无法匹配时返回 `false`，适合继续承担 unified diff 解析/应用；路径解析、授权、基础正文哈希、原子替换和确认仍必须由 `FileToolService` 负责。

官方公告列出的影响范围是 `>=6.0.0, <8.0.3`，恶意补丁头中的特定换行字符可使 `parsePatch` 无限循环或触发高复杂度正则处理；修复版本是 `8.0.3`。当前 `packages/file-tools/package.json` 与 `pnpm-lock.yaml` 锁定 `8.0.2`，而模型可以产生补丁字符串，所以不能只依赖现有补丁长度上限。后续升级应先用公告中的字符构造最小 RED，再升级依赖并运行 `file-tools` 定向测试、安全测试和直接消费者测试。

**本地修改记录：** 当前仓库已通过 `FileToolService` 调用 `parsePatch`/`applyPatch`；本调研没有改变依赖或实现。建议的 `8.0.3` 升级尚未执行，需另行批准。

## 5. 推荐决策

### 5.1 现在应保留

- 保留现有 `AgentLoop`、Provider adapters、`ToolRegistry`、确认状态机和 Renderer 卡片，不引入第二套 Agent 框架。
- 保留 `packages/file-tools` 作为唯一文件安全实现，继续使用 Node `fs/promises` 完成受控创建/读取/替换。
- 保留 Electron Main 注入的 `shell.trashItem` 作为 `delete_file` 唯一删除端口；不增加 `trash`、`rimraf` 或另一套永久删除库。
- 保留“首次可信工具结果前禁止口头成功/拒绝、只允许一次协议修复”的规则，并把不同 Provider 的真实工具调用响应作为主要测试 seam。
- 保留 MCP 运行时、Agent 接口和 Renderer 入口的禁用状态；候选中的 MCP 功能不进入复用清单。

### 5.2 后续最小行动顺序

1. **安全依赖任务：** 单独规格与 TDD 将 `diff` 从 `8.0.2` 升级到 `8.0.3`，不顺带重构文件工具。
2. **工具调用可靠性调查：** 对截图所用 Provider 做原始、去敏的响应类型核对，确认是模型未调用工具、Provider adapter 丢失 `tool_calls`，还是工具定义兼容问题；在证据不足前不改文件 API。
3. **契约测试：** 为每个支持 Provider 固定“创建文件”和“删除空目录”工具调用 fixture，断言结构化请求在任何文件副作用前产生；保留连续两次普通文本违约的稳定失败测试。
4. **仅在现有 seam 上吸收模式：** 如确有缺口，可借鉴 Gemini CLI 的 `toolLocations/preview/confirm/execute` 分层或 Cline 的拒绝结果回传，但用现有类型和状态机实现，不复制完整框架。

### 5.3 明确不做

- 不用 Cline、Gemini CLI、OpenAI Agents JS 或 Codex 替换当前 `AgentLoop`。
- 不用上游写文件工具替换 `FileToolService`，因为它们的覆盖、目录创建和路径授权语义不满足本项目契约。
- 不因截图故障更换 `fs/promises` 或 `shell.trashItem`；它们位于故障点之后。
- 不开发、恢复、启动或推荐任何 MCP client、MCP server、MCP 工具注册或 MCP 扩展路径。

## 6. 调研与复用记录

| 仓库 | 固定 tag | 固定 commit | 许可证 | 本次本地修改 |
| --- | --- | --- | --- | --- |
| `cline/cline` | `v4.1.12` | `db6d18a98a34f5c0559175b5c49ce0c5031f33f1` | Apache-2.0 | 无 |
| `google-gemini/gemini-cli` | `v0.56.0` | `b6e23a7dc29eb15fede4bbe646d91869e948b45a` | Apache-2.0 | 无 |
| `openai/openai-agents-js` | `v0.17.0` | `0319b657e64e0c132629fe9ed4d524f7cde93445` | MIT | 无 |
| `openai/codex` | `rust-v0.149.0` | `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0` | Apache-2.0 | 无 |
| `kpdecker/jsdiff` | `v8.0.3` | `13576bfbcc444ce48f71cfd1e08529bd13962411` | BSD-3-Clause | 无；仓库当前仍为 `8.0.2` |

版本与提交通过各上游 GitHub release/tag 和只读 `git ls-remote` 交叉核对。后续若复制任何实现正文，必须在实施报告中追加具体源文件、复制片段、本地修改和许可证保留方式；本调研没有复制上游代码。
