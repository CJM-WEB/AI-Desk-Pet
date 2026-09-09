# 桌宠轻量 Agent 复用与减法设计

> 后续替代（2026-09-05）：本文文件／命令执行器、逐动作确认和旧任务协议由[文件任务重构规格](./2026-09-05-ai-pet-coding-assistant-design.md)替代；普通聊天隔离、路径复核、回收站、脱敏和 MCP 禁用等未冲突边界继续有效。保留以下历史设计，当前实现与验收状态见[新链验收记录](../../operations/2026-09-05-deepseek-qwen-coding-tasks.md)。

**日期：** 2026-08-12  
**状态：** 待用户书面审阅  
**适用范围：** 智能桌宠桌面端；禁止修改网站

## 1. 目标

让桌宠可靠完成基础文件操作和 PowerShell 命令，同时控制代码量、开发时间、模型调用成本与维护成本。

本设计以“成熟方案优先、最小能力闭环优先”为准则，替代原设计中过度复杂的文件 CAS、目录全量身份快照、PowerShell AST 检查器、Windows Job Object 宿主和后台任务系统。

第一版解决三个真实问题：

1. 用户明确要求创建、修改或删除文件时，桌宠必须执行真实工具，不能只口头回答。
2. 用户明确要求运行 PowerShell 时，桌宠必须展示并执行真实命令，不能伪造成功。
3. 普通聊天、命令讨论、文件正文和自主行为不能获得文件或 PowerShell 权限。

## 2. 已确认的威胁模型

第一版防护对象：

- 模型误判普通聊天为执行请求；
- 模型伪造工具成功；
- 相对路径逃逸授权目录；
- 绝对路径、UNC、设备路径和 `..` 越权；
- 静态符号链接或 Junction 指向授权根之外；
- 未确认的写入、删除和 PowerShell；
- 命令超时、输出失控、取消后迟到事件和敏感日志泄漏。

第一版不承诺抵御同一 Windows 用户下的恶意本机进程在检查与操作之间主动制造毫秒级文件替换、符号链接或 Junction 竞态。该边界必须在开发文档中明确，但不需要以吓人的技术提示打扰普通用户。

如果以后需要抵御本机恶意进程，应单独引入真正的受限账户、AppContainer、ACL 沙箱或隔离运行环境；不能用路径前后检查或 `taskkill` 冒充强隔离。

## 3. 开源复用裁决

### 3.1 参考但不直接嵌入

| 项目 | 许可证 | 复用内容 | 不复用内容 |
|---|---|---|---|
| mini-swe-agent | MIT | 线性消息历史、独立命令执行、工具结果继续进入模型循环、有限轮数 | Python 运行时、SWE-bench 环境、仅 Bash 的工具模型 |
| Cline | Apache-2.0 | 文件修改前预览、终端命令逐次确认、工具错误回传模型 | VS Code/CLI/SDK 整体、检查点和多 Agent 系统 |
| Gemini CLI | Apache-2.0 | 工具分类、可信目录、修改器确认、Shell 输出结构 | Gemini 认证、CLI 配置系统、MCP 与扩展系统 |
| Codex | Apache-2.0 | 工作目录、审批、超时、中断、输出截断、环境隔离原则 | Rust 核心、沙箱框架、完整执行策略与桌面产品架构 |

这些项目与本项目的运行时、Provider、Renderer 和会话状态并不相同。直接嵌入会形成第二套 Agent、模型配置、审批和历史系统，总代价高于复用收益。因此只吸收经过验证的设计模式，不引入整个框架。

若后续直接复制开源代码，必须在实现报告中记录仓库、固定提交、源文件、修改点和许可证；没有记录时不得复制实现正文。

### 3.2 允许直接依赖的小模块

- `diff`（jsdiff，BSD-3-Clause）：用于解析和应用统一文本补丁，避免自研 patch 解析器。
- Electron 已有的 `shell.trashItem`：用于进入系统回收站，不再引入额外删除库。
- Node `fs/promises`、`child_process` 与现有 Zod：继续承担文件、进程和结构化参数能力。

不引入 `@cline/sdk`、完整 Gemini CLI、Codex CLI、LangGraph、多 Agent 框架、`node-pty` 或 `node-powershell`。第一版 PowerShell 非交互执行不需要 PTY。

## 4. 总体结构

```text
用户消息
  → CapabilityIntentRouter
     ├─ chat → 现有 ConversationChatAdapter
     ├─ file_task → 现有 AgentLoop + 五个文件工具
     └─ powershell_task → 现有 AgentLoop + 一个 PowerShell 工具
  → 工具结果写回同一线性历史
  → 模型总结
```

保留现有 `ConversationCoordinator`、`CapabilityIntentRouter`、`AgentLoop`、Provider、确认状态机和 Renderer 卡片。不得新建第二套 Agent 循环或第二套权限系统。

AgentLoop 继续遵守：

- 首次真实工具结果出现前，模型不能用普通文本声称完成；
- 违规模型输出只允许一次格式修复；
- 工具结果是成功与否的唯一事实来源；
- 运行轮数、请求长度和工具输出均有上限；
- reset、取消和配置变化使旧请求失效。

## 5. 第一版工具范围

第一版只开放六个工具。

### 5.1 `list_files`

- 列出授权根内指定相对目录；
- 默认不递归；允许的递归深度和返回条目数有固定上限；
- 不跟随静态链接或 Junction；
- 只返回相对路径、类型和截断状态。

### 5.2 `read_file`

- 读取授权根内的文本文件；
- 支持起始行和行数；
- 限制 UTF-8 字节数和返回字符数；
- 二进制、过大文件和越权路径使用稳定错误码拒绝。

### 5.3 `create_file`

- 接受相对路径和可选正文；
- 使用独占创建，目标存在时拒绝，永不覆盖；
- 父目录不存在时默认拒绝，不隐式创建目录树；
- 执行前展示相对路径、字符数和有界预览；敏感或过长正文不展示正文。

### 5.4 `apply_patch`

- 只修改一个已存在的文本文件；
- 使用 jsdiff 的统一补丁解析与应用，不自研 patch 语法；
- 预览阶段读取旧正文、生成差异摘要，并在 Main 私下保存基础正文哈希；哈希不发给 Renderer 或模型；
- 确认后若当前正文哈希变化或原补丁无法精确应用，则稳定拒绝，不做模糊覆盖；
- 新正文先写入同目录临时文件，再替换目标；失败时尽量保留旧文件；
- 单次补丁、目标文件和结果正文均有大小上限。

### 5.5 `delete_file`

- 第一版只删除单个文件或空目录；
- 不接受通配符，不递归永久删除；
- 每次都显示确认卡；
- 执行只调用 Electron `shell.trashItem` 进入回收站；
- 删除结果以本地端口返回值为准。

### 5.6 `powershell`

- 仅在用户明确要求执行命令、脚本、构建、测试或系统操作时暴露；
- 第一版所有 PowerShell 命令都逐次确认，不维护复杂的“自动安全命令”解析器；
- 确认卡展示完整命令、授权工作目录、前台运行方式和通用风险提示；
- 命令、工作目录、会话 generation 或过期时间变化后，旧确认失效。

复制、移动、重命名、创建目录等未提供专用工具的操作，可以由 PowerShell 完成，但必须走完整命令确认。后续只有在真实使用频率和误操作数据证明值得时，才升级为专用工具。

## 6. PowerShell 运行约束

第一版只实现前台、非交互命令：

- 固定调用 `powershell.exe -NoLogo -NoProfile -NonInteractive -Command`；
- 工作目录固定为当前授权根，不接受模型提供的任意绝对 cwd；
- 命令经独立 argv 传入，不拼接到另一个 Shell 命令；
- 环境变量采用最小继承，移除本项目可识别的密钥和认证变量；
- stdout、stderr、退出码、耗时和截断状态分别返回；
- 有固定总超时、静默超时和每流输出上限；
- Abort、reset、窗口关闭和应用退出都会结束当前进程；
- Windows 下使用进程终止与 `taskkill /T` 做尽力清理，但不宣称严格 Job Object 保证。

第一版不实现：

- 交互式终端和 PTY；
- 后台任务、任务列表、游标日志和跨重启恢复；
- PowerShell AST 分类器；
- Windows Job Object/C# 宿主；
- 管理员提权；
- OS 级沙箱。

对直接出现的提权、凭据导出或明显永久递归删除语句可以稳定拒绝；其他无法可靠判断的命令交给用户看完整命令后决定。UI 不得把逐次确认描述成“安全沙箱”。

## 7. 确认、错误和隐私

- 只读文件工具在授权范围内自动执行；创建、补丁、删除和 PowerShell 必须确认。
- 确认数据使用判别联合，Renderer 只接收展示所需的相对摘要。
- 文件正文、PowerShell 输出、完整绝对路径、API key 和 Authorization 不进入诊断日志。
- PowerShell 完整命令只允许出现在用户确认卡、受控执行输入和当前会话工具历史中，不写普通日志。
- 工具失败返回稳定错误码和下一步建议；模型不得把失败改写为成功。
- 工具已经本地成功但模型总结失败时，UI 明确显示“操作已完成，但总结失败”。

## 8. 替换与删除

本设计批准后，后续实施计划必须：

1. 保留已经完成并验证的可信意图路由和文件规划协议。
2. 撤销当前尚未完成的 `SecureFileSystemPort`、目录后代 seal、文件身份回滚与复杂 CAS 实验代码。
3. 将原十个文件操作收敛为五个文件工具，不保留旧工具别名或双轨注册。
4. 删除 PowerShell AST Inspector、Job Object 和后台任务的计划任务；不得先实现再弃用。
5. 若旧测试只验证被替换的复杂设计，应同步删除或改写为新工具的行为测试。

撤销仅针对当前未完成实验差异，不使用 `git reset --hard`，不覆盖用户其他改动。

## 9. 测试与验收

### 9.1 单元测试

- 六个工具的参数 schema 均为严格模式；
- 普通聊天、命令讨论、代码块和文件正文不能触发工具；
- `create_file` 不覆盖；
- `apply_patch` 冲突时不写入，写入失败不留下成功事件；
- `delete_file` 只调用回收站端口且不支持递归永久删除；
- PowerShell 确认哈希、generation、超时、取消、输出截断和环境脱敏成立；
- 违规模型拒绝和伪成功不能越过工具结果。

### 9.2 纵向验收

- “创建 empty.txt”出现确认，确认后真实落盘；
- “删除 empty 文件夹”在空目录情况下进入回收站；
- 修改文本展示补丁摘要，确认后只产生预期差异；
- “运行 Get-ChildItem”显示完整命令确认，执行后返回真实输出；
- 普通聊天不要求目录授权，也不创建 PowerShell 进程；
- reset 后旧确认和迟到进程事件均失效；
- 完整 Desktop 单元、安全、集成与 Electron E2E 通过；
- `apps/website` 零差异且不运行网站任务。

## 10. 成本控制

- 不为第一版实现多 Agent、MCP、长期记忆、浏览器、后台 Shell 或复杂沙箱。
- 每个新依赖必须说明删除了多少自研职责；不能只为一个简单辅助函数引入大型依赖。
- 每个功能先写一个最小纵向测试，再补关键失败路径；不穷举与已确认威胁模型无关的本机恶意竞态。
- 单点调查超过 10 分钟时停止原路径，选择更小的接口、成熟依赖或明确延期。

## 11. 与旧设计的关系

本文取代 `2026-08-12-ai-pet-capability-behavior-geometry-design.md` 的第 5 节、第 6 节、第 10 节中有关文件与 PowerShell 的条款，以及原可信能力实施计划中相应任务。角色行为、缩放、碰撞范围和拖拽修复设计不受影响。

## 12. 参考资料

- [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
- [Cline](https://github.com/cline/cline)
- [Gemini CLI 工具说明](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md)
- [Gemini CLI PowerShell 说明](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md)
- [Codex](https://github.com/openai/codex)
- [jsdiff](https://github.com/kpdecker/jsdiff)
