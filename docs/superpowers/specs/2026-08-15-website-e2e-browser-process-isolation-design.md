# 网站 E2E 浏览器进程隔离设计

**日期：** 2026-08-15

**状态：** 已证伪并退役

**适用范围：** `tests/e2e/website.spec.ts`、网站专属 Playwright 配置、阶段 0 网站链门禁

**不适用范围：** 桌面端、Electron E2E、Agent、文件工具、角色运行时、生产部署及远端数据

**退役说明：** 完整 E2E 在 15.6 分钟止损时为 `20 passed / 10 failed / 1 interrupted / 14 did not run`，测试级独立 Chromium fixture 未消除序列性 GPU stall。后继逐项 CLI 方案也已被真实验收证伪并退役；两个 fixture 文件于 2026-08-20 经用户二次批准后物理删除，不再存在后继隔离路径。

## 1. 背景与已证伪方案

阶段 0 的网站链完整门在单 Playwright worker 中运行 45 项网站 E2E。默认 `browser` fixture 是 worker-scoped，同一 worker 的所有用例复用一个 Chromium 进程；虽然每项测试已有独立 BrowserContext，前序 WebGL 页面仍会使后续页面出现 GPU stall，最终让对已存在 DOM 的读取耗尽 60 秒。

以下方案已经实际证伪，不再重试：

1. 关闭 trace：精确失败对仍超时。
2. 在 React cleanup 或 `pagehide` 主动调用 `WEBGL_lose_context`：精确失败对仍超时，试验代码已撤回。
3. `fullyParallel: true`、`workers: 1`：精确失败对仍超时。
4. `fullyParallel: true`、`workers: 2`：精确失败对 2/2 通过，但完整 45 项仍有至少四项约 60 秒失败，说明并行资源竞争或 worker 复用仍不能提供稳定门禁；实现已撤回且未提交。

原 `2026-08-15-website-e2e-worker-isolation-design.md` 与对应实施计划因此退役。本规格在网站 E2E 调度范围内替代它们。

## 2. 目标

1. 保持全部网站 E2E 串行执行，任一时刻最多存在一个测试用 Chromium 进程。
2. 只为实际请求 `page` 的用例启动独立 Chromium；每项用例结束后关闭该进程，下一项不得复用浏览器或 GPU 状态。
3. API-only 用例继续只使用 `request`，不为其启动无用浏览器。
4. 保持现有随机端口静态服务器、内存 API、测试断言、零重试、超时、locale、viewport、Desktop Chrome 上下文和失败 trace 语义。
5. 完整 45 项 E2E 与 `verify:web-chain` 必须一次运行得到完整汇总和退出码。

## 3. 非目标

- 不修改网站产品组件来迎合测试环境。
- 不增加 worker、重试或超时。
- 不拆散或弱化现有业务断言。
- 不把网站 E2E 从完整门移除。
- 不修改 `tests/playwright.config.ts`、桌面 E2E 或任何桌宠业务文件。
- 不在本阶段部署正式网站或声明生产环境上线。

## 4. 方案决策

### 4.1 采用：串行调度与 test-scoped Chromium

网站专属配置保持：

```typescript
fullyParallel: false,
workers: 1,
retries: 0,
timeout: 60_000,
expect: { timeout: 10_000 }
```

在 `website.spec.ts` 的测试类型中新增 test-scoped `isolatedBrowser` fixture。该 fixture 使用 Playwright 已配置的 Chromium BrowserType 启动一个浏览器，只服务当前测试，并在 `finally` 中关闭。网站测试覆盖内建 `page` fixture，使其从 `isolatedBrowser` 创建独立 context 与 page；不直接使用默认 worker-scoped `browser`。

唯一直接请求 `browser` 的液态玻璃 DPR 用例改为请求 `isolatedBrowser`，继续自行创建 `deviceScaleFactor: 2` 的 context。API-only 用例不依赖 `page` 或 `isolatedBrowser`，因此不会启动 Chromium。

### 4.2 不采用：每项测试独立 CLI 子进程

用 `--list`、shard 或源码行号把 45 项拆成 45 个 Playwright CLI 进程能获得最强隔离，但会新增测试发现、退出码聚合、日志聚合和动态测试数量维护职责。只有 test-scoped Chromium 仍不能稳定通过完整套件时，才另立规格考虑该方案。

### 4.3 拒绝：分批、重试或延长超时

按功能人工分批会随新增测试漂移；重试和延长超时只隐藏资源污染。这些手段均不得进入正式门。

## 5. Fixture 与数据流

```text
worker（固定 1 个）
  -> 随机端口静态服务器 + 内存 API（worker-scoped）
  -> test A（需要 page）
       -> isolatedBrowser A -> context A -> page A -> close A
  -> test B（仅 request）
       -> 不启动浏览器
  -> test C（需要 page）
       -> isolatedBrowser C -> context C -> page C -> close C
```

### 5.1 浏览器启动

- 只使用 Chromium，与当前网站配置一致。
- 启动参数继续来自 Playwright 的 `headless` 与 `launchOptions` 配置；不得硬编码调试参数、禁用 GPU 或 `--no-sandbox` 来制造通过。
- context 合并当前 Desktop Chrome 设备参数、`locale: 'zh-CN'`、`viewport: 1280x720` 与 worker 提供的 `baseURL`。
- 用例仍可通过 `page.setViewportSize()` 或专用 context 覆盖自身视口和 DPR。

### 5.2 trace 与失败产物

覆盖内建 `page` 后，不能假设 Playwright 自动追踪自建 context。fixture 必须在用例开始前为自建 context 启动截图、快照和源码 trace；用例失败时将 `trace.zip` 写入 `testInfo.outputPath()` 并通过 `testInfo.attach()` 挂到报告，成功时停止并丢弃 trace。

trace 只用于诊断，不改变用例通过条件。若 trace 本身停止失败，fixture 必须继续关闭 context 与浏览器，并把清理错误作为明确测试失败或附件错误报告，不能留下后台进程。

### 5.3 API 与服务器状态

- `websiteServerInfo` 继续保持 worker-scoped，使用 `PORT=0` 与独立 `WEBSITE_TEST_RUN_ID`。
- `beforeEach` 的 `/__e2e/reset` 保留，负责业务数据清理，不再承担浏览器或 GPU 隔离。
- page context 的 `baseURL` 必须使用同一 `websiteServerInfo.url`，确保 page 与 `request` 访问同一内存 API。

## 6. 清理与失败边界

fixture 的清理顺序固定为：

1. 停止或保存当前 context trace；
2. 关闭当前 BrowserContext；
3. 关闭当前 isolatedBrowser；
4. 返回下一个测试。

清理必须位于 `finally`，即使用例断言失败、取消或超时也执行。完整 E2E 后通过只读进程检查确认没有本工作区遗留的 Playwright、Chromium、网站导出或静态服务器进程；不得终止其他工作树或桌面 E2E 的进程。

若单个 browser close 超过现有测试清理预算，先记录精确 PID/命令行和 Playwright 错误；不得用无界等待。相关强制终止机制需要独立失败测试和规格，不在本方案中猜测加入。

## 7. 文件边界

预计修改或新增：

- `tests/e2e/website.spec.ts`：新增 test-scoped 浏览器、page 与 trace fixture，迁移唯一直接使用 `browser` 的网站用例；
- `tests/playwright.website.config.ts`：显式保持串行、单 worker、零重试，并更新中文结构性注释；
- 网站 fixture 单元测试或根 `node:test`：验证 API-only 不启动浏览器、page 用例每次新启/关闭浏览器、失败 trace 和清理顺序；
- `tools/verification/website-scope-policy.mjs` 及测试：精确允许本替代规格、计划和网站 E2E fixture/config 文件；
- 阶段 0 原计划、实施报告与验收记录：同步实际执行模型与证据。

不得修改：

- `tests/playwright.config.ts`；
- `tests/e2e/desktop.spec.ts`、`tests/e2e/agent-mcp-flow.spec.ts`；
- `apps/desktop/**`；
- `packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`。

## 8. TDD 与验收

### RED

1. fixture 契约测试证明当前 page 用例复用默认 worker browser，而不是 test-scoped browser。
2. 测试证明 API-only 用例不会触发浏览器启动。
3. 测试证明失败路径保存 trace，并按 trace → context → browser 顺序清理。
4. 使用原单 worker 配置稳定复现已锁定失败对。

### GREEN

1. fixture 单元/契约测试全部通过。
2. 锁定失败对在正式串行配置下 2/2 通过，不使用 worker、重试或超时 CLI 覆盖。
3. 完整 45 项网站 E2E 一次运行 45/45 通过并输出退出码 0。
4. 完整运行后没有本工作区遗留浏览器或静态服务器进程。
5. `pnpm.cmd verify:web-chain` 一次运行 20/20 步通过。
6. 网站范围守卫、测试归属、全部 verification `node:test` 与 `git diff --check` 通过。

若完整 45 项仍出现同类 GPU stall，本方案立即停止，不增加第三种局部清理。届时以“每项测试独立 Playwright CLI 子进程”另立规格。

## 9. 人工与部署边界

本规格只证明本地自动化门的浏览器进程隔离，不替代正式网站重新部署后的人工浏览器验收。生产部署、域名、CDN、CloudBase 生产数据和正式发布仍需后续独立批准与验收证据。
