# Graphify 外置架构审查执行计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 按任务执行，并在每个任务后进行规格符合性与任务质量复核。用户已于 2026-08-13 明确授权本任务执行 Git 写操作；任务检查点允许本地暂存与提交，但不得推送、合并、rebase、reset、clean 或删除分支，除非用户另行明确授权。

**目标：** 在不污染当前项目的前提下配置外置 Graphify，生成并核验全仓代码关系图，完成桌宠、网站与云端、工程治理三域审查，并交付三份中文长期架构治理文档。

**架构：** 当前 monorepo 始终作为只读分析输入；Graphify 0.9.41 安装和全部原始产物限定在 `D:\Python\Graphify`。Graphify 先提供静态关系候选，独立审查任务再用源码、测试、配置和历史规格核验，最后由主流程统一裁决并只向项目写入批准的中文文档。

**技术栈：** Python 3.12.5、Python `venv`、Graphify 0.9.41、PowerShell、pnpm workspace、TypeScript、Markdown、Mermaid、SDD 只读审查。

## 全局约束

- 当前工作树必须保持在 `main_Graphify_test`。
- 审查基准提交为 `4ddb14f04f12b3f9341de47a866854450afb24ee`；若用户后续修改工作区，必须记录并保护。
- Graphify 工具环境固定为 `D:\Python\Graphify\tool\.venv`。
- Graphify 固定安装 `graphifyy==0.9.41`，不得自动升级。
- Graphify 分析输出固定为 `D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out`。
- Graphify 必须使用 `--code-only`，不得处理文档、PDF、图片、音视频或调用 LLM。
- 不使用 Docker、Neo4j、FalkorDB、共享 MCP 或项目级 Graphify/Codex skill。
- 不修改项目 `package.json`、锁文件、workspace 配置或 `.gitignore`。
- 不修 Bug、不新增业务功能、不移动或删除业务文件。
- 所有项目文档和审查报告使用中文；代码符号、命令、路径和协议名保持原文。
- Graphify 的 `INFERRED` 和 `AMBIGUOUS` 关系必须回到源码核验，未经核验不得作为最终结论。
- 中间报告放在本计划的 `.superpowers/sdd` 忽略目录；项目内最终只新增批准的规格、计划和三份治理文档。
- 允许按任务检查点执行本地 `git add` 与 `git commit`；不执行 `git push`、merge、rebase、reset、clean 或分支删除。
- `graph.html` 构建完成后立即向用户提供绝对路径和打开方式，但通知不得暂停后续任务。

---

### Task 1：建立 Graphify 外置隔离环境

**文件：**

- 外部创建：`D:\Python\Graphify\tool\.venv\`
- 不修改：当前项目全部文件
- 证据写入：本计划 SDD 工作区的 `task-1-report.md`

**接口：**

- 消费：系统 Python `C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe`，版本 3.12.5。
- 产出：`D:\Python\Graphify\tool\.venv\Scripts\graphify.exe`，版本精确为 0.9.41。

- [ ] **步骤 1：执行失败前置检查**

```powershell
$GraphifyExe = 'D:\Python\Graphify\tool\.venv\Scripts\graphify.exe'
Test-Path -LiteralPath $GraphifyExe
```

预期：首次执行输出 `False`。如果已存在，则先读取版本和目录内容，不覆盖、不删除，按停止条件报告冲突。

- [ ] **步骤 2：记录项目隔离基线**

```powershell
git status --short --branch
git rev-parse HEAD
Get-FileHash package.json,pnpm-lock.yaml,pnpm-workspace.yaml,.gitignore -Algorithm SHA256
```

预期：分支为 `main_Graphify_test`，HEAD 为基准提交；状态只包含本轮已批准的规格和计划文件。

- [ ] **步骤 3：创建独立 Python 环境**

```powershell
& 'C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe' -m venv 'D:\Python\Graphify\tool\.venv'
```

预期：命令成功，Graphify 环境只位于 D 盘目标目录。

- [ ] **步骤 4：固定安装 Graphify**

```powershell
& 'D:\Python\Graphify\tool\.venv\Scripts\python.exe' -m pip install 'graphifyy==0.9.41'
```

预期：安装成功，不修改当前项目依赖或锁文件。

- [ ] **步骤 5：验证版本与可执行文件**

```powershell
& 'D:\Python\Graphify\tool\.venv\Scripts\graphify.exe' --version
& 'D:\Python\Graphify\tool\.venv\Scripts\python.exe' -m pip show graphifyy
```

预期：Graphify/包版本均为 `0.9.41`。

- [ ] **步骤 6：执行隔离回归检查**

```powershell
git status --short --branch
Get-FileHash package.json,pnpm-lock.yaml,pnpm-workspace.yaml,.gitignore -Algorithm SHA256
rg --files -g 'graphify-out/**' -g '.graphify*'
```

预期：哈希与步骤 2 一致；仓库状态没有 Graphify 引起的新增；`rg` 不返回仓库内 Graphify 状态文件。

- [ ] **步骤 7：记录任务检查点并独立复核**

报告必须记录安装命令、版本输出、隔离前后哈希和 `git status`。复核者确认规格符合性与安装隔离质量；本任务不产生需单独提交的项目文件，规格与计划由主流程在复核通过后建立本地检查点。

### Task 2：生成全仓关系图和交互式 HTML

**文件：**

- 外部创建：`D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json`
- 外部创建：`D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\GRAPH_REPORT.md`
- 外部创建：`D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.html`
- 外部创建：同目录 manifest、分析侧车、缓存和 Graphify 本地状态
- 不修改：当前项目全部文件
- 证据写入：本计划 SDD 工作区的 `task-2-report.md`

**接口：**

- 消费：任务 1 产出的 Graphify 可执行文件；只读 monorepo 根目录。
- 产出：可解析的 `graph.json`、Graphify 架构报告和可本地打开的 `graph.html`。

- [ ] **步骤 1：执行失败前置检查**

```powershell
$RunRoot = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13'
$Graph = Join-Path $RunRoot 'graphify-out\graph.json'
$Html = Join-Path $RunRoot 'graphify-out\graph.html'
Test-Path -LiteralPath $Graph
Test-Path -LiteralPath $Html
```

预期：首次执行均为 `False`。若已有同名运行目录，不覆盖、不删除，停止并让用户决定是否采用新的日期后缀。

- [ ] **步骤 2：执行纯代码提取**

```powershell
$Graphify = 'D:\Python\Graphify\tool\.venv\Scripts\graphify.exe'
$Repo = 'C:\Users\Administrator\.codex\worktrees\38cc\myself'
$RunRoot = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13'
& $Graphify extract $Repo --code-only --out $RunRoot
```

预期：生成 `graphify-out\graph.json`、manifest 和分析侧车，不在项目内生成 `graphify-out`。

- [ ] **步骤 3：验证图 JSON 基本完整性**

```powershell
$Graph = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json'
& 'D:\Python\Graphify\tool\.venv\Scripts\python.exe' -c "import json, pathlib; p=pathlib.Path(r'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json'); d=json.loads(p.read_text(encoding='utf-8')); print(type(d).__name__, p.stat().st_size, len(d.get('nodes', [])), len(d.get('edges', [])))"
```

预期：JSON 可解析，文件大小大于 0，节点数和边数均大于 0。

- [ ] **步骤 4：生成离线聚类报告**

```powershell
$Graphify = 'D:\Python\Graphify\tool\.venv\Scripts\graphify.exe'
$Repo = 'C:\Users\Administrator\.codex\worktrees\38cc\myself'
$Graph = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json'
& $Graphify cluster-only $Repo --graph $Graph --no-label --no-viz
```

预期：生成或更新 `.graphify_analysis.json` 和 `GRAPH_REPORT.md`，不调用 LLM。

- [ ] **步骤 5：导出交互式 HTML**

```powershell
$Graphify = 'D:\Python\Graphify\tool\.venv\Scripts\graphify.exe'
$Graph = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.json'
& $Graphify export html --graph $Graph
```

预期：生成 `D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.html`。

- [ ] **步骤 6：验证产物和仓库隔离**

```powershell
$Out = 'D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out'
Get-Item (Join-Path $Out 'graph.json'),(Join-Path $Out 'GRAPH_REPORT.md'),(Join-Path $Out 'graph.html') | Select-Object FullName,Length,LastWriteTime
git status --short --branch
rg --files -g 'graphify-out/**' -g '.graphify*'
```

预期：三项核心产物存在且非空；项目内没有 Graphify 产物；Git 状态只有已批准文档。

- [ ] **步骤 7：通知用户但不中断执行**

向用户提供：

```text
D:\Python\Graphify\runs\myself-main_Graphify_test-2026-08-13\graphify-out\graph.html
```

说明该文件可直接用浏览器打开，并继续执行任务 3，不等待用户回复。

- [ ] **步骤 8：记录任务检查点并独立复核**

报告必须记录节点数、边数、三项核心产物大小、执行命令、错误和隔离验证。复核者确认图谱生成符合规格且未污染项目；若没有项目文件变化，则只记录外置产物检查点，不创建空提交。

### Task 3：建立全仓基线并验证 Graphify 可信度

**文件：**

- 读取：任务 2 的 `graph.json`、`GRAPH_REPORT.md` 和 manifest
- 读取：根 `package.json`、`pnpm-workspace.yaml`、各 workspace `package.json`、`tsconfig` 和核心 barrel export
- 创建：本计划 SDD 工作区的 `reviews/01-baseline-and-graph-trust.md`

**接口：**

- 消费：任务 2 的完整关系图。
- 产出：已核验的包级依赖基线、Graphify 正负样本、动态关系限制和是否通过可信度门的结论。

- [ ] **步骤 1：先写可信度验收样本**

报告中预先列出以下正向样本，尚未查询时全部标记为“未验证”：

```text
@myself/desktop -> @myself/agent-core
@myself/desktop -> @myself/character-runtime
@myself/desktop -> @myself/file-tools
@myself/website -> @myself/shared-types
@myself/cloudbase-api -> @myself/shared-types
@myself/package-scanner -> @myself/character-assets
@myself/agent-core -> @myself/character-runtime
```

负向样本：网站不得直接依赖桌宠应用实现；桌宠不得直接依赖网站实现；共享包不得依赖任一应用。

- [ ] **步骤 2：从声明依赖建立事实基线**

```powershell
rg -n --glob 'package.json' '"@myself/[^\"]+"\s*:\s*"workspace:' apps packages tools
rg -n --glob 'tsconfig*.json' 'baseUrl|paths|extends' .
rg -n --glob '*.ts' --glob '*.tsx' '^export .* from |^import .* from ' apps packages
```

预期：得到可回溯到文件和行号的声明依赖、alias 与 barrel export 事实。

- [ ] **步骤 3：在 Graphify 图中核验样本**

读取 `graph.json` 的节点、边、关系类型和置信度，逐条对照步骤 1 的正负样本；记录匹配节点、边、置信度和源码位置。

- [ ] **步骤 4：抽查动态关系限制**

至少抽查 Electron IPC、依赖注入、事件回调、运行时 provider 注册和动态 import 各一个案例。Graphify 未覆盖时记录为工具限制，不伪造关系。

- [ ] **步骤 5：裁决可信度门**

仅在已知包依赖可识别、没有系统性误边、动态限制已记录且项目隔离保持成立时标记“通过”。否则标记“降级”，后续审查只把 Graphify 当作符号索引。

- [ ] **步骤 6：独立复核**

复核者检查每个样本是否有 Graphify 与源码双重证据、负向样本是否被正确解释、可信度裁决是否过度推断；不修改项目文件。

### Task 4：审查桌宠域

**文件：**

- 读取：`apps/desktop/**`
- 读取：`packages/agent-core/**`
- 读取：`packages/character-runtime/**`
- 读取：`packages/character-assets/**`
- 读取：`packages/file-tools/**`
- 读取：相关安全、集成和 E2E 测试及既有规格
- 创建：本计划 SDD 工作区的 `reviews/02-desktop-domain.md`

**接口：**

- 消费：任务 3 的包级基线和 Graphify 可信度裁决。
- 产出：桌宠域的模块图、关键数据流、问题清单、目标 seam 和优化候选顺序。

- [ ] **步骤 1：建立桌宠域清单**

按 Electron main/preload/renderer、Agent、角色、文件能力、设置与存储、Explorer/Windows 集成、MCP 保留路径分类文件和模块。

- [ ] **步骤 2：审查结构热点**

重点核验已发现的超大 implementation：角色资源、角色包、角色存储、角色工作室 store、主进程装配、Agent service、IPC 注册和对话协调器。每项判断必须包含文件、行号、interface、implementation、依赖和修改扩散证据。

- [ ] **步骤 3：审查运行时链路**

沿以下纵向链路追踪真实数据流：

```text
用户输入 → renderer → preload → IPC → main → Agent/能力 → 授权与确认 → 执行 → 反馈 → 角色表现/持久化
```

记录隐式协议、重复校验、错误映射差异和共享状态。

- [ ] **步骤 4：审查 V1/V2 与退役能力**

区分必要数据兼容、运行时双轨、测试兼容夹具和已退役功能残留；不得把仍受支持的迁移路径简单判定为冗余。

- [ ] **步骤 5：审查测试 seam**

检查超大测试是否说明生产 interface 过宽、fixture 重复、穿透 implementation 或多职责混合；提出测试结构优化，但不修改测试。

- [ ] **步骤 6：形成问题清单**

每个问题使用 S0–S3 分级，包含源码证据、影响、目标 seam、最小迁移顺序、风险、回滚点和验收方式。

- [ ] **步骤 7：独立复核**

复核者分别给出规格符合性和审查质量结论，重点检查是否混淆“文件很大”与“职责不合理”、是否遗漏安全 seam、是否提出一次性重写。

### Task 5：审查网站与云端域

**文件：**

- 读取：`apps/website/**`
- 读取：`apps/cloudbase-api/**`
- 读取：`apps/package-scanner/**`
- 读取：`packages/shared-types/**`
- 读取：`cloudbase/**`、网站 E2E、云端测试和相关规格
- 创建：本计划 SDD 工作区的 `reviews/03-web-cloud-domain.md`

**接口：**

- 消费：任务 3 的包级基线和 Graphify 可信度裁决。
- 产出：网站、CloudBase、扫描器及共享契约的模块图、运行时链路和问题清单。

- [ ] **步骤 1：建立网站与云端域清单**

按网站展示与交互、客户端数据 adapter、CloudBase HTTP/function、内容存储与审核、角色包扫描、共享契约和发布下载链分类。

- [ ] **步骤 2：审查共享契约**

核验 `shared-types` 是否保持跨应用最小公共语义，检查 schema、错误、状态、moderation 与 provider catalog 是否泄漏具体应用职责。

- [ ] **步骤 3：审查纵向数据流**

至少追踪提交、审核、公开内容、角色包扫描、反馈存储和软件下载 manifest；记录客户端、CloudBase 和扫描器间的鉴权、校验、错误与状态映射。

- [ ] **步骤 4：审查结构热点与重复实现**

重点核验 CloudBase Postgres adapter、function 入口、package scanner server、网站 controller、大型页面模块和 i18n 消息集中度；区分 UI 复杂度与领域职责混合。

- [ ] **步骤 5：审查与桌宠的真实边界**

确认网站和桌宠是否仅共享契约、角色资源格式与发布产物；识别不必要的双向假设或重复领域模型。

- [ ] **步骤 6：形成问题清单**

使用与任务 4 相同的证据和严重度格式，不提出功能性改动。

- [ ] **步骤 7：独立复核**

复核者检查数据流是否完整、共享契约判断是否有真实消费者证据、云端安全与部署边界是否被忽略。

### Task 6：审查测试、构建、发布与文档治理

**文件：**

- 读取：`tests/**`
- 读取：`tools/**`
- 读取：根脚本、各包脚本和配置
- 读取：`docs/superpowers/specs/**`、`docs/superpowers/plans/**`、`docs/operations/**`、`CONTEXT.md`
- 创建：本计划 SDD 工作区的 `reviews/04-engineering-governance.md`

**接口：**

- 消费：任务 3–5 的基线和分域问题。
- 产出：测试分层、构建发布、配置与文档一致性的证据化问题清单。

- [ ] **步骤 1：建立工程验证矩阵**

将根 `test`、`typecheck`、桌宠、网站、CloudBase、行为、角色和 E2E 脚本映射到实际包与测试目录，识别重复执行、缺口和职责交叉。

- [ ] **步骤 2：审查测试结构**

统计超大测试文件、fixture 重复、跨层 mock、脆弱 DOM/IPC 断言和与 implementation 强绑定的测试；回到生产 interface 判断根因。

- [ ] **步骤 3：审查构建与发布链**

追踪 Electron 构建与 NSIS、网站 build/export、CloudBase function 构建、角色包扫描镜像、release manifest 生成和网站下载入口。

- [ ] **步骤 4：审查规格与实现漂移**

抽查已确认设计、执行计划、验收文档和当前代码，记录已退役能力仍被描述为现状、术语冲突、完成状态失真和重复计划造成的认知噪声。

- [ ] **步骤 5：审查领域词汇**

核验根 `CONTEXT.md` 是否只描述桌宠上下文却被放在全仓根；提出是否需要 `CONTEXT-MAP.md` 的建议，但本轮不创建未获证据支持的领域文件。

- [ ] **步骤 6：形成问题清单并独立复核**

使用统一格式输出工程治理问题；复核者检查是否把历史文档当成当前事实、是否给出可执行而非泛化的治理建议。

### Task 7：合并审查结果并交付三份长期文档

**文件：**

- 创建：`docs/architecture/system-map.md`
- 创建：`docs/architecture/audits/2026-08-13-full-audit.md`
- 创建：`docs/architecture/audits/2026-08-13-optimization-roadmap.md`
- 读取：任务 3–6 的全部报告与复核结论

**接口：**

- 消费：四份已复核中间报告和 Graphify 原始产物。
- 产出：稳定系统地图、完整问题清单和分阶段优化路线图。

- [ ] **步骤 1：执行失败前置检查**

```powershell
Test-Path docs/architecture/system-map.md
Test-Path docs/architecture/audits/2026-08-13-full-audit.md
Test-Path docs/architecture/audits/2026-08-13-optimization-roadmap.md
```

预期：首次执行均为 `False`。如果用户已创建同名文件，停止并确认合并方式，不覆盖。

- [ ] **步骤 2：合并和裁决问题**

去重跨域问题，统一 S0–S3 严重度；S0、S1 和跨域问题必须由主流程再次读取源码核验。明确标记合理兼容成本、Graphify 误报和无法通过静态分析裁决的问题。

- [ ] **步骤 3：编写系统关系总览**

`system-map.md` 必须包含：

- 业务上下文与职责。
- workspace 包依赖方向。
- 桌宠 main/preload/renderer 与核心能力数据流。
- 网站、CloudBase、扫描器与发布数据流。
- Mermaid 总图与关键纵向链路图。
- 每个重要模块的 interface、依赖和 seam。

- [ ] **步骤 4：编写完整审查报告**

`full-audit.md` 必须包含：

- 审查范围、基准提交和方法。
- Graphify 版本、产物路径、节点/边统计和可信度裁决。
- 按域组织的 S0–S3 问题。
- 每项问题的源码证据、影响、目标结构和验收方式。
- 未发现问题的关键边界与当前合理设计，避免报告只呈现负面内容。

- [ ] **步骤 5：编写优化路线图**

`optimization-roadmap.md` 必须按“止血规则 → 建立 seam → 纵向替换 → 删除旧路径 → 恢复功能开发”组织。每个阶段包含目标、范围、前置、明确非目标、任务顺序、风险、回滚点、测试策略和完成标准。

- [ ] **步骤 6：运行文档验收检查**

```powershell
git diff --check
rg -n 'TBD|TODO|待定|稍后补充|适当处理|类似于' docs/architecture
rg -n '^```mermaid$|^flowchart |^graph ' docs/architecture
rg -n 'S0|S1|S2|S3' docs/architecture/audits/2026-08-13-full-audit.md
```

预期：`git diff --check` 无输出；占位符搜索无命中；Mermaid 与严重度结构存在。

- [ ] **步骤 7：运行最终隔离检查**

```powershell
git status --short --branch
git diff --name-only
Get-FileHash package.json,pnpm-lock.yaml,pnpm-workspace.yaml,.gitignore -Algorithm SHA256
rg --files -g 'graphify-out/**' -g '.graphify*'
```

预期：差异只包含本轮中文规格、计划和三份治理文档；根依赖与忽略文件哈希未改变；项目内不存在 Graphify 原始产物。

- [ ] **步骤 8：最终整体验收**

由独立审查者同时检查规格覆盖和文档质量，重点验证：结论可追溯、严重度一致、路线图可拆成后续独立 SDD/TDD 规格、没有一次性重写、没有未授权 Git 操作。

- [ ] **步骤 9：向用户交付**

提供三份项目文档与外部 `graph.html` 的绝对路径，汇总最高优先级发现、Graphify 局限和建议的第一项后续治理规格。报告已经完成的本地检查点提交；推送、合并或其他集成操作继续等待用户决定。
