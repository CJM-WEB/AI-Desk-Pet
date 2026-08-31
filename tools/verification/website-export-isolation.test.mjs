import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANONICAL_EXPORT_ROOT,
  E2E_EXPORT_DIRECTORY,
  E2E_EXPORT_ROOT,
  assertCanonicalExportClean
} from './website-export-isolation.mjs';

const E2E_EXPORT_ENV = 'AI_PET_WEBSITE_E2E_EXPORT_DIRECTORY';

async function loadNextConfig(exportDirectory) {
  const previous = process.env[E2E_EXPORT_ENV];
  try {
    if (exportDirectory === undefined) delete process.env[E2E_EXPORT_ENV];
    else process.env[E2E_EXPORT_ENV] = exportDirectory;
    const url = new URL('../../apps/website/next.config.ts', import.meta.url);
    url.searchParams.set('case', `${exportDirectory ?? 'production'}-${Date.now()}-${Math.random()}`);
    return (await import(url.href)).default;
  } finally {
    if (previous === undefined) delete process.env[E2E_EXPORT_ENV];
    else process.env[E2E_EXPORT_ENV] = previous;
  }
}

test('普通构建保留 canonical out，E2E 构建选择明确的独立目录', async () => {
  const productionConfig = await loadNextConfig(undefined);
  const e2eConfig = await loadNextConfig(E2E_EXPORT_DIRECTORY);

  assert.equal(productionConfig.distDir, undefined);
  assert.equal(e2eConfig.distDir, E2E_EXPORT_DIRECTORY);
  assert.notEqual(CANONICAL_EXPORT_ROOT, E2E_EXPORT_ROOT);
});

test('canonical out 不得包含 E2E 管理员测试令牌', async () => {
  await assertCanonicalExportClean();
});
