import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['desktop.spec.ts', 'desktop-settings-layout.spec.ts', 'character-motion-continuity.spec.ts', 'character-event-bindings.spec.ts', 'chat-visual-presentation.spec.ts', 'chat-appearance.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '.playwright-output'
});
