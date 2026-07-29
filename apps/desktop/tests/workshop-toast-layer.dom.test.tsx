// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  WorkshopToastLayer,
  toastDurationMs
} from '../src/renderer/src/characters/workshop/WorkshopToastLayer';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('工作台右上角临时提示层', () => {
  test('仅渲染队首，并在成功提示完整经过三秒后关闭', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();

    render(
      <WorkshopToastLayer
        queue={[
          { id: 'first', tone: 'success', text: '已创建。' },
          { id: 'second', tone: 'error', text: '保存失败。' }
        ]}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('已创建。')).not.toBeNull();
    expect(screen.queryByText('保存失败。')).toBeNull();
    expect(toastDurationMs('success')).toBe(3000);
    expect(toastDurationMs('info')).toBe(3000);
    expect(toastDurationMs('warning')).toBe(6000);
    expect(toastDurationMs('error')).toBe(6000);

    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('first');
  });

  test('hover 与焦点必须同时解除才从剩余时间继续计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    render(
      <WorkshopToastLayer
        queue={[{ id: 'warning', tone: 'warning', text: '请确认。' }]}
        onDismiss={onDismiss}
      />
    );
    const toast = screen.getByRole('alert');
    const close = screen.getByRole('button', { name: '关闭提示：请确认。' });

    await vi.advanceTimersByTimeAsync(2000);
    fireEvent.mouseEnter(toast);
    fireEvent.focus(close);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(close, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(3999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('warning');
  });

  test('手动关闭和卸载会清理计时器，关闭回调抛错不会重复调用', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn(() => {
      throw new Error('关闭失败');
    });
    const view = render(
      <WorkshopToastLayer
        queue={[{ id: 'manual', tone: 'info', text: '已取消。' }]}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭提示：已取消。' }));
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('manual');
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).toHaveBeenCalledOnce();

    view.unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test('队首 ID 切换会清理旧 timer，下一条从完整时长开始', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = render(
      <WorkshopToastLayer
        queue={[{ id: 'old', tone: 'error', text: '旧提示。' }]}
        onDismiss={onDismiss}
      />
    );

    await vi.advanceTimersByTimeAsync(2000);
    view.rerender(
      <WorkshopToastLayer
        queue={[{ id: 'next', tone: 'success', text: '新提示。' }]}
        onDismiss={onDismiss}
      />
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('next');
  });

  test.each([
    ['hover', (toast: HTMLElement) => fireEvent.mouseEnter(toast), (toast: HTMLElement) => fireEvent.mouseLeave(toast)],
    ['focus', (_toast: HTMLElement, close: HTMLElement) => fireEvent.focus(close), (_toast: HTMLElement, close: HTMLElement) => fireEvent.blur(close, { relatedTarget: document.body })]
  ] as const)('仅 %s 时也从剩余时间恢复', async (_name, pause, resume) => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    render(
      <WorkshopToastLayer
        queue={[{ id: 'single', tone: 'info', text: '单独暂停。' }]}
        onDismiss={onDismiss}
      />
    );
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭提示：单独暂停。' });

    await vi.advanceTimersByTimeAsync(1000);
    pause(toast, close);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDismiss).not.toHaveBeenCalled();
    resume(toast, close);
    await vi.advanceTimersByTimeAsync(1999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('single');
  });

  test('焦点在 toast 内部移动不会恢复计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    render(
      <WorkshopToastLayer
        queue={[{ id: 'inside', tone: 'info', text: '内部焦点。' }]}
        onDismiss={onDismiss}
      />
    );
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭提示：内部焦点。' });

    fireEvent.focus(toast);
    fireEvent.blur(toast, { relatedTarget: close });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(toast, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('inside');
  });

  test('同一 ID 更换关闭回调时保留剩余时长并调用新回调', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const oldDismiss = vi.fn();
    const latestDismiss = vi.fn();
    const queue = [{ id: 'same', tone: 'success' as const, text: '同一条。' }];
    const view = render(<WorkshopToastLayer queue={queue} onDismiss={oldDismiss} />);

    await vi.advanceTimersByTimeAsync(1000);
    view.rerender(<WorkshopToastLayer queue={queue} onDismiss={latestDismiss} />);
    await vi.advanceTimersByTimeAsync(1999);
    expect(latestDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(oldDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledExactlyOnceWith('same');
  });

  test('timer 句柄为 0 时 hover 会清理 timer 并从剩余时长恢复', () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let nowValue = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => nowValue);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      scheduled.push({ callback: callback as () => void, delay: Number(delay) });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const onDismiss = vi.fn();
    render(
      <WorkshopToastLayer
        queue={[{ id: 'zero', tone: 'success', text: '零句柄。' }]}
        onDismiss={onDismiss}
      />
    );

    nowValue = 1000;
    fireEvent.mouseEnter(screen.getByRole('status'));
    fireEvent.mouseLeave(screen.getByRole('status'));

    expect(now).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(scheduled[1]?.delay).toBe(2000);
  });

  test('活跃 timer 卸载后不会触发关闭回调', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = render(
      <WorkshopToastLayer
        queue={[{ id: 'active', tone: 'info', text: '仍在计时。' }]}
        onDismiss={onDismiss}
      />
    );

    view.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
