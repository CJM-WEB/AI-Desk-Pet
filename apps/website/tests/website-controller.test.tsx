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

  it('滚轮先更新目标且显示进度通过动画帧连续追赶', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    expect(state.dataset.progress).toBe('0.0000');
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(16); });
    expect(Number(state.dataset.progress)).toBeGreaterThan(0);
    expect(Number(state.dataset.progress)).toBeLessThan(0.132);
  });

  it('减少动态效果时达到新手势阈值后直接稳定到相邻章节', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    const requestFrame = installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    requestFrame.mockClear();
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    expect(state.dataset.progress).toBe('0.0000');

    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });

    expect(state.dataset.index).toBe('1');
    expect(state.dataset.progress).toBe('1.0000');
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('停止 120ms 后用 380ms 吸附并锁住后续 800ms 惯性', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    for (let index = 0; index < 7; index += 1) {
      fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
      act(() => { vi.advanceTimersByTime(16); });
    }
    act(() => { vi.advanceTimersByTime(120 + 400); });
    expect(state.dataset.index).toBe('1');
    expect(state.dataset.progress).toBe('1.0000');

    fireEvent.wheel(window, { deltaY: 600, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(700); });
    expect(state.dataset.index).toBe('1');
    expect(state.dataset.progress).toBe('1.0000');
  });

  it('锁定结束后必须静止并重新累计 240px 才能离开', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.wheel(window, { deltaY: 40, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(220); });

    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(state.dataset.progress).toBe('1.0000');

    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(Number(state.dataset.progress)).toBeGreaterThan(1);
  });

  it('首页越界滚轮不留累计量，反向后仍需重新累计完整阈值', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.wheel(window, { deltaY: -120, deltaMode: 0 });
    }
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(state.dataset.progress).toBe('0.0000');

    fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(Number(state.dataset.progress)).toBeGreaterThan(0);
  });

  it('末页越界滚轮不留累计量，反向后仍需重新累计完整阈值', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList()));
    installAnimationFrameTimers();
    render(<ControllerHarness staticFallback={false} />);
    const state = screen.getByTestId('controller-state');

    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
      act(() => { vi.advanceTimersByTime(400); });
    }
    act(() => { vi.advanceTimersByTime(920); });
    expect(state.dataset.progress).toBe('5.0000');

    for (let index = 0; index < 3; index += 1) {
      fireEvent.wheel(window, { deltaY: 120, deltaMode: 0 });
    }
    fireEvent.wheel(window, { deltaY: -120, deltaMode: 0 });
    fireEvent.wheel(window, { deltaY: -120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(state.dataset.progress).toBe('5.0000');

    fireEvent.wheel(window, { deltaY: -120, deltaMode: 0 });
    act(() => { vi.advanceTimersByTime(32); });
    expect(Number(state.dataset.progress)).toBeLessThan(5);
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
    fireEvent.wheel(window, { deltaY: 120 });
    fireEvent.wheel(window, { deltaY: 120 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(Number(state.dataset.progress)).toBeGreaterThan(0);

    requestFrame.mockClear();
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

    act(() => {
      vi.advanceTimersByTime(800);
    });
    fireEvent.wheel(window, { deltaY: -120 });
    fireEvent.wheel(window, { deltaY: -120 });
    fireEvent.wheel(window, { deltaY: -120 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(Number(state.dataset.progress)).toBeLessThan(5);

    requestFrame.mockClear();
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
