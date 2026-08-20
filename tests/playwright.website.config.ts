import { defineConfig, devices } from '@playwright/test';

// 网站 E2E 由测试 worker 启动隔离端口，避免改变桌面端 Electron 测试配置。
export default defineConfig({
  testDir: './e2e',
  testMatch: 'website.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '.playwright-output/website',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure'
  }
});
