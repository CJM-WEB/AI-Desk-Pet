# AI Pet 文件事务纠偏设计

## 1. 背景与目标

`f285a3d` 已修复 Provider 格式诊断、事务过期和多轮工具结果记录，但最终复审仍证明四个承重缺口存在：普通评论可误入文件任务、事务续接缺少本回合期望操作、失败重试可能重放已经成功的写操作、按文件名询问内容没有确定性闭环。

本轮目标是让 Main 对每个文件回合形成不可变的操作意图，并以可信工具结果作为唯一成功事实；同时为“目录下的 test 文件内容是什么”提供不依赖模型猜路径的受控解析。

## 2. 非目标

- 不启用 MCP，不改变 Renderer 的系统权限边界。
- 不引入第二套 Agent 框架，也不复制 OpenCode 的 Effect、权限系统或完整工具实现。
- 不扩大授权根，不允许绝对路径、越界链接或静默写入。
- 不在本轮扩展模糊编辑、递归删除或后台 PowerShell。

## 3. 方案比较

### 方案 A：Main 操作意图票据（采用）

Router 负责识别显式动作或封闭内容问句，并产生 `FilePlanningHint`；事务只保存可信引用和执行账本，不再用更宽的自然语言正则独立决定文件权限。Coordinator 将本回合 `operation` 贯穿到 AgentLoop，只有匹配的可信结果才能完成。

优点是权限判定、工具期望和成功事实使用同一来源，能同时约束 Provider 与本地模型。代价是需要调整 Router、Coordinator 和 AgentService 的接口。

### 方案 B：继续扩大事务正则（拒绝）

为每个误判句补负向规则改动较小，但 Router 与事务会继续存在两套语义，无法证明普通评论和未来用户自定义表达不会绕过边界。

### 方案 C：完全交给模型判断（拒绝）

模型更灵活，但 Provider 输出不是可信授权事实，无法满足普通聊天零工具、真实结果背书和失败重试防重放要求。

## 4. 核心设计

### 4.1 单一意图权威

`CapabilityIntentRouter` 新增事务续接专用判定，返回文件意图时必须同时满足：

1. 当前事务存在可信文件引用；
2. 文本不是否定、引用、代码块或嵌入正文；
3. 文本包含显式文件操作，或是以问句形式闭合的文件内容询问；
4. `createFilePlanningHint()` 能给出确定的 `operation`。

`CapabilityTransactionStore.classifyFollowUp()` 只识别“继续”“重试”“状态”控制词，不再通过“这个文件”“内容是”等词授予语义续接。新任务与带动作的事务续接均由 Router 决定。

### 4.2 本回合操作票据

Coordinator 在首轮和事务续接都创建 `FilePlanningHint`，并将其传给 AgentService。事务 `beginTurn()` 同步保存相同的 `expectedOperation`。AgentLoop 只有观察到与该操作匹配的可信工具结果后，才允许模型输出完成总结。

模型可以先调用 `list_files`、`glob_files` 或 `read_file` 收集信息，但这些中间结果不能为 `edit_file`、`move_file`、`delete_file` 等写意图背书。

### 4.3 安全重试

事务快照额外公开 Main 私有的成功 mutation 摘要，不包含正文或绝对路径。失败事务只有在本回合没有任何成功 mutation 时才允许复用原请求重试；若已发生成功 mutation，Coordinator 只报告“任务部分执行，不能自动重试”，要求用户提交新的明确请求。

模型总结失败但期望 mutation 已成功时继续记为 `completed` warning，不进入重试路径。

### 4.4 按文件名读取闭环

`FilePlanningHint` 可携带经过 Router 严格提取的 `targetNameQuery`。它只接受单个安全文件名，不接受分隔符、通配符、绝对路径或控制字符。

AgentService 在正式 Agent 会话内使用现有 `glob_files` 只读工具搜索授权根，并按相对路径末段进行精确匹配：带扩展名时匹配完整文件名；不带扩展名时匹配完整文件名或文件名 stem。结果处理如下：

- 唯一候选：Main 直接调用现有 `read_file`，发布可信只读结果并显示带相对路径的文件内容；不依赖模型再次猜路径。
- 多个候选：返回结构化目标路径澄清，只展示最多 10 个相对路径。
- 不存在：返回目标路径澄清，说明授权目录内未找到，不索要绝对路径。
- 搜索截断：不把唯一表象当成唯一候选，要求提供更具体的相对路径。

这一模式参考 OpenCode `read`、`glob` 的“先解析位置、再执行真实工具、工具结果是事实”分层，但继续复用本项目 `FileToolService`、`PathPolicy` 与确认边界。参考仓库为 `D:\AgentLearning`，固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`，许可证 MIT。

## 5. 失败与隐私边界

- 候选解析和读取失败不得输出成功文案。
- 普通聊天、否定句、引用与代码块请求始终 `tools: []`。
- 结构化澄清只含授权根内相对路径，不含文件正文、绝对路径、Provider 密钥或内部对象。
- TTL、generation、Provider profile 与 capability revision 变化继续使旧事务失效。
- 任何成功 mutation 都进入防重放账本；事务失败不清除已经发生的本地事实。

## 6. 测试与验收

1. Router/Coordinator：普通评价、否定、引用、代码块为普通聊天；显式续接产生正确 operation。
2. AgentLoop/Coordinator：编辑或移动回合只有匹配 mutation 可完成，只读结果不能背书。
3. 重试：无成功 mutation 可重试；已有成功 mutation 时零 Agent 调用、零重复写入。
4. 文件名读取：唯一、重名、不存在、截断四种结果均由真实临时授权根验证。
5. 外部 Provider 与本地模型的正式三轮链继续通过。
6. 运行 agent-core、desktop、security、integration、`verify:desktop` 与 `git diff --check`。

## 7. 迁移与删除范围

- 删除事务层语义续接正则和仅服务它的测试。
- 清理测试夹具中的 `providerId`、`authorizationRootId`、`fileDisclosureAllowed` 旧字段。
- 保留现有安全文件工具、授权确认、回收站、Provider 配置和 MCP 禁用状态。
