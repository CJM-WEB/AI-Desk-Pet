import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  compileAtlas,
  type AtlasCanvasLike,
  type AtlasDrawContextLike,
  type AtlasSourceFrame
} from '../src/renderer/src/characters/import/atlas-compiler';
import { decodeSource } from '../src/renderer/src/characters/import/image-decoder';

// 两个夹具均已使用 Sharp 0.34.5 验证为可解码的 1×1 图片。
const PNG_BYTES = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
));
const WEBP_BYTES = new Uint8Array(Buffer.from(
  'UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA',
  'base64'
));

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bitmap(width: number, height: number): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn()
  } as unknown as ImageBitmap;
}

type CanvasHarness = {
  canvas: AtlasCanvasLike;
  context: AtlasDrawContextLike;
  factory: ReturnType<typeof vi.fn>;
};

function createCanvasHarness(
  exportedBlob: Blob | null = new Blob([PNG_BYTES], { type: 'image/png' })
): CanvasHarness {
  const context: AtlasDrawContextLike = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x, _y, width, height) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255)
    }))
  };
  const canvas: AtlasCanvasLike = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn(callback => callback(exportedBlob))
  };
  return {
    canvas,
    context,
    factory: vi.fn((width: number, height: number) => {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    })
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 细长的两帧因 shelf 换行分成两页，但实际只分配 8192 像素。
function pagedSourceFrames(): AtlasSourceFrame[] {
  return [{
    frameId: 'tall', sourceAssetId: 'source', bytes: PNG_BYTES, mimeType: 'image/png',
    sourceRect: { x: 0, y: 0, width: 1, height: 4096 }, durationMs: 50
  }, {
    frameId: 'wide', sourceAssetId: 'source', bytes: PNG_BYTES, mimeType: 'image/png',
    sourceRect: { x: 1, y: 0, width: 4096, height: 1 },
    anchors: { ground: { x: 0.25, y: 0.5 } }
  }];
}

describe('浏览器图片解码', () => {
  test('只允许 PNG 和 WebP MIME，并把白名单 MIME 写入 Blob', async () => {
    const decoded = bitmap(16, 24);
    const createImageBitmap = vi.fn(async (_blob: Blob) => decoded);
    vi.stubGlobal('createImageBitmap', createImageBitmap);

    await expect(decodeSource(PNG_BYTES, 'image/png')).resolves.toBe(decoded);
    const blob = createImageBitmap.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_BYTES);

    await expect(decodeSource(WEBP_BYTES, 'image/webp')).resolves.toBe(decoded);
    const webpBlob = createImageBitmap.mock.calls[1]![0];
    expect(webpBlob.type).toBe('image/webp');
    expect(new Uint8Array(await webpBlob.arrayBuffer())).toEqual(WEBP_BYTES);

    await expect(decodeSource(PNG_BYTES, 'image/jpeg'))
      .rejects.toThrow('CHARACTER_IMAGE_MIME_UNSUPPORTED');
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
  });
});

describe('浏览器图集编译', () => {
  test('长源图分页保持帧身份和统一几何，逐页释放画布并复用源摘要', async () => {
    const source = bitmap(4097, 4096);
    const decode = vi.fn(async () => source);
    vi.stubGlobal('createImageBitmap', decode);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const first = createCanvasHarness();
    const second = createCanvasHarness();
    const factory = vi.fn((width: number, height: number) => {
      if (factory.mock.calls.length === 1) return first.factory(width, height);
      expect(first.canvas.width).toBe(0);
      expect(first.canvas.height).toBe(0);
      return second.factory(width, height);
    });
    const result = await compileAtlas({
      atlasAssetId: 'paged', mimeType: 'image/png', groundAnchor: { x: 0, y: 0 }, frames: pagedSourceFrames()
    }, factory);

    expect(result.pages).toEqual([
      { assetId: 'paged', mimeType: 'image/png', bytes: PNG_BYTES, width: 1, height: 4096 },
      { assetId: 'paged-page-2', mimeType: 'image/png', bytes: PNG_BYTES, width: 4096, height: 1 }
    ]);
    expect(result.frames).toEqual([
      { id: 'tall', assetId: 'paged', x: 0, y: 0, width: 1, height: 4096, durationMs: 50, anchors: { ground: { x: 0.5, y: 1 } } },
      { id: 'wide', assetId: 'paged-page-2', x: 0, y: 0, width: 4096, height: 1, anchors: { ground: { x: 0.25, y: 0.5 } } }
    ]);
    expect(second.context.drawImage).toHaveBeenCalledWith(source, 1, 0, 4096, 1, 0, 0, 4096, 1);
    expect(result.geometry).toEqual({ visualBounds: { x: 0, y: 0, width: 1, height: 1 }, groundAnchor: { x: 0, y: 0 } });
    expect(digest).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(second.canvas.width).toBe(0);
    expect(second.canvas.height).toBe(0);
  });

  test('分页标识截短后仍唯一且符合120字符资源契约', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap(4097, 4096)));
    const base = `${'a'.repeat(113)}-page-2`;
    const result = await compileAtlas({
      atlasAssetId: base, mimeType: 'image/png', frames: pagedSourceFrames()
    }, (width, height) => createCanvasHarness().factory(width, height));
    expect(result.pages[0]!.assetId).toBe(base);
    expect(new Set(result.pages.map(page => page.assetId)).size).toBe(2);
    expect(result.pages.every(page => page.assetId.length <= 120)).toBe(true);
    expect(result.frames[1]!.assetId).toBe(result.pages[1]!.assetId);
  });

  test.each(['failure', 'cancel'] as const)('第二页%s时释放全部临时资源且不返回部分结果', async mode => {
    const source = bitmap(4097, 4096);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
    const first = createCanvasHarness();
    const second = createCanvasHarness(mode === 'failure' ? null : undefined);
    const abort = new AbortController();
    if (mode === 'cancel') second.canvas.toBlob = callback => {
      abort.abort();
      callback(new Blob([PNG_BYTES], { type: 'image/png' }));
    };
    const factory = vi.fn((width: number, height: number) => (
      factory.mock.calls.length === 1 ? first.factory(width, height) : second.factory(width, height)
    ));
    const pending = compileAtlas({
      atlasAssetId: 'failure', mimeType: 'image/png', frames: pagedSourceFrames(), signal: abort.signal
    }, factory);
    if (mode === 'failure') await expect(pending).rejects.toThrow('CHARACTER_ATLAS_EXPORT_FAILED');
    else await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.canvas.toBlob).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(source.close).toHaveBeenCalledOnce();
    for (const harness of [first, second]) {
      expect(harness.canvas.width).toBe(0);
      expect(harness.canvas.height).toBe(0);
    }
  });

  test('相同源标识使用不同字节对象仍校验内容冲突并释放位图', async () => {
    const source = bitmap(32, 32);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
    const frames = pagedSourceFrames().map(frame => ({ ...frame, sourceRect: { x: 0, y: 0, width: 1, height: 1 } }));
    frames[1]!.bytes = WEBP_BYTES;
    const harness = createCanvasHarness();
    await expect(compileAtlas({ atlasAssetId: 'conflict', mimeType: 'image/png', frames }, harness.factory))
      .rejects.toThrow('CHARACTER_SOURCE_ASSET_CONFLICT');
    expect(source.close).toHaveBeenCalledOnce();
    expect(harness.factory).not.toHaveBeenCalled();
  });

  test('按源矩形裁切精灵图，输出帧坐标和默认 ground 锚点', async () => {
    const sourceBitmap = bitmap(64, 32);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => sourceBitmap));
    const harness = createCanvasHarness();

    const result = await compileAtlas({
      atlasAssetId: 'idle-atlas',
      mimeType: 'image/png',
      frames: [{
        frameId: 'frame-1',
        sourceAssetId: 'idle-source',
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        sourceRect: { x: 0, y: 0, width: 32, height: 32 }
      }, {
        frameId: 'frame-2',
        sourceAssetId: 'idle-source',
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        sourceRect: { x: 32, y: 0, width: 32, height: 32 },
        durationMs: 120
      }]
    }, harness.factory);

    expect(harness.factory).toHaveBeenCalledWith(64, 32);
    expect(harness.context.drawImage).toHaveBeenNthCalledWith(
      1,
      sourceBitmap,
      0, 0, 32, 32,
      0, 0, 32, 32
    );
    expect(harness.context.drawImage).toHaveBeenNthCalledWith(
      2,
      sourceBitmap,
      32, 0, 32, 32,
      32, 0, 32, 32
    );
    expect(result.frames).toEqual([{
      id: 'frame-1',
      assetId: 'idle-atlas',
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      anchors: { ground: { x: 0.5, y: 1 } }
    }, {
      id: 'frame-2',
      assetId: 'idle-atlas',
      x: 32,
      y: 0,
      width: 32,
      height: 32,
      durationMs: 120,
      anchors: { ground: { x: 0.5, y: 1 } }
    }]);
    expect(result.sourceChecksums).toEqual({
      'idle-source': checksum(PNG_BYTES)
    });
    expect(result.geometry).toEqual({
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 }
    });
    expect(sourceBitmap.close).toHaveBeenCalledOnce();
  });

  test('只读取一次图集 Alpha 并联合不同帧的非透明范围', async () => {
    const sourceBitmap = bitmap(4, 2);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => sourceBitmap));
    const harness = createCanvasHarness();
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    // 两个 2×2 帧横向排布；首帧右上、次帧左下可见。
    rgba[(1 * 4) + 3] = 255;
    rgba[((1 * 4 + 2) * 4) + 3] = 255;
    vi.mocked(harness.context.getImageData).mockReturnValue({ data: rgba });

    const result = await compileAtlas({
      atlasAssetId: 'alpha-atlas',
      mimeType: 'image/png',
      groundAnchor: { x: 0.5, y: 1 },
      frames: [{
        frameId: 'first', sourceAssetId: 'source', bytes: PNG_BYTES,
        mimeType: 'image/png', sourceRect: { x: 0, y: 0, width: 2, height: 2 }
      }, {
        frameId: 'second', sourceAssetId: 'source', bytes: PNG_BYTES,
        mimeType: 'image/png', sourceRect: { x: 2, y: 0, width: 2, height: 2 }
      }]
    }, harness.factory);

    expect(harness.context.getImageData).toHaveBeenCalledOnce();
    expect(result.geometry).toEqual({
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 }
    });
  });

  test('不同尺寸单帧保持原始宽高绘制，不做拉伸', async () => {
    const firstBitmap = bitmap(20, 30);
    const secondBitmap = bitmap(40, 10);
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce(firstBitmap)
      .mockResolvedValueOnce(secondBitmap));
    const harness = createCanvasHarness(
      new Blob([WEBP_BYTES], { type: 'image/webp' })
    );

    const result = await compileAtlas({
      atlasAssetId: 'mixed-atlas',
      mimeType: 'image/webp',
      frames: [{
        frameId: 'small',
        sourceAssetId: 'small-source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }, {
        frameId: 'wide',
        sourceAssetId: 'wide-source',
        bytes: WEBP_BYTES,
        mimeType: 'image/webp',
        anchors: { ground: { x: 0.25, y: 0.9 } }
      }]
    }, harness.factory);

    expect(harness.context.drawImage).toHaveBeenNthCalledWith(
      1,
      firstBitmap,
      0, 0, 20, 30,
      0, 0, 20, 30
    );
    expect(harness.context.drawImage).toHaveBeenNthCalledWith(
      2,
      secondBitmap,
      0, 0, 40, 10,
      20, 0, 40, 10
    );
    expect(result).toMatchObject({
      pages: [{ mimeType: 'image/webp', width: 60, height: 30 }],
      frames: [{
        width: 20,
        height: 30
      }, {
        x: 20,
        width: 40,
        height: 10,
        anchors: { ground: { x: 0.25, y: 0.9 } }
      }],
      sourceChecksums: {
        'small-source': checksum(PNG_BYTES),
        'wide-source': checksum(WEBP_BYTES)
      }
    });
    expect(result.pages[0]!.bytes).toEqual(WEBP_BYTES);
    expect(firstBitmap.close).toHaveBeenCalledOnce();
    expect(secondBitmap.close).toHaveBeenCalledOnce();
  });

  test('每帧绘制前检查取消信号，并始终关闭已解码位图', async () => {
    const sourceBitmap = bitmap(32, 32);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => sourceBitmap));
    const controller = new AbortController();
    const harness = createCanvasHarness();
    vi.mocked(harness.context.drawImage).mockImplementationOnce(() => controller.abort());

    await expect(compileAtlas({
      atlasAssetId: 'cancel-atlas',
      mimeType: 'image/png',
      signal: controller.signal,
      frames: [{
        frameId: 'first',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }, {
        frameId: 'second',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }]
    }, harness.factory)).rejects.toMatchObject({ name: 'AbortError' });

    expect(harness.context.drawImage).toHaveBeenCalledTimes(1);
    expect(sourceBitmap.close).toHaveBeenCalledOnce();
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);
  });

  test('入口已取消时不解码、不创建画布且不产生临时资源', async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const controller = new AbortController();
    controller.abort();
    const harness = createCanvasHarness();

    await expect(compileAtlas({
      atlasAssetId: 'cancelled-before-start',
      mimeType: 'image/png',
      signal: controller.signal,
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }]
    }, harness.factory)).rejects.toMatchObject({ name: 'AbortError' });

    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(harness.factory).not.toHaveBeenCalled();
  });

  test('后续源解码失败时关闭此前已创建的位图', async () => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockRejectedValueOnce(new Error('TEST_DECODE_FAILED')));
    const harness = createCanvasHarness();

    await expect(compileAtlas({
      atlasAssetId: 'decode-failure',
      mimeType: 'image/png',
      frames: [{
        frameId: 'first',
        sourceAssetId: 'first',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }, {
        frameId: 'second',
        sourceAssetId: 'second',
        bytes: WEBP_BYTES,
        mimeType: 'image/webp'
      }]
    }, harness.factory)).rejects.toThrow('TEST_DECODE_FAILED');

    expect(decoded.close).toHaveBeenCalledOnce();
    expect(harness.factory).not.toHaveBeenCalled();
  });

  test('图集导出失败时关闭位图并释放画布', async () => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => decoded));
    const harness = createCanvasHarness(null);

    await expect(compileAtlas({
      atlasAssetId: 'export-failure',
      mimeType: 'image/png',
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }]
    }, harness.factory)).rejects.toThrow('CHARACTER_ATLAS_EXPORT_FAILED');

    expect(decoded.close).toHaveBeenCalledOnce();
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);
  });

  test.each([
    [
      new Blob([PNG_BYTES], { type: 'image/webp' }),
      'CHARACTER_ATLAS_MIME_MISMATCH'
    ],
    [
      new Blob([], { type: 'image/png' }),
      'CHARACTER_ATLAS_EMPTY_OUTPUT'
    ],
    [
      new Blob([WEBP_BYTES], { type: 'image/png' }),
      'CHARACTER_ATLAS_SIGNATURE_INVALID'
    ]
  ] as const)('拒绝 Canvas MIME、非空和 magic 不一致：%s', async (
    exportedBlob,
    expectedCode
  ) => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => decoded));
    const harness = createCanvasHarness(exportedBlob);

    await expect(compileAtlas({
      atlasAssetId: 'invalid-output',
      mimeType: 'image/png',
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }]
    }, harness.factory)).rejects.toThrow(expectedCode);

    expect(decoded.close).toHaveBeenCalledOnce();
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);
  });

  test('导出期间取消时关闭位图并释放画布', async () => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => decoded));
    const controller = new AbortController();
    const harness = createCanvasHarness();
    harness.canvas.toBlob = vi.fn(callback => {
      controller.abort();
      callback(new Blob([PNG_BYTES], { type: 'image/png' }));
    });

    await expect(compileAtlas({
      atlasAssetId: 'cancel-during-export',
      mimeType: 'image/png',
      signal: controller.signal,
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png'
      }]
    }, harness.factory)).rejects.toMatchObject({ name: 'AbortError' });

    expect(decoded.close).toHaveBeenCalledOnce();
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);
  });

  test.each([
    {
      name: '非法图集资源标识',
      atlasAssetId: '../atlas',
      frame: {}
    },
    {
      name: '非法帧时长',
      atlasAssetId: 'valid-atlas',
      frame: { durationMs: 0 }
    },
    {
      name: '越界 ground 锚点',
      atlasAssetId: 'valid-atlas',
      frame: { anchors: { ground: { x: 1.1, y: 1 } } }
    }
  ])('通过共享角色帧结构拒绝 $name', async ({ atlasAssetId, frame }) => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => decoded));
    const harness = createCanvasHarness();

    await expect(compileAtlas({
      atlasAssetId,
      mimeType: 'image/png',
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        ...frame
      }]
    }, harness.factory)).rejects.toThrow('CHARACTER_ATLAS_FRAME_INVALID');

    if (atlasAssetId === 'valid-atlas') {
      expect(decoded.close).toHaveBeenCalledOnce();
    }
    expect(harness.context.drawImage).not.toHaveBeenCalled();
  });

  test('源裁切矩形越过位图边界时拒绝编译且仍释放位图', async () => {
    const decoded = bitmap(16, 16);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => decoded));
    const harness = createCanvasHarness();

    await expect(compileAtlas({
      atlasAssetId: 'invalid-crop',
      mimeType: 'image/png',
      frames: [{
        frameId: 'only',
        sourceAssetId: 'source',
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        sourceRect: { x: 8, y: 8, width: 16, height: 16 }
      }]
    }, harness.factory)).rejects.toThrow('CHARACTER_FRAME_RECT_INVALID');

    expect(decoded.close).toHaveBeenCalledOnce();
    expect(harness.factory).not.toHaveBeenCalled();
  });
});
