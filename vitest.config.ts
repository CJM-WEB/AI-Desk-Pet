import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/shared-types/vitest.config.ts',
      'packages/file-tools/vitest.config.ts'
    ]
  }
});
