import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'desktop',
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
});
