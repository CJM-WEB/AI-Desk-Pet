import {
  ModelRouter,
  type ModelSelection
} from '@myself/agent-core';
import type {
  ProviderCatalogEntry,
  ProviderProfileV2,
  TaskEvent
} from '@myself/shared-types';
import { DisclosurePolicy, type PrivacySessionRegistry } from
  '../agent/disclosure-policy';
import type { ProviderSettingsSnapshot } from '../storage/settings-store';
import {
  normalizeModelRoutePreflightError,
  settingsIncompleteError
} from '../settings/session-preflight';
import { ConversationCoordinator } from './conversation-coordinator';
import { ConversationDisclosureAdapter } from './conversation-disclosure-adapter';
import { ConversationHistory } from './conversation-history';
import type { ConversationTurnAdapter } from './conversation-turn-adapter';
import {
  FileTaskAdapter,
  type FileTaskAgentPort
} from './file-task-adapter';

export type MainConversationAgentSnapshot<TPrivacy, TReadTool> = Readonly<{
  providerSettings: ProviderSettingsSnapshot;
  authorizedRootPath: string;
  privacySettings: TPrivacy;
  enabledReadTools: readonly TReadTool[];
}>;

export interface MainConversationAgentFactoryInput<TPrivacy, TReadTool> {
  snapshot: MainConversationAgentSnapshot<TPrivacy, TReadTool>;
  selection: ModelSelection;
  primaryProfile: ProviderProfileV2;
  fallbackProfiles: readonly ProviderProfileV2[];
  emit(event: TaskEvent): void;
}

export interface MainConversationCompositionOptions<TPrivacy, TReadTool> {
  catalog: readonly ProviderCatalogEntry[];
  privacySessions: PrivacySessionRegistry;
  sessionId: string;
  readProviderSettings(): Promise<ProviderSettingsSnapshot>;
  readAuthorizedRootPath(): Promise<string | null>;
  readPrivacySettings(): Promise<TPrivacy>;
  readEnabledReadTools(): Promise<readonly TReadTool[]>;
  createChatAdapter(profile: ProviderProfileV2): ConversationTurnAdapter;
  createAgentService(
    input: MainConversationAgentFactoryInput<TPrivacy, TReadTool>
  ): FileTaskAgentPort;
  emit(event: TaskEvent): void;
}

export interface MainConversationComposition {
  coordinator: ConversationCoordinator;
  fileTasks: FileTaskAdapter;
  resetForConfigurationChange(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Main 会话深模块统一持有路由、披露、文件目标快照和关闭所有权。
 * Electron 平台层只需提供设置读取与 Provider/File Agent 构造适配器。
 */
export function createMainConversationComposition<TPrivacy, TReadTool>(
  options: MainConversationCompositionOptions<TPrivacy, TReadTool>
): MainConversationComposition {
  const disclosureTargets = new Map<string, string>();
  const disclosurePolicy = new DisclosurePolicy({
    privacySessions: options.privacySessions,
    resolveProfileProvider: profileId => disclosureTargets.get(profileId) ?? null,
    resolveCurrentSourceProvider: () => null
  });
  let preparedAgentSnapshot: MainConversationAgentSnapshot<TPrivacy, TReadTool> | null = null;
  let activeAgentRootPath: string | null = null;
  let closePromise: Promise<void> | null = null;

  const select = (
    providerSettings: ProviderSettingsSnapshot,
    requestKind: 'chat' | 'agent'
  ): ModelSelection => {
    try {
      const router = new ModelRouter({
        profiles: providerSettings.profiles,
        route: providerSettings.route,
        catalog: [...options.catalog]
      });
      return router.select(requestKind, {
        allowedCrossProviderProfileIds: providerSettings.route.allowCrossProviderFallback
          ? new Set(providerSettings.route.fallbackProfileIds)
          : new Set()
      });
    } catch (error) {
      throw normalizeModelRoutePreflightError(error);
    }
  };

  const createChatTurn = async () => {
    const providerSettings = await options.readProviderSettings();
    const selection = select(providerSettings, 'chat');
    const profile = selection.profile;
    if (!profile.hasStoredSecret) throw settingsIncompleteError();
    rememberTarget(selection);
    return {
      adapter: options.createChatAdapter(profile),
      profileId: selection.disclosureTarget.profileId,
      providerIdentity: selection.disclosureTarget.providerIdentity,
      providerName: profile.displayName
    };
  };

  const getAuthorizedRootPath = async (): Promise<string | null> => {
    const [providerSettings, authorizedRootPath, privacySettings, enabledReadTools] =
      await Promise.all([
        options.readProviderSettings(),
        options.readAuthorizedRootPath(),
        options.readPrivacySettings(),
        options.readEnabledReadTools()
      ]);
    preparedAgentSnapshot = authorizedRootPath === null
      ? null
      : Object.freeze({
          providerSettings,
          authorizedRootPath,
          privacySettings,
          enabledReadTools
        });
    if (activeAgentRootPath !== null && activeAgentRootPath !== authorizedRootPath) return null;
    return authorizedRootPath;
  };

  const createAgentTarget = (emit: (event: TaskEvent) => void) => {
    const snapshot = preparedAgentSnapshot;
    preparedAgentSnapshot = null;
    if (!snapshot) throw settingsIncompleteError();
    const selection = select(snapshot.providerSettings, 'agent');
    const primaryProfile = selection.profile;
    if (!primaryProfile.hasStoredSecret) throw settingsIncompleteError();
    const fallbackProfiles = sameProviderAgentFallbacks(
      snapshot.providerSettings,
      selection,
      options.catalog
    );
    activeAgentRootPath = snapshot.authorizedRootPath;
    rememberTarget(selection);
    return {
      service: options.createAgentService({
        snapshot,
        selection,
        primaryProfile,
        fallbackProfiles,
        emit
      }),
      profileId: selection.disclosureTarget.profileId,
      providerIdentity: selection.disclosureTarget.providerIdentity,
      providerName: primaryProfile.displayName
    };
  };

  const fileTasks = new FileTaskAdapter({
    getAuthorizedRootPath,
    createAgentTarget
  });
  const coordinator = new ConversationCoordinator({
    history: new ConversationHistory(),
    chatTurnFactory: { create: createChatTurn },
    disclosureAdapter: new ConversationDisclosureAdapter({
      sessionId: options.sessionId,
      privacySessions: options.privacySessions,
      disclosurePolicy
    }),
    fileTasks,
    emit: options.emit
  });

  return {
    coordinator,
    fileTasks,
    async resetForConfigurationChange(): Promise<void> {
      preparedAgentSnapshot = null;
      activeAgentRootPath = null;
      await coordinator.resetConversation();
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(async () => {
        let firstFailure: unknown;
        try {
          await coordinator.close();
        } catch (error) {
          firstFailure = error;
        }
        try {
          disclosurePolicy.dispose();
        } catch (error) {
          firstFailure ??= error;
        }
        if (firstFailure !== undefined) throw firstFailure;
      });
      return closePromise;
    }
  };

  function rememberTarget(selection: ModelSelection): void {
    disclosureTargets.set(
      selection.disclosureTarget.profileId,
      selection.disclosureTarget.providerIdentity
    );
  }
}

/** 使用 ModelRouter 解析每个候选目标，绝不复制 Provider identity 算法。 */
function sameProviderAgentFallbacks(
  providerSettings: ProviderSettingsSnapshot,
  selection: ModelSelection,
  catalog: readonly ProviderCatalogEntry[]
): ProviderProfileV2[] {
  return selection.fallbackProfiles.filter(profile => {
    const router = new ModelRouter({
      profiles: providerSettings.profiles,
      route: {
        ...providerSettings.route,
        agentProfileId: profile.id,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      catalog: [...catalog]
    });
    const candidate = router.select('agent', {
      allowedCrossProviderProfileIds: new Set()
    });
    return candidate.disclosureTarget.providerIdentity
      === selection.disclosureTarget.providerIdentity;
  });
}
