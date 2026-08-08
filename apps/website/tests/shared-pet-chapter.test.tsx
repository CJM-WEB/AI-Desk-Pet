// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionReceipt } from '@myself/shared-types';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function createPage(
  items: readonly SharedPetPackageSummary[],
  page: number,
  total: number
): SharedPetPage {
  const totalPages = Math.ceil(total / SHARED_PET_PAGE_SIZE);
  return {
    items,
    page,
    pageSize: SHARED_PET_PAGE_SIZE,
    total,
    totalPages,
    hasPrevious: page > 1 && totalPages > 0,
    hasNext: page < totalPages
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
  const submit = vi.fn(async (
    input: CreateSharedPetInput
  ): Promise<SubmissionReceipt> => {
    await create(input);
    return {
      submissionId: 'submission-test',
      statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/',
      status: 'system_reviewing'
    };
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
    url: 'https://storage.example/pet.zip',
    fileName: 'original-pet.zip',
    expiresAt: '2026-08-01T00:00:00.000Z'
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
    submit,
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
    submit,
    create,
    getById,
    toggleLike,
    getDownload,
    recordDownload,
    emit
  };
}

function renderChapter(repository: SharedPetRepository, props = {}) {
  return render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetChapter
        interactive
        repository={repository}
        {...props}
      />
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

  it('分页使旧刷新失效并在进入结束后补刷新订阅脏页', async () => {
    const harness = createRepository(9);
    const staleRefresh = deferred<SharedPetPage>();
    const targetPage = deferred<SharedPetPage>();
    const dirtyRefresh = deferred<SharedPetPage>();
    renderChapter(harness.repository);
    await screen.findByText('Pet 9');

    harness.listPage.mockImplementationOnce(() => staleRefresh.promise);
    harness.emit();
    await waitFor(() => expect(harness.listPage).toHaveBeenCalledTimes(2));
    harness.listPage.mockImplementationOnce(() => targetPage.promise);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await act(async () => {
      staleRefresh.resolve(createPage([
        { ...createItem(9), name: '过期刷新' }
      ], 1, 9));
      await staleRefresh.promise;
    });
    expect(screen.queryByText('过期刷新')).toBeNull();
    expect(screen.getByTestId('shared-pet-chapter').dataset.transition).toBe('leaving');

    harness.emit();
    expect(harness.listPage).toHaveBeenCalledTimes(3);
    fireEvent.animationEnd(screen.getAllByTestId('shared-pet-card')[7]!);
    await act(async () => {
      targetPage.resolve(createPage([createItem(1)], 2, 9));
      await targetPage.promise;
    });
    expect(await screen.findByText('Pet 1')).toBeTruthy();

    harness.listPage.mockImplementationOnce(() => dirtyRefresh.promise);
    fireEvent.animationEnd(screen.getByTestId('shared-pet-card'));
    await waitFor(() => {
      expect(harness.listPage).toHaveBeenLastCalledWith(2, SHARED_PET_PAGE_SIZE);
    });
    await act(async () => {
      dirtyRefresh.resolve(createPage([
        { ...createItem(1), name: 'Pet 1 已刷新' }
      ], 2, 9));
      await dirtyRefresh.promise;
    });
    expect(await screen.findByText('Pet 1 已刷新')).toBeTruthy();
  });

  it('直切分页立即锁定按钮并只提交当前请求', async () => {
    const harness = createRepository(9);
    const targetPage = deferred<SharedPetPage>();
    renderChapter(harness.repository, { reducedMotion: true });
    await screen.findByText('Pet 9');
    harness.listPage.mockImplementationOnce(() => targetPage.promise);

    const next = screen.getByRole('button', { name: '下一页' });
    fireEvent.click(next);
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(next);
    expect(harness.listPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      targetPage.resolve(createPage([createItem(1)], 2, 9));
      await targetPage.promise;
    });
    expect(await screen.findByText('Pet 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('动画分页快速拒绝会被立即收敛并在离场结束后解锁', async () => {
    const harness = createRepository(9);
    renderChapter(harness.repository);
    await screen.findByText('Pet 9');
    harness.listPage.mockRejectedValueOnce(new Error('快速拒绝'));

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await act(async () => Promise.resolve());
    expect(screen.queryByText('共享内容暂时无法加载，请稍后重试。')).toBeNull();

    fireEvent.animationEnd(screen.getAllByTestId('shared-pet-card')[7]!);
    expect(await screen.findByText('共享内容暂时无法加载，请稍后重试。'))
      .toBeTruthy();
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('离场请求等待期间切换减少动态效果后安全直切并解锁', async () => {
    const harness = createRepository(9);
    const targetPage = deferred<SharedPetPage>();
    const view = renderChapter(harness.repository);
    await screen.findByText('Pet 9');
    harness.listPage.mockImplementationOnce(() => targetPage.promise);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    fireEvent.animationEnd(screen.getAllByTestId('shared-pet-card')[7]!);
    view.rerender(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetChapter
          interactive
          reducedMotion
          repository={harness.repository}
        />
      </I18nProvider>
    );
    await act(async () => {
      targetPage.resolve(createPage([createItem(1)], 2, 9));
      await targetPage.promise;
    });

    expect(await screen.findByText('Pet 1')).toBeTruthy();
    expect(screen.getByTestId('shared-pet-chapter').dataset.transition).toBe('idle');
    expect(screen.getByTestId('shared-pet-chapter').dataset.pageLocked).toBe('false');
  });

  it('切换仓储时同步复位分页状态且旧请求不能写回', async () => {
    const oldHarness = createRepository(9);
    const newHarness = createRepository(1);
    const oldTarget = deferred<SharedPetPage>();
    newHarness.listPage.mockResolvedValue(createPage([
      { ...createItem(50), name: '新仓储 Pet' }
    ], 1, 1));
    const view = renderChapter(oldHarness.repository);
    await screen.findByText('Pet 9');
    oldHarness.listPage.mockImplementationOnce(() => oldTarget.promise);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByTestId('shared-pet-chapter').dataset.transition).toBe('leaving');
    view.rerender(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetChapter interactive repository={newHarness.repository} />
      </I18nProvider>
    );

    expect(screen.getByTestId('shared-pet-chapter').dataset.transition).toBe('idle');
    expect(screen.getByTestId('shared-pet-chapter').dataset.pageLocked).toBe('false');
    expect(await screen.findByText('新仓储 Pet')).toBeTruthy();
    await act(async () => {
      oldTarget.resolve(createPage([createItem(1)], 2, 9));
      await oldTarget.promise;
    });
    expect(screen.getByText('新仓储 Pet')).toBeTruthy();
    expect(screen.queryByText('Pet 1')).toBeNull();
  });

  it('桌面四列两行并在窄屏切换为两列或一列', () => {
    expect(communityCss).toMatch(
      /\.sharedPetChapter\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s
    );
    expect(communityCss).toMatch(
      /\.sharedPetLayout\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+clamp\([^;]+\)\s+minmax\(0,\s*1fr\)/s
    );
    expect(communityCss).toMatch(
      /\.sharedPetFocus\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s
    );
    expect(communityCss).toMatch(
      /\.sharedPetCardSlot:nth-child\(-n\s*\+\s*4\)\s*\{[^}]*grid-row:\s*1/s
    );
    expect(communityCss).toMatch(
      /\.sharedPetCardSlot:nth-child\(n\s*\+\s*5\)\s*\{[^}]*grid-row:\s*3/s
    );
    expect(communityCss).toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sharedPetLayout\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(communityCss).toMatch(
      /@media\s*\(max-width:\s*560px\)[\s\S]*?\.sharedPetLayout\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
    expect(communityCss).toMatch(
      /\.dialogBackdrop\s*\{[^}]*padding:\s*max\(20px,\s*env\(safe-area-inset-top\)\)\s+max\(20px,\s*env\(safe-area-inset-right\)\)\s+max\(20px,\s*env\(safe-area-inset-bottom\)\)\s+max\(20px,\s*env\(safe-area-inset-left\)\)[^}]*backdrop-filter:\s*blur\(34px\)\s+saturate\(72%\)\s+brightness\(0\.58\)/s
    );
    expect(communityCss).toMatch(
      /@media\s*\(max-width:\s*560px\)[\s\S]*?\.dialogBackdrop\s*\{[^}]*padding:\s*max\(16px,\s*env\(safe-area-inset-top\)\)\s+max\(16px,\s*env\(safe-area-inset-right\)\)\s+max\(16px,\s*env\(safe-area-inset-bottom\)\)\s+max\(16px,\s*env\(safe-area-inset-left\)\)/s
    );
  });

  it('投稿成功后关闭弹窗并显示一次性审核查询链接', async () => {
    const harness = createRepository(1);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
    const composer = await screen.findByRole('dialog', { name: '分享投稿' });
    expect(within(composer).getByRole('link', { name: '用户协议' }).getAttribute('href'))
      .toBe('/legal/terms.html');
    expect(within(composer).getByRole('link', { name: '隐私政策' }).getAttribute('href'))
      .toBe('/legal/privacy.html');
    expect(within(composer).getByRole('link', { name: '内容规则' }).getAttribute('href'))
      .toBe('/legal/content-policy.html');
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
    expect(screen.queryByRole('dialog', { name: '分享投稿' })).toBeNull();
    expect(await screen.findByText('投稿已收到，正在系统审核。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开专属状态查询链接' })
      .getAttribute('href')).toBe('/submission-status/#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(screen.getByText('请立即保存此链接，丢失后无法找回。')).toBeTruthy();
  });

  it('加载失败后的投稿仍调用仓库并优先显示状态链接', async () => {
    const harness = createRepository(0);
    harness.listPage.mockRejectedValueOnce(new Error('load failed'));
    renderChapter(harness.repository);
    await screen.findByText('共享内容暂时无法加载，请稍后重试。');

    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '共享包描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    await waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('投稿已收到，正在系统审核。')).toBeTruthy();
    expect(screen.queryByText('共享内容暂时无法加载，请稍后重试。')).toBeNull();
  });

  it('再次打开投稿时清除旧审核回执和状态链接', async () => {
    const harness = createRepository(0);
    renderChapter(harness.repository);
    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '共享包描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));
    await screen.findByRole('link', { name: '打开专属状态查询链接' });

    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
    expect(screen.queryByText('投稿已收到，正在系统审核。')).toBeNull();
    expect(screen.queryByRole('link', { name: '打开专属状态查询链接' })).toBeNull();
  });

  it('投稿时将聚合上传进度传给对话框', async () => {
    const harness = createRepository(0);
    let complete!: (receipt: SubmissionReceipt) => void;
    harness.submit.mockImplementationOnce((
      _input: CreateSharedPetInput,
      progress?: (percent: number) => void
    ) => new Promise<SubmissionReceipt>(resolve => {
      progress?.(42);
      complete = resolve;
    }));
    renderChapter(harness.repository);
    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新 Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '共享包描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));
    expect(await screen.findByLabelText('上传进度')).toHaveProperty('value', 42);
    await act(async () => complete({
      submissionId: 'submission-test', statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/', status: 'system_reviewing'
    }));
  });

  it('投稿失败时保留弹窗并显示本地化错误', async () => {
    const harness = createRepository(0);
    harness.create.mockRejectedValueOnce(new Error('failed'));
    renderChapter(harness.repository);

    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
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

  it('投稿完成时若章节已卸载则不再刷新或写状态', async () => {
    const harness = createRepository(0);
    const created = deferred<SharedPetPackageSummary>();
    harness.create.mockImplementationOnce(() => created.promise);
    const view = renderChapter(harness.repository);
    await screen.findByText('0/0');

    fireEvent.click(screen.getByRole('button', { name: '分享您的 AI Pet' }));
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
    await waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      created.resolve(createItem(1));
      await created.promise;
    });
    expect(harness.listPage).toHaveBeenCalledTimes(1);
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

  it('详情乱序完成时只允许最新请求打开弹窗和写错误状态', async () => {
    const harness = createRepository(2);
    const first = deferred<SharedPetPackageSummary | null>();
    const second = deferred<SharedPetPackageSummary | null>();
    harness.getById
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderChapter(harness.repository);
    await screen.findByText('Pet 2');

    const pet2 = screen.getByRole('button', { name: '打开 Pet 2 的详情' });
    const pet1 = screen.getByRole('button', { name: '打开 Pet 1 的详情' });
    fireEvent.click(pet2);
    fireEvent.click(pet1);
    expect((pet2 as HTMLButtonElement).disabled).toBe(true);
    expect((pet1 as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      second.resolve({ ...createItem(1), description: '最新详情' });
      await second.promise;
    });
    expect(await screen.findByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    await act(async () => {
      first.reject(new Error('过期详情失败'));
      await first.promise.catch(() => undefined);
    });
    expect(screen.getByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    expect(screen.queryByText('详情暂时无法打开，请稍后重试。')).toBeNull();
  });

  it('详情等待期间点赞不会使当前详情请求失效', async () => {
    const harness = createRepository(1);
    const detail = deferred<SharedPetPackageSummary | null>();
    harness.getById.mockImplementationOnce(() => detail.promise);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '打开 Pet 1 的详情' }));
    fireEvent.click(screen.getByRole('button', { name: '点赞 Pet 1' }));
    await waitFor(() => expect(harness.toggleLike).toHaveBeenCalledWith('pet-1'));
    await act(async () => {
      detail.resolve({ ...createItem(1), description: '并发后详情' });
      await detail.promise;
    });

    expect(await screen.findByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    expect(screen.getByText('并发后详情')).toBeTruthy();
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

  it('同一条目的点赞与下载在完成前各自只执行一次', async () => {
    const harness = createRepository(1);
    const liked = deferred<SharedPetPackageSummary>();
    const downloaded = deferred<SharedPetDownload>();
    harness.toggleLike.mockImplementationOnce(() => liked.promise);
    harness.getDownload.mockImplementationOnce(() => downloaded.promise);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    const like = screen.getByRole('button', { name: '点赞 Pet 1' });
    fireEvent.click(like);
    fireEvent.click(like);
    expect(harness.toggleLike).toHaveBeenCalledTimes(1);
    expect((like as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      liked.resolve({ ...createItem(1), likeCount: 1, likedByCurrentUser: true });
      await liked.promise;
    });
    await waitFor(() => expect((like as HTMLButtonElement).disabled).toBe(false));

    const download = screen.getByRole('button', { name: '下载 Pet 1' });
    fireEvent.click(download);
    fireEvent.click(download);
    expect(harness.getDownload).toHaveBeenCalledTimes(1);
    expect((download as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      downloaded.resolve({
        url: 'https://storage.example/pet.zip',
        fileName: 'pet.zip',
        expiresAt: '2026-08-01T00:00:00.000Z'
      });
      await downloaded.promise;
    });
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
  });

  it('从详情下载时复用短期下载流程且不在客户端更新计数', async () => {
    const harness = createRepository(1);
    const downloaded = deferred<SharedPetDownload>();
    harness.getDownload.mockImplementationOnce(() => downloaded.promise);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');
    const card = screen.getByTestId('shared-pet-card');

    fireEvent.click(within(card).getByRole('button', { name: '打开 Pet 1 的详情' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pet 1' });
    const detailDownload = within(dialog).getByRole('button', { name: '下载 Pet 1' });
    fireEvent.click(detailDownload);
    fireEvent.click(detailDownload);

    expect(harness.getDownload).toHaveBeenCalledTimes(1);
    expect((detailDownload as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole('button', {
      name: '下载 Pet 1'
    }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      downloaded.resolve({
        url: 'https://storage.example/pet.zip',
        fileName: 'pet.zip',
        expiresAt: '2026-08-01T00:00:00.000Z'
      });
      await downloaded.promise;
    });

    await waitFor(() => expect((detailDownload as HTMLButtonElement).disabled).toBe(false));
    expect(harness.recordDownload).not.toHaveBeenCalled();
  });

  it('旧点赞错误不覆盖后续详情操作的状态', async () => {
    const harness = createRepository(2);
    const oldLike = deferred<SharedPetPackageSummary>();
    harness.toggleLike.mockImplementationOnce(() => oldLike.promise);
    renderChapter(harness.repository);
    await screen.findByText('Pet 2');

    fireEvent.click(screen.getByRole('button', { name: '点赞 Pet 2' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 Pet 1 的详情' }));
    expect(await screen.findByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    await act(async () => {
      oldLike.reject(new Error('过期点赞失败'));
      await oldLike.promise.catch(() => undefined);
    });

    expect(screen.getByRole('dialog', { name: 'Pet 1' })).toBeTruthy();
    expect(screen.queryByText('点赞暂时无法完成，请稍后重试。')).toBeNull();
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

  it('加载失败后的成功订阅刷新会清除旧加载错误', async () => {
    const harness = createRepository(1);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');
    harness.listPage.mockRejectedValueOnce(new Error('load failed'));

    harness.emit();
    expect(await screen.findByText('共享内容暂时无法加载，请稍后重试。')).toBeTruthy();
    harness.listPage.mockResolvedValueOnce(createPage([
      { ...createItem(1), name: '刷新成功 Pet' }
    ], 1, 1));
    harness.emit();

    expect(await screen.findByText('刷新成功 Pet')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('共享内容暂时无法加载，请稍后重试。')).toBeNull();
    });
  });

  it('成功订阅刷新不会清除并发操作错误', async () => {
    const harness = createRepository(1);
    harness.toggleLike.mockRejectedValueOnce(new Error('like failed'));
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '点赞 Pet 1' }));
    expect(await screen.findByText('点赞暂时无法完成，请稍后重试。')).toBeTruthy();
    harness.listPage.mockResolvedValueOnce(createPage([createItem(1)], 1, 1));
    harness.emit();
    await waitFor(() => expect(harness.listPage).toHaveBeenCalledTimes(2));

    expect(screen.getByText('点赞暂时无法完成，请稍后重试。')).toBeTruthy();
  });

  it('下载使用短期地址和原文件名触发隐藏链接', async () => {
    const harness = createRepository(1);
    const order: string[] = [];
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

    await waitFor(() => expect(order).toContain('click:https://storage.example/pet.zip'));
    expect(clickedDownload).toBe('original-pet.zip');
    expect(harness.recordDownload).not.toHaveBeenCalled();
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

  it('短期地址下载不再尝试客户端记录次数', async () => {
    const harness = createRepository(1);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderChapter(harness.repository);
    await screen.findByText('Pet 1');

    fireEvent.click(screen.getByRole('button', { name: '下载 Pet 1' }));

    await waitFor(() => expect(harness.getDownload).toHaveBeenCalledWith('pet-1'));
    expect(harness.recordDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下载 Pet 1' }).textContent).toContain('0');
  });
});
