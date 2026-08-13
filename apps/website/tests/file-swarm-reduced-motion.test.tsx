// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSwarm } from '../components/home-experience/FileSwarm';
import { I18nProvider, useI18n } from '../components/i18n/I18nProvider';

function LocaleSwitch() {
  const { setLocale } = useI18n();

  return (
    <button type="button" onClick={() => setLocale('en')}>
      切换到英文
    </button>
  );
}

describe('文件粒子减少动态效果', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
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

  it('语言切换后使用英文实际生成粒子的按钮标签', () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?seed=42');
    render(
      <I18nProvider initialLocale="zh-CN">
        <LocaleSwitch />
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
      </I18nProvider>
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getAllByTestId('file-icon')[0]?.getAttribute('aria-label'))
      .toMatch(/^预览 /);

    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));

    const labels = screen.getAllByTestId('file-icon').map((icon) => (
      icon.getAttribute('aria-label') ?? ''
    ));
    expect(labels.every((label) => /^Preview /.test(label))).toBe(true);
    expect(labels.join(' ')).not.toMatch(/\p{Script=Han}/u);
  });
});
