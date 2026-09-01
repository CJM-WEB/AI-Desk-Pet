# 网站架构优化总索引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按安全门顺序完成网站链路阶段 0—3，恢复普通网站功能开发资格，并为阶段 4 治理和后续独立生产计划建立可审计入口。

**Architecture:** 采用“验证基线 → 安全止血 → 基础设施可靠性 → 跨端契约闭环”的纵向切片顺序；每个阶段必须满足退出条件后才能进入下一阶段。阶段 4—5 当前只记录进入条件，不提前固化尚未取得真实平台证据的代码方案。

**Tech Stack:** pnpm workspace、TypeScript 5、Vitest 3、Playwright 1.61、Zod 3、Next.js 15、CloudBase JS SDK 3.6.8、PostgreSQL、Docker、ClamAV。

> 2026-09-01 当前入口：阶段 2A、2B、阶段 3 与阶段四本地治理的既有本地裁决保持通过。阶段 2C 的现行规格与计划为 `2026-09-01-website-stage-2c-zero-cost-manual-review-design.md` 和 `2026-09-01-website-stage-2c-zero-cost-manual-review.md`：云上只保留 PostgreSQL、私有存储、API、cleanup、身份、网关与静态托管；新投稿直入人工队列。已执行本地验证，`remote: unverified`；投稿开启、远端 migration、阶段 5 正式生产重部署与上线继续冻结。真实状态见 `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`。

## Global Constraints

- 唯一设计基线：`docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md`。
- 允许修改：`apps/website/**`、`apps/cloudbase-api/**`、`apps/package-scanner/**` 的协议/适配器/构建/部署、必要的 `packages/shared-types/**`、`cloudbase/migrations/**`、网站链工具、测试和文档。
- 严禁修改：`apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**` 及桌面测试和发布配置。
- Scanner 只能复用角色包公开契约，不得改变角色包业务语义。
- 正式生产平台固定为独立 CloudBase 生产环境；Vercel、Cloudflare、Supabase 不进入本轮生产链路。
- 本轮已授权在 `WebsiteExtension` 分支执行必要的本地 Git add/commit；禁止 merge/rebase、push、PR 和跨分支写入。真实数据库迁移、CloudBase 资源变更、部署、发布和远端数据修改仍不在授权范围。
- 大量删除必须先列出精确目标、引用、恢复方式和验证结果，并取得用户二次批准。
- 每个功能任务执行 RED → GREEN → REFACTOR；先运行定向测试，再运行所属阶段门禁。

---

### Task 1: 顺序执行阶段 0—3

**Files:**
- Read: `docs/superpowers/plans/2026-08-15-website-verification-foundation.md`
- Read: `docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md`
- Read: `docs/superpowers/plans/2026-08-15-website-cloudbase-scanner-reliability.md`
- Read: `docs/superpowers/plans/2026-08-15-website-http-contract-closure.md`

**Interfaces:**
- Consumes: 已批准设计规格和当前 `WebsiteExtension` 代码基线。
- Produces: 可重复执行的 `verify:web-chain`、失败关闭的共享包发布链、可审计迁移器、统一 Scanner 协议、共享 HTTP 运行时契约。

- [x] **Step 1: 执行阶段 0 并保存证据**

阶段 0 已完成，详见 `docs/operations/website-chain-verification.md` 与 `docs/operations/website-chain-verification-acceptance.md` 的最终固定顺序证据。阶段 1 已于 2026-08-21 完成，最终固定顺序 E2E 为 14/14；阶段 2A、2B 与阶段 3 已通过，普通网站功能开发资格恢复，正式部署继续冻结。

- [x] **Step 2: 执行阶段 1 并确认止血门**

严格执行 `2026-08-15-website-publication-stopgap-and-migration-freeze.md`；确认无扫描证据不能批准/发布，旧迁移入口不能误执行。

2026-08-21 的实际完成证据见该计划 Task 11 与 `docs/operations/website-chain-verification-acceptance.md`。后续阶段不得恢复已删除的固定 SQL 写入入口。

- [x] **Step 3: 执行阶段 2A/2B 并确认本地 S1 联合门**

阶段 2 的当前执行口径由 `2026-08-31-website-stage-2-3-local-closure.md` 修订：先完成本地结构、候选和自动化闭环；真实 Scanner 开发环境冒烟未通过时，共享包投稿开关必须保持关闭，远程部署门不阻塞阶段 3 本地契约闭环。

2026-08-31 实际结果：阶段 2A、2B PASS；PostgreSQL 17.11 的 7 个 migration/42 项行为通过，真实 Node 22 Scanner 容器以 UID 999 通过 health、EICAR 与 timeout 门，完整网站链复验通过。

- [x] **Step 4: 执行阶段 3 并恢复普通功能开发资格**

阶段 3 的当前执行口径由 `2026-08-31-website-stage-2-3-local-closure.md` 修订；只有生产 `createApi` 与内存后端通过同一行为案例，关键响应均经 Zod 解析，且阶段 2 本地门通过后，才能恢复普通网站功能开发。恢复开发不等于开启共享包投稿或完成部署。

2026-08-31 实际结果：阶段 3 PASS，双 Adapter 合同 12/12；2A/2B/3 联合门满足，普通非投稿网站功能开发资格恢复。投稿开启和部署仍受阶段 2C 与独立远端授权约束。

- [x] **Step 5: 在当前分支提交阶段索引状态（禁止合并与远端写入）**

```powershell
git add docs/superpowers/plans/2026-08-15-website-optimization-index.md docs/operations/website-optimization-acceptance.md docs/operations/cloudbase-deployment.md docs/operations/content-moderation.md tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs
git commit -m "docs: 记录网站阶段2至3验收裁决"
```

### Task 2: 阶段 4 独立规格入口

**Files:**
- Create: `docs/superpowers/specs/2026-08-15-website-s2-governance-design.md`

**Interfaces:**
- Consumes: 阶段 0—3 的验收记录、真实 CloudBase 网关 `/api` 前缀证据和当前生产 Adapter 行为。
- Produces: 每项 S2 债务的独立 owner、非目标、接口、迁移/删除范围和验收门。

- [x] **Step 1: 核对进入条件**

确认阶段 0—3 全部通过；缺少任一证据时停止，不创建代码任务。

阶段 0—3 的本地进入条件已经满足；阶段四已由 `docs/superpowers/specs/2026-08-15-website-s2-governance-design.md` 与 `docs/superpowers/plans/2026-08-31-website-stage-4-s2-governance.md` 规格化并执行。

- [x] **Step 2: 分别规格化并实现八项本地治理工作**

规格必须分别裁决：keyset cursor、desired-state 点赞与 `operationId`、下载计数语义、坏公开记录隔离、有界 RPC、Release Manifest 单一契约、`LiquidGlassHome` 事件上移、i18n 单向消息键；生产 Router 只在取得真实网关证据后保留或删除。

2026-09-01 实际结果：版本化 keyset cursor、desired-state 点赞与互动幂等账本、下载成功签发计数、发布结构不变量与坏记录隔离、有界 RPC JSON、Release Manifest 单一契约、CloudBase 能力端口收窄和 i18n 单向权威八项本地实现均已完成。`LiquidGlassHome` 跨章节事件项已由 2026-08-20 减法规格接替为“删除且不替换”；生产 Router 明确等待阶段 2C 的真实 CloudBase 网关路径证据，本阶段未预判保留或删除。

- [x] **Step 3: 核对旧实现清理范围**

清单必须含精确文件、调用引用、恢复方式、定向测试和阶段门；未获二次批准不得大量删除。

阶段四按纵向切片删除被替代的旧符号、函数和浅接口，没有执行 IndexedDB/LocalStorage Repository、旧首页文件簇、CSS 或资产的大量文件删除，因此未触发大量删除二次批准门。阶段五仍须单独列出文件簇并取得二次批准。

### 阶段四当前退出状态

- 八项本地治理实现：complete；最终代码 Spec 轴 Approved。
- `LiquidGlassHome` 事件项：由 2026-08-20 减法规格接替，不重新建立事件总线。
- 生产 Router：等待阶段 2C 真实网关证据，不记通过或失败。
- 阶段四整体：complete。2026-09-01 在 `f6978d0cec4108a1c168eded98b1ce5b9e512a1b` 上运行的同一次完整 `verify:web-chain` 通过真实 `scanner-candidate` 与 website E2E 21/21，并以退出码 0 结束。
- 外部状态：CloudBase 开发环境、远端 migration、cleanup 调度、真实网关、对象存储、部署、发布和正式上线均未执行。
- 范围边界：生产 Router 的唯一正式路径裁决继续等待阶段 2C 真实网关证据，不属于阶段四完成条件。

### Task 3: 已退役的旧阶段 5 生产重部署入口

> **历史替代声明（禁止执行）：** 本节中 CloudBase Run、三函数、`moderation-worker` 与 Scanner 的部署顺序已被阶段 2C 零费用人工审核规格和计划替代。不得执行下列旧入口、命令或其变体；现行链路只允许 PostgreSQL、私有 Bucket、API、cleanup、身份、网关、静态托管与管理员本地 Docker CLI。正式生产仍须另立规格并获得逐项授权。

**Files:**
- Create: `docs/superpowers/plans/2026-08-15-website-production-relaunch.md`
- Create: `docs/operations/2026-08-15-website-production-relaunch-acceptance.md`

**现行入口：** [`2026-09-01-website-stage-2c-zero-cost-manual-review-design.md`](../specs/2026-09-01-website-stage-2c-zero-cost-manual-review-design.md) 与 [`2026-09-01-website-stage-2c-zero-cost-manual-review.md`](2026-09-01-website-stage-2c-zero-cost-manual-review.md)。真实生产操作未获授权时状态只能写“待正式上线”；不得从本历史节生成部署步骤。
