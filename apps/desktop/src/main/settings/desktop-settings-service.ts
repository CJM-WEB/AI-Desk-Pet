import type { ModelProvider } from '@myself/agent-core';
import {
  providerCatalog,
  type ModelRouteConfig,
  type ProviderProfileV2
} from '@myself/shared-types';
import type {
  PrivacySettingsDto,
  SaveProviderProfileInput,
  SettingsDashboardDto
} from '../../shared/myself-api';
import type { PrivacySessionRegistry } from '../agent/disclosure-policy';
import type {
  CharacterBehaviorSettingsSnapshot,
  CharacterMovementMode,
  PrivacySettings
} from '../storage/settings-store';
import type { SecretSnapshot } from '../storage/secret-store';
import {
  localModelPublicStatusSchema,
  type LocalModelPublicStatus
} from '../../shared/local-model-ipc';

interface SettingsAccess {
  getProviderSettings(): Promise<{
    profiles: ProviderProfileV2[];
    route: ModelRouteConfig;
  }>;
  saveProviderProfile(profile: ProviderProfileV2): Promise<void>;
  deleteProviderProfile(profileId: string): Promise<void>;
  saveModelRoute(route: ModelRouteConfig): Promise<void>;
  getPrivacySettings(): Promise<PrivacySettings>;
  savePrivacySettings(settings: PrivacySettings): Promise<CharacterBehaviorSettingsSnapshot>;
  saveMovementMode(
    mode: CharacterMovementMode,
    isCurrent?: () => boolean
  ): Promise<CharacterBehaviorSettingsSnapshot | null>;
  getPetAlwaysOnTop(): Promise<boolean>;
  savePetAlwaysOnTop(enabled: boolean): Promise<void>;
  getPublic(): Promise<{
    authorizedRoot: SettingsDashboardDto['authorizedRoot'];
  }>;
  revokeAuthorizedRoot(): Promise<void>;
}

interface SecretAccess {
  save(profileId: string, secret: string, persist: boolean): Promise<void>;
  readForProviderCall(profileId?: string): Promise<string>;
  clear(profileId?: string): Promise<void>;
  snapshot(profileId: string): Promise<SecretSnapshot>;
  restore(profileId: string, snapshot: SecretSnapshot): Promise<void>;
}

interface ProviderAccess {
  create(
    profile: ProviderProfileV2,
    getSecret: () => Promise<string>
  ): ModelProvider;
}

/** 设置服务只拥有公开状态与切换动作，私有连接和 Runtime 生命周期留在 Main。 */
interface LocalModelSettingsAccess {
  getStatus(): LocalModelPublicStatus;
  setEnabled(enabled: boolean): Promise<void>;
}

export interface DesktopSettingsServiceOptions {
  settings: SettingsAccess;
  secrets: SecretAccess;
  providers: ProviderAccess;
  privacySessions: PrivacySessionRegistry;
  sessionId: string;
  localModel: LocalModelSettingsAccess;
  applyPetAlwaysOnTop(enabled: boolean): Promise<void> | void;
  applyCharacterBehaviorSettings(snapshot: CharacterBehaviorSettingsSnapshot): void;
}

export class DesktopSettingsService {
  private petAlwaysOnTopQueue: Promise<void> = Promise.resolve();
  private petAlwaysOnTopFrozen = false;
  private petAlwaysOnTopFlush: Promise<void> | undefined;

  constructor(private readonly options: DesktopSettingsServiceOptions) {}

  async getDashboard(): Promise<SettingsDashboardDto> {
    const [providerSettings, privacy, publicSettings, petAlwaysOnTop, localModel] = await Promise.all([
      this.options.settings.getProviderSettings(),
      this.options.settings.getPrivacySettings(),
      this.options.settings.getPublic(),
      this.options.settings.getPetAlwaysOnTop(),
      Promise.resolve(this.options.localModel.getStatus())
    ]);
    return {
      catalog: structuredClone(providerCatalog),
      profiles: providerSettings.profiles,
      route: providerSettings.route,
      privacy,
      privacyRuntimeSupport: {
        dataCategories: {
          file: true,
          memory: false
        },
        longTermMemory: false,
        proactivity: true
      },
      petAlwaysOnTop,
      // 在跨进程边界再次执行严格白名单校验，禁止未来接线把 Runtime 私有字段带入 Dashboard。
      localModel: localModelPublicStatusSchema.parse(localModel),
      authorizedRoot: publicSettings.authorizedRoot
    };
  }

  async saveProviderProfile(input: SaveProviderProfileInput): Promise<SettingsDashboardDto> {
    const existing = (await this.options.settings.getProviderSettings()).profiles.find(
      profile => profile.id === input.profile.id
    );
    const profile: ProviderProfileV2 = {
      ...input.profile,
      hasStoredSecret: input.secret !== undefined || existing?.hasStoredSecret === true
    };
    const secretSnapshot = input.secret === undefined
      ? undefined
      : await this.options.secrets.snapshot(profile.id);
    await this.options.settings.saveProviderProfile(profile);
    if (input.secret !== undefined && secretSnapshot) {
      try {
        await this.options.secrets.save(profile.id, input.secret, input.persistSecret);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          if (existing) {
            await this.options.settings.saveProviderProfile(existing);
          } else {
            await this.options.settings.deleteProviderProfile(profile.id);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await this.options.secrets.restore(profile.id, secretSnapshot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'PROVIDER_SAVE_ROLLBACK_FAILED');
        }
        throw error;
      }
    }
    return this.getDashboard();
  }

  async deleteProviderProfile(profileId: string): Promise<SettingsDashboardDto> {
    const providerSettings = await this.options.settings.getProviderSettings();
    const existing = providerSettings.profiles.find(profile => profile.id === profileId);
    const secretSnapshot = await this.options.secrets.snapshot(profileId);
    await this.options.settings.deleteProviderProfile(profileId);
    try {
      await this.options.secrets.clear(profileId);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (existing) {
        try {
          await this.options.settings.saveProviderProfile(existing);
          await this.options.settings.saveModelRoute(providerSettings.route);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await this.options.secrets.restore(profileId, secretSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'PROVIDER_DELETE_ROLLBACK_FAILED');
      }
      throw error;
    }
    return this.getDashboard();
  }

  async saveModelRoute(route: ModelRouteConfig): Promise<SettingsDashboardDto> {
    await this.options.settings.saveModelRoute(route);
    return this.getDashboard();
  }

  async setLocalModelEnabled(enabled: boolean): Promise<SettingsDashboardDto> {
    await this.options.localModel.setEnabled(enabled);
    return this.getDashboard();
  }

  async testProviderProfile(
    profileId: string
  ): Promise<{ ok: boolean; message: string }> {
    const profile = (await this.options.settings.getProviderSettings()).profiles.find(
      candidate => candidate.id === profileId
    );
    if (!profile || !profile.hasStoredSecret) {
      return { ok: false, message: '请先保存该档案的 API Key。' };
    }
    try {
      const provider = this.options.providers.create(
        profile,
        () => this.options.secrets.readForProviderCall(profile.id)
      );
      const result = await provider.respond({
        messages: [
          { role: 'system', content: '这是连接测试，只需返回简短文本。' },
          { role: 'user', content: '请回复“连接成功”。' }
        ],
        tools: [],
        toolChoice: 'none',
        reasoningMode: 'provider_default'
      }, AbortSignal.timeout(15_000));
      return result.type === 'text'
        ? { ok: true, message: '连接成功。' }
        : { ok: false, message: '模型服务响应格式不兼容。' };
    } catch {
      return { ok: false, message: '连接失败，请检查档案和网络。' };
    }
  }

  async savePrivacySettings(input: PrivacySettingsDto): Promise<SettingsDashboardDto> {
    const snapshot = await this.options.settings.savePrivacySettings(input);
    this.options.applyCharacterBehaviorSettings(snapshot);
    return this.getDashboard();
  }

  /** 此入口只供 Main 本地 Gate 使用，Renderer 不获得停止锁写权。 */
  async saveMovementMode(mode: CharacterMovementMode, isCurrent = () => true): Promise<void> {
    const snapshot = await this.options.settings.saveMovementMode(mode, isCurrent);
    if (snapshot === null || !isCurrent()) return;
    this.options.applyCharacterBehaviorSettings(snapshot);
  }

  /** 先提交运行态再落盘；任一步失败都把窗口层级恢复到旧值。 */
  savePetAlwaysOnTop(enabled: boolean): Promise<SettingsDashboardDto> {
    if (this.petAlwaysOnTopFrozen) {
      return Promise.reject(new Error('PET_ALWAYS_ON_TOP_FROZEN'));
    }
    const transaction = this.petAlwaysOnTopQueue.then(() => (
      this.commitPetAlwaysOnTop(enabled)
    ));
    this.petAlwaysOnTopQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  /** 退出前同步冻结入口，并等待此前已接收的置顶事务全部完成补偿。 */
  freezeAndFlushPetAlwaysOnTop(): Promise<void> {
    this.petAlwaysOnTopFrozen = true;
    this.petAlwaysOnTopFlush ??= this.petAlwaysOnTopQueue;
    return this.petAlwaysOnTopFlush;
  }

  private async commitPetAlwaysOnTop(enabled: boolean): Promise<SettingsDashboardDto> {
    const previous = await this.options.settings.getPetAlwaysOnTop();
    try {
      await this.options.applyPetAlwaysOnTop(enabled);
    } catch (error) {
      try {
        await this.options.applyPetAlwaysOnTop(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'PET_ALWAYS_ON_TOP_APPLY_ROLLBACK_FAILED'
        );
      }
      throw error;
    }
    try {
      await this.options.settings.savePetAlwaysOnTop(enabled);
    } catch (error) {
      try {
        await this.options.applyPetAlwaysOnTop(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'PET_ALWAYS_ON_TOP_PERSIST_ROLLBACK_FAILED'
        );
      }
      throw error;
    }
    return this.getDashboard();
  }

  async setIncognitoSession(incognito: boolean): Promise<{ incognito: boolean }> {
    this.options.privacySessions.register(this.options.sessionId, { incognito });
    return { incognito };
  }

  async revokeAuthorizedRoot(): Promise<SettingsDashboardDto> {
    await this.options.settings.revokeAuthorizedRoot();
    return this.getDashboard();
  }

  async close(): Promise<void> {
    this.options.privacySessions.unregister(this.options.sessionId);
  }
}
