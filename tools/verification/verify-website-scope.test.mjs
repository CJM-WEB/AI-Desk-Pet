import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRetiredWebsiteScopePathsAbsent,
  assertRootManifestChange,
  classifyChangedPaths,
} from './verify-website-scope.mjs';

const baseManifest = {
  name: 'myself',
  scripts: {
    'test:e2e:desktop': 'desktop-e2e',
    'verify:behavior': 'behavior',
    'verify:characters': 'characters',
    'verify:desktop': 'desktop',
  },
  devDependencies: {
    typescript: '^5.9.3',
  },
};

test('黑名单优先于白名单', () => {
  assert.deepEqual(classifyChangedPaths([
    'tools/verification/new.mjs',
    'apps/desktop/src/main/index.ts',
    'README.md',
  ]), {
    allowed: ['tools/verification/new.mjs'],
    forbidden: ['apps/desktop/src/main/index.ts'],
    outside: ['README.md'],
  });
});

test('网站 E2E 规格与正式测试保持在网站分支范围内', () => {
  const websiteE2ePaths = [
    'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-cli-process-isolation.md',
    'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
    'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
    'docs/superpowers/specs/2026-08-15-website-e2e-cli-process-isolation-design.md',
    'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
    'tests/e2e/website.spec.ts',
  ];

  assert.deepEqual(classifyChangedPaths(websiteE2ePaths), {
    allowed: websiteE2ePaths,
    forbidden: [],
    outside: [],
  });

  assert.deepEqual(classifyChangedPaths([
    'tests/website-isolated-browser-fixture.ts',
  ]), {
    allowed: [],
    forbidden: [],
    outside: ['tests/website-isolated-browser-fixture.ts'],
  });
});

test('当前网站优化阶段只放行官网业务与精确获批文档', () => {
  const approvedWebsitePaths = [
    'apps/website/components/home-experience/LiquidGlassHome.tsx',
    'apps/website/tests/website-fallback.test.tsx',
    'tests/playwright.website.config.ts',
    'docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md',
    'docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md',
    'docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md',
    'docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md',
    'docs/superpowers/plans/2026-08-21-website-gpu-e2e-responsibility-subtraction.md',
    'docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md',
  ];

  assert.deepEqual(classifyChangedPaths([
    ...approvedWebsitePaths,
    'apps/desktop/src/main/index.ts',
  ]), {
    allowed: approvedWebsitePaths,
    forbidden: ['apps/desktop/src/main/index.ts'],
    outside: [],
  });
});

test('阶段二 ScannerProtocol 只放行共享协议和扫描器路径', () => {
  const approvedStagePaths = [
    'docs/superpowers/specs/2026-08-31-website-stage-2-3-local-closure-design.md',
    'docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md',
    '.dependency-cruiser.mjs',
    '.dependency-cruiser.web.mjs',
    'packages/shared-types/package.json',
    'packages/shared-types/src/scanner-protocol.ts',
    'packages/shared-types/tests/scanner-protocol.test.ts',
    'apps/package-scanner/package.json',
    'apps/package-scanner/README.md',
    'apps/package-scanner/src/server.ts',
    'apps/package-scanner/src/request-signature.ts',
    'apps/package-scanner/src/scan-package.ts',
    'apps/package-scanner/tests/server.test.ts',
    'apps/package-scanner/tests/request-signature.test.ts',
    'apps/package-scanner/tests/scan-package.test.ts',
  ];

  assert.deepEqual(classifyChangedPaths([
    ...approvedStagePaths,
    'tests/website-contract/production-driver.test.ts',
  ]), {
    allowed: approvedStagePaths,
    forbidden: [],
    outside: [
      'tests/website-contract/production-driver.test.ts',
    ],
  });
});

test('阶段二 V3 迁移只额外放行现有 CloudBase 构建工具', () => {
  assert.deepEqual(classifyChangedPaths([
    'tools/build-cloudbase-functions.mjs',
    'tools/build-cloudbase-functions.test.mjs',
    'tools/cloudbase-user-migrations.mjs',
  ]), {
    allowed: [
      'tools/build-cloudbase-functions.mjs',
      'tools/build-cloudbase-functions.test.mjs',
    ],
    forbidden: [],
    outside: ['tools/cloudbase-user-migrations.mjs'],
  });
});

test('阶段一只放行获批的 CloudBase 发布止血路径', () => {
  const phaseOnePaths = [
    'apps/cloudbase-api/src/services/submission-service.ts',
    'cloudbase/migrations/20260815000000_shared_package_publication_guard.sql',
    'docs/operations/content-moderation.md',
    'docs/operations/cloudbase-deployment.md',
    'tools/cloudbase-migration-inventory.mjs',
    'tools/cloudbase-migration-inventory.test.mjs',
    'tools/plan-cloudbase-migrations.mjs',
    'tools/plan-cloudbase-migrations.test.mjs',
  ];

  assert.deepEqual(classifyChangedPaths([
    ...phaseOnePaths,
    'apps/package-scanner/src/index.ts',
    'cloudbase/migrations/20260730000000_moderation.sql',
    'tools/unapproved-cloudbase-tool.mjs',
    'apps/desktop/src/main/index.ts',
    'packages/agent-core/src/index.ts',
  ]), {
    allowed: phaseOnePaths,
    forbidden: [
      'apps/desktop/src/main/index.ts',
      'packages/agent-core/src/index.ts',
    ],
    outside: [
      'apps/package-scanner/src/index.ts',
      'cloudbase/migrations/20260730000000_moderation.sql',
      'tools/unapproved-cloudbase-tool.mjs',
    ],
  });
});

test('已退役迁移写入口即使仍为删除差异白名单也不得恢复到工作树', () => {
  assert.throws(
    () => assertRetiredWebsiteScopePathsAbsent('C:/workspace', path =>
      path.endsWith('tools\\apply-cloudbase-migrations.mjs')),
    /已退役路径不得恢复：tools\/apply-cloudbase-migrations\.mjs/u,
  );
});

test('工作树已删除但 Git 索引仍跟踪退役入口时拒绝范围验证', () => {
  assert.throws(
    () => assertRetiredWebsiteScopePathsAbsent('C:/workspace', () => false, [
      'tools/apply-cloudbase-migrations.test.mjs',
    ]),
    /已退役路径不得恢复：tools\/apply-cloudbase-migrations\.test\.mjs/u,
  );
});

test('根 manifest 只允许增加阶段 0 脚本和 dependency-cruiser', () => {
  const changedDesktop = structuredClone(baseManifest);
  changedDesktop.scripts['verify:desktop'] = 'echo bypass';

  assert.throws(
    () => assertRootManifestChange(baseManifest, changedDesktop),
    /verify:desktop/u,
  );
});

test('根 manifest 拒绝阶段 0 依赖的非精确版本', () => {
  const changedDependency = structuredClone(baseManifest);
  changedDependency.devDependencies['dependency-cruiser'] = '^18.2.0';

  assert.throws(
    () => assertRootManifestChange(baseManifest, changedDependency),
    /dependency-cruiser/u,
  );
});

test('根 manifest 拒绝阶段 0 脚本的错误命令值', () => {
  const changedCommand = structuredClone(baseManifest);
  changedCommand.scripts['verify:web-chain'] = 'echo unexpected-command';

  assert.throws(
    () => assertRootManifestChange(baseManifest, changedCommand),
    /verify:web-chain/u,
  );
});

test('根 manifest 接受全部精确阶段 0 脚本和 dependency-cruiser', () => {
  const allowedChange = structuredClone(baseManifest);
  Object.assign(allowedChange.scripts, {
    'deps:audit:web': 'node tools/verification/run-web-dependency-audit.mjs',
    'verify:web-chain:ownership': 'node tools/verification/verify-web-test-ownership.mjs',
    'verify:web-chain:scope': 'node tools/verification/verify-website-scope.mjs',
    'verify:web-chain:fast': 'node tools/verification/verify-web-chain.mjs --profile fast',
    'verify:web-chain': 'node tools/verification/verify-web-chain.mjs --profile full',
    'plan:cloudbase-migrations': 'node tools/plan-cloudbase-migrations.mjs --dry-run',
    'test:cloudbase-tools': 'node --test tools/cloudbase-migration-inventory.test.mjs tools/plan-cloudbase-migrations.test.mjs tools/build-cloudbase-functions.test.mjs',
  });
  allowedChange.devDependencies['dependency-cruiser'] = '18.2.0';

  assert.doesNotThrow(() => assertRootManifestChange(baseManifest, allowedChange));
});
