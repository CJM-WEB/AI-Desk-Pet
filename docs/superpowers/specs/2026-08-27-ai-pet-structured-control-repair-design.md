# 桌宠统一结构化控制与本地 Agent 修复设计

**日期：** 2026-08-27  
**状态：** 已获用户授权实施  
**适用范围：** Electron 桌面端、Agent Core、文件工具与角色行为运行时；不修改官网，不启用 MCP，不制作安装包

## 1. 背景与根因证据

本轮不是继续补充孤立关键词，而是修复模型理解到本地执行之间的转换层。

已确认两个故障具有相同结构：

1. `帮我在当前目录下创建ab.txt文件` 同时包含创建动作和本地文件对象，但现有 `CapabilityIntentRouter` 只接受少数固定语序，将它确定性降级成普通聊天。普通聊天固定传入 `tools: []`，因此 Provider 模型与内置本地模型都不可能调用文件工具。
2. `时不时动一下` 未命中固定行为 Gate；模型提示又没有“间歇运动”语义，反而容易返回持续运动。云模型的普通文本回退还会静默丢失行为字段，最终表现为一直静止或一直移动。

下游 `AgentLoop → ToolRegistry → PendingAction → FileToolService` 在正确进入能力任务时已有真实落盘测试，故本轮不能用重写文件 API 掩盖上游分流故障。

## 2. 目标

1. 用户以自然语序明确要求文件、目录或 PowerShell 操作时，Provider 与内置本地模型都进入真实工具循环，不能口头拒绝或伪造成功。
2. 同一任务可连续使用文件工具与前台 PowerShell，支持创建、读取、搜索、编辑、移动、删除、复制、构建、测试及程序执行等组合任务。
3. 用户关于运动的表达稳定归一为三态：`0` 一直静止、`1` 持续运动、`2` 每隔 10–30 秒随机短程移动一次；一次性移动不得污染持久模式。
4. 模型负责语义建议，Electron Main 继续独占工具裁决、参数校验、确认、路径安全、真实执行和结果事实。
5. 用户自定义角色动作继续按公开状态、动作、语义和标签选择相似度最高候选；模型不得提交私有资源标识或脚本。

## 3. 非目标

- 不把 OpenCode 整体运行时、Effect、Bun、AI SDK、数据库、插件或子 Agent 系统嵌入桌宠。
- 不复制 OpenCode 默认全放行权限、宿主 Shell 环境继承、动态路径跳过审计或九级模糊编辑。
- 不开放管理员提权、后台命令、无人值守永久删除、跨授权根读写或 OS 级桌面自动化。
- 不启用 MCP，不恢复截图或剪贴板能力，不新增长期记忆。
- 不承诺任意模型都具备相同推理质量；契约失败必须明确报错或走一次受限修复，不能静默变成无能力聊天。

## 4. 方案比较与裁决

### 4.1 方案 A：继续补正则和提示词

改动最小，但每种自然语序都会形成新盲区，且文件与行为仍是两套互相独立的转换协议。已连续多轮失败，不再采用。

### 4.2 方案 B：完全仿照 OpenCode，所有聊天始终暴露全部工具

模型自由度最高，但普通聊天可能触发授权目录读取；OpenCode 默认权限和宿主 Shell 威胁模型也不适合桌宠。不能原样采用。

### 4.3 方案 C：本地证据 Gate 与模型结构化控制计划合并

采用该方案。Main 先用与语序无关的正向证据识别明确执行请求；未被本地 Gate 直接裁决的自然语言由聊天响应中的严格控制计划补充。两者汇入唯一 `TurnControlPlan`，再进入统一 Agent 工具循环或角色行为执行器。否定、引用、代码块和知识讨论仍由本地拒绝证据封闭。

该方案保留普通聊天的数据最小化，同时修复固定语序脆弱性，并允许模型处理更多自然表达。

## 5. 统一控制协议

### 5.1 能力计划

新增严格判别联合：

```ts
type CapabilityControlPlan =
  | { kind: 'chat' }
  | { kind: 'agent_task'; preferredTool: AgentPlanningTool | null };
```

- 本地 Gate 只判断“是否明确要求执行本地任务”，不再要求操作、地点和对象以固定顺序排列。
- `preferredTool` 仅收窄第一轮工具，不解释路径、不签发权限，也不限制后续组合任务。
- 模型结构化计划只能建议 `chat` 或 `agent_task`；Main 的否定、引用、代码块、越权路径和设置状态仍可拒绝。
- 复制不再在 Router 中提前报“不支持”；模型可以选择受控 PowerShell `Copy-Item`，仍需逐次确认。

### 5.2 运动计划

持久状态只保留一个入口：

```ts
type MovementControlPlan =
  | { kind: 'keep' }
  | { kind: 'set_mode'; mode: 0 | 1 | 2 }
  | { kind: 'move_once'; target: PublicMotionTarget; distance: MoveDistance };
```

语义固定如下：

- “停止、保持静止、不要再动” → `set_mode(0)`；
- “一直、持续、保持运动” → `set_mode(1)`；
- “时不时、偶尔、间歇、恢复自主活动” → `set_mode(2)`；
- “动一下、跑远一点、去屏幕左边” → `move_once`，不改变持久模式。

删除 `behaviorPlan.stop_movement/resume_movement` 与 `motionPlan.stop/continuous` 对同一持久状态的双写竞争。`behaviorPlan` 只负责选择动画候选，`MovementControlPlan` 独占运动策略。

显式 `mode=2` 不受普通聊天主动性设置阻断；它是用户直接选择的运动策略。Scheduler 每次等待 10–30 秒，向 Director 请求一次真实随机屏幕运动；到达目标附近或运动结束后停止移动并回到 idle，再重新抽取下一次间隔。

## 6. 统一 Agent 工具循环

### 6.1 工具集合

文件与 PowerShell 不再创建互斥的两种 Session Registry。统一 Agent Session 公告：

- `list_files`
- `read_file`
- `glob_files`
- `grep_files`
- `create_file`
- `create_directory`
- `edit_file`
- `apply_patch`
- `move_file`
- `delete_file`
- `powershell`
- 无权限结构化澄清工具

Main 可根据 `preferredTool` 收窄第一轮；第一次可信工具结果后恢复完整工具表，使模型可以完成“读取→修改→运行测试”或“创建→移动”等多步任务。

### 6.2 OpenCode 复用范围

参考仓库：`https://github.com/anomalyco/opencode.git`  
固定提交：`2a6be0a03b93a6734070e10a6c3b56863475f214`  
许可证：MIT

吸收并在本项目接口上重写以下模式：

- `packages/opencode/src/tool/tool.ts`：公告 Schema 与运行时 Schema 二次校验；
- `packages/opencode/src/session/tools.ts`：统一工具注册和执行桥；
- `packages/opencode/src/session/prompt.ts`：工具结果后继续循环；
- `packages/opencode/src/session/llm.ts`：参数错误向模型回灌并只允许受限修复；
- `packages/opencode/src/session/processor.ts`：工具 running/completed/error 状态和三次相同调用熔断；
- `packages/opencode/src/permission/index.ts`：确认暂停、回复后原调用栈续跑。

不直接复制 OpenCode Shell、权限默认值、模糊编辑器或会话持久化代码。若最终确有逐段复制，必须在第三方声明中记录源文件、代码段和本地修改；否则只记录设计来源。

### 6.3 PowerShell 边界

继续复用现有 `PowerShellTool`：

- `powershell.exe -NoLogo -NoProfile -NonInteractive -Command`；
- 工作目录固定为当前授权根；
- 每条命令逐次展示完整命令并确认；
- 前台执行，支持超时、取消、有限输出和进程树清理；
- 不继承项目可识别的密钥，不允许管理员提权；
- 明显永久递归删除、凭据导出和越权工作目录稳定拒绝。

## 7. 错误与修复协议

- 工具参数不符合 Schema 时，将稳定错误码作为 tool-result 回灌模型，最多修复一次；不能直接显示笼统“任务执行失败”。
- 相同工具和相同参数连续三次时终止为 `AGENT_REPEATED_TOOL_CALL`。
- 工具失败继续以可信结果进入模型；模型总结不得覆盖失败事实。
- 模型返回口头“无法操作文件”，但 Main 已判定为明确 Agent 任务且尚无可信工具结果时，视为协议违例并要求一次工具调用修复。
- 结构化控制计划缺失时：明确本地证据仍可进入 Agent；普通聊天保留正文，但不执行行为副作用。
- UI 公开稳定的具体错误和下一步，不把未知内部异常重复投影成多个相同错误卡。

## 8. 安全与隐私不变量

- Renderer 不获得文件系统、进程或密钥能力。
- Provider 的控制计划和工具调用都只是建议；Main 每次重新校验 Schema、授权根、真实路径、冲突、generation 和确认令牌。
- 文件路径继续使用授权根标识和根内相对路径；拒绝绝对路径、UNC、设备路径、`..`、链接/Junction 越界和受保护区域。
- 写入、移动、删除与 PowerShell 每次确认；删除默认进入回收站。
- 普通聊天不读取文件正文；只有已经进入 Agent 任务且获得现行授权时才公告读取工具。
- MCP 运行时、Agent 与 Renderer 继续禁用。

## 9. 删除与迁移范围

新路径通过纵向测试后删除：

- 文件 Router 中依赖固定中文语序的执行结构拼接逻辑；
- `unsupported_file_operation/copy_file` 的提前失败分支；
- 文件 Session 与 PowerShell Session 的互斥工具注册路径；
- 行为持久状态的 `stop_movement/resume_movement` 双入口；
- 提示词中把“一会儿”无条件映射为无限 `continuous` 的旧规则；
- 只验证旧双轨协议的测试和别名。

保留路径安全、确认卡、文件执行器、PowerShell 执行器、Provider Adapter 和角色候选相似度选择器。

## 10. TDD 与验收

### 10.1 RED 用例

1. 截图原句及常见语序必须进入 `agent_task`，并生成 `create_file` 首轮提示。
2. Provider 与内置本地模型参数化纵向用例：原句 → 工具调用 → 确认卡 → 确认 → `ab.txt` 真实存在。
3. 多步任务：创建文件后移动；读取后编辑并运行 PowerShell；复制通过 PowerShell 确认后产生真实目标。
4. 普通聊天、否定、引用和代码块不公告文件/PowerShell 工具。
5. 工具参数错误可修复一次；相同调用三次熔断；失败结果不能被模型总结成成功。
6. `时不时动一下/偶尔动一下/自己偶尔走动` → `mode=2`；`一直运动` → `mode=1`；`停止不动` → `mode=0`。
7. `mode=2` 在 10、20、30 秒边界各触发一次真实随机运动，结束后回到 idle 并重新计时；不得变成连续运动。
8. Provider 与本地模型使用相同控制 Schema 和相同 Main 状态转移。

### 10.2 自动门禁

- 相关 package 定向单元测试与 typecheck；
- `pnpm.cmd verify:desktop`；
- `pnpm.cmd verify:behavior`；
- `pnpm.cmd test:security`；
- `pnpm.cmd test:integration`；
- Electron E2E 覆盖真实确认、落盘、PowerShell 和三态诊断；
- 内置本地模型真实验收覆盖一次文件创建与 `mode=2` 控制。

### 10.3 人工边界

自动化必须证明文件副作用和状态机诊断值。真实动画观感、移动距离体感与确认卡可读性仍标记为待用户人工验收。

## 11. 完成标准

- 截图原句在 Provider 与内置本地模型上都出现创建确认卡，确认后真实落盘。
- 文件、目录与前台 PowerShell 能在同一 Agent 任务中组合执行，失败时给出可信具体结果。
- 三态由唯一控制协议驱动；`mode=2` 可重复观察为间歇真实移动而非持续动画。
- 旧双轨状态入口和固定语序执行结构已经删除。
- 自动门禁有新鲜证据，实际目录同步到最终提交，未生成安装包。
