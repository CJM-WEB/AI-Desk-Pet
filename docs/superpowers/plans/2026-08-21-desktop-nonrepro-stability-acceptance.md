# AI Pet 桌宠非复现稳定性准入例外实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`；命令执行者、证据审查者和最终文档审查者必须是不同的新鲜子智能体。严禁在本计划复审完成前执行任何正式门。

**目标：** 不修改任何可执行内容，在固定候选可执行 HEAD `55bd05898dca055cc4ed239e82072e30f1848de3` 上，用一次性、不可重跑、机器证据绑定的五门结果裁决是否恢复常规开发。

**架构：** 本修订提交先由主控双审查；双审查 Ready 后才在 ignored 证据中外部冻结实际 `CONTROL_HEAD`。随后固定 baseline、自测机器记录链，再由五个彼此独立的自包含 PowerShell 调用各执行一门；首个失败立即关闭。成功后只允许一个直接 parent 为 `CONTROL_HEAD` 的五文档后继提交。

**技术栈：** PowerShell 7.x（`pwsh`）、pnpm 11、Vitest 3、Electron、Playwright、Git、Markdown。

## 全局约束

- 批准规格为 `docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`。
- 固定候选可执行 HEAD 为 `55bd05898dca055cc4ed239e82072e30f1848de3`；历史首次文档提交为 `9e88370ff4061eb91ac1f23184248628fa0edfd6`，后者不是执行控制点。
- `CONTROL_HEAD` 不写入 tracked 文档。它只能在本修订提交经过主控两份独立 C0/I0 Ready 审查后，以实际完整 HEAD 外部冻结；之后门前、每门前后和最终 review 的 HEAD 必须逐字相等。
- 15/15 三 seam GREEN 是稳定性证据，不是修复。成功限语只能是“稳定性准入通过，已知偶发超时根因未定位”。
- 五门固定顺序：`verify:desktop`、`verify:characters`、`verify:behavior`、`test:security`、`test:integration`。每门只 spawn 一次；首个非零、超时、spawn/termination/证据/工作树失败后停止。
- 不重跑、不 retry、不提高 timeout、不 skip、不降低 worker、不改代码/测试/config/依赖/脚本。
- 单个 PowerShell block 从首行启动绝对 Stopwatch：前后 Git guard 每个子命令最多 3000ms，pnpm 主等待最多 780000ms，有界终止最多 20000ms，block 在 870000ms 前主动返回；为执行工具的 900000ms 硬停止预留至少 30 秒。
- Task 0 必须验证 `$PSVersionTable.PSVersion.Major -ge 7`，否则 `CLOSED`；禁止用 Windows PowerShell 5.1 执行含 `Process.Kill(Boolean)` 的 block。
- 每个 block 由执行工具设置 900000ms 硬停止；正常清理必须由 block 在 870000ms 内完成，外层只作失控兜底。兜底触发即 `CLOSED`，恢复分支只清理已由 start 记录双重标识的树，不重跑门。
- 普通 `git status --short` 必须无输出；禁止关闭 untracked 枚举。任何 non-ignored untracked 都阻断。保护路径另用 `git ls-files --others --exclude-standard` 显式枚举。
- 受保护路径：`apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、`tests/e2e/website.spec.ts`、`tests/playwright.website.config.ts`。不修改、不运行网站/CloudBase/scanner。
- owner inventory 的 `+1956/-1294`、净增 `662` 原样保留，不再硬删。
- 不 push、不 merge、不 rebase、不 reset。成功后继以外不再创建 tracked 提交。

## 覆盖关系

本计划只在本固定候选与外部冻结 `CONTROL_HEAD` 上替代旧开发门计划 `NO_RED` 禁止进入 Task 5/6 的分支，以及旧 Task 6 的四文件/旧 allowlist。它同时落实新规格对旧开发门规格第 7.1、7.3、9.1 和第 10 节第 10 项的限域替代：

- 门前相对候选 HEAD 只能有本计划与本规格两个新文档路径；
- 成功后继只修改本规格和四份既有状态文档；
- 最终相对候选 HEAD 只能有六个唯一文档路径；
- 其余可执行零差异、保护路径、C1–C10 与人工待验规则继续有效。

## 专属 ignored 证据

固定目录：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/`。

| 文件 | 作用 |
| --- | --- |
| `progress.md` | SDD 恢复账本，精确记录 Task/门 started/complete |
| `control-head.txt` | 唯一一行外部冻结完整 HEAD |
| `control-review.md` | 被审查 commit、两份 C0/I0 Ready 与 review package SHA-256 |
| `baseline.md` | 候选/control、旧 baseline 脚本逐字对比、15/15、owner 与保护路径 |
| `gate-N.start.json` | 第 N 门 spawn 后立即 CreateNew 的 PID/启动时间/session |
| `gate-N.final.json` | 同一 block 原子 CreateNew 的真实结束事实；其 exit 变量也是 block 唯一 native return |
| `raw-record-manifest.json` | 已执行门全部原始机器记录的路径与 SHA-256；完整 PASS 时固定十份 |
| `gate-summary.json` | 只由原始记录机械汇总的单次/顺序/exit/耗时/终局 |
| `review.md` | 复算 raw manifest 与 summary hash 后的独立裁决 |
| `docs-successor-report.md` | 成功后继 hash、parent、rev-list 与六路径证明 |

不得创建 stdout/stderr artifact。JSON 不含绝对路径、错误正文、测试正文、token、API Key、Authorization 或用户数据。

---

### Task 0：双审查后外部冻结 CONTROL_HEAD，并固定 baseline

**前置：** 主控已对本修订提交完成两份独立审查，均为 C0/I0 Ready。未满足时本任务禁止执行。

- [ ] **Step 1：用 `apply_patch` CreateNew 冻结控制证据**

  先执行普通只读检查：

  ```powershell
  $head = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') { throw 'HEAD 非完整 hash' }
  $status = @(git status --short)
  if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw '存在 tracked 或 non-ignored untracked 差异' }
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw '必须使用 PowerShell 7.x' }
  ```

  然后只用 `apply_patch` 新增（已存在即停止，不覆盖）：

  - `control-head.txt`：只写上述实际 `$head`；
  - `control-review.md`：精确写 `ReviewedCommit=<同一hash>`、两份 `ReviewA/ReviewB=C0/I0/Ready`、两份规范化 review package 的 Base64 与 64 位小写 SHA-256。package 规范化字节固定为 UTF-8（无 BOM）、LF 换行、文件末尾一个 LF；后续审查者从 Base64 解码后重算 hash，不依赖聊天历史。

  创建后重读，要求 control HEAD、ReviewedCommit 与当前 HEAD 三者逐字相等；两个 package Base64 可解码、重算 hash 逐字匹配，且不同审查者身份明确。

- [ ] **Step 2：读取旧 baseline 的五脚本展开值并与当前逐字比较**

  ```powershell
  $oldBaseline = Get-Content -Raw '.superpowers/sdd/2026-08-21-desktop-development-gate-closure/baseline.md'
  $package = Get-Content -Raw package.json | ConvertFrom-Json
  $expectedScripts = [ordered]@{
    'verify:desktop' = 'pnpm typecheck && pnpm test:unit && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop'
    'verify:characters' = 'pnpm --filter @myself/character-runtime test && pnpm --filter @myself/character-assets test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop'
    'verify:behavior' = 'pnpm --filter @myself/character-runtime test && pnpm --filter @myself/agent-core test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop'
    'test:security' = 'vitest run --config tests/vitest.config.ts tests/security'
    'test:integration' = 'vitest run --config tests/vitest.config.ts tests/integration'
  }
  foreach ($name in $expectedScripts.Keys) {
    $current = [string]$package.scripts.$name
    $expected = [string]$expectedScripts[$name]
    if ($current -cne $expected) { throw "当前脚本展开值不一致：$name" }
    $expectedRow = '| `' + $name + '` | `' + $expected + '` |'
    $rowCount = ([regex]::Matches($oldBaseline, '(?m)^' + [regex]::Escape($expectedRow) + '\r?$')).Count
    if ($rowCount -ne 1) { throw "旧 baseline 脚本行缺失或重复：$name" }
  }
  ```

- [ ] **Step 3：执行统一 clean/HEAD/保护路径门**

  后续每个门前后和最终 review 都必须执行这组等价机械规则：

  ```powershell
  $control = (Get-Content '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/control-head.txt' -Raw).Trim()
  $head = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -ne $control) { throw 'HEAD 不等于 CONTROL_HEAD' }
  $status = @(git status --short)
  if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw '普通 status 非空' }
  $protected = @('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts')
  if (@(git diff --name-only '55bd05898dca055cc4ed239e82072e30f1848de3..HEAD' -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径历史差异' }
  if (@(git diff --name-only -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径工作树差异' }
  if (@(git diff --cached --name-only -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径暂存差异' }
  if (@(git ls-files --others --exclude-standard -- $protected).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '保护路径存在 non-ignored untracked' }
  $expectedDocs = @(
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualDocs = @(git diff --name-only '55bd05898dca055cc4ed239e82072e30f1848de3..HEAD' -- docs)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedDocs $actualDocs).Count -ne 0) { throw '门前文档路径不等于初始两路径' }
  $nonDocs = @(git diff --name-only '55bd05898dca055cc4ed239e82072e30f1848de3..HEAD' -- . ':(exclude)docs/**')
  if ($LASTEXITCODE -ne 0 -or $nonDocs.Count -ne 0) { throw '候选以来出现非文档差异' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'diff-check 失败' }
  ```

- [ ] **Step 4：写 baseline 并独立复审**

  `baseline.md` 记录 control/candidate、旧 baseline 文件 hash、五脚本旧值/当前值、15/15 GREEN 但非修复、`+662`、普通 status 与保护路径四类零差异。只用 `apply_patch` CreateNew。独立审查 C0/I0 后仅从已有证据机械重建 progress，使 `Task0=COMPLETE`。

---

### Task R：在正式门前验证机器证据链 fixture

**目标：** 不执行正式门，只验证 validator、原子记录、中断恢复和 Git guard 确实会拒绝伪证据。

- [ ] **Step 1：纯内存时间/exit fixture**

  validator 固定规则：

  - `startedAt`、`finishedAt` 必须为 `O` 格式且 finish 不早于 start；
  - `wallMs=finished-started` 与 `durationMs` 绝对误差不超过 5000ms；
  - `durationMs < 900000`；
  - `termination=NONE` 时 `exitCode` 必须是从真实 child `Process.ExitCode` 写入的整数；summary 不接受第二个 exit 来源。

  在 ignored fixture 子目录构造完整 gate-1 start/final，其中 `startedAt=2026-08-21T00:00:00.0000000+00:00`、`finishedAt=2026-08-21T00:20:00.0000000+00:00`、`durationMs=1`；设置 `DESKTOP_NONREPRO_EVIDENCE_ROOT` 指向该目录、`DESKTOP_NONREPRO_VALIDATOR_FIXTURE=1`，逐字执行 Task 2 的正式 validator fenced block，必须非零退出且不得生成 manifest/summary。禁止另写时间 validator。真实 exit 7 另由 fixture 子 block 自己原子写 final 后 `exit $nativeExit`，外层读取该子 block 的 `Process.ExitCode` 并与 JSON 同时断言为 7。

- [ ] **Step 2：spawn 后中断恢复 fixture**

  在 ignored fixture 子目录启动 `node -e "setInterval(() => {}, 1000)"` 并写完整正式 start JSON；设置 `DESKTOP_NONREPRO_EVIDENCE_ROOT` 指向该目录，逐字执行 Task 1 正式 block 的 `gateIndex=1` 版本。它必须进入正式 start-only 分支而不是 spawn pnpm，返回 125、杀死原树并原子生成 `INTERRUPTED` final。第二个子目录使用新的 Node，将真实 PID/StartTime 另存 fixture-only `cleanup.json`，但正式 start 中写入不匹配 `processStartedAt`；再次执行同一正式 block，必须返回 125、生成 `TERMINATION_FAILURE` 且真实 Node 仍存活，随后 orchestrator 只按 `cleanup.json` 的原始 PID/StartTime 双重核验后有界清理。禁止用复制版 `Stop-Exact` 代替这两次正式 block 调用。

- [ ] **Step 3：dirty untracked 与额外提交 guard fixture**

  用 `apply_patch` 在仓库根创建唯一 `desktop-nonrepro-dirty-fixture.tmp`，普通 `git status --short` 必须非空并阻断；随后用 `apply_patch` 删除该文件并确认 status 恢复为空。额外 docs commit 由固定 fixture block 在系统临时 Git 仓库中真实构造：首个提交作为临时 control，再生成并提交 `docs/extra.md`；同一 HEAD/parent/rev-list guard 必须因 `HEAD != control` 且后继尚未获准而 RED。fixture 完成后验证路径确在系统临时根并删除整个临时目录，不对项目仓库创建提交。此项证明审查后插入 docs-only 提交也会阻断，而不是只测试一个伪造字符串。

  时间、exit、中断、dirty 和额外提交检查必须由下列唯一 fixture orchestrator 执行；运行前先按上段用 `apply_patch` 创建 dirty 文件，运行后再用 `apply_patch` 删除。block 只写 ignored report 和系统临时目录，不执行正式门：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $root = '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance'
  $reportPath = "$root/fixture-report.md"
  $dirtyPath = 'desktop-nonrepro-dirty-fixture.tmp'
  if (-not (Test-Path $dirtyPath)) { throw 'dirty fixture 必须先由 apply_patch 创建' }
  function Write-Atomic([string]$path, [System.Collections.IDictionary]$value) {
    if (Test-Path $path) { throw "fixture 目标已存在：$path" }
    $temp = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
    $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 6 -Compress))
    $stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temp,$path)
  }
  $timeMarker = Get-Content -Raw "$root/fixtures/time/fixture-time-rejected.json" | ConvertFrom-Json
  $timeRejected = $timeMarker.rejected -eq $true -and $timeMarker.reason -ceq 'DURATION_INVALID'
  $exitRecord = Join-Path ([IO.Path]::GetTempPath()) "desktop-nonrepro-exit-$([guid]::NewGuid().ToString('N')).json"
  $previousExitRecord = $env:DESKTOP_NONREPRO_EXIT_RECORD
  $env:DESKTOP_NONREPRO_EXIT_RECORD = $exitRecord
  $exitChildBlock = @'
$nativeExit = 7
$path = $env:DESKTOP_NONREPRO_EXIT_RECORD
$temp = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
$bytes = [Text.Encoding]::UTF8.GetBytes((@{exitCode=$nativeExit} | ConvertTo-Json -Compress))
$stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
[IO.File]::Move($temp,$path)
exit $nativeExit
'@
  $encodedExitChild = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($exitChildBlock))
  $exitProcess = Start-Process pwsh -ArgumentList @('-NoProfile','-EncodedCommand',$encodedExitChild) -WindowStyle Hidden -PassThru
  if (-not $exitProcess.WaitForExit(10000)) { throw 'exit7 fixture 超时' }
  $observedBlockExit = [int]$exitProcess.ExitCode
  $nativeBound = ((Get-Content -Raw $exitRecord | ConvertFrom-Json).exitCode -eq $observedBlockExit -and $observedBlockExit -eq 7)
  [IO.File]::Delete($exitRecord)
  $env:DESKTOP_NONREPRO_EXIT_RECORD = $previousExitRecord
  $recoveryGood = Get-Content -Raw "$root/fixtures/recovery-good/gate-1.final.json" | ConvertFrom-Json
  $interruptBound = $recoveryGood.termination -ceq 'INTERRUPTED' -and $recoveryGood.exitCode -eq 125 -and $null -eq (Get-Process -Id ([int]$recoveryGood.pid) -ErrorAction SilentlyContinue)
  $recoveryMismatch = Get-Content -Raw "$root/fixtures/recovery-mismatch/gate-1.final.json" | ConvertFrom-Json
  $mismatchCleanup = Get-Content -Raw "$root/fixtures/recovery-mismatch/cleanup.json" | ConvertFrom-Json
  $mismatchProcess = Get-Process -Id ([int]$recoveryMismatch.pid) -ErrorAction SilentlyContinue
  $cleanupIdentity = $false
  if ($null -ne $mismatchProcess) { try { $cleanupIdentity = $mismatchProcess.StartTime.ToUniversalTime().ToString('O') -ceq [string]$mismatchCleanup.processStartedAt } catch {} }
  $mismatchRefused = $recoveryMismatch.termination -ceq 'TERMINATION_FAILURE' -and $recoveryMismatch.exitCode -eq 125 -and $cleanupIdentity
  if ($cleanupIdentity) { try { $mismatchProcess.Kill($true); $mismatchProcess.WaitForExit(5000) | Out-Null } catch {} }
  if ($null -ne (Get-Process -Id ([int]$recoveryMismatch.pid) -ErrorAction SilentlyContinue)) { throw 'mismatch fixture 清理失败' }
  $dirtyRejected = @(git status --short | Where-Object { $_ -match 'desktop-nonrepro-dirty-fixture\.tmp$' }).Count -eq 1
  $tempRepo = Join-Path ([IO.Path]::GetTempPath()) "desktop-nonrepro-git-$([guid]::NewGuid().ToString('N'))"
  try {
    New-Item -ItemType Directory -Path (Join-Path $tempRepo 'docs') -Force | Out-Null
    git -C $tempRepo init --quiet; git -C $tempRepo config user.name fixture; git -C $tempRepo config user.email fixture@example.invalid
    [IO.File]::WriteAllText((Join-Path $tempRepo 'docs/base.md'),'base',[Text.Encoding]::UTF8)
    git -C $tempRepo add docs/base.md; git -C $tempRepo commit --quiet -m base
    $tempControl = (git -C $tempRepo rev-parse HEAD).Trim()
    [IO.File]::WriteAllText((Join-Path $tempRepo 'docs/extra.md'),'extra',[Text.Encoding]::UTF8)
    git -C $tempRepo add docs/extra.md; git -C $tempRepo commit --quiet -m extra
    $tempHead = (git -C $tempRepo rev-parse HEAD).Trim()
    $extraHeadRejected = $tempHead -ne $tempControl -and [int](git -C $tempRepo rev-list --count "$tempControl..HEAD") -eq 1
  } finally {
    if ((Resolve-Path $tempRepo).Path.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) { [IO.Directory]::Delete($tempRepo,$true) }
  }
  $result = [ordered]@{timeMismatchRejected=$timeRejected;nativeExit7Bound=$nativeBound;interruptRecoveryBound=$interruptBound;identityMismatchKillRefused=$mismatchRefused;dirtyUntrackedRejected=$dirtyRejected;extraHeadRejected=$extraHeadRejected}
  if (@($result.Values | Where-Object { $_ -ne $true }).Count -ne 0) { throw 'fixture 至少一项未按预期拒绝' }
  Write-Atomic $reportPath $result
  ```

- [ ] **Step 4：fixture 报告独立复审**

  ignored `fixture-report.md` 必须由 fixture block 以原子 CreateNew 机械写入 JSON，字段集合精确为 `timeMismatchRejected`、`nativeExit7Bound`、`interruptRecoveryBound`、`identityMismatchKillRefused`、`dirtyUntrackedRejected`、`extraHeadRejected`；不得人工填写结果，不保存进程输出。新鲜审查者重做输入/输出断言并计算报告 SHA-256，六项全部为布尔 `true` 且 C0/I0 后 progress 才机械得到 `TaskR=COMPLETE`。任一不符，本计划 `CLOSED`，不得执行正式门。

---

### Task 1：五门各由单个自包含 block 执行一次

**前置：** Task 0、Task R complete；`gate-*.start/final.json` 全部不存在。

#### 统一机器 schema

start JSON 只能包含：`schemaVersion`、`controlHead`、`gateIndex`、`gateName`、`session`、`startedAt`、`pid`、`processStartedAt`。

final JSON 只能包含上述字段再加：`finishedAt`、`durationMs`、`exitCode`、`killExitCode`、`termination`。`termination` 只能为 `NONE|TIMEOUT|SPAWN_FAILURE|TERMINATION_FAILURE|INTERRUPTED|EVIDENCE_FAILURE`。

#### 自包含 block

五次调用分别把首行 `$gateIndex` 固定为 1、2、3、4、5；除此之外 block 字节不变。block 内部 switch 唯一映射门名，因此不得人工传门名。每次作为独立 PowerShell 调用执行：

```powershell
$gateIndex = 1 # 五次调用依次固定为 1、2、3、4、5
$absoluteTimer = [Diagnostics.Stopwatch]::StartNew()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$evidenceRoot = if ([string]::IsNullOrWhiteSpace($env:DESKTOP_NONREPRO_EVIDENCE_ROOT)) { '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance' } else { $env:DESKTOP_NONREPRO_EVIDENCE_ROOT }
$control = (Get-Content "$evidenceRoot/control-head.txt" -Raw).Trim()
$gateName = switch ($gateIndex) {
  1 { 'verify:desktop' }
  2 { 'verify:characters' }
  3 { 'verify:behavior' }
  4 { 'test:security' }
  5 { 'test:integration' }
  default { throw '非法 gateIndex' }
}
$startPath = "$evidenceRoot/gate-$gateIndex.start.json"
$finalPath = "$evidenceRoot/gate-$gateIndex.final.json"
function Write-AtomicNewJson([string]$path, [System.Collections.IDictionary]$value) {
  $json = $value | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $tempPath = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
  $stream = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($tempPath, $path) # 同目录原子 rename；目标存在时失败，绝不覆盖
}
function Assert-RecordShape($record,[string]$kind) {
  $startKeys = @('schemaVersion','controlHead','gateIndex','gateName','session','startedAt','pid','processStartedAt')
  $expectedKeys = if ($kind -eq 'start') { $startKeys } else { @($startKeys + @('finishedAt','durationMs','exitCode','killExitCode','termination')) }
  if (@(Compare-Object $expectedKeys @($record.PSObject.Properties.Name)).Count -ne 0) { throw "$kind temp 字段集合不合法" }
  if ($record.schemaVersion -ne 1 -or $record.controlHead -cne $control -or $record.gateIndex -ne $gateIndex -or $record.gateName -cne $gateName) { throw "$kind temp 身份不合法" }
  if ([string]$record.session -notmatch '^[0-9a-f]{32}$') { throw "$kind temp session 不合法" }
  $parsedStarted = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact([string]$record.startedAt,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$parsedStarted)) { throw "$kind temp startedAt 不合法" }
  if ($kind -eq 'start') {
    $parsedProcessStarted = [DateTimeOffset]::MinValue
    if ([int]$record.pid -le 0 -or -not [DateTimeOffset]::TryParseExact([string]$record.processStartedAt,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$parsedProcessStarted)) { throw 'start temp 进程身份不合法' }
  }
  if ($kind -eq 'final') {
    $parsedFinished = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact([string]$record.finishedAt,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$parsedFinished)) { throw 'final temp finishedAt 不合法' }
    if ([string]$record.termination -notin @('NONE','TIMEOUT','SPAWN_FAILURE','TERMINATION_FAILURE','INTERRUPTED','EVIDENCE_FAILURE')) { throw 'final temp termination 不合法' }
    $duration = 0L; $exitCode = 0
    $wallDuration = [long]($parsedFinished-$parsedStarted).TotalMilliseconds
    if (-not [long]::TryParse([string]$record.durationMs,[ref]$duration) -or $wallDuration -lt 0 -or $duration -lt 0 -or $duration -ge 900000 -or [Math]::Abs($wallDuration-$duration) -gt 5000) { throw 'final temp duration 不合法' }
    if (-not [int]::TryParse([string]$record.exitCode,[ref]$exitCode)) { throw 'final temp exitCode 不合法' }
    $expectedExit = switch ([string]$record.termination) { 'NONE' {$exitCode} 'TIMEOUT' {124} 'SPAWN_FAILURE' {70} default {125} }
    if ($exitCode -ne $expectedExit) { throw 'final temp exit/termination 不一致' }
    if ($record.termination -eq 'SPAWN_FAILURE') {
      if ($null -ne $record.pid -or $null -ne $record.processStartedAt -or $null -ne $record.killExitCode) { throw 'final temp SPAWN_FAILURE 组合不合法' }
    } else {
      $parsedProcessStarted = [DateTimeOffset]::MinValue
      if ([int]$record.pid -le 0 -or -not [DateTimeOffset]::TryParseExact([string]$record.processStartedAt,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$parsedProcessStarted)) { throw 'final temp 进程身份不合法' }
      if ($record.termination -eq 'NONE' -and $null -ne $record.killExitCode) { throw 'final temp NONE 不应有 killExitCode' }
      if ($null -ne $record.killExitCode) { $parsedKill = 0; if (-not [int]::TryParse([string]$record.killExitCode,[ref]$parsedKill)) { throw 'final temp killExitCode 不合法' } }
    }
  }
}
function Complete-AtomicResidue([string]$path,[string]$kind) {
  $directory = Split-Path -Parent $path
  $leaf = Split-Path -Leaf $path
  $residues = @(Get-ChildItem -LiteralPath $directory -Filter "$leaf.tmp-*" -File -ErrorAction Stop)
  if (Test-Path $path) {
    if ($residues.Count -ne 0) { throw '最终记录与 temp 同时存在' }
    return
  }
  if ($residues.Count -eq 0) { return }
  if ($residues.Count -ne 1) { throw '原子 temp 数量不唯一' }
  $record = Get-Content -Raw -LiteralPath $residues[0].FullName | ConvertFrom-Json
  Assert-RecordShape $record $kind
  if ($kind -eq 'start') {
    [IO.File]::Move($residues[0].FullName, $path)
    return
  }
  # final 未完成 rename 意味着原 block 未能可信返回；永远降为 EVIDENCE_FAILURE，禁止把 temp 绿色提升为 PASS。
  $recoveredFinishedAt = [DateTimeOffset]::UtcNow
  $recoveredStartedAt = [DateTimeOffset]::ParseExact([string]$record.startedAt,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
  $recoveredDuration = [long][Math]::Max(0,($recoveredFinishedAt-$recoveredStartedAt).TotalMilliseconds)
  $failure = [ordered]@{
    schemaVersion=1;controlHead=$record.controlHead;gateIndex=$record.gateIndex;gateName=$record.gateName;session=$record.session
    startedAt=$record.startedAt;pid=$record.pid;processStartedAt=$record.processStartedAt;finishedAt=$recoveredFinishedAt.ToString('O')
    durationMs=$recoveredDuration;exitCode=125;killExitCode=$record.killExitCode;termination='EVIDENCE_FAILURE'
  }
  Write-AtomicNewJson $path $failure
  [IO.File]::Delete($residues[0].FullName)
}
function Test-ProcessIdentity([int]$targetPid, [string]$startedAt) {
  $candidate = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $candidate) { return $false }
  try { return $candidate.StartTime.ToUniversalTime().ToString('O') -eq $startedAt } catch { return $false }
}
function Stop-TreeBounded([int]$targetPid, [string]$startedAt) {
  if (-not (Test-ProcessIdentity $targetPid $startedAt)) { return @{ killExit = $null; alive = $true } }
  $killer = $null
  $killExit = $null
  try {
    $killer = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID',"$targetPid",'/T','/F') -WindowStyle Hidden -PassThru
    $killerFinished = $killer.WaitForExit(10000)
    if (-not $killerFinished) {
      try { $killer.Kill($true) } catch {}
      $killer.WaitForExit(5000) | Out-Null
    }
    try { $killer.Refresh() } catch {}
    if ($killer.HasExited) { $killExit = $killer.ExitCode }
  } catch {
    if ($null -ne $killer) {
      try { $killer.Kill($true); $killer.WaitForExit(5000) | Out-Null } catch {}
    }
  }
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ((Test-ProcessIdentity $targetPid $startedAt) -and $deadline.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 100 }
  return @{ killExit = $killExit; alive = (Test-ProcessIdentity $targetPid $startedAt) }
}
function Invoke-GitBounded([string[]]$arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = 'git.exe'; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
  $gitProcess = [Diagnostics.Process]::new(); $gitProcess.StartInfo = $info
  if (-not $gitProcess.Start()) { throw 'git 启动失败' }
  $stdoutTask = $gitProcess.StandardOutput.ReadToEndAsync(); $stderrTask = $gitProcess.StandardError.ReadToEndAsync()
  if (-not $gitProcess.WaitForExit(2500)) {
    try { $gitProcess.Kill($true); $gitProcess.WaitForExit(500) | Out-Null } catch {}
    throw 'git 子命令超时'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult(); $stderrTask.GetAwaiter().GetResult() | Out-Null
  if ($gitProcess.ExitCode -ne 0) { throw 'git 子命令失败' }
  return @($stdout -split '\r?\n' | Where-Object { $_ -ne '' })
}
function Assert-StaticState([string]$expectedControl) {
  $headLines = @(Invoke-GitBounded @('rev-parse','HEAD'))
  if ($headLines.Count -ne 1 -or $headLines[0].Trim() -ne $expectedControl) { throw 'HEAD 不等于 CONTROL_HEAD' }
  $status = @(Invoke-GitBounded @('status','--short'))
  if ($status.Count -ne 0) { throw '普通 status 非空' }
  $protected = @('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts')
  $historical = @(Invoke-GitBounded (@('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--') + $protected))
  if ($historical.Count -ne 0) { throw '保护路径历史差异' }
  $worktree = @(Invoke-GitBounded (@('diff','--name-only','--') + $protected))
  if ($worktree.Count -ne 0) { throw '保护路径工作树差异' }
  $cached = @(Invoke-GitBounded (@('diff','--cached','--name-only','--') + $protected))
  if ($cached.Count -ne 0) { throw '保护路径暂存差异' }
  $untracked = @(Invoke-GitBounded (@('ls-files','--others','--exclude-standard','--') + $protected))
  if ($untracked.Count -ne 0) { throw '保护路径存在 non-ignored untracked' }
  $expectedDocs = @(
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualDocs = @(Invoke-GitBounded @('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--','docs'))
  if (@(Compare-Object $expectedDocs $actualDocs).Count -ne 0) { throw '门前文档路径不等于初始两路径' }
  $nonDocs = @(Invoke-GitBounded @('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--','.',':(exclude)docs/**'))
  if ($nonDocs.Count -ne 0) { throw '候选以来出现非文档差异' }
}
Complete-AtomicResidue $startPath 'start'
Complete-AtomicResidue $finalPath 'final'
if (Test-Path $finalPath) { throw 'final 已存在，禁止重跑或恢复' }
if (Test-Path $startPath) {
  $startRecord = Get-Content -Raw $startPath | ConvertFrom-Json
  $expectedStartKeys = @('schemaVersion','controlHead','gateIndex','gateName','session','startedAt','pid','processStartedAt')
  if (@(Compare-Object $expectedStartKeys @($startRecord.PSObject.Properties.Name)).Count -ne 0) { throw '中断 start schema 不合法' }
  if ($startRecord.schemaVersion -ne 1 -or $startRecord.controlHead -cne $control -or $startRecord.gateIndex -ne $gateIndex -or $startRecord.gateName -cne $gateName) { throw '中断 start 身份不合法' }
  if ([int]$startRecord.pid -le 0 -or [string]$startRecord.session -notmatch '^[0-9a-f]{32}$') { throw '中断 PID/session 不合法' }
  $parsedStartedAt = [DateTimeOffset]::MinValue
  $parsedProcessStartedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact([string]$startRecord.startedAt, 'O', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedStartedAt)) { throw '中断 startedAt 不合法' }
  if (-not [DateTimeOffset]::TryParseExact([string]$startRecord.processStartedAt, 'O', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedProcessStartedAt)) { throw '中断 processStartedAt 不合法' }
  $recoveryProcess = Get-Process -Id ([int]$startRecord.pid) -ErrorAction SilentlyContinue
  $recoveryTermination = 'INTERRUPTED'
  $recoveryKillExit = $null
  if ($null -ne $recoveryProcess) {
    if (Test-ProcessIdentity ([int]$startRecord.pid) ([string]$startRecord.processStartedAt)) {
      $recoveryStop = Stop-TreeBounded ([int]$startRecord.pid) ([string]$startRecord.processStartedAt)
      $recoveryKillExit = $recoveryStop.killExit
      if ($recoveryStop.alive) { $recoveryTermination = 'TERMINATION_FAILURE' }
    } else {
      $recoveryTermination = 'TERMINATION_FAILURE' # PID 可能复用，禁止杀进程
    }
  }
  $recoveryFinishedAt = [DateTimeOffset]::UtcNow
  $recoveryDuration = [long][Math]::Max(0, ($recoveryFinishedAt - $parsedStartedAt).TotalMilliseconds)
  try { Assert-StaticState $control } catch { $recoveryTermination = 'EVIDENCE_FAILURE' }
  Write-AtomicNewJson $finalPath ([ordered]@{
    schemaVersion=1; controlHead=$control; gateIndex=$gateIndex; gateName=$gateName; session=[string]$startRecord.session
    startedAt=[string]$startRecord.startedAt; pid=[int]$startRecord.pid; processStartedAt=[string]$startRecord.processStartedAt
    finishedAt=$recoveryFinishedAt.ToString('O'); durationMs=$recoveryDuration
    exitCode=125; killExitCode=$recoveryKillExit; termination=$recoveryTermination
  })
  exit 125
}
Assert-StaticState $control
$session = [guid]::NewGuid().ToString('N')
$startedAt = [DateTimeOffset]::UtcNow
$timer = [Diagnostics.Stopwatch]::StartNew()
$process = $null
$processStartedAt = $null
$nativeExit = 70
$termination = 'SPAWN_FAILURE'
$killExit = $null
try {
  $process = Start-Process -FilePath 'pnpm.cmd' -ArgumentList @($gateName) -WindowStyle Hidden -PassThru
  $processStartedAt = $process.StartTime.ToUniversalTime().ToString('O')
  Write-AtomicNewJson $startPath ([ordered]@{
    schemaVersion=1; controlHead=$control; gateIndex=$gateIndex; gateName=$gateName; session=$session
    startedAt=$startedAt.ToString('O'); pid=$process.Id; processStartedAt=$processStartedAt
  })
  $finished = $process.WaitForExit(780000)
  if ($finished) {
    $process.Refresh()
    $nativeExit = [int]$process.ExitCode
    $termination = 'NONE'
  } else {
    $stop = Stop-TreeBounded $process.Id $processStartedAt
    $killExit = $stop.killExit
    if ($stop.alive) { $nativeExit = 125; $termination = 'TERMINATION_FAILURE' }
    else { $nativeExit = 124; $termination = 'TIMEOUT' }
  }
} catch {
  if ($null -ne $process -and $null -ne $processStartedAt -and (Test-ProcessIdentity $process.Id $processStartedAt)) {
    $stop = Stop-TreeBounded $process.Id $processStartedAt
    $killExit = $stop.killExit
    $termination = if ($stop.alive) { 'TERMINATION_FAILURE' } else { 'EVIDENCE_FAILURE' }
    $nativeExit = 125
  } elseif ($null -ne $process) {
    try { $process.Kill($true); $process.WaitForExit(5000) | Out-Null; $process.Refresh() } catch {}
    $processAlive = $true
    try { $processAlive = -not $process.HasExited } catch {}
    $termination = if ($processAlive) { 'TERMINATION_FAILURE' } else { 'EVIDENCE_FAILURE' }
    $nativeExit = 125
  }
} finally {
  try { Assert-StaticState $control } catch { $nativeExit = 125; $termination = 'EVIDENCE_FAILURE' }
  if ($absoluteTimer.ElapsedMilliseconds -ge 870000) { $nativeExit = 125; $termination = 'EVIDENCE_FAILURE' }
  $timer.Stop()
  $finishedAt = [DateTimeOffset]::UtcNow
  $pidValue = if ($null -eq $process) { $null } else { $process.Id }
  $startValue = if ($null -eq $processStartedAt) { $null } else { $processStartedAt }
  try {
    Write-AtomicNewJson $finalPath ([ordered]@{
      schemaVersion=1; controlHead=$control; gateIndex=$gateIndex; gateName=$gateName; session=$session
      startedAt=$startedAt.ToString('O'); pid=$pidValue; processStartedAt=$startValue
      finishedAt=$finishedAt.ToString('O'); durationMs=[long]$timer.ElapsedMilliseconds
      exitCode=$nativeExit; killExitCode=$killExit; termination=$termination
    })
  } catch { $nativeExit = 125 }
}
exit $nativeExit
```

final JSON 的 `exitCode` 与 block 最后一行 `exit $nativeExit` 使用同一个不可由调用者传入的变量；Task R 的真实 exit 7 fixture 必须证明序列化值与 native return 同源。child stdout/stderr 不重定向到文件。若会话中断，必须先恢复原 execution session；只有 session 已确认不可恢复时，才允许用同一 block 的“start 已存在”分支收口。该分支不 spawn pnpm、不重跑门，只以 PID/StartTime 双重身份做有界清理并原子 CreateNew `INTERRUPTED` 或 `TERMINATION_FAILURE` final；身份不匹配时绝不杀进程。

- [ ] **Step 1–5：依次执行 gateIndex 1–5**

  只有前一门 start/final 经最小 schema 检查为 `termination=NONE`、`exitCode=0`、`durationMs<900000`，且执行工具观察到同一 block native return=0，才执行下一门。每次调用后仅由 raw 文件机械重建 progress；首个失败立即得到 `CLOSED`，后续 start/final 必须不存在。任一 start 已存在即视为已 spawn，绝不再次启动该 index；上述 recovery-only 分支不计为第二次门启动。

---

### Task 2：机械汇总、hash 绑定与独立 review

#### manifest、summary 与 review 的唯一 schema

- `raw-record-manifest.json` 只能包含 `schemaVersion=1`、`controlHead` 和按相对路径升序排列的 `records`；每个 record 只能有 `path`、64 位小写 `sha256`。路径集合必须与磁盘实际 `gate-[1-5].start/final.json` 集合完全相等。
- `gate-summary.json` 只能包含 `schemaVersion=1`、`controlHead`、`rawManifestSha256`、`executedCount`、按 gateIndex 升序的 `gates`、`finalReason`、`finalStatus`。每个 gate 只能有 `gateIndex`、`gateName`、`startedAt`、`finishedAt`、`durationMs`、`exitCode`、`killExitCode`、`termination`。`finalReason` 只能为 `ALL_GATES_GREEN|GATE_FAILURE|TIMEOUT|INTERRUPTED|SPAWN_FAILURE|TERMINATION_FAILURE|EVIDENCE_FAILURE`，只有五门完整 `NONE/0` 时允许 `finalStatus=PASS` 与 `ALL_GATES_GREEN`，其余固定 `CLOSED`。
- `review.md` 是唯一允许的行式报告，且只能有一次并按此顺序出现：`ControlHead=`、`RawManifestSha256=`、`GateSummarySha256=`、`FixtureReportSha256=`、`Critical=`、`Important=`、`FinalStatus=`、`结论=`。各 hash 必须由独立审查者对当前文件重算；不得从执行者的文本复制。
- `progress.md` 不是门事实源，只能由机器从现有 control/baseline/fixture/start/final/summary/review 文件重建，固定行顺序为 `SchemaVersion=1`、`ControlHead=`、`Task0=`、`TaskR=`、`Gate.1=` 至 `Gate.5=`、`Task2=`、`Task3=`、`FinalStatus=`；Task/Gate 值只能为 `NOT_STARTED|STARTED|COMPLETE|CLOSED`，`FinalStatus` 只能为 `PASS|CLOSED`。禁止人工追加或手工转录门结果。

- [ ] **Step 1：机器验证全部既有原始记录**

  对每个已执行门验证：成功与已持久化 start 的门必须 start/final 成对。只有两种 final-only 合法：真正 `SPAWN_FAILURE`（PID/processStartedAt 为 null）或 start 原子落盘失败后的 `EVIDENCE_FAILURE`（PID 为正整数、processStartedAt 合法且进程树已证明退出）；其他 final-only 一律拒绝。两份共有字段逐字相同；gateIndex/name 顺序正确；时间为 `O` 格式；`wallMs=finished-started` 与 duration 绝对误差 `<=5000ms`；duration `>=0` 且 `<900000`；termination/exit/killExit 组合合法。执行门必须是从 1 开始的连续前缀；首失败后不能存在后续记录。完整 PASS 必须五门各有 start/final 且全 `NONE/0`。

  validator 不是自由实现：必须执行下列固定 block。它只读 raw，任何异常直接 `CLOSED`；通过时才原子生成 manifest 与 summary：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $root = if ([string]::IsNullOrWhiteSpace($env:DESKTOP_NONREPRO_EVIDENCE_ROOT)) { '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance' } else { $env:DESKTOP_NONREPRO_EVIDENCE_ROOT }
  $control = (Get-Content "$root/control-head.txt" -Raw).Trim()
  $names = @('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
  function Read-Json([string]$path) { Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
  function Assert-Keys($value, [string[]]$keys, [string]$label) {
    if (@(Compare-Object $keys @($value.PSObject.Properties.Name)).Count -ne 0) { throw "$label 字段集合不合法" }
  }
  function Read-O([string]$value, [string]$label) {
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact($value, 'O', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { throw "$label 不是 O 时间" }
    return $parsed
  }
  function Assert-Duration([string]$startedAt, [string]$finishedAt, $durationValue, [string]$label) {
    $duration = 0L
    if (-not [long]::TryParse([string]$durationValue, [ref]$duration) -or $duration -lt 0 -or $duration -ge 900000) {
      if ($env:DESKTOP_NONREPRO_VALIDATOR_FIXTURE -eq '1') { Write-AtomicJson "$root/fixture-time-rejected.json" ([ordered]@{rejected=$true;reason='DURATION_INVALID'}) }
      throw "$label duration 非法"
    }
    $wall = [long]((Read-O $finishedAt "$label.finishedAt") - (Read-O $startedAt "$label.startedAt")).TotalMilliseconds
    if ($wall -lt 0 -or [Math]::Abs($wall - $duration) -gt 5000) {
      if ($env:DESKTOP_NONREPRO_VALIDATOR_FIXTURE -eq '1') { Write-AtomicJson "$root/fixture-time-rejected.json" ([ordered]@{rejected=$true;reason='DURATION_INVALID'}) }
      throw "$label wall/duration 不一致"
    }
    return $duration
  }
  function Write-AtomicJson([string]$path, [System.Collections.IDictionary]$value) {
    $expectedJson = $value | ConvertTo-Json -Depth 8 -Compress
    $directory = Split-Path -Parent $path; $leaf = Split-Path -Leaf $path
    $residues = @(Get-ChildItem -LiteralPath $directory -Filter "$leaf.tmp-*" -File -ErrorAction Stop)
    if (Test-Path $path) {
      if ($residues.Count -ne 0 -or (Get-Content -Raw $path) -cne $expectedJson) { throw "既有目标/残留与机械期望不一致：$path" }
      return
    }
    if ($residues.Count -gt 0) {
      if ($residues.Count -ne 1) { throw "temp 数量不唯一：$path" }
      $residueJson = Get-Content -Raw $residues[0].FullName
      $residueJson | ConvertFrom-Json | Out-Null
      if ($residueJson -cne $expectedJson) { throw "temp schema/内容与机械期望不一致：$path" }
      [IO.File]::Move($residues[0].FullName,$path)
      return
    }
    $temp = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
    $bytes = [Text.Encoding]::UTF8.GetBytes($expectedJson)
    $stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temp,$path)
  }
  function Write-ProgressView([string]$path,[string[]]$lines) {
    $temp = "$path.tmp-$([guid]::NewGuid().ToString('N'))"
    $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
    $stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temp,$path,$true) # progress 只是 raw 派生视图，可机械替换
  }
  if ($env:DESKTOP_NONREPRO_VALIDATOR_FIXTURE -ne '1') {
    if (-not (Test-Path "$root/baseline.md") -or -not (Test-Path "$root/fixture-report.md")) { throw 'Task0/TaskR 证据缺失' }
    $fixture = Read-Json "$root/fixture-report.md"
    $fixtureKeys = @('timeMismatchRejected','nativeExit7Bound','interruptRecoveryBound','identityMismatchKillRefused','dirtyUntrackedRejected','extraHeadRejected')
    Assert-Keys $fixture $fixtureKeys 'fixture-report'
    if (@($fixture.PSObject.Properties.Value | Where-Object { $_ -ne $true }).Count -ne 0) { throw 'fixture-report 未全部通过' }
  }
  $startKeys = @('schemaVersion','controlHead','gateIndex','gateName','session','startedAt','pid','processStartedAt')
  $finalKeys = @($startKeys + @('finishedAt','durationMs','exitCode','killExitCode','termination'))
  $rawPaths = [Collections.Generic.List[string]]::new()
  $summaryGates = [Collections.Generic.List[object]]::new()
  $seenGap = $false
  $seenFailure = $false
  for ($i = 1; $i -le 5; $i += 1) {
    $startPath = "$root/gate-$i.start.json"
    $finalPath = "$root/gate-$i.final.json"
    $exists = @((Test-Path $startPath),(Test-Path $finalPath))
    if (-not ($exists -contains $true)) { $seenGap = $true; continue }
    if ($seenGap -or $seenFailure) { throw "第 $i 门出现在缺口或首失败之后" }
    if (-not (Test-Path $finalPath)) { throw "第 $i 门缺 final" }
    $final = Read-Json $finalPath
    Assert-Keys $final $finalKeys "gate-$i.final"
    if ($final.schemaVersion -ne 1 -or $final.controlHead -cne $control -or $final.gateIndex -ne $i -or $final.gateName -cne $names[$i-1]) { throw "第 $i 门身份不一致" }
    if ([string]$final.session -notmatch '^[0-9a-f]{32}$') { throw "第 $i 门 session 非法" }
    $finalDuration = Assert-Duration ([string]$final.startedAt) ([string]$final.finishedAt) $final.durationMs "gate-$i.final"
    $hasStart = Test-Path $startPath
    if ($hasStart) {
      $start = Read-Json $startPath
      Assert-Keys $start $startKeys "gate-$i.start"
      foreach ($key in $startKeys) { if ([string]$start.$key -cne [string]$final.$key) { throw "第 $i 门 start/final.$key 不一致" } }
      if ([int]$start.pid -le 0) { throw "第 $i 门 PID 非法" }
      Read-O ([string]$start.processStartedAt) "gate-$i.processStartedAt" | Out-Null
      $rawPaths.Add($startPath)
    } elseif ([string]$final.termination -eq 'SPAWN_FAILURE') {
      if ($null -ne $final.pid -or $null -ne $final.processStartedAt) { throw "第 $i 门 SPAWN_FAILURE 身份应为空" }
    } elseif ([string]$final.termination -eq 'EVIDENCE_FAILURE') {
      if ([int]$final.pid -le 0) { throw "第 $i 门 final-only EVIDENCE_FAILURE 缺 PID" }
      Read-O ([string]$final.processStartedAt) "gate-$i.processStartedAt" | Out-Null
      $sameProcess = Get-Process -Id ([int]$final.pid) -ErrorAction SilentlyContinue
      if ($null -ne $sameProcess) {
        try { $sameIdentity = $sameProcess.StartTime.ToUniversalTime().ToString('O') -eq [string]$final.processStartedAt } catch { throw "第 $i 门无法证明 final-only 原进程已退出" }
        if ($sameIdentity) { throw "第 $i 门 final-only 原进程仍存活" }
      }
    } else { throw "第 $i 门不允许 final-only" }
    $allowedFinal = @('NONE','TIMEOUT','SPAWN_FAILURE','TERMINATION_FAILURE','INTERRUPTED','EVIDENCE_FAILURE')
    if ($allowedFinal -cnotcontains [string]$final.termination) { throw "第 $i 门 final termination 非法" }
    if ($null -ne $final.killExitCode) {
      $parsedKillExit = 0
      if (-not [int]::TryParse([string]$final.killExitCode,[ref]$parsedKillExit)) { throw "第 $i 门 killExitCode 非整数/null" }
    }
    if (($final.termination -eq 'NONE' -or $final.termination -eq 'SPAWN_FAILURE') -and $null -ne $final.killExitCode) { throw "第 $i 门未终止却存在 killExitCode" }
    $expectedExit = switch ([string]$final.termination) { 'NONE' { [int]$final.exitCode } 'TIMEOUT' { 124 } 'SPAWN_FAILURE' { 70 } default { 125 } }
    if ([int]$final.exitCode -ne $expectedExit) { throw "第 $i 门 exit/termination 不一致" }
    $rawPaths.Add($finalPath)
    $summaryGates.Add([ordered]@{gateIndex=$i;gateName=$names[$i-1];startedAt=$final.startedAt;finishedAt=$final.finishedAt;durationMs=$finalDuration;exitCode=[int]$final.exitCode;killExitCode=$final.killExitCode;termination=$final.termination})
    if ($final.termination -cne 'NONE' -or [int]$final.exitCode -ne 0) { $seenFailure = $true }
  }
  if ($summaryGates.Count -eq 0) { throw '没有已执行门' }
  $records = @($rawPaths | Sort-Object | ForEach-Object { [ordered]@{path=$_.Replace('\\','/');sha256=(Get-FileHash -Algorithm SHA256 $_).Hash.ToLowerInvariant()} })
  $manifestPath = "$root/raw-record-manifest.json"
  Write-AtomicJson $manifestPath ([ordered]@{schemaVersion=1;controlHead=$control;records=$records})
  $allGreen = $summaryGates.Count -eq 5 -and -not $seenFailure
  $reason = if ($allGreen) { 'ALL_GATES_GREEN' } else { switch ([string]$summaryGates[-1].termination) { 'TIMEOUT' {'TIMEOUT'} 'INTERRUPTED' {'INTERRUPTED'} 'SPAWN_FAILURE' {'SPAWN_FAILURE'} 'TERMINATION_FAILURE' {'TERMINATION_FAILURE'} 'EVIDENCE_FAILURE' {'EVIDENCE_FAILURE'} default {'GATE_FAILURE'} } }
  $finalStatus = if($allGreen){'PASS'}else{'CLOSED'}
  Write-AtomicJson "$root/gate-summary.json" ([ordered]@{schemaVersion=1;controlHead=$control;rawManifestSha256=(Get-FileHash -Algorithm SHA256 $manifestPath).Hash.ToLowerInvariant();executedCount=$summaryGates.Count;gates=@($summaryGates);finalReason=$reason;finalStatus=$finalStatus})
  $progressLines = [Collections.Generic.List[string]]::new()
  $progressLines.Add('SchemaVersion=1'); $progressLines.Add("ControlHead=$control"); $progressLines.Add('Task0=COMPLETE'); $progressLines.Add('TaskR=COMPLETE')
  for ($i=1; $i -le 5; $i+=1) { $progressLines.Add("Gate.$i=$(if($i -le $summaryGates.Count){'COMPLETE'}else{'NOT_STARTED'})") }
  $progressLines.Add('Task2=COMPLETE'); $progressLines.Add('Task3=NOT_STARTED'); $progressLines.Add("FinalStatus=$finalStatus")
  Write-ProgressView "$root/progress.md" @($progressLines)
  ```

- [ ] **Step 2：CreateNew raw manifest 与机械 summary**

  按路径排序计算全部既有 start/final 的 SHA-256，原子 CreateNew `raw-record-manifest.json`；只从已验证 raw JSON 原子 CreateNew `gate-summary.json`。两文件都不得手工编辑。summary 固定含 controlHead、executedCount、每门 name/duration/exit/termination、FinalReason、FinalStatus；完整 PASS 的 manifest 必须恰有十条记录。

- [ ] **Step 3：独立 review 重算绑定**

  新鲜审查者重新枚举全部既有 raw 文件、计算 hash 并与 manifest 的精确路径集合逐字对比，再计算 manifest SHA-256、summary SHA-256 与 fixture report SHA-256；重跑 Task 0 Step 3 普通 status/HEAD/保护/两文档 allowlist。`review.md` 只用 `apply_patch` CreateNew，严格按上方八行 schema 写入。完整 PASS 时还必须重验十份 raw；任一 hash/事实失败均 `CLOSED`，不重跑门。

---

### Task 3：仅 PASS 后创建唯一纯文档后继

**前置：** 原样重跑 Task 2 Step 1 的完整 raw/schema/顺序/耗时/首失败 validator；summary/review 均唯一 PASS；review 中三个 hash 与当前 manifest、summary、fixture report 重算一致；当前 HEAD 等于 control；普通 status 为空。不能只检查成功字段子集。

**修改且仅修改：**

1. `docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`
2. `docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md`
3. `docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`
4. `docs/operations/character-workshop-acceptance.md`
5. `docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`

- [ ] **Step 1：同步事实并独立复审 cached 五文档**

  五份文档统一记录固定候选、五门真实 exit/耗时、`+662`、保护路径、人工待验和限语；旧开发门历史 `NO_RED/CLOSED` 保留为前阶段事实。普通 `git status --short` 只能显示这五份 tracked 修改且不能出现 untracked。机械解析 status，要求每行状态为 ` M` 且路径属于精确五文件集合；另外分别断言 `git diff --name-only` 恰为五文件、`git diff --cached --name-only` 为空、`git ls-files --others --exclude-standard` 为空。暂存后 cached allowlist 必须精确五份，unstaged 为空，docs 外为空。新鲜审查者 C0/I0 后才提交。

- [ ] **Step 2：提交并机械证明唯一后继拓扑**

  ```powershell
  $expectedCached = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualCached = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedCached $actualCached).Count -ne 0) { throw '提交前 cached 不等于精确五文档' }
  $unstaged = @(git diff --name-only)
  if ($LASTEXITCODE -ne 0 -or $unstaged.Count -ne 0) { throw '提交前存在未暂存 tracked 差异' }
  $untracked = @(git ls-files --others --exclude-standard)
  if ($LASTEXITCODE -ne 0 -or $untracked.Count -ne 0) { throw '提交前存在 non-ignored untracked' }
  $stagedNonDocs = @(git diff --cached --name-only -- . ':(exclude)docs/**')
  if ($LASTEXITCODE -ne 0 -or $stagedNonDocs.Count -ne 0) { throw '提交前 cached 存在非文档差异' }
  $control = (Get-Content '.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/control-head.txt' -Raw).Trim()
  $parentBefore = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $parentBefore -ne $control) { throw '提交前 parent 不是 CONTROL_HEAD' }
  git commit -m "docs(desktop): 通过非复现稳定性准入"
  if ($LASTEXITCODE -ne 0) { throw '后继提交失败' }
  $parentAfter = (git rev-parse HEAD^).Trim()
  $count = [int](git rev-list --count "$control..HEAD")
  if ($LASTEXITCODE -ne 0 -or $parentAfter -ne $control -or $count -ne 1) { throw '后继不是 control 的唯一一个提交' }
  $expectedAllDocs = @(
    'docs/operations/character-workshop-acceptance.md',
    'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
    'docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md',
    'docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md',
    'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
  )
  $actualAllDocs = @(git diff --name-only '55bd05898dca055cc4ed239e82072e30f1848de3..HEAD' -- docs)
  if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expectedAllDocs $actualAllDocs).Count -ne 0) { throw '最终不等于六个唯一文档路径' }
  if (@(git diff --name-only '55bd05898dca055cc4ed239e82072e30f1848de3..HEAD' -- . ':(exclude)docs/**').Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '最终存在非文档差异' }
  if (@(git status --short).Count -ne 0 -or $LASTEXITCODE -ne 0) { throw '最终普通 status 非空' }
  ```

  用 `apply_patch` CreateNew `docs-successor-report.md`，记录 docs HEAD、parent、rev-list count、六路径和 docs 外零差异。正式文档不回写自身 commit hash。

## 文档自审与当前修订提交门

本轮只修改本规格与本计划。提交前必须：

```powershell
$expected = @(
  'docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md',
  'docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md'
)
$actual = @(git diff --name-only)
if ($LASTEXITCODE -ne 0 -or @(Compare-Object $expected $actual).Count -ne 0) { throw 'fix round 范围不止两文档' }
$status = @(git status --short)
if ($LASTEXITCODE -ne 0 -or $status.Count -ne 2) { throw '普通 status 不是精确两文档修改' }
if (@($status | Where-Object { $_ -match '^\?\? ' }).Count -ne 0) { throw '存在 non-ignored untracked' }
$cached = @(git diff --cached --name-only)
if ($LASTEXITCODE -ne 0 -or $cached.Count -ne 0) { throw '当前修订提交前暂存区必须为空' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'diff-check 失败' }
```

解析本计划全部 PowerShell fenced block，要求 parser error 为零；扫描占位、旧的四路径白名单、关闭 untracked 枚举的 status 选项、接近 15 分钟且未预留清理的等待值，以及要求人工填写机器结果的文字，任何命中都须解释或修正。独立内部审查 C0/I0 后只提交这两份文档；不得执行任何正式门。

## 最终裁决

- 完整 PASS：外部冻结 control、fixtures、五门机器记录、raw/summary hash、独立 review、唯一后继和六路径全部成立，发布“稳定性准入通过，已知偶发超时根因未定位”。
- 其他任何组合：`CLOSED`；不重跑、不补门、不改代码，另立独立规格。
