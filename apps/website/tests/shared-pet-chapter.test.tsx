// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SharedPetChapter } from '../components/website-experience/community/SharedPetChapter';
import {
  SHARED_PET_PAGE_SIZE,
  type CreateSharedPetInput,
  type SharedPetDownload,
  type SharedPetPackageSummary,
  type SharedPetPage,
  type SharedPetRepository
} from '../components/website-experience/community/shared-pet-types';

const communityCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/community/community.module.css'
  ),
  'utf8'
);

function createItem(index: number): SharedPetPackageSummary {
  return {
    id: `pet-${index}`,
    name: `Pet ${index}`,
    description: `Package ${index}`,
    packageFileName: `pet-${index}.zip`,
    packageSizeBytes: 2_048,
    coverFileName: `pet-${index}.png`,
    coverMimeType: 'image/png',
    coverSizeBytes: 512,
    coverFile: new Blob([`cover-${index}`], { type: 'image/png' }),
    likeCount: 0,
    downloadCount: 0,
    createdAt: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    likedByCurrentUser: false
  };
}

function createRepository(itemCount: number) {
  let items = Array.from(
    { length: itemCount },
    (_, index) => createItem(itemCount - index)
  );
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  const listPage = vi.fn(async (
    page: number,
    pageSize: typeof SHARED_PET_PAGE_SIZE = SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage> => {
    const totalPages = Math.ceil(items.length / pageSize);
    const offset = (page - 1) * pageSize;
    return {
      items: items.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: items.length,
      totalPages,
      hasPrevious: page > 1 && totalPages > 0,
      hasNext: page < totalPages
    };
  });
  const create = vi.fn(async (
    input: CreateSharedPetInput
  ): Promise<SharedPetPackageSummary> => {
    const item = {
      ...createItem(items.length + 1),
      name: input.name,
      description: input.description,
      packageFileName: input.packageFile.name,
      packageSizeBytes: input.packageFile.size,
      coverFileName: input.coverFile.name,
      coverMimeType: input.coverFile.type,
      coverSizeBytes: input.coverFile.size,
      coverFile: input.coverFile
    };
    items = [item, ...items];
    emit();
    return item;
  });
  const getById = vi.fn(async (id: string) => (
    items.find((item) => item.id === id) ?? null
  ));
  const toggleLike = vi.fn(async (id: string) => {
    const current = items.find((item) => item.id === id);
    if (!current) throw new Error('missing');
    const updated = {
      ...current,
      likedByCurrentUser: !current.likedByCurrentUser,
      likeCount: current.likeCount + (current.likedByCurrentUser ? -1 : 1)
    };
    items = items.map((item) => item.id === id ? updated : item);
    emit();
    return updated;
  });
  const getDownload = vi.fn(async (): Promise<SharedPetDownload> => ({
    file: new Blob(['zip'], { type: 'application/zip' }),
    fileName: 'original-pet.zip',
    mimeType: 'application/zip'
  }));
  const recordDownload = vi.fn(async (id: string) => {
    const current = items.find((item) => item.id === id);
    if (!current) throw new Error('missing');
    const updated = { ...current, downloadCount: current.downloadCount + 1 };
    items = items.map((item) => item.id === id ? updated : item);
    emit();
    return updated;
  });
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const repository: SharedPetRepository = {
    listPage,
    create,
    getById,
    toggleLike,
    getDownload,
    recordDownload,
    subscribe
  };

  return {
    repository,
    listPage,
    create,
    getById,
    toggleLike,
    getDownload,
    recordDownload
  };
}

function renderChapter(repository: SharedPetRepository, props = {}) {
  return render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetChapter interactive repository={repository} {...props} />
    </I18nProvider>
  );
}

beforeEach(() => {
  let coverIndex = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => (
      blob.type === 'application/zip'
        ? 'blob:download'
        : `blob:cover-${coverIndex++}`
    ))
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

describe('共享仓库章节', () => {
  it('空仓库显示 0/0 并禁用分页', async () => {
    const { repository } = createRepository(0);
    renderChapter(repository);

    expect(await screen.findByText('0/0')).toBeTruthy();
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('每页固定八张卡片并在最后一张离场后替换数据', async () => {
    const { repository } = createRepository(9);
    renderChapter(repository);

    await screen.findByText('Pet 9');
    const firstPageCards = screen.getAllByTestId('shared-pet-card');
    expect(firstPageCards).toHaveLength(8);
    expect(firstPageCards[0]?.style.getPropertyValue('--shared-pet-order')).toBe('0');
    expect(firstPageCards[7]?.style.getPropertyValue('--shared-pet-order')).toBe('7');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('Pet 9')).toBeTruthy();
    expect(screen.queryByText('Pet 1')).toBeNull();
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.animationEnd(firstPageCards[7]!);
    expect(await screen.findByText('Pet 1')).toBeTruthy();
    expect(screen.queryByText('Pet 9')).toBeNull();
    fireEvent.animationEnd(screen.getByTestId('shared-pet-card'));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
  });

  it('减少动态效果时直接替换分页数据', async () => {
    const { repository } = createRepository(9);
    renderChapter(repository, { reducedMotion: true });
    await screen.findByText('Pet 9');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(await screen.findByText('Pet 1')).toBeTruthy();
    expect(screen.getByTestId('shared-pet-chapter').dataset.transition).toBe('idle');
  });

  it('桌面四列两行并在窄屏切换为两列或一列', () => {
    expect(communityCss).toMatch(
      /\.sharedPetGrid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(communityCss).toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sharedPetGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(communityCss).toMatch(
      /@media\s*\(max-width:\s*560px\)[\s\S]*?\.sharedPetGrid\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
  });

  it('投稿成功后关闭弹窗并刷新第一页', async () => {
    const harness = createRepository(1);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '上传 AI Pet' }));
    expect(await screen.findByRole('dialog', { name: '分享投稿' })).toBeTruthy();
    const packageFile = new File(['zip'], 'new-pet.zip', { type: 'application/zip' });
    const coverFile = new File(['image'], 'new-cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [packageFile] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [coverFile] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '新的共享包' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    await waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('新 Pet')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '分享投稿' })).toBeNull();
    expect(harness.listPage).toHaveBeenLastCalledWith(1, SHARED_PET_PAGE_SIZE);
  });

  it('投稿失败时保留弹窗并显示本地化错误', async () => {
    const harness = createRepository(0);
    harness.create.mockRejectedValueOnce(new Error('failed'));
    renderChapter(harness.repository);

    fireEvent.click(screen.getByRole('button', { name: '上传 AI Pet' }));
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: {
        files: [new File(['zip'], 'new-pet.zip', { type: 'application/zip' })]
      }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: {
        files: [new File(['image'], 'new-cover.png', { type: 'image/png' })]
      }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '新的共享包' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    expect(await screen.findByText('分享暂时无法发布，请稍后重试。')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '分享投稿' })).toBeTruthy();
  });

  it('详情读取仓储中的最新数据', async () => {
    const harness = createRepository(1);
    harness.getById.mockResolvedValueOnce({
      ...createItem(1),
      description: '详情最新数据'
    });
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '打开 Pet 1 的详情' }));

    expect(await screen.findByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    expect(screen.getByText('详情最新数据')).toBeTruthy();
    expect(harness.getById).toHaveBeenCalledWith('pet-1');
  });

  it('点赞成功后只更新当前卡片', async () => {
    const harness = createRepository(2);
    renderChapter(harness.repository);
    await screen.findByText('Pet 2');
    const card = screen.getAllByTestId('shared-pet-card')[0]!;

    fireEvent.click(within(card).getByRole('button', { name: '点赞 Pet 2' }));

    await waitFor(() => {
      expect(within(card).getByRole('button', { name: '点赞 Pet 2' }).textContent)
        .toContain('1');
    });
    expect(harness.toggleLike).toHaveBeenCalledWith('pet-2');
    expect(within(screen.getAllByTestId('shared-pet-card')[1]!)
      .getByRole('button', { name: '点赞 Pet 1' }).textContent).toContain('0');
  });

  it('详情和点赞失败时显示各自的本地化状态', async () => {
    const harness = createRepository(1);
    harness.getById.mockRejectedValueOnce(new Error('detail failed'));
    harness.toggleLike.mockRejectedValueOnce(new Error('like failed'));
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '打开 Pet 1 的详情' }));
    expect(await screen.findByText('详情暂时无法打开，请稍后重试。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '点赞 Pet 1' }));
    expect(await screen.findByText('点赞暂时无法完成，请稍后重试。')).toBeTruthy();
  });

  it('下载使用原文件名并在记录次数前释放临时地址', async () => {
    const harness = createRepository(1);
    const order: string[] = [];
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
    revokeObjectURL.mockImplementation((url) => {
      order.push(`revoke:${url}`);
    });
    harness.recordDownload.mockImplementationOnce(async () => {
      order.push('record');
      return { ...createItem(1), downloadCount: 1 };
    });
    let clickedDownload = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clickedDownload = this.download;
      order.push(`click:${this.href}`);
    });
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '下载 Pet 1' }));

    await waitFor(() => expect(harness.recordDownload).toHaveBeenCalledWith('pet-1'));
    expect(clickedDownload).toBe('original-pet.zip');
    expect(order).toContain('revoke:blob:download');
    expect(order.indexOf('revoke:blob:download')).toBeLessThan(order.indexOf('record'));
  });

  it('下载失败时不记录次数并显示本地化错误', async () => {
    const harness = createRepository(1);
    harness.getDownload.mockRejectedValueOnce(new Error('download failed'));
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '下载 Pet 1' }));

    expect(await screen.findByText('下载暂时无法完成，请稍后重试。')).toBeTruthy();
    expect(harness.recordDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下载 Pet 1' }).textContent).toContain('0');
  });
});
