# AI Pet 文件执行、行为灵动与缩放交互修复规格

**日期：** 2026-08-24
**状态：** 第二轮人工验收失败，按真实运行证据修订并重新实施
**适用范围：** 仅修复用户本轮验收不合格的第 1、2、3 项；第 4、5、6 项只做回归验证

## 1. 目标

1. 让明确的文件或空目录创建、文件或空目录删除请求稳定进入真实工具链，不再以“无法操作”普通文字结束；参数缺失后的下一轮补充仍留在原文件任务语境。
2. 让用户对桌宠行为的自然语言要求实际驱动当前角色最相似的可播放自定义状态或动作；自主模式每隔 10–30 秒在当前单屏工作区内随机移动，到目标附近即停止并回到 idle。
3. 让鼠标位于桌宠真实 Alpha 像素上时滚轮可按既有 50%–200% 档位缩放；单纯左键长按不改变缩放，拖动仍保持可用。

## 2. 非目标与硬边界

- 不启用、恢复或改造 MCP；Renderer、Preload 和 Agent 继续不获得任意文件系统权限。
- 不接入 DeepSeek Harness、OpenHands 或 Cline 的完整运行时，不新增大型依赖。
- 不实现递归目录创建、递归删除、永久删除、批量删除、重命名或任意 shell 旁路。
- 不修改碰撞体、拖拽边界、角色发布播放参数等第 4、5、6 项既有实现；只运行相关回归测试。
- 模型隐藏行为字段只决定角色表现，不能触发文件、PowerShell 或其他系统能力。

## 3. 现状证据与根因

### 3.1 文件执行

- 现有 `AgentLoop` 已在能力规划首轮使用 `toolChoice: required`，真实执行也已由 Main 和 `FileToolService` 裁决；底层文件 API 不应重写。
- `CapabilityIntentRouter` 只按当前一条消息分流。首轮能力链若发出结构化澄清，下一轮只有路径而没有操作词时会落入普通聊天链。
- 当前文件工具没有 `create_directory`，因此“创建 abc 文件夹”没有合法业务工具可调用。
- 提供给模型的工具集合没有按已经识别的操作和参数完整度收窄；即使用户已经给出 `empty`，模型仍可选择“缺少路径”的澄清工具。

开源研究结论记录于 `docs/research/2026-08-24-open-source-agent-file-execution-patterns.md`：复用的是 Action/tool call → Main 执行 → Observation/tool result 的循环不变量，而不是复制外部项目的绝对路径、沙箱、永久删除或完整框架。

### 3.2 行为

- 明确行为 Gate 不识别“请你移动”等常见自然表达；普通聊天又允许无 `behaviorPlan` 的纯文字回退，所以会出现口头答应但身体不动。
- 现有公开角色目录只有扁平的语义、状态名、动作名和标签，解析器仅做精确相等，不支持模型描述与用户自定义命名之间的最高相似匹配。
- 本地主动候选使用 `near` 相对位移，实际仅约半个角色宽高；计时范围仍是 20–60 秒。
- 运动数学要求精确到达目标点，且现有测试没有纵向证明 `moving: false` 后实际切回当前角色的 idle 动作。

### 3.3 缩放

- `PetView` 把 wheel 事件缩减为只有 `deltaY`；控制器只能依赖此前缓存的 pointermove 坐标。真实穿透窗口中该坐标可能缺失或过期，导致 wheel 被拒绝。
- 左键按下立即启动 16ms 原生拖动轮询，即使指针没有移动；同时 wheel 没有排除按压/拖动会话。单纯长按不应启动窗口位移或改变缩放。

## 4. 设计

### 4.1 文件任务：收窄工具面、结构化续接、专用建目录

1. 在能力路由后生成只读的 `FilePlanningHint`：操作类别、是否存在具体根内相对目标、允许公开给模型的候选工具。它只缩小能力，不携带授权或执行结果。
2. 参数完整时，首轮只公开对应业务工具并禁止澄清工具；参数确实缺失时才公开结构化澄清工具。这样 DeepSeek 的 `required` 不能再用无根据的澄清绕过已明确请求。
3. Coordinator 依据“能力任务未 acting/未确认而以澄清成功结束”的结构化阶段事实，保留一次待补充文件上下文。下一条具有路径/文件对象证据的消息与原请求合并后再次进入文件链；普通聊天、重置、Provider/授权变化或一次消费后立即失效。
4. 新增 `create_directory` 专用工具：只允许授权根内一个相对目录；父目录必须已经存在；目标必须不存在；拒绝绝对路径、`..`、链接、Junction 和授权根本身；每次生成准确确认卡，确认后复核 generation、父目录与目标状态，再创建单个目录。
5. `delete_file` 保留现有“普通文件或空目录进入回收站”语义，不改成永久删除。
6. UI 的成功只能来自 Main 工具结果。模型纯文字、无效参数或总结失败不能伪造执行成功。

### 4.2 对话行为：隐藏语义 + 当前角色公开目录匹配

每轮普通聊天要求 Provider 返回不显示给用户的结构化字段：

```json
{
  "text": "显示给用户的回复",
  "activity": "在做什么",
  "status": "当前状态",
  "behaviorPlan": { "kind": "..." }
}
```

- `activity` 与 `status` 只作为角色表现语义，Renderer 不显示。
- 公开目录改为按可播放候选提供状态/动作描述项；描述项只含公开名称、标准或自定义语义和标签，不含 stateId、actionId、路径或能力引用。
- Provider 在同一结构化回复中根据 `activity + status + 当前公开目录` 选择最高相似候选；Main 再验证目标必须精确属于当前目录。只要当前角色存在可播放候选就选择相似度最高者，不要求模型描述与用户自定义名称完全一致；模型返回目录外目标或目录为空时才回退当前角色 idle/default。
- 本地明确命令仍优先：补齐“请你移动/移动一下/跑一跑”等安全移动表达，但最终动画仍通过当前角色的 move 语义、名称与标签解析，不能写死某个动作 ID 或“跑步”名称。
- 文件任务的模型回包不参与行为相似匹配；可信任务动画沿用既有优先级。

### 4.3 自主移动

- 唯一主动计时改为每轮独立随机 10,000–30,000ms。
- autonomous 每次到期只提交 `wander(work_area)`；assistive 只提交原地 idle；不再由反思链触发其他可见动作。
- `wander(work_area)` 继续复用现有“按脚底与可见交集选择当前显示器”的单屏逻辑，并在该显示器工作区内随机目标。
- 随机远行使用 24 DIP 到达容差；进入容差即 `moving: false`，不强求精确落点。相对移动、区域移动和用户拖拽不使用该容差。
- `moving: true → false` 必须产生一次 movement-stop，并由现有引擎解析、播放当前角色可用的 idle/default 动作，终止循环跑步姿态。
- “停止移动”保持持久停止锁；在用户明确恢复前，自主计时不得再启动移动。

### 4.4 wheel 与左键

- `PetView` 将 wheel 的 `clientX/clientY/deltaY` 一并交给控制器；控制器用本次 wheel 坐标做命中，不依赖旧 pointermove。播放器 ready 时仍使用正式 Alpha，运行时回退画面则复用已经承担穿透判定的可见元素 bounds，不能让回退桌宠完全失去缩放。
- wheel 只在当前可见命中、非按压/非拖动、`deltaY != 0` 时提交一个缩放档位。
- 左键按下只建立候选会话并捕获指针；移动超过 4 DIP 后才调用 Main 开始拖动。未超过阈值的长按/点击在释放时只清理会话，不调用 `beginPetDrag`、`endPetDrag` 或 `stepPetScale`。
- Main 拖动轮询在目标窗口坐标未变化时不得重复 `setPosition`，避免静止长按产生无意义的 Windows `move/moved` 与几何事务。
- 保留既有 30 秒安全超时、穿透恢复和拖拽边界实现。

## 5. 失败与清理

- 文件续接只保留一次且不跨 reset、close、generation、授权根或 Provider 变化。
- 创建目录遇到目标冲突、父目录变化或链接替换时失败关闭，不静默复用或覆盖。
- 行为结构化字段解析失败不影响文字聊天；只回退 idle。
- wheel IPC 失败保持原缩放，吞掉 Renderer 侧未处理拒绝并恢复安全穿透。
- 拖动阈值会话在 pointercancel、lost capture、blur、超时和卸载时幂等清理。

## 6. TDD 与验收

### RED

1. 固化截图原句与两轮补路径：删除 `TempTest/empty` 必须进入 `delete_file` 确认；创建当前目录 `abc` 文件夹必须进入 `create_directory` 确认。
2. 固化 DeepSeek 首轮错误澄清：参数完整时工具集合不得包含澄清工具。
3. 自定义动作名/标签与隐藏 activity/status 不完全相同时选择当前目录中相似度最高候选；目录外返回或空目录回 idle/default。
4. 10–30 秒边界、单屏随机目标、24 DIP 容差、运动终止回 idle。
5. 无前置 pointermove 的 wheel 可缩放；左键长按不产生 scale 或 drag 调用；超过阈值仍可拖动。

### GREEN 与回归

- 先运行各 package 定向测试和 typecheck。
- 运行 `pnpm verify:desktop`、`pnpm verify:behavior`；角色公共契约变化再运行 `pnpm verify:characters`。
- 真实 Electron E2E 覆盖截图文件纵向链、明确行为、自主移动、wheel 和左键长按。
- 第 4、5、6 项只运行现有碰撞、拖拽边界和发布参数回归，不修改其生产逻辑。
- 最终仍标注真实 DeepSeek 网络响应、鼠标手感与 Windows 回收站为“待用户人工确认”，自动化不能替代人工验收。

## 7. 自复审裁决

- 方案复用现有 `AgentLoop`、工具注册、授权根、回收站、角色目录、行为引擎、运动服务和几何缩放队列，没有建立第二套 Agent 或动画运行时。
- 新增能力仅是用户明确要求的单目录创建；风险不高于现有 `create_file`，仍逐次确认且不递归。
- 最高相似匹配只在当前皮肤可播放的公开候选中进行，不能扩大系统权限。
- 对第 4、5、6 项采用最小修改策略：生产代码不进入这些已验收功能的实现面。

## 8. 2026-08-24 第二轮验收失败修订

### 8.1 新证据与旧验收失效原因

1. 当前真实设置同时满足“已选择授权根、Agent 路由已配置”，但 `privacy.dataCategories.file=false`。Main 据此把整个文件工具表清空，并在预览和执行阶段统一抛出 `FILE_DISCLOSURE_DENIED`。这错误地把“读取并向模型披露文件数据”与“用户已经在消息中明确给出相对路径、仍需逐次确认的本地写操作”合并成同一开关。
2. 旧文件 E2E 直接构造 `fileDisclosureAllowed=true` 并由脚本化 Provider 返回正确工具调用，因此只证明底层 `FileToolService` 可执行，没有覆盖真实默认隐私配置下工具根本不暴露的情况。
3. `movementStopped` 已存在，但显式 Gate 不识别“静止不动”“保持静止”“不要再动”等用户实际表达，所以该布尔锁没有被置位；“保持运动”也没有独立连续运动状态，现有一次性 `move` 到达目标后必然结束。
4. 旧 wheel E2E 先在 Renderer 内手工 `dispatchEvent(new PointerEvent('pointermove'))`，再等待窗口取消穿透。Electron 在 Windows 对 `setIgnoreMouseEvents(true, { forward: true })` 只承诺转发 mouse move；生产代码只监听 `pointermove`，旧测试绕过了真实事件类型。
5. 因上述三项真实链路未覆盖，原“已实施并通过自动化门禁”结论失效。本轮完成标准必须以真实文件副作用、Main 行为状态快照和持久化缩放值为证据。

OpenCode 对照研究见 `docs/research/2026-08-24-opencode-file-tool-execution-patterns.md` 和用户提供的 `D:\AgentLearning\opencode-file-operations-analysis.md`。已核对本机源码版本 `2a6be0a03b93a6734070e10a6c3b56863475f214`（MIT）：OpenCode 不从自然语言正则抽取文件路径，而是由模型生成经过 Schema 约束的文件工具参数，宿主再解析路径、询问权限、执行并回传结果。本项目复用该结构化闭环，不复制其绝对路径权限、完整 Agent 框架或宿主 Shell 能力。

### 8.2 文件能力修订

1. `privacy.dataCategories.file` 继续控制列目录、读取文件和把新文件数据发送给 Provider，不修改默认值，不静默扩大读取权限。
2. 删除本轮新增的自然语言目标路径提取、大小写转换、分隔符猜测和 `targetRelativePath` 许可绑定。Router 只判定普通聊天、文件能力任务及只读/写入类别，不负责解释文件名；具体 `relativePath/content/patch` 必须来自 Provider 的结构化工具参数并通过既有 Zod Schema。
3. `file=false` 时，明确写任务只从 `create_file`、`create_directory`、`apply_patch`、`delete_file` 四项受控写工具中公开与 Router 操作类别精确对应的一项，并由 AgentLoop 追加结构化澄清工具；读取、列目录和其他写工具保持不可见、不可执行。Provider 选错操作或目标不会直接执行，只会形成包含准确操作、规范化相对路径和预览的确认卡。
4. Main 在 `prepare` 后以 `VerifiedWriteAction` 为唯一待确认事实；确认和不可逆提交前重新校验任务 owner、Session、授权 generation 和动作 token。取消、reset、close、Provider/授权根/配置变化或任务结束立即失效。准确确认卡等价于 OpenCode 的 `ask once`，模型文字不能代替确认。
5. 单次确认只执行一个结构化写动作；多目标请求由 Provider 使用结构化澄清要求拆分，不在 Main 中用自然语言正则枚举目标。
6. 验收必须在隔离临时授权根中通过聊天链让 DeepSeek 兼容 Provider 自行生成结构化工具参数，创建真实目录或文件，并在确认后用 Node 文件系统读取结果；测试不得手工注入从自然语言猜测的目标路径。删除测试只删除本轮创建的测试实体并验证回收站端口结果。模型文字不算成功。

### 8.3 行为控制与隐藏运动计划修订

1. Director 明确维护 `autonomousMovementAllowed: boolean`，启动值为 `!movementStopped`。识别“静止不动、保持静止、不要再动、别乱跑”等停止命令后先持久化旧兼容字段 `movementStopped=true`，成功快照再把该布尔值设为 `false` 并立即停止运动；在明确“可以活动、恢复自主移动”前 Scheduler 不得发起自主移动。
2. Director 另维护 `continuousMovementRequested: boolean`。识别“保持运动、一直走、继续跑”等命令或合法隐藏计划后设为 `true`；每次进入目标 24 DIP 范围后，如果仍允许运动且未到时限，立即在当前单屏工作区选择下一个随机目标。停止命令把两个布尔状态分别设为 `false` 和 `false`。
3. 普通聊天结构化输出在既有 `text/activity/status/behaviorPlan` 外增加必需的隐藏 `motionPlan`：

```json
{
  "mode": "none | stop | once | continuous",
  "durationSeconds": null,
  "target": "current | random_work_area | left | right | top | bottom | top_left | top_right | bottom_left | bottom_right"
}
```

4. `durationSeconds` 只在运动模式使用，允许 `null` 或 1–600；`continuous + null` 表示持续到用户停止。目标只使用公开区域或当前单屏随机点，不把屏幕坐标交给 Provider。非法字段只丢弃运动计划，不影响文字回复。
5. 显式本地 Gate 优先于 Provider；Provider 计划只影响角色表现，不能获得文件或系统能力。动画仍从当前角色包全部可播放候选中按 `activity + status + motionPlan + 名称/语义/标签` 选择最高相似项。
6. Main 提供只读行为诊断快照，至少包含 `autonomousMovementAllowed`、`continuousMovementRequested`、`moving`、当前目标类型和状态标记。自动验收监视这些状态，不依赖肉眼动画判断。

### 8.4 真实 wheel 修订

1. 透明窗口穿透态同时监听原生 `mousemove/mouseleave` 与 Pointer 事件，二者进入同一去重的命中/穿透状态机；不建立第二套拖拽状态。
2. wheel 仍使用自身 `clientX/clientY/deltaY` 做最终 Alpha 或 fallback bounds 命中；未命中、按压中或拖动中均拒绝。
3. Electron E2E 不得在页面内手工派发 `PointerEvent` 来解锁穿透。测试必须从初始穿透状态使用真实输入移动到可见点并滚轮，随后同时读取 Main `scaleTick` 与 `settings.json` 中当前角色 scale，证明实际改变。
4. 增加失败链诊断计数但不记录坐标或路径：最近一次 mouse move 命中、wheel 是否到达 Renderer、是否提交 IPC、Main 是否提交新 scale revision。仅在测试边界公开完整探针，生产日志不输出用户输入。

### 8.5 第二轮完成门禁

- 文件：默认 `file=false` + 已授权根下，明确创建/删除进入真实确认，确认后实际文件系统改变；只读仍被拒绝。
- 行为：状态快照证明停止命令后 30 秒以上没有自主移动；连续运动至少完成两个不同目标且中间保持运动意图，停止后立即归 idle；一次性运动到达后归 idle。
- 缩放：不注入 DOM 事件，真实 wheel 使 Main revision、scaleTick 和持久化 scale 同步变化；长按不改变 scale。
- 运行全部定向测试、`pnpm.cmd verify:desktop`、`pnpm.cmd verify:behavior`、`pnpm.cmd verify:characters` 与 `git diff --check`。第 4、5、6 项只回归，不改业务逻辑。
