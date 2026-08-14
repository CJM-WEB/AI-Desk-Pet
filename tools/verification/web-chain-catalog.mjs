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
  'tools/apply-cloudbase-migrations.mjs',
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
  { id: 'root-cloudbase-tools', pattern: /^tools\/(apply-cloudbase-migrations|build-cloudbase-functions)\.test\.mjs$/u },
  { id: 'website-e2e', pattern: /^tests\/e2e\/website\.spec\.ts$/u },
  { id: 'website-verification', pattern: /^tools\/verification\/.*\.test\.mjs$/u }
]);

/**
 * 此阶段只声明 profile 容器；具体命令由后续任务填入，避免提前扩大验证范围。
 * @type {Readonly<Record<'fast' | 'full', readonly WebChainStep[]>>}
 */
export const WEB_CHAIN_PROFILES = Object.freeze({
  fast: Object.freeze([]),
  full: Object.freeze([])
});

/** 返回规范化测试路径匹配到的全部归属标识。 */
export function findTestOwners(path) {
  const normalized = path.replaceAll('\\', '/');
  return WEB_TEST_OWNERS.filter(owner => owner.pattern.test(normalized)).map(owner => owner.id);
}
