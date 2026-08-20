import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEB_AUDIT_INPUTS,
  WEB_CHAIN_PROFILES,
  findTestOwners
} from './web-chain-catalog.mjs';
import { verifyWebTestOwnership } from './verify-web-test-ownership.mjs';

const currentTests = [
  'packages/shared-types/tests/moderation.test.ts',
  'apps/website/tests/api-client.test.ts',
  'apps/cloudbase-api/tests/api.test.ts',
  'apps/package-scanner/tests/server.test.ts',
  'tools/release/tests/generate-manifest.test.ts',
  'tools/cloudbase-migration-inventory.test.mjs',
  'tools/plan-cloudbase-migrations.test.mjs',
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

test('当前网站链测试均恰有一个 owner', async () => {
  await verifyWebTestOwnership(process.cwd());
});
