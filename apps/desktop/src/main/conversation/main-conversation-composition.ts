import {
  ModelRouter,
  type ModelSelection
} from '@myself/agent-core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { taskApprovedCommandsSchema } from '@myself/shared-types';
import type {
  ProviderCatalogEntry,
  ProviderProfileV2,
  TaskEvent
} from '@myself/shared-types';
import { DisclosurePolicy, type PrivacySessionRegistry } from
  '../agent/disclosure-policy';
import type { ProviderSettingsSnapshot } from '../storage/settings-store';
import { resolveProviderProfile } from '../providers/provider-registry';
import {
  normalizeModelRoutePreflightError,
  settingsIncompleteError
} from '../settings/session-preflight';
import { ConversationCoordinator } from './conversation-coordinator';
import type { ConversationChatAdapter } from './conversation-chat-adapter';
import { ConversationDisclosureAdapter } from './conversation-disclosure-adapter';
import { ConversationHistory } from './conversation-history';
import {
  CapabilityTaskAdapter,
  type CapabilityTaskServicePort
} from './capability-task-adapter';
import type { CapabilityTaskKind } from './conversation-coordinator';
import type { CodingTaskToolResult } from '../agent/coding-task-service';
import type { ConversationBehaviorPort } from
  '../characters/character-behavior-director';
import type { CharacterBehaviorDirector } from '../characters/character-behavior-director';
import type { CharacterAutonomousRequest } from '../characters/character-proactivity-runtime';

export type MainConversationCodingTaskSnapshot<TPrivacy> = Readonly<{
  taskKind: CapabilityTaskKind;
  providerSettings: ProviderSettingsSnapshot;
  authorizedRootPath: string;
  privacySettings: TPrivacy;
  approvedCommands: readonly string[];
}>;

export interface MainConversationCodingTaskFactoryInput<TPrivacy> {
  snapshot: MainConversationCodingTaskSnapshot<TPrivacy>;
  generation: string;
  selection: ModelSelection;
  primaryProfile: ProviderProfileV2;
  fallbackProfiles: readonly ProviderProfileV2[];
  emit(event: TaskEvent): void;
  emitTrustedToolResult(result: CodingTaskToolResult): void;
}

export interface MainConversationCompositionOptions<TPrivacy> {
  catalog: readonly ProviderCatalogEntry[];
  privacySessions: PrivacySessionRegistry;
  sessionId: string;
  readProviderSettings(): Promise<ProviderSettingsSnapshot>;
  assertProviderReady?(profile: ProviderProfileV2): void;
  readAuthorizedRootPath(): Promise<string | null>;
  readPrivacySettings(): Promise<TPrivacy>;
  createChatAdapter(profile: ProviderProfileV2): ConversationChatAdapter;
  createCodingTaskService(
    input: MainConversationCodingTaskFactoryInput<TPrivacy>
  ): CapabilityTaskServicePort;
  behavior: ConversationBehaviorPort;
  autonomy?: Pick<CharacterBehaviorDirector, 'getActivityBlockers' | 'getBehaviorLifecycleGeneration' | 'applyAutonomousDecision' | 'applyBehaviorBindings'>;
  emit(event: TaskEvent): void;
}

export interface MainConversationComposition {
  coordinator: ConversationCoordinator;
  capabilityTasks: CapabilityTaskAdapter;
  requestAutonomousDecision(input: CharacterAutonomousRequest): Promise<void>;
  resetForConfigurationChange(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Main 会话深模块统一持有路由、披露、文件目标快照和关闭所有权。
 * Electron 平台层只需提供设置读取与 Provider/CodingTaskService 构造适配器。
 */
export function createMainConversationComposition<TPrivacy>(
  options: MainConversationCompositionOptions<TPrivacy>
): MainConversationComposition {
  const disclosureTargets = new Map<string, string>();
  const disclosurePolicy = new DisclosurePolicy({
    privacySessions: options.privacySessions,
    resolveProfileProvider: profileId => disclosureTargets.get(profileId) ?? null,
    resolveCurrentSourceProvider: () => null
  });
  let preparedCodingTaskSnapshot: MainConversationCodingTaskSnapshot<TPrivacy> | null = null;
  let preparedCodingTaskTarget: Readonly<{
    generation: string;
    taskKind: CapabilityTaskKind;
    selection: ModelSelection;
    primaryProfile: ProviderProfileV2;
    fallbackProfiles: readonly ProviderProfileV2[];
    capabilityRevision: string;
  }> | null = null;
  let activeCodingTaskRootPath: string | null = null;
  let closePromise: Promise<void> | null = null;
  let autonomousFlight: { controller: AbortController; signal: AbortSignal } | null = null;
  const invalidateAutonomy = () => { autonomousFlight?.controller.abort(); autonomousFlight = null; };
  const assertProviderReady = options.assertProviderReady ?? (profile => {
    if (!profile.hasStoredSecret) throw settingsIncompleteError();
  });

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
    assertProviderReady(profile);
    rememberTarget(selection);
    return {
      adapter: options.createChatAdapter(profile),
      profileId: selection.disclosureTarget.profileId,
      providerIdentity: selection.disclosureTarget.providerIdentity,
      providerName: profile.displayName
    };
  };

  const getAuthorizedRootPath = async (taskKind: CapabilityTaskKind): Promise<string | null> => {
    const [providerSettings, rootPath, privacySettings] =
      await Promise.all([
        options.readProviderSettings(),
        options.readAuthorizedRootPath(),
        options.readPrivacySettings()
      ]);
    const authorizedRootPath = rootPath === null ? null : await realpath(rootPath);
    const approvedCommands = authorizedRootPath === null ? [] : await projectCommands(authorizedRootPath);
    preparedCodingTaskSnapshot = authorizedRootPath === null
      ? null
      : Object.freeze({
          providerSettings,
          authorizedRootPath,
          taskKind,
          privacySettings,
          approvedCommands
        });
    if (activeCodingTaskRootPath !== null && activeCodingTaskRootPath !== authorizedRootPath) return null;
    return authorizedRootPath;
  };

  const createCodingTaskTarget = (input: {
    generation: string;
    taskKind: CapabilityTaskKind;
    emit: (event: TaskEvent) => void;
    emitTrustedToolResult: (result: CodingTaskToolResult) => void;
  }) => {
    const snapshot = preparedCodingTaskSnapshot;
    const descriptor = preparedCodingTaskTarget;
    preparedCodingTaskSnapshot = null;
    preparedCodingTaskTarget = null;
    if (!snapshot || !descriptor || descriptor.generation !== input.generation
      || descriptor.taskKind !== input.taskKind) throw settingsIncompleteError();
    const { selection, primaryProfile, fallbackProfiles, capabilityRevision } = descriptor;
    activeCodingTaskRootPath = snapshot.authorizedRootPath;
    rememberTarget(selection);
    return {
      service: options.createCodingTaskService({
        snapshot,
        generation: input.generation,
        selection,
        primaryProfile,
        fallbackProfiles,
        emit: input.emit,
        emitTrustedToolResult: input.emitTrustedToolResult
      }),
      profileId: selection.disclosureTarget.profileId,
      providerIdentity: selection.disclosureTarget.providerIdentity,
      providerName: primaryProfile.displayName,
      directory: snapshot.authorizedRootPath,
      modelId: primaryProfile.modelId,
      approvedCommands: snapshot.approvedCommands,
      capabilityRevision
    };
  };

  const createTargetSnapshot = (input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }) => {
    const snapshot = preparedCodingTaskSnapshot;
    if (!snapshot || snapshot.taskKind !== input.taskKind) throw settingsIncompleteError();
    const selection = select(snapshot.providerSettings, 'agent');
    const primaryProfile = selection.profile;
    assertProviderReady(primaryProfile);
    if (resolveProviderProfile(primaryProfile, options.catalog).protocol !== 'openai-compatible') {
      throw Object.assign(new Error('CODING_MODEL_PROTOCOL_UNSUPPORTED'), { code: 'CODING_MODEL_PROTOCOL_UNSUPPORTED' });
    }
    const fallbackProfiles: readonly ProviderProfileV2[] = [];
    const capabilityRevision = createHash('sha256').update(JSON.stringify({
      generation: input.generation,
      taskKind: snapshot.taskKind,
      authorizedRootPath: snapshot.authorizedRootPath,
      approvedCommands: snapshot.approvedCommands,
      providerSettings: snapshot.providerSettings
    })).digest('hex');
    preparedCodingTaskTarget = Object.freeze({
      generation: input.generation,
      taskKind: input.taskKind,
      selection,
      primaryProfile,
      fallbackProfiles,
      capabilityRevision
    });
    rememberTarget(selection);
    return Object.freeze({
      profileId: selection.disclosureTarget.profileId,
      providerIdentity: selection.disclosureTarget.providerIdentity,
      providerName: primaryProfile.displayName,
      directory: snapshot.authorizedRootPath,
      modelId: primaryProfile.modelId,
      approvedCommands: snapshot.approvedCommands,
      capabilityRevision
    });
  };

  const capabilityTasks = new CapabilityTaskAdapter({
    getAuthorizedRootPath,
    createTargetSnapshot,
    createCodingTaskTarget
  });
  const coordinator = new ConversationCoordinator({
    history: new ConversationHistory(),
    chatTurnFactory: { create: createChatTurn },
    disclosureAdapter: new ConversationDisclosureAdapter({
      sessionId: options.sessionId,
      privacySessions: options.privacySessions,
      disclosurePolicy
    }),
    capabilityTasks,
    behavior: options.behavior,
    emit: options.emit
  });

  return {
    coordinator,
    capabilityTasks,
    /** 当前聊天 Provider 的独立无工具请求；不经过会话消息、历史或任务路由。 */
    async requestAutonomousDecision(input): Promise<void> {
      const autonomy = options.autonomy;
      if (!autonomy || closePromise || input.signal.aborted || autonomousFlight && !autonomousFlight.signal.aborted) return;
      const controller = new AbortController();
      const current = { controller, signal: AbortSignal.any([input.signal, controller.signal]) };
      autonomousFlight = current;
      const lifecycle = autonomy.getBehaviorLifecycleGeneration();
      const context = options.behavior.captureExpressionContext();
      const behaviorContext = options.behavior.getChatContext();
      const isCurrent = () => {
        const blockers = autonomy.getActivityBlockers();
        return autonomousFlight === current && !current.signal.aborted && !closePromise
          && lifecycle === autonomy.getBehaviorLifecycleGeneration() && !blockers.closed
          && !blockers.chatting && !blockers.capabilityTask && !blockers.awaitingConfirmation && !blockers.dragging;
      };
      try {
        if (!context || !isCurrent()) return;
        const turn = await createChatTurn();
        if (!isCurrent()) return;
        const request = { behaviorContext, signal: current.signal, beforeProviderCall: () => isCurrent() && input.beforeProviderCall() };
        if (input.purpose === 'bindings') {
          const bindings = await turn.adapter.respondBindings(request);
          if (bindings && isCurrent()) autonomy.applyBehaviorBindings({ bindings, context, lifecycle });
        } else {
          const decision = await turn.adapter.respondAutonomous({ ...request, idleForMs: input.idleForMs });
          if (decision && isCurrent()) autonomy.applyAutonomousDecision({ ...decision, context, lifecycle, eventId: randomUUID() });
        }
      } finally {
        if (autonomousFlight === current) autonomousFlight = null;
      }
    },
    async resetForConfigurationChange(): Promise<void> {
      invalidateAutonomy();
      preparedCodingTaskSnapshot = null;
      preparedCodingTaskTarget = null;
      activeCodingTaskRootPath = null;
      await coordinator.resetConversation();
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      invalidateAutonomy();
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

/** 只列出当前项目确实存在的固定质量脚本；未知命令交由原 Core 具体许可。 */
async function projectCommands(directory: string): Promise<readonly string[]> {
  try {
    const packageInfo: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!packageInfo || typeof packageInfo !== 'object') return [];
    const scripts = Reflect.get(packageInfo, 'scripts');
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
    const manager = Reflect.get(packageInfo, 'packageManager');
    const executable = typeof manager === 'string' && manager.startsWith('pnpm@') ? 'pnpm.cmd' : typeof manager === 'string' && manager.startsWith('yarn@') ? 'yarn.cmd' : 'npm.cmd';
    return Object.freeze(taskApprovedCommandsSchema.parse(['build', 'test', 'typecheck', 'lint']
      .filter(name => typeof Reflect.get(scripts, name) === 'string' && Reflect.get(scripts, name).trim().length > 0)
      .map(name => `${executable} run ${name}`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}
