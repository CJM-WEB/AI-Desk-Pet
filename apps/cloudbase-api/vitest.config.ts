import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cloudbase-api',
    include: ['tests/**/*.test.ts']
  }
});
