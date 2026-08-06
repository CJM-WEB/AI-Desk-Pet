// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWebsiteController } from '../components/website-experience/use-website-controller';

function createMediaQueryList(matches = false): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  };
}

function installAnimationFrameTimers() {
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => window.setTimeout(
      () => callback(performance.now()),
      16
    ));
  vi.spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((frameId) => window.clearTimeout(frameId));
  return requestFrame;
}

function ControllerHarness({
  staticFallback
}: {
  staticFallback: boolean;
}) {
  const controller = useWebsiteController({
    chapterCount: 6,
    staticFallback
  });

  return (
    <div
      data-testid="controller-state"
      data-phase={controller.phase}
      data-paused={controller.isPaused}
      data-index={controller.settledIndex}
      data-progress={controller.progress.toFixed(4)}
    >
      <button type="button" onClick={() => controller.goToAdjacent(1)}>
        下一章节
      </button>
    </div>
  );
}

describe('官网章节控制器', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('普通鼠标滚轮按实际滚动量连续改变章节进度且不自动吸附', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    for (let index = 0; index < 5; index += 1) {
      fireEvent.wheel(window, { deltaY: 120 });
      act(() => {
        vi.advanceTimersByTime(70);
      });
    }

    expect(state.dataset.index).toBe('0');
    expect(Number(state.dataset.progress)).toBeGreaterThan(0.5);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(state.dataset.index).toBe('0');
    expect(Number(state.dataset.progress)).toBeCloseTo(0.66, 2);

    fireEvent.wheel(window, { deltaY: 400 });
    expect(state.dataset.index).toBe('1');
    expect(state.dataset.progress).toBe('1.0000');
  });

  it('单个微小滚轮最终返回原章且快速巨大输入只前进相邻一章', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    fireEvent.wheel(window, { deltaY: 24 });
    expect(state.dataset.index).toBe('0');
    expect(Number(state.dataset.progress)).toBeCloseTo(0.0264, 3);

    for (let index = 0; index < 3; index += 1) {
      fireEvent.wheel(window, { deltaY: 50_000 });
      act(() => {
        vi.advanceTimersByTime(20);
      });
    }
    expect(state.dataset.index).toBe('3');
    expect(state.dataset.progress).toBe('3.0000');
  });

  it('首页边界键打断向下滚轮后回到当前章节且稳定边界不启动动画', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    const requestFrame = installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    requestFrame.mockClear();

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(requestFrame).not.toHaveBeenCalled();

    fireEvent.wheel(window, { deltaY: 120 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(Number(state.dataset.progress)).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: 'PageUp' });
    expect(requestFrame).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(state.dataset.phase).toBe('interactive');
    expect(state.dataset.index).toBe('0');
    expect(state.dataset.progress).toBe('0.0000');
  });

  it('末章边界键打断向上滚轮后回到当前章节且稳定边界不启动动画', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    const requestFrame = installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
      act(() => {
        vi.advanceTimersByTime(400);
      });
    }
    expect(state.dataset.index).toBe('5');
    expect(state.dataset.progress).toBe('5.0000');
    requestFrame.mockClear();

    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(requestFrame).not.toHaveBeenCalled();

    fireEvent.wheel(window, { deltaY: -120 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(Number(state.dataset.progress)).toBeLessThan(5);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(requestFrame).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(state.dataset.phase).toBe('interactive');
    expect(state.dataset.index).toBe('5');
    expect(state.dataset.progress).toBe('5.0000');
  });

  it('初始即为交互态且下一章节只推进一次', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    expect(state.dataset.phase).toBe('interactive');
    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));

    expect(state.dataset.phase).toBe('interactive');
    expect(state.dataset.index).toBe('1');
    expect(state.dataset.progress).toBe('1.0000');
  });

  it('隐藏暂停后进入静态回退会恢复导航并完整清理监听器', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const { rerender } = render(
      <ControllerHarness staticFallback={false} />
    );
    const state = screen.getByTestId('controller-state');

    expect(state.dataset.phase).toBe('interactive');

    visibilityState = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    expect(state.dataset.paused).toBe('true');

    rerender(<ControllerHarness staticFallback />);
    await waitFor(() => {
      expect(state.dataset.paused).toBe('false');
    });

    visibilityState = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));

    expect(state.dataset.index).toBe('1');
    expect(removeWindowListener).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function)
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
  });
});
