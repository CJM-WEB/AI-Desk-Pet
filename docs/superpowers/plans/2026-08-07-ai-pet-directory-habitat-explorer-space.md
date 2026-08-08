# AI 桌宠阶段 3B：目录藏身与资源管理器空间实施计划

> 供智能执行代理使用：实施时采用子智能体逐任务执行；每个任务依次完成测试设计、最小实现、规格审查和代码质量审查后才能进入下一任务。

**目标：** 在不扩大 Agent 文件权限、不向资源管理器注入代码、不使用持续截图的前提下，让桌宠进入用户明确配置的目录空间；只有当前台资源管理器准确打开同一目录时才出现，并提供动态窗口层级、托盘呼唤、召回桌面和迷路恢复。

**基线：** AgentCoreExtension 分支，阶段 3A 自动门禁与 Windows 人工验收均已通过；阶段 3A 最终提交为 3de2275，回收站安全闭环提交为 d22f7ca，动作事务接线提交为 f564eb7。

**设计依据：**

- ../specs/2026-08-01-ai-pet-reference-architecture-evolution-design.md
- ./2026-08-01-ai-pet-autonomous-companion-roadmap.md
- ./2026-08-07-ai-pet-file-entity-recycle-bin-transport.md
- ../specs/2026-07-27-explorer-pet-space-design.md
- ./2026-07-27-explorer-pet-space.md

**替代关系：** 2026-07-27 的资源管理器计划保留为历史设计输入，但不再作为当前分支的直接执行清单。阶段 3B 当前采用受限 Shell 标签 HWND 唯一映射观察与 Electron `moveAbove` 层级控制；受限 UIA 已在 Task 0 实机证明不可行，不开放通用 UIA、截图、视觉定位或任意桌面执行器。

**2026-08-08 状态同步：** 用户接受 Task 0E 剩余人工未验收风险后，Task 0F 已完成精确 profile、新 helper 唯一生产观察、Electron-only 层级控制和无事实观察心跳的技术切换，旧 UIA 观察与 User32 层级路线已删除，并通过自动总门。桥接与 helper 运行源文件已经准备，但 `extraResources`、完整性清单和正式生产组合仍归 Task 10。该状态不追认 Task 0E 未完成的 rapid、父目录、特殊字符、Explorer 重启/新 generation、完整失败矩阵或多屏/DPI 项；当前机器虽有双显示器，本轮仅按用户限定的单屏范围验收。Main、正式桌宠窗口、Renderer 和 Preload 尚未接入，当前 `alwaysOnTop` 行为保持不变，仍须按 Task 6 和 Task 10 完成正式组合。因此阶段 3B 尚未完成，Task 1 及后续业务范围没有因本次技术切换自动解锁。

**2026-08-08 阶段门例外：** 用户再次明确要求跳过剩余验证、接受风险并执行下一步。本次 `accuracy-core` 重跑仅取得 W1-A `ready`、`round=1`，等待 B 时由用户 `Ctrl-C` 终止，进程残留为零。自动 rapid、父目录、特殊字符、Explorer 重启与新 generation、Shell/COM 停滞、HWND 复用完整矩阵和多屏相关项目仍为未验收，多屏继续按用户限定暂缓。该显式授权允许从现在起按计划顺序进入 Task 1，但不修改下文 Task 0 原始完成定义，不追认其全部技术门已经满足，也不代表跨屏支持；阶段 3B 仍未完成。

---

## 0. 已锁定的产品行为

### 0.1 空间状态

桌宠只有一个真实实例，空间状态固定为：

1. desktop：桌面空间，使用已保存的屏幕坐标。
2. folder-hidden：已进入某个配置目录，但目标资源管理器当前未被准确发现，窗口真正隐藏。
3. folder-visible：前台资源管理器准确打开同一目录，桌宠在该窗口附近的安全区域出现。
4. folder-lost：原目录不可访问或身份不再可信，窗口隐藏，只允许重新验证或召回桌面。

entering、revealing 和 recalling 只作为 Main 内存中的过渡状态；重启后必须从持久化稳定状态恢复，不能恢复半完成窗口操作。

### 0.2 进入、找到与离开

- 用户可在设置中明确添加多个可藏身目录，并逐项启用或停用。
- 用户可从托盘手动选择“藏到此目录”。
- 自动藏身默认关闭；只有用户显式开启、主动性模式为 autonomous、桌宠持续空闲且不存在阻塞条件时才允许本地调度。
- 进入目录后不打开目录、不读取目录内容、不写隐藏文件、标记、快捷方式或元数据。
- 只有前台 Windows 文件资源管理器准确显示同一目录时才判定“被找到”。
- 上级目录、搜索结果、相同名称、悬停图标、后台窗口、其他应用打开同一路径均不算找到。
- 资源管理器失焦、最小化、关闭、切换标签或切换目录后，桌宠重新隐藏。
- 同一路径存在多个候选窗口时只绑定最近的前台实例，不产生分身。

### 0.3 呼唤、召回和迷路

- “呼唤桌宠”在桌面状态只显示并聚焦桌宠；在目录状态使用 Electron shell.openPath 打开已保存目录，等待准确观察后再显示。
- “召回桌面”不依赖目录仍可访问，始终清除目录绑定状态并恢复进入前桌面坐标或当前主屏安全坐标。
- 目录同卷重命名或移动后，只能在用户实际打开新位置且文件身份匹配时更新路径提示；禁止扫描磁盘寻找。
- 目录删除、磁盘断开、权限拒绝、身份冲突或桥接层不可用时进入 folder-lost，不猜测替代目录。

### 0.4 动画与系统事实

- 角色表现增加 hide 和 emerge 两个标准动作语义，以及对应可信本地信号。
- 角色缺少新动作时，hide 受控回退到 move，emerge 受控回退到 idle；V1 角色仍可使用。
- 动画只负责表现，不授予目录权限，也不能伪造“已经藏身”或“已经找到”。
- 持久化目录位置、窗口隐藏/显示和桥接观察结果才是系统事实。
- hide 动画失败或超时不得让窗口停在半隐藏状态；emerge 动画失败不得改变已经准确找到目录的事实。

### 0.5 权限隔离

- 可藏身目录授权与 Agent 文件授权根完全独立。
- 添加可藏身目录不会改变 PathPolicy、FileToolService、Agent 工具集合或文件披露设置。
- Agent、Renderer、角色包和模型均拿不到可藏身目录绝对路径、Explorer HWND、桌宠 HWND、桥接协议或持久化私有身份。
- 角色包只能定义 hide/emerge 表现和回退，不得声明目录、授权、窗口命令、Shell、COM、UIA 或 MCP 能力。

---

## 1. 当前基线与复用点

### 1.1 直接复用

- apps/desktop/src/main/characters/character-behavior-service.ts：Main 行为权威、播放令牌和真实反馈。
- apps/desktop/src/main/characters/character-motion-service.ts：窗口坐标、自动运动、拖拽接管和运动快照。
- apps/desktop/src/main/windows/pet-window-interaction-controller.ts：用户拖拽与鼠标穿透生命周期。
- apps/desktop/src/main/windows/pet-position.ts：桌面坐标恢复、去抖保存和退出刷新。
- apps/desktop/src/main/windows/window-manager.ts：安全 BrowserWindow 配置和屏幕边界计算。
- apps/desktop/src/main/windows/window-commands.ts：聊天、工作室和窗口命令组合根。
- apps/desktop/src/main/storage/settings-store.ts：现有模型、隐私、授权根和桌面坐标；不把目录空间私有状态混入 Agent 授权根。
- apps/desktop/src/main/index.ts：Tray、shell、screen、窗口生命周期和服务组合根。
- apps/desktop/src/shared/myself-api.ts、ipc-channels.ts 与 preload/index.ts：最小白名单 IPC。
- tests/fixtures/electron-app.ts 与 apps/desktop/src/main/e2e-boundary.ts：隔离 E2E 边界和生产探针保护。

### 1.2 必须先消除的冲突

- 当前桌宠窗口创建时 alwaysOnTop=true，阶段 3B 必须改为默认非永久置顶。
- 当前 CharacterMotionService 永远按显示器 workArea 运动，隐藏和资源管理器关联期间需要可暂停、可切换运动区域。
- 当前 PetPositionController 会保存所有 move 事件，资源管理器附近位置不得覆盖桌面坐标。
- 当前设置中没有独立目录空间配置，不能复用 authorizedRoot 冒充藏身授权。
- 当前角色 V2 没有 hide/emerge 语义或 habitat 信号。
- 当前没有 Windows Explorer 观察适配器，也没有打包资源和子进程生命周期。

---

## 2. Windows 桥接技术决策

### 2.1 采用方案

使用固定资源脚本 apps/desktop/resources/windows/explorer-space-bridge.ps1，由 Electron Main 以系统 Windows PowerShell 5.1 启动：

- 可执行文件固定为 System32 下的 powershell.exe，不接受设置、模型、角色包或 Renderer 提供的命令路径。
- 参数固定为 NoLogo、NoProfile、NonInteractive 和 File；不覆盖企业 ExecutionPolicy。
- 脚本路径只能来自开发资源目录或打包后的 process.resourcesPath。
- 子进程使用最小环境，不继承 API Key、代理密钥、授权根、MCP 环境或任意用户变量。
- Main 与桥接层只通过有版本、严格 Schema 的 JSON Lines 协议通信。

桥接层只允许以下固定能力：

1. 加载固定 Shell 标签 helper，以活动 `ShellTabWindowClass` HWND 和 `IShellBrowser.GetWindow` 的唯一映射观察前台 Explorer 活动目录。
2. 输出递增序号、Explorer HWND、不透明实例 ID、规范化候选路径和窗口矩形；稳定快照去重期间只输出不含路径、HWND、实例、矩形或状态事实的观察心跳。
3. 只接收 `start-observing`、`stop-observing` 和 `shutdown` 三类固定命令。

桥接层不接收宠物 HWND，也不执行窗口层级操作。层级只由 Electron Main 内的 `ExplorerWindowLayerController` 调用 `BrowserWindow.moveAbove` 完成。

禁止提供任意 PowerShell、任意 COM ProgID、任意窗口消息、鼠标键盘、截图、文件枚举或进程启动能力。

### 2.2 观察频率与生命周期

- 仅在 folder-hidden、folder-visible、folder-lost 或等待呼唤绑定期间运行桥接层。
- desktop 状态关闭桥接层，不保留后台观察进程。
- 桥接层最多每 750ms 查询一次活动 Explorer；相同事实不重复发送，观察期间按固定有界间隔发送无事实心跳。
- Main 对每行限制 16 KiB，对请求和事件设置 5 秒超时，对重启采用 1s、5s、30s 退避，五分钟内最多重启三次。
- Explorer 观察退出、协议错误、超时或输出超限时，Main 立即隐藏目录空间桌宠并进入失联或降级状态，不影响聊天、Agent 和托盘召回。

### 2.3 准确性失败门

Shell/COM 在 Windows 版本和 Explorer 多标签实现上可能存在差异，因此 Task 0 是强制技术门：

- 必须在当前 Windows 环境证明单窗口、多窗口、多标签、地址栏切换、最小化和 Explorer 重启的准确路径。
- 同一 HWND 下无法区分活动标签时必须返回 ambiguous，Main 保持隐藏。
- 不得用窗口标题、文件夹名称、最近路径、搜索结果或时间猜测当前目录。
- 不得为了通过此门直接改用通用 UIA 或截图。原外层 HWND Shell/COM 和后续受限 UIA 已完成失败记录；当前只允许按恢复计划验证 Shell 标签 HWND 唯一映射，失败时继续 blocked，不得再扩大 UIA。

---

## 3. 持久化与公开契约

### 3.1 私有 HabitatStore

新建独立 habitat.json，不升级或复用 Agent 授权根。建议严格结构：

    version: 1
    preferences:
      autoHideEnabled: boolean
      idleDelayMs: number
    directories:
      id: safe identifier
      displayName: bounded text
      pathHint: bounded text
      absolutePath: Main private absolute path
      identity:
        dev: finite integer
        ino: finite integer
      enabled: boolean
    location:
      desktop:
        position: x/y or null
      folder:
        directoryId
        enteredAt
        previousDesktopPosition
        localOffset

稳定文件只保存 desktop 或 folder，不保存 Explorer HWND、当前窗口矩形、前台应用、播放令牌、桥接序号或过渡状态。

### 3.2 Renderer DTO

Renderer 只能读取：

- enabled、autoHideEnabled 和 idleDelayMs。
- 目录 id、displayName、pathHint、enabled、availability。
- 当前空间 kind、目录 id、状态 hidden/visible/lost。
- 用户可执行命令的可用性和稳定错误码。

Renderer 不接收 absolutePath、dev、ino、Explorer HWND、宠物 HWND、桥接消息、进入前绝对坐标或其他目录候选。

### 3.3 目录选择策略

目录只能由 Main 的 dialog.showOpenDialog 结果创建：

- 必须是现存目录。
- realpath、lstat 和 stat 前后复核身份。
- 拒绝符号链接、Junction、文件系统根、用户配置目录根、Windows、Program Files、ProgramData、Temp、AppData、应用 userData、角色存储和回收站系统目录。
- 第一版只支持本地固定磁盘上的普通目录；UNC、网络盘、可移动盘和云占位目录返回明确的暂不支持错误。
- 不读取目录条目，不要求该目录位于 Agent 授权根内。
- 删除配置只删除 HabitatStore 记录，不删除、重命名或写入目标目录。

---

## 4. 实施任务

### Task 0：建立 Shell 标签准确观察与 Electron 层级技术门

> **2026-08-07 恢复说明：** 本 Task 的外层 HWND Shell/COM 归因和后续受限 UIA 路线已取得真实失败证据。当前执行清单由 `2026-08-07-ai-pet-shell-tab-window-task0-recovery.md` 替代；新路线使用 `ShellTabWindowClass` 活动候选与 `IShellBrowser.GetWindow` 唯一映射。层级路线比较已经收敛为 Electron `moveAbove`，生产不保留另一套层级实现。恢复计划通过前不得执行 Task 1。

**文件：**

- 新建：apps/desktop/resources/windows/explorer-space-bridge.ps1
- 新建：apps/desktop/src/main/habitat/explorer-space-protocol.ts
- 新建：apps/desktop/src/main/habitat/explorer-space-client.ts
- 新建：apps/desktop/tests/explorer-space-protocol.test.ts
- 新建：apps/desktop/tests/explorer-space-client.test.ts
- 新建：docs/operations/explorer-shell-com-feasibility.md

**步骤 1：先写协议 RED**

覆盖：

- hello 协议版本、进程 nonce、请求 ID和递增事件序号。
- 严格拒绝未知字段、超长行、重复序号、过期响应、错误矩形、空路径和非 Explorer 类型。
- `start-observing`、`stop-observing`、`shutdown` 之外的命令全部拒绝；观察心跳只允许固定协议身份字段。
- stderr 只允许稳定诊断码，不得输出路径、命令正文或环境。

运行：

    pnpm.cmd --filter @myself/desktop test -- explorer-space-protocol.test.ts explorer-space-client.test.ts

预期：新测试因协议和客户端不存在而失败。

**步骤 2：实现最小固定桥接**

- 脚本只加载固定 Shell 标签 helper 和有界输入队列，不内联另一套 Explorer 归因或窗口层级实现。
- Main 使用 spawn 的参数数组，不拼接命令字符串。
- 环境从显式允许名单构造，stdio 固定为 pipe，窗口隐藏。
- Main 在收到 hello 并验证版本前不发送观察命令。
- 客户端关闭必须等待进程退出；超时后只终止该已验证 PID。

**步骤 3：完成真实准确性验证**

至少记录：

- 单 Explorer 窗口准确目录。
- 两个 Explorer 窗口前台切换。
- 同一窗口两个标签页来回切换。
- 地址栏进入上级目录和搜索结果。
- 最小化、关闭和 Explorer 重启。
- 路径包含空格、中文、#、% 和非 BMP 字符。
- 在不使用真实桌宠数据的测试窗口上验证 `ExplorerWindowLayerController.moveAbove`：测试窗口只位于目标 Explorer 相邻层级，切换到其他应用时先隐藏并 `invalidate`，不会继续覆盖该应用。
- 验证默认企业 ExecutionPolicy 允许固定资源脚本运行；若被系统策略阻止，客户端只返回稳定不可用错误并确保没有残留进程，不得自动加入 Bypass。

若任一多标签场景只能猜测，桥接必须输出 ambiguous；若 Electron 层级控制器不能证明“非全局置顶”，也必须失败。任一技术门失败时停止后续任务并把计划状态标记为 blocked，不得放宽为标题匹配、永久置顶或执行策略绕过。

**步骤 4：验证并提交**

    pnpm.cmd --filter @myself/desktop test -- explorer-space-protocol.test.ts explorer-space-client.test.ts
    pnpm.cmd --filter @myself/desktop typecheck

建议提交：

    feat: 建立资源管理器准确发现桥接门

---

### Task 1：扩展目录空间行为语义但不授予能力

**文件：**

- 修改：packages/character-runtime/src/character-v2-schema.ts
- 修改：packages/character-runtime/src/behavior-contracts.ts
- 修改：packages/character-runtime/src/behavior-state-inference.ts
- 修改：packages/character-runtime/src/character-v1-converter.ts
- 修改：apps/desktop/src/main/characters/official-default-character.ts
- 修改：apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx
- 修改测试：packages/character-runtime/tests/character-v2-schema.test.ts
- 修改测试：packages/character-runtime/tests/character-v1-converter.test.ts
- 修改测试：packages/character-runtime/tests/behavior-state-inference.test.ts
- 修改测试：apps/desktop/tests/character-action-editor.test.tsx

**契约：**

- 标准动作语义增加 hide 和 emerge。
- 可信信号增加 habitat-enter、habitat-found、habitat-hidden 和 habitat-lost。
- hide 默认表现回退为 move；emerge 默认表现回退为 idle。
- V1 转换不伪造目录能力，只生成受控表现回退。
- capabilityRef 仍然不接受任何值。

**RED：**

- 角色包可以声明 hide/emerge 表现，但未知系统能力字段仍严格拒绝。
- 行为引擎只接受 Main 本地 habitat 信号，Agent 意图不能直接进入系统保留的目录过渡。
- 旧 V2、V1、缺少新动作的角色继续解析和播放。
- 角色工作室只编辑语义和素材，不出现路径、权限或系统命令字段。

运行：

    pnpm.cmd --filter @myself/character-runtime test
    pnpm.cmd --filter @myself/desktop test -- character-action-editor.test.tsx
    pnpm.cmd --filter @myself/character-runtime typecheck

建议提交：

    feat: 增加目录藏身表现语义

---

### Task 2：实现独立 HabitatStore 与目录选择策略

**文件：**

- 新建：apps/desktop/src/main/habitat/pet-habitat-store.ts
- 新建：apps/desktop/src/main/habitat/habitat-directory-policy.ts
- 新建：apps/desktop/tests/pet-habitat-store.test.ts
- 新建：apps/desktop/tests/habitat-directory-policy.test.ts

**RED：**

- 缺失文件使用安全默认值；损坏文件隔离，不扫描或删除目标目录。
- 原子写失败保留上一版本；并发写按调用顺序提交。
- 重启恢复 folder 状态、进入前桌面坐标和目录身份。
- Renderer 投影不含绝对路径、dev、ino 或其他配置目录。
- 目录被替换、变成链接、身份冲突、删除或权限拒绝时不能继续信任。
- 相同真实目录不能重复添加，名称前缀碰撞不视为同目录。
- 清除本地数据只清除 HabitatStore，不触碰配置目标。

**最小实现：**

- 复用现有安全标识和原子写模式，不建立新的通用文件框架。
- 保存前后复核 HabitatStore 自身父目录身份。
- 目标目录只做 realpath/lstat/stat 和身份比较，不读取 readdir。
- pathHint 只保留末级目录显示名，不生成可逆的完整路径。

运行：

    pnpm.cmd --filter @myself/desktop test -- pet-habitat-store.test.ts habitat-directory-policy.test.ts
    pnpm.cmd --filter @myself/desktop typecheck

建议提交：

    feat: 保存独立目录空间授权

---

### Task 3：实现候选匹配、目录身份延续和多窗口选择

**文件：**

- 新建：apps/desktop/src/main/habitat/explorer-candidate-selector.ts
- 新建：apps/desktop/src/main/habitat/folder-identity-resolver.ts
- 新建测试：apps/desktop/tests/explorer-candidate-selector.test.ts
- 新建测试：apps/desktop/tests/folder-identity-resolver.test.ts

**纯函数选择规则：**

1. 只接受桥接层标记为 foreground、not minimized、not search、unambiguous 的候选。
2. 规范路径直接匹配时仍重新 stat 并比较目录身份。
3. 规范路径变化但 dev/ino 与已保存身份匹配时，视为同卷重命名或移动，并由 HabitatStore 原子更新新路径。
4. 多个候选身份都匹配时选择最大激活序号；序号相同或事实冲突时保持隐藏。
5. 候选过期、事件倒序、实例销毁或前台 HWND 改变时立即撤销绑定。

**RED：**

- 上级目录、搜索结果、同名目录、路径前缀、大小写变化、短路径和链接目标。
- 同一路径多窗口、同 HWND 多标签、事件乱序和旧实例重放。
- 同卷重命名身份匹配、目录被替代身份不匹配。
- 目录临时不可访问与永久删除都不触发相似路径搜索。

运行：

    pnpm.cmd --filter @myself/desktop test -- explorer-candidate-selector.test.ts folder-identity-resolver.test.ts

建议提交：

    feat: 匹配准确资源管理器目录

---

### Task 4：实现 HabitatService 权威状态机

**文件：**

- 新建：apps/desktop/src/main/habitat/habitat-service.ts
- 新建：apps/desktop/src/main/habitat/habitat-errors.ts
- 新建测试：apps/desktop/tests/habitat-service.test.ts

**公开 Main 内部命令：**

- enterDirectory(directoryId, reason)
- summon()
- recallToDesktop()
- observeExplorer(snapshot)
- handleDirectoryAvailability()
- handleTaskEvent(event)
- handleUserInteraction()
- close()
- snapshot()

**状态迁移：**

- desktop → entering → folder-hidden
- folder-hidden → revealing → folder-visible
- folder-visible → folder-hidden
- folder-hidden/folder-visible → folder-lost
- folder-hidden/folder-visible/folder-lost → recalling → desktop

**一致性规则：**

- enter 先重新验证目录身份和阻塞条件，再保存稳定 folder 位置；持久化成功后隐藏窗口。崩溃重启时启动链在任何 pet.show 前读取 HabitatStore。
- recall 先保存 desktop 稳定位置，再恢复窗口坐标和显示；目录不可访问不阻止 recall。
- revealing 只消费当前桥接 revision 和实例 ID；旧窗口事件不能恢复可见性。
- Explorer 观察异常、窗口失焦或候选不确定时，先隐藏并 `invalidate` 层级控制器，但不清除 folder 位置。
- close 幂等停止观察、隐藏并 `invalidate` 层级控制器，清理未完成的目录窗口。
- 同一时刻只允许一个 enter/recall/summon 操作；重复命令返回当前结果，不重复写状态。

**阻塞条件：**

- Agent 阶段为 listening、thinking、awaiting_confirmation 或 acting。
- 存在文件任务事务、角色切换、用户拖拽、聊天窗口交互或应用退出。
- 前台窗口全屏。
- 自动藏身时 proactivityMode 不是 autonomous。

手动 recall 永远不被上述条件阻塞。

运行：

    pnpm.cmd --filter @myself/desktop test -- habitat-service.test.ts
    pnpm.cmd --filter @myself/desktop typecheck

建议提交：

    feat: 建立目录空间权威状态机

---

### Task 5：暂停运动并分离桌面坐标与目录局部坐标

**文件：**

- 修改：apps/desktop/src/main/characters/character-motion-service.ts
- 修改：apps/desktop/src/main/windows/pet-position.ts
- 新建：apps/desktop/src/main/habitat/habitat-motion-region.ts
- 修改测试：apps/desktop/tests/character-motion-controller.test.ts
- 修改测试：apps/desktop/tests/pet-position.test.ts
- 新建测试：apps/desktop/tests/habitat-motion-region.test.ts

**RED：**

- folder-hidden 和 folder-lost 时 tick 不调用 setPosition、不发布伪移动、不推进待机。
- folder-visible 时运动只在 Explorer 邻近安全矩形内，不能越过屏幕工作区、任务栏或目标窗口外侧安全边界。
- 切换候选窗口先暂停，再重设区域和坐标，最后恢复，不经过无界中间位置。
- 目录附近拖拽只更新 localOffset，不覆盖 desktop petPosition。
- recall 恢复进入前桌面坐标；坐标失效时使用现有多显示器安全回退。
- 隐藏期间 position move 事件不写入 HabitatStore 或 SettingsStore。

**最小接口：**

- CharacterMotionService 增加 setSuspended(boolean) 和 setMovementRegions(rectangles|null)。
- PetPositionController 增加明确的持久化模式 desktop/folder/disabled，不从窗口可见性猜测。
- habitat-motion-region 只做矩形计算，不读取 HWND 或目录。

运行：

    pnpm.cmd --filter @myself/desktop test -- character-motion-controller.test.ts pet-position.test.ts habitat-motion-region.test.ts

建议提交：

    feat: 隔离目录与桌面运动坐标

---

### Task 6：实现非永久置顶和 Explorer 相邻层级

**文件：**

- 修改：apps/desktop/src/main/windows/window-manager.ts
- 新建：apps/desktop/src/main/habitat/habitat-window-controller.ts
- 复用：apps/desktop/src/main/habitat/explorer-window-layer-controller.ts
- 新建测试：apps/desktop/tests/habitat-window-controller.test.ts
- 复用测试：apps/desktop/tests/explorer-window-layer-controller.test.ts
- 修改测试：apps/desktop/tests/window-security.test.ts

**窗口模式：**

- desktop-idle：alwaysOnTop=false，普通桌面窗口层级。
- interaction-raised：点击、聊天、拖拽或托盘命令期间临时提升；结束或超时后恢复。
- folder-hidden：window.hide、运动暂停、鼠标穿透回到安全状态。
- folder-visible：Main 设置安全坐标，再调用 `ExplorerWindowLayerController.activate({ explorerHwnd })`；控制器只通过 Electron `BrowserWindow.moveAbove` 放到匹配 Explorer 的相邻 Z 序，不是全局置顶。
- lost：先隐藏窗口，再 `invalidate` 层级控制器。

**RED：**

- 创建选项不再永久 alwaysOnTop。
- 临时提升有固定最大时长，窗口销毁后不执行延迟恢复。
- 旧 Explorer HWND、其他进程 HWND、零句柄和已销毁窗口全部拒绝。
- 前台切换到其他应用时先隐藏，再 `invalidate`；不得在轮询间隔内继续覆盖其他应用。
- 最小化、DPI 改变、多显示器负坐标、任务栏四方向和 Explorer 移动时区域重算。
- Explorer 观察失败后没有残留置顶或可见透明窗口。

运行：

    pnpm.cmd --filter @myself/desktop test -- habitat-window-controller.test.ts window-security.test.ts

建议提交：

    feat: 管理目录空间动态窗口层级

---

### Task 7：把 hide/emerge 表现接入真实 Habitat 事件

**文件：**

- 修改：apps/desktop/src/main/characters/character-behavior-service.ts
- 修改：packages/character-runtime/src/character-behavior-engine.ts
- 修改测试：apps/desktop/tests/character-behavior-service.test.ts
- 修改测试：packages/character-runtime/tests/character-behavior-engine.test.ts

**规则：**

- HabitatService 只能发送 Main 内部 habitat 事实，Renderer 和 Agent 不新增 habitat 行为 IPC。
- enter 验证通过后可请求 hide 表现；播放完成、失败或最多两秒超时后都由 HabitatService 按真实窗口与存储结果收敛。
- 准确 found 后先提交 folder-visible 事实，再请求 emerge 表现。
- lost 使用已有 fail 表现，不增加系统权限语义。
- 用户交互、角色切换和任务开始可以中断表现，但不能改写已提交的空间事实。
- V1 和没有 hide/emerge 的 V2 角色使用 move/idle 回退，不能伪造新素材或播放成功。

**RED：**

- 正确令牌、错误令牌、终态乱序、角色切换、动画超时和缺失动作。
- enter 动画失败仍不会留下可见半状态。
- emerge 动画失败时准确找到的窗口仍保持真实 folder-visible；窗口事实变化后照常隐藏。
- 角色包不能通过 hide/emerge 请求任意目录或窗口。

运行：

    pnpm.cmd --filter @myself/character-runtime test
    pnpm.cmd --filter @myself/desktop test -- character-behavior-service.test.ts

建议提交：

    feat: 接入目录藏身与出现表现

---

### Task 8：设置页目录空间配置与严格 IPC

**文件：**

- 新建：apps/desktop/src/shared/habitat-ipc.ts
- 修改：apps/desktop/src/shared/ipc-channels.ts
- 修改：apps/desktop/src/shared/myself-api.ts
- 修改：apps/desktop/src/main/ipc/register-ipc.ts
- 新建：apps/desktop/src/main/habitat/habitat-settings-service.ts
- 修改：apps/desktop/src/preload/index.ts
- 修改：apps/desktop/src/renderer/src/settings/SettingsView.tsx
- 新建：apps/desktop/src/renderer/src/settings/HabitatSettings.tsx
- 修改测试：apps/desktop/tests/preload-api.test.ts
- 新建测试：apps/desktop/tests/habitat-ipc.test.ts
- 新建测试：apps/desktop/tests/habitat-settings.test.tsx

**界面：**

- 设置新增“空间”标签，不与已禁用 MCP 工具标签复用。
- 显示功能总开关、自动藏身开关、空闲延迟、已配置目录和当前空间状态。
- 添加目录必须打开 Main 目录选择框；删除配置明确说明不会删除磁盘目录。
- 每个目录只显示 displayName/pathHint、启用状态和可用/失联状态。
- 提供“立即藏到这里”和“召回桌面”，忙碌或阻塞时显示具体原因。

**IPC：**

- get habitat dashboard
- choose/add habitat directory
- set directory enabled
- remove directory
- save habitat preferences
- enter directory by opaque id
- summon
- recall

所有输入严格 Schema；Renderer 不能传 absolutePath、HWND、坐标、桥接命令或动作令牌。

**生产 preload 边界：**

- 不暴露私有目录身份、桥接快照、窗口句柄、状态机内部状态或 E2E 控制命令。
- E2E 探针只能在既有固定参数下返回枚举状态和 revision，不返回目录提示以外的数据。

运行：

    pnpm.cmd --filter @myself/desktop test -- habitat-ipc.test.ts habitat-settings.test.tsx preload-api.test.ts preload-production-boundary.test.ts
    pnpm.cmd --filter @myself/desktop typecheck

建议提交：

    feat: 添加目录空间设置入口

---

### Task 9：托盘呼唤、召回与自动藏身策略

**文件：**

- 修改：apps/desktop/src/main/index.ts
- 修改：apps/desktop/src/main/windows/window-commands.ts
- 新建：apps/desktop/src/main/habitat/habitat-autonomy-policy.ts
- 新建测试：apps/desktop/tests/pet-summon.test.ts
- 新建测试：apps/desktop/tests/habitat-autonomy-policy.test.ts
- 修改测试：apps/desktop/tests/window-commands.test.ts

**托盘：**

- 当前在桌面：显示“藏到目录”子菜单和普通显示/隐藏命令。
- 当前在目录：显示“呼唤桌宠”和“召回桌面”。
- 失联：呼唤给出稳定错误和召回入口。
- 呼唤通过 shell.openPath 打开已验证目录，不使用 Shell 命令字符串。
- 等待同一目录的准确 Explorer 事件；固定超时后保持隐藏并提示可召回。

**自动藏身：**

- 默认关闭。
- 只在用户开启、proactivityMode=autonomous、连续空闲达到配置阈值并且目录列表非空时运行。
- 目录候选只来自已启用配置，不读取内容、不按文件活动排序。
- 任务、确认、聊天、拖拽、角色切换、全屏、应用退出和桥接降级均阻止自动进入。
- 自动选择使用 Main 本地随机源和冷却；同一目录连续选择受抑制。
- 自动藏身失败只记录稳定码并回到 desktop，不触发模型请求。

运行：

    pnpm.cmd --filter @myself/desktop test -- pet-summon.test.ts habitat-autonomy-policy.test.ts window-commands.test.ts

建议提交：

    feat: 支持托盘呼唤与受控自动藏身

---

### Task 10：生产组合根、启动恢复和资源打包

**文件：**

- 修改：apps/desktop/src/main/index.ts
- 修改：apps/desktop/electron-builder.yml
- 修改：apps/desktop/package.json
- 修改测试：apps/desktop/tests/package-config.test.ts
- 新建测试：apps/desktop/tests/habitat-main-wiring.test.ts
- 修改：tests/fixtures/electron-app.ts
- 修改：apps/desktop/src/main/e2e-boundary.ts

**启动顺序：**

1. 创建 pet 窗口但不显示。
2. 初始化 HabitatStore 并恢复稳定空间。
3. desktop 时恢复桌面坐标；folder 时保持隐藏并启动桥接观察。
4. 初始化角色、运动和行为服务。
5. 只有状态机允许时才 show。

**关闭顺序：**

1. 停止自动藏身调度。
2. HabitatService close 并撤销窗口层级。
3. 关闭桥接客户端并等待已验证子进程退出。
4. 刷新目录局部坐标和桌面坐标。
5. 再关闭设置、角色和其他服务。

**打包：**

- `extraResources` 只包含固定 `explorer-space-bridge.ps1`、`explorer-space-shell-tab-helper.cs` 和二者的完整性清单。
- 包配置测试证明脚本、C# helper 与完整性清单逐文件进入安装包，生产不从 userData、授权目录、藏身目录或角色包加载源码。
- E2E 使用 Main 内部 fake bridge，不打开用户真实 Explorer，不暴露 fake 控制到生产 preload。

运行：

    pnpm.cmd --filter @myself/desktop test -- habitat-main-wiring.test.ts package-config.test.ts e2e-boundary.test.ts
    pnpm.cmd --filter @myself/desktop build

建议提交：

    feat: 完成目录空间生产组合根

---

### Task 11：安全、集成与 Electron E2E

**文件：**

- 修改：tests/security/permission-boundary.test.ts
- 修改：tests/integration/desktop-agent.test.ts
- 修改：tests/e2e/desktop.spec.ts
- 修改：tests/fixtures/electron-app.ts
- 修改：apps/desktop/tests/preload-production-boundary.test.ts

**安全矩阵：**

- 伪造目录 id、绝对路径、HWND、桥接序号、协议版本和未知命令。
- 路径穿越、目录根、符号链接、Junction、目标替换、权限变化和身份重用。
- Shell/COM 输出超长、乱码、截断、重复、乱序、晚到和 stderr 注入。
- 桥接脚本路径被替换、可执行路径被替换、最小环境和退出清理。
- Agent 工具定义中不存在 habitat、Explorer、window、PowerShell 或 Shell 能力。
- 角色包导入不能携带桥接脚本、目录配置、capabilityRef 或窗口命令。
- 生产 preload 不暴露绝对路径、句柄、私有身份、桥接状态或 E2E 控制。

**集成矩阵：**

- desktop → folder-hidden → folder-visible → hidden → recalled。
- 同路径多窗口只绑定最新实例。
- 多标签 ambiguous 保持隐藏。
- 同卷重命名在真实身份匹配后更新提示。
- bridge 崩溃、Explorer 重启、目录删除和磁盘不可用进入 lost。
- 任务执行、文件提交、拖拽和角色切换阻止自动藏身。
- folder 模式不改变 Agent 授权根，现有回收站任务无回归。

**Electron E2E：**

E2E 只使用隔离 HabitatStore 和脚本化 fake bridge：

1. 添加临时目录配置并确认 Renderer 看不到绝对路径。
2. 手动进入后 pet 窗口隐藏，运动暂停。
3. 注入错误目录、旧 revision、后台窗口和 ambiguous，不显示。
4. 注入准确前台 Explorer 快照，pet 只出现一次并进入 emerge 表现。
5. 切换目录、最小化和失焦后隐藏。
6. 托盘呼唤等待正确快照；超时不错误显示。
7. recall 在目录失效时仍恢复桌面坐标。
8. bridge 崩溃后无残留可见窗口和子进程。
9. 回收站搬运、角色切换、边缘拖拽和 MCP 禁用场景继续通过。

运行：

    pnpm.cmd test:security
    pnpm.cmd test:integration
    pnpm.cmd --filter @myself/desktop build
    pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "目录藏身与资源管理器空间"

建议提交：

    test: 覆盖目录空间安全闭环

---

### Task 12：Windows 人工验收、完整门禁和中文记录

**文件：**

- 新建：docs/operations/directory-habitat-explorer-space-acceptance.md
- 更新：docs/operations/explorer-shell-com-feasibility.md

**自动门禁：**

    pnpm.cmd verify:behavior
    pnpm.cmd verify:characters
    pnpm.cmd verify:desktop
    pnpm.cmd --filter @myself/file-tools test
    pnpm.cmd --filter @myself/file-tools typecheck

**Windows 人工验收：**

1. 添加一个不含隐私内容的专用测试目录，确认磁盘中没有被写入标记。
2. 手动藏身，确认桌宠窗口真正隐藏且 CPU/内存下降。
3. 打开上级目录、搜索结果和同名目录，确认桌宠不出现。
4. 前台准确打开目标目录，确认桌宠在窗口附近出现且不覆盖工具栏。
5. 切换标签、窗口、最小化、关闭和失焦，确认立即隐藏。
6. 同一路径打开两个窗口，只在最近激活实例附近出现。
7. 重命名或同卷移动目录，再打开新位置，确认身份延续；不要扫描磁盘。
8. 删除目录、拒绝权限或断开磁盘，确认进入迷路并可召回。
9. 使用托盘呼唤打开目录，超时后仍可召回桌面。
10. 在目录空间进行点击、聊天和拖拽，确认临时层级结束后恢复普通层级。
11. 启动文件任务、确认回收站动作和切换角色，确认不会触发自动藏身或串线。
12. 重启 Explorer、终止桥接层和重启应用，确认没有残留 PowerShell、透明窗口或过期 HWND。
13. 多显示器、负坐标、DPI 缩放、任务栏四边和全屏应用下复验。
14. 连续切换目录和标签至少 20 次，运行 10 分钟，记录 CPU、内存、桥接进程和错误日志。
15. 确认日志不含 API Key、Authorization、目录绝对路径、文件名列表、聊天内容或窗口句柄。

自动 E2E 不等同于真实 Explorer、Shell/COM、多标签和窗口层级验收；人工项目未完成前不得宣称阶段 3B 完成。

建议提交：

    docs: 记录目录空间验收结果

---

## 5. 子智能体执行顺序

严格按以下顺序：

1. Task 0：Shell/COM 准确发现技术门。
2. Task 1：角色行为语义。
3. Task 2：HabitatStore 和目录策略。
4. Task 3：候选选择和身份延续。
5. Task 4：HabitatService 状态机。
6. Task 5：运动暂停与坐标隔离。
7. Task 6：动态窗口层级。
8. Task 7：表现接线。
9. Task 8：设置和 IPC。
10. Task 9：托盘与自动策略。
11. Task 10：生产组合和打包。
12. Task 11：安全、集成和 E2E。
13. Task 12：完整门禁与人工验收。

同一核心文件的任务不得并行。允许并行的只有：

- 只读代码调查。
- 不修改共享文件的测试矩阵审阅。
- Windows 人工夹具准备。
- 已完成任务的独立只读规格审查和代码质量审查。

Task 0 未通过时不得开始 Task 1。Task 6 未证明非永久置顶和失焦隐藏时不得开始 Renderer/E2E 接线。

---

## 6. 超时和换方案

- 单点先进行有证据的定位，不能第一次失败就跳过。
- 同一路径连续三次没有新增证据时，切换到协议纯函数、fake bridge 或更小窗口夹具。
- 单点累计 30 分钟没有实质进展时停止扩大修改，记录失败测试、Windows 版本和桥接输出的脱敏摘要。
- 可以放宽的只有动画时长、轮询间隔和非关键视觉距离。
- 不得放宽准确路径、身份匹配、目录独立授权、生产 preload、非永久置顶、单实例、失焦隐藏、最小子进程环境和召回能力。
- 多标签准确识别失败不能切换为标题猜测；只能返回 ambiguous 或进入新的 UIA 安全设计审批。
- 长时间构建、Playwright 和 Windows 人工观察可挂后台，但每 60 秒检查输出和残留进程。

---

## 7. 明确不在阶段 3B 实现

- 永久删除、批量删除或新的文件写工具。
- 把藏身目录设为 Agent 文件授权根或当前文件工具作用域。
- 读取、索引、搜索或根据目录内容选择藏身地。
- 资源管理器进程注入、Shell 扩展、任意 DLL 注入。
- 通用 Windows UI Automation、任意 Win32/COM 命令、鼠标键盘执行。
- 持续截图、OCR、视觉定位或逐帧模型判断。
- 桌面图标藏入真实目录、修改图标、写隐藏文件或快捷方式。
- 长期记忆、主动陪伴对话、动态模型目录、语音和 MCP 恢复。
- WebsiteExtension、网站、部署或下载链路。

---

## 8. 完成定义

只有同时满足以下条件才能宣布阶段 3B 完成：

- 用户可独立配置可藏身目录，绝对路径只保留在 Main 私有存储。
- 目录配置不会扩大 Agent 文件权限，也不会读取或修改目标目录内容。
- 桌宠进入目录后真正隐藏，运动和桌面坐标保存暂停。
- 只有准确前台 Explorer 目录身份匹配时桌宠才出现。
- 上级目录、搜索、同名、后台窗口和 ambiguous 多标签都不误触发。
- 同一路径多窗口只出现一个桌宠，旧事件和旧 HWND 不能恢复显示。
- 窗口不是永久置顶，失焦后不覆盖其他应用。
- 托盘呼唤、召回和目录失联恢复可用，召回不依赖目录。
- hide/emerge 只有表现权，没有系统权限；V1 和缺少动作的 V2 角色可降级。
- 桥接层协议固定、环境最小、输出有界、退出后无残留进程。
- 现有回收站事务、角色切换、边缘拖拽、聊天、设置和 MCP 禁用无回归。
- 三道完整门禁、专属安全/集成/E2E 和当前 Windows 人工验收均有新鲜证据。
- 未触碰 WebsiteExtension、网站、阶段 4 认知、语音、通用自动化或 MCP。

---

## 9. 阶段 4 交接条件

阶段 3B 完成并经用户验收后，才允许编写“自由聊天与任务意图分流、共享用户档案、角色关系记忆、记忆管理和受冷却主动陪伴”的详细计划。阶段 4 可以消费脱敏的空间状态枚举，但不得读取可藏身目录绝对路径、Explorer 窗口信息或桥接协议。
