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
});
