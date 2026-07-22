import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/shared-types/vitest.config.ts',
      'packages/file-tools/vitest.config.ts',
      'packages/agent-core/vitest.config.ts',
      'packages/character-runtime/vitest.config.ts',
      'apps/desktop/vitest.config.ts',
      { extends: 'tests/vitest.config.ts' }
    ]
  }
});
