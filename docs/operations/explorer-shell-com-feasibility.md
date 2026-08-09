# Windows Explorer Shell/COM 技术门记录

## 结论

阶段 3B Task 0 当前状态为 **blocked**。固定桥接协议、客户端生命周期和单窗口准确路径已通过自动测试与当前 Windows 实机烟测，但以下两项硬门尚未获得真实证据：

1. 用户手工构造“同一 Explorer HWND 的两个标签页”后，Shell/COM 同时返回两个不同目录候选，但固定桥接在两个标签分别位于前台时都错误返回 `ready`，没有返回安全的 `ambiguous`。因此当前 Shell/COM 桥接无法准确归因活动标签，真实多标签技术门已确认失败。
2. `place-near` 已在目标 Explorer 上方不存在相邻窗口时明确返回 `LAYER_UNPROVABLE`，不会退化到 `HWND_TOP`；本轮尚未完成测试窗口的真实 Z 序、其他应用抢前台和 `remove-layer` 恢复验证。

根据实施计划，这两项未证明前不得进入 Task 1，也不得改用窗口标题、最近路径、永久置顶、ExecutionPolicy Bypass 或通用桌面自动化。

## 环境

- 系统：Microsoft Windows 11 专业版
- 版本：10.0.26200，Build 26200
- 固定运行时：`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
- CurrentUser ExecutionPolicy：`RemoteSigned`
- MachinePolicy、UserPolicy、Process、LocalMachine：`Undefined`
- 桥接启动参数不包含 `ExecutionPolicy` 或 `Bypass`

## 已通过证据

### 协议与客户端

- 定向测试：26/26 通过。
- 覆盖版本、nonce、requestId、序号、严格未知字段、16 KiB 行限制、错误矩形、空路径、非 Explorer 类型和固定五命令白名单。
- hello 前不发送命令；沉默进程触发稳定 `BRIDGE_HELLO_TIMEOUT`。
- hello 前后协议错误只终止当前客户端持有的 child，不按外部 PID 查杀。
- stderr 只接受稳定诊断码；路径或命令正文会触发 `BRIDGE_STDERR_INVALID`。
- Main 启动参数为数组，`shell=false`、`windowsHide=true`、三路 pipe，环境只保留 SystemRoot、WINDIR、ComSpec、PATHEXT、TEMP 和 TMP。

### 固定脚本生命周期

- 真实桥接 PID 23520：完成 hello、start-observing、`none` 快照、stop-observing、shutdown；序号从 0 递增至 4，stderr 为空，退出码 0。
- 真实桥接 PID 23236：前台 Explorer 单窗口返回 `ready`，包含准确 HWND、矩形和测试目录路径；shutdown 后退出码 0。
- PowerShell 5.1 默认控制台编码曾导致中文和非 BMP 字符损坏，已固定 stdin/stdout 为无 BOM UTF-8。
- 初版 `ReadLineAsync` 在 Windows PowerShell 5.1 中阻断轮询，已换成同一进程内固定 C# 后台输入线程与队列；没有新增子进程或任意命令入口。当前队列尚未实现容量和背压，不得描述为有界。
- Shell 快照异常统一降为 `SNAPSHOT_FAILED` 并关闭，不再由 PowerShell 输出错误上下文或绝对路径。

### Explorer 观察

- 单窗口：前台 `CabinetWClass`、explorer.exe、Shell COM HWND 和目录路径一致时返回 `ready`。
- 特殊字符：测试目录包含空格、中文、`#`、`%` 和非 BMP 字符；修正 UTF-8 后协议可无损传输。
- 非 Explorer 前台：返回 `none`。
- 两个独立窗口：Shell COM 返回两个不同 HWND，可按前台 HWND 收敛到单一候选，不产生分身。
- 搜索 URL 在脚本中以 `search-ms:` 明确返回 `none`，不使用标题判断。
- 最小化窗口通过 User32 `IsIconic` 返回 `none`。

## 未通过或未执行

- 同一 HWND 多标签真实切换：用户分别激活两个标签后，两轮前台 HWND 均为 `656810`；Shell/COM 两轮均得到两个候选、两个唯一路径且属于同一 HWND，但固定桥接两轮均错误返回 `ready`。技术门确认失败。
- 地址栏切换、搜索结果、最小化、关闭和 Explorer 重启的完整连续人工矩阵：仅完成代码路径与部分实机事实，未形成完整真实证据。
- 非全局置顶：已禁止 `GW_HWNDPREV=0` 退化，但未完成真实测试窗口 Z 序矩阵，技术门阻塞。
- 企业强制 ExecutionPolicy：当前机器无 MachinePolicy/UserPolicy，无法在不修改系统策略的前提下模拟；客户端不会加入 Bypass。

## 清理

- 两个测试 Explorer 窗口已按测试目录精确匹配并关闭。
- 临时目录 `Codex-Habitat-空间 #100% 🦊` 已确认位于系统 TEMP 后删除。
- 已记录的桥接 PID 均已退出；未按名称或模糊条件终止其他 PowerShell 进程。

## 解阻条件

当前 Shell/COM 路线已经取得真实失败证据，不能继续用标题、最近路径或候选顺序猜测活动标签。进入阶段 3B 后续任务前，必须先提交新的受限 UIA 安全设计并取得用户批准；新设计至少必须取得：

1. 活动标签可由 Shell/COM 唯一归因，或桥接稳定返回 `ambiguous` 并保持隐藏；
2. 测试窗口只在目标 Explorer 相邻普通 Z 序，其他应用前台时不覆盖，`remove-layer` 后恢复普通层级。

此外，当前实验实现仍有失败后未可靠等待子进程退出、Shell/COM 不可用被降格为 `none`、输入队列和实例映射无界等审查问题。该实现不得作为 Task 0 完成结果提交或接入生产。

## 受限 UIA 探测结果

用户批准受限 UIA 设计及其第 13 节一次性分层缓存修订后，在当前 Windows 11 Build 26200 上完成了三次互相收敛的真实结构探测：

1. RawView 逐节点读取在单 MTA 线程 100 毫秒边界内超时。
2. 两阶段最小读取仍在相同边界内超时。
3. 仅按 `TreeScope.Children` 分层、缓存八个批准属性的 `CacheRequest` 探测仍超时。

三次均没有输出结构 JSON、Name、Value、路径或 RuntimeId；每个一次性探测进程均已退出，临时探测文件已删除，生产 profile 始终保持未验证状态。按照“三次无新增证据即停止同类路径”的规则，不再继续重试或把 100 毫秒边界静默放宽。

这说明当前“PowerShell 固定桥接内同步遍历 UIA 树”的路线在批准的时限内不可行，不再继续扩大 UIA。

## Shell 标签 HWND 恢复路线

后续调查确认原 Shell/COM 失败并不代表 Shell 无法区分标签，而是原桥接只比较了共享的外层 `CabinetWClass` HWND，遗漏了每个标签自己的 `ShellTabWindowClass` 子 HWND。成熟开源项目 ExplorerTabUtility 使用活动标签候选 HWND 与每个 Shell COM 对象的 `IShellBrowser.GetWindow` 结果进行唯一映射，再读取唯一匹配对象的路径。

该方法已写入 `2026-08-07-ai-pet-shell-tab-window-task0-recovery.md`，替代进程隔离 UIA 方向。它仍是待当前 Windows 实机证明的技术假设：`ShellTabWindowClass` 同级 Z-order 首项不是微软公开的活动标签保证，必须通过 A → B → A、竞态、Explorer 重启和失败关闭矩阵后才能解除 Task 0 阻塞。

## 2026-08-08 Task 0E 实机证据与用户范围裁剪

以下项目已在用户限定的单屏验收范围内取得真实证据；当前机器虽连接双显示器，但本轮没有执行多屏验收：

- Electron 与固定 User32 两条非 topmost 层级路线均完成 A → B → A、前台保持、扩展样式和失焦隐藏验证；最终生产选择 Electron `moveAbove`。
- 单标签、最小化、恢复和关闭生命周期矩阵完成；恢复后仍对应同一外层窗口和同一切换轮次。
- 搜索结果保持隐藏，搜索期间稳定 `ambiguous` 不会重新显示；实际验收使用的 AppsFolder 虚拟目录返回严格 `none`。
- 三标签 A、同目录 B、不同目录 C、返回 A，以及两个 Explorer 窗口往返的前七步准确性身份、轮次和加钥指纹验证完成。
- 所有已启动的固定验收子进程均已退出，最终残留数为零。

以下项目没有取得真实通过证据，不得写为 `passed`：

- 本次重新运行 `accuracy-core` 只取得 W1-A `ready`、`round=1`；夹具等待 B 时用户终止，未取得后续窗口往返或自动 rapid 终态证据。
- 地址栏父目录、特殊字符目录的当前新 helper 全流程、Explorer 完整重启和新 generation 尚未执行。
- Shell/COM 拒绝或卡顿、企业 ExecutionPolicy 阻止、HWND 复用等失败路径只有自动门或既有局部证据，未完成全部真实矩阵。
- 多显示器、负坐标、混合 DPI 和跨屏移动按用户当前单屏范围明确暂缓，状态为“未验收”，不代表支持。

用户已明确接受上述剩余人工未验收风险并要求继续 Task 0F。本次受控切换只把已验证的精确身份常量提升为生产 profile，不扩大 OS Build、Explorer ProductVersion、FileVersion 或映射版本范围；未知身份继续返回 `unavailable`。该风险接受不等于 Task 0E 全矩阵通过，也不等于阶段 3B 完成。

2026-08-08，用户再次明确要求跳过剩余验证、接受风险并执行下一步。本次 `accuracy-core` 在等待 B 时由用户 `Ctrl-C` 终止，检查确认验收进程残留为零。该授权作为阶段门例外，允许按原计划顺序进入 Task 1；它不追认 Task 0 原完成定义，不把上述剩余项目写为 `passed`，也不代表多屏、负坐标、混合 DPI 或跨屏移动获得支持。

## 2026-08-08 Task 0F 技术切换状态

- 精确 OS、Explorer ProductVersion、FileVersion 与映射版本 profile 已从候选验证态提升为生产已验证态；任何身份偏差仍失败关闭为 `unavailable`。
- 新 Shell 标签 helper 已成为生产桥接唯一观察实现；旧 UIA 观察器、外层窗口候选归因，以及 User32 层级协议和实现已经删除。helper 为候选识别保留的受限只读 Win32 调用不属于已删除的层级路线。
- 生产协议增加不携带路径、HWND、实例、矩形或状态事实的观察心跳；稳定快照去重时由心跳续观察看门狗，不续普通请求超时。
- 自动总门已完成协议、客户端、helper、Electron 层级控制器、真实桥接、类型检查、生产构建和 Desktop 全套测试。

本次只完成 Task 0F 技术切换，没有把 Explorer 观察或层级控制接入 Main、正式桌宠窗口、Renderer 或 Preload。桥接与 helper 运行源文件已经准备，但 `extraResources`、完整性清单和正式生产组合仍留给原计划 Task 10；当前桌宠窗口的 `alwaysOnTop` 创建行为保持原状，非永久置顶正式组合仍留给 Task 6。因此 Task 0F 技术切换完成不代表 Task 0E 全矩阵通过，也不代表阶段 3B 完成。

## 2026-08-09 Task 12 自动门与人工验收状态

- 当前基线 `5932444d03906c8c271491181b6024bf8acec7c2` 已运行 Task 12 五道自动门。`verify:behavior` 默认并发首轮有一个既有角色包导出测试超过 5 秒；该文件精确复现 45/45 通过，原用例耗时 615 毫秒。未放宽 timeout、未修改代码，以 Vitest threads/forks 固定为 2 后完整重跑通过。该首败保留为并发资源抖动证据。
- `verify:characters`、`verify:desktop` 均以相同低并发完成，三次完整 Electron E2E 各为 43/43；file-tools 48/48 与 typecheck 通过。自动 E2E 仍使用 Main fake bridge，不是 Explorer、Shell/COM 或真实窗口层级人工证明。
- 专用人工目录已在系统临时区创建并确认初始为空，未向目标目录写入标记。真实 Explorer 人工矩阵尚未开始，因此 Task 12 和阶段 3B 不得标记完成。
- 多显示器、负坐标、混合 DPI 和跨屏移动继续按用户裁决记为“用户范围暂缓/未验收”，不代表支持或硬件阻塞；单屏 100%、当前任务栏与全屏应用仍待人工验收。
- Explorer 重启、权限拒绝、磁盘断开和批量临时目录清理均未执行。前两类系统状态操作必须先取得用户明确确认；大量历史和单测保留目录未经二次批准不删除。

## 2026-08-10 目录藏身退役与保留图层边界

目录藏身不再是产品目标。目录授权、路径采集、空间状态机、设置与托盘入口、呼唤/召回、迷路恢复和专用角色表现已经删除；旧 `habitat.json` 保留在用户磁盘上但新版本不读取。上述 Task 0E、Task 12 和人工矩阵仍按原记录保持“通过”“失败”“未执行”或“未验收”，本次退役与新自动测试都不追认历史缺口。

保留的生产能力只包括：固定 bridge/helper 发布无路径 Explorer 实例事实，Main 严格验证 nonce、单调序列、前台与最小化状态，再通过 Electron `moveAbove` 建立相邻层级。桌宠窗口保持 `alwaysOnTop: false`；非 Explorer、失焦、最小化、歧义、桥错误和层级错误均不改变桌宠可见性。Renderer、preload、Agent、日志和 E2E 控制面都不接收目录路径或私有 HWND。

本次自动验收已取得以下证据：character-runtime 221/221；Desktop 1287/1287（另 14 项按原条件跳过）；安全门 17/17；集成门 22/22；Desktop 类型检查与生产构建通过；专用 Electron 图层场景 1/1 通过。场景覆盖准确快照、非 Explorer、失焦、最小化、歧义、层级失败和后续恢复，并持续断言桌宠可见且 `alwaysOnTop: false`。协议、E2E 白名单和打包资源行为测试同时覆盖路径拒绝、Main-only 去标识化图层状态和固定资源清单。

真实 Explorer 人工验收仍需单独确认以下四项，自动门不能替代：Explorer 前台时桌宠在其上方；普通应用前台时自然覆盖桌宠且桌宠未自行隐藏；切回 Explorer 后重新建立层级；最小化或关闭 Explorer 后桌宠仍作为普通窗口可见。

## 2026-08-10 阶段 3 尾声：可选桌宠置顶偏好

当前生产边界以 `alwaysOnTop: false` 为默认：准确前台 Explorer 通过 Electron `moveAbove` 建立相邻层级，其他应用前台时可自然覆盖桌宠。用户可在设置的隐私页显式开启独立窗口偏好“桌宠始终置顶”；开启后真实桌宠窗口全局 topmost，Explorer 协调器暂停消费 `moveAbove`。关闭后立即恢复 `alwaysOnTop: false`，后续新鲜准确快照可重新建立动态相邻层级。该设置独立于 Agent 隐私与数据披露对象。

自动证据覆盖默认值、旧 V2 默认迁移、独立严格 IPC/preload、即时应用与重启持久化、开启期间忽略 `moveAbove`、关闭后的新鲜快照恢复、应用或持久化失败补偿、并发事务串行、退出前冻结冲刷和启动失败关闭。窗口基础创建选项仍为 `alwaysOnTop: false`。

用户已进行简单人工观察并认为基本正常，同时明确跳过严格人工 Z 序矩阵并接受残余风险。因此这里只记录“用户简单验收”，不得写成完整人工矩阵通过；前述 Task 0E、Task 12、多窗口、多显示器及完整 Z 序缺口继续保持原历史状态。
