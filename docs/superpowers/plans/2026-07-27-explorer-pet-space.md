# AI 桌宠文件夹空间与资源管理器图层实施计划

> **供智能执行代理使用：** 实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按复选框逐项执行和复核。

**目标：** 让桌宠可进入文件夹、只在对应资源管理器内容区活动，并通过托盘呼唤或召回。

**架构：** 使用独立 Windows UI Automation/Win32 辅助进程观察 Explorer 和管理外部窗口层级；Electron Main 保存空间状态并控制唯一角色窗口，Renderer 只负责渲染。

**设计规格：** [AI 桌宠文件夹空间与资源管理器图层设计](../specs/2026-07-27-explorer-pet-space-design.md)

## 全局约束

- 不向 `explorer.exe` 注入代码，不修改系统进程。
- 不使用持续截图或高频全桌面轮询。
- 任意时刻只允许一个可见桌宠实例。
- 文件夹不可访问时不得猜测相似路径。
- 实施期间只允许 Git 只读命令；其他 Git 行为必须取得用户同意。

---

### 任务 1：空间位置契约与迁移

**文件：**

- 修改：`packages/shared-types/src/contracts.ts`
- 修改：`apps/desktop/src/main/storage/settings-store.ts`
- 新建：`apps/desktop/src/main/habitat/pet-habitat-store.ts`
- 新建测试：`apps/desktop/tests/pet-habitat-store.test.ts`

**产出：** `PetHabitat`、`FolderIdentity`、局部位置和桌面坐标的版本化持久化。

- [ ] 写失败测试，覆盖旧 `petPosition` 迁移、文件夹位置恢复和损坏数据降级。
- [ ] 实现原子迁移；公开设置只返回脱敏路径提示。
- [ ] 验证目录不可访问不会静默改成另一个目录。
- [ ] 运行目标测试和类型检查。

### 任务 2：Windows 辅助进程协议

**文件：**

- 新建：`native/windows-explorer-bridge/`
- 新建：`apps/desktop/src/main/habitat/explorer-bridge-protocol.ts`
- 新建：`apps/desktop/src/main/habitat/explorer-bridge-client.ts`
- 新建测试：`apps/desktop/tests/explorer-bridge-protocol.test.ts`

**产出：** 带版本的 JSON Lines 协议、请求 ID、事件序号、超时、取消和进程生命周期。

- [ ] 先定义并测试 `hello`、窗口快照、激活变化、内容区边界、目录身份和图层命令 Schema。
- [ ] 辅助进程只实现 UI Automation、WinEvent Hook 和必要 Win32 窗口 API，不实现任意命令执行。
- [ ] Main 校验每条消息，忽略过期序号并限制消息大小。
- [ ] 验证辅助进程异常退出、协议不匹配和重启限频。

### 任务 3：Explorer 窗口与标签页观察

**文件：**

- 修改：`native/windows-explorer-bridge/`
- 新建测试：`apps/desktop/tests/explorer-window-selection.test.ts`
- 新建人工夹具：`docs/operations/explorer-habitat-acceptance.md`

**产出：** 当前文件夹、内容区、激活窗口/标签页和稳定目录身份事件。

- [ ] 用纯选择函数测试同一路径多候选时选择最近激活实例。
- [ ] 使用 UI Automation 读取 Explorer 当前标签页与文件视图边界。
- [ ] 使用卷标识和文件标识追踪本地目录，网络目录回退到规范化路径。
- [ ] 人工验证 Windows 10/11、单窗口、多窗口、多标签和 Explorer 重启。

### 任务 4：覆盖窗口和图层同步

**文件：**

- 修改：`apps/desktop/src/main/windows/window-manager.ts`
- 新建：`apps/desktop/src/main/habitat/explorer-overlay-controller.ts`
- 修改：`apps/desktop/src/main/windows/pet-position.ts`
- 新建测试：`apps/desktop/tests/explorer-overlay-controller.test.ts`

**产出：** 桌面与文件夹两种窗口模式、内容区裁剪、层级同步和唯一实例约束。

- [ ] 写状态机测试，覆盖绑定、切换、最小化、遮挡、关闭和乱序事件。
- [ ] 文件夹模式关闭全局 `alwaysOnTop`，由桥接进程将窗口放在目标 Explorer 的正确层级。
- [ ] 将窗口边界限制在文件内容区，并把角色坐标转换为内容区局部坐标。
- [ ] 透明区域保持点击穿透，角色命中区仍可交互。
- [ ] 运行窗口安全、位置和控制器回归测试。

### 任务 5：进入文件夹与作用域联动

**文件：**

- 新建：`apps/desktop/src/main/habitat/habitat-service.ts`
- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 修改：`packages/character-runtime/src/state-machine.ts`
- 新建测试：`apps/desktop/tests/habitat-service.test.ts`

**产出：** 受权限控制的进入动作，以及 Agent 文件工具当前作用域更新。

- [ ] 写测试证明动画失败不改变真实位置迁移结果，未授权目录不能进入。
- [ ] 按“校验权限→播放表现事件→保存位置→切换窗口模式”执行迁移。
- [ ] 文件夹栖息期间，工具默认作用域限定为该文件夹；扩大范围仍需另行授权。
- [ ] 切换或取消任务时保持位置、权限和角色状态一致。

### 任务 6：托盘呼唤、召回和失联恢复

**文件：**

- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/main/windows/window-commands.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 新建测试：`apps/desktop/tests/pet-summon.test.ts`

**产出：** “呼唤桌宠”“召回桌面”菜单命令和错误恢复。

- [ ] 写测试覆盖桌面显示、打开目标目录、绑定超时、磁盘断开和召回。
- [ ] 呼唤文件夹桌宠时通过系统目录打开能力启动 Explorer，不拼接 Shell 命令。
- [ ] 等待目标窗口被观察后再显示覆盖窗口；超时提供召回入口。
- [ ] Explorer 或辅助进程故障时先隐藏覆盖窗口，避免残留置顶层。

### 任务 7：性能与端到端验收

**文件：**

- 新建：`apps/desktop/e2e/explorer-habitat.spec.ts`
- 修改：`docs/operations/explorer-habitat-acceptance.md`
- 修改：`apps/desktop/electron-builder.yml`

**产出：** 辅助进程打包、自动化状态验证和 Windows 人工验收记录。

- [ ] 验证安装包包含版本匹配的辅助进程，且卸载不会留下进程或启动项。
- [ ] 自动化验证事件合并、重连、唯一实例和状态恢复。
- [ ] 在 Windows 10/11 实机验证进入、隐藏、切换标签、遮挡、呼唤、召回和目录重命名。
- [ ] 记录空闲、窗口拖动和动画期间 CPU/内存；超过预算时先优化事件合并与刷新频率。
- [ ] 运行桌面端测试、类型检查、构建和打包配置验证。

## 完成门禁

- [ ] 设计规格的九项验收标准全部有证据。
- [ ] Explorer 和辅助进程崩溃后不存在残留可见覆盖窗口。
- [ ] Windows 10/11 人工验收完成前，不宣称资源管理器图层完全通过。
- [ ] 未经用户另行许可，不执行任何 Git 写操作。
