import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  resolve: {
    alias: {
      '@myself/shared-types/website-http': resolve(
        import.meta.dirname,
        '../packages/shared-types/src/website-http.ts',
      ),
      '@myself/shared-types': resolve(
        import.meta.dirname,
        '../packages/shared-types/src/index.ts',
      ),
    },
  },
  test: {
    name: 'website-contract',
    include: ['tests/website-contract/*.test.ts'],
    environment: 'node',
  },
});
