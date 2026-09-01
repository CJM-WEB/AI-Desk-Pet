// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

vi.mock('../components/website-experience/download/download-content', () => ({
  createDownloadContent: () => ({
    platforms: [
      {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('点击只旁路上报一次且保留原生链接默认行为', () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);
    const link = screen.getByRole('link', { name: '下载 Windows' });
    const observedDefaults: boolean[] = [];
    link.addEventListener('click', event => observedDefaults.push(event.defaultPrevented));

    const defaultAllowed = fireEvent.click(link);

    expect(link.getAttribute('href')).toBe('https://downloads.example/AI-Pet.exe');
    expect(defaultAllowed).toBe(true);
    expect(observedDefaults).toEqual([false]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('旁路上报同步失败时仍保留链接默认行为', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
    render(<DownloadChapter interactive staticFallback />);
    const link = screen.getByRole('link', { name: '下载 Windows' });
    const observedDefaults: boolean[] = [];
    link.addEventListener('click', event => observedDefaults.push(event.defaultPrevented));

    const defaultAllowed = fireEvent.click(link);

    expect(defaultAllowed).toBe(true);
    expect(observedDefaults).toEqual([false]);
  });

  it('切换到 macOS 后不会为未发布入口发送上报', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<DownloadChapter interactive staticFallback />);

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));

    expect(screen.queryByRole('link', { name: /macOS/u })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
