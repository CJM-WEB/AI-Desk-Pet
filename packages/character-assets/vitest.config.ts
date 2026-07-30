import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'character-assets',
    include: ['tests/**/*.test.ts']
  }
});
