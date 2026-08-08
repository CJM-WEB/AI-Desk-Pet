# 智能桌宠受限 Explorer UIA 观察器安全设计

> **历史状态：实机不可行，已被替代。** 本设计及第 13 节均已按批准边界执行，但 RawView、两阶段最小读取和分层 CacheRequest 三次真实探测都在 100 毫秒内安全超时。后续不得继续扩大 UIA；阶段 3B Task 0 改由 `2026-08-07-ai-pet-shell-tab-window-task0-recovery.md` 的 Shell 标签 HWND 唯一映射路线恢复。本文件保留为失败证据，不再作为实施清单。

## 1. 背景与结论

阶段 3B Task 0 已在 Windows 11 Build 26200 获得真实失败证据：同一 Explorer HWND 中存在两个不同目录标签时，Shell/COM 同时暴露两个目录，但当前桥接在两个标签分别位于前台时都错误返回 `ready`。因此不得继续根据 Shell/COM 候选顺序、窗口标题、标签名称或最近路径猜测活动标签。

本设计建议增加一个固定用途、只读、失败关闭的 UIA 观察器。它只回答“当前前台 Explorer 的活动标签能否被唯一证明以及其完整本地目录是什么”，不提供通用桌面自动化能力。设计经用户批准并完成当前 Windows 构建的真实探测前，不得实现或进入阶段 3B Task 1。

## 2. 明确目标

- 准确识别当前前台 Explorer 窗口中唯一选中的标签。
- 读取该标签当前地址控件提供的完整本地绝对路径。
- 将 UIA 地址与同一 HWND 的 Shell/COM 候选精确交叉验证。
- 任何歧义、竞态、结构变化、超时或组件不可用时保持桌宠隐藏。
- 保留现有固定 JSONL 协议、最小子进程环境和非永久置顶边界。

## 3. 明确禁止

- 不开放通用 UIA 查询、元素树、属性查询或 Pattern 调用给 PowerShell、Main、Preload、Renderer、Agent 或角色包。
- 不允许 `Invoke`、`SetValue`、`Selection.Select`、`ExpandCollapse`、`Scroll`、`Transform` 等写入或控制 Pattern。
- 不允许从桌面根节点开始搜索，不允许跨进程或跨窗口枚举。
- 不允许截图、OCR、窗口标题匹配、标签名称匹配、文件夹名猜测、最近路径或候选顺序猜测。
- 不允许键鼠注入、快捷键、`SendMessage`、`PostMessage`、任意 ProgID、任意脚本或任意进程启动。
- 不读取目录条目，不把藏身目录设为 Agent 授权根，不扩大文件工具权限。

## 4. 固定观察接口

UIA 只能封装在固定桥接内部的 C# 类型中，对脚本只暴露无参数方法：

```text
ObserveActiveExplorer() -> ready | ambiguous | none | unavailable
```

返回 `ready` 时只包含既有协议需要的最终字段：Explorer HWND、不透明实例标识、完整本地路径和窗口矩形。不得返回 UIA 元素、树节点、控件名称、RuntimeId 原值、进程路径或未验证候选。

固定允许的 UIA 能力：

- `AutomationElement.FromHandle`。
- `TreeWalker.RawViewWalker` 的 `GetFirstChild` 和 `GetNextSibling`。
- `GetCurrentPropertyValue`。
- 属性仅限 ProcessId、NativeWindowHandle、ControlType、AutomationId、ClassName、IsOffscreen、IsEnabled 和 RuntimeId。
- Pattern 仅限只读的 `SelectionItemPattern.IsSelected` 与 `ValuePattern.Value`。

遍历必须从已经验证的前台 Explorer HWND 根开始，最大深度 12、最多访问 256 个节点、单轮最多 100 毫秒。不得回退为模糊搜索。

## 5. 窗口与进程身份验证

观察前后必须同时满足：

1. `GetForegroundWindow` 未变化且不为零。
2. 窗口未最小化，类名只允许 `CabinetWClass` 或 `ExploreWClass`。
3. `GetWindowThreadProcessId` 得到的 PID 前后相同。
4. `QueryFullProcessImageName` 必须精确等于 `%WINDIR%\explorer.exe`。
5. UIA 根的 ProcessId 和 NativeWindowHandle 必须分别等于已验证 PID 和 HWND。
6. 观察结束时再次确认窗口仍在前台，并复核选中标签的 RuntimeId 未变化。

任一检查失败必须丢弃本轮结果。RuntimeId 只能在桥接内部用于本轮一致性检查和生成不透明实例标识，不得持久化或原样输出。

## 6. 活动标签与地址证明

- 只接受固定 Explorer 结构指纹下、固定标签容器内唯一满足 `TabItem` 且 `SelectionItem.IsSelected=true` 的元素。
- 选中标签必须启用且没有离屏；零个或多个选中项均返回 `ambiguous`。
- 只读取同一 Explorer 根、固定祖先链下当前地址编辑控件的 `ValuePattern.Value`。
- 地址值必须本身就是完整、已根化的 Win32 本地路径。
- 不移除本地化“地址”前缀，不拼接面包屑，不展开环境变量，不转换虚拟命名空间。
- `Path.GetFullPath` 规范化后，必须与同一 HWND 的 Shell/COM 候选按 `OrdinalIgnoreCase` 精确匹配且唯一。
- 地址栏编辑中、搜索结果、虚拟目录、无匹配、多匹配或前后状态变化均不得返回 `ready`。

Windows 11 上即使 Shell/COM 只返回一个候选，也必须经过 UIA 交叉证明，不能因为候选数量为一而直接信任。

## 7. 状态与失败关闭

- `none`：前台明确不是 Explorer、目标窗口已关闭或最小化、或者明确处于搜索结果。
- `ambiguous`：已经确认是 Explorer，但无法唯一证明活动标签或完整本地路径。
- `unavailable`：UIA、Shell/COM、协议或安全验证组件不可用。
- `ready`：只有全部身份、标签、地址、Shell/COM 和竞态复核通过时允许。

Main 收到 `ambiguous`、`unavailable`、桥接退出、超时、未知结构指纹或未知系统构建时必须立即隐藏桌宠，并清除上一轮临时 `ready`，不得沿用缓存路径。

Shell/COM 或 UIA 初始化失败必须输出稳定诊断码并退出，不能降格为 `none` 后继续运行。诊断不得包含路径、命令、元素文本或环境内容。

## 8. 协议、资源和生命周期

- 保留版本化 JSONL、进程 nonce、请求 ID、递增序号、16 KiB 行限制和 start/stop/place/remove/shutdown 五命令白名单。
- 不增加任意 UIA 查询命令，Main 和 Renderer 不得指定窗口、元素、属性或 Pattern。
- 轮询间隔暂定 750 毫秒；UIA 单轮上限 100 毫秒，连续超时必须关闭桥接。
- 输入队列容量最多 8 行，每个 tick 限制处理数量；超过容量以稳定错误关闭。
- 不透明实例映射使用最多 64 项的 LRU，不得随 HWND 和路径无限增长。
- 客户端失败和关闭必须等待自己持有的 child 真正退出；超时后只对该 ChildProcess 调用终止并再次等待。
- 不允许根据外部 PID 或进程名查杀，不得在进程仍存活时把关闭状态标记为完成。

## 9. Windows 构建兼容策略

首批只允许当前已实测的 Windows 11 `10.0.26200`。必须通过只读结构探测锁定标签容器、选中标签和地址控件的祖先链、AutomationId 与 ClassName 组合，形成版本化结构指纹。

系统构建或 Explorer 结构指纹不匹配时返回 `ambiguous` 或 `unavailable`。Windows 更新后必须重新执行验收才能增加新 profile。Windows 10 无标签 Explorer 必须使用独立实测 profile，不能自动复用 Windows 11 假设。

## 10. 强制真实验收矩阵

每一项都只记录脱敏状态和匹配结论，不在文档记录用户绝对路径：

- 单窗口单标签。
- 同一 HWND 双标签 A → B → A。
- 同一目录的两个标签。
- 两个窗口各自包含双标签并来回切换前台。
- 地址栏编辑中、提交地址后和进入上级目录。
- 搜索结果、虚拟目录、最小化、恢复和关闭。
- Explorer 重启及 HWND/PID 复用。
- 路径包含空格、中文、`#`、`%` 和非 BMP 字符。
- 轮询中切换标签、窗口和重启 Explorer，期间不得短暂误报 `ready`。
- UIA 服务异常、Shell/COM 异常、超时、输出超限、ExecutionPolicy 阻止和不支持构建。
- 桥接退出后无残留进程。

窗口层级门独立验证：测试窗口只处于目标 Explorer 相邻普通 Z 序；切换到其他应用后不得覆盖；`remove-layer` 后恢复普通层级；窗口不得设置 TopMost。

## 11. 对当前 Task 0 实验文件的处理

- 保留并修正 `explorer-space-protocol.ts`、`explorer-space-client.ts` 及其测试，继续复用严格协议边界。
- `explorer-space-bridge.ps1` 只保留固定启动壳、JSONL、固定 User32 层级函数和 Shell/COM 交叉验证；必须替换当前错误的多标签归因。
- 修复客户端退出等待、Shell/COM 错误状态、输入队列和实例映射无界问题。
- 保留 `explorer-shell-com-feasibility.md` 作为 Shell/COM 路线真实失败记录，不改写历史结论。
- 若无法把 UIA 对象与能力完全封装在固定 C# 观察器内，则废弃当前脚本实验，不得接入生产。

## 12. 批准门

用户批准本设计只表示允许执行以下下一步：

1. 为固定观察器编写 RED 测试。
2. 在当前 Build 26200 上执行只读 UIA 结构探测。
3. 根据真实结构收敛固定 profile。
4. 重新执行 Task 0 的全部准确性、层级、安全和生命周期门禁。

批准不代表允许通用 UIA、键鼠控制、截图、目录读取或直接进入 Task 1。Task 0 全部门禁通过前，阶段 3B 仍保持 blocked。

## 13. 待批准修订：一次性分层缓存探测

当前 Build 26200 的两次真实探测均在 100 毫秒内安全超时，逐节点跨进程读取没有得到结构证据。以下修订仅是待用户批准的探测方案，不属于前述已批准范围：

- 一次性探测器允许使用 UIA `CacheRequest`，但只允许 `TreeScope.Children` 按层缓存；禁止 `TreeScope.Subtree`、`RawViewCondition` 全子树缓存、`BuildUpdatedCache`、`GetUpdatedCache` 和不受控 `GetCachedChildren` 递归。
- 每一层返回后立即执行同 PID、深度和累计节点计数；达到 12 层或 256 节点立即停止并判定歧义，不能先缓存未知规模子树再计数。
- 缓存属性仍限 ProcessId、ControlType、AutomationId、ClassName、IsEnabled、IsOffscreen，以及新增的 `IsSelectionItemPatternAvailableProperty` 和 `IsValuePatternAvailableProperty`。
- 探测阶段不得缓存或读取 `ValuePattern.Value`，不得输出 Name、HelpText、Value 内容、路径或 RuntimeId；只输出 Pattern 是否可用的布尔值。
- 单次缓存调用仍视为不可取消的跨进程调用，必须位于唯一后台 MTA 线程；外层 `Join(100ms)` 超时后直接结束整个一次性探测进程，不继续、不创建第二线程。
- 探测器必须与生产桥接和 JSONL 协议完全隔离，结构 profile 锁定并完成验收后删除。生产源码和测试必须明确禁止 `CacheRequest` 与任何探测入口。

该修订不能保证 100 毫秒内成功，只是减少跨进程往返的受限尝试。若仍超时或无法证明标签与地址的固定结构关联，Task 0 继续 blocked，不再扩大为全子树缓存或放宽时间边界。
