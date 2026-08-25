# AI 桌宠拖拽、运动恢复、文件移动与 Zen 退役修复规格

日期：2026-08-25

状态：已实施；自动门禁通过，真实 Windows 主观拖拽手感待用户人工确认

## 1. 目标

本轮只处理四项明确问题：

1. 完整退役 OpenCode Zen 匿名免费模型，不替换或破坏现有 Provider 配置。
2. 消除桌宠拖拽启动迟滞与拖拽期间的视觉尺寸变化，并删除“拖动我”提示。
3. 明确运动命令能够从持久停止锁恢复，并立即执行用户要求的运动。
4. 新增真实的“把普通文件移动到另一个文件夹”能力；模型文字不能伪造移动成功。

## 2. 非目标与安全边界

- MCP runtime、Agent、Preload 与 Renderer 继续禁用。
- 不新增跨授权根、跨卷、目录树移动、覆盖移动或任意 Shell 旁路。
- 移动工具只接受同一活动授权根内的普通文件和已存在目标目录，目标文件名沿用源文件名。
- Provider、Renderer 与角色包没有文件系统权限；Electron Main 的真实工具结果仍是唯一成功事实。
- 不恢复滚轮缩放；桌宠运行时尺寸继续固定为 100%。
- 不修改已验收合格的碰撞边界和角色工作台发布契约。

## 3. 根因

### 3.1 Zen 退役

Zen 是上一轮新增的独立目录、档案字段、匿名凭据、错误映射与设置 UI 分支。删除目录项但保留运行时分支会形成不可达旧代码；只删除 Schema 又会让已保存的 Zen 档案使整个设置文件被隔离。因此必须同时删除功能链，并用一次性通用退役迁移删除旧 Zen 档案及其路由引用，保留其他档案和设置。

### 3.2 拖拽

Renderer 当前先等待指针超过 4 DIP，再异步调用 Main；Main 收到后才采集系统光标，并等待下一次 16ms interval 更新窗口，形成可感知的起步迟滞。拖拽本身没有缩放窗口的数据流；已确认的视觉变大来源是备用角色呼吸 CSS 的 `scale`，用户素材动画帧也可能在拖拽期间继续改变可见轮廓。

### 3.3 停止后无法运动

停止锁、Settings、Director、Scheduler 和 Motion 链本身正常。缺陷是 `move` 与 `continuous_movement` 明确命令在锁定时没有先保存 `movementStopped=false`，随后被 Director 的停止门立即拒绝；“动、运动、跑”等短词也未被显式 Gate 识别。

### 3.4 文件移动与伪成功

Router 会把移动识别为文件任务，但 `FilePlanningOperation`、工具注册表、文件服务和确认契约都没有移动操作。规划提示为空时模型可调用只读工具；AgentLoop 又把任意真实只读结果视为已经完成可信工具，随后接受“已移动”文本，导致成功状态与文件系统事实分叉。

## 4. 方案

### 4.1 完整退役 Zen

1. 从 Provider 目录、公开档案 Schema、Registry、OpenAI Provider、设置服务、会话组合、错误映射和设置 UI 删除 Zen/匿名公开分支。
2. 删除只验证 Zen 功能的测试和文档结论；现有十个预置 Provider 的顺序与行为不变。
3. SettingsStore 在严格解析前执行一次退役档案迁移：只删除 `opencode-zen-anonymous` 档案，清空指向它的路由字段和 fallback 引用，保留其他设置；迁移后不再存在匿名凭据能力。

### 4.2 低延迟且固定视觉的拖拽

1. 左键在像素命中区域按下时立即请求 Main 建立拖拽会话，不再等待 4 DIP 阈值。
2. Main 建立会话后立即执行一次位置同步，再启动既有 16ms interval；窗口位置仍只由系统光标与初始窗口边界计算，Renderer 不发送坐标。
3. 指针会话期间把 CharacterPlayer 与 CSS fallback 切到 `static`，释放或取消后恢复原动画；拖拽前后窗口宽高、几何 scale tick 和可见矩形尺寸保持不变。
4. 删除 `pet-drag-hint` DOM、CSS 和只验证该提示存在的断言。

### 4.3 明确运动即恢复

1. Gate 将独立的“动、运动、跑”识别为一次短距 `move`；现有方向、远距、区域和持续运动语义不变。
2. 对本地显式 `move` 或 `continuous_movement`，若停止锁为真，先 `await saveMovementStopped(false)`；只有落盘和 Director 快照应用成功后才请求动作与 Motion。
3. 保存失败时保持停止，不提交动作、不产生运动成功事实。Provider 结构化建议仍不能自行解除持久停止锁。

### 4.4 真实普通文件移动

新增专用工具 `builtin.files.move_file`：

```ts
{
  sourceRelativePath: string;
  targetDirectoryRelativePath: string;
}
```

执行规则：

1. 预览时解析源普通文件与已存在目标目录，拒绝授权根、目录源、链接、Junction、绝对路径、`..` 和目标已存在。
2. 最终目标为“目标目录 + 源 basename”；确认卡同时展示源与最终目标相对路径。
3. Main 私下记录源 `dev/ino/size/mtime` 与目标目录 `dev/ino`。确认后重新解析并复核，任一变化稳定拒绝。
4. 使用 Node `rename` 在同一授权根内原子移动；不覆盖、不复制后删除、不跨卷 fallback。
5. 确认前源存在且目标不存在；成功后源不存在、目标内容与身份对应；失败不发布成功事件。

### 4.5 阻断模型伪成功

1. 移动请求必须生成精确 `move_file` planning hint，只向模型开放移动工具和结构化澄清。
2. 能力规划携带期望操作；写任务只有收到同一操作的 Main 本地 `ok:true` 结果后才允许最终总结。
3. `list_files`、`read_file` 等只读结果不能满足移动/创建/补丁/删除写任务；模型提前输出成功文本进入一次协议修复，仍不合规则返回稳定错误且不显示该文本。

## 5. TDD 验收

### 5.1 Zen

- RED：目录、UI、公开 Schema 与生产源码不得再出现匿名 Zen 能力；旧 Zen + DeepSeek 设置加载后只移除 Zen，DeepSeek、路由外设置和密钥槽不变。
- GREEN：现有 Provider 设置、连接测试、路由和迁移测试通过。

### 5.2 拖拽

- RED：命中后 pointerdown 同轮调用 `beginPetDrag`；Main `beginDrag` 同轮执行首笔同步；拖拽状态下播放器为 static。
- 连续拖拽探针断言 scale tick 恒为 10，窗口宽高不变；删除提示文字和样式。

### 5.3 行为

- RED：初始 `movementStopped=true` 时输入“动/运动/跑/跑一跑/保持运动”，先保存 false，再产生 Motion；保存失败时零 Motion。
- 恢复后 Scheduler 重新获得自主资格；再次停止后仍保持锁定。

### 5.4 文件移动

- RED：真实临时授权根中，确认前无副作用，确认后源消失且目标文件内容一致。
- 覆盖目标已存在、源/目标目录身份变化、链接/Junction、过期确认、取消、执行失败和只读工具伪成功。
- Electron E2E 从用户文本开始，经过 Provider 工具调用与确认卡，再检查真实隔离文件系统结果。

## 6. 完成门禁

先运行每项定向 RED/GREEN，再运行相关 package typecheck、`pnpm.cmd test:security`、`pnpm.cmd test:integration`、`pnpm.cmd verify:desktop` 和 `pnpm.cmd verify:behavior`。真实 Windows 主观拖拽观感仍由用户人工验收；自动化只证明启动链、尺寸不变量、状态与真实文件副作用。
