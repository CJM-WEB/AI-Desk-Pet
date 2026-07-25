import { defineConfig, devices } from '@playwright/test';

const websiteUrl = 'http://127.0.0.1:4173';

// 网站 E2E 使用独立浏览器服务，避免改变桌面端 Electron 测试配置。
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
    baseURL: websiteUrl,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure'
  }
});
