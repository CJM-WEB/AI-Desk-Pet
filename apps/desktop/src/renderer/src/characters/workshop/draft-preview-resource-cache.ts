import type {
  CharacterWorkshopApi
} from '../store/character-workshop-store';
import { imageMimeType } from '../import/image-decoder';
import {
  CHARACTER_RESOURCE_LIMITS,
  parseCharacterImageMetadata,
  planAtlas,
  type CharacterImageMetadata
} from '@myself/character-assets';
import type { ActionFrame } from '@myself/character-runtime';

export type DraftPreviewBundle = {
  urls: ReadonlyMap<string, string>;
  release(): void;
};

export type DraftFramePreviewBundle = DraftPreviewBundle & {
  frames: ActionFrame[];
};

type DraftPreviewEntry = {
  key: string;
  assetId: string;
  references: number;
  url: string | null;
  promise: Promise<string>;
  metadata: CharacterImageMetadata | null;
  largeSource: Blob | null;
};

type DraftPreviewCrop = {
  key: string;
  sourceAssetId: string;
  references: number;
  urls: Map<string, string>;
  frames: Map<number, Pick<ActionFrame, 'assetId' | 'x' | 'y'>>;
  promise: Promise<void>;
};

function cacheDestroyedError(): Error {
  return new Error('DRAFT_PREVIEW_CACHE_DESTROYED');
}

function abortError(): DOMException {
  return new DOMException('草稿预览资源加载已取消', 'AbortError');
}

/** 取消只结束当前等待，底层共享解码由引用数决定能否继续提交结果。 */
function waitFor<T>(loading: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    loading.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}

/**
 * 草稿预览缓存共享同一素材的读取，并以 bundle 引用计数管理 Blob URL。
 */
export class DraftPreviewResourceCache {
  private readonly entries = new Map<string, DraftPreviewEntry>();
  private readonly crops = new Map<string, DraftPreviewCrop>();
  private nextPageId = 0;
  private destroyed = false;

  constructor(
    private readonly api: Pick<CharacterWorkshopApi, 'readCharacterSource'>
  ) {}

  async load(
    characterId: string,
    assetIds: readonly string[],
    signal: AbortSignal
  ): Promise<DraftPreviewBundle> {
    if (this.destroyed) throw cacheDestroyedError();
    if (signal.aborted) throw abortError();

    const entries = [...new Set(assetIds)].map(assetId => (
      this.acquire(characterId, assetId)
    ));
    let transferredToBundle = false;

    try {
      const urls = new Map(await waitFor(Promise.all(entries.map(async entry => (
        [entry.assetId, await entry.promise] as const
      ))), signal));
      if (signal.aborted) throw abortError();
      if (this.destroyed) throw cacheDestroyedError();

      transferredToBundle = true;
      let released = false;
      return {
        urls,
        release: () => {
          if (released) return;
          released = true;
          for (const entry of entries) this.releaseEntry(entry);
        }
      };
    } finally {
      if (!transferredToBundle) {
        for (const entry of entries) this.releaseEntry(entry);
      }
    }
  }

  /** 大源图只把裁好的小页交给 GPU；映射仅作用于预览，编辑矩形保持原值。 */
  async loadFrames(
    characterId: string,
    frames: readonly ActionFrame[],
    signal: AbortSignal
  ): Promise<DraftFramePreviewBundle> {
    if (frames.some(frame => frame.width > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
      || frame.height > CHARACTER_RESOURCE_LIMITS.maxFrameDimension)) {
      throw new Error('CHARACTER_FRAME_DIMENSION_EXCEEDED');
    }
    const sourceBundle = await this.load(characterId, frames.map(frame => frame.assetId), signal);
    const crops: DraftPreviewCrop[] = [];
    let transferred = false;
    try {
      const urls = new Map(sourceBundle.urls);
      for (const assetId of urls.keys()) {
        const entry = this.entries.get(JSON.stringify([characterId, assetId]));
        if (!entry?.largeSource) continue;
        crops.push(this.acquireCrop(entry, frames.filter(frame => frame.assetId === assetId)));
        urls.delete(assetId);
      }
      await waitFor(Promise.all(crops.map(crop => crop.promise)), signal);
      if (this.destroyed) throw cacheDestroyedError();
      if (signal.aborted) throw abortError();
      const cropsByAsset = new Map(crops.map(crop => [crop.sourceAssetId, crop]));
      for (const crop of crops) {
        for (const [id, url] of crop.urls) urls.set(id, url);
      }
      const sourceFrameIndices = new Map<string, number>();
      const previewFrames = frames.map(frame => {
        const index = sourceFrameIndices.get(frame.assetId) ?? 0;
        sourceFrameIndices.set(frame.assetId, index + 1);
        return { ...frame, ...cropsByAsset.get(frame.assetId)?.frames.get(index) };
      });
      transferred = true;
      let released = false;
      return {
        urls,
        frames: previewFrames,
        release: () => {
          if (released) return;
          released = true;
          for (const crop of crops) this.releaseCrop(crop);
          sourceBundle.release();
        }
      };
    } finally {
      if (!transferred) {
        for (const crop of crops) this.releaseCrop(crop);
        sourceBundle.release();
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.revokeEntryUrl(entry);
    for (const crop of this.crops.values()) this.revokeCropUrls(crop);
    this.crops.clear();
  }

  private acquire(characterId: string, assetId: string): DraftPreviewEntry {
    const key = JSON.stringify([characterId, assetId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        assetId,
        references: 0,
        url: null,
        promise: Promise.resolve(''),
        metadata: null,
        largeSource: null
      };
      entry.promise = this.readEntry(entry, characterId);
      this.entries.set(key, entry);
    }
    entry.references += 1;
    return entry;
  }

  /**
   * 读取完成后再次核对条目身份，阻止取消或销毁后的晚到结果写回缓存。
   */
  private async readEntry(
    entry: DraftPreviewEntry,
    characterId: string
  ): Promise<string> {
    try {
      const bytes = await this.api.readCharacterSource(
        characterId,
        entry.assetId
      );
      if (this.destroyed) throw cacheDestroyedError();
      if (
        this.entries.get(entry.key) !== entry
        || entry.references === 0
      ) {
        throw new Error('DRAFT_PREVIEW_RESOURCE_RELEASED');
      }

      const mimeType = imageMimeType(bytes);
      entry.metadata = parseCharacterImageMetadata(bytes, mimeType, { purpose: 'source' });
      const blob = new Blob([
        Uint8Array.from(bytes).buffer
      ], { type: mimeType });
      if (entry.metadata.width > CHARACTER_RESOURCE_LIMITS.maxFrameDimension
        || entry.metadata.height > CHARACTER_RESOURCE_LIMITS.maxFrameDimension) {
        entry.largeSource = blob;
      }
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    } catch (error) {
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      }
      throw error;
    }
  }

  private acquireCrop(entry: DraftPreviewEntry, frames: readonly ActionFrame[]): DraftPreviewCrop {
    const key = JSON.stringify([entry.key, frames.map(frame => [
      frame.id, frame.x, frame.y, frame.width, frame.height
    ])]);
    const existing = this.crops.get(key);
    if (existing) {
      existing.references += 1;
      return existing;
    }
    const crop: DraftPreviewCrop = {
      key, sourceAssetId: entry.assetId, references: 1, urls: new Map(), frames: new Map(), promise: Promise.resolve()
    };
    this.crops.set(key, crop);
    crop.promise = this.renderCrop(crop, entry, frames);
    return crop;
  }

  private assertCropActive(crop: DraftPreviewCrop): void {
    if (this.destroyed) throw cacheDestroyedError();
    if (this.crops.get(crop.key) !== crop || crop.references === 0) {
      throw new Error('DRAFT_PREVIEW_RESOURCE_RELEASED');
    }
  }

  /** 共用分页布局但不扫描 alpha；逐页导出并清空画布，避免同时持有多页 RGBA。 */
  private async renderCrop(
    crop: DraftPreviewCrop,
    entry: DraftPreviewEntry,
    frames: readonly ActionFrame[]
  ): Promise<void> {
    const plans = planAtlas({ frames: frames.map((frame, index) => ({
      frameId: String(index), width: frame.width, height: frame.height
    })) });
    const bitmap = await createImageBitmap(entry.largeSource!);
    try {
      this.assertCropActive(crop);
      for (const frame of frames) {
        if (!Number.isSafeInteger(frame.x) || !Number.isSafeInteger(frame.y)
          || frame.x < 0 || frame.y < 0
          || frame.x + frame.width > bitmap.width
          || frame.y + frame.height > bitmap.height) {
          throw new Error('CHARACTER_FRAME_RECT_INVALID');
        }
      }
      for (const plan of plans) {
        this.assertCropActive(crop);
        const canvas = document.createElement('canvas');
        canvas.width = plan.width;
        canvas.height = plan.height;
        try {
          const context = canvas.getContext('2d');
          if (!context) throw new Error('DRAFT_PREVIEW_CANVAS_UNAVAILABLE');
          const assetId = `draft-preview-${++this.nextPageId}`;
          for (const placement of plan.placements) {
            const frameIndex = Number(placement.frameId);
            const frame = frames[frameIndex]!;
            const rect = placement.rect;
            context.drawImage(bitmap, frame.x, frame.y, frame.width, frame.height,
              rect.x, rect.y, rect.width, rect.height);
            crop.frames.set(frameIndex, { assetId, x: rect.x, y: rect.y });
          }
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(value => value
              ? resolve(value)
              : reject(new Error('DRAFT_PREVIEW_EXPORT_FAILED')), 'image/png');
          });
          this.assertCropActive(crop);
          crop.urls.set(assetId, URL.createObjectURL(blob));
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    } finally {
      bitmap.close();
    }
  }

  private releaseCrop(crop: DraftPreviewCrop): void {
    if (crop.references === 0) return;
    crop.references -= 1;
    if (crop.references > 0) return;
    if (this.crops.get(crop.key) === crop) this.crops.delete(crop.key);
    this.revokeCropUrls(crop);
  }

  private revokeCropUrls(crop: DraftPreviewCrop): void {
    for (const url of crop.urls.values()) URL.revokeObjectURL(url);
    crop.urls.clear();
  }

  private releaseEntry(entry: DraftPreviewEntry): void {
    if (entry.references === 0) return;
    entry.references -= 1;
    if (entry.references > 0) return;

    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    this.revokeEntryUrl(entry);
  }

  private revokeEntryUrl(entry: DraftPreviewEntry): void {
    entry.largeSource = null;
    if (!entry.url) return;
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}
