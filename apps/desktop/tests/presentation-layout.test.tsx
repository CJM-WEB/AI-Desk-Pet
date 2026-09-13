// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { usePresentationLayout } from '../src/renderer/src/chat/use-presentation-layout';
afterEach(cleanup);

test('历史下滑期间仅上报容器实际揭开的区域，系统模糊不能提前铺满', () => {
  const root = document.createElement('main');
  const clipping = document.createElement('div');
  const history = document.createElement('section');
  // jsdom 未把 overflow 简写展开到坐标轴，直接声明与浏览器相同的计算值。
  clipping.style.overflowX = 'hidden'; clipping.style.overflowY = 'hidden';
  history.dataset.presentationRegion = '8'; history.dataset.presentationKind = 'history';
  clipping.append(history); root.append(clipping); document.body.append(root);
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} });
  root.getBoundingClientRect = () => rect(0, 0, 528, 500);
  clipping.getBoundingClientRect = () => rect(24, 18, 480, 80);
  history.getBoundingClientRect = () => rect(24, 18, 480, 360);
  const api = { setLayout: vi.fn().mockResolvedValue(undefined) };
  const hook = renderHook(() => usePresentationLayout({ current: root }, api, 'island', 'open', 'history-opening', vi.fn()));
  expect(api.setLayout.mock.calls[0]![0].regions).toEqual([{ x: 24, y: 18, width: 480, height: 80, radius: 8, kind: 'history' }]);
  hook.unmount(); root.remove();
});
