# AI 桌宠四项回归收口设计

日期：2026-08-26

状态：用户已授权在严格自审后持续实施，不再逐环确认

## 1. 目标

本轮只处理四项已复现或已定位的问题：

1. 拖拽期间桌宠窗口和可见角色尺寸恒定，窗口紧跟真实系统光标。
2. OpenAI-compatible、Anthropic、Gemini 三类云 Provider 的普通可见回复使用流式传输；本地模型现有流式链保持不变。
3. 最新桌宠的创建、读取、检索、编辑、移动和回收站删除使用同一 Main 可信工具链；旧构建、隐私阻断或工具失败必须显示准确原因，不能表现为模型口头成功。
4. 用单一数值运动模式替换互相竞争的运动布尔锁：`0=持续静止`、`1=持续运动`、`2=间歇自主运动`。

## 2. 非目标与边界

- 不恢复滚轮缩放；桌宠运行尺寸固定为默认尺寸。
- 不启用 MCP、任意 Shell、绝对路径、覆盖写、永久删除或递归删除。
- 不把 OpenCode 的会话、权限、插件、Shell 或数据库框架整体移入桌宠；只复用逐工具调用终态、错误回注和继续循环的业务模式。
- 工具规划、工具参数和失败后的可信总结保持缓冲完成，不向 Renderer 流出不完整工具参数或模型提前宣称的成功文字。
- Renderer 不获得文件系统、进程、全局光标或最终窗口坐标权限。
- 本轮不制作安装包。

## 3. 已确认根因

### 3.1 拖拽尺寸和延迟

自定义拖拽调用 `CharacterMotionService.beginUserMove()` 后，每次 `BrowserWindow.setPosition()` 产生的原生 `moved` 事件都会调用 `endUserMove()`。第一帧移动便错误释放拖拽所有权，随后 `PetGeometryCoordinator` 在按住期间重新获得布局权限并调用仓库中唯一可改变窗口宽高的 `setBounds()`。现有 Electron E2E 主要派发 DOM 合成事件，没有真正移动系统光标，因此没有覆盖这条竞态。

### 3.2 云 Provider 非流式

现有 ModelRequest、Coordinator、TaskEvent 和 Renderer 已具备增量正文链，但只有本地 Provider 启用了 SSE。OpenAI-compatible 默认读取整段 JSON，Anthropic 未发送 `stream:true`，Gemini 使用 `generateContent` 而不是 SSE 端点。

### 3.3 文件操作验收环境分叉

当前 `AgentCoreExtension` 的真实 Vulkan 验收已经证明七类文件工具及真实副作用可用；最近的 AgentLoop 失败状态不会跨独立任务残留，工具名映射也一致。实际环境存在两个分叉：常用启动目录 `D:\Python\Important\myself` 仍停留在旧提交 `0dab17d`，而最新代码位于 Codex 工作树；当前用户设置还关闭了 `privacy.dataCategories.file`，会稳定阻断读取、列出、Glob 和 Grep。必须补足构建身份证据、披露阻断准确提示以及独立任务恢复测试，最终将通过门禁的分支快进到常用主目录。

### 3.4 运动状态竞争

`movementStopped`、`autonomousMovementAllowed` 与 `continuousMovementRequested` 分别由设置、Scheduler 和单轮动作维护。停止、恢复、单次移动和持续移动会写入不同布尔组合，因此可能永久停止、永久连续或每条指令只移动一次。

## 4. 设计

### 4.1 固定尺寸拖拽权威

- `CharacterMotionService` 区分自定义拖拽所有权与原生窗口移动所有权；原生 `moved` 只能结束原生 owner，不能结束仍活跃的自定义拖拽。
- `PetWindowInteractionController.endDrag()` 是自定义拖拽 owner 的唯一释放入口。
- 自定义拖拽活跃期间，几何协调器拒绝任何窗口尺寸提交；固定尺寸模式下运行期只允许 `setPosition()`，窗口宽高保持默认值。
- 拖拽使用初始系统光标和初始窗口左上角的绝对差值，不累计 Renderer 位移。先移除几何事务噪声，再依据真实系统光标 E2E 判断是否仍需调整 16ms 调度。

### 4.2 三协议流式正文

- 抽取 Provider 私有的有界 SSE 帧读取和结构化顶层 `text` 增量投影器，保持完整最终响应用于 Schema 校验和历史提交。
- OpenAI-compatible 普通无工具聊天发送 `stream:true` 并解析 `data:` 帧；云端 reasoning 字段不公开，但不沿用本地模型的思考泄漏硬失败。
- Anthropic 普通无工具聊天发送 `stream:true`，只消费 `content_block_delta.text_delta`，以协议终态结束。
- Gemini 普通无工具聊天使用 `streamGenerateContent?alt=sse`，只消费候选正文片段并验证完整终态。
- 工具回合、能力规划以及没有 `onTextDelta` 的调用保持现有非流式路径。自定义 OpenAI-compatible 端点若在任何增量前明确返回普通 JSON，可以安全回退整段解析；已经产生增量后禁止重试或重复正文。

### 4.3 文件工具事实与启动身份

- 保留现有 FileToolService、授权根、逐次确认和真实结果边界，不建立第二套文件执行器。
- AgentLoop 每次 `run()` 从空调用状态开始；补充失败任务后新任务成功、披露关闭时读写矩阵、全部公开工具名到内部结果名矩阵。
- 文件披露关闭时，只读类工具返回稳定、可操作的“在隐私设置开启文件访问”提示；写工具仍依据明确用户意图、授权根和确认卡执行，不被只读披露开关误伤。
- E2E 暴露只含提交短哈希和构建根类别的开发诊断，不暴露绝对路径；测试启动必须断言正在运行预期提交。
- 全部门禁通过后，将 `AgentCoreExtension` 快进合并到干净的 `main`，使常用启动目录不再运行旧代码。

### 4.4 单一三态运动模式

新增持久字段：

```ts
type CharacterMovementMode = 0 | 1 | 2;
```

- `0` 持续静止：不调度自主移动；明确的单次方向、区域或距离指令仍执行一次，完成后模式保持 `0`。
- `1` 持续运动：到达一个随机目标附近后立即选取下一个屏幕内随机目标；聊天、拖拽、确认和文件任务期间暂停，解除阻塞后继续，直到收到停止或模式切换。
- `2` 间歇自主：每次空闲从 10–30 秒均匀抽取延迟，到期执行一次随机屏幕目标移动，结束后重新抽取。

命令映射：停止/保持静止写 `0`；一直走/保持运动写 `1`；恢复活动/自己偶尔走动写 `2`；移动一下、方向、区域和距离只产生一次运动，不改变持久模式。Provider 的 `stop`、`continuous`、`once`、`none` 使用同一映射。旧 `movementStopped=true` 迁移为 `0`，旧 `false` 迁移为 `2`，迁移后删除旧字段及重复布尔 owner。

## 5. 失败处理

- 拖拽 owner 或几何提交异常时结束本次拖拽、恢复鼠标穿透，但不改变窗口尺寸。
- SSE 非法、超预算、缺终态、Abort 或终态后尾数据均失败关闭；已显示草稿由既有 error/cancel 事件清除。
- 文件工具的宿主结果是唯一成功事实；模型正文不能覆盖失败、取消或未执行。
- 运动模式保存失败时不改变运行模式，也不启动新运动。

## 6. TDD 与验收

- 拖拽：事件化 fake BrowserWindow 证明 100 次真实位置事件期间 owner 不释放、`setBounds` 为零、宽高恒定；真实 Electron 使用系统光标移动至少 20 步并重复三轮。
- 流式：三协议分别覆盖 Unicode 跨块、JSON 转义、终态、Abort、超限和工具回合零 delta；纵向验证 start/delta/commit 只形成一条历史消息。
- 文件：失败任务后的新任务恢复；披露关闭的读写矩阵；七类真实副作用；启动提交身份；本地与云 Provider 使用同一 canonical 工具表。
- 运动：`0` 下单次移动后仍为 `0`，`1` 连续换目标直到 stop，`2` 严格 10–30 秒随机间隔；模式切换、重启迁移和阻塞恢复均使用可控时钟。
- 最终运行 package typecheck/test、`verify:behavior`、`test:security`、`test:integration`、`verify:desktop`、真实 Vulkan 本地模型验收和 `git diff --check`。
