# 官网 CloudBase 与扫描器可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭官网投稿链路的 S1 风险：统一 CloudBase V3 SDK，收窄三类函数配置，建立唯一扫描协议和可复验镜像候选，提供事务化迁移执行器，恢复技术扫描状态流与完整 ZIP 证据，并只在通过真实开发环境门禁后开启投稿。

**Architecture:** `packages/shared-types` 提供唯一的扫描线协议；CloudBase API 通过按函数拆分的配置与 V3 SDK 运行时调用扫描器，扫描器以临时 HTTP 契约返回可绑定对象身份的完整归档证据。数据库迁移执行器在单会话内持有 advisory lock，并按文件事务更新不可变台账；开发环境验收报告是功能开关由关闭变为开启的唯一前置证据。

**Tech Stack:** TypeScript 5.9、Node.js 22、pnpm 11.9、Vitest 3、Zod 3、`@cloudbase/js-sdk` 3.6.8、PostgreSQL、Vite 7、Docker、ClamAV。

## Global Constraints

- 适用规格：`docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md`；实施前必须确认该规格已经获得用户书面复核。
- 阶段 1 的官网停写止血措施必须先完成并保持默认关闭；本计划不得绕过阶段 1 直接开放投稿。
- 只允许修改本计划列出的官网、CloudBase、扫描器、共享契约、迁移工具与运维文档；禁止修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-*/**`。
- CloudBase 服务端只保留 `@cloudbase/js-sdk` 3.6.8；删除 `@cloudbase/node-sdk`，不得保留双 SDK 兼容层。
- 扫描器构建与运行统一为 Node.js 22；容器必须非 root 运行并提供 `/healthz`。
- 扫描协议版本固定为 `2026-08-15`，规则版本固定为 `character-package-2026-08-15`；协议字段由共享 Zod Schema 唯一定义。
- `SHARED_PACKAGE_SUBMISSIONS_ENABLED` 仅接受字面量 `true` 或 `false`，缺省为 `false`；只允许在真实开发环境验收全部通过后开启。
- Task 6 开始前，用户必须书面给出扫描证据 TTL 的精确数值及单位；计划不推测、不预填该值。
- 历史迁移文件一律不可编辑；状态流恢复必须新增前向迁移。
- RED 测试必须先以预期原因失败，才可写 GREEN 实现；每个任务先跑定向测试，再跑本任务列出的门禁。
- Git 默认只读；任务中的提交命令只有在用户另行明确授权后才执行。

---

## 文件结构与任务依赖

| 任务 | 主要产物 | 直接依赖 |
| --- | --- | --- |
| 1 | CloudBase V3 单 SDK 运行时 | 阶段 1 |
| 2 | API、审核、清理三套最小配置 | Task 1 |
| 3 | 唯一 `ScannerProtocol` 与真实临时 HTTP 契约测试 | 阶段 1 |
| 4 | Node 22 扫描器构建与镜像候选验证 | Task 3 |
| 5 | 单会话、逐文件事务迁移执行器 | 阶段 1 |
| 6 | `scanning` 状态流与完整 ZIP SHA-256 证据 | Task 2、3、5；证据 TTL 用户决策门 |
| 7 | 真实开发环境验收与投稿开关 | Task 1—6 |

### Task 1: 将 CloudBase 服务端收敛为 V3 单 SDK

**Files:**
- Modify: `apps/cloudbase-api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`
- Modify: `apps/cloudbase-api/tests/support/cloudbase-production.ts`
- Modify: `apps/cloudbase-api/tests/build-output.test.ts`
- Modify: `tools/build-cloudbase-functions.mjs`
- Modify: `tools/build-cloudbase-functions.test.mjs`

**Interfaces:**
- Consumes: 云函数传入的 V3 临时运行上下文；独立 RPC 调用继续使用 `CLOUDBASE_API_KEY`，不得作为 SDK 初始化密钥。
- Produces:

```ts
export interface CloudBaseFunctionContext {
  requestId?: string;
  environment?: string;
  credentials?: {
    secretId: string;
    secretKey: string;
    token: string;
  };
}

export interface CloudBaseRuntimeConfig {
  envId: string;
  region: string;
  timeoutMs: number;
}

export function createCloudBaseServerRuntime(
  config: CloudBaseRuntimeConfig,
  context: CloudBaseFunctionContext,
): CloudBaseRuntime;
```

- `createCloudBaseServerRuntime` 只以 `{ env, region, timeout, context }` 初始化 `@cloudbase/js-sdk`；初始化参数不得出现 `accessKey`、静态 `secretId` 或静态 `secretKey`。

- [ ] **Step 1: 写 V3 单 SDK RED 测试**

```ts
it('只用 V3 SDK 和云函数临时上下文初始化运行时', async () => {
  const init = vi.fn(() => fakeApp);
  createCloudBaseServerRuntime(
    { envId: 'dev-env', region: 'ap-shanghai', timeoutMs: 8_000 },
    { requestId: 'req-1', credentials: { secretId: 'sid', secretKey: 'skey', token: 'token' } },
    { init },
  );
  expect(init).toHaveBeenCalledWith({
    env: 'dev-env',
    region: 'ap-shanghai',
    timeout: 8_000,
    context: expect.objectContaining({ requestId: 'req-1' }),
  });
  expect(init.mock.calls[0]?.[0]).not.toHaveProperty('accessKey');
});

it('依赖树不再包含旧 Node SDK', () => {
  expect(cloudbaseApiPackage.dependencies).toHaveProperty('@cloudbase/js-sdk', '3.6.8');
  expect(cloudbaseApiPackage.dependencies).not.toHaveProperty('@cloudbase/node-sdk');
});
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/cloudbase-runtime.test.ts tests/build-output.test.ts`

Expected: FAIL，当前运行时仍导入 `@cloudbase/node-sdk`，且初始化参数仍含 `accessKey`。

- [ ] **Step 3: 完成最小 GREEN 实现**

```ts
import cloudbase from '@cloudbase/js-sdk';

export function createCloudBaseServerRuntime(
  config: CloudBaseRuntimeConfig,
  context: CloudBaseFunctionContext,
): CloudBaseRuntime {
  const app = cloudbase.init({
    env: config.envId,
    region: config.region,
    timeout: config.timeoutMs,
    context,
  });
  return createRuntimeFromApp(app);
}
```

将 `@cloudbase/js-sdk: 3.6.8` 加入 `apps/cloudbase-api/package.json`，删除 `@cloudbase/node-sdk`；调整构建器只处理 V3 SDK 的动态依赖，生产测试以真实 V3 导出为准。

- [ ] **Step 4: 运行 GREEN 与产物验证**

Run: `pnpm.cmd install --lockfile-only`

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/cloudbase-runtime.test.ts tests/build-output.test.ts`

Run: `node --test tools/build-cloudbase-functions.test.mjs`

Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`

Run: `pnpm.cmd --filter @myself/cloudbase-api build`

Expected: 全部 PASS；三个函数产物可由 Node 加载，且 `pnpm.cmd why @cloudbase/node-sdk -r` 无工作区直接依赖结果。

- [ ] **Step 5: 删除旧路径并建立审查门**

删除旧 SDK 依赖、旧 SDK 专用 source-string 断言、双 SDK 适配分支以及把 RPC API Key 传给 SDK 的代码。只有定向测试、类型检查和构建全绿后才允许删除；如需提交，先取得用户 Git 写授权，再执行：

```powershell
git add apps/cloudbase-api/package.json pnpm-lock.yaml apps/cloudbase-api/src/adapters/cloudbase-runtime.ts apps/cloudbase-api/tests/cloudbase-runtime.test.ts apps/cloudbase-api/tests/support/cloudbase-production.ts apps/cloudbase-api/tests/build-output.test.ts tools/build-cloudbase-functions.mjs tools/build-cloudbase-functions.test.mjs
git commit -m "refactor(cloudbase): 统一服务端 V3 SDK"
```

### Task 2: 将统一配置拆成三个函数的最小配置

**Files:**
- Create: `apps/cloudbase-api/src/config/config-readers.ts`
- Create: `apps/cloudbase-api/src/config/common-config.ts`
- Create: `apps/cloudbase-api/src/config/api-config.ts`
- Create: `apps/cloudbase-api/src/config/moderation-config.ts`
- Create: `apps/cloudbase-api/src/config/cleanup-config.ts`
- Create: `apps/cloudbase-api/tests/api-config.test.ts`
- Create: `apps/cloudbase-api/tests/moderation-config.test.ts`
- Create: `apps/cloudbase-api/tests/cleanup-config.test.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/src/functions/moderation-worker.ts`
- Modify: `apps/cloudbase-api/src/functions/cleanup.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/moderation-worker.test.ts`
- Delete after GREEN: `apps/cloudbase-api/src/config.ts`
- Delete after GREEN: `apps/cloudbase-api/tests/config.test.ts`

**Interfaces:**

```ts
export interface CommonCloudConfig {
  envId: string;
  region: string;
  sdkTimeoutMs: number;
  rpcApiKey: string;
  bucket: string;
}

export interface ApiConfig extends CommonCloudConfig {
  adminEmail: string;
  abuseSecret: string;
  sharedPackageSubmissionsEnabled: boolean;
}

export interface ModerationConfig extends CommonCloudConfig {
  scannerUrl: string;
  scannerHmacSecret: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  tmsEndpoint: string;
  imsEndpoint: string;
}

export type CleanupConfig = CommonCloudConfig;

export function readStrictBoolean(
  env: NodeJS.ProcessEnv,
  key: 'SHARED_PACKAGE_SUBMISSIONS_ENABLED',
  defaultValue: false,
): boolean;
export function loadApiConfig(env?: NodeJS.ProcessEnv): ApiConfig;
export function loadModerationConfig(env?: NodeJS.ProcessEnv): ModerationConfig;
export function loadCleanupConfig(env?: NodeJS.ProcessEnv): CleanupConfig;
```

- [ ] **Step 1: 写三套配置边界 RED 测试**

```ts
it('cleanup 不要求审核器、管理员或扫描器变量', () => {
  expect(loadCleanupConfig(commonEnv)).toEqual(expect.objectContaining({ bucket: 'private-bucket' }));
});

it('api 缺省关闭共享包投稿并拒绝模糊布尔值', () => {
  expect(loadApiConfig(apiEnv).sharedPackageSubmissionsEnabled).toBe(false);
  expect(() => loadApiConfig({ ...apiEnv, SHARED_PACKAGE_SUBMISSIONS_ENABLED: '1' }))
    .toThrow(/SHARED_PACKAGE_SUBMISSIONS_ENABLED/);
});

it('moderation 明确要求扫描器与内容审核凭据', () => {
  expect(() => loadModerationConfig(commonEnv)).toThrow(/SCANNER_URL/);
});
```

- [ ] **Step 2: 运行 RED 并确认旧聚合配置造成失败**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/api-config.test.ts tests/moderation-config.test.ts tests/cleanup-config.test.ts`

Expected: FAIL，三个 loader 尚不存在，当前 `loadCloudConfig` 会强制所有函数提供全量变量。

- [ ] **Step 3: 写最小 loader 并切换三个入口**

```ts
export function readStrictBoolean(
  env: NodeJS.ProcessEnv,
  key: 'SHARED_PACKAGE_SUBMISSIONS_ENABLED',
  defaultValue: false,
): boolean {
  const value = env[key];
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} 只允许 true 或 false`);
}
```

`api.ts` 只调用 `loadApiConfig`，`moderation-worker.ts` 只调用 `loadModerationConfig`，`cleanup.ts` 只调用 `loadCleanupConfig`；共同字段由 `loadCommonCloudConfig` 复用。

- [ ] **Step 4: 运行 GREEN、函数测试与 bundle 泄漏检查**

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/api-config.test.ts tests/moderation-config.test.ts tests/cleanup-config.test.ts tests/api.test.ts tests/moderation-worker.test.ts`

Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`

Run: `pnpm.cmd --filter @myself/cloudbase-api build`

Expected: 全部 PASS；cleanup bundle 不含 `SCANNER_HMAC_SECRET`、`ADMIN_EMAIL`、`TENCENT_SECRET_ID` 字符串，API bundle 不要求扫描器和腾讯审核变量。

- [ ] **Step 5: 删除聚合配置旧路径**

删除 `src/config.ts`、`tests/config.test.ts`、三个入口的 `loadCloudConfig` 导入和仅服务全量 fixture 的测试辅助代码。只有三个入口测试与构建均绿后删除；如获 Git 写授权，提交上述文件，提交信息使用 `refactor(cloudbase): 收窄云函数配置边界`。

### Task 3: 建立唯一 ScannerProtocol 与真实临时 HTTP 契约

**Files:**
- Create: `packages/shared-types/src/scanner-protocol.ts`
- Create: `packages/shared-types/tests/scanner-protocol.test.ts`
- Modify: `packages/shared-types/src/index.ts`
- Modify: `packages/shared-types/package.json`
- Modify: `apps/cloudbase-api/package.json`
- Modify: `apps/package-scanner/package.json`
- Modify: `apps/cloudbase-api/src/adapters/scanner-client.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/tests/scanner-client.test.ts`
- Modify: `apps/package-scanner/src/request-signature.ts`
- Modify: `apps/package-scanner/src/server.ts`
- Modify: `apps/package-scanner/src/scan-package.ts`
- Modify: `apps/package-scanner/tests/request-signature.test.ts`
- Modify: `apps/package-scanner/tests/server.test.ts`
- Create: `tests/vitest.web-chain.config.ts`
- Create: `tests/web-chain/scanner-http-contract.test.ts`

**Interfaces:**

```ts
export const SCANNER_PROTOCOL_VERSION = '2026-08-15' as const;
export const SCANNER_RULE_VERSION = 'character-package-2026-08-15' as const;

export const ScannerRequestSchema = z.object({
  protocolVersion: z.literal(SCANNER_PROTOCOL_VERSION),
  submissionId: z.string().uuid(),
  downloadUrl: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
});

export const ScannerResponseSchema = z.object({
  protocolVersion: z.literal(SCANNER_PROTOCOL_VERSION),
  ruleVersion: z.literal(SCANNER_RULE_VERSION),
  code: z.enum(['clean', 'dangerous', 'invalid', 'timeout', 'scanner_error']),
  completedAt: z.string().datetime({ offset: true }),
  archive: z.object({ sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  summary: z.object({ entryCount: z.number().int().nonnegative(), totalUncompressedBytes: z.number().int().nonnegative() }),
  jsonFiles: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  imageFiles: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
});

export type ScannerRequest = z.infer<typeof ScannerRequestSchema>;
export type ScannerResponse = z.infer<typeof ScannerResponseSchema>;
export function createScannerSignature(protocolVersion: string, timestamp: string, body: Uint8Array, secret: string): string;
```

签名规范固定为 `HMAC-SHA256(secret, protocolVersion + "\n" + timestamp + "\n" + SHA256(body))`。HTTP 端点固定为 `POST /internal/scan`；协议版本错误返回 400，HMAC 错误返回 401，超时返回 503 和共享错误 Schema。

- [ ] **Step 1: 先写共享 Schema 与跨应用真实 HTTP RED 测试**

```ts
it('API client 能调用真实临时 scanner server 并解析共享响应', async () => {
  const server = await startScannerServer({ port: 0, hmacSecret: 'contract-secret', scan: fakeCleanScan });
  const client = createScannerClient({ baseUrl: server.url, hmacSecret: 'contract-secret' });
  const result = await client.scan({
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    submissionId: '3d594650-3436-4ad0-a9a8-80ca4388824b',
    downloadUrl: 'http://127.0.0.1/archive.zip',
    expiresAt: '2026-08-15T10:00:00+08:00',
  });
  expect(result.protocolVersion).toBe(SCANNER_PROTOCOL_VERSION);
  await server.close();
});

it.each([
  ['错误协议版本', { protocolVersion: '2026-08-14' }, 400],
  ['错误 HMAC', { secret: 'wrong-secret' }, 401],
])('%s 被真实 server 拒绝', async (_name, override, status) => {
  expect(await postSignedScan(override)).toHaveProperty('status', status);
});
```

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/shared-types test -- scanner-protocol.test.ts`

Run: `pnpm.cmd vitest run --config tests/vitest.web-chain.config.ts tests/web-chain/scanner-http-contract.test.ts`

Expected: FAIL，共享协议与真实临时 server 工厂尚不存在；当前请求不携带 `submissionId` 和协议版本。

- [ ] **Step 3: 实现唯一协议并让两端消费同一 Schema**

共享包通过 `./scanner-protocol` 子路径导出常量、Schema、类型和签名函数；API client 使用 `ScannerRequestSchema` 序列化，scanner server 使用同一 Schema 验证输入和输出。临时 HTTP 测试必须监听系统分配端口 `0`，通过真实 socket 请求，不得 mock `fetch` 或直接调用 handler。

- [ ] **Step 4: 运行 GREEN 与所有直接消费者门禁**

Run: `pnpm.cmd --filter @myself/shared-types typecheck`

Run: `pnpm.cmd --filter @myself/shared-types test`

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/scanner-client.test.ts tests/ports.test.ts`

Run: `pnpm.cmd --filter @myself/package-scanner test -- tests/request-signature.test.ts tests/server.test.ts`

Run: `pnpm.cmd vitest run --config tests/vitest.web-chain.config.ts tests/web-chain/scanner-http-contract.test.ts`

Expected: 全部 PASS；协议版本与签名负例分别稳定返回 400 与 401。

- [ ] **Step 5: 删除重复契约**

删除 `scanner-client.ts` 内重复 Zod response schema、scanner server 内重复 request schema、两端各自的签名格式和不含 `submissionId` 的旧请求类型。只有共享包、两个消费者和真实 HTTP 契约均绿后删除；如获授权，提交信息使用 `feat(scanner): 统一临时 HTTP 扫描协议`。

### Task 4: 产出可复验的 scanner build/image candidate

**Files:**
- Modify: `apps/package-scanner/vite.build.config.ts`
- Modify: `apps/package-scanner/Dockerfile`
- Modify: `apps/package-scanner/tests/dockerfile.test.ts`
- Create: `apps/package-scanner/tests/build-output.test.ts`
- Create: `tools/verify-package-scanner-candidate.mjs`
- Create: `tools/verify-package-scanner-candidate.test.mjs`
- Modify: `apps/package-scanner/README.md`
- Modify: `package.json`

**Interfaces:**

```ts
export interface ScannerCandidateReport {
  imageTag: 'ai-pet-package-scanner:stage2-candidate';
  imageId: string;
  nodeVersion: string;
  clamavVersion: string;
  clamavDatabaseVersion: string;
  uid: number;
  health: 'pass';
  eicar: 'blocked';
  timeout: 'http-503';
}
```

根脚本新增 `verify:scanner-candidate`，执行 `node tools/verify-package-scanner-candidate.mjs`。脚本只接受本地候选镜像，输出 JSON 报告，不部署 CloudBase Run，也不把本地验证写成云端通过。

- [ ] **Step 1: 写构建与候选脚本 RED 测试**

```ts
it('scanner bundle 的执行目标为 node22', async () => {
  const output = await buildScannerToTempDirectory();
  expect(output.target).toBe('node22');
  await expect(import(pathToFileURL(output.server))).resolves.toBeDefined();
});

it('候选报告必须绑定镜像身份和安全门', () => {
  const report = parseCandidateReport(validReport);
  expect(report).toEqual(expect.objectContaining({
    imageTag: 'ai-pet-package-scanner:stage2-candidate',
    imageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    health: 'pass',
    eicar: 'blocked',
    timeout: 'http-503',
  }));
  expect(report.uid).not.toBe(0);
});
```

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --filter @myself/package-scanner test -- tests/build-output.test.ts tests/dockerfile.test.ts`

Run: `node --test tools/verify-package-scanner-candidate.test.mjs`

Expected: FAIL，Vite 当前目标不是 `node22`，候选验证工具尚不存在。

- [ ] **Step 3: 实现 Node 22 构建与候选验证**

将 Vite `build.target` 固定为 `node22`；Docker builder 与 runtime 均固定 Node 22，保留非 root 用户和 `/healthz`。候选工具依次执行：构建镜像、取得 immutable image ID、启动临时容器、验证 UID 非 0、记录 Node/ClamAV/病毒库版本、请求 `/healthz`、用 EICAR ZIP 验证 `dangerous`、注入超时扫描器验证 HTTP 503，最后停止并删除本次临时容器。

- [ ] **Step 4: 运行 GREEN 与真实候选门禁**

Run: `pnpm.cmd --filter @myself/package-scanner build`

Run: `pnpm.cmd --filter @myself/package-scanner test`

Run: `node --test tools/verify-package-scanner-candidate.test.mjs`

Run: `pnpm.cmd verify:scanner-candidate`

Expected: 测试全 PASS；最后一条命令输出满足 `ScannerCandidateReport` 的 JSON，并绑定精确 image ID。

- [ ] **Step 5: 删除脆弱验证路径**

删除只检查 Dockerfile 文本片段却不验证 bundle、UID、health、EICAR 和 timeout 的断言；保留少量锁定基础镜像与非 root 指令的静态检查。只有真实候选命令通过后删除；如获授权，提交信息使用 `build(scanner): 增加可复验镜像候选门禁`。

### Task 5: 实现单会话、逐文件事务的迁移执行器

**Files:**
- Modify: `tools/cloudbase-migration-inventory.mjs`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Create: `tools/cloudbase-migrations/plan.mjs`
- Create: `tools/cloudbase-migrations/render-batch.mjs`
- Create: `tools/cloudbase-migrations/executor.mjs`
- Create: `tools/cloudbase-migrations/plan.test.mjs`
- Create: `tools/cloudbase-migrations/render-batch.test.mjs`
- Create: `tools/cloudbase-migrations/executor.test.mjs`
- Create: `tools/apply-cloudbase-migrations.mjs`
- Create: `tools/apply-cloudbase-migrations.test.mjs`
- Modify: `package.json`
- Modify: `docs/operations/cloudbase-deployment.md`

**Interfaces:**

```ts
export interface MigrationFile {
  version: string;
  name: string;
  path: string;
  checksumSha256: string;
  sql: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksumSha256: string;
  appliedAt: string;
}

export interface CloudBaseMigrationPlan {
  pending: MigrationFile[];
  applied: AppliedMigration[];
  checksumConflicts: Array<{ version: string; expected: string; actual: string }>;
}

export function loadMigrationSources(directoryUrl: URL, inventory: readonly CloudBaseMigrationInventoryItem[]): Promise<MigrationFile[]>;
export function createMigrationPlan(files: MigrationFile[], ledger: AppliedMigration[]): CloudBaseMigrationPlan;
export function renderMigrationBatch(plan: CloudBaseMigrationPlan, advisoryLockKey: bigint): string;
export function applyMigrationPlan(client: CloudBaseSqlClient, plan: CloudBaseMigrationPlan): Promise<AppliedMigration[]>;
```

CLI 明确提供 `--inventory --json`、`--dry-run --json`、`--apply`。无参数只输出帮助并以非零状态退出，不允许默认写数据库。

- [ ] **Step 1: 写发现、校验、锁和故障续跑 RED 测试**

```js
test('复用阶段 1 inventory 顺序并拒绝台账 checksum 漂移', async () => {
  const inventory = await inventoryCloudBaseMigrations(fixtureDirectoryUrl);
  const files = await loadMigrationSources(fixtureDirectoryUrl, inventory);
  assert.deepEqual(files.map((file) => file.version), ['20260730000000', '20260807000000']);
  assert.throws(
    () => createMigrationPlan(files, [{ ...applied, checksumSha256: '0'.repeat(64) }]),
    /checksum conflict/,
  );
});

test('一个批次只取一次锁且每个文件独立事务', () => {
  const sql = renderMigrationBatch(planWithTwoFiles, 8_150_001n);
  assert.equal(count(sql, 'pg_advisory_lock'), 1);
  assert.equal(count(sql, 'BEGIN;'), 2);
  assert.equal(count(sql, 'COMMIT;'), 2);
  assert.match(sql, /INSERT INTO schema_migrations/);
});

test('第二个文件失败时保留第一个提交，重跑只执行剩余文件', async () => {
  const first = await applyWithInjectedFailure({ failVersion: '20260807000000' });
  assert.deepEqual(first.ledgerVersions, ['20260730000000']);
  const second = await applyMigrationPlan(first.client, first.replanned);
  assert.deepEqual(second.map((row) => row.version), ['20260807000000']);
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test tools/cloudbase-migrations/*.test.mjs tools/apply-cloudbase-migrations.test.mjs`

Expected: FAIL，阶段 1 只有只读 inventory/checksum/dry-run，尚无 SQL source loader、台账、锁和逐文件故障恢复接口。

- [ ] **Step 3: 实现单次 `executePGSql` 批次**

`loadMigrationSources` 必须消费阶段 1 已校验的 inventory，不再实现第二套发现、命名和排序逻辑；它按 `fileName` 读取原始 SQL，并再次核对 SHA-256。`renderMigrationBatch` 必须生成一次发送给 `@cloudbase/manager-node` `executePGSql` 的 SQL：创建不可变 `schema_migrations` 台账、获取一次 session advisory lock、逐文件重新检查台账、每个未应用文件各自 `BEGIN/COMMIT`，并在同一事务写入版本、名称、SHA-256 与时间。渲染前剥离历史 SQL 最外层单个 `BEGIN;`/`COMMIT;`，不修改历史文件内容；发现 checksum 冲突必须在执行任何 pending SQL 前失败。

- [ ] **Step 4: 运行 GREEN 与只读 inventory/dry-run**

Run: `node --test tools/cloudbase-migrations/*.test.mjs tools/apply-cloudbase-migrations.test.mjs`

Run: `node tools/apply-cloudbase-migrations.mjs --inventory --json`

Run: `node tools/apply-cloudbase-migrations.mjs --dry-run --json`

Expected: 测试全 PASS；inventory 按版本列出阶段 1 验收时的全部迁移（当前基线为三份历史迁移加阶段 1 新增的发布防线前向迁移）；dry-run 不连接或写入数据库，并输出 pending、applied、checksumConflicts。

- [ ] **Step 5: 删除固定单文件 runner 路径**

删除硬编码 `migrationPath`、无参数即执行写入、每份迁移分别建立远程 session 的分支。历史 SQL 文件不可删除或改写。只有故障注入续跑测试和 dry-run 通过后删除；如获授权，提交信息使用 `feat(cloudbase): 增加事务迁移执行器`。

### Task 6: 恢复 scanning 状态流并绑定完整 ZIP SHA-256 证据

**Files:**
- Create: `cloudbase/migrations/20260815010000_restore_scanned_submission_flow.sql`
- Modify: `packages/shared-types/src/moderation.ts`
- Modify: `packages/shared-types/tests/moderation.test.ts`
- Modify: `apps/package-scanner/src/scan-package.ts`
- Modify: `apps/package-scanner/tests/scan-package.test.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/scanner-client.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/services/submission-service.ts`
- Modify: `apps/cloudbase-api/src/services/moderation-service.ts`
- Modify: `apps/cloudbase-api/src/services/admin-service.ts`
- Modify: `apps/cloudbase-api/tests/submission-service.test.ts`
- Modify: `apps/cloudbase-api/tests/moderation-service.test.ts`
- Modify: `apps/cloudbase-api/tests/admin-service.test.ts`
- Modify: `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- Modify: `apps/website/tests/cloud-shared-pet-repository.test.ts`
- Modify: `apps/website/lib/submission-status.ts`
- Modify: `apps/website/tests/submission-status.test.tsx`
- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `docs/operations/content-moderation.md`

**Interfaces:**

```ts
export interface PackageArchiveIdentity {
  sizeBytes: number;
  sha256: string;
}

export interface PackageScanResult {
  protocolVersion: typeof SCANNER_PROTOCOL_VERSION;
  ruleVersion: typeof SCANNER_RULE_VERSION;
  code: 'clean' | 'dangerous' | 'invalid' | 'timeout' | 'scanner_error';
  completedAt: string;
  archive: PackageArchiveIdentity;
  summary: { entryCount: number; totalUncompressedBytes: number };
  jsonFiles: Array<{ path: string; sha256: string }>;
  imageFiles: Array<{ path: string; sha256: string }>;
}

export interface PackageScanEvidence {
  submissionId: string;
  objectKey: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  protocolVersion: typeof SCANNER_PROTOCOL_VERSION;
  ruleVersion: typeof SCANNER_RULE_VERSION;
  code: 'clean';
  completedAt: string;
  statusVersion: number;
  objectEtag?: string;
}
```

状态不变量：上传初始化为 `uploading`；完成上传后以版本 `N -> N+1` 进入 `system_reviewing`；clean 技术扫描完成后以 `N+1 -> N+2` 进入 `manual_review_pending`，证据 `statusVersion` 等于 `N+2`；dangerous/invalid 自动进入 `auto_rejected`；timeout/scanner_error 保持 `system_reviewing`、保持私有且进入重试。系统审核通过不等于公开发布。

- [ ] **Step 0: 通过证据 TTL 用户决策门**

向用户书面确认两个不可拆分字段：`SCAN_EVIDENCE_TTL_VALUE` 的正整数和 `SCAN_EVIDENCE_TTL_UNIT` 的单位。将用户原文决定记录到本计划引用的规格或独立 ADR 后才能开始 Step 1；未获得明确决定时 Task 6 状态必须保持未开始，不创建迁移、不写测试、不实现默认值。

- [ ] **Step 1: 写状态、全 ZIP hash 与证据绑定 RED 测试**

```ts
it('complete upload 从 uploading 进入 system_reviewing', async () => {
  const result = await service.completeUpload({ submissionId, statusVersion: 3 });
  expect(result).toMatchObject({ status: 'system_reviewing', statusVersion: 4 });
});

it('对收到的完整 ZIP 字节流计算 SHA-256，而非拼接 entry hash', async () => {
  const zip = await createCharacterZipFixture();
  const result = await scanPackage(Readable.from(zip));
  expect(result.archive).toEqual({
    sizeBytes: zip.byteLength,
    sha256: createHash('sha256').update(zip).digest('hex'),
  });
});

it('clean 扫描证据绑定投稿、对象、完整 ZIP 与最终状态版本', async () => {
  await moderation.process(submissionInSystemReviewing);
  expect(repository.savedEvidence).toEqual(expect.objectContaining({
    submissionId,
    objectKey: 'private/submissions/archive.zip',
    archiveSizeBytes: expectedZip.length,
    archiveSha256: expectedZipSha256,
    protocolVersion: '2026-08-15',
    ruleVersion: 'character-package-2026-08-15',
    code: 'clean',
    statusVersion: 5,
  }));
  expect(repository.current.status).toBe('manual_review_pending');
});

it.each(['objectKey', 'archiveSizeBytes', 'archiveSha256', 'protocolVersion', 'ruleVersion', 'statusVersion'])
  ('管理员审批拒绝不匹配的 %s', async (field) => {
    await expect(approveWithMutatedEvidence(field)).rejects.toThrow(/scan evidence/i);
  });
```

- [ ] **Step 2: 运行 RED 并确认当前半迁移状态**

Run: `pnpm.cmd --filter @myself/package-scanner test -- tests/scan-package.test.ts`

Run: `pnpm.cmd --filter @myself/cloudbase-api test -- tests/submission-service.test.ts tests/moderation-service.test.ts tests/admin-service.test.ts`

Run: `pnpm.cmd --filter @myself/website test -- tests/cloud-shared-pet-repository.test.ts tests/submission-status.test.tsx`

Expected: FAIL，当前 finalize 直接进入 `manual_review_pending`，扫描器只保存 entry hash，证据没有完整 ZIP identity，管理员门禁只核对较弱字段。

- [ ] **Step 3: 实现流式完整归档证据与服务状态机**

扫描器在下载流进入 ZIP 解析前通过 `Transform` 同时累计字节数与 `createHash('sha256')`，不得为 hash 再下载一次对象，也不得把完整 ZIP 常驻内存。`submission-service` 完成上传时只进入 `system_reviewing`；`moderation-service` 按上述状态不变量持久化完整证据并使用 optimistic `statusVersion`；`admin-service` 在批准前逐字段核对证据、对象当前 metadata/ETag、用户确认的 TTL 以及当前状态版本。

- [ ] **Step 4: 写前向 SQL 并验证 SQL 与服务语义一致**

迁移 `20260815010000_restore_scanned_submission_flow.sql` 必须新增所需证据列和约束，并恢复以下数据库函数行为：完成上传进入 `system_reviewing`；clean 扫描才进入 `manual_review_pending`；dangerous/invalid 进入 `auto_rejected`；临时失败不公开且可重试；管理员批准仅接受未过期且逐字段匹配的 clean evidence。不得编辑 `20260730000000_moderation.sql`、`20260807000000_public_like_kinds.sql`、`20260808000000_direct_manual_review.sql`。

以迁移 runner 的 SQL 行为测试调用临时 PostgreSQL fixture 验证实际函数返回与行状态，不使用字符串包含测试替代数据库行为测试。

- [ ] **Step 5: 更新网站状态解析与内存 E2E**

官网共享投稿仓库必须解析服务端真实 receipt，不再伪造 `manual_review_pending`。`tests/memory-website-api.mjs` 依次模拟 `uploading -> system_reviewing -> manual_review_pending -> approved`，并增加 dangerous 自动拒绝、scanner timeout 保持隐藏、错误 hash 无法管理员批准三条路径。

- [ ] **Step 6: 运行 GREEN 和跨应用门禁**

Run: `pnpm.cmd --filter @myself/shared-types test`

Run: `pnpm.cmd --filter @myself/shared-types typecheck`

Run: `pnpm.cmd --filter @myself/package-scanner test`

Run: `pnpm.cmd --filter @myself/package-scanner typecheck`

Run: `pnpm.cmd --filter @myself/cloudbase-api test`

Run: `pnpm.cmd --filter @myself/cloudbase-api typecheck`

Run: `pnpm.cmd --filter @myself/website test`

Run: `pnpm.cmd --filter @myself/website typecheck`

Run: `pnpm.cmd test:e2e:website`

Expected: 全部 PASS；测试证明确切状态转换、完整 ZIP SHA-256、证据过期与所有字段不匹配均被拒绝。

- [ ] **Step 7: 删除直接人工审核与弱证据旧路径**

删除 finalize 直接返回 `manual_review_pending`、无需技术扫描即可管理员批准、只记录 storage key/size/code 的弱证据、所有 signal 都硬编码为 manual pending、官网伪造投稿 receipt 的旧实现和相应旧测试。保留历史迁移文件。只有前向迁移行为测试、三个应用定向测试及网站 E2E 全绿后删除；如获授权，提交信息使用 `fix(moderation): 恢复技术扫描状态流与完整归档证据`。

### Task 7: 真实开发环境验收后开启投稿

**Files:**
- Create: `docs/operations/website-stage-2-development-acceptance.md`
- Create: `tools/verify-website-stage-2-development.mjs`
- Create: `tools/verify-website-stage-2-development.test.mjs`
- Modify: `package.json`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/content-moderation.md`

**Interfaces:**

```ts
export interface WebsiteStage2DevelopmentReport {
  environmentClass: 'development';
  migrationChecksums: Record<string, string>;
  functionCandidateIds: { api: string; moderationWorker: string; cleanup: string };
  scannerImageId: string;
  scannerProtocolVersion: '2026-08-15';
  scannerRuleVersion: 'character-package-2026-08-15';
  checks: {
    scannerHealth: 'pass';
    validHmac: 'pass';
    cleanZip: 'pass';
    eicar: 'pass';
    timeout: 'pass';
    privateBeforeApproval: 'pass';
    adminUnauthorized401: 'pass';
    adminForbidden403: 'pass';
    cleanFlow: 'pass';
    dangerousFlow: 'pass';
  };
  submissionSwitch: 'disabled' | 'enabled-after-gate';
}
```

工具必须读取显式 `--environment-class development`，拒绝 production、staging 和缺省值。所有外部部署、迁移写入、环境变量修改与真实投稿均需用户分别明确授权。

- [ ] **Step 1: 写环境分类与全门禁 RED 测试**

```js
test('拒绝非开发环境和缺失检查项', () => {
  assert.throws(() => assertDevelopmentGate({ ...validReport, environmentClass: 'production' }), /development/);
  assert.throws(() => assertDevelopmentGate({ ...validReport, checks: { ...validReport.checks, eicar: 'fail' } }), /eicar/);
});

test('只有全部检查通过才允许生成开启动作', () => {
  assert.deepEqual(createEnableAction(validReport), {
    functionName: 'api',
    environmentVariable: 'SHARED_PACKAGE_SUBMISSIONS_ENABLED',
    value: 'true',
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `node --test tools/verify-website-stage-2-development.test.mjs`

Expected: FAIL，开发环境验证工具和严格 report parser 尚不存在。

- [ ] **Step 3: 实现只读优先的开发环境验证工具**

工具先读取迁移 inventory、三个函数候选 ID、scanner image ID/版本，再执行 `/healthz`、正确和错误 HMAC、clean ZIP、EICAR、timeout、批准前对象私有、管理员 401/403、clean 完整流与 dangerous 自动拒绝。任一字段缺失或检查失败时退出非零，不生成开关动作；报告只允许写“CloudBase 开发环境通过”，不得写“生产已上线”。

- [ ] **Step 4: 运行本地 GREEN 与全仓网站/CloudBase 门禁**

Run: `node --test tools/verify-website-stage-2-development.test.mjs`

Run: `pnpm.cmd verify:cloudbase`

Run: `pnpm.cmd verify:website`

Run: `pnpm.cmd verify:scanner-candidate`

Expected: 全部 PASS；这一步只证明本地自动化和本地候选，不证明真实开发环境。

- [ ] **Step 5: 经授权执行真实开发环境迁移与候选部署**

先向用户列出目标开发环境 ID、三个函数名、scanner image ID、将写入的迁移版本和回滚边界，并取得外部写操作授权。授权后执行：

Run: `node tools/apply-cloudbase-migrations.mjs --dry-run --json`

Run: `node tools/apply-cloudbase-migrations.mjs --apply`

Run: `node tools/verify-website-stage-2-development.mjs --environment-class development --submission-switch disabled`

Expected: migration ledger checksum 全匹配，三个函数候选和 scanner image identity 均被报告绑定，所有检查为 `pass`，开关仍为 disabled。

- [ ] **Step 6: 经第二次明确授权只在开发环境开启投稿**

向用户展示 Step 5 的完整报告并单独请求开启开关授权。授权后仅给开发环境 API 函数设置 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=true`，只重新部署 API 函数，不重部署 moderation worker、cleanup 或 scanner；随后执行：

Run: `node tools/verify-website-stage-2-development.mjs --environment-class development --submission-switch enabled-after-gate`

Expected: 所有安全检查继续为 `pass`，新的匿名投稿可进入 `system_reviewing`，批准前对象保持私有，报告记录精确函数候选 ID、scanner image ID、迁移 checksum、协议/规则版本、执行命令、结果和开关变化。

- [ ] **Step 7: 删除旧开关与模糊验收口径**

删除任何缺省开启、在客户端控制投稿、用非严格布尔值开启、未验证完整门禁即生成 enable 动作的旧路径；文档删除“部署脚本存在即上线”“本地 Docker 通过即 CloudBase Run 通过”等表述。只有真实开发环境报告完成且用户确认后删除；如获授权，提交信息使用 `docs(website): 记录阶段二开发环境验收门禁`。

## 最终自检与交付门禁

- [ ] 对照规格逐条确认：V3 单 SDK、三函数最小配置、共享扫描协议、真实临时 HTTP、Node 22 镜像候选、事务迁移 runner、状态恢复、完整 ZIP SHA-256、证据 TTL 决策门、开发环境验收与投稿开关各有唯一任务和测试证据。
- [ ] 按 `writing-plans` 的 “No Placeholders” 清单逐项扫描本文；Expected: 每个代码步骤均完整，且不引用未定义接口。
- [ ] 执行越界路径扫描：`rg -n "apps/desktop|packages/agent-core|packages/file-tools|packages/character-" docs/superpowers/plans/2026-08-15-website-cloudbase-scanner-reliability.md`；Expected: 只命中 Global Constraints 的禁止修改声明及扫描器当前依赖边界，不出现任何 Modify/Create/Delete 指令。
- [ ] 执行完整质量门禁：`pnpm.cmd typecheck && pnpm.cmd verify:cloudbase && pnpm.cmd verify:website`；Expected: 全部 PASS。
- [ ] 执行只读 Git 核验：`git diff --check` 与 `git status --short`；Expected: 无空白错误，工作区只包含已批准范围内的改动。
- [ ] 交付时分别记录“本地自动化通过”“CloudBase 开发环境通过”“待用户生产授权”，不得将任一前者写成生产上线完成。
