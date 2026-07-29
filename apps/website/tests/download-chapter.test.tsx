// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';
import { isLocalInputElement } from '../components/website-experience/use-website-controller';

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
}

describe('下载安装章节', () => {
  beforeEach(() => setMobileViewport(false));

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('渲染数据驱动平台、倾斜标题与真实 Windows 导航链接', () => {
    render(<DownloadChapter interactive />);

    expect(screen.getAllByTestId('pointer-tilt-text')).toHaveLength(2);
    expect(screen.getByText('Windows')).toBeTruthy();
    expect(screen.getByText('macOS')).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载 Windows' })
      .hasAttribute('download')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));
    expect(screen.queryByRole('link', { name: /macOS/u })).toBeNull();
    expect((screen.getByRole('button', { name: '即将支持' }) as HTMLButtonElement)
      .disabled).toBe(true);
  });

  it('英文环境使用精简下载文案', () => {
    render(
      <I18nProvider initialLocale="en">
        <DownloadChapter interactive staticFallback />
      </I18nProvider>
    );

    expect(screen.getByRole('heading', { name: 'Choose Your Platform' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download Windows' })).toBeTruthy();
  });

  it('桌面端 hover 和 focus 临时展开，点击不锁定', () => {
    render(<DownloadChapter interactive />);
    const root = screen.getByTestId('download-chapter');
    const trigger = screen.getByRole('button', { name: '显示常见问题' });

    expect(trigger.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.pointerEnter(trigger);
    expect(root.dataset.visibleSide).toBe('faq');
    fireEvent.pointerLeave(trigger);
    expect(root.dataset.visibleSide).toBe('none');

    fireEvent.focus(trigger);
    expect(root.dataset.visibleSide).toBe('faq');
    fireEvent.click(trigger);
    fireEvent.blur(trigger);
    expect(root.dataset.visibleSide).toBe('none');
  });

  it('移动端轻触打开侧栏并由章节空白处关闭', () => {
    setMobileViewport(true);
    render(<DownloadChapter interactive />);
    const root = screen.getByTestId('download-chapter');
    const trigger = screen.getByRole('button', { name: '显示安装前须知' });

    fireEvent.click(trigger);
    expect(root.dataset.visibleSide).toBe('notice');
    fireEvent.click(root);
    expect(root.dataset.visibleSide).toBe('none');
  });

  it('两个可滚动侧栏让滚轮正常冒泡但被全局章节控制器识别为局部输入', () => {
    const globalChapterWheel = vi.fn();
    const bubbledWheel = vi.fn((event: WheelEvent) => {
      if (!isLocalInputElement(event.target as HTMLElement)) {
        globalChapterWheel();
      }
    });
    window.addEventListener('wheel', bubbledWheel);
    render(<DownloadChapter interactive />);

    const panels = document.querySelectorAll<HTMLElement>('[data-side-panel]');
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel.dataset.inputScope).toBe('local');
      fireEvent.wheel(panel, { deltaY: 120, bubbles: true });
    }

    expect(bubbledWheel).toHaveBeenCalledTimes(2);
    expect(globalChapterWheel).not.toHaveBeenCalled();
    window.removeEventListener('wheel', bubbledWheel);
  });

  it('侧栏标题和每条内容保留稳定动画语义标记', () => {
    render(<DownloadChapter interactive />);

    expect(document.querySelectorAll('[data-panel-heading]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-panel-item]')).toHaveLength(6);
  });

  it('局部滚筒消费滚轮并切换数据配置的下一个平台', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });
    const preventDefault = vi.spyOn(wheel, 'preventDefault');

    fireEvent(stack, wheel);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stack.dataset.activePlatform).toBe('macos');
  });

  it('Escape 重置平台状态并让焦点退出局部滚筒', () => {
    render(<DownloadChapter interactive />);
    const stack = screen.getByRole('group', { name: '选择下载平台' });
    const blur = vi.spyOn(stack, 'blur');
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape'
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    stack.focus();
    fireEvent(stack, event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(stack);
  });
});
