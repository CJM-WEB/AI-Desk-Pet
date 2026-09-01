# 官网官方安装包下载计数实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以最小网站链改动记录正式 Windows 安装包按钮点击，并只在管理员模式显示累计值。

**Architecture:** 复用现有 CloudBase API 和 PostgreSQL Adapter，在新前向 migration 中加入单例指标表与两个受控函数。独立指标 Store 隐藏限流、原子递增和读取；公开路由只登记且返回空对象，管理员路由经过现有鉴权后读取累计值；下载链接不等待辅助请求。

**Tech Stack:** Next.js、React、TypeScript、Zod、CloudBase Functions、PostgreSQL、Vitest、Playwright、pnpm。

## Global Constraints

- 只统计 `windows-x64` 且 `available` 的真实安装包按钮；不统计章节锚点、未发布按钮或 macOS。
- 公开页面和公开响应不得出现累计值；只有现有管理员鉴权后的接口和工作台可读。
- 计数失败、超时或限流不得调用 `preventDefault`，不得等待请求，也不得阻止发行清单中的原始下载地址。
- 复用 `download:official-windows` 的既有 10 次/60 秒设备限流，不存储原始 IP、User-Agent 或第三方标识。
- 新增且只新增一条 `20260901020000_official_windows_download_click_metric.sql` 前向 migration；历史 migration 不修改，总数从 15 增至 16。
- 不新增依赖、环境变量、服务、任务、CloudBase Run、TMS、IMS 或桌宠改动。
- 文档和结构性注释使用中文；所有实现遵守 RED → GREEN → REFACTOR。

---

### Task 1: 数据库、契约与 CloudBase API

**Files:**

- Create: `cloudbase/migrations/20260901020000_official_windows_download_click_metric.sql`
- Modify: `packages/shared-types/src/website-http.ts`
- Modify: `packages/shared-types/tests/website-http.test.ts`
- Modify: `apps/cloudbase-api/src/ports.ts`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`
- Modify: `apps/cloudbase-api/tests/ports.test.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- Modify: `apps/cloudbase-api/tests/api.test.ts`
- Modify: `tools/cloudbase-migration-inventory.test.mjs`
- Modify: `tools/test-cloudbase-migrations.mjs`
- Modify: `tools/test-cloudbase-migrations.test.mjs`

**Interfaces:**

- Consumes: 现有 JSON 信封、`consume_abuse_limit`、HMAC 设备指纹、`requireAdmin`、`CloudBasePostgresStore`。
- Produces: `POST /api/v1/official-downloads/windows/click`、`GET /api/v1/admin/metrics/official-windows-download`、严格空公开响应、`{ clickCount }` 管理员响应，以及 `OfficialDownloadMetricStore` 两方法接口。

- [ ] **Step 1: 写共享契约、服务、API、Adapter 与 migration 行为的失败测试**

新增测试必须先证明以下行为缺失：

```ts
expect(officialDownloadClickRequestSchema.parse({})).toEqual({});
expect(officialDownloadClickRequestSchema.safeParse({ count: 1 }).success).toBe(false);
expect(officialDownloadClickResponseSchema.parse({})).toEqual({});
expect(officialDownloadClickResponseSchema.safeParse({ clickCount: 1 }).success).toBe(false);
expect(adminSiteMetricsResponseSchema.parse({ clickCount: 12 }))
  .toEqual({ clickCount: 12 });
```

API 测试必须以真实 `createApi` 断言：公开路由把 HMAC 设备指纹交给独立 Store、响应严格为空；管理员路由先调用身份校验再读取，403 时不读取指标。PostgreSQL 行为门必须断言连续两次递增得到 2、多个独立并发会话不丢失、限流与递增同事务，表和函数不授予公开角色。

- [ ] **Step 2: 运行 RED 并确认失败原因是功能不存在**

Run:

```powershell
pnpm.cmd --filter @myself/shared-types test -- website-http.test.ts
pnpm.cmd --filter @myself/cloudbase-api test -- api.test.ts cloudbase-postgres.test.ts ports.test.ts
node --test tools/cloudbase-migration-inventory.test.mjs tools/test-cloudbase-migrations.test.mjs
```

Expected: 因 schema、端点、Store 方法、RPC 或第 16 条 migration 不存在而失败；不得是语法、fixture 或导入错误。

- [ ] **Step 3: 写最小 GREEN 实现**

共享契约固定为严格空请求、严格空公开响应，以及仅含非负安全整数 `clickCount` 的管理员响应。独立指标接口固定为：

```ts
interface OfficialDownloadMetricStore {
  recordOfficialWindowsDownloadClick(
    input: { fingerprintHash: string }
  ): Promise<void>;
  getOfficialWindowsDownloadClickCount(): Promise<number>;
}
```

公开 dispatcher 只生成 HMAC 设备指纹并交给该 Store；SQL 在一次 RPC 事务内消费 `download:official-windows` 的 10 次/60 秒既有限流并原子加一。管理员 dispatcher 必须先 `requireAdmin` 再调用读取方法。两个函数只授予 `service_role`，表启用并强制 RLS。

- [ ] **Step 4: 运行 GREEN 与相关回归**

Run:

```powershell
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/cloudbase-api test
node --test tools/cloudbase-migration-inventory.test.mjs tools/test-cloudbase-migrations.test.mjs
node tools/test-cloudbase-migrations.mjs
```

Expected: 全部通过；migration 汇总为 16 条，行为数只按新增真实断言更新。

- [ ] **Step 5: 自审、`git diff --check` 并提交**

```powershell
git diff --check
git add packages/shared-types cloudbase/migrations/20260901020000_official_windows_download_click_metric.sql apps/cloudbase-api tools/cloudbase-migration-inventory.test.mjs tools/test-cloudbase-migrations.mjs tools/test-cloudbase-migrations.test.mjs
git commit -m "feat(web): 记录官方安装包下载点击"
```

完成标准：数据库原子计数、公开不泄露、管理员鉴权读取和固定限流均由 RED/GREEN 证据保护。

---

### Task 2: 下载按钮与管理员展示

**Files:**

- Create: `apps/website/lib/official-download-metric-client.ts`
- Create: `apps/website/tests/official-download-click.test.tsx`
- Create: `apps/website/tests/official-download-metric-client.test.ts`
- Modify: `apps/website/components/website-experience/download/DownloadChapter.tsx`
- Modify: `apps/website/lib/admin-api-client.ts`
- Modify: `apps/website/components/admin/AdminApp.tsx`
- Modify: `apps/website/components/admin/admin.module.css`
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/admin-api-client.test.ts`
- Modify: `apps/website/tests/admin-app.test.tsx`

**Interfaces:**

- Consumes: Task 1 的两个响应 schema 和端点；发行清单提供的原始 Windows `downloadUrl`；现有管理员令牌。
- Produces: 不阻断导航的点击上报函数，以及管理员顶栏的官方安装包累计点击显示。

- [ ] **Step 1: 写真实按钮、客户端和管理员界面的失败测试**

测试必须先覆盖：已发布 Windows 链接点击只发出一次 `POST /official-downloads/windows/click` 且请求体为 `{}`、`keepalive: true`、`credentials: 'omit'`；链接 `href` 未改变、事件未被阻止；同步抛错、网络拒绝和 429/500 后链接仍可继续。管理员客户端必须请求 `/admin/metrics/official-windows-download` 并携带现有管理员头；工作台显示服务端累计值及其近似含义，读取失败只显示不可用且审核队列仍存在。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
pnpm.cmd --filter @myself/website test -- official-download-click.test.tsx official-download-metric-client.test.ts admin-api-client.test.ts admin-app.test.tsx
```

Expected: 因点击上报模块、管理员方法和界面指标缺失而失败。

- [ ] **Step 3: 写最小 GREEN 实现**

链接保持普通 `<a href={activePlatform.downloadUrl}>`；仅增加非等待处理：

```ts
onClick={() => {
  if (activePlatform.id === 'windows-x64') {
    recordOfficialDownloadClick();
  }
}}
```

`recordOfficialDownloadClick()` 自身吞掉同步和异步辅助错误，内部不重试、不持久化。管理员工作台登录成功后读取一次指标；用单独状态保存 `clickCount`，退出、403 和卸载时清除或中止迟到请求。不得把指标并入公开下载内容或公开 DTO。

- [ ] **Step 4: 运行 GREEN、网站构建与回归**

Run:

```powershell
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website typecheck
pnpm.cmd --filter @myself/website build
```

Expected: 全部通过；未发布发行清单仍不渲染真实下载链接。

- [ ] **Step 5: 自审、`git diff --check` 并提交**

```powershell
git diff --check
git add apps/website
git commit -m "feat(web): 在管理员模式显示官方下载点击"
```

完成标准：真实安装包链接保持原生下载语义，辅助统计失败不影响下载，累计值只在管理员工作台出现。

---

### Task 3: 全链合同、范围与验收收敛

**Files:**

- Modify: `tests/memory-website-api.mjs`
- Modify: `tests/website-contract/website-api-contract.ts`
- Modify: `tests/website-contract/production-driver.test.ts`
- Modify: `tests/e2e/website.spec.ts`
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `tools/verification/web-chain-catalog.mjs`
- Modify: `tools/verification/web-chain-catalog.test.mjs`
- Modify: `docs/operations/cloudbase-deployment.md`
- Modify: `docs/operations/website-stage-2c-zero-cost-manual-review-acceptance.md`
- Modify: `docs/superpowers/plans/2026-09-01-website-stage-2c-zero-cost-manual-review.md`

**Interfaces:**

- Consumes: Task 1–2 的端点、schema、UI 和第 16 条 migration。
- Produces: Memory/生产合同一致、管理员 E2E 可见、公开 DTO 不泄露、范围门允许精确文件、阶段 2C 远端计划按 16 条迁移继续。

- [ ] **Step 1: 写失败的全链合同与范围测试**

合同必须证明：公开点击响应没有累计值；管理员指标端点返回累计值；无管理员令牌被拒绝；公开社区、反馈和静态页面均不含 `officialDownloadCount`。E2E 使用 Memory API 点击两次并只在管理员工作台看到 `2`。范围门仅放行本规格、计划、migration 和精确网站链文件。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
pnpm.cmd test:website-contract
pnpm.cmd test:e2e:website
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
```

Expected: Memory/生产合同、E2E 或范围目录尚未支持新功能而失败。

- [ ] **Step 3: 写最小 GREEN 替身与文档更新**

Memory API 只保存单个非负累计值，公开点击递增但不回传累计值，管理员鉴权端点读取。部署手册加入新 migration、两个端点和管理员 smoke；阶段 2C 验收仍不得把未执行的远端内容写成通过。

- [ ] **Step 4: 运行完整网站链**

Run:

```powershell
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git status --short
```

Expected: 全部返回 0；没有桌宠路径、公开累计值、额外依赖或未解释文件。

- [ ] **Step 5: 提交并发起整功能复审**

```powershell
git add tests tools/verification docs/operations docs/superpowers/specs/2026-09-01-website-official-download-counter-design.md docs/superpowers/plans/2026-09-01-website-official-download-counter.md docs/superpowers/plans/2026-09-01-website-stage-2c-zero-cost-manual-review.md
git commit -m "test(web): 闭合官方下载计数全链"
```

完成标准：三个任务逐项复审通过，完整网站链为绿；随后回到阶段 2C Task 8，先在上海免费环境预览并顺序执行 16 条 migration。
