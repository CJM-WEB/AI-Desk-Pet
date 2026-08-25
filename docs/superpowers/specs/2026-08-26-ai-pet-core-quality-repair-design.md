# AI 桌宠核心质量修复设计

日期：2026-08-26

状态：用户已预授权持续实施；调查结论已复审，进入 TDD

## 1. 目标

本轮统一解决六项相互关联的问题：

1. 本地内置模型优先改善首字延迟和吞吐，正确选择可用独显，只做温和上下文裁剪，不降低小模型回答质量。
2. 本地模型与远程 Provider 共用文件工具和角色行为协议，不再出现“能聊天但没有工具或状态控制”的降级成功。
3. 桌宠拖拽期间尺寸与动画连续，窗口紧跟系统鼠标，不在按下时重建播放器或改变可见轮廓。
4. 停止锁只禁止自主移动；后续明确移动命令或经 Schema 校验的移动计划能够可靠解锁并执行。
5. 参考 OpenCode 完整迁移与本项目安全边界兼容的文件行为层，扩展读取、检索、精确编辑和补丁能力。
6. 删除设置中尚未接入运行时的截图与剪贴板隐私选项，并迁移已有设置。

## 2. 非目标与硬边界

- MCP 的运行时、Agent、Preload 与 Renderer 继续禁用。
- 不复制 OpenCode 的第二套会话、权限、Shell、插件、MCP、LSP 或数据库框架。
- 不接受绝对路径、UNC、设备路径、`..`、越界链接或外部目录永久授权。
- 不允许覆盖写、递归删除或永久删除；写操作仍逐次确认，删除默认进入 Windows 回收站。
- Renderer 不获得文件系统、进程、模型服务或任意系统权限；Main 的真实工具结果是唯一成功事实。
- 不恢复滚轮缩放；运行时尺寸保持 `1.0`。
- 不启用思考模式，不通过激进量化、摘要或截断当前用户输入换取速度。

## 3. 现状证据与根因

### 3.1 本地模型

当前 `ModelProvider.respond`、OpenAI 兼容适配器、`TaskEvent` 和 Renderer Store 都只支持整段返回；本地请求又固定 `stream:false`，因此用户必须等待完整 JSON 生成。Vulkan 探测只取 `--list-devices` 输出中的第一个 `VulkanN`，实测环境会先取 Intel 核显而非 RTX 独显。

本地聊天虽然要求结构化角色响应，却允许纯文本回退。小模型返回普通文字时会被当作聊天成功，但 `motionPlan` 与 `behaviorPlan` 均为空。文件任务本身和远程 Provider 共用同一 AgentLoop；常规失败主要来自意图路由措辞过窄及模型参数修复能力不足，而不是缺少另一套本地文件执行器。

### 3.2 拖拽

wheel、缩放 IPC 和运行时缩放入口已经删除。当前按下时把播放器从 `animated` 切为 `static`，会重建 Pixi 当前动作；备用 CSS 呼吸动画也包含 `scale()`。这使可见轮廓在按下瞬间变化，并在关键路径增加工作量。Main 每 16ms 轮询系统鼠标再 `setPosition`，产生稳定的至少一帧迟滞。

### 3.3 状态恢复

停止设置的持久化链正常，但只有少量本地正则命中的移动命令会先写回 `movementStopped=false`。模型返回的合法 `motionPlan.once/continuous` 会在停止锁下直接被丢弃。另一个阻塞是停止没有清理未完成的显式动作所有权，后续同优先级动作可能永久被拒绝。

### 3.4 文件工具

现有文件服务具备授权根、确认、实体身份复核、不覆盖、原子写入和回收站删除，但公开工具只覆盖列出、读取、创建、单文件补丁、移动普通文件和删除文件/空目录，缺少成熟 Agent 常用的分页、Glob、Grep、精确编辑、编码与换行保持、稳定截断和错误修复反馈。

OpenCode 固定参考版本为 `2a6be0a03b93a6734070e10a6c3b56863475f214`，MIT。其工具层依赖 Bun、Effect、AI SDK、Formatter、LSP、Session 与插件系统，且允许绝对路径、覆盖写、递归建目录、永久删除和外部目录授权，不能整体作为执行器嵌入。

## 4. 方案

### 4.1 本地模型响应与设备选择

1. 为 Provider 增加可选文字增量回调；本地无工具文字回合使用 SSE，最终仍返回完整 `ModelResponse` 并执行现有 Schema 校验。
2. 角色聊天只投影结构化 JSON 顶层 `text` 字符串的已完整解码字符；`activity/status/motionPlan/behaviorPlan` 不作为增量公开。最终 commit 以完整校验结果校正草稿。
3. `TaskEvent` 增加带 `turnId` 的 start/delta/commit，Preload 严格校验，Renderer 同一消息原位追加；Abort、reset、generation 变化后丢弃迟到增量。
4. 工具规划和带工具调用的回合首版继续非流式，避免不完整工具参数进入 Main。
5. 解析全部 Vulkan 设备，拒绝软件设备；确定性优先可容纳模型的独显，其次其他硬件，最后沿用 Vulkan→CPU 回退。不得硬编码设备序号。
6. 本地带 `responseContract` 的请求使用 llama.cpp JSON Schema 约束；纯文本或非法结构不再作为角色控制成功。

### 4.2 温和上下文预算

- 保留系统消息、当前用户输入、最近完整回合及成对的 assistant-tool/tool 消息。
- 为 8192 上下文预留约 1500 至 2000 输出 token，输入预算约 6000 至 6500 token；只按完整旧回合从最早处裁剪，不摘要、不截断单条当前正文。
- 行为候选完整保留；存在 candidates 时不再重复发送可由候选推导的聚合名称和标签。
- 本地文件读取结果按完整行设置温和上限并显式标记 `truncated`，云端现有上限不变。

### 4.3 拖拽不变量与低延迟

1. 删除 `dragging → static` 的播放器模式切换，拖拽前、中、后保持原动作连续播放；通用 reduced-motion 的 static 能力保留。
2. 备用角色呼吸动画不得使用 scale；动作可以位移或旋转，但不能改变桌宠尺寸。
3. Main 仍独占系统光标坐标，保持初始绝对差值、16ms 有界调度和可见边界钳制；不引入 Renderer 坐标或累计位移。Renderer 收到 `moving:false` 的用户拖拽权威快照时必须立即吸附并清零残差，只有 `moving:true` 的自主运动允许表现插值。
4. 每次拖拽前后窗口宽高、几何 scale tick、角色布局基准均保持不变；只有消除已证实的 Renderer 二次追赶后仍有测量证据，才调整 Main 调度频率。

### 4.4 停止与恢复状态机

- `movementStopped` 表示“禁止自主移动”，不是永久禁止所有用户命令。
- 明确 stop 立即保存 true、停止 Motion、清理连续运动及未完成的显式移动所有权。
- 显式 Gate 或本轮经 Schema 校验的 `motionPlan.once/continuous` 都先保存 false；保存成功后才请求动作与 Motion，失败时零动作。
- `none`、纯情绪、纯行为候选和普通聊天不解锁；同轮明确 stop 的优先级最高。
- 扩充少量高置信常见用语，但自然语言泛化主要依赖结构化模型结果，不维护无限正则词表。

### 4.5 OpenCode 文件行为层迁移

在 `packages/file-tools` 内形成单一深模块，迁移并适配以下行为：

- 按行分页读取、行号、稳定字符/字节截断、二进制与超大文件拒绝、UTF-8 BOM 和 CRLF/LF 保持；
- 授权根内的 Glob 与 Grep，确定性排序、结果上限、隐藏/忽略策略和显式 truncated；
- 唯一匹配的精确编辑，支持原文本唯一性检查及 OpenCode 风格的有限纠错候选；歧义时拒绝而不是猜测；
- 单文件安全补丁以及多文件补丁的解析/预览；每个受影响文件都必须在确认卡中可见，执行前复核实体身份；
- 工具参数错误和执行错误以稳定、可修复的结构回注模型；重复相同失败触发有界终止，禁止模型口头宣称成功。

不迁移 OpenCode 的覆盖写、绝对路径、外部目录、永久删除、Shell、格式化器、LSP、快照或插件副作用。新增或修改工具继续复用现有 `PathPolicy`、确认续跑、授权 generation 与 Main 执行结果。若复制实质代码，文件头或第三方 notices 保留 OpenCode MIT 版权与固定提交来源。

### 4.6 隐私设置减法

从公开 Settings DTO、Store schema/default、Dashboard support、Renderer state 和 Privacy UI 删除 screenshot/clipboard。SettingsStore 在严格解析前只剥离旧数据中的两个字段并原子回写，保留 file、memory 和其他配置。底层通用披露策略类型暂保留，因为它不代表已接入捕获功能且仍服务跨 Provider 安全测试。

## 5. TDD 验收矩阵

### 5.1 本地模型

- SSE 分片、JSON 转义、Unicode 跨 chunk、最终 commit、非法 JSON、HTTP 错误、Abort 和迟到增量。
- 工具回合保持非流式；Schema 约束请求体存在，纯文本角色响应拒绝。
- Intel Vulkan0 + NVIDIA Vulkan1 选 Vulkan1；仅 Intel 可用、软件设备混入、乱序/重复/无效输出及 CPU 回退。
- 本地文件创建/读取/检索/编辑/移动/删除确认链和角色 once/continuous/stop 的集成测试。

### 5.2 拖拽与行为

- 拖拽前中后 `motionMode` 不变，播放器不因 pointerdown 重建动作；fallback CSS 不含 scale 动画。
- 快速变化系统光标时下一调度周期跟到最新绝对位置；重复拖拽宽高和 scale tick 恒定。
- move→stop→move 即使旧 playback 没有 finished 事件也能重新授权；停止锁下 provider once/continuous 解锁，none 不解锁；保存失败零 Motion。

### 5.3 文件工具

- 分页、BOM、CRLF、二进制、超限、Glob/Grep 排序与截断、唯一编辑及歧义拒绝。
- 所有写操作确认前无副作用；取消、过期、身份变化、目标存在、链接/Junction、越界和执行失败均稳定关闭。
- 模型参数错误最多有限修复；本地失败或未执行不能显示成功。

### 5.4 隐私

- UI 与公开 DTO 不再出现截图/剪贴板；旧设置迁移只剥离这两个字段；严格保存拒绝旧字段重新进入。

## 6. 完成门禁

每个切片先确认 RED 原因，再完成 GREEN 和必要重构。最终运行相关 package 测试与 typecheck、`pnpm.cmd test:security`、`pnpm.cmd test:integration`、`pnpm.cmd verify:desktop`、`pnpm.cmd verify:behavior`、`git diff --check`。真实 Windows 拖拽手感与视觉尺寸仍标记为待用户人工确认，自动化只证明尺寸、状态、事件和真实文件副作用不变量。
