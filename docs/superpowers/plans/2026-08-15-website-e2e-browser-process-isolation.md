# 网站 E2E 浏览器进程隔离实施计划

> **执行状态：已停止。** Task 1 已提交；Task 2 的完整 E2E 在 15.6 分钟止损时为 `20 passed / 10 failed / 1 interrupted / 14 did not run`，且未提交。测试级独立 Chromium fixture 已证伪，后续由 `2026-08-15-website-e2e-cli-process-isolation-design.md` 替代；本计划 Task 3 不再执行。

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 将官网 Playwright 页面测试改为“每个请求 `page` 的测试独占一个 Chromium 进程”，消除跨测试 GPU/WebGL 进程状态污染，同时保持 API-only 测试不启动浏览器、串行执行、零重试和现有 60 秒超时。

**Architecture:** 在 `tests/website-isolated-browser-fixture.ts` 中集中封装浏览器、上下文、追踪与清理生命周期；`tests/e2e/website.spec.ts` 仅注册并消费该 fixture，不把资源管理散落到各测试。每个页面测试按 `trace → context → browser` 顺序清理；失败测试保存并附加 trace，成功测试丢弃 trace。现有网站验证 runner、桌宠代码和产品运行时代码均不修改。

**Tech Stack:** TypeScript、Playwright Test、Node.js 24 test runner、pnpm workspace、PowerShell。

---

## 全局约束

- 只允许修改本计划列出的官网 E2E、验证治理和中文文档文件；绝不修改 `apps/desktop/**`、桌宠业务代码或产品 WebGL 实现。
- 遵循 RED → GREEN → REFACTOR；每次只实现使当前测试通过的最小代码。
- 保持 `fullyParallel: false`、`workers: 1`、`retries: 0`、测试超时 `60_000ms`、断言超时 `10_000ms`。
- 复用 Playwright 自带 Chromium 与 `devices['Desktop Chrome']`；不新增 npm 依赖，不引入第二套测试框架。
- 不修改当前未提交的 Phase 0 Task 4 文件：`package.json`、`tools/verification/web-chain-catalog.mjs`、`tools/verification/verify-web-chain.mjs`、`tools/verification/verify-web-chain.test.mjs`。
- 任一命令或单一故障调查累计达到 15 分钟仍无结论时，终止对应进程树并记录证据，不继续重复同一路径；转入规格规定的“每测试独立 CLI 进程”新方案评审，不在本计划内临时扩大 worker、重试或超时。
- Git 提交只包含当前任务精确文件，禁止 `git add .`、`git add -A`，不得覆盖用户已有改动。

### Task 1: 建立可单测的隔离浏览器生命周期模块

**Files:**
- Create: `tests/website-isolated-browser-fixture.ts`
- Create: `tools/verification/website-isolated-browser-fixture.test.mjs`

**Step 1: 编写浏览器生命周期失败测试**

创建 `tools/verification/website-isolated-browser-fixture.test.mjs`，先覆盖以下契约：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBSITE_BROWSER_CONTEXT_OPTIONS,
  useIsolatedBrowser,
  useIsolatedPage,
} from '../../tests/website-isolated-browser-fixture.ts';

test('每次调用都启动并关闭独立浏览器，且保留既有启动参数', async () => {
  const events = [];
  const browser = {
    async close() {
      events.push('browser.close');
    },
  };
  const browserType = {
    async launch(options) {
      events.push(['browser.launch', options]);
      return browser;
    },
  };

  await useIsolatedBrowser(
    {
      browserType,
      headless: true,
      launchOptions: { args: ['--disable-dev-shm-usage'] },
    },
    async (actualBrowser) => {
      assert.equal(actualBrowser, browser);
      events.push('use.browser');
    },
  );

  assert.deepEqual(events, [
    ['browser.launch', { args: ['--disable-dev-shm-usage'], headless: true }],
    'use.browser',
    'browser.close',
  ]);
});

test('页面成功时丢弃追踪，并按 tracing、context 顺序清理', async () => {
  // 使用最小 fake browser/context/testInfo，断言 Desktop Chrome、zh-CN、baseURL
  // 被传给 newContext，且事件顺序为 tracing.start → newPage → use.page
  // → tracing.stop → context.close。
});

test('页面失败时保存并附加追踪后再关闭上下文', async () => {
  // 令 use(page) 抛出固定错误，并把 testInfo.status 设为 timedOut、
  // expectedStatus 设为 passed；断言 outputPath('trace.zip')、
  // tracing.stop({ path })、attach('trace', ...) 与清理顺序。
});

test('主流程和清理同时失败时保留全部错误证据', async () => {
  // 断言返回 AggregateError，errors 同时包含 use 错误与 cleanup 错误。
});
```

测试 fake 只实现当前 helper 实际调用的方法，不启动真实浏览器。第二、三项测试必须精确断言：

- `WEBSITE_BROWSER_CONTEXT_OPTIONS` 包含 Desktop Chrome 的 `userAgent`、`viewport`、`screen`、`deviceScaleFactor`、`isMobile`、`hasTouch`，并覆盖 `locale: 'zh-CN'`；
- `baseURL` 由当前 Playwright project 注入，不在模块中硬编码；
- 失败 trace 的 `contentType` 为 `application/zip`。

**Step 2: 运行测试并确认 RED**

Run:

```powershell
node.exe --test tools/verification/website-isolated-browser-fixture.test.mjs
```

Expected: FAIL，首个原因是 `tests/website-isolated-browser-fixture.ts` 不存在或缺少预期导出，而不是测试语法错误。

**Step 3: 编写最小生命周期实现**

创建 `tests/website-isolated-browser-fixture.ts`，导出以下稳定接口：

```ts
import {
  devices,
  type Browser,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
  type TestInfo,
} from '@playwright/test';

const { defaultBrowserType: _defaultBrowserType, ...desktopChrome } =
  devices['Desktop Chrome'];

export const WEBSITE_BROWSER_CONTEXT_OPTIONS = Object.freeze({
  ...desktopChrome,
  locale: 'zh-CN',
}) satisfies Readonly<BrowserContextOptions>;

interface IsolatedBrowserInput {
  browserType: BrowserType;
  headless: boolean;
  launchOptions: Parameters<BrowserType['launch']>[0];
}

interface IsolatedPageInput {
  browser: Browser;
  baseURL: string | undefined;
  testInfo: TestInfo;
}

export async function useIsolatedBrowser(
  input: IsolatedBrowserInput,
  use: (browser: Browser) => Promise<void>,
): Promise<void>;

export async function useIsolatedPage(
  input: IsolatedPageInput,
  use: (page: Page) => Promise<void>,
): Promise<void>;
```

实现要求：

1. `useIsolatedBrowser` 调用 `browserType.launch({ ...launchOptions, headless })`；即使 `use` 失败也关闭浏览器。
2. `useIsolatedPage` 调用 `browser.newContext({ ...WEBSITE_BROWSER_CONTEXT_OPTIONS, baseURL })`，随后启动 `screenshots: true`、`snapshots: true`、`sources: true` 的 trace 并创建页面。
3. 成功时 `tracing.stop()` 不落盘；`testInfo.status !== testInfo.expectedStatus` 时先写入 `testInfo.outputPath('trace.zip')`，再用 `testInfo.attach('trace', { path, contentType: 'application/zip' })` 附加。
4. 清理顺序固定为 trace、context；外层 fixture 随后关闭 browser。
5. 主流程错误与清理错误分别收集；只有一个错误时原样抛出，存在多个错误时抛出 `AggregateError`，不得因清理失败吞掉原始测试错误。
6. 仅添加解释资源所有权、诊断证据与失败边界的中文结构性注释。

**Step 4: 运行测试并确认 GREEN**

Run:

```powershell
node.exe --test tools/verification/website-isolated-browser-fixture.test.mjs
```

Expected: 4/4 PASS，退出码 0。

**Step 5: 运行官网 TypeScript 检查**

Run:

```powershell
pnpm.cmd --filter @ai-pet/website typecheck
```

Expected: PASS，退出码 0。

**Step 6: 检查差异并提交 Task 1**

Run:

```powershell
git diff --check -- tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
git diff -- tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
git add -- tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
git commit -m "test: 建立网站 E2E 浏览器隔离夹具"
```

Expected: 只提交这两个文件；现有 Phase 0 Task 4 差异仍保持未暂存。

### Task 2: 接入页面测试并锁定网站分支范围

**Files:**
- Modify: `tests/e2e/website.spec.ts`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `docs/superpowers/plans/2026-08-15-website-verification-foundation.md`

**Step 1: 记录串行复现 RED**

在改动 `website.spec.ts` 前运行已知最小复现：

```powershell
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --grep "安全共享包经系统与管理员审核后才在真实网页公开|介绍章节桌面悬停与键盘聚焦同步玻璃交互"
```

Expected: `Running 2 tests using 1 worker`；第一项通过，第二项约 60 秒超时失败。若两项意外全部通过，立即连续复跑一次；第二次仍全绿则停止实现并记录环境变化，不用未经复现的修复改写测试基础设施。

**Step 2: 先为新增官网路径写范围守卫测试**

在 `tools/verification/verify-website-scope.test.mjs` 增加精确断言：

```js
assert.equal(isAllowedWebsiteScopePath('tests/e2e/website.spec.ts'), true);
assert.equal(isAllowedWebsiteScopePath('tests/website-isolated-browser-fixture.ts'), true);
assert.equal(
  isAllowedWebsiteScopePath(
    'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
  ),
  true,
);
assert.equal(
  isAllowedWebsiteScopePath(
    'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
  ),
  true,
);
assert.equal(isAllowedWebsiteScopePath('tests/e2e/desktop.spec.ts'), false);
```

Run:

```powershell
node.exe --test tools/verification/verify-website-scope.test.mjs
```

Expected: FAIL，原因是新增官网 E2E、fixture、规格或计划路径尚未进入允许清单；桌宠路径仍被拒绝。

**Step 3: 最小扩展网站范围白名单**

在 `tools/verification/website-scope-policy.mjs` 仅加入以下精确路径：

```js
'tests/e2e/website.spec.ts',
'tests/website-isolated-browser-fixture.ts',
'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
```

不得放宽为整个 `tests/e2e/**`，不得允许任何桌面测试或桌宠代码路径。

Run:

```powershell
node.exe --test tools/verification/verify-website-scope.test.mjs
```

Expected: PASS，退出码 0。

**Step 4: 在官网 E2E 注册测试级隔离 fixture**

在 `tests/e2e/website.spec.ts`：

1. 从 `@playwright/test` 增加 `Browser` 类型导入；
2. 导入 `useIsolatedBrowser` 与 `useIsolatedPage`；
3. 在既有网站服务器 worker fixture 外层增加测试级 fixture：

```ts
type WebsiteTestFixtures = {
  isolatedBrowser: Browser;
};

const isolatedBrowserTest = baseTest.extend<WebsiteTestFixtures>({
  isolatedBrowser: async (
    { playwright, headless, launchOptions },
    use,
  ) => {
    await useIsolatedBrowser(
      {
        browserType: playwright.chromium,
        headless,
        launchOptions,
      },
      use,
    );
  },
  page: async ({ isolatedBrowser, baseURL }, use, testInfo) => {
    await useIsolatedPage(
      {
        browser: isolatedBrowser,
        baseURL,
        testInfo,
      },
      use,
    );
  },
});

const test = isolatedBrowserTest.extend<
  {},
  { websiteServerInfo: WebsiteServerInfo }
>({
  // 保留既有 websiteServerInfo 与 baseURL 实现。
});
```

4. 把设备像素比专项测试的参数从 `{ browser, baseURL }` 改为 `{ isolatedBrowser, baseURL }`，并用 `isolatedBrowser.newContext(...)` 创建其专用 DPR 上下文；其他测试不逐项改写。
5. 不覆盖 `request` fixture。Playwright fixture 按需解析，因此 API-only 测试没有 `page` 依赖时不会请求 `isolatedBrowser`，也不会启动 Chromium。
6. 不修改 `tests/playwright.website.config.ts`：其串行、单 worker、零重试和现有超时已经符合获批规格。

**Step 5: 运行模块、范围与类型定向验证**

Run:

```powershell
node.exe --test tools/verification/website-isolated-browser-fixture.test.mjs tools/verification/verify-website-scope.test.mjs
pnpm.cmd --filter @ai-pet/website typecheck
```

Expected: 两组 Node 测试全部 PASS；官网 typecheck PASS。

**Step 6: 运行锁定串行回归**

Run:

```powershell
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --grep "安全共享包经系统与管理员审核后才在真实网页公开|介绍章节桌面悬停与键盘聚焦同步玻璃交互"
```

Expected: 输出 `Running 2 tests using 1 worker`，2/2 PASS；不得出现 retry、提高 worker 或放宽超时。

随后运行一个 API-only 用例，确认其仍可单独执行：

```powershell
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --grep "反馈列表 API 支持状态筛选与分页"
```

Expected: 1/1 PASS。结合 fixture 的按需依赖关系复核，确认该测试没有请求 `page` 或 `isolatedBrowser`。

**Step 7: 更新 Phase 0 执行台账**

修改 `docs/superpowers/plans/2026-08-15-website-verification-foundation.md`：

- 把 Task 4 的 E2E 隔离方式更新为“测试级独立 Chromium 进程”；
- 明确页面测试独占浏览器、API-only 测试不启动浏览器；
- 记录双 worker 方案已证伪，不再作为有效执行路径；
- 不把尚未运行的完整 E2E 或 full chain 写为通过。

**Step 8: 运行完整官网 E2E，执行 15 分钟止损**

使用可续读后台会话执行：

```powershell
pnpm.cmd test:e2e:website
```

Expected: 静态构建成功，输出 `Running 45 tests using 1 worker`，45/45 PASS，退出码 0。

每 30–60 秒读取一次输出；若总时长达到 15 分钟仍未结束，立即终止此次命令及其当前工作区子进程树，保留最后通过项、首个失败/卡点和 trace 路径。不得在本计划内增加 worker、retry、timeout 或再次修改产品 WebGL 代码。

E2E 结束后只读检查残留进程：

```powershell
$workspacePath = 'C:\Users\Administrator\.codex\worktrees\3bfd\myself'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(chrome|msedge|playwright|node)(\.exe)?$' -and
    $_.CommandLine -like "*$workspacePath*"
  } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

Expected: 不存在由本次官网 E2E 遗留且命令行指向当前工作区的浏览器或 Node 进程。若存在，记录 PID 与命令行并判定清理验收失败，不直接删除用户无关进程。

**Step 9: 运行完整网站验证链**

在 Phase 0 Task 4 runner 文件保持当前实现的前提下运行：

```powershell
pnpm.cmd verify:web:full
```

Expected: 20/20 步骤 PASS，退出码 0；最后官网 E2E 为 45/45 PASS。命令达到 15 分钟仍未结束时采用与 Step 8 相同的止损和证据记录规则。

**Step 10: 检查范围、差异与提交 Task 2**

Run:

```powershell
node.exe tools/verification/verify-website-scope.mjs --base=0dab17de8863a7c726a5bb5fceff35a1713daad1 --head=HEAD --include-working-tree
git diff --check -- tests/e2e/website.spec.ts tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md
git diff -- tests/e2e/website.spec.ts tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md
git add -- tests/e2e/website.spec.ts tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md
git commit -m "fix: 隔离网站 E2E 浏览器进程"
```

Expected:

- 范围守卫 PASS，且仍拒绝桌宠路径；
- `git diff --check` 无输出；
- 只提交上述四个文件；
- Phase 0 Task 4 的四个既有未提交文件仍未暂存。

### Task 3: 完成 Phase 0 Task 4 验收、报告与独立提交

**Files:**
- Modify: `.superpowers/sdd/2026-08-15-website-verification-foundation/task-4-report.md`
- Existing uncommitted: `package.json`
- Existing uncommitted: `tools/verification/web-chain-catalog.mjs`
- Existing uncommitted: `tools/verification/verify-web-chain.mjs`
- Existing uncommitted: `tools/verification/verify-web-chain.test.mjs`

**Step 1: 复核运行证据并更新 Task 4 报告**

仅当 Task 2 的完整 E2E 与 `verify:web:full` 确实退出 0 后，更新 Task 4 报告，记录：

- runner 单测 4/4；
- verification Node 测试 23/23；
- fast chain 15/15；
- full chain 20/20；
- 官网 E2E 45/45；
- 测试级独立 Chromium 进程是解决复用浏览器 GPU 状态污染的最终路径；
- 真实生产部署仍不在本次范围，正式网站重新部署与人工验收继续待后续阶段执行。

若任一验证失败，报告如实写失败与首个证据，不写“达标”或“完成”。

**Step 2: 复跑 Task 4 最小验证集**

Run:

```powershell
node.exe --test tools/verification/*.test.mjs
pnpm.cmd verify:web:fast
```

Expected: verification Node 测试全部 PASS；fast chain 15/15 PASS。

**Step 3: 检查 Task 4 精确差异并提交**

Run:

```powershell
git diff --check -- package.json tools/verification/web-chain-catalog.mjs tools/verification/verify-web-chain.mjs tools/verification/verify-web-chain.test.mjs .superpowers/sdd/2026-08-15-website-verification-foundation/task-4-report.md
git diff -- package.json tools/verification/web-chain-catalog.mjs tools/verification/verify-web-chain.mjs tools/verification/verify-web-chain.test.mjs .superpowers/sdd/2026-08-15-website-verification-foundation/task-4-report.md
git add -- package.json tools/verification/web-chain-catalog.mjs tools/verification/verify-web-chain.mjs tools/verification/verify-web-chain.test.mjs .superpowers/sdd/2026-08-15-website-verification-foundation/task-4-report.md
git commit -m "build: 建立网站统一验证入口"
```

Expected: 只提交 Task 4 runner 与其报告，不混入 E2E fixture、失败方案或桌宠文件。

**Step 4: 最终只读审计**

Run:

```powershell
git status --short
git log --oneline -8
node.exe tools/verification/verify-website-scope.mjs --base=0dab17de8863a7c726a5bb5fceff35a1713daad1 --head=HEAD --include-working-tree
```

Expected:

- 工作区没有本计划遗留的未提交文件；若仍有用户原有差异，逐项列出且不改动；
- 最新提交按顺序包含 fixture、E2E 接入、Task 4 runner；
- 网站范围守卫 PASS；
- 正式网站生产部署仍明确标记为下一阶段，不因测试版或本地验证通过而宣称已上线。
