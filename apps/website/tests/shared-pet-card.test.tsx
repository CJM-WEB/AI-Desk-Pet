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
  likedByCurrentUser: false
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
});
