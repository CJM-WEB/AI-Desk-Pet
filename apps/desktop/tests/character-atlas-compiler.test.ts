import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  compileAtlas,
  type AtlasCanvasLike,
  type AtlasDrawContextLike
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
  vi.unstubAllGlobals();
});

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
      mimeType: 'image/webp',
      width: 60,
      height: 30,
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
    expect(result.bytes).toEqual(WEBP_BYTES);
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
