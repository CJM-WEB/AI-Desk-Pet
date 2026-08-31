# 网站管理员强制发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不伪造 Scanner 证据的前提下，让唯一管理员可转人工并通过独立动作强制发布未通过技术扫描的共享包。

**Architecture:** 复用现有管理员动作 RPC、状态版本、幂等键和审计表；用 `force_publish` 与 `publicationBasis` 把人工覆盖从普通批准和技术结论中分离。生产 PostgreSQL、CloudBase 服务、内存 Adapter 和网站界面共享同一状态语义，后到扫描结果只更新风险信息。

**Tech Stack:** TypeScript、Zod、PostgreSQL 17、CloudBase PostgreSQL RPC、React、Vitest、Node test runner。

## Global Constraints

- 只修改官网、CloudBase API、Scanner 消费契约、共享网站契约和网站验证文件；禁止触碰桌宠业务代码。
- `force_publish` 是唯一强制发布入口；普通 `approve` 继续要求当前有效技术扫描证据。
- `riskAcknowledgement` 精确为 `ADMIN_OVERRIDE_ACCEPTED`，理由长度继续为 1—500 字符。
- `publicationBasis` 只允许 `standard`、`admin_override`；未发布记录为 `NULL`。
- 技术扫描结论、管理员裁决和发布依据分别保存，任何人工动作不得生成扫描通过证据。
- 后到扫描结果不得修改 `published`、状态版本或 `publicationBasis`。
- 只新增不可变前向 migration，不修改五个历史 migration。
- 所有实现执行 RED → GREEN → REFACTOR；新路径通过后删除被替代旧分支和旧断言。
- 单一问题或命令超过 15 分钟即保留证据并切换方案。
- 只在 `WebsiteExtension` 分支执行已授权的 Git 写操作；禁止 merge、rebase、push 和生产部署。

---

### Task 1：共享动作、发布依据与 PostgreSQL 原子事实

**Files:**
- Modify: `packages/shared-types/src/moderation.ts`
- Modify: `packages/shared-types/tests/moderation.test.ts`
- Create: `cloudbase/migrations/20260831010000_admin_override_publication.sql`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Modify: `tools/verification/website-scope-policy.mjs`

**Interfaces:**
- Produces: `AdminAction` 可辨识联合，其中 `force_publish` 必须包含 `riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'`。
- Produces: `PublicationBasis = 'standard' | 'admin_override'`。
- Produces: 前向 SQL 继续暴露现有 `apply_admin_action(...)` RPC，并为已领取审核任务提供只追加后到结果的原子分支。

- [ ] **Step 1: 写共享契约 RED**

```ts
expect(adminActionSchema.safeParse({
  action: 'force_publish', version: 3, idempotencyKey: 'override-0001', reason: '人工确认可发布'
}).success).toBe(false);
expect(adminActionSchema.parse({
  action: 'force_publish', version: 3, idempotencyKey: 'override-0001', reason: '人工确认可发布',
  riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
}).action).toBe('force_publish');
expect(adminActionSchema.safeParse({
  action: 'approve', version: 3, idempotencyKey: 'approve-0001', reason: '普通批准',
  riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
}).success).toBe(false);
```

- [ ] **Step 2: 运行共享 RED**

Run: `pnpm.cmd --filter @myself/shared-types test -- tests/moderation.test.ts`
Expected: FAIL，因为 `force_publish` 与严格风险确认尚不存在。

- [ ] **Step 3: 最小实现共享契约**

```ts
export const publicationBasisSchema = z.enum(['standard', 'admin_override']);
export const adminActionSchema = z.discriminatedUnion('action', [
  normalAdminActionSchema,
  adminActionBase.extend({
    action: z.literal('force_publish'),
    riskAcknowledgement: z.literal('ADMIN_OVERRIDE_ACCEPTED')
  }).strict()
]);
```

- [ ] **Step 4: 写真实 PostgreSQL RED**

在行为门加入以下逐项断言：共享包 `system_reviewing → move_to_manual → manual_review_pending`；无通过证据时 `approve` 回滚；缺风险确认的 `force_publish` 回滚；合法 `force_publish` 原子写入 `published + admin_override + admin_audit_logs`；同键同请求回放首次快照；同键异参冲突；后到危险结果保持发布状态和版本不变但追加审核结果。

- [ ] **Step 5: 运行数据库 RED**

Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: FAIL，因为第六个前向 migration、发布依据和强制发布事务尚不存在。

- [ ] **Step 6: 编写不可变前向 migration**

新增 `publication_basis` 检查约束和索引所需最小列，`apply_admin_action` 只在 `manual_review_pending + shared_package + force_publish + ADMIN_OVERRIDE_ACCEPTED` 时写 `admin_override`；普通批准写 `standard`。审计请求载荷必须包含风险确认和动作时最新扫描摘要；后到结果分支只允许 `published + admin_override`。

- [ ] **Step 7: 运行 Task 1 GREEN**

Run: `pnpm.cmd --filter @myself/shared-types test && pnpm.cmd --filter @myself/shared-types typecheck`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: 全部 PASS，inventory 顺序包含六个 migration。

- [ ] **Step 8: 删除旧 SQL 行为断言并提交**

删除“共享包转人工回 `system_reviewing`”和“只有技术通过可形成任何 published”的旧断言，保留普通批准证据门测试。

```powershell
git add packages/shared-types cloudbase/migrations tools
git commit -m "feat(web): 建立管理员强制发布原子契约"
```

### Task 2：CloudBase 服务、Adapter 与后到扫描结果

**Files:**
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/src/services/moderation-service.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`
- Modify: `apps/cloudbase-api/tests/moderation-service.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/support/fakes.ts`

**Interfaces:**
- Consumes: Task 1 的 `AdminAction`、`PublicationBasis` 和 SQL RPC。
- Produces: `AdminActionInput.riskAcknowledgement`、管理/公开记录的 `publicationBasis`、后到扫描结果写入端口。

- [ ] **Step 1: 写服务和 Adapter RED**

新增测试证明：三种投稿从 `system_reviewing` 执行 `move_to_manual` 都返回 `manual_review_pending`；共享包缺证据普通批准仍为 `TECHNICAL_SCAN_REQUIRED`；合法 `force_publish` 传入精确确认值和 `admin_override`；有效证据存在时强制发布返回 `INVALID_ADMIN_ACTION`；已领取任务在强制发布后完成危险扫描只调用后到结果端口。

- [ ] **Step 2: 运行 CloudBase RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/admin-service.test.ts tests/moderation-service.test.ts tests/cloudbase-postgres.test.ts`
Expected: FAIL，失败点分别是旧转人工目标、未知动作、缺发布依据和后到结果端口。

- [ ] **Step 3: 实现最小服务路径**

`AdminService` 保留 `hasCurrentTechnicalPass()` 供普通批准使用；`force_publish` 只校验投稿种类、状态、确认值和“当前没有有效通过证据”，再把原请求交给数据库。`ModerationService` 遇到 `published + admin_override` 只记录结果，不调用状态推进。

- [ ] **Step 4: 映射发布依据且不泄漏私有字段**

CloudBase PostgreSQL Adapter 在管理员详情、公开社区列表/详情和下载元数据中映射 `publication_basis`；公开 DTO 只返回枚举，不返回管理员身份、理由或内部扫描对象。

- [ ] **Step 5: 运行 Task 2 GREEN**

Run: `pnpm.cmd --filter @myself/cloudbase-api test`
Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`
Expected: 全部 PASS，无未校验 cast 或第二套强制发布入口。

- [ ] **Step 6: 重构并提交**

删除共享包 `move_to_manual` 回 `system_reviewing` 的服务分支和只服务该分支的 fake；复用现有幂等回放，不新增旁路存储。

```powershell
git add apps/cloudbase-api
git commit -m "feat(web): 接入强制发布与后到扫描记录"
```

### Task 3：管理确认、公开警告与内存同构

**Files:**
- Modify: `apps/website/components/admin/AdminDetail.tsx`
- Modify: `apps/website/components/admin/AdminApp.tsx`
- Modify: `apps/website/components/admin/admin.module.css`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/components/website-experience/community/shared-pet-types.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/components/website-experience/community/SharedPetCard.tsx`
- Modify: `apps/website/components/website-experience/community/SharedPetDetailDialog.tsx`
- Modify: `apps/website/tests/admin-app.test.tsx`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `docs/operations/content-moderation.md`

**Interfaces:**
- Consumes: Task 2 的 `publicationBasis` 和 `force_publish` 管理动作。
- Produces: 可访问的两步强制发布确认、公开人工放行标记、生产与内存一致行为。

- [ ] **Step 1: 写 UI、仓储与内存 RED**

新增测试证明：`system_reviewing` 显示“转人工”；缺有效证据的人工待审共享包同时显示被禁用的普通批准和“强制发布”；第一次点击只显示风险确认区；确认后才发送带字面量确认值的 `force_publish`；公开卡片、详情和下载入口显示人工放行警告；Memory 与生产状态、版本、幂等和错误码一致。

- [ ] **Step 2: 运行网站 RED**

Run: `pnpm.cmd --filter @myself/website test -- tests/admin-app.test.tsx tests/cloud-shared-pet-repository.test.ts`
Run: `pnpm.cmd test:e2e:website`
Expected: FAIL，因为 UI、公开 DTO 和 Memory 尚不认识强制发布。

- [ ] **Step 3: 实现两步确认和公开标记**

管理界面用组件状态显示内联警告、确认和取消按钮；不使用自动回退。Cloud 仓储严格读取 `publicationBasis`，共享包卡片、详情和下载区域仅在 `admin_override` 时显示固定警告文案。

- [ ] **Step 4: 对齐 Memory 和运维文档**

Memory 保存发布依据、首次结果快照、风险确认和后到结果；同键异参返回 `IDEMPOTENCY_CONFLICT`。运维手册分别描述普通批准、强制发布、后到危险结果和主动隔离。

- [ ] **Step 5: 运行 Task 3 GREEN**

Run: `pnpm.cmd --filter @myself/website test && pnpm.cmd --filter @myself/website typecheck`
Run: `pnpm.cmd test:e2e:website`
Expected: 全部 PASS，人工放行标记在公开与管理链均可观察。

- [ ] **Step 6: 全局门禁与提交**

Run: `pnpm.cmd verify:cloudbase`
Run: `pnpm.cmd verify:website`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; pnpm.cmd verify:web-chain:fast`
Run: `pnpm.cmd verify:web-chain:scope && pnpm.cmd verify:web-chain:ownership`
Run: `git diff --check`
Expected: 全部 PASS；完整网站链仍按 Docker 引擎真实状态单独记录。

```powershell
git add apps/website tests docs/operations package.json tools/verification
git commit -m "feat(web): 展示管理员人工放行风险"
```

### Task 4：独立审查与阶段 2—3 续接

**Files:**
- Modify: `docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md`
- Modify: `.superpowers/sdd/2026-08-31-website-stage-2-3-local-closure/progress.md`（Git 忽略证据台账）

**Interfaces:**
- Produces: Task 6 可直接消费的最终管理员动作和公开 DTO，不保留临时契约。

- [ ] **Step 1: 独立规格与质量双审查**

审查完整分支差异，逐项核对三类事实分离、SQL 原子性、幂等回放、后到扫描不改状态、公开标记和旧路径删除；Critical/Important 必须修复并复审。

- [ ] **Step 2: 记录验收并恢复 Task 6**

在阶段 2—3 台账记录强制发布计划的 commit 范围和审查 verdict；重新生成 Task 6 brief，使 feedback 精确为 `system_reviewing`，并消费 `force_publish` 与 `publicationBasis`。

- [ ] **Step 3: 提交计划状态**

```powershell
git add docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md
git commit -m "docs: 续接管理员覆盖后的HTTP契约"
```
