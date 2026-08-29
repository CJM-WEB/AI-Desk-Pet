# Task 3 Fix Round 1 报告：保留工作台布局持久偏好

## 复审核验

复审指出的持久偏好污染真实存在：已保存 `stageHeight=470` 在当前 659px 工作区内渲染为 451px 后，只提交左栏宽度会把未交互的 `stageHeight` 错误保存为 451。原因是 `commitLayout()` 对四字段整体执行当前窗口 clamp，并把 rendered 结果写回 preferred 与 SettingsStore。

## RED 证据

- 将既有提交测试修正为“只更新实际交互字段”，执行 `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-layout.dom.test.tsx`：退出 1，11 项中 1 项失败；预期保存 `stageHeight=470`，实际为 451。
- 同轮新增 `1920×1080`、`1280×720` 默认布局字面基准，两项在修复前后均通过，证明常规桌面边界不会无故改写默认偏好。

## 最小修复

- `commitLayout()` 只把本次交互字段规范为 `1..4096` 的整数并合入 `preferredLayoutRef`。
- 保存对象使用更新后的 preferred 原值；Renderer 展示态另行根据当前 bounds 执行 clamp。
- 其他字段的 resize/DPI 临时收敛值不再写回持久设置。

## GREEN 与验证

- 布局 DOM：11/11 通过。
- 工作台组件：37/37 通过。
- Desktop typecheck：退出 0。
- Desktop build：退出 0；Main、Preload、Renderer 与生产边界检查通过。
- 目标 Electron E2E：1/1 通过；除四条真实拖动、重开恢复与窄屏回退外，新增验证响应式布局下左栏 ≥220px、中央 ≥360px、右侧属性区 ≥360px、侧栏上下区各 ≥220px、预览 ≥280px、时间轴 ≥150px。
- `git diff --check`：退出 0，仅有 CRLF 转换提示。

## 剩余边界

自动化已证明持久偏好与 rendered clamp 分离。不同 DPI 下的视觉观感和长时间拖动手感仍待用户人工确认。
