import type {
  CharacterWorkshopApi
} from '../store/character-workshop-store';
import { imageMimeType } from '../import/image-decoder';

export type DraftPreviewBundle = {
  urls: ReadonlyMap<string, string>;
  release(): void;
};

type DraftPreviewEntry = {
  key: string;
  assetId: string;
  references: number;
  url: string | null;
  promise: Promise<string>;
};

function cacheDestroyedError(): Error {
  return new Error('DRAFT_PREVIEW_CACHE_DESTROYED');
}

function abortError(): DOMException {
  return new DOMException('草稿预览资源加载已取消', 'AbortError');
}

/**
 * 草稿预览缓存共享同一素材的读取，并以 bundle 引用计数管理 Blob URL。
 */
export class DraftPreviewResourceCache {
  private readonly entries = new Map<string, DraftPreviewEntry>();
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
      const urls = await this.waitForEntries(entries, signal);
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.revokeEntryUrl(entry);
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
        promise: Promise.resolve('')
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

      const blob = new Blob([
        Uint8Array.from(bytes).buffer
      ], { type: imageMimeType(bytes) });
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    } catch (error) {
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      }
      throw error;
    }
  }

  /**
   * 每个调用独立监听取消；底层共享读取继续由其余引用使用。
   */
  private waitForEntries(
    entries: readonly DraftPreviewEntry[],
    signal: AbortSignal
  ): Promise<ReadonlyMap<string, string>> {
    const loading = Promise.all(entries.map(async entry => (
      [entry.assetId, await entry.promise] as const
    )));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', handleAbort);
        callback();
      };
      const handleAbort = (): void => {
        finish(() => reject(abortError()));
      };

      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
      loading.then(
        urls => finish(() => resolve(new Map(urls))),
        error => finish(() => reject(error))
      );
    });
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
    if (!entry.url) return;
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}
