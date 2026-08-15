# Website E2E CLI Process Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网站只构建一次，并把当前全部 Playwright E2E 逐项放入独立 CLI 进程，在 15 分钟内得到可审计的完整汇总与退出码。

**Architecture:** 新增一个无第三方依赖的 Node 编排器，使用 Playwright 1.61.1 官方 `--list` 发现测试、用单项 `--test-list` 顺序启动独立 CLI，并为每项分配独立产物目录。纯清单/参数契约与异步进程生命周期分两次 TDD 和审查；只有直接运行编排器完成 45/45 后才切换根脚本、删除已证伪 fixture 并运行完整网站链。

**Tech Stack:** Node.js 24、原生 `node:test`、Playwright Test 1.61.1、pnpm workspace、PowerShell、Windows `taskkill.exe`。

## Global Constraints

- 只允许修改本计划列出的官网 E2E 调度、验证治理和中文文档；绝不修改 `apps/desktop/**`、桌宠业务代码、网站产品组件或 WebGL 实现。
- 网站 E2E 保持 `fullyParallel: false`、`workers: 1`、`retries: 0`、测试超时 `60_000ms`、断言超时 `10_000ms`。
- 全部测试都逐项进入独立 Playwright CLI，包括 API-only 与不请求浏览器的 helper 测试；不得保留第二条批量执行路径。
- Playwright 清单选择只使用 `--list` 与 `--test-list`；不得使用 `--grep`、shard、固定标题数组、固定源码行号数组或 `--pass-with-no-tests` 作为正式调度协议。
- 单项 CLI 墙钟上限 `90_000ms`，整轮上限 `900_000ms`；达到任一上限时当前项为 interrupted、剩余项为 not run，不提高 Playwright 内部超时。
- Windows 只能终止编排器刚启动并持有 PID 的当前子进程树；不得扫描或批量终止其他 Node、Chrome、Playwright 或其他工作区进程。
- 不新增 npm 依赖，不调用 Playwright 非公开 runner API，不拆分或改写 `tests/e2e/website.spec.ts`。
- 当前受保护的 Phase 0 Task 4 差异是 `package.json` 中四个 `verify:web-chain*` 脚本、`tools/verification/web-chain-catalog.mjs`、`tools/verification/verify-web-chain.mjs`、`tools/verification/verify-web-chain.test.mjs`；不得覆盖、暂存或混入本计划提交。
- `tests/e2e/website.spec.ts` 当前只有 Windows 索引时间戳状态，工作树 blob 与 `HEAD` 相同；不得借机重写或提交该文件。
- 任一命令或单一问题达到 15 分钟仍未完成时立即终止精确进程树并记录证据；不得重复同一路径或放宽 worker、retry、timeout。
- 当前计划只执行 Tasks 1—4。它不得读写 foundation 计划的 `.superpowers/sdd/` 工作区；完整门通过后由原 foundation 计划所有者更新 Task 4 报告并提交既有 runner。
- Git 只精确暂存当前任务文件；禁止 `git add .` 与 `git add -A`。`package.json` 必须逐 hunk 暂存并验证缓存差异。
- 正式网站重新部署、域名/CDN、CloudBase 生产数据与上线后人工验收不在本计划范围。

---

### Task 1: 锁定测试清单解析与单项命令契约

**Files:**
- Create: `tools/verification/run-website-e2e-process-isolation.mjs`
- Create: `tools/verification/run-website-e2e-process-isolation.test.mjs`

**Interfaces:**
- Consumes: Playwright `--list` 的标准文本输出；仓库内 `node_modules/@playwright/test/cli.js` 与 `tests/playwright.website.config.ts` 的绝对路径。
- Produces: `parseWebsiteTestList(output: string): readonly string[]`。
- Produces: `createWebsiteTestInvocation(input: { testListPath: string; outputDirectory: string }): { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }`。
- Produces: 常量 `WEBSITE_E2E_ITEM_TIMEOUT_MS = 90_000`、`WEBSITE_E2E_TOTAL_TIMEOUT_MS = 900_000`、`WEBSITE_E2E_OUTPUT_ROOT`。

- [ ] **Step 1: 写清单解析 RED**

创建 `tools/verification/run-website-e2e-process-isolation.test.mjs`，使用手工固定输入，不调用实现生成期望值：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebsiteTestInvocation,
  parseWebsiteTestList,
  WEBSITE_E2E_ITEM_TIMEOUT_MS,
  WEBSITE_E2E_TOTAL_TIMEOUT_MS,
} from './run-website-e2e-process-isolation.mjs';

const listedTests = `Listing tests:
  website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开
  website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互
Total: 2 tests in 1 file\n`;

test('解析 Playwright 标准清单并保留完整中文测试描述', () => {
  assert.deepEqual(parseWebsiteTestList(listedTests), [
    'website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开',
    'website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互',
  ]);
});

test('拒绝空清单、重复描述、畸形行和总数不一致', () => {
  assert.throws(() => parseWebsiteTestList('Listing tests:\nTotal: 0 tests in 0 files\n'), /没有发现网站 E2E/u);
  assert.throws(() => parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /重复/u);
  assert.throws(() => parseWebsiteTestList(`Listing tests:\n  不是标准测试描述\nTotal: 1 test in 1 file\n`), /无法解析/u);
  assert.throws(() => parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /总数/u);
});
```

该测试能捕获的生产缺陷必须明确写进 Task 1 报告：错误地接受空清单、把标题行当测试、丢失中文标题、重复运行同一描述或忽略 Playwright 汇总数量。

- [ ] **Step 2: 运行并确认清单解析 RED**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: FAIL，首个原因是目标模块不存在或缺少导出；不得是测试语法错误。

- [ ] **Step 3: 实现最小清单解析**

在 `run-website-e2e-process-isolation.mjs` 使用以下约束实现；错误消息必须为中文并包含失败类别：

```js
export const WEBSITE_E2E_ITEM_TIMEOUT_MS = 90_000;
export const WEBSITE_E2E_TOTAL_TIMEOUT_MS = 900_000;

const TEST_DESCRIPTION = /^\S.+:\d+:\d+\s+›\s+.+$/u;
const TOTAL_LINE = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?$/u;

export function parseWebsiteTestList(output) {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const start = lines.indexOf('Listing tests:');
  if (start < 0) throw new Error('无法解析网站 E2E 清单：缺少 Listing tests 标题');

  const totalIndex = lines.findIndex((line, index) => index > start && TOTAL_LINE.test(line));
  if (totalIndex < 0) throw new Error('无法解析网站 E2E 清单：缺少 Total 汇总');

  const descriptions = lines.slice(start + 1, totalIndex);
  const malformed = descriptions.find(line => !TEST_DESCRIPTION.test(line));
  if (malformed) throw new Error(`无法解析网站 E2E 测试描述：${malformed}`);
  if (descriptions.length === 0) throw new Error('没有发现网站 E2E 测试');
  if (new Set(descriptions).size !== descriptions.length) throw new Error('网站 E2E 清单包含重复测试描述');

  const expectedCount = Number(TOTAL_LINE.exec(lines[totalIndex])?.[1]);
  if (expectedCount !== descriptions.length) {
    throw new Error(`网站 E2E 清单总数不一致：发现 ${descriptions.length}，汇总 ${expectedCount}`);
  }
  return Object.freeze([...descriptions]);
}
```

不得解析 `website.spec.ts` 源码，也不得把当前 `45` 写进生产实现。

- [ ] **Step 4: 写单项命令 RED**

追加行为测试：

```js
test('单项命令只使用网站配置、test-list 和独立输出目录', () => {
  const invocation = createWebsiteTestInvocation({
    testListPath: 'C:\\Temp\\website-e2e\\current.txt',
    outputDirectory: 'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  });

  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [
    'test',
    '--config',
    'tests/playwright.website.config.ts',
    '--test-list',
    'C:\\Temp\\website-e2e\\current.txt',
    '--output',
    'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  ]);
  assert.equal(invocation.args[0].endsWith('node_modules\\@playwright\\test\\cli.js') || invocation.args[0].endsWith('node_modules/@playwright/test/cli.js'), true);
  assert.equal(invocation.args.includes('--grep'), false);
  assert.equal(invocation.args.includes('--shard'), false);
  assert.equal(invocation.args.includes('--pass-with-no-tests'), false);
  assert.equal(invocation.env.NO_COLOR, '1');
  assert.equal(invocation.env.FORCE_COLOR, '0');
  assert.equal(WEBSITE_E2E_ITEM_TIMEOUT_MS, 90_000);
  assert.equal(WEBSITE_E2E_TOTAL_TIMEOUT_MS, 900_000);
});
```

- [ ] **Step 5: 运行并确认命令契约 RED**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: 清单测试通过，命令测试因 `createWebsiteTestInvocation` 不存在而 FAIL。

- [ ] **Step 6: 实现单项命令构造**

使用 `fileURLToPath(new URL('../../', import.meta.url))` 得到仓库根，导出稳定产物根，并实现：

```js
export const WEBSITE_E2E_OUTPUT_ROOT = resolve(
  repositoryRoot,
  'tests/.playwright-output/website-process-isolation',
);

export function createWebsiteTestInvocation({ testListPath, outputDirectory }) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      resolve(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'tests/playwright.website.config.ts',
      '--test-list',
      testListPath,
      '--output',
      outputDirectory,
    ]),
    env: Object.freeze({ ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }),
  });
}
```

结构性中文注释只解释官方 test-list 选择、不使用标题正则和每项独立产物目录的原因。

- [ ] **Step 7: 运行 Task 1 GREEN 与真实清单探针**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
node.exe --input-type=module -e "import { parseWebsiteTestList } from './tools/verification/run-website-e2e-process-isolation.mjs'; import { execFileSync } from 'node:child_process'; const text=execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tests/playwright.website.config.ts','--list'],{encoding:'utf8',env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}}); const tests=parseWebsiteTestList(text); console.log(JSON.stringify({count:tests.length,first:tests[0],last:tests.at(-1)}));"
```

Expected: Node 单测全部 PASS；真实清单输出 `count: 45`，首尾描述对应当前 `website.spec.ts`，且没有运行网站测试或启动浏览器。

- [ ] **Step 8: 检查并提交 Task 1**

Run:

```powershell
git diff --check -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git diff -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git add -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git commit -m "test: 锁定网站 E2E 逐项进程契约"
```

Expected: 只提交两个编排器文件；受保护 Task 4 差异仍未暂存。

### Task 2: 实现串行状态机与精确进程清理

**Files:**
- Modify: `tools/verification/run-website-e2e-process-isolation.mjs`
- Modify: `tools/verification/run-website-e2e-process-isolation.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `parseWebsiteTestList`、`createWebsiteTestInvocation` 与三个常量。
- Produces: `runWebsiteTestSequence(input: WebsiteSequenceInput, dependencies: WebsiteSequenceDependencies): Promise<WebsiteRunSummary>`。
- Produces: `executeOwnedProcess(invocation: WebsiteInvocation, timeoutMs: number, dependencies?: OwnedProcessDependencies): Promise<{ exitCode: number | null; timedOut: boolean }>`。
- Produces: `terminateOwnedProcessTree(child: ChildProcess, dependencies?: TerminationDependencies): Promise<void>`。

`WebsiteRunSummary` 精确形状：

```js
{
  discovered: number,
  passed: number,
  failed: number,
  interrupted: number,
  notRun: number,
  durationMs: number,
  exitCode: 0 | 1,
  results: readonly Array<{
    index: number,
    description: string,
    outputDirectory: string,
    status: 'passed' | 'failed' | 'interrupted',
    exitCode: number | null,
    durationMs: number,
  }>,
}
```

- [ ] **Step 1: 写顺序、失败继续和汇总 RED**

追加以下测试；`executeTest` 是边界 fake，测试断言编排器的真实顺序、输入文件内容和汇总，不断言 fake 自身存在：

```js
test('逐项串行执行且普通失败后继续并返回完整汇总', async () => {
  const events = [];
  let active = 0;
  const descriptions = [
    'website.spec.ts:1:1 › A',
    'website.spec.ts:2:1 › B',
    'website.spec.ts:3:1 › C',
  ];

  const summary = await runWebsiteTestSequence({
    descriptions,
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: (() => { let value = 0; return () => (value += 10); })(),
    writeTestList: async (_path, description) => events.push(['write', description]),
    writeProgress: line => events.push(['progress', line]),
    executeTest: async ({ description, timeoutMs }) => {
      active += 1;
      assert.equal(active, 1);
      events.push(['start', description, timeoutMs]);
      active -= 1;
      return { exitCode: description.endsWith('B') ? 1 : 0, timedOut: false };
    },
  });

  assert.deepEqual(summary, {
    discovered: 3,
    passed: 2,
    failed: 1,
    interrupted: 0,
    notRun: 0,
    durationMs: 100,
    exitCode: 1,
    results: [
      { index: 1, description: descriptions[0], outputDirectory: 'C:\\output\\001', status: 'passed', exitCode: 0, durationMs: 10 },
      { index: 2, description: descriptions[1], outputDirectory: 'C:\\output\\002', status: 'failed', exitCode: 1, durationMs: 10 },
      { index: 3, description: descriptions[2], outputDirectory: 'C:\\output\\003', status: 'passed', exitCode: 0, durationMs: 10 },
    ],
  });
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ['progress', `[1/3] start: ${descriptions[0]}`], ['write', `${descriptions[0]}\n`], ['start', descriptions[0]],
    ['progress', `[1/3] passed: ${descriptions[0]}`],
    ['progress', `[2/3] start: ${descriptions[1]}`], ['write', `${descriptions[1]}\n`], ['start', descriptions[1]],
    ['progress', `[2/3] failed: ${descriptions[1]}`],
    ['progress', `[3/3] start: ${descriptions[2]}`], ['write', `${descriptions[2]}\n`], ['start', descriptions[2]],
    ['progress', `[3/3] passed: ${descriptions[2]}`],
  ]);
});
```

- [ ] **Step 2: 写单项/全局超时 RED**

追加两个独立测试：

```js
test('单项超时后停止且把剩余项记为 not run', async () => {
  const descriptions = ['website.spec.ts:1:1 › A', 'website.spec.ts:2:1 › B'];
  const summary = await runWebsiteTestSequence({
    descriptions,
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: () => 0,
    writeTestList: async () => {},
    executeTest: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 90_000);
      return { exitCode: null, timedOut: true };
    },
  });
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.notRun, 1);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.exitCode, 1);
});

test('全局剩余预算限制当前项并在耗尽后停止', async () => {
  const times = [0, 899_950, 899_960, 900_000];
  const observedTimeouts = [];
  const summary = await runWebsiteTestSequence({
    descriptions: ['website.spec.ts:1:1 › A', 'website.spec.ts:2:1 › B'],
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: () => times.shift() ?? 900_000,
    writeTestList: async () => {},
    executeTest: async ({ timeoutMs }) => {
      observedTimeouts.push(timeoutMs);
      return { exitCode: null, timedOut: true };
    },
  });
  assert.deepEqual(observedTimeouts, [50]);
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.notRun, 1);
});
```

- [ ] **Step 3: 运行并确认序列 RED**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: Task 1 测试通过；新测试因 `runWebsiteTestSequence` 不存在而 FAIL。

- [ ] **Step 4: 实现最小顺序状态机**

实现必须遵循以下代码骨架，不增加并行、重试或过滤选项：

```js
export async function runWebsiteTestSequence(input, dependencies) {
  const startedAt = input.startedAtMs ?? dependencies.now();
  const results = [];

  for (const [offset, description] of input.descriptions.entries()) {
    const elapsed = dependencies.now() - startedAt;
    const remaining = WEBSITE_E2E_TOTAL_TIMEOUT_MS - elapsed;
    if (remaining <= 0) break;

    const index = offset + 1;
    const outputDirectory = resolve(input.outputRoot, String(index).padStart(3, '0'));
    dependencies.writeProgress?.(`[${index}/${input.descriptions.length}] start: ${description}`);
    await dependencies.writeTestList(input.testListPath, `${description}\n`);
    const itemStartedAt = dependencies.now();
    const outcome = await dependencies.executeTest({
      index,
      description,
      outputDirectory,
      timeoutMs: Math.min(WEBSITE_E2E_ITEM_TIMEOUT_MS, remaining),
    });
    const status = outcome.timedOut ? 'interrupted' : outcome.exitCode === 0 ? 'passed' : 'failed';
    results.push(Object.freeze({
      index,
      description,
      outputDirectory,
      status,
      exitCode: outcome.exitCode,
      durationMs: dependencies.now() - itemStartedAt,
    }));
    dependencies.writeProgress?.(`[${index}/${input.descriptions.length}] ${status}: ${description}`);
    if (status === 'interrupted') break;
  }

  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const interrupted = results.filter(result => result.status === 'interrupted').length;
  const notRun = input.descriptions.length - results.length;
  return Object.freeze({
    discovered: input.descriptions.length,
    passed,
    failed,
    interrupted,
    notRun,
    durationMs: dependencies.now() - startedAt,
    exitCode: passed === input.descriptions.length ? 0 : 1,
    results: Object.freeze(results),
  });
}
```

用中文结构性注释解释“普通失败继续、超时停止”的不同语义。

- [ ] **Step 5: 写精确子进程终止 RED**

追加测试覆盖：

1. 子进程在超时前退出时不得调用终止器，返回真实退出码；
2. 超时时必须把当前 `child` 对象传给 `terminateOwnedProcessTree`，等待终止器完成后返回 `{ exitCode: null, timedOut: true }`；
3. `child.pid` 缺失时终止器必须拒绝，且不得启动 `taskkill.exe`；
4. Windows 终止只启动 `taskkill.exe /PID <当前 PID> /T /F`，`shell: false`、`stdio: 'ignore'`；
5. `taskkill` 成功后仍等待原 child 的 `exit`；原 child 已退出时直接收敛，5 秒内仍不退出则返回明确中文错误；
6. `taskkill` 非零、启动错误或 5 秒内不退出时，返回明确中文错误，不扫描其他 PID。

测试 fake child 使用真实 `EventEmitter` 模拟 `exit`/`error` 生命周期；断言 `executeOwnedProcess` 的返回值与终止器收到的对象身份，不只断言 mock 被调用。

- [ ] **Step 6: 运行并确认进程生命周期 RED**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: 序列测试通过；进程生命周期测试因 `executeOwnedProcess` 或 `terminateOwnedProcessTree` 不存在而 FAIL。

- [ ] **Step 7: 实现异步进程生命周期**

实现要求：

```js
export async function executeOwnedProcess(invocation, timeoutMs, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const terminate = dependencies.terminateOwnedProcessTree ?? terminateOwnedProcessTree;
  const child = spawnProcess(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    env: invocation.env,
    stdio: 'inherit',
    shell: false,
  });

  // 用一次性 exit/error 监听器与有界 timer 竞争；任何分支都清 timer 和监听器。
  // 正常 exit 返回真实 code；error 作为明确失败抛出；timer 胜出时 await terminate(child)。
  // 不把 signal 退出写成 passed。
}
```

Windows `terminateOwnedProcessTree` 必须使用传入 child 的 PID 构造：

```js
spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
  stdio: 'ignore',
  shell: false,
});
```

等待 `taskkill` 的 `exit`/`error`，另设 `5_000ms` helper 上限；`taskkill` 成功后检查原 child 的 `exitCode`/`signalCode`，尚未退出则再有界等待其 `exit`，仍存活即明确失败。非 Windows 只向该 child 发送 `SIGTERM` 并执行相同的有界退出确认；不得调用按名称扫描进程的命令。清理错误原样进入最终失败，不得被转换成普通 test failure。

- [ ] **Step 8: 运行 Task 2 GREEN**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: 清单、命令、顺序、失败继续、单项/全局超时与精确终止测试全部 PASS；输出无 warning。

- [ ] **Step 9: 检查并提交 Task 2**

Run:

```powershell
git diff --check -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git diff -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git add -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git commit -m "build: 实现网站 E2E 进程状态机"
```

Expected: 只提交两个编排器文件；尚未增加可执行 CLI 入口，也未运行真实浏览器。

### Task 3: 组合正式 CLI 并验证真实逐项隔离

**Files:**
- Modify: `tools/verification/run-website-e2e-process-isolation.mjs`
- Modify: `tools/verification/run-website-e2e-process-isolation.test.mjs`

**Interfaces:**
- Consumes: Tasks 1—2 的解析、命令、顺序执行和精确终止接口。
- Produces: `discoverWebsiteTests(dependencies?: DiscoveryDependencies): Promise<readonly string[]>`。
- Produces: `executeWebsiteListCommand(invocation: WebsiteListInvocation, dependencies?: ListProcessDependencies): Promise<{ exitCode: number | null; stdout: string }>`。
- Produces: `formatWebsiteRunSummary(summary: WebsiteRunSummary): string`。
- Produces: `runWebsiteE2EMain(dependencies?: MainDependencies): Promise<WebsiteRunSummary>`。
- Produces: CLI `node tools/verification/run-website-e2e-process-isolation.mjs`，无业务参数。

- [ ] **Step 1: 写发现失败、汇总与临时文件清理 RED**

追加以下三个行为测试：

```js
test('列表命令非零时拒绝且不返回部分清单', async () => {
  await assert.rejects(
    () => discoverWebsiteTests({
      executeList: async () => ({ exitCode: 1, stdout: 'Listing tests:\n  website.spec.ts:1:1 › A\n' }),
    }),
    /清单命令失败/u,
  );
});

test('列表命令超时只终止自己启动的 child', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 2468,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const terminated = [];
  await assert.rejects(
    () => executeWebsiteListCommand({
      executable: process.execPath,
      args: ['playwright-cli', 'test', '--list'],
      env: process.env,
      timeoutMs: 30_000,
    }, {
      spawnProcess: () => child,
      scheduleTimeout: callback => { queueMicrotask(callback); return 1; },
      clearScheduledTimeout: () => {},
      terminateOwnedProcessTree: async actualChild => terminated.push(actualChild),
    }),
    /清单命令超时/u,
  );
  assert.deepEqual(terminated, [child]);
});

test('汇总输出包含全部计数及失败产物目录', () => {
  assert.equal(formatWebsiteRunSummary({
    discovered: 2,
    passed: 1,
    failed: 1,
    interrupted: 0,
    notRun: 0,
    durationMs: 1234,
    exitCode: 1,
    results: [
      { index: 1, description: 'website.spec.ts:1:1 › A', outputDirectory: 'C:\\output\\001', status: 'passed', exitCode: 0, durationMs: 100 },
      { index: 2, description: 'website.spec.ts:2:1 › B', outputDirectory: 'C:\\output\\002', status: 'failed', exitCode: 1, durationMs: 200 },
    ],
  }), [
    '网站 E2E 逐项进程汇总：discovered=2 passed=1 failed=1 interrupted=0 notRun=0',
    '总耗时：1234ms',
    'failed: website.spec.ts:2:1 › B -> C:\\output\\002',
  ].join('\n'));
});

test('主流程成功和异常都只清理自己创建的临时目录', async () => {
  for (const fail of [false, true]) {
    const events = [];
    const action = () => runWebsiteE2EMain({
      makeTempDirectory: async () => 'C:\\Temp\\owned-website-e2e',
      discoverTests: async () => ['website.spec.ts:1:1 › A'],
      runSequence: async () => {
        if (fail) throw new Error('sequence failed');
        return {
          discovered: 1,
          passed: 1,
          failed: 0,
          interrupted: 0,
          notRun: 0,
          durationMs: 10,
          exitCode: 0,
          results: [{
            index: 1,
            description: 'website.spec.ts:1:1 › A',
            outputDirectory: 'C:\\output\\001',
            status: 'passed',
            exitCode: 0,
            durationMs: 10,
          }],
        };
      },
      removeTempDirectory: async path => events.push(['remove', path]),
      writeLine: line => events.push(['write', line]),
    });
    if (fail) await assert.rejects(action, /sequence failed/u);
    else await action();
    assert.deepEqual(events.filter(event => event[0] === 'remove'), [['remove', 'C:\\Temp\\owned-website-e2e']]);
  }
});
```

- [ ] **Step 2: 运行并确认正式组合 RED**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: Tasks 1—2 测试通过；新测试因三个正式组合导出不存在而 FAIL。

- [ ] **Step 3: 实现发现、临时文件、CLI 与汇总输出**

清单子进程使用 `process.execPath`、Playwright CLI、网站配置与 `--list`，`stdio` 为 `['ignore', 'pipe', 'pipe']`、`shell: false`。stdout 最多收集 `1_000_000` 字节；stderr 边读边写入 `process.stderr`。清单进程上限 `30_000ms`，超时调用 Task 2 的 `terminateOwnedProcessTree(child)` 并抛出“网站 E2E 清单命令超时”。实现以下稳定组合：

```js
export async function discoverWebsiteTests(dependencies = {}) {
  const executeList = dependencies.executeList ?? executeWebsiteListCommand;
  const outcome = await executeList({
    executable: process.execPath,
    args: [
      resolve(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'tests/playwright.website.config.ts',
      '--list',
    ],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeoutMs: 30_000,
  });
  if (outcome.exitCode !== 0) {
    throw new Error(`网站 E2E 清单命令失败：exitCode=${String(outcome.exitCode)}`);
  }
  return parseWebsiteTestList(outcome.stdout);
}

export function formatWebsiteRunSummary(summary) {
  return [
    `网站 E2E 逐项进程汇总：discovered=${summary.discovered} passed=${summary.passed} failed=${summary.failed} interrupted=${summary.interrupted} notRun=${summary.notRun}`,
    `总耗时：${summary.durationMs}ms`,
    ...summary.results
      .filter(result => result.status !== 'passed')
      .map(result => `${result.status}: ${result.description} -> ${result.outputDirectory}`),
  ].join('\n');
}

export async function runWebsiteE2EMain(dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const makeTempDirectory = dependencies.makeTempDirectory
    ?? (() => mkdtemp(join(tmpdir(), 'website-e2e-process-')));
  const removeTempDirectory = dependencies.removeTempDirectory
    ?? (path => rm(path, { recursive: true, force: true }));
  const discoverTests = dependencies.discoverTests ?? discoverWebsiteTests;
  const runSequence = dependencies.runSequence ?? runWebsiteTestSequence;
  const writeLine = dependencies.writeLine ?? (line => console.log(line));
  const startedAtMs = now();
  const tempDirectory = await makeTempDirectory();
  try {
    const descriptions = await discoverTests();
    const summary = await runSequence({
      descriptions,
      startedAtMs,
      testListPath: join(tempDirectory, 'current-test-list.txt'),
      outputRoot: WEBSITE_E2E_OUTPUT_ROOT,
    }, {
      now,
      writeTestList: (path, content) => writeFile(path, content, 'utf8'),
      writeProgress: writeLine,
      executeTest: async ({ outputDirectory, timeoutMs }) => {
        const invocation = createWebsiteTestInvocation({
          testListPath: join(tempDirectory, 'current-test-list.txt'),
          outputDirectory,
        });
        return executeOwnedProcess(invocation, timeoutMs);
      },
    });
    writeLine(formatWebsiteRunSummary(summary));
    return summary;
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}
```

`runWebsiteTestSequence` 使用 `input.startedAtMs` 时，15 分钟预算从清单发现前开始计算；没有该字段时保持 Task 2 单元调用行为。临时目录只包含当前短文本文件，不删除测试产物根。

通过 `pathToFileURL(process.argv[1]).href === import.meta.url` 保护入口；被单测导入时不得自动运行。CLI 设置 `process.exitCode = summary.exitCode`，异常时输出中文错误并设置 1。

- [ ] **Step 4: 运行全部编排器单测与真实清单**

Run:

```powershell
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
node.exe --input-type=module -e "import { discoverWebsiteTests } from './tools/verification/run-website-e2e-process-isolation.mjs'; const tests=await discoverWebsiteTests(); console.log(JSON.stringify({count:tests.length}));"
```

Expected: 全部单测 PASS，输出无 warning；真实发现为 `count: 45`。

- [ ] **Step 5: 构建一次并运行两个独立 CLI 锁定回归**

先构建：

```powershell
pnpm.cmd build:website:e2e
```

Expected: 静态导出成功，退出码 0。

使用 `apply_patch` 在本计划 SDD 工作区创建两个短期文件，不加入 Git：

```text
.superpowers/sdd/2026-08-15-website-e2e-cli-process-isolation/locked-1.txt
website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开

.superpowers/sdd/2026-08-15-website-e2e-cli-process-isolation/locked-2.txt
website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互
```

运行两个独立进程；若当前 `--list` 行号变化，必须从本轮清单复制完整描述，不能凭记忆改行号：

```powershell
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --test-list .superpowers/sdd/2026-08-15-website-e2e-cli-process-isolation/locked-1.txt --output tests/.playwright-output/website-process-isolation/locked-1
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --test-list .superpowers/sdd/2026-08-15-website-e2e-cli-process-isolation/locked-2.txt --output tests/.playwright-output/website-process-isolation/locked-2
```

Expected: 每条命令各发现并运行 1 项，均退出 0；进程之间无共享 Playwright worker。随后用 `apply_patch` 删除两个短期文件。

- [ ] **Step 6: 直接运行正式编排器并执行 15 分钟止损**

构建已在 Step 10 完成，不重复构建：

```powershell
node.exe tools/verification/run-website-e2e-process-isolation.mjs
```

使用后台可续读会话每 30—60 秒读取输出。Expected:

- `discovered=45 passed=45 failed=0 interrupted=0 notRun=0`；
- 总时长小于 `900_000ms`；
- 退出码 0；
- 每项输出目录互不相同。

若出现 GPU stall、任何失败或达到 15 分钟：立即停止 Task 3，不修改产品、fixture、worker、retry 或 timeout；写清首错、计数和产物路径，状态 BLOCKED，不提交 Task 3。

- [ ] **Step 7: 检查残留进程与定向验证**

Run:

```powershell
$workspacePath = 'C:\Users\Administrator\.codex\worktrees\3bfd\myself'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(chrome|msedge|playwright|node)(\.exe)?$' -and
    $_.CommandLine -like "*$workspacePath*"
  } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
node.exe --test tools/verification/run-website-e2e-process-isolation.test.mjs
```

Expected: 没有本轮遗留且命令行指向当前工作区的进程；全部编排器单测 PASS。

- [ ] **Step 8: 检查并提交 Task 3**

Run:

```powershell
git diff --check -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git diff -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git add -- tools/verification/run-website-e2e-process-isolation.mjs tools/verification/run-website-e2e-process-isolation.test.mjs
git commit -m "build: 隔离网站 E2E CLI 进程"
```

Expected: 只提交两个编排器文件；真实逐项运行证据写入本计划 Task 3 报告。

### Task 4: 切换正式入口、删除失败 fixture 并完成网站链验收

**Files:**
- Modify: `package.json`（只改 `test:e2e:website` hunk）
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `docs/superpowers/plans/2026-08-15-website-verification-foundation.md`
- Delete: `tests/website-isolated-browser-fixture.ts`
- Delete: `tools/verification/website-isolated-browser-fixture.test.mjs`

**Interfaces:**
- Consumes: Task 3 CLI `node tools/verification/run-website-e2e-process-isolation.mjs` 与完整 45/45 证据。
- Produces: 根脚本 `test:e2e:website = pnpm build:website:e2e && node tools/verification/run-website-e2e-process-isolation.mjs`。
- Produces: 网站范围守卫对本计划全部网站文档和调度文件的精确允许，同时继续拒绝 `tests/e2e/desktop.spec.ts` 与 `apps/desktop/**`。
- Removes: 已证伪的 `useIsolatedBrowser`、`useIsolatedPage` 正式代码和只覆盖该失败路径的测试。

- [ ] **Step 1: 写网站范围治理 RED**

在 `verify-website-scope.test.mjs` 追加行为测试，复用现有 `classifyChangedPaths`：

```js
test('网站 E2E CLI 隔离只允许精确网站文档与调度路径', () => {
  assert.deepEqual(classifyChangedPaths([
    'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
    'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
    'docs/superpowers/specs/2026-08-15-website-e2e-cli-process-isolation-design.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-cli-process-isolation.md',
    'tools/verification/run-website-e2e-process-isolation.mjs',
    'tools/verification/run-website-e2e-process-isolation.test.mjs',
    'tests/e2e/desktop.spec.ts',
    'apps/desktop/src/main/index.ts',
  ]), {
    allowed: [
      'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
      'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
      'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
      'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
      'docs/superpowers/specs/2026-08-15-website-e2e-cli-process-isolation-design.md',
      'docs/superpowers/plans/2026-08-15-website-e2e-cli-process-isolation.md',
      'tools/verification/run-website-e2e-process-isolation.mjs',
      'tools/verification/run-website-e2e-process-isolation.test.mjs',
    ],
    forbidden: ['tests/e2e/desktop.spec.ts', 'apps/desktop/src/main/index.ts'],
    outside: [],
  });
});
```

- [ ] **Step 2: 运行并确认范围 RED**

Run:

```powershell
node.exe --test tools/verification/verify-website-scope.test.mjs
```

Expected: FAIL；新旧三代隔离文档中的未允许路径进入 `outside`，两个桌宠路径仍进入 `forbidden`。

- [ ] **Step 3: 最小扩展精确白名单并确认 GREEN**

在 `website-scope-policy.mjs` 的 `ALLOWED_WEBSITE_SCOPE_PATHS` 仅增加六个精确文档路径；`tools/verification/**` 已覆盖两个编排器文件，不重复增加。不得允许整个 `tests/e2e/**` 或 `docs/superpowers/**`。

Run:

```powershell
node.exe --test tools/verification/verify-website-scope.test.mjs
```

Expected: 全部 PASS；两个桌宠路径仍为 forbidden。

- [ ] **Step 4: 切换根正式入口并精确检查差异**

只把：

```json
"test:e2e:website": "pnpm build:website:e2e && node node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts"
```

改为：

```json
"test:e2e:website": "pnpm build:website:e2e && node tools/verification/run-website-e2e-process-isolation.mjs"
```

不得改动同文件四个未提交 `verify:web-chain*` 脚本。Run:

```powershell
git diff -- package.json
```

Expected: 工作树 diff 同时显示受保护的四个 Task 4 脚本与本任务一个 `test:e2e:website` 改动；内容均保持精确值。

- [ ] **Step 5: 运行根正式入口并执行 15 分钟止损**

Run:

```powershell
pnpm.cmd test:e2e:website
```

Expected: 构建一次；`discovered=45 passed=45 failed=0 interrupted=0 notRun=0`；退出码 0；总时长小于 15 分钟。

若失败或超时，停止 Task 4；不得删除 fixture、不得更新 foundation 状态、不得提交根入口。

- [ ] **Step 6: 删除已证伪 fixture 与测试**

先只读确认只有失败方案自身引用：

```powershell
rg -n "website-isolated-browser-fixture|useIsolatedBrowser|useIsolatedPage" tests tools apps packages
```

Expected: 只命中 `tests/website-isolated-browser-fixture.ts` 与 `tools/verification/website-isolated-browser-fixture.test.mjs`。随后使用 `apply_patch` 删除这两个文件，不使用递归删除命令。

Run:

```powershell
rg -n "website-isolated-browser-fixture|useIsolatedBrowser|useIsolatedPage" tests tools apps packages
node.exe --test tools/verification/*.test.mjs
pnpm.cmd --filter @myself/website typecheck
```

Expected: `rg` 无命中；全部 verification Node 测试 PASS；网站 typecheck PASS。Node `.ts` 直载产生的 `MODULE_TYPELESS_PACKAGE_JSON` warning 随失败 fixture 测试删除而消失。

- [ ] **Step 7: 更新 foundation 计划实际状态**

在 `docs/superpowers/plans/2026-08-15-website-verification-foundation.md` 的 Task 4 执行台账记录：

- 双 worker 与测试级独立 Chromium fixture 均已证伪退役；
- 正式 E2E 入口使用全部测试逐项独立 Playwright CLI；
- 本轮真实 `test:e2e:website` 的 discovered/passed/failed/interrupted/notRun、耗时和退出码；
- 尚未运行的 full chain 不得预写为通过；
- 生产正式部署仍不在本阶段范围。

- [ ] **Step 8: 运行完整网站范围与 fast 门**

Run:

```powershell
node.exe tools/verification/verify-website-scope.mjs --base=0dab17de8863a7c726a5bb5fceff35a1713daad1 --head=HEAD --include-working-tree
pnpm.cmd verify:web:fast
```

Expected: 范围守卫 PASS 且不允许桌宠路径；fast chain 15/15 PASS。

- [ ] **Step 9: 运行完整网站链并执行 15 分钟止损**

Run:

```powershell
pnpm.cmd verify:web:full
```

使用后台可续读会话每 30—60 秒读取。Expected:

- full chain 20/20 PASS；
- website-e2e 内部汇总 `45/45`；
- 退出码 0；
- 总时长小于 15 分钟。

若达到 15 分钟或失败，立即终止当前精确进程树并记录首错；不得放宽门禁或把 Task 4 写为完成。

- [ ] **Step 10: 检查残留进程、差异与 package 分 hunk 暂存**

Run:

```powershell
$workspacePath = 'C:\Users\Administrator\.codex\worktrees\3bfd\myself'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(chrome|msedge|playwright|node)(\.exe)?$' -and
    $_.CommandLine -like "*$workspacePath*"
  } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
git diff --check -- package.json tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
git diff -- package.json tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
```

Expected: 无残留当前工作区测试进程；`git diff --check` 无错误；删除仅限两个失败 fixture 文件。

先精确暂存非 package 文件：

```powershell
git add -- tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-08-15-website-verification-foundation.md tests/website-isolated-browser-fixture.ts tools/verification/website-isolated-browser-fixture.test.mjs
```

再运行：

```powershell
git add -p -- package.json
```

若 Git 把两类变化显示在同一 hunk，先回答 `s` 拆分；对四个 `verify:web-chain*` 脚本所在 hunk 回答 `n`，只对 `test:e2e:website` hunk 回答 `y`。随后必须核验：

```powershell
git diff --cached -- package.json
git diff --cached --name-only
```

Expected: package 缓存 diff 只含 `test:e2e:website` 一行替换；缓存文件只含本 Task 4 精确文件，不含 `web-chain-catalog.mjs`、`verify-web-chain.mjs` 或 `verify-web-chain.test.mjs`。若不满足，立即 `git restore --staged -- package.json` 并重新分 hunk，禁止提交混合差异。

- [ ] **Step 11: 提交 Task 4 并最终只读审计**

Run:

```powershell
git commit -m "build: 启用网站 E2E 独立进程门"
git status --short
git log --oneline -10
node.exe tools/verification/verify-website-scope.mjs --base=0dab17de8863a7c726a5bb5fceff35a1713daad1 --head=HEAD --include-working-tree
```

Expected:

- Task 4 提交只含正式入口、精确范围治理、foundation 状态与两个失败 fixture 删除；
- 工作树只剩 Phase 0 Task 4 的四个受保护差异，以及 `website.spec.ts` 的无内容时间戳状态；
- 网站范围守卫 PASS；
- 当前计划没有读写 foundation 的 SDD 工作区；
- 下一步回交原 foundation 计划所有者更新报告并独立提交 Task 4 runner；
- 正式网站生产部署继续标记为后续阶段。
