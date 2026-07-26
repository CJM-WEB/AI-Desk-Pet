// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { gsap } from 'gsap';
import rawManifest from '../content/release-manifest.json';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';
import { DOWNLOAD_PLATFORMS } from '../components/website-experience/download/download-content';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
  }
}

function advancePanelTransition() {
  act(() => {
    vi.advanceTimersByTime(250);
  });
}

function pressEnter(element: HTMLElement) {
  fireEvent.keyDown(element, { key: 'Enter' });
  fireEvent.click(element, { detail: 0 });
  fireEvent.keyUp(element, { key: 'Enter' });
}

describe('下载安装章节', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('渲染配置平台、真实下载和两侧信息', () => {
    const html = renderToStaticMarkup(<DownloadChapter interactive />);

    expect(html).toContain('data-testid="download-chapter"');
    expect(html).toContain('Windows');
    expect(html).toContain('macOS');
    expect(html).toContain('即将支持');
    expect(html).toContain('.exe');
    expect(html).toContain('常见问题');
    expect(html).toContain('安装前须知');
    expect(html).toContain('data-input-scope="local"');
  });

  it('滚轮阻止默认与冒泡并按方向切换平台', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });
    const preventDefault = vi.spyOn(wheel, 'preventDefault');
    const stopPropagation = vi.spyOn(wheel, 'stopPropagation');

    fireEvent(stack, wheel);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 macOS' })
        .getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('方向键循环平台且 Escape 复位平台与侧栏', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });

    fireEvent.keyDown(stack, { key: 'ArrowDown' });
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 macOS' })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '显示常见问题' }));
    expect(screen.getByTestId('download-chapter').dataset.visibleSide).toBe('faq');

    fireEvent.keyDown(stack, { key: 'Escape' });
    advancePanelTransition();

    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 Windows' })
    ).toBeTruthy();
    expect(screen.getByTestId('download-chapter').dataset.visibleSide).toBe('none');
  });

  it('pointer 与 focus 共同持有预览，全部释放后才关闭', () => {
    render(<DownloadChapter interactive />);
    const trigger = screen.getByRole('button', { name: '显示常见问题' });
    const root = screen.getByTestId('download-chapter');

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);
    fireEvent.pointerLeave(trigger);

    expect(root.dataset.visibleSide).toBe('faq');

    fireEvent.blur(trigger);
    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('none');
  });

  it('pointer 与 focus 仍持有时再次点击同侧会立即关闭锁定面板', () => {
    render(<DownloadChapter interactive />);
    const trigger = screen.getByRole('button', { name: '显示常见问题' });
    const root = screen.getByTestId('download-chapter');

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(root.dataset.visibleSide).toBe('faq');
    expect(root.dataset.panelPhase).toBe('closing');
    expect(root.dataset.pendingSide).toBe('none');

    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('none');
  });

  it('focus 持有时连续按 Enter 会锁定后立即解除并关闭面板', () => {
    render(<DownloadChapter interactive />);
    const trigger = screen.getByRole('button', { name: '显示常见问题' });
    const root = screen.getByTestId('download-chapter');

    fireEvent.focus(trigger);
    pressEnter(trigger);
    pressEnter(trigger);

    expect(root.dataset.panelPhase).toBe('closing');
    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('none');
  });

  it('另一侧临时 focus 释放后恢复仍由 pointer 持有的面板', () => {
    render(<DownloadChapter interactive />);
    const faqTrigger = screen.getByRole('button', { name: '显示常见问题' });
    const noticeTrigger = screen.getByRole('button', { name: '显示安装前须知' });
    const root = screen.getByTestId('download-chapter');

    fireEvent.pointerEnter(faqTrigger);
    fireEvent.focus(noticeTrigger);
    expect(root.dataset.visibleSide).toBe('faq');
    expect(root.dataset.panelPhase).toBe('closing');
    expect(root.dataset.pendingSide).toBe('notice');
    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('notice');

    fireEvent.blur(noticeTrigger);
    expect(root.dataset.visibleSide).toBe('notice');
    expect(root.dataset.panelPhase).toBe('closing');
    expect(root.dataset.pendingSide).toBe('faq');
    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('faq');
  });

  it('显式关闭期间释放 hold 后，新的 pointerEnter 可以再次预览', () => {
    render(<DownloadChapter interactive />);
    const trigger = screen.getByRole('button', { name: '显示常见问题' });
    const root = screen.getByTestId('download-chapter');

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.blur(trigger);
    advancePanelTransition();
    expect(root.dataset.visibleSide).toBe('none');

    fireEvent.pointerEnter(trigger);
    expect(root.dataset.visibleSide).toBe('faq');
    expect(root.dataset.panelPhase).toBe('open');
  });

  it('锁定面板从一侧切换时先关闭当前侧再展开目标侧', () => {
    render(<DownloadChapter interactive />);
    const root = screen.getByTestId('download-chapter');

    fireEvent.click(screen.getByRole('button', { name: '显示常见问题' }));
    expect(root.dataset.visibleSide).toBe('faq');

    fireEvent.click(screen.getByRole('button', { name: '显示安装前须知' }));

    expect(root.dataset.visibleSide).toBe('faq');
    expect(root.dataset.panelPhase).toBe('closing');
    expect(root.dataset.pendingSide).toBe('notice');
    expect(
      document
        .querySelector('[data-side-panel="notice"]')
        ?.getAttribute('aria-hidden')
    ).toBe('true');

    advancePanelTransition();

    expect(root.dataset.visibleSide).toBe('notice');
    expect(root.dataset.panelPhase).toBe('open');
    expect(root.dataset.pendingSide).toBe('none');
  });

  it('pointer 垂直拖动超过阈值只切换一次，并在结束后允许新手势', () => {
    const globalPointerUp = vi.fn();
    render(
      <div onPointerUp={globalPointerUp}>
        <DownloadChapter interactive />
      </div>
    );
    const stack = screen.getByRole('group', { name: '选择下载平台' });

    fireEvent.pointerDown(stack, {
      bubbles: true,
      clientY: 200,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      bubbles: true,
      clientY: 165,
      pointerId: 7,
      pointerType: 'touch'
    });
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 Windows' })
    ).toBeTruthy();

    fireEvent.pointerMove(stack, {
      bubbles: true,
      clientY: 159,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      bubbles: true,
      clientY: 80,
      pointerId: 7,
      pointerType: 'touch'
    });
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 macOS' })
    ).toBeTruthy();

    fireEvent.pointerUp(stack, {
      bubbles: true,
      clientY: 80,
      pointerId: 7,
      pointerType: 'touch'
    });
    expect(globalPointerUp).not.toHaveBeenCalled();

    fireEvent.pointerDown(stack, {
      bubbles: true,
      clientY: 100,
      pointerId: 8,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      bubbles: true,
      clientY: 141,
      pointerId: 8,
      pointerType: 'touch'
    });
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 Windows' })
    ).toBeTruthy();
  });

  it('pointer cancel 清除拖动，不再响应取消手势的后续移动', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });

    fireEvent.pointerDown(stack, {
      clientY: 200,
      pointerId: 11,
      pointerType: 'touch'
    });
    fireEvent.pointerCancel(stack, {
      clientY: 190,
      pointerId: 11,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      clientY: 100,
      pointerId: 11,
      pointerType: 'touch'
    });

    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 Windows' })
    ).toBeTruthy();
  });

  it('已有 pointer 拖动时忽略第二指针，第一指针仍可完成切换', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });

    fireEvent.pointerDown(stack, {
      clientY: 200,
      pointerId: 21,
      pointerType: 'touch'
    });
    fireEvent.pointerDown(stack, {
      clientY: 100,
      pointerId: 22,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      clientY: 150,
      pointerId: 21,
      pointerType: 'touch'
    });

    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 macOS' })
    ).toBeTruthy();

    fireEvent.pointerUp(stack, {
      clientY: 150,
      pointerId: 21,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(stack, {
      clientY: 20,
      pointerId: 22,
      pointerType: 'touch'
    });
    expect(
      screen.getByRole('button', { name: '重置下载视图，当前为 macOS' })
    ).toBeTruthy();
  });

  it('macOS 选中后没有下载链接且保持禁用状态', () => {
    render(<DownloadChapter interactive />);

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));

    expect(screen.queryByRole('link')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '即将支持' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('Windows 详情展示 SHA-256 并使用动态平台名生成下载文案', () => {
    const originalPlatform = DOWNLOAD_PLATFORMS[0]!;
    DOWNLOAD_PLATFORMS[0] = {
      ...originalPlatform,
      name: 'Windows ARM'
    };

    try {
      render(<DownloadChapter interactive />);

      expect(screen.getByText(rawManifest.sha256)).toBeTruthy();
      expect(screen.getByRole('link', { name: '下载 Windows ARM' })).toBeTruthy();
    } finally {
      DOWNLOAD_PLATFORMS[0] = originalPlatform;
    }
  });

  it('GSAP 清理失败会上报统一错误入口且不向 effect 外抛出', () => {
    const onInitializationError = vi.fn();
    const revert = vi.fn(() => {
      throw new Error('下载 GSAP 清理失败');
    });
    vi.spyOn(gsap, 'context').mockReturnValue({
      revert
    } as unknown as gsap.Context);
    const { rerender } = render(
      <DownloadChapter
        interactive
        onInitializationError={onInitializationError}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '显示常见问题' }));
    expect(() => {
      rerender(
        <DownloadChapter
          interactive={false}
          onInitializationError={onInitializationError}
        />
      );
    }).not.toThrow();

    expect(revert).toHaveBeenCalledOnce();
    expect(onInitializationError).toHaveBeenCalledOnce();
  });
});
