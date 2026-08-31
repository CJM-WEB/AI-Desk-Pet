import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CANONICAL_EXPORT_ROOT,
  E2E_EXPORT_DIRECTORY,
  E2E_EXPORT_ROOT,
  assertCanonicalExportClean,
  assertE2eExportReady,
  createWebsiteExportBuildFinalizer
} from './website-export-isolation.mjs';

const E2E_BUILD_ENV = 'AI_PET_WEBSITE_E2E_BUILD';
const RETIRED_E2E_EXPORT_ENV = 'AI_PET_WEBSITE_E2E_EXPORT_DIRECTORY';

async function loadNextConfig(buildMode, retiredExportDirectory) {
  const previousBuildMode = process.env[E2E_BUILD_ENV];
  const previousRetiredDirectory = process.env[RETIRED_E2E_EXPORT_ENV];
  try {
    if (buildMode === undefined) delete process.env[E2E_BUILD_ENV];
    else process.env[E2E_BUILD_ENV] = buildMode;
    if (retiredExportDirectory === undefined) delete process.env[RETIRED_E2E_EXPORT_ENV];
    else process.env[RETIRED_E2E_EXPORT_ENV] = retiredExportDirectory;
    const url = new URL('../../apps/website/next.config.ts', import.meta.url);
    url.searchParams.set('case', `${buildMode ?? 'production'}-${Date.now()}-${Math.random()}`);
    return (await import(url.href)).default;
  } finally {
    if (previousBuildMode === undefined) delete process.env[E2E_BUILD_ENV];
    else process.env[E2E_BUILD_ENV] = previousBuildMode;
    if (previousRetiredDirectory === undefined) delete process.env[RETIRED_E2E_EXPORT_ENV];
    else process.env[RETIRED_E2E_EXPORT_ENV] = previousRetiredDirectory;
  }
}

test('普通构建保留 canonical out，精确 E2E 模式选择硬编码独立目录', async () => {
  const productionConfig = await loadNextConfig(undefined);
  const emptyModeConfig = await loadNextConfig('');
  const e2eConfig = await loadNextConfig('1');
  const retiredEnvironmentConfig = await loadNextConfig(undefined, '../..');

  assert.equal(productionConfig.distDir, undefined);
  assert.equal(emptyModeConfig.distDir, undefined);
  assert.equal(e2eConfig.distDir, E2E_EXPORT_DIRECTORY);
  assert.equal(retiredEnvironmentConfig.distDir, undefined);
  assert.notEqual(CANONICAL_EXPORT_ROOT, E2E_EXPORT_ROOT);
});

test('E2E 模式拒绝所有路径值和非精确别名', async t => {
  for (const value of [
    'out',
    '..',
    '../..',
    'C:\\temp\\e2e-out',
    '/tmp/e2e-out',
    '.e2e-out',
    'true'
  ]) {
    await t.test(value, async () => {
      await assert.rejects(loadNextConfig(value), /AI_PET_WEBSITE_E2E_BUILD.*1/u);
    });
  }
});

test('canonical out 不得包含 E2E 管理员测试令牌', async () => {
  await assertCanonicalExportClean();
});

test('canonical 门禁对临时目录中的测试令牌保持敏感', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ai-pet-canonical-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bundle.js'), 'const token = "e2e-admin-session";');

  await assert.rejects(assertCanonicalExportClean(root), /canonical out 含测试认证产物/u);
});

test('E2E 产物缺少测试令牌或 index 时均拒绝', async t => {
  const missingTokenRoot = await mkdtemp(join(tmpdir(), 'ai-pet-e2e-missing-token-'));
  const missingIndexRoot = await mkdtemp(join(tmpdir(), 'ai-pet-e2e-missing-index-'));
  t.after(() => Promise.all([
    rm(missingTokenRoot, { recursive: true, force: true }),
    rm(missingIndexRoot, { recursive: true, force: true })
  ]));
  await writeFile(join(missingTokenRoot, 'index.html'), '<main>没有测试令牌</main>');
  await writeFile(join(missingIndexRoot, 'bundle.js'), 'const token = "e2e-admin-session";');

  await assert.rejects(assertE2eExportReady(missingTokenRoot), /缺失测试认证代码/u);
  await assert.rejects(assertE2eExportReady(missingIndexRoot), /index\.html/u);
});

test('构建终结器先检查 canonical，且只为成功结果检查 E2E 产物', async t => {
  const cases = [
    { name: 'success', outcome: { code: 0, signal: null }, expected: ['canonical', 'e2e', 'exit:0'] },
    { name: 'nonzero', outcome: { code: 7, signal: null }, expected: ['canonical', 'exit:7'] },
    { name: 'signal', outcome: { code: null, signal: 'SIGTERM' }, expected: ['canonical', 'exit:1'] },
    { name: 'spawn error', outcome: { error: new Error('spawn failed') }, expected: ['canonical', 'exit:1'] }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const calls = [];
      const finalize = createWebsiteExportBuildFinalizer({
        assertCanonicalClean: async () => calls.push('canonical'),
        assertE2eReady: async () => calls.push('e2e'),
        reportError: () => {},
        setExitCode: code => calls.push(`exit:${code}`)
      });

      await finalize(entry.outcome);
      assert.deepEqual(calls, entry.expected);
    });
  }
});

test('构建终结器只结算一次并保留原非零退出码', async () => {
  const calls = [];
  const finalize = createWebsiteExportBuildFinalizer({
    assertCanonicalClean: async () => {
      calls.push('canonical');
      throw new Error('canonical polluted');
    },
    assertE2eReady: async () => calls.push('e2e'),
    reportError: message => calls.push(`error:${message}`),
    setExitCode: code => calls.push(`exit:${code}`)
  });

  await finalize({ code: 9, signal: null });
  await finalize({ code: 0, signal: null });

  assert.deepEqual(calls, [
    'canonical',
    'error:canonical polluted',
    'exit:9'
  ]);
});
