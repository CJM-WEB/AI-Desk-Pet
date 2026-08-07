import { planAtlas } from '@myself/character-assets';
import {
  characterManifestV1Schema,
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
  signal?: AbortSignal;
};

export type CompiledAtlas = {
  mimeType: CharacterImageMimeType;
  bytes: Uint8Array;
  width: number;
  height: number;
  frames: ActionFrame[];
  sourceChecksums: Record<string, string>;
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
  mimeType: CharacterImageMimeType,
  frames: ActionFrame[]
): ActionFrame[] {
  const parsed = characterManifestV1Schema.safeParse({
    version: 1,
    id: 'atlas-validation',
    name: '图集结构验证',
    thumbnailAssetId: atlasAssetId,
    compilerVersion: 'character-atlas-compiler-v1',
    resources: [{
      assetId: atlasAssetId,
      fileName: `${atlasAssetId}.${mimeType === 'image/png' ? 'png' : 'webp'}`,
      sha256: '0'.repeat(64),
      byteLength: 1
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'atlas-validation',
        name: '图集结构验证',
        fps: 1,
        loop: false,
        weight: 1,
        anchors: { ground: { x: 0.5, y: 1 } },
        frames
      }]
    }]
  });
  if (!parsed.success) {
    throw new Error('CHARACTER_ATLAS_FRAME_INVALID');
  }
  return parsed.data.states[0]!.actions[0]!.frames;
}

export async function compileAtlas(
  input: CompileAtlasInput,
  canvasFactory: AtlasCanvasFactory
): Promise<CompiledAtlas> {
  throwIfAborted(input.signal);
  // 先用共享角色结构验证图集资源标识，非法标识不触发任何图片解码。
  parseActionFrames(input.atlasAssetId, input.mimeType, [{
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
  const decodedFrames: DecodedFrame[] = [];
  let canvas: AtlasCanvasLike | undefined;

  try {
    // 先完成全部解码与裁切校验，避免失败时留下半成品画布。
    for (const frame of input.frames) {
      throwIfAborted(input.signal);
      const fingerprint = `${frame.mimeType}:${await checksum(frame.bytes)}`;
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

    const layout = planAtlas({
      frames: decodedFrames.map(frame => ({
        frameId: frame.input.frameId,
        width: frame.sourceRect.width,
        height: frame.sourceRect.height
      }))
    });
    canvas = canvasFactory(layout.width, layout.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('CHARACTER_ATLAS_CONTEXT_UNAVAILABLE');

    const candidateFrames: ActionFrame[] = decodedFrames.map((decoded, index) => {
      const placement = layout.placements[index]!;
      const source = decoded.sourceRect;
      const destination = placement.rect;
      return {
        id: decoded.input.frameId,
        assetId: input.atlasAssetId,
        x: destination.x,
        y: destination.y,
        width: source.width,
        height: source.height,
        ...(decoded.input.durationMs === undefined
          ? {}
          : { durationMs: decoded.input.durationMs }),
        anchors: {
          ground: { x: 0.5, y: 1 },
          ...decoded.input.anchors
        }
      };
    });
    // 最终帧尺寸、时长和锚点统一通过共享 ActionFrame 所属结构解析。
    const frames = parseActionFrames(
      input.atlasAssetId,
      input.mimeType,
      candidateFrames
    );

    // 布局由共享包统一规划；源矩形和目标矩形保持同尺寸，禁止隐式拉伸。
    for (const [index, decoded] of decodedFrames.entries()) {
      throwIfAborted(input.signal);
      const source = decoded.sourceRect;
      const destination = layout.placements[index]!.rect;
      context.drawImage(
        decoded.bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        destination.x,
        destination.y,
        source.width,
        source.height
      );
    }

    throwIfAborted(input.signal);
    const bytes = await exportCanvas(canvas, input.mimeType);
    throwIfAborted(input.signal);
    return {
      mimeType: input.mimeType,
      bytes,
      width: layout.width,
      height: layout.height,
      frames,
      sourceChecksums
    };
  } finally {
    // 成功、取消和异常都释放浏览器原生位图与临时画布内存。
    for (const bitmap of new Set(bitmaps.values())) bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
