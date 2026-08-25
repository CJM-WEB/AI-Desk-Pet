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
