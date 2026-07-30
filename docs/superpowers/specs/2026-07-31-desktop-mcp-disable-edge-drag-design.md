# 桌宠 MCP 暂停开放与边缘拖拽修复设计

## 背景

当前桌面端会初始化 MCP 存储和管理器，设置页提供完整的 MCP 配置入口，Agent 在构建工具集合时会连接已启用的 MCP 服务并注册只读工具。现阶段产品不准备向用户开放 MCP，但相关实现需要完整保留，以便后续扩展开发。

桌宠窗口同时受两套位置逻辑控制：

- `PetWindowInteractionController` 在用户拖拽时每 16ms 根据系统光标移动窗口；
- `CharacterMotionService` 的自动运动计时器每 50ms 调用 `tick()`。

`CharacterMotionService.beginUserMove()` 已记录 `userMoving`，但 `tick()` 尚未使用该状态阻止自动窗口写入。当桌宠位于工作区左上角时，自动运动目标也是左上角；若拖拽窗口事件反馈晚于运动计时器，自动运动可能把刚向右下移动的窗口重新写回左上角，表现为能够按住但窗口不移动。

实施前必须先通过计时器交错测试验证该根因。如果测试不能证明双写竞争，不得实施猜测性修复，应返回 Renderer 命中、IPC 会话和 Main 窗口事件链继续采集证据。

## 目标

1. 完全暂停桌面端 MCP 对用户和 Agent 的运行时开放。
2. 保留 MCP 的源码、IPC、Preload、存储格式、配置和密钥，降低未来恢复成本。
3. 修复桌宠位于左上角及其他工作区边缘时能抓住但无法向屏幕内部拖动的问题。
4. 用户拖拽期间由拖拽控制器独占窗口位置写入。
5. 桌宠始终完整位于当前显示器工作区内。

## 非目标

- 不删除 MCP Manager、Store、IPC、Preload 或设置组件源码。
- 不迁移、清空、禁用标记或改写已有 MCP 配置和密钥。
- 不实现 MCP 的新功能或新传输方式。
- 不允许桌宠部分移出工作区。
- 不重构角色自动运动、像素命中或窗口安全边界中与本问题无关的代码。
- 不处理模型目录、自由对话或长期记忆需求。

## 方案选择

### 采用：共享能力策略与拖拽独占窗口

以共享、只读的桌面能力策略将 MCP 固定为关闭。Main、Renderer 和服务层使用同一能力值：

- Renderer 隐藏“工具”标签和 MCP 设置面板；
- Main 不加载 MCP 配置到运行态，不读取 MCP 密钥，不连接服务；
- Agent 工具构建固定得不到 MCP 注册项；
- MCP 配置、测试、启停、授权、删除和执行入口返回稳定错误；
- 持久化文件保持不变。

拖拽开始后，`CharacterMotionService` 进入用户移动状态。自动运动计时器仍可生成同步快照，但不得调用窗口 `setPosition()`。拖拽结束时以窗口最终坐标重设运动目标，再恢复自动运动。

该方案改动集中、恢复路径清晰，并直接消除两个控制器同时写窗口的所有权冲突。

### 未采用：空 MCP Manager

用空实现替代 `McpManager` 可以阻止连接，但设置页和服务方法仍表现为可用，需要在多层模拟部分成功，容易形成不一致状态，接口改动也更多。

### 未采用：从启动链路删除 MCP

删除依赖和注册代码最彻底，但会破坏现有扩展边界，提高未来恢复成本，不符合保留代码的要求。

## MCP 能力策略

新增共享能力策略，提供语义明确的布尔值：

```ts
export const desktopRuntimeCapabilities = {
  mcp: false
} as const;
```

能力值是当前版本的产品策略，不从用户输入、环境变量或本地配置读取，避免用户绕过禁用边界。未来恢复 MCP 时，应通过新的设计和测试显式修改该策略。

## MCP Main 行为

### 初始化

能力关闭时：

- `DesktopSettingsService.initialize()` 不调用 `getMcpServerSettings()`；
- 不读取 `mcp:<serverId>` 密钥；
- 不向运行态 `McpServerStore` 写入已有配置；
- 不调用 `McpManager.connect()`；
- 状态表和已发现工具表保持为空。

磁盘上的 MCP 设置和 SecretStore 内容不发生任何写入。

### 设置面板数据

`getDashboard()` 在能力关闭时返回空的 `mcpServers`。这不是删除持久化数据，只是运行时投影不公开 MCP 配置。

### 操作入口

以下服务方法在任何读写或连接动作之前抛出稳定错误 `MCP_MODULE_DISABLED`：

- `upsertMcpServer`
- `confirmMcpLaunch`
- `testMcpServer`
- `setMcpServerEnabled`
- `setMcpToolEnabled`
- `authorizeMcpToolReadOnly`
- `revokeMcpToolReadOnly`
- `deleteMcpServer`
- `executeMcpRead`

IPC 和 Preload 保持原接口，以便未来恢复且防止旧 Renderer 或直接 IPC 调用绕过能力策略。

### Agent 工具注册

`enabledReadToolRegistrations()` 在能力关闭时直接返回空数组，不读取 MCP Store，不连接服务。Agent 不会看到任何 `mcp.*` 工具。

### 关闭

应用退出仍调用 `McpManager.close()`。虽然禁用状态下不应存在连接，该调用保留防御性清理语义。

## MCP Renderer 行为

能力关闭时：

- 设置导航不渲染“工具”标签；
- `SettingsWorkspace` 不渲染 `McpSettings`；
- 初始标签和标签切换均不能进入 `tools`；
- MCP 组件及其操作回调源码保留，不删除。

直接传入 `activeTab="tools"` 的异常状态应回退到可用标签，不显示空白或 MCP 表单。

## MCP 数据保留

禁用行为不得调用以下写操作：

- 保存或删除 MCP 设置；
- 保存、清除或恢复 MCP 密钥；
- 修改 stdio 启动确认指纹；
- 修改服务或工具启用状态。

验收使用启动前后逐字节比较，证明已有 MCP 配置和密钥未发生变化。

## 拖拽根因验证

新增组合测试模拟以下顺序：

1. 窗口初始位于工作区左上角；
2. 自动运动目标为左上角；
3. 用户开始拖拽；
4. 拖拽控制器把系统光标向右下的差值写入窗口；
5. 窗口 `move` 事件尚未反馈前，自动运动 `tick()` 执行。

现有实现预期会由自动运动再次调用 `setPosition()`，证明窗口存在双写竞争。只有该测试按预期失败，才进入实现。

如果失败原因不符，应停止并检查：

- Renderer 是否仍处于命中且非穿透状态；
- `beginPetDrag` 是否在 Main 建立会话；
- 系统光标差值是否变化；
- `setPosition` 是否被调用及随后由谁覆盖；
- `move`、`moved`、pointer capture 和 blur 的事件顺序。

## 拖拽窗口所有权

### 开始拖拽

`beginUserMove()`：

- 设置 `userMoving = true`；
- 清空程序化位置历史；
- 将当前窗口坐标设为目标；
- 不改动现有方向、携带状态和空闲调度。

### 拖拽期间

`tick()` 检测到 `userMoving` 时：

- 从 `window.getBounds()` 读取真实当前位置；
- 更新单调递增的运动快照；
- `position` 与 `target` 使用真实当前位置；
- `moving` 为 `false`；
- 不调用 `window.setPosition()`；
- 不把位置加入程序化位置历史。

因此 `PetWindowInteractionController` 成为拖拽期间唯一允许调用 `setPosition()` 的组件。

### 结束拖拽

`endUserMove()`：

- 读取窗口最终坐标；
- 发布最终快照；
- 将最终坐标设为新的自动运动目标；
- 退出用户移动状态。

后续自动运动从最终位置继续，不回弹到拖拽前目标。

## 工作区边界

继续使用 Main 的系统光标和 `screen.getDisplayNearestPoint(cursor).workArea` 选择目标显示器。位置通过 `clampPositionToWorkArea()` 逐轴限制：

```text
workArea.x <= x <= workArea.x + workArea.width - window.width
workArea.y <= y <= workArea.y + workArea.height - window.height
```

验收覆盖：

- 左上、右上、左下、右下；
- 上、下、左、右四条边；
- 工作区原点不为零；
- 负坐标显示器。

拖向屏幕外时对应轴保持在边界，向屏幕内移动时必须立即离开边界。窗口始终完整可见。

## 异常处理

- MCP 禁用错误使用固定代码 `MCP_MODULE_DISABLED`，不暴露路径、命令、URL 或密钥。
- 拖拽 IPC 失败继续结束 Renderer 会话并恢复安全穿透。
- 拖拽取消、超时、Renderer 崩溃和窗口销毁继续执行现有安全清理。
- 自动运动暂停只影响窗口位置写入，不吞掉错误或改变计时器生命周期。

## 测试策略

### MCP 单元和组件测试

- 能力关闭时设置页没有“工具”标签和 MCP 表单。
- 异常传入 `tools` 标签时回退到可用页面。
- 初始化不读取 MCP 设置或密钥。
- 所有 MCP 操作在副作用前返回 `MCP_MODULE_DISABLED`。
- `enabledReadToolRegistrations()` 返回空数组且不连接。
- `executeMcpRead()` 不调用 Manager。
- 启动和关闭服务后，MCP 配置与密钥逐字节不变。
- MCP Manager、Store 和适配器原有内部测试继续保留。

### 拖拽单元与组合测试

- 左上角交错计时器测试先按预期失败。
- 用户移动期间 `tick()` 不调用 `setPosition()`。
- 多次 tick 均使用窗口真实坐标发布快照。
- 结束后最终位置成为新目标，下一次 tick 不回弹。
- 四角、四边、负坐标和非零工作区原点均可向内部移动。
- 现有穿透、取消、超时、销毁和多显示器测试继续通过。

### Electron E2E

在受限 E2E 边界中：

1. 将桌宠窗口移动到当前工作区左上角；
2. 在角色真实可见像素按下；
3. 向右下拖动；
4. 断言窗口坐标离开左上角；
5. 断言窗口完整位于工作区；
6. 打开设置并断言不存在“工具”标签；
7. 断言受限探针未出现 MCP 注册工具。

E2E 使用状态条件等待，不使用固定休眠。

## 验收标准

- 应用启动和 Agent 响应期间不会启动或连接任何 MCP 服务。
- 设置页没有 MCP 入口。
- 所有 MCP 直接调用返回 `MCP_MODULE_DISABLED`。
- 已保存 MCP 配置和密钥未被改写或删除。
- 桌宠从左上角向右下拖动时立即离开角落。
- 桌宠从任意边缘向屏幕内部拖动均正常。
- 拖拽期间自动运动不写窗口位置，结束后不回弹。
- 桌宠始终完整位于所选显示器工作区。
- 完整单元测试、类型检查、安全测试、集成测试和目标 Electron E2E 通过。

