# AI Pet CloudBase 匿名投稿与双层审核上线实施计划

> **供智能代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按任务顺序执行。所有步骤使用复选框跟踪。

**目标：** 将网站的本地共享仓库和反馈原型升级为 CloudBase PG 模式的完全匿名投稿平台，实现系统审核、唯一管理员审核、私有文件扫描、三天隔离清理和可上线部署。

**架构：** 现有 Next.js 静态网站继续负责公开页面和独立 `/admin` 页面；一个 CloudBase HTTP 云函数提供 `/api/v1` 接口，定时云函数领取待审核任务，CloudBase Run 隔离容器检查 ZIP。PostgreSQL 保存状态与审计，私有 Bucket 保存文件，腾讯云 CAPTCHA、文本内容安全和图片内容安全通过服务端适配器接入。

**技术栈：** TypeScript 5、Next.js 15、React 19、Vitest 3、Playwright、Zod 3、CloudBase JS SDK v3、CloudBase Node SDK、CloudBase PostgreSQL、CloudBase PG Storage、腾讯云 Node.js SDK、CloudBase Run、Node.js 20、yauzl、sharp、ClamAV。

## 全局约束

- 只在 `WebsiteExtension` 分支对应的当前工作树中开发。
- 所有新增文档、代码注释、测试名称和用户可见文案使用中文。
- 实施采用最小修改策略，保留现有章节、动画、对话框和仓库抽象。
- 共享 ZIP 最大 100 MB，解压后最大 300 MB，最多 500 个文件。
- ZIP 内只允许 PNG、WebP 和 JSON；单张图片最大 10 MB。
- 封面只允许 PNG、WebP、JPG、JPEG，最大 5 MB。
- 所有公开投稿必须先通过系统审核，再由管理员批准；文件技术检查失败不得人工绕过。
- 匿名投稿不要求账号、手机号、邮箱或真实身份；CAPTCHA 必须由服务端验票。
- 管理员仅允许白名单中的唯一邮箱，通过邮箱验证码登录，不增加二次验证。
- 删除或驳回内容立即隐藏，文件隔离三天后永久清理。
- 审核依赖失败时保持隐藏，禁止失败放行。
- 正式文件保持私有，仅对 `published` 内容签发短期下载链接。
- 不把任何 SecretId、SecretKey、API Key、管理员邮箱或验证码密钥写入仓库。
- 计划中的 Git 提交步骤仅在用户明确授权 Git 写操作后执行；未获授权时跳过提交并保留工作树修改。

---

## 文件结构锁定

### 共享契约

- `packages/shared-types/src/moderation.ts`：投稿、状态、管理员动作和 API DTO 的唯一 Zod 契约。
- `packages/shared-types/src/index.ts`：导出审核契约。
- `packages/shared-types/tests/moderation.test.ts`：契约边界测试。
- `packages/character-assets/src/package-policy.ts`：在不改变桌面端默认限制的前提下支持网站扫描限制。
- `packages/character-assets/tests/package-policy.test.ts`：网站限制覆盖测试。

### CloudBase 后端

- `apps/cloudbase-api/package.json`：云函数依赖与构建脚本。
- `apps/cloudbase-api/tsconfig.json`、`apps/cloudbase-api/vitest.config.ts`：后端 TypeScript 与测试配置。
- `apps/cloudbase-api/migrations/001_moderation.sql`：业务表、索引、约束、RLS 和存储 Bucket 策略。
- `apps/cloudbase-api/src/config.ts`：只从环境变量读取配置并启动时校验。
- `apps/cloudbase-api/src/ports.ts`：数据库、存储、CAPTCHA、审核、扫描和时钟端口。
- `apps/cloudbase-api/src/errors.ts`：稳定错误码与 HTTP 映射。
- `apps/cloudbase-api/src/crypto/status-token.ts`：查询令牌生成与 SHA-256 哈希。
- `apps/cloudbase-api/src/http/router.ts`：无框架 HTTP 路由和响应规范化。
- `apps/cloudbase-api/src/services/submission-service.ts`：匿名投稿、上传完成、状态查询。
- `apps/cloudbase-api/src/services/public-content-service.ts`：公开列表、详情、点赞和下载。
- `apps/cloudbase-api/src/services/moderation-service.ts`：审核任务领取、系统结果聚合和重试。
- `apps/cloudbase-api/src/services/admin-service.ts`：管理员授权、审核动作和审计记录。
- `apps/cloudbase-api/src/services/cleanup-service.ts`：三天隔离清理和残缺上传清理。
- `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`：`app.rdb()` 数据访问。
- `apps/cloudbase-api/src/adapters/cloudbase-storage.ts`：签名上传、对象核对、签名下载和删除。
- `apps/cloudbase-api/src/adapters/cloudbase-auth.ts`：调用者 UID、邮箱和管理员白名单。
- `apps/cloudbase-api/src/adapters/tencent-captcha.ts`：`DescribeCaptchaResult` 服务端验票。
- `apps/cloudbase-api/src/adapters/tencent-content-moderation.ts`：TMS、IMS 和 OCR 结果归一化。
- `apps/cloudbase-api/src/adapters/cloudbase-relevance.ts`：通过 CloudBase AI 判断投稿是否与 AI Pet 直接相关。
- `apps/cloudbase-api/src/adapters/scanner-client.ts`：向隔离扫描服务发送 HMAC 请求。
- `apps/cloudbase-api/src/functions/api.ts`：公开及管理员 HTTP 入口。
- `apps/cloudbase-api/src/functions/moderation-worker.ts`：定时审核工作器入口。
- `apps/cloudbase-api/src/functions/cleanup.ts`：定时清理入口。
- `apps/cloudbase-api/tests/*.test.ts`：按服务、适配器和入口拆分的后端测试。
- `tools/build-cloudbase-functions.mjs`：将三个入口打包为 CloudBase 可部署的 CommonJS 函数。
- `cloudbaserc.json`：三项函数的 Node.js 20 配置，不保存环境密钥。

### ZIP 隔离扫描

- `apps/package-scanner/package.json`、`tsconfig.json`、`vitest.config.ts`：扫描服务工程配置。
- `apps/package-scanner/src/server.ts`：仅暴露 `/healthz` 与 HMAC 保护的 `/internal/scan`。
- `apps/package-scanner/src/scan-package.ts`：ZIP 结构、内容类型、JSON、图片和 ClamAV 编排。
- `apps/package-scanner/src/request-signature.ts`：内部请求时间窗与 HMAC 校验。
- `apps/package-scanner/Dockerfile`：Node.js 20、ClamAV 和最小运行用户。
- `apps/package-scanner/tests/*.test.ts`：恶意 ZIP、签名和扫描结果测试。

### 网站

- `apps/website/lib/api-client.ts`：统一 fetch、稳定错误和运行时 API 地址。
- `apps/website/lib/captcha.ts`：动态加载腾讯验证码脚本并返回 `ticket/randstr`。
- `apps/website/lib/submission-status.ts`：从 URL Fragment 读取令牌，不写入服务器 URL。
- `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`：替换生产 IndexedDB。
- `apps/website/components/website-experience/community/shared-pet-types.ts`：投稿回执和签名下载类型。
- `apps/website/components/website-experience/community/SharedPetChapter.tsx`：显示待审核回执。
- `apps/website/components/website-experience/community/SharedPetComposerDialog.tsx`：CAPTCHA 与投稿说明。
- `apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`：替换生产 localStorage。
- `apps/website/components/website-experience/feedback/feedback-types.ts`：异步刷新、投稿回执和异步点赞。
- `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`：异步云端数据与待审核结果。
- `apps/website/components/website-experience/chapter-registry.tsx`、`WebsiteExperience.tsx`：注入云仓库。
- `apps/website/app/submission-status/page.tsx`：匿名状态查询页面。
- `apps/website/app/admin/page.tsx`：管理员工作台入口。
- `apps/website/components/admin/*`：登录、队列、详情、动作与审计界面。
- `apps/website/components/i18n/messages.ts`：新增中英文审核、状态和管理员文案。
- `apps/website/next.config.ts`：保留静态导出并明确运行时 API 配置。
- `apps/website/tests/*`、`tests/e2e/website.spec.ts`：云仓库、投稿、状态页和管理员端测试。

### 运维

- `docs/operations/cloudbase-deployment.md`：开发与生产部署、密钥、域名、网关和回滚。
- `docs/operations/content-moderation.md`：审核规则、误判处理、自动驳回与人工流程。
- `apps/website/public/legal/privacy.html`、`terms.html`、`content-policy.html`：中文为主、包含英文摘要的上线基础文本。

---

### Task 1：建立审核共享契约

**文件：**

- 新建：`packages/shared-types/src/moderation.ts`
- 修改：`packages/shared-types/src/index.ts`
- 新建：`packages/shared-types/tests/moderation.test.ts`

**接口：**

- 产出：`submissionStatusSchema`、`captchaProofSchema`、`submissionReceiptSchema`、`submissionStatusViewSchema`、`adminActionSchema`。
- 产出：`SubmissionStatus`、`CaptchaProof`、`SubmissionReceipt`、`SubmissionStatusView`、`AdminAction`。
- 后续任务只从 `@myself/shared-types` 引用这些名称。

- [ ] **Step 1：先写契约失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  adminActionSchema,
  captchaProofSchema,
  submissionStatusSchema
} from '../src/moderation';

describe('投稿审核契约', () => {
  it('只接受已定义状态', () => {
    expect(submissionStatusSchema.parse('system_reviewing')).toBe('system_reviewing');
    expect(() => submissionStatusSchema.parse('approved')).toThrow();
  });

  it('验证码票据必须同时包含 ticket 和 randstr', () => {
    expect(captchaProofSchema.parse({ ticket: 'ticket-1', randstr: 'rand-1' }))
      .toEqual({ ticket: 'ticket-1', randstr: 'rand-1' });
    expect(() => captchaProofSchema.parse({ ticket: 'ticket-1' })).toThrow();
  });

  it('管理员批准必须携带版本和幂等键', () => {
    expect(adminActionSchema.parse({
      action: 'approve',
      version: 3,
      idempotencyKey: 'idem-00000001',
      reason: '系统误判，人工复核通过'
    }).version).toBe(3);
  });
});
```

- [ ] **Step 2：运行测试并确认红灯**

运行：`pnpm --filter @myself/shared-types test -- moderation.test.ts`

预期：失败，提示找不到 `../src/moderation`。

- [ ] **Step 3：实现最小契约**

```ts
export const submissionStatuses = [
  'uploading',
  'system_reviewing',
  'manual_review_pending',
  'published',
  'auto_rejected',
  'admin_rejected',
  'deleted_quarantined',
  'purged'
] as const;

export const submissionStatusSchema = z.enum(submissionStatuses);
export const captchaProofSchema = z.object({
  ticket: z.string().min(1).max(4096),
  randstr: z.string().min(1).max(256)
}).strict();
```

同时定义：

```ts
export const adminActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'move_to_manual', 'delete', 'restore']),
  version: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
  reason: z.string().trim().min(1).max(500)
}).strict();

export interface SubmissionReceipt {
  submissionId: string;
  statusToken: string;
  statusPath: '/submission-status/';
  status: 'uploading' | 'system_reviewing';
}
```

- [ ] **Step 4：验证契约**

运行：

```powershell
pnpm --filter @myself/shared-types test -- moderation.test.ts
pnpm --filter @myself/shared-types typecheck
```

预期：全部通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add packages/shared-types
git commit -m "feat: 增加匿名投稿审核共享契约"
```

---

### Task 2：让现有 ZIP 策略支持网站限制

**文件：**

- 修改：`packages/character-assets/src/package-policy.ts`
- 修改：`packages/character-assets/tests/package-policy.test.ts`

**接口：**

- 消费：现有 `PackageEntryDescriptor`。
- 产出：`validatePackageEntries(entries, limits?)`，缺省行为与桌面端完全一致。
- 产出：`WEBSITE_SHARED_PACKAGE_LIMITS`，值为 500 个文件、300 MB 总解压、10 MB 单资源、100 倍膨胀率。

- [ ] **Step 1：写覆盖参数失败测试**

```ts
test('网站策略限制 500 个文件和 10 MB 单图', () => {
  const limits = {
    ...CHARACTER_PACKAGE_LIMITS,
    maxEntries: 500,
    maxFiles: 500,
    maxTotalUncompressedBytes: 300 * 1024 * 1024,
    maxResourceBytes: 10 * 1024 * 1024
  };

  expect(() => validatePackageEntries([{
    path: 'compiled/too-large.png',
    kind: 'file',
    compressedBytes: 1024 * 1024,
    uncompressedBytes: 10 * 1024 * 1024 + 1
  }], limits)).toThrow('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/character-assets test -- package-policy.test.ts`

预期：TypeScript 报告 `validatePackageEntries` 不接受第二个参数。

- [ ] **Step 3：最小扩展现有函数**

```ts
export function validatePackageEntries(
  entries: readonly PackageEntryDescriptor[],
  limits: CharacterPackageLimits = CHARACTER_PACKAGE_LIMITS
): PackageValidationResult {
  // 所有原有常量读取替换为 limits 字段，校验顺序不变。
}

export const WEBSITE_SHARED_PACKAGE_LIMITS = Object.freeze({
  ...CHARACTER_PACKAGE_LIMITS,
  maxEntries: 500,
  maxFiles: 500,
  maxTotalUncompressedBytes: 300 * 1024 * 1024,
  maxResourceBytes: 10 * 1024 * 1024
});
```

- [ ] **Step 4：验证默认策略未回归**

运行：

```powershell
pnpm --filter @myself/character-assets test
pnpm --filter @myself/character-assets typecheck
```

预期：现有桌面端策略测试和新增网站策略测试全部通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add packages/character-assets
git commit -m "feat: 复用角色包策略支持网站扫描限制"
```

---

### Task 3：搭建 CloudBase API 工程与稳定错误边界

**文件：**

- 新建：`apps/cloudbase-api/package.json`
- 新建：`apps/cloudbase-api/tsconfig.json`
- 新建：`apps/cloudbase-api/vitest.config.ts`
- 新建：`apps/cloudbase-api/src/config.ts`
- 新建：`apps/cloudbase-api/src/ports.ts`
- 新建：`apps/cloudbase-api/src/errors.ts`
- 新建：`apps/cloudbase-api/src/http/router.ts`
- 新建：`apps/cloudbase-api/tests/config.test.ts`
- 新建：`apps/cloudbase-api/tests/router.test.ts`

**接口：**

- 产出：`loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig`。
- 产出：`ApiError`、`jsonResponse()`、`createRouter()`。
- 产出端口：`SubmissionStore`、`ObjectStorage`、`CaptchaVerifier`、`ContentModerator`、`RelevanceClassifier`、`PackageScanner`、`AdminIdentityProvider`、`Clock`。

- [ ] **Step 1：写配置与路由失败测试**

```ts
it('缺少管理员邮箱时拒绝启动', () => {
  expect(() => loadCloudConfig({
    CLOUDBASE_ENV_ID: 'env-test',
    PRIVATE_BUCKET_ID: 'ai-pet-private'
  })).toThrow('ADMIN_EMAIL');
});

it('未知 API 路径返回稳定 404', async () => {
  const response = await createRouter([])({
    httpMethod: 'GET',
    path: '/api/v1/missing',
    headers: {},
    body: ''
  });
  expect(response).toMatchObject({
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/cloudbase-api test`

预期：工程或目标模块尚不存在。

- [ ] **Step 3：创建工程与端口**

`package.json` 必须包含：

```json
{
  "name": "@myself/cloudbase-api",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node ../../tools/build-cloudbase-functions.mjs",
    "test": "vitest run --config vitest.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cloudbase/js-sdk": "^3.6.8",
    "@cloudbase/node-sdk": "^3.18.3",
    "@myself/shared-types": "workspace:*",
    "tencentcloud-sdk-nodejs": "^4.1.281",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "esbuild": "^0.28.1",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

`CloudConfig` 至少包含：

```ts
export interface CloudConfig {
  envId: string;
  privateBucketId: string;
  adminEmail: string;
  captchaAppId: number;
  captchaSecretKey: string;
  moderationRegion: string;
  tmsBizType: string;
  imsBizType: string;
  scannerUrl: string;
  scannerHmacSecret: string;
  cloudbaseAiApiKey: string;
  relevanceModel: 'deepseek-v4-flash';
}
```

路由统一输出：

```ts
{
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  },
  body: JSON.stringify({ data, error, requestId })
}
```

- [ ] **Step 4：运行后端基础验证**

运行：

```powershell
pnpm install --lockfile-only
pnpm --filter @myself/cloudbase-api test
pnpm --filter @myself/cloudbase-api typecheck
```

预期：测试与类型检查通过；锁文件只出现预期依赖变化。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api package.json pnpm-lock.yaml
git commit -m "feat: 建立 CloudBase 审核 API 基础工程"
```

---

### Task 4：建立 PostgreSQL 结构与数据仓储

**文件：**

- 新建：`apps/cloudbase-api/migrations/001_moderation.sql`
- 新建：`apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- 新建：`apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- 新建：`tools/apply-cloudbase-migrations.mjs`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

**接口：**

- 实现 `SubmissionStore`。
- 关键方法：

```ts
createSubmission(input: NewSubmission): Promise<SubmissionRow>;
completeUpload(input: CompleteUploadInput): Promise<SubmissionRow>;
findByStatusTokenHash(hash: string): Promise<SubmissionStatusView | null>;
claimModerationJobs(limit: number, leaseUntil: string): Promise<SubmissionRow[]>;
recordModerationResult(result: ModerationRecord): Promise<void>;
applyAdminAction(input: AdminActionInput): Promise<AdminActionResult>;
listPublished(input: PublicListQuery): Promise<PublicSubmissionPage>;
listPurgeCandidates(now: string, limit: number): Promise<SubmissionRow[]>;
```

- [ ] **Step 1：写迁移结构测试**

```ts
it('迁移包含必要表、状态约束和版本条件更新', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const table of [
    'submissions',
    'assets',
    'moderation_results',
    'admin_audit_logs',
    'public_engagement'
  ]) {
    expect(sql).toContain(`CREATE TABLE ${table}`);
  }
  expect(sql).toContain('status_version');
  expect(sql).toContain('purge_after');
  expect(sql).toContain('FOR UPDATE SKIP LOCKED');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts`

预期：迁移文件不存在。

- [ ] **Step 3：实现迁移与 `app.rdb()` 适配器**

状态约束必须精确包含 Task 1 的八种状态。查询令牌列只允许：

```sql
status_token_hash char(64) NOT NULL UNIQUE
```

并发管理员动作使用数据库函数：

```sql
UPDATE submissions
SET status = p_next_status,
    status_version = status_version + 1,
    updated_at = now()
WHERE id = p_submission_id
  AND status_version = p_expected_version
RETURNING *;
```

RLS 原则：

- `anon` 不直接读写业务表或私有 Bucket。
- `authenticated` 不直接读写业务表。
- 只有服务端 `service_role` 访问完整数据。
- 公开数据只能经云函数裁剪后返回。

根开发依赖增加 `"@cloudbase/manager-node": "^5.6.5"`。迁移工具只从 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`、`CLOUDBASE_ENV_ID` 读取凭据，并调用 `@cloudbase/manager-node` 的 `executePGSql`；禁止打印环境变量。

- [ ] **Step 4：验证仓储与 SQL**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts
pnpm --filter @myself/cloudbase-api typecheck
```

预期：内存化 SDK 替身验证分页、租约领取、版本冲突和幂等动作通过；`git diff` 中不出现密钥。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api/migrations apps/cloudbase-api/src/adapters/cloudbase-postgres.ts apps/cloudbase-api/tests/cloudbase-postgres.test.ts tools/apply-cloudbase-migrations.mjs package.json pnpm-lock.yaml
git commit -m "feat: 增加审核数据库结构与仓储"
```

---

### Task 5：实现私有上传、匿名状态查询和公开下载

**文件：**

- 新建：`apps/cloudbase-api/src/crypto/status-token.ts`
- 新建：`apps/cloudbase-api/src/adapters/cloudbase-storage.ts`
- 新建：`apps/cloudbase-api/src/services/submission-service.ts`
- 新建：`apps/cloudbase-api/src/services/public-content-service.ts`
- 新建：`apps/cloudbase-api/tests/submission-service.test.ts`
- 新建：`apps/cloudbase-api/tests/public-content-service.test.ts`

**接口：**

- `SubmissionService.prepare(input, context): Promise<SubmissionReceipt & UploadTargets>`
- `SubmissionService.finalize(input): Promise<{ status: 'system_reviewing' }>`
- `SubmissionService.getStatus(token): Promise<SubmissionStatusView>`
- `PublicContentService.getDownload(id, fingerprint): Promise<SignedDownload>`

- [ ] **Step 1：写生命周期失败测试**

```ts
it('prepare 验票后只返回私有单次上传目标和一次性状态令牌', async () => {
  const receipt = await service.prepare(validSharedPackageInput, requestContext);
  expect(receipt.status).toBe('uploading');
  expect(receipt.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(receipt.packageUpload.url).toMatch(/^https:/);
  expect(store.created.statusTokenHash).not.toBe(receipt.statusToken);
});

it('未发布内容不能获得下载链接', async () => {
  await expect(publicService.getDownload('pending-id', 'device-hash'))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
});
```

- [ ] **Step 2：确认测试失败**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- submission-service.test.ts
pnpm --filter @myself/cloudbase-api test -- public-content-service.test.ts
```

预期：服务尚不存在。

- [ ] **Step 3：实现最小服务**

令牌：

```ts
export function createStatusToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashStatusToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
```

对象路径固定为：

```ts
submissions/{submissionId}/cover.{extension}
submissions/{submissionId}/package.zip
```

上传必须使用 `createSignedUploadUrl(path, { upsert: false })`。`finalize` 使用 `info(path)` 核对对象存在、实际大小和 MIME，再把记录从 `uploading` 原子转为 `system_reviewing`。下载只对 `published` 记录调用 `createSignedUrl(path, 300)`，有效期五分钟。

- [ ] **Step 4：验证上传与下载边界**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- submission-service.test.ts public-content-service.test.ts
pnpm --filter @myself/cloudbase-api typecheck
```

预期：重复 finalize 幂等、对象不完整拒绝、状态令牌哈希查询、未发布下载拒绝全部通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api/src/crypto apps/cloudbase-api/src/adapters/cloudbase-storage.ts apps/cloudbase-api/src/services apps/cloudbase-api/tests
git commit -m "feat: 实现匿名投稿与私有文件生命周期"
```

---

### Task 6：接入 CAPTCHA、限流与公开 HTTP 路由

**文件：**

- 新建：`apps/cloudbase-api/src/adapters/tencent-captcha.ts`
- 新建：`apps/cloudbase-api/src/services/abuse-control.ts`
- 新建：`apps/cloudbase-api/src/functions/api.ts`
- 新建：`apps/cloudbase-api/tests/tencent-captcha.test.ts`
- 新建：`apps/cloudbase-api/tests/api.test.ts`

**接口：**

- `CaptchaVerifier.verify(proof, ip): Promise<void>`。
- `AbuseControl.consume(scope, fingerprint): Promise<void>`。
- `api.main(event, context): Promise<CloudBaseHttpResponse>`。

- [ ] **Step 1：写验票与路由失败测试**

```ts
it('CaptchaCode 非 1 时拒绝投稿', async () => {
  captchaClient.DescribeCaptchaResult.mockResolvedValue({ CaptchaCode: 8 });
  await expect(verifier.verify({ ticket: 'expired', randstr: 'r' }, '203.0.113.8'))
    .rejects.toMatchObject({ code: 'CAPTCHA_INVALID' });
});

it('匿名 prepare 缺少 CAPTCHA 返回 400', async () => {
  const response = await main(httpEvent('POST', '/api/v1/submissions/prepare', {}), context);
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error.code).toBe('INVALID_REQUEST');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/cloudbase-api test -- tencent-captcha.test.ts api.test.ts`

预期：模块不存在。

- [ ] **Step 3：实现服务端验票和公开路由**

腾讯验证码调用参数固定包含：

```ts
{
  CaptchaType: 9,
  Ticket: proof.ticket,
  UserIp: ip,
  Randstr: proof.randstr,
  CaptchaAppId: config.captchaAppId,
  AppSecretKey: config.captchaSecretKey
}
```

只有 `CaptchaCode === 1` 视为通过。ticket 有效期和一次性约束由腾讯接口验证，服务端另外保存五分钟票据哈希，拒绝本应用内重放。

路由至少注册：

```ts
POST /api/v1/submissions/prepare
POST /api/v1/submissions/:id/finalize
POST /api/v1/feedback
POST /api/v1/submission-status
GET  /api/v1/community
GET  /api/v1/community/:id
POST /api/v1/community/:id/like
POST /api/v1/community/:id/download
```

限流基线：

- 单 IP：10 分钟最多 5 次投稿准备。
- 单 IP：每分钟最多 30 次状态查询。
- 单 IP + 资源 ID：每分钟最多 10 次点赞或下载。
- 超限返回 `429` 与 `retryAfterSeconds`。

- [ ] **Step 4：验证 API 安全边界**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- tencent-captcha.test.ts api.test.ts
pnpm --filter @myself/cloudbase-api typecheck
```

预期：缺票、坏票、重放、超限、未知路由和公开 DTO 裁剪测试全部通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api/src/adapters/tencent-captcha.ts apps/cloudbase-api/src/services/abuse-control.ts apps/cloudbase-api/src/functions/api.ts apps/cloudbase-api/tests
git commit -m "feat: 接入匿名投稿验证码与公开接口"
```

---

### Task 7：实现 ZIP 隔离扫描服务

**文件：**

- 新建：`apps/package-scanner/package.json`
- 新建：`apps/package-scanner/tsconfig.json`
- 新建：`apps/package-scanner/vitest.config.ts`
- 新建：`apps/package-scanner/src/request-signature.ts`
- 新建：`apps/package-scanner/src/scan-package.ts`
- 新建：`apps/package-scanner/src/server.ts`
- 新建：`apps/package-scanner/Dockerfile`
- 新建：`apps/package-scanner/tests/request-signature.test.ts`
- 新建：`apps/package-scanner/tests/scan-package.test.ts`

**接口：**

- `verifyInternalSignature(request, secret, now): void`。
- `scanPackage(input: ScanPackageInput): Promise<PackageScanResult>`。
- `PackageScanResult` 只返回结构化代码、文件清单摘要、JSON 文本和图片审核信号列表，不返回文件内容。

- [ ] **Step 1：写恶意包失败测试**

```ts
it.each([
  ['路径穿越', '../evil.json', 'CHARACTER_PACKAGE_PATH_REJECTED'],
  ['嵌套压缩', 'nested.zip', 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED'],
  ['脚本文件', 'run.js', 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED']
])('%s 被拒绝', async (_name, path, code) => {
  const archive = await zipFixture([{ path, bytes: Buffer.from('{}') }]);
  await expect(scanPackage({ archivePath: archive, clamav: cleanClamav }))
    .rejects.toThrow(code);
});
```

再覆盖：

- 501 个文件。
- 解压总量超过 300 MB。
- 单图超过 10 MB。
- 加密 ZIP。
- 符号链接。
- 大小写或 Unicode 归一化冲突。
- 扩展名、签名和 MIME 不一致。
- JSON 解析失败或 `compiled/manifest.json` 不符合 `characterManifestV1Schema`。
- ClamAV 命中。

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/package-scanner test`

预期：扫描工程不存在。

- [ ] **Step 3：实现流式扫描**

扫描器 `package.json` 使用：

```json
{
  "name": "@myself/package-scanner",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/server.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --config vitest.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@myself/character-assets": "workspace:*",
    "@myself/character-runtime": "workspace:*",
    "sharp": "0.34.5",
    "tencentcloud-sdk-nodejs": "^4.1.281",
    "yauzl": "3.4.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/yauzl": "2.10.3",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

扫描顺序固定为：

1. 下载对象到受限临时目录。
2. 校验 ZIP 头、加密标记和目录项。
3. 用 `validatePackageEntries(entries, WEBSITE_SHARED_PACKAGE_LIMITS)` 校验路径与大小。
4. 流式解压单个文件，不把整个 300 MB 包读入内存。
5. 用文件签名判断 PNG、WebP、JSON，拒绝嵌套压缩和未知类型。
6. 用 `sharp(...).metadata()` 安全解码图片。
7. 解析并验证 `compiled/manifest.json`，复用 `characterManifestV1Schema`。
8. 对所有文件执行 ClamAV 扫描。
9. 通过仅具 IMS 权限的 CAM 子账号审核 ZIP 内图片并归一化 OCR/风险信号。
10. 删除临时目录后返回结果。

内部签名内容：

```ts
`${timestamp}\n${sha256(rawBody)}`
```

请求超过五分钟或签名不匹配返回 `401`。

Dockerfile 使用非 root 用户，并把 `/tmp/scan` 作为唯一工作目录；容器内存至少 1 GB，单请求并发设为 1，最小实例数设为 0。

- [ ] **Step 4：验证扫描器**

运行：

```powershell
pnpm --filter @myself/package-scanner test
pnpm --filter @myself/package-scanner typecheck
docker build -f apps/package-scanner/Dockerfile -t ai-pet-package-scanner:local .
```

预期：测试通过，镜像构建成功，容器以非 root 用户启动，`/healthz` 返回 200。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/package-scanner packages/character-assets
git commit -m "feat: 增加共享资源包隔离扫描服务"
```

---

### Task 8：实现自动审核编排和定时工作器

**文件：**

- 新建：`apps/cloudbase-api/src/adapters/tencent-content-moderation.ts`
- 新建：`apps/cloudbase-api/src/adapters/cloudbase-relevance.ts`
- 新建：`apps/cloudbase-api/src/adapters/scanner-client.ts`
- 新建：`apps/cloudbase-api/src/services/moderation-service.ts`
- 新建：`apps/cloudbase-api/src/functions/moderation-worker.ts`
- 新建：`apps/cloudbase-api/tests/tencent-content-moderation.test.ts`
- 新建：`apps/cloudbase-api/tests/moderation-service.test.ts`

**接口：**

- `ContentModerator.reviewText(input): Promise<ModerationSignal>`。
- `ContentModerator.reviewImage(input): Promise<ModerationSignal>`。
- `RelevanceClassifier.classify(input): Promise<'pass' | 'review' | 'reject'>`。
- `PackageScanner.scan(input): Promise<PackageScanResult>`。
- `ModerationService.processNextBatch(limit): Promise<BatchResult>`。

- [ ] **Step 1：写聚合规则失败测试**

```ts
it.each([
  [{ suggestion: 'Block', label: 'Abuse' }, 'auto_rejected'],
  [{ suggestion: 'Review', label: 'Politics' }, 'manual_review_pending'],
  [{ suggestion: 'Pass', label: 'Normal' }, 'manual_review_pending']
])('审核建议映射为固定状态', async (signal, expected) => {
  moderator.reviewText.mockResolvedValue(signal);
  scanner.scan.mockResolvedValue(safePackageResult);
  expect((await service.process('submission-1')).status).toBe(expected);
});

it('技术扫描未完成时不允许进入管理员可批准状态', async () => {
  scanner.scan.mockRejectedValue(new Error('扫描服务超时'));
  expect((await service.process('submission-1')).status).toBe('system_reviewing');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/cloudbase-api test -- moderation-service.test.ts`

预期：审核服务不存在。

- [ ] **Step 3：实现固定决策表**

决策顺序：

```ts
if (!technicalScan.complete) return 'system_reviewing';
if (!technicalScan.safe || relevance === 'reject') return 'auto_rejected';
if (signals.some(signal => signal.suggestion === 'Block')) return 'auto_rejected';
return 'manual_review_pending';
```

要求：

- TMS 检查标题、正文和 JSON 文本，支持中英文。
- IMS 在工作器中检查封面，在扫描器中检查 ZIP 内图片，并保存 OCR 风险摘要。
- 政治、脏话及其他禁止标签进入 `auto_rejected`。
- AI Pet 相关性通过 CloudBase OpenAI 兼容接口调用 `deepseek-v4-flash`，使用温度 0、固定 JSON Schema 和最多 300 输出 token；模型只返回 `pass/review/reject` 信号，不直接写状态。
- 相关性 `reject` 进入 `auto_rejected`，`review` 进入 `manual_review_pending`，调用失败保持 `system_reviewing`。
- `RelevanceClassifier` 调用失败时抛出受控错误，由工作器记录重试并保持 `system_reviewing`，不会执行上述决策函数。
- 所有外部原始响应保存为受限结构化审计记录，公开 API 不返回。
- 工作器每分钟领取最多 3 个任务；使用十分钟租约，失败指数退避，最多重试 5 次后仍保持系统审核并告警。

- [ ] **Step 4：验证系统审核**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- tencent-content-moderation.test.ts moderation-service.test.ts
pnpm --filter @myself/cloudbase-api typecheck
```

预期：通过、明确违规、不确定、超时、重试和技术扫描失败场景全部通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api/src/adapters/tencent-content-moderation.ts apps/cloudbase-api/src/adapters/cloudbase-relevance.ts apps/cloudbase-api/src/adapters/scanner-client.ts apps/cloudbase-api/src/services/moderation-service.ts apps/cloudbase-api/src/functions/moderation-worker.ts apps/cloudbase-api/tests
git commit -m "feat: 实现系统内容审核编排"
```

---

### Task 9：实现唯一管理员授权、审核 API 和三天清理

**文件：**

- 新建：`apps/cloudbase-api/src/adapters/cloudbase-auth.ts`
- 新建：`apps/cloudbase-api/src/services/admin-service.ts`
- 新建：`apps/cloudbase-api/src/services/cleanup-service.ts`
- 新建：`apps/cloudbase-api/src/functions/cleanup.ts`
- 修改：`apps/cloudbase-api/src/functions/api.ts`
- 新建：`apps/cloudbase-api/tests/admin-service.test.ts`
- 新建：`apps/cloudbase-api/tests/cleanup-service.test.ts`
- 修改：`apps/cloudbase-api/tests/api.test.ts`

**接口：**

- `AdminIdentityProvider.requireAdmin(): Promise<AdminIdentity>`。
- `AdminService.listQueue(query): Promise<AdminQueuePage>`。
- `AdminService.getDetail(id): Promise<AdminSubmissionDetail>`。
- `AdminService.applyAction(id, action): Promise<AdminActionResult>`。
- `CleanupService.purgeDue(limit): Promise<PurgeResult>`。

- [ ] **Step 1：写授权、并发和清理失败测试**

```ts
it('登录邮箱不等于白名单时返回 403', async () => {
  auth.getUserInfo.mockReturnValue({ uid: 'uid-other' });
  auth.getEndUserInfo.mockResolvedValue({ userInfo: { email: 'other@example.com' } });
  await expect(provider.requireAdmin()).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('管理员不能批准技术扫描未通过的投稿', async () => {
  await expect(service.applyAction('submission-1', approveAction))
    .rejects.toMatchObject({ code: 'TECHNICAL_SCAN_REQUIRED' });
});

it('只清理 purge_after 已到期记录并先删对象后清正文', async () => {
  await cleanup.purgeDue(20);
  expect(storage.remove).toHaveBeenCalledBefore(store.markPurged);
});
```

- [ ] **Step 2：确认测试失败**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- admin-service.test.ts cleanup-service.test.ts api.test.ts
```

预期：服务不存在。

- [ ] **Step 3：实现管理员与清理逻辑**

管理员授权：

```ts
const { uid } = auth.getUserInfo();
if (!uid) throw new ApiError('UNAUTHORIZED', 401);
const { userInfo } = await auth.getEndUserInfo(uid);
if (userInfo.email.toLowerCase() !== config.adminEmail.toLowerCase()) {
  throw new ApiError('FORBIDDEN', 403);
}
```

管理员路由：

```ts
GET  /api/v1/admin/submissions
GET  /api/v1/admin/submissions/:id
POST /api/v1/admin/submissions/:id/actions
```

动作约束：

- `approve`：仅允许 `manual_review_pending` 或技术扫描已通过的 `auto_rejected`。
- `reject`：写管理员理由，立即隐藏，`purge_after = now + 3 days`。
- `move_to_manual`：仅允许 `auto_rejected`。
- `delete`：记录删除前状态，进入 `deleted_quarantined`，三天内可恢复。
- `restore`：仅允许 `deleted_quarantined` 且尚未清理。
- 所有动作以 `status_version` 和 `idempotencyKey` 防止并发重复，并写 `admin_audit_logs`。

清理顺序：

1. 领取到期记录并加租约。
2. 删除私有对象。
3. 清空标题、正文、对象键和审核证据正文。
4. 标记 `purged`，保留最小审计摘要。
5. 删除超过一小时仍为 `uploading` 的残缺对象和记录。

- [ ] **Step 4：验证管理员与清理**

运行：

```powershell
pnpm --filter @myself/cloudbase-api test -- admin-service.test.ts cleanup-service.test.ts api.test.ts
pnpm --filter @myself/cloudbase-api typecheck
```

预期：白名单、未登录、技术扫描门禁、版本冲突、幂等、恢复和三天清理测试通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/cloudbase-api/src/adapters/cloudbase-auth.ts apps/cloudbase-api/src/services/admin-service.ts apps/cloudbase-api/src/services/cleanup-service.ts apps/cloudbase-api/src/functions apps/cloudbase-api/tests
git commit -m "feat: 增加管理员审核与三天隔离清理"
```

---

### Task 10：打包 CloudBase 函数并固定部署配置

**文件：**

- 新建：`tools/build-cloudbase-functions.mjs`
- 新建：`cloudbaserc.json`
- 修改：`package.json`
- 新建：`apps/cloudbase-api/tests/build-output.test.ts`

**接口：**

- 产出：`apps/cloudbase-api/dist/api/index.js`。
- 产出：`apps/cloudbase-api/dist/moderation-worker/index.js`。
- 产出：`apps/cloudbase-api/dist/cleanup/index.js`。
- 每个入口导出 CommonJS `main`。

- [ ] **Step 1：写构建产物失败测试**

```ts
it('三个部署入口均导出 main 且不包含源码映射', async () => {
  for (const name of ['api', 'moderation-worker', 'cleanup']) {
    const entry = resolve(distRoot, name, 'index.js');
    expect(existsSync(entry)).toBe(true);
    expect(require(entry).main).toBeTypeOf('function');
    expect(existsSync(`${entry}.map`)).toBe(false);
  }
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/cloudbase-api test -- build-output.test.ts`

预期：`dist` 入口不存在。

- [ ] **Step 3：实现构建与配置**

构建脚本用 esbuild：

```js
await build({
  entryPoints: { index: sourceEntry },
  outfile: destination,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  banner: { js: '/* AI Pet CloudBase 云函数部署产物 */' }
});
```

`cloudbaserc.json` 使用动态环境：

```json
{
  "version": "2.0",
  "envId": "{{env.CLOUDBASE_ENV_ID}}",
  "functions": [
    {
      "name": "ai-pet-api",
      "dir": "./apps/cloudbase-api/dist/api",
      "runtime": "Nodejs20.19",
      "handler": "index.main",
      "timeout": 30
    },
    {
      "name": "ai-pet-moderation-worker",
      "dir": "./apps/cloudbase-api/dist/moderation-worker",
      "runtime": "Nodejs20.19",
      "handler": "index.main",
      "timeout": 900
    },
    {
      "name": "ai-pet-cleanup",
      "dir": "./apps/cloudbase-api/dist/cleanup",
      "runtime": "Nodejs20.19",
      "handler": "index.main",
      "timeout": 300
    }
  ]
}
```

根脚本新增：

```json
"build:cloudbase": "pnpm --filter @myself/cloudbase-api build",
"verify:cloudbase": "pnpm --filter @myself/cloudbase-api typecheck && pnpm --filter @myself/cloudbase-api test && pnpm --filter @myself/package-scanner typecheck && pnpm --filter @myself/package-scanner test"
```

- [ ] **Step 4：验证可部署产物**

运行：

```powershell
pnpm build:cloudbase
pnpm --filter @myself/cloudbase-api test -- build-output.test.ts
pnpm verify:cloudbase
```

预期：三个入口存在并导出 `main`，后端与扫描器验证通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add tools/build-cloudbase-functions.mjs cloudbaserc.json package.json apps/cloudbase-api
git commit -m "build: 固定 CloudBase 函数部署产物"
```

---

### Task 11：把公开共享仓库切换到云端

**文件：**

- 新建：`apps/website/lib/api-client.ts`
- 新建：`apps/website/lib/captcha.ts`
- 新建：`apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- 修改：`apps/website/components/website-experience/community/shared-pet-types.ts`
- 修改：`apps/website/components/website-experience/community/SharedPetChapter.tsx`
- 修改：`apps/website/components/website-experience/community/SharedPetComposerDialog.tsx`
- 修改：`apps/website/components/website-experience/chapter-registry.tsx`
- 修改：`apps/website/components/i18n/messages.ts`
- 新建：`apps/website/tests/cloud-shared-pet-repository.test.ts`
- 修改：`apps/website/tests/shared-pet-chapter.test.tsx`
- 修改：`apps/website/tests/shared-pet-dialogs.test.tsx`

**接口：**

- `ApiClient.request<T>(path, init): Promise<T>`。
- `CaptchaClient.verify(): Promise<CaptchaProof>`。
- `CloudSharedPetRepository` 实现调整后的 `SharedPetRepository`。
- `SharedPetRepository.submit(input, captcha): Promise<SubmissionReceipt>`。

- [ ] **Step 1：写云仓库失败测试**

```ts
it('投稿按 prepare、双文件直传、finalize 顺序执行', async () => {
  const receipt = await repository.submit(validInput, captchaProof);
  expect(fetchMock.calls.map(call => call.url)).toEqual([
    '/api/v1/submissions/prepare',
    'https://storage.example/cover',
    'https://storage.example/package',
    '/api/v1/submissions/submission-1/finalize'
  ]);
  expect(receipt.status).toBe('system_reviewing');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/website test -- cloud-shared-pet-repository.test.ts`

预期：云仓库不存在。

- [ ] **Step 3：实现仓库替换和投稿回执**

调整类型：

```ts
export interface SharedPetRepository {
  listPage(page: number, pageSize?: 8): Promise<SharedPetPage>;
  submit(input: CreateSharedPetInput, captcha: CaptchaProof): Promise<SubmissionReceipt>;
  getById(id: string): Promise<SharedPetPackageSummary | null>;
  toggleLike(id: string): Promise<SharedPetPackageSummary>;
  getDownload(id: string): Promise<{
    url: string;
    fileName: string;
    expiresAt: string;
  }>;
  subscribe(listener: () => void): () => void;
}
```

生产注册改为：

```ts
const sharedPetRepository = new CloudSharedPetRepository(
  new ApiClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1')
);
```

提交成功后不把内容插入公开列表，而是显示：

- “投稿已收到，正在系统审核。”
- 一次性状态查询链接。
- “请立即保存此链接，丢失后无法找回。”

下载改为请求短期 URL 后使用隐藏 `<a download>` 触发，不再读取 Blob。

- [ ] **Step 4：验证共享仓库**

运行：

```powershell
pnpm --filter @myself/website test -- cloud-shared-pet-repository.test.ts shared-pet-chapter.test.tsx shared-pet-dialogs.test.tsx
pnpm --filter @myself/website typecheck
```

预期：分页、详情、点赞、签名下载、CAPTCHA、上传进度和待审核回执通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/website/lib apps/website/components/website-experience/community apps/website/components/website-experience/chapter-registry.tsx apps/website/components/i18n/messages.ts apps/website/tests
git commit -m "feat: 将共享仓库接入 CloudBase 审核流程"
```

---

### Task 12：把反馈与建议切换到云端审核

**文件：**

- 新建：`apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- 修改：`apps/website/components/website-experience/feedback/feedback-types.ts`
- 修改：`apps/website/components/website-experience/feedback/FeedbackChapter.tsx`
- 修改：`apps/website/components/website-experience/feedback/FeedbackComposerDialog.tsx`
- 修改：`apps/website/components/website-experience/WebsiteExperience.tsx`
- 修改：`apps/website/components/i18n/messages.ts`
- 新建：`apps/website/tests/cloud-feedback-repository.test.ts`
- 修改：`apps/website/tests/feedback-chapter.test.tsx`

**接口：**

- `CloudFeedbackRepository.refresh(kind): Promise<void>`。
- `CloudFeedbackRepository.create(input, captcha): Promise<SubmissionReceipt>`。
- `CloudFeedbackRepository.toggleLike(id): Promise<FeedbackEntry>`。
- `list(kind)` 继续返回内存快照，避免重写粒子预览算法。

- [ ] **Step 1：写异步反馈失败测试**

```ts
it('未审核反馈提交成功后不进入公开快照', async () => {
  const before = repository.list('feedback');
  const receipt = await repository.create(validInput, captchaProof);
  expect(receipt.status).toBe('system_reviewing');
  expect(repository.list('feedback')).toEqual(before);
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/website test -- cloud-feedback-repository.test.ts`

预期：云反馈仓库不存在。

- [ ] **Step 3：实现快照式云仓库**

接口调整为：

```ts
export interface FeedbackRepository {
  list(kind: FeedbackKind): readonly FeedbackEntry[];
  refresh(kind: FeedbackKind): Promise<void>;
  create(input: CreateFeedbackInput, captcha: CaptchaProof): Promise<SubmissionReceipt>;
  toggleLike(id: string): Promise<FeedbackEntry>;
  subscribe(listener: () => void): () => void;
}
```

要求：

- 页面进入反馈章节时调用 `refresh`。
- 提交前调用 CAPTCHA。
- 成功后显示查询链接，不打开公开反馈列表。
- 只有后端返回的 `published` 记录进入快照。
- `LocalStorageFeedbackRepository` 只保留为测试适配器，不再由生产组件默认创建。
- `WebsiteExperience` 的反馈粒子继续读取同一仓库快照，网络失败时只显示官方示例。

- [ ] **Step 4：验证反馈章节**

运行：

```powershell
pnpm --filter @myself/website test -- cloud-feedback-repository.test.ts feedback-chapter.test.tsx feedback-preview-source.test.ts
pnpm --filter @myself/website typecheck
```

预期：公开读取、提交不立即公开、异步点赞、网络错误和官方示例回退通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/website/components/website-experience/feedback apps/website/components/website-experience/WebsiteExperience.tsx apps/website/components/i18n/messages.ts apps/website/tests
git commit -m "feat: 将反馈建议接入双层审核"
```

---

### Task 13：新增匿名状态查询页

**文件：**

- 新建：`apps/website/lib/submission-status.ts`
- 新建：`apps/website/app/submission-status/page.tsx`
- 新建：`apps/website/app/submission-status/status-page.module.css`
- 修改：`apps/website/components/i18n/messages.ts`
- 新建：`apps/website/tests/submission-status.test.tsx`

**接口：**

- `readStatusToken(locationHash: string): string | null`。
- 页面只向 `POST /api/v1/submission-status` 发送令牌。

- [ ] **Step 1：写 Fragment 安全失败测试**

```ts
it('只从 Fragment 读取令牌并在请求后清除地址栏', async () => {
  window.history.replaceState({}, '', '/submission-status/#token-123');
  render(<SubmissionStatusPage />);
  await waitFor(() => expect(api.status).toHaveBeenCalledWith('token-123'));
  expect(window.location.search).toBe('');
  expect(window.location.hash).toBe('');
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/website test -- submission-status.test.tsx`

预期：状态页不存在。

- [ ] **Step 3：实现状态页**

页面状态映射：

```ts
system_reviewing      -> 系统审核中
manual_review_pending -> 等待管理员审核
published             -> 已发布
auto_rejected         -> 系统未通过
admin_rejected        -> 管理员未通过
deleted_quarantined   -> 已下架
purged                -> 已清理
```

要求：

- 初次读取令牌后立即用 `history.replaceState` 清除 Fragment。
- 不写 localStorage、sessionStorage、Cookie 或遥测。
- 无令牌时允许手动粘贴。
- 返回理由只显示后端提供的公开说明。
- 状态查询响应使用 `Cache-Control: no-store`。

- [ ] **Step 4：验证静态导出**

运行：

```powershell
pnpm --filter @myself/website test -- submission-status.test.tsx
pnpm --filter @myself/website build
```

预期：`out/submission-status/index.html` 存在，令牌不出现在构建产物。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/website/lib/submission-status.ts apps/website/app/submission-status apps/website/components/i18n/messages.ts apps/website/tests/submission-status.test.tsx
git commit -m "feat: 增加匿名投稿状态查询"
```

---

### Task 14：实现管理员邮箱验证码登录与审核工作台

**文件：**

- 新建：`apps/website/lib/cloudbase-auth.ts`
- 新建：`apps/website/app/admin/page.tsx`
- 新建：`apps/website/components/admin/AdminApp.tsx`
- 新建：`apps/website/components/admin/AdminLogin.tsx`
- 新建：`apps/website/components/admin/AdminSidebar.tsx`
- 新建：`apps/website/components/admin/AdminQueue.tsx`
- 新建：`apps/website/components/admin/AdminDetail.tsx`
- 新建：`apps/website/components/admin/AdminAuditLog.tsx`
- 新建：`apps/website/components/admin/admin.module.css`
- 修改：`apps/website/components/i18n/messages.ts`
- 修改：`apps/website/package.json`
- 新建：`apps/website/tests/admin-login.test.tsx`
- 新建：`apps/website/tests/admin-app.test.tsx`

**接口：**

- `CloudBaseAdminAuth.sendCode(email): Promise<VerificationInfo>`。
- `CloudBaseAdminAuth.signIn(email, code, verificationInfo): Promise<string>`。
- `AdminApiClient` 为管理员请求添加 `Authorization: Bearer <accessToken>`。

- [ ] **Step 1：写登录与工作台失败测试**

```ts
it('邮箱验证码登录后才加载待审核队列', async () => {
  render(<AdminApp auth={auth} api={api} />);
  await user.type(screen.getByLabelText('管理员邮箱'), 'admin@example.com');
  await user.click(screen.getByRole('button', { name: '发送验证码' }));
  await user.type(screen.getByLabelText('邮箱验证码'), '123456');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(api.listQueue).toHaveBeenCalledWith('manual_review_pending'));
});

it('版本冲突时刷新详情而不是重复提交', async () => {
  api.applyAction.mockRejectedValue(new ApiClientError('VERSION_CONFLICT', 409));
  await approveCurrentItem();
  expect(api.getDetail).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2：确认测试失败**

运行：`pnpm --filter @myself/website test -- admin-login.test.tsx admin-app.test.tsx`

预期：管理员组件不存在。

- [ ] **Step 3：实现方案 B 工作台**

登录使用官方邮箱验证码流程：

```ts
const verificationInfo = await auth.getVerification({ email });
await auth.signInWithEmail({
  verificationInfo,
  verificationCode: code,
  email
});
```

界面：

- 左侧：待我审核、自动驳回、已发布、隔离区、审计记录。
- 中间：类型、标题、系统标签、提交时间、状态。
- 右侧：正文、封面、文件清单、扫描结果、机器证据和操作。
- `auto_rejected` 支持维持驳回、转人工、技术检查通过后批准。
- 批准、驳回、删除、恢复均要求理由；动作携带当前 `version` 和 `crypto.randomUUID()` 幂等键。
- 不在公开网站导航中增加管理员入口。
- 401 清会话并返回登录页，403 显示“该邮箱没有管理员权限”，409 自动刷新详情。

- [ ] **Step 4：验证管理员页面**

运行：

```powershell
pnpm --filter @myself/website test -- admin-login.test.tsx admin-app.test.tsx
pnpm --filter @myself/website typecheck
pnpm --filter @myself/website build
```

预期：登录、五个队列、动作门禁、并发冲突和静态 `/admin/` 产物通过。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/website/lib/cloudbase-auth.ts apps/website/app/admin apps/website/components/admin apps/website/components/i18n/messages.ts apps/website/package.json apps/website/tests pnpm-lock.yaml
git commit -m "feat: 增加管理员审核工作台"
```

---

### Task 15：补齐法律页面、运维手册和全链路 E2E

**文件：**

- 新建：`apps/website/public/legal/privacy.html`
- 新建：`apps/website/public/legal/terms.html`
- 新建：`apps/website/public/legal/content-policy.html`
- 修改：`apps/website/components/website-experience/community/SharedPetComposerDialog.tsx`
- 修改：`apps/website/components/website-experience/feedback/FeedbackComposerDialog.tsx`
- 新建：`docs/operations/cloudbase-deployment.md`
- 新建：`docs/operations/content-moderation.md`
- 修改：`tests/e2e/website.spec.ts`
- 修改：`tests/serve-website-export.mjs`
- 修改：`package.json`

**接口：**

- 测试服务器为 `/api/v1` 提供确定性的内存 API，不连接真实云环境。
- E2E 覆盖公开投稿、状态查询、管理员批准、自动驳回复核和删除恢复。

- [ ] **Step 1：先写 E2E 失败场景**

```ts
test('共享包经系统和管理员审核后才公开', async ({ page }) => {
  await submitSharedPackage(page, 'safe-pet.zip');
  await expect(page.getByText('投稿已收到，正在系统审核。')).toBeVisible();
  await expect(page.getByText('Safe Pet')).toHaveCount(0);

  await approveFromAdmin(page, 'Safe Pet');
  await page.goto('/');
  await enterChapter(page, 'community');
  await expect(page.getByText('Safe Pet')).toBeVisible();
});
```

再增加：

- 自动驳回内容不公开，管理员可转人工。
- 技术扫描失败时批准按钮禁用。
- 反馈批准前不出现在列表。
- 发布内容删除后立即消失，恢复后重新出现。
- 状态令牌只在 Fragment 中出现。
- 非管理员邮箱访问 API 返回 403。
- E2E 章节数组修正为六章，包含 `community`。

- [ ] **Step 2：确认 E2E 红灯**

运行：`pnpm test:e2e:website`

预期：新增投稿和管理员场景失败，且旧的五章节断言被测试暴露。

- [ ] **Step 3：完成文档、测试替身和上线文案**

三个法律页面至少包含：

- 完全匿名投稿说明。
- CAPTCHA、IP/设备风控的用途与保存边界。
- 投稿内容、版权和资源安全声明。
- 禁止政治、脏话、色情、暴力、违法、广告、隐私和非 AI Pet 内容。
- 投诉举报和运营者联系入口。
- “完全匿名不等于已经满足全部实名合规要求”的风险说明。

部署手册必须列出：

1. 开发和生产 CloudBase 环境隔离。
2. 创建私有 Bucket 与执行迁移。
3. 开通 TMS、IMS、CAPTCHA 和邮箱登录。
4. 开通 CloudBase AI Token 资源并启用 `deepseek-v4-flash`，API Key 只配置在服务端。
5. 配置唯一管理员邮箱。
6. 部署扫描容器，最小实例 0、并发 1、内存至少 1 GB。
7. 构建并部署三个云函数。
8. HTTP 网关把 `/api/v1` 关联到 `ai-pet-api`，管理员路径同时启用身份认证。
9. 静态托管部署 `apps/website/out`，绑定已备案自定义域名和 HTTPS。
10. 配置 CSP、CORS、费用告警、调用告警和日志。
11. 先在开发环境跑冒烟测试，再建立独立生产环境。
12. 回滚只切换上一静态版本和上一函数版本，不回滚已执行的数据迁移。

审核手册必须列出自动驳回、转人工、批准、删除、恢复和三天清理操作。

- [ ] **Step 4：执行完整验证**

运行：

```powershell
pnpm verify:cloudbase
pnpm verify:website
git diff --check
```

预期：

- CloudBase API、扫描器、网站单测、类型检查、静态构建和网站 E2E 全部通过。
- `apps/website/out/admin/index.html` 与 `apps/website/out/submission-status/index.html` 存在。
- `rg -n "SECRET|SecretKey|AppSecretKey" apps docs tools cloudbaserc.json` 只命中环境变量名称和说明，不命中真实值。

- [ ] **Step 5：在获得 Git 写权限后提交**

```powershell
git add apps/website/public/legal apps/website/components/website-experience tests docs/operations package.json
git commit -m "docs: 补齐审核上线与部署验收"
```

---

### Task 16：开发环境部署与生产上线门禁

**文件：**

- 不新增业务文件；按 `docs/operations/cloudbase-deployment.md` 操作。

**接口：**

- 开发环境通过后才允许创建或部署生产环境。
- 该任务包含外部资源写入，执行前必须再次取得用户明确授权。

- [ ] **Step 1：部署前只读检查**

运行：

```powershell
pnpm exec tcb -v
pnpm exec tcb env list
pnpm exec tcb fn deploy --help
pnpm exec tcb hosting deploy --help
```

预期：CLI 已登录，能看到已购买的开发环境；命令帮助与计划一致。

- [ ] **Step 2：获得用户部署授权后应用开发环境资源**

按顺序执行：

```powershell
node tools/apply-cloudbase-migrations.mjs
pnpm build:cloudbase
pnpm exec tcb fn deploy --all --yes
pnpm --filter @myself/website build
pnpm exec tcb hosting deploy apps/website/out -e $env:CLOUDBASE_ENV_ID
```

扫描器通过 CloudBase Run 控制台从 `apps/package-scanner/Dockerfile` 部署，先使用最小实例 0。

预期：迁移、函数、扫描器和静态站点均成功。

- [ ] **Step 3：配置控制台资源**

逐项完成并截图留档：

- 私有 Bucket 与 RLS。
- moderation-worker 每分钟触发。
- cleanup 每小时触发。
- `/api/v1` HTTP 网关。
- 管理员邮箱验证码登录。
- TMS、IMS、CAPTCHA 的开发策略。
- 自定义域名、HTTPS、CORS 和 CSP。
- 费用与异常调用告警。

- [ ] **Step 4：开发环境冒烟验收**

验证：

```text
安全 ZIP -> 系统通过 -> 管理员批准 -> 公开 -> 短期下载成功
脏话文本 -> 自动驳回 -> 管理员能查看但公众不可见
政治文本 -> 自动驳回 -> 管理员能转人工
危险 ZIP -> 技术失败 -> 管理员不能批准
公开内容删除 -> 立即隐藏 -> 三天内恢复成功
非白名单邮箱 -> 管理 API 403
审核服务断开 -> 保持 system_reviewing
```

- [ ] **Step 5：生产上线门禁**

只有以下条件全部满足才进入生产：

- 开发环境连续 24 小时无高危错误。
- 所有自动化测试通过。
- 域名备案、HTTPS 和法律页面可访问。
- 管理员邮箱可收到验证码。
- CAPTCHA、TMS、IMS 已开通正式额度和费用告警。
- CloudBase AI Token 资源已开通并设置用量告警。
- 数据库恢复演练成功。
- 完全匿名模式的合规风险已由产品方再次书面确认，并建议完成专业法律复核。
- 用户另行明确授权生产部署。

生产部署时使用独立 `CLOUDBASE_ENV_ID`、Bucket、数据库、密钥和管理员配置，禁止复制开发数据。
