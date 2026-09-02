# 网站阶段 2C 零费用人工审核实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最少云端组件完成上海 CloudBase 阶段 2C：投稿直入人工队列，共享包由本地 Docker 辅助检查并通过现有 `force_publish` 发布，同时删除会产生费用或重复职责的远程自动审核链。

**Architecture:** 云上只保留静态网站、PostgreSQL、私有存储、API 和 cleanup；包扫描器收缩为无网络的一次性本地 Docker CLI。反馈走人工普通批准，共享包在没有有效系统证据时走现有强制发布并公开 `admin_override`。状态切换和数据库减法使用两个不可变前向 migration，确保中间提交仍可验证。

**Tech Stack:** pnpm workspace、TypeScript、Vitest、Node.js test runner、Next.js 15、CloudBase JS SDK V3、CloudBase PostgreSQL、Docker、ClamAV、Playwright。

**适用规格:** `docs/superpowers/specs/2026-09-01-website-stage-2c-zero-cost-manual-review-design.md`

## 全局约束

- 只修改网站业务白名单；禁止修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**` 和 `packages/character-assets/**`。
- 只在当前 `WebsiteExtension` 分支进行 Git 写操作；禁止 merge、rebase、push、PR 和破坏性回退。
- 每项行为修改执行 RED → GREEN → REFACTOR，先证明测试因预期原因失败。
- 用现有状态机、`force_publish`、审计和扫描内核完成目标；不得新增第二套状态机、报告上传或本地扫描可信凭证体系。
- 替代路径通过定向门禁后，删除旧自动审核实现、入口、协议、依赖和只服务旧路径的测试。
- 大量文件删除前，由主智能体展示精确清单并取得行动时第二次明确确认；确认前可以完成不含删除的任务。
- 单个问题主动排查超过 15 分钟仍无进展时换方案或收缩范围；单任务运行上限 40 分钟。
- 面向人的文档和结构性代码注释使用中文；不得写入密钥、管理员邮箱、私有对象地址或主机绝对路径。
- 每个 Task 由独立实现子智能体执行并提交；随后由另一子智能体做规格符合性和代码质量复审。主智能体维护 `.superpowers/sdd/<plan-name>/progress.md`。

## Task 1：固化规格、计划与网站范围门禁

**Files:**

- Create: `docs/superpowers/specs/2026-09-01-website-stage-2c-zero-cost-manual-review-design.md`
- Create: `docs/superpowers/plans/2026-09-01-website-stage-2c-zero-cost-manual-review.md`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/website/components/admin/AdminDetail.tsx`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/production-driver.test.ts`

- [x] **Step 1.1：RED**

在 scope 单测中加入本计划新增的两个文档、两个 migration、本地 Scanner CLI/测试和阶段 2C 验收文件的精确允许路径，并确认现有策略拒绝这些路径。

Run:

```powershell
node --test tools/verification/verify-website-scope.test.mjs
```

Expected: 新增路径断言因白名单缺失而失败，现有越界拒绝断言仍通过。

- [x] **Step 1.2：GREEN 与减法复核**

只扩展精确路径或既有网站目录规则，不放宽桌宠路径，不增加通配到仓库根目录。检查新规格明确替代 CloudBase Run/TMS/IMS/worker，并保留管理员强制发布与公开风险标记。

- [x] **Step 1.3：验证并提交**

```powershell
node --test tools/verification/verify-website-scope.test.mjs
pnpm.cmd verify:web-chain:scope
git diff --check
git add docs/superpowers/specs/2026-09-01-website-stage-2c-zero-cost-manual-review-design.md docs/superpowers/plans/2026-09-01-website-stage-2c-zero-cost-manual-review.md tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs
git commit -m "docs(web): 采用零费用人工审核方案"
```

完成标准：新方案有单一规格与可执行计划，网站范围门禁只允许计划中的精确新增文件。

---

## Task 2：投稿直入人工队列并增加前向 migration

**Files:**

- Modify: `packages/shared-types/src/moderation.ts`
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/moderation.test.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/cloudbase-api/src/services/submission-service.ts`
- Modify: `apps/cloudbase-api/src/services/text-submission-service.ts`
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts`
- Modify: `apps/cloudbase-api/tests/text-submission-service.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Create: `cloudbase/migrations/20260901000000_zero_cost_manual_review.sql`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`

- [x] **Step 2.1：RED**

先把 HTTP 回执、服务、Memory Adapter 和真实 PostgreSQL 行为测试改为期望 `manual_review_pending`。增加真实 SQL 断言：共享包完成上传与反馈创建直入人工队列；既有 `system_reviewing` 迁移时版本递增、worker 运行态清空、历史 `moderation_results` 与风险字段不变；无有效证据的共享包普通批准仍返回 `TECHNICAL_SCAN_REQUIRED`，强制发布仍写入 `admin_override`。

Run:

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/cloudbase-api test -- tests/submission-service.test.ts tests/text-submission-service.test.ts tests/api.test.ts tests/cloudbase-postgres.test.ts
node --test tools/test-cloudbase-migrations.test.mjs
```

Expected: 旧 `system_reviewing` 实现或缺失 migration 导致新增断言失败。

- [x] **Step 2.2：GREEN**

以最小修改完成：

- finalize 与反馈回执字面量改为 `manual_review_pending`；
- 服务消费 store 的真实状态，不重复硬编码第二份状态；
- 新 migration 只覆盖 `create_text_submission`、`complete_submission_upload` 和遗留状态迁移，保留所有对象/MIME/大小、审计和发布结构校验；
- migration 行为门从全部历史文件动态读取执行顺序，测试只更新到实际可证明的 migration 数量和行为数。

- [x] **Step 2.3：验证并提交**

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
node tools/test-cloudbase-migrations.mjs
node --test tools/test-cloudbase-migrations.test.mjs
git diff --check
git add packages/shared-types apps/cloudbase-api tests/memory-website-api.mjs cloudbase/migrations/20260901000000_zero_cost_manual_review.sql tools/test-cloudbase-migrations.mjs tools/test-cloudbase-migrations.test.mjs
git commit -m "refactor(web): 投稿直接进入人工审核"
```

完成标准：新投稿不再依赖 worker；强制发布、历史事实和发布结构安全边界保持不变。

---

## Task 3：删除 CloudBase 自动审核运行链

**Files:**

- Delete: `apps/cloudbase-api/src/functions/moderation-worker.ts`
- Delete: `apps/cloudbase-api/src/services/moderation-service.ts`
- Delete: `apps/cloudbase-api/src/services/keyword-relevance.ts`
- Delete: `apps/cloudbase-api/src/adapters/tencent-content-moderation.ts`
- Delete: `apps/cloudbase-api/src/adapters/scanner-client.ts`
- Delete: `apps/cloudbase-api/tests/moderation-worker.test.ts`
- Delete: `apps/cloudbase-api/tests/moderation-service.test.ts`
- Delete: `apps/cloudbase-api/tests/keyword-relevance.test.ts`
- Delete: `apps/cloudbase-api/tests/tencent-content-moderation.test.ts`
- Delete: `apps/cloudbase-api/tests/scanner-client.test.ts`
- Modify: `apps/cloudbase-api/src/config.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/tests/config.test.ts`
- Modify: `apps/cloudbase-api/tests/build-output.test.ts`
- Modify: `apps/cloudbase-api/tests/ports.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/support/cloudbase-production.ts`
- Modify: `apps/cloudbase-api/package.json`
- Modify: `.dependency-cruiser.mjs`
- Modify: `tools/build-cloudbase-functions.mjs`
- Modify: `tools/build-cloudbase-functions.test.mjs`
- Modify: `cloudbaserc.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 3.1：删除行动门**

主智能体逐项展示本 Task 的十个删除文件，确认它们只服务自动审核且 Git 可恢复，并取得用户第二次明确批准。未取得批准时不得执行本 Task。

- [x] **Step 3.2：RED**

先修改构建产物、配置和依赖测试，使其期望仅有 `api` 与 `cleanup` 两个函数入口，拒绝 moderation worker 环境变量与入口，并确认旧实现导致失败。

- [x] **Step 3.3：GREEN 与删除**

删除 worker 函数、服务、Tencent Adapter、Scanner Client、专用端口和对应测试；从 `cloudbaserc.json`、构建工具和配置 loader 删除 worker；从 CloudBase API 依赖中删除 `tencentcloud-sdk-nodejs`。保留 cleanup、管理员服务、`moderation_results` 读取和强制发布。

- [x] **Step 3.4：验证并提交**

```powershell
pnpm.cmd install --lockfile-only
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd build:cloudbase
node --test tools/build-cloudbase-functions.test.mjs
pnpm.cmd verify:web-chain:ownership
git diff --check
git add apps/cloudbase-api cloudbaserc.json tools/build-cloudbase-functions.mjs tools/build-cloudbase-functions.test.mjs pnpm-lock.yaml
git commit -m "refactor(web): 删除云端自动审核链"
```

完成标准：CloudBase 产物只剩两个函数，不存在可达的 TMS/IMS/远程 Scanner 或审核 worker 代码与依赖。

---

## Task 4：把包扫描器收缩为本地 Docker CLI

**Files:**

- Create: `apps/package-scanner/src/local-scan-cli.ts`
- Create: `apps/package-scanner/src/clamav-command-scanner.ts`
- Create: `apps/package-scanner/tests/local-scan-cli.test.ts`
- Create: `apps/package-scanner/tests/clamav-command-scanner.test.ts`
- Modify: `apps/package-scanner/src/scan-package.ts`
- Modify: `apps/package-scanner/tests/scan-package.test.ts`
- Modify: `apps/package-scanner/Dockerfile`
- Modify: `apps/package-scanner/vite.build.config.ts`
- Modify: `apps/package-scanner/package.json`
- Modify: `tools/verification/verify-scanner-candidate.mjs`
- Modify: `tools/verification/verify-scanner-candidate.test.mjs`
- Modify: `pnpm-lock.yaml`
- Delete: `apps/package-scanner/src/server.ts`
- Delete: `apps/package-scanner/src/request-signature.ts`
- Delete: `apps/package-scanner/tests/server.test.ts`
- Delete: `apps/package-scanner/tests/request-signature.test.ts`
- Delete: `apps/package-scanner/tests/adapters.test.ts`
- Delete: `packages/shared-types/src/scanner-protocol.ts`
- Delete: `packages/shared-types/tests/scanner-protocol.test.ts`

- [x] **Step 4.1：删除行动门**

Task 3 的二次确认同时列出并覆盖本 Task 的七个删除文件；若清单或范围变化，必须重新确认变化部分。

- [x] **Step 4.2：RED**

先增加 CLI 与 Docker 候选测试，固定以下契约：单个 ZIP 路径输入；结构与 ClamAV 复用现有扫描内核；图片产生 `manual-review-required` 信号；输出含 `manualReviewRequired: true`；错误退出码非零；不监听端口、不读取腾讯凭据或 Secret；镜像可在 `--network none`、只读输入、非 root 下运行；EICAR 被阻断。

- [x] **Step 4.3：GREEN 与删除**

提取 `ClamAvCommandScanner`，新增薄 CLI，向现有 `scanPackage` 注入只返回人工检查信号的本地图片审核器。删除 HTTP server、HMAC、远程下载、IMS Adapter、共享 Scanner 网络协议及 `tencentcloud-sdk-nodejs`。Dockerfile 只构建 CLI，不暴露端口或 healthcheck。

- [x] **Step 4.4：验证并提交**

```powershell
pnpm.cmd install --lockfile-only
pnpm.cmd --filter @myself/package-scanner test
pnpm.cmd --filter @myself/package-scanner typecheck
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/shared-types typecheck
node --test tools/verification/verify-scanner-candidate.test.mjs
pnpm.cmd verify:scanner-candidate
pnpm.cmd verify:web-chain:ownership
git diff --check
git add apps/package-scanner packages/shared-types tools/verification/verify-scanner-candidate.mjs tools/verification/verify-scanner-candidate.test.mjs pnpm-lock.yaml
git commit -m "refactor(web): 扫描器收缩为本地容器工具"
```

完成标准：扫描器不再是云服务，只有一个本地 CLI 正式入口，且干净包/EICAR/结构失败均有容器级证据。

---

## Task 5：删除数据库 worker 结构并收敛网站契约测试

**Files:**

- Create: `cloudbase/migrations/20260901010000_remove_moderation_worker.sql`
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/website/components/website-experience/community/indexed-db-shared-pet-repository.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`
- Modify: `apps/website/tests/cloud-feedback-repository.test.ts`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `apps/website/tests/indexed-db-shared-pet-repository.test.ts`
- Modify: `apps/website/tests/shared-pet-chapter.test.tsx`
- Modify: `apps/website/tests/support-chapter.test.tsx`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `tests/website-contract/memory-driver.test.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tests/website-contract/website-api-contract.ts`

- [x] **Step 5.1：RED**

增加真实 PostgreSQL 断言：最新 schema 不再暴露三个 worker RPC、五个 worker 运行态列和专用索引，但 `moderation_results`、风险字段、管理员审计、强制发布和发布结构触发器仍存在。把 Memory/production contract 与 E2E 改为“投稿直入人工 → 反馈批准 / 共享包强制发布”，并删除只服务后到 worker、租约和自动重试的断言。

- [x] **Step 5.2：GREEN 与减法**

新增第二条前向 migration 删除 worker RPC、列和索引；从 Adapter/端口移除最后的 worker 字段与方法。删除 Memory API 的 `/__e2e/moderation/*` 入口和仅服务旧自动审核的数据操作。不得删除历史 `moderation_results` 或风险披露。

- [x] **Step 5.3：验证并提交**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
node tools/test-cloudbase-migrations.mjs
node --test tools/test-cloudbase-migrations.test.mjs
pnpm.cmd test:website-contract
pnpm.cmd test:e2e:website
git diff --check
git add cloudbase/migrations/20260901010000_remove_moderation_worker.sql apps/cloudbase-api/src apps/cloudbase-api/tests tools/test-cloudbase-migrations.mjs tools/test-cloudbase-migrations.test.mjs tests/memory-website-api.mjs tests/e2e/website.spec.ts tests/website-contract
git commit -m "refactor(web): 退役审核队列运行结构"
```

完成标准：数据库与测试环境都不再模拟不存在的 worker；强制发布风险、互动和反馈链继续通过。

---

## Task 6：更新运维、验收与替代入口

**Files:**

- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`
- Modify: `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`
- Modify: `docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/website/components/admin/AdminDetail.tsx`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/production-driver.test.ts`

- [x] **Step 6.1：文档减法**

把现行部署手册收敛为上海 PG、私有 Bucket、API、cleanup、身份、网关和静态托管；删除 CloudBase Run、TMS/IMS、Scanner Secret、moderation worker 部署与 smoke 步骤。内容审核手册改为本地 Docker 命令、报告解释、人工查看图片、普通批准/强制发布边界。

- [x] **Step 6.2：状态治理**

在旧上海重建规格和计划顶部标明其自动审核部分已被本规格替代；更新优化索引的当前入口。验收记录只写已执行事实：本地完成时写 `remote: unverified`，不得宣称正式上线。

- [x] **Step 6.3：验证并提交**

```powershell
rg -n "CloudBase Run|TMS|IMS|moderation-worker|SCANNER_HMAC_SECRET|SCANNER_INTERNAL_SECRET" docs/operations docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git add docs/operations docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md docs/superpowers/plans/2026-08-15-website-optimization-index.md
git commit -m "docs(web): 收敛零费用部署与人工审核手册"
```

Expected: 搜索结果只允许出现在“已退役/禁止部署”的历史说明或本规格中，不存在可执行的旧部署步骤。

完成标准：操作人员只会看到一条零费用正式路径，文档和实现一致。

---

## Task 7：完整本地门禁与全分支复审

**Files:**

- Modify: `.dependency-cruiser.mjs`
- Modify: `.dependency-cruiser.web.mjs`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`
- Modify: `apps/package-scanner/README.md`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/i18n.test.tsx`
- Modify: `apps/website/tests/shared-pet-chapter.test.tsx`
- Modify: `apps/website/tests/support-chapter.test.tsx`
- Modify: `cloudbase/migrations/20260901010000_remove_moderation_worker.sql`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/verification/verify-scanner-candidate.mjs`
- Modify: `tools/verification/verify-scanner-candidate.test.mjs`
- Modify: `tools/verification/web-dependency-audit.test.mjs`
- Modify: `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`
- Modify: `.superpowers/sdd/2026-09-01-website-stage-2c-zero-cost-manual-review/progress.md`（Git 忽略）

- [x] **Step 7.1：完整验证**

```powershell
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 5c914ef..HEAD
git status --short
```

Expected: 全部通过；没有桌宠路径、Secret、临时归档、CloudBase Run/TMS/IMS/worker 正式入口或未解释改动。

- [x] **Step 7.2：全分支复审**

由独立高级审查子智能体同时检查规格符合性与代码质量。发现 Critical/Important 时只发起一轮集中修复，再做一次范围复审；不得执行 merge、rebase 或 push。

- [x] **Step 7.3：记录本地验收**

把实际命令、日期、迁移数、行为验证数、测试数、本地 Docker 镜像摘要和未验证远端项写入验收记录后提交。只有观察到的结果才能写为通过。

完成标准：本地实现、测试、构建、Docker 和文档全部闭环；远端保持 `unverified`，等待行动时环境删除确认。

---

## Task 8：上海免费环境阶段 2C（远端、非生产）

**Files:**

- Modify: `tools/build-cloudbase-functions.mjs`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`
- Modify: `apps/cloudbase-api/tests/build-output.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`
- Modify: `apps/website/lib/admin-api-client.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`
- Modify: `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`
- Modify: `docs/operations/website-stage-2c-shanghai-acceptance.md`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`
- Modify: `apps/cloudbase-api/src/functions/cleanup.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cleanup-service.test.ts`
- Modify: `cloudbaserc.json`
- Modify: `tools/build-cloudbase-functions.test.mjs`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-zero-cost-manual-review.md`
- Modify: `docs/superpowers/specs/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md`
- Modify: `docs/superpowers/specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md`
- Modify: `docs/superpowers/specs/2026-09-01-website-stage-2c-zero-cost-manual-review-design.md`

- [x] **Step 8.1：不可逆删除行动门**

只读核对环境 `ai-pet-scanner-dev-d8cqh04af371e` 的地域、套餐和资源清单，展示删除预览并取得行动时第二次明确确认。没有确认不得销毁。

- [x] **Step 8.2：零费用创建门**

创建页必须明确显示上海、PostgreSQL、免费体验、应付 0 元、按量付费关闭、自动续费关闭；任一条件不满足立即停止。

- [x] **Step 8.3：最小部署**

顺序执行全部 16 条 migration（包括 `20260901020000_official_windows_download_click_metric.sql`），创建私有 Bucket，只部署 `ai-pet-api` 与 `ai-pet-cleanup`，配置身份、最小网关和静态托管。不得开通或部署 CloudBase Run、TMS、IMS、moderation worker。实际远端已完成这些最小部署项；`ai-pet-api` 与 `ai-pet-cleanup` 均为 Node.js 20.19 的 Event 函数，免费体验版实际固定超时 3 秒、内存 256 MB。静态构建使用目标环境 ID、Publishable Key 与网关 `/api/v1` 基址，67/67 个构建文件上传成功。此记录不包含任何密钥值，也不表示真实管理员业务 smoke 已完成。

- [ ] **Step 8.4：真实 smoke**

已通过的远端子项：公开社区 GET 返回 200；未认证管理员请求由网关返回 401 `MISSING_CREDENTIALS`；真实 OTP 管理员登录、双头认证、指标与详情读取通过；反馈完成批准发布、公开读取、点赞/撤赞、删除隔离与审计保留；官方下载计数公开写入与管理员读取通过。共享包使用私有 PNG/ZIP 实际上传，完成 5 分钟待审下载、两步 `force_publish`、三处公开风险提示、幂等下载计数、点赞/撤赞、隔离删除和精确物理清理；审计在清理后保留。初次 finalize 暴露 V3 双实例身份覆盖，已按 RED → GREEN 收敛为一个服务端实例并部署复验。`ai-pet-cleanup-daily` 已按仓库配置创建并启用；配置后另行直调返回 `claimed=0/purged=0/failed=0/expiredOperationsPurged=0`，自然定时投递尚未观察。开发环境日志会保存函数响应摘要，`IgnoreSysLog` 试验未能消除，因此只用于测试数据排障，正式上线前必须关闭或完成脱敏方案。现有代码没有共享资源留言/回复入口，而规格仍列出评论验收，须由用户确认是反馈正文还是新增留言功能。投稿开关保持关闭，测试数据按已批准清理边界处理。

- [ ] **Step 8.5：记录状态**

在 Task 8.4 完整闭环后，记录脱敏环境 ID、migration 结果、函数版本、网关/存储/身份配置、smoke、资源点和费用，并据实写最终 `pass`、`blocked` 或 `unverified`。当前远端状态必须保持 `remote: in_progress`，不得写成正式生产上线。

完成标准：上海免费开发环境形成零额外费用的真实网站闭环，且没有任何已退役云服务。

## 完成定义

Task 1–7 全部完成并通过只代表本地改造完成；Task 8 的同一上海 PostgreSQL 免费环境 smoke 通过后，阶段 2C 才是 `pass`。正式上线仍是独立后续任务，必须另行评估生产套餐、域名、备份、监控、迁移与回滚。
