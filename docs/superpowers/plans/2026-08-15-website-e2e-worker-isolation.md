# 网站 E2E Worker 隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将网站 Playwright E2E 从同一 worker 顺序复用改为最多两个隔离 worker 的用例级并行，并让阶段 0 完整网站链门稳定通过。

**Architecture:** 只修改网站专属 Playwright 调度配置，不改产品组件或业务断言。`fullyParallel: true` 让同一文件中的用例成为隔离并行组，`workers: 2` 限制最大资源占用；每个组继续复用现有 worker-scoped 随机端口服务器与内存 API 夹具。Node 配置契约测试锁定并行度、零重试和超时，阶段 0 范围守卫显式批准本规格、计划及网站 Playwright 配置。

**Tech Stack:** Node.js 24.18.0、pnpm 11.9.0、TypeScript 5.9.3、Playwright 1.61.1、Node `node:test`、PowerShell。

## Global Constraints

- 规格事实来源：`docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md`。
- 只允许修改网站 E2E 配置、网站验证基础设施和相应中文规格/计划；绝不修改桌面端、Electron E2E、Agent、文件工具或角色代码。
- 精确设置 `fullyParallel: true`、`workers: 2`、`retries: 0`、`timeout: 60_000`、`expect.timeout: 10_000`。
- 保留 `testDir: './e2e'`、`testMatch: 'website.spec.ts'`、现有 Desktop Chrome、中文 locale、视口、trace 和失败产物设置。
- 不提高 worker 数，不增加重试，不延长超时，不从 `verify:web-chain` 删除网站 E2E。
- 每个实现点执行 RED → GREEN；没有通过精确失败对、45 项网站 E2E 和完整网站链门，不得宣称完成。
- Git 提交只暂存本计划列出的隔离文件；保留当前 Task 4 runner 的未提交改动，由阶段 0 Task 4 独立复审和提交。
- 正式网站部署、远端数据和生产环境验收不在本计划范围。

---

### Task 1: 锁定网站 E2E 隔离配置与阶段范围

**Files:**
- Create: `tools/verification/playwright-website-config.test.mjs`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `tests/playwright.website.config.ts`
- Modify: `docs/superpowers/plans/2026-08-15-website-verification-foundation.md`

**Interfaces:**
- Consumes: Playwright 默认导出的 `PlaywrightTestConfig`、`classifyChangedPaths(paths: readonly string[])`、现有 worker-scoped `websiteServerInfo` fixture、阶段 0 固定差异基线 `0dab17de8863a7c726a5bb5fceff35a1713daad1`。
- Produces: 网站配置契约 `fullyParallel === true`、`workers === 2`、`retries === 0`、`timeout === 60_000`、`expect.timeout === 10_000`；范围守卫允许本规格、计划和 `tests/playwright.website.config.ts`。

- [ ] **Step 1: 写网站 Playwright 配置契约 RED**

创建 `tools/verification/playwright-website-config.test.mjs`：

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import websiteConfig from '../../tests/playwright.website.config.ts';

test('网站 E2E 使用两个隔离 worker 且不以重试或放宽超时掩盖失败', () => {
  assert.equal(websiteConfig.fullyParallel, true);
  assert.equal(websiteConfig.workers, 2);
  assert.equal(websiteConfig.retries, 0);
  assert.equal(websiteConfig.timeout, 60_000);
  assert.equal(websiteConfig.expect?.timeout, 10_000);
  assert.equal(websiteConfig.testDir, './e2e');
  assert.equal(websiteConfig.testMatch, 'website.spec.ts');
});
```

- [ ] **Step 2: 运行配置契约 RED**

Run:

```powershell
node --test tools/verification/playwright-website-config.test.mjs
```

Expected: FAIL；当前实际值为 `fullyParallel: false`、`workers: 1`，失败必须来自这两个隔离断言，而不是模块导入错误。

- [ ] **Step 3: 写范围守卫 RED**

在 `tools/verification/verify-website-scope.test.mjs` 增加：

```javascript
test('网站 E2E 隔离配置及其获批规格计划属于阶段 0 范围', () => {
  const paths = [
    'tests/playwright.website.config.ts',
    'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
  ];

  assert.deepEqual(classifyChangedPaths(paths), {
    allowed: paths,
    forbidden: [],
    outside: [],
  });
});
```

- [ ] **Step 4: 运行范围守卫 RED**

Run:

```powershell
node --test tools/verification/verify-website-scope.test.mjs
```

Expected: FAIL；三条路径当前进入 `outside`，没有任何路径进入 `forbidden`。

- [ ] **Step 5: 实现最小范围白名单**

在 `ALLOWED_WEBSITE_SCOPE_PATHS` 中精确追加，不使用更宽的 `tests/**` 或 `docs/**`：

```javascript
'tests/playwright.website.config.ts',
'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
```

不得修改 `FORBIDDEN_WEBSITE_SCOPE_PATHS`，尤其不得移除 `tests/playwright.config.ts`。

- [ ] **Step 6: 实现最小 Playwright 调度配置**

将 `tests/playwright.website.config.ts` 的配置头精确改为：

```typescript
// 网站 E2E 的并行用例各自启动随机端口服务器；最多两个 worker，避免共享 GPU 状态和无界资源占用。
export default defineConfig({
  testDir: './e2e',
  testMatch: 'website.spec.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
```

其余 `reporter`、`outputDir` 和 `use` 内容保持不变。

- [ ] **Step 7: 同步阶段 0 原计划的显式边界**

在 `docs/superpowers/plans/2026-08-15-website-verification-foundation.md` 的 Task 4 `Files` 增加：

```markdown
- Modify: `tests/playwright.website.config.ts`
- Create: `tools/verification/playwright-website-config.test.mjs`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
```

在 Task 4 Step 7 的预期结果后追加：

```markdown
网站 E2E 遵守 `2026-08-15-website-e2e-worker-isolation-design.md`：同一文件的用例以最多两个隔离 worker 运行，保持零重试和原超时；不得用 CLI 临时覆盖配置取得通过。
```

- [ ] **Step 8: 运行配置与范围 GREEN**

Run:

```powershell
node --test tools/verification/playwright-website-config.test.mjs
node --test tools/verification/verify-website-scope.test.mjs
node tools/verification/verify-website-scope.mjs
```

Expected: 配置契约 1/1 通过；范围守卫测试全部通过；真实范围守卫退出 0，且不报告桌面、Agent 或角色路径。

- [ ] **Step 9: 运行已锁定失败对回归**

Run:

```powershell
node node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --grep "安全共享包经系统与管理员审核后才在真实网页公开|介绍章节桌面悬停与键盘聚焦同步玻璃交互" --reporter=line
```

Expected: 不传 `--fully-parallel` 或 `--workers` CLI 覆盖；正式配置显示 `Running 2 tests using 2 workers`，2/2 通过。

- [ ] **Step 10: 运行完整网站 E2E**

Run:

```powershell
pnpm.cmd test:e2e:website
```

Expected: 网站静态构建成功；Playwright 输出完整 45 项汇总，45/45 通过，退出 0。若出现资源竞争，不增加 worker、重试或超时，停止并报告精确失败用例和 worker 证据。

- [ ] **Step 11: 运行完整网站链门**

Run:

```powershell
pnpm.cmd verify:web-chain
```

Expected: 20/20 步通过；`website-e2e` 输出 45/45；CloudBase 顺序保持 `cloudbase-build` → `cloudbase-build-output-test` → `cloudbase-build-tool-test`；不启动 Electron 或任何桌宠验证。

- [ ] **Step 12: 运行差异与格式检查**

Run:

```powershell
node --test tools/verification/*.test.mjs
git diff --check
git diff --name-only
```

Expected: 全部 verification `node:test` 通过；无空白错误；差异中没有 `tests/playwright.config.ts`、`tests/e2e/desktop.spec.ts`、`apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**` 或角色路径。

- [ ] **Step 13: 提交隔离变更**

只暂存本任务文件，不暂存当前 Task 4 runner 的 `package.json`、`web-chain-catalog.mjs`、`verify-web-chain.mjs` 或 `verify-web-chain.test.mjs`：

```powershell
git add tests/playwright.website.config.ts tools/verification/playwright-website-config.test.mjs tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md
git commit -m "test: 隔离网站 E2E worker"
```

Expected: 提交只包含上述五个路径；随后由阶段 0 Task 4 复审 `verify:web-chain` runner 并单独提交其四个文件。
