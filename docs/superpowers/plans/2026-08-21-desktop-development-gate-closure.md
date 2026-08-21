# AI Pet 桌宠恢复常规开发门收口实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐任务执行并由新鲜独立审查者复审。实施缺陷修复时同时使用 `diagnosing-bugs`、`test-driven-development` 和 `verification-before-completion`。所有步骤使用复选框跟踪。

**目标：** 在不放宽测试、不牺牲唯一安全证据且不触碰网站业务的前提下，根治 Desktop 并行负载下的 5000ms 超时，完成测试 owner 审计，并在同一个最终可执行树 HEAD 上通过五条质量门后正式恢复桌宠常规新功能开发。

**架构：** 先固定事实基线，再依次使用最多三个有限 feedback seam 建立同症状 RED；诊断任务只产出可证伪根因和一份精确 fix brief，禁止提前猜测修复文件。根因修复与 owner 减法分别以最小提交落地；所有可执行变化停止后固定最终可执行树 HEAD，每个 HEAD 只执行一轮五门、全流程最多两轮，最后只允许一个纯验收文档后继提交。

**技术栈：** TypeScript、Vitest 3、Electron、Playwright、pnpm 11、Windows PowerShell、Git。

## 全局约束

- 已批准规格为 `docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md`；计划不得扩大到 C1–C10、新业务能力或大规模架构重写。
- 当前事实起点为分支 `AgentCoreExtension`：失败用例位于 `apps/desktop/tests/official-default-character.test.ts`，标题为“损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据”；一次完整 `verify:desktop` 中达到固定 5000ms，随后唯一定向复现约 1.06 秒通过。
- 当前 `apps/desktop/vitest.config.ts` 使用 `maxWorkers: 4`；这只是配置事实，不是根因结论。没有同时通过资源不变量根因门与量化效果门时，值必须保持 4。
- 测试与 E2E 的唯一比较基线是 `c7d951d`，范围只含 `apps/desktop/tests` 与 `tests/e2e`；计划编写时精确总账为 Desktop `+1648/-825`、E2E `+308/-469`，合计 `+1956/-1294`、净增 `662`。
- 严格执行“能不加就不加，能减则减”。不得为了归零删除唯一安全、竞态、持久化或真实 Electron 证据；不得新增通用测试 DSL、第二套 fixture 框架、长期诊断服务或无业务价值的 wrapper。
- 禁止提高 timeout、增加 retry、失败后自动重跑、使用 `skip`/`todo`、缩小正式门范围、降低断言、吞异常、mock 掉真实文件事务，或无证据降低 worker 来制造绿色。
- 单条命令达到 15 分钟立即终止；从 Task 1 第一条压力命令开始，到 Task 2 根因裁决完成为止，总诊断预算为 60 分钟。最多三个 feedback seam、3–5 个假设、每个假设最多两个单变量 probe；达到任一预算立即终局。
- 压力数据只使用临时目录和合成角色；报告不得记录完整绝对路径、文件正文、损坏 marker 原字节、owner token、哈希、API Key、Authorization 或 Provider 私有响应。路径统一写 `<REDACTED>`。
- Vitest JSON 与 stdout/stderr 只能存在于 runner 的有界内存；任何模式都不得持久化 stdout/stderr 正文。Vitest 只保存不含 `failureMessages`、expected、actual、路径、正文、token 或 hash 的最小 summary；native 只保存退出、耗时、spawn 与 termination 类别；两者仅可追加严格白名单 probe 指标与拒绝计数，并只落盘 summary 和 metadata。
- 所有插入生产/正式测试/config 的 `[DEBUG-*]` 与临时探针必须在 Task 3 完成前删除；ignored runner、fixtures 与 review package 保留到任一成功/关门终局，再由 Task X 精确删除。最终正式运行路径、日志契约和测试入口不得因诊断增加第二套 owner。
- 不修改或运行网站业务。以下受保护路径相对实施基线、工作树和暂存区必须始终零差异：`apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、`tests/e2e/website.spec.ts`、`tests/playwright.website.config.ts`。
- 不 push、不 merge、不 rebase、不 reset。Git 写操作已获授权；有实质 tracked 变更的任务必须独立提交。证据型 Task 0、Task 1、Task 2、Task 5 不制造空提交，其独立复审以报告和固定 HEAD 为对象；这避免用无内容提交污染最终可执行树或使五门 HEAD 失效。
- 每个任务由新鲜独立审查者同时检查规格符合性与代码/证据质量；Critical/Important 必须清零才能进入下一任务。审查超过 15 分钟未收敛时停止该审查方式，换新审查者或收窄审查包。
- 若调查发现需要大量删除文件，必须先列出精确目标、替代 owner、恢复方式和 `numstat`，再取得用户二次明确批准；现有授权不替代仓库对大量文件删除的二次确认。

## 文件与产物职责

| 文件或目录 | 职责 | 生命周期 |
| --- | --- | --- |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/baseline.md` | 固定实施基线、脚本、配置、失败事实、受保护路径和总账 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/implementation-baseline.txt` | 仅一行实施基线完整 hash，供后续命令机械读取 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs` | `vitest`/`native` 两模式、有界内存、预算、进程树终止、脱敏与原子证据写入 | ignored 临时执行工具，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs` | runner 分类、脱敏、预算、argv、冲突与进程树 TDD 自测 | ignored 临时测试，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/` | argv、fake Vitest、安全 probe、超量输出与短超时父子进程 fixture | ignored 临时测试装配，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnostics/` | 按 episode/seam/round 保存不可覆盖的最小 summary 和 metadata；不保存 stdout/stderr | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md` | 三个有限 feedback seam 的轮次、退出码、耗时和同症状统计 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-ledger.md` | 3–5 个假设、预测、单变量 probe、支持/排除结论和 60 分钟终局 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-probe-brief.md` | 每个假设插桩前固定精确文件、符号、单变量、命令、指标和清理补丁 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md` | 由诊断证据生成的唯一修复任务简报，固定具体修复与测试文件 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-files.txt` | 每行一个经复审的 Task 3 tracked 路径 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-subtraction-files.txt` | 每行一个通过删除门且实际修改的 Task 4 路径；无安全减法时为空 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/final-executable-head.txt` | 仅一行 Task 5 最终可执行树完整 hash | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-report.md` | 最终可执行树 HEAD、五门结果、路径保护、最终文档提交 hash 与差异证明 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-failure-episode-brief.md` | 第一轮门失败后的唯一新诊断 episode 边界与专属 seam | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/terminal-closure-brief.md` | 上游终局任务显式传入唯一 `TerminalReason`，Task X 禁止自行推断 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-pending.md` | Task X 删除工具前的可恢复快照，固定 reason、before、required evidence 与全部 diagnostics 路径 | ignored 临时终局状态，Ready 后删除 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-report.md` | Task X 删除工具并复核后创建的扁平最终终局证据 | ignored 终局证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-review.md` | 独立复审 Task X final report 并记录 `状态：Ready` | ignored 终局证据，不提交 |
| `docs/operations/desktop-test-owner-inventory.md` | 每个变更测试文件及有效 hunk/测试簇的唯一 owner 清单和逐文件 `numstat` 对账 | 永久审计事实，门禁前提交 |
| `docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md` | 本次开发门规则与最终状态 | 仅 Task 6 纯验收文档后继更新 |
| `docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md` | 旧 worker 固定值和机械净负数门的准确替代关系 | 仅 Task 6 纯验收文档后继更新 |
| `docs/operations/character-workshop-acceptance.md` | 五门命令、退出码、耗时、人工待验和解锁裁决 | 仅 Task 6 纯验收文档后继更新 |
| `docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md` | 上位路线中的恢复开发门状态摘要 | 仅 Task 6 纯验收文档后继更新 |

根因修复的生产与测试文件**不在本计划中预填**。Task 2 只有在证据足够时才把精确路径、符号、公开 seam、RED 命令和最小删除范围写入 `root-cause-fix-brief.md`；没有这份完整简报，Task 3 不得启动。

---

### Task 0：固定事实基线、脚本契约与预算计时点

**文件：**
- 读取：`package.json`
- 读取：`apps/desktop/package.json`
- 读取：`apps/desktop/vitest.config.ts`
- 读取：`apps/desktop/tests/official-default-character.test.ts`
- 读取：`docs/operations/character-workshop-acceptance.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/baseline.md`

**接口：**
- 产出 `implementation-baseline.txt`：本计划提交后的精确 HEAD，后续保护路径检查只机械读取该 hash。
- 产出固定正式门清单：`verify:desktop`、`verify:characters`、`verify:behavior`、`test:security`、`test:integration`。
- 产出 `DIAGNOSIS_STARTED_AT` 的写入规则：只在 Task 1 第一条压力命令开始前记录，Task 0 不提前消耗 60 分钟预算。

- [ ] **Step 1：确认工作树、分支和计划提交是唯一新增事实**

  ```powershell
  git branch --show-current
  git status --short
  git log -1 --oneline
  git rev-parse HEAD
  ```

  预期：分支为 `AgentCoreExtension`；除用户已知改动外工作树干净；HEAD 包含本计划提交。若存在不属于本任务的可执行差异，记录并停止，不把它们混入实施基线。

- [ ] **Step 2：固定脚本与配置事实**

  ```powershell
  node -e "const p=require('./package.json'); for (const n of ['verify:desktop','verify:characters','verify:behavior','test:security','test:integration']) { if (!p.scripts[n]) throw new Error('缺少脚本: '+n); console.log(n+'='+p.scripts[n]); }"
  Get-Content -Raw apps/desktop/vitest.config.ts
  rg -n "损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据|maxWorkers|testTimeout|retry|skip|todo" apps/desktop/tests/official-default-character.test.ts apps/desktop/vitest.config.ts package.json
  ```

  预期：五个脚本全部存在；Desktop `maxWorkers` 为 4；目标测试没有本任务新增的 timeout/retry/skip。

- [ ] **Step 3：固定 20 个当前变更测试文件与精确总账**

  ```powershell
  git diff --name-status c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --name-only c7d951d..HEAD -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  ```

  预期：当前清单为 20 个文件；总账为 `+1956/-1294`、净增 `662`；受保护路径无输出。最终 inventory 必须重新读取实际 HEAD，不能把 20 当作未来固定数量。

- [ ] **Step 4：固定 runner 接口与本地 CLI 事实**

  Task R 将创建 runner；本步骤只固定接口：

  ```text
  node run-diagnostic-round.mjs --mode vitest --episode initial --seam 1-isolated --round 1 \
    --started-at diagnosis-started-at.txt --target-id "官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据" -- \
    node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts

  node run-diagnostic-round.mjs --mode native --episode root-fix-verification --seam desktop-typecheck --round 1 \
    --started-at root-fix-verification-started-at.txt -- \
    node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
  ```

  本地只读确认 `node_modules/vitest/vitest.mjs` 与 `node_modules/typescript/bin/tsc` 存在；后续诊断统一直接运行这两个 Node CLI，不把 `.cmd` 交给 `spawn(shell:false)`。

  runner 的完整实现位于 Task R；此处只锁定外部契约：`spawn(..., {shell:false})`；stdout/stderr 各 10 MiB 有界内存；Vitest JSON 直接从 stdout 内存解析，不使用 `outputFile`，因此不存在未脱敏 raw 文件清理分支；每次 spawn 前计算 `remaining=min(900000, 3600000-elapsed)`；自身 timer 到期在 Windows 按精确 child PID 执行 `taskkill /PID ... /T /F` 并等待 close；全部 artifact 脱敏后以 `wx` 写入且 metadata 最后写。

  上述接口、分类与隐私约束由独立 Task R 以完整 Node 实现和自测落地；Task R 未 Ready 时不得进入 Task 1。

- [ ] **Step 5：写入 baseline 报告并独立复审**

  先固定机器可读 hash：

  ```powershell
  git rev-parse HEAD | Set-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/implementation-baseline.txt
  ```

  `baseline.md` 必须逐字记录实施基线 hash、当前时间、分支、五个脚本展开值、Vitest worker 值、目标用例文件与标题、20 文件清单、逐文件 `numstat`、总账和保护路径结果。独立审查者复算总账并确认报告没有敏感绝对路径。

  完成门：事实、算术和脚本一致；Critical/Important 为零。该任务没有 tracked 变更，不创建空提交；报告记录进入 Task 1 时的同一 HEAD。

---

### Task R：以 TDD 实现独立诊断 runner 并复审为 Ready

**文件：**
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/argv-child.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/fake-vitest.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/probe-child.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/output-overflow.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/tree-parent.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/tree-child.mjs`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-review.md`

**接口：**
- `mode='vitest'` 时只追加 `--reporter=json`，从 stdout 内存缓冲解析 JSON；绝不使用 `outputFile`。
- `mode='native'` 时 argv 原样传给子进程，不追加 Vitest 参数；Task 3 typecheck 必须使用此模式。
- 两种模式都不创建 stdout/stderr artifact。Vitest summary 只含目标 ID/status/duration/classification、test/file pass/fail counts、exit/termination category；native summary 只含 exit、duration、spawn/termination category，并仅在 termination 或 probe overflow 时追加 `classification='OTHER_FAILURE'`；两者可追加经过严格白名单验证的 probe 计数与指标，不得追加原文。
- 子进程固定使用 `child_process.spawn(executable, args, { shell: false })`。诊断 CLI 以 `node node_modules/vitest/vitest.mjs ...` 或 `node node_modules/typescript/bin/tsc ...` 运行，不启动 `.cmd`。
- stdout/stderr 各自最多保留 10 MiB；超限立即终止精确 child PID 的整个进程树，并把本轮分类为 `OTHER_FAILURE`。
- metadata 固定包含 `episodeElapsedBeforeMs`、`episodeElapsedAfterMs`、基于 `performance.now()` 的 `commandDurationMs`、`effectiveLimitMs`、`deadlineKind` 和 `terminationReason`。
- runner 只识别行首锚定的 `[GATE_PROBE]{json}`：对象必须且只能含 `phase`、`count`、`durationMs`、`category`；`phase` 为安全 token，`category` 为封闭枚举；无前缀文本忽略，非法 JSON、额外键或非法值只增加 `rejectedProbeMetricCount`，不保存原文。每轮最多保存 256 个合法指标；第 257 个令 `probeMetricOverflow=true`、清空 `probeMetrics` 并把分类置为 `OTHER_FAILURE`，仅保留 observed/rejected 计数。
- ignored 文件也不靠“反正不提交”规避审查：Task R 生成文件清单、SHA-256 与完整内容 review package，独立审查 Critical/Important 为零并在 `runner-review.md` 写 `状态：Ready` 后，Task 1 才能启动。

- [ ] **Step 1：先写 runner fixtures**

  `argv-child.mjs` 完整内容：

  ```js
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
  ```

  `fake-vitest.mjs` 完整内容：

  ```js
  const reporterPresent = process.argv.includes('--reporter=json');
  const forceExitOne = process.argv.includes('--force-exit-one');
  const forceTargetTimeout = process.argv.includes('--force-target-timeout');
  const target = '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据';
  process.stdout.write(JSON.stringify({
    success: reporterPresent && !forceTargetTimeout,
    numTotalTests: 1,
    numPassedTests: reporterPresent && !forceTargetTimeout ? 1 : 0,
    numFailedTests: reporterPresent && !forceTargetTimeout ? 0 : 1,
    numTotalTestSuites: 1,
    numPassedTestSuites: reporterPresent && !forceTargetTimeout ? 1 : 0,
    numFailedTestSuites: reporterPresent && !forceTargetTimeout ? 0 : 1,
    testResults: [{
      assertionResults: [{
        fullName: target,
        status: reporterPresent && !forceTargetTimeout ? 'passed' : 'failed',
        duration: 123,
        failureMessages: forceTargetTimeout
          ? ['Test timed out in 5000ms']
          : reporterPresent ? [] : ['REPORTER_MISSING']
      }]
    }]
  }));
  process.exitCode = !reporterPresent ? 2 : forceExitOne || forceTargetTimeout ? 1 : 0;
  ```

  `probe-child.mjs` 完整内容：

  ```js
  const metricCountArgument = process.argv.find(argument => argument.startsWith('--metric-count='));
  if (metricCountArgument) {
    const metricCount = Number(metricCountArgument.slice('--metric-count='.length));
    for (let index = 0; index < metricCount; index += 1) {
      process.stderr.write(`[GATE_PROBE]{"phase":"bulk-probe","count":${index},"durationMs":1,"category":"IO"}\n`);
    }
  } else {
    process.stderr.write('[GATE_PROBE]{"phase":"rebuild-index","count":2,"durationMs":12.5,"category":"IO"}\n');
    process.stderr.write('[GATE_PROBE]{"phase":"bad-path","count":1,"durationMs":1,"category":"IO","path":"C:\\\\private\\\\file"}\n');
    process.stderr.write('[GATE_PROBE]{"phase":"bad-body","count":1,"durationMs":1,"category":"IO","body":"secret"}\n');
    process.stderr.write('[GATE_PROBE]{not-json}\n');
    process.stderr.write('ordinary output C:\\private\\file must not become a metric\n');
  }
  ```

  `output-overflow.mjs` 完整内容：

  ```js
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  for (let index = 0; index < 11; index += 1) process.stdout.write(chunk);
  setInterval(() => {}, 1_000);
  ```

  `tree-child.mjs` 完整内容：

  ```js
  process.stdout.write('READY child\n');
  setInterval(() => {}, 1_000);
  ```

  `tree-parent.mjs` 完整内容：

  ```js
  import { spawn } from 'node:child_process';
  import { fileURLToPath } from 'node:url';
  import { writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';

  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, 'tree-child.mjs')], {
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  writeFileSync(process.argv[2], JSON.stringify({ parentPid: process.pid, childPid: child.pid }), { flag: 'wx' });
  process.stdout.write('READY parent\n');
  setInterval(() => {}, 1_000);
  ```

- [ ] **Step 2：先写失败自测并观察 RED**

  `test-diagnostic-runner.mjs` 使用 `node:assert/strict`，必须先覆盖以下十五组并因 runner 不存在而 RED：

  1. 三分类 fixture：目标 GREEN + 其他测试 5000ms → `OTHER_FAILURE`；目标自身 5000ms → `TARGET_FIXED_TIMEOUT`；目标其他错误 → `OTHER_FAILURE`。
  2. `redact()` 的结果不含 workspace、temp、HOME、USERPROFILE 或合成 Windows 绝对路径原文。
  3. 同一 episode/seam/round 第二次写入因 `EEXIST` 拒绝，第一次 artifact 不变。
  4. started-at 已超过 3600 秒时 metadata 为 `BUDGET_EXHAUSTED`，argv fixture 的 marker 不存在，证明没有 spawn。
  5. `native` 模式运行 argv fixture，结果 argv 不含 `--reporter=json`。
  6. `vitest` 模式真实运行 fake-vitest fixture，必须由自动追加 reporter 得到 GREEN、`targetDurationMs=123`，证明完整解析链有效。
  7. `native` 模式运行 11 MiB overflow fixture，预期 `terminationReason='OUTPUT_LIMIT'`，summary/metadata 不含正文。
  8. 以 `selfTestHardLimitMs=3_000` 启动 tree fixture；fixture 先写 READY/PID 握手，再由 deadline 终止，父、子 PID 都不存在且只留下最小 artifact。
  9. 不存在的 executable 触发异步 spawn error，仍生成最小 `SPAWN_FAILED` summary/metadata。
  10. 自测专用注入令已完成的树清理被报告为失败，必须生成 `TERMINATION_FAILED` 并关闭门；子进程仍须死亡，任何遗留 PID 都令自测和证据失败。
  11. probe fixture 的唯一合法指标原样成为白名单对象；带 `path`/`body` 的额外键和非法 JSON 只累计三次拒绝，artifact 不含其原文；无前缀普通文本不产生 metric。
  12. fake Vitest 返回 `success=true`、目标 passed 但 native exit 1 时，最终分类仍为 `OTHER_FAILURE`。
  13. 主 child 与 `taskkill` child 都通过同一个 once-settled lifecycle Promise 收口；spawn error、close、deadline 与 output overflow 后没有残留 timer 或 `error`/`close`/`data` handler。
  14. fake Vitest 目标自身 `failureMessages` 含 5000ms 且 native exit 1 时，完整 `runRound` 仍保留 `TARGET_FIXED_TIMEOUT`。
  15. 256 个合法 probe 指标可保存且不溢出；第 257 个使 `probeMetricOverflow=true`、`probeMetrics=[]`、最终 `OTHER_FAILURE`，只保留 observed/rejected 计数。

  ```powershell
  node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs
  ```

  预期：RED，错误为无法导入 `run-diagnostic-round.mjs`；不得先创建空 runner 让错误变成无意义断言失败。

- [ ] **Step 3：用 `apply_patch` 写入完整 runner 实现**

  `run-diagnostic-round.mjs` 完整实现固定为：

  ```js
  import { spawn } from 'node:child_process';
  import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
  import { homedir, tmpdir } from 'node:os';
  import { basename, resolve } from 'node:path';
  import { performance } from 'node:perf_hooks';
  import { fileURLToPath } from 'node:url';

  const BUFFER_LIMIT = 10 * 1024 * 1024;
  const EPISODE_LIMIT_MS = 3_600_000;
  const COMMAND_LIMIT_MS = 900_000;
  const TARGET_ID = '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据';
  const SAFE_ID = /^[a-z0-9-]+$/u;
  const SAFE_PHASE = /^[a-z][a-z0-9-]{0,63}$/u;
  const PROBE_PREFIX = '[GATE_PROBE]';
  const PROBE_METRIC_LIMIT = 256;
  const PROBE_CATEGORIES = new Set(['IO', 'CLEANUP', 'CACHE', 'CPU', 'LIFECYCLE', 'STATE']);
  const EMPTY_PROBES = {
    probeMetrics: [], observedProbeMetricCount: 0,
    rejectedProbeMetricCount: 0, probeMetricOverflow: false
  };

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }

  export function redact(value, workspaceRoot) {
    let text = String(value ?? '');
    const known = [workspaceRoot, tmpdir(), homedir(), process.env.HOME, process.env.USERPROFILE]
      .filter(Boolean)
      .flatMap(item => [String(item), String(item).replaceAll('\\', '/')])
      .sort((left, right) => right.length - left.length);
    for (const item of new Set(known)) {
      text = text.replace(new RegExp(escapeRegExp(item), 'giu'), '<REDACTED>');
    }
    return text
      .replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gu, '<REDACTED>')
      .replace(/\\\\[^\\\s]+\\[^\r\n"'<>|]*/gu, '<REDACTED>');
  }

  export function classifyVitest(report, targetId = TARGET_ID) {
    const assertions = (report?.testResults ?? []).flatMap(result => result.assertionResults ?? []);
    const target = assertions.find(assertion => assertion.fullName === targetId);
    const otherTimedOut = assertions.some(assertion =>
      assertion.fullName !== targetId
      && (assertion.failureMessages ?? []).some(message => /Test timed out in 5000ms/u.test(message))
    );
    if (target?.status === 'failed'
      && (target.failureMessages ?? []).some(message => /Test timed out in 5000ms/u.test(message))) {
      return { classification: 'TARGET_FIXED_TIMEOUT', targetStatus: target.status, targetDurationMs: target.duration ?? null };
    }
    if (target?.status === 'passed' && report?.success === true && !otherTimedOut) {
      return { classification: 'GREEN', targetStatus: target.status, targetDurationMs: target.duration ?? null };
    }
    return { classification: 'OTHER_FAILURE', targetStatus: target?.status ?? 'missing', targetDurationMs: target?.duration ?? null };
  }

  export function extractProbeMetrics(...texts) {
    const probeMetrics = [];
    let observedProbeMetricCount = 0;
    let rejectedProbeMetricCount = 0;
    let probeMetricOverflow = false;
    for (const text of texts) {
      for (const line of String(text ?? '').split(/\r?\n/u)) {
        if (!line.startsWith(PROBE_PREFIX)) continue;
        observedProbeMetricCount += 1;
        try {
          const value = JSON.parse(line.slice(PROBE_PREFIX.length));
          const keys = value && typeof value === 'object' && !Array.isArray(value)
            ? Object.keys(value).sort() : [];
          if (keys.join(',') !== 'category,count,durationMs,phase'
            || !SAFE_PHASE.test(value.phase)
            || !Number.isSafeInteger(value.count) || value.count < 0
            || !Number.isFinite(value.durationMs) || value.durationMs < 0
            || !PROBE_CATEGORIES.has(value.category)) {
            throw new Error('INVALID_PROBE_METRIC');
          }
          if (!probeMetricOverflow && probeMetrics.length === PROBE_METRIC_LIMIT) {
            probeMetricOverflow = true;
            probeMetrics.length = 0;
          } else if (!probeMetricOverflow) {
            probeMetrics.push({
              phase: value.phase, count: value.count,
              durationMs: value.durationMs, category: value.category
            });
          }
        } catch {
          rejectedProbeMetricCount += 1;
        }
      }
    }
    return {
      probeMetrics, observedProbeMetricCount,
      rejectedProbeMetricCount, probeMetricOverflow
    };
  }

  function stripProbeLines(text) {
    return String(text ?? '').split(/\r?\n/u)
      .filter(line => !line.startsWith(PROBE_PREFIX)).join('\n');
  }

  function artifactPaths(artifactDir, episodeId, seam, round) {
    if (!SAFE_ID.test(episodeId) || !SAFE_ID.test(seam) || !Number.isInteger(round) || round < 0) {
      throw new Error('INVALID_ARTIFACT_ID');
    }
    const prefix = `episode-${episodeId}-seam-${seam}-round-${String(round).padStart(2, '0')}`;
    return Object.fromEntries(['summary', 'metadata']
      .map(kind => [kind, resolve(artifactDir, `${prefix}.${kind}.json`)]));
  }

  async function ensureAbsent(paths) {
    for (const path of Object.values(paths)) {
      try {
        await access(path);
        throw Object.assign(new Error(`ARTIFACT_EXISTS:${basename(path)}`), { code: 'EEXIST' });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  async function writeArtifacts(paths, values) {
    const created = [];
    try {
      for (const kind of ['summary', 'metadata']) {
        await writeFile(paths[kind], values[kind], { encoding: 'utf8', flag: 'wx' });
        created.push(paths[kind]);
      }
    } catch (error) {
      await Promise.all(created.map(path => rm(path, { force: true })));
      throw error;
    }
  }

  function capture(stream, limit, onOverflow) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    const onData = chunk => {
      if (overflow) return;
      const buffer = Buffer.from(chunk);
      const remaining = limit - size;
      if (buffer.length > remaining) {
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        size = limit;
        overflow = true;
        void onOverflow();
      } else {
        chunks.push(buffer);
        size += buffer.length;
      }
    };
    stream.on('data', onData);
    return {
      text: () => Buffer.concat(chunks).toString('utf8'),
      overflow: () => overflow,
      dispose: () => stream.removeListener('data', onData)
    };
  }

  function observeChild(child) {
    let dispose = () => {};
    const result = new Promise(resolveResult => {
      let settled = false;
      const cleanup = () => {
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      };
      dispose = cleanup;
      const finish = result => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(result);
      };
      const onError = () => finish({ code: null, signal: null, spawnFailed: true });
      const onClose = (code, signal) => finish({ code, signal, spawnFailed: false });
      child.once('error', onError);
      child.once('close', onClose);
    });
    return { result, dispose: () => dispose() };
  }

  async function killTree(child) {
    if (!child.pid || child.exitCode !== null) return { succeeded: true, killerCleanup: null };
    if (process.platform === 'win32') {
      let killerCleanup = null;
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore'
        });
        const killerLifecycle = observeChild(killer);
        let killerResult;
        try {
          killerResult = await killerLifecycle.result;
        } finally {
          killerLifecycle.dispose();
        }
        killerCleanup = {
          errorHandlers: killer.listenerCount('error'),
          closeHandlers: killer.listenerCount('close')
        };
        if (!killerResult.spawnFailed && killerResult.code === 0) {
          return { succeeded: true, killerCleanup };
        }
      } catch {}
      try { child.kill('SIGKILL'); } catch {}
      return { succeeded: false, killerCleanup };
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return { succeeded: true, killerCleanup: null };
      } catch {
        try {
          return { succeeded: child.kill('SIGKILL'), killerCleanup: null };
        } catch {
          return { succeeded: false, killerCleanup: null };
        }
      }
    }
  }

  export async function runRound(options) {
    const {
      mode, episodeId, seam, round, startedAtFile, executable, args,
      targetId = TARGET_ID, workspaceRoot = process.cwd(),
      artifactDir = resolve(workspaceRoot, '.superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnostics'),
      selfTestHardLimitMs, selfTestForceTerminationFailure = false
    } = options;
    if (!['vitest', 'native'].includes(mode)) throw new Error('INVALID_MODE');
    if (!executable || !Array.isArray(args)) throw new Error('INVALID_COMMAND');
    if ((selfTestHardLimitMs !== undefined || selfTestForceTerminationFailure)
      && process.env.AI_PET_GATE_RUNNER_SELF_TEST !== '1') {
      throw new Error('SELF_TEST_LIMIT_FORBIDDEN');
    }
    await mkdir(artifactDir, { recursive: true });
    const paths = artifactPaths(artifactDir, episodeId, seam, round);
    await ensureAbsent(paths);
    const startedAt = Date.parse(await readFile(startedAtFile, 'utf8'));
    if (!Number.isFinite(startedAt)) throw new Error('INVALID_STARTED_AT');
    const episodeElapsedBeforeMs = Date.now() - startedAt;
    const episodeRemainingMs = EPISODE_LIMIT_MS - episodeElapsedBeforeMs;
    const productionLimitMs = Math.min(COMMAND_LIMIT_MS, episodeRemainingMs);
    const effectiveLimitMs = Math.max(0, selfTestHardLimitMs === undefined
      ? productionLimitMs
      : Math.min(productionLimitMs, selfTestHardLimitMs));
    const baseMetadata = { episodeId, seam, round, mode, episodeElapsedBeforeMs, effectiveLimitMs };
    if (productionLimitMs <= 0) {
      const summary = mode === 'vitest'
        ? { classification: 'OTHER_FAILURE', targetFullName: targetId, targetStatus: 'not-started',
          targetDurationMs: null, testCounts: null, fileCounts: null,
          exitCategory: 'NOT_STARTED', spawnCategory: 'NOT_SPAWNED', terminationReason: 'EPISODE_LIMIT', ...EMPTY_PROBES }
        : { classification: 'OTHER_FAILURE', exitCategory: 'NOT_STARTED', spawnCategory: 'NOT_SPAWNED',
          terminationReason: 'EPISODE_LIMIT', commandDurationMs: 0, ...EMPTY_PROBES };
      const metadata = {
        ...baseMetadata, episodeElapsedAfterMs: Date.now() - startedAt, commandDurationMs: 0,
        deadlineKind: 'EPISODE_LIMIT', terminationReason: 'EPISODE_LIMIT', exitCode: null,
        spawnCategory: 'NOT_SPAWNED', budgetStatus: 'BUDGET_EXHAUSTED', summary: basename(paths.summary)
      };
      await writeArtifacts(paths, { summary: JSON.stringify(summary), metadata: JSON.stringify(metadata) });
      return { exitCode: 124, summary, paths, spawned: false };
    }

    const childArgs = mode === 'vitest' ? [...args, '--reporter=json'] : [...args];
    const commandStarted = performance.now();
    let child;
    try {
      child = spawn(executable, childArgs, {
        cwd: workspaceRoot, shell: false, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      const commandDurationMs = performance.now() - commandStarted;
      const summary = mode === 'vitest'
        ? { classification: 'OTHER_FAILURE', targetFullName: targetId, targetStatus: 'not-started',
          targetDurationMs: null, testCounts: null, fileCounts: null,
          exitCategory: 'SPAWN_FAILED', spawnCategory: 'SPAWN_FAILED', terminationReason: 'SPAWN_FAILED', ...EMPTY_PROBES }
        : { classification: 'OTHER_FAILURE', exitCategory: 'SPAWN_FAILED', spawnCategory: 'SPAWN_FAILED',
          terminationReason: 'SPAWN_FAILED', commandDurationMs, ...EMPTY_PROBES };
      const metadata = {
        ...baseMetadata, episodeElapsedAfterMs: Date.now() - startedAt, commandDurationMs,
        deadlineKind: null, terminationReason: 'SPAWN_FAILED', exitCode: null,
        spawnCategory: 'SPAWN_FAILED', summary: basename(paths.summary)
      };
      await writeArtifacts(paths, { summary: JSON.stringify(summary), metadata: JSON.stringify(metadata) });
      return { exitCode: 70, summary, paths, spawned: false };
    }

    let termination;
    let killerCleanup = null;
    let requestedTerminationReason = null;
    const terminate = reason => {
      requestedTerminationReason ??= reason;
      return (termination ??= killTree(child).then(result => {
        killerCleanup = result.killerCleanup;
        return selfTestForceTerminationFailure ? false : result.succeeded;
      }));
    };
    const governingDeadline = selfTestHardLimitMs !== undefined || COMMAND_LIMIT_MS <= episodeRemainingMs
      ? 'COMMAND_LIMIT' : 'EPISODE_LIMIT';
    const lifecycle = observeChild(child);
    let stdout;
    let stderr;
    let timer;
    let closeResult;
    let terminationSucceeded = true;
    let rawStdout = '';
    let rawStderr = '';
    try {
      stdout = capture(child.stdout, BUFFER_LIMIT, () => terminate('OUTPUT_LIMIT'));
      stderr = capture(child.stderr, BUFFER_LIMIT, () => terminate('OUTPUT_LIMIT'));
      timer = setTimeout(() => { void terminate(governingDeadline); }, effectiveLimitMs);
      closeResult = await lifecycle.result;
      terminationSucceeded = termination ? await termination : true;
      rawStdout = stdout.text();
      rawStderr = stderr.text();
    } finally {
      if (timer) clearTimeout(timer);
      timer = undefined;
      lifecycle.dispose();
      stdout?.dispose();
      stderr?.dispose();
    }
    const selfTestCleanup = process.env.AI_PET_GATE_RUNNER_SELF_TEST === '1' ? {
      timerCleared: timer === undefined,
      childErrorHandlers: child.listenerCount('error'),
      childCloseHandlers: child.listenerCount('close'),
      stdoutDataHandlers: child.stdout.listenerCount('data'),
      stderrDataHandlers: child.stderr.listenerCount('data')
    } : undefined;
    const commandDurationMs = performance.now() - commandStarted;
    const probes = extractProbeMetrics(rawStdout, rawStderr);
    let terminationReason = requestedTerminationReason;
    if (closeResult.spawnFailed) terminationReason = 'SPAWN_FAILED';
    if (!terminationSucceeded) terminationReason = 'TERMINATION_FAILED';
    const exitCategory = closeResult.spawnFailed
      ? 'SPAWN_FAILED'
      : terminationReason ? 'TERMINATED'
        : closeResult.code === 0 ? 'EXIT_ZERO' : 'EXIT_NONZERO';

    let summary;
    if (closeResult.spawnFailed) {
      summary = mode === 'vitest'
        ? { classification: 'OTHER_FAILURE', targetFullName: targetId, targetStatus: 'not-started',
          targetDurationMs: null, testCounts: null, fileCounts: null,
          exitCategory: 'SPAWN_FAILED', spawnCategory: 'SPAWN_FAILED', terminationReason: 'SPAWN_FAILED', ...probes }
        : { classification: 'OTHER_FAILURE', exitCategory: 'SPAWN_FAILED', spawnCategory: 'SPAWN_FAILED',
          terminationReason: 'SPAWN_FAILED', commandDurationMs, ...probes };
    } else if (mode === 'vitest') {
      try {
        const report = JSON.parse(stripProbeLines(rawStdout).replace(/^\uFEFF/u, ''));
        summary = {
          ...classifyVitest(report, targetId), targetFullName: targetId,
          testCounts: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests },
          fileCounts: { total: report.numTotalTestSuites, passed: report.numPassedTestSuites, failed: report.numFailedTestSuites },
          exitCategory, terminationReason, ...probes
        };
      } catch {
        summary = {
          classification: 'OTHER_FAILURE', targetFullName: targetId, targetStatus: 'unparseable',
          targetDurationMs: null, testCounts: null, fileCounts: null, exitCategory, terminationReason, ...probes
        };
      }
    } else {
      summary = {
        exitCategory, spawnCategory: closeResult.spawnFailed ? 'SPAWN_FAILED' : 'SPAWNED',
        terminationReason, commandDurationMs, ...probes
      };
    }
    if ((stdout.overflow() || stderr.overflow()) && terminationReason !== 'TERMINATION_FAILED') {
      terminationReason = 'OUTPUT_LIMIT';
      summary.terminationReason = 'OUTPUT_LIMIT';
    }
    if (probes.probeMetricOverflow) {
      summary.probeMetrics = [];
      summary.classification = 'OTHER_FAILURE';
    }
    if (terminationReason) {
      summary.classification = 'OTHER_FAILURE';
    } else if (closeResult.code !== 0 && summary.classification === 'GREEN') {
      summary.classification = 'OTHER_FAILURE';
    }

    const metadata = {
      ...baseMetadata, episodeElapsedAfterMs: Date.now() - startedAt, commandDurationMs,
      deadlineKind: ['COMMAND_LIMIT', 'EPISODE_LIMIT'].includes(requestedTerminationReason)
        ? requestedTerminationReason : null,
      terminationReason, exitCode: closeResult.code,
      spawnCategory: closeResult.spawnFailed ? 'SPAWN_FAILED' : 'SPAWNED', summary: basename(paths.summary)
    };
    const safeSummary = redact(JSON.stringify(summary), workspaceRoot);
    const safeMetadata = redact(JSON.stringify(metadata), workspaceRoot);
    await writeArtifacts(paths, { summary: safeSummary, metadata: safeMetadata });
    const runnerExit = terminationReason ? 124 : (closeResult.code ?? 70);
    return {
      exitCode: runnerExit, summary, paths, spawned: !closeResult.spawnFailed,
      selfTestStdout: process.env.AI_PET_GATE_RUNNER_SELF_TEST === '1' ? rawStdout : undefined,
      selfTestStderr: process.env.AI_PET_GATE_RUNNER_SELF_TEST === '1' ? rawStderr : undefined,
      selfTestPid: process.env.AI_PET_GATE_RUNNER_SELF_TEST === '1' ? child.pid : undefined,
      selfTestCleanup,
      selfTestKillerCleanup: process.env.AI_PET_GATE_RUNNER_SELF_TEST === '1' ? killerCleanup : undefined
    };
  }

  function parseCli(argv) {
    const separator = argv.indexOf('--');
    if (separator < 0) throw new Error('MISSING_COMMAND_SEPARATOR');
    const flags = argv.slice(0, separator);
    const command = argv.slice(separator + 1);
    const value = name => {
      const index = flags.indexOf(name);
      if (index < 0 || !flags[index + 1]) throw new Error(`MISSING_${name}`);
      return flags[index + 1];
    };
    return {
      mode: value('--mode'), episodeId: value('--episode'), seam: value('--seam'),
      round: Number(value('--round')), startedAtFile: value('--started-at'),
      targetId: flags.includes('--target-id') ? value('--target-id') : TARGET_ID,
      executable: command[0], args: command.slice(1)
    };
  }

  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runRound(parseCli(process.argv.slice(2)))
      .then(result => { process.exitCode = result.exitCode; })
      .catch(error => {
        process.stderr.write(`${redact(error?.message ?? error, process.cwd())}\n`);
        process.exitCode = 70;
      });
  }
  ```

- [ ] **Step 4：补全自测脚本并观察 GREEN**

  `test-diagnostic-runner.mjs` 完整内容固定为：

  ```js
  import assert from 'node:assert/strict';
  import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
  import { homedir, tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { classifyVitest, extractProbeMetrics, redact, runRound } from './run-diagnostic-round.mjs';

  const target = '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据';
  const root = await mkdtemp(join(tmpdir(), 'ai-pet-gate-runner-'));
  const artifacts = join(root, 'artifacts');
  const fixture = name => join(import.meta.dirname, 'runner-fixtures', name);
  const report = (assertions, success) => ({ success, testResults: [{ assertionResults: assertions }] });
  const assertion = (fullName, status, failureMessages = []) => ({ fullName, status, failureMessages });
  const startedAt = async (name, ageMs = 0) => {
    const file = join(root, name);
    await writeFile(file, new Date(Date.now() - ageMs).toISOString(), { flag: 'wx' });
    return file;
  };
  const exists = async path => access(path).then(() => true, () => false);
  const isDead = pid => {
    try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  };

  try {
    assert.equal(classifyVitest(report([
      assertion(target, 'passed'), assertion('其他测试', 'failed', ['Test timed out in 5000ms'])
    ], false)).classification, 'OTHER_FAILURE');
    assert.equal(classifyVitest(report([
      assertion(target, 'failed', ['Test timed out in 5000ms'])
    ], false)).classification, 'TARGET_FIXED_TIMEOUT');
    assert.equal(classifyVitest(report([
      assertion(target, 'failed', ['expected 2 to be 3'])
    ], false)).classification, 'OTHER_FAILURE');

    const privateValues = [root, tmpdir(), homedir(), process.env.USERPROFILE, 'C:\\Users\\Secret\\角色'].filter(Boolean);
    const redacted = redact(privateValues.join('\n'), root);
    for (const value of privateValues) assert.equal(redacted.includes(value), false);
    assert.deepEqual(extractProbeMetrics('ordinary output without prefix'), {
      probeMetrics: [], observedProbeMetricCount: 0,
      rejectedProbeMetricCount: 0, probeMetricOverflow: false
    });

    process.env.AI_PET_GATE_RUNNER_SELF_TEST = '1';
    const current = await startedAt('current.txt');
    const argvRun = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'argv', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('argv-child.mjs'), 'alpha'], workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(argvRun.exitCode, 0);
    const argvOutput = JSON.parse(argvRun.selfTestStdout);
    assert.deepEqual(argvOutput.argv, ['alpha']);
    assert.equal(argvOutput.argv.includes('--reporter=json'), false);
    assert.deepEqual(argvRun.selfTestCleanup, {
      timerCleared: true, childErrorHandlers: 0, childCloseHandlers: 0,
      stdoutDataHandlers: 0, stderrDataHandlers: 0
    });
    await assert.rejects(() => runRound({
      mode: 'native', episodeId: 'selftest', seam: 'argv', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('argv-child.mjs')], workspaceRoot: root, artifactDir: artifacts
    }), error => error?.code === 'EEXIST');
    assert.equal(JSON.parse(await readFile(argvRun.paths.summary, 'utf8')).exitCategory, 'EXIT_ZERO');

    const fake = await runRound({
      mode: 'vitest', episodeId: 'selftest', seam: 'fake-vitest', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('fake-vitest.mjs'), target], targetId: target,
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(fake.exitCode, 0);
    assert.equal(fake.summary.classification, 'GREEN');
    assert.equal(fake.summary.targetDurationMs, 123);

    const fakeExitOne = await runRound({
      mode: 'vitest', episodeId: 'selftest', seam: 'fake-vitest-exit-one', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('fake-vitest.mjs'), '--force-exit-one'], targetId: target,
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(fakeExitOne.summary.targetStatus, 'passed');
    assert.equal(fakeExitOne.summary.classification, 'OTHER_FAILURE');
    assert.equal(fakeExitOne.summary.exitCategory, 'EXIT_NONZERO');

    const fakeTimeout = await runRound({
      mode: 'vitest', episodeId: 'selftest', seam: 'fake-vitest-timeout', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('fake-vitest.mjs'), '--force-target-timeout'], targetId: target,
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(fakeTimeout.exitCode, 1);
    assert.equal(fakeTimeout.summary.targetStatus, 'failed');
    assert.equal(fakeTimeout.summary.classification, 'TARGET_FIXED_TIMEOUT');

    const probeRun = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'probe', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('probe-child.mjs')], workspaceRoot: root, artifactDir: artifacts
    });
    assert.deepEqual(probeRun.summary.probeMetrics, [
      { phase: 'rebuild-index', count: 2, durationMs: 12.5, category: 'IO' }
    ]);
    assert.equal(probeRun.summary.rejectedProbeMetricCount, 3);
    assert.equal(probeRun.summary.observedProbeMetricCount, 4);
    assert.equal(probeRun.summary.probeMetricOverflow, false);
    const persistedProbe = await readFile(probeRun.paths.summary, 'utf8');
    assert.equal(/bad-path|bad-body|secret|private|ordinary output/u.test(persistedProbe), false);

    const probe256 = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'probe-256', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('probe-child.mjs'), '--metric-count=256'],
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(probe256.summary.probeMetrics.length, 256);
    assert.equal(probe256.summary.observedProbeMetricCount, 256);
    assert.equal(probe256.summary.probeMetricOverflow, false);

    const probe257 = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'probe-257', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('probe-child.mjs'), '--metric-count=257'],
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.deepEqual(probe257.summary.probeMetrics, []);
    assert.equal(probe257.summary.observedProbeMetricCount, 257);
    assert.equal(probe257.summary.rejectedProbeMetricCount, 0);
    assert.equal(probe257.summary.probeMetricOverflow, true);
    assert.equal(probe257.summary.classification, 'OTHER_FAILURE');

    const spawnFailure = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'spawn-failure', round: 1,
      startedAtFile: current, executable: 'definitely-missing-ai-pet-gate-executable', args: [],
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(spawnFailure.summary.spawnCategory, 'SPAWN_FAILED');
    assert.equal(spawnFailure.summary.terminationReason, 'SPAWN_FAILED');
    assert.deepEqual(spawnFailure.selfTestCleanup, {
      timerCleared: true, childErrorHandlers: 0, childCloseHandlers: 0,
      stdoutDataHandlers: 0, stderrDataHandlers: 0
    });

    const old = await startedAt('old.txt', 3_660_000);
    const marker = join(root, 'must-not-spawn');
    const budget = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'budget', round: 1,
      startedAtFile: old, executable: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      workspaceRoot: root, artifactDir: artifacts
    });
    assert.equal(budget.spawned, false);
    assert.equal(budget.summary.terminationReason, 'EPISODE_LIMIT');
    assert.equal(JSON.parse(await readFile(budget.paths.metadata, 'utf8')).budgetStatus, 'BUDGET_EXHAUSTED');
    assert.equal(await exists(marker), false);

    const overflow = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'overflow', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('output-overflow.mjs')], workspaceRoot: root, artifactDir: artifacts,
      selfTestHardLimitMs: 10_000
    });
    assert.equal(overflow.summary.terminationReason, 'OUTPUT_LIMIT');

    const terminationFailure = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'termination-failure', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], workspaceRoot: root, artifactDir: artifacts,
      selfTestHardLimitMs: 100, selfTestForceTerminationFailure: true
    });
    assert.equal(terminationFailure.summary.terminationReason, 'TERMINATION_FAILED');
    assert.equal(isDead(terminationFailure.selfTestPid), true);

    const pidFile = join(root, 'tree-pids.json');
    const tree = await runRound({
      mode: 'native', episodeId: 'selftest', seam: 'tree', round: 1,
      startedAtFile: current, executable: process.execPath,
      args: [fixture('tree-parent.mjs'), pidFile], workspaceRoot: root, artifactDir: artifacts,
      selfTestHardLimitMs: 3_000
    });
    assert.equal(tree.exitCode, 124);
    assert.match(tree.selfTestStdout, /READY parent/u);
    assert.match(tree.selfTestStdout, /READY child/u);
    const treePids = JSON.parse(await readFile(pidFile, 'utf8'));
    assert.equal(isDead(treePids.parentPid), true);
    assert.equal(isDead(treePids.childPid), true);
    if (process.platform === 'win32') {
      assert.deepEqual(tree.selfTestKillerCleanup, { errorHandlers: 0, closeHandlers: 0 });
    }

    const artifactNames = await readdir(artifacts);
    for (const name of artifactNames) {
      const content = await readFile(join(artifacts, name), 'utf8');
      for (const value of privateValues) assert.equal(content.includes(value), false, name);
      assert.equal(/\b[A-Za-z]:\\/u.test(content), false, name);
      assert.equal(/failureMessages|expected|actual|privatePath|token|hash/u.test(content), false, name);
      assert.equal(/\.stdout\.|\.stderr\./u.test(name), false, name);
    }
    process.stdout.write('runner self-test: 15/15 passed\n');
  } finally {
    delete process.env.AI_PET_GATE_RUNNER_SELF_TEST;
    await rm(root, { recursive: true, force: true });
  }
  ```

  ```powershell
  node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs
  ```

  预期：十五组全部 GREEN；其中 fake Vitest 必须走真实 `runRound(mode='vitest')` 全链，目标 passed 但 exit 1 为 `OTHER_FAILURE`，目标自身 5000ms 且 exit 1 保留 `TARGET_FIXED_TIMEOUT`；probe 只保留白名单指标，256 边界正常、第 257 个清空指标并 `OTHER_FAILURE`；output overflow 得到 `OUTPUT_LIMIT`，终止失败得到 `TERMINATION_FAILED` 且无遗留 PID，进程树父子 PID 均死亡，cleanup snapshot 全零。任一自测达到 15 分钟立即停止，runner 状态不得写 Ready。

- [ ] **Step 5：生成 ignored review package 并独立复审**

  ```powershell
  Get-FileHash -Algorithm SHA256 .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs .superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs .superpowers/sdd/2026-08-21-desktop-development-gate-closure/runner-fixtures/*.mjs
  node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/test-diagnostic-runner.mjs
  git check-ignore -v .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs
  git status --short
  ```

  review package 保存 runner、selftest、fixtures 的完整内容与 hash、自测进程的最终 `15/15`/native exit 和 ignored 证明；不得保存任一 round 的 stdout/stderr。审查重点：单一 lifecycle/finally 清理、10 MiB 上限、Windows PID 树、probe 256 上限、termination 强制 OTHER、仅 GREEN 被非零 exit 覆盖、`TARGET_FIXED_TIMEOUT` 保留、最小 summary、`wx`/metadata 最后写与十五组测试真实性。Critical/Important 清零后在 `runner-review.md` 写 `状态：Ready`；本任务没有 tracked 变更，不提交。

---

### Task 1：建立最多三个有限 feedback seam 并取得同症状 RED

**文件：**
- 读取：`apps/desktop/tests/official-default-character.test.ts`
- 读取：`apps/desktop/tests/character-store.test.ts`
- 读取：`apps/desktop/tests/character-package-service.test.ts`
- 读取：`apps/desktop/tests/character-transaction-recovery.test.ts`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md`

**接口：**
- 本轮可计数 RED 只指结构化 classifier 对目标完整 test ID 自身给出 `TARGET_FIXED_TIMEOUT`；其他测试 5000ms、目标其他错误、缺模块、JSON 缺失、人工 sleep 或人为缩短 timeout 均不算 RED。
- seam 1 是单文件隔离基线，只测目标自身耗时和稳定性；即使 RED，也不得宣称复现了多文件并行负载根因。
- seam 2 固定四文件集合：`official-default-character.test.ts`、`character-asset-service.test.ts`、`character-store.test.ts`、`character-package-service.test.ts`。后三者当前存在且分别包含 127、191、118 个真实文件操作匹配；Asset/Store 有既有 5000ms 超时记录。一次 Vitest 命令同时传入四个文件，使 `maxWorkers=4` 对多文件并行真实生效。
- 每个 seam 固定输入、测试清单与五轮；每轮 stdout/stderr 只允许存在于 runner 有界内存，落盘仅有最小 summary 和 metadata；汇总只能机械读取这两类 JSON，不得以人工转述替代。
- seam 2 或 seam 3 中第一个达到至少 `2/5 TARGET_FIXED_TIMEOUT` 的 seam 成为 `PRIMARY_FEEDBACK_SEAM`。一旦建立高复现并行 seam，停止更宽 seam，避免无价值压力；未执行的后续 seam 明确写“因前序已达 2/5 未执行”。

- [ ] **Step 1：机械启动 60 分钟总预算**

  ```powershell
  New-Item -ItemType File -Path .superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnosis-started-at.txt -Value ([DateTimeOffset]::UtcNow.ToString('O')) -ErrorAction Stop | Out-Null
  ```

  后续每个 seam/probe 开始前都用当前 UTC 减该值，写入 elapsed；达到 60 分钟立即停止，不依赖人工估算。

- [ ] **Step 2：运行 seam 1——单文件隔离基线**

  执行五轮固定目标用例，每轮是独立 runner 进程：

  ```powershell
  1..5 | ForEach-Object {
    node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs `
      --mode vitest --episode initial --seam 1-isolated --round $_ `
      --started-at .superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnosis-started-at.txt `
      --target-id '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据' -- `
      node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts `
      tests/official-default-character.test.ts --maxWorkers=4 `
      -t '损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据'
  }
  ```

  不修改测试或生产实现。结果只作为隔离基线；无论是否 RED，都继续 seam 2，因为单文件不能证明多文件 worker 压力。

- [ ] **Step 3：只读确认 seam 2 固定多文件集合**

  ```powershell
  $feedbackFiles = @(
    'apps/desktop/tests/official-default-character.test.ts',
    'apps/desktop/tests/character-asset-service.test.ts',
    'apps/desktop/tests/character-store.test.ts',
    'apps/desktop/tests/character-package-service.test.ts'
  )
  $feedbackFiles | ForEach-Object { if (-not (Test-Path $_)) { throw "缺少固定压力文件：$_" } }
  rg -n "saveCompiled 首次写拒绝|事务恢复协调|5000ms|5 秒超时" docs/operations/character-workshop-acceptance.md
  rg -c "mkdtemp|readFile|writeFile|readdir|rm\(|mkdir|rename|link\(" $feedbackFiles
  ```

  任一文件不存在或已不再包含真实文件事务时，停止并更新计划/规格；不得临时换入无关 CPU 或网络测试。

- [ ] **Step 4：运行 seam 2——固定四文件并行压力**

  ```powershell
  1..5 | ForEach-Object {
    node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs `
      --mode vitest --episode initial --seam 2-four-files --round $_ `
      --started-at .superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnosis-started-at.txt `
      --target-id '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据' -- `
      node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts --maxWorkers=4 `
      tests/official-default-character.test.ts tests/character-asset-service.test.ts `
      tests/character-store.test.ts tests/character-package-service.test.ts
  }
  ```

  runner 必须在内存逐轮读取 JSON reporter 中完整 test ID 对应 assertion 的自身 `status`/`failureMessages`，随后只落盘分类与最小计数；不能因为进程退出非零或其他测试超时就自动算目标 RED。达到 `2/5` 后固定为主 seam；否则继续 seam 3。

- [ ] **Step 5：必要时运行 seam 3——Desktop unit 固定真实负载**

  ```powershell
  1..5 | ForEach-Object {
    node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs `
      --mode vitest --episode initial --seam 3-desktop-unit --round $_ `
      --started-at .superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnosis-started-at.txt `
      --target-id '官方默认角色安装 损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据' -- `
      node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts
  }
  ```

  每轮必须单独判断目标用例是否为同症状失败；其他用例超时只作为相邻信号，不计入目标 RED。单轮接近 15 分钟立即终止整条 seam。

- [ ] **Step 6：机械汇总脱敏结构化证据并裁决红能力，不得先修**

  对 `diagnostics/*.metadata.json` 逐个读取同前缀 `.summary.json`，生成汇总表，固定字段为：`episodeId`、`seam`、`round`、`targetFullName`、`targetStatus`、`targetDurationMs`、`classification`、`testCounts`、`fileCounts`、`probeMetrics`、`observedProbeMetricCount`、`rejectedProbeMetricCount`、`probeMetricOverflow`、`exitCode`、`spawnCategory`、`terminationReason`、`episodeElapsedBeforeMs`、`episodeElapsedAfterMs`、`commandDurationMs`、`effectiveLimitMs`、`deadlineKind`、`budgetStatus`、`summary`、`metadata`。不存在 stdout/stderr artifact，也不得从命令正文猜测目标状态。

  ```powershell
  $diagnostics = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnostics'
  $summary = Get-ChildItem $diagnostics -Filter '*.metadata.json' | Sort-Object Name | ForEach-Object {
    $metadata = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $prefix = $_.Name -replace '\.metadata\.json$', ''
    $summaryPath = Join-Path $diagnostics "$prefix.summary.json"
    $structured = Get-Content $summaryPath -Raw | ConvertFrom-Json
    [pscustomobject]@{
      episodeId = $metadata.episodeId
      seam = $metadata.seam
      round = [int]$metadata.round
      targetFullName = $structured.targetFullName
      targetStatus = $structured.targetStatus
      targetDurationMs = $structured.targetDurationMs
      classification = $structured.classification
      testCounts = $structured.testCounts
      fileCounts = $structured.fileCounts
      probeMetrics = $structured.probeMetrics
      observedProbeMetricCount = [int]$structured.observedProbeMetricCount
      rejectedProbeMetricCount = [int]$structured.rejectedProbeMetricCount
      probeMetricOverflow = [bool]$structured.probeMetricOverflow
      exitCode = $metadata.exitCode
      spawnCategory = $metadata.spawnCategory
      terminationReason = $metadata.terminationReason
      episodeElapsedBeforeMs = [long]$metadata.episodeElapsedBeforeMs
      episodeElapsedAfterMs = [long]$metadata.episodeElapsedAfterMs
      commandDurationMs = [double]$metadata.commandDurationMs
      effectiveLimitMs = [long]$metadata.effectiveLimitMs
      deadlineKind = $metadata.deadlineKind
      budgetStatus = $metadata.budgetStatus
      summary = [IO.Path]::GetFileName($summaryPath)
      metadata = $_.Name
    }
  }
  $aggregate = Join-Path $diagnostics 'episode-initial-seam-aggregate-round-00.summary.json'
  if (Test-Path $aggregate) { throw '汇总文件已存在，禁止覆盖' }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($summary | ConvertTo-Json -Depth 3))
  $stream = [IO.File]::Open($aggregate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  $summary | Format-Table -AutoSize
  ```

  报告固定写入：三个 seam 的执行/未执行理由、各轮统计、主 seam 命令、复现率、最高耗时和脱敏失败类别。此时禁止修改 `apps/desktop/src`、Vitest 配置、测试 timeout、retry 或测试断言。

  若三个 seam 都未捕获同症状，或没有任何 seam 达到足以区分修复前后的稳定信号，Task 1 结论为“未建立合格 RED，开发门仍关闭”；停止超时代码修改，转去 Task 4 完成 owner inventory。Task 4 复审完成后用 `apply_patch` 创建 `terminal-closure-brief.md`，内容固定为 `TerminalReason=NO_RED`、`ProducerTask=Task4`，再进入 Task X；不得进入 Task 2 根因修复链、Task 3、Task 5 或 Task 6。

- [ ] **Step 7：独立复审 feedback 证据**

  先机械执行隐私与清理门，不输出命中的敏感正文：

  ```powershell
  $diagnostics = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnostics'
  $forbidden = @((Resolve-Path .).Path, [IO.Path]::GetTempPath(), $HOME, $env:USERPROFILE) |
    Where-Object { $_ } | Sort-Object Length -Descending -Unique
  Get-ChildItem $diagnostics -File | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    foreach ($value in $forbidden) {
      if ($content.Contains($value, [StringComparison]::OrdinalIgnoreCase)) {
        throw "持久化诊断 artifact 未脱敏：$($_.Name)"
      }
    }
    if ($content -match '\b[A-Za-z]:\\') {
      throw "持久化诊断 artifact 仍含 Windows 绝对路径：$($_.Name)"
    }
  }
  ```

  审查者核对 Task R Ready、classifier 三项自检、最小 summary 与 metadata，确认目标完整 ID、自身状态/耗时、native exit、计数和单调耗时字段一致；确认其他测试 5000ms 不会误算目标 RED、每轮启动前检查 episode 预算、文件拒绝覆盖，且 artifact 不含 stdout/stderr、路径、正文、token、hash、expected、actual 或 failureMessages。Critical/Important 清零后才进入 Task 2。该任务没有 tracked 变更，不创建空提交。

---

### Task 2：用 3–5 个可证伪假设和单变量 probe 裁决根因

**文件：**
- 读取：Task 1 主 feedback seam 涉及的测试与生产调用链
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-ledger.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-probe-brief.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md`（仅根因成立时）

**接口：**
- `hypothesis-ledger.md` 只保留与 Task 1 证据相关的 3–5 项；每项包含预测、一个被改变变量、控制量、最多两条命令、观察值和“支持/排除/证据不足”。
- `hypothesis-probe-brief.md` 是插桩授权边界；每个假设必须先固定精确文件、符号、单变量、完整命令、采集指标、预期支持/排除结果、反向 `apply_patch` 和 `[DEBUG-DESKTOP-GATE]` 清理扫描。每个指标还必须声明唯一 `phase` 安全 token、`category` 枚举、`count` 语义与 `durationMs` 起止边界；独立审查标为 Ready 前禁止插桩或运行 probe。
- `root-cause-fix-brief.md` 只有在一个假设的预测成立、竞争假设按其预测被排除且 60 分钟预算未耗尽时生成。
- 若无法定位，终局是“开发门仍关闭”，不生成猜测性修复简报，不进入 Task 3。

- [ ] **Step 1：只读追踪目标调用链并选出 3–5 个假设**

  ```powershell
  rg -n "recoverCorruptIndex|ensureOfficialDefaultCharacter|prepareCharacterStartup|afterEach|temporaryDirectory|mkdtemp|rm\(" apps/desktop/tests/official-default-character.test.ts apps/desktop/src/main/characters
  rg -n "recoverCorruptIndex|mkdtemp|afterEach|rm\(" apps/desktop/tests/character-store.test.ts apps/desktop/tests/character-package-service.test.ts apps/desktop/tests/character-transaction-recovery.test.ts
  git diff -- apps/desktop/tests/official-default-character.test.ts apps/desktop/src/main/characters
  ```

  从下列候选中按 Task 1 证据选 3–5 项，不得自动认定任何一项为真：共享文件系统 I/O 竞争、同一事务重复磁盘工作、cleanup 与 worker 生命周期重叠、CPU/事件循环拥塞、进程级共享状态或缓存泄漏。

- [ ] **Step 2：先生成 hypothesis-probe-brief 并独立复审为 Ready**

  对选出的每个假设先读取实际符号，再在 brief 写入一条完整 probe。禁止写“在相关函数加日志”这类模糊动作；必须能由另一智能体只读 brief 完成正向和反向 patch。每条 probe 同时写入 `diagnosis-started-at.txt` 的读取命令：

  ```powershell
  $startedAt = [DateTimeOffset]::Parse((Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/diagnosis-started-at.txt -Raw).Trim())
  $elapsed = [DateTimeOffset]::UtcNow - $startedAt
  if ($elapsed.TotalMinutes -ge 60) { throw '超时诊断已达到 60 分钟终局' }
  "diagnosisElapsedMs=$([long]$elapsed.TotalMilliseconds)"
  ```

  每条 probe 的正向 patch 只能使用以下四字段 channel；变量必须来自 brief 指向的单调计数器与 `performance.now()` 差值：

  ```js
  // [DEBUG-DESKTOP-GATE] 仅供本轮单变量 probe，轮次结束后按 brief 反向补丁删除。
  process.stderr.write(`[GATE_PROBE]${JSON.stringify({
    phase: 'brief-fixed-safe-token',
    count: observedCount,
    durationMs: performance.now() - phaseStartedAt,
    category: 'IO'
  })}\n`);
  ```

  `phase` 必须匹配 `^[a-z][a-z0-9-]{0,63}$`；`category` 只能选 `IO|CLEANUP|CACHE|CPU|LIFECYCLE|STATE`；`count` 是非负安全整数，`durationMs` 是非负有限数。禁止添加 path、正文、token、hash、错误消息或第五个键。brief 必须把模板中的值替换为该假设的精确常量/变量，不能原样保留示例 token。

  独立审查者逐项确认仅改变一个变量、指标能证伪预测、命令低于 15 分钟、反向补丁可恢复、隐私字段不输出。Critical/Important 清零并在 brief 写 `状态：Ready` 后才进入 Step 3。

- [ ] **Step 3：按 Ready brief 的固定 probe 矩阵做单变量测量**

  每个已选假设最多从对应行执行两次；所有命令复用 Task 1 的固定输入和主 seam，只有“改变变量”不同：

  | 假设 | 控制量 | 唯一改变变量 | 支持预测 |
  | --- | --- | --- | --- |
  | 文件 I/O 竞争 | 目标输入、4 workers、五轮、临时盘 | 从目标文件扩展为目标 + `character-store` + `character-package-service` + `character-transaction-recovery` | 真实文件事务并发指标与目标耗时/红率同向恶化 |
  | 重复磁盘工作 | 主 seam、4 workers、相同资源 | 只增加临时阶段计数/耗时探针，不改控制流 | 同一事务内出现可删除的重复读取、复制、哈希或重建 |
  | cleanup 重叠 | 主 seam、相同输入和 worker | 只记录 setup/test/afterEach 开始结束边界 | 前一场景 cleanup 与目标事务真实重叠；等待正确 cleanup Promise 后重叠消失 |
  | CPU/事件循环拥塞 | 主 seam、相同文件负载 | 只记录事件循环长任务或已识别同步阶段耗时 | 稳定长任务与超时同现，而等价 I/O 压力变化不解释结果 |
  | 共享状态/缓存泄漏 | 文件集合、4 workers、五轮 | 只改变固定执行顺序/固定 seed | 特定前序集合稳定改变目标耗时；清除错误 owner 后顺序影响消失 |

  临时探针只能通过行首 `[GATE_PROBE]` channel 写上述四字段对象，源码旁带 `[DEBUG-DESKTOP-GATE]` 结构性注释。每次 probe 前后机械记录诊断 elapsed；每轮必须复用 runner 并只保存白名单指标。每次 probe 后必须同时核对 `rejectedProbeMetricCount=0` 与 `probeMetricOverflow=false`，再把 `probeMetrics` 写入 ledger；任一不满足时本轮证据无效，清理插桩并修正、复审 brief，禁止人工解释原始输出。每轮最多 256 个指标，brief 应优先聚合 count/duration 而不是逐事件输出；随后严格执行反向 `apply_patch` 和 DEBUG 零残留扫描。

- [ ] **Step 4：worker 假设只允许通过严格双门**

  只有 probe 已识别“随 worker 数变化的具体资源容量不变量”，并按各自预测排除 cleanup、共享状态、可消除重复工作及仍相关候选后，才可执行效果门：

  ```powershell
  # 同一主压力 loop：4 workers 必须至少 2/5 同症状 RED。
  # 仅改变 worker 值为 3；五轮必须 5/5 GREEN。
  # 仅改变 worker 值为 2；只有 3 未达 5/5 时才用于候选裁决。
  ```

  若 3 和 2 均为 5/5，简报只能选择 3；只有 2 达标才可选择 2；1 或串行永远不允许。仅有“更快”或“更绿”而没有资源不变量，不得修改 `maxWorkers: 4`，根因写“证据不足”，开发门保持关闭。

- [ ] **Step 5：在 60 分钟硬预算内形成唯一根因裁决**

  根因成立必须同时满足：主 seam 已 RED；至少一个假设预测得到支持；竞争假设有排除证据；拟修复行为能在公开 seam 被先 RED 后 GREEN 观察。报告同时列出未支持假设，禁止在代码中留下对应补丁。

  若计时达到 60 分钟、五个假设均证据不足或竞争解释无法排除，立即删除全部临时探针，写明每个 seam、probe、已排除项和缺失证据，裁决“开发门仍关闭”；转去 Task 4 审计。Task 4 复审完成后用 `apply_patch` 创建 `terminal-closure-brief.md`，内容固定为 `TerminalReason=NO_ROOT_CAUSE`、`ProducerTask=Task4`，再进入 Task X；不进入 Task 3、Task 5 或 Task 6。

- [ ] **Step 6：生成无猜测的 root-cause-fix-brief 并独立复审**

  简报必须填入诊断已经确定的具体内容：根因陈述；证据表；唯一修复文件路径和符号；唯一测试文件、公开 seam 与测试标题；精确 RED 命令和预期失败原因；最小实现删除/修改范围；GREEN 命令；原始未缩小 feedback 命令；临时探针清理清单；受影响 typecheck/测试；worker 分支的资源不变量和 4/3/2 五轮数据（若适用）。同时把全部且仅有的 tracked 路径逐行写入 `root-cause-fix-files.txt`。任一字段无法由现有证据填写，就不生成简报和路径文件。

  独立审查者必须能够从 ledger 复算因果链；Critical/Important 清零后才进入 Task 3。该任务不提交诊断产物，不创建空提交。

---

### Task 3：按诊断 brief 进行 TDD 最小根因修复

**文件：**
- 读取：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md`
- 修改/测试：仅限 brief 已由 Task 2 证据确定的精确文件；未列入 brief 的文件禁止触碰

**接口：**
- 修复只消除已证实根因，不顺带重构角色恢复体系。
- 若正确公开 seam 已存在，增强或复用其唯一 owner；若不存在，建立最窄公开 seam并在同一任务删除被替代的内部耦合表达，不得双轨。

- [ ] **Step 1：把 brief 转为任务边界并确认无越界差异**

  ```powershell
  Get-Content -Raw .superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md
  git status --short
  git diff --name-only
  ```

  若 brief 不存在、缺少具体文件/符号/RED 命令，或工作树含冲突改动，立即停止；不猜修复位置。

- [ ] **Step 2：在正确公开 seam 固化最小回归并观察 RED**

  只实施 brief 的测试变化，执行其精确 RED 命令。预期必须因已确认根因而 RED；若失败原因不同或仍 GREEN，撤销本步最小测试变化、回到 Task 2，不写实现。

- [ ] **Step 3：实现只足以消除根因的最小改动**

  只修改 brief 列明的生产/配置 owner。优先删除重复工作、修正真实 cleanup owner 或错误共享状态；不增加 retry、timeout、吞错 wrapper、缓存双轨或第二套恢复路径。

  若 brief 裁决 worker 为根因，必须同时满足并落盘：选定值不低于 2；优先稳定的最高值；配置契约测试锁定选定值与最低边界；报告包含 4 workers `>=2/5 RED`、候选值 `5/5 GREEN`、资源指标和相对耗时。任一数据缺失都保持 4，不得提交 worker 修改。

- [ ] **Step 4：观察 GREEN 并复验原始未缩小 feedback seam**

  新建且拒绝覆盖 `root-fix-verification-started-at.txt`，使用 `EpisodeId='root-fix-verification'` 和新的 seam 名依次运行 brief 的最小回归、原始未缩小 feedback seam及受影响 package typecheck。验证不复用 initial episode 的 artifact 名或 60 分钟 started-at；最小回归和原始 seam 均须 GREEN。worker 分支还须完整 Desktop unit 连续两次退出 0，并记录目标耗时、总耗时、worker 值和资源指标。

  Desktop typecheck 固定使用 native mode，不得让 runner 追加 Vitest reporter：

  ```powershell
  node .superpowers/sdd/2026-08-21-desktop-development-gate-closure/run-diagnostic-round.mjs `
    --mode native --episode root-fix-verification --seam desktop-typecheck --round 1 `
    --started-at .superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-fix-verification-started-at.txt -- `
    node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
  ```

- [ ] **Step 5：只删除生产/正式测试插桩并检查禁止项**

  ```powershell
  rg -n "DEBUG-DESKTOP-GATE|testTimeout|retry|\.skip\(|\.todo\(" apps/desktop/src apps/desktop/tests apps/desktop/vitest.config.ts
  git diff --check
  git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  ```

  仅允许仓库既有、与本任务无关的命中；插入 `apps/desktop` 生产、正式测试或 config 的 debug/probe 必须为零。ignored runner、fixtures、selftest、review package 与最小 summary/metadata 此时必须保留供 Task 5 复核，不得提前删除。保护路径无输出。

- [ ] **Step 6：独立复审并提交根因修复**

  审查者核对 RED 原因、根因证据、最小性、禁止项、临时探针零残留及 worker 双门。Critical/Important 清零后提交 brief 列出的全部且仅这些文件：

  ```powershell
  $fixFiles = Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-files.txt
  if ($fixFiles.Count -eq 0) { throw '修复路径清单为空，禁止提交' }
  git add -- $fixFiles
  $actualCached = @(git diff --cached --name-only)
  if (@(Compare-Object $fixFiles $actualCached).Count -gt 0) { throw 'Task 3 commit allowlist 不一致' }
  git commit -m "fix(desktop): 根治并行恢复测试超时"
  git status --short
  ```

  暂存清单必须与已复审 brief 完全一致；不一致时取消提交并修正清单。提交后不得有 tracked 残留，并把精确 hash 写入 ignored 报告。

---

### Task 4：建立逐文件、逐有效 hunk 的唯一 owner inventory 并只做安全减法

**文件：**
- 创建：`docs/operations/desktop-test-owner-inventory.md`
- 可能修改：仅 inventory 证明可替换/删除且通过删除门的现有测试、fixture 或 helper；路径必须先在 inventory 写明
- 范围：`c7d951d..当前最终候选 HEAD` 下 `apps/desktop/tests` 与 `tests/e2e` 的全部实际变更文件

**接口：**
- Task 3 合法完成时，owner 审计从其提交 HEAD 开始；Task 2 以“根因未定位、开发门关闭”结束且没有 Task 3 时，先把当时 HEAD 写为 `OWNER_AUDIT_HEAD`，Task 4 仍可交付 owner 审计，但不得进入 Task 5 解锁门。Task 4 不依赖一个不存在的 Task 3 提交。
- 每个变更文件至少一条 inventory 或可核验排除理由；每个有效 hunk/测试簇必须归类为 `业务 owner`、`测试装配`、`已删旧路径`、`纯移动/格式`。
- 每条业务 owner 必须有公开 seam、最低合理测试层、RED 能力证据、疑似重复裁决和旧路径依赖结论。
- 文件级 added/deleted 必须与 `git diff --numstat` 对账，所有文件求和必须等于 Git 总账。

- [ ] **Step 1：固定 OWNER_AUDIT_HEAD 并重新生成真实文件清单**

  ```powershell
  git rev-parse HEAD | Set-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-audit-head.txt
  git diff --name-status c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --unified=0 c7d951d..HEAD -- apps/desktop/tests tests/e2e
  ```

  当前已知 20 个文件只能作为起始核对；Task 3 若改变测试文件，必须使用新清单，不能漏项。

- [ ] **Step 2：按四组完成只读 owner 盘点**

  依次盘点且不并发写同一 inventory：

  1. Agent/IPC/窗口边界：`agent-ipc*`、`conversation-event-projection`、`character-ipc`、`preload-api`、`window-security`、`main-lifecycle`；
  2. 角色事务与包恢复：`atomic-file-coordinator`、`character-package-service`、`character-store`、`character-transaction-recovery`；
  3. 启动/Renderer/工作室：`character-recovery`、`character-startup`、`official-default-character`、`pet-view`、两个 workshop 测试；
  4. 验证入口与真实 Electron：`desktop-e2e-entry`、已删除的 `vitest-worker-cap`、`tests/e2e/desktop.spec.ts`。

  每组可由只读子智能体分别出报告，主智能体是 `desktop-test-owner-inventory.md` 的唯一 writer。

- [ ] **Step 3：为每个测试簇填写完整字段并形成候选裁决**

  每条固定写入：路径与 hunk/标题定位、四类之一、不变量或装配目的、公开 seam/层级、RED 证据、相邻重复 owner、旧路径依赖、保留/合并/下移/替换/删除/排除裁决、文件级 numstat。必须逐项覆盖 owner token、真实 Store 重启、竞态、证据发布与保留、256/2000ms 边界、启动顺序、fallback、最终 load 两类失败、不可变快照、Main/Preload 双边界、Pet 顺序、Workshop StrictMode/脱敏、Electron 生命周期/诊断/窗口交互和两条恢复重启 E2E。

- [ ] **Step 4：仅对通过删除门的表达实施替换式减法**

  每个候选必须先指出替代 owner 和精确 seam，以 mutation、历史 RED 或最小破坏证明替代 owner 会捕获回归，确认不是唯一安全/竞态/持久化/Electron 证据，再让保留 owner GREEN，最后删除旧测试、旧 helper、旧 fixture 和只服务旧路径的注释。

  新抽象必须同时减少 owner 数和总代码；少量行数不引入通用 helper。若没有候选完整通过删除门，Task 4 合法结果是“零安全删除”，不得为制造减法而改代码。

- [ ] **Step 5：验证每组减法并暂存候选实现**

  每个实际减法组运行受影响层的最小测试、Desktop typecheck（涉及 Desktop TypeScript 时）和 `git diff --check`。把所有通过删除门且实际修改的路径逐行写入 `owner-subtraction-files.txt`，然后只暂存这些候选文件：

  ```powershell
  $subtractionFiles = @(Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-subtraction-files.txt)
  if ($subtractionFiles.Count -gt 0) { git add -- $subtractionFiles }
  $actualCached = @(git diff --cached --name-only)
  $unexpected = @(Compare-Object $subtractionFiles $actualCached)
  if ($unexpected.Count -gt 0) { throw 'Task 4 暂存集合与安全减法 allowlist 不一致' }
  ```

  此时 inventory 尚未暂存，必须基于“基线 commit 与 cached 候选树”生成真实总账：

  ```powershell
  git diff --cached --numstat c7d951d -- apps/desktop/tests tests/e2e
  git diff --cached --name-status c7d951d -- apps/desktop/tests tests/e2e
  git diff --cached --unified=0 c7d951d -- apps/desktop/tests tests/e2e
  rg -n "startupRecoveryErrorCode|loadCharacterStartupRecovery|fallbackActive|CharacterActions.*getCharacterRecoverySnapshot|export \{ characterRecoveryMessage \}" apps/desktop/src packages
  git diff --check
  ```

  用以上 cached 候选 diff 完成 `desktop-test-owner-inventory.md` 的最终逐文件/hunk 对账；`fallbackActive` 若仅存在于严格 Schema 负例，明确登记，不误报为生产旧 owner。最终净值如实记录，不宣称“安全减法已穷尽”。

- [ ] **Step 6：独立复审并提交最终可执行树候选**

  先暂存 inventory，再机械比较完整 allowlist；审查者针对 cached 候选 diff 逐文件抽查 hunk、RED 证据、分层和算术，并确认 Critical/Important 为零：

  ```powershell
  git add docs/operations/desktop-test-owner-inventory.md
  $subtractionFiles = @(Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-subtraction-files.txt)
  $expectedCached = @('docs/operations/desktop-test-owner-inventory.md') + $subtractionFiles
  $actualCached = @(git diff --cached --name-only)
  if (@(Compare-Object $expectedCached $actualCached).Count -gt 0) { throw 'Task 4 commit allowlist 不一致' }
  git commit -m "test(desktop): 收口唯一测试 owner"
  git status --short
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  ```

  提交后 `c7d951d..HEAD` 的逐文件和总 `numstat` 必须与 inventory 完全一致，且 `git status --short` 不得有 tracked 残留；否则修正文档/提交并重新复审。根因已修复时该 HEAD 才是“最终可执行树候选”；无 Task 3 时必须由上游失败分支在本任务复审后创建 `terminal-closure-brief.md`，再进入 Task X，只交付 owner 审计与“开发门仍关闭”，不进入 Task 5。

---

### Task 5：在同一个最终可执行树 HEAD 上一次执行五条正式门

**文件：**
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-report.md`
- 不修改任何 tracked 文件

**接口：**
- `FINAL_EXECUTABLE_HEAD` 是 Task 3 修复、Task 4 inventory/减法和门禁前计划均已提交，且工作树无可执行差异的精确 HEAD。
- 五条顶层命令在该 HEAD 各执行一次且必须全部退出 0；历史绿色、内嵌相同步骤、定向绿色或另一 HEAD 不能替代。
- 最终五门最多两轮：第一轮是本任务初次执行；若失败，最多允许一个新的、总计不超过 60 分钟的诊断 episode。只有该 episode 定位并修复根因、重新完成 Task 4 和固定新 HEAD 后，才允许第二轮；第二轮任一失败即开发门关闭并另立短规格。

- [ ] **Step 1：固定最终可执行树 HEAD 并做门前静态检查**

  ```powershell
  git status --short
  git rev-parse HEAD | Set-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/final-executable-head.txt
  $implementationBaseline = (Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/implementation-baseline.txt -Raw).Trim()
  git diff --check
  git diff --name-only "$implementationBaseline..HEAD" -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --cached --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  ```

  工作树不干净、保护路径有输出或生产/正式测试 DEBUG 探针仍存在时不得开始五门。ignored runner、fixtures、selftest 与 review package 此时应继续存在供失败诊断复用；把精确 HEAD 写入 gate report，并记录“解锁交付窗口开始”。

- [ ] **Step 2：依次执行第一轮五条正式门，本轮每条一次、15 分钟硬停**

  ```powershell
  pnpm.cmd verify:desktop
  pnpm.cmd verify:characters
  pnpm.cmd verify:behavior
  pnpm.cmd test:security
  pnpm.cmd test:integration
  ```

  每轮先写唯一段落标题 `## Gate round N` 和唯一机器行 `gateRound=N`，该轮每条记录开始/结束时间、退出码、阶段摘要和耗时；机器结果必须带轮次前缀：`roundN.<script>=<exitCode>`。成功轮必须逐字得到 `roundN.verify:desktop=0`、`roundN.verify:characters=0`、`roundN.verify:behavior=0`、`roundN.test:security=0`、`roundN.test:integration=0`。任一命令达到 15 分钟立即终止；任一退出非零立即停止本轮剩余正式门，不在同一 HEAD 重跑碰运气。禁止保留无轮次前缀的旧机器行。

- [ ] **Step 3：第一轮失败最多开启一个新的 60 分钟诊断 episode**

  若任一门失败，先把状态写为“开发门仍关闭”，并在 gate report 当前轮段落机械记录失败命令、带轮次前缀的 native exit、最小失败类别和失败阶段；不得保存该门 stdout/stderr 正文。在执行任何诊断命令前创建 `gate-failure-episode-brief.md`，固定写入：失败域、失败测试完整 ID 或失败脚本阶段、可复现 seam、3–5 个候选假设、每个 probe 的精确命令/指标/预测/清理、60 分钟 started-at 文件和 `EpisodeId='gate-failure-1'`。由新鲜独立审查者确认 Critical/Important 为零并标记 `状态：Ready` 后，才允许启动这唯一一个新 episode。

  只有失败仍是同一个 official-default 完整 test ID 的自身 5000ms，brief 才能引用 Task 1/2 的固定三 seam 和假设。若失败属于 security、integration、behavior、characters、Electron E2E、构建、类型检查或其他单元测试，必须按该失败域建立专属最小 seam 与假设，禁止套用角色恢复压力文件。brief 无法提供专属可证伪 seam 时直接关门并另立短规格。

  Ready 后用 `New-Item` 创建全新的 `gate-failure-episode-started-at.txt`（已存在则拒绝）。Vitest 专属 seam 使用 runner 的 `vitest` mode；Playwright、构建、类型检查等非 Vitest 失败使用同一 runner 的 `native` mode，并在 brief 中指定可由 exit/spawn/termination 类别证伪的 seam。两种 mode 都遵守启动前 3600 秒预算检查、episode/seam/round 不覆盖命名、有界内存且 stdout/stderr 正文零落盘；达到 3600 秒写 `BUDGET_EXHAUSTED` 且不启动。episode 仍受 3–5 假设、每假设最多两 probe、单命令 15 分钟和总计 60 分钟约束。

  如果 60 分钟内未定位或未修复，立即结束，开发门保持关闭，并另立短规格记录新证据；不得启动第二个 episode。先在 gate report 追加唯一 `finalGateRound=1`，再用 `apply_patch` 创建 `terminal-closure-brief.md`，内容固定为 `TerminalReason=GATE_FAILURE`、`ProducerTask=Task5`，随后进入 Task X。若修复涉及任何代码、测试、fixture、config、依赖、脚本或其他可执行变化，必须回到 Task 4：刷新全部 inventory/hunk/numstat，按 allowlist 提交，确认提交后对账一致，再写入新的 `final-executable-head.txt`。即使修复只改变测试，也不得跳过 Task 4。

  只有上述修复与 Task 4 全部完成，才允许在新 HEAD 从 `verify:desktop` 开始执行第二轮完整五门，并新建 `## Gate round 2` 段落和唯一 `gateRound=2`。第一轮已通过的命令不能拼接进第二轮。第二轮是绝对上限；任一失败即关门并另立短规格，不再诊断或重跑；先追加唯一 `finalGateRound=2`，再用 `apply_patch` 创建 `terminal-closure-brief.md`，固定写 `TerminalReason=GATE_FAILURE`、`ProducerTask=Task5`，再进入 Task X。

- [ ] **Step 4：全绿后固定静态证据和最终总账**

  ```powershell
  git rev-parse HEAD
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --name-status c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --check
  git status --short
  rg -n "startupRecoveryErrorCode|loadCharacterStartupRecovery|fallbackActive|CharacterActions.*getCharacterRecoverySnapshot|export \{ characterRecoveryMessage \}" apps/desktop/src packages
  ```

  再次核对三个保护范围（实施基线提交区间、工作树、暂存区）均零差异。最终精确净值必须与 inventory 对齐。

- [ ] **Step 5：独立复审五门报告**

  审查者核对最终轮五条命令确实各运行一次、HEAD 相同、退出 0、时间低于 15 分钟、无 retry/skip/timeout/无证据 worker 变化、inventory 总账一致、保护路径为零。Critical/Important 清零后才在 gate report 追加唯一 `finalGateRound=N` 和同轮唯一 `roundN.terminalGateStatus=SUCCESS`，并用 `apply_patch` 创建 `terminal-closure-brief.md`，固定写 `TerminalReason=FIVE_GATES_GREEN`、`ProducerTask=Task5`。历史轮即使含绿色结果也不得拼接到最终轮；失败报告不得包含其 `finalGateRound` 对应轮的成功行与五条全零组合。随后进入 Task X，Task X 完成前不得进入 Task 6。

  Task 5 不创建 commit：任何提交都会改变 `FINAL_EXECUTABLE_HEAD`。gate report 记录同一 HEAD 并保持 ignored。

---

### Task X：统一收口成功或关门终局并删除 ignored 临时工具

**文件：**
- 读取：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/terminal-closure-brief.md`
- 创建/删除：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-pending.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-report.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-review.md`
- 删除：仅本任务列出的 ignored runner、selftest、fixtures 与 review package
- 保留：终局分支要求的全部 evidence，以及 `diagnostics/` 下全部 `.summary.json`/`.metadata.json`

**接口：**
- `TerminalReason` 只能来自上游 `terminal-closure-brief.md` 的唯一行，枚举为 `NO_RED|NO_ROOT_CAUSE|GATE_FAILURE|FIVE_GATES_GREEN`；禁止根据 ignored 文件是否存在来猜分支。
- `ProducerTask` 在 brief/pending/final 中都必须且只能出现一次并一致；`NO_RED|NO_ROOT_CAUSE` 只能映射 `Task4`，`GATE_FAILURE|FIVE_GATES_GREEN` 只能映射 `Task5`。
- 四分支共同必须证据：`terminal-closure-brief.md`、`baseline.md`、`implementation-baseline.txt`、`feedback-results.md`、`docs/operations/desktop-test-owner-inventory.md`，以及 `diagnostics/` 下当时存在的全部 `.summary.json`/`.metadata.json` 相对路径。
- `NO_RED`：禁止存在 `hypothesis-probe-brief.md`、`hypothesis-ledger.md`、`root-cause-fix-brief.md`、`root-cause-fix-files.txt`、`gate-report.md`、`gate-failure-episode-brief.md`、`final-executable-head.txt`。
- `NO_ROOT_CAUSE`：额外必须 `hypothesis-probe-brief.md`、`hypothesis-ledger.md`；禁止存在 `root-cause-fix-brief.md`、`root-cause-fix-files.txt`、`gate-report.md`、`gate-failure-episode-brief.md`、`final-executable-head.txt`。
- `GATE_FAILURE`：额外必须 `hypothesis-probe-brief.md`、`hypothesis-ledger.md`、`root-cause-fix-brief.md`、`root-cause-fix-files.txt`、`gate-report.md`、`gate-failure-episode-brief.md`、`final-executable-head.txt`；gate report 必须有唯一 `finalGateRound=N`，且同轮禁止 `roundN.terminalGateStatus=SUCCESS` 和五条全零组合。
- `FIVE_GATES_GREEN`：额外必须 `hypothesis-probe-brief.md`、`hypothesis-ledger.md`、`root-cause-fix-brief.md`、`root-cause-fix-files.txt`、`gate-report.md`、`final-executable-head.txt`；gate report 必须在唯一 `finalGateRound=N` 对应轮含唯一 `roundN.terminalGateStatus=SUCCESS` 与同轮五条精确 `=0`。`gate-failure-episode-brief.md` 允许存在或不存在，因为首轮全绿和第二轮修复后全绿都合法。
- pending/final 的 `evidence=` 清单只含保留证据与 diagnostics，不得把将删除的九个工具列为 evidence；工具只出现在 `before=`/`after=` 行。

- [ ] **Step 1：验证显式 reason 和分支证据，再用 `apply_patch` 创建或恢复 pending**

  重跑入口先只读检查三状态文件：pending 不存在而 final 与 Ready review 都存在时，说明 Task X 已完成，跳过 Step 1–3，直接执行 Step 4 的一致性验证；pending 不存在且 final/review 只存在其一时属于非法孤儿状态，停止且不得重建 pending、review 或覆盖 final。其他情况按下列检查继续。

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $repoRoot = (Get-Location).Path
  $relativeRoot = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure'
  $root = [IO.Path]::GetFullPath((Join-Path $repoRoot $relativeRoot))
  function Assert-RepoRelativePath([string]$path, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path -match '^[A-Za-z]:[\\/]|^\\\\|^/' -or $path.Contains('\') -or @($path -split '/' | Where-Object { $_ -eq '..' }).Count -gt 0) { throw "$label 不是安全 repo-relative 路径：$path" }
    if (-not ($path.StartsWith("$relativeRoot/") -or $path -eq 'docs/operations/desktop-test-owner-inventory.md')) { throw "$label 不在允许前缀：$path" }
  }
  $reasonLines = @(Get-Content "$root/terminal-closure-brief.md" | Where-Object { $_ -match '^TerminalReason=' })
  if ($reasonLines.Count -ne 1) { throw 'terminal brief 必须且只能有一个 TerminalReason' }
  $terminalReason = $reasonLines[0].Substring('TerminalReason='.Length)
  if ($terminalReason -notin @('NO_RED','NO_ROOT_CAUSE','GATE_FAILURE','FIVE_GATES_GREEN')) { throw 'TerminalReason 非法' }
  $producerLines = @(Get-Content "$root/terminal-closure-brief.md" | Where-Object { $_ -match '^ProducerTask=' })
  if ($producerLines.Count -ne 1) { throw 'terminal brief 必须且只能有一个 ProducerTask' }
  $expectedProducer = if ($terminalReason -in @('NO_RED','NO_ROOT_CAUSE')) { 'Task4' } else { 'Task5' }
  if ($producerLines[0] -ne "ProducerTask=$expectedProducer") { throw 'TerminalReason 与 ProducerTask 映射错误' }
  $commonEvidence = @(
    "$relativeRoot/terminal-closure-brief.md", "$relativeRoot/baseline.md", "$relativeRoot/implementation-baseline.txt",
    "$relativeRoot/feedback-results.md", 'docs/operations/desktop-test-owner-inventory.md'
  )
  $requiredEvidence = @($commonEvidence)
  $forbiddenEvidence = @()
  switch ($terminalReason) {
    'NO_RED' {
      $forbiddenEvidence = @(
        "$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md",
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/gate-failure-episode-brief.md", "$relativeRoot/final-executable-head.txt"
      )
    }
    'NO_ROOT_CAUSE' {
      $requiredEvidence += @("$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md")
      $forbiddenEvidence = @(
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/gate-failure-episode-brief.md", "$relativeRoot/final-executable-head.txt"
      )
    }
    'GATE_FAILURE' {
      $requiredEvidence += @(
        "$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md",
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/gate-failure-episode-brief.md", "$relativeRoot/final-executable-head.txt"
      )
    }
    'FIVE_GATES_GREEN' {
      $requiredEvidence += @(
        "$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md",
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/final-executable-head.txt"
      )
      if (Test-Path -LiteralPath "$root/gate-failure-episode-brief.md") {
        $requiredEvidence += "$relativeRoot/gate-failure-episode-brief.md"
      }
    }
  }
  $requiredEvidence | ForEach-Object { if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf)) { throw "缺少必须证据：$_" } }
  $forbiddenEvidence | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $repoRoot $_)) { throw "出现禁止证据：$_" } }
  if ($terminalReason -in @('GATE_FAILURE','FIVE_GATES_GREEN')) {
    $gateLines = Get-Content "$root/gate-report.md"
    $finalRoundLines = @($gateLines | Where-Object { $_ -match '^finalGateRound=' })
    if ($finalRoundLines.Count -ne 1) { throw 'gate report finalGateRound 非唯一' }
    $finalRound = $finalRoundLines[0].Substring('finalGateRound='.Length)
    if ($finalRound -notin @('1','2')) { throw 'finalGateRound 非法' }
    if (@($gateLines | Where-Object { $_ -eq "## Gate round $finalRound" }).Count -ne 1) { throw '最终轮 gate 段落标题非唯一' }
    if (@($gateLines | Where-Object { $_ -eq "gateRound=$finalRound" }).Count -ne 1) { throw '最终轮 gateRound 机器行非唯一' }
    $scripts = @('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
    $successLine = "round${finalRound}.terminalGateStatus=SUCCESS"
    $successCount = @($gateLines | Where-Object { $_ -eq $successLine }).Count
    $resultCounts = @{}
    $zeroCounts = @()
    foreach ($script in $scripts) {
      $prefix = "round${finalRound}.$script="
      $resultLines = @($gateLines | Where-Object { $_.StartsWith($prefix) })
      if ($resultLines.Count -gt 1) { throw "最终轮同一脚本存在多个结果：$script" }
      if ($resultLines.Count -eq 1 -and $resultLines[0] -notmatch ('^' + [regex]::Escape($prefix) + '-?\d+$')) { throw "最终轮脚本结果格式非法：$script" }
      $resultCounts[$script] = $resultLines.Count
      $zeroCounts += @($gateLines | Where-Object { $_ -eq "${prefix}0" }).Count
    }
    $finalPrefixedLines = @($gateLines | Where-Object { $_ -match "^round${finalRound}\." })
    foreach ($line in $finalPrefixedLines) {
      if ($line -eq $successLine) { continue }
      $known = $false
      foreach ($script in $scripts) {
        if ($line -match ('^' + [regex]::Escape("round${finalRound}.$script=") + '-?\d+$')) { $known = $true; break }
      }
      if (-not $known) { throw "最终轮出现未知或格式非法的机器行：$line" }
    }
    if ($terminalReason -eq 'FIVE_GATES_GREEN') {
      if ($successCount -ne 1 -or @($resultCounts.Values | Where-Object { $_ -ne 1 }).Count -ne 0 -or @($zeroCounts | Where-Object { $_ -ne 1 }).Count -ne 0) { throw '成功分支最终轮机器行不完整或重复' }
    } else {
      if ($successCount -ne 0) { throw '失败分支最终轮含成功行' }
      if (@($resultCounts.Values | Where-Object { $_ -eq 1 }).Count -eq 0) { throw '失败分支最终轮没有已执行脚本结果' }
      if (@($zeroCounts | Where-Object { $_ -ge 1 }).Count -eq 5) { throw '失败分支最终轮含五门全零组合' }
    }
  }
  $diagnosticPaths = @(
    Get-ChildItem "$root/diagnostics" -File |
      Where-Object { $_.Name -match '\.(summary|metadata)\.json$' } |
      Sort-Object Name |
      ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1).Replace('\','/') }
  )
  $summaryPathCount = @($diagnosticPaths | Where-Object { $_ -match '\.summary\.json$' }).Count
  $metadataPathCount = @($diagnosticPaths | Where-Object { $_ -match '\.metadata\.json$' }).Count
  if ($summaryPathCount -eq 0 -or $metadataPathCount -eq 0) {
    throw 'diagnostics 必须同时含 summary 与 metadata'
  }
  $requiredEvidence = @($requiredEvidence | Sort-Object -Unique)
  $toolPaths = @(
    "$relativeRoot/run-diagnostic-round.mjs", "$relativeRoot/test-diagnostic-runner.mjs", "$relativeRoot/runner-review.md",
    "$relativeRoot/runner-fixtures/argv-child.mjs", "$relativeRoot/runner-fixtures/fake-vitest.mjs",
    "$relativeRoot/runner-fixtures/probe-child.mjs", "$relativeRoot/runner-fixtures/output-overflow.mjs",
    "$relativeRoot/runner-fixtures/tree-child.mjs", "$relativeRoot/runner-fixtures/tree-parent.mjs"
  )
  $pendingPath = "$root/closure-pending.md"
  if (Test-Path -LiteralPath $pendingPath) {
    $pendingLines = Get-Content $pendingPath
    if (@($pendingLines | Where-Object { $_ -eq 'NOT_FINAL=true' }).Count -ne 1) { throw 'pending 缺少 NOT_FINAL 标记' }
    $pendingReason = @($pendingLines | Where-Object { $_ -match '^TerminalReason=' })
    $pendingProducer = @($pendingLines | Where-Object { $_ -match '^ProducerTask=' })
    if ($pendingReason.Count -ne 1 -or $pendingReason[0] -ne $reasonLines[0]) { throw 'pending reason 非唯一或与 brief 不一致' }
    if ($pendingProducer.Count -ne 1 -or $pendingProducer[0] -ne $producerLines[0]) { throw 'pending producer 非唯一或与 brief 不一致' }
    $pendingBefore = @($pendingLines | Where-Object { $_ -match '^before=' })
    $expectedBefore = @($toolPaths | ForEach-Object { "before=$_|present" })
    $pendingEvidence = @($pendingLines | Where-Object { $_ -match '^evidence=' } | ForEach-Object { $_.Substring('evidence='.Length) })
    $pendingDiagnostics = @($pendingLines | Where-Object { $_ -match '^diagnostic=' } | ForEach-Object { $_.Substring('diagnostic='.Length) })
    $pendingBefore | ForEach-Object {
      if ($_ -notmatch '^before=(.+)\|present$') { throw "pending before 格式非法：$_" }
      Assert-RepoRelativePath $Matches[1] 'pending before'
    }
    $pendingEvidence | ForEach-Object { Assert-RepoRelativePath $_ 'pending evidence' }
    $pendingDiagnostics | ForEach-Object { Assert-RepoRelativePath $_ 'pending diagnostic' }
    if (@(Compare-Object $expectedBefore $pendingBefore).Count -ne 0) { throw 'pending before 清单不一致' }
    if (@(Compare-Object $requiredEvidence $pendingEvidence).Count -ne 0) { throw 'pending evidence 清单不一致' }
    if (@(Compare-Object $diagnosticPaths $pendingDiagnostics).Count -ne 0) { throw 'pending diagnostics 清单不一致' }
  } else {
    $toolPaths | ForEach-Object { if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf)) { throw "首次 pending 前工具缺失：$_" } }
  }
  $requiredEvidence
  $diagnosticPaths
  ```

  Step 1 与 Step 5 completion 中的最终轮判定是同一份规范化判定，必须成对更新：先验证每个已执行脚本只有一条格式为 `roundN.<script>=<整数 exit>` 的结果，再判断成功/失败组合。独立复审包必须用纯内存 `string[]` 对这两处逐行判定运行同一组自测，不创建文件：最终轮 1 五门精确全零且唯一成功行应放行；`finalGateRound=2` 但只有 round1 绿色必须拒绝；重复 `finalGateRound` 或重复任一同轮机器行必须拒绝；`GATE_FAILURE` 五个精确零行计数为 `2,1,1,1,1` 必须因重复结果及“每项 count >= 1”同时拒绝；`GATE_FAILURE` 最终轮含成功行必须拒绝；`GATE_FAILURE` 最终轮五条全零即使无成功行也必须拒绝；至少一门非零且无成功行的失败轮应保持 CLOSED。路径判定再覆盖合法 `$relativeRoot/diagnostics/x.summary.json`、合法 owner inventory，以及 `../x`、`C:/x`、`C:\x`、`\\server\share`、`/root/x` 六类拒绝样本。自测结果逐项写入 review，全部符合预测才可创建 pending。

  按接口表逐项验证本 reason 的必须/禁止证据；`FIVE_GATES_GREEN` 还逐字核对成功行，`GATE_FAILURE` 核对成功行不存在。若 `closure-pending.md` 不存在，使用 `apply_patch` 创建，逐行写真实值：首行 `NOT_FINAL=true`、唯一 `TerminalReason=`、唯一且映射正确的 `ProducerTask=`、九行 `before=<相对工具路径>|present`、每个必须证据一行 `evidence=<相对路径>`、每个 `$diagnosticPaths` 一行 `diagnostic=<相对路径>`。禁止 wildcard、绝对路径、`System.Object[]` 或占位文字；创建后立即重跑本 Step 的 pending 分支，机械验证所有路径再进入 Step 2。

  若 pending 已存在，先核对其中 `TerminalReason` 与 brief 完全一致、九条 before 完整、evidence/diagnostic 清单与当前分支及磁盘上的 diagnostics 完全一致，才允许 resume；reason 不一致时停止，不覆盖 pending。首次创建 pending 时九工具必须全 present；resume 时允许因上次中断而部分 absent。此文件明确是 `NOT_FINAL`，不能作为开发门结论。

- [ ] **Step 2：只用 `apply_patch` 精确删除仍存在的九个临时工具**

  固定目标为 runner、selftest、runner review、`argv-child`、`fake-vitest`、`probe-child`、`output-overflow`、`tree-child`、`tree-parent`。逐项 `Test-Path -LiteralPath`；对仍存在的文件分别使用 `apply_patch` 删除，对已经 absent 的项记录为中断恢复并继续。不得使用 `Remove-Item`、Node/fs、递归删除、目录通配或脚本化删除。九个小文件属于用户已授权的本计划范围，不触发“大量删除”二次批准；不得扩大到其他 ignored evidence 或整个 fixtures 目录。

- [ ] **Step 3：验证全部 absent 后，用 `apply_patch` 创建扁平 final report**

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $repoRoot = (Get-Location).Path
  $relativeRoot = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure'
  $root = [IO.Path]::GetFullPath((Join-Path $repoRoot $relativeRoot))
  $tools = @(
    "$relativeRoot/run-diagnostic-round.mjs", "$relativeRoot/test-diagnostic-runner.mjs", "$relativeRoot/runner-review.md",
    "$relativeRoot/runner-fixtures/argv-child.mjs", "$relativeRoot/runner-fixtures/fake-vitest.mjs",
    "$relativeRoot/runner-fixtures/probe-child.mjs", "$relativeRoot/runner-fixtures/output-overflow.mjs",
    "$relativeRoot/runner-fixtures/tree-child.mjs", "$relativeRoot/runner-fixtures/tree-parent.mjs"
  )
  $tools | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $repoRoot $_)) { throw "临时工具仍存在：$_" } }
  $briefLines = Get-Content "$root/terminal-closure-brief.md"
  $pendingLines = Get-Content "$root/closure-pending.md"
  $briefReason = @($briefLines | Where-Object { $_ -match '^TerminalReason=' })
  $briefProducer = @($briefLines | Where-Object { $_ -match '^ProducerTask=' })
  if ($briefReason.Count -ne 1 -or $briefProducer.Count -ne 1) { throw 'terminal brief reason/producer 非唯一' }
  $terminalReason = $briefReason[0].Substring('TerminalReason='.Length)
  if ($terminalReason -notin @('NO_RED','NO_ROOT_CAUSE','GATE_FAILURE','FIVE_GATES_GREEN')) { throw 'terminal brief reason 非法' }
  $expectedProducer = if ($terminalReason -in @('NO_RED','NO_ROOT_CAUSE')) { 'ProducerTask=Task4' } else { 'ProducerTask=Task5' }
  if ($briefProducer[0] -ne $expectedProducer) { throw 'terminal brief reason/producer 映射错误' }
  $pendingReason = @($pendingLines | Where-Object { $_ -match '^TerminalReason=' })
  $pendingProducer = @($pendingLines | Where-Object { $_ -match '^ProducerTask=' })
  if ($pendingReason.Count -ne 1 -or $pendingReason[0] -ne $briefReason[0]) { throw 'pending reason 非唯一或与 brief 不一致' }
  if ($pendingProducer.Count -ne 1 -or $pendingProducer[0] -ne $briefProducer[0]) { throw 'pending producer 非唯一或与 brief 不一致' }
  $implementationBaseline = (Get-Content "$root/implementation-baseline.txt" -Raw).Trim()
  $protected = @('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts')
  $intervalProtected = @(git diff --name-only "$implementationBaseline..HEAD" -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'git interval protected diff 执行失败' }
  if ($intervalProtected.Count -ne 0) { throw '实施区间保护路径有差异' }
  $worktreeProtected = @(git diff --name-only -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'git worktree protected diff 执行失败' }
  if ($worktreeProtected.Count -ne 0) { throw '工作树保护路径有差异' }
  $cachedProtected = @(git diff --cached --name-only -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'git cached protected diff 执行失败' }
  if ($cachedProtected.Count -ne 0) { throw '暂存区保护路径有差异' }
  $trackedStatus = @(git status --short --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { throw 'git status 执行失败' }
  if ($trackedStatus.Count -ne 0) { throw '存在 tracked 差异' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'git diff --check 失败' }
  ```

  若 final 已存在，禁止覆盖；若九工具已全 absent、pending 存在而 final 缺失，这是合法中断恢复点，直接从 pending 的真实扁平行恢复创建 final。使用 `apply_patch` 创建 `closure-report.md`，逐行写：唯一 `TerminalReason=`；唯一且与 brief/pending 映射一致的 `ProducerTask=`；`TerminalStatus=SUCCESS` 仅对应 `FIVE_GATES_GREEN`，其余均为 `CLOSED`；原样复制九条 `before=`；写九条 `after=<相对工具路径>|absent`；原样复制每条 `evidence=`/`diagnostic=`；最后写 `protectedPathDifferences=0`、`trackedStatusEntries=0`、`diffCheck=PASS`。不得使用 PowerShell join、嵌套对象或动态报告生成。

  创建后机械验证 pending 中每一条 before/evidence/diagnostic 都逐字存在于 final，九条 after 均存在；evidence/diagnostic 指向的文件仍存在；`evidence=` 不含九个已删工具；final 不含 `NOT_FINAL`、绝对路径或 `System.Object[]`：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $repoRoot = (Get-Location).Path
  $relativeRoot = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure'
  $root = [IO.Path]::GetFullPath((Join-Path $repoRoot $relativeRoot))
  function Assert-RepoRelativePath([string]$path, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path -match '^[A-Za-z]:[\\/]|^\\\\|^/' -or $path.Contains('\') -or @($path -split '/' | Where-Object { $_ -eq '..' }).Count -gt 0) { throw "$label 不是安全 repo-relative 路径：$path" }
    if (-not ($path.StartsWith("$relativeRoot/") -or $path -eq 'docs/operations/desktop-test-owner-inventory.md')) { throw "$label 不在允许前缀：$path" }
  }
  $briefLines = Get-Content "$root/terminal-closure-brief.md"
  $pendingLines = Get-Content "$root/closure-pending.md"
  $finalLines = Get-Content "$root/closure-report.md"
  $finalText = Get-Content "$root/closure-report.md" -Raw
  $briefReason = @($briefLines | Where-Object { $_ -match '^TerminalReason=' })
  $pendingReason = @($pendingLines | Where-Object { $_ -match '^TerminalReason=' })
  $finalReason = @($finalLines | Where-Object { $_ -match '^TerminalReason=' })
  $briefProducer = @($briefLines | Where-Object { $_ -match '^ProducerTask=' })
  $pendingProducer = @($pendingLines | Where-Object { $_ -match '^ProducerTask=' })
  $finalProducer = @($finalLines | Where-Object { $_ -match '^ProducerTask=' })
  if ($briefReason.Count -ne 1 -or $pendingReason.Count -ne 1 -or $finalReason.Count -ne 1) { throw 'brief/pending/final TerminalReason 非唯一' }
  if ($briefProducer.Count -ne 1 -or $pendingProducer.Count -ne 1 -or $finalProducer.Count -ne 1) { throw 'brief/pending/final ProducerTask 非唯一' }
  if ($briefReason[0] -ne $pendingReason[0] -or $briefReason[0] -ne $finalReason[0]) { throw 'brief/pending/final TerminalReason 不一致' }
  if ($briefProducer[0] -ne $pendingProducer[0] -or $briefProducer[0] -ne $finalProducer[0]) { throw 'brief/pending/final ProducerTask 不一致' }
  $terminalReason = $briefReason[0].Substring('TerminalReason='.Length)
  if ($terminalReason -notin @('NO_RED','NO_ROOT_CAUSE','GATE_FAILURE','FIVE_GATES_GREEN')) { throw 'TerminalReason 非法' }
  $expectedProducer = if ($terminalReason -in @('NO_RED','NO_ROOT_CAUSE')) { 'ProducerTask=Task4' } else { 'ProducerTask=Task5' }
  if ($briefProducer[0] -ne $expectedProducer) { throw 'TerminalReason 与 ProducerTask 映射错误' }
  $statusLines = @($finalLines | Where-Object { $_ -match '^TerminalStatus=' })
  if ($statusLines.Count -ne 1) { throw 'final TerminalStatus 非唯一' }
  $expectedStatus = if ($terminalReason -eq 'FIVE_GATES_GREEN') { 'TerminalStatus=SUCCESS' } else { 'TerminalStatus=CLOSED' }
  if ($statusLines[0] -ne $expectedStatus) { throw 'TerminalReason 与 TerminalStatus 映射错误' }
  if (@($pendingLines | Where-Object { $_ -eq 'NOT_FINAL=true' }).Count -ne 1) { throw 'pending NOT_FINAL 非唯一' }
  @('protectedPathDifferences=0','trackedStatusEntries=0','diffCheck=PASS') | ForEach-Object {
    if (@($finalLines | Where-Object { $_ -eq $PSItem }).Count -ne 1) { throw "final 固定尾行缺失或重复：$PSItem" }
  }
  $pendingLines | Where-Object { $_ -match '^(before|evidence|diagnostic)=' } |
    ForEach-Object {
      & rg -F -x -- $_ "$root/closure-report.md" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "final 缺少 pending 行：$_" }
    }
  $retainedLines = @($pendingLines | Where-Object { $_ -match '^(evidence|diagnostic)=' })
  $retainedLines | ForEach-Object {
    $path = $_.Substring($_.IndexOf('=') + 1)
    Assert-RepoRelativePath $path 'final retained evidence'
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $path) -PathType Leaf)) { throw "final 指向的保留证据不存在：$path" }
  }
  $tools = @(
    "$relativeRoot/run-diagnostic-round.mjs", "$relativeRoot/test-diagnostic-runner.mjs", "$relativeRoot/runner-review.md",
    "$relativeRoot/runner-fixtures/argv-child.mjs", "$relativeRoot/runner-fixtures/fake-vitest.mjs",
    "$relativeRoot/runner-fixtures/probe-child.mjs", "$relativeRoot/runner-fixtures/output-overflow.mjs",
    "$relativeRoot/runner-fixtures/tree-child.mjs", "$relativeRoot/runner-fixtures/tree-parent.mjs"
  )
  $expectedBefore = @($tools | ForEach-Object { "before=$_|present" })
  $expectedAfter = @($tools | ForEach-Object { "after=$_|absent" })
  $actualBefore = @($finalLines | Where-Object { $_ -match '^before=' })
  $actualAfter = @($finalLines | Where-Object { $_ -match '^after=' })
  if (@(Compare-Object $expectedBefore $actualBefore).Count -ne 0) { throw 'final before 路径或状态不一致' }
  if (@(Compare-Object $expectedAfter $actualAfter).Count -ne 0) { throw 'final after 路径或状态不一致' }
  @($actualBefore + $actualAfter) | ForEach-Object {
    if ($_ -notmatch '^(before|after)=(.+)\|(present|absent)$') { throw "final before/after 格式非法：$_" }
    Assert-RepoRelativePath $Matches[2] 'final before/after'
  }
  $tools | ForEach-Object {
    $relative = $_
    & rg -F -x -- "after=$relative|absent" "$root/closure-report.md" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "final 缺少 after：$relative" }
    if (@($retainedLines | Where-Object { $_.EndsWith($relative) }).Count -ne 0) { throw "已删工具误入 evidence：$relative" }
  }
  if (@($finalLines | Where-Object { $_ -match '^before=' }).Count -ne 9) { throw 'final before 行数不是 9' }
  if (@($finalLines | Where-Object { $_ -match '^after=' }).Count -ne 9) { throw 'final after 行数不是 9' }
  if ($finalText -match 'System\.Object\[\]|NOT_FINAL|[A-Za-z]:\\') { throw 'final 含禁止内容' }
  rg -n "^TerminalReason=|^ProducerTask=|^TerminalStatus=|^before=|^after=|^evidence=|^diagnostic=|^protectedPathDifferences=0$|^trackedStatusEntries=0$|^diffCheck=PASS$" "$root/closure-report.md"
  if ($LASTEXITCODE -ne 0) { throw 'final rg 字段验证失败' }
  ```

- [ ] **Step 4：final 独立复审 Ready 后删除 pending**

  独立审查者核对显式 reason、分支必须/禁止证据、diagnostics 全量、九条 before/after、保护路径、tracked status、无对象串和敏感字段；Critical/Important 清零后用 `apply_patch` 创建 `closure-review.md`，固定写 `状态：Ready`、与 brief/final 相同且唯一的 `TerminalReason`、`ProducerTask`、`TerminalStatus`、`Critical=0`、`Important=0`。只有 final 与 Ready review 全部一致时，才用 `apply_patch` 删除 `closure-pending.md`。

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $repoRoot = (Get-Location).Path
  $relativeRoot = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure'
  $root = [IO.Path]::GetFullPath((Join-Path $repoRoot $relativeRoot))
  $briefLines = Get-Content "$root/terminal-closure-brief.md"
  $finalLines = Get-Content "$root/closure-report.md"
  $reviewLines = Get-Content "$root/closure-review.md"
  $briefReason = @($briefLines | Where-Object { $_ -match '^TerminalReason=' })
  $briefProducer = @($briefLines | Where-Object { $_ -match '^ProducerTask=' })
  $finalReason = @($finalLines | Where-Object { $_ -match '^TerminalReason=' })
  $finalProducer = @($finalLines | Where-Object { $_ -match '^ProducerTask=' })
  $reviewReason = @($reviewLines | Where-Object { $_ -match '^TerminalReason=' })
  $reviewProducer = @($reviewLines | Where-Object { $_ -match '^ProducerTask=' })
  if ($briefReason.Count -ne 1 -or $finalReason.Count -ne 1 -or $reviewReason.Count -ne 1) { throw 'brief/final/review reason 非唯一' }
  if ($briefProducer.Count -ne 1 -or $finalProducer.Count -ne 1 -or $reviewProducer.Count -ne 1) { throw 'brief/final/review producer 非唯一' }
  if ($briefReason[0] -ne $finalReason[0] -or $briefReason[0] -ne $reviewReason[0]) { throw 'brief/final/review reason 不一致' }
  if ($briefProducer[0] -ne $finalProducer[0] -or $briefProducer[0] -ne $reviewProducer[0]) { throw 'brief/final/review producer 不一致' }
  $terminalReason = $briefReason[0].Substring('TerminalReason='.Length)
  if ($terminalReason -notin @('NO_RED','NO_ROOT_CAUSE','GATE_FAILURE','FIVE_GATES_GREEN')) { throw 'TerminalReason 非法' }
  $expectedProducer = if ($terminalReason -in @('NO_RED','NO_ROOT_CAUSE')) { 'ProducerTask=Task4' } else { 'ProducerTask=Task5' }
  if ($briefProducer[0] -ne $expectedProducer) { throw 'reason/producer 映射错误' }
  $statusLines = @($finalLines | Where-Object { $_ -match '^TerminalStatus=' })
  $reviewStatus = @($reviewLines | Where-Object { $_ -match '^TerminalStatus=' })
  if ($statusLines.Count -ne 1 -or $reviewStatus.Count -ne 1) { throw 'final/review status 非唯一' }
  $expectedStatus = if ($terminalReason -eq 'FIVE_GATES_GREEN') { 'TerminalStatus=SUCCESS' } else { 'TerminalStatus=CLOSED' }
  if ($statusLines[0] -ne $expectedStatus -or $reviewStatus[0] -ne $expectedStatus) { throw 'reason/status 映射错误' }
  @('protectedPathDifferences=0','trackedStatusEntries=0','diffCheck=PASS') | ForEach-Object {
    if (@($finalLines | Where-Object { $_ -eq $PSItem }).Count -ne 1) { throw "final 固定尾行缺失或重复：$PSItem" }
  }
  $pendingPath = "$root/closure-pending.md"
  if (Test-Path -LiteralPath $pendingPath) {
    $pendingLines = Get-Content $pendingPath
    $pendingReason = @($pendingLines | Where-Object { $_ -match '^TerminalReason=' })
    $pendingProducer = @($pendingLines | Where-Object { $_ -match '^ProducerTask=' })
    if ($pendingReason.Count -ne 1 -or $pendingReason[0] -ne $briefReason[0]) { throw 'pending reason 非唯一或与 brief 不一致' }
    if ($pendingProducer.Count -ne 1 -or $pendingProducer[0] -ne $briefProducer[0]) { throw 'pending producer 非唯一或与 brief 不一致' }
  }
  if (@($reviewLines | Where-Object { $_ -eq '状态：Ready' }).Count -ne 1) { throw 'closure review 未 Ready' }
  if (@($reviewLines | Where-Object { $_ -eq 'Critical=0' }).Count -ne 1) { throw 'closure review Critical 未清零' }
  if (@($reviewLines | Where-Object { $_ -eq 'Important=0' }).Count -ne 1) { throw 'closure review Important 未清零' }
  ```

- [ ] **Step 5：删除 pending 后执行独立 completion 门**

  使用 `apply_patch` 删除 pending 后，必须在新的 PowerShell 会话执行下列完整检查；重跑入口发现 pending 已不存在且 final/review 均存在时也直接执行同一块，不能只依赖 Step 4 的删除前状态：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $repoRoot = (Get-Location).Path
  $relativeRoot = '.superpowers/sdd/2026-08-21-desktop-development-gate-closure'
  $root = [IO.Path]::GetFullPath((Join-Path $repoRoot $relativeRoot))
  function Assert-RepoRelativePath([string]$path, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path -match '^[A-Za-z]:[\\/]|^\\\\|^/' -or $path.Contains('\') -or @($path -split '/' | Where-Object { $_ -eq '..' }).Count -gt 0) { throw "$label 不是安全 repo-relative 路径：$path" }
    if (-not ($path.StartsWith("$relativeRoot/") -or $path -eq 'docs/operations/desktop-test-owner-inventory.md')) { throw "$label 不在允许前缀：$path" }
  }
  if (Test-Path -LiteralPath "$root/closure-pending.md") { throw 'completion 时 pending 仍存在' }
  $tools = @(
    "$relativeRoot/run-diagnostic-round.mjs", "$relativeRoot/test-diagnostic-runner.mjs", "$relativeRoot/runner-review.md",
    "$relativeRoot/runner-fixtures/argv-child.mjs", "$relativeRoot/runner-fixtures/fake-vitest.mjs",
    "$relativeRoot/runner-fixtures/probe-child.mjs", "$relativeRoot/runner-fixtures/output-overflow.mjs",
    "$relativeRoot/runner-fixtures/tree-child.mjs", "$relativeRoot/runner-fixtures/tree-parent.mjs"
  )
  $tools | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $repoRoot $_)) { throw "completion 时工具仍存在：$_" } }
  $briefLines = Get-Content "$root/terminal-closure-brief.md"
  $finalLines = Get-Content "$root/closure-report.md"
  $reviewLines = Get-Content "$root/closure-review.md"
  $briefReason = @($briefLines | Where-Object { $_ -match '^TerminalReason=' })
  $finalReason = @($finalLines | Where-Object { $_ -match '^TerminalReason=' })
  $reviewReason = @($reviewLines | Where-Object { $_ -match '^TerminalReason=' })
  $briefProducer = @($briefLines | Where-Object { $_ -match '^ProducerTask=' })
  $finalProducer = @($finalLines | Where-Object { $_ -match '^ProducerTask=' })
  $reviewProducer = @($reviewLines | Where-Object { $_ -match '^ProducerTask=' })
  if ($briefReason.Count -ne 1 -or $finalReason.Count -ne 1 -or $reviewReason.Count -ne 1 -or @(@($briefReason[0],$finalReason[0],$reviewReason[0]) | Sort-Object -Unique).Count -ne 1) { throw 'completion reason 非唯一或不一致' }
  if ($briefProducer.Count -ne 1 -or $finalProducer.Count -ne 1 -or $reviewProducer.Count -ne 1 -or @(@($briefProducer[0],$finalProducer[0],$reviewProducer[0]) | Sort-Object -Unique).Count -ne 1) { throw 'completion producer 非唯一或不一致' }
  $terminalReason = $briefReason[0].Substring('TerminalReason='.Length)
  if ($terminalReason -notin @('NO_RED','NO_ROOT_CAUSE','GATE_FAILURE','FIVE_GATES_GREEN')) { throw 'completion reason 非法' }
  $expectedProducer = if ($terminalReason -in @('NO_RED','NO_ROOT_CAUSE')) { 'ProducerTask=Task4' } else { 'ProducerTask=Task5' }
  if ($briefProducer[0] -ne $expectedProducer) { throw 'completion reason/producer 映射错误' }
  $finalStatus = @($finalLines | Where-Object { $_ -match '^TerminalStatus=' })
  $reviewStatus = @($reviewLines | Where-Object { $_ -match '^TerminalStatus=' })
  $expectedStatus = if ($terminalReason -eq 'FIVE_GATES_GREEN') { 'TerminalStatus=SUCCESS' } else { 'TerminalStatus=CLOSED' }
  if ($finalStatus.Count -ne 1 -or $reviewStatus.Count -ne 1 -or $finalStatus[0] -ne $expectedStatus -or $reviewStatus[0] -ne $expectedStatus) { throw 'completion status 非唯一、不一致或映射错误' }
  @('状态：Ready','Critical=0','Important=0') | ForEach-Object {
    $expectedLine = $_
    if (@($reviewLines | Where-Object { $_ -eq $expectedLine }).Count -ne 1) { throw "completion review 行缺失或重复：$expectedLine" }
  }
  $expectedBefore = @($tools | ForEach-Object { "before=$_|present" })
  $expectedAfter = @($tools | ForEach-Object { "after=$_|absent" })
  $actualBefore = @($finalLines | Where-Object { $_ -match '^before=' })
  $actualAfter = @($finalLines | Where-Object { $_ -match '^after=' })
  if ($actualBefore.Count -ne 9 -or @(Compare-Object $expectedBefore $actualBefore).Count -ne 0) { throw 'completion before 不是精确九项' }
  if ($actualAfter.Count -ne 9 -or @(Compare-Object $expectedAfter $actualAfter).Count -ne 0) { throw 'completion after 不是精确九项' }
  @($actualBefore + $actualAfter) | ForEach-Object {
    if ($_ -notmatch '^(before|after)=(.+)\|(present|absent)$') { throw "completion before/after 格式非法：$_" }
    Assert-RepoRelativePath $Matches[2] 'completion before/after'
  }
  $requiredEvidence = @(
    "$relativeRoot/terminal-closure-brief.md", "$relativeRoot/baseline.md", "$relativeRoot/implementation-baseline.txt",
    "$relativeRoot/feedback-results.md", 'docs/operations/desktop-test-owner-inventory.md'
  )
  switch ($terminalReason) {
    'NO_RED' { }
    'NO_ROOT_CAUSE' { $requiredEvidence += @("$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md") }
    'GATE_FAILURE' {
      $requiredEvidence += @(
        "$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md",
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/gate-failure-episode-brief.md", "$relativeRoot/final-executable-head.txt"
      )
    }
    'FIVE_GATES_GREEN' {
      $requiredEvidence += @(
        "$relativeRoot/hypothesis-probe-brief.md", "$relativeRoot/hypothesis-ledger.md",
        "$relativeRoot/root-cause-fix-brief.md", "$relativeRoot/root-cause-fix-files.txt",
        "$relativeRoot/gate-report.md", "$relativeRoot/final-executable-head.txt"
      )
      if (Test-Path -LiteralPath "$root/gate-failure-episode-brief.md") { $requiredEvidence += "$relativeRoot/gate-failure-episode-brief.md" }
    }
  }
  $requiredEvidence = @($requiredEvidence | Sort-Object -Unique)
  $finalEvidence = @($finalLines | Where-Object { $_ -match '^evidence=' } | ForEach-Object { $_.Substring('evidence='.Length) })
  $finalEvidence | ForEach-Object {
    Assert-RepoRelativePath $_ 'completion evidence'
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf)) { throw "completion evidence 不存在：$_" }
  }
  if ($finalEvidence.Count -ne $requiredEvidence.Count -or @(Compare-Object $requiredEvidence $finalEvidence).Count -ne 0) { throw 'completion evidence 与 TerminalReason 重建清单不一致' }
  $diagnosticPaths = @(
    Get-ChildItem "$root/diagnostics" -File |
      Where-Object { $_.Name -match '\.(summary|metadata)\.json$' } |
      Sort-Object Name |
      ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1).Replace('\','/') }
  )
  if (@($diagnosticPaths | Where-Object { $_ -match '\.summary\.json$' }).Count -eq 0 -or @($diagnosticPaths | Where-Object { $_ -match '\.metadata\.json$' }).Count -eq 0) { throw 'completion diagnostics 必须至少各有一个 summary 与 metadata' }
  $finalDiagnostics = @($finalLines | Where-Object { $_ -match '^diagnostic=' } | ForEach-Object { $_.Substring('diagnostic='.Length) })
  $finalDiagnostics | ForEach-Object {
    Assert-RepoRelativePath $_ 'completion diagnostic'
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf)) { throw "completion diagnostic 不存在：$_" }
  }
  if ($finalDiagnostics.Count -ne $diagnosticPaths.Count -or @(Compare-Object $diagnosticPaths $finalDiagnostics).Count -ne 0) { throw 'completion diagnostics 与目录重枚举清单不一致' }
  if ($terminalReason -in @('GATE_FAILURE','FIVE_GATES_GREEN')) {
    $gateLines = Get-Content "$root/gate-report.md"
    $finalRoundLines = @($gateLines | Where-Object { $_ -match '^finalGateRound=' })
    if ($finalRoundLines.Count -ne 1) { throw 'completion finalGateRound 非唯一' }
    $finalRound = $finalRoundLines[0].Substring('finalGateRound='.Length)
    if ($finalRound -notin @('1','2')) { throw 'completion 最终轮非法' }
    if (@($gateLines | Where-Object { $_ -eq "## Gate round $finalRound" }).Count -ne 1) { throw 'completion 最终轮段落标题非唯一' }
    if (@($gateLines | Where-Object { $_ -eq "gateRound=$finalRound" }).Count -ne 1) { throw 'completion gateRound 非唯一' }
    $scripts = @('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
    $successLine = "round${finalRound}.terminalGateStatus=SUCCESS"
    $successCount = @($gateLines | Where-Object { $_ -eq $successLine }).Count
    $resultCounts = @{}
    $zeroCounts = @()
    foreach ($script in $scripts) {
      $prefix = "round${finalRound}.$script="
      $resultLines = @($gateLines | Where-Object { $_.StartsWith($prefix) })
      if ($resultLines.Count -gt 1) { throw "completion 最终轮同一脚本存在多个结果：$script" }
      if ($resultLines.Count -eq 1 -and $resultLines[0] -notmatch ('^' + [regex]::Escape($prefix) + '-?\d+$')) { throw "completion 最终轮脚本结果格式非法：$script" }
      $resultCounts[$script] = $resultLines.Count
      $zeroCounts += @($gateLines | Where-Object { $_ -eq "${prefix}0" }).Count
    }
    $finalPrefixedLines = @($gateLines | Where-Object { $_ -match "^round${finalRound}\." })
    foreach ($line in $finalPrefixedLines) {
      if ($line -eq $successLine) { continue }
      $known = $false
      foreach ($script in $scripts) {
        if ($line -match ('^' + [regex]::Escape("round${finalRound}.$script=") + '-?\d+$')) { $known = $true; break }
      }
      if (-not $known) { throw "completion 最终轮出现未知或格式非法的机器行：$line" }
    }
    if ($terminalReason -eq 'FIVE_GATES_GREEN') {
      if ($successCount -ne 1 -or @($resultCounts.Values | Where-Object { $_ -ne 1 }).Count -ne 0 -or @($zeroCounts | Where-Object { $_ -ne 1 }).Count -ne 0) { throw 'completion 成功最终轮机器行不完整或重复' }
    } else {
      if ($successCount -ne 0) { throw 'completion 失败最终轮含成功行' }
      if (@($resultCounts.Values | Where-Object { $_ -eq 1 }).Count -eq 0) { throw 'completion 失败最终轮没有已执行脚本结果' }
      if (@($zeroCounts | Where-Object { $_ -ge 1 }).Count -eq 5) { throw 'completion 失败最终轮含五门全零组合' }
    }
  }
  $implementationBaseline = (Get-Content "$root/implementation-baseline.txt" -Raw).Trim()
  $protected = @('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts')
  $intervalProtected = @(git diff --name-only "$implementationBaseline..HEAD" -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'completion git interval protected diff 执行失败' }
  if ($intervalProtected.Count -ne 0) { throw 'completion 实施区间保护路径有差异' }
  $worktreeProtected = @(git diff --name-only -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'completion git worktree protected diff 执行失败' }
  if ($worktreeProtected.Count -ne 0) { throw 'completion 工作树保护路径有差异' }
  $cachedProtected = @(git diff --cached --name-only -- $protected)
  if ($LASTEXITCODE -ne 0) { throw 'completion git cached protected diff 执行失败' }
  if ($cachedProtected.Count -ne 0) { throw 'completion 暂存区保护路径有差异' }
  $trackedStatus = @(git status --short --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { throw 'completion git status 执行失败' }
  if ($trackedStatus.Count -ne 0) { throw 'completion 存在 tracked 差异' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'completion git diff --check 失败' }
  ```

  中断重跑规则：pending 存在则从 reason 一致性继续；工具部分 absent 则 Step 2 只删剩余项；工具全 absent/final 缺失则从 pending 创建 final；final 与 Ready review 已存在而 pending 仍在则只执行 pending 删除；pending 已不存在时必须执行上述 completion block 后完成。`NO_RED|NO_ROOT_CAUSE|GATE_FAILURE` 均交付“开发门仍关闭”并终止；只有 `FIVE_GATES_GREEN` 可进入 Task 6。Task X 不创建 Git commit。

---

### Task 6：唯一纯验收文档后继提交并正式发布解锁结论

**前置条件：** 只有 Task 5 五门全部退出 0、独立复审 Critical/Important 为零，且 Task X 的 `closure-report.md` 记录 `TerminalReason=FIVE_GATES_GREEN`、`TerminalStatus=SUCCESS`，`closure-review.md` 为 Ready、`closure-pending.md` 已删除、九个 ignored 临时工具均 absent 时执行。若 reason 是其他枚举、pending 仍在、超时根因未定位、Task 3 未合法完成、inventory 未对账或五门任一失败，不进入本任务；状态保持“开发门仍关闭”。

**文件：**
- 修改：`docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`
- 修改：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-report.md`（提交后追加实际文档 commit hash，不提交）

**接口：**
- 四份正式文档只记录同一个 `FINAL_EXECUTABLE_HEAD`，不预填或回写承载自身内容的文档提交 hash。
- 本任务是五门通过后的唯一后继提交；不得修改 `apps/`、`packages/`、`tests/`、根 `package.json`、锁文件、测试/构建配置或脚本。
- ignored gate report 在提交后记录实际当前 HEAD 与 `FINAL_EXECUTABLE_HEAD..当前 HEAD` 的完整路径差异，证明只有这四份纯文档变化且可执行范围零差异。

- [ ] **Step 0：在修改任何正式文档前重跑完整 completion 门**

  在新的 PowerShell 会话中原样执行 Task X Step 5 的完整 completion PowerShell block，不得删减、改写成历史报告引用或只检查 `TerminalStatus`。它必须再次证明：pending 与九工具 absent；brief/final/review 的 reason、producer、status、Ready 一致；最终轮 gate report 的精确机器行属于同一轮；before/after 精确各九项；全部 retained repo-relative evidence 仍存在；protected history/worktree/cached、tracked status 和 `diff --check` 全部为零/通过且每条 native Git 调用退出码已检查。任一检查失败立即停止 Task 6，开发门保持关闭。

- [ ] **Step 1：同步开发门规格与 owner inventory 链接**

  在开发门规格中记录最终根因、RED/GREEN、最终可执行树 HEAD、inventory 链接、精确总账、五门全绿、保护路径和人工待验；只记录实测，不复制敏感日志，不写文档提交自身 hash。

- [ ] **Step 2：同步旧减法规格的准确替代范围**

  明确本开发门规格只在恢复常规开发门范围内替代：第 5.2 节固定 worker 值（仅当 worker 双门实际成立）和第 9 节机械净负数门。写入最终可执行树 HEAD、inventory 链接和精确总账；未触及条款继续有效。若根因不是 worker，明确 `maxWorkers: 4` 未变化，避免误写替代结果。

- [ ] **Step 3：同步验收记录与上位状态摘要**

  `character-workshop-acceptance.md` 记录五条命令、退出码、耗时、同一最终可执行树 HEAD、保护路径、Windows 人工待验和“桌宠恢复常规新功能开发”结论。上位架构规格只更新开发门状态摘要，链接开发门规格、inventory 与验收记录，不复制命令流水。

- [ ] **Step 4：交叉链接、自审并提交唯一纯文档后继**

  ```powershell
  $finalExecutableHead = (Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/final-executable-head.txt -Raw).Trim()
  $finalExecutableShort = git rev-parse --short $finalExecutableHead
  rg -n "$finalExecutableShort|desktop-test-owner-inventory|恢复常规新功能开发|待用户人工确认" docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md docs/operations/character-workshop-acceptance.md docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md
  git diff --check
  git diff --name-only
  ```

  四份文档必须都命中由机器读取的真实短 hash、交叉链接一致，且 `git diff --name-only` 只能输出四个文档路径。独立审查者确认事实源、hash、命令结果、替代关系和人工待验一致，Critical/Important 清零后提交：

  ```powershell
  git add docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md docs/operations/character-workshop-acceptance.md docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md
  $expectedCached = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md'
  )
  $actualCached = @(git diff --cached --name-only)
  if (@(Compare-Object $expectedCached $actualCached).Count -gt 0) { throw 'Task 6 commit allowlist 不一致' }
  git commit -m "docs(desktop): 正式解锁常规功能开发"
  git status --short
  ```

- [ ] **Step 5：在 ignored 报告记录文档提交 hash 和可执行零差异**

  ```powershell
  $finalExecutableHead = (Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/final-executable-head.txt -Raw).Trim()
  git rev-parse HEAD
  git diff --name-status "$finalExecutableHead..HEAD"
  git diff --name-only "$finalExecutableHead..HEAD" -- apps packages tests package.json pnpm-lock.yaml pnpm-workspace.yaml
  git status --short
  ```

  gate report 写入实际文档提交 hash、四文档路径差异及可执行范围零输出；正式文档不回写该 hash，因此不会形成自引用提交循环。若出现第五个路径、第二个后继提交或未提交差异，本轮证据失效，必须整理为新的最终可执行树 HEAD 并重新执行五门。

## 最终完成标准

- 已在有限预算内取得同症状、高复现 RED，3–5 个假设均有支持/排除证据，根因可明确陈述。
- 根因修复先 RED 后 GREEN；原始未缩小 feedback seam GREEN；无 timeout、retry、skip、断言放宽或无证据 worker 降级。
- `c7d951d..FINAL_EXECUTABLE_HEAD` 每个变更测试文件和有效 hunk/测试簇均已登记，逐文件 `numstat` 与 Git 总账完全一致；重复表达与旧路径已安全删除，唯一证据未降低。
- 同一个 `FINAL_EXECUTABLE_HEAD` 上五条正式门均实际执行一次并退出 0，单条低于 15 分钟。
- 受保护网站/云端路径在实施区间、工作树和暂存区零差异；`git diff --check` 通过；九个临时执行工具与 `closure-pending.md` 零残留，扁平 final/review 和最小 diagnostics 证据保留。
- 唯一纯验收文档后继提交已同步四份事实源；ignored 报告记录实际文档提交 hash，并证明相对最终可执行树 HEAD 只有四份文档变化、可执行范围零差异。
- Windows 窗口层级、焦点、布局、文案可读性、重启视觉、拖拽、托盘和资源释放保持“待用户人工确认”；只在后续功能直接触及时成为该功能的前置验收。

任一项不满足，结论只能是“开发门仍关闭”。不得用历史绿色、风险接受、定向绿色或等价证据替代。
