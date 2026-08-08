# 智能桌宠阶段 3B Task 0：Explorer 活动标签与动态层级恢复实施计划

**日期：** 2026-08-07

**状态：** 待实施

**目标：** 用受限 Shell 标签 HWND 映射替代已失败的 UIA 路线，准确识别 Windows 11 前台 Explorer 的活动标签目录；独立证明桌宠只位于目标 Explorer 上方、不会成为全局置顶窗口。只有本计划全部技术门通过后，才恢复执行阶段 3B 原计划 Task 1。

**恢复关系：** 本计划替代 `2026-08-07-ai-pet-directory-habitat-explorer-space.md` 的 Task 0，不修改原计划 Task 1 至 Task 12 的业务范围。原 Shell/COM 外层 HWND 失败记录和受限 UIA 超时记录继续保留为历史证据。

**2026-08-08 执行状态与偏差：** 用户明确接受剩余人工验收风险，并批准在 Task 0E 原硬门尚未全部取得真实证据时继续 Task 0F。该决定只允许完成技术路线切换，不修改或追认本计划原验收条款。以下项目仍为未验收：自动 rapid 终态实机复核、地址栏父目录、特殊字符目录的新 helper 全流程、Explorer 完整重启与新 generation、Shell/COM 拒绝或卡顿、企业 ExecutionPolicy 阻止、HWND 复用等完整失败矩阵，以及多显示器、负坐标、混合 DPI 和跨屏移动。当前机器连接双显示器，但用户把本轮范围限定为单屏；这不代表多屏支持。

Task 0F 的技术切换已经完成：精确 profile 已提升，新 helper 成为唯一生产观察实现，旧 UIA 观察与 User32 层级路线已删除，观察心跳已加入，并通过自动总门。桥接与 helper 运行源文件已经准备，但 `extraResources`、完整性清单和正式 Main/桌宠组合尚未接入，仍归原计划 Task 10；`alwaysOnTop` 行为没有在本 Task 改动，仍由 Task 6 完成。因此本计划 Task 0E 硬门没有被宣称全部通过，阶段 3B 也仍未完成。

**2026-08-08 再次授权：** 用户再次明确要求跳过剩余验证、接受风险并执行下一步。本次 `accuracy-core` 重跑只取得 W1-A `ready`、`round=1`，在等待 B 时由用户 `Ctrl-C` 终止，验收进程残留为零。自动 rapid、父目录、特殊字符、Explorer 重启与新 generation、Shell/COM 停滞、HWND 复用完整矩阵，以及多屏相关项目仍为未验收；多屏继续按用户限定暂缓。该明确授权是阶段门例外，允许按原计划顺序进入 Task 1，但不修改本计划原始完成定义，不追认 Task 0 已满足全部技术门，也不代表跨屏支持。

---

## 1. 已确认的失败原因

原桥接只按 Explorer 外层 `CabinetWClass` HWND 过滤 `Shell.Application.Windows`。同一 Explorer 窗口的多个标签共享外层 HWND，因此可能同时得到多个路径，却无法证明哪个路径属于当前活动标签。

受限 UIA 先后尝试 RawView 逐节点读取、两阶段最小读取和分层 `CacheRequest`，三次均在批准的 100 毫秒边界内安全超时。不得继续扩大 UIA、放宽为标题猜测或保留两套发现逻辑。

新的技术假设来自成熟开源项目 ExplorerTabUtility：

```text
前台 CabinetWClass
  → 首个 ShellTabWindowClass 直接子窗口作为活动候选
  → Shell.Application.Windows 枚举标签对象
  → IServiceProvider.QueryService(IShellBrowser)
  → IShellBrowser.GetWindow 返回每个标签 HWND
  → 活动候选与标签 HWND 唯一匹配
  → 只读取唯一匹配对象的目录
```

`FindWindowEx` 按 Z-order 搜索直接子窗口是 Windows API 行为；“首个 `ShellTabWindowClass` 是活动标签”以及“ShellWindows 对象的 `IShellBrowser.GetWindow` 返回对应标签 HWND”都只是当前 Explorer 实现和第三方项目的实测假设，不是微软公开的标签兼容契约。两项必须在当前系统共同验证，未知构建或结构变化一律失败关闭。

---

## 2. 技术参考与许可证策略

**技术参考：**

- ExplorerTabUtility：https://github.com/w4po/ExplorerTabUtility
- 固定参考 commit：`fad736353210d36595c6e6caa77ac7ad9129b3ee`
- 参考文件：`ExplorerTabUtility/Hooks/ExplorerWatcher.cs`
- 上游许可证：MIT
- Microsoft `FindWindowEx`：https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-findwindowexw
- Microsoft `IShellBrowser::GetWindow` 继承契约：https://learn.microsoft.com/windows/win32/api/oleidl/nf-oleidl-iolewindow-getwindow
- Electron `BrowserWindow.moveAbove`：https://www.electronjs.org/docs/latest/api/browser-window/#winmoveabovemediasourceid
- Microsoft `SetWindowPos`：https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowpos

**实施约束：**

- 只借鉴“活动标签候选 HWND 与 `IShellBrowser.GetWindow` 唯一映射”的方法。
- COM GUID 和接口签名依据 Windows SDK 文档独立最小实现。
- 不复制上游的 Hook、键鼠消息、标签切换、导航、窗口恢复、注册表或设置功能。
- 实施审查必须记录实际参考的上游 commit。
- 若最终复制或实质改编任何上游代码，新增第三方声明，包含上游 MIT 全文、仓库、commit 和改编文件；不得杜撰上游许可证占位版权人。

---

## 3. 能力边界

### 3.1 固定允许

- `GetForegroundWindow`
- `FindWindowEx`
- `GetWindowThreadProcessId`
- `GetClassName`
- `IsWindow`
- `IsIconic`
- `GetWindowRect`
- `QueryFullProcessImageName`
- `GetProcessTimes` 或等价只读进程创建时间读取
- 固定 `Shell.Application.Windows`
- ShellWindows 对象的固定只读 `HWND` 属性
- 固定 `IServiceProvider.QueryService(IShellBrowser)`
- 固定 `IShellBrowser.GetWindow`
- 唯一映射后读取 `LocationURL`
- `LocationURL` 为空时读取 `Document.Folder.Self.Path`
- Electron `BrowserWindow.moveAbove`
- 仅在 Electron 路线失败时评估固定 User32 `GetWindow` 和 `SetWindowPos` 回退
- 仅在验收夹具内读取 Z-order 的固定 `GetWindow`，以及读取 `GWL_EXSTYLE` 的 `GetWindowLongPtr`（32 位进程使用等价 `GetWindowLong`）

验收读取 API 不进入生产 Explorer 观察接口，只能接收夹具在本进程创建的测试窗口 HWND 与已由固定 helper 确认的目标 Explorer HWND；不得接受 IPC、Renderer、配置文件或命令行传入的任意 HWND。

### 3.2 明确禁止

- UIA、`System.Windows.Automation`、FlaUI 或控件树遍历
- 截图、OCR、DesktopCapturer 缩略图或视觉猜测
- 窗口标题、标签名称、最近路径和 Shell 候选顺序猜测
- `SendMessage`、`PostMessage`、键盘或鼠标模拟
- 通用 WinEvent Hook、全桌面窗口控制或 Explorer 注入
- 任意 ProgID、CLSID、IID、COM 方法或调用方指定窗口类
- ShellWindows 对象除 `HWND`、唯一映射后的 `LocationURL` 和路径回退链以外的任意属性
- `setAlwaysOnTop(true)`、`HWND_TOPMOST` 或永久置顶回退
- ExecutionPolicy Bypass
- 读取目录条目、扩大 Agent 文件授权或把藏身目录设为文件工具根

### 3.3 对外事实最小化

- Renderer、Preload 和 Agent 不接收 Explorer HWND、标签 HWND、PID、创建时间、COM 对象或绝对路径。
- Main 只消费严格快照；标签 HWND 永不进入公开 DTO。
- stderr、普通日志、测试快照和验收文档不得记录用户绝对路径。
- `ambiguous`、`none` 和 `unavailable` 不携带候选列表或猜测路径。

---

## 4. 精确文件范围

### 4.1 计划阶段

- 新建：`docs/superpowers/plans/2026-08-07-ai-pet-shell-tab-window-task0-recovery.md`
- 修改：`docs/superpowers/plans/2026-08-07-ai-pet-directory-habitat-explorer-space.md`
- 修改：`docs/superpowers/specs/2026-08-07-ai-pet-restricted-explorer-uia-security-design.md`
- 修改：`docs/operations/explorer-shell-com-feasibility.md`

### 4.2 实施阶段

- 新建：`apps/desktop/resources/windows/explorer-space-shell-tab-helper.cs`
- 修改：`apps/desktop/resources/windows/explorer-space-bridge.ps1`
- 修改：`apps/desktop/src/main/habitat/explorer-space-protocol.ts`
- 修改：`apps/desktop/src/main/habitat/explorer-space-client.ts`
- 新建：`apps/desktop/src/main/habitat/explorer-window-layer-controller.ts`
- 修改：`apps/desktop/tests/explorer-space-protocol.test.ts`
- 修改：`apps/desktop/tests/explorer-space-client.test.ts`
- 新建：`apps/desktop/tests/explorer-space-shell-tab-helper.test.ts`
- 新建：`apps/desktop/tests/explorer-window-layer-controller.test.ts`
- 新建：`apps/desktop/tests/fixtures/explorer-space-shell-tab-self-test.ps1`
- 修改：`docs/operations/explorer-shell-com-feasibility.md`

### 4.3 Task 10 打包交接文件

- 修改：`apps/desktop/electron-builder.yml`
- 修改：`apps/desktop/tests/package-config.test.ts`
- 新建或修改：固定桥接资源完整性清单

Task 10 必须把 `explorer-space-bridge.ps1`、`explorer-space-shell-tab-helper.cs` 和二者的完整性清单一起放入固定 `extraResources` 目录。包配置测试必须证明安装包不从 userData、角色包、藏身目录或 Agent 授权目录加载桥接源码。

### 4.4 不得修改

- WebsiteExtension、网站、部署和下载链路
- Agent、文件工具和 Agent 授权根
- Renderer、Preload、MCP
- 阶段 3B Task 1 及后续业务功能

---

## 5. 进程、线程与协议设计

### 5.1 固定辅助实现

- 使用独立 C# 源文件，由固定 PowerShell 5.1 壳从 `$PSScriptRoot` 的固定文件名加载。
- PowerShell 不接受源码路径、ProgID、IID、窗口类或 COM 方法参数。
- C# 只公开固定无参数观察方法 `ObserveActiveExplorer()`。
- 不引入 .NET SDK、Vanara、FlaUI 或其他运行时依赖。

为避免只用源码正则冒充行为测试，C# 决策核必须拆成“固定系统适配器 + 纯决策核心”。测试夹具 `apps/desktop/tests/fixtures/explorer-space-shell-tab-self-test.ps1` 为必需文件，通过 `SHELL_TAB_HELPER_TEST` 条件编译加入固定测试入口；生产编译不定义该符号，因此不暴露注入事实、任意 HWND 或任意 COM 调用入口。Vitest 只传计划内固定 fixture 名称并断言结构化结果，不能传源码、方法名、ProgID 或真实路径。

### 5.2 STA COM 约束

- `Shell.Application`、ShellWindows、标签 COM 对象、`IServiceProvider` 和 `IShellBrowser` 必须在同一显式 STA 创建、使用和释放。
- RCW 不得跨线程。
- `QueryService` 和 `GetWindow` 必须检查 HRESULT。
- COM 拒绝调用只允许有限次数、有限总时长重试。
- COM 卡死由 Main 的桥接请求超时和 owned-child 清理兜底；不得依赖线程取消。

### 5.3 复用严格协议

- 复用版本化 JSONL、nonce、requestId、递增 sequence、16 KiB 行限制和稳定 stderr 诊断码。
- 输入队列容量保持 8；不透明实例缓存上限保持 64。
- 桥接失败或关闭必须等待自己持有的 child 真正退出。
- 不按进程名或外部 PID 查杀。
- `place-near/remove-layer` 在层级路线完成实机决策前暂时保留，不能提前删除安全回退。

### 5.4 构建 profile

- profile 固定保存在 `explorer-space-shell-tab-helper.cs` 的只读常量表，不写入 userData 或可修改配置。
- profile 身份至少包含 OS major/minor/build、`explorer.exe` 文件版本和 Shell 标签映射版本。
- 当前首个候选仅精确匹配 Windows 11 OS Build `26200` 与 Explorer 文件版本 `10.0.26100.8875`，并按“候选验证态 → Task 0E 真实矩阵 → Task 0F 生产已验证态”提升。
- 候选验证态是编译在 helper 内的只读状态，只能由固定 Task 0E 验收入口启用；不得从配置、IPC、Renderer、命令行或 userData 开启，也不得进入正式生产组合或返回 `ready`。它只输出脱敏的状态、匹配计数、切换轮次和稳定错误码，不输出 HWND、路径或 COM 对象。
- Task 0E 全部通过后，Task 0F 才能把同一精确身份常量提升为生产已验证 profile；提升必须产生代码差异并重新通过最终总门。
- 任一字段不匹配返回 `unavailable`；不得自动学习、模糊匹配或沿用旧 profile。

---

## 6. 活动标签严格决策

每轮观察必须按以下顺序完成：

1. 前采样外层 HWND、Explorer PID、进程创建时间、窗口类、最小化状态和前台状态。
2. 验证进程映像精确等于 `%WINDIR%\explorer.exe`。
3. 枚举外层窗口的全部直接 `ShellTabWindowClass` 子窗口。
4. 将 Z-order 首个子窗口仅标记为活动候选，不提前返回路径。
5. 枚举 ShellWindows 中外层 HWND 等于当前 Explorer 的对象。
6. 对每个对象只调用固定 `QueryService(IShellBrowser)` 和 `GetWindow`。
7. 只保留标签 HWND 等于活动候选的对象。
8. 必须恰好一个匹配；零个、多个、重复 HWND 或任何 COM 异常均失败关闭。
9. 只有唯一匹配后才读取路径。
10. 路径读取后重新采样外层 HWND、PID、进程创建时间、活动候选 HWND、前台和最小化状态。
11. 前后两次完全一致，且唯一映射仍成立，才返回 `ready`。

### 6.1 状态语义

- `none`：前台明确不是 Explorer、Explorer 已最小化或关闭、或者明确是搜索结果。
- `ambiguous`：前台是 Explorer，但活动候选或唯一映射无法证明，或者观察期间发生切换。
- `unavailable`：Shell/COM、协议、固定辅助文件或安全验证组件不可用。
- `ready`：身份、唯一映射、路径和前后竞态复核全部通过。

### 6.2 世代与 HWND 复用

实例身份至少绑定：

```text
bridge generation
+ explorer PID
+ explorer process creation time
+ outer HWND
+ tab HWND
```

- HWND 不得作为长期身份。
- Explorer PID、创建时间、外层 HWND 或桥接 generation 变化时立即清空 COM、标签和路径缓存。
- 旧 snapshot、旧 response、旧 instanceId 和旧 HWND 不得跨世代恢复显示。
- Explorer 重启后必须重新创建 Shell.Application 和 ShellWindows；重建前保持隐藏。

### 6.3 路径语义

- `LocationURL` 非空时只接受严格 `file:` URI，并按 URI 规则解码一次。
- 禁止把 `+` 当空格。
- 覆盖 `%23`、`%25`、中文、空格和非 BMP 字符。
- `LocationURL` 为空时，`Folder.Self.Path` 只接受已根化普通文件系统路径。
- 拒绝 `search-ms:`、`shell:`、GUID namespace、主页、此电脑、快速访问、回收站和其他虚拟目录。
- UNC、网络盘、可移动盘和云占位目录在 Habitat 授权策略明确支持前全部拒绝。
- 后续 HabitatService 仍需使用 `stat/realpath` 与已授权目录身份交叉验证，不能只信任 COM 字符串。

---

## 7. 严格 TDD 实施任务

### Task 0A：建立活动标签决策 RED

**文件：**

- 新建：`apps/desktop/tests/explorer-space-shell-tab-helper.test.ts`
- 修改：`apps/desktop/tests/explorer-space-protocol.test.ts`

**RED 必须覆盖：**

- 同一外层 HWND 下标签 A、B，活动候选 A 只能选择 A。
- 活动候选 B 只能选择 B。
- A → B → A 每轮结果正确，不重放旧路径。
- 零匹配、多匹配、重复标签 HWND 返回 `ambiguous`。
- 唯一映射前不得调用路径 getter。
- 读取路径前后活动候选、外层 HWND、PID、创建时间或前台发生变化时返回 `ambiguous`。
- 非 Explorer 和最小化返回 `none`。
- 搜索结果返回 `none`，且不使用标题判断。
- COM 初始化、QueryService、GetWindow 或固定文件错误返回 `unavailable`。
- 输出不包含标签 HWND、候选列表、标题和未匹配路径。

运行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explorer-space-shell-tab-helper.test.ts tests/explorer-space-protocol.test.ts
```

预期：因新 helper 和决策模块不存在而失败。

### Task 0B：实现固定 C# Shell 标签 Helper

**文件：**

- 新建：`apps/desktop/resources/windows/explorer-space-shell-tab-helper.cs`
- 修改：`apps/desktop/resources/windows/explorer-space-bridge.ps1`

**GREEN：**

- 按第 6 节顺序实现身份验证、候选枚举、唯一映射、路径读取和双采样。
- 固定 C# 文件只包含白名单接口和观察逻辑。
- PowerShell 只负责固定加载、JSONL 和生命周期，不重新实现标签判断。
- 所有 COM 引用在成功和异常路径中有界释放。
- 未知 Windows/Explorer 构建返回 `unavailable`；唯一的精确候选构建仅能通过固定验收入口进入候选验证态，不能以生产 `ready` 运行。
- 必需 self-test 夹具必须实际编译同一 C# 源文件的测试条件分支，并对 A → B → A、零匹配、多匹配、双采样竞态和路径 getter 延迟调用执行行为断言；源码字符串扫描只能作为补充安全门。

### Task 0C：修复桥接与客户端生命周期

**文件：**

- 修改：`apps/desktop/src/main/habitat/explorer-space-protocol.ts`
- 修改：`apps/desktop/src/main/habitat/explorer-space-client.ts`
- 修改：`apps/desktop/tests/explorer-space-client.test.ts`

**GREEN：**

- Shell/COM 不可用不能降格成 `none`。
- hello、观察和请求超时后只终止 owned child，并等待真实 exit。
- kill 拒绝、延迟退出和退出超时不能伪报 `closed`。
- Explorer 重启建立新 generation，旧序号和旧实例全部失效。
- PowerShell 参数仍为数组，不增加 ExecutionPolicy 或 Bypass。

### Task 0D：比较 Electron 与 User32 层级路线

**文件：**

- 新建：`apps/desktop/src/main/habitat/explorer-window-layer-controller.ts`
- 新建：`apps/desktop/tests/explorer-window-layer-controller.test.ts`

先使用不含真实桌宠数据的测试 BrowserWindow，比较：

1. Electron `petWindow.moveAbove("window:<validated-hwnd>:0")`。
2. 当前固定 User32 `place-near/remove-layer`。

`mediaSourceId` 只能由已验证 HWND 的规范十进制字符串构造，不接受调用方传入任意字符串，不把 HWND 转为 JS `number`。不得使用 DesktopCapturer 缩略图或标题匹配。

两条路线使用同一硬门：

- 测试窗口位于 Explorer 上方。
- 操作前后 `GetForegroundWindow()` 仍是 Explorer。
- Electron `isAlwaysOnTop()` 始终为 false。
- 原生扩展样式不包含 `WS_EX_TOPMOST`。
- Codex、记事本或其他普通窗口成为前台后覆盖测试窗口。
- Explorer 失焦、最小化、关闭、标签竞态或 HWND 失效时，测试窗口不迟于 1,000 毫秒隐藏。
- 恢复 Explorer 后可重新建立层级。
- 退出目录空间后恢复普通窗口行为。

**决策：**

- `moveAbove` 通过完整实机门后，删除 `place-near/remove-layer` 协议和固定 SetWindowPos 层级代码。
- `moveAbove` 失败，但固定 User32 通过同一非 topmost 门时，只保留固定 User32 回退。
- 两条路线都失败时 Task 0 继续 blocked。
- 不允许改成永久置顶。

### Task 0E：预切换自动门与真实技术门

先运行四份专项测试、Desktop 类型检查和 `git diff --check`，随后用固定验收入口让精确匹配的候选 profile 完整执行第 8 节真实矩阵。此阶段允许旧 UIA 实验代码仍存在；验收进程只能运行新 helper 的候选验证态，正式生产组合仍不得把候选报告为 `ready`，专项测试必须证明生产组合不会实例化旧观察器。

只有以下项目全部通过，才允许切换：

- A → B → A、快速切换、多窗口和 Explorer 重启。
- Shell 标签候选与 `IShellBrowser.GetWindow` 唯一映射。
- 至少一种动态层级路线通过非 topmost 实机门。
- 客户端生命周期和进程清理通过。
- 独立预审无 P0/P1。

### Task 0F：受控切换、旧代码删除与最终总门

预切换技术门通过后：

1. 把已经通过 Task 0E 的同一精确候选常量提升为生产已验证 profile；不得扩大 build 或文件版本范围。
2. 删除 `System.Windows.Automation`、`RestrictedExplorerObserver`、UIA profile、结构指纹和 CacheRequest 遗留。
3. 删除原外层 HWND 候选归因代码。
4. 根据 Task 0D 结论删除未被选择的层级路线及其协议命令和测试。
5. 更新生产组合只实例化新 helper，并删除或编译排除候选验收入口。
6. 再运行最终源码安全门、Desktop 全套、真实关键矩阵复核和独立终审。

运行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explorer-space-protocol.test.ts tests/explorer-space-client.test.ts tests/explorer-space-shell-tab-helper.test.ts tests/explorer-window-layer-controller.test.ts
pnpm.cmd --filter @myself/desktop test
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

源码边界测试拒绝：

```text
System.Windows.Automation
UIAutomation
FlaUI
SendMessage
PostMessage
mouse_event
keybd_event
GetWindowText
Capture
Screenshot
setAlwaysOnTop(true)
HWND_TOPMOST
-ExecutionPolicy
Bypass
```

---

## 8. 当前 Windows 真实验收矩阵

自动测试不得替代真实 Explorer 观察。

### 8.1 标签准确性

- 单窗口单标签。
- 同一窗口双标签 A → B → A。
- 同一窗口三个标签及快速切换。
- 相同目录的两个标签，活动标签身份仍须变化且不得串代。
- 两个 Explorer 窗口前台来回切换。
- 地址栏进入父目录。
- 观察期间快速切换：只能返回正确结果或 `ambiguous`，绝不允许旧路径 `ready`。
- 搜索结果和全部虚拟目录保持隐藏。
- 最小化、恢复和关闭。
- Explorer 完整重启并建立新世代。
- 路径包含空格、中文、`#`、`%` 和非 BMP 字符。
- 零匹配、多匹配、重复 COM 映射和 HWND 复用全部失败关闭。

Explorer 重启会明显影响桌面，执行到该步骤时先告知用户并由用户配合，不由测试脚本静默执行。

### 8.2 动态层级

- Explorer 前台时测试窗口显示在其上。
- 测试窗口不获得键盘焦点。
- 切换 Codex、记事本或其他普通应用后，该应用覆盖测试窗口。
- Explorer 失焦、最小化、关闭和重启时测试窗口隐藏。
- 恢复后重新建立层级。
- 退出目录空间后恢复普通桌面显示。
- 使用独立 `GetWindow` Z-order、焦点和扩展样式读取，与人工视觉共同确认。
- 从 Explorer 失去前台到桌宠隐藏的最大暴露时间为 1,000 毫秒；自动测试和真实计时均不得超过此值。

### 8.3 多显示器与 DPI

- 单显示器 100%。
- 负坐标副屏。
- 100%/125%/150% 混合缩放。
- Explorer 跨屏移动和最大化。
- Win32 物理 RECT 转 Electron DIP 时必须使用明确显示器上下文，不允许直接混用坐标。
- 当前硬件无法提供双显示器或混合 DPI 时必须记录为 `blocked`，不能用单元测试代替并宣称跨屏支持。

### 8.4 生命周期

- Shell/COM 拒绝调用、卡顿和重建。
- 桥接超时、协议失败、应用退出和 Electron 窗口销毁。
- 所有场景无残留桥接进程、无旧 generation 事件和无路径日志泄露。
- 当前 ExecutionPolicy 允许固定脚本时验证正常启动；企业策略阻止时只返回稳定 `unavailable`、不添加 Bypass 且不残留进程。无法修改企业策略时如实记录未执行项，不伪造策略覆盖。

---

## 9. 旧实验删除时机

不得在新路线证明可行前删除旧实验，因为需要保留可复核对照；但新路线通过后不得让两套生产逻辑并存。

只有 Task 0E 预切换技术门同时满足以下条件，才进入 Task 0F 删除旧 UIA 和失败实现：

1. 新 helper 自动测试通过。
2. 真实双标签 A → B → A 通过。
3. 快速切换竞态和 Explorer 重启通过。
4. 至少一种层级路线通过非 topmost 实机门。
5. 独立预审无 P0/P1。

届时删除：

- `System.Windows.Automation` 引用。
- `RestrictedExplorerObserver`、UIA profile、结构指纹和 CacheRequest 遗留。
- 被替代的外层 HWND 候选归因代码。
- 未被选中的层级路线、命令和测试。

必须保留：

- `docs/operations/explorer-shell-com-feasibility.md` 中原外层 HWND 失败证据。
- UIA 三次超时记录。
- 受限 UIA 设计文档，并标记为历史失败方案。

若新路线失败，只清理本轮新增实验，不伪造通过记录，不进入 Task 1。

---

## 10. 子智能体执行顺序与超时

同一核心文件不得并行编辑：

1. 子智能体 A：Task 0A RED 与安全边界测试。
2. 子智能体 B：Task 0B 固定 C# helper 和 PowerShell 最小 GREEN。
3. 子智能体 C：Task 0C 客户端生命周期与世代。
4. 子智能体 D：Task 0D Electron/User32 层级夹具。
5. 子智能体 E：Task 0E 真实人工矩阵和预审。
6. 子智能体 F：Task 0F 受控切换与旧代码删除。
7. 独立子智能体：最终源码门和只读终审。

每个点：

- 10 分钟报告证据。
- 20 分钟无新增证据时缩小夹具或切换实现。
- 30 分钟硬停止并记录 blocked。
- 不因超时跳过 RED、唯一映射、双采样、非 topmost 或进程回收门。
- 长时间构建和人工观察可以后台运行，但每 60 秒检查输出与残留进程。

Task 0 未通过时不得开始 Task 1。

---

## 11. 建议提交点

不得提交 RED 失败状态；每个提交前运行对应 GREEN 测试。

```text
feat: 精确映射资源管理器活动标签
feat: 建立资源管理器动态相邻层级
test: 验证资源管理器标签与层级技术门
docs: 记录资源管理器标签技术门结果
```

若 Task 0 最终仍 blocked，只提交经用户认可的失败记录和安全设计，不提交不可用生产实现。

---

## 12. 完成定义

- 当前 Windows 上活动标签候选与一个且仅一个 Shell/COM 对象准确映射。
- A → B → A、快速切换、多窗口、Explorer 重启和特殊字符均有真实证据。
- 未知结构、竞态、搜索、虚拟目录和 COM 异常全部失败关闭。
- 桌宠测试窗口位于目标 Explorer 上方，但其他普通前台应用可以覆盖它。
- 窗口从未成为 topmost，也不抢焦点。
- Explorer 失焦、最小化、关闭、重启或句柄失效时，桌宠不迟于 1,000 毫秒隐藏。
- 桥接严格 STA、协议有界、退出后无残留进程。
- 不包含 UIA、截图、键鼠、标题猜测、通用 COM 或桌面捕获能力。
- 旧失败生产逻辑已删除，历史失败记录保留。
- WebsiteExtension、网站、Agent 授权、文件工具、Renderer、Preload 和 MCP 未修改。
- 专项测试、Desktop 全套、类型检查和 `git diff --check` 全部通过。
- 独立审查无 P0/P1。
- 完成后更新阶段 3B 原计划状态，才允许进入 Task 1。
