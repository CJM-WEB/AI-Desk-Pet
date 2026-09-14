// @vitest-environment jsdom

import { afterEach, expect, test, vi } from 'vitest';
import { waitForRendererReady as wait } from '../src/main/windows/renderer-ready';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

test('已经提交的视图立即就绪', async () => {
  document.body.innerHTML = '<div id="root"><main></main></div>';
  await expect(wait({ executeJavaScript: code => window.eval(code) })).resolves.toBeUndefined();
});

test('空白 Suspense 不允许提前显示，视图提交后释放监听和计时器', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  let ready = false;
  const pending = wait({ executeJavaScript: code => window.eval(code) }).then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);
  document.getElementById('root')!.append(document.createElement('main'));
  await pending;
  expect(ready).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('视图加载失败时有界退出，不永久等待', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const pending = expect(wait({ executeJavaScript: code => window.eval(code) }))
    .rejects.toThrow('RENDERER_READY_TIMEOUT');
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});

test('窗口销毁导致执行上下文失效时向调用者传播失败', async () => {
  await expect(wait({ executeJavaScript: async () => { throw new Error('销毁'); } }))
    .rejects.toThrow('销毁');
});
