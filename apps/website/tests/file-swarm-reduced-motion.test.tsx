// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSwarm } from '../components/home-experience/FileSwarm';

describe('文件粒子减少动态效果', () => {
  afterEach(() => {
    cleanup();
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
});
