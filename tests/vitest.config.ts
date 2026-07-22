import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  resolve: {
    alias: {
      '@myself/agent-core': resolve(import.meta.dirname, '../packages/agent-core/src/index.ts'),
      '@myself/file-tools': resolve(import.meta.dirname, '../packages/file-tools/src/index.ts'),
      '@myself/shared-types': resolve(import.meta.dirname, '../packages/shared-types/src/index.ts')
    }
  },
  test: {
    name: 'desktop-integration',
    include: ['tests/{integration,security}/**/*.test.ts'],
    environment: 'node'
  }
});
