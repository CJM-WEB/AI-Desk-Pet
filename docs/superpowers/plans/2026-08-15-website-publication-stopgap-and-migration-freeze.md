# 网站共享包发布止血与迁移入口冻结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不恢复 Scanner、不连接数据库和不执行真实迁移的前提下，使无当前有效扫描证据的共享包无法批准公开、默认关闭共享包投稿，并用可审计的 migration inventory/checksum/dry-run 取代固定单 SQL 写入口。

**Architecture:** 本计划包含两个可独立验收的纵向子项目。子项目一由 `SubmissionService` 持有投稿开关，`AdminService` 与 PostgreSQL RPC 保留有意的双层发布复核，管理员 UI 只投影同一失败原因；子项目二建立纯文件系统的 `CloudBaseMigrationInventory` 和只读 CLI，彻底删除阶段 1 的数据库写入口。阶段 2 在本计划产出的有序 inventory 与 checksum 之上另行增加不可变账本、专用数据库会话、整轮 advisory lock、逐份事务、故障注入和开发环境 smoke，不复活固定 SQL 执行器。

**Tech Stack:** TypeScript 5.9、Node.js 24 ESM、Vitest 3、Node `node:test`、React 19、Zod、PostgreSQL PL/pgSQL、pnpm 11 workspace。

## Global Constraints

- 设计基线：`docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md`；执行前必须取得用户书面复核。
- 只允许修改网站、CloudBase API、数据库前向 migration、网站链工具与对应运维文档；严禁修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`。
- 本阶段不恢复 Scanner、不调用 Scanner、不改变角色包业务语义，也不把纯人工审核当成降级路径。
- 本阶段不得连接 CloudBase PostgreSQL、不得执行真实 migration、不得部署、不得修改远端资源或数据。
- 历史 migration 永不改写；数据库实际变更只能在后续获批阶段使用新的前向 migration。
- 服务层与 PostgreSQL RPC 的双层复核是有意安全防线；不得新增第三个只转发规则的 `SharedPackagePublicationGate`。
- 共享包投稿开关生产初始关闭；关闭不得影响公开只读、普通反馈、管理员登录或管理员查看已有记录。
- API Key、Secret、Bearer、OTP、状态令牌、签名 URL、私有对象键、SQL 正文和绝对迁移路径不得进入普通日志或 dry-run 输出。
- 所有面向人的文档和结构性代码注释使用中文。
- 实施严格执行 RED → GREEN → REFACTOR；不得先写完整实现再补测试。
- 本计划不授权 Git 暂存、提交、推送、建分支或其他 Git 写操作；如需提交必须另行取得用户授权。

---

## 文件职责与变更地图

### 子项目一：共享包批准失败关闭与投稿开关

- Modify: `apps/cloudbase-api/src/config.ts`：解析默认关闭的服务端投稿开关。
- Modify: `apps/cloudbase-api/src/functions/api.ts`：将开关显式注入 `SubmissionService`。
- Modify: `apps/cloudbase-api/src/services/submission-service.ts`：在任何写入或签名之前执行投稿开关。
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`：对所有非已发布共享包批准动作复核当前技术证据。
- Modify: `apps/cloudbase-api/tests/config.test.ts`：验证开关默认值、显式开启和非法值。
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts`：验证关闭时零数据库/存储调用，开启时保留既有上传流程。
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`：验证缺失、错对象、错大小、错投稿、错版本证据均失败。
- Modify: `apps/cloudbase-api/tests/api.test.ts`：验证稳定 HTTP 错误信封和非共享包路径不受影响。
- Create: `cloudbase/migrations/20260815000000_shared_package_publication_guard.sql`：用新的前向 migration 收紧 PostgreSQL `apply_admin_action`。
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`：锁定新 migration 契约、RPC `P1003` 映射和可执行内存 RPC 行为。
- Modify: `apps/website/components/admin/AdminDetail.tsx`：对所有缺证据共享包禁用批准并显示稳定原因。
- Modify: `apps/website/tests/admin-app.test.tsx`：反转直接人工批准旧用例，保护反馈、建议和只读查看。
- Modify: `docs/operations/content-moderation.md`：删除当前有效的人工绕过语义。
- Modify: `docs/operations/cloudbase-deployment.md`：记录投稿开关和阶段 1 的失败关闭状态。
- No change: `packages/shared-types/**`：开关属于服务端部署策略；现有 HTTP 错误信封已能携带稳定错误码。
- No change: `apps/website/lib/admin-api-client.ts`：管理员详情已有运行时 Schema，批准失败由现有 `ApiClientError` 传播。

### 子项目二：迁移 inventory/checksum/dry-run 与旧入口冻结

- Create: `tools/cloudbase-migration-inventory.mjs`：发现、校验、排序 migration 并计算原始字节 SHA-256。
- Create: `tools/cloudbase-migration-inventory.test.mjs`：使用临时目录执行纯文件系统行为测试。
- Create: `tools/plan-cloudbase-migrations.mjs`：只允许 `--dry-run` 的无凭据 CLI。
- Create: `tools/plan-cloudbase-migrations.test.mjs`：子进程验证输出、参数和零外部副作用。
- Delete: `tools/apply-cloudbase-migrations.mjs`：删除固定首份 SQL 与 `executePGSql` 写入口。
- Delete: `tools/apply-cloudbase-migrations.test.mjs`：删除只维护旧凭据读取和写入口的测试。
- Modify: `package.json`：新增只读 plan/test 脚本；保留阶段 2 事务迁移执行器将继续使用的 `@cloudbase/manager-node`。
- No change: `pnpm-lock.yaml`：阶段 1 不移除并在阶段 2 重新添加同一管理工具依赖。
- Modify: `docs/operations/cloudbase-deployment.md`：删除旧有效执行指引，只保留 dry-run 与冻结说明。

---

## 子项目一 Interface

`apps/cloudbase-api/src/services/submission-service.ts` 产生：

```ts
export interface SubmissionServiceOptions {
  sharedPackageSubmissionsEnabled: boolean;
}

export class SubmissionService {
  constructor(
    store: SubmissionStore,
    storage: ObjectStorage,
    options: SubmissionServiceOptions,
    createId?: () => string
  );
}
```

`apps/cloudbase-api/src/config.ts` 产生：

```ts
export interface CloudConfig {
  // 既有字段保持不变。
  sharedPackageSubmissionsEnabled: boolean;
}
```

环境变量契约：

```text
SHARED_PACKAGE_SUBMISSIONS_ENABLED
```

- 缺失、空字符串或 `false`：关闭。
- `true`：开启。
- 其他值：配置加载失败。

稳定公开错误码：

```ts
new ApiError('SHARED_PACKAGE_SUBMISSIONS_PAUSED', 503)
new ApiError('TECHNICAL_SCAN_REQUIRED', 409)
```

阶段 1 的“当前有效扫描证据”必须同时满足：

```ts
result.kind === 'package_scan'
result.provider === 'isolated-scanner'
result.suggestion === 'Pass'
result.evidence.submissionId === submission.id
result.evidence.packageStorageKey === packageAsset.storageKey
result.evidence.packageSizeBytes === packageAsset.actualBytes
result.evidence.submissionStatusVersion === submission.statusVersion
result.evidence.scanCode === 'CHARACTER_PACKAGE_SCAN_PASSED'
```

现有缺少投稿 ID 或状态版本绑定的历史证据按失败关闭处理。阶段 2 恢复 Scanner 时扩展 SHA-256、协议版本、规则版本、完成时间及可用的对象版本/ETag；本阶段不得伪造这些字段或恢复扫描。

## Task 1: 投稿开关配置契约

**Files:**
- Modify: `apps/cloudbase-api/src/config.ts:2-18,41-87`
- Modify: `apps/cloudbase-api/tests/config.test.ts:5-144`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv`
- Produces: `CloudConfig.sharedPackageSubmissionsEnabled: boolean`

- [ ] **Step 1: 写入配置 RED 测试**

```ts
it.each([
  [undefined, false],
  ['', false],
  ['false', false],
  ['true', true]
] as const)('投稿开关 %s 解析为 %s', (raw, expected) => {
  const config = loadCloudConfig({
    ...validEnv,
    ...(raw === undefined
      ? {}
      : { SHARED_PACKAGE_SUBMISSIONS_ENABLED: raw })
  });

  expect(config.sharedPackageSubmissionsEnabled).toBe(expected);
});

it('投稿开关拒绝模糊值', () => {
  expect(() => loadCloudConfig({
    ...validEnv,
    SHARED_PACKAGE_SUBMISSIONS_ENABLED: 'yes'
  })).toThrow('SHARED_PACKAGE_SUBMISSIONS_ENABLED 必须为 true 或 false');
});
```

- [ ] **Step 2: 运行测试确认 RED 原因**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts
```

Expected: FAIL，原因是 `CloudConfig` 不存在 `sharedPackageSubmissionsEnabled`，且非法值尚未被拒绝。

- [ ] **Step 3: 实现最小严格布尔读取器**

```ts
function readBooleanSwitch(
  env: NodeJS.ProcessEnv,
  name: string
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} 必须为 true 或 false`);
}
```

在 `loadCloudConfig()` 返回值加入：

```ts
sharedPackageSubmissionsEnabled: readBooleanSwitch(
  env,
  'SHARED_PACKAGE_SUBMISSIONS_ENABLED'
),
```

- [ ] **Step 4: 运行配置测试确认 GREEN**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

Expected: PASS。

## Task 2: SubmissionService 投稿止血

**Files:**
- Modify: `apps/cloudbase-api/src/services/submission-service.ts:52-104`
- Modify: `apps/cloudbase-api/src/functions/api.ts:567-588`
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts:113-162`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts:1118-1155`
- Modify: `apps/cloudbase-api/tests/api.test.ts:220-264`

**Interfaces:**
- Consumes: `SubmissionServiceOptions.sharedPackageSubmissionsEnabled`
- Produces: 关闭时 `SHARED_PACKAGE_SUBMISSIONS_PAUSED/503`，且零持久化、零上传签名调用

- [ ] **Step 1: 调整 fixture 并写关闭路径 RED 测试**

```ts
function createFixture(
  options: SubmissionServiceOptions = {
    sharedPackageSubmissionsEnabled: true
  }
) {
  const store = new MemorySubmissionStore();
  const storage = new MemoryStorage();
  return {
    store,
    storage,
    service: new SubmissionService(
      store as never,
      storage,
      options,
      () => 'submission-1'
    )
  };
}

it('共享包投稿开关关闭时不创建记录或签发上传地址', async () => {
  const { service, store, storage } = createFixture({
    sharedPackageSubmissionsEnabled: false
  });

  await expect(
    service.prepare(validInput, { ip: '203.0.113.8' })
  ).rejects.toMatchObject({
    code: 'SHARED_PACKAGE_SUBMISSIONS_PAUSED',
    statusCode: 503
  });

  expect(store.created).toBeNull();
  expect(storage.uploadCalls).toEqual([]);
});
```

- [ ] **Step 2: 运行定向测试确认 RED**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- submission-service.test.ts
```

Expected: FAIL，原因是构造函数尚不接收 options，关闭时仍调用 store/storage。

- [ ] **Step 3: 实现最小前置门并显式装配生产开关**

构造函数采用本计划 Interface；`prepare()` 第一项业务动作加入：

```ts
if (!this.options.sharedPackageSubmissionsEnabled) {
  throw new ApiError('SHARED_PACKAGE_SUBMISSIONS_PAUSED', 503);
}
```

该检查必须早于 `validatePrepareInput()`、`createStatusToken()`、`createSubmission()` 和上传 URL 签名。

生产装配改为：

```ts
submissions: new SubmissionService(
  store,
  storage,
  {
    sharedPackageSubmissionsEnabled:
      config.sharedPackageSubmissionsEnabled
  }
),
```

所有测试构造器显式传入开关；成功路径必须传 `true`，不得使用隐式测试默认值掩盖生产默认关闭。

- [ ] **Step 4: 补 API 稳定信封测试**

`apps/cloudbase-api/tests/api.test.ts` 的依赖替身让 `prepare` 抛出：

```ts
new ApiError('SHARED_PACKAGE_SUBMISSIONS_PAUSED', 503)
```

断言：

```ts
expect(response.statusCode).toBe(503);
expect(JSON.parse(response.body)).toMatchObject({
  data: null,
  error: { code: 'SHARED_PACKAGE_SUBMISSIONS_PAUSED' }
});
```

同时保留公开 GET、反馈提交和管理员 GET 的现有成功用例。

- [ ] **Step 5: 运行 GREEN 与回归**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- submission-service.test.ts api.test.ts cloudbase-postgres.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

Expected: PASS。

## Task 3: AdminService 当前证据复核

**Files:**
- Modify: `apps/cloudbase-api/src/services/admin-service.ts:74-128`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts:175-265,310-330`

**Interfaces:**
- Consumes: `AdminSubmissionDetail`、`AdminAction`
- Produces: 发布转换前 `TECHNICAL_SCAN_REQUIRED/409`；反馈和建议保持既有批准语义

- [ ] **Step 1: 将现有允许测试反转为 RED**

删除“待人工审核的共享包无需系统扫描即可由管理员批准”旧断言，替换为：

```ts
it('待人工审核共享包缺少当前技术证据时拒绝批准', async () => {
  const { service, store } = createService(submission(
    'manual_review_pending',
    { kind: 'shared_package', moderationResults: [] }
  ));

  await expect(service.applyAction(
    { uid: 'uid-admin', email: 'admin@example.com' },
    'submission-1',
    {
      action: 'approve',
      version: 3,
      idempotencyKey: 'manual-review-approve',
      reason: '尝试批准'
    }
  )).rejects.toMatchObject({
    code: 'TECHNICAL_SCAN_REQUIRED',
    statusCode: 409
  });

  expect(store.applyAdminAction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 加入陈旧证据矩阵**

使用以下四组 `evidence`，逐组断言 `TECHNICAL_SCAN_REQUIRED` 且 store 零调用：

```ts
const staleEvidenceCases = [
  ['对象键变化', {
    submissionId: 'submission-1',
    packageStorageKey: 'private/old-pet.zip',
    packageSizeBytes: 20,
    submissionStatusVersion: 3,
    scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
  }],
  ['实际大小变化', {
    submissionId: 'submission-1',
    packageStorageKey: 'private/current-pet.zip',
    packageSizeBytes: 19,
    submissionStatusVersion: 3,
    scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
  }],
  ['投稿身份变化', {
    submissionId: 'other-submission',
    packageStorageKey: 'private/current-pet.zip',
    packageSizeBytes: 20,
    submissionStatusVersion: 3,
    scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
  }],
  ['状态版本变化', {
    submissionId: 'submission-1',
    packageStorageKey: 'private/current-pet.zip',
    packageSizeBytes: 20,
    submissionStatusVersion: 2,
    scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
  }]
] as const;
```

- [ ] **Step 3: 加入有效证据与非共享包保护测试**

```ts
const currentEvidence = {
  submissionId: 'submission-1',
  packageStorageKey: 'private/current-pet.zip',
  packageSizeBytes: 20,
  submissionStatusVersion: 3,
  scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
};
```

断言完整当前证据允许调用 `store.applyAdminAction({ nextStatus: 'published' })`。使用 `it.each(['feedback', 'suggestion'])` 断言普通内容不依赖角色包扫描证据。

- [ ] **Step 4: 运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- admin-service.test.ts
```

Expected: 缺证据的 `manual_review_pending` 当前仍被批准；缺少 `submissionId/statusVersion` 绑定检查。

- [ ] **Step 5: 实现最小服务门**

```ts
if (
  action === 'approve'
  && submission.kind === 'shared_package'
  && status !== 'published'
  && !hasCurrentTechnicalPass(submission)
) {
  throw new ApiError('TECHNICAL_SCAN_REQUIRED', 409);
}
```

`status === 'published'` 只为既有幂等重放继续进入数据库，不产生新的发布转换。`hasCurrentTechnicalPass()` 按本计划 Interface 精确比对全部阶段 1 字段。

- [ ] **Step 6: 运行 GREEN**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- admin-service.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

Expected: PASS。

## Task 4: PostgreSQL 前向发布防线

**Files:**
- Create: `cloudbase/migrations/20260815000000_shared_package_publication_guard.sql`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts:15-40,178-196,281-427,1256-1303`

**Interfaces:**
- Consumes: 现有 `apply_admin_action` 参数与表结构
- Produces: PostgreSQL `P1003`，由 `CloudBasePostgresStore` 映射为 `TECHNICAL_SCAN_REQUIRED/409`

- [ ] **Step 1: 写可执行 MemoryRdb RED 行为**

在 `MemoryRdb.rpc('apply_admin_action')` 的测试夹具中加入 assets/moderation evidence 查询能力，然后增加：

```ts
it('数据库 RPC 拒绝缺少当前证据的待人工共享包批准', async () => {
  const database = new MemoryRdb();
  database.submissions.push(makeSubmission({
    id: 'manual-package',
    kind: 'shared_package',
    status: 'manual_review_pending',
    status_version: 3
  }));
  database.assets.push({
    submission_id: 'manual-package',
    object_key: 'submissions/manual-package/package.zip',
    original_name: 'pet.zip',
    declared_size: 1024,
    actual_size: 1024,
    mime_type: 'application/zip',
    role: 'package'
  });
  const { store } = createStore(database);

  await expect(store.applyAdminAction({
    submissionId: 'manual-package',
    adminId: 'admin-1',
    action: 'approve',
    nextStatus: 'published',
    expectedVersion: 3,
    idempotencyKey: 'manual-package-approve',
    reason: '批准'
  })).rejects.toMatchObject({
    code: 'TECHNICAL_SCAN_REQUIRED',
    statusCode: 409
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts
```

Expected: MemoryRdb 当前直接把状态改为 `published`。

- [ ] **Step 3: 实现 MemoryRdb 的同语义测试 Adapter**

幂等旧结果检查之后、状态写入之前，若批准非已发布共享包且找不到精确 evidence，则返回：

```ts
{
  data: null,
  error: {
    code: 'P1003',
    message: 'technical scan required'
  }
}
```

测试 Adapter 只用于执行行为案例，不成为生产规则 owner。

- [ ] **Step 4: 创建新的前向 migration**

历史三份 migration 保持字节不变。新 migration 使用 `CREATE OR REPLACE FUNCTION apply_admin_action(...)`，完整保留现有 service-role 校验、幂等优先、advisory transaction lock、版本 fence、审计写入、权限回收和错误码，只把原先限定 `auto_rejected` 的扫描条件收紧为所有非已发布共享包批准动作。

核心 SQL 条件必须为：

```sql
IF p_action = 'approve'
  AND v_previous_status <> 'published'
  AND (SELECT kind FROM submissions WHERE id = p_submission_id)
    = 'shared_package'
  AND NOT EXISTS (
    SELECT 1
    FROM moderation_results AS result
    JOIN assets AS asset
      ON asset.submission_id = result.submission_id
     AND asset.role = 'package'
    WHERE result.submission_id = p_submission_id
      AND result.kind = 'package_scan'
      AND result.provider = 'isolated-scanner'
      AND result.suggestion = 'Pass'
      AND result.evidence ->> 'submissionId' = p_submission_id
      AND result.evidence ->> 'packageStorageKey' = asset.object_key
      AND result.evidence ->> 'packageSizeBytes' = asset.actual_size::text
      AND result.evidence ->> 'submissionStatusVersion'
        = p_expected_version::text
      AND result.evidence ->> 'scanCode'
        = 'CHARACTER_PACKAGE_SCAN_PASSED'
  ) THEN
  RAISE EXCEPTION 'technical scan required'
    USING ERRCODE = 'P1003';
END IF;
```

- [ ] **Step 5: 增加 migration 契约保护**

测试读取新 migration，验证它重新定义正确函数、保留事务包裹与权限回收，并且旧的 `v_previous_status = 'auto_rejected'` 限定不再作为扫描门。行为正确性由 MemoryRdb 测试覆盖；源码结构断言只保护无法在本阶段连接 PostgreSQL 的部署边界，不替代阶段 2 的真实 PostgreSQL smoke。

- [ ] **Step 6: 运行 GREEN 并记录外部门**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

Expected: PASS。验收状态只能写“仓库契约自动化通过；CloudBase PostgreSQL 运行待阶段 2 开发环境确认”。

## Task 5: 管理员 UI 失败原因投影

**Files:**
- Modify: `apps/website/components/admin/AdminDetail.tsx:24-30,118-136,161-173`
- Modify: `apps/website/tests/admin-app.test.tsx:249-294`

**Interfaces:**
- Consumes: 现有 `AdminSubmissionDetail`
- Produces: 缺证据共享包的禁用批准按钮与 `admin.detail.technicalBlocked` 文案

- [ ] **Step 1: 反转旧 UI 测试**

```ts
it('人工审核共享包缺少技术证据时禁用批准并显示稳定原因', async () => {
  const pending = detail({
    id: 'manual-package',
    kind: 'shared_package',
    status: 'manual_review_pending',
    moderationResults: []
  });
  setup({
    listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
    getDetail: vi.fn().mockResolvedValue(pending)
  });

  fireEvent.click(await screen.findByText(pending.title));
  fireEvent.change(await screen.findByLabelText('审核理由'), {
    target: { value: '尝试批准' }
  });

  expect((screen.getByRole('button', {
    name: '批准发布'
  }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(
    '技术扫描未明确通过，不能批准共享包。'
  )).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认 RED**

```powershell
pnpm.cmd --filter @myself/website test -- admin-app.test.tsx
```

Expected: 当前 `manual_review_pending` 按钮仍可用。

- [ ] **Step 3: 实现最小 UI 条件**

删除“仅历史自动驳回项保留技术扫描门禁”旧注释，改为：

```ts
const technicalScanRequired =
  detail.kind === 'shared_package'
  && detail.status !== 'published'
  && !technicalPass;
```

前端 `hasCurrentTechnicalPass()` 加入 `submissionId` 和 `submissionStatusVersion` 对比。继续复用现有 `admin.detail.technicalBlocked` 中英文文案，不新增同义 key。

- [ ] **Step 4: 补保护回归并运行 GREEN**

保留并运行：有效当前证据允许批准、反馈/建议批准、自动驳回转人工、隔离恢复、管理员详情只读。

```powershell
pnpm.cmd --filter @myself/website test -- admin-app.test.tsx admin-api-client.test.ts
pnpm.cmd --filter @myself/website typecheck
```

Expected: PASS。

## Task 6: 止血文档与旧语义删除

**Files:**
- Modify: `docs/operations/content-moderation.md:5-49,92-97`
- Modify: `docs/operations/cloudbase-deployment.md:5-25,65-83,119-125`

**Interfaces:**
- Consumes: 已通过的服务、SQL 契约和 UI 行为
- Produces: 当前唯一有效的运维止血说明

- [ ] **Step 1: 更新审核手册**

明确：

- `manual_review_pending` 与 `auto_rejected` 共享包均必须具有当前有效扫描证据；
- 缺证据、证据陈旧、Scanner 不可用或证据字段不完整时不得批准；
- 普通反馈和建议不依赖角色包 Scanner；
- 不得通过“转人工”绕过技术扫描。

- [ ] **Step 2: 更新部署手册**

加入当前配置：

```text
SHARED_PACKAGE_SUBMISSIONS_ENABLED=false
```

明确阶段 2 Scanner 候选、协议契约和开发环境完整 smoke 完成前不得改为 `true`。

- [ ] **Step 3: 搜索并删除当前有效旧语义**

```powershell
rg -n "无需系统扫描|直接人工审核共享包|直接进入人工审核|扫描异常即通过" apps/website apps/cloudbase-api docs/operations
```

Expected: 当前代码、测试名和运维入口中不存在允许无扫描批准的有效语义。历史规格保留，并由 2026-08-15 规格声明替代范围。

- [ ] **Step 4: 运行子项目一完整验证**

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/cloudbase-api build
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd verify:cloudbase
```

阶段 0 已提供脚本时再运行：

```powershell
pnpm.cmd verify:web-chain
```

Expected: 全部自动化通过；未执行 Scanner、真实数据库或部署。

---

## 子项目二 Interface

`tools/cloudbase-migration-inventory.mjs` 产生：

```js
/**
 * @typedef {{
 *   version: string;
 *   name: string;
 *   fileName: string;
 *   sha256: string;
 *   bytes: number;
 * }} CloudBaseMigrationInventoryItem
 */

/**
 * @typedef {{
 *   mode: 'dry-run';
 *   migrations: readonly CloudBaseMigrationInventoryItem[];
 *   planSha256: string;
 * }} CloudBaseMigrationDryRun
 */

export async function inventoryCloudBaseMigrations(
  directoryUrl
) {}

export function createCloudBaseMigrationDryRun(
  migrations
) {}
```

文件名契约：

```regex
^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$
```

SHA-256 对 SQL 原始字节计算，不归一化编码或换行。`planSha256` 的输入精确为每项按版本升序拼接：

```text
<version>:<sha256>\n
```

输出不得包含绝对路径、SQL 正文、环境 ID 或凭据。

## Task 7: Migration inventory

**Files:**
- Create: `tools/cloudbase-migration-inventory.mjs`
- Create: `tools/cloudbase-migration-inventory.test.mjs`

**Interfaces:**
- Consumes: migration 目录 URL
- Produces: 有序且不可变语义的 `CloudBaseMigrationInventoryItem[]`

- [ ] **Step 1: 写排序与原始字节 checksum RED 测试**

```js
it('按版本排序并对 SQL 原始字节计算 SHA-256', async () => {
  await writeFile(
    join(root, '20260808000000_direct_manual_review.sql'),
    'SELECT 2;\r\n'
  );
  await writeFile(
    join(root, '20260730000000_moderation.sql'),
    'SELECT 1;\n'
  );

  const items = await inventoryCloudBaseMigrations(
    pathToFileURL(`${root}${sep}`)
  );

  assert.deepEqual(items.map(item => item.fileName), [
    '20260730000000_moderation.sql',
    '20260808000000_direct_manual_review.sql'
  ]);
  assert.equal(
    items[0].sha256,
    createHash('sha256').update('SELECT 1;\n').digest('hex')
  );
});
```

- [ ] **Step 2: 写失败关闭 RED 测试**

分别验证：

```js
await assert.rejects(
  inventoryCloudBaseMigrations(directoryWith('manual.sql')),
  /迁移文件名无效/u
);

await assert.rejects(
  inventoryCloudBaseMigrations(directoryWith(
    '20260808000000_first.sql',
    '20260808000000_second.sql'
  )),
  /迁移版本重复：20260808000000/u
);

await assert.rejects(
  inventoryCloudBaseMigrations(directoryWith(
    '20260808000000_empty.sql',
    ''
  )),
  /迁移文件为空/u
);
```

非 `.sql` 文件忽略；任何 `.sql` 文件名不符合契约必须失败。

- [ ] **Step 3: 运行测试确认 RED**

```powershell
node --test tools/cloudbase-migration-inventory.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现最小 inventory**

```js
export async function inventoryCloudBaseMigrations(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const seenVersions = new Set();
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const match = /^(?<version>\d{14})_(?<name>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u
      .exec(entry.name);
    if (!match?.groups) {
      throw new Error(`迁移文件名无效：${entry.name}`);
    }
    if (seenVersions.has(match.groups.version)) {
      throw new Error(`迁移版本重复：${match.groups.version}`);
    }

    const content = await readFile(new URL(entry.name, directoryUrl));
    if (content.byteLength === 0) {
      throw new Error(`迁移文件为空：${entry.name}`);
    }
    seenVersions.add(match.groups.version);
    migrations.push({
      version: match.groups.version,
      name: match.groups.name,
      fileName: entry.name,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength
    });
  }

  migrations.sort((left, right) =>
    left.version.localeCompare(right.version)
  );
  if (migrations.length === 0) {
    throw new Error('未发现 CloudBase PostgreSQL 迁移');
  }
  return migrations;
}
```

- [ ] **Step 5: 运行 GREEN**

```powershell
node --test tools/cloudbase-migration-inventory.test.mjs
```

Expected: PASS。

## Task 8: 稳定 dry-run plan

**Files:**
- Modify: `tools/cloudbase-migration-inventory.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`

**Interfaces:**
- Consumes: 已排序 inventory
- Produces: `CloudBaseMigrationDryRun`

- [ ] **Step 1: 写 plan RED 测试**

```js
it('生成稳定且不含 SQL 正文和绝对路径的 dry-run', () => {
  const checksum = 'a'.repeat(64);
  const plan = createCloudBaseMigrationDryRun([{
    version: '20260730000000',
    name: 'moderation',
    fileName: '20260730000000_moderation.sql',
    sha256: checksum,
    bytes: 10
  }]);

  assert.deepEqual(plan, {
    mode: 'dry-run',
    migrations: [{
      version: '20260730000000',
      name: 'moderation',
      fileName: '20260730000000_moderation.sql',
      sha256: checksum,
      bytes: 10
    }],
    planSha256: createHash('sha256')
      .update(`20260730000000:${checksum}\n`)
      .digest('hex')
  });
  assert.doesNotMatch(
    JSON.stringify(plan),
    /SELECT|TENCENT|CLOUDBASE_ENV_ID|:\\\\/u
  );
});
```

- [ ] **Step 2: 运行 RED**

```powershell
node --test tools/cloudbase-migration-inventory.test.mjs
```

Expected: `createCloudBaseMigrationDryRun` 不存在。

- [ ] **Step 3: 实现最小稳定 plan**

```js
export function createCloudBaseMigrationDryRun(migrations) {
  const planBody = migrations
    .map(item => `${item.version}:${item.sha256}\n`)
    .join('');
  return {
    mode: 'dry-run',
    migrations: migrations.map(item => ({ ...item })),
    planSha256: createHash('sha256')
      .update(planBody)
      .digest('hex')
  };
}
```

- [ ] **Step 4: 运行 GREEN**

```powershell
node --test tools/cloudbase-migration-inventory.test.mjs
```

Expected: PASS。

## Task 9: 只读 CLI 与旧写入口退役

**Files:**
- Create: `tools/plan-cloudbase-migrations.mjs`
- Create: `tools/plan-cloudbase-migrations.test.mjs`
- Delete: `tools/apply-cloudbase-migrations.mjs`
- Delete: `tools/apply-cloudbase-migrations.test.mjs`
- Modify: `package.json:7-27`
- No change: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `--dry-run` 与仓库 migration 目录
- Produces: stdout JSON plan；所有其他参数非零退出；零网络、零 SDK、零凭据读取

- [ ] **Step 1: 写 CLI RED 测试**

使用 `spawnSync(process.execPath, [cliPath, '--dry-run'])` 验证：

```js
assert.equal(result.status, 0);
const plan = JSON.parse(result.stdout);
assert.equal(plan.mode, 'dry-run');
assert.ok(plan.migrations.length >= 4);
assert.match(plan.planSha256, /^[a-f0-9]{64}$/u);
assert.doesNotMatch(
  result.stdout,
  /SELECT|TENCENTCLOUD_SECRET|CLOUDBASE_ENV_ID|Project Optimization/u
);
```

无参数和 `--apply`：

```js
assert.notEqual(run([]).status, 0);
assert.notEqual(run(['--apply']).status, 0);
assert.match(run(['--apply']).stderr, /当前迁移入口仅允许 --dry-run/u);
```

- [ ] **Step 2: 运行测试确认 RED**

```powershell
node --test tools/plan-cloudbase-migrations.test.mjs
```

Expected: CLI 不存在。

- [ ] **Step 3: 实现只读 CLI**

```js
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--dry-run') {
  throw new Error('当前迁移入口仅允许 --dry-run');
}

const directoryUrl = new URL('../cloudbase/migrations/', import.meta.url);
const inventory = await inventoryCloudBaseMigrations(directoryUrl);
const plan = createCloudBaseMigrationDryRun(inventory);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
```

CLI 不得导入 `@cloudbase/manager-node`，不得读取 process.env 凭据，不得包含 fetch、SDK初始化或数据库调用。

- [ ] **Step 4: 删除固定 SQL 写入口及专属测试**

精确删除：

- `tools/apply-cloudbase-migrations.mjs`
- `tools/apply-cloudbase-migrations.test.mjs`
- `readMigrationCredentials`
- `applyCloudBaseMigrations`
- 固定 `20260730000000_moderation.sql` 路径
- `executePGSql`

这是两个小文件的明确退役，不属于大量文件删除。

- [ ] **Step 5: 隔离阶段 2 管理 SDK，禁止阶段 1 CLI 导入**

先只读确认：

```powershell
rg -n "@cloudbase/manager-node" . --glob "!docs/superpowers/plans/**" --glob "!docs/superpowers/specs/**"
```

Expected: 旧工具删除后只允许根 `package.json` 与 `pnpm-lock.yaml` 命中；`tools/plan-cloudbase-migrations.mjs`、inventory 与测试不得命中。该依赖保留给阶段 2 的事务执行器，避免先删后加；阶段 1 不加载、不调用它，也不修改锁文件。

- [ ] **Step 6: 新增根脚本**

```json
{
  "plan:cloudbase-migrations": "node tools/plan-cloudbase-migrations.mjs --dry-run",
  "test:cloudbase-tools": "node --test tools/cloudbase-migration-inventory.test.mjs tools/plan-cloudbase-migrations.test.mjs tools/build-cloudbase-functions.test.mjs"
}
```

- [ ] **Step 7: 运行 GREEN**

```powershell
node --test tools/cloudbase-migration-inventory.test.mjs
node --test tools/plan-cloudbase-migrations.test.mjs
pnpm.cmd test:cloudbase-tools
pnpm.cmd plan:cloudbase-migrations
```

Expected: 全部 PASS；plan 按版本列出当前 migration 及 checksum，不包含 SQL 正文和绝对路径。

## Task 10: 冻结运维入口并定义阶段 2 衔接

**Files:**
- Modify: `docs/operations/cloudbase-deployment.md:9-25,119-125`
- Modify: `docs/operations/content-moderation.md:92-97`

**Interfaces:**
- Consumes: `pnpm.cmd plan:cloudbase-migrations`
- Produces: 唯一当前迁移入口为只读 dry-run；阶段 2 runner 的输入边界固定为 inventory item

- [ ] **Step 1: 删除旧有效执行命令**

从当前部署手册删除：

```powershell
node tools/apply-cloudbase-migrations.mjs
```

替换为：

```powershell
pnpm.cmd plan:cloudbase-migrations
```

- [ ] **Step 2: 写明阶段 1 冻结语义**

部署手册必须明确：

- 当前命令只读取仓库 migration 并输出 checksum plan；
- 阶段 2 完成前，任何环境都不得从仓库执行 migration；
- 不得通过控制台复制 SQL 绕过冻结；
- checksum 漂移、重复版本、非法文件名或空 migration 必须在 SQL 写入前停止；
- 已提交数据库变更只能新增前向 migration。

- [ ] **Step 3: 明确阶段 2 runner 的衔接 Interface**

阶段 2 的 `CloudBaseMigrationPlan` 必须直接消费本计划的：

```ts
type MigrationIdentity = {
  version: string;
  fileName: string;
  sha256: string;
  bytes: number;
};
```

阶段 2 另行实现并验收：

1. 读取数据库不可变 ledger；
2. 在专用数据库会话持有整轮 advisory lock；
3. 锁内重读 ledger 并计算 pending；
4. 每份 SQL body 与 ledger/checksum 在同一事务提交；
5. checksum 漂移、重复 ledger、未知已应用版本失败关闭；
6. SQL 中途、ledger 写入、commit 前后失联、双 runner 并发及续跑故障注入；
7. 只在新的 runner、自动化和开发环境 PostgreSQL smoke 通过后恢复数据库写入口。

阶段 2 不得重新引入固定 migration 路径或 `applyCloudBaseMigrations(environment)` 宽入口。

- [ ] **Step 4: 搜索旧当前入口**

```powershell
rg -n "applyCloudBaseMigrations|readMigrationCredentials|executePGSql|node tools/apply-cloudbase-migrations.mjs" tools package.json docs/operations
```

Expected: 零命中。历史 specs/plans 允许保留旧决策记录。

## Task 11: 阶段 1 最终验证与完成裁决

**Files:**
- Verify only: 本计划涉及的全部文件

**Interfaces:**
- Consumes: 两个子项目的 GREEN 结果
- Produces: 仓库级阶段 1 验收记录所需的可复现证据

- [x] **Step 1: 运行定向测试**

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts submission-service.test.ts admin-service.test.ts api.test.ts cloudbase-postgres.test.ts
pnpm.cmd --filter @myself/website test -- admin-app.test.tsx admin-api-client.test.ts
node --test tools/cloudbase-migration-inventory.test.mjs
node --test tools/plan-cloudbase-migrations.test.mjs
```

- [x] **Step 2: 运行包级与网站链门**

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/cloudbase-api build
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd verify:cloudbase
pnpm.cmd test:cloudbase-tools
```

阶段 0 已建立时追加：

```powershell
pnpm.cmd verify:web-chain
```

- [x] **Step 3: 运行范围、旧路径和格式检查**

```powershell
git diff --name-only
git diff --check
rg -n "applyCloudBaseMigrations|readMigrationCredentials|executePGSql|node tools/apply-cloudbase-migrations.mjs" tools package.json docs/operations
rg -n "无需系统扫描|直接人工审核共享包|扫描异常即通过" apps/website apps/cloudbase-api docs/operations
```

Expected:

- 差异不包含桌宠黑名单路径；
- `git diff --check` 无输出；
- 当前入口无旧 migration 写路径；
- 当前代码、测试名和运维文档无无扫描批准语义。

- [x] **Step 4: 记录完成状态**

只有以下全部满足才可把两个子项目标记为“自动化通过”：

- 投稿开关缺失时默认关闭，关闭时 prepare 零持久化/零签名调用；
- 只有显式 `true` 才允许既有共享包 prepare；
- 服务和数据库测试 Adapter 对缺失/陈旧证据返回 `TECHNICAL_SCAN_REQUIRED`；
- Admin UI 对缺证据共享包禁用批准并显示稳定原因；
- 反馈、建议、公开只读、管理员登录与查看不受影响；
- 新前向 SQL 已加入且历史 migration 字节未改写；
- inventory、顺序、checksum 与 dry-run 可重复；
- 无参数和 `--apply` 均不能执行迁移；
- 固定单 SQL 写入口及专属测试已删除；阶段 2 需要的管理 SDK 被只读 CLI 隔离且未发生删除/重加抖动；
- 当前运维文档只暴露 dry-run；
- 未连接 Scanner、数据库或任何远端服务。

外部状态必须分别写为：

- CloudBase PostgreSQL 实际防线：`待阶段 2 开发环境确认`。
- 事务型 migration runner：`不在本次范围`。
- Scanner 协议、镜像与完整扫描证据：`不在本次范围`。
- 共享包投稿生产开启：`不在本次范围，继续关闭`。
- 正式部署与上线：`不在本次范围`。

> **2026-08-21 实际裁决：自动化通过。** 首轮 `verify:web-chain` 的 14 passed / 2 failed 与未运行项保留在 Task 11 报告中。随后依据 `docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md` 和对应计划完成职责减法：提交 `d602d87` 将正式清单收敛为 14 项，四项 mutation RED/GREEN、三个生产文件零差异，测试代码净减少 51 行；scope 精确白名单修复为 `aea8e03`。固定顺序重跑的定向/包级门、fast/full 网站链、独立 scope、migration dry-run 和两项负向检索全部通过，完整门内 E2E 为 14/14。详细命令、计数和耗时见 `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/task-11-report.md` 与 `docs/operations/website-chain-verification-acceptance.md`。本裁决不改变以上五项外部状态，也不表示 Chromium/GPU 阻塞已修复。

## 删除条件汇总

本计划只允许以下明确退役：

1. `tools/apply-cloudbase-migrations.mjs`：只读 inventory CLI 测试通过后删除。
2. `tools/apply-cloudbase-migrations.test.mjs`：新 inventory/CLI 测试通过后删除。
3. `admin-service.test.ts` 与 `admin-app.test.tsx` 中“无扫描也可批准”的旧测试语义：对应 RED/GREEN 新用例通过后替换。
4. `AdminDetail.tsx` 的“仅历史自动驳回需要扫描”旧注释和条件：新 UI 用例通过后删除。
5. 当前运维文档中的旧写入命令和无扫描批准指引：新 dry-run 与失败关闭说明完成后删除。

不得删除：

- 任一历史 PostgreSQL migration；
- 历史规格和计划正文；
- Scanner 源码、协议或历史审核状态；
- 普通反馈和建议审核路径；
- 服务层或 SQL 任一安全复核层。

## 执行交接

计划实施时有两种方式：

1. **Subagent-Driven（推荐）**：使用 `subagent-driven-development`，每个 Task 交给新的实现子智能体，完成后依次进行规格符合性和代码质量审查；同一状态机、共享契约或 migration 不并行修改。
2. **Inline Execution**：使用 `executing-plans`，按 Task 顺序分批执行，每批在进入依赖任务前设置人工检查点。

无论选择哪种方式，Task 1—6 与 Task 7—10 可作为两个独立纵向子项目安排，但 Task 11 只能在两者均完成后执行。任何 Git 写操作、依赖变更、真实数据库连接或外部环境操作仍需单独授权。
