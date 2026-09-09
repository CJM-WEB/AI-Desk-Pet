// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SharedPetChapter } from '../components/website-experience/community/SharedPetChapter';
import type {
  SharedPetPage,
  SharedPetRepository
} from '../components/website-experience/community/shared-pet-types';
import { SupportChapter } from '../components/website-experience/support/SupportChapter';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

const downloadCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/download/download.module.css'
  ),
  'utf8'
);
const communityCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/community/community.module.css'
  ),
  'utf8'
);
const supportCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/support/support.module.css'
  ),
  'utf8'
);

function emptySharedPetRepository(): SharedPetRepository {
  const page: SharedPetPage = {
    items: [],
    page: 1,
    pageSize: 8,
    total: 0,
    totalPages: 0,
    hasPrevious: false,
    hasNext: false
  };
  return {
    listPage: vi.fn(async () => page),
    submit: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    toggleLike: vi.fn(),
    getDownload: vi.fn(),
    recordDownload: vi.fn(),
    subscribe: vi.fn(() => () => undefined)
  };
}

describe('章节静态回退禁用内部动效', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('下载静态回退保留标题与安装提示的可见语义节点', () => {
    render(<DownloadChapter interactive staticFallback />);
    const root = screen.getByTestId('download-chapter');
    const heading = screen.getByRole('heading', { name: '选择你的平台' });
    const notice = screen.getByRole('region', { name: '安装前须知 · 常见问题' });

    expect(root.dataset.motionDisabled).toBe('true');
    expect(heading).toBeTruthy();
    expect(notice).toBeTruthy();
    expect(heading.style.visibility).toBe('');
    expect(notice.getAttribute('aria-hidden')).toBeNull();
  });

  it('下载静态回退关闭标题、平台文字与内容切换过渡且保留真实链接', () => {
    render(<DownloadChapter interactive staticFallback />);

    const root = screen.getByTestId('download-chapter');
    expect(root.dataset.motionDisabled).toBe('true');
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.platformHeader,[\s\S]*\.downloadChapter\[data-motion-disabled='true'\] \.platformCopy,[\s\S]*\.downloadChapter\[data-motion-disabled='true'\] \.downloadAction\s*\{[^}]*transition:\s*none;/s
    );
    expect(downloadCss.match(/\.platformWord\s*\{([^}]*)\}/s)?.[1]).not.toContain('rotate(');
    expect(screen.getByRole('link', { name: '下载 Windows' }).getAttribute('href')).toBe(
      'https://ai-pet-scanner-dev-d0cpbc8094826-1391054083.tcloudbaseapp.com/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe'
    );
  });

  it('下载章节减少动态效果时不安排模型挂载且不创建 WebGL', () => {
    const setTimeout = vi.spyOn(window, 'setTimeout');
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null);

    render(
      <DownloadChapter
        interactive
        reducedMotion
        transitionProgress={2}
      />
    );

    expect(screen.queryByRole('img', { name: /3D 模型/ })).toBeNull();
    expect(setTimeout).not.toHaveBeenCalledWith(expect.any(Function), 120);
    expect(getContext.mock.calls.some(([type]) => type === 'webgl')).toBe(false);
    expect(screen.getByRole('link', { name: '下载 Windows' }).getAttribute('href')).toBe(
      'https://ai-pet-scanner-dev-d0cpbc8094826-1391054083.tcloudbaseapp.com/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe'
    );
  });

  it('捐款静态回退关闭滚筒与付款码进入动效且保留支付按钮', () => {
    render(<SupportChapter interactive staticFallback />);

    const root = screen.getByTestId('support-chapter');
    expect(root.dataset.motionDisabled).toBe('true');

    const payment = screen.getByRole('button', { name: '打开微信付款码' });
    expect((payment as HTMLButtonElement).disabled).toBe(false);
    expect(supportCss).toMatch(
      /\.supportChapter\[data-static-presentation='true'\] \.glassButton\s*\{[^}]*color:\s*#effff8;/s
    );
    fireEvent.click(payment);

    const dialog = screen.getByRole('dialog', { name: '微信付款码' });
    expect(dialog.dataset.motionDisabled).toBe('true');
  });

  it('窗口暂停会下发到下载与捐款章节并关闭 CSS 动画和过渡', () => {
    const { rerender } = render(
      <DownloadChapter interactive isPaused />
    );
    const download = screen.getByTestId('download-chapter');

    expect(download.dataset.paused).toBe('true');
    expect(download.dataset.motionDisabled).toBe('true');
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.platformHeader,[\s\S]*\.downloadChapter\[data-motion-disabled='true'\] \.platformCopy,[\s\S]*\.downloadChapter\[data-motion-disabled='true'\] \.downloadAction\s*\{[^}]*transition:\s*none;/s
    );

    rerender(<SupportChapter interactive isPaused />);
    const support = screen.getByTestId('support-chapter');
    expect(support.dataset.paused).toBe('true');
    expect(support.dataset.motionDisabled).toBe('true');
  });

  it('下载章节暂停时关闭标题倾斜且恢复后重新启用', () => {
    const setTimeout = vi.spyOn(window, 'setTimeout');
    const { rerender } = render(
      <DownloadChapter interactive isPaused />
    );

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 120);
    expect(screen.getAllByTestId('pointer-tilt-text').every(
      (element) => element.dataset.motionEnabled === 'false'
    )).toBe(true);

    rerender(<DownloadChapter interactive isPaused={false} />);
    expect(screen.getAllByTestId('pointer-tilt-text').every(
      (element) => element.dataset.motionEnabled === 'true'
    )).toBe(true);
  });

  it('共享仓库减少动态效果时关闭顺序动画和标题倾斜', async () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetChapter
          interactive
          reducedMotion
          repository={emptySharedPetRepository()}
        />
      </I18nProvider>
    );

    const root = await screen.findByTestId('shared-pet-chapter');
    expect(root.dataset.motionDisabled).toBe('true');
    expect(screen.queryAllByTestId('pointer-tilt-text')).toHaveLength(0);
    expect(communityCss).toMatch(
      /\.sharedPetChapter\[data-motion-disabled='true'\] \.sharedPetCardSlot,\s*\.sharedPetChapter\[data-motion-disabled='true'\] \.card\s*\{[^}]*animation:\s*none/s
    );
    expect(communityCss).toMatch(
      /\.sharedPetChapter\[data-static-presentation='true'\] \.sharedPetPrevious,[\s\S]*\.sharedPetChapter\[data-static-presentation='true'\] \.totalPageNumber\s*\{[^}]*color:\s*#effff8;/s
    );
  });
});
