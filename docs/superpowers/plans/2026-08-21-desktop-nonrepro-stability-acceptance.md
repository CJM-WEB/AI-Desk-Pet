# AI Pet 桌宠非复现稳定性准入例外实施计划

> **执行规则：** 使用 `subagent-driven-development`；执行者、证据审查者和文档审查者相互独立。本计划复审完成前严禁执行正式门。

**目标：** 不改可执行内容，在候选可执行 HEAD `55bd05898dca055cc4ed239e82072e30f1848de3` 上，用一次性五门结果决定是否恢复常规开发。

**核心边界：** gate worker 只能产生原始 start/result；只有外层 supervisor 实际观察 worker 退出并关闭进程句柄后，才可写 authoritative final 和 outer ACK。任何缺 ACK、hash 不一致或中断残留都不能成为绿色证据。

## 1. 全局约束与覆盖关系

- 适用规格：`docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`。
- 固定候选：`55bd05898dca055cc4ed239e82072e30f1848de3`；首次文档提交 `9e88370ff4061eb91ac1f23184248628fa0edfd6` 仅为历史。
- 本修订提交经主控两份独立 C0/I0 Ready 审查后，才可把实际完整 HEAD 外部冻结为 ignored `CONTROL_HEAD`。门前、每门前后和最终 review 的 HEAD 必须逐字相等。
- 15/15 三 seam GREEN 是统计稳定证据，不是根因修复。成功限语只能是“稳定性准入通过，已知偶发超时根因未定位”。
- 五门顺序固定：`verify:desktop`、`verify:characters`、`verify:behavior`、`test:security`、`test:integration`。每门只 spawn 一次；首失败后停止。
- 不重跑、不 retry、不提高 timeout、不 skip、不降低 worker、不修改代码、测试、config、依赖或脚本。
- 使用 PowerShell 7.x。单门 supervisor 从首行计时：worker 主等待 760000ms，supervisor 等待 800000ms，每个已双验同身份树的终止与核验最多 20000ms，恢复路径最多处理三份身份记录，Git guard 每个子进程最多 3000ms；所有路径必须在 870000ms 内返回，执行工具 900000ms 硬停止仅作失控兜底。
- 普通 `git status --short` 必须无输出；不能关闭 untracked 枚举。保护路径另用 `git ls-files --others --exclude-standard` 显式检查。
- 保护路径：`apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、`tests/e2e/website.spec.ts`、`tests/playwright.website.config.ts`。不修改、不运行网站、CloudBase 或 scanner。
- owner inventory 的 `+1956/-1294`、净增 `662` 原样保留，不再硬删。
- 本计划限域替代旧开发门 `NO_RED` 禁止进入 Task 5/6 的分支和旧 Task 6 四文件 allowlist，并落实新规格对旧规格第 7.1、7.3、9.1、第 10 节第 10 项的替代。门前相对候选只允许本规格/计划两个路径；成功后相对候选最终只允许六个文档路径。

## 2. ignored 证据与唯一 schema

固定目录：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/`。

| 文件 | 权威职责 |
| --- | --- |
| `control-head.txt` / `control-review.md` | 外部冻结 HEAD 与两份可重算 review package |
| `baseline.md` | 候选、脚本、15/15、owner 和保护范围 |
| `gate-N.outer-start.json` | supervisor 启动 worker 后立即记录 worker PID/StartTime/session |
| `gate-N.start.json` | worker 启动 pnpm 后立即记录 pnpm PID/StartTime/session |
| `gate-N.worker-result.json` | worker 原始退出事实；永远不能独立判绿 |
| `gate-N.final.json` | supervisor 观察 worker native exit 后生成的裁决 |
| `gate-N.outer-ack.json` | supervisor 最后签发的 ACK；绿色必须 `accepted=true` |
| `raw-record-manifest.json` / `gate-summary.json` | 全部 raw hash 与机械汇总 |
| `fixture-report.json` / `review.md` | 共享 validator fixture 与独立复审 |
| `docs-successor-report.md` | 成功后继拓扑与六路径证明 |

所有 JSON 使用同目录唯一 temp → 完整写入 → `Flush(true)` → 关闭 → 不覆盖 rename。禁止保存 stdout/stderr、错误正文、绝对路径、token、API Key、Authorization 或用户数据。

`worker-result` 只能包含 worker 观察到的 pnpm 事实。`final` 只能由 supervisor 写。`outer-ack` 必须包含 `workerResultSha256`、`finalSha256`、`observedWorkerExit` 和 `accepted`；validator 只有在 ACK、worker raw、final 三方逐字一致时才允许 PASS。

## 3. Task 0：双审查后冻结 control 与 baseline

**前置：** 主控针对本修订提交的两份独立审查均为 C0/I0 Ready。

1. 普通 `git status --short` 必须为空，PowerShell major >= 7。
2. 用 `apply_patch` CreateNew `control-head.txt` 与 `control-review.md`；后者记录 `ReviewedCommit`、ReviewA/B C0/I0/Ready、规范化 UTF-8/LF review package Base64 与 SHA-256，后续可解码重算。
3. 旧 closure baseline 的五脚本展开值必须与当前 `package.json` 逐字相等：

```powershell
$old=Get-Content -Raw '.superpowers/sdd/2026-08-21-desktop-development-gate-closure/baseline.md';$package=Get-Content -Raw package.json|ConvertFrom-Json
$scripts=[ordered]@{'verify:desktop'='pnpm typecheck && pnpm test:unit && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop';'verify:characters'='pnpm --filter @myself/character-runtime test && pnpm --filter @myself/character-assets test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop';'verify:behavior'='pnpm --filter @myself/character-runtime test && pnpm --filter @myself/agent-core test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop';'test:security'='vitest run --config tests/vitest.config.ts tests/security';'test:integration'='vitest run --config tests/vitest.config.ts tests/integration'}
foreach($name in $scripts.Keys){if([string]$package.scripts.$name-cne[string]$scripts[$name]){throw "脚本变化：$name"};$row='| `'+$name+'` | `'+$scripts[$name]+'` |';if(([regex]::Matches($old,'(?m)^'+[regex]::Escape($row)+'\r?$')).Count-ne1){throw "旧baseline不唯一：$name"}}
```

4. `baseline.md` 原子记录 control/candidate、五脚本、15/15 但非修复、`+662`、普通 status、候选以来 docs 外零差异和保护路径历史/工作树/cached/untracked 四类零差异。新鲜审查者 C0/I0 后才进入 fixture。

## 4. Task R：共享正式路径 fixture

fixture 使用正式 supervisor 和正式 validator，不复制另一套实现：

1. **raw green 无 ACK：** fixture root 构造合法 `outer-start/start/worker-result/final` 绿色 raw，故意不创建 `outer-ack`；执行第 6 节正式 validator，必须写 `fixture-no-ack-rejected.json` 后非零退出，不能生成 PASS summary。
2. **真实 exit 7：** 设置 `DESKTOP_NONREPRO_WORKER_FIXTURE_EXIT=7` 和独立 fixture root，逐字执行第 5 节 supervisor。worker 必须真实退出 7；supervisor 观察 7，final/ACK 三方记录 7、`accepted=false`，supervisor native return 7。
3. **final temp + 活进程：** 启动 fixture Node，按真实 PID/StartTime 写 outer-start/start，并放置完整绿色 `final.json.tmp-*`；执行同一 supervisor 恢复入口。它必须先双验并有界终止进程树，再生成非正常 final 和 `accepted=false` ACK；若树仍存活，validator 必须拒绝。
4. **dirty / extra commit：** 用 `apply_patch` 创建唯一 root untracked，正式 static guard 必须拒绝，随后用 `apply_patch` 删除。系统临时 Git repo 真实增加 docs-only commit，HEAD/control guard 必须拒绝。

`fixture-report.json` 只从正式产物机械汇总 `noAckRejected`、`exit7Observed`、`liveTreeClosed`、`liveTreeNotMasked`、`dirtyUntrackedRejected`、`extraHeadRejected`。全部 true 且独立 C0/I0 后才允许正式门。

## 5. Task 1：每门一次的 supervisor/worker

五次调用只改首行 `$gateIndex=1..5`。以下唯一正式 block 内嵌 worker encoded command，不创建 runner 文件。

```powershell
$gateIndex=1
$absolute=[Diagnostics.Stopwatch]::StartNew();Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
$root=if([string]::IsNullOrWhiteSpace($env:DESKTOP_NONREPRO_EVIDENCE_ROOT)){'.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance'}else{$env:DESKTOP_NONREPRO_EVIDENCE_ROOT}
$control=(Get-Content "$root/control-head.txt" -Raw).Trim();$gateName=@('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')[$gateIndex-1];$prefix="$root/gate-$gateIndex"
function Write-Atomic([string]$path,[System.Collections.IDictionary]$value){if(Test-Path $path){throw "已存在：$path"};$tmp="$path.tmp-$([guid]::NewGuid().ToString('N'))";$b=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 8 -Compress));$s=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$s.Write($b,0,$b.Length);$s.Flush($true)}finally{$s.Dispose()};[IO.File]::Move($tmp,$path)}
function Stamp($value){if($value-is[DateTime]){return ([DateTime]$value).ToUniversalTime().ToString('O')};if($value-is[DateTimeOffset]){return ([DateTimeOffset]$value).ToUniversalTime().ToString('O')};return [string]$value}
function Same([int]$id,[string]$at){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($null -eq $p){return $false};try{return $p.StartTime.ToUniversalTime().ToString('O') -ceq $at}catch{throw '无法核验进程身份'}}
function StopTree([int]$id,[string]$at){if(-not(Same $id $at)){return @{alive=$false;killExit=$null}};$k=Start-Process taskkill.exe -ArgumentList @('/PID',"$id",'/T','/F') -WindowStyle Hidden -PassThru;if(-not$k.WaitForExit(10000)){try{$k.Kill($true);$k.WaitForExit(5000)|Out-Null}catch{}};$w=[Diagnostics.Stopwatch]::StartNew();while((Same $id $at)-and$w.ElapsedMilliseconds-lt5000){Start-Sleep -Milliseconds 100};return @{alive=(Same $id $at);killExit=if($k.HasExited){$k.ExitCode}else{$null}}}
function Git([string[]]$a){$q=[Diagnostics.ProcessStartInfo]::new('git.exe');$q.UseShellExecute=$false;$q.CreateNoWindow=$true;$q.RedirectStandardOutput=$true;$q.RedirectStandardError=$true;foreach($x in $a){$q.ArgumentList.Add($x)};$p=[Diagnostics.Process]::new();$p.StartInfo=$q;if(-not $p.Start()){throw 'git启动失败'};$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(2500)){try{$p.Kill($true);$p.WaitForExit(500)|Out-Null}catch{};throw 'git超时'};$t=$o.GetAwaiter().GetResult();$e.GetAwaiter().GetResult()|Out-Null;if($p.ExitCode -ne 0){throw 'git失败'};return @($t -split '\r?\n'|Where-Object{$_ -ne ''})}
function Guard{$h=@(Git @('rev-parse','HEAD'));if($h.Count-ne1-or$h[0].Trim()-cne$control){throw 'HEAD/control'};if(@(Git @('status','--short')).Count-ne0){throw 'status'};$pr=@('apps/website','apps/cloudbase-api','apps/package-scanner','cloudbase','tests/e2e/website.spec.ts','tests/playwright.website.config.ts');if(@(Git (@('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--')+$pr)).Count-ne0){throw '保护历史'};if(@(Git (@('diff','--name-only','--')+$pr)).Count-ne0){throw '保护工作树'};if(@(Git (@('diff','--cached','--name-only','--')+$pr)).Count-ne0){throw '保护cached'};if(@(Git (@('ls-files','--others','--exclude-standard','--')+$pr)).Count-ne0){throw '保护untracked'};$docs=@(Git @('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--','docs'));$ex=@('docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md','docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md');if(@(Compare-Object $ex $docs).Count-ne0){throw 'docs范围'};if(@(Git @('diff','--name-only','55bd05898dca055cc4ed239e82072e30f1848de3..HEAD','--','.',':(exclude)docs/**')).Count-ne0){throw '非docs'}}
function Candidate([string]$path){if(Test-Path $path){return Get-Content $path -Raw|ConvertFrom-Json};$tmp=@(Get-ChildItem -LiteralPath (Split-Path $path) -Filter "$(Split-Path $path -Leaf).tmp-*" -File);if($tmp.Count-eq1){try{return Get-Content $tmp[0].FullName -Raw|ConvertFrom-Json}catch{return $null}};return $null}
function CloseTrees{$closed=$true;foreach($path in @("$prefix.start.json","$prefix.outer-start.json","$prefix.final.json")){$r=Candidate $path;if($null -ne $r -and [int]$r.pid -gt 0 -and [string]$r.processStartedAt -ne ''){$st=StopTree ([int]$r.pid) (Stamp $r.processStartedAt);if($st.alive){$closed=$false}}};return $closed}
function Closed([string]$reason){$closed=CloseTrees;$fp="$prefix.final.json";$ap="$prefix.outer-ack.json";$temps=@(Get-ChildItem -LiteralPath $root -Filter "gate-$gateIndex.final.json.tmp-*" -File);if(-not(Test-Path $fp)){Write-Atomic $fp ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$gateIndex;gateName=$gateName;session='RECOVERY';pid=$null;processStartedAt=$null;startedAt=[DateTimeOffset]::UtcNow.ToString('O');finishedAt=[DateTimeOffset]::UtcNow.ToString('O');durationMs=0;workerResultSha256=$null;observedWorkerExit=125;exitCode=125;killExitCode=$null;termination=if($closed){'EVIDENCE_FAILURE'}else{'TERMINATION_FAILURE'};status='CLOSED'})};foreach($t in $temps){[IO.File]::Delete($t.FullName)};if(-not(Test-Path $ap)){$fh=(Get-FileHash -Algorithm SHA256 $fp).Hash.ToLowerInvariant();Write-Atomic $ap ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$gateIndex;gateName=$gateName;workerResultSha256=$null;finalSha256=$fh;observedWorkerExit=125;accepted=$false;reason=$reason})};Get-ChildItem -LiteralPath $root -Filter "gate-$gateIndex.outer-ack.json.tmp-*" -File|ForEach-Object{[IO.File]::Delete($_.FullName)};exit 125}
Guard
if(@(Get-ChildItem -LiteralPath $root -Filter "gate-$gateIndex.*.json*" -File).Count-gt0){if(Test-Path "$prefix.outer-ack.json"){throw 'ACK已存在'};Closed 'INTERRUPTED_OR_TEMP'}
$worker=@'
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$root=$env:DESKTOP_NONREPRO_EVIDENCE_ROOT;$control=$env:DESKTOP_NONREPRO_CONTROL;$index=[int]$env:DESKTOP_NONREPRO_GATE_INDEX;$name=$env:DESKTOP_NONREPRO_GATE_NAME;$prefix="$root/gate-$index"
function A([string]$path,[System.Collections.IDictionary]$v){$t="$path.tmp-$([guid]::NewGuid().ToString('N'))";$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 6 -Compress));$s=[IO.File]::Open($t,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$s.Write($b,0,$b.Length);$s.Flush($true)}finally{$s.Dispose()};[IO.File]::Move($t,$path)}
function S([int]$id,[string]$at){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($null-eq$p){return $false};try{return $p.StartTime.ToUniversalTime().ToString('O')-ceq$at}catch{return $false}}
function K([int]$id,[string]$at){if(-not(S $id $at)){return @{alive=$false;killExit=$null}};$k=Start-Process taskkill.exe -ArgumentList @('/PID',"$id",'/T','/F') -WindowStyle Hidden -PassThru;if(-not$k.WaitForExit(10000)){try{$k.Kill($true);$k.WaitForExit(5000)|Out-Null}catch{}};$w=[Diagnostics.Stopwatch]::StartNew();while((S $id $at)-and$w.ElapsedMilliseconds-lt5000){Start-Sleep -Milliseconds 100};return @{alive=(S $id $at);killExit=if($k.HasExited){$k.ExitCode}else{$null}}}
$session=[guid]::NewGuid().ToString('N');$beg=[DateTimeOffset]::UtcNow;$w=[Diagnostics.Stopwatch]::StartNew();$p=$null;$at=$null;$x=70;$term='SPAWN_FAILURE';$kill=$null
try{if([string]::IsNullOrWhiteSpace($env:DESKTOP_NONREPRO_WORKER_FIXTURE_EXIT)){$p=Start-Process pnpm.cmd -ArgumentList @($name) -WindowStyle Hidden -PassThru}else{$p=Start-Process pwsh -ArgumentList @('-NoProfile','-Command',"exit $($env:DESKTOP_NONREPRO_WORKER_FIXTURE_EXIT)") -WindowStyle Hidden -PassThru};$at=$p.StartTime.ToUniversalTime().ToString('O');A "$prefix.start.json" ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$index;gateName=$name;session=$session;startedAt=$beg.ToString('O');pid=$p.Id;processStartedAt=$at});if($p.WaitForExit(760000)){$p.Refresh();$x=[int]$p.ExitCode;$term='NONE'}else{$st=K $p.Id $at;$kill=$st.killExit;if($st.alive){$x=125;$term='TERMINATION_FAILURE'}else{$x=124;$term='TIMEOUT'}}}catch{if($null-ne$p-and$null-ne$at){$st=K $p.Id $at;$kill=$st.killExit};$x=125;$term='EVIDENCE_FAILURE'}finally{$w.Stop();$fin=[DateTimeOffset]::UtcNow;A "$prefix.worker-result.json" ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$index;gateName=$name;session=$session;startedAt=$beg.ToString('O');pid=if($null-eq$p){$null}else{$p.Id};processStartedAt=$at;finishedAt=$fin.ToString('O');durationMs=[long]$w.ElapsedMilliseconds;exitCode=$x;killExitCode=$kill;termination=$term})};exit $x
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($worker));$old=@($env:DESKTOP_NONREPRO_EVIDENCE_ROOT,$env:DESKTOP_NONREPRO_CONTROL,$env:DESKTOP_NONREPRO_GATE_INDEX,$env:DESKTOP_NONREPRO_GATE_NAME);$env:DESKTOP_NONREPRO_EVIDENCE_ROOT=$root;$env:DESKTOP_NONREPRO_CONTROL=$control;$env:DESKTOP_NONREPRO_GATE_INDEX="$gateIndex";$env:DESKTOP_NONREPRO_GATE_NAME=$gateName
$wp=Start-Process pwsh -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;$wat=$wp.StartTime.ToUniversalTime().ToString('O');try{Write-Atomic "$prefix.outer-start.json" ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$gateIndex;gateName=$gateName;session=[guid]::NewGuid().ToString('N');startedAt=[DateTimeOffset]::UtcNow.ToString('O');pid=$wp.Id;processStartedAt=$wat})}catch{$null=StopTree $wp.Id $wat;throw};$env:DESKTOP_NONREPRO_EVIDENCE_ROOT=$old[0];$env:DESKTOP_NONREPRO_CONTROL=$old[1];$env:DESKTOP_NONREPRO_GATE_INDEX=$old[2];$env:DESKTOP_NONREPRO_GATE_NAME=$old[3]
$closed=$wp.WaitForExit(800000);if(-not$closed){$st=StopTree $wp.Id $wat;$observed=if($st.alive){125}else{124}}else{$wp.Refresh();$observed=[int]$wp.ExitCode};$wp.Dispose()
$rp="$prefix.worker-result.json";if(-not(Test-Path $rp)){Closed 'MISSING_WORKER_RESULT'};$raw=Get-Content $rp -Raw|ConvertFrom-Json;$rh=(Get-FileHash -Algorithm SHA256 $rp).Hash.ToLowerInvariant();$identity=$raw.schemaVersion-eq2-and$raw.controlHead-ceq$control-and$raw.gateIndex-eq$gateIndex-and$raw.gateName-ceq$gateName;$exitOk=[int]$raw.exitCode-eq$observed;$static=$true;try{Guard}catch{$static=$false};$deadline=$absolute.ElapsedMilliseconds-lt870000;$pass=$closed-and$identity-and$exitOk-and$static-and$deadline-and$raw.termination-ceq'NONE'-and$observed-eq0-and[long]$raw.durationMs-lt900000;$term=if($pass){'NONE'}elseif(-not$closed){'TIMEOUT'}elseif(-not$static){'STATIC_DIFFERENCE'}elseif(-not$deadline){'EVIDENCE_FAILURE'}else{'GATE_FAILURE'};$returnExit=if($deadline){$observed}else{125}
$f=[ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$gateIndex;gateName=$gateName;session=$raw.session;pid=$raw.pid;processStartedAt=$raw.processStartedAt;startedAt=$raw.startedAt;finishedAt=$raw.finishedAt;durationMs=$raw.durationMs;workerResultSha256=$rh;observedWorkerExit=$observed;exitCode=$observed;killExitCode=$raw.killExitCode;termination=$term;status=if($pass){'PASS'}else{'CLOSED'}};Write-Atomic "$prefix.final.json" $f;$fh=(Get-FileHash -Algorithm SHA256 "$prefix.final.json").Hash.ToLowerInvariant();Write-Atomic "$prefix.outer-ack.json" ([ordered]@{schemaVersion=2;controlHead=$control;gateIndex=$gateIndex;gateName=$gateName;workerResultSha256=$rh;finalSha256=$fh;observedWorkerExit=$observed;accepted=$pass;reason=if($pass){'OBSERVED_GREEN'}else{$term}});exit $returnExit
```

只有前一门五份记录以 `DESKTOP_NONREPRO_VALIDATE_ONLY=1` 经第 6 节 validator 验证、ACK `accepted=true` 且 supervisor native return 0，才启动下一门。validate-only 不创建 manifest/summary。任一 existing artifact 都进入恢复/关闭路径，绝不再次 spawn worker。

## 6. Task 2：共享 validator、manifest 与 review

以下 block 同时供 fixture 和正式汇总。缺 ACK、ACK=false、hash/exit 不一致、首失败后有后续、非正常 final 的同身份进程仍存活，全部拒绝。

```powershell
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$root=if([string]::IsNullOrWhiteSpace($env:DESKTOP_NONREPRO_EVIDENCE_ROOT)){'.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance'}else{$env:DESKTOP_NONREPRO_EVIDENCE_ROOT};$control=(Get-Content "$root/control-head.txt" -Raw).Trim();$names=@('verify:desktop','verify:characters','verify:behavior','test:security','test:integration')
function A([string]$p,[System.Collections.IDictionary]$v){if(Test-Path $p){throw "已存在：$p"};$t="$p.tmp-$([guid]::NewGuid().ToString('N'))";$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 10 -Compress));$s=[IO.File]::Open($t,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$s.Write($b,0,$b.Length);$s.Flush($true)}finally{$s.Dispose()};[IO.File]::Move($t,$p)}
function Stamp($value){if($value-is[DateTime]){return ([DateTime]$value).ToUniversalTime().ToString('O')};if($value-is[DateTimeOffset]){return ([DateTimeOffset]$value).ToUniversalTime().ToString('O')};return [string]$value}
function S([int]$id,[string]$at){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($null -eq $p){return $false};try{return $p.StartTime.ToUniversalTime().ToString('O') -ceq $at}catch{throw '无法核验进程身份'}}
function T($r){$s=[DateTimeOffset]::ParseExact((Stamp $r.startedAt),'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$f=[DateTimeOffset]::ParseExact((Stamp $r.finishedAt),'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$w=[long]($f-$s).TotalMilliseconds;$d=[long]$r.durationMs;return ($w-ge0-and$d-ge0-and$d-lt900000-and[Math]::Abs($w-$d)-le5000)}
$records=[Collections.Generic.List[object]]::new();$gates=[Collections.Generic.List[object]]::new();$failed=$false;$gap=$false
for($i=1;$i -le 5;$i++){
  $p="$root/gate-$i"
  $paths=@("$p.outer-start.json","$p.start.json","$p.worker-result.json","$p.final.json","$p.outer-ack.json")
  $present=@($paths|Where-Object{Test-Path $_})
  if($present.Count -eq 0){$gap=$true;continue}
  if($gap -or $failed){throw '首失败/缺口后有后续'}
  if($present.Count -ne 5){
    if($env:DESKTOP_NONREPRO_VALIDATOR_FIXTURE -eq 'NO_ACK' -and -not(Test-Path "$root/fixture-no-ack-rejected.json")){A "$root/fixture-no-ack-rejected.json" ([ordered]@{rejected=$true;reason='MISSING_ACK'})}
    throw "第${i}门证据不完整"
  }
  $outer=Get-Content $paths[0] -Raw|ConvertFrom-Json;$start=Get-Content $paths[1] -Raw|ConvertFrom-Json;$worker=Get-Content $paths[2] -Raw|ConvertFrom-Json;$final=Get-Content $paths[3] -Raw|ConvertFrom-Json;$ack=Get-Content $paths[4] -Raw|ConvertFrom-Json
  foreach($r in @($outer,$start,$worker,$final,$ack)){if($r.schemaVersion -ne 2 -or $r.controlHead -cne $control -or $r.gateIndex -ne $i -or $r.gateName -cne $names[$i-1]){throw "第${i}门身份"}}
  if(-not(T $worker) -or -not(T $final)){throw "第${i}门时间"}
  $wh=(Get-FileHash -Algorithm SHA256 $paths[2]).Hash.ToLowerInvariant();$fh=(Get-FileHash -Algorithm SHA256 $paths[3]).Hash.ToLowerInvariant()
  if($ack.workerResultSha256 -cne $wh -or $final.workerResultSha256 -cne $wh -or $ack.finalSha256 -cne $fh){throw "第${i}门hash"}
  if([int]$worker.exitCode -ne [int]$final.observedWorkerExit -or [int]$ack.observedWorkerExit -ne [int]$final.observedWorkerExit -or [int]$final.exitCode -ne [int]$final.observedWorkerExit){throw "第${i}门exit"}
  $green=$worker.termination -ceq 'NONE' -and [int]$worker.exitCode -eq 0 -and $final.status -ceq 'PASS' -and $final.termination -ceq 'NONE' -and $ack.accepted -eq $true
  if($null -ne $start.pid -and (S ([int]$start.pid) (Stamp $start.processStartedAt))){throw "第${i}门pnpm仍活"};if($null -ne $outer.pid -and (S ([int]$outer.pid) (Stamp $outer.processStartedAt))){throw "第${i}门worker仍活"};if(-not $green){$failed=$true}
  foreach($path in $paths){$records.Add([ordered]@{path=$path.Replace('\\','/');sha256=(Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()})}
  $gates.Add([ordered]@{gateIndex=$i;gateName=$names[$i-1];durationMs=[long]$final.durationMs;observedWorkerExit=[int]$final.observedWorkerExit;termination=$final.termination;accepted=[bool]$ack.accepted})
}
if($gates.Count-eq0){throw '无门证据'};if($env:DESKTOP_NONREPRO_VALIDATE_ONLY-eq'1'){if($failed){exit 125}else{exit 0}};$pass=$gates.Count-eq5-and-not$failed;A "$root/raw-record-manifest.json" ([ordered]@{schemaVersion=2;controlHead=$control;records=@($records|Sort-Object path)});$mh=(Get-FileHash -Algorithm SHA256 "$root/raw-record-manifest.json").Hash.ToLowerInvariant();A "$root/gate-summary.json" ([ordered]@{schemaVersion=2;controlHead=$control;rawManifestSha256=$mh;executedCount=$gates.Count;gates=@($gates);finalStatus=if($pass){'PASS'}else{'CLOSED'};conclusion=if($pass){'稳定性准入通过，已知偶发超时根因未定位'}else{'CLOSED'}})
```

独立审查者重新枚举五类 raw、重算每个 hash、manifest/summary/fixture hash，并重跑 HEAD/status/保护/两文档 allowlist。完整 PASS 必须五门各五份 raw，共 25 条 manifest record；其他组合为 `CLOSED`。`review.md` 只写 control、hash、Critical、Important、FinalStatus 和结论。

## 7. Task 3：仅 PASS 后的唯一纯文档后继

只有 summary/review 唯一 PASS、hash 重算一致、HEAD=control、普通 status 为空，才可修改本规格、旧开发门规格、旧减法规格、角色验收和上位架构规格五文档。cached 精确五路径、unstaged/untracked/docs 外均为空且独立 C0/I0 后提交。提交前 HEAD=control；提交后 `HEAD^=control` 且 `git rev-list --count control..HEAD=1`。相对候选最终路径精确为本计划、本规格和四份既有文档，共六个唯一路径。`docs-successor-report.md` 记录实际后继 hash 与拓扑。

## 8. 本轮文档提交门

```powershell
$expected=@('docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md','docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md');$actual=@(git diff --name-only);if(@(Compare-Object $expected $actual).Count-ne0){throw '范围不止两文档'};if(@(git diff --cached --name-only).Count-ne0){throw '暂存区非空'};if(@(git ls-files --others --exclude-standard).Count-ne0){throw 'untracked'};git diff --check;if($LASTEXITCODE-ne0){throw 'diff-check'}
```

解析全部 PowerShell fenced block，parser error 必须为 0；扫描占位、错误成功表述、关闭 untracked 的选项和无清理预算的等待值。独立内部审查 C0/I0 后只提交这两文档，不执行正式门。

## 9. 最终裁决

- PASS：control、fixtures、五门 supervisor ACK、25 条 raw/hash、独立 review、唯一后继和六路径全部成立，只发布“稳定性准入通过，已知偶发超时根因未定位”。
- 其他任何组合：`CLOSED`；不重跑、不补门、不改代码，另立独立规格。
