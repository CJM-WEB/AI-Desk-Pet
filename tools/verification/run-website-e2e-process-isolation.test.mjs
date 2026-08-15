import assert from 'node:assert/strict';
import test from 'node:test';

import * as runner from './run-website-e2e-process-isolation.mjs';

const listedTests = `Listing tests:
  website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开
  website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互
Total: 2 tests in 1 file\n`;

test('解析 Playwright 标准清单并保留完整中文测试描述', () => {
  assert.deepEqual(runner.parseWebsiteTestList(listedTests), [
    'website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开',
    'website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互',
  ]);
});

test('拒绝空清单、重复描述、畸形行和总数不一致', () => {
  assert.throws(() => runner.parseWebsiteTestList('Listing tests:\nTotal: 0 tests in 0 files\n'), /没有发现网站 E2E/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /重复/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  不是标准测试描述\nTotal: 1 test in 1 file\n`), /无法解析/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /总数/u);
});

test('单项命令只使用网站配置、test-list 和独立输出目录', () => {
  const invocation = runner.createWebsiteTestInvocation({
    testListPath: 'C:\\Temp\\website-e2e\\current.txt',
    outputDirectory: 'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  });

  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [
    'test',
    '--config',
    'tests/playwright.website.config.ts',
    '--test-list',
    'C:\\Temp\\website-e2e\\current.txt',
    '--output',
    'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  ]);
  assert.equal(invocation.args[0].endsWith('node_modules\\@playwright\\test\\cli.js') || invocation.args[0].endsWith('node_modules/@playwright/test/cli.js'), true);
  assert.equal(invocation.args.includes('--grep'), false);
  assert.equal(invocation.args.includes('--shard'), false);
  assert.equal(invocation.args.includes('--pass-with-no-tests'), false);
  assert.equal(invocation.env.NO_COLOR, '1');
  assert.equal(invocation.env.FORCE_COLOR, '0');
  assert.equal(runner.WEBSITE_E2E_ITEM_TIMEOUT_MS, 90_000);
  assert.equal(runner.WEBSITE_E2E_TOTAL_TIMEOUT_MS, 900_000);
});
