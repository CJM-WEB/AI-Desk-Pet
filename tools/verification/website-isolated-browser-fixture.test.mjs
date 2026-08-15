import assert from 'node:assert/strict';
import test from 'node:test';

import { devices } from '@playwright/test';

import {
  WEBSITE_BROWSER_CONTEXT_OPTIONS,
  useIsolatedBrowser,
  useIsolatedPage,
} from '../../tests/website-isolated-browser-fixture.ts';

test('每次调用都启动并关闭独立浏览器，且保留既有启动参数', async () => {
  const events = [];
  const browser = {
    async close() {
      events.push('browser.close');
    },
  };
  const browserType = {
    async launch(options) {
      events.push(['browser.launch', options]);
      return browser;
    },
  };

  await useIsolatedBrowser(
    {
      browserType,
      headless: true,
      launchOptions: { args: ['--disable-dev-shm-usage'] },
    },
    async (actualBrowser) => {
      assert.equal(actualBrowser, browser);
      events.push('use.browser');
    },
  );

  assert.deepEqual(events, [
    ['browser.launch', { args: ['--disable-dev-shm-usage'], headless: true }],
    'use.browser',
    'browser.close',
  ]);
});

test('页面成功时丢弃追踪，并按 tracing、context 顺序清理', async () => {
  const events = [];
  const page = { name: 'isolated-page' };
  const context = {
    tracing: {
      async start(options) {
        events.push(['tracing.start', options]);
      },
      async stop(options) {
        events.push(['tracing.stop', options]);
      },
    },
    async newPage() {
      events.push('context.newPage');
      return page;
    },
    async close() {
      events.push('context.close');
    },
  };
  const browser = {
    async newContext(options) {
      events.push(['browser.newContext', options]);
      return context;
    },
  };
  const testInfo = {
    status: 'passed',
    expectedStatus: 'passed',
    outputPath() {
      throw new Error('成功测试不应写入 trace 文件');
    },
    attach() {
      throw new Error('成功测试不应附加 trace');
    },
  };

  await useIsolatedPage(
    { browser, baseURL: 'http://127.0.0.1:43125', testInfo },
    async (actualPage) => {
      assert.equal(actualPage, page);
      events.push('use.page');
    },
  );

  const desktopChrome = devices['Desktop Chrome'];
  assert.deepEqual(WEBSITE_BROWSER_CONTEXT_OPTIONS, {
    userAgent: desktopChrome.userAgent,
    viewport: desktopChrome.viewport,
    screen: desktopChrome.screen,
    deviceScaleFactor: desktopChrome.deviceScaleFactor,
    isMobile: desktopChrome.isMobile,
    hasTouch: desktopChrome.hasTouch,
    locale: 'zh-CN',
  });
  assert.deepEqual(events, [
    ['browser.newContext', {
      ...WEBSITE_BROWSER_CONTEXT_OPTIONS,
      baseURL: 'http://127.0.0.1:43125',
    }],
    ['tracing.start', { screenshots: true, snapshots: true, sources: true }],
    'context.newPage',
    'use.page',
    ['tracing.stop', undefined],
    'context.close',
  ]);
});

test('页面失败时保存并附加追踪后再关闭上下文', async () => {
  const events = [];
  const expectedError = new Error('页面操作失败');
  const tracePath = 'C:/temp/trace.zip';
  const context = {
    tracing: {
      async start(options) {
        events.push(['tracing.start', options]);
      },
      async stop(options) {
        events.push(['tracing.stop', options]);
      },
    },
    async newPage() {
      events.push('context.newPage');
      return { name: 'isolated-page' };
    },
    async close() {
      events.push('context.close');
    },
  };
  const browser = {
    async newContext(options) {
      events.push(['browser.newContext', options]);
      return context;
    },
  };
  const testInfo = {
    status: 'timedOut',
    expectedStatus: 'passed',
    outputPath(name) {
      events.push(['testInfo.outputPath', name]);
      return tracePath;
    },
    async attach(name, options) {
      events.push(['testInfo.attach', name, options]);
    },
  };

  await assert.rejects(
    useIsolatedPage(
      { browser, baseURL: undefined, testInfo },
      async () => {
        events.push('use.page');
        throw expectedError;
      },
    ),
    (error) => error === expectedError,
  );

  assert.deepEqual(events, [
    ['browser.newContext', { ...WEBSITE_BROWSER_CONTEXT_OPTIONS, baseURL: undefined }],
    ['tracing.start', { screenshots: true, snapshots: true, sources: true }],
    'context.newPage',
    'use.page',
    ['testInfo.outputPath', 'trace.zip'],
    ['tracing.stop', { path: tracePath }],
    ['testInfo.attach', 'trace', {
      path: tracePath,
      contentType: 'application/zip',
    }],
    'context.close',
  ]);
});

test('主流程和清理同时失败时保留全部错误证据', async () => {
  const events = [];
  const useError = new Error('页面操作失败');
  const cleanupError = new Error('追踪保存失败');
  const context = {
    tracing: {
      async start() {
        events.push('tracing.start');
      },
      async stop() {
        events.push('tracing.stop');
        throw cleanupError;
      },
    },
    async newPage() {
      events.push('context.newPage');
      return { name: 'isolated-page' };
    },
    async close() {
      events.push('context.close');
    },
  };
  const browser = {
    async newContext() {
      events.push('browser.newContext');
      return context;
    },
  };
  const testInfo = {
    status: 'failed',
    expectedStatus: 'passed',
    outputPath() {
      events.push('testInfo.outputPath');
      return 'C:/temp/trace.zip';
    },
    async attach() {
      events.push('testInfo.attach');
    },
  };

  await assert.rejects(
    useIsolatedPage(
      { browser, baseURL: undefined, testInfo },
      async () => {
        events.push('use.page');
        throw useError;
      },
    ),
    (error) => {
      assert.equal(error.constructor, AggregateError);
      assert.deepEqual(error.errors, [useError, cleanupError]);
      return true;
    },
  );
  assert.deepEqual(events, [
    'browser.newContext',
    'tracing.start',
    'context.newPage',
    'use.page',
    'testInfo.outputPath',
    'tracing.stop',
    'context.close',
  ]);
});
