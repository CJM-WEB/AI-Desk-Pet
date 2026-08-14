# 网站 HTTP 运行时契约闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让网站浏览器 Adapter、CloudBase `createApi` 和 E2E 内存后端对关键 endpoint 使用同一套 Zod 运行时契约与行为案例，关闭漂移后恢复普通网站功能开发资格。

**Architecture:** `packages/shared-types/website-http` 只拥有跨应用 wire schema；`ApiClient` 在 HTTP 信封和 endpoint data 两层解析，CloudBase API 在发送前解析公开 DTO。生产与内存后端保持各自存储实现，但共同运行一套行为案例。

**Tech Stack:** TypeScript 5、Zod 3、Vitest 3、Playwright 1.61、Next.js 15、CloudBase HTTP 函数。

## Global Constraints

- 前置条件：阶段 0、1、2 已完成且各自门禁为绿；共享包投稿开关是否开启不影响本阶段契约测试。
- 唯一设计基线：`docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md` 第 5.2、7.4、8、10 节。
- 只修改网站链允许目录；严禁修改桌宠业务代码和角色包公开语义。
- `packages/shared-types` 保留根入口兼容；新 HTTP 契约只从 `@myself/shared-types/website-http` 子路径导出，不继续扩大根 barrel。
- 管理端契约以当前生产 Interface 为准：`x-ai-pet-admin-token`、401/403、`statusVersion` 和幂等错误；若真实 CloudBase 网关证据与此冲突，停止并另行裁决，不在本阶段猜测改成 `Authorization`。
- 响应不满足信封或 data Schema 时，浏览器统一抛出 `ApiClientError('INVALID_RESPONSE', statusCode)`。
- 每迁移一个 endpoint 组，立即删除该组在网站端重复的响应 Schema/DTO；不保留兼容 wrapper。
- 未经用户授权不执行部署、远端操作或 Git 写操作；大量删除仍需二次批准。

---

### Task 1: 建立 HTTP 信封和 `ApiClient` Schema 接口

**Files:**
- Create: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/package.json`
- Test: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/website/lib/api-client.ts`
- Test: `apps/website/tests/api-client.test.ts`

**Interfaces:**
- Consumes: `z.ZodType<T>` 与现有 `{ data, error, requestId }` 响应形状。
- Produces: `apiErrorSchema`、`apiEnvelopeSchema(dataSchema)`、`ApiErrorPayload`；`ApiClient.request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>`。

- [ ] **Step 1: 写共享信封 RED 测试**

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiEnvelopeSchema } from '../src/website-http.js';

describe('网站 HTTP 信封', () => {
  it('拒绝 data 与 error 同时有值及额外字段', () => {
    const schema = apiEnvelopeSchema(z.object({ id: z.string() }).strict());
    expect(schema.safeParse({ data: { id: '1' }, error: { code: 'BAD' }, requestId: 'r1' }).success).toBe(false);
    expect(schema.safeParse({ data: { id: '1', leaked: true }, error: null, requestId: 'r1' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Expected: FAIL，原因是 `src/website-http.ts` 不存在或没有导出 `apiEnvelopeSchema`。

- [ ] **Step 3: 实现最小共享信封与子路径导出**

```ts
import { z } from 'zod';

export const apiErrorSchema = z.object({
  code: z.string().min(1).max(128),
  retryAfterSeconds: z.number().int().positive().optional()
}).strict();

export function apiEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.union([
    z.object({ data: dataSchema, error: z.null(), requestId: z.string().min(1).max(128) }).strict(),
    z.object({ data: z.null(), error: apiErrorSchema, requestId: z.string().min(1).max(128) }).strict()
  ]);
}

export type ApiErrorPayload = z.infer<typeof apiErrorSchema>;
```

在 `packages/shared-types/package.json` 的 `exports` 中保留 `".": "./src/index.ts"`，新增 `"./website-http": "./src/website-http.ts"`。

- [ ] **Step 4: 写 `ApiClient` data 解析 RED 测试**

```ts
it('成功信封中的 data 不满足 endpoint Schema 时失败关闭', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    data: { id: 7 }, error: null, requestId: 'request-1'
  }), { status: 200 }));
  const client = new ApiClient('https://api.example', fetcher as typeof fetch);
  await expect(client.request('/community/1', z.object({ id: z.string() }).strict()))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE', statusCode: 200 });
});
```

- [ ] **Step 5: 运行 RED 并修改 `ApiClient`**

Run: `pnpm --filter @myself/website test -- api-client.test.ts`

Expected: FAIL，原因是 `request` 第二参数仍被解释为 `RequestInit`。

把接口改为：

```ts
async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await this.fetcher(`${this.baseUrl}${path}`, buildInit(init));
  const parsed = apiEnvelopeSchema(schema).safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiClientError('INVALID_RESPONSE', response.status);
  if (!response.ok || parsed.data.error) {
    throw new ApiClientError(parsed.data.error?.code ?? 'REQUEST_FAILED', response.status, parsed.data.error?.retryAfterSeconds);
  }
  return parsed.data.data;
}
```

- [ ] **Step 6: 验证并在授权后提交**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Run: `pnpm --filter @myself/website test -- api-client.test.ts`

Expected: PASS。

获得用户明确 Git 写入授权后：

```powershell
git add packages/shared-types apps/website/lib/api-client.ts apps/website/tests/api-client.test.ts
git commit -m "refactor: 建立网站 HTTP 运行时信封"
```

### Task 2: 迁移投稿与状态 endpoint

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Test: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- Modify: `apps/website/lib/submission-status.ts`
- Test: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Test: `apps/website/tests/cloud-feedback-repository.test.ts`
- Test: `apps/website/tests/submission-status.test.tsx`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Test: `apps/cloudbase-api/tests/api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ApiClient.request(path, schema, init)`、现有 `submissionReceiptSchema`、`submissionStatusViewSchema`。
- Produces: `prepareSubmissionResultSchema`、`finalizeSubmissionResultSchema`、`feedbackSubmissionResultSchema`、`submissionStatusResultSchema`；finalize 的正式状态为 `system_reviewing`，不得在测试后端伪造 `manual_review_pending`。

- [ ] **Step 1: 写四个 endpoint 的 RED 契约测试**

```ts
it('投稿响应拒绝未知状态和泄漏字段', () => {
  expect(finalizeSubmissionResultSchema.safeParse({ status: 'manual_review_pending' }).success).toBe(false);
  expect(submissionStatusResultSchema.safeParse({
    submissionId: 's1', status: 'system_reviewing', publicReason: null,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    moderationEvidence: 'private'
  }).success).toBe(false);
});
```

- [ ] **Step 2: 运行 RED 并新增 Schema**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Expected: FAIL，四个 Schema 尚未导出。

精确契约：prepare 与 feedback 复用 `submissionReceiptSchema`；finalize 为 `z.object({ status: z.literal('system_reviewing') }).strict()`；status 复用 `submissionStatusViewSchema`。

- [ ] **Step 3: 逐个改造三个网站 Adapter**

所有调用采用：

```ts
await api.request('/submissions/prepare', prepareSubmissionResultSchema, init);
await api.request(`/submissions/${encodeURIComponent(id)}/finalize`, finalizeSubmissionResultSchema, init);
await api.request('/feedback', feedbackSubmissionResultSchema, init);
await api.request('/submission-status', submissionStatusResultSchema, init);
```

删除这三个文件中被共享 Schema 替代的 `parseResponse`、本地响应 Schema 和硬编码响应断言。

- [ ] **Step 4: 让 `createApi` 在发送前验证公开 DTO**

在各路由返回处调用对应 `.parse(...)`；解析失败由现有 `normalizeError` 转为 500 `INTERNAL_ERROR`，不得向浏览器发送部分有效对象。

- [ ] **Step 5: 运行定向测试并在授权后提交**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Run: `pnpm --filter @myself/website test -- cloud-shared-pet-repository.test.ts cloud-feedback-repository.test.ts submission-status.test.tsx`

Run: `pnpm --filter @myself/cloudbase-api test -- api.test.ts`

Expected: PASS，且 `rg -n "request<unknown>|status: 'manual_review_pending'" apps/website/lib tests/memory-website-api.mjs` 不再命中这组 endpoint 的响应实现。

获得用户明确 Git 写入授权后提交：`git commit -m "refactor: 统一投稿 HTTP 契约"`。

### Task 3: 迁移公开内容 endpoint

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Test: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- Test: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Test: `apps/website/tests/cloud-feedback-repository.test.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Test: `apps/cloudbase-api/tests/api.test.ts`

**Interfaces:**
- Consumes: Task 1 信封接口；现有 Repository 公开 Model 字段。
- Produces: `publicCommunityItemSchema`、`publicCommunityPageSchema`、`publicFeedbackItemSchema`、`publicFeedbackPageSchema`、`likeResultSchema`、`downloadResultSchema`。

- [ ] **Step 1: 写隐私裁剪与畸形记录 RED 测试**

```ts
it('公开 DTO 严格拒绝私有字段', () => {
  expect(publicCommunityItemSchema.safeParse({ ...validCommunity, storageKey: 'private' }).success).toBe(false);
  expect(publicFeedbackItemSchema.safeParse({ ...validFeedback, statusTokenHash: 'private' }).success).toBe(false);
});
```

- [ ] **Step 2: 运行 RED 并实现精确字段 Schema**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Expected: FAIL，公开内容 Schema 尚未导出。

字段必须与 `publicCommunity()`、`publicFeedback()` 当前实际返回完全一致；分页 `nextCursor` 暂保持非负整数或 `null`，keyset 迁移留给阶段 4。

- [ ] **Step 3: 把网站和 `createApi` 接到共享 Schema**

网站各请求把 Schema 作为第二参数；CloudBase API 在 `jsonResponse` 前对 list/detail/like/download 结果 `.parse()`。删除网站本地重复公开响应 Schema。

- [ ] **Step 4: 验证六条公开 endpoint**

Run: `pnpm --filter @myself/website test -- cloud-shared-pet-repository.test.ts cloud-feedback-repository.test.ts`

Run: `pnpm --filter @myself/cloudbase-api test -- api.test.ts public-content-service.test.ts`

Expected: PASS；公开响应不包含 `storageKey`、`statusTokenHash`、`internalEvidence`。

- [ ] **Step 5: 在获得 Git 授权后提交**

```powershell
git add packages/shared-types/src/website-http.ts packages/shared-types/tests/website-http.test.ts apps/website apps/cloudbase-api/src/functions/api.ts apps/cloudbase-api/tests/api.test.ts
git commit -m "refactor: 统一公开内容 HTTP 契约"
```

### Task 4: 迁移管理员 endpoint 并固定真实认证头

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Test: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/website/lib/admin-api-client.ts`
- Test: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Test: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `tests/e2e/website.spec.ts`

**Interfaces:**
- Consumes: `adminActionSchema`、`submissionStatusSchema`、Task 1 `ApiClient`。
- Produces: `adminSubmissionSummarySchema`、`adminSubmissionDetailSchema`、`adminQueuePageSchema`、`adminActionResultSchema`；认证头固定为 `x-ai-pet-admin-token`。

- [ ] **Step 1: 写共享管理员响应 RED 测试**

```ts
it('管理员动作响应要求状态版本与重放标记', () => {
  expect(adminActionResultSchema.safeParse({
    submission: { id: 's1', status: 'published' }, replayed: false
  }).success).toBe(false);
});
```

- [ ] **Step 2: 运行 RED 并移动现有本地 Schema**

Run: `pnpm --filter @myself/shared-types test -- website-http.test.ts`

Expected: FAIL。把 `apps/website/lib/admin-api-client.ts` 现有管理员响应 Schema 原样迁到共享子路径，保持字段与 `.strict()` 规则，不顺带重设计数据库 DTO。

- [ ] **Step 3: 更新生产端、浏览器端和 E2E 头**

浏览器使用共享 Schema；生产 `createApi` 对三个管理员响应发送前解析；`tests/e2e/website.spec.ts` 的管理请求统一改为：

```ts
headers: { 'x-ai-pet-admin-token': accessToken }
```

补充缺头 401、非白名单 403、错误 `statusVersion`/幂等键不产生状态变化的断言。

- [ ] **Step 4: 验证并删除本地重复 DTO**

Run: `pnpm --filter @myself/website test -- admin-api-client.test.ts`

Run: `pnpm --filter @myself/cloudbase-api test -- api.test.ts admin-service.test.ts`

Expected: PASS；`apps/website/lib/admin-api-client.ts` 不再声明 `adminSubmissionBaseSchema` 等响应 Schema。

- [ ] **Step 5: 在获得 Git 授权后提交**

```powershell
git add packages/shared-types apps/website/lib/admin-api-client.ts apps/website/tests/admin-api-client.test.ts apps/cloudbase-api/src/functions/api.ts apps/cloudbase-api/tests/api.test.ts tests/e2e/website.spec.ts
git commit -m "refactor: 统一管理员 HTTP 契约"
```

### Task 5: 让生产 API 与内存后端共用行为案例

**Files:**
- Create: `tests/website-contract/website-api-contract.ts`
- Create: `apps/cloudbase-api/tests/website-api-contract.test.ts`
- Create: `tests/website-contract/memory-website-api-contract.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `WebsiteApiDriver = { request(input: ContractRequest): Promise<ContractResponse>; reset(): Promise<void> }`。
- Produces: `runWebsiteApiContract(createDriver: () => Promise<WebsiteApiDriver>): void`，由生产 `createApi` Adapter 和内存 HTTP Adapter 各注册一次。

- [ ] **Step 1: 写共享行为套件**

```ts
export interface ContractRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface ContractResponse {
  status: number;
  data: unknown | null;
  error: { code: string; retryAfterSeconds?: number } | null;
}

export interface WebsiteApiDriver {
  request(input: ContractRequest): Promise<ContractResponse>;
  reset(): Promise<void>;
}

export function runWebsiteApiContract(createDriver: () => Promise<WebsiteApiDriver>) {
  describe('网站 API 行为契约', () => {
    it('finalize 只进入 system_reviewing', async () => {
      const driver = await createDriver();
      const response = await driver.request({ method: 'POST', path: '/api/v1/submissions/s1/finalize', body: {} });
      expect(response).toMatchObject({ status: 200, data: { status: 'system_reviewing' }, error: null });
    });
    it('管理员缺令牌为 401，非法身份为 403', async () => {
      const driver = await createDriver();
      const missing = await driver.request({ method: 'GET', path: '/api/v1/admin/submissions' });
      const forbidden = await driver.request({
        method: 'GET', path: '/api/v1/admin/submissions',
        headers: { 'x-ai-pet-admin-token': 'non-admin-token' }
      });
      expect(missing).toMatchObject({ status: 401, data: null, error: { code: 'UNAUTHORIZED' } });
      expect(forbidden).toMatchObject({ status: 403, data: null, error: { code: 'FORBIDDEN' } });
    });
    it('重复 idempotencyKey 返回 replayed=true 且 statusVersion 不二次递增', async () => {
      const driver = await createDriver();
      const input = {
        method: 'POST' as const,
        path: '/api/v1/admin/submissions/s1/actions',
        headers: { 'x-ai-pet-admin-token': 'admin-token' },
        body: { action: 'approve', version: 3, idempotencyKey: 'contract-action-1', reason: '契约测试批准' }
      };
      const first = await driver.request(input);
      const second = await driver.request(input);
      expect(first).toMatchObject({ status: 200, data: { submission: { statusVersion: 4 }, replayed: false } });
      expect(second).toMatchObject({ status: 200, data: { submission: { statusVersion: 4 }, replayed: true } });
    });
  });
}
```

`WebsiteApiDriver` 的两种 Adapter 都必须把 HTTP 信封解码为 `{ status, data, error }`，并在每个案例前用 `reset()` 建立相同种子数据。

- [ ] **Step 2: 运行生产 Adapter RED**

Run: `pnpm --filter @myself/cloudbase-api test -- website-api-contract.test.ts`

Expected: 首先因契约套件/Adapter 尚未存在失败；接入现有 `createApi(createDependencies())` 后，所有案例必须通过。

- [ ] **Step 3: 导出可启动的内存 Adapter 并运行同一套件 RED**

`tests/memory-website-api.mjs` 导出 `createMemoryWebsiteApi()`，返回 `{ listen(), close(), reset() }`，同时用 `import.meta.url` 判断保留 CLI 启动方式。测试通过真实 localhost HTTP 调用它，不复制业务断言。

Run: `pnpm exec vitest run --config tests/vitest.config.ts tests/website-contract/memory-website-api-contract.test.ts`

Expected: RED 首次暴露 finalize 状态、管理员头或幂等行为中至少一个现有漂移。

- [ ] **Step 4: 最小修复内存后端漂移**

只修改内存后端的状态转换、认证头和幂等账本，使同一行为套件变绿；不得导入生产数据库服务或复制 `createApi` 的 dispatch。

- [ ] **Step 5: 将契约套件加入网站门禁**

在根脚本中新增 `test:website-contract`，精确命令为：

```json
"test:website-contract": "pnpm --filter @myself/cloudbase-api test -- website-api-contract.test.ts && vitest run --config tests/vitest.config.ts tests/website-contract/memory-website-api-contract.test.ts"
```

阶段 0 已建立的 `verify:web-chain` 在 E2E 前调用它。

- [ ] **Step 6: 验证并在授权后提交**

Run: `pnpm test:website-contract`

Run: `pnpm verify:web-chain`

Expected: PASS；同一行为套件在两个 Adapter 上各执行一次。

获得用户明确 Git 写入授权后提交：`git commit -m "test: 统一网站 API 行为契约"`。

### Task 6: 阶段 3 收口、边界复核与恢复开发资格

**Files:**
- Create: `docs/operations/website-optimization-acceptance.md`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`

**Interfaces:**
- Consumes: Tasks 1—5 的测试输出与阶段 0—2 验收证据。
- Produces: 阶段 3 日期化验收结论，以及“允许恢复普通网站功能开发”或明确失败状态。

- [ ] **Step 1: 搜索残余重复与越界改动**

Run: `rg -n "request<unknown>|interface ApiEnvelope|x-ai-pet-admin-token|Authorization" apps/website apps/cloudbase-api tests packages/shared-types`

Expected: `request<unknown>` 和重复 `ApiEnvelope` 为零；管理端只在共享行为案例、生产解析和客户端设置位置出现；不存在两种有效认证头。

Run: `git diff --name-only`

Expected: 不包含 `apps/desktop/`、`packages/agent-core/`、`packages/file-tools/`、`packages/character-runtime/`、`packages/character-assets/`。

- [ ] **Step 2: 运行完整网站链门禁**

Run: `pnpm verify:web-chain`

Run: `git diff --check`

Expected: 两者退出码 0。

- [ ] **Step 3: 写事实型验收记录**

记录日期、分支、HEAD、命令、退出码、测试数量、未执行的真实 CloudBase/生产事项。只有阶段 0—3 全部满足时写“允许恢复普通网站功能开发”；否则写具体失败项和“继续冻结”。

- [ ] **Step 4: 在获得用户明确 Git 写入授权后提交文档**

```powershell
git add docs/operations/website-optimization-acceptance.md docs/superpowers/plans/2026-08-15-website-optimization-index.md
git commit -m "docs: 验收网站恢复开发门"
```
