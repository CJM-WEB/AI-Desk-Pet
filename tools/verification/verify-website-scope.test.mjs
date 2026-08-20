import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
  });
  allowedChange.devDependencies['dependency-cruiser'] = '18.2.0';

  assert.doesNotThrow(() => assertRootManifestChange(baseManifest, allowedChange));
});
