# 网站阶段四 S2 持续治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `WebsiteExtension` 分支逐项关闭八项本地可执行 S2 债务，删除相应旧路径，并把真实网关 Router 裁决保留在阶段 2C 证据门。

**Architecture:** 采用纵向替换而非平行重写；共享 wire contract 先稳定，随后由生产 PostgreSQL/CloudBase Adapter、Memory Adapter 和网站消费者共同迁移。数据库只新增前向 migration；每项新 Interface 通过定向测试后立即删除数字 offset、toggle、先计数、重复 Schema、无界 reader 和过宽死方法。

**Tech Stack:** pnpm workspace、TypeScript 5.9、Zod 3、Next.js 15、React 19、Vitest 3、Node test runner、PostgreSQL 17、CloudBase JS SDK 3.6.8、Playwright 1.61。

## Global Constraints

- 规格唯一来源：`docs/superpowers/specs/2026-08-15-website-s2-governance-design.md`。
- 只允许修改网站链：`apps/website/**`、`apps/cloudbase-api/**`、必要的 `packages/shared-types/**`、`cloudbase/migrations/**`、`tools/release/**`、网站链测试/工具/文档和必要 workspace manifest/lockfile。
- 严禁修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`。
- 不执行远端 migration、CloudBase 资源写入、部署、发布、push、merge、rebase 或 PR。
- Git add/commit 已获用户授权；每个任务独立提交，禁止覆盖用户已有改动。
- 不删除 IndexedDB/LocalStorage Repository 或旧首页文件簇；阶段五大量删除仍需二次批准。
- 管理员 `force_publish` 继续允许无有效扫描通过证据的结构完整共享包发布为 `admin_override`；不得伪造技术通过结论。
- 每个实现执行 RED → GREEN → REFACTOR；测试必须先失败且原因正确，不能用源码字符串断言替代行为。
- 每个任务完成后执行规格符合性与工程质量复审；Critical/Important finding 必须修复并复审。
- 单一问题超过 15 分钟无实质进展时保留证据并切换方案，不降低安全语义或把未运行项目写成通过。

---

### Task 1：i18n 单向权威与 Liquid 测试 locality

**Files:**
- Modify: `.dependency-cruiser.mjs`
- Modify: `.dependency-cruiser.web.mjs`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/about-chapter.test.tsx`
- Modify: `apps/website/tests/download-chapter.test.tsx`
- Modify: `tools/verification/web-dependency-audit.test.mjs`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`

**Interfaces:**
- Consumes: `zhCN` 当前完整键集和现有 `MessageKey`/`Translate` 调用接口。
- Produces: `messages.ts → 无反向类型依赖`，`i18n-types.ts → messages.ts` 的单向依赖；功能层不得导入 Liquid 组件或 shader 的 error 级网站门。

- [ ] **Step 1: 写依赖门 RED**

把 `allowedDebt` 收窄为只允许 `no-orphan-production-module`，并在真实 fixture 增加：

```js
'apps/website/components/website-experience/shader-offender.ts':
  "import { LIQUID_GLASS_FRAGMENT_SHADER } from '../home-experience/liquid-glass-shaders.ts';\nexport { LIQUID_GLASS_FRAGMENT_SHADER };\n",
'apps/website/components/home-experience/liquid-glass-shaders.ts':
  "export const LIQUID_GLASS_FRAGMENT_SHADER = '';\n",
```

断言 `shader-offender.ts` 命中 `website-features-do-not-import-liquid-glass`，且该规则与网站范围 `no-circular` 的 severity 都是 `error`。

快速基线已经证明阶段四规格与计划尚未进入精确网站范围。范围测试补充这两个获批文档为 allowed，并继续证明同名伪文件与桌宠路径被拒绝。

- [ ] **Step 2: 运行 RED**

Run: `node --test tools/verification/web-dependency-audit.test.mjs`
Run: `node --test tools/verification/verify-website-scope.test.mjs`
Expected: FAIL；当前 i18n 循环仍存在，Liquid 规则尚未覆盖 shader 且仍是 warning；阶段四两份精确文档尚未放行。

- [ ] **Step 3: 最小删除反向依赖并收紧网站门**

`messages.ts` 删除 `MessageKey` import，并改为：

```ts
export const en: { [K in keyof typeof zhCN]: string } = {
  // 复用现有完整英文消息对象，不改文案。
};
```

Liquid 规则目标改为：

```js
to: {
  path: '^apps/website/components/home-experience/(LiquidGlassHome\\.tsx|liquid-glass-shaders\\.ts)$',
},
```

`.dependency-cruiser.web.mjs` 在筛选网站规则时只把 `no-circular` 和 `website-features-do-not-import-liquid-glass` 映射为 `severity: 'error'`，不改变桌宠审查级别。

`website-scope-policy.mjs` 只新增本阶段规格与计划两个精确路径，不改 baseline、不放行通配文档目录。

- [ ] **Step 4: 删除穿透 shader 实现的旧测试**

删除 `about-chapter.test.tsx` 和 `download-chapter.test.tsx` 中 shader import 及仅断言旧 uniform 字符串不存在的断言；保留 DOM 内容、交互和 `magnetic-intro.test.tsx` 的 GPU 可观察行为测试。

- [ ] **Step 5: 运行 GREEN**

Run: `node --test tools/verification/web-dependency-audit.test.mjs`
Run: `node --test tools/verification/verify-website-scope.test.mjs && pnpm.cmd verify:web-chain:scope`
Run: `pnpm.cmd deps:audit:web`
Run: `pnpm.cmd --filter @myself/website test -- tests/i18n.test.tsx tests/about-chapter.test.tsx tests/download-chapter.test.tsx tests/magnetic-intro.test.tsx`
Run: `pnpm.cmd --filter @myself/website typecheck`
Expected: 全部 PASS；依赖审查只剩 8 个阶段五 orphan warning。

- [ ] **Step 6: 提交**

```powershell
git add .dependency-cruiser.mjs .dependency-cruiser.web.mjs apps/website tools/verification/web-dependency-audit.test.mjs tools/verification/website-scope-policy.mjs tools/verification/verify-website-scope.test.mjs
git commit -m "refactor(web): 收口前端单向依赖"
```

### Task 2：Release Manifest 单一运行时契约

**Files:**
- Modify: `.dependency-cruiser.mjs`
- Modify: `.dependency-cruiser.web.mjs`
- Create: `packages/shared-types/src/release-manifest.ts`
- Create: `packages/shared-types/tests/release-manifest.test.ts`
- Modify: `packages/shared-types/package.json`
- Modify: `tools/release/package.json`
- Modify: `tools/release/src/generate-manifest.ts`
- Modify: `tools/release/tests/generate-manifest.test.ts`
- Modify: `apps/website/lib/release-manifest.ts`
- Modify: `apps/website/content/release-manifest.json`
- Modify: `apps/website/components/DownloadCard.tsx`
- Modify: `apps/website/components/website-experience/download/download-content.ts`
- Modify: `apps/website/components/website-experience/download/DownloadChapter.tsx`
- Modify: `apps/website/tests/release-manifest.test.ts`
- Modify: `apps/website/tests/download-model.test.ts`
- Modify: `tools/verification/web-dependency-audit.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `@myself/shared-types/release-manifest` 导出的 `publishedReleaseManifestSchema`、`unpublishedReleaseManifestSchema`、`releaseManifestSchema` 和 `ReleaseManifest`。
- Preserves: alpha 版本、`windows-x64`、当前文件名、published `signed: false` 与网站 UI 格式化。

- [ ] **Step 1: 写共享契约 RED**

```ts
expect(releaseManifestSchema.parse({
  version: '0.1.0-alpha.1',
  platform: 'windows-x64',
  status: 'unpublished',
  fileName: 'AI-Pet-0.1.0-alpha.1-windows-x64.exe'
}).status).toBe('unpublished');
expect(releaseManifestSchema.safeParse({
  version: '0.1.0-alpha.1',
  platform: 'windows-x64',
  status: 'unpublished',
  fileName: 'AI-Pet-0.1.0-alpha.1-windows-x64.exe',
  plannedReleaseTag: 'v0.1.0-alpha.1'
}).success).toBe(false);
```

release-tools 测试从共享子路径解析生成结果；website 测试也从同一子路径解析当前 JSON。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/shared-types test -- tests/release-manifest.test.ts`
Run: `pnpm.cmd --filter @myself/release-tools test`
Expected: FAIL；共享子路径和联合契约尚不存在。

- [ ] **Step 3: 建立唯一联合 Schema**

```ts
const releaseIdentitySchema = {
  version: z.string().regex(/^\d+\.\d+\.\d+-alpha\.\d+$/u),
  platform: z.literal('windows-x64'),
  fileName: z.string().regex(/^AI-Pet-\d+\.\d+\.\d+-alpha\.\d+-windows-x64\.exe$/u)
};

export const releaseManifestSchema = z.discriminatedUnion('status', [
  z.object({ ...releaseIdentitySchema, status: z.literal('published'),
    downloadUrl: z.string().url().regex(/\.exe$/u), sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u), publishedAt: z.string().datetime(),
    signed: z.literal(false) }).strict(),
  z.object({ ...releaseIdentitySchema, status: z.literal('unpublished') }).strict()
]);
```

package exports 增加 `./release-manifest`；release-tools 增加 workspace 依赖并删除本地 Zod Schema 与直接 `zod` 依赖。

同步把 `release-manifest` 纳入 shared-types 公开子路径白名单，并新增 `release-manifest-only-in-release-chain` error 规则：只允许 website、release-tools 和 shared-types 自测消费。真实 fixture 必须证明桌面端穿透该子路径会失败，避免新增契约成为跨业务后门。

- [ ] **Step 4: 迁移网站并删除冗余 tag**

website 生产与测试直接导入共享 Schema；`apps/website/lib/release-manifest.ts` 只保留 `formatReleaseSize()`。JSON 删除 `plannedReleaseTag`，Download UI 使用 `` `v${activePlatform.versionLabel}` `` 派生展示值，`DownloadPlatform` 删除持久 `plannedReleaseTag` 字段。

- [ ] **Step 5: 运行 GREEN**

Run: `pnpm.cmd --filter @myself/shared-types test && pnpm.cmd --filter @myself/shared-types typecheck`
Run: `pnpm.cmd --filter @myself/release-tools test && pnpm.cmd --filter @myself/release-tools typecheck`
Run: `pnpm.cmd --filter @myself/website test -- tests/release-manifest.test.ts tests/download-model.test.ts tests/download-chapter.test.tsx`
Run: `pnpm.cmd --filter @myself/website typecheck`
Run: `node --test tools/verification/web-dependency-audit.test.mjs && pnpm.cmd deps:audit:web`
Expected: 全部 PASS；全仓只剩共享文件中的一个 `releaseManifestSchema` 定义。

- [ ] **Step 6: 提交**

```powershell
git add .dependency-cruiser.mjs .dependency-cruiser.web.mjs packages/shared-types tools/release apps/website tools/verification/web-dependency-audit.test.mjs pnpm-lock.yaml
git commit -m "refactor(web): 统一发行清单契约"
```

### Task 3：有界 JSON 与 PostgreSQL RPC deadline

**Files:**
- Create: `apps/cloudbase-api/src/adapters/bounded-json-response.ts`
- Create: `apps/cloudbase-api/tests/bounded-json-response.test.ts`
- Modify: `apps/cloudbase-api/src/adapters/scanner-client.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/src/functions/moderation-worker.ts`
- Modify: `apps/cloudbase-api/src/functions/cleanup.ts`
- Modify: `apps/cloudbase-api/tests/scanner-client.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`

**Interfaces:**
- Produces: 内部 `readBoundedJsonResponse(response, { maxBytes, signal })`；PostgreSQL RPC 默认 15 秒、4 MiB。
- Preserves: Scanner 130 秒、12 MiB 和现有 `SCANNER_*` 错误分类；公开 HTTP 仍只看到 `DATABASE_ERROR`/既有 500 归一化。

- [ ] **Step 1: 写有界 reader RED**

分别覆盖：声明长度超限时不读 body、无长度分块超限时 cancel、恰好上限合法 JSON、空/畸形 JSON、中途 abort。断言生产改动为“删除或绕过边界检查”时至少一个测试失败。

- [ ] **Step 2: 写 RPC RED**

用假时钟和挂起 fetch 证明：等待响应头到 deadline 返回 `{data:null,error:{message:'RPC 请求超时'}}`；返回响应头后挂起 reader 也在同一 deadline 终止；4 MiB+1 返回“RPC 响应过大”。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/bounded-json-response.test.ts tests/cloudbase-postgres.test.ts tests/scanner-client.test.ts`
Expected: FAIL；当前 RPC 无 signal 且使用 `response.text()`，Scanner 仍有私有 reader。

- [ ] **Step 4: 实现并复用一个内部 reader**

reader 必须先检查可信的非负 `Content-Length`，再按实际 chunk 累计；超限或 abort 时调用 `reader.cancel()`，finally 释放 lock。PostgreSQL 客户端构造器接受一次性策略：

```ts
interface RpcClientOptions {
  timeoutMs: number;
  maxResponseBytes: number;
}
```

默认 `{ timeoutMs: 15_000, maxResponseBytes: 4 * 1024 * 1024 }`；三个组合根显式传入 `config.cloudbaseSdkTimeoutMs`，不新增环境变量。

- [ ] **Step 5: 删除旧 reader**

删除 `scanner-client.ts` 私有 `readJson` 和 `cloudbase-postgres.ts` 私有 `readJsonResponse`；将 RPC 名称收窄为当前调用集合的字符串联合，后续任务只向该联合追加已批准函数名。

- [ ] **Step 6: 运行 GREEN**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/bounded-json-response.test.ts tests/cloudbase-postgres.test.ts tests/scanner-client.test.ts`
Run: `pnpm.cmd --filter @myself/cloudbase-api test && pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `pnpm.cmd --filter @myself/package-scanner test`
Expected: 全部 PASS，源码只有一份有界 JSON 流读取实现。

- [ ] **Step 7: 提交**

```powershell
git add apps/cloudbase-api
git commit -m "fix(web): 限制云端RPC响应边界"
```

### Task 4：三条列表迁移 keyset cursor

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Create: `cloudbase/migrations/20260831030000_keyset_pagination.sql`
- Create: `apps/cloudbase-api/src/adapters/keyset-cursor.ts`
- Create: `apps/cloudbase-api/tests/keyset-cursor.test.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- Modify: `apps/website/lib/admin-api-client.ts`
- Modify: `apps/website/components/admin/AdminApp.tsx`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `apps/website/tests/cloud-feedback-repository.test.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`

**Interfaces:**
- Produces: 所有公开/管理员 page 的 `cursor?: string` 与 `nextCursor: string | null`。
- Produces: 私有 `encodeKeysetCursor(scope, sortTime, id)` / `decodeKeysetCursor(cursor, expectedScope)`。
- Produces: SQL RPC `list_public_community`、`list_public_feedback`、`list_admin_submissions`。

- [ ] **Step 1: 写 cursor codec 与共享 wire RED**

```ts
expect(publicListRequestSchema.parse({ limit: 8, cursor: 'v1.abc' }).cursor)
  .toBe('v1.abc');
expect(publicListRequestSchema.safeParse({ limit: 8, cursor: 8 }).success)
  .toBe(false);
```

codec 测试覆盖 round-trip、scope/status 错配、未知版本、非法日期/id、非 base64url 和 513 字符输入。

- [ ] **Step 2: 写真实 PostgreSQL RED**

临时 PostgreSQL 为社区、反馈、管理员各插入同时间戳 id，读取第一页后分别插入更新记录或改变第一页记录状态，再读第二页；断言无重复/漏项、id 降序稳定、跨 status cursor 拒绝。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/shared-types test -- tests/website-http.test.ts`
Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/keyset-cursor.test.ts tests/cloudbase-postgres.test.ts tests/api.test.ts`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: FAIL；当前只接受数字并使用 offset/range。

- [ ] **Step 4: 实现 SQL keyset 与 Adapter codec**

三个 SECURITY DEFINER RPC 校验 service_role、limit 1—100、cursor 成对为空或非空。社区和反馈使用以下真实列：

```sql
AND (
  p_cursor_time IS NULL
  OR (submission.published_at, submission.id) < (p_cursor_time, p_cursor_id)
)
ORDER BY submission.published_at DESC, submission.id DESC
LIMIT p_limit + 1
```

管理员 RPC 使用 `(submission.created_at, submission.id)` 的同形比较与排序；管理员 status 作为 cursor scope，而不是 token 外可变条件。SQL 中不得引入不存在的通用 `sort_time` 列或拼接动态列名。

- [ ] **Step 5: 原子迁移三个消费者**

API 只把 `limit` 转成数字，cursor 保持字符串。Community Repository 缓存每页起始 cursor，第一页请求不发送 cursor且刷新清空后续缓存；Feedback 和 Admin 只回传服务端 token，循环集合改为 `Set<string>`。Memory Adapter 使用相同稳定排序与 opaque cursor 行为，但不复用生产数据库实现。

- [ ] **Step 6: 删除 numeric cursor 与死列表路径**

删除所有 offset 注释、Number(cursor)、`.range` 公开/管理员列表调用；删除 `PublicSubmission`、`PublicSubmissionPage`、`SubmissionStore.listPublished`、`CloudBasePostgresStore.listPublished`、`mapPublicSubmission` 及仅维护该死方法的测试。不保留兼容 Wrapper。

- [ ] **Step 7: 运行 GREEN**

Run: `pnpm.cmd --filter @myself/shared-types test && pnpm.cmd --filter @myself/shared-types typecheck`
Run: `pnpm.cmd --filter @myself/cloudbase-api test && pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `pnpm.cmd --filter @myself/website test && pnpm.cmd --filter @myself/website typecheck`
Run: `pnpm.cmd test:website-contract`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: 全部 PASS；网站链业务 cursor 零数字实现。

- [ ] **Step 8: 提交**

```powershell
git add packages/shared-types cloudbase/migrations apps/cloudbase-api apps/website tests tools
git commit -m "refactor(web): 改用稳定键集游标"
```

### Task 5：desired-state 点赞与互动幂等账本

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Create: `cloudbase/migrations/20260831040000_idempotent_public_interactions.sql`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/services/public-content-service.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/src/services/cleanup-service.ts`
- Modify: `apps/cloudbase-api/tests/public-content-service.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/cleanup-service.test.ts`
- Modify: `apps/website/components/website-experience/community/shared-pet-types.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/components/website-experience/feedback/feedback-types.ts`
- Modify: `apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `apps/website/tests/cloud-feedback-repository.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`

**Interfaces:**
- Produces: `{ liked: boolean, operationId: uuid }` HTTP 请求与 `setPublicLike(...)` Store Interface。
- Produces: `public_interaction_operations`，动作联合预留 `like|download`，24 小时过期；cleanup 每轮最多删除 500 条。

- [ ] **Step 1: 写共享与服务 RED**

共享 Schema 拒绝空对象、未知字段和非 UUID。服务案例证明同 desired state 不反转，并把 `operationId`、设备哈希原样传入 Store。

- [ ] **Step 2: 写真实 SQL RED**

覆盖同 operation+同输入回放首次结果、同 ID 异参冲突、两个 operation 同 `liked=true` 只加一票、`liked=false` 不为负、两设备独立、并发同 operation 一次写入、24 小时过期记录由 cleanup 有界删除。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/public-content-service.test.ts tests/api.test.ts tests/cloudbase-postgres.test.ts tests/cleanup-service.test.ts`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: FAIL；当前请求为空、SQL 是 toggle 且无账本。

- [ ] **Step 4: 实现原子 desired-state RPC**

新增 `set_public_like(text,char(64),boolean,uuid)`；在同一事务中锁定互动行、插入/删除 vote、更新汇总并写首次结果。账本唯一 operationId，保存最小请求哈希事实和 `expires_at = now() + interval '24 hours'`。相同 ID 异参抛 `P1001`。

- [ ] **Step 5: 接入 cleanup**

新增 `purge_expired_public_interaction_operations(p_limit integer)`，只删除 `expires_at <= now()` 且 `LIMIT <= 500`。`CleanupStore`/`CleanupService.purgeDue()` 每轮调用一次，并在 `PurgeResult` 返回 `expiredOperationsPurged`，不能静默吞掉数据库失败。

- [ ] **Step 6: 迁移网站与 Memory**

网站 UI 与 Repository 的既有 `toggleLike(id)` 交互接口不扩张；Cloud Repository 在已有记录边界把当前状态转换为明确的 `desiredLiked`。每个未完成 item 保存 `{desiredLiked, operationId}`，失败重试同 desired state 复用，成功后删除；旧 IndexedDB/LocalStorage Repository 不修改。Memory Adapter 以设备+投稿保存 vote 和 24 小时 operation 结果；合同测试重放同请求并验证冲突。

- [ ] **Step 7: 删除 toggle 路径**

前向 migration 撤权并 `DROP FUNCTION toggle_public_like(text,char)`；删除 `togglePublicLike`、`toggleCommunityLike`、`toggleFeedbackLike` 命名、空 body 和只断言 toggle 次序的测试。不为旧本地 Repository 扩展新能力。

- [ ] **Step 8: 运行 GREEN**

Run: `pnpm.cmd --filter @myself/shared-types test && pnpm.cmd --filter @myself/shared-types typecheck`
Run: `pnpm.cmd --filter @myself/cloudbase-api test && pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `pnpm.cmd --filter @myself/website test && pnpm.cmd --filter @myself/website typecheck`
Run: `pnpm.cmd test:website-contract`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: 全部 PASS；服务端无 toggle 正式入口。

- [ ] **Step 9: 提交**

```powershell
git add packages/shared-types cloudbase/migrations apps/cloudbase-api apps/website tests tools
git commit -m "fix(web): 使公开点赞可安全重放"
```

### Task 6：下载成功签发与幂等计数

**Files:**
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Create: `cloudbase/migrations/20260831050000_idempotent_download_issuance.sql`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/services/public-content-service.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/tests/public-content-service.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Modify: `docs/operations/content-moderation.md`

**Interfaces:**
- Produces: `{ operationId: uuid }` 下载请求；`recordPublicDownload({submissionId,fingerprintHash,operationId})`。
- Preserves: 返回 URL、expiresAt 和 `publicationBasis`；不返回私有路径或设备事实。

- [ ] **Step 1: 写失败顺序 RED**

服务测试断言：签名失败时 Store 零调用；签名成功后才计数；计数失败时方法 reject 且不返回 URL；同 operation 重试可重新签名但 Store 只计一次。

- [ ] **Step 2: 写 SQL 与合同 RED**

临时 PostgreSQL 证明同 operation 只增加一次、异投稿/设备冲突、不同 operation 各增加一次。HTTP 合同证明响应丢失后同 body 重放仍成功且计数不重复。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/public-content-service.test.ts tests/api.test.ts tests/cloudbase-postgres.test.ts`
Run: `pnpm.cmd test:website-contract`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: FAIL；当前计数先于签名且每次递增。

- [ ] **Step 4: 实现固定顺序与幂等 RPC**

`record_public_download(text,char(64),uuid)` 复用 Task 5 账本的 `download` 分支并返回首次 `download_count`。服务输入包含设备哈希与 operationId，严格按“校验资产 → 签名 → 计数 → 返回”执行。

- [ ] **Step 5: 迁移网站与删除旧函数**

Community Repository 为失败下载保留 operationId，成功后清除；前向 migration 撤权并删除 `record_public_download(text)`。删除 `_fingerprint` 占位参数、空 body 和“计数早于签名”的旧测试。

- [ ] **Step 6: 记录口径并运行 GREEN**

运维文档只称 `downloadCount` 为“成功签发次数”，明确不等于实际传输/安装。

Run: `pnpm.cmd --filter @myself/cloudbase-api test && pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `pnpm.cmd --filter @myself/website test && pnpm.cmd --filter @myself/website typecheck`
Run: `pnpm.cmd test:website-contract`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add packages/shared-types cloudbase/migrations apps/cloudbase-api apps/website tests tools docs/operations/content-moderation.md
git commit -m "fix(web): 统一下载成功计数语义"
```

### Task 7：发布结构不变量与坏记录逐项隔离

**Files:**
- Create: `cloudbase/migrations/20260831060000_publication_shape_guard.sql`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/services/public-content-service.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/public-content-service.test.ts`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tests/website-contract/production-driver.test.ts`（Memory/Production 双驱动合同的直接消费者）
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`

**Interfaces:**
- Produces: SQL `assert_submission_publication_shape(id)` 与约束触发器；公开列表外部 Interface 不变。
- Preserves: `force_publish` 不要求扫描通过；反馈/建议不要求资产。

- [ ] **Step 1: 写发布不变量 RED**

临时 PostgreSQL 分别构造：缺 cover、重复 package、错误 package key、越层 cover key、零/NULL actual size、错误 MIME、空 title/body；普通批准与强制发布都必须回滚。再证明结构合法但无扫描证据的共享包仍能 `force_publish` 为 `admin_override`，多个 derived 资产合法。

- [ ] **Step 2: 写读隔离 RED**

Store/服务输入 `[合法、损坏、合法]` 必须返回两个合法项并保留基于最后原始候选的 nextCursor；一个封面签名失败时返回其他成功项；非空候选全部签名失败时抛 `STORAGE_ERROR`。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/cloudbase-postgres.test.ts tests/public-content-service.test.ts`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: FAIL；当前发布路径不检查结构且列表 fail-fast。

- [ ] **Step 4: 实现单一 SQL 结构断言**

migration 先执行只读 inventory 并在既有 published 违规时整体失败；随后创建 cover/package 部分唯一索引。状态进入 published 的触发器调用一个断言函数；已发布资产更新/删除使用 deferred constraint trigger 在事务末重新验证。共享包规则按规格第 5.4 节精确执行，反馈/建议只校验 kind 与非空文本。

- [ ] **Step 5: 实现逐项隔离**

Adapter 以 raw 行为 cursor 基准，单条映射错误只跳过该记录；服务使用 `Promise.allSettled`，有成功项时返回 fulfilled 项，全部失败时抛第一个稳定存储错误。日志只允许公开 submission id 和固定错误码，不写对象键或原始错误。

- [ ] **Step 6: 对齐 Memory 并运行 GREEN**

Memory `applyAdminAction` 在改变状态前运行等价结构验证，失败不修改版本、依据或审计。合同覆盖普通/强制发布和坏公开记录隔离。

Run: `pnpm.cmd --filter @myself/cloudbase-api test && pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `pnpm.cmd test:website-contract`
Run: `$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'; node --test tools/test-cloudbase-migrations.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add cloudbase/migrations apps/cloudbase-api tests tools
git commit -m "fix(web): 隔离损坏公开记录"
```

### Task 8：CloudBase 能力端口收窄与死方法删除

**Files:**
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/services/submission-service.ts`
- Modify: `apps/cloudbase-api/src/services/text-submission-service.ts`
- Modify: `apps/cloudbase-api/src/services/public-content-service.ts`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/ports.test.ts`
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts`
- Modify: `apps/cloudbase-api/tests/text-submission-service.test.ts`
- Modify: `apps/cloudbase-api/tests/public-content-service.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`

**Interfaces:**
- Produces: 四方法 `SubmissionStore`、单方法 `TextSubmissionStore`、稳定 `PublicContentStore`；各服务只获得所需 Storage `Pick`。
- Preserves: 一个 `CloudBasePostgresStore` 多接口 Adapter，不新增 facade。

- [ ] **Step 1: 写最小能力 RED**

类型测试证明：四方法 fake 可构造 `SubmissionService`；`PublicContentService` Store 不拥有 create/apply/claim/delete；`CloudBaseRdbQuery` 不拥有 `update/upsert/single`；生产 Store 分别满足最终能力接口。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/ports.test.ts tests/submission-service.test.ts tests/public-content-service.test.ts`
Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`
Expected: FAIL；当前 `SubmissionStore` 和公开服务依赖过宽。

- [ ] **Step 3: 收窄 Interface 并删除死实现**

从 `SubmissionStore` 删除已由 `ModerationJobStore`/`AdminStore` 拥有的重复项；把 `createTextSubmission` 移至 `TextSubmissionStore`；公开服务只收 `PublicContentStore`。删除确认无生产消费者的 `listPurgeCandidates`、`recordModerationResult` 以及对应映射/测试，删除 RDB Query 零调用的 `update/upsert/single`。

- [ ] **Step 4: 收窄 Storage 参数**

SubmissionService 使用 `Pick<ObjectStorage, 'createSignedUploadUrl' | 'info'>`；PublicContentService 与 AdminService 使用 `Pick<ObjectStorage, 'createSignedUrl'>`；CleanupService 保持 `Pick<ObjectStorage, 'delete'>`。不创建运行时 Wrapper。

- [ ] **Step 5: 运行 GREEN 与引用扫描**

Run: `pnpm.cmd --filter @myself/cloudbase-api test`
Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`
Run: `rg -n "listPublished|listPurgeCandidates|recordModerationResult|\.update\(|\.upsert\(|\.single\(" apps/cloudbase-api/src apps/cloudbase-api/tests`
Expected: 测试/typecheck PASS；引用扫描对已删除符号零命中。

- [ ] **Step 6: 提交**

```powershell
git add apps/cloudbase-api
git commit -m "refactor(web): 收窄云端业务能力端口"
```

### Task 9：阶段四联合门、验收记录与 Router 条件门

**Files:**
- Create: `.superpowers/sdd/2026-08-31-website-stage-4-s2-governance/task-9-preflight-report.md`
- Create: `cloudbase/migrations/20260831070000_feedback_kind_null_guard.sql`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/keyset-cursor.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`
- Modify: `docs/superpowers/plans/2026-08-31-website-stage-4-s2-governance.md`
- Modify: `docs/operations/website-optimization-acceptance.md`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`

**Interfaces:**
- Produces: 阶段四本地可执行项的日期化真实证据；Router 明确为等待阶段 2C，不写成失败或通过。

- [ ] **Step 1: 运行定向剩余门**

Run: `pnpm.cmd deps:audit:web`
Run: `pnpm.cmd test:website-contract`
Run: `pnpm.cmd verify:web-chain:scope`
Run: `pnpm.cmd verify:web-chain:ownership`
Run: `git diff --check`
Expected: 全部退出 0；依赖审查只剩 8 个阶段五 orphan warning；黑名单桌宠路径零差异。

- [ ] **Step 2: 运行 CloudBase 与 website 门**

Run: `pnpm.cmd verify:cloudbase`
Run: `pnpm.cmd verify:website`
Expected: 全部 PASS；失败、超时或取消不得登记为通过。

- [ ] **Step 3: 运行 PostgreSQL 17 与完整网站链**

Run:

```powershell
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
```

Expected: 从 scope 到 browser E2E 的同一次完整门退出 0；记录实际 migration 数、行为断言数、各 package 测试数、构建与 E2E 数，不复制旧数字。

- [ ] **Step 4: 独立最终双审**

对本计划起点到 HEAD 执行规格审查与工程质量审查，重点核对：无 numeric/toggle/先计数/重复 Manifest/无界 reader/过宽死方法；`force_publish` 保持；Memory/Production 同构；Router 未被预判。Critical/Important 必须由一个修复子智能体统一修复并做一次 scoped re-review。

- [ ] **Step 5: 更新文档真实状态**

索引把阶段四八项本地治理标记为完成，把 Liquid 项标记为 8/20 已接替，把 Router 标记为“等待阶段 2C 真实网关证据”。验收记录写实际日期、命令、结果、未覆盖项；CloudBase 开发环境、远端 migration、cleanup 调度、部署和正式上线继续写“未执行”。

- [ ] **Step 6: 提交阶段四验收**

```powershell
git add docs/superpowers/plans/2026-08-15-website-optimization-index.md docs/superpowers/plans/2026-08-31-website-stage-4-s2-governance.md docs/operations/website-optimization-acceptance.md docs/operations/cloudbase-deployment.md docs/operations/content-moderation.md
git commit -m "docs: 完成网站阶段四本地治理"
```

## 执行台账

- Task 1：pending
- Task 2：pending
- Task 3：pending
- Task 4：pending
- Task 5：pending
- Task 6：pending
- Task 7：pending
- Task 8：pending
- Task 9：pending
