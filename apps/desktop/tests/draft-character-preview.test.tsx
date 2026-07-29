import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CharacterWorkshopApi
} from '../src/renderer/src/characters/store/character-workshop-store';
import {
  DraftPreviewResourceCache
} from '../src/renderer/src/characters/workshop/draft-preview-resource-cache';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50
]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function apiWithReader(
  readCharacterSource: CharacterWorkshopApi['readCharacterSource']
): Pick<CharacterWorkshopApi, 'readCharacterSource'> {
  return { readCharacterSource };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('草稿预览资源缓存', () => {
  const createdBlobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:preview-${createdBlobs.length}`;
  });
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createdBlobs.length = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('同一动作多帧引用相同素材时只读取一次', async () => {
    const readCharacterSource = vi.fn(async () => PNG_BYTES);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    const bundle = await cache.load(
      'nova',
      ['sheet-a', 'sheet-a'],
      new AbortController().signal
    );

    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(readCharacterSource).toHaveBeenCalledWith('nova', 'sheet-a');
    expect([...bundle.urls]).toEqual([['sheet-a', 'blob:preview-1']]);
  });

  test('并发加载相同素材共享读取且分别持有引用', async () => {
    const source = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(() => source.promise);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    const firstLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    const secondLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    expect(readCharacterSource).toHaveBeenCalledOnce();

    source.resolve(PNG_BYTES);
    const [first, second] = await Promise.all([firstLoad, secondLoad]);
    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  test('并发共享慢读取时取消一方不影响另一方取得并释放 URL', async () => {
    const source = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(() => source.promise);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));
    const firstController = new AbortController();

    const firstLoad = cache.load(
      'nova',
      ['sheet-a'],
      firstController.signal
    );
    const secondLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    expect(readCharacterSource).toHaveBeenCalledOnce();

    firstController.abort();
    await expect(firstLoad).rejects.toMatchObject({ name: 'AbortError' });
    source.resolve(PNG_BYTES);

    const second = await secondLoad;
    expect(second.urls.get('sheet-a')).toBe('blob:preview-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  test('取消加载会释放该调用已创建的 Blob URL', async () => {
    const slowSource = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(
      async (_characterId: string, assetId: string) => (
        assetId === 'ready' ? PNG_BYTES : slowSource.promise
      )
    );
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));
    const controller = new AbortController();

    const loading = cache.load(
      'nova',
      ['ready', 'slow'],
      controller.signal
    );
    await settle();
    expect(createObjectURL).toHaveBeenCalledOnce();

    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');

    slowSource.resolve(PNG_BYTES);
    await settle();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  test('单个 bundle 重复 release 只撤销一次', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    const bundle = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    bundle.release();
    bundle.release();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  test('一个 bundle 释放不影响另一个 bundle 使用同一素材', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    const first = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    const second = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(second.urls.get('sheet-a')).toBe('blob:preview-1');

    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  test('读取失败会清理条目并允许后续重试', async () => {
    const readCharacterSource = vi.fn()
      .mockRejectedValueOnce(new Error('CHARACTER_SOURCE_READ_FAILED'))
      .mockResolvedValueOnce(PNG_BYTES);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    await expect(cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    )).rejects.toThrow('CHARACTER_SOURCE_READ_FAILED');
    const retried = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    expect(readCharacterSource).toHaveBeenCalledTimes(2);
    expect(retried.urls.get('sheet-a')).toBe('blob:preview-1');
  });

  test('加载过程中 destroy 会阻止晚到结果创建 Blob URL', async () => {
    const source = deferred<Uint8Array>();
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(() => source.promise)
    ));
    const loading = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    cache.destroy();
    source.resolve(PNG_BYTES);

    await expect(loading).rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test('destroy 释放全部 Blob URL 且后续加载被拒绝', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    await cache.load(
      'nova',
      ['sheet-a', 'sheet-b'],
      new AbortController().signal
    );

    cache.destroy();

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
    await expect(cache.load(
      'nova',
      ['sheet-c'],
      new AbortController().signal
    )).rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
  });

  test.each([
    ['PNG', PNG_BYTES, 'image/png'],
    ['WebP', WEBP_BYTES, 'image/webp']
  ] as const)('%s 魔数创建对应 MIME 的 Blob', async (
    _name,
    bytes,
    expectedMimeType
  ) => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => bytes)
    ));

    await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]?.type).toBe(expectedMimeType);
  });

  test('不支持的素材内容沿用角色图片 MIME 错误语义', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => new Uint8Array([1, 2, 3]))
    ));

    await expect(cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    )).rejects.toThrow('CHARACTER_IMAGE_MIME_UNSUPPORTED');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
