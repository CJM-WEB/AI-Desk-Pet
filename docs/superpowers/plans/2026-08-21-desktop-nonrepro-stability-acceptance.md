# AI Pet 桌宠非复现稳定性准入实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 逐任务执行。正式门由主控直接运行；独立审查者只读复核，不能代跑或补跑。

**目标：** 不改可执行内容，在可执行基线 `55bd05898dca055cc4ed239e82072e30f1848de3` 对应的冻结文档 HEAD 上，把五条正式门各执行一次，并据此决定是否恢复常规新功能开发。

**架构：** 不创建自制 runner、worker、supervisor、validator、fixture、hash、ACK 或进程恢复层。Codex 执行工具返回的真实 `exit_code` 和 `wall_time_seconds` 是唯一原始证据；ignored 报告只在门阶段结束后用 `apply_patch` 镜像这些事实。

**技术栈：** pnpm 11、Git、Codex `exec_command` / `write_stdin`、Markdown。

## 全局约束

- 适用规格：`docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`。
- 可执行基线固定为 `55bd05898dca055cc4ed239e82072e30f1848de3`；`GATE_HEAD` 在本轮两文档提交并复审后从真实 `git rev-parse HEAD` 冻结。
- 15/15 三 seam GREEN 不是根因修复。成功只能写“稳定性准入通过，已知偶发超时根因未定位”。
- owner inventory 保留 `+1956/-1294`、净增 `662`，本轮不继续硬删。
- 五门每条只启动一次；不 retry、不补跑、不提高 timeout、不 skip、不降低 worker、不修改代码、测试、配置、依赖或脚本。
- 单条命令最多 15 分钟。持续 session 每次轮询间隔不超过 60 秒；使用工具等待时间与最大间隔计算保守耗时上界，达到上限立即 `Ctrl-C`，无法取得最终退出码也按 `CLOSED`。
- 从第一门开始到第五门结束或首失败结束，主控不得主动修改文件，tracked/non-ignored 内容不得变化；正式脚本自身产生的 ignored 构建与测试输出允许存在，但不能作为通过证据。
- 不修改或运行网站、CloudBase、包扫描器和网站 E2E。
- 任何失败都没有成功文档后继，也不得通过重跑修补证据。

## Task 0：提交并冻结门禁 HEAD

**文件：**

- 修改：`docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`
- 修改：`docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md`

- [ ] **Step 1：复核本轮只有两份文档变化**

  运行 `$expected=@('docs/superpowers/plans/2026-08-21-desktop-nonrepro-stability-acceptance.md','docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md')|Sort-Object;$actual=@(git diff --name-only)|Sort-Object;if($LASTEXITCODE-ne0-or@(Compare-Object $expected $actual).Count-ne0){throw '文档范围'}`。随后确认 `git diff --cached --name-only` 和 `git ls-files --others --exclude-standard` 无输出。路径按无序集合比较，不依赖 Git 输出顺序。

- [ ] **Step 2：检查文档质量**

  运行 `git diff --check`；扫描未完成占位词、退役机制的实施步骤和错误成功表述。worker、supervisor、validator、fixture、hash、ACK、PID 等词只允许出现在“明确退役/禁止”的说明中。

- [ ] **Step 3：独立复审并提交**

  两份独立审查都必须为 C0/I0 Ready。只提交这两份文档；不执行正式门。提交后普通 `git status --short` 必须为空。

- [ ] **Step 4：冻结 `GATE_HEAD`**

  运行 `git rev-parse HEAD`，把工具返回的完整 hash 作为本任务内唯一 `GATE_HEAD`。不创建 control 文件、不计算 review package hash。

## Task 1：完成统一只读预检

**读取：**

- `package.json`
- 当前 Git HEAD、状态和相对基线差异

- [ ] **Step 1：确认五个脚本仍存在**

  只读解析根 `package.json`，确认 `verify:desktop`、`verify:characters`、`verify:behavior`、`test:security`、`test:integration` 均存在。不改脚本、不缓存另一份展开值。

- [ ] **Step 2：执行统一守卫**

  依次运行以下只读检查：

  - `git branch --show-current`：必须精确等于 `AgentCoreExtension`；
  - `git rev-parse HEAD`：完整输出必须等于 `GATE_HEAD`；
  - `git status --short`：必须无输出；
  - `git diff --name-only 55bd05898dca055cc4ed239e82072e30f1848de3..HEAD -- . ':(exclude)docs/**'`：必须无输出；
  - `git diff --name-only 55bd05898dca055cc4ed239e82072e30f1848de3..HEAD -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts`：必须无输出。

  任一检查失败即 `CLOSED`，不启动正式门。

## Task 2：前台串行执行五条正式门

**唯一原始证据：** 本 Codex 任务中 `exec_command` / 持续 session 的工具返回。

固定门序：

1. `pnpm.cmd verify:desktop`
2. `pnpm.cmd verify:characters`
3. `pnpm.cmd verify:behavior`
4. `pnpm.cmd test:security`
5. `pnpm.cmd test:integration`

对每一门严格执行同一流程：

- [ ] **Step 1：门前守卫**

  重新执行 Task 1 Step 2 的五项只读检查。全部成立才继续。

- [ ] **Step 2：启动当前门一次**

  用独立 `exec_command` 前台启动当前 `pnpm.cmd` 命令，工作目录为仓库根，设置 `tty:true`，`yield_time_ms` 固定为 30000。不得把五门封装进脚本或一条 shell 命令。

- [ ] **Step 3：有界观察**

  若返回持续 session，使用 `write_stdin` 轮询，任意两次工具调用之间不超过 60 秒。令保守上界为“初始调用和全部 `write_stdin` 返回的 `wall_time_seconds` 之和，加 `write_stdin` 调用次数乘 60 秒”。每次新等待前再为下一次最多 60 秒的调用间隔预留预算，`yield_time_ms` 取 60000 与“900 秒减当前保守上界再减 60 秒”中的较小正值；没有正值时立即发送 `Ctrl-C`。仍无法取得最终返回时使用执行 session 的终止能力；能力不可用也按 `CLOSED`。

- [ ] **Step 4：读取真实结果**

  只读取工具返回的最终 `exit_code` 和每次 `wall_time_seconds`，按 Step 3 计算保守上界。缺少最终退出码、非零、保守上界达到或超过 900 秒、session 丢失、执行中断或结果含义不明确，都立即 `CLOSED`，停止后续门且不重跑。

- [ ] **Step 5：门后守卫**

  当前 session 已取得最终返回时，无论退出码是否为零，都再次执行 Task 1 Step 2 的五项只读检查；任一不成立同样记为 `CLOSED`。只有全部守卫成立、当前门 `exit_code=0` 且保守耗时上界小于 900 秒，才进入下一门。若 session 丢失或终止后仍无法证明命令已经结束，门后守卫记为“不可取得”，直接 `CLOSED`，不得在可能仍写文件的进程旁启动后续命令。

五门全部满足时进入 Task 3 的完整复审路径；任一门 `CLOSED` 时也进入 Task 3，但只执行失败报告并结束，不执行 PASS 复审或 Task 4。

## Task 3：镜像报告与独立裁决

**文件：**

- 创建：`.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance-gate-report.md`（ignored，不提交；父目录已存在）

- [ ] **Step 1：用 `apply_patch` 创建最小报告**

  报告只逐项抄录 `GATE_HEAD`、可执行基线、实际启动门的序号/命令/每次工具 `wall_time_seconds`/保守耗时上界/最终 `exit_code`、门前后守卫、首失败或五门全零、`+662` 和“根因未定位”。不写 stdout/stderr 正文，不自行推断退出码。失败路径创建报告后立即结束。

- [ ] **Step 2：新鲜独立复审**

  审查者必须直接读取本 Codex 任务的完整工具调用记录、ignored 报告和当前 HEAD，核对顺序、单次性、每次轮询间隔、五个最终退出码/耗时、每门前后守卫以及报告一致性。审查者无法读取完整工具记录，或存在任何 Critical/Important，均裁决 `CLOSED`，不能重跑正式门。

- [ ] **Step 3：形成唯一裁决**

  五门均 `exit_code=0`、每门保守耗时上界均小于 900 秒、全部守卫通过且独立复审 C0/I0 Ready 时，裁决 `PASS`，结论逐字为“稳定性准入通过，已知偶发超时根因未定位”。其他任何组合都是 `CLOSED`。

## Task 4：仅 PASS 后同步正式状态

**文件：**

- 修改：`docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md`
- 修改：`docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`

- [ ] **Step 1：同步同一组事实**

  五份文档只记录 `GATE_HEAD`、五门真实 `exit_code`/耗时、`+662`、人工待验和固定成功限语。不得写“已修复”“根因已解决”或推测性结论。

- [ ] **Step 2：复核唯一纯文档差异**

  运行 `$expected=@('docs/operations/character-workshop-acceptance.md','docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md','docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md','docs/superpowers/specs/2026-08-21-desktop-development-gate-closure-design.md','docs/superpowers/specs/2026-08-21-desktop-nonrepro-stability-acceptance-design.md')|Sort-Object;$actual=@(git diff --name-only)|Sort-Object;if($LASTEXITCODE-ne0-or@(Compare-Object $expected $actual).Count-ne0){throw '后继范围'}`。随后确认 `git status --short` 不出现其他路径，相对 `GATE_HEAD` 的 `docs/` 外差异为零，且 `git diff --check` 退出 0。路径按无序集合比较。

- [ ] **Step 3：独立文档复审并提交一次**

  独立审查 C0/I0 Ready 后，只创建一个纯文档后继提交。该提交的直接 parent 必须为 `GATE_HEAD`；提交后 `git branch --show-current` 仍须精确等于 `AgentCoreExtension`。随后交付窗口关闭，发布“稳定性准入通过，已知偶发超时根因未定位；桌宠可以继续常规新功能开发”。

若 Task 0–3 任一步为 `CLOSED`，不得执行 Task 4，也不得创建失败后继提交。
