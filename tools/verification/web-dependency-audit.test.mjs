import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNNER_PATH = join(REPOSITORY_ROOT, 'tools/verification/run-web-dependency-audit.mjs');
const WEB_CONFIGURATION_PATH = join(REPOSITORY_ROOT, '.dependency-cruiser.web.mjs');

/** 执行命令并保留完整诊断，避免把真实规则失败误判为 JSON 解析问题。 */
function runNode(args, options = {}) {
  const result = runNodeResult(args, options);

  assert.equal(
    result.status,
    0,
    `命令执行失败：node ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

/** 返回子进程结果，供拒绝路径断言退出码与诊断。 */
function runNodeResult(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

/** 从 ESM 入口定位真实 CLI，测试不依赖平台相关的 .bin 包装脚本。 */
function resolveDependencyCruiserCli() {
  return fileURLToPath(
    new URL('../../bin/dependency-cruise.mjs', import.meta.resolve('dependency-cruiser')),
  );
}

/** 创建只覆盖网站链安全边界的最小真实模块图。 */
async function createRuleFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'ai-pet-web-dependency-audit-'));
  const files = {
    'apps/website/lib/cloudbase-client.ts': "import cloudbase from '@cloudbase/js-sdk';\nexport { cloudbase };\n",
    'apps/website/lib/sdk-offender.ts': "import cloudbase from '@cloudbase/js-sdk';\nexport { cloudbase };\n",
    'apps/website/lib/cloud-offender.ts':
      "import { internal } from '../../cloudbase-api/src/internal.ts';\nexport { internal };\n",
    'apps/website/lib/scanner-protocol-offender.ts':
      "import { protocol } from '../../../packages/shared-types/src/scanner-protocol.ts';\nexport { protocol };\n",
    'apps/desktop/src/renderer/scanner-protocol-offender.ts':
      "import { protocol } from '../../../../packages/shared-types/src/scanner-protocol.ts';\nexport { protocol };\n",
    'apps/desktop/src/renderer/website-http-offender.ts':
      "import { contract } from '../../../../packages/shared-types/src/website-http.ts';\nexport { contract };\n",
    'apps/website/lib/migration-target.ts': 'export const website = true;\n',
    'apps/cloudbase-api/src/internal.ts': 'export const internal = true;\nexport const cloud = true;\n',
    'packages/shared-types/src/scanner-protocol.ts': 'export const protocol = true;\n',
    'packages/shared-types/src/website-http.ts': 'export const contract = true;\n',
    'apps/cloudbase-api/src/services/offender.ts':
      "import { runtime } from '../adapters/cloudbase-runtime.ts';\nexport { runtime };\n",
    'apps/cloudbase-api/src/adapters/cloudbase-runtime.ts': 'export const runtime = true;\n',
    'tools/plan-cloudbase-migrations.mjs': "import './migration-bridge.mjs';\n",
    'tools/migration-bridge.mjs':
      "import { cloud } from '../apps/cloudbase-api/src/internal.ts';\nexport { cloud };\n",
    'tools/cloudbase-migration-inventory.mjs': "import './inventory-bridge.mjs';\n",
    'tools/cloudbase-user-migrations.mjs': "import './migration-bridge.mjs';\n",
    'tools/cloudbase-user-migration-adapter.mjs': "import './inventory-bridge.mjs';\n",
    'tools/inventory-bridge.mjs':
      "import { website } from '../apps/website/lib/migration-target.ts';\nexport { website };\n",
    'node_modules/@cloudbase/js-sdk/package.json': JSON.stringify({
      name: '@cloudbase/js-sdk',
      version: '0.0.0-fixture',
      type: 'module',
      exports: './index.js',
    }),
    'node_modules/@cloudbase/js-sdk/index.js': 'export default {};\n',
    'package.json': JSON.stringify({ name: 'dependency-audit-fixture', private: true, type: 'module' }),
  };

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = join(fixtureRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }),
  );

  return fixtureRoot;
}

test('网站链审查仅报告已批准的历史 warning，且不载入桌面模块或规则', () => {
  const stdout = runNode([RUNNER_PATH, '--output-type', 'json']);
  const report = JSON.parse(stdout);

  assert.equal(report.summary.error, 0);
  assert.ok(report.modules.some(module => module.source.startsWith('apps/website/')));
  assert.ok(report.modules.some(module => module.source.startsWith('apps/cloudbase-api/')));
  assert.ok(report.modules.some(module => module.source.startsWith('apps/package-scanner/')));
  assert.equal(report.modules.some(module => module.source.startsWith('apps/desktop/')), false);
  assert.equal(
    report.summary.ruleSetUsed.forbidden.some(rule => /desktop|electron/u.test(rule.name)),
    false,
  );

  const allowedDebt = new Set([
    'no-circular',
    'no-orphan-production-module',
    'website-features-do-not-import-liquid-glass',
  ]);
  assert.ok(report.summary.violations.every(item => allowedDebt.has(item.rule.name)));
  assert.ok(report.summary.violations.length <= 14);
});

test('依赖审查配置不再为已退役迁移入口或管理 SDK 保留例外', async () => {
  const [baseConfiguration, webConfiguration] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, '.dependency-cruiser.mjs'), 'utf8'),
    readFile(WEB_CONFIGURATION_PATH, 'utf8'),
  ]);
  const serialized = `${baseConfiguration}\n${webConfiguration}`;

  const retiredTerms = [
    'apply-cloudbase-migrations',
    '@cloudbase/' + 'manager-node',
    'migration-production-to-dev-dependency',
  ];

  assert.doesNotMatch(serialized, new RegExp(retiredTerms.join('|'), 'u'));

  const configuration = (await import(`${new URL('../../.dependency-cruiser.mjs', import.meta.url)}?test=${Date.now()}`)).default;
  const migrationToolRule = configuration.forbidden.find(
    rule => rule.name === 'migration-planning-tools-do-not-import-web-or-cloud-source',
  );
  assert.equal(
    migrationToolRule?.from.path,
    '^tools/(plan-cloudbase-migrations|cloudbase-migration-inventory|cloudbase-user-migrations|cloudbase-user-migration-adapter)\\.mjs$',
  );
});

test('runner 拒绝覆盖配置、输入范围或输出参数契约的调用', async t => {
  const rejectedArguments = [
    ['覆盖配置', ['--config', '.dependency-cruiser.mjs']],
    ['覆盖排除范围', ['--exclude', '.*']],
    ['追加输入', ['apps/desktop']],
    ['未知参数', ['--validate']],
    ['输出类型缺值', ['--output-type']],
    ['输出路径缺值', ['--output-to']],
    ['重复输出类型', ['--output-type', 'json', '--output-type', 'err']],
    ['重复输出路径', ['--output-to', 'first.json', '--output-to', 'second.json']],
  ];

  for (const [name, args] of rejectedArguments) {
    await t.test(name, () => {
      const result = runNodeResult([RUNNER_PATH, ...args]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /网站依赖审查参数/u);
    });
  }
});

test('网站专属规则阻止跨应用、服务反向依赖与越界 SDK 调用', async t => {
  const fixtureRoot = await createRuleFixture();
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  const cliPath = resolveDependencyCruiserCli();
  const result = runNodeResult(
    [
      cliPath,
      '--config',
      WEB_CONFIGURATION_PATH,
      '--output-type',
      'json',
      'apps/website',
      'apps/desktop',
      'apps/cloudbase-api',
      'tools/plan-cloudbase-migrations.mjs',
      'tools/cloudbase-migration-inventory.mjs',
      'tools/cloudbase-user-migrations.mjs',
      'tools/cloudbase-user-migration-adapter.mjs',
    ],
    { cwd: fixtureRoot },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.error, 3);
  const hasViolation = (ruleName, from) =>
    report.summary.violations.some(
      violation => violation.rule.name === ruleName && violation.from === from,
    );

  assert.ok(
    hasViolation(
      'no-website-to-cloud-source',
      'apps/website/lib/cloud-offender.ts',
    ),
  );
  assert.ok(
    hasViolation('cloud-services-stay-inward', 'apps/cloudbase-api/src/services/offender.ts'),
  );
  assert.ok(
    hasViolation('website-cloudbase-sdk-only-in-client-adapter', 'apps/website/lib/sdk-offender.ts'),
  );
  assert.equal(
    hasViolation(
      'website-cloudbase-sdk-only-in-client-adapter',
      'apps/website/lib/cloudbase-client.ts',
    ),
    false,
  );
  for (const offender of [
    'apps/website/lib/scanner-protocol-offender.ts',
    'apps/desktop/src/renderer/scanner-protocol-offender.ts',
  ]) {
    assert.ok(
      hasViolation('scanner-protocol-only-in-server-chain', offender),
      offender,
    );
  }
  assert.ok(
    hasViolation(
      'website-http-only-in-web-chain',
      'apps/desktop/src/renderer/website-http-offender.ts',
    ),
  );
  for (const entryPoint of [
    'tools/plan-cloudbase-migrations.mjs',
    'tools/cloudbase-migration-inventory.mjs',
    'tools/cloudbase-user-migrations.mjs',
    'tools/cloudbase-user-migration-adapter.mjs',
  ]) {
    assert.ok(
      hasViolation('migration-planning-tools-do-not-import-web-or-cloud-source', entryPoint),
      entryPoint,
    );
  }
});
