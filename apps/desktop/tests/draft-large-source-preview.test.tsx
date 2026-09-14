// @vitest-environment jsdom

import { crc32 } from 'node:zlib';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActionFrame } from '@myself/character-runtime';
import { DraftPreviewResourceCache } from '../src/renderer/src/characters/workshop/draft-preview-resource-cache';
import { AtlasImportPanel } from '../src/renderer/src/characters/workshop/AtlasImportPanel';

// 仅构造合法元数据；像素解码在此单元测试中由可观察的 Bitmap 替身负责。
function sourceBytes(width: number, height: number): Uint8Array {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

function frames(count = 17): ActionFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `frame-${index}`, assetId: 'long-sheet', x: index * 1024, y: 0,
    width: 1024, height: 1024, durationMs: 80,
    anchors: { carry: { x: 0.2, y: 0.3 } }
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('大源图草稿预览', () => {
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();
  const drawImage = vi.fn();
  const close = vi.fn();
  const canvases: HTMLCanvasElement[] = [];

  beforeEach(() => {
    let urlIndex = 0;
    createObjectURL.mockReset().mockImplementation(() => `blob:preview-${++urlIndex}`);
    revokeObjectURL.mockReset();
    drawImage.mockReset();
    close.mockReset();
    canvases.length = 0;
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 17408, height: 1024, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return { drawImage } as unknown as ReturnType<HTMLCanvasElement['getContext']>;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['page'], { type: 'image/png' }));
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('17 帧长图裁成两页，原矩形和编辑帧身份保持，整图 URL 不上传', async () => {
    const readCharacterSource = vi.fn(async () => sourceBytes(17408, 1024));
    const cache = new DraftPreviewResourceCache({ readCharacterSource });
    const original = frames();
    const snapshot = structuredClone(original);
    const bundle = await cache.loadFrames('nova', original, new AbortController().signal);

    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect([...bundle.urls.values()]).toEqual(['blob:preview-2', 'blob:preview-3']);
    expect(bundle.frames[16]).toMatchObject({
      id: 'frame-16', x: 0, y: 0, width: 1024, height: 1024,
      durationMs: 80, anchors: original[16]!.anchors
    });
    expect(bundle.frames[16]!.assetId).not.toBe(bundle.frames[0]!.assetId);
    expect(drawImage.mock.calls[16]?.slice(1)).toEqual([16384, 0, 1024, 1024, 0, 0, 1024, 1024]);
    expect(original).toEqual(snapshot);
    expect(canvases).toHaveLength(2);
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    bundle.release();
    bundle.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  test('相同裁片并发共享读取和分页，锚点变化不重做裁图', async () => {
    const readCharacterSource = vi.fn(async () => sourceBytes(17408, 1024));
    const cache = new DraftPreviewResourceCache({ readCharacterSource });
    const original = frames();
    const changedAnchors = original.map(frame => ({ ...frame, anchors: { carry: { x: 0.8, y: 0.7 } } }));
    const [first, second] = await Promise.all([
      cache.loadFrames('nova', original, new AbortController().signal),
      cache.loadFrames('nova', changedAnchors, new AbortController().signal)
    ]);
    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect([...second.urls]).toEqual([...first.urls]);
    expect(second.frames[0]!.anchors).toEqual(changedAnchors[0]!.anchors);
    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  test('小素材直接复用源 URL，不进入 Bitmap 或 Canvas', async () => {
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(1, 1) });
    const original = [{ ...frames(1)[0]!, width: 1, height: 1 }];
    const bundle = await cache.loadFrames('nova', original, new AbortController().signal);
    expect(bundle.frames).toEqual(original);
    expect([...bundle.urls]).toEqual([['long-sheet', 'blob:preview-1']]);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(canvases).toHaveLength(0);
    bundle.release();
  });

  test('裁片位置改变生成独立页，旧 bundle 释放不影响新矩形', async () => {
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    const original = frames(1);
    const first = await cache.loadFrames('nova', original, new AbortController().signal);
    const second = await cache.loadFrames('nova', [{ ...original[0]!, x: 4096 }], new AbortController().signal);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls[1]?.slice(1)).toEqual([4096, 0, 1024, 1024, 0, 0, 1024, 1024]);
    expect([...second.urls.values()]).toEqual(['blob:preview-3']);
    first.release();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:preview-2']]);
    second.release();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:preview-2'], ['blob:preview-3'], ['blob:preview-1']]);
  });

  test('交错引用多个源图且旧帧没有 id 时仍按原顺序映射各自裁片', async () => {
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    const first = { ...frames(1)[0]!, id: undefined };
    const original = [first, { ...first, assetId: 'another-sheet' }, { ...first, x: 8192 }];
    const bundle = await cache.loadFrames('nova', original, new AbortController().signal);
    expect(bundle.frames.map(frame => [frame.id, frame.x, frame.y])).toEqual([
      [undefined, 0, 0], [undefined, 0, 0], [undefined, 1024, 0]
    ]);
    expect(bundle.frames[0]!.assetId).toBe(bundle.frames[2]!.assetId);
    expect(bundle.frames[0]!.assetId).not.toBe(bundle.frames[1]!.assetId);
    bundle.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(4);
  });

  test('同一慢裁图取消一方，另一方仍成功且只解码一次', async () => {
    const decoded = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockReturnValue(decoded.promise);
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    const controller = new AbortController();
    const first = cache.loadFrames('nova', frames(), controller.signal);
    const second = cache.loadFrames('nova', frames(), new AbortController().signal);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    decoded.resolve({ width: 17408, height: 1024, close } as ImageBitmap);
    const remaining = await second;
    expect(remaining.urls.size).toBe(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    remaining.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  test('未切帧的超大单帧在解码前明确拒绝', async () => {
    const readCharacterSource = vi.fn(async () => sourceBytes(8192, 1024));
    const cache = new DraftPreviewResourceCache({ readCharacterSource });
    await expect(cache.loadFrames('nova', [{ ...frames(1)[0]!, width: 8192 }], new AbortController().signal))
      .rejects.toThrow('CHARACTER_FRAME_DIMENSION_EXCEEDED');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  test('取消慢解码后及时结束等待，晚到 Bitmap 关闭且不创建页 URL', async () => {
    const decoded = deferred<ImageBitmap>();
    vi.mocked(createImageBitmap).mockReturnValue(decoded.promise);
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    const controller = new AbortController();
    const loading = cache.loadFrames('nova', frames(), controller.signal);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    decoded.resolve({ width: 17408, height: 1024, close } as ImageBitmap);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  test('第二页导出失败撤销已创建页 URL 并释放所有画布', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob)
      .mockImplementationOnce(callback => callback(new Blob(['page'], { type: 'image/png' })))
      .mockImplementationOnce(callback => callback(null));
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    await expect(cache.loadFrames('nova', frames(), new AbortController().signal))
      .rejects.toThrow('DRAFT_PREVIEW_EXPORT_FAILED');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  test('销毁时第二页导出尚未返回，晚到回调不发布 URL 并清空画布', async () => {
    let finishPage: BlobCallback | undefined;
    vi.mocked(HTMLCanvasElement.prototype.toBlob)
      .mockImplementationOnce(callback => callback(new Blob(['page'], { type: 'image/png' })))
      .mockImplementationOnce(callback => { finishPage = callback; });
    const cache = new DraftPreviewResourceCache({ readCharacterSource: async () => sourceBytes(17408, 1024) });
    const loading = cache.loadFrames('nova', frames(), new AbortController().signal);
    await vi.waitFor(() => expect(finishPage).toBeTypeOf('function'));
    cache.destroy();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    finishPage!(new Blob(['late-page'], { type: 'image/png' }));
    await expect(loading).rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });
});

test('精灵图表单允许 128 列并保留 500 有效帧上限', () => {
  const onApply = vi.fn(async () => undefined);
  render(<AtlasImportPanel sources={[{ assetId: 'sheet', displayName: '长图', mimeType: 'image/png' }]} disabled={false} onApply={onApply} />);
  const columns = screen.getByLabelText('列数') as HTMLInputElement;
  fireEvent.change(columns, { target: { value: '128' } });
  expect(columns.checkValidity()).toBe(true);
  fireEvent.change(screen.getByLabelText('有效帧数'), { target: { value: '128' } });
  fireEvent.click(screen.getByRole('button', { name: '应用到当前动作' }));
  expect(onApply).toHaveBeenCalledWith({ sourceAssetId: 'sheet', rows: 1, columns: 128, frameCount: 128 });
  fireEvent.change(screen.getByLabelText('行数'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('有效帧数'), { target: { value: '501' } });
  expect((screen.getByLabelText('有效帧数') as HTMLInputElement).checkValidity()).toBe(false);
  cleanup();
});
