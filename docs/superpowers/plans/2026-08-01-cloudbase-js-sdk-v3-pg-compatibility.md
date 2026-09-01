# CloudBase JS SDK V3 PG Compatibility Implementation Plan

> **历史计划提示：** 本文仅保留历史执行证据；其中 `ap-singapore` 地域条款与部署命令已被 [`2026-09-01-website-stage-2c-shanghai-rebuild-design.md`](../specs/2026-09-01-website-stage-2c-shanghai-rebuild-design.md) 替代，不得按本文执行 CloudBase 部署或远端写操作。与地域无关的历史事实不受此提示影响。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变匿名投稿和双层审核安全边界的前提下，将后端统一迁移到 CloudBase JS SDK V3 PG，并为 Next.js 管理员邮箱 OTP 登录建立安全的客户端适配层。

**Architecture:** 后端新增一个可注入、可测试的 CloudBase V3 运行时工厂，三个云函数只从该工厂取得 PostgreSQL、PG Storage 和 Auth 端口；RPC 的服务端 API Key 继续由独立适配器使用。前端新增仅客户端懒初始化的 CloudBase 单例和管理员认证适配器，普通用户继续只调用 `/api/v1`，不创建 CloudBase 匿名身份。

**Tech Stack:** pnpm workspace、TypeScript 5、Next.js 15、React 19、`@cloudbase/js-sdk` 3.6.x、`@cloudbase/signature-nodejs`、Zod、Vitest。

## Global Constraints

- CloudBase 环境地域固定为 `ap-singapore`。
- 普通用户保持完全匿名，不调用 `signInAnonymously`，不直接访问 PostgreSQL 或私有 Bucket。
- 浏览器只能使用 `NEXT_PUBLIC_CLOUDBASE_ENV_ID` 和 `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`。
- SecretId、SecretKey、服务端 API Key、管理员邮箱和内部 HMAC 密钥不得进入网站构建产物。
- 管理员 OTP 必须设置 `shouldCreateUser: false`。
- CloudBase 服务端 Auth 使用云函数运行时临时凭证，不传 API Key 或 Publishable Key。
- PostgreSQL RPC 的 `CLOUDBASE_API_KEY` 保持在独立服务端适配器中。
- 依赖和实现采用最小修改，不重写审核服务、状态机、DTO、迁移或存储端口。
- 文档和结构性注释使用中文。
- 当前 Git 写入受平台执行额度限制；只有平台恢复或用户重新授权后才执行计划中的提交步骤。

---

## 文件职责与改动范围

- `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`：唯一的服务端 V3 SDK 初始化与端口提取工厂。
- `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`：验证当前环境、地域、超时、单实例和无浏览器 Key 初始化。
- `apps/cloudbase-api/src/functions/api.ts`：从共享运行时取得 `rdb`、`storage` 和 `auth`。
- `apps/cloudbase-api/src/functions/moderation-worker.ts`：从共享运行时取得 `rdb` 和 `storage`。
- `apps/cloudbase-api/src/functions/cleanup.ts`：从共享运行时取得 `rdb` 和 `storage`。
- `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`：移除 Node SDK 模块补充声明，只保留仓库自有结构类型。
- `apps/cloudbase-api/src/config.ts`：提供严格的新加坡地域与 SDK 超时配置。
- `apps/website/lib/cloudbase-client.ts`：仅浏览器懒初始化的 V3 客户端单例。
- `apps/website/lib/admin-auth.ts`：邮箱 OTP、验证码确认、会话刷新和 Access Token 读取。
- `apps/website/tests/cloudbase-client.test.ts`：验证 SSR 隔离、初始化参数和单例。
- `apps/website/tests/admin-auth.test.ts`：验证禁止自动注册、Token 刷新及稳定错误。
- `apps/cloudbase-api/package.json`：添加签名依赖并最终移除旧 Node SDK。
- `apps/website/package.json`：添加 JS SDK V3。
- `pnpm-lock.yaml`：锁定工作区依赖。

---

### Task 1：安装并约束 CloudBase V3 依赖与配置

**Files:**
- Modify: `apps/cloudbase-api/package.json`
- Modify: `apps/website/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/cloudbase-api/src/config.ts`
- Modify: `apps/cloudbase-api/tests/config.test.ts`

**Interfaces:**
- Consumes: 现有 `loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig`。
- Produces: `CloudConfig.cloudbaseRegion: 'ap-singapore'` 和 `CloudConfig.cloudbaseSdkTimeoutMs: 15000`。

- [ ] **Step 1：为严格地域和超时写失败测试**

在 `apps/cloudbase-api/tests/config.test.ts` 的有效配置断言中加入：

```ts
expect(config.cloudbaseRegion).toBe('ap-singapore');
expect(config.cloudbaseSdkTimeoutMs).toBe(15_000);
```

加入拒绝错误地域的测试：

```ts
it('拒绝与已购买环境不一致的地域', () => {
  expect(() => loadCloudConfig({
    ...validEnv,
    CLOUDBASE_REGION: 'ap-shanghai'
  })).toThrow('CLOUDBASE_REGION 必须为 ap-singapore');
});
```

- [ ] **Step 2：运行配置测试确认 RED**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts
```

Expected: FAIL，提示 `cloudbaseRegion`/`cloudbaseSdkTimeoutMs` 尚不存在或错误地域未被拒绝。若 Vitest 仍被既知 esbuild 沙箱限制阻断，记录该环境阻塞，不提权、不绕过，并继续以类型检查作为静态 RED 证据。

- [ ] **Step 3：安装工作区依赖**

Run:

```powershell
pnpm.cmd --filter @myself/website add @cloudbase/js-sdk@3.6.8
pnpm.cmd --filter @myself/cloudbase-api add @cloudbase/signature-nodejs
```

Expected: 两个应用的 `package.json` 和根 `pnpm-lock.yaml` 更新；网站依赖树中没有 `@cloudbase/signature-nodejs` 的直接依赖。

- [ ] **Step 4：实现严格配置**

在 `CloudConfig` 中新增：

```ts
cloudbaseRegion: 'ap-singapore';
cloudbaseSdkTimeoutMs: 15000;
```

在 `loadCloudConfig` 中使用以下逻辑：

```ts
const cloudbaseRegion = env.CLOUDBASE_REGION?.trim() || 'ap-singapore';
if (cloudbaseRegion !== 'ap-singapore') {
  throw new Error('CLOUDBASE_REGION 必须为 ap-singapore');
}
```

在现有 `return` 对象中加入以下两个字段，其他现有字段和值保持原样：

```ts
cloudbaseRegion,
cloudbaseSdkTimeoutMs: 15_000,
```

- [ ] **Step 5：验证依赖边界和配置 GREEN**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts
pnpm.cmd --filter @myself/website why @cloudbase/signature-nodejs
```

Expected: 两个 typecheck 通过；测试通过或只留下已记录的 Vitest 平台阻塞；最后一条不显示网站直接依赖签名模块。

- [ ] **Step 6：在 Git 写入恢复后提交**

```powershell
git add apps/cloudbase-api/package.json apps/website/package.json pnpm-lock.yaml apps/cloudbase-api/src/config.ts apps/cloudbase-api/tests/config.test.ts
git commit -m "build: 安装 CloudBase JS SDK V3 PG 依赖"
```

---

### Task 2：建立 CloudBase V3 服务端运行时工厂

**Files:**
- Create: `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`
- Create: `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`

**Interfaces:**
- Consumes: `CloudConfig`、`CloudBaseRdbClient`、`CloudBaseStorageBucket`、`CloudBaseAuthClient`。
- Produces:

```ts
export interface CloudBaseServerRuntime {
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
  auth: CloudBaseAuthClient;
}

export function createCloudBaseServerRuntime(
  config: CloudConfig,
  sdk?: CloudBaseServerSdk
): CloudBaseServerRuntime;
```

- [ ] **Step 1：写 V3 初始化参数和单实例失败测试**

创建 `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`：

```ts
it('使用当前环境、新加坡地域和有界超时只初始化一次', () => {
  const init = vi.fn(() => fakeApp);
  const runtime = createCloudBaseServerRuntime(validConfig, {
    init,
    currentEnv: Symbol('current-env')
  });

  expect(init).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledWith({
    env: expect.any(Symbol),
    region: 'ap-singapore',
    timeout: 15_000
  });
  expect(runtime).toEqual({
    rdb: fakeRdb,
    bucket: fakeBucket,
    auth: fakeAuth
  });
});

it('服务端初始化不接受 API Key 或 Publishable Key', () => {
  createCloudBaseServerRuntime(validConfig, fakeSdk);
  expect(fakeSdk.init).not.toHaveBeenCalledWith(
    expect.objectContaining({ accessKey: expect.anything() })
  );
});
```

`fakeApp` 必须同时暴露 `rdb()`、`storage.from()` 和 `auth()`，从而证明三个端口来自同一个 app。

- [ ] **Step 2：运行测试确认 RED**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-runtime.test.ts
```

Expected: FAIL，模块 `cloudbase-runtime.ts` 尚不存在；如被既知平台限制阻断，记录后继续。

- [ ] **Step 3：实现最小结构端口和工厂**

在新文件中使用结构类型隔离 SDK 宽泛声明：

```ts
import cloudbase from '@cloudbase/js-sdk';

import type { CloudBaseAuthClient } from './cloudbase-auth.js';
import type { CloudBaseRdbClient } from './cloudbase-postgres.js';
import type { CloudBaseStorageBucket } from './cloudbase-storage.js';
import type { CloudConfig } from '../config.js';

export interface CloudBaseServerRuntime {
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
  auth: CloudBaseAuthClient;
}

export interface CloudBaseServerSdk {
  currentEnv: symbol;
  init(options: {
    env: symbol;
    region: 'ap-singapore';
    timeout: number;
  }): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
    auth(): CloudBaseAuthClient;
  };
}

const installedSdk: CloudBaseServerSdk = {
  currentEnv: cloudbase.SYMBOL_CURRENT_ENV,
  init: options => cloudbase.init(options) as ReturnType<CloudBaseServerSdk['init']>
};

export function createCloudBaseServerRuntime(
  config: CloudConfig,
  sdk: CloudBaseServerSdk = installedSdk
): CloudBaseServerRuntime {
  const app = sdk.init({
    env: sdk.currentEnv,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs
  });
  return {
    rdb: app.rdb(),
    bucket: app.storage.from(config.privateBucketId),
    auth: app.auth()
  };
}
```

如果已安装 V3 类型不接受 `symbol`，只在 `installedSdk` 边界执行窄化，不把类型断言扩散到业务代码。

- [ ] **Step 4：移除 Node SDK 模块补充声明**

从 `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts` 删除：

```ts
declare module '@cloudbase/node-sdk' {
  interface CloudBase {
    rdb(options?: {
      instance?: string;
      database?: string;
    }): CloudBaseRdbClient;
  }
}
```

保留 `CloudBaseRdbClient`、`CloudBaseRdbQuery` 和 RPC 客户端结构，不改变数据库业务实现。

- [ ] **Step 5：运行工厂测试和类型检查**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-runtime.test.ts cloudbase-postgres.test.ts cloudbase-auth.test.ts
```

Expected: typecheck 通过；测试通过或只留下既知平台阻塞。

- [ ] **Step 6：在 Git 写入恢复后提交**

```powershell
git add apps/cloudbase-api/src/adapters/cloudbase-runtime.ts apps/cloudbase-api/src/adapters/cloudbase-postgres.ts apps/cloudbase-api/tests/cloudbase-runtime.test.ts
git commit -m "refactor: 统一 CloudBase V3 服务端运行时"
```

---

### Task 3：迁移三个 CloudBase 云函数入口并删除旧 SDK

**Files:**
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/src/functions/moderation-worker.ts`
- Modify: `apps/cloudbase-api/src/functions/cleanup.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `apps/cloudbase-api/tests/moderation-worker.test.ts`
- Modify: `apps/cloudbase-api/tests/cleanup-service.test.ts`
- Modify: `apps/cloudbase-api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `createCloudBaseServerRuntime(config): CloudBaseServerRuntime`。
- Produces: 三个入口不再导入 `@cloudbase/node-sdk`，并继续导出原有 CommonJS 部署目标 `main`。

- [ ] **Step 1：写入口只使用共享运行时的失败测试**

为每个入口的生产依赖工厂增加可注入运行时测试，核心断言为：

```ts
expect(createRuntime).toHaveBeenCalledTimes(1);
expect(createRuntime).toHaveBeenCalledWith(config);
expect(nodeSdkInit).not.toHaveBeenCalled();
```

如果现有私有 `createProductionHandler/createProductionWorker` 无法注入，最小调整为导出只用于组合的工厂函数，不导出或暴露任何密钥。

- [ ] **Step 2：运行入口测试确认 RED**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- api.test.ts moderation-worker.test.ts cleanup-service.test.ts
```

Expected: FAIL，入口仍分别初始化 `cloudbaseNode` 和 `cloudbaseWeb`。

- [ ] **Step 3：将 API 入口改为单运行时**

在 `createProductionHandler` 中改为：

```ts
const config = loadCloudConfig(process.env);
const runtime = createCloudBaseServerRuntime(config);
const store = new CloudBasePostgresStore(
  runtime.rdb,
  new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey)
);
const storage = new CloudBaseStorage(runtime.bucket);
```

管理员身份适配器使用：

```ts
new CloudBaseAdminIdentityProvider(runtime.auth, config.adminEmail)
```

- [ ] **Step 4：迁移审核和清理入口**

两个 worker 同样调用一次 `createCloudBaseServerRuntime(config)`，分别把 `runtime.rdb` 和 `runtime.bucket` 传给既有 Store/Storage；不要修改批次大小、租约、状态机或审核编排。

- [ ] **Step 5：删除旧 Node SDK 依赖并扫描残留**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api remove @cloudbase/node-sdk
rg -n "@cloudbase/node-sdk|cloudbaseNode" apps/cloudbase-api
```

Expected: `package.json` 和锁文件删除旧依赖；`rg` 无命中。测试中若仅用于旧类型导入，也必须改用仓库结构类型或 `@cloudbase/js-sdk`。

- [ ] **Step 6：验证三个入口与构建边界**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd build:cloudbase
```

Expected: typecheck 和测试通过；构建产出三个 CJS `main`。若 esbuild 仍受既知平台限制，记录为部署硬门禁，不换工具伪造构建结果。

- [ ] **Step 7：在 Git 写入恢复后提交**

```powershell
git add apps/cloudbase-api/src/functions apps/cloudbase-api/tests apps/cloudbase-api/package.json pnpm-lock.yaml
git commit -m "refactor: 迁移云函数到 CloudBase JS SDK V3"
```

---

### Task 4：建立 Next.js 管理员 OTP 与 Access Token 适配层

**Files:**
- Create: `apps/website/lib/cloudbase-client.ts`
- Create: `apps/website/lib/admin-auth.ts`
- Create: `apps/website/tests/cloudbase-client.test.ts`
- Create: `apps/website/tests/admin-auth.test.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_CLOUDBASE_ENV_ID`、`NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY`。
- Produces:

```ts
export function getCloudBaseClient(): CloudBaseBrowserClient;
export function createAdminAuth(client?: CloudBaseBrowserClient): AdminAuthClient;

export interface AdminOtpChallenge {
  verify(code: string): Promise<void>;
}

export interface AdminAuthClient {
  requestEmailOtp(email: string): Promise<AdminOtpChallenge>;
  getAccessToken(): Promise<string>;
  signOut(): Promise<void>;
}
```

- [ ] **Step 1：写客户端初始化失败测试**

创建 `cloudbase-client.test.ts`，覆盖：

```ts
it('服务端渲染阶段拒绝初始化浏览器 SDK', () => {
  vi.stubGlobal('window', undefined);
  expect(() => getCloudBaseClient()).toThrow('CLOUDBASE_BROWSER_ONLY');
});

it('只使用公开环境变量并复用单例', () => {
  const first = getCloudBaseClient();
  const second = getCloudBaseClient();
  expect(first).toBe(second);
  expect(init).toHaveBeenCalledWith({
    env: 'ai-pet-dev',
    region: 'ap-singapore',
    accessKey: 'publishable-test-key',
    timeout: 15_000
  });
});
```

- [ ] **Step 2：写 OTP 和 Token 失败测试**

创建 `admin-auth.test.ts`：

```ts
it('邮箱 OTP 禁止自动创建用户', async () => {
  await auth.requestEmailOtp('admin@example.com');
  expect(signInWithOtp).toHaveBeenCalledWith({
    email: 'admin@example.com',
    options: { shouldCreateUser: false }
  });
});

it('没有有效会话时刷新一次再读取 Access Token', async () => {
  getSession
    .mockResolvedValueOnce({ data: { session: null }, error: null })
    .mockResolvedValueOnce({
      data: { session: { access_token: 'access-token' } },
      error: null
    });
  await expect(auth.getAccessToken()).resolves.toBe('access-token');
  expect(refreshSession).toHaveBeenCalledTimes(1);
});
```

测试替身同时兼容已安装 SDK 返回的 `access_token` 字段；不要自行发明长期 Token 存储。

- [ ] **Step 3：运行网站测试确认 RED**

Run:

```powershell
pnpm.cmd --filter @myself/website test -- cloudbase-client.test.ts admin-auth.test.ts
```

Expected: FAIL，两个模块尚不存在。

- [ ] **Step 4：实现浏览器懒初始化单例**

`getCloudBaseClient` 必须：

```ts
if (typeof window === 'undefined') {
  throw new Error('CLOUDBASE_BROWSER_ONLY');
}
```

并分别读取两个明确的公开变量：

```ts
const env = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID;
const accessKey = process.env.NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY;
```

缺失时抛出稳定错误；不得展开或遍历整个 `process.env`。

- [ ] **Step 5：实现管理员认证适配器**

`requestEmailOtp` 对邮箱执行 trim/lowercase 和最大 320 字符校验，调用：

```ts
const { data, error } = await client.auth.signInWithOtp({
  email: normalizedEmail,
  options: { shouldCreateUser: false }
});
```

`AdminOtpChallenge.verify` 调用：

```ts
const result = await data.verifyOtp({ token: code.trim() });
```

`getAccessToken` 先调用 `getSession()`，无 Token 时只调用一次 `refreshSession()`，仍无 Token 则抛出 `ADMIN_SESSION_REQUIRED`。`signOut` 只代理 SDK 的 `signOut()`。

- [ ] **Step 6：验证网站边界**

Run:

```powershell
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/website test -- cloudbase-client.test.ts admin-auth.test.ts
pnpm.cmd --filter @myself/website build
rg -n "TENCENTCLOUD_SECRET|CLOUDBASE_API_KEY|ADMIN_EMAIL|ABUSE_HMAC_SECRET|SCANNER_HMAC_SECRET" apps/website/.next
```

Expected: typecheck、测试和构建通过；密钥扫描无命中。若构建受既知 esbuild 平台限制，记录而不绕过。

- [ ] **Step 7：在 Git 写入恢复后提交**

```powershell
git add apps/website/lib/cloudbase-client.ts apps/website/lib/admin-auth.ts apps/website/tests/cloudbase-client.test.ts apps/website/tests/admin-auth.test.ts
git commit -m "feat: 增加管理员 CloudBase 邮箱认证适配层"
```

---

### Task 5：兼容迁移总体验证与原计划衔接

**Files:**
- Modify: `.superpowers/sdd/2026-07-30-cloudbase-anonymous-moderation-production/progress.md`
- Create: `.superpowers/sdd/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility/report.md`

**Interfaces:**
- Consumes: Task 1—4 的后端运行时和前端管理员认证端口。
- Produces: 可供原计划 Task 11 和 Task 14 复用的已审查基础设施。

- [ ] **Step 1：执行静态与自动化验证**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api typecheck
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/package-scanner typecheck
pnpm.cmd --filter @myself/cloudbase-api test
pnpm.cmd --filter @myself/website test
git diff --check
rg -n "@cloudbase/node-sdk|signInAnonymously" apps/cloudbase-api apps/website
```

Expected: 三个 typecheck 通过；测试通过或明确记录单一平台阻塞；diff-check 无空白错误；最后的扫描无命中。

- [ ] **Step 2：执行依赖和密钥边界检查**

Run:

```powershell
pnpm.cmd --filter @myself/cloudbase-api list @cloudbase/js-sdk @cloudbase/signature-nodejs
pnpm.cmd --filter @myself/website list @cloudbase/js-sdk
pnpm.cmd --filter @myself/website list @cloudbase/signature-nodejs
rg -n "secretId|secretKey|CLOUDBASE_API_KEY|ADMIN_EMAIL" apps/website/lib apps/website/components apps/website/app
```

Expected: 后端包含 JS SDK 和签名模块；网站只包含 JS SDK；网站签名模块列表为空；网站源码无服务端密钥读取。

- [ ] **Step 3：记录真实 CloudBase 硬门禁**

报告必须列出尚需在新加坡开发环境完成的项目：

```text
1. CloudBase V3 云函数默认临时凭证初始化
2. app.rdb() 查询与受限 RPC
3. PG Storage 签名上传、info、签名下载和删除
4. 邮箱 OTP 且 shouldCreateUser=false
5. HTTP 网关只保护 /api/v1/admin/*
6. Access Token 传递到 getUserInfo/getEndUserInfo
7. 非白名单邮箱稳定返回 403
```

- [ ] **Step 4：更新主执行台账**

在原 ledger 中新增：

```text
Task 10.5: CloudBase JS SDK V3 PG compatibility complete; review pending
```

正式审查通过后改为：

```text
Task 10.5: complete; review clean; real CloudBase smoke tests deferred to deployment gate
```

- [ ] **Step 5：在 Git 写入恢复后提交**

```powershell
git add .superpowers/sdd docs/superpowers/specs/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility-design.md docs/superpowers/plans/2026-08-01-cloudbase-js-sdk-v3-pg-compatibility.md
git commit -m "docs: 记录 CloudBase V3 PG 兼容迁移"
```

---

## 后续衔接

本计划通过正式审查后，继续执行原计划 Task 11。Task 11 的公开 `ApiClient` 不初始化 CloudBase 用户身份；Task 14 的管理员工作台直接复用 `AdminAuthClient`，并为管理员 HTTP 请求附加 `Authorization: Bearer <accessToken>`。
