// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SharedPetCard } from '../components/website-experience/community/SharedPetCard';
import type { SharedPetPackageSummary } from '../components/website-experience/community/shared-pet-types';

const item: SharedPetPackageSummary = {
  id: 'pet-1',
  name: 'My Pet',
  description: 'My package',
  packageFileName: 'my-pet.zip',
  packageSizeBytes: 2_048,
  coverFileName: 'cover.png',
  coverMimeType: 'image/png',
  coverSizeBytes: 512,
  coverFile: new Blob(['cover'], { type: 'image/png' }),
  likeCount: 12,
  downloadCount: 34,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  likedByCurrentUser: false,
  publicationBasis: 'standard'
};

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cover')
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('共享包卡片', () => {
  it('卡片操作不会触发详情点击', () => {
    const onOpen = vi.fn();
    const onLike = vi.fn();
    const onDownload = vi.fn();
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetCard
          item={item}
          onOpen={onOpen}
          onLike={onLike}
          onDownload={onDownload}
        />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '点赞 My Pet' }));
    fireEvent.click(screen.getByRole('button', { name: '下载 My Pet' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onLike).toHaveBeenCalledWith(item);
    expect(onDownload).toHaveBeenCalledWith(item);
  });

  it('卡片点击打开详情，图标操作提供名称和提示', () => {
    const onOpen = vi.fn();
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetCard
          item={item}
          onOpen={onOpen}
          onLike={vi.fn()}
          onDownload={vi.fn()}
        />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '打开 My Pet 的详情' }));
    expect(onOpen).toHaveBeenCalledWith(item);
    expect(screen.getByRole('button', { name: '点赞 My Pet' })
      .getAttribute('title')).toBe('点赞 My Pet');
    expect(screen.getByRole('button', { name: '下载 My Pet' })
      .getAttribute('title')).toBe('下载 My Pet');
  });

  it('详情入口为独立按钮，重复 keydown 不调用业务回调', () => {
    const onOpen = vi.fn();
    const onLike = vi.fn();
    const onDownload = vi.fn();
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetCard
          item={item}
          onOpen={onOpen}
          onLike={onLike}
          onDownload={onDownload}
        />
      </I18nProvider>
    );

    const open = screen.getByRole('button', { name: '打开 My Pet 的详情' });
    const like = screen.getByRole('button', { name: '点赞 My Pet' });
    const download = screen.getByRole('button', { name: '下载 My Pet' });
    expect(open.tagName).toBe('BUTTON');
    expect(open.contains(like)).toBe(false);
    expect(open.contains(download)).toBe(false);

    fireEvent.keyDown(open, { key: ' ', repeat: true });
    fireEvent.keyDown(open, { key: ' ', repeat: true });
    fireEvent.keyDown(like, { key: ' ', repeat: true });
    fireEvent.keyDown(like, { key: ' ', repeat: true });
    fireEvent.keyDown(download, { key: 'Enter', repeat: true });
    fireEvent.keyDown(download, { key: 'Enter', repeat: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onLike).not.toHaveBeenCalled();
    expect(onDownload).not.toHaveBeenCalled();

    fireEvent.click(open);
    fireEvent.click(like);
    fireEvent.click(download);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onLike).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('只有管理员人工放行的卡片显示固定风险提示', () => {
    const renderCard = (publicationBasis: 'standard' | 'admin_override') => render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetCard
          item={{ ...item, publicationBasis }}
          onOpen={vi.fn()}
          onLike={vi.fn()}
          onDownload={vi.fn()}
        />
      </I18nProvider>
    );

    const override = renderCard('admin_override');
    expect(screen.getByRole('note', { name: '共享包风险提示' }).textContent)
      .toContain('管理员人工放行，未通过系统安全验证');
    override.unmount();

    renderCard('standard');
    expect(screen.queryByText('管理员人工放行，未通过系统安全验证')).toBeNull();
  });
});
