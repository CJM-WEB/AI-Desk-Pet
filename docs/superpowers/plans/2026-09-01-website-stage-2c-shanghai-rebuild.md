# 网站阶段 2C 上海免费环境重建实施计划

> **历史替代声明（禁止执行旧自动审核任务）：** 本计划中关于 CloudBase Run Scanner、腾讯 TMS/IMS、`ai-pet-moderation-worker`、Scanner Secret、触发器与相关 smoke 的任务已被 [`2026-09-01-website-stage-2c-zero-cost-manual-review.md`](2026-09-01-website-stage-2c-zero-cost-manual-review.md) 替代。保留全文只为追溯既有裁决，任何旧命令都不得执行；现行部署仅允许 PostgreSQL、私有 Bucket、API、cleanup、身份、网关与静态托管。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不产生额外费用、不触碰桌宠业务代码、不进入正式生产的前提下，把网站阶段 2C 的唯一开发目标迁移到上海 CloudBase PostgreSQL 免费环境，并用本地测试和真实云端证据决定阶段 2C 是 `pass` 还是 `blocked`。

**Architecture:** 保留现有 Next.js 网站、CloudBase API、PostgreSQL migration、三个云函数和 Scanner 容器架构；地域只保留 `ap-shanghai` 一条正式路径。先做零费用与免费套餐能力门禁，再完成本地 TDD 改造；远端写操作全部串行，由主智能体在已登录的腾讯云会话或官方 CLI 中执行。若免费套餐不能承载既定超时、内存或安全能力，立即失败关闭，不通过新增第二套架构、付费或降低审核要求绕过。

**Tech Stack:** pnpm workspace、TypeScript、Vitest、Node.js test runner、Next.js 15、CloudBase JS SDK V3、`@cloudbase/manager-node`、CloudBase CLI 3.7.0、CloudBase PostgreSQL、Cloud Functions、CloudBase Run、Docker。

**适用规格:** `docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md`

> **2026-09-01 执行结果：** Task 1、Task 2 与适用的 Task 4 已完成；Task 3、Task 5–10 按零费用阻断裁剪，未执行远端操作；Task 11 已完成最终本地门禁与文档收敛。阶段 2C 最终状态为 `blocked`，不代表上海 PG 环境已创建、远端已部署或生产已上线。独立证据见 `docs/operations/website-stage-2c-shanghai-acceptance.md`。

> **历史快照（已被后续状态取代）：** 上述 2026-09-01 `blocked` 执行结果仅保留历史事实；2026-09-02 零费用方案已取代其状态。当前入口是 [`2026-09-01-website-stage-2c-zero-cost-manual-review.md`](2026-09-01-website-stage-2c-zero-cost-manual-review.md) 与 [`website-stage-2c-zero-cost-manual-review-acceptance.md`](../../operations/website-stage-2c-zero-cost-manual-review-acceptance.md)，远端状态为 `remote: in_progress`。

## 全局约束

- 允许修改的业务路径仅为 `apps/website/**`、`apps/cloudbase-api/**`、`apps/package-scanner/**`、`cloudbase/**`、相关网站工具、配置和文档。
- 禁止修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`；Scanner 只能消费已有契约。
- 当前分支为 `WebsiteExtension`。允许 `git add`、`git commit` 等已授权的当前分支写操作；禁止 merge、rebase、push 和破坏性回退。
- 全部云端写操作串行执行，不分派给并行子智能体。唯一例外是 Task 7 在一个受控 probe 内对同一 plan 发起恰好两次并发 push；该窗口不得有其他写操作，任一任务状态未知即停止。子智能体只承担边界清晰的本地实现或只读复核。
- 旧环境销毁属于不可恢复的大量删除；真正提交前必须展示精确目标并取得用户第二次明确确认。
- 创建永久 Publishable Key、API Key 或持久访问密钥前必须取得行动时确认。优先使用官方 CLI Web 登录产生的临时凭据。
- 不打印、不记录 SecretId、SecretKey、SessionToken、API Key、HMAC Secret、管理员邮箱或对象签名 URL。
- `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false` 贯穿本计划；本计划不切换正式域名、不发布正式网站。
- 控制台任何页面若未明确显示 `0 元`、需要按量计费、自动续费或购买资源包，立即停止并把阶段 2C 记为 `blocked`。
- 每个任务先运行最小定向测试，再运行其完成标准中的门禁；失败原因未解释前不得继续堆叠修改。

---

## Task 1：建立基线并执行“删除前”零费用能力门禁

**Files:**

- Read: `cloudbaserc.json`
- Read: `apps/cloudbase-api/src/functions/moderation-worker.ts`
- Read: `apps/cloudbase-api/src/functions/cleanup.ts`
- Read: `apps/package-scanner/Dockerfile`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`
- Modify when blocked: `docs/operations/cloudbase-deployment.md`

- [ ] **Step 1.1：记录本地与 Git 基线**

Run:

```powershell
git status --short --branch
git diff --check
git branch --show-current
pnpm.cmd exec cloudbase --version
docker info
```

Expected:

- 分支为 `WebsiteExtension`；没有未知工作区改动。
- CloudBase CLI 为可用的 3.7.x；Docker Server 可响应。
- 若存在用户改动，只登记并避开，不覆盖或清理。

- [ ] **Step 1.2：RED——证明新阶段文件尚未越过精确范围门禁**

Run:

```powershell
rg -n "ap-singapore|intl:\s*true" apps/cloudbase-api apps/website apps/package-scanner tools docs/operations docs/superpowers/specs docs/superpowers/plans
pnpm.cmd verify:web-chain:scope
```

Expected: 地域命中用于建立后续删除清单；scope 只因尚未登记的新规格和新计划精确路径而失败，不得出现桌宠黑名单或其他白名单外路径。

- [ ] **Step 1.3：GREEN——登记阶段 2C 的最小网站范围**

先在 `verify-website-scope.test.mjs` 添加失败测试，再只把以下精确路径加入 `ALLOWED_WEBSITE_SCOPE_PATHS`：

- `cloudbaserc.json`
- `apps/package-scanner/tests/adapters.test.ts`
- `tools/run-cloudbase-development-migrations.mjs`
- `tools/run-cloudbase-development-migrations.test.mjs`
- `docs/operations/website-stage-2c-shanghai-acceptance.md`
- `docs/superpowers/specs/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md`
- `docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md`
- `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`

在 `ALLOWED_ROOT_SCRIPT_CHANGES` 中只增加：

```js
'run:cloudbase-migrations:development': 'node tools/run-cloudbase-development-migrations.mjs'
```

不得把 `tools/**`、`docs/**` 或 `apps/package-scanner/**` 整体放行；桌宠黑名单保持不变。

Run:

```powershell
node --test tools/verification/verify-website-scope.test.mjs
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
```

Expected: 三项通过，新阶段只获得上述精确文件权限。

- [ ] **Step 1.4：用官方价格页与当前控制台做免费能力门禁**

逐项只读核对：

1. 免费体验环境是否仍可在上海创建 PostgreSQL。
2. 免费云函数是否允许 `ai-pet-api=30s`、`ai-pet-moderation-worker=900s`、`ai-pet-cleanup=300s`。
3. 免费 CloudBase Run 是否允许 Scanner 使用 Node 22 容器、至少 1 GB 内存、最大实例 1、最小实例 0，以及控制台是否真的提供并保存“单实例并发 1”。
4. 是否存在按量付费、超限自动扣费、自动续费或必须购买资源包的前置条件。

官方价格页目前写明免费环境函数固定 256 MB、3 秒超时且不可修改，而仓库声明三个函数分别为 30/900/300 秒。该冲突必须在删除旧环境前裁决：

官方依据：[CloudBase 云开发定价](https://buy.cloud.tencent.com/price/tcb/overview)。

- 若控制台和官方后端仍明确限制为 3 秒，记录 URL、日期、脱敏截图和受阻函数，阶段 2C 记为 `blocked`，**不删除旧环境、不新建付费资源、不继续 Task 5 以后步骤**。
- 只有在控制台明确证明免费环境允许仓库所需超时且没有费用时，才能继续后续云端重建。
- 若控制台和官方 CLI 都不能证明 Scanner“单实例并发 1”可配置并保存，本项同样 `blocked`；不得把最大实例 1 误当作单实例并发 1。
- 不通过把 worker 临时改为 3 秒、改成第二套云托管服务或减少审核步骤来伪造通过；这类架构变化必须另立规格。

**2026-09-01 实际门禁结论：** 旧上海免费体验环境仍为传统/MySQL 模式；免费云函数页面展示的超时与内存未形成阻断，但 CloudBase Run 需要开启超限按量计费，且官方 CLI 与控制台均未观察到可保存“单实例并发 1”的设置。因此远端部分为 `blocked`，未执行任何腾讯云写操作，Task 3 与 Task 5–10 被裁剪。完整环境、费用、凭据风险与恢复证据见 [`website-stage-2c-shanghai-acceptance.md`](../../operations/website-stage-2c-shanghai-acceptance.md)。

- [ ] **Step 1.5：提交范围治理与门禁记录**

Run:

```powershell
git diff --check
git diff -- docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md docs/operations/cloudbase-deployment.md
git add tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md docs/operations/cloudbase-deployment.md
git commit -m "test(web): 登记阶段2C网站范围"
```

完成标准：在任何不可逆删除前，免费套餐是否能承载现有架构已有明确、可追溯裁决。

若 Task 1.4 判定 `blocked`，仍执行 Task 2 的上海单地域减法与适用的 Task 4 本地门禁，然后直接进入 Task 11 写阻塞验收；跳过只为远端执行服务的 Task 3 和全部 Task 5–10，避免增加用不到的 runner。

---

## Task 2：TDD 将唯一开发地域改为上海并删除新加坡专用配置

**Files:**

- Modify: `apps/cloudbase-api/tests/config.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`
- Modify: `apps/cloudbase-api/tests/support/cloudbase-production.ts`
- Modify: `apps/website/tests/cloudbase-client.test.ts`
- Modify: `apps/package-scanner/tests/adapters.test.ts`
- Modify: `tools/cloudbase-user-migration-adapter.test.mjs`
- Modify: `tools/verification/verify-scanner-candidate.test.mjs`
- Modify: `apps/cloudbase-api/src/config.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`
- Modify: `apps/website/lib/cloudbase-client.ts`
- Modify: `apps/package-scanner/src/server.ts`
- Modify: `tools/cloudbase-user-migration-adapter.mjs`
- Modify: `tools/verification/verify-scanner-candidate.mjs`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/superpowers/specs/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-website-stage-2-3-local-closure-design.md`

- [ ] **Step 2.1：RED——先把测试改为上海契约**

测试必须断言：

- CloudBase API 默认并只接受 `ap-shanghai`，显式 `ap-singapore` 失败关闭。
- 服务端 SDK 初始化传入 `region: 'ap-shanghai'`。
- 网站 SDK 初始化传入 `region: 'ap-shanghai'`，并且初始化参数不再拥有 `intl` 属性。
- migration Adapter 固定上海并拒绝任何 `region` override；`TCB_REGION` 只有精确 `ap-shanghai` 才可用。
- Scanner 候选容器注入 `TENCENT_CLOUD_REGION=ap-shanghai`。
- moderation worker 只接受 `MODERATION_REGION=ap-shanghai`，Scanner IMS 客户端只接受 `TENCENT_CLOUD_REGION=ap-shanghai`；显式新加坡值均失败关闭。

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api exec vitest run --config vitest.config.ts tests/config.test.ts tests/cloudbase-runtime.test.ts
pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/cloudbase-client.test.ts
pnpm.cmd --filter @myself/package-scanner exec vitest run --config vitest.config.ts --configLoader runner tests/adapters.test.ts
node --test tools/cloudbase-user-migration-adapter.test.mjs tools/verification/verify-scanner-candidate.test.mjs
```

Expected: 只因现有实现仍为新加坡或仍包含 `intl: true` 而失败；保存 RED 失败摘要。

- [ ] **Step 2.2：GREEN——进行最小地域替换与配置减法**

实施：

- 将五处正式运行路径的固定地域改为 `ap-shanghai`。
- 把 moderation worker 与 Scanner IMS 的地域 loader 收窄为唯一 `ap-shanghai`，延续配置不一致时失败关闭。
- 删除网站 SDK 初始化对象中的 `intl: true`，不增加 `intl: false` 或新的地区兼容层。
- 保留字符串字面量和现有失败关闭结构，不抽象通用 region registry。
- 只更新结构性注释中的地域事实，不改业务 DTO、状态机或审核行为。

- [ ] **Step 2.3：运行定向 GREEN 与小范围门禁**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api exec vitest run --config vitest.config.ts tests/config.test.ts tests/cloudbase-runtime.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/cloudbase-client.test.ts
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/package-scanner exec vitest run --config vitest.config.ts --configLoader runner tests/adapters.test.ts
pnpm.cmd --filter @myself/package-scanner typecheck
node --test tools/cloudbase-user-migration-adapter.test.mjs tools/verification/verify-scanner-candidate.test.mjs
```

Expected: 全部通过。

- [ ] **Step 2.4：REFACTOR——清除有效文档中的旧地域结论**

实施：

- 部署手册只保留上海开发环境结论。
- 两份被替代的旧规格在顶部增加“地域条款已被 2026-09-01 规格替代”的短说明；不重写历史正文。
- 历史计划中的命令和旧 RED/GREEN 示例保留为历史证据，不批量改写；索引必须把新规格和本计划列为当前入口。

Run:

```powershell
rg -n "ap-singapore|intl:\s*true" apps/cloudbase-api apps/website apps/package-scanner tools docs/operations
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
```

Expected: 正式实现和现行部署手册中没有旧新加坡配置或 `intl: true`；测试中的 `ap-singapore` 只用于验证明确拒绝，历史文档命中均有替代关系。

- [ ] **Step 2.5：提交本任务**

```powershell
git add apps/cloudbase-api/src/config.ts apps/cloudbase-api/src/adapters/cloudbase-runtime.ts apps/cloudbase-api/tests/config.test.ts apps/cloudbase-api/tests/cloudbase-runtime.test.ts apps/cloudbase-api/tests/support/cloudbase-production.ts apps/website/lib/cloudbase-client.ts apps/website/tests/cloudbase-client.test.ts apps/package-scanner/src/server.ts apps/package-scanner/tests/adapters.test.ts tools/cloudbase-user-migration-adapter.mjs tools/cloudbase-user-migration-adapter.test.mjs tools/verification/verify-scanner-candidate.mjs tools/verification/verify-scanner-candidate.test.mjs docs/operations/cloudbase-deployment.md docs/superpowers/specs/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md docs/superpowers/specs/2026-08-31-website-stage-2-3-local-closure-design.md
git commit -m "refactor(web): 固定上海CloudBase开发地域"
```

完成标准：仓库只有一条上海开发地域路径，且代码总职责未因兼容层增加。

---

## Task 3：TDD 增加最小、受控的开发环境 migration 执行入口

**进入条件:** Task 1.4 已证明免费套餐能够承载现有函数与 Scanner 契约；若已 `blocked`，整项跳过且不得创建下列文件。

**Files:**

- Create: `tools/run-cloudbase-development-migrations.mjs`
- Create: `tools/run-cloudbase-development-migrations.test.mjs`
- Modify: `tools/cloudbase-user-migration-adapter.mjs`
- Modify: `tools/cloudbase-user-migration-adapter.test.mjs`
- Modify: `tools/verification/web-chain-catalog.mjs`
- Modify: `tools/verification/web-chain-catalog.test.mjs`
- Modify: `tools/verification/verify-web-test-ownership.mjs`
- Modify: `tools/verification/verify-web-test-ownership.test.mjs`
- Modify: `package.json`

- [ ] **Step 3.1：RED——定义执行入口的安全契约**

测试覆盖：

1. 缺少 `--execute`、`--env-id` 或 `--expected-plan-sha256` 时拒绝。
2. 只接受 `--environment-class development`，拒绝 production 或未声明环境类别。
3. 地域不接受参数，内部固定 `ap-shanghai`；存在不一致 `TCB_REGION` 时失败关闭。
4. 必须从当前进程环境读取临时 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY` 和可选 `TENCENTCLOUD_SESSIONTOKEN`；不接受命令行 secret 参数。
5. 传入的 plan hash 必须与 `createCloudBaseMigrationDryRun` 生成值完全相等，否则不加载 manager SDK。
6. 正常路径只复用 `inventoryCloudBaseMigrations`、`createCloudBaseUserMigrationAdapter` 和 `runCloudBaseUserMigrations`。
7. 标准输出只允许脱敏后的 `outcome`、`taskId`、迁移数量和 plan hash；错误与输出不得含注入的 secret 哨兵值或 SQL 正文。
8. Adapter 增加的 `listApplied` 只调用官方 `listPGUserMigrations`，每次调用前继续执行 development 与 `TCB_REGION` 失败关闭。
9. 显式 `--stage2c-probe` 只允许对 inventory 第一条 migration 生成内存内固定非法 SQL 变体，并执行“失败后未写历史、同 plan 双 push、最终 history 唯一、正常重试 up-to-date”流程；不接受 SQL、版本或名称参数。
10. 网站链 catalog 把 runner 源文件加入依赖审计输入，把 runner 测试加入 `migration-tool-test`，并为该测试增加唯一 `root-cloudbase-tools` owner；ownership 的精确文件清单同步登记。

Run:

```powershell
node --test tools/run-cloudbase-development-migrations.test.mjs tools/cloudbase-user-migration-adapter.test.mjs
```

Expected: 因入口和 `listApplied` 尚不存在而失败。

- [ ] **Step 3.2：GREEN——实现单一受控入口**

实施边界：

- `package.json` 只新增以下执行脚本：

```json
"run:cloudbase-migrations:development": "node tools/run-cloudbase-development-migrations.mjs"
```

现有 `test:cloudbase-tools` 保持不变；runner 测试由本任务和最终门禁中的精确 `node --test` 命令执行，避免为一次运维入口扩大原工具门禁职责。

- 不修改默认只读的 `plan:cloudbase-migrations`。
- 不新增 SQL 执行器、配置文件或持久凭据存储。
- `listApplied` 的默认分页上限固定为 500，足以覆盖当前 13 个 migration；超限时失败关闭，不静默截断。
- `--stage2c-probe` 与普通 `--execute` 互斥，并复用同一个 Adapter 和 inventory；probe 结果只输出脱敏状态。
- 使用 `try/finally` 删除进程内临时凭据引用；不向日志输出环境变量对象。
- 不新增第二个验证 profile；复用现有 `migration-tool-test`、ownership 与 dependency-audit 门禁。

- [ ] **Step 3.3：运行定向 GREEN 与工具门禁**

Run:

```powershell
node --test tools/run-cloudbase-development-migrations.test.mjs tools/cloudbase-user-migration-adapter.test.mjs tools/cloudbase-user-migrations.test.mjs tools/cloudbase-migration-inventory.test.mjs
pnpm.cmd test:cloudbase-tools
pnpm.cmd plan:cloudbase-migrations
pnpm.cmd verify:web-chain:fast
```

Expected:

- 测试通过。
- 默认 plan 仍只输出 13 个版本及 checksum，不访问网络。
- 执行入口在没有 `--execute` 与临时凭据时拒绝。

- [ ] **Step 3.4：提交本任务**

```powershell
git add package.json tools/run-cloudbase-development-migrations.mjs tools/run-cloudbase-development-migrations.test.mjs tools/cloudbase-user-migration-adapter.mjs tools/cloudbase-user-migration-adapter.test.mjs tools/verification/web-chain-catalog.mjs tools/verification/web-chain-catalog.test.mjs tools/verification/verify-web-test-ownership.mjs tools/verification/verify-web-test-ownership.test.mjs
git commit -m "feat(web): 增加受控开发环境迁移入口"
```

完成标准：远端 migration 有一条显式、可测试、默认拒绝的正式入口；原 dry-run 路径未被扩大。

---

## Task 4：本地全量门禁与双重复核

**Files:**

- Review: Task 2–3 的全部差异
- Modify when needed: 仅限 Task 2–3 已登记文件

- [ ] **Step 4.1：运行网站与 CloudBase 范围门禁**

Run:

```powershell
pnpm.cmd verify:cloudbase
pnpm.cmd verify:website
pnpm.cmd test:cloudbase-tools
if (Test-Path 'tools/run-cloudbase-development-migrations.test.mjs') { node --test tools/run-cloudbase-development-migrations.test.mjs }
pnpm.cmd verify:web-chain:fast
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 880502c..HEAD
```

Expected: 全部通过。若 `verify:website` 的浏览器测试因环境故障失败，先按系统化调试查明原因；不得放宽到跳过业务断言。

- [ ] **Step 4.2：执行规格复核与代码质量复核**

两个复核分别检查：

- 规格：上海单地域、零费用、投稿关闭、无桌宠越界、无生产部署。
- 代码：入口默认拒绝、凭据不泄漏、没有第二套迁移器、没有遗留 `intl`、没有无关新增。

任何 P0/P1 问题必须回到定向 RED → GREEN 修复；修复后重跑 Step 4.1。

完成标准：本地改造可独立验收，且尚未触碰云端资源。

---

## Task 5：生成旧上海环境删除预览并暂停等待二次确认

**Files:**

- Modify: `docs/operations/cloudbase-deployment.md`
- No repository code changes

- [ ] **Step 5.1：重新读取旧环境真实清单**

通过控制台和官方 CLI 只读核对：

- 环境 ID 必须精确为 `ai-pet-scanner-dev-d8cqh04af371e`。
- 地域必须为 `ap-shanghai`，套餐必须为免费体验版，数据库仍为传统模式。
- 资源必须与当前清单一致：0 个函数、1 个已暂停 Scanner、空存储、0 条网关路由、1 个旧管理员账号及旧安全域名。

Run:

```powershell
pnpm.cmd exec cloudbase -e ai-pet-scanner-dev-d8cqh04af371e -r ap-shanghai env delete --dry-run --json
```

Expected: 只返回预览，不提交删除；若环境 ID、地域或资源清单变化，停止并重新定界。

- [ ] **Step 5.2：向用户请求行动时第二次确认**

必须明确展示：

- 将永久删除的环境 ID 与资源清单。
- 数据、旧 Scanner、旧管理员、安全域名、日志不可恢复。
- 不会删除任何新加坡环境、账号级 CAM、账单、域名或其他腾讯云资源。
- 是否需要备份；只有用户明确回答“不需要并确认删除”后才进入 Task 6。

完成标准：停在实际删除按钮或提交命令之前；设计批准和计划批准均不能替代本次二次确认。

---

## Task 6：销毁旧环境并创建上海 PG 零元环境

**Files:**

- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`

- [ ] **Step 6.1：在二次确认后删除精确旧环境**

使用官方控制台提交删除，不使用 `--yes`、`BypassCheck` 或任何跳过校验参数。删除后核对环境不再可用，并报告被删除内容不可恢复。

- [ ] **Step 6.2：等待免费环境名额释放**

只使用官方状态检查；不循环高频请求。若进入隔离期或当月销毁次数限制，记录 `blocked` 并停止，不购买临时环境。

- [ ] **Step 6.3：创建新环境**

在最终提交页逐项核对：

- 地域：上海 `ap-shanghai`
- 数据库：PostgreSQL
- 套餐：免费体验版
- 应付金额：`0 元`
- 按量计费、自动续费、付费资源包：均未启用

显示名称优先使用 `ai-pet-scanner-dev`；平台生成的新环境 ID 不预设、不复用旧 ID。

- [ ] **Step 6.4：记录并验证新环境事实**

记录新环境 ID、地域、PG 模式、免费套餐、到期日、3000 资源点状态。再次从环境概览和 PostgreSQL 页面证明它不是传统/MySQL 模式。

在当前 PowerShell 会话中把控制台实际返回的新 ID 保存为运行时变量，并校验格式；不得把旧 ID 当默认值：

```powershell
$stage2cEnvId = Read-Host '请输入刚创建的上海 PostgreSQL 环境 ID'
if ($stage2cEnvId -notmatch '^[a-z][a-z0-9-]{3,63}$') { throw '新环境 ID 格式无效' }
$env:CLOUDBASE_ENV_ID = $stage2cEnvId
```

完成标准：获得唯一的新上海 PG 免费环境；实际支付为 0 元，未开启未来自动收费。

---

## Task 7：使用临时凭据执行真实 migration 失败、并发、重试与幂等验证

**Files:**

- Modify if tests reveal defects: `tools/run-cloudbase-development-migrations.mjs`
- Modify if tests reveal defects: `tools/run-cloudbase-development-migrations.test.mjs`
- Modify: `docs/operations/cloudbase-deployment.md`

- [ ] **Step 7.1：取得官方临时凭据但不打印**

Run interactively:

```powershell
pnpm.cmd exec cloudbase login --flow web
```

随后在一个不中断的 PowerShell `try/finally` 会话块内执行 Task 7.1–7.5。以下片段从 `try` 开始捕获 stdout；赋值表达式不会把原始 JSON 显示在终端，stderr 也不回显。CLI banner 存在时只截取首个 JSON 对象；解析或退出码异常只抛通用错误，不拼接原始输出：

```powershell
try {
  $stage2cCredentialLines = @(& pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai secrets get --json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw '获取 CloudBase 临时凭据失败' }
  $stage2cJsonStart = -1
  for ($stage2cIndex = 0; $stage2cIndex -lt $stage2cCredentialLines.Count; $stage2cIndex += 1) {
    if ($stage2cCredentialLines[$stage2cIndex].TrimStart().StartsWith('{')) {
      $stage2cJsonStart = $stage2cIndex
      break
    }
  }
  if ($stage2cJsonStart -lt 0) { throw 'CloudBase 临时凭据响应格式无效' }
  $stage2cCredential = ($stage2cCredentialLines[$stage2cJsonStart..($stage2cCredentialLines.Count - 1)] -join "`n") | ConvertFrom-Json
  if ($stage2cCredential.isTemporary -ne $true -or -not $stage2cCredential.token) { throw 'CloudBase 未返回临时会话凭据' }
  $env:TENCENTCLOUD_SECRETID = $stage2cCredential.secretId
  $env:TENCENTCLOUD_SECRETKEY = $stage2cCredential.secretKey
  $env:TENCENTCLOUD_SESSIONTOKEN = $stage2cCredential.token

  # Task 7.2–7.5 的命令全部在本 try 块内执行。
} finally {
  Remove-Item Env:TENCENTCLOUD_SECRETID -ErrorAction SilentlyContinue
  Remove-Item Env:TENCENTCLOUD_SECRETKEY -ErrorAction SilentlyContinue
  Remove-Item Env:TENCENTCLOUD_SESSIONTOKEN -ErrorAction SilentlyContinue
  Clear-Variable stage2cCredentialLines,stage2cCredential,stage2cJsonStart,stage2cIndex -ErrorAction SilentlyContinue
}
```

禁止打印上述变量、原始行或 `$stage2cCredential`。不得在 Task 7.5 完成前退出 `try`；任何解析、preview、push、poll 或验证异常都必须先执行同一 `finally`。

- [ ] **Step 7.2：核对只读 plan hash 与远端空历史**

Run:

```powershell
pnpm.cmd plan:cloudbase-migrations
```

Expected: 13 个 migration、版本严格递增、plan hash 与执行入口预期值一致；`listApplied` 返回空列表。

本计划写入时的已验证 plan hash 为：

```powershell
$stage2cPlanHash = 'ae6095d471e0f7056b25cec286694a1706fe851538ec6adce4f12debf851ee09'
```

若运行时 dry-run 返回其他值，停止并审查 migration 差异，不更新变量来绕过校验。

**2026-09-01 本地证据：** 仅运行只读的 `pnpm.cmd plan:cloudbase-migrations`，生成的 `planSha256` 与上值完全一致。该命令未加载远端凭据；由于 Task 3 与 Task 5–10 已裁剪，未执行 `listApplied` 或本节任何远端步骤，未提交本地 plan，也未创建远端 TaskId。

- [ ] **Step 7.3：验证真实任务失败后不污染历史**

使用当前 inventory 的第一条 migration，保持相同 Version/Name，但只在内存中给 Query 追加固定非法 SQL `SELECT FROM;`：

1. preview 必须可执行。
2. push 返回 TaskId 后持续轮询，最终必须为 `Failed`；不能把 TaskId 当成功。
3. `listApplied` 必须证明该 Version 未被记录。
4. 若失败 migration 被写入历史，立即停止；不得调用 repair 或手改历史。

该 probe 逻辑使用 Task 3 已测试的显式 `--stage2c-probe` 路径；不得接受用户自定义 SQL。若官方 preview 在提交前直接拒绝非法 SQL，则记录平台真实行为；由于这不能证明“真实任务失败”，本项记为未通过并使阶段 2C 保持 `blocked`，不得伪造 TaskId。

Run:

```powershell
pnpm.cmd run:cloudbase-migrations:development -- --environment-class development --env-id $stage2cEnvId --expected-plan-sha256 $stage2cPlanHash --stage2c-probe
```

- [ ] **Step 7.4：验证并发与整轮锁**

在远端仍为空历史时，由同一个 runner 对同一份完整、hash 已锁定的 13 条 inventory 发起恰好两次几乎同时的 push，并轮询全部返回的 TaskId。这是全计划唯一并发写例外；开始前再次确认没有函数部署、控制台配置或其他迁移写操作正在进行：

- 接受：一个成功、另一个失败或被平台判定重复；或两个任务均成功但最终历史每个版本只有一条且 checksum 完全一致。
- 拒绝：重复历史、部分提交后无可解释状态、checksum 漂移或未知任务状态。

不要并发执行其他云端写操作。

- [ ] **Step 7.5：验证重试、续跑和 up-to-date**

以正式执行入口再次运行同一 plan：

```powershell
pnpm.cmd run:cloudbase-migrations:development -- --environment-class development --env-id $stage2cEnvId --expected-plan-sha256 $stage2cPlanHash --execute
```

Expected:

- 若并发中有任务只提交部分版本，续跑只应用 pending。
- 最终 13 条全部存在且 checksum 一致。
- 再运行一次返回 `outcome: up-to-date`。

离开 Step 7.5 时由 Step 7.1 的 `finally` 无条件清理；文档只记录环境 ID、脱敏 TaskId、最终状态、migration 数量与 plan hash。

完成标准：真实 PG 环境有失败关闭、并发、重试、续跑和幂等证据，且没有修改历史 migration。

---

## Task 8：配置私有存储、身份与零费用内容安全前置条件

**Files:**

- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`

- [ ] **Step 8.1：验证 PG Storage 私有 Bucket 契约**

通过 migration 和官方 PG Storage 页面确认逻辑 Bucket `ai-pet-private` 存在并为私有访问。验证：

- 匿名无法列举或读取对象。
- 通过受控 API 生成的上传 URL 有短 TTL。
- 完成上传后按 object key、size、sha256 复核对象身份。
- 下载 URL 有短 TTL，过期后失效。
- 从一条脱敏真实短期下载 URL 中只提取并记录 host 与查询参数名称集合，不记录完整 URL、路径、签名值或 token；该 host 和参数名集合是 Task 9 的 `SCANNER_DOWNLOAD_HOSTS` 与 `SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS` 唯一输入。

不得把平台物理 Bucket 名写死到业务代码，也不得公开持久对象地址。

- [ ] **Step 8.2：清理旧身份假设并创建唯一管理员**

管理员邮箱由用户在执行时通过安全输入提供，只用于 CloudBase 身份和函数环境变量，不写入仓库或验收日志。验证普通账号不能获得管理员角色。

- [ ] **Step 8.3：持久 API Key 与 Publishable Key 行动时确认**

只有服务端 RPC 或网站登录 smoke 确实需要时才创建对应 Key：

- `CLOUDBASE_API_KEY` 是仅供三个函数使用的服务端高权限 Key，绝不进入前端或文档。
- `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` 是浏览器公开、长期有效且官方页面可能不支持删除的 Publishable Key。

创建任一持久 Key 前必须分别说明用途、权限、有效期和可删除性并取得行动时确认。未确认时停在创建按钮之前。

- [ ] **Step 8.4：TMS/IMS 零费用门禁**

只在控制台明确显示 3000 条/张、15 天试用、`0 元` 且试用结束不会自动转按量计费时开通。若需要开通按量后付费或价格含糊，记录外部阻塞，不启用服务。

完成标准：存储和身份边界可用；所有持久密钥与内容安全试用都经过行动时确认和零费用检查。

---

## Task 9：部署三个既有函数与 Scanner，不改变业务架构

**Files:**

- Read/Use: `cloudbaserc.json`
- Read/Use: `apps/package-scanner/Dockerfile`
- Modify only if a verified defect exists: `cloudbaserc.json`
- Modify: `docs/operations/cloudbase-deployment.md`

- [ ] **Step 9.1：再次执行免费函数能力门禁**

在新环境函数创建/配置页核对 30/900/300 秒配置是否真的可保存且仍为 0 元。若任一函数被固定为 3 秒或需要付费，阶段 2C 记为 `blocked`，不缩短业务超时、不改成第二套服务。

- [ ] **Step 9.2：本地构建并部署三个函数**

Run:

```powershell
pnpm.cmd build:cloudbase
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn deploy ai-pet-api --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn deploy ai-pet-moderation-worker --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn deploy ai-pet-cleanup --json
```

不得使用 `--force`。`ai-pet-api` 保持 Event 类型并由网关以 `SCF` 上游暴露；另两个 worker 保持 Event 类型。分别核对 Node.js 20.19、入口和超时与 `cloudbaserc.json` 一致；免费版内存以控制台固定默认 256 MB 为事实来源，配置未声明 `memorySize` 时不得声称它来自仓库。

- [ ] **Step 9.3：只写入各 loader 实际读取的最小环境变量**

共同变量：`CLOUDBASE_ENV_ID`、`PRIVATE_BUCKET_ID=ai-pet-private`、`CLOUDBASE_REGION=ap-shanghai`。

API 额外变量：`CLOUDBASE_API_KEY`、`ADMIN_EMAIL`、`ABUSE_HMAC_SECRET`、`SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。

审核 worker 额外变量：`CLOUDBASE_API_KEY`、`MODERATION_SECRET_ID`、`MODERATION_SECRET_KEY`、可选 `MODERATION_SESSION_TOKEN`、`MODERATION_REGION=ap-shanghai`、`TMS_BIZ_TYPE`、`IMS_BIZ_TYPE`、`SCANNER_URL`、`SCANNER_HMAC_SECRET`。

cleanup 额外变量：`CLOUDBASE_API_KEY`。

逐个进入 `ai-pet-api`、`ai-pet-moderation-worker`、`ai-pet-cleanup` 的“函数配置 → 环境变量”页面，写入对应最小集合并保存；随后重新打开配置页，只记录变量名、是否为掩码值和保存时间，不读取或截图 Secret 值。不把一个函数的 Secret 复制给无关函数；所有密钥只在控制台 Secret/环境配置中写入。

- [ ] **Step 9.4：部署 Scanner CloudBase Run**

当前 CloudBase CLI 3.7.0 的新 `cloudrun deploy --source` 只能把 `--source` 目录作为 Docker build context，不能选择目录外的 Dockerfile；现有 Scanner Dockerfile 必须以 workspace 根目录为 context。为避免复制 workspace 或新增第二份 Dockerfile，本次使用同一官方 CLI 仍保留的 legacy deploy 参数指定根 context 与现有 Dockerfile；不得传 `--noConfirm` 或 `--override`：

```powershell
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai run deploy -s ai-pet-package-scanner --path . --dockerfile apps/package-scanner/Dockerfile --containerPort 8080 --mem 1 --minNum 0 --maxNum 1 --json
```

CLI 会明确提示该入口已废弃；它只用于解决当前 workspace build context，不引入仓库兼容代码。若官方后端拒绝该命令，停止并使用控制台的“根目录上传 + 指定 Dockerfile”能力；若控制台也不支持，记为 `blocked`，不复制三份共享 package 源码绕过。

进入 `ai-pet-package-scanner` 的“服务配置 → 环境变量”，逐项写入并保存：`SCANNER_INTERNAL_SECRET`、Task 8 得到的 `SCANNER_DOWNLOAD_HOSTS`、Task 8 得到的 `SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS`、`TENCENT_CLOUD_REGION=ap-shanghai`、可选 `TENCENT_IMS_BIZ_TYPE`、临时腾讯云凭据和 `PORT=8080`。重新打开页面，只记录变量名与掩码状态，不记录值。

控制台同时核对：Node 22 镜像、非 root、内存至少 1 GB、最大实例 1、最小实例 0；只有控制台明确提供并成功保存时，才能把单实例并发 1 写为通过，否则本项 `blocked`。不创建固定最小实例。

- [ ] **Step 9.5：部署后最小 smoke**

验证：

- Scanner `/healthz` 返回 200。
- API 在投稿关闭时拒绝共享包投稿。
- 缺少或错误 HMAC 时 Scanner 拒绝。
- 三函数缺少必要 Secret 时失败关闭且日志不泄漏值。

完成 smoke 后确认 Scanner 最小实例恢复为 0，并读取资源点余额；若接近上限立即停止。

完成标准：三个函数和 Scanner 均部署在同一新上海免费环境，配置最小且没有常驻付费实例。

---

## Task 10：配置网关、CORS、触发器并完成真实链路 smoke

**Files:**

- Modify only if real event proves compatibility defect: `apps/cloudbase-api/src/functions/api.ts`
- Modify corresponding test first when needed: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`

- [ ] **Step 10.1：采集脱敏真实 HTTP event/path**

先用最小测试路由采集 path、method、headers 的结构，不记录 Authorization 值、Cookie、管理员邮箱或请求正文。根据真实事件裁决现有 `createApi/dispatch` 是否已兼容 `/v1/` 前缀。

若需要代码修复，必须先添加真实形状的失败测试，再做最小修复；不得同时保留第二套 Router。

- [ ] **Step 10.2：配置唯一网关路由与最小 CORS**

从新环境 HTTP 网关页面读取平台分配的测试域名，保存为 `$stage2cGatewayDomain` 并验证它属于当前环境；不得填正式域名。路由只指向 Event 类型的 `ai-pet-api`：管理员前缀开启网关认证并启用路径透传，公开前缀保持匿名且不启用路径透传，由应用层继续区分具体端点；两者均启用安全域名。

```powershell
$stage2cGatewayDomain = Read-Host '请输入当前上海开发环境的 HTTP 网关测试域名（不含协议）'
if ($stage2cGatewayDomain -notmatch '^[a-z0-9.-]+$') { throw 'HTTP 网关域名格式无效' }
$stage2cRouteData = @{
  domain = $stage2cGatewayDomain
  routes = @(
    @{ path = '/api/v1/admin'; upstreamResourceType = 'SCF'; upstreamResourceName = 'ai-pet-api'; enable = $true; enableAuth = $true; enableSafeDomain = $true; enablePathTransmission = $true },
    @{ path = '/api'; upstreamResourceType = 'SCF'; upstreamResourceName = 'ai-pet-api'; enable = $true; enableAuth = $false; enableSafeDomain = $true; enablePathTransmission = $false }
  )
} | ConvertTo-Json -Compress -Depth 6
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai routes add --data $stage2cRouteData --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai cors add http://localhost:3000 --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai routes list --filter "Domain=$stage2cGatewayDomain" --json
```

路由创建后、发送业务请求前，在控制台把总 QPS 与单客户端 QPS 都设为免费环境允许的最低正整数并保存；记录平台实际最小值，不预设生产容量。随后再次核对认证、请求头透传、QPS 和 CORS；CORS 只允许本地测试来源，不绑定正式域名。若真实网关不支持更具体的管理员前缀优先匹配，停止并先补规格，不把整个 `/api/v1` 强制认证而破坏匿名接口。

验证：错误或缺失管理员令牌为 401，非管理员为 403；网关认证与应用层邮箱/角色校验都生效。

- [ ] **Step 10.3：配置并验证两个临时定时触发器**

阶段 2C 投稿保持关闭，因此不保留持续消耗免费资源点的生产频率。创建以下临时七段 cron 触发器：

```powershell
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn trigger create ai-pet-moderation-worker --trigger-name stage2c_moderation_probe --cron "0 */2 * * * * *" --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn trigger create ai-pet-cleanup --trigger-name stage2c_cleanup_probe --cron "30 */2 * * * * *" --json
```

观察每个函数至少一次真实触发，验证空队列幂等、失败关闭和脱敏日志后立即删除这两个 probe 触发器。正式频率留给阶段 5 生产规格裁决；不得把临时频率写成生产配置。

```powershell
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn trigger delete ai-pet-moderation-worker stage2c_moderation_probe --json
pnpm.cmd exec cloudbase -e $stage2cEnvId -r ap-shanghai fn trigger delete ai-pet-cleanup stage2c_cleanup_probe --json
```

- [ ] **Step 10.4：执行开发环境完整 smoke**

至少覆盖：

1. 投稿关闭与反馈不直接公开。
2. 状态令牌只存在 URL Fragment，不进入日志或 Referer。
3. 私有上传、对象身份校验与短期下载 URL。
4. 系统审核、管理员直接转人工、普通批准、未通过也可由管理员强制发布、删除与恢复。
5. 强制发布保留原扫描事实、风险确认、公开覆盖标记与审计记录。
6. Scanner 干净包、EICAR、超时、IMS 错误与并发限制。
7. moderation 与 cleanup 的触发、幂等、失败关闭和可观察日志。
8. 即时只读记录资源点与账单页面、确认按量能力和自动续费仍关闭、Scanner 最小实例为 0；因统计可能延迟，此时费用结论保持 `unverified（等待资源点统计）`，不据即时数字宣称零费用通过。

任一强制项未通过则阶段 2C 为 `blocked`，投稿继续关闭。

完成标准：真实网关、身份、存储、审核、Scanner 和定时任务形成同一环境的可复核证据。

---

## Task 11：做减法、更新单一事实来源并完成最终验证

**Files:**

- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`
- Modify: `docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`
- Create: `docs/operations/website-stage-2c-shanghai-acceptance.md`

- [ ] **Step 11.1：清理被替代的有效入口**

删除或退役：

- 现行手册中的新加坡地域说明。
- 只服务旧环境 ID、旧域名、旧 Scanner 或旧管理员的有效配置说明。
- 实施中临时生成的 probe 配置、临时路由、测试 cron 和本地凭据变量。
- 从函数与 Scanner 云端配置中删除本次 smoke 注入的全部临时腾讯云凭据，无论它们是否仍在有效期；投稿关闭期间不保留会持续调用内容安全的触发器。
- 若 `--stage2c-probe` 只服务一次性验收，则在保存云端证据后先写删除测试，再从正式 runner 中删除该分支；保留日常 development migration 执行入口。

不得批量删除历史规格或 migration；大量文件删除仍需用户第二次批准。

- [ ] **Step 11.2：写独立验收记录**

验收文件必须包含：日期、环境 ID、地域、PG/免费套餐证据、实际命令、脱敏 TaskId、迁移 plan hash、函数/Scanner 版本、网关/触发器配置、smoke 结果、资源点与费用、临时运行凭据已删除且环境已转为投稿关闭的 dormant 状态、未验证项和最终状态。

只允许三种结论：

- `pass`：全部强制本地和云端证据通过。
- `blocked`：免费套餐或外部试用不能满足强制能力，或任一强制 smoke 失败。
- `unverified`：尚未执行远端步骤。

不得把 `pass` 写成正式部署或生产上线；投稿是否解冻单独裁决。

CloudBase 官方说明资源点统计可能延迟，最长按 48 小时窗口处理。同次部署/smoke 完成后先把费用结论写为 `unverified（等待资源点统计）`；在 48 小时后重新只读核对资源点、账单、按量开关和自动续费均无异常，才能把费用门改为通过并裁决最终 `pass`。该等待是外部结算窗口，不通过长时间阻塞命令实现。

- [ ] **Step 11.3：运行最终门禁**

Run:

```powershell
pnpm.cmd test:cloudbase-tools
if (Test-Path 'tools/run-cloudbase-development-migrations.test.mjs') { node --test tools/run-cloudbase-development-migrations.test.mjs }
pnpm.cmd verify:cloudbase
pnpm.cmd verify:website
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 880502c..HEAD
git diff --check
git status --short
```

Expected: 所有适用门禁通过；没有桌宠路径改动、Secret、临时文件或未解释差异。

- [ ] **Step 11.4：最终规格复核与代码复核**

分别复核规格符合性与代码质量。任何 P0/P1 问题在本分支修正并重跑 Step 11.3；不执行合并。

- [ ] **Step 11.5：提交验收与文档**

```powershell
git add docs/operations/cloudbase-deployment.md docs/operations/content-moderation.md docs/operations/website-stage-2c-shanghai-acceptance.md docs/superpowers/plans/2026-08-15-website-optimization-index.md docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md
git commit -m "docs(web): 记录上海阶段2C验收结果"
```

完成标准：文档、代码和真实云端状态一致；旧正式路径已做减法；最终状态有证据且没有被误写为生产上线。

---

## 任务停点与恢复规则

- Task 1 的免费函数能力门禁失败：停在删除前，阶段 2C 为 `blocked`。
- Task 5 未取得二次删除确认：停在删除提交前，现有环境保持不变。
- Task 6 免费名额未释放或最终金额不为 0 元：停止，不创建付费环境。
- Task 7 失败 migration 污染历史或 migration checksum 冲突：停止，不 repair、不手改历史。
- Task 8 持久 Key 未获行动时确认：停止创建 Key；其他不依赖该 Key 的只读检查可继续。
- Task 9 免费函数超时或 Scanner 配置不满足：阶段 2C 为 `blocked`，不修改业务语义绕过。
- 任一云端步骤遇到验证码、权限不足、费用提示或未知资源：停在提交动作前，保留已有证据并报告。

## 完成定义

阶段 2C 只有在 Task 1–11 的适用步骤全部完成、最终门禁通过、上海 PG 环境真实 smoke 通过，且 48 小时资源点统计窗口后仍证明没有超额账单或付费能力时才是 `pass`。若按硬约束停在 `blocked`，该状态也是本计划的正确、安全执行结果，但不代表阶段 2C 已达标，更不能进入正式生产部署。
