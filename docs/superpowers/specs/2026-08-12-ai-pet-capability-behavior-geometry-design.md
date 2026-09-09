# AI 桌宠可信能力、行为导演与视觉几何设计

> **后续裁决：** 本文第 5 节、第 6 节、第 10 节中有关文件与 PowerShell 的设计曾由轻量 Agent 规格替代，当前以[编程助手规格](2026-09-05-ai-pet-coding-assistant-design.md)为准。2026-09-06 起，move 动画控制真实位移、运动档位关闭原地状态等分支由[自定义状态与持续心情规格](2026-09-05-ai-pet-custom-state-autonomy-design.md)替代；未冲突的缩放、几何、碰撞范围和拖拽规则继续保留。

**日期：** 2026-08-12  
**状态：** 用户已审阅并批准，进入详细实施计划阶段
**范围：** 仅 AI 桌宠桌面应用；网站不在本设计范围内

## 1. 背景与问题

当前项目已经具备文件工具、角色行为引擎、窗口运动和像素命中等基础能力，但用户实际使用仍存在五类断裂：

1. 明确的新建、删除等文件请求可能被模型用普通文本拒绝，底层工具存在却没有可靠执行。
2. 普通聊天只稳定返回正文与情绪，真实 Provider 通常不会提供现有内部 `metadata.behaviorIntent`；Prompt 无法可靠驱动角色状态、自定义动作和真实窗口移动。
3. 主动行为虽有本地引擎基础，但档位、低频反思、持久停止锁和用户可理解的运行语义尚未形成完整产品闭环。
4. 桌宠运动边界仍以固定透明窗口矩形为主，不能贴合当前动作的可见角色范围，也没有用户滚轮缩放能力。
5. 连续拖拽会逐次向桌面左上方向漂移；该现象在不接触屏幕边缘时也会发生，因此不能只修边缘钳制，必须重新建立单一坐标权威和可重复诊断闭环。

本设计采用可信编排层方案：模型负责理解与提出受限计划，Main 负责权限、状态、坐标和真实结果，Renderer 只负责可见呈现与受限输入。

## 2. 目标

- 让明确文件请求可靠进入工具链，模型不能用口头拒绝或伪造完成替代真实执行。
- 补齐常用文件操作，并以 Windows 回收站、不可覆盖创建和快照确认保护用户数据。
- 提供类似 Codex 的受控 PowerShell：显式触发、受限默认权限、逐次扩展确认、可管理后台任务。
- 让每次对话都能形成受验证的角色行为判断，并支持标准语义、自定义动作和真实空间移动。
- 让桌宠在自主模式下低频、低打扰地活动，同时服从跨重启持久的“停下”锁。
- 支持像素命中区域内滚轮缩放，范围 50%–200%，保持脚底锚点稳定并按角色持久化。
- 用当前动作稳定视觉包围盒约束运动和屏幕边界，使可见角色能够贴边。
- 从根因上解决连续拖拽漂移，并支持负坐标、多显示器和不同 DPI。

## 3. 非目标

- 不允许自主行为、文件内容或环境事件触发 PowerShell。
- 不自动提权，不接管 UAC，不提供无限交互式 TUI。
- 不直接永久删除文件或目录。
- 不允许模型提交任意绝对屏幕坐标、窗口句柄、绝对文件路径或系统能力令牌。
- 不修改、构建、测试或启动网站。
- 不为兼容旧实现长期保留两套文件执行、坐标或位置持久化路径。

## 4. 总体架构

保留 `ConversationCoordinator` 作为用户 Prompt 唯一入口，在 Main 内增加四个职责清晰的深模块。

### 4.1 `CapabilityIntentRouter`

输入规范化 Prompt 与只读会话上下文，输出以下路由之一：

```ts
type CapabilityIntent =
  | { kind: 'chat'; behaviorHint: ExplicitBehaviorHint | null }
  | { kind: 'file_task'; evidence: ExplicitFileEvidence }
  | { kind: 'powershell_task'; evidence: ExplicitShellEvidence };
```

- 没有充分执行证据时默认普通聊天。
- 角色动作可作为聊天附带行为，不获得文件或终端权限。
- 文件与 PowerShell 使用不同的正向证据和安全链；不能因出现文件名、命令名或代码块而自动执行。
- 明确的停止、恢复和受限方向移动由本地规则识别，保证模型结构化行为失败时仍能服从。

### 4.2 `CapabilityTaskCoordinator`

统一持有文件计划、PowerShell 计划、确认令牌、运行所有权、取消和重置语义。它只接受结构化计划，不把 Provider 普通文本当作任务结果。

### 4.3 `CharacterBehaviorDirector`

融合聊天行为计划、可信任务阶段、运动状态、拖拽状态、用户交互、空闲计时、主动性档位、当前角色清单和持久停止锁。它输出已通过本地验证的角色动作或受限运动意图。

### 4.4 `PetVisualGeometry`

统一持有角色缩放、动作稳定包围盒、脚底锚点、透明窗口偏移、全局 DIP 坐标与显示器工作区。自动运动、拖拽、位置恢复和屏幕钳制只能消费其不可变快照。

## 5. 文件任务可靠执行

### 5.1 文件计划协议

文件 Provider 在首次真实工具结果出现前只能返回：

```ts
type FilePlannerResult =
  | { kind: 'tool_request'; request: FileToolRequest }
  | { kind: 'clarification_required'; question: string };
```

工具完成后才允许返回受限总结。Provider 在工具调用前返回拒绝、命令建议或成功声明时，协调器将其标记为协议违规并进行一次受限修复请求；第二次仍不合规时返回稳定错误码，不展示误导性模型正文。

### 5.2 文件工具范围

- `list_directory`：列出授权根内目录。
- `search_entries`：按受限名称、类型和深度搜索，不跟随链接越界。
- `read_text_file`：读取受限大小的文本文件。
- `create_file`：创建空文件或带初始正文的文件，独占创建，永不覆盖。
- `create_directory`：创建新目录，永不覆盖已有实体。
- `write_text_file`：修改已有文本，绑定旧内容哈希和大小快照。
- `copy_entry`：复制普通文件或目录，目标不存在才允许。
- `move_entry`：在授权范围内移动普通文件或目录。
- `rename_entry`：在同一父范围内重命名。
- `move_to_recycle_bin`：删除语义的唯一实现，统一移入 Windows 回收站。

所有路径使用授权根标识与根内相对路径。拒绝绝对路径、UNC、设备路径、上级穿越、符号链接和 Junction 越界；受保护区域继续不可授权。

### 5.3 风险与确认

- 列出、搜索和读取受文件披露设置约束；只有获得授权后才执行。
- 所有写操作展示确认卡。
- 新建文件确认卡展示相对路径、内容字符数和受限预览；长正文或敏感正文不完整铺开。
- 修改文本展示受限差异摘要，并绑定旧哈希。
- 复制、移动、重命名和回收站操作绑定目标身份、源/目标快照和授权 generation。
- 确认后任何路径、哈希、实体类型、授权范围或会话 generation 变化都会使旧动作失效。
- 模型总结只能依据本地工具结果，不能覆盖本地错误或取消状态。

## 6. 受控 PowerShell

### 6.1 触发边界

只有用户明确要求运行命令、脚本、构建、测试或系统操作时才进入 PowerShell。普通聊天、自动反思、环境事件、文件正文和 Provider 工具结果都没有触发权。

### 6.2 两级权限

**受限级：**

- 使用 PowerShell AST 解析器验证保守非交互子集。
- 固定授权根内工作目录，拒绝动态调用、无法静态确定的路径、提权、凭据读取、任意模块加载和不可证明安全的表达式。
- 只读低风险命令可按策略直接执行；写入仍进入确认。

**扩展级：**

- 受限规则无法证明安全时，确认卡展示完整命令、工作目录、运行方式以及联网、写入、启动程序和系统配置风险。
- 用户逐次确认后，以当前 Windows 用户权限执行确认时的精确命令哈希。
- 不自动请求管理员权限；需要 UAC 的命令明确失败或由用户在应用外处理。

### 6.3 运行模型

- 固定使用 `-NoProfile -NonInteractive`。
- 使用受控环境变量白名单、输出字节上限、执行超时和进程树终止。
- 前台任务有有界生命周期和明确取消。
- 用户明确要求时可创建受管理后台任务；任务具有稳定 ID、状态、受限日志和停止入口。
- 应用退出时按已声明策略停止后台任务；首版不静默留下孤儿进程。
- stdout、stderr、命令正文和路径不进入普通诊断日志；公开事件只包含阶段、稳定错误码和有界计数。

## 7. 角色行为导演

### 7.1 单次聊天行为计划

聊天请求携带最小行为上下文：

- 当前对话与任务阶段；
- 当前角色可用标准语义、自定义状态名称、动作名称和标签；
- 当前移动、拖拽、携带与停止锁状态；
- 主动性档位和近期动作摘要。

同一次 Provider 调用返回自然回复和可选行为计划，避免每条消息增加第二次模型调用。优先使用 Provider 支持的结构化输出或没有系统权限的行为工具；Provider 不支持时保留正常文本，并由本地显式指令解析保证停止、恢复和方向移动。

```ts
type CharacterBehaviorPlan =
  | { kind: 'none'; emotion?: CharacterEmotionLabel }
  | { kind: 'play'; target: BehaviorTarget; emotion?: CharacterEmotionLabel }
  | { kind: 'move'; direction: MoveDirection; distance: MoveDistance }
  | { kind: 'move_region'; region: ScreenRegion }
  | { kind: 'stop_movement' }
  | { kind: 'resume_movement' };
```

模型只能引用标准语义、当前角色公开的名称或标签。Main 将其解析为当前清单中的真实状态和动作；模型不能直接授权未知 action ID。动作不存在或资源不可用时返回稳定能力提示，不能口头答应后继续播放 idle。

### 7.2 仲裁优先级

1. 应用关闭、安全失败和持久停止锁。
2. 用户当前明确行为指令。
3. 文件任务、拖拽、倾听、思考、携带等可信运行状态。
4. 普通聊天行为计划。
5. 自主反思计划。
6. 本地空闲动作。

停止锁禁止空间移动和自主闲逛，但不冻结倾听、思考、说话、成功、失败等聊天关联原地动画。锁跨重启保存，只有明确“恢复活动”“可以动了”等指令解除。

### 7.3 真实运动绑定

- “走一走”映射为当前显示器安全范围内随机移动。
- 左、右、上、下映射为按视觉角色尺寸计算的有界相对位移。
- 屏幕区域指令映射为左侧、右侧、顶部、底部和四角等受限区域。
- 模型不能提交绝对坐标。
- 只有 move 语义动作成功取得播放授权后才请求窗口运动；缺少 move 动作时不移动并提示能力缺失。

### 7.4 主动性档位

- **被动：** 只执行明确 Prompt；聊天关联动作继续正常。
- **辅助：** 允许聊天动作和空闲 20–60 秒后的本地原地小动作，不自行走动，不调用反思模型。
- **自主：** 额外允许短距离走动，并在持续空闲 2–5 分钟后进行一次低频模型反思。

新用户默认自主；已有用户保留当前选择。自主计时在聊天、拖拽、文件/PowerShell 任务、确认等待和其他阻塞状态下暂停。模型反思没有文件工具和 PowerShell 能力，不产生未经用户请求的聊天正文。同一动作不能连续重复。

## 8. 视觉几何与缩放

### 8.1 动作视觉包围盒

角色编译流程为每个动作计算全部帧非透明像素的最小联合矩形，并与脚底锚点、资源修订一起保存。当前正式播放器每次只渲染一个可见主表现；`modifierStateIds` 只参与动作筛选，不进入几何权威输入，也不是独立可见图层，当前没有 overlay 播放协议，因此本阶段不能宣称修饰表现或覆盖物已经接入。几何模块保留按共同脚底锚点联合多个可见表现的纯函数 seam；该 seam 只接收已经转换到共同脚底 DIP 坐标系的矩形，不能直接联合不同画布的归一化几何。生产输入长度固定为 1；未来只有在角色契约和播放器真实支持多层后才能扩大。

动作播放期间的帧切换不重新扫描 Alpha，也不改变稳定视觉包围盒。角色、动作、方向、缩放、播放器 viewport 尺寸或真实可见表现集合变化时才建立新的几何形状版本。

旧角色缺少包围盒时在导入或首次加载时生成一次并迁移，不长期保留固定 180×220 与新几何双轨。

### 8.2 `PetGeometrySnapshot`

```ts
type PetGeometrySnapshot = Readonly<{
  revision: number;
  characterId: string;
  scale: number;
  footAnchorDip: Point;
  visualBoundsInWindowDip: Rectangle;
  windowBoundsDip: Rectangle;
  displayId: string;
}>;
```

Main 校验有限数值、正尺寸、缩放范围、角色身份和资源修订。过期或非法数据拒绝，并回退到已验证默认几何。

完整 `PetGeometrySnapshot` 只存在于 Main。Renderer 后续只允许报告经过严格 schema 校验的 window-local viewport 矩形；该矩形是已经应用缩放后的实际画布范围，Main 不得再乘一次持久 `scale`。Renderer 不得报告全局坐标、最终视觉包围盒、脚底全局坐标、角色 ID 或资源哈希。Main 从严格 `CharacterManifestV2`、已授权 action、资源 revision、方向、`BrowserWindow` bounds 和 Electron display 数据自行计算 `footAnchorDip` 与 `visualBoundsInWindowDip`。Renderer 只接收去全局坐标的渲染视图。

`revision` 只表示几何形状版本。角色、动作、方向、缩放、viewport 尺寸或真实可见表现集合变化时单调自增；窗口移动、viewport 在窗口内的 offset 变化和 display placement 更新不自增。若未来需要对位置广播排序，使用独立 `placementRevision`，不得复用几何 revision。

权威接口拆为低频 `updateShape` 与廉价 `updatePlacement`。`updateShape` 才能解析严格 Manifest，并验证动作、资源、方向、scale 和实际 viewport size 后创建 pending 共同脚底 DIP 形状；它不接收 `frameIndex`，也不得由逐帧通知调用。pending 不得修改已提交角色、动作 revision 绑定或快照。`updatePlacement` 只接收 `baseRevision`、同尺寸 window-local viewport、窗口 bounds 和 display，按 revision 选择 pending 或 active 缓存且不解析 Manifest；pending placement 全部验证并成功生成快照后，才原子提交 active 元数据与快照并清除 pending。pending placement 失败后旧 active revision 仍可继续 placement，显式 `discardPendingShape()` 可幂等回滚 pending 且不影响 active。缺少形状、revision 不等或 viewport 尺寸变化均稳定拒绝并保留最后有效快照。

G4 在提交窗口 placement 前可按 revision 读取 Main 私有、去全局坐标的 shape layout，内容仅含角色、scale、viewport size、相对 viewport 左上角的 `footOffsetInViewportDip` 和共同脚底坐标系下的视觉矩形。G4 必须把 viewport 的窗口内 offset 与它相加，形成位置恢复唯一接收的 `footOffsetInWindowDip`；两个坐标系不得使用同名字段。该只读投影必须克隆并深冻结，不得提交 pending、改变 active 或进入 IPC；未知或已丢弃 revision 返回空。位置恢复以视觉矩形约束脚底，透明窗口留白允许越出工作区；窗口尺寸只用于旧左上角位置的显示器归属判断和 BrowserWindow 左上角反算。

形状 revision 以已签发 revision 单调递增；丢弃或替换不同 pending 不能复用旧 revision。与 active 或 pending 形状键相同的候选复用原 revision，保证同 revision 只表达同一几何形状。

同一角色的同一 action revision 必须绑定同一皮肤、动作和资源修订；更小 revision 或同 revision 的绑定冲突稳定拒绝。方向来自独立运动快照，不属于 action revision 的绑定字段。Main 显式切换活动角色时重置 action revision 基线，但几何形状 revision 继续单调递增。窗口必须与声明的 display 工作区存在正面积相交，负坐标显示器按同一全局 DIP 规则计算；所有派生点和矩形在提交前再次校验有限数值与正尺寸。

几何 authority 只在角色、动作、方向、scale、viewport 或 placement 边界调用；逐帧通知不得调用它。输入 revision 以及 Renderer 可见的几何 revision 必须是非负安全整数。所有矩形除字段本身有限且尺寸为正外，右边界与下边界也必须保持有限。

### 8.3 滚轮缩放

- 只有鼠标通过现有像素透明度命中时才接受滚轮。
- 每格 10%，范围 50%–200%。
- 缩放围绕脚底锚点，窗口和画布原子更新。
- 缩放按角色持久化，重启恢复。
- 屏幕边界只约束可见包围盒，透明窗口留白可以越出工作区。

G4 的跨进程协议固定为三条：Renderer invoke `pet-window:viewport-commit`，负载仅含严格的 `viewportInWindowDip`；Renderer invoke `pet-window:scale-step`，负载仅含 `step: -1 | 1`；Main 通过 `pet-window:geometry-render` 单向发布既有去全局坐标渲染视图。viewport invoke 同时作为 BrowserWindow resize 后的 ack，不增加第四条协议，Main 最多等待 2000ms。

Main 以单 FIFO 串行窗口布局。每次事务先捕获旧窗口、几何 authority 和行为绑定 generation，再建立 pending shape、读取局部 shape layout、设置候选窗口、等待匹配 viewport ack、提交 placement，最后执行 pending legacy CAS 或 ready placement 保存；成功后才 best-effort 广播渲染视图。任一步失败都恢复旧 authority、旧窗口并等待旧 viewport ack，不广播成功。authority 已签发的 shape revision 保持单调，不因回滚复用。

缩放内部只使用 5–20 的整数 tick，公开 scale 为 `tick / 10`。首次实际 viewport 与当时已提交 scale 形成 canonical base；目标 viewport 按 canonical base 计算并四舍五入，保留固定窗口 inset，窗口原点从持久的全局脚底锚点反算，单轴量化误差不超过 0.5 DIP 且不得累积。事务中滚轮只累计最新目标 tick；拖拽或运动活动时延后布局；行为绑定 generation 变化使在途事务失效并回滚。Main 通过私有行为绑定读取正式 manifest、skin、action revision、resource revision 与 direction，身份绝不来自 Renderer。

自动运动、边缘钳制、位置恢复和拖拽全部使用视觉包围盒与脚底锚点，不再使用固定窗口矩形。

## 9. 拖拽状态机

### 9.1 诊断原则

用户确认漂移在同一显示器中央连续拖拽、完全不触边时仍出现。实施前必须建立真实、可重复、快速的 RED；不能预设屏幕钳制是唯一根因。

重点验证：

- Main 与 Renderer 是否重复持有移动所有权；
- 指针捕获、窗口失焦和 `will-move`/`move`/`moved` 是否重入；
- 全局光标、窗口原点和视觉锚点是否混用了物理像素与 DIP；
- 保存的窗口左上角是否在动作、缩放或窗口尺寸变化后被重复当成视觉位置。

### 9.2 单一拖拽所有权

Main 为每次拖拽创建独立 epoch，并冻结本次几何：

```ts
type DragSession = Readonly<{
  epoch: string;
  initialCursorDip: Point;
  initialFootAnchorDip: Point;
  grabOffsetInVisualBoundsDip: Point;
  geometryRevision: number;
}>;
```

- 每一帧位置均由初始锚点加本次全局光标总位移计算，不从上一帧窗口位置继续累加。
- 跨显示器时使用 Electron 提供的目标显示器 DIP 工作区，不手工混合物理像素。
- 先钳制可见视觉矩形，再反推出透明窗口原点。
- 拖拽期间动作和缩放引起的几何更新延后到释放后原子提交。
- Main 拖拽控制器是唯一窗口位置写入者；运动服务只接收用户移动开始/结束，不通过另一事件链重新计算坐标。
- 释放、取消、失焦、指针捕获丢失、超时和窗口销毁按 epoch 幂等收口。

位置持久化改为按角色保存脚底锚点、显示器身份与缩放。设置 V3 使用 `pending-legacy | ready` 判别状态：旧窗口左上角先原样进入 pending，不以固定 180×220、窗口底部中心或 CSS 留白猜测角色脚底；G4 先只读 pending 与 Main 私有 shape layout，完成 Renderer、BrowserWindow 和几何提交后，再以原 legacy 坐标作为 compare-and-swap 条件原子提交 ready。任一前置步骤、CAS 或落盘失败都保留 pending 并回滚窗口/几何；成功后只写按角色 ready placements，并删除旧 Main/PublicSettings 位置路径。

## 10. 错误处理与隐私

- 文件计划、确认、执行与总结使用独立状态；任何失败都不能发布成功终态。
- PowerShell 确认绑定完整命令哈希、工作目录、风险等级和 generation；确认后变更即失效。
- 行为计划失败只影响动作，不让合法聊天正文丢失；明确动作无法执行时追加稳定能力提示。
- 自主反思失败静默跳过本轮，不弹窗、不重试风暴。
- 几何错误回退默认包围盒；拖拽错误立即结束 epoch、停止写位置并恢复安全鼠标穿透。
- 日志不保存用户正文、模型正文、命令正文、文件正文、密钥、Authorization、绝对路径或屏幕绝对坐标。
- 只允许记录稳定错误码、阶段、布尔泄漏证据、受限计数和相对耗时。

## 11. 数据迁移

- 新用户主动性默认 `autonomous`；已有设置不覆盖。
- 现有用户停止锁默认关闭；明确停止后持久化。
- 角色缩放默认 100%，以后按角色保存。
- 旧位置待真实 viewport 与脚底偏移可用后，从窗口左上角一次性迁移为脚底锚点；迁移失败保留 pending 并使用当前显示器安全默认位置，不写入猜测坐标。
- 旧角色包围盒在可信编译/加载流程中一次性补齐；生成失败则使用经过验证的保守默认范围并提示修复角色资源。

## 12. 实施分解

本设计拆为四个严格串行的 SDD/TDD 子项目：

1. **可信文件与 PowerShell 执行**：先解决截图中的核心执行断裂，再补完整工具和终端边界。
2. **行为导演与自主生命感**：接通单次聊天行为计划、标准/自定义动作、移动锁和三档主动性。
3. **缩放与视觉几何**：生成动作包围盒、迁移脚底锚点、实现按角色缩放和贴边运动。
4. **拖拽诊断与修复**：在新几何权威上建立真实 RED，修复连续拖拽和跨显示器坐标。

每个子项目完成实现、自审、独立规格审查和独立质量审查后才进入下一项。任何单点超过 10 分钟必须安全终止并更换诊断路径；长命令可以后台运行，但持续报告进度。

## 13. 验收矩阵

### 13.1 文件与 PowerShell

- 新建空文件、带正文文件和目录；同名目标不覆盖。
- 修改文本绑定旧哈希；并发变化使确认失效。
- 搜索、复制、移动、重命名与回收站删除均限制在授权范围。
- Provider 普通拒绝、伪造成功和连续协议违规不能冒充工具结果。
- PowerShell 受限 AST、扩展确认、命令哈希、超时、输出上限、后台查询和停止均有 RED/GREEN。
- 自主行为、文件正文和环境事件无法触发 PowerShell。

### 13.2 行为导演

- Prompt 能驱动标准语义、自定义动作、方向移动、区域移动、停止和恢复。
- 动作不存在时出现稳定提示，不能播放 idle 假装完成。
- move 动画授权与真实窗口移动一致。
- 停止锁跨重启且不冻结聊天关联原地动作。
- 被动、辅助、自主三档行为符合定义；本地 20–60 秒和反思 2–5 分钟使用可控时钟测试。
- 反思无文件/终端能力，聊天或任务期间不触发。

### 13.3 视觉几何

- 动作全部帧联合矩形正确，动作内不逐帧抖动。
- 50% 与 200% 缩放围绕脚底锚点，按角色持久化。
- 像素透明度命中保持现有正确行为。
- 可见角色能贴近屏幕四边，透明窗口留白不造成提前停止。
- 旧位置和旧角色包迁移后不保留运行双轨。

### 13.4 拖拽

- 单显示器中央连续拖拽至少 20 次，无累计左上偏移。
- 完全不触边的拖拽也保持期望相对位移。
- 负坐标显示器、相同 DPI 和不同 DPI 跨屏拖拽抓取点不跳。
- 50% 与 200% 缩放后拖拽正确。
- 动作切换、自动运动、窗口失焦和指针丢失不争夺位置。
- 真实 Electron E2E 覆盖原始复现，不只验证纯数学函数。

### 13.5 最终门禁

- Desktop 与相关共享包 typecheck。
- 桌宠单元、安全、集成和真实 Electron E2E。
- 文件系统与 PowerShell 的权限边界测试。
- 行为、几何和连续拖拽纵向验收。
- 工作树进程残留、敏感日志和空白差异检查。
- `git diff --name-only -- apps/website` 必须为空；不运行网站命令。
