# AI Pet 桌宠恢复常规开发门收口实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐任务执行并由新鲜独立审查者复审。实施缺陷修复时同时使用 `diagnosing-bugs`、`test-driven-development` 和 `verification-before-completion`。所有步骤使用复选框跟踪。

**目标：** 在不放宽测试、不牺牲唯一安全证据且不触碰网站业务的前提下，根治 Desktop 并行负载下的 5000ms 超时，完成测试 owner 审计，并在同一个最终可执行树 HEAD 上通过五条质量门后正式恢复桌宠常规新功能开发。

**架构：** 先固定事实基线，再依次使用最多三个有限 feedback seam 建立同症状 RED；诊断任务只产出可证伪根因和一份精确 fix brief，禁止提前猜测修复文件。根因修复与 owner 减法分别以最小提交落地；所有可执行变化停止后固定最终可执行树 HEAD，一次执行五条正式门，最后只允许一个纯验收文档后继提交。

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
- 所有 `[DEBUG-*]`、临时探针和 throwaway harness 必须在 Task 3 完成前删除；最终正式运行路径、日志契约和测试入口不得因诊断增加第二套 owner。
- 不修改或运行网站业务。以下受保护路径相对实施基线、工作树和暂存区必须始终零差异：`apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、`tests/e2e/website.spec.ts`、`tests/playwright.website.config.ts`。
- 不 push、不 merge、不 rebase、不 reset。Git 写操作已获授权；有实质 tracked 变更的任务必须独立提交。证据型 Task 0、Task 1、Task 2、Task 5 不制造空提交，其独立复审以报告和固定 HEAD 为对象；这避免用无内容提交污染最终可执行树或使五门 HEAD 失效。
- 每个任务由新鲜独立审查者同时检查规格符合性与代码/证据质量；Critical/Important 必须清零才能进入下一任务。审查超过 15 分钟未收敛时停止该审查方式，换新审查者或收窄审查包。
- 若调查发现需要大量删除文件，必须先列出精确目标、替代 owner、恢复方式和 `numstat`，再取得用户二次明确批准；现有授权不替代仓库对大量文件删除的二次确认。

## 文件与产物职责

| 文件或目录 | 职责 | 生命周期 |
| --- | --- | --- |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/baseline.md` | 固定实施基线、脚本、配置、失败事实、受保护路径和总账 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/implementation-baseline.txt` | 仅一行实施基线完整 hash，供后续命令机械读取 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md` | 三个有限 feedback seam 的轮次、退出码、耗时和同症状统计 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-ledger.md` | 3–5 个假设、预测、单变量 probe、支持/排除结论和 60 分钟终局 | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md` | 由诊断证据生成的唯一修复任务简报，固定具体修复与测试文件 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-files.txt` | 每行一个经复审的 Task 3 tracked 路径 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-subtraction-files.txt` | 每行一个通过删除门且实际修改的 Task 4 路径；无安全减法时为空 | ignored 执行输入，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/final-executable-head.txt` | 仅一行 Task 5 最终可执行树完整 hash | ignored 执行证据，不提交 |
| `.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-report.md` | 最终可执行树 HEAD、五门结果、路径保护、最终文档提交 hash 与差异证明 | ignored 执行证据，不提交 |
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

- [ ] **Step 4：写入 baseline 报告并独立复审**

  先固定机器可读 hash：

  ```powershell
  git rev-parse HEAD | Set-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/implementation-baseline.txt
  ```

  `baseline.md` 必须逐字记录实施基线 hash、当前时间、分支、五个脚本展开值、Vitest worker 值、目标用例文件与标题、20 文件清单、逐文件 `numstat`、总账和保护路径结果。独立审查者复算总账并确认报告没有敏感绝对路径。

  完成门：事实、算术和脚本一致；Critical/Important 为零。该任务没有 tracked 变更，不创建空提交；报告记录进入 Task 1 时的同一 HEAD。

---

### Task 1：建立最多三个有限 feedback seam 并取得同症状 RED

**文件：**
- 读取：`apps/desktop/tests/official-default-character.test.ts`
- 读取：`apps/desktop/tests/character-store.test.ts`
- 读取：`apps/desktop/tests/character-package-service.test.ts`
- 读取：`apps/desktop/tests/character-transaction-recovery.test.ts`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/feedback-results.md`

**接口：**
- 同症状只指目标测试在真实 `CharacterStore`/官方默认角色恢复链中达到 5000ms 或同一被阻塞边界；其他断言失败、缺模块、人工 sleep 或人为缩短 timeout 均不算 RED。
- 每个 seam 固定 `maxWorkers=4`、输入、测试清单与五轮；报告记录每轮退出码、目标状态、墙钟耗时、最高耗时和同症状次数。
- 第一个达到至少 `2/5` 同症状 RED 的 seam 成为 `PRIMARY_FEEDBACK_SEAM`。一旦建立高复现 seam，停止更宽 seam，避免无价值压力；未执行的后续 seam 明确写“因前序已达 2/5 未执行”。

- [ ] **Step 1：启动 60 分钟总预算并运行 seam 1——目标用例压力循环**

  在 ignored 报告记录开始时间，然后执行五轮固定目标用例：

  ```powershell
  1..5 | ForEach-Object {
    $round = $_
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/official-default-character.test.ts --maxWorkers=4 -t "损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据"
    $code = $LASTEXITCODE
    $timer.Stop()
    "seam=1 round=$round exit=$code elapsedMs=$($timer.ElapsedMilliseconds)"
  }
  ```

  不修改测试或生产实现。若 `2/5` 同症状 RED，固定为主 feedback seam 并跳到 Step 4；若只有 `1/5`，记录“有红能力但未达高复现”，继续 seam 2。

- [ ] **Step 2：必要时运行 seam 2——同文件真实文件系统恢复压力**

  ```powershell
  1..5 | ForEach-Object {
    $round = $_
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/official-default-character.test.ts --maxWorkers=4
    $code = $LASTEXITCODE
    $timer.Stop()
    "seam=2 round=$round exit=$code elapsedMs=$($timer.ElapsedMilliseconds)"
  }
  ```

  这条 seam 只增加同文件的真实默认角色安装、消失目录、链接隔离和恢复记录写失败场景，不加入无关 CPU/网络噪声。达到 `2/5` 后停止；否则继续 seam 3。

- [ ] **Step 3：必要时运行 seam 3——Desktop unit 固定真实负载**

  ```powershell
  1..5 | ForEach-Object {
    $round = $_
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    pnpm.cmd --filter @myself/desktop test
    $code = $LASTEXITCODE
    $timer.Stop()
    "seam=3 round=$round exit=$code elapsedMs=$($timer.ElapsedMilliseconds)"
  }
  ```

  每轮必须单独判断目标用例是否为同症状失败；其他用例超时只作为相邻信号，不计入目标 RED。单轮接近 15 分钟立即终止整条 seam。

- [ ] **Step 4：裁决红能力，不得先修**

  报告固定写入：三个 seam 的执行/未执行理由、各轮统计、主 seam 命令、复现率、最高耗时和脱敏失败类别。此时禁止修改 `apps/desktop/src`、Vitest 配置、测试 timeout、retry 或测试断言。

  若三个 seam 都未捕获同症状，或没有任何 seam 达到足以区分修复前后的稳定信号，Task 1 结论为“未建立合格 RED，开发门仍关闭”；停止超时代码修改，允许转去 Task 4 owner inventory，但不得进入 Task 2 根因修复链、Task 3、Task 5 或解锁版 Task 6。

- [ ] **Step 5：独立复审 feedback 证据**

  审查者核对原始命令输出与报告统计，确认没有通过另一种失败、缩短 timeout、无关噪声或重复完整门伪造 RED。Critical/Important 清零后才进入 Task 2。该任务没有 tracked 变更，不创建空提交。

---

### Task 2：用 3–5 个可证伪假设和单变量 probe 裁决根因

**文件：**
- 读取：Task 1 主 feedback seam 涉及的测试与生产调用链
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/hypothesis-ledger.md`
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-brief.md`（仅根因成立时）

**接口：**
- `hypothesis-ledger.md` 只保留与 Task 1 证据相关的 3–5 项；每项包含预测、一个被改变变量、控制量、最多两条命令、观察值和“支持/排除/证据不足”。
- `root-cause-fix-brief.md` 只有在一个假设的预测成立、竞争假设按其预测被排除且 60 分钟预算未耗尽时生成。
- 若无法定位，终局是“开发门仍关闭”，不生成猜测性修复简报，不进入 Task 3。

- [ ] **Step 1：只读追踪目标调用链并选出 3–5 个假设**

  ```powershell
  rg -n "recoverCorruptIndex|ensureOfficialDefaultCharacter|prepareCharacterStartup|afterEach|temporaryDirectory|mkdtemp|rm\(" apps/desktop/tests/official-default-character.test.ts apps/desktop/src/main/characters
  rg -n "recoverCorruptIndex|mkdtemp|afterEach|rm\(" apps/desktop/tests/character-store.test.ts apps/desktop/tests/character-package-service.test.ts apps/desktop/tests/character-transaction-recovery.test.ts
  git diff -- apps/desktop/tests/official-default-character.test.ts apps/desktop/src/main/characters
  ```

  从下列候选中按 Task 1 证据选 3–5 项，不得自动认定任何一项为真：共享文件系统 I/O 竞争、同一事务重复磁盘工作、cleanup 与 worker 生命周期重叠、CPU/事件循环拥塞、进程级共享状态或缓存泄漏。

- [ ] **Step 2：按固定 probe 矩阵做单变量测量**

  每个已选假设最多从对应行执行两次；所有命令复用 Task 1 的固定输入和主 seam，只有“改变变量”不同：

  | 假设 | 控制量 | 唯一改变变量 | 支持预测 |
  | --- | --- | --- | --- |
  | 文件 I/O 竞争 | 目标输入、4 workers、五轮、临时盘 | 从目标文件扩展为目标 + `character-store` + `character-package-service` + `character-transaction-recovery` | 真实文件事务并发指标与目标耗时/红率同向恶化 |
  | 重复磁盘工作 | 主 seam、4 workers、相同资源 | 只增加临时阶段计数/耗时探针，不改控制流 | 同一事务内出现可删除的重复读取、复制、哈希或重建 |
  | cleanup 重叠 | 主 seam、相同输入和 worker | 只记录 setup/test/afterEach 开始结束边界 | 前一场景 cleanup 与目标事务真实重叠；等待正确 cleanup Promise 后重叠消失 |
  | CPU/事件循环拥塞 | 主 seam、相同文件负载 | 只记录事件循环长任务或已识别同步阶段耗时 | 稳定长任务与超时同现，而等价 I/O 压力变化不解释结果 |
  | 共享状态/缓存泄漏 | 文件集合、4 workers、五轮 | 只改变固定执行顺序/固定 seed | 特定前序集合稳定改变目标耗时；清除错误 owner 后顺序影响消失 |

  临时探针只能写阶段名、次数、耗时和失败类别，并带 `[DEBUG-DESKTOP-GATE]` 标识。每次 probe 后先把观察写入 ledger；不支持预测的临时代码立即用反向 `apply_patch` 删除，禁止保留防御性补丁。

- [ ] **Step 3：worker 假设只允许通过严格双门**

  只有 probe 已识别“随 worker 数变化的具体资源容量不变量”，并按各自预测排除 cleanup、共享状态、可消除重复工作及仍相关候选后，才可执行效果门：

  ```powershell
  # 同一主压力 loop：4 workers 必须至少 2/5 同症状 RED。
  # 仅改变 worker 值为 3；五轮必须 5/5 GREEN。
  # 仅改变 worker 值为 2；只有 3 未达 5/5 时才用于候选裁决。
  ```

  若 3 和 2 均为 5/5，简报只能选择 3；只有 2 达标才可选择 2；1 或串行永远不允许。仅有“更快”或“更绿”而没有资源不变量，不得修改 `maxWorkers: 4`，根因写“证据不足”，开发门保持关闭。

- [ ] **Step 4：在 60 分钟硬预算内形成唯一根因裁决**

  根因成立必须同时满足：主 seam 已 RED；至少一个假设预测得到支持；竞争假设有排除证据；拟修复行为能在公开 seam 被先 RED 后 GREEN 观察。报告同时列出未支持假设，禁止在代码中留下对应补丁。

  若计时达到 60 分钟、五个假设均证据不足或竞争解释无法排除，立即删除全部临时探针，写明每个 seam、probe、已排除项和缺失证据，裁决“开发门仍关闭”；可继续 Task 4 审计，但不进入 Task 3、Task 5 或解锁版 Task 6。

- [ ] **Step 5：生成无猜测的 root-cause-fix-brief 并独立复审**

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

  依次运行 brief 的最小回归、原始主 feedback seam和受影响 package typecheck。最小回归和原始 seam 均须 GREEN；worker 分支还须完整 Desktop unit 连续两次退出 0，并记录目标耗时、总耗时、worker 值和资源指标。

- [ ] **Step 5：删除全部临时诊断并检查禁止项**

  ```powershell
  rg -n "DEBUG-DESKTOP-GATE|testTimeout|retry|\.skip\(|\.todo\(" apps/desktop/src apps/desktop/tests apps/desktop/vitest.config.ts
  git diff --check
  git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  ```

  仅允许仓库既有、与本任务无关的命中；本任务的 debug/harness 必须为零。保护路径无输出。

- [ ] **Step 6：独立复审并提交根因修复**

  审查者核对 RED 原因、根因证据、最小性、禁止项、临时探针零残留及 worker 双门。Critical/Important 清零后提交 brief 列出的全部且仅这些文件：

  ```powershell
  $fixFiles = Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/root-cause-fix-files.txt
  if ($fixFiles.Count -eq 0) { throw '修复路径清单为空，禁止提交' }
  git add -- $fixFiles
  git diff --cached --name-only
  git commit -m "fix(desktop): 根治并行恢复测试超时"
  ```

  暂存清单必须与已复审 brief 完全一致；不一致时取消提交并修正清单。提交后把精确 hash 写入 ignored 报告。

---

### Task 4：建立逐文件、逐有效 hunk 的唯一 owner inventory 并只做安全减法

**文件：**
- 创建：`docs/operations/desktop-test-owner-inventory.md`
- 可能修改：仅 inventory 证明可替换/删除且通过删除门的现有测试、fixture 或 helper；路径必须先在 inventory 写明
- 范围：`c7d951d..当前最终候选 HEAD` 下 `apps/desktop/tests` 与 `tests/e2e` 的全部实际变更文件

**接口：**
- 每个变更文件至少一条 inventory 或可核验排除理由；每个有效 hunk/测试簇必须归类为 `业务 owner`、`测试装配`、`已删旧路径`、`纯移动/格式`。
- 每条业务 owner 必须有公开 seam、最低合理测试层、RED 能力证据、疑似重复裁决和旧路径依赖结论。
- 文件级 added/deleted 必须与 `git diff --numstat` 对账，所有文件求和必须等于 Git 总账。

- [ ] **Step 1：在 Task 3 最终提交后重新生成真实文件清单和无上下文 hunk**

  ```powershell
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

- [ ] **Step 3：为每个测试簇填写完整字段并逐文件对账**

  每条固定写入：路径与 hunk/标题定位、四类之一、不变量或装配目的、公开 seam/层级、RED 证据、相邻重复 owner、旧路径依赖、保留/合并/下移/替换/删除/排除裁决、文件级 numstat。必须逐项覆盖 owner token、真实 Store 重启、竞态、证据发布与保留、256/2000ms 边界、启动顺序、fallback、最终 load 两类失败、不可变快照、Main/Preload 双边界、Pet 顺序、Workshop StrictMode/脱敏、Electron 生命周期/诊断/窗口交互和两条恢复重启 E2E。

- [ ] **Step 4：仅对通过删除门的表达实施替换式减法**

  每个候选必须先指出替代 owner 和精确 seam，以 mutation、历史 RED 或最小破坏证明替代 owner 会捕获回归，确认不是唯一安全/竞态/持久化/Electron 证据，再让保留 owner GREEN，最后删除旧测试、旧 helper、旧 fixture 和只服务旧路径的注释。

  新抽象必须同时减少 owner 数和总代码；少量行数不引入通用 helper。若没有候选完整通过删除门，Task 4 合法结果是“零安全删除”，不得为制造减法而改代码。

- [ ] **Step 5：验证每组减法并复算总账**

  每个实际减法组运行受影响层的最小测试、Desktop typecheck（涉及 Desktop TypeScript 时）和 `git diff --check`。随后执行：

  ```powershell
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --name-only c7d951d..HEAD -- apps/desktop/tests tests/e2e
  rg -n "startupRecoveryErrorCode|loadCharacterStartupRecovery|fallbackActive|CharacterActions.*getCharacterRecoverySnapshot|export \{ characterRecoveryMessage \}" apps/desktop/src packages
  git diff --check
  ```

  `fallbackActive` 若仅存在于严格 Schema 负例，inventory 明确登记，不误报为生产旧 owner。最终净值如实记录，不宣称“安全减法已穷尽”。

- [ ] **Step 6：独立复审并提交最终可执行树候选**

  审查者逐文件抽查 hunk、RED 证据、分层和算术，并确认 Critical/Important 为零。把所有通过删除门且实际修改的路径逐行写入 `owner-subtraction-files.txt`；没有安全减法时保持空文件。提交 inventory 与该清单中的文件：

  ```powershell
  git add docs/operations/desktop-test-owner-inventory.md
  $subtractionFiles = @(Get-Content .superpowers/sdd/2026-08-21-desktop-development-gate-closure/owner-subtraction-files.txt)
  if ($subtractionFiles.Count -gt 0) { git add -- $subtractionFiles }
  git diff --cached --name-only
  git commit -m "test(desktop): 收口唯一测试 owner"
  ```

  提交后该 HEAD 只是“最终可执行树候选”；Task 5 前不得再有可执行差异。

---

### Task 5：在同一个最终可执行树 HEAD 上一次执行五条正式门

**文件：**
- 创建：`.superpowers/sdd/2026-08-21-desktop-development-gate-closure/gate-report.md`
- 不修改任何 tracked 文件

**接口：**
- `FINAL_EXECUTABLE_HEAD` 是 Task 3 修复、Task 4 inventory/减法和门禁前计划均已提交，且工作树无可执行差异的精确 HEAD。
- 五条顶层命令在该 HEAD 各执行一次且必须全部退出 0；历史绿色、内嵌相同步骤、定向绿色或另一 HEAD 不能替代。

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

  工作树不干净、保护路径有输出或临时诊断仍存在时不得开始五门。把精确 HEAD 写入 gate report，并记录“解锁交付窗口开始”。

- [ ] **Step 2：依次执行五条正式门，每条一次、15 分钟硬停**

  ```powershell
  pnpm.cmd verify:desktop
  pnpm.cmd verify:characters
  pnpm.cmd verify:behavior
  pnpm.cmd test:security
  pnpm.cmd test:integration
  ```

  每条记录开始/结束时间、退出码、阶段摘要和耗时。任一命令达到 15 分钟立即终止；任一退出非零立即停止剩余正式解锁流程，不重跑完整门碰运气。

- [ ] **Step 3：失败分支只建立新的最小反馈环**

  若任一门失败，状态为“开发门仍关闭”。只对该失败按 Task 1/2 方法建立新的最小反馈环；修复后产生新的最终可执行树 HEAD，五条命令必须全部从第一条重新执行。不得把已通过的旧 HEAD 命令拼接为新 HEAD 的五门证据。

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

  审查者核对每条命令确实运行一次、HEAD 相同、退出 0、时间低于 15 分钟、无 retry/skip/timeout/无证据 worker 变化、inventory 总账一致、保护路径为零。Critical/Important 清零后才允许 Task 6。

  Task 5 不创建 commit：任何提交都会改变 `FINAL_EXECUTABLE_HEAD`。gate report 记录同一 HEAD 并保持 ignored。

---

### Task 6：唯一纯验收文档后继提交并正式发布解锁结论

**前置条件：** 只有 Task 5 五门全部退出 0 且独立复审 Critical/Important 为零时执行。若超时根因未定位、Task 3 未合法完成、inventory 未对账或五门任一失败，不进入本任务；状态保持“开发门仍关闭”。

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
  git commit -m "docs(desktop): 正式解锁常规功能开发"
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
- 受保护网站/云端路径在实施区间、工作树和暂存区零差异；`git diff --check` 通过；临时诊断零残留。
- 唯一纯验收文档后继提交已同步四份事实源；ignored 报告记录实际文档提交 hash，并证明相对最终可执行树 HEAD 只有四份文档变化、可执行范围零差异。
- Windows 窗口层级、焦点、布局、文案可读性、重启视觉、拖拽、托盘和资源释放保持“待用户人工确认”；只在后续功能直接触及时成为该功能的前置验收。

任一项不满足，结论只能是“开发门仍关闭”。不得用历史绿色、风险接受、定向绿色或等价证据替代。
