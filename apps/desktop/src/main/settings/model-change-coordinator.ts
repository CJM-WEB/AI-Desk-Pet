import type { ModelRouteConfig, ProviderProfileV2, StoredProviderProfileV2 } from '@myself/shared-types';
import type { ProviderSettingsSnapshot } from '../storage/settings-store';

export type ModelConfiguration = ProviderSettingsSnapshot & Readonly<{ localModelEnabled: boolean }>;
export type ModelConfigurationChange =
  | Readonly<{ type: 'profile-save'; profile: StoredProviderProfileV2; activatePrimary?: true }>
  | Readonly<{ type: 'profile-delete'; profileId: string }>
  | Readonly<{ type: 'route'; route: ModelRouteConfig }>
  | Readonly<{ type: 'local'; enabled: boolean }>;

export interface ModelChangeCoordinatorOptions {
  readConfiguration(): Promise<ModelConfiguration>;
  confirmModelChange(signal: AbortSignal): Promise<boolean>;
  invalidateConfiguration(): Promise<void>;
  onModelChanged(): Promise<void>;
}

/** 只比较实际聊天与任务目标；名称、密钥、非活动档案和备用配置不是当前模型身份。 */
export function conversationModelIdentity(config: ModelConfiguration): string {
  if (config.localModelEnabled) return JSON.stringify(['builtin-local', 'builtin-local']);
  const identity = (profileId: string | null) => {
    const profile = config.profiles.find(candidate => candidate.id === profileId);
    if (!profile) return null;
    return profile.mode === 'preset'
      ? ['preset', profile.providerId, profile.modelId]
      : ['custom', profile.protocol, profile.baseUrl.replace(/\/+$/u, ''), profile.modelId];
  };
  return JSON.stringify([
    identity(config.route.chatProfileId ?? config.route.primaryProfileId),
    identity(config.route.agentProfileId ?? config.route.primaryProfileId)
  ]);
}

function previewConfiguration(before: ModelConfiguration, change: ModelConfigurationChange): ModelConfiguration {
  if (change.type === 'local') return { ...before, localModelEnabled: change.enabled };
  if (change.type === 'route') return { ...before, route: change.route };
  if (change.type === 'profile-save') {
    const existing = before.profiles.find(profile => profile.id === change.profile.id);
    const profile: ProviderProfileV2 = { ...change.profile, hasStoredSecret: existing?.hasStoredSecret ?? false };
    return { ...before, profiles: [...before.profiles.filter(item => item.id !== profile.id), profile],
      route: change.activatePrimary ? { ...before.route, primaryProfileId: profile.id } : before.route };
  }
  const route = before.route;
  return { ...before, profiles: before.profiles.filter(profile => profile.id !== change.profileId), route: {
    primaryProfileId: route.primaryProfileId === change.profileId ? null : route.primaryProfileId,
    chatProfileId: route.chatProfileId === change.profileId ? null : route.chatProfileId,
    agentProfileId: route.agentProfileId === change.profileId ? null : route.agentProfileId,
    visionProfileId: route.visionProfileId === change.profileId ? null : route.visionProfileId,
    fallbackProfileIds: route.fallbackProfileIds.filter(id => id !== change.profileId),
    allowCrossProviderFallback: route.allowCrossProviderFallback
  } };
}

/** 所有模型入口共用串行确认与提交边界；失败事实取实际路由，不能把已提交的本地故障当作未切换。 */
export class ModelChangeCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private changing = false;
  private closed = false;
  private confirmation: AbortController | null = null;
  private closePromise: Promise<void> | undefined;
  constructor(private readonly options: ModelChangeCoordinatorOptions) {}

  isChanging(): boolean { return this.changing; }

  /** 同步拒绝新事务并撤回未确认对话框；已开始提交的事务仍完成真实身份收尾。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.confirmation?.abort();
    this.closePromise = this.queue;
    return this.closePromise;
  }

  run<T>(change: ModelConfigurationChange, commit: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError());
    const transaction = this.queue.then(async () => {
      if (this.closed) throw this.closedError();
      const before = await this.options.readConfiguration();
      if (this.closed) throw this.closedError();
      const previousIdentity = conversationModelIdentity(before);
      if (conversationModelIdentity(previewConfiguration(before, change)) !== previousIdentity
        && !await this.confirm()) {
        throw Object.assign(new Error('MODEL_CHANGE_CANCELLED'), { code: 'MODEL_CHANGE_CANCELLED' });
      }
      if (this.closed) throw this.closedError();
      this.changing = true;
      try {
        await this.options.invalidateConfiguration();
        let result: T | undefined;
        let failure: unknown;
        try { result = await commit(); } catch (error) { failure = error; }
        try {
          if (conversationModelIdentity(await this.options.readConfiguration()) !== previousIdentity) {
            await this.options.onModelChanged();
          }
        } catch (error) {
          if (failure !== undefined) throw new AggregateError([failure, error], 'MODEL_CHANGE_FINALIZATION_FAILED');
          throw error;
        }
        if (failure !== undefined) throw failure;
        return result as T;
      } finally {
        this.changing = false;
      }
    });
    this.queue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  private async confirm(): Promise<boolean> {
    const controller = new AbortController();
    this.confirmation = controller;
    let cancel!: () => void;
    const cancelled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      // 原生窗口接收 signal 负责撤回；竞速还保证退出不依赖外部确认适配器遵守取消。
      return await Promise.race([this.options.confirmModelChange(controller.signal), cancelled]);
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      if (this.confirmation === controller) this.confirmation = null;
    }
  }

  private closedError(): Error {
    return Object.assign(new Error('MODEL_CHANGE_CLOSED'), { code: 'MODEL_CHANGE_CLOSED' });
  }
}
