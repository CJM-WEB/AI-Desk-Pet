# 任务 9B2 审查修复实施计划

> **执行者要求：** 当前会话逐项执行，每一步使用复选框跟踪；禁止默认沙箱启动真实 Electron，禁止 git 写操作。

**目标：** 以 TDD 修复 5 项 Important，并保留可复核的 RED/GREEN 与最终纯回归证据。

**架构：** 安全边界采用同步 canonical 校验；fixture 资源状态按成功清理逐项提交，并以脱敏 AggregateError 组合主/清理错误；`terminateElectronProcess()` 是进程终止超时的唯一所有者，外层 cleanup 直接等待其有界契约；窗口命令从 Main 入口提取为注入式控制器。

**技术栈：** TypeScript、Node.js、Electron、Vitest、Playwright 测试运行器。

## 全局约束

- 所有新增文档、注释和测试描述使用中文。
- 不新增 IPC/preload 测试 API，不默认沙箱启动真实 Electron，不执行 git 写操作。
- 不拆分 857 行 `desktop.spec.ts`，只记录 Minor。

---

### 任务 1：Main E2E canonical 边界

**文件：** 修改 `apps/desktop/tests/e2e-boundary.test.ts`、`apps/desktop/src/main/e2e-boundary.ts`。

**接口：** `resolveMainE2eBoundary(options)` 签名不变；内部对临时根和候选调用 `statSync(...).isDirectory()` 与 `realpathSync.native()`。

- [ ] 创建真实存在目录的测试夹具，新增目录/文件/不存在/前缀碰撞和 Windows Junction 跳出临时根用例。
- [ ] 运行 `pnpm.cmd --filter @myself/desktop test -- e2e-boundary.test.ts`，确认新增用例因当前词法校验而失败。
- [ ] 最小实现 canonical 目录 containment，异常统一返回 `null`。
- [ ] 重跑同一命令确认 GREEN。

### 任务 2：进程确认、可重试 dispose 与主错误保真

**文件：** 修改 `tests/e2e/desktop.spec.ts`、`tests/fixtures/electron-app.ts`。

**接口：** 导出可注入命令启动与短超时的 `terminateElectronProcess`；`ElectronAppFixture` 公共签名不变。

- [ ] 新增 taskkill 非零、taskkill 超时、SIGKILL 后仍存活、精确路径/PID和 dispose 首次失败后二次成功的纯假进程测试。
- [ ] 新增 create/restart 的主错误与 cleanup 同时失败测试，断言 `AggregateError.cause` 保留启动/CDP错误且错误集合包含清理诊断。
- [ ] 运行纯夹具 grep，确认引用过早清空、永久 disposed 和错误覆盖产生预期 RED。
- [ ] 最小实现原 child exit 确认、资源成功后清引用、成功后 released，以及脱敏主/清理错误聚合。
- [ ] 重跑纯夹具 grep确认 GREEN。

### 任务 3：跨 chunk 脱敏

**文件：** 修改 `tests/e2e/desktop.spec.ts`、`tests/fixtures/electron-app.ts`。

**接口：** `redactElectronLog` 签名不变；`fixture.logs` 改为按完整私有 chunk 聚合文本动态生成的只读脱敏结果。

- [ ] 将动态 key、`Authorization: Bearer ...` 和授权根拆为 2–3 个 stdout/stderr chunk，断言 logs 与最终错误任何字符串均不含完整秘密。
- [ ] 运行纯夹具 grep，确认逐 chunk 脱敏产生 RED。
- [ ] 改为聚合后统一 sanitize，再限制为最多 100 段、每段 4000 字符。
- [ ] 重跑纯夹具 grep确认 GREEN。

### 任务 4：窗口命令与 Renderer 点击

**文件：** 新建 `apps/desktop/src/main/windows/window-commands.ts`、`apps/desktop/tests/window-commands.test.ts`；修改 `apps/desktop/src/main/index.ts`、`apps/desktop/tests/renderer-components.test.tsx`、`ChatPanel.tsx`、`PetView.tsx`。

**接口：** `createWindowCommandController({ getChatWindow, ensureChatWindow, positionChat })` 返回 `showChat()`、`hideChat()`；正式 IPC channel 与 preload API 不变。

- [ ] 先测试 hide、现存/重建 chat 的 position→show→focus顺序，以及 `registerWindowIpc` 对正式 channel 的绑定。
- [ ] 运行窗口聚焦测试确认模块缺失 RED。
- [ ] 新增控制器并让 `index.ts`、托盘与 IPC 复用。
- [ ] 新增无状态关闭/打开按钮行为测试，确认分别调用 `window.myself.hideChat/openChat`；先 RED 后最小组件抽取 GREEN。

### 任务 5：最终验证与报告

**文件：** 修改 `.superpowers/sdd/task-9b2-cdp-report.md`。

- [ ] 顺序运行 e2e-boundary、window command、Renderer、纯 CDP fixture、desktop 完整、integration/security、typecheck、build。
- [ ] 记录每项命令、exit code、文件/测试数量和 RED/GREEN 原因。
- [ ] 报告新增/修改文件，并把 `desktop.spec.ts` 动态导入与重复逻辑列为后续 Minor。
- [ ] 核对没有真实 Electron、git 写或测试 API。

### 任务 6：统一进程终止 timeout owner

**文件：** 修改 `tests/e2e/desktop.spec.ts`、`tests/fixtures/electron-app.ts`、`.superpowers/sdd/task-9b2-brief.md`、`.superpowers/sdd/task-9b2-cdp-report.md`。

**接口：** `terminateElectronProcess()` 继续内部管理 `gracefulExitTimeoutMs`、`taskkillTimeoutMs`、`probeTimeoutMs`、`processExitTimeoutMs` 与路径/PID安全；`ElectronAppFixture` 公共签名不变。

- [x] 新增纯测试：注入终止器耗时超过 `operationTimeoutMs`，但在自身有界契约内成功；旧实现精确 RED 为 `ELECTRON_STAGE_TIMEOUT:cleanup_process_terminate`。
- [x] 最小 GREEN：`cleanupCurrentProcess()` 直接等待 `dependencies.terminateProcess()` 并沿用既有错误聚合与成功后清引用逻辑；禁止重新包裹通用短 timeout。
- [x] 保留 `cleanup_browser_close` 的 5 秒 `runStage()` 以及 CDP、目录等其他阶段边界，不调整 forced deadline。
- [x] 纯 fixture 23/23、desktop 112/112、integration/security 20/20、全工作区 typecheck 与 desktop build 均通过；未启动真实 Electron，未执行 git 写操作。
