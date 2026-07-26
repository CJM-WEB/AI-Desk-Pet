// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWebsiteController } from '../components/website-experience/use-website-controller';

function createMediaQueryList(): MediaQueryList {
  return {
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  };
}

function ControllerHarness({
  staticFallback
}: {
  staticFallback: boolean;
}) {
  const controller = useWebsiteController({
    chapterCount: 5,
    staticFallback
  });

  return (
    <div
      data-testid="controller-state"
      data-phase={controller.phase}
      data-paused={controller.isPaused}
      data-index={controller.settledIndex}
    >
      <button type="button" onClick={controller.drawingDone}>
        完成绘制
      </button>
      <button type="button" onClick={controller.settled}>
        完成落位
      </button>
      <button type="button" onClick={() => controller.goToAdjacent(1)}>
        下一章节
      </button>
    </div>
  );
}

describe('官网章节控制器静态回退', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    fireEvent.click(screen.getByRole('button', { name: '完成绘制' }));
    fireEvent.click(screen.getByRole('button', { name: '完成落位' }));
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
