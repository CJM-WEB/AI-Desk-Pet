import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const WEBSITE_E2E_ITEM_TIMEOUT_MS = 90_000;
export const WEBSITE_E2E_TOTAL_TIMEOUT_MS = 900_000;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export const WEBSITE_E2E_OUTPUT_ROOT = resolve(
  repositoryRoot,
  'tests/.playwright-output/website-process-isolation',
);

const TEST_DESCRIPTION = /^\S.+:\d+:\d+\s+›\s+.+$/u;
const TOTAL_LINE = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?$/u;

export function parseWebsiteTestList(output) {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const start = lines.indexOf('Listing tests:');
  if (start < 0) throw new Error('无法解析网站 E2E 清单：缺少 Listing tests 标题');

  const totalIndex = lines.findIndex((line, index) => index > start && TOTAL_LINE.test(line));
  if (totalIndex < 0) throw new Error('无法解析网站 E2E 清单：缺少 Total 汇总');

  const descriptions = lines.slice(start + 1, totalIndex);
  const malformed = descriptions.find(line => !TEST_DESCRIPTION.test(line));
  if (malformed) throw new Error(`无法解析网站 E2E 测试描述：${malformed}`);
  if (descriptions.length === 0) throw new Error('没有发现网站 E2E 测试');
  if (new Set(descriptions).size !== descriptions.length) throw new Error('网站 E2E 清单包含重复测试描述');

  const expectedCount = Number(TOTAL_LINE.exec(lines[totalIndex])?.[1]);
  if (expectedCount !== descriptions.length) {
    throw new Error(`网站 E2E 清单总数不一致：发现 ${descriptions.length}，汇总 ${expectedCount}`);
  }
  return Object.freeze([...descriptions]);
}

// 单项运行交由 Playwright 官方 test-list 精确选择，不转换标题为正则；独立产物目录避免进程间覆盖。
export function createWebsiteTestInvocation({ testListPath, outputDirectory }) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      resolve(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'tests/playwright.website.config.ts',
      '--test-list',
      testListPath,
      '--output',
      outputDirectory,
    ]),
    env: Object.freeze({ ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }),
  });
}
