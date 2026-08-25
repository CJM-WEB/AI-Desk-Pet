# Task 7：设置卡与聊天加载状态报告

## 状态

已完成。

## RED 证据

先新增设置页与聊天面板 Renderer 测试，再执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/multi-provider-settings.test.tsx tests/chat-panel.test.tsx
```

初始结果为 4 项预期失败：模型页不存在带可访问名称的本地模型开关，CPU 与故障文字不存在，聊天面板未调用 `onLocalModelStatus()`，故障态未显示稳定原因与设置入口。失败均由缺失的目标 UI 行为引起。

## 实现

- 新增独立的“内置本地模型”卡片，并置于模型页云端档案表单之前。卡片固定展示 Qwen3.5-4B、无需 API Key、当前公开状态、CPU 兼容模式提示、稳定故障原因和重新加载入口；不会进入 Provider 档案、密钥槽、已保存档案或路由表单。
- 开关使用具名 `role="switch"` 的原生复选框；异步设置事务进行期间由现有 `busy` 状态禁用，并以“正在切换…”提供文本反馈，从而阻止重复点击。
- `SettingsView` 在同一 effect 中订阅公开本地模型状态与读取 Dashboard。状态事件优先覆盖过期 Dashboard 返回值，组件卸载时停止状态更新并精确调用注销函数。
- `ChatPanel` 订阅同一公开状态；本地启用但未 ready 时禁用发送按钮，不替代 Main 的最终就绪校验。加载、停止、CPU 兼容、故障和视觉不可用都提供文本；故障态提供打开模型设置的入口。
- 复用既有设置令牌、卡片、按钮、焦点和紧凑网格样式。新卡片及聊天提示均使用 `min-width: 0` 的既有布局上下文与全局 `box-sizing: border-box`，静态检查未发现 640px 设置窗口和 720px 设置窗口的横向溢出路径；真实 Electron 尺寸观察继续由 Task 9 覆盖。

## 验证结果

最终执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/multi-provider-settings.test.tsx tests/chat-panel.test.tsx tests/settings-toast.dom.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop build
pnpm.cmd --filter @myself/desktop test
git diff --check
```

结果：定向 3 个测试文件共 24 项通过；Desktop TypeScript 检查通过；生产构建与 Preload/MCP 边界校验通过；完整 Desktop 套件 102 个测试文件、2352 项测试通过；`git diff --check` 无空白错误。

构建期间 Vite 继续报告第三方 `lucide-react` 的既有 `"use client"` 指令忽略提示，构建退出码为 0，未影响本任务验证。

## 自审

- Renderer 仅消费既有严格 `LocalModelPublicStatus`，未新增或泄露端口、Token、路径、PID、命令行、哈希或 stderr。
- 状态卡独立于云端 Provider 编辑区，云档案仍可编辑。
- 设置卡不再使用 `role="status"`，避免与既有全局 Toast 的唯一 live-status 语义冲突；聊天加载反馈保留独立 live status。
- 未修改 SDD ledger，未涉及 Task 8 的模型资源、打包或下载流程。

## 未覆盖项与风险

- 未运行真实 GGUF、CPU/Vulkan Runtime 或真实 Electron 窗口尺寸人工验收；这些仍由后续资源集成与 Task 9 / 用户人工确认覆盖。

---

## 修复轮 1（2026-08-25）

### RED 证据

先新增 Dashboard 初始快照和异步交错时序测试，再执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/chat-panel.test.tsx tests/settings-toast.dom.test.tsx
```

结果为 3 项预期失败：ChatPanel 在首次状态事件前未消费 Dashboard 的 `loading` 与 `faulted` 快照；SettingsView 的延迟保存响应以旧 `loading` 覆盖了操作期间事件推送的 `ready/Vulkan` 状态。其余 11 项通过。

### 修复内容

- ChatPanel 复用既有 `getSettingsDashboard()`，先订阅状态事件、后读取初始 Dashboard；快照只在尚未收到事件时生效，因此 Renderer 重载后的加载与故障状态会在首个事件前以文字反馈并禁用发送。
- SettingsView 用 ref 持有最新公开状态，并让初始读取与 `run()` 的两条 Dashboard 写入路径统一通过合并入口，避免任何延迟响应回退已经到达的状态事件。
- 抽取 Renderer 共享只读故障原因 formatter，移除聊天和设置卡中的重复中文映射。

### 验证结果

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/chat-panel.test.tsx tests/settings-toast.dom.test.tsx
pnpm.cmd --dir apps/desktop typecheck
pnpm.cmd --dir apps/desktop test
pnpm.cmd --dir apps/desktop build
git diff --check
```

结果：定向 2 个文件共 14 项通过；类型检查通过；完整 Desktop 套件 102 个测试文件、2355 项测试通过；生产构建、Preload/MCP 边界校验通过；`git diff --check` 无空白错误。构建仍有第三方 `lucide-react` 既有 `"use client"` 提示，退出码为 0。

### 范围与剩余风险

- 未新增 IPC、未改动 SDD ledger，也未涉及 Task 8。
- 未运行真实 Runtime 与真实 Electron 窗口人工验收；该限制与原报告相同，仍待后续任务或用户人工确认。

---

## 修复轮 2（2026-08-25）

### RED 证据

为 `run()` 的成功与失败异步续体新增两条卸载时序测试：实际执行“发起保存 → 卸载组件 → resolve/reject”，并精确断言续体必须经过 mounted 生命周期守卫。初始执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-toast.dom.test.tsx tests/chat-panel.test.tsx
```

结果为新增 2 项预期失败：`await operation()` 后、`catch` 内和 `finally` 内均缺少 mounted 守卫；其余 14 项通过。

### 修复内容

- SettingsView 新增组件级 `mounted` ref，并在挂载 effect 清理时失效。
- `run()` 在成功返回后和失败捕获后立即退出已卸载的组件；finally 仅在仍挂载时重置 `busy`。因此卸载后的 resolve/reject 不会继续执行 `applyDashboard`、`showNotice` 或 `setBusy`。

### 验证结果

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-toast.dom.test.tsx tests/chat-panel.test.tsx
pnpm.cmd --dir apps/desktop typecheck
pnpm.cmd --dir apps/desktop build
git diff --check
```

结果：定向 2 个文件共 16 项通过；类型检查通过；生产构建、Preload/MCP 边界校验通过；`git diff --check` 无空白错误。构建仍有第三方 `lucide-react` 既有 `"use client"` 提示，退出码为 0。
