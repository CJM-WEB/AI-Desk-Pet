# 网站架构优化总索引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按安全门顺序完成网站链路阶段 0—3，恢复普通网站功能开发资格，并为阶段 4 治理和阶段 5 CloudBase 正式生产重部署建立可审计入口。

**Architecture:** 采用“验证基线 → 安全止血 → 基础设施可靠性 → 跨端契约闭环”的纵向切片顺序；每个阶段必须满足退出条件后才能进入下一阶段。阶段 4—5 当前只记录进入条件，不提前固化尚未取得真实平台证据的代码方案。

**Tech Stack:** pnpm workspace、TypeScript 5、Vitest 3、Playwright 1.61、Zod 3、Next.js 15、CloudBase JS SDK 3.6.8、PostgreSQL、CloudBase Run。

> 2026-08-31 当前裁决：阶段 2A 与阶段 3 PASS；阶段 2B 因缺少 Docker Linux runtime 而为 `blocked/unverified`；阶段 2C 未执行，生产未部署。联合门未满足，普通非投稿网站新功能继续冻结。新鲜证据见 `docs/operations/website-optimization-acceptance.md`。

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

阶段 0 已完成，详见 `docs/operations/website-chain-verification.md` 与 `docs/operations/website-chain-verification-acceptance.md` 的最终固定顺序证据。阶段 1 已于 2026-08-21 完成，最终固定顺序 E2E 为 14/14；阶段 2A 与阶段 3 已通过，阶段 2B 仍为 `blocked/unverified`，因此普通网站功能开发资格尚未恢复，正式部署继续冻结。

- [x] **Step 2: 执行阶段 1 并确认止血门**

严格执行 `2026-08-15-website-publication-stopgap-and-migration-freeze.md`；确认无扫描证据不能批准/发布，旧迁移入口不能误执行。

2026-08-21 的实际完成证据见该计划 Task 11 与 `docs/operations/website-chain-verification-acceptance.md`。后续阶段不得恢复已删除的固定 SQL 写入入口。

- [ ] **Step 3: 执行阶段 2A/2B 并确认本地 S1 联合门**

阶段 2 的当前执行口径由 `2026-08-31-website-stage-2-3-local-closure.md` 修订：先完成本地结构、候选和自动化闭环；真实 Scanner 开发环境冒烟未通过时，共享包投稿开关必须保持关闭，远程部署门不阻塞阶段 3 本地契约闭环。

2026-08-31 实际结果：阶段 2A PASS；阶段 2B 的 PostgreSQL 17.11 7 个 migration/42 项行为和 Scanner 本地代码门通过，但真实 Node 22 容器候选因缺少 Docker Linux runtime 未运行。本步骤保持未勾选，不得以部分证据解冻联合门。

- [ ] **Step 4: 执行阶段 3 并恢复普通功能开发资格**

阶段 3 的当前执行口径由 `2026-08-31-website-stage-2-3-local-closure.md` 修订；只有生产 `createApi` 与内存后端通过同一行为案例，关键响应均经 Zod 解析，且阶段 2 本地门通过后，才能恢复普通网站功能开发。恢复开发不等于开启共享包投稿或完成部署。

2026-08-31 实际结果：阶段 3 PASS，双 Adapter 合同 12/12；由于阶段 2B 未通过，本步骤中的“恢复普通功能开发资格”未达成，继续保持未勾选。

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

- [ ] **Step 1: 核对进入条件**

确认阶段 0—3 全部通过；缺少任一证据时停止，不创建代码任务。

当前因阶段 2B 为 `blocked/unverified` 不满足进入条件；阶段 4 继续冻结。

- [ ] **Step 2: 分别规格化八项治理工作**

规格必须分别裁决：keyset cursor、desired-state 点赞与 `operationId`、下载计数语义、坏公开记录隔离、有界 RPC、Release Manifest 单一契约、`LiquidGlassHome` 事件上移、i18n 单向消息键；生产 Router 只在取得真实网关证据后保留或删除。

- [ ] **Step 3: 为涉及旧实现清理的任务建立二次批准清单**

清单必须含精确文件、调用引用、恢复方式、定向测试和阶段门；未获二次批准不得大量删除。

### Task 3: 阶段 5 正式生产重部署入口

**Files:**
- Create: `docs/superpowers/plans/2026-08-15-website-production-relaunch.md`
- Create: `docs/operations/2026-08-15-website-production-relaunch-acceptance.md`

**Interfaces:**
- Consumes: 阶段 0—4 验收、固定发布候选身份、独立生产 CloudBase 环境资料和用户对外部操作的逐项授权。
- Produces: 可回滚的正式 CloudBase 上线记录；未实际执行时状态只能写“待正式上线”。

- [ ] **Step 1: 在编写部署命令前向用户取得生产操作授权**

授权范围必须逐项覆盖：生产迁移、三函数、Scanner 镜像、Hosting 静态站点、正式域名/HTTPS/CORS/CSP、监控告警和回滚。

- [ ] **Step 2: 按固定候选顺序部署**

顺序固定为：生产迁移 → `api`/`moderation-worker`/`cleanup` → Scanner → 内部冒烟 → Hosting → 正式域名 → 外部冒烟。任何一步失败立即停止后续写操作。

- [ ] **Step 3: 记录真实证据而不是计划结论**

验收记录必须写日期、环境类别、候选身份、执行命令、退出码、实际 HTTP/页面观察、回滚结果和未覆盖项；不得记录 Secret、`x-ai-pet-admin-token`、OTP、签名 URL、私有对象键或真实环境 ID。
