import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CharacterDraftV3,
  CharacterPlaybackView
} from '@myself/character-runtime';
import type {
  CharacterEvent,
  CharacterMigrationReview,
  CharacterMigrationResolution,
  CharacterPublishInput,
  CharacterRuntimeSnapshot,
  CharacterWorkshopSourceDto
} from '../../shared/character-ipc';
import type {
  CharacterAssetService,
  ImportedSource
} from './character-asset-service';
import type { CharacterPackageService } from './character-package-service';
import type { CharacterStore, CharacterSummary } from './character-store';

type CharacterStorePort = Pick<
  CharacterStore,
  | 'list'
  | 'create'
  | 'getDraft'
  | 'getMigrationReview'
  | 'saveDraft'
  | 'publishCompiled'
  | 'setActive'
  | 'getActive'
  | 'delete'
  | 'readActiveRuntimeAsset'
>;
type CharacterAssetPort = Pick<
  CharacterAssetService,
  'importSources' | 'listSources' | 'readSource'
>;
type CharacterPackagePort = Pick<
  CharacterPackageService,
  'importCharacter' | 'exportCharacter' | 'exportCharacterRecovery'
>;

export type CharacterActionsDependencies = {
  store: CharacterStorePort;
  assets: CharacterAssetPort;
  packages: CharacterPackagePort;
};

function stableCharacterErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^CHARACTER_[A-Z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return 'CHARACTER_OPERATION_FAILED';
}

/**
 * 角色应用服务只编排现有存储、素材和角色包服务，不复制其路径与完整性策略。
 */
export class CharacterActions {
  private readonly listeners = new Set<(event: CharacterEvent) => void>();

  constructor(private readonly dependencies: CharacterActionsDependencies) {}

  listCharacters(): Promise<CharacterSummary[]> {
    return this.dependencies.store.list();
  }

  async createCharacter(input: { name: string }): Promise<CharacterDraftV3> {
    const characterId = randomUUID();
    await this.dependencies.store.create({ id: characterId, name: input.name });
    const draft = await this.dependencies.store.getDraft(characterId);
    this.emit({ type: 'index-changed' });
    return draft;
  }

  async duplicateCharacter(characterId: string): Promise<CharacterDraftV3> {
    const packagePath = join(
      tmpdir(),
      `ai-pet-character-copy-${randomUUID()}.zip`
    );
    try {
      await this.dependencies.packages.exportCharacter(characterId, packagePath);
      const duplicateId = await this.dependencies.packages.importCharacter(packagePath);
      const draft = await this.dependencies.store.getDraft(duplicateId);
      this.emit({ type: 'index-changed' });
      return draft;
    } finally {
      await rm(packagePath, { force: true }).catch(() => undefined);
    }
  }

  getCharacterDraft(characterId: string): Promise<CharacterDraftV3> {
    return this.dependencies.store.getDraft(characterId);
  }

  getCharacterMigrationReview(characterId: string): Promise<CharacterMigrationReview> {
    return this.dependencies.store.getMigrationReview(characterId);
  }

  async saveCharacterDraft(
    characterId: string,
    draft: CharacterDraftV3,
    draftRevision: string,
    migrationResolutions?: readonly CharacterMigrationResolution[]
  ): Promise<void> {
    await this.dependencies.store.saveDraft(characterId, draft, draftRevision, migrationResolutions);
    this.emit({ type: 'index-changed' });
  }

  chooseCharacterSources(
    characterId: string,
    selectedPaths: readonly string[]
  ): Promise<ImportedSource[]> {
    return this.dependencies.assets.importSources(characterId, selectedPaths);
  }

  async listCharacterSources(
    characterId: string
  ): Promise<CharacterWorkshopSourceDto[]> {
    return (await this.dependencies.assets.listSources(characterId)).map(
      ({ assetId, displayName, mimeType }) => ({ assetId, displayName, mimeType })
    );
  }

  readCharacterSource(characterId: string, assetId: string): Promise<Uint8Array> {
    return this.dependencies.assets.readSource(characterId, assetId);
  }

  async publishCharacter(input: CharacterPublishInput): Promise<void> {
    const resourcesById = new Map(
      input.manifest.resources.map(resource => [resource.assetId, resource])
    );
    const assets: Record<string, Uint8Array> = {};
    for (const resource of input.resources) {
      const manifestResource = resourcesById.get(resource.assetId);
      if (!manifestResource || manifestResource.fileName in assets) {
        throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
      }
      assets[manifestResource.fileName] = resource.bytes;
    }

    try {
      await this.dependencies.store.publishCompiled(
        input.characterId,
        input.manifest,
        assets,
        input.draftRevision
      );
      this.emit({
        type: 'compile-result',
        characterId: input.characterId,
        ok: true
      });
      this.emit({ type: 'index-changed' });
    } catch (error) {
      this.emit({
        type: 'compile-result',
        characterId: input.characterId,
        ok: false,
        errorCode: stableCharacterErrorCode(error)
      });
      throw error;
    }
  }

  async activateCharacter(
    characterId: string,
    confirmIncomplete = false
  ): Promise<void> {
    if (confirmIncomplete) {
      await this.dependencies.store.setActive(characterId, true);
    } else {
      await this.dependencies.store.setActive(characterId);
    }
    this.emit({ type: 'active-character-changed', characterId });
    this.emit({ type: 'index-changed' });
  }

  async deleteCharacter(characterId: string): Promise<void> {
    await this.dependencies.store.delete(characterId);
    this.emit({ type: 'index-changed' });
  }

  async importCharacterPackage(packagePath: string): Promise<string> {
    const characterId = await this.dependencies.packages.importCharacter(packagePath);
    this.emit({ type: 'index-changed' });
    return characterId;
  }

  async exportCharacterPackage(
    characterId: string,
    destination: string
  ): Promise<'exported' | 'recovery-exported'> {
    try {
      await this.dependencies.packages.exportCharacter(characterId, destination);
      return 'exported';
    } catch (error) {
      const migrationFailed = error instanceof Error && (
        error.message === 'CHARACTER_MIGRATION_FAILED'
        || error.message === 'CHARACTER_VERSION_UNSUPPORTED'
      );
      if (!migrationFailed) throw error;
      await this.dependencies.packages.exportCharacterRecovery(
        characterId,
        destination
      );
      return 'recovery-exported';
    }
  }

  async getCharacterRuntimeSnapshot(): Promise<CharacterRuntimeSnapshot | null> {
    try {
      const manifest = await this.dependencies.store.getActive();
      return {
        activeCharacterId: manifest.id,
        manifest
      };
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'CHARACTER_RUNTIME_UNAVAILABLE'
      ) {
        return null;
      }
      throw error;
    }
  }

  readCharacterRuntimeAsset(assetId: string): Promise<Uint8Array> {
    return this.dependencies.store.readActiveRuntimeAsset(assetId);
  }

  subscribeCharacterEvents(listener: (event: CharacterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CharacterEvent): void {
    // 事件属于提交后的 UI 通知，单个观察者故障不得改变领域操作结果。
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 继续通知其余观察者；Main 层负责记录具体窗口发送故障。
      }
    }
  }
}
