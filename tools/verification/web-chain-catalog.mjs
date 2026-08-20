import { readdirSync } from 'node:fs';

/**
 * 网站验证链中每个可执行步骤的声明结构。
 * @typedef {{ id: string, command: string, args: readonly string[] }} WebChainStep
 */

/** 网站验证链允许审计的输入范围。 */
export const WEB_AUDIT_INPUTS = Object.freeze([
  'apps/website',
  'apps/cloudbase-api',
  'apps/package-scanner',
  'packages/shared-types',
  'tools/release',
  'tools/plan-cloudbase-migrations.mjs',
  'tools/build-cloudbase-functions.mjs',
  'tests/build-website-export.mjs',
  'tests/serve-website-export.mjs',
  'tests/memory-website-api.mjs',
  'tests/e2e/website.spec.ts',
  'tests/playwright.website.config.ts'
]);

/** 每个网站链测试文件必须且只能匹配一个归属。 */
export const WEB_TEST_OWNERS = Object.freeze([
  { id: 'shared-types', pattern: /^packages\/shared-types\/tests\/.*\.test\.ts$/u },
  { id: 'website', pattern: /^apps\/website\/tests\/.*\.test\.tsx?$/u },
  { id: 'cloudbase-api', pattern: /^apps\/cloudbase-api\/tests\/.*\.test\.ts$/u },
  { id: 'package-scanner', pattern: /^apps\/package-scanner\/tests\/.*\.test\.ts$/u },
  { id: 'release-tools', pattern: /^tools\/release\/tests\/.*\.test\.ts$/u },
  { id: 'root-cloudbase-tools', pattern: /^tools\/(plan-cloudbase-migrations|build-cloudbase-functions)\.test\.mjs$/u },
  { id: 'website-e2e', pattern: /^tests\/e2e\/website\.spec\.ts$/u },
  { id: 'website-verification', pattern: /^tools\/verification\/.*\.test\.mjs$/u }
]);

/** Node 侧展开并排序验证测试，避免把通配符交给平台 shell 解释。 */
const verificationTests = readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => `tools/verification/${entry.name}`)
  .sort();

/** 冻结步骤及参数，防止运行期间改写已批准命令。 */
function defineStep(id, command, args) {
  return Object.freeze({ id, command, args: Object.freeze(args) });
}

const fastSteps = Object.freeze([
  defineStep('scope', process.execPath, ['tools/verification/verify-website-scope.mjs']),
  defineStep('ownership', process.execPath, ['tools/verification/verify-web-test-ownership.mjs']),
  defineStep('verification-tests', process.execPath, ['--test', ...verificationTests]),
  defineStep('shared-types-typecheck', 'pnpm.cmd', ['--filter', '@myself/shared-types', 'typecheck']),
  defineStep('shared-types-test', 'pnpm.cmd', ['--filter', '@myself/shared-types', 'test']),
  defineStep('website-typecheck', 'pnpm.cmd', ['--filter', '@myself/website', 'typecheck']),
  defineStep('website-test', 'pnpm.cmd', ['--filter', '@myself/website', 'test']),
  defineStep('cloudbase-typecheck', 'pnpm.cmd', ['--filter', '@myself/cloudbase-api', 'typecheck']),
  defineStep('cloudbase-test', 'pnpm.cmd', [
    '--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run',
    '--config', 'vitest.config.ts', '--exclude', 'tests/build-output.test.ts',
  ]),
  defineStep('scanner-typecheck', 'pnpm.cmd', ['--filter', '@myself/package-scanner', 'typecheck']),
  defineStep('scanner-test', 'pnpm.cmd', ['--filter', '@myself/package-scanner', 'test']),
  defineStep('release-typecheck', 'pnpm.cmd', ['--filter', '@myself/release-tools', 'typecheck']),
  defineStep('release-test', 'pnpm.cmd', ['--filter', '@myself/release-tools', 'test']),
  defineStep('migration-tool-test', process.execPath, ['--test', 'tools/plan-cloudbase-migrations.test.mjs']),
  defineStep('dependency-audit', process.execPath, ['tools/verification/run-web-dependency-audit.mjs']),
]);

const fullOnlySteps = Object.freeze([
  defineStep('cloudbase-build', 'pnpm.cmd', ['--filter', '@myself/cloudbase-api', 'build']),
  defineStep('cloudbase-build-output-test', 'pnpm.cmd', [
    '--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run',
    '--config', 'vitest.config.ts', 'tests/build-output.test.ts',
  ]),
  defineStep('cloudbase-build-tool-test', process.execPath, ['--test', 'tools/build-cloudbase-functions.test.mjs']),
  defineStep('scanner-build', 'pnpm.cmd', ['--filter', '@myself/package-scanner', 'build']),
  defineStep('website-e2e', 'pnpm.cmd', ['test:e2e:website']),
]);

/** @type {Readonly<Record<'fast' | 'full', readonly WebChainStep[]>>} */
export const WEB_CHAIN_PROFILES = Object.freeze({
  fast: fastSteps,
  full: Object.freeze([...fastSteps, ...fullOnlySteps]),
});

/** 返回指定网站链 profile；未知 profile 必须失败，不能静默扩大或缩小范围。 */
export function createWebChainSteps(profile) {
  const steps = WEB_CHAIN_PROFILES[profile];
  if (!steps) {
    throw new Error(`不支持的网站链 profile: ${profile ?? '<空>'}`);
  }

  return steps;
}

/** 返回规范化测试路径匹配到的全部归属标识。 */
export function findTestOwners(path) {
  const normalized = path.replaceAll('\\', '/');
  return WEB_TEST_OWNERS.filter(owner => owner.pattern.test(normalized)).map(owner => owner.id);
}
