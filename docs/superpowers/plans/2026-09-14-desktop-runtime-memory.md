# 桌宠运行内存优化计划

**适用规格：** [运行内存优化](../specs/2026-09-14-desktop-runtime-memory-design.md)。用户已明确授权实施，无需重复审批。

**全局约束：** 已有 worktree 中执行；只改桌面资源加载；保留全部交互、组件状态、业务投影与角色效果；无依赖变更、无 Git 写操作。独立进程采样前后复用同一脚本，绝不停止用户现有桌宠。

## Task 1: 当前视图按需加载

**文件：** 修改 `apps/desktop/src/renderer/src/App.tsx`、`apps/desktop/src/renderer/src/main.tsx`（保留原 CSS 静态加载顺序）、`apps/desktop/src/renderer/src/chat/ChatBubbleView.tsx`（显式导入原 CSS）；新增 `apps/desktop/tests/app-view-loading.test.tsx`；必要时调整已有 `renderer-components.test.tsx` 的异步等待。

**接口：** 保留 `currentView()`、`mountTaskEventsIfAvailable(api, restoreConversation)` 和 `App()` 导出；五个 view 的组件 props 原样传递，bubble 仍不挂任务订阅，其余订阅与恢复规则保留。

1. RED：用受控模块工厂记录实际加载的视图，分别渲染 bubble/chat/pet/settings/characters；断言只加载所选视图，既有元素/props 与挂载契约不变。旧静态导入应导致无关工厂也加载而失败。
2. GREEN：复用 React 原生 `lazy` 与 `Suspense`，按当前 view 选择同名组件。例如：

```tsx
const ChatPanel = lazy(() => import('./chat/ChatPanel').then(module => ({ default: module.ChatPanel })));
```

其余四个组件使用各自现有路径及命名导出；`Suspense` 不新增产品占位视觉。保留 App 的 effect 与公开 helper，禁止顺带改订阅、会话或者样式。入口 CSS 按聊天、工作室、全局样式顺序静态加载；使用 `tests/e2e/desktop-style-loading.spec.ts` 的实际构建样式浏览器回归验证原最终级联，避免视图拆包改变字体、颜色和间距。
3. 运行 `pnpm.cmd --filter @myself/desktop test tests/app-view-loading.test.tsx tests/renderer-components.test.tsx tests/use-chat-presentation.test.tsx tests/use-chat-presentation-reset.test.tsx`，再执行桌面 `typecheck`；检查首次视图加载和 CSS 无遗漏。
4. 完成标准：测试证明非当前视图未求值，五种视图可加载，原业务 helper 不变；提交前删除原静态导入，无第二套入口。交付报告注明 RED/GREEN 命令和风险，不自行 commit。

## Task 2: 设置和工作室延迟首次创建

**文件：** 修改 `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/windows/window-commands.ts`；修改 `apps/desktop/tests/main-lifecycle.test.ts`、`apps/desktop/tests/window-commands.test.ts`，只在原断言依赖旧预加载时调整 `window-security.test.ts`。

**接口：** 设置复用 `createLoadBeforePublishWindow<BrowserWindow>` 的 `ensure(): Promise<BrowserWindow>` 与 `getCurrent(): BrowserWindow | null`。工作室既有管理器和 `workshopCloseHandshake.bindWindow` 保留；所有业务 IPC 和窗口命令签名不变。

1. RED：断言 Main 首屏 Promise.all 不再加载设置/工作室、设置通过按需管理器接入、动态广播允许空目标；管理器测试先挂起 load，再销毁候选，完成 load 后应拒绝且 getCurrent 为空。
2. GREEN：设置管理器 create 中创建窗口并立即 `startupCleanup.add` 登记候选销毁，prepare 保留 `hideOnClose`，load 继续 `loadRenderer(candidate, 'settings')`。动态读取设置目标，不新增业务状态缓存。工作室工厂同样登记候选清理。
3. 管理器在 load 成功后、发布前执行：

```ts
if (candidate.isDestroyed()) throw new Error('WINDOW_LOAD_DESTROYED');
current = candidate;
```

继续复用原 catch/finally 的销毁、清空 inFlight 和重试路径。禁止销毁用户隐藏的设置/工作室，保留未保存输入和编辑选择。
4. 启动 Promise.all 保留 pet/chat/bubble；移除非必要页面的预加载。不要改本地模型 start、行为初始化及任务入口。
   首次显示前通过 `apps/desktop/src/main/windows/renderer-ready.ts` 固定脚本等待 DOM 提交；`apps/desktop/tests/renderer-ready.test.ts` 在 jsdom 中执行实际脚本，验证已有视图、延迟提交、超时清理和上下文销毁。
5. 运行 `pnpm.cmd --filter @myself/desktop test tests/main-lifecycle.test.ts tests/window-commands.test.ts tests/window-security.test.ts tests/character-workshop-close.test.ts tests/character-workshop-close-renderer.test.tsx` 与桌面 `typecheck`。
6. 完成标准：冷启动只含必要页面；首次并发打开复用单个加载；关闭重开状态保留；错误候选不发布；既有关闭握手测试通过。交付报告记录实测，不自行 commit。

## Task 3: 同条件内存与交互验收

**文件：** 测量脚本和原始结果位于 `.superpowers/sdd/2026-09-14-desktop-runtime-memory/`；正式回归优先复用 `tests/e2e/desktop-settings-layout.spec.ts`、`tests/e2e/chat-appearance.spec.ts` 与现有工作室测试，必要时新增专用窗口加载 E2E；结果写入 `docs/operations/2026-09-14-desktop-runtime-memory-acceptance.md`。

1. 生产改动前先完成 before 内存采样，记录源版本、测试模式、窗口数、进程类别和多个稳定样本。
2. Tasks 1/2 完成并经独立复核后 build，再用同一脚本 after 采样；包含首次打开和关闭后重开设置/工作室，验证原组件状态和加载耗时。
3. 运行受影响测试、桌面类型检查、构建和适用门禁；不可把旧原生截图守卫失败写成已通过，也不可用开发版与测试版不同基线推算收益。
4. 对照变化范围、测试、内存数据、未覆盖项，写中文验收记录并执行 `git diff --check`。不执行 Git 写操作。
