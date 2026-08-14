/** 阶段 0 的差异基线只能通过获批计划更新，运行时不得替换为当前提交。 */
export const WEBSITE_SCOPE_BASELINE = '0dab17de8863a7c726a5bb5fceff35a1713daad1';

/** 阶段 0 只允许网站验证基础设施及其已批准的规格、计划和验收文档。 */
export const ALLOWED_WEBSITE_SCOPE_PATHS = Object.freeze([
  '.dependency-cruiser.mjs',
  '.dependency-cruiser.web.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'tools/verification/**',
  'docs/operations/website-chain-verification.md',
  'docs/operations/website-chain-verification-acceptance.md',
  'docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md',
  'docs/superpowers/plans/2026-08-15-website-verification-foundation.md',
  'docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md',
  'docs/superpowers/plans/2026-08-15-website-cloudbase-scanner-reliability.md',
  'docs/superpowers/plans/2026-08-15-website-http-contract-closure.md',
  'docs/superpowers/plans/2026-08-15-website-optimization-index.md',
]);

/** 桌宠、Agent、角色及其根测试始终优先拒绝，即使未来误入白名单也不放行。 */
export const FORBIDDEN_WEBSITE_SCOPE_PATHS = Object.freeze([
  'apps/desktop/**',
  'packages/agent-core/**',
  'packages/file-tools/**',
  'packages/character-runtime/**',
  'packages/character-assets/**',
  'tests/e2e/desktop.spec.ts',
  'tests/e2e/agent-mcp-flow.spec.ts',
  'tests/integration/**',
  'tests/security/**',
  'tests/fixtures/**',
  'tests/playwright.config.ts',
  'tests/vitest.config.ts',
  'vitest.config.ts',
]);

/** 根 manifest 只能新增这些精确的网站链命令，既有脚本不允许改写。 */
export const ALLOWED_ROOT_SCRIPT_CHANGES = Object.freeze({
  'deps:audit:web': 'node tools/verification/run-web-dependency-audit.mjs',
  'verify:web-chain:ownership': 'node tools/verification/verify-web-test-ownership.mjs',
  'verify:web-chain:scope': 'node tools/verification/verify-website-scope.mjs',
  'verify:web-chain:fast': 'node tools/verification/verify-web-chain.mjs --profile fast',
  'verify:web-chain': 'node tools/verification/verify-web-chain.mjs --profile full',
});

/** 依赖审查器使用固定版本，避免范围守卫本身被浮动依赖削弱。 */
export const ALLOWED_ROOT_DEV_DEPENDENCY_CHANGES = Object.freeze({
  'dependency-cruiser': '18.2.0',
});
