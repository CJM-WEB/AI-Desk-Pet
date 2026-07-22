import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'character-runtime',
    include: ['tests/**/*.test.ts']
  }
});
