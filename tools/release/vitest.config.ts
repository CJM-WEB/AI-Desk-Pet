import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'release-tools',
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
});
