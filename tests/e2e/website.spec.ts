import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

test('官网首页展示信任信息和可验证下载入口', async ({ page }) => {
  const indexPath = resolve(process.cwd(), 'apps/website/out/index.html');
  expect(existsSync(indexPath)).toBe(true);

  await page.goto(pathToFileURL(indexPath).toString());

  await expect(page.getByRole('heading', { name: '住在桌面上的 AI 文件小助手' })).toBeVisible();
  await expect(page.getByText('文件安全由本地控制')).toBeVisible();
  await expect(page.getByRole('heading', { name: '安装帮助' })).toBeVisible();

  const download = page.getByRole('link', { name: '下载 Myself 0.1.0-alpha.1' });
  await expect(page.locator('#download').getByText('未签名测试版；安装前请核对文件名和 SHA-256。')).toBeVisible();
  await expect(download).toHaveAttribute('href', /\.exe$/);
});
