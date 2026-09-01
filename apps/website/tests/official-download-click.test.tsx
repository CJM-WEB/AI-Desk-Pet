// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

const fixture = vi.hoisted(() => ({
  windowsStatus: 'available' as 'available' | 'unpublished'
}));

vi.mock('../components/website-experience/download/download-content', () => ({
  createDownloadContent: () => ({
    platforms: [
      fixture.windowsStatus === 'available' ? {
        id: 'windows-x64',
        name: 'Windows',
        status: 'available',
        summary: '正式 Windows 安装包',
        versionLabel: '0.1.0',
        systemRequirements: 'Windows 10/11 x64',
        downloadUrl: 'https://downloads.example/AI-Pet.exe',
        fileName: 'AI-Pet.exe',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64)
      } : {
        id: 'windows-x64',
        name: 'Windows',
        status: 'unpublished',
        summary: 'Windows 安装包尚未发布',
        versionLabel: '0.1.0',
        systemRequirements: 'Windows 10/11 x64',
        fileName: 'AI-Pet.exe'
      },
      {
        id: 'macos',
        name: 'macOS',
        status: 'coming-soon',
        summary: '即将支持 macOS',
        versionLabel: 'Soon',
        systemRequirements: 'macOS'
      }
    ],
    faqItems: [],
    installNoticeItems: []
  })
}));

describe('正式 Windows 安装包链接', () => {
  afterEach(() => {
    cleanup();
    fixture.windowsStatus = 'available';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('点击只旁路上报一次且保留原生链接默认行为', () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);
    const link = screen.getByRole('link', { name: '下载 Windows' });
    assertNativeLinkClick(link);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('旁路上报同步失败时仍保留链接默认行为', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
    render(<DownloadChapter interactive staticFallback />);
    const link = screen.getByRole('link', { name: '下载 Windows' });
    assertNativeLinkClick(link);
  });

  it.each([
    ['网络拒绝', () => Promise.reject(new Error('offline'))],
    ['429 响应', () => Promise.resolve(new Response(null, { status: 429 }))],
    ['500 响应', () => Promise.resolve(new Response(null, { status: 500 }))]
  ])('旁路上报%s时仍保留链接默认行为', async (_label, request) => {
    const fetcher = vi.fn(request);
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);

    assertNativeLinkClick(screen.getByRole('link', { name: '下载 Windows' }));
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('切换到 macOS 后不会为未发布入口发送上报', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));

    expect(screen.queryByRole('link', { name: /macOS/u })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('Windows 未发布时不渲染真实链接也不上报', () => {
    fixture.windowsStatus = 'unpublished';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);

    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect((screen.getByRole('button', { name: '尚未发布' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function assertNativeLinkClick(link: HTMLElement): void {
  let defaultPrevented: boolean | undefined;
  const observe = (event: MouseEvent) => { defaultPrevented = event.defaultPrevented; };
  document.addEventListener('click', observe);
  const defaultAllowed = fireEvent.click(link);
  document.removeEventListener('click', observe);

  expect(link.getAttribute('href')).toBe('https://downloads.example/AI-Pet.exe');
  expect(defaultAllowed).toBe(true);
  expect(defaultPrevented).toBe(false);
}
