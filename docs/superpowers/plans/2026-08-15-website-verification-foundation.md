# 网站链可信验证基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复可复现的 dependency-cruiser 18.2.0 网站链审查，并建立只覆盖 shared-types、website、cloudbase-api、package-scanner、release-tools、根 CloudBase 工具和网站 E2E 的可信验证门。

**Architecture:** 使用审查分支中已经校准的 dependency-cruiser 配置作为事实来源，再派生不包含 desktop/Electron 规则的网站专属配置。声明式目录统一拥有测试、类型检查、构建、E2E、依赖审查和范围守卫；快速门只运行包级检查，完整门追加 CloudBase 函数构建、Scanner 构建和网站 E2E。分支差异守卫以阶段 0 开始前的提交为基线，黑名单优先于白名单，并对根 `package.json` 做语义比较，防止借允许修改根脚本之机改动桌宠门。

**Tech Stack:** Node.js 24.18.0、pnpm 11.9.0、TypeScript 5.9.3、Vitest 3.2.7、Playwright 1.61.1、dependency-cruiser 18.2.0、Node `node:test`、PowerShell。

## Global Constraints

- 目标分支必须为 `WebsiteExtension`；`0dab17de8863a7c726a5bb5fceff35a1713daad1` 固定为阶段 0 审查差异基线，实施前只需确认该提交存在且是当前分支祖先。获批规格、计划及后续阶段 0 小批可以位于其后；若提交不存在或不再是祖先，停止实施并更新规格与本计划，不猜测替代基线。
- dependency-cruiser 必须精确锁定 `18.2.0`，不得使用范围版本。
- 只建立网站链门，不创建、不调用、不修改任何 desktop、Agent、文件工具、角色运行时或角色资产验证门。
- 严禁修改 `apps/desktop/**`、`packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`、`tests/e2e/desktop.spec.ts`、`tests/e2e/agent-mcp-flow.spec.ts`、`tests/integration/**`、`tests/security/**`、`tests/fixtures/**`、`tests/playwright.config.ts`、`tests/vitest.config.ts` 和根 `vitest.config.ts`。
- package-scanner 只验证现有远程协议、构建与运输闭包；不得改变角色包业务语义，也不得读取或修改角色包内部实现。依赖审查对 `packages/character-assets` 与 `packages/character-runtime` 只允许解析公开入口边，不继续遍历。
- 本阶段不修改网站、CloudBase、Scanner、发布或共享契约业务实现；只允许新增验证配置、验证脚本、验证测试、根脚本、锁文件和验收记录。
- 不执行真实数据库迁移、CloudBase 部署、Docker 发布、安装包发布、远端数据修改或外部服务写入。
- 所有新增文档和结构性代码注释使用中文；命令、协议字段、库名和代码标识符保留英文。
- 所有实现任务执行 RED → GREEN；测试必须验证可执行行为，不读取源码文本冒充行为证明。
- Git 只读检查可执行；下列提交步骤仅记录任务边界，只有在用户另行明确授权后才执行，未授权时跳过且不得把任务写成已提交。

---

## 文件职责映射

| 文件 | 动作 | 单一职责 |
| --- | --- | --- |
| `.dependency-cruiser.mjs` | 新建 | 原样恢复审查提交 `640bedb69d0ad3623aabd51b8721a42222efe588` 中已经完成 9/9 行为校准的通用配置；本阶段不把它接成全仓门。 |
| `.dependency-cruiser.web.mjs` | 新建 | 从通用配置筛选网站链规则，停止遍历桌宠与角色包内部实现。 |
| `package.json` | 修改 | 精确增加 dependency-cruiser 依赖与 `deps:audit:web`、`verify:web-chain:*` 脚本；既有 desktop 脚本必须逐字保持。 |
| `pnpm-lock.yaml` | 修改 | 只记录 `dependency-cruiser@18.2.0` 及其锁定传递依赖。 |
| `tools/verification/web-chain-catalog.mjs` | 新建 | 机器可读地声明审查输入、测试 owner、快速门和完整门命令。 |
| `tools/verification/web-chain-catalog.test.mjs` | 新建 | 验证每个网站链测试恰有一个 owner，且目录和命令不包含桌宠目标。 |
| `tools/verification/run-web-dependency-audit.mjs` | 新建 | 通过本地 depcruise 二进制运行网站链审查，并透传 JSON/终端输出参数。 |
| `tools/verification/web-dependency-audit.test.mjs` | 新建 | 验证审查范围、规则、已知 warning 上限和桌宠排除行为。 |
| `tools/verification/website-scope-policy.mjs` | 新建 | 保存阶段 0 基线、允许路径、禁止路径和根 manifest 允许变化键。 |
| `tools/verification/verify-website-scope.mjs` | 新建 | 聚合已提交、暂存、未暂存和未跟踪差异，执行路径与根 manifest 语义守卫及 `git diff --check`。 |
| `tools/verification/verify-website-scope.test.mjs` | 新建 | 用纯输入测试白名单、黑名单优先级和 manifest 变化限制。 |
| `tools/verification/verify-web-test-ownership.mjs` | 新建 | 枚举网站链测试文件，拒绝无 owner 或多 owner 文件。 |
| `tools/verification/verify-web-chain.mjs` | 新建 | 按 catalog 顺序执行 `fast` 或 `full` profile，首个失败立即停止并保留退出码。 |
| `tools/verification/verify-web-chain.test.mjs` | 新建 | 验证 profile 展开顺序、失败短路和不包含 desktop 命令。 |
| `docs/operations/website-chain-verification.md` | 新建 | 记录当前唯一网站链入口、快速/完整门差异、基线参数和外部未验证项。 |
| `docs/operations/website-chain-verification-acceptance.md` | 新建 | 记录本次实际命令、日期、环境、退出码、warning 分类和未覆盖项。 |

## 允许路径与禁止路径

阶段 0 范围守卫的白名单为：

```text
.dependency-cruiser.mjs
.dependency-cruiser.web.mjs
package.json
pnpm-lock.yaml
tools/verification/**
docs/operations/website-chain-verification.md
docs/operations/website-chain-verification-acceptance.md
docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md
docs/superpowers/plans/2026-08-15-website-verification-foundation.md
docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md
docs/superpowers/plans/2026-08-15-website-cloudbase-scanner-reliability.md
docs/superpowers/plans/2026-08-15-website-http-contract-closure.md
docs/superpowers/plans/2026-08-15-website-optimization-index.md
```

黑名单为：

```text
apps/desktop/**
packages/agent-core/**
packages/file-tools/**
packages/character-runtime/**
packages/character-assets/**
tests/e2e/desktop.spec.ts
tests/e2e/agent-mcp-flow.spec.ts
tests/integration/**
tests/security/**
tests/fixtures/**
tests/playwright.config.ts
tests/vitest.config.ts
vitest.config.ts
```

黑名单始终优先；后续阶段要扩大网站白名单时，必须在相应已批准计划中更新 policy，不得把阶段 0 白名单预先放宽为整个仓库。

---

### Task 1: 建立网站链声明式目录与测试归属

**Files:**
- Create: `tools/verification/web-chain-catalog.mjs`
- Create: `tools/verification/web-chain-catalog.test.mjs`
- Create: `tools/verification/verify-web-test-ownership.mjs`

**Interfaces:**
- Consumes: 现有 workspace scripts、`tests/e2e/website.spec.ts`、两个根 `tools/*.test.mjs`。
- Produces: `WEB_AUDIT_INPUTS: readonly string[]`、`WEB_TEST_OWNERS: readonly { id: string; pattern: RegExp }[]`、`WEB_CHAIN_PROFILES: Readonly<Record<'fast' | 'full', readonly WebChainStep[]>>`、`findTestOwners(path: string): string[]`、`verifyWebTestOwnership(root: string): Promise<void>`。

- [ ] **Step 1: 写测试归属 RED**

创建 `web-chain-catalog.test.mjs`，至少包含以下可执行断言：

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEB_AUDIT_INPUTS,
  WEB_CHAIN_PROFILES,
  findTestOwners
} from './web-chain-catalog.mjs';

const currentTests = [
  'packages/shared-types/tests/moderation.test.ts',
  'apps/website/tests/api-client.test.ts',
  'apps/cloudbase-api/tests/api.test.ts',
  'apps/package-scanner/tests/server.test.ts',
  'tools/release/tests/generate-manifest.test.ts',
  'tools/apply-cloudbase-migrations.test.mjs',
  'tools/build-cloudbase-functions.test.mjs',
  'tests/e2e/website.spec.ts',
  'tools/verification/web-chain-catalog.test.mjs'
];

test('网站链代表测试各自只有一个 owner', () => {
  for (const path of currentTests) {
    assert.equal(findTestOwners(path).length, 1, path);
  }
});

test('目录和命令不扫描或执行桌宠目标', () => {
  const serialized = JSON.stringify({ WEB_AUDIT_INPUTS, WEB_CHAIN_PROFILES });
  assert.doesNotMatch(serialized, /apps\/desktop|agent-core|file-tools|character-runtime|character-assets|test:e2e:desktop|verify:desktop/u);
});
```

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run:

```powershell
node --test tools/verification/web-chain-catalog.test.mjs
```

Expected: FAIL，错误为 `ERR_MODULE_NOT_FOUND`，因为 catalog 尚不存在；不得因测试语法错误失败。

- [ ] **Step 3: 实现最小 catalog**

`web-chain-catalog.mjs` 使用以下精确结构；所有注释用中文：

```javascript
export const WEB_AUDIT_INPUTS = Object.freeze([
  'apps/website',
  'apps/cloudbase-api',
  'apps/package-scanner',
  'packages/shared-types',
  'tools/release',
  'tools/apply-cloudbase-migrations.mjs',
  'tools/build-cloudbase-functions.mjs',
  'tests/build-website-export.mjs',
  'tests/serve-website-export.mjs',
  'tests/memory-website-api.mjs',
  'tests/e2e/website.spec.ts',
  'tests/playwright.website.config.ts'
]);

export const WEB_TEST_OWNERS = Object.freeze([
  { id: 'shared-types', pattern: /^packages\/shared-types\/tests\/.*\.test\.ts$/u },
  { id: 'website', pattern: /^apps\/website\/tests\/.*\.test\.tsx?$/u },
  { id: 'cloudbase-api', pattern: /^apps\/cloudbase-api\/tests\/.*\.test\.ts$/u },
  { id: 'package-scanner', pattern: /^apps\/package-scanner\/tests\/.*\.test\.ts$/u },
  { id: 'release-tools', pattern: /^tools\/release\/tests\/.*\.test\.ts$/u },
  { id: 'root-cloudbase-tools', pattern: /^tools\/(apply-cloudbase-migrations|build-cloudbase-functions)\.test\.mjs$/u },
  { id: 'website-e2e', pattern: /^tests\/e2e\/website\.spec\.ts$/u },
  { id: 'website-verification', pattern: /^tools\/verification\/.*\.test\.mjs$/u }
]);

export function findTestOwners(path) {
  const normalized = path.replaceAll('\\', '/');
  return WEB_TEST_OWNERS.filter(owner => owner.pattern.test(normalized)).map(owner => owner.id);
}
```

`verify-web-test-ownership.mjs` 递归枚举上述 owner 根目录中的 `*.test.ts`、`*.test.tsx`、`*.test.mjs` 和精确网站 E2E；任一文件 owner 数不是 1 时打印相对路径和 owner 列表并退出 1。

- [ ] **Step 4: 运行 GREEN**

Run:

```powershell
node --test tools/verification/web-chain-catalog.test.mjs
node tools/verification/verify-web-test-ownership.mjs
```

Expected: 两条命令退出 0；归属枚举得到 shared-types 2、website 41、cloudbase-api 19、package-scanner 5、release-tools 1、根 CloudBase 工具 2、网站 E2E 1，另含本目录新增的 `node:test` 文件且每个恰有一个 owner。

- [ ] **Step 5: 只读复核差异**

Run:

```powershell
git diff -- tools/verification/web-chain-catalog.mjs tools/verification/web-chain-catalog.test.mjs tools/verification/verify-web-test-ownership.mjs
```

Expected: 只出现本任务三个新文件；不删除任何现有测试、Vitest 配置或 Playwright 配置。

**删除条件:** 本任务不删除任何文件。未来测试 owner 迁移时，只有新 owner 已从 `verify:web-chain` 可达且原入口失去独有断言，才可在对应独立计划中删除原入口。

- [ ] **Step 6: 获得用户 Git 写入授权后提交测试归属目录**

```powershell
git add tools/verification/web-chain-catalog.mjs tools/verification/web-chain-catalog.test.mjs tools/verification/verify-web-test-ownership.mjs
git commit -m "test: 建立网站链测试归属目录"
```

---

### Task 2: 精确恢复 dependency-cruiser 18.2.0 与网站链规则

**Files:**
- Create: `.dependency-cruiser.mjs`
- Create: `.dependency-cruiser.web.mjs`
- Create: `tools/verification/run-web-dependency-audit.mjs`
- Create: `tools/verification/web-dependency-audit.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 的 `WEB_AUDIT_INPUTS`；审查提交 `640bedb69d0ad3623aabd51b8721a42222efe588:.dependency-cruiser.mjs`。
- Produces: 根脚本 `deps:audit:web`；命令接口 `node tools/verification/run-web-dependency-audit.mjs [...depcruise args]`；网站规则输出为 dependency-cruiser JSON 或终端 `err` 格式。

- [ ] **Step 1: 写依赖审查 RED**

`web-dependency-audit.test.mjs` 调用 runner 输出 JSON，并断言：

```javascript
assert.equal(report.summary.error, 0);
assert.ok(report.modules.some(module => module.source.startsWith('apps/website/')));
assert.ok(report.modules.some(module => module.source.startsWith('apps/cloudbase-api/')));
assert.ok(report.modules.some(module => module.source.startsWith('apps/package-scanner/')));
assert.equal(report.modules.some(module => module.source.startsWith('apps/desktop/')), false);
assert.equal(report.summary.ruleSetUsed.forbidden.some(rule => /desktop|electron/u.test(rule.name)), false);

const allowedDebt = new Set([
  'no-circular',
  'no-orphan-production-module',
  'website-features-do-not-import-liquid-glass'
]);
assert.ok(report.summary.violations.every(item => allowedDebt.has(item.rule.name)));
assert.ok(report.summary.violations.length <= 14);
```

另加临时 fixture 行为测试：website 导入 cloudbase-api 源码必须命中 `no-website-to-cloud-or-migration-source`；CloudBase service 导入 adapter 必须命中 `cloud-services-stay-inward`；合法 SDK adapter 不告警，越界 SDK 调用方告警。

- [ ] **Step 2: 运行 RED 并确认缺失工具**

Run:

```powershell
node --test tools/verification/web-dependency-audit.test.mjs
```

Expected: FAIL，原因是 runner、配置或本地 `depcruise` 不存在；不得因为已有 14 条历史 warning 失败。

- [ ] **Step 3: 恢复精确依赖和通用配置**

修改根 manifest：

```json
{
  "scripts": {
    "deps:audit:web": "node tools/verification/run-web-dependency-audit.mjs"
  },
  "devDependencies": {
    "dependency-cruiser": "18.2.0"
  }
}
```

现有 scripts 和 devDependencies 全部保留。使用：

```powershell
pnpm.cmd add -Dw dependency-cruiser@18.2.0 --save-exact
```

Expected: `package.json` 为精确版本，锁文件出现 `specifier: 18.2.0` 和 `dependency-cruiser@18.2.0`；不得改变 workspace manifest。

用只读命令取得审查配置，并通过 `apply_patch` 原样建立 `.dependency-cruiser.mjs`：

```powershell
git show 640bedb69d0ad3623aabd51b8721a42222efe588:.dependency-cruiser.mjs
```

不得手工重写或删除该配置中的已校准规则；它只作为审查事实源，不新增根 `deps:audit` 或任何全仓门。

- [ ] **Step 4: 实现网站专属配置和 runner**

`.dependency-cruiser.web.mjs` 导入通用配置，只保留以下具名规则：

```javascript
const WEB_RULE_NAMES = new Set([
  'no-circular',
  'no-unresolved',
  'no-undeclared-package-dependencies',
  'no-undeclared-workspace-alias-character-assets',
  'no-undeclared-workspace-alias-character-runtime',
  'no-undeclared-workspace-alias-shared-types',
  'no-production-to-dev-dependency',
  'no-migration-production-to-dev-dependency',
  'no-production-to-test-or-output',
  'no-orphan-production-module',
  'no-package-to-app-tool-or-test',
  'no-app-to-other-app-source-cloudbase-api',
  'no-app-to-other-app-source-package-scanner',
  'no-app-to-other-app-source-website',
  'no-relative-cross-workspace-import-apps-cloudbase-api',
  'no-relative-cross-workspace-import-apps-package-scanner',
  'no-relative-cross-workspace-import-apps-website',
  'no-relative-cross-workspace-import-packages-shared-types',
  'no-relative-cross-workspace-import-tools-release',
  'shared-types-is-foundational',
  'no-internal-source-import-shared-types',
  'no-website-to-cloud-or-migration-source',
  'no-cloud-to-website-or-migration-source',
  'no-migration-to-website-or-cloud-source',
  'cloud-services-stay-inward',
  'cloud-adapters-do-not-depend-on-services',
  'website-lib-does-not-import-ui',
  'website-production-does-not-use-node-core',
  'website-cloudbase-sdk-only-in-client-adapter',
  'cloudbase-node-sdk-only-in-runtime-adapter',
  'tencent-sdk-only-in-content-adapters',
  'cloudbase-manager-sdk-only-in-migration-adapter',
  'website-features-do-not-import-liquid-glass'
]);

export default {
  ...baseConfiguration,
  forbidden: baseConfiguration.forbidden.filter(rule => WEB_RULE_NAMES.has(rule.name)),
  options: {
    ...baseConfiguration.options,
    doNotFollow: {
      path: '(^|/)node_modules/|^packages/(character-assets|character-runtime)/'
    }
  }
};
```

runner 使用 `process.execPath` 加 dependency-cruiser 的 Node CLI 入口或当前平台本地 `.bin`，参数固定以 `--config .dependency-cruiser.web.mjs` 开始，再接用户输出参数和 `WEB_AUDIT_INPUTS`；不得启用 shell 字符串拼接。

- [ ] **Step 5: 运行 GREEN 和当前快照**

Run:

```powershell
node --test tools/verification/web-dependency-audit.test.mjs
pnpm.cmd deps:audit:web
$auditPath = Join-Path $env:TEMP 'ai-pet-web-dependency-audit.json'
pnpm.cmd deps:audit:web --output-type json --output-to $auditPath
```

Expected: 三条命令退出 0；正式网站链审查只包含已知 `no-circular`、`no-orphan-production-module`、`website-features-do-not-import-liquid-glass` 债务，当前基线不超过 14 条；报告没有 desktop/Electron 规则或 desktop 模块。JSON 只写临时目录，不提交仓库。

- [ ] **Step 6: 验证依赖差异最小**

Run:

```powershell
git diff -- package.json pnpm-lock.yaml .dependency-cruiser.mjs .dependency-cruiser.web.mjs tools/verification/run-web-dependency-audit.mjs tools/verification/web-dependency-audit.test.mjs
```

Expected: manifest 只新增四个阶段 0 根脚本中的本任务脚本和精确依赖；lockfile 只来自精确安装；不修改业务源码。

**删除条件:** 本任务不删除审查规则、不删除当前 warning、不升级 severity。通用 `.dependency-cruiser.mjs` 只有在网站配置不再派生它且存在等价行为证据时才可删除；不得在本阶段删除。

- [ ] **Step 7: 获得用户 Git 写入授权后提交依赖审查基线**

```powershell
git add package.json pnpm-lock.yaml .dependency-cruiser.mjs .dependency-cruiser.web.mjs tools/verification/run-web-dependency-audit.mjs tools/verification/web-dependency-audit.test.mjs
git commit -m "build: 恢复网站链依赖审查"
```

---

### Task 3: 建立分支差异范围守卫

**Files:**
- Create: `tools/verification/website-scope-policy.mjs`
- Create: `tools/verification/verify-website-scope.mjs`
- Create: `tools/verification/verify-website-scope.test.mjs`

**Interfaces:**
- Consumes: 固定基线提交 `0dab17de8863a7c726a5bb5fceff35a1713daad1`、当前 HEAD、index、工作树和未跟踪文件。
- Produces: `classifyChangedPaths(paths): { allowed: string[]; forbidden: string[]; outside: string[] }`、`assertRootManifestChange(baseManifest, currentManifest): void`、CLI `node tools/verification/verify-website-scope.mjs`。

- [ ] **Step 1: 写范围策略 RED**

```javascript
test('黑名单优先于白名单', () => {
  assert.deepEqual(classifyChangedPaths([
    'tools/verification/new.mjs',
    'apps/desktop/src/main/index.ts',
    'README.md'
  ]), {
    allowed: ['tools/verification/new.mjs'],
    forbidden: ['apps/desktop/src/main/index.ts'],
    outside: ['README.md']
  });
});

test('根 manifest 只允许增加阶段 0 脚本和 dependency-cruiser', () => {
  const changedDesktop = structuredClone(baseManifest);
  changedDesktop.scripts['verify:desktop'] = 'echo bypass';
  assert.throws(() => assertRootManifestChange(baseManifest, changedDesktop), /verify:desktop/u);
});
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test tools/verification/verify-website-scope.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现路径与 manifest 双重守卫**

policy 精确导出本计划前述白名单、黑名单、基线提交，以及仅允许新增的根键：

```javascript
export const ALLOWED_ROOT_SCRIPT_CHANGES = Object.freeze({
  'deps:audit:web': 'node tools/verification/run-web-dependency-audit.mjs',
  'verify:web-chain:ownership': 'node tools/verification/verify-web-test-ownership.mjs',
  'verify:web-chain:scope': 'node tools/verification/verify-website-scope.mjs',
  'verify:web-chain:fast': 'node tools/verification/verify-web-chain.mjs --profile fast',
  'verify:web-chain': 'node tools/verification/verify-web-chain.mjs --profile full'
});
export const ALLOWED_ROOT_DEV_DEPENDENCY_CHANGES = Object.freeze({
  'dependency-cruiser': '18.2.0'
});
```

CLI 使用参数数组执行以下只读 Git 查询并合并去重：

```text
git diff --name-only 0dab17de8863a7c726a5bb5fceff35a1713daad1...HEAD
git diff --cached --name-only
git diff --name-only
git ls-files --others --exclude-standard
```

随后读取基线 `package.json` 与当前 `package.json` 做结构化比较，确认所有原有脚本，包括 `verify:desktop`、`verify:behavior`、`verify:characters`、`test:e2e:desktop`，逐字未变。最后运行：

```text
git diff --check 0dab17de8863a7c726a5bb5fceff35a1713daad1...HEAD
git diff --cached --check
git diff --check
```

任一禁止路径、白名单外路径、manifest 越权变化或空白错误均打印精确路径/键并退出 1。

- [ ] **Step 4: 运行 GREEN 和真实范围检查**

Run:

```powershell
node --test tools/verification/verify-website-scope.test.mjs
node tools/verification/verify-website-scope.mjs
```

Expected: 测试退出 0；真实检查仅列出阶段 0 白名单文件并退出 0。若实现过程中出现任何桌宠黑名单差异，必须保持失败并移除越界改动，不得扩大白名单。

**删除条件:** 不删除现有 Git 配置或分支文件。基线只能由新的获批阶段计划更新，禁止运行时自动改成当前 HEAD。

- [ ] **Step 6: 获得用户 Git 写入授权后提交范围守卫**

```powershell
git add tools/verification/verify-website-scope.mjs tools/verification/verify-website-scope.test.mjs
git commit -m "test: 增加网站分支范围守卫"
```

---

### Task 4: 建立快速门与完整 `verify:web-chain`

> **实际状态：2026-08-20 已完成。** 既有隔离方案已删除，当前保持原生 Playwright 入口。实际证据：`node --test tools/verification/verify-web-chain.test.mjs` 为 5/5；范围守卫、快速门和完整门均退出 0；完整门中的网站 E2E 为 16/16。Task 5 的最终固定顺序复跑已另行记录；本结论不延伸为阶段 1 或正式部署通过。

**Files:**
- Modify: `tools/verification/web-chain-catalog.mjs`
- Create: `tools/verification/verify-web-chain.mjs`
- Create: `tools/verification/verify-web-chain.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1—3 的 catalog、ownership、scope 和 `deps:audit:web`。
- Produces: `createWebChainSteps(profile: 'fast' | 'full'): readonly WebChainStep[]`、CLI `node tools/verification/verify-web-chain.mjs --profile fast|full`、根脚本 `verify:web-chain:fast` 与 `verify:web-chain`。

- [x] **Step 1: 写 profile 与失败短路 RED**

测试精确断言：

```javascript
const fastIds = createWebChainSteps('fast').map(step => step.id);
assert.deepEqual(fastIds, [
  'scope', 'ownership', 'verification-tests', 'shared-types-typecheck',
  'shared-types-test', 'website-typecheck', 'website-test',
  'cloudbase-typecheck', 'cloudbase-test', 'scanner-typecheck',
  'scanner-test', 'release-typecheck', 'release-test',
  'migration-tool-test', 'dependency-audit'
]);

const fullIds = createWebChainSteps('full').map(step => step.id);
assert.deepEqual(fullIds.slice(0, fastIds.length), fastIds);
assert.deepEqual(fullIds.slice(fastIds.length), [
  'cloudbase-build', 'cloudbase-build-output-test',
  'cloudbase-build-tool-test', 'scanner-build', 'website-e2e'
]);
assert.doesNotMatch(JSON.stringify(createWebChainSteps('full')), /desktop|agent-core|file-tools|character-runtime|character-assets/u);
```

为执行器注入 fake spawn：第二步返回 17 时，第三步不得执行，CLI 返回 17。

- [x] **Step 2: 运行 RED**

Run:

```powershell
node --test tools/verification/verify-web-chain.test.mjs
```

Expected: FAIL，因为 runner 尚不存在。

- [x] **Step 3: 定义精确命令目录**

catalog 中每步使用可执行文件和参数数组，不使用 shell 长字符串。关键映射：

```javascript
{ id: 'shared-types-typecheck', command: 'pnpm.cmd', args: ['--filter', '@myself/shared-types', 'typecheck'] }
{ id: 'shared-types-test', command: 'pnpm.cmd', args: ['--filter', '@myself/shared-types', 'test'] }
{ id: 'website-typecheck', command: 'pnpm.cmd', args: ['--filter', '@myself/website', 'typecheck'] }
{ id: 'website-test', command: 'pnpm.cmd', args: ['--filter', '@myself/website', 'test'] }
{ id: 'cloudbase-typecheck', command: 'pnpm.cmd', args: ['--filter', '@myself/cloudbase-api', 'typecheck'] }
{ id: 'cloudbase-test', command: 'pnpm.cmd', args: ['--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', '--exclude', 'tests/build-output.test.ts'] }
{ id: 'scanner-typecheck', command: 'pnpm.cmd', args: ['--filter', '@myself/package-scanner', 'typecheck'] }
{ id: 'scanner-test', command: 'pnpm.cmd', args: ['--filter', '@myself/package-scanner', 'test'] }
{ id: 'release-typecheck', command: 'pnpm.cmd', args: ['--filter', '@myself/release-tools', 'typecheck'] }
{ id: 'release-test', command: 'pnpm.cmd', args: ['--filter', '@myself/release-tools', 'test'] }
{ id: 'migration-tool-test', command: process.execPath, args: ['--test', 'tools/apply-cloudbase-migrations.test.mjs'] }
{ id: 'cloudbase-build', command: 'pnpm.cmd', args: ['--filter', '@myself/cloudbase-api', 'build'] }
{ id: 'cloudbase-build-output-test', command: 'pnpm.cmd', args: ['--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'tests/build-output.test.ts'] }
{ id: 'cloudbase-build-tool-test', command: process.execPath, args: ['--test', 'tools/build-cloudbase-functions.test.mjs'] }
{ id: 'scanner-build', command: 'pnpm.cmd', args: ['--filter', '@myself/package-scanner', 'build'] }
{ id: 'website-e2e', command: 'pnpm.cmd', args: ['test:e2e:website'] }
```

`verification-tests` 运行 `node --test tools/verification/*.test.mjs` 时必须由 Node 侧先展开已排序文件列表，不把通配符交给 shell。`website-e2e` 已通过 `tests/build-website-export.mjs` 构建静态网站，因此本阶段不额外再执行一次 `website build`；阶段 5 再统一旧重复构建入口。

- [x] **Step 4: 实现 runner 与根脚本**

runner 开始每步前输出 `[web-chain] START <id>`，成功输出 `[web-chain] PASS <id>`，失败输出稳定的命令 ID 和退出码后立即结束。根 manifest 精确新增：

```json
{
  "verify:web-chain:ownership": "node tools/verification/verify-web-test-ownership.mjs",
  "verify:web-chain:scope": "node tools/verification/verify-website-scope.mjs",
  "verify:web-chain:fast": "node tools/verification/verify-web-chain.mjs --profile fast",
  "verify:web-chain": "node tools/verification/verify-web-chain.mjs --profile full"
}
```

不得让 `verify:web-chain` 调用 `pnpm typecheck`、`pnpm test`、`verify:desktop`、`verify:behavior` 或 `verify:characters`。

- [x] **Step 5: 运行 runner 单元 GREEN**

Run:

```powershell
node --test tools/verification/verify-web-chain.test.mjs
node --test tools/verification/*.test.mjs
```

Expected: 全部 `node:test` 通过；测试证明失败短路和 desktop 命令缺失。

- [x] **Step 6: 运行快速网站链门**

Run:

```powershell
pnpm.cmd verify:web-chain:fast
```

Expected: 退出 0；覆盖 shared-types、website、cloudbase-api（排除依赖 `dist` 的 `build-output.test.ts`）、package-scanner、release-tools 的 test/typecheck，迁移工具 `node:test`，网站依赖审查、归属和范围守卫；不执行构建、产物测试或 E2E。

- [x] **Step 7: 运行完整网站链门**

Run:

```powershell
pnpm.cmd verify:web-chain
```

Expected: 退出 0；在快速门基础上，CloudBase 三函数构建、构建后的 `build-output.test.ts` 及根 `node:test`、Scanner Vite build、网站静态构建与 Playwright E2E 全部通过。没有 Electron 启动、desktop build、desktop E2E、根 integration/security 或角色包测试。

**删除条件:** 本阶段不删除 `verify:website`、`verify:cloudbase` 或现有构建脚本，因为尚未验证所有外部调用方已迁移；它们不再代表完整网站链门。阶段 5 在调用方清单明确后删除或改为唯一入口别名，不保留永久平行权威。

- [x] **Step 8: 获得用户 Git 写入授权后提交网站链门禁**

```powershell
git add package.json tools/verification/web-chain-catalog.mjs tools/verification/verify-web-chain.mjs tools/verification/verify-web-chain.test.mjs
git commit -m "test: 建立完整网站链验证门"
```

---

### Task 5: 写入使用说明与日期化验收记录

> **实际状态：2026-08-20 已完成。** 已写入唯一入口说明和日期化验收记录；最终固定顺序复跑已由主控完成并记录实际结果。Git 写入已获授权，文档尚待本次独立提交。

**Files:**
- Create: `docs/operations/website-chain-verification.md`
- Create: `docs/operations/website-chain-verification-acceptance.md`

**Interfaces:**
- Consumes: Tasks 1—4 的真实命令输出。
- Produces: 网站链当前门的人工入口说明和仅记录实际观察结果的验收证据。

- [x] **Step 1: 协调复用已创建验收记录（RED 不适用）**

先运行以下检查，确认文档尚不存在：

```powershell
$required = @(
  'docs/operations/website-chain-verification.md',
  'docs/operations/website-chain-verification-acceptance.md'
)
$existing = $required | Where-Object { Test-Path -LiteralPath $_ }
if ($existing.Count -ne 0) { throw "RED 前不应已有阶段 0 文档：$($existing -join ', ')" }
```

实际处理：`website-chain-verification-acceptance.md` 已由获批的网站 E2E 减法任务先创建，因此未虚构“文件不存在”的 RED 结果；已按本步骤要求协调复用既有验收记录，并新增本任务的唯一入口说明。

- [x] **Step 2: 编写唯一入口说明**

`website-chain-verification.md` 必须明确：

- `pnpm.cmd verify:web-chain:fast` 是日常快速包级门；
- `pnpm.cmd verify:web-chain` 是当前唯一完整网站链门；
- `deps:audit:web` 只扫描网站链，不表示全仓或桌宠通过；
- 完整门覆盖 Scanner build、release-tools、两个根 CloudBase `node:test` 和网站 E2E；
- 当前历史 warning 只允许减少，不作为业务通过证明；
- CloudBase 真实数据库、Bucket、函数、Scanner 镜像、域名、CORS/CSP、OTP、告警、备份与发布均为“不在本次范围”；
- 范围基线为 `0dab17de8863a7c726a5bb5fceff35a1713daad1`，变更需新计划批准。

- [x] **Step 3: 运行最终验证并填写验收记录**

按顺序实际执行：

```powershell
node --test tools/verification/*.test.mjs
pnpm.cmd deps:audit:web
pnpm.cmd verify:web-chain:fast
pnpm.cmd verify:web-chain
node tools/verification/verify-website-scope.mjs
git diff --check
git status --short --branch
```

`website-chain-verification-acceptance.md` 对每条命令记录实际执行日期（本次为 `2026-08-20`）、Windows/Node/pnpm 版本、退出码、关键计数和实际结果。失败必须写“失败”，未运行必须写“未运行”；不得复制规格中的预期值冒充观察结果。

- [x] **Step 4: 最终范围与删除复核**

Run:

```powershell
git diff --name-only 0dab17de8863a7c726a5bb5fceff35a1713daad1...HEAD
git diff --name-only
git ls-files --others --exclude-standard
```

Expected: 合并后的文件集合全部位于阶段 0 白名单；桌宠黑名单零命中。确认本阶段没有删除业务代码、旧网站模块、历史迁移、测试或配置。

**删除条件:** 本任务不删除任何文档或历史验收记录。未来结论变化时新增日期化验收记录，旧记录保留日期和范围，不覆盖为“当前通过”。

- [ ] **Step 5: 获得用户 Git 写入授权后提交阶段 0 文档**

```powershell
git add docs/operations/website-chain-verification.md docs/operations/website-chain-verification-acceptance.md
git commit -m "docs: 记录网站链验证基线"
```

---

## 最终自检

- [x] 规格覆盖：阶段 0 的 dependency-cruiser 18.2.0、网站专属审查、测试归属、快速门、完整门、Scanner build、release-tools、根 `node:test`、网站 E2E、范围守卫和验收记录均有独立任务。
- [x] 类型与接口：`WEB_AUDIT_INPUTS`、`WEB_TEST_OWNERS`、`WEB_CHAIN_PROFILES`、`findTestOwners`、`classifyChangedPaths`、`assertRootManifestChange` 和 profile 名称在所有任务中一致。
- [x] 内容完整：所有步骤均给出精确命令、目标文件、断言和已定义函数，没有留空的实施决策。
- [x] 范围：计划没有创建全仓 `deps:audit`、`verify:all` 或 desktop 门，也没有修改桌宠目录、桌宠脚本和桌宠测试。
- [x] 删除纪律：阶段 0 只新增可信基线，不删除业务路径；旧验证入口的最终收敛有明确后续删除条件。
- [x] 外部边界：没有把本地测试、静态依赖或构建通过写成 CloudBase/生产上线通过。

## 执行交接

实施本计划时优先使用 `subagent-driven-development`，每个 Task 由新的实现子智能体执行，并在进入下一 Task 前完成规格符合性和代码质量双重审查。若改为同一会话执行，必须使用 `executing-plans`，按 Task 设置复核检查点。无论采用哪种方式，Git 写操作仍需用户另行明确授权。
