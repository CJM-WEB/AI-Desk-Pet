/** 阶段 0 的差异基线只能通过获批计划更新，运行时不得替换为当前提交。 */
export const WEBSITE_SCOPE_BASELINE = '0dab17de8863a7c726a5bb5fceff35a1713daad1';

/** 当前网站优化阶段只允许官网业务、验证基础设施及其精确获批文档。 */
export const ALLOWED_WEBSITE_SCOPE_PATHS = Object.freeze([
  '.dependency-cruiser.mjs',
  '.dependency-cruiser.web.mjs',
  'packages/shared-types/package.json',
  'packages/shared-types/src/moderation.ts',
  'packages/shared-types/src/scanner-protocol.ts',
  'packages/shared-types/tests/moderation.test.ts',
  'packages/shared-types/tests/scanner-protocol.test.ts',
  'apps/package-scanner/package.json',
  'apps/package-scanner/README.md',
  'apps/package-scanner/Dockerfile',
  'apps/package-scanner/vite.build.config.ts',
  'apps/package-scanner/src/server.ts',
  'apps/package-scanner/src/request-signature.ts',
  'apps/package-scanner/src/scan-package.ts',
  'apps/package-scanner/tests/server.test.ts',
  'apps/package-scanner/tests/request-signature.test.ts',
  'apps/package-scanner/tests/scan-package.test.ts',
  'apps/package-scanner/tests/dockerfile.test.ts',
  'apps/package-scanner/tests/build-output.test.ts',
  'apps/website/**',
  /** 阶段二沿用 CloudBase 范围，并只为当前任务精确放行 Scanner 与共享协议。 */
  'apps/cloudbase-api/**',
  'cloudbase/migrations/20260815000000_shared_package_publication_guard.sql',
  'cloudbase/migrations/20260831000000_restore_scanned_submission_flow.sql',
  'package.json',
  'pnpm-lock.yaml',
  'tools/verification/**',
  'docs/operations/website-chain-verification.md',
  'docs/operations/website-chain-verification-acceptance.md',
  'docs/operations/content-moderation.md',
  'docs/operations/cloudbase-deployment.md',
  'docs/superpowers/specs/2026-08-15-website-architecture-optimization-and-production-relaunch-design.md',
  'docs/superpowers/plans/2026-08-15-website-verification-foundation.md',
  'docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md',
  'docs/superpowers/plans/2026-08-15-website-cloudbase-scanner-reliability.md',
  'docs/superpowers/plans/2026-08-15-website-http-contract-closure.md',
  'docs/superpowers/plans/2026-08-15-website-optimization-index.md',
  'docs/superpowers/plans/2026-08-15-website-e2e-browser-process-isolation.md',
  'docs/superpowers/plans/2026-08-15-website-e2e-cli-process-isolation.md',
  'docs/superpowers/plans/2026-08-15-website-e2e-worker-isolation.md',
  'docs/superpowers/specs/2026-08-15-website-e2e-browser-process-isolation-design.md',
  'docs/superpowers/specs/2026-08-15-website-e2e-cli-process-isolation-design.md',
  'docs/superpowers/specs/2026-08-15-website-e2e-worker-isolation-design.md',
  'docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md',
  'docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md',
  'docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md',
  'docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md',
  'docs/superpowers/plans/2026-08-21-website-gpu-e2e-responsibility-subtraction.md',
  'docs/superpowers/specs/2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md',
  'docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md',
  'docs/superpowers/specs/2026-08-31-website-stage-2-3-local-closure-design.md',
  'tests/e2e/website.spec.ts',
  'tests/memory-website-api.mjs',
  'tests/playwright.website.config.ts',
  'tools/cloudbase-migration-inventory.mjs',
  'tools/cloudbase-migration-inventory.test.mjs',
  'tools/cloudbase-user-migrations.mjs',
  'tools/cloudbase-user-migrations.test.mjs',
  'tools/cloudbase-user-migration-adapter.mjs',
  'tools/cloudbase-user-migration-adapter.test.mjs',
  'tools/build-cloudbase-functions.mjs',
  'tools/build-cloudbase-functions.test.mjs',
  'tools/plan-cloudbase-migrations.mjs',
  'tools/plan-cloudbase-migrations.test.mjs',
  'tools/test-cloudbase-migrations.mjs',
  'tools/test-cloudbase-migrations.test.mjs',
  /** 仅允许基线中已有的两个文件作为删除差异出现；恢复由退役不变量拒绝。 */
  'tools/apply-cloudbase-migrations.mjs',
  'tools/apply-cloudbase-migrations.test.mjs',
]);

/** 已退役入口即使保留删除差异白名单，也必须始终不存在于当前工作树。 */
export const RETIRED_WEBSITE_SCOPE_PATHS = Object.freeze([
  'tools/apply-cloudbase-migrations.mjs',
  'tools/apply-cloudbase-migrations.test.mjs',
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
  'plan:cloudbase-migrations': 'node tools/plan-cloudbase-migrations.mjs --dry-run',
  'test:cloudbase-tools': 'node --test tools/cloudbase-migration-inventory.test.mjs tools/cloudbase-user-migrations.test.mjs tools/cloudbase-user-migration-adapter.test.mjs tools/plan-cloudbase-migrations.test.mjs tools/build-cloudbase-functions.test.mjs',
  'verify:scanner-candidate': 'node tools/verification/verify-scanner-candidate.mjs',
});

/** 依赖审查器使用固定版本，避免范围守卫本身被浮动依赖削弱。 */
export const ALLOWED_ROOT_DEV_DEPENDENCY_CHANGES = Object.freeze({
  'dependency-cruiser': '18.2.0',
});

/** manager SDK 已成为受控迁移适配器的运行依赖，只允许保持原版本进行分类迁移。 */
export const ALLOWED_ROOT_DEPENDENCY_RELOCATIONS = Object.freeze({
  '@cloudbase/manager-node': '^5.6.5',
});
