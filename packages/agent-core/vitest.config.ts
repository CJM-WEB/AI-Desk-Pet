import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'agent-core',
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
});
