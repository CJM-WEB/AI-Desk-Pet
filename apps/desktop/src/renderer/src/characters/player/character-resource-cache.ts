import type { CharacterRuntimeSnapshot } from '../../../../shared/character-ipc';

export type CharacterAssetBundle = {
  characterId: string;
  atlasUrls: ReadonlyMap<string, string>;
};

export type CharacterAssetLoadContext = {
  snapshot: CharacterRuntimeSnapshot;
};

export type CharacterAssetLoader = (
  characterId: string,
  signal: AbortSignal,
  context?: CharacterAssetLoadContext
) => Promise<CharacterAssetBundle>;

export type CharacterAssetDestroyer = (bundle: CharacterAssetBundle) => void;

export type CharacterActivationOptions = {
  forceReload?: boolean;
  context?: CharacterAssetLoadContext;
};

/**
 * 资源缓存只持有当前活动角色。修订号与 AbortSignal 共同阻止慢请求覆盖新角色。
 */
export class CharacterResourceCache {
  private activeBundle: CharacterAssetBundle | null = null;
  private activationRevision = 0;
  private activationController: AbortController | null = null;

  constructor(
    private readonly loader: CharacterAssetLoader,
    private readonly destroyer: CharacterAssetDestroyer
  ) {}

  get activeCharacterId(): string | null {
    return this.activeBundle?.characterId ?? null;
  }

  get current(): CharacterAssetBundle | null {
    return this.activeBundle;
  }

  async activate(
    characterId: string,
    options: CharacterActivationOptions = {}
  ): Promise<CharacterAssetBundle | null> {
    if (this.activeBundle?.characterId === characterId && !options.forceReload) {
      return this.activeBundle;
    }

    const revision = ++this.activationRevision;
    this.activationController?.abort();
    const controller = new AbortController();
    this.activationController = controller;

    let loaded: CharacterAssetBundle;
    try {
      loaded = await this.loader(characterId, controller.signal, options.context);
    } catch (error) {
      if (controller.signal.aborted || revision !== this.activationRevision) {
        return null;
      }
      throw error;
    }

    if (
      controller.signal.aborted
      || revision !== this.activationRevision
      || loaded.characterId !== characterId
    ) {
      this.destroyer(loaded);
      return null;
    }

    const previous = this.activeBundle;
    this.activeBundle = loaded;
    if (previous && previous !== loaded) {
      this.destroyer(previous);
    }
    return loaded;
  }

  destroy(): void {
    ++this.activationRevision;
    this.activationController?.abort();
    this.activationController = null;
    if (this.activeBundle) {
      this.destroyer(this.activeBundle);
      this.activeBundle = null;
    }
  }
}

export function destroyCharacterAssetBundle(bundle: CharacterAssetBundle): void {
  if (typeof URL.revokeObjectURL !== 'function') return;
  for (const url of new Set(bundle.atlasUrls.values())) {
    URL.revokeObjectURL(url);
  }
}
