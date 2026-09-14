import {
  createPresentationAlphaGeometryAccumulator,
  planAtlas,
  type PresentationAlphaGeometry
} from '@myself/character-assets';
import {
  actionFrameSchema,
  type ActionFrame
} from '@myself/character-runtime';
import type {
  CharacterImageMimeType,
  ImageBitmapLike
} from './image-decoder';
import { decodeSource } from './image-decoder';

export type AtlasDrawContextLike = {
  drawImage(
    image: ImageBitmapLike,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number
  ): void;
  getImageData(
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number
  ): { data: Uint8ClampedArray };
};

export type AtlasCanvasLike = {
  width: number;
  height: number;
  getContext(type: '2d'): AtlasDrawContextLike | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type?: string
  ): void;
};

export type AtlasCanvasFactory = (
  width: number,
  height: number
) => AtlasCanvasLike;

export type AtlasSourceFrame = {
  frameId: string;
  sourceAssetId: string;
  bytes: Uint8Array;
  mimeType: CharacterImageMimeType;
  sourceRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  durationMs?: number;
  anchors?: ActionFrame['anchors'];
};

export type CompileAtlasInput = {
  atlasAssetId: string;
  mimeType: CharacterImageMimeType;
  frames: readonly AtlasSourceFrame[];
  groundAnchor?: { x: number; y: number };
  signal?: AbortSignal;
};

export type CompiledAtlasPage = {
  assetId: string;
  mimeType: CharacterImageMimeType;
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type CompiledAtlas = {
  pages: CompiledAtlasPage[];
  frames: ActionFrame[];
  sourceChecksums: Record<string, string>;
  geometry: PresentationAlphaGeometry;
};

type DecodedFrame = {
  input: AtlasSourceFrame;
  bitmap: ImageBitmapLike;
  sourceRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('操作已取消。', 'AbortError');
  }
}

function isValidRect(
  rect: DecodedFrame['sourceRect'],
  bitmap: ImageBitmapLike
): boolean {
  return Number.isSafeInteger(rect.x)
    && Number.isSafeInteger(rect.y)
    && Number.isSafeInteger(rect.width)
    && Number.isSafeInteger(rect.height)
    && rect.x >= 0
    && rect.y >= 0
    && rect.width > 0
    && rect.height > 0
    && rect.x + rect.width <= bitmap.width
    && rect.y + rect.height <= bitmap.height;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copied.buffer);
  return Array.from(new Uint8Array(digest), byte => (
    byte.toString(16).padStart(2, '0')
  )).join('');
}

function matchesOutputMagic(
  bytes: Uint8Array,
  mimeType: CharacterImageMimeType
): boolean {
  if (mimeType === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }
  return bytes.byteLength >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

function exportCanvas(
  canvas: AtlasCanvasLike,
  mimeType: CharacterImageMimeType
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('CHARACTER_ATLAS_EXPORT_FAILED'));
        return;
      }
      if (blob.type !== mimeType) {
        reject(new Error('CHARACTER_ATLAS_MIME_MISMATCH'));
        return;
      }
      if (blob.size === 0) {
        reject(new Error('CHARACTER_ATLAS_EMPTY_OUTPUT'));
        return;
      }
      void blob.arrayBuffer().then(
        buffer => {
          const bytes = new Uint8Array(buffer);
          if (!matchesOutputMagic(bytes, mimeType)) {
            reject(new Error('CHARACTER_ATLAS_SIGNATURE_INVALID'));
            return;
          }
          resolve(bytes);
        },
        () => reject(new Error('CHARACTER_ATLAS_EXPORT_FAILED'))
      );
    }, mimeType);
  });
}

function parseActionFrames(
  atlasAssetId: string,
  frames: ActionFrame[]
): ActionFrame[] {
  const parsed = actionFrameSchema.array().min(1).safeParse(frames);
  if (!parsed.success || parsed.data.some(frame => frame.assetId !== atlasAssetId)) {
    throw new Error('CHARACTER_ATLAS_FRAME_INVALID');
  }
  return parsed.data;

}

export async function compileAtlas(
  input: CompileAtlasInput,
  canvasFactory: AtlasCanvasFactory
): Promise<CompiledAtlas> {
  throwIfAborted(input.signal);
  // 先用共享角色结构验证图集资源标识，非法标识不触发任何图片解码。
  parseActionFrames(input.atlasAssetId, [{
    assetId: input.atlasAssetId,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    anchors: { ground: { x: 0.5, y: 1 } }
  }]);

  const bitmaps = new Map<string, ImageBitmapLike>();
  const sourceChecksums: Record<string, string> = {};
  const sourceFingerprints = new Map<string, string>();
  const checksumsByBytes = new WeakMap<Uint8Array, Promise<string>>();
  const decodedFrames: DecodedFrame[] = [];

  try {
    // 先完成全部解码与裁切校验，避免失败时留下半成品画布。
    for (const frame of input.frames) {
      throwIfAborted(input.signal);
      // 相同字节对象只计算一次摘要；同一资源标识换字节对象仍须校验冲突。
      let pendingChecksum = checksumsByBytes.get(frame.bytes);
      if (!pendingChecksum) {
        pendingChecksum = checksum(frame.bytes);
        checksumsByBytes.set(frame.bytes, pendingChecksum);
      }
      const fingerprint = `${frame.mimeType}:${await pendingChecksum}`;
      const knownFingerprint = sourceFingerprints.get(frame.sourceAssetId);
      if (knownFingerprint && knownFingerprint !== fingerprint) {
        throw new Error('CHARACTER_SOURCE_ASSET_CONFLICT');
      }
      sourceFingerprints.set(frame.sourceAssetId, fingerprint);
      sourceChecksums[frame.sourceAssetId] = fingerprint.slice(
        fingerprint.indexOf(':') + 1
      );

      let sourceBitmap = bitmaps.get(frame.sourceAssetId);
      if (!sourceBitmap) {
        sourceBitmap = await decodeSource(frame.bytes, frame.mimeType);
        bitmaps.set(frame.sourceAssetId, sourceBitmap);
      }
      const sourceRect = frame.sourceRect ?? {
        x: 0,
        y: 0,
        width: sourceBitmap.width,
        height: sourceBitmap.height
      };
      if (!isValidRect(sourceRect, sourceBitmap)) {
        throw new Error('CHARACTER_FRAME_RECT_INVALID');
      }
      decodedFrames.push({ input: frame, bitmap: sourceBitmap, sourceRect });
    }

    const layouts = planAtlas({
      frames: decodedFrames.map(frame => ({
        frameId: frame.input.frameId,
        width: frame.sourceRect.width,
        height: frame.sourceRect.height
      }))
    });
    const decodedById = new Map(decodedFrames.map(frame => [frame.input.frameId, frame]));
    const usedAssetIds = new Set([input.atlasAssetId]);
    const plans = layouts.map((layout, pageIndex) => {
      let assetId = input.atlasAssetId;
      if (pageIndex > 0) {
        let suffix = `-page-${pageIndex + 1}`;
        assetId = `${input.atlasAssetId.slice(0, 120 - suffix.length)}${suffix}`;
        // 截短后的页名不得与作者传入的首图集标识碰撞。
        if (usedAssetIds.has(assetId)) {
          suffix += '-2';
          assetId = `${input.atlasAssetId.slice(0, 120 - suffix.length)}${suffix}`;
        }
        usedAssetIds.add(assetId);
      }
      const frames = parseActionFrames(assetId, layout.placements.map(placement => {
        const decoded = decodedById.get(placement.frameId)!;
        return {
          id: decoded.input.frameId,
          assetId,
          ...placement.rect,
          ...(decoded.input.durationMs === undefined ? {} : { durationMs: decoded.input.durationMs }),
          anchors: { ground: { x: 0.5, y: 1 }, ...decoded.input.anchors }
        };
      }));
      return { assetId, layout, frames };
    });
    const frames = plans.flatMap(plan => plan.frames);
    const geometry = createPresentationAlphaGeometryAccumulator({
      groundAnchor: input.groundAnchor ?? { x: 0.5, y: 1 },
      frames
    });
    const pages: CompiledAtlasPage[] = [];
    let frameIndex = 0;
    for (const { assetId, layout } of plans) {
      throwIfAborted(input.signal);
      const canvas = canvasFactory(layout.width, layout.height);
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('CHARACTER_ATLAS_CONTEXT_UNAVAILABLE');
        // 每页独立绘制和扫描；源矩形与目标矩形同尺寸，禁止隐式缩放。
        for (const placement of layout.placements) {
          throwIfAborted(input.signal);
          const decoded = decodedById.get(placement.frameId)!;
          const source = decoded.sourceRect;
          context.drawImage(decoded.bitmap, source.x, source.y, source.width, source.height,
            placement.rect.x, placement.rect.y, source.width, source.height);
        }
        const rgba = context.getImageData(0, 0, layout.width, layout.height).data;
        if (rgba.length !== layout.width * layout.height * 4) {
          throw new Error('CHARACTER_ATLAS_ALPHA_INVALID');
        }
        const alpha = new Uint8Array(layout.width * layout.height);
        for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = rgba[pixel * 4 + 3]!;
        for (const placement of layout.placements) {
          throwIfAborted(input.signal);
          geometry.addFrame({ frameIndex: frameIndex++, sourceWidth: layout.width,
            sourceHeight: layout.height, sourceAlpha: alpha, sourceRect: placement.rect });
        }
        throwIfAborted(input.signal);
        const bytes = await exportCanvas(canvas, input.mimeType);
        throwIfAborted(input.signal);
        pages.push({ assetId, mimeType: input.mimeType, bytes, width: layout.width, height: layout.height });
      } finally {
        // 成功、取消和失败都在进入下一页之前释放当前画布。
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return { pages, frames, sourceChecksums, geometry: geometry.finish() };
  } finally {
    // 所有页完成或失败后统一关闭共享源位图。
    for (const bitmap of new Set(bitmaps.values())) bitmap.close();
  }
}
