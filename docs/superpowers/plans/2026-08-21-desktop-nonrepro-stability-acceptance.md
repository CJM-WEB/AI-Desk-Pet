# AI Pet 桌宠非复现稳定性准入例外实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`，逐任务执行；命令执行者与独立审查者必须是不同的新鲜子智能体。步骤使用复选框跟踪。

**目标：** 不修改任何可执行内容，在固定候选可执行 HEAD `55bd05898dca055cc4ed239e82072e30f1848de3` 上将 15/15 非复现证据与五条正式门结合，作出一次性稳定性准入裁决。

**架构：** 先固定纯文档提交后的可执行树等价基线，再按固定顺序对五门各执行一次；首个失败立即关门。独立审查只验证现有证据，不重跑命令；成功后用唯一纯文档后继同步五处事实源，失败则保持 `CLOSED` 并另立规格。

**技术栈：** pnpm 11、Vitest 3、Electron、Playwright、Windows PowerShell、Git、Markdown。

## 全局约束

- 批准规格为 `docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`。
- 固定候选可执行 HEAD 必须逐字为 `55bd05898dca055cc4ed239e82072e30f1848de3`；本规格/计划提交后只允许 `docs/` 变化，任何非文档 tracked 变化使例外失效。
- 15/15 三 seam GREEN 是稳定性证据，不是根因修复；任何成功结论必须写“稳定性准入通过，已知偶发超时根因未定位”。
- 五门固定顺序为 `verify:desktop`、`verify:characters`、`verify:behavior`、`test:security`、`test:integration`，以根 `package.json` 的实际脚本为事实源。
- 每门只启动一次、单门小于 15 分钟；任一失败立即 `CLOSED` 并停止，不重跑、不 retry、不增加 timeout、不 skip、不降低 worker、不改代码/测试/config。
- 不创建临时 runner、fixture、脚本或代码 commit；证据只写入 `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/` 的少量 ignored Markdown。
- `+1956/-1294`、净增 `662` 的 owner inventory 原样保留；本计划不再硬删测试，也不宣称安全减法穷尽。
- 网站、CloudBase、scanner、cloudbase 和网站 E2E/配置只做只读差异检查，绝不修改或运行。
- Git 写已获用户授权；不 push、不 merge、不 rebase、不 reset。成功后仅有一个五文档状态同步提交；失败不产生规格/计划首次提交之外的额外 tracked 后继提交。
- 每个命令或审查单点超过 15 分钟立即停止该做法。审查超时则更换新鲜审查者，不重跑五门。

## 文件与产物职责

| 路径 | 职责 | 生命周期 |
| --- | --- | --- |
| `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/progress.md` | SDD 恢复账本 | ignored，保留 |
| `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/baseline.md` | 候选 hash、脚本展开、15/15、owner 总账与保护范围 | ignored，保留 |
| `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/gate-report.md` | 五门逐门开始/结束、耗时、exit/终止和终局 | ignored，保留 |
| `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/review.md` | 独立复审裁决 | ignored，保留 |
| `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/docs-successor-report.md` | 成功后文档提交 hash 与可执行零差异 | ignored，仅成功创建 |
| 五份状态文档 | 成功后同步稳定性准入事实 | 唯一纯文档后继提交 |

---

### Task 0：固定证据型 baseline

**文件：**
- 读取：`package.json`
- 读取：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md`
- 读取：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-report.md`
- 读取：`docs/operations/desktop-test-owner-inventory.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/baseline.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/progress.md`

**接口：**
- 产出唯一常量 `FROZEN_EXECUTABLE_HEAD=55bd05898dca055cc4ed239e82072e30f1848de3`。
- baseline 只记录事实，不改变 tracked 文件。

- [ ] **Step 1：创建专属 SDD workspace 和 ledger**

  使用 `subagent-driven-development` 的 `sdd-workspace` 解析本计划目录；若没有 ledger，以首行创建：

  ```text
  # SDD ledger — plan: docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md
  ```

  已有同身份 ledger 时从首个未完成任务恢复，不重复门命令。

- [ ] **Step 2：机械验证候选提交和纯文档区间**

  ```powershell
  $expected = '55bd05898dca055cc4ed239e82072e30f1848de3'
  $actual = (git rev-parse '55bd058^{commit}').Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne $expected) { throw '固定候选 HEAD 不一致' }
  $tracked = @(git status --short --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $tracked.Count -ne 0) { throw 'tracked 工作树不干净' }
  $intervalNonDocs = @(git diff --name-only "$expected..HEAD" -- . ':(exclude)docs/**')
  if ($LASTEXITCODE -ne 0 -or $intervalNonDocs.Count -ne 0) { throw '候选之后出现非文档差异' }
  $intervalDocs = @(git diff --name-only "$expected..HEAD" -- docs)
  $expectedDocs = @(
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  if (@(Compare-Object $expectedDocs $intervalDocs).Count -ne 0) { throw '门前文档区间不止本规格与计划' }
  ```

- [ ] **Step 3：从 `package.json` 固定脚本与顺序**

  ```powershell
  node -e "const p=require('./package.json'); for (const n of ['verify:desktop','verify:characters','verify:behavior','test:security','test:integration']) { if (!p.scripts[n]) throw new Error('缺少脚本: '+n); console.log(n+'='+p.scripts[n]); }"
  if ($LASTEXITCODE -ne 0) { throw '脚本事实读取失败' }
  ```

  baseline 逐字记录五个展开值，不缓存其他脚本。

- [ ] **Step 4：复核 `NO_RED`、15/15 与 owner 总账**

  ```powershell
  rg -n "NO_RED|15/15|TARGET_FIXED_TIMEOUT.*0/15|maxWorkers|未修改生产代码" .superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md .superpowers/sdd/2026-08-21-desktop-development-gate-closure/closure-report.md
  rg -n "零安全删除|1956|1294|\+662|259/259" docs/operations/desktop-test-owner-inventory.md
  ```

  baseline 必须明确写“非复现不等于修复”“owner 账本保留”。

- [ ] **Step 5：验证保护路径和门前静态状态**

  ```powershell
  $expected = '55bd05898dca055cc4ed239e82072e30f1848de3'
  $protected = @('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts')
  if (@(git diff --name-only "$expected..HEAD" -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径历史差异' }
  if (@(git diff --name-only -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径工作树差异' }
  if (@(git diff --cached --name-only -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径暂存区差异' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'diff-check 失败' }
  ```

- [ ] **Step 6：独立复审 baseline**

  新鲜审查者复算 hash、两文档 allowlist、五脚本、15/15、`+662` 和三个保护范围。Critical/Important 为零后在 ledger 写 `Task 0: complete`；本任务不提交。

---

### Task 1：在同一候选可执行树上各一次执行五门

**文件：**
- 读取：Task 0 `baseline.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/gate-report.md`
- 不修改：任何 tracked 文件

**接口：**
- gate report 以唯一 `candidateExecutableHead=` 开头，并有唯一 `gateOrder=verify:desktop,verify:characters,verify:behavior,test:security,test:integration`。
- 第 N 门只使用机器行 `gate.N.name=`、`gate.N.startedAt=`、`gate.N.pid=`、`gate.N.processStartedAt=`、`gate.N.session=`、`gate.N.finishedAt=`、`gate.N.durationMs=`、`gate.N.exitCode=`、`gate.N.killExitCode=`、`gate.N.termination=`；每个键至多一行。`pid/processStartedAt/session/exitCode/killExitCode` 无值时写 `NONE`，不省略键。
- `termination` 只能为 `NONE|TIMEOUT|SPAWN_FAILURE|TERMINATION_FAILURE|INTERRUPTED`；`NONE` 必须有整数 exit，其他类别允许 `exitCode=NONE`。
- 报告最后必须各有唯一一行 `FinalReason=ALL_GATES_GREEN|GATE_FAILURE|STATIC_DIFFERENCE|INTERRUPTED|SPAWN_FAILURE|TERMINATION_FAILURE` 与 `FinalStatus=PASS|CLOSED`。`PASS` 只允许 `ALL_GATES_GREEN` 且五门完整全零；其他终局固定为 `CLOSED`。

- [ ] **Step 1：命令执行者复核 baseline Ready 和未执行状态**

  ledger 必须有 `Task 0: complete` 且不存在任何 `Gate <name>: started|complete` 行。若恢复时发现某门已有 `started` 而没有 `complete`，读取 gate report 中已持久化的 `pid/processStartedAt/session`：仍有 session 就只恢复该 session；session 不可恢复时，先读取该 PID 当前进程的 `StartTime.ToUniversalTime().ToString('O')` 并与 `processStartedAt` 逐字比较。只有 PID 与启动时间双重一致才允许 `taskkill /PID ... /T /F`；PID 不存在则补全 `INTERRUPTED/CLOSED`，PID 存在但启动时间不符或无法读取时禁止杀进程，补全 `TERMINATION_FAILURE/CLOSED`。执行 taskkill 后还须记录 exit 并验证 PID 不存在；仍存活则 `TERMINATION_FAILURE/CLOSED`。任何中断分支都不得重新启动该门。

- [ ] **Step 2：锁定单门执行协议但不创建脚本**

  每门使用一次独立 PowerShell/执行工具调用。开始前先用 `apply_patch` 写入该门唯一 `name/startedAt` 与 ledger `started`；启动调用第一次返回 PID、进程启动时间和运行 session 后，立即用 `apply_patch` 写入 `pid/processStartedAt/session`，再只恢复该 session 等待结束。block 用隐藏窗口启动精确 `pnpm.cmd`、以 Stopwatch 计时，主等待固定 840000ms；超时清理最多再等 10000ms，为 taskkill、结果落盘和外层工具返回预留至少 50 秒，保证单次调用硬上界低于 15 分钟。不能把五门放入同一个外层命令。

  每门结束后只用 `apply_patch` 把结构化结果写入 gate report；不保存 stdout/stderr。执行调用自身达到 15 分钟时也按超时失败处理。

- [ ] **Step 3：一次执行 `verify:desktop`**

  ```powershell
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'verify:desktop' -WindowStyle Hidden -PassThru }
  catch { $timer.Stop(); "GATE_RESULT name=verify:desktop pid=NONE processStartedAt=NONE exit=NONE killExit=NONE termination=SPAWN_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 70 }
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  "GATE_PID=$($process.Id) GATE_PROCESS_STARTED_AT=$processStartedAt"
  $finished = $process.WaitForExit(840000)
  if (-not $finished) {
    & taskkill /PID $process.Id /T /F | Out-Null
    $killExit = $LASTEXITCODE
    $process.WaitForExit(10000) | Out-Null
    $alive = $null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
    $timer.Stop()
    if ($alive) { "GATE_RESULT name=verify:desktop pid=$($process.Id) processStartedAt=$processStartedAt exit=NONE killExit=$killExit termination=TERMINATION_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 125 }
    "GATE_RESULT name=verify:desktop pid=$($process.Id) processStartedAt=$processStartedAt exit=124 killExit=$killExit termination=TIMEOUT durationMs=$($timer.ElapsedMilliseconds)"
    exit 124
  }
  $timer.Stop()
  $process.Refresh()
  "GATE_RESULT name=verify:desktop pid=$($process.Id) processStartedAt=$processStartedAt exit=$($process.ExitCode) killExit=NONE termination=NONE durationMs=$($timer.ElapsedMilliseconds)"
  exit $process.ExitCode
  ```

  只允许一次启动。exit 非 0 或超时则写 `Gate verify:desktop: complete CLOSED`、`FinalStatus=CLOSED`，停止 Task 1，跳到 Task 2。

- [ ] **Step 4：一次执行 `verify:characters`**

  仅当前门 exit 0 且小于 15 分钟时执行：

  ```powershell
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'verify:characters' -WindowStyle Hidden -PassThru }
  catch { $timer.Stop(); "GATE_RESULT name=verify:characters pid=NONE processStartedAt=NONE exit=NONE killExit=NONE termination=SPAWN_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 70 }
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  "GATE_PID=$($process.Id) GATE_PROCESS_STARTED_AT=$processStartedAt"
  $finished = $process.WaitForExit(840000)
  if (-not $finished) {
    & taskkill /PID $process.Id /T /F | Out-Null
    $killExit = $LASTEXITCODE
    $process.WaitForExit(10000) | Out-Null
    $alive = $null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
    $timer.Stop()
    if ($alive) { "GATE_RESULT name=verify:characters pid=$($process.Id) processStartedAt=$processStartedAt exit=NONE killExit=$killExit termination=TERMINATION_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 125 }
    "GATE_RESULT name=verify:characters pid=$($process.Id) processStartedAt=$processStartedAt exit=124 killExit=$killExit termination=TIMEOUT durationMs=$($timer.ElapsedMilliseconds)"
    exit 124
  }
  $timer.Stop()
  $process.Refresh()
  "GATE_RESULT name=verify:characters pid=$($process.Id) processStartedAt=$processStartedAt exit=$($process.ExitCode) killExit=NONE termination=NONE durationMs=$($timer.ElapsedMilliseconds)"
  exit $process.ExitCode
  ```

  失败处理同 Step 3。

- [ ] **Step 5：一次执行 `verify:behavior`**

  仅当前两门均合格时执行：

  ```powershell
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'verify:behavior' -WindowStyle Hidden -PassThru }
  catch { $timer.Stop(); "GATE_RESULT name=verify:behavior pid=NONE processStartedAt=NONE exit=NONE killExit=NONE termination=SPAWN_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 70 }
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  "GATE_PID=$($process.Id) GATE_PROCESS_STARTED_AT=$processStartedAt"
  $finished = $process.WaitForExit(840000)
  if (-not $finished) {
    & taskkill /PID $process.Id /T /F | Out-Null
    $killExit = $LASTEXITCODE
    $process.WaitForExit(10000) | Out-Null
    $alive = $null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
    $timer.Stop()
    if ($alive) { "GATE_RESULT name=verify:behavior pid=$($process.Id) processStartedAt=$processStartedAt exit=NONE killExit=$killExit termination=TERMINATION_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 125 }
    "GATE_RESULT name=verify:behavior pid=$($process.Id) processStartedAt=$processStartedAt exit=124 killExit=$killExit termination=TIMEOUT durationMs=$($timer.ElapsedMilliseconds)"
    exit 124
  }
  $timer.Stop()
  $process.Refresh()
  "GATE_RESULT name=verify:behavior pid=$($process.Id) processStartedAt=$processStartedAt exit=$($process.ExitCode) killExit=NONE termination=NONE durationMs=$($timer.ElapsedMilliseconds)"
  exit $process.ExitCode
  ```

  失败处理同 Step 3。

- [ ] **Step 6：一次执行 `test:security`**

  仅前三门均合格时执行：

  ```powershell
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'test:security' -WindowStyle Hidden -PassThru }
  catch { $timer.Stop(); "GATE_RESULT name=test:security pid=NONE processStartedAt=NONE exit=NONE killExit=NONE termination=SPAWN_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 70 }
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  "GATE_PID=$($process.Id) GATE_PROCESS_STARTED_AT=$processStartedAt"
  $finished = $process.WaitForExit(840000)
  if (-not $finished) {
    & taskkill /PID $process.Id /T /F | Out-Null
    $killExit = $LASTEXITCODE
    $process.WaitForExit(10000) | Out-Null
    $alive = $null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
    $timer.Stop()
    if ($alive) { "GATE_RESULT name=test:security pid=$($process.Id) processStartedAt=$processStartedAt exit=NONE killExit=$killExit termination=TERMINATION_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 125 }
    "GATE_RESULT name=test:security pid=$($process.Id) processStartedAt=$processStartedAt exit=124 killExit=$killExit termination=TIMEOUT durationMs=$($timer.ElapsedMilliseconds)"
    exit 124
  }
  $timer.Stop()
  $process.Refresh()
  "GATE_RESULT name=test:security pid=$($process.Id) processStartedAt=$processStartedAt exit=$($process.ExitCode) killExit=NONE termination=NONE durationMs=$($timer.ElapsedMilliseconds)"
  exit $process.ExitCode
  ```

  失败处理同 Step 3。

- [ ] **Step 7：一次执行 `test:integration`**

  仅前四门均合格时执行：

  ```powershell
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'test:integration' -WindowStyle Hidden -PassThru }
  catch { $timer.Stop(); "GATE_RESULT name=test:integration pid=NONE processStartedAt=NONE exit=NONE killExit=NONE termination=SPAWN_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 70 }
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  "GATE_PID=$($process.Id) GATE_PROCESS_STARTED_AT=$processStartedAt"
  $finished = $process.WaitForExit(840000)
  if (-not $finished) {
    & taskkill /PID $process.Id /T /F | Out-Null
    $killExit = $LASTEXITCODE
    $process.WaitForExit(10000) | Out-Null
    $alive = $null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)
    $timer.Stop()
    if ($alive) { "GATE_RESULT name=test:integration pid=$($process.Id) processStartedAt=$processStartedAt exit=NONE killExit=$killExit termination=TERMINATION_FAILURE durationMs=$($timer.ElapsedMilliseconds)"; exit 125 }
    "GATE_RESULT name=test:integration pid=$($process.Id) processStartedAt=$processStartedAt exit=124 killExit=$killExit termination=TIMEOUT durationMs=$($timer.ElapsedMilliseconds)"
    exit 124
  }
  $timer.Stop()
  $process.Refresh()
  "GATE_RESULT name=test:integration pid=$($process.Id) processStartedAt=$processStartedAt exit=$($process.ExitCode) killExit=NONE termination=NONE durationMs=$($timer.ElapsedMilliseconds)"
  exit $process.ExitCode
  ```

  失败处理同 Step 3。

- [ ] **Step 8：固定终局并复核执行后静态状态**

  ```powershell
  $expected = '55bd05898dca055cc4ed239e82072e30f1848de3'
  if (@(git diff --name-only "$expected..HEAD" -- . ':(exclude)docs/**').Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '执行后候选树出现非文档差异' }
  $expectedDocs = @(
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualDocs = @(git diff --name-only "$expected..HEAD" -- docs)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedDocs $actualDocs).Count -ne 0) { throw '执行后门前文档 allowlist 已变化' }
  if (@(git status --short --untracked-files=no).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '执行后 tracked 工作树不干净' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw '执行后 diff-check 失败' }
  ```

  五门恰好各有一条完整记录、全为 exit 0 且每条 `<900000ms` 时才写 `FinalStatus=PASS`；否则 `FinalStatus=CLOSED`。Task 1 不提交。

---

### Task 2：新鲜独立复审并给出唯一裁决

**文件：**
- 读取：`baseline.md`
- 读取：`gate-report.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/review.md`

**接口：**
- 审查者不得重跑任何正式门。
- review 固定包含 `Critical=`、`Important=`、`FinalStatus=` 和结论限语。

- [ ] **Step 1：生成只读 review package**

  review package 只由 baseline、gate report、ledger、`git status --short --untracked-files=no`、`git diff --check`、`55bd058..HEAD` 全路径 diff 和三个保护范围差异组成；不得包含测试 stdout/stderr。

  在交给审查者前执行以下机器 schema 门；任一异常直接 `CLOSED`，不得由人工解释或重跑覆盖：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $report = Get-Content '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/gate-report.md'
  function OneValue([string]$key) {
    $matches = @($report | Where-Object { $_.StartsWith("$key=") })
    if ($matches.Count -ne 1) { throw "机器键不唯一：$key" }
    return $matches[0].Substring($key.Length + 1)
  }
  $expectedHead = '55bd05898dca055cc4ed239e82072e30f1848de3'
  $expectedNames = @('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
  if ((OneValue 'candidateExecutableHead') -ne $expectedHead) { throw '候选 HEAD 错误' }
  if ((OneValue 'gateOrder') -ne ($expectedNames -join ',')) { throw 'gateOrder 错误' }
  $finalStatus = OneValue 'FinalStatus'
  $finalReason = OneValue 'FinalReason'
  if ($finalStatus -notin @('PASS','CLOSED')) { throw 'FinalStatus 非法' }
  if ($finalReason -notin @('ALL_GATES_GREEN','GATE_FAILURE','STATIC_DIFFERENCE','INTERRUPTED','SPAWN_FAILURE','TERMINATION_FAILURE')) { throw 'FinalReason 非法' }
  $executed = 0
  $seenFailure = $false
  for ($index = 1; $index -le 5; $index += 1) {
    $nameLines = @($report | Where-Object { $_.StartsWith("gate.$index.name=") })
    if ($nameLines.Count -eq 0) {
      if (@($report | Where-Object { $_.StartsWith("gate.$index.") }).Count -ne 0) { throw "第 $index 门存在残缺字段" }
      continue
    }
    if ($nameLines.Count -ne 1 -or $index -ne ($executed + 1) -or $seenFailure) { throw "第 $index 门重复、非连续或位于失败之后" }
    $name = OneValue "gate.$index.name"
    $startedAt = OneValue "gate.$index.startedAt"
    $pid = OneValue "gate.$index.pid"
    $processStartedAt = OneValue "gate.$index.processStartedAt"
    $session = OneValue "gate.$index.session"
    $finishedAt = OneValue "gate.$index.finishedAt"
    $durationText = OneValue "gate.$index.durationMs"
    $exitText = OneValue "gate.$index.exitCode"
    $killExitText = OneValue "gate.$index.killExitCode"
    $termination = OneValue "gate.$index.termination"
    if ($name -ne $expectedNames[$index - 1]) { throw "第 $index 门名称或顺序错误" }
    $start = [DateTimeOffset]::ParseExact($startedAt, 'O', [Globalization.CultureInfo]::InvariantCulture)
    $finish = [DateTimeOffset]::ParseExact($finishedAt, 'O', [Globalization.CultureInfo]::InvariantCulture)
    if ($finish -lt $start) { throw "第 $index 门时间倒置" }
    $duration = 0L
    if (-not [long]::TryParse($durationText, [ref]$duration) -or $duration -lt 0) { throw "第 $index 门耗时非法" }
    if ($termination -eq 'SPAWN_FAILURE') {
      if ($pid -ne 'NONE' -or $processStartedAt -ne 'NONE') { throw "第 $index 门 spawn 失败却有进程身份" }
    } else {
      if ($pid -notmatch '^[1-9]\d*$') { throw "第 $index 门缺少正整数 PID" }
      [DateTimeOffset]::ParseExact($processStartedAt, 'O', [Globalization.CultureInfo]::InvariantCulture) | Out-Null
    }
    if ([string]::IsNullOrWhiteSpace($session)) { throw "第 $index 门 session 为空" }
    if ($termination -notin @('NONE','TIMEOUT','SPAWN_FAILURE','TERMINATION_FAILURE','INTERRUPTED')) { throw "第 $index 门终止类别非法" }
    $exitCode = 0
    $hasIntegerExit = [int]::TryParse($exitText, [ref]$exitCode)
    if ($termination -eq 'NONE' -and -not $hasIntegerExit) { throw "第 $index 门自然结束却无整数 exit" }
    if ($termination -in @('TIMEOUT','TERMINATION_FAILURE','INTERRUPTED') -and $pid -eq 'NONE') { throw "第 $index 门终止却无 PID" }
    if ($termination -eq 'TIMEOUT' -and $killExitText -notmatch '^-?\d+$') { throw "第 $index 门超时却无 taskkill exit" }
    if ($termination -in @('NONE','SPAWN_FAILURE') -and $killExitText -ne 'NONE') { throw "第 $index 门不应有 taskkill exit" }
    $isGreen = $termination -eq 'NONE' -and $hasIntegerExit -and $exitCode -eq 0 -and $duration -lt 900000
    if (-not $isGreen) { $seenFailure = $true }
    $executed += 1
  }
  $unknownMachineLines = @($report | Where-Object {
    $_ -match '^(candidateExecutableHead=|gateOrder=|gate\.|FinalReason=|FinalStatus=)' -and
    $_ -notmatch '^(candidateExecutableHead|gateOrder|FinalReason|FinalStatus)=' -and
    $_ -notmatch '^gate\.[1-5]\.(name|startedAt|pid|processStartedAt|session|finishedAt|durationMs|exitCode|killExitCode|termination)='
  })
  if ($unknownMachineLines.Count -ne 0) { throw '出现未知 gate 机器键' }
  if ($finalStatus -eq 'PASS') {
    if ($finalReason -ne 'ALL_GATES_GREEN' -or $executed -ne 5 -or $seenFailure) { throw 'PASS 组合不完整' }
  } else {
    if ($finalReason -eq 'ALL_GATES_GREEN') { throw 'CLOSED 不能使用全绿 reason' }
    if (-not $seenFailure -and $finalReason -ne 'STATIC_DIFFERENCE') { throw 'CLOSED 缺少失败门或静态差异' }
  }
  ```

- [ ] **Step 2：独立验证单次性、顺序和终止点**

  审查者确认每个已执行门恰好一条 started/complete；执行顺序固定；首个失败后没有后续 started；成功时五门完整、全零、各小于 15 分钟。任何 started 无完成、重复门或失败后继续均为 Important，最终必须 `CLOSED`。

- [ ] **Step 3：独立验证没有伪修复和越界修改**

  审查者确认没有 timeout/retry/skip/worker/断言、代码、测试、config、依赖或脚本变化；`docs/` 外和保护路径零差异；owner `+662` 未被改写；15/15 未被表述为修复。

- [ ] **Step 4：写入复审结论**

  先计算审查对象 hash：

  ```powershell
  $gateReportHash = (Get-FileHash -Algorithm SHA256 '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/gate-report.md').Hash.ToLowerInvariant()
  if ($gateReportHash -notmatch '^[0-9a-f]{64}$') { throw 'gate report hash 非法' }
  ```

  只有 gate report 为完整 PASS 且 Critical/Important 为零时，review 写入唯一 `GateReportSha256=<64位小写hex>`，并写：

  ```text
  FinalStatus=PASS
  结论=稳定性准入通过，已知偶发超时根因未定位
  ```

  其他情况写 `FinalStatus=CLOSED` 和首个失败事实；不得以复审意见覆盖原始 exit。ledger 写 `Task 2: complete`。

---

### Task 3：仅在 PASS 后提交唯一纯文档后继

**前置条件：** `gate-report.md` 与 `review.md` 均唯一写 `FinalStatus=PASS`，review 的 Critical/Important 为零，五门完整全零且每条小于 15 分钟。否则本任务 `not_run`，向用户交付 `CLOSED`，后续另立独立规格。

**文件：**
- 修改：`docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`
- 修改：`docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/docs-successor-report.md`（提交后，ignored）

**接口：**
- 五份正式文档只记录固定候选可执行 HEAD，不写文档提交自身 hash。
- 计划文件不修改；可执行范围不修改。

- [ ] **Step 1：在改文档前重验 PASS 和可执行零差异**

  机械检查 gate/review 各只有一个 `FinalStatus=PASS`、五门记录完整唯一、Critical/Important 为零。任一失败停止，不改文档：

  ```powershell
  $ErrorActionPreference = 'Stop'
  $root = '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance'
  $gate = Get-Content "$root/gate-report.md"
  $review = Get-Content "$root/review.md"
  foreach ($lines in @($gate,$review)) {
    if (@($lines | Where-Object { $_ -eq 'FinalStatus=PASS' }).Count -ne 1) { throw 'PASS 非唯一' }
  }
  foreach ($required in @('Critical=0','Important=0','结论=稳定性准入通过，已知偶发超时根因未定位')) {
    if (@($review | Where-Object { $_ -eq $required }).Count -ne 1) { throw "review 缺少唯一行：$required" }
  }
  $reviewHashLines = @($review | Where-Object { $_ -match '^GateReportSha256=' })
  $actualGateHash = (Get-FileHash -Algorithm SHA256 "$root/gate-report.md").Hash.ToLowerInvariant()
  if ($reviewHashLines.Count -ne 1 -or $reviewHashLines[0] -ne "GateReportSha256=$actualGateHash") { throw 'gate report 在独立复审后发生变化' }
  $names = @('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
  for ($index = 1; $index -le 5; $index += 1) {
    foreach ($line in @("gate.$index.name=$($names[$index-1])","gate.$index.exitCode=0","gate.$index.killExitCode=NONE","gate.$index.termination=NONE")) {
      if (@($gate | Where-Object { $_ -eq $line }).Count -ne 1) { throw "成功门机器行缺失或重复：$line" }
    }
    $durationLines = @($gate | Where-Object { $_.StartsWith("gate.$index.durationMs=") })
    $duration = 0L
    if ($durationLines.Count -ne 1 -or -not [long]::TryParse($durationLines[0].Split('=')[1], [ref]$duration) -or $duration -ge 900000) { throw "第 $index 门耗时不合格" }
    foreach ($key in @('startedAt','pid','session','finishedAt')) {
      if (@($gate | Where-Object { $_.StartsWith("gate.$index.$key=") }).Count -ne 1) { throw "第 $index 门缺少唯一 $key" }
    }
  }
  $candidate = '55bd05898dca055cc4ed239e82072e30f1848de3'
  if (@(git diff --name-only "$candidate..HEAD" -- . ':(exclude)docs/**').Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '候选树存在非文档历史差异' }
  $expectedPreGateDocs = @(
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualPreGateDocs = @(git diff --name-only "$candidate..HEAD" -- docs)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedPreGateDocs $actualPreGateDocs).Count -ne 0) { throw 'Task 3 前文档 allowlist 不再是初始两文件' }
  if (@(git status --short --untracked-files=no).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '改文档前 tracked 工作树不干净' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw '改文档前 diff-check 失败' }
  ```

- [ ] **Step 2：同步五份文档的单一事实**

  五份文档统一写入：固定候选可执行 HEAD；五门逐项 exit/耗时；`+662` owner 账本保留；受保护路径零差异；Windows 人工待验；结论“稳定性准入通过，已知偶发超时根因未定位”。旧开发门规格必须把 `NO_RED/CLOSED` 标为前一阶段历史事实，并链接本例外；不得改写成已完成根因修复。

- [ ] **Step 3：自审占位、矛盾和范围**

  ```powershell
  $docs = @(
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md'
  )
  & rg -n "T[B]D|T[O]DO|待[补]" $docs
  if ($LASTEXITCODE -ne 1) { throw '占位扫描必须精确为零命中的 exit 1' }
  & rg -n "^(> )?(文档状态|结论|当前状态).*?(根因已解决|超时已修复|问题已消失)" $docs
  if ($LASTEXITCODE -ne 1) { throw '错误成功表述扫描必须精确为零命中的 exit 1' }
  foreach ($doc in $docs) {
    foreach ($pattern in @('55bd058','稳定性准入通过，已知偶发超时根因未定位','待用户人工确认')) {
      & rg -F -n -- $pattern $doc | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "$doc 缺少事实：$pattern" }
    }
  }
  & rg -F -n -- '+662' docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md docs/operations/character-workshop-acceptance.md
  if ($LASTEXITCODE -ne 0) { throw 'owner 总账同步缺失' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw '文档 diff-check 失败' }
  $expectedWorktree = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualWorktree = @(git diff --name-only)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedWorktree $actualWorktree).Count -ne 0) { throw '未暂存 tracked 差异不止五文档' }
  $cachedBeforeReview = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0 -or $cachedBeforeReview.Count -ne 0) { throw '复审前暂存区必须为空' }
  ```

  两条禁止项扫描必须精确退出 1，不能把工具错误 exit 2 当成零命中；五个文件必须分别命中固定 hash、限语和人工待验。

- [ ] **Step 4：独立复审 cached 五文档差异**

  只暂存精确五文件：

  ```powershell
  git add docs/operations/character-workshop-acceptance.md docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md
  if ($LASTEXITCODE -ne 0) { throw '五文档暂存失败' }
  ```

  新鲜审查者检查 cached 差异的事实、替代范围、链接、限语和可执行零差异。Critical/Important 清零才可提交；审查不重跑五门。

- [ ] **Step 5：提交唯一纯文档后继**

  ```powershell
  $expectedCached = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualCached = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedCached $actualCached).Count -ne 0) { throw '文档后继 allowlist 不一致' }
  $unstaged = @(git diff --name-only)
  if ($LASTEXITCODE -ne 0 -or $unstaged.Count -ne 0) { throw '提交前仍有未暂存 tracked 差异' }
  $candidate = '55bd05898dca055cc4ed239e82072e30f1848de3'
  if (@(git diff --cached --name-only -- . ':(exclude)docs/**').Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '暂存区出现非文档差异' }
  git commit -m "docs(desktop): 通过非复现稳定性准入"
  if ($LASTEXITCODE -ne 0) { throw '文档后继提交失败' }
  ```

- [ ] **Step 6：提交后记录文档 hash 与可执行零差异**

  ```powershell
  $candidate = '55bd05898dca055cc4ed239e82072e30f1848de3'
  $docsHead = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw '读取文档 HEAD 失败' }
  $allPaths = @(git diff --name-status "$candidate..HEAD")
  if ($LASTEXITCODE -ne 0) { throw '读取候选区间失败' }
  $nonDocs = @(git diff --name-only "$candidate..HEAD" -- . ':(exclude)docs/**')
  if ($LASTEXITCODE -ne 0 -or $nonDocs.Count -ne 0) { throw '提交后候选区间存在非文档差异' }
  $expectedAllDocs = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualAllDocs = @(git diff --name-only "$candidate..HEAD" -- docs)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedAllDocs $actualAllDocs).Count -ne 0) { throw '提交后完整文档 allowlist 不等于六个唯一路径' }
  $tracked = @(git status --short --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $tracked.Count -ne 0) { throw '提交后 tracked 工作树不干净' }
  $docsHead
  $allPaths
  ```

  `docs-successor-report.md` 记录实际文档提交 hash、候选以来全部文档路径和 `docs/` 外零输出。正式文档不回写该 hash。ledger 写 `Task 3: complete`。

## 最终完成标准

- baseline 证明候选为 `55bd05898dca055cc4ed239e82072e30f1848de3`，门前只有本规格/计划两份纯文档变化；
- 五门固定顺序、各一次、同一候选可执行树、全 exit 0、各小于 15 分钟；
- 独立复审 Critical/Important 为零且没有重跑正式门；
- 代码、测试、config、依赖、脚本、网站/云端保护路径和 owner 账本均未改变；
- 唯一纯文档后继同步五份事实源；
- 最终只发布“稳定性准入通过，已知偶发超时根因未定位”。

任一条件不满足，最终状态为 `CLOSED`，不重跑、不补丁式修门，另立独立规格。
