# Task 3 实施报告：角色工作台四条可访问分隔器

## 实施范围

- 新增 `clampWorkshopLayout()`，统一约束桌面三列、侧栏上下区和预览/时间轴轨道；`stageHeight` 明确表示预览轨道高度。
- 新增 `WorkshopSplitter`，支持 Pointer Capture、错误指针过滤、Pointer Cancel/Lost Capture 收口、方向键 8px、Shift 32px，以及完整 separator ARIA 值。
- `CharacterWorkshopView` 负责 StrictMode 单次读取、ResizeObserver 内存收敛、交互结束持久化和脱敏保存失败提示；Workspace 只接收布局与回调，不直接访问 Main IPC。
- 桌面模式使用四个 8px CSS Grid 轨道；`<=920px` 隐藏全部分隔器并恢复无空轨道的响应式布局。
- 未删除或修改皮肤编辑 UI、角色包 V2 皮肤契约与运行时路径。

## RED 证据

1. 首轮执行 `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-layout.dom.test.tsx`：退出 1，生产模块 `WorkshopSplitter`/`workshop-layout` 不存在，测试套件无法解析。
2. 加入纯函数与独立分隔器后，View 生命周期 RED：9 项中 3 项失败，分别证明布局 IPC 未读取、四条命名 separator 未渲染。
3. 真实 Electron 方向 mutation：把四条拖动断言从“任意变化”收紧为“边界跟随指针方向”后退出 1；右侧分隔器向右拖动时右栏由 300px 错误增至 316px。新增右侧 `pointerDirection={-1}` 后通过。

## GREEN 与验证证据

- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-layout.dom.test.tsx`：退出 0，9/9 通过。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-components.test.tsx`：退出 0，37/37 通过。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-close-renderer.test.tsx`：退出 0，4/4 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出 0。
- `pnpm.cmd --filter @myself/desktop build`：退出 0；Main、Preload、Renderer 构建及沙箱 Preload/MCP/本地模型边界检查通过。
- `pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "四条分隔器真实拖动"`：退出 0，1/1 通过，真实鼠标拖动四条分隔器、正确方向变化、关闭重开恢复、900px 窄屏隐藏与恢复桌面偏好均通过。
- `git diff --check`：退出 0，仅有工作树 CRLF 转换提示。

## 失败路径与边界

- 连续 pointermove 与 ResizeObserver 通知不调用保存；pointerup/cancel、lost capture 或有效键盘操作才提交。
- 窄屏只使用响应式模板，不保存临时收敛值；回到桌面布局时从持久偏好重新收敛。
- 保存失败保留当前 Renderer 布局，显示不含异常路径或原始错误的中文 `role="status"` 提示。
- 自动化证明布局几何与持久化行为；真实用户对分隔器手感、不同 DPI 和长期使用观感仍为待用户人工确认。

## 已知非阻塞事项

- JSDOM 不实现 Canvas 2D Context，完整 View DOM 测试会输出既有 `HTMLCanvasElement.getContext()` 警告；相关测试均通过，真实 Electron E2E 使用正式 Renderer 验证布局交互。
