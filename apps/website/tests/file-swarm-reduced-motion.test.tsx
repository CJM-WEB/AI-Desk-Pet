// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSwarm } from '../components/home-experience/FileSwarm';

describe('文件粒子减少动态效果', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('切换为减少动态效果时清理已有帧且不再启动坐标循环', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(91);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    const baseProps = {
      running: true,
      generating: true,
      exitProgress: 0,
      pointer: { x: 0, y: 0 },
      isPaused: false,
      maxActive: 10,
      safeZoneRatio: 0.3
    };
    const { rerender } = render(
      <FileSwarm {...baseProps} reducedMotion={false} />
    );

    expect(requestFrame).toHaveBeenCalledTimes(1);
    rerender(<FileSwarm {...baseProps} reducedMotion />);

    expect(cancelFrame).toHaveBeenCalledWith(91);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('减少动态效果下新粒子直接进入可见悬浮阶段', () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?seed=42');
    render(
      <FileSwarm
        running
        generating
        exitProgress={0}
        pointer={{ x: 0, y: 0 }}
        isPaused={false}
        maxActive={10}
        safeZoneRatio={0.3}
        reducedMotion
      />
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const icons = screen.getAllByTestId('file-icon');
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((icon) => icon.dataset.phase === 'floating')).toBe(true);
  });
});
