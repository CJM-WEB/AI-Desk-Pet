// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_POOL } from '../components/home-experience/content-pool';
import { FilePreview } from '../components/home-experience/FilePreview';
import type { FileParticle } from '../components/home-experience/swarm-model';

const particle: FileParticle = {
  id: 'preview-error-particle',
  kind: 'txt',
  preview: CONTENT_POOL.txt[0]!,
  x: 100,
  y: 100,
  width: 120,
  height: 120,
  rotation: 0,
  scale: 1,
  remainingMs: 1_000,
  isHeld: true,
  phase: 'floating'
};

const baseProps = {
  particle,
  pointer: { x: 120, y: 140 },
  anchorRect: null,
  inputMode: 'pointer' as const
};

function createQuickTo(kill: () => void) {
  return Object.assign(vi.fn(), {
    tween: { kill }
  }) as unknown as ReturnType<typeof gsap.quickTo>;
}

describe('文件预览动画异常回退', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('quickTo 初始化异常进入统一回退并上报', () => {
    const onInitializationError = vi.fn();
    vi.spyOn(gsap, 'quickTo').mockImplementation(() => {
      throw new Error('quickTo 初始化失败');
    });

    render(
      <FilePreview
        {...baseProps}
        onInitializationError={onInitializationError}
      />
    );

    expect(onInitializationError).toHaveBeenCalledOnce();
    expect(screen.getByTestId('file-preview').dataset.motionState)
      .toBe('inactive');
  });

  it('gsap.to 初始化异常复用统一回退并上报', () => {
    const onInitializationError = vi.fn();
    vi.spyOn(gsap, 'quickTo').mockImplementation(() => createQuickTo(vi.fn()));
    vi.spyOn(gsap, 'to').mockImplementation(() => {
      throw new Error('gsap.to 初始化失败');
    });

    render(
      <FilePreview
        {...baseProps}
        onInitializationError={onInitializationError}
      />
    );

    expect(onInitializationError).toHaveBeenCalledOnce();
    expect(screen.getByTestId('file-preview').dataset.motionState)
      .toBe('inactive');
  });

  it('依赖更新时 quickTo cleanup 异常进入统一回退并上报', () => {
    const onInitializationError = vi.fn();
    const kill = vi.fn(() => {
      throw new Error('quickTo cleanup 失败');
    });
    vi.spyOn(gsap, 'quickTo').mockImplementation(() => createQuickTo(kill));
    vi.spyOn(gsap, 'to').mockReturnValue({
      kill: vi.fn()
    } as unknown as gsap.core.Tween);

    const { rerender } = render(
      <FilePreview
        {...baseProps}
        reducedMotion={false}
        onInitializationError={onInitializationError}
      />
    );
    onInitializationError.mockClear();

    rerender(
      <FilePreview
        {...baseProps}
        reducedMotion
        onInitializationError={onInitializationError}
      />
    );

    expect(kill).toHaveBeenCalled();
    expect(onInitializationError).toHaveBeenCalledOnce();
    expect(screen.getByTestId('file-preview').dataset.motionState)
      .toBe('inactive');
  });

  it('真正卸载时 cleanup 异常不再触发父级状态回调', () => {
    const onInitializationError = vi.fn();
    const onQuickToStateChange = vi.fn();
    const kill = vi.fn(() => {
      throw new Error('卸载 cleanup 失败');
    });
    vi.spyOn(gsap, 'quickTo').mockImplementation(() => createQuickTo(kill));
    vi.spyOn(gsap, 'to').mockReturnValue({
      kill: vi.fn()
    } as unknown as gsap.core.Tween);
    vi.spyOn(gsap, 'killTweensOf').mockImplementation(() => {});

    const { unmount } = render(
      <FilePreview
        {...baseProps}
        onInitializationError={onInitializationError}
        onQuickToStateChange={onQuickToStateChange}
      />
    );
    onInitializationError.mockClear();
    onQuickToStateChange.mockClear();

    unmount();

    expect(kill).toHaveBeenCalled();
    expect(onInitializationError).not.toHaveBeenCalled();
    expect(onQuickToStateChange).not.toHaveBeenCalled();
  });
});
