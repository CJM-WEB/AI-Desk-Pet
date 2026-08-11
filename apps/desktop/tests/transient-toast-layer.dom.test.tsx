// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  TransientToastLayer,
  type TransientToast
} from '../src/renderer/src/components/TransientToastLayer';

const workshopDurationMs = (toast: TransientToast): 3000 | 6000 => (
  toast.tone === 'warning' || toast.tone === 'error' ? 6000 : 3000
);

function renderToastLayer(
  queue: readonly TransientToast[],
  onDismiss: (id: string) => void,
  ariaLabel = '工作台提示'
) {
  return render(
    <TransientToastLayer
      queue={queue}
      onDismiss={onDismiss}
      durationMs={workshopDurationMs}
      ariaLabel={ariaLabel}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('通用瞬时提示层', () => {
  test('仅渲染队首，并在消费者提供的三秒时长结束后关闭', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();

    renderToastLayer([
      { id: 'first', tone: 'success', text: '已创建。' },
      { id: 'second', tone: 'error', text: '保存失败。' }
    ], onDismiss);

    expect(screen.getByLabelText('工作台提示')).not.toBeNull();
    expect(screen.getByText('已创建。')).not.toBeNull();
    expect(screen.queryByText('保存失败。')).toBeNull();
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('first');
  });

  test('将消费者指定的六秒时长用于 warning', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    renderToastLayer([{ id: 'warning', tone: 'warning', text: '请确认。' }], onDismiss);

    await vi.advanceTimersByTimeAsync(5999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('warning');
  });

  test('hover 与焦点必须同时解除才从剩余时间继续计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    renderToastLayer([{ id: 'warning', tone: 'warning', text: '请确认。' }], onDismiss);
    const toast = screen.getByRole('alert');
    const close = screen.getByRole('button', { name: '关闭工作台提示：请确认。' });

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

  test('手动关闭和自动到期最多各消费者回调一次，回调抛错时不重复关闭', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn(() => {
      throw new Error('关闭失败');
    });
    const view = renderToastLayer(
      [{ id: 'manual', tone: 'info', text: '已取消。' }],
      onDismiss
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭工作台提示：已取消。' }));
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
    const view = renderToastLayer(
      [{ id: 'old', tone: 'error', text: '旧提示。' }],
      onDismiss
    );

    await vi.advanceTimersByTimeAsync(2000);
    view.rerender(
      <TransientToastLayer
        queue={[{ id: 'next', tone: 'success', text: '新提示。' }]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('next');
  });

  test('hover 中原位替换 ID 会保持暂停，离开后从新提示完整时长计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = renderToastLayer(
      [{ id: 'old', tone: 'success', text: '旧提示。' }],
      onDismiss
    );
    const toast = screen.getByRole('status');

    fireEvent.mouseEnter(toast);
    view.rerender(
      <TransientToastLayer
        queue={[{ id: 'next', tone: 'success', text: '新提示。' }]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    expect(screen.getByRole('status')).toBe(toast);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('next');
  });

  test('焦点内原位替换 ID 会保持暂停，失焦后恢复新提示计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = renderToastLayer(
      [{ id: 'old', tone: 'success', text: '旧提示。' }],
      onDismiss
    );
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭工作台提示：旧提示。' });

    fireEvent.focus(close);
    view.rerender(
      <TransientToastLayer
        queue={[{ id: 'next', tone: 'success', text: '新提示。' }]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    expect(screen.getByRole('status')).toBe(toast);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(close, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('next');
  });

  test('提示移除到空队列后清空暂停状态，后续提示正常计时', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = renderToastLayer(
      [{ id: 'old', tone: 'success', text: '旧提示。' }],
      onDismiss
    );

    fireEvent.mouseEnter(screen.getByRole('status'));
    view.rerender(
      <TransientToastLayer
        queue={[]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    view.rerender(
      <TransientToastLayer
        queue={[{ id: 'next', tone: 'success', text: '新提示。' }]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
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
  ] as const)('%s 暂停后也从剩余时间恢复', async (_name, pause, resume) => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    renderToastLayer([{ id: 'single', tone: 'info', text: '单独暂停。' }], onDismiss);
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭工作台提示：单独暂停。' });

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

  test('提示内焦点移动不会恢复计时，采用当前 onDismiss 引用', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const oldDismiss = vi.fn();
    const latestDismiss = vi.fn();
    const queue = [{ id: 'same', tone: 'success' as const, text: '同一条。' }];
    const view = renderToastLayer(queue, oldDismiss);
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭工作台提示：同一条。' });

    fireEvent.focus(toast);
    fireEvent.blur(toast, { relatedTarget: close });
    await vi.advanceTimersByTimeAsync(5000);
    expect(oldDismiss).not.toHaveBeenCalled();

    view.rerender(
      <TransientToastLayer
        queue={queue}
        onDismiss={latestDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    fireEvent.blur(toast, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(3000);
    expect(oldDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledExactlyOnceWith('same');
  });

  test('timer 句柄为 0 时暂停会清理 timer，并从剩余时间恢复', () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let nowValue = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => nowValue);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      scheduled.push({ callback: callback as () => void, delay: Number(delay) });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const onDismiss = vi.fn();
    renderToastLayer([{ id: 'zero', tone: 'success', text: '零句柄。' }], onDismiss);

    nowValue = 1000;
    fireEvent.mouseEnter(screen.getByRole('status'));
    fireEvent.mouseLeave(screen.getByRole('status'));

    expect(now).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(scheduled[1]?.delay).toBe(2000);

  });

  test('活跃 timer 在卸载后不会触发关闭回调', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismiss = vi.fn();
    const view = renderToastLayer([{ id: 'active', tone: 'info', text: '仍在计时。' }], onDismiss);

    view.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('以正确 live 区域语义展示每种 tone，且关闭按钮不会自动获取焦点', () => {
    const onDismiss = vi.fn();
    const { rerender } = renderToastLayer(
      [{ id: 'success', tone: 'success', text: '成功。' }],
      onDismiss
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('true');
    expect(document.activeElement).not.toBe(screen.getByRole('button'));

    rerender(
      <TransientToastLayer
        queue={[{ id: 'error', tone: 'error', text: '失败。' }]}
        onDismiss={onDismiss}
        durationMs={workshopDurationMs}
        ariaLabel="工作台提示"
      />
    );
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
    expect(screen.getByRole('alert').getAttribute('aria-atomic')).toBe('true');
  });
});
