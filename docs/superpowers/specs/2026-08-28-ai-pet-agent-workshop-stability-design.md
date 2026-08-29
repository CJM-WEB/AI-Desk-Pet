# AI 桌宠 Agent 与角色工作台稳定性设计

**日期：** 2026-08-28  
**状态：** 已获用户批准，可在严格自审后持续实施  
**适用范围：** Electron 桌面端、Agent Core、受控文件工具、角色运行时与角色工作台；不修改官网，不启用 MCP，不制作安装包

**替代关系：** 本规格在文件任务连续性、显式任务文件披露、Provider 格式故障、角色工作台布局和角色运动原生坐标容错范围内，替代 `2026-08-27-ai-pet-intent-and-behavior-orchestration-design.md`、`2026-08-27-ai-pet-structured-control-repair-design.md` 与 `2026-08-26-ai-pet-regression-closure-design.md` 的对应旧实现。旧规格中的授权根、Main 可信边界、逐次写确认、回收站删除、真实工具结果权威、MCP 禁用和角色包 V2 兼容约束继续有效。

## 1. 现状证据与根因

### 1.1 文件任务不是执行器故障，而是上游任务链断裂

定向真实文件测试已证明 `FileToolService` 的创建、编辑和移动副作用可用。故障发生在它之前：

- “请你把 order 文件放入到 a 文件夹中”和“请你告诉我目录下的 test 文件内容是什么”被 Router 降级为普通聊天；
- “请编辑刚创建的文件”虽然出现错误的创建提示，但仍走普通聊天；
- “继续”“成功了吗”等后续输入会新建普通聊天回合，不会续接上一个文件任务；
- 普通聊天没有工具，却允许模型口头声称“正在移动”或“已经完成”，造成无副作用的伪成功；
- `privacy.dataCategories.file=false` 会从工具目录中移除读取、列出和检索工具，导致创建后无法执行可靠的“读取→编辑”链；
- 多种 Provider 解析失败被折叠为同一“模型响应格式不兼容”，缺少可判定的脱敏子原因。

结论：不能再扩大关键词表，也不能重写已能工作的文件 API。需要修复“用户意图→任务事务→工具循环→真实结果”这一条链。

### 1.2 工作台弹窗没有进入浏览器顶层

扩展状态与发布要求弹窗使用 `<dialog open>`。`open` 只显示元素，不会进入浏览器 top layer；Pixi 预览 Canvas 的定位图层因此可覆盖弹窗并截获点击。仓库已有 `IncompleteCharacterDialog` 使用 `showModal()` 的正确模式，可以直接复用。

### 1.3 工作台布局由固定网格控制

工作台左右列、侧栏上下分区和预览/时间轴分区均由固定 `grid-template-columns/rows` 控制，没有 splitter、Pointer Capture、键盘调节或持久化。窄窗口只切换为堆叠布局，因此内容可能被压缩到不可用。

### 1.4 Electron 错误弹窗来自负零坐标

角色靠近屏幕上边缘时，`Math.round(-0.1)` 会得到 JavaScript 的 `-0`。`BrowserWindow.setPosition(2, -0)` 在 Electron 原生 Int32 参数转换时抛出 `TypeError`，而定时器边界没有捕获同步异常，最终弹出主进程错误窗口。合法的多显示器负整数坐标不能因此被禁止。

## 2. 目标

1. 显式文件任务在同一会话内可连续完成创建、读取、搜索、精确编辑、补丁、移动、删除和受控 PowerShell 组合操作。
2. “刚创建的文件”“那个文件”“继续”“成功了吗”等后续表达只续接当前有效任务，不再丢失真实工具上下文，也不能绕过确认。
3. 模型口头成功不产生成功状态；只有 Main 收到的真实工具完成结果可以建立文件引用和成功事实。
4. Provider 格式不兼容具有可诊断、脱敏的子原因，并允许一次有界修复；普通聊天失败不得误触发文件任务错误。
5. 工作台模态弹窗始终位于预览之上并可鼠标、键盘操作。
6. 工作台主要分区可拖拽或键盘调整，尺寸本地持久化并在窗口/DPI 变化后安全收敛。
7. 删除角色工作台皮肤编辑界面，同时保留角色包 V2 默认皮肤、多皮肤导入、编译、发布与运行时兼容。
8. 角色运动永不把 `-0` 或越出 Int32 的坐标交给 Electron；定时任务异常被收口，不再弹出未捕获主进程错误。

## 3. 非目标

- 不整体嵌入 OpenCode 的会话数据库、Effect/Bun 运行时、插件、Provider、权限默认值、Shell 或子 Agent。
- 不开放跨授权根、绝对路径、UNC、设备路径、Junction 越界、管理员提权、无人值守写入或永久递归删除。
- 不让 Renderer 直接访问文件系统、进程、密钥或原生窗口坐标。
- 不恢复 MCP、截图、剪贴板或长期保存文件正文。
- 不删除角色包的 `skins` 契约，也不破坏已导入多皮肤角色的加载和启用。
- 不把布局自由拉伸解释为任意脱离窗口的浮动面板；本轮只实现工作台内部四条受约束 splitter。

## 4. 选定方案

采用“会话级能力事务 + 现有可信工具链 + 最小工作台分隔器”的方案。

继续补正则无法可靠处理省略、指代和多步任务；整体复制 OpenCode 会引入第二套 Agent、权限和 Shell 边界。选定方案只借鉴其成熟的工具消息图、同会话续跑、参数错误回灌、工具结果权威和读后编辑模式，并映射到本项目已有的 Main、AgentLoop、ToolRegistry、PendingAction 与 FileToolService。

## 5. 文件任务设计

### 5.1 会话级能力事务

Main 为当前聊天 generation 维护且只维护一个短生命周期事务：

```ts
type CapabilityTransaction = {
  id: string;
  generation: number;
  kind: 'file' | 'powershell';
  phase: 'planning' | 'awaiting_clarification' | 'awaiting_confirmation' | 'running' | 'completed' | 'failed';
  providerId: string;
  authorizationRootId: string;
  toolTranscript: TrustedToolTurn[];
  references: TrustedFileReference[];
  pendingActionId?: string;
};
```

- `toolTranscript` 只记录工具名、脱敏参数摘要、稳定结果码和任务内可用引用；不写普通日志、长期记忆或 Renderer 非必要状态。
- `references` 只能由成功的真实工具结果建立，例如刚创建、刚读取或刚移动的相对路径；模型文字不得创建引用。
- 明确的新任务替换已完成或可取消的旧事务；新聊天、reset、窗口关闭、Provider/配置/授权根变化、generation 变化和有效期到期会立即失效事务及旧确认。
- “继续”“继续执行”在 `awaiting_confirmation` 阶段只提示用户操作现有确认卡，不执行也不生成新确认；在 `awaiting_clarification` 阶段只补全原任务；在 `completed/failed` 阶段回答真实终态。
- “成功了吗”只读取事务的可信终态，不重新调用工具。

### 5.2 候选 Gate 与完整工具循环

- 本地 Gate 只判断是否存在显式本地能力意图、明确否定/引用/代码块和普通聊天，不再决定完整操作步骤。
- 一旦进入经授权的文件任务，Agent Session 公告完整受控文件工具表：`list_files`、`read_file`、`glob_files`、`grep_files`、`create_file`、`create_directory`、`edit_file`、`apply_patch`、`move_file`、`delete_file`；明确 PowerShell 任务另加 `powershell`。
- Router 的 `preferredTool` 只作为首轮规划提示，不能删掉后续必要工具。这样“创建→编辑”“读取→精确修改”“创建→移动”可在同一事务中闭环。
- 工具参数 Schema 错误以稳定 tool-result 回灌，最多修复一次；相同工具与同参数连续三次触发熔断。
- 模型没有调用工具却口头声明完成时，事务不得成功；显式文件任务可进行一次“必须调用工具或返回结构化澄清”的修复，仍无工具则以具体协议错误结束。

### 5.3 任务级文件披露

用户已选择授权根并明确要求读取、编辑或处理其中的文件时，该显式任务本身构成仅限当前事务的文件内容披露同意：

- 普通聊天仍然传入 `tools: []`，不会读取或发送文件内容；
- 显式文件事务可使用读取、列出、Glob 和 Grep，以完成读后编辑和结果核验；
- 文件内容继续带“不可信数据”标记，不能成为系统指令；
- 写入、移动、删除和 PowerShell 仍逐次显示准确确认卡；
- 旧 `privacy.dataCategories.file` 与 `fileDisclosureAccepted` 不再作为执行 Gate。迁移时忽略旧值并删除仅服务该 Gate 的设置文案、IPC 分支和运行时过滤逻辑；其他隐私设置不受影响；
- 文件正文、完整绝对路径和 PowerShell 输出不进入普通日志或长期记忆。

### 5.4 Provider 格式兼容与诊断

- 在 Provider Adapter 边界把格式失败区分为：HTTP 非 JSON、JSON 结构缺失、结构化计划 Schema 不匹配、工具调用参数非法、流式终态缺失和协议不支持。
- 对外只显示稳定中文原因和可执行下一步；诊断事件只含 Provider 类型、阶段、稳定子码和请求 correlation id，不含密钥、正文、完整路径或原始响应。
- 结构化计划 Schema 不匹配时允许一次无副作用修复请求；已经产生工具副作用后不重放整个请求。
- 普通聊天正文可用但控制字段缺失时保留聊天正文、忽略副作用并记录脱敏控制错误；不能把它显示为文件任务执行失败。
- 文件事务在格式失败后保留可信工具历史，用户重试可从最后可信状态续接，不重复已成功写操作。

### 5.5 OpenCode 参考与许可

参考仓库：`https://github.com/anomalyco/opencode.git`  
本地参考：`D:\AgentLearning`  
固定提交：`2a6be0a03b93a6734070e10a6c3b56863475f214`  
许可证：MIT

仅复用并在本项目接口上重写以下模式：

- 工具 Schema 公告与执行时再次校验；
- assistant/tool-result 交替的同会话消息图；
- 工具参数错误作为结果回灌后有限重试；
- 读取后精确编辑、冲突失败和真实结果权威；
- 等待权限确认后从原调用栈续跑。

不直接复制绝对路径策略、默认权限、模糊编辑器、Shell 环境继承或数据库实现。若实施中逐段使用外部源代码，必须增加第三方声明，注明源文件、代码段与本地修改。

## 6. 角色工作台设计

### 6.1 原生模态顶层

- 抽取或复用受控 `<dialog ref>` 模式，在状态打开时调用 `showModal()`，关闭时调用 `close()`；不再渲染 `<dialog open>`。
- 扩展状态与发布要求弹窗都进入 top layer，支持 Escape、提交后关闭和卸载清理。
- E2E 必须通过真实点击被预览覆盖区域的按钮来验证命中，不能只用 Enter 绕过点击问题。

### 6.2 四条受约束 splitter

工作台桌面布局提供四条分隔器：左侧栏/预览、预览/右侧属性、左栏角色区/状态区、中央预览/时间轴。

- 复用 `AnchorEditor` 的 Pointer Capture 模式；拖动只更新 CSS 自定义属性，不触发高频 Main IPC。
- 分隔器具有 `role="separator"`、方向、`aria-valuenow/min/max`，方向键按固定步长调节，Shift+方向键使用较大步长。
- 每个分区设最小可用尺寸；窗口 resize、DPI 改变和恢复旧值时统一 clamp，保证预览、属性和操作按钮始终可达。
- 指针释放或键盘调节结束时，通过现有 SettingsStore 扩展出的最小强类型 IPC 持久化；保存失败保留本次界面尺寸并显示非阻塞提示，下次启动恢复上一次成功持久化值；若从未成功持久化，则由 SettingsStore 返回默认值。
- 小于现有响应式阈值时继续使用堆叠布局并隐藏 splitter；回到桌面布局时恢复经 clamp 的持久化尺寸。

### 6.3 删除皮肤编辑界面

- 从工作台移除 `SkinList`、`SkinInspector`、皮肤板块标题、增删改入口和只为这些入口服务的样式与测试。
- 工作台继续编辑当前角色默认皮肤下的状态与动作；角色包 V2 的 `skins`、`defaultSkinId`、多皮肤导入/导出/编译/发布和运行时选择保持不变。
- 不批量删除用户角色数据，也不迁移角色包内容。

## 7. 角色运动原生边界

- `integerPosition()` 在舍入后把 `-0` 规范化为 `+0`，同时保留 `-1`、`-200` 等合法多显示器负坐标。
- 调用 Electron 前验证 x/y 为有限、安全且位于 Int32 范围内的整数；非法值不进入原生 API，而是返回稳定内部错误并停止本次运动。
- 定时器 guard 捕获同步与异步异常，停止相关 timer，最多报告一次脱敏内部错误；窗口销毁、服务停止或同一故障重复发生不会弹出未捕获异常。
- 不吞掉正常编程错误：测试和诊断端仍能观察稳定错误码，但用户界面不显示 Electron 堆栈或绝对路径。

## 8. 失败、安全与隐私不变量

- Electron Main 是唯一执行与事实裁决边界；Provider 只能建议工具调用。
- 路径始终使用授权根标识与根内相对路径，写操作确认令牌绑定事务、Provider、配置、授权根、目标快照和 generation。
- 文件创建不得覆盖；编辑必须基于读取后的精确内容或可验证补丁；移动冲突不得静默覆盖；删除默认进回收站。
- 工具失败、取消、超时或格式失败都不能发布成功事件；模型总结不能改写真实结果。
- Renderer 只接收展示所需的脱敏任务状态、确认预览和结果，不接收私有工具 transcript。
- MCP 的源码和持久化数据可保留，但运行时、Agent 和 Renderer 继续禁用。

## 9. 删除与迁移范围

新路径通过定向测试后删除：

1. 只服务单轮文件关键词分流、错误 `preferredTool` 限制和普通聊天口头成功的旧分支；
2. 文件任务中的 `fileDisclosureAllowed` 工具过滤及对应隐私 UI/IPC 活跃路径；旧持久化字段仅做向后兼容读取后丢弃；
3. `<dialog open>` 的扩展状态和发布要求旧渲染路径；
4. `SkinList`、`SkinInspector` 生产入口及只验证已退役皮肤编辑 UI 的测试和样式；
5. 被 CSS 变量与 splitter 取代的固定桌面网格常量。

保留 FileToolService、PathPolicy、PendingAction、回收站、PowerShell、Provider Adapter、角色包 V2 皮肤契约、运行时多皮肤兼容和窄屏堆叠布局。

## 10. TDD 与验收

### 10.1 文件事务 RED 用例

1. “创建 test.txt”确认并真实创建后，“把刚创建的文件内容改为 hello”会先读取再产生编辑确认，确认后磁盘内容为 `hello`。
2. “把 order 文件放入 a 文件夹”进入文件任务，确认后真实移动；模型口头声称移动但没有 tool-result 时事务失败且磁盘不变。
3. “目录下的 test 文件内容是什么”能在授权根内解析唯一候选并真实读取；重名或不存在时给出带候选的结构化澄清，不索要无意义的完整绝对路径。
4. `继续` 在确认前不执行，在确认后续接原工具循环；`成功了吗`只报告真实终态。
5. `privacy.dataCategories.file=false` 的旧设置不会阻断显式文件事务读取，但普通聊天工具表仍为空。
6. Provider 与内置本地模型参数化运行同一创建→编辑→移动纵向用例。
7. 普通聊天结构化控制缺失时仍显示聊天正文；六类格式故障各映射到独立稳定子码且日志不含敏感正文。

### 10.2 工作台 RED 用例

1. 扩展状态和发布要求弹窗 `showModal()` 后位于 top layer，覆盖预览区域的按钮可真实点击。
2. 四条 splitter 支持指针捕获、键盘调节、最小尺寸 clamp、窗口缩小后收敛和重新打开后的持久化恢复。
3. 窄屏堆叠时 splitter 不可见且内容顺序可达。
4. 页面中不再出现皮肤编辑板块；导入含多个皮肤的 V2 角色仍可编译、发布和在运行时启用默认皮肤。

### 10.3 运动 RED 用例

1. x/y 分别为 `-0` 时传给 fake BrowserWindow 的值满足 `Object.is(value, 0)`。
2. 合法负整数坐标原样保留。
3. NaN、Infinity、非整数和 Int32 越界值不调用原生 API。
4. fake `setPosition` 同步抛错时 timer 被停止、只报告一次稳定错误，后续 tick 不再抛出未捕获异常。
5. 窗口已销毁和服务已停止时不调用原生 API。

### 10.4 自动门禁

- 相关 package 定向测试和 typecheck；
- `pnpm.cmd verify:desktop`；
- 文件/IPC/日志变更追加 `pnpm.cmd test:security` 与 `pnpm.cmd test:integration`；
- 角色行为追加 `pnpm.cmd verify:behavior`；
- 角色工作台追加 `pnpm.cmd verify:characters` 和真实 Electron 点击/拖动 E2E；
- `git diff --check` 与只读差异复核。

### 10.5 人工边界

自动化必须证明真实临时目录的创建、编辑、移动副作用，事务状态变化、弹窗命中、布局值变化和负零不进入原生 API。真实 Windows 窗口层级观感、分隔器手感和长时间桌宠运行仍标记为待用户人工验收。

## 11. 完成标准

- Provider 与内置本地模型都能在同一显式文件事务中完成创建→读取→编辑→移动，并且所有成功均有真实工具证据。
- 普通聊天不再误报“任务执行失败”，格式不兼容具有准确、脱敏的子原因。
- 两个问题弹窗均使用原生模态顶层，四条 splitter 可调、可恢复、可收敛，皮肤编辑 UI 已删除而角色包兼容保持。
- `-0`、越界坐标和 timer 异常都被 Main 边界收口，不再出现未捕获 Electron 错误弹窗。
- 旧失效路径按批准范围清理，相关自动门禁有新鲜通过证据；安装包与用户人工观感不在本轮完成声明中。
