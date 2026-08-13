import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'package-scanner',
    include: ['tests/**/*.test.ts']
  }
});
