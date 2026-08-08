# 投稿直接人工审核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让反馈、建议和共享资源包在完成必要校验后直接进入管理员人工审核，同时完整保留系统审核实现供后续恢复。

**Architecture:** 应用服务和跨端契约统一返回 `manual_review_pending`；数据库通过新的前向迁移重定义文本创建、上传完成和管理员动作函数，并迁移当前系统审核中数据。系统审核 Worker 及其依赖不修改，因为它只领取 `system_reviewing`，新流程不会产生该状态。

**Tech Stack:** TypeScript、Vitest、Zod、PostgreSQL PL/pgSQL、CloudBase 云函数与静态托管。

## Global Constraints

- 只在当前 `main` 分支修改、提交和部署，不创建或切换其他分支。
- 保留系统审核 Worker、触发器、扫描器、内容安全适配器、审核表和历史审核结果。
- 共享包仍必须完成对象存在性、大小、类型和上传完整性校验。
- 新人工审核共享包可以直接批准；历史 `auto_rejected` 共享包继续执行技术扫描门禁。
- 数据库只新增前向迁移，不修改已执行的历史迁移。
- 网站生产构建必须注入现有 `NEXT_PUBLIC_CLOUDBASE_ENV_ID` 与 `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`，不得用空配置覆盖线上静态站。
- 所有新增文档和结构性注释使用中文。
- 先提交当前工作区已有的管理员路由修复，避免与本功能混入同一提交。

---

### Task 1: 固化当前管理员路由修复基线

**Files:**
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/website/components/admin/AdminApp.tsx`
- Modify: `apps/website/lib/admin-api-client.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`

**Interfaces:**
- Consumes: 已在线验证的 `x-ai-pet-admin-token` 管理员令牌边界。
- Produces: 干净且可独立回退的管理员路由修复提交。

- [ ] **Step 1: 重新运行既有回归测试**

Run: `pnpm --filter cloudbase-api test -- api.test.ts && pnpm --filter website test -- admin-api-client.test.ts admin-app.test.tsx`

Expected: 相关测试全部通过。

- [ ] **Step 2: 只提交六个既有修复文件**

```powershell
git add -- apps/cloudbase-api/src/functions/api.ts apps/cloudbase-api/tests/api.test.ts apps/website/components/admin/AdminApp.tsx apps/website/lib/admin-api-client.ts apps/website/tests/admin-api-client.test.ts apps/website/tests/admin-app.test.tsx
git diff --cached --check
git commit -m "fix: 修复管理员审核请求路由"
```

### Task 2: 跨端回执与应用服务直接返回人工审核状态

**Files:**
- Modify: `packages/shared-types/src/moderation.ts`
- Modify: `packages/shared-types/tests/moderation.test.ts`
- Modify: `apps/cloudbase-api/src/services/text-submission-service.ts`
- Modify: `apps/cloudbase-api/tests/text-submission-service.test.ts`
- Modify: `apps/cloudbase-api/src/services/submission-service.ts`
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts`

**Interfaces:**
- Consumes: `SubmissionStatus` 中已有的 `manual_review_pending`。
- Produces: `SubmissionReceipt.status` 接受并返回 `manual_review_pending`；`SubmissionService.finalize()` 返回 `{ status: 'manual_review_pending' }`。

- [ ] **Step 1: 写回执与文本投稿失败测试**

```ts
expect(submissionReceiptSchema.parse({
  submissionId: 'submission-1',
  statusToken: 'a'.repeat(43),
  statusPath: '/submission-status/',
  status: 'manual_review_pending'
}).status).toBe('manual_review_pending');

expect(await service.submit(validFeedback, context)).toMatchObject({
  status: 'manual_review_pending'
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm --filter @myself/shared-types test -- moderation.test.ts && pnpm --filter cloudbase-api test -- text-submission-service.test.ts`

Expected: 回执枚举和文本服务仍返回 `system_reviewing`，测试失败。

- [ ] **Step 3: 最小修改回执枚举和文本服务**

```ts
status: z.enum(['uploading', 'system_reviewing', 'manual_review_pending'])
```

文本投稿成功回执固定返回 `manual_review_pending`。

- [ ] **Step 4: 写共享包完成上传失败测试**

内存存储的 `completeUpload` 将 `uploading` 转为 `manual_review_pending`，并断言首次和重复完成都返回：

```ts
{ status: 'manual_review_pending' }
```

- [ ] **Step 5: 运行测试确认 RED**

Run: `pnpm --filter cloudbase-api test -- submission-service.test.ts`

Expected: `SubmissionService.finalize()` 仍要求并返回 `system_reviewing`，测试失败。

- [ ] **Step 6: 最小修改共享包完成服务**

`finalize()` 接受数据库返回的 `manual_review_pending`，重复完成同样幂等返回该状态；上传前校验逻辑保持不变。

- [ ] **Step 7: 运行相关测试确认 GREEN**

Run: `pnpm --filter @myself/shared-types test -- moderation.test.ts && pnpm --filter cloudbase-api test -- text-submission-service.test.ts submission-service.test.ts`

Expected: 全部通过。

- [ ] **Step 8: 提交应用状态修改**

```powershell
git add -- packages/shared-types/src/moderation.ts packages/shared-types/tests/moderation.test.ts apps/cloudbase-api/src/services/text-submission-service.ts apps/cloudbase-api/tests/text-submission-service.test.ts apps/cloudbase-api/src/services/submission-service.ts apps/cloudbase-api/tests/submission-service.test.ts
git commit -m "feat: 投稿直接进入人工审核"
```

### Task 3: 仅对历史自动驳回共享包保留技术扫描门禁

**Files:**
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`

**Interfaces:**
- Consumes: `AdminSubmissionDetail.status` 和现有 `hasCurrentTechnicalPass()`。
- Produces: `manual_review_pending` 共享包无需扫描即可批准；`auto_rejected` 共享包仍需当前文件的有效 Pass 结果。

- [ ] **Step 1: 写人工共享包可直接批准的失败测试**

```ts
const { service, store } = createService(submission('manual_review_pending', {
  kind: 'shared_package',
  moderationResults: []
}));
await service.applyAction(admin, 'submission-1', approveAction);
expect(store.applyAdminAction).toHaveBeenCalledWith(
  expect.objectContaining({ nextStatus: 'published' })
);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm --filter cloudbase-api test -- admin-service.test.ts`

Expected: 现有服务抛出 `TECHNICAL_SCAN_REQUIRED`。

- [ ] **Step 3: 最小收窄服务层门禁**

仅当 `submission.status === 'auto_rejected'`、类型为 `shared_package` 且当前扫描未通过时抛出 `TECHNICAL_SCAN_REQUIRED`。

- [ ] **Step 4: 运行管理员服务测试确认 GREEN**

Run: `pnpm --filter cloudbase-api test -- admin-service.test.ts`

Expected: 新测试和历史自动驳回门禁测试全部通过。

- [ ] **Step 5: 提交管理员规则修改**

```powershell
git add -- apps/cloudbase-api/src/services/admin-service.ts apps/cloudbase-api/tests/admin-service.test.ts
git commit -m "feat: 允许人工审核共享包直接发布"
```

### Task 4: 新增并执行数据库前向迁移

**Files:**
- Create: `cloudbase/migrations/20260808000000_direct_manual_review.sql`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`

**Interfaces:**
- Consumes: 现有 `create_text_submission(jsonb)`、`complete_submission_upload(text,jsonb)`、`apply_admin_action(...)` 函数签名。
- Produces: 三个签名不变的函数实现，以及现有 `system_reviewing` 数据的一次性人工审核转换。

- [ ] **Step 1: 写迁移契约失败测试**

测试读取新迁移并验证它是事务化前向迁移，包含三项可观察数据库行为：文本创建写入 `manual_review_pending`、上传完成写入 `manual_review_pending`、管理员技术门禁限定 `v_previous_status = 'auto_rejected'`，并包含现有 `system_reviewing` 行的状态更新与租约释放。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm --filter cloudbase-api test -- cloudbase-postgres.test.ts`

Expected: 新迁移文件不存在，测试失败。

- [ ] **Step 3: 编写最小前向迁移**

迁移使用 `BEGIN`/`COMMIT`，通过 `CREATE OR REPLACE FUNCTION` 保持 RPC 签名与权限不变。历史数据转换执行：

```sql
UPDATE submissions
SET status = 'manual_review_pending',
    status_version = status_version + 1,
    moderation_lease_until = NULL,
    moderation_next_retry_at = NULL,
    updated_at = now()
WHERE status = 'system_reviewing';
```

- [ ] **Step 4: 运行数据库适配器测试确认 GREEN**

Run: `pnpm --filter cloudbase-api test -- cloudbase-postgres.test.ts`

Expected: 全部通过。

- [ ] **Step 5: 在已登录 CloudBase PostgreSQL SQL 编辑器执行完整迁移**

执行前确认环境为 `ai-pet-dev-d0gkscb2j2fc77664`，一次提交完整迁移；失败时停止 API 部署。

- [ ] **Step 6: 只读查询验证迁移结果**

确认 `system_reviewing` 数量为 0，`manual_review_pending` 包含迁移前内容，且三项函数仍存在。

- [ ] **Step 7: 提交迁移**

```powershell
git add -- cloudbase/migrations/20260808000000_direct_manual_review.sql apps/cloudbase-api/tests/cloudbase-postgres.test.ts
git commit -m "feat: 数据库投稿直接转人工审核"
```

### Task 5: 全量验证、部署与线上验收

**Files:**
- Verify: `apps/cloudbase-api/**`
- Verify: `apps/website/**`
- Verify: `packages/shared-types/**`

**Interfaces:**
- Consumes: Tasks 1-4 的提交与线上数据库迁移。
- Produces: `main` 分支上的可部署构建和真实线上人工审核闭环。

- [ ] **Step 1: 运行全量相关验证**

```powershell
pnpm --filter @myself/shared-types test
pnpm --filter cloudbase-api typecheck
pnpm --filter cloudbase-api test
pnpm --filter website typecheck
pnpm --filter website test
pnpm --filter cloudbase-api build
$env:NEXT_PUBLIC_CLOUDBASE_ENV_ID='ai-pet-dev-d0gkscb2j2fc77664'
# NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY 从现有安全配置注入，不在命令、代码或日志中回显。
pnpm --filter website build
git diff --check
```

Expected: 全部通过且无新增警告或未预期文件。

- [ ] **Step 2: 只部署 API 和静态网站**

```powershell
pnpm.cmd exec cloudbase -e ai-pet-dev-d0gkscb2j2fc77664 -r ap-singapore fn deploy ai-pet-api --force --json
pnpm.cmd exec cloudbase -e ai-pet-dev-d0gkscb2j2fc77664 -r ap-singapore hosting deploy apps/website/out
```

不重新部署或删除系统审核 Worker、扫描器和清理函数。

- [ ] **Step 3: 线上真实提交并验收**

提交一条标记明确的测试反馈，确认 API 回执为 `manual_review_pending`，管理员“待我审核”立即出现该条目，“系统处理中”不新增该条目。

- [ ] **Step 4: 验收管理员动作**

打开一条新的共享包详情，确认没有系统扫描结果时“批准发布”可用；不实际发布用户内容。

- [ ] **Step 5: 检查分支和工作区**

Run: `git branch --show-current && git status --short && git log -5 --oneline`

Expected: 分支为 `main`，仅保留明确说明的未提交文件或工作区干净。
