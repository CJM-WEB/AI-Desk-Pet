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
  'tools/cloudbase-user-migrations.test.mjs',
  'tools/cloudbase-user-migration-adapter.test.mjs',
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

test('合同测试建立前不提前登记目录、owner 或执行步骤', () => {
  const serialized = JSON.stringify({ WEB_AUDIT_INPUTS, WEB_CHAIN_PROFILES });

  assert.doesNotMatch(serialized, /tests\/website-contract|website-contract/u);
  assert.deepEqual(findTestOwners('tests/website-contract/production-driver.test.ts'), []);
});

test('当前网站链测试均恰有一个 owner', async () => {
  await verifyWebTestOwnership(process.cwd());
});

test('迁移编排模块进入依赖审计且测试进入快速门', () => {
  assert.ok(WEB_AUDIT_INPUTS.includes('tools/cloudbase-user-migrations.mjs'));
  assert.ok(WEB_AUDIT_INPUTS.includes('tools/cloudbase-user-migration-adapter.mjs'));
  const migrationStep = WEB_CHAIN_PROFILES.fast.find(step => step.id === 'migration-tool-test');
  assert.ok(migrationStep.args.includes('tools/cloudbase-user-migrations.test.mjs'));
  assert.ok(migrationStep.args.includes('tools/cloudbase-user-migration-adapter.test.mjs'));
  const behaviorStep = WEB_CHAIN_PROFILES.fast.find(
    step => step.id === 'migration-behavior-gate'
  );
  assert.deepEqual(behaviorStep, {
    id: 'migration-behavior-gate',
    command: process.execPath,
    args: ['tools/test-cloudbase-migrations.mjs']
  });
});
