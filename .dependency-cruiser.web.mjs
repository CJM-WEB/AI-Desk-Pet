import baseConfiguration from './.dependency-cruiser.mjs';

/** 网站链只复用与网站、云端和发布工具边界相关的已校准规则。 */
const WEB_RULE_NAMES = new Set([
  'no-circular',
  'no-unresolved',
  'no-undeclared-package-dependencies',
  'no-undeclared-workspace-alias-character-assets',
  'no-undeclared-workspace-alias-character-runtime',
  'no-undeclared-workspace-alias-shared-types',
  'no-production-to-dev-dependency',
  'no-production-to-test-or-output',
  'no-orphan-production-module',
  'no-package-to-app-tool-or-test',
  'no-app-to-other-app-source-cloudbase-api',
  'no-app-to-other-app-source-package-scanner',
  'no-app-to-other-app-source-website',
  'no-relative-cross-workspace-import-apps-cloudbase-api',
  'no-relative-cross-workspace-import-apps-package-scanner',
  'no-relative-cross-workspace-import-apps-website',
  'no-relative-cross-workspace-import-packages-shared-types',
  'no-relative-cross-workspace-import-tools-release',
  'shared-types-is-foundational',
  'no-internal-source-import-shared-types',
  'no-website-to-cloud-source',
  'no-cloud-to-website-source',
  'cloud-services-stay-inward',
  'cloud-adapters-do-not-depend-on-services',
  'website-lib-does-not-import-ui',
  'website-production-does-not-use-node-core',
  'website-cloudbase-sdk-only-in-client-adapter',
  'cloudbase-node-sdk-only-in-runtime-adapter',
  'tencent-sdk-only-in-content-adapters',
  'website-features-do-not-import-liquid-glass'
]);

export default {
  ...baseConfiguration,
  forbidden: baseConfiguration.forbidden.filter(rule => WEB_RULE_NAMES.has(rule.name)),
  options: {
    ...baseConfiguration.options,
    doNotFollow: {
      path: '(^|/)node_modules/|^packages/(character-assets|character-runtime)/'
    }
  }
};
