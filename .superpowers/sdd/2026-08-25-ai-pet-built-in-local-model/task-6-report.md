# Task 6：严格 IPC 与 Preload 状态订阅报告

## 状态

已完成。

## RED 证据

先新增严格 IPC、公开 Dashboard 状态和 Preload 订阅边界测试，再执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/advanced-settings-ipc.test.ts tests/preload-production-boundary.test.ts tests/desktop-settings-service.test.ts
```

初始结果为 4 项预期失败：高级设置尚未注册本地模型开关通道，`DesktopSettingsService` 缺少 `setLocalModelEnabled()` 且 Dashboard 未校验/投影本地状态，生产 preload 没有状态订阅 API。失败原因均为缺失的目标行为，而非测试配置错误。

## 实现

- 新增严格白名单 IPC：`settings:local-model-enabled-set` 仅接受严格 `{ enabled: boolean }`，未知字段和字符串布尔值在进入服务前统一拒绝为 `SETTINGS_INPUT_INVALID`。
- `DesktopSettingsService` 仅接收 `getStatus()` 与 `setEnabled()` 两项本地模型窄接口；不持有 Runtime、连接、进程、Token 或私有日志。
- Dashboard 增加 `localModel: LocalModelPublicStatus`，并在 Main 设置服务中使用严格 Schema 复核，拒绝任何额外私有字段。
- Main 把 Runtime 状态再次按 `LocalModelPublicStatus` 严格校验后，仅广播至聊天和设置窗口；广播负载不包含端口、Token、路径、PID 或 stderr。
- Preload 增加 `setLocalModelEnabled()` 与 `onLocalModelStatus()`；事件入站使用 `localModelPublicStatusSchema.parse()`，取消订阅时移除原始精确 handler。
- 为既有 Dashboard 空态和测试夹具补齐公开状态字段；未新增设置页面、视觉资源或用户交互界面。

## 验证结果

最终执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/advanced-settings-ipc.test.ts tests/preload-production-boundary.test.ts tests/desktop-settings-service.test.ts tests/preload-api.test.ts
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop build
git diff --check
```

结果：4 个测试文件共 56 项通过；桌面 TypeScript 检查通过；生产 Main、Preload、Renderer 构建及现有 Preload/MCP 产物边界校验通过；`git diff --check` 无空白错误。

构建期间 Vite 继续报告第三方 `lucide-react` 的既有 `"use client"` 指令忽略提示，命令退出码为 0，未影响本任务校验。

## 自审

- 严格输入 Schema 同时拒绝多余字段与非布尔 `enabled`。
- Dashboard 和状态事件均复用唯一公开状态 Schema；公开 DTO 不携带运行连接细节。
- 开关 IPC 不额外触发现有通用配置重置；`LocalModelService.setEnabled()` 仍是唯一执行会话失效、路由与 Runtime 切换的事务入口。
- 未修改 SDD ledger，未下载模型、未启动真实 Runtime，未提前实现 Task 7 的设置界面。

## 未覆盖项与风险

- 本任务不包含真实 CPU/Vulkan Runtime、安装包或 Windows 窗口人工观察；这些仍待后续资源集成和人工验收。
- 新状态事件只传输严格公开快照；具体的加载提示、开关控件和聊天禁发 UI 仍属于后续 UI 任务。
