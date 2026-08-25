import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import { providerCatalog, type ProviderProfileV2, type TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { ConversationChatAdapter } from
  '../src/main/conversation/conversation-chat-adapter';
import {
  createMainConversationComposition,
  type MainConversationAgentFactoryInput
} from '../src/main/conversation/main-conversation-composition';
import type { ConversationBehaviorPort } from
  '../src/main/characters/character-behavior-director';
import {
  BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY,
  createLocalModelRoutingSnapshot
} from '../src/main/local-model/local-model-route';
import { assertProviderReady } from '../src/main/settings/session-preflight';
import type { ProviderSettingsSnapshot } from '../src/main/storage/settings-store';

function behaviorDouble(): ConversationBehaviorPort {
  return {
    prepareUserPrompt: vi.fn(async text => ({
      originalText: text,
      capabilityText: text,
      explicitDirective: null
    })),
    getChatContext: vi.fn(() => ({
      character: {
        characterName: '测试角色', semantics: ['idle'] as const,
        stateNames: [], actionNames: [], tags: []
      },
      runtime: {
        moving: false, dragging: false, carrying: false, movementStopped: false
      },
      proactivityMode: 'assistive' as const,
      recentActions: []
    })),
    completeUserPrompt: vi.fn(),
    handleTaskEvent: vi.fn(),
    applyPlaybackFeedback: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}

function profile(id: string, baseUrl: string): ProviderProfileV2 {
  return {
    id,
    displayName: id,
    modelId: 'model-test',
    hasStoredSecret: true,
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl,
    additionalParameters: {},
    capabilities: ['chat', 'tools']
  };
}

const primary = profile('primary', 'https://same.example/v1');
const sameProviderFallback = profile('same-fallback', 'https://same.example/v1/');
const crossProviderFallback = profile('cross-fallback', 'https://cross.example/v1');
const localReadinessCases = [
  ['loading', 'LOCAL_MODEL_LOADING'],
  ['faulted', 'LOCAL_MODEL_FAULTED'],
  ['disabled', 'LOCAL_MODEL_DISABLED']
] as const;

function localStatus(phase: typeof localReadinessCases[number][0]) {
  return {
    enabled: phase !== 'disabled',
    phase,
    backend: null,
    reasonCode: phase === 'faulted' ? 'CPU_START_FAILED' as const : null
  };
}

function providerWith(response: ModelResponse | Promise<ModelResponse>): ModelProvider {
  return {
    respond: vi.fn(async (_request: ModelRequest) => response)
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function agentDouble(overrides: Record<string, unknown> = {}) {
  return {
    submitFileTask: vi.fn(async () => ({ kind: 'completed', acted: false } as const)),
    cancelActive: vi.fn(),
    confirm: vi.fn(async () => undefined),
    cancelAction: vi.fn(),
    resetForNewConversation: vi.fn(async () => undefined),
    close: vi.fn(),
    ...overrides
  };
}

function baseOptions(input: {
  chatResponse?: ModelResponse | Promise<ModelResponse>;
  assertProviderReady?: (profile: ProviderProfileV2) => void;
  catalog?: typeof providerCatalog;
  createAgent?: (factory: MainConversationAgentFactoryInput<
    { dataCategories: { file: boolean } }
  >) => ReturnType<typeof agentDouble>;
} = {}) {
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('desktop-session', { incognito: false });
  const providerSettings: ProviderSettingsSnapshot = {
    profiles: [primary, sameProviderFallback, crossProviderFallback],
    route: {
      primaryProfileId: primary.id,
      chatProfileId: primary.id,
      agentProfileId: primary.id,
      visionProfileId: null,
      fallbackProfileIds: [sameProviderFallback.id, crossProviderFallback.id],
      allowCrossProviderFallback: true
    }
  };
  const readProviderSettings = vi.fn(async () => providerSettings);
  const readAuthorizedRootPath = vi.fn(async () => 'D:\\authorized');
  const privacySettings = { dataCategories: { file: true } };
  const readPrivacySettings = vi.fn(async () => privacySettings);
  const factoryInputs: Array<MainConversationAgentFactoryInput<
    typeof privacySettings
  >> = [];
  const createdAgentProfiles: string[] = [];
  const createAgentService = vi.fn((factoryInput: MainConversationAgentFactoryInput<
    typeof privacySettings
  >) => {
    factoryInputs.push(factoryInput);
    createdAgentProfiles.push(factoryInput.primaryProfile.id);
    createdAgentProfiles.push(...factoryInput.fallbackProfiles.map(item => item.id));
    return input.createAgent?.(factoryInput) ?? agentDouble();
  });
  const events: TaskEvent[] = [];
  const behavior = behaviorDouble();
  const options = {
    catalog: input.catalog ?? [],
    privacySessions,
    sessionId: 'desktop-session',
    readProviderSettings,
    readAuthorizedRootPath,
    readPrivacySettings,
    assertProviderReady: input.assertProviderReady ?? (profile => {
      if (!profile.hasStoredSecret) throw Object.assign(new Error('SETTINGS_INCOMPLETE'), {
        code: 'SETTINGS_INCOMPLETE'
      });
    }),
    createChatAdapter: () => new ConversationChatAdapter(providerWith(
      input.chatResponse ?? {
        type: 'text',
        text: '你好'
      }
    )),
    createAgentService,
    behavior,
    emit: (event: TaskEvent) => events.push(event)
  };
  const composition = createMainConversationComposition(options);
  return {
    composition,
    behavior,
    createdAgentProfiles,
    events,
    factoryInputs,
    options,
    privacySettings,
    providerSettings,
    readAuthorizedRootPath,
    readPrivacySettings,
    readProviderSettings
  };
}

describe('Main 会话组合模块', () => {
  test('普通聊天只读模型设置且不会触碰授权或文件 Agent 工厂', async () => {
    const harness = baseOptions();

    await harness.composition.coordinator.submit('你好');

    expect(harness.readProviderSettings).toHaveBeenCalledOnce();
    expect(harness.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(harness.readPrivacySettings).not.toHaveBeenCalled();
    expect(harness.factoryInputs).toHaveLength(0);
    expect(harness.behavior.prepareUserPrompt).toHaveBeenCalledExactlyOnceWith('你好');
    expect(harness.behavior.getChatContext).toHaveBeenCalledOnce();
    expect(harness.behavior.completeUserPrompt).toHaveBeenCalledExactlyOnceWith({
      generation: expect.any(String),
      explicitDirective: null,
      motionPlan: null,
      providerPlan: null
    });
    await harness.composition.close();
    expect(harness.behavior.close).toHaveBeenCalledOnce();
  });

  test('文件 Agent 与元数据消费同一设置快照并只创建同源 fallback', async () => {
    const harness = baseOptions();

    const target = await harness.composition.capabilityTasks.prepareTarget({ generation: 'generation-1', taskKind: 'file' });

    expect(target).toEqual({
      profileId: 'primary',
      providerIdentity: 'custom:openai-compatible:https://same.example/v1',
      providerName: 'primary',
      capabilityRevision: expect.any(String)
    });
    expect(harness.createdAgentProfiles).toEqual(['primary', 'same-fallback']);
    expect(harness.createdAgentProfiles).not.toContain('cross-fallback');
    expect(harness.factoryInputs[0]?.snapshot).toEqual({
      providerSettings: harness.providerSettings,
      authorizedRootPath: 'D:\\authorized',
      taskKind: 'file',
      privacySettings: harness.privacySettings
    });
    expect(harness.options).not.toHaveProperty('readEnabledReadTools');
    await harness.composition.close();
  });

  test('PowerShell 能力目标只把 PowerShell taskKind 交给同一 Agent 工厂', async () => {
    const harness = baseOptions();

    await harness.composition.capabilityTasks.prepareTarget({
      generation: 'generation-shell',
      taskKind: 'powershell'
    });

    expect(harness.factoryInputs[0]?.snapshot.taskKind).toBe('powershell');
    expect(harness.factoryInputs[0]?.generation).toBe('generation-shell');
    await harness.composition.close();
  });

  test('配置重置撤销旧目标并允许从新授权快照重新创建', async () => {
    const harness = baseOptions();
    await harness.composition.capabilityTasks.prepareTarget({ generation: 'generation-old', taskKind: 'file' });
    harness.readAuthorizedRootPath.mockResolvedValue('E:\\new-root');

    await harness.composition.resetForConfigurationChange();
    await expect(harness.composition.capabilityTasks.prepareTarget({ generation: 'generation-new', taskKind: 'file' }))
      .resolves.toMatchObject({ profileId: 'primary' });

    expect(harness.factoryInputs).toHaveLength(2);
    await harness.composition.close();
  });

  test.each(localReadinessCases)('本地档案处于 %s 时抛出稳定就绪错误且不要求 Secret', (phase, code) => {
    const localProfile = createLocalModelRoutingSnapshot(
      { profiles: [primary], route: {
        primaryProfileId: primary.id,
        chatProfileId: primary.id,
        agentProfileId: primary.id,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      } },
      true
    ).profiles.at(-1)!;

    expect(localProfile.hasStoredSecret).toBe(false);
    expect(() => assertProviderReady(localProfile, localStatus(phase)))
      .toThrowError(expect.objectContaining({ code }));
  });

  test.each(localReadinessCases)('本地 %s 就绪错误穿过会话公开边界后仍保持稳定代码', async (phase, code) => {
    const harness = baseOptions({
      catalog: [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
      assertProviderReady: profile => assertProviderReady(profile, localStatus(phase))
    });
    harness.readProviderSettings.mockResolvedValue(
      createLocalModelRoutingSnapshot(harness.providerSettings, true)
    );

    await expect(harness.composition.coordinator.submit('本地聊天'))
      .rejects.toMatchObject({ code });
    await harness.composition.close();
  });

  test.each(localReadinessCases)('本地 Agent 在 %s 时也拒绝创建且保持稳定代码', async (phase, code) => {
    const harness = baseOptions({
      catalog: [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
      assertProviderReady: profile => assertProviderReady(profile, localStatus(phase))
    });
    harness.readProviderSettings.mockResolvedValue(
      createLocalModelRoutingSnapshot(harness.providerSettings, true)
    );

    await expect(harness.composition.capabilityTasks.prepareTarget({
      generation: 'generation-local-not-ready',
      taskKind: 'file'
    })).rejects.toMatchObject({ code });
    expect(harness.factoryInputs).toHaveLength(0);
    await harness.composition.close();
  });

  test('本地 Runtime ready 时无 Secret 也可进入会话，云档案仍要求 Secret', async () => {
    const harness = baseOptions({
      catalog: [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
      assertProviderReady: profile => assertProviderReady(profile, {
        enabled: true,
        phase: 'ready',
        backend: 'cpu',
        reasonCode: null
      })
    });
    harness.readProviderSettings.mockResolvedValue(
      createLocalModelRoutingSnapshot(harness.providerSettings, true)
    );

    await expect(harness.composition.coordinator.submit('本地聊天')).resolves.toBeUndefined();
    await expect(harness.composition.capabilityTasks.prepareTarget({
      generation: 'generation-local-ready',
      taskKind: 'file'
    })).resolves.toMatchObject({ profileId: 'builtin-local' });
    expect(harness.factoryInputs[0]?.primaryProfile).toMatchObject({
      id: 'builtin-local',
      hasStoredSecret: false
    });

    expect(() => assertProviderReady({ ...primary, hasStoredSecret: false }, {
      enabled: true,
      phase: 'ready',
      backend: 'cpu',
      reasonCode: null
    })).toThrowError(expect.objectContaining({ code: 'SETTINGS_INCOMPLETE' }));
    await harness.composition.close();
  });

  test('关闭等待文件不可逆屏障，但不等待不服从取消的普通聊天 Provider', async () => {
    const writeBarrier = deferred();
    const agent = agentDouble({
      resetForNewConversation: vi.fn(() => writeBarrier.promise)
    });
    const fileHarness = baseOptions({ createAgent: () => agent });
    await fileHarness.composition.capabilityTasks.prepareTarget({ generation: 'generation-write', taskKind: 'file' });
    let fileClosed = false;
    const fileClose = fileHarness.composition.close().then(() => { fileClosed = true; });
    await Promise.resolve();
    expect(fileClosed).toBe(false);
    writeBarrier.resolve();
    await fileClose;

    const hanging = new Promise<ModelResponse>(() => undefined);
    const chatHarness = baseOptions({ chatResponse: hanging });
    void chatHarness.composition.coordinator.submit('悬挂聊天');
    await vi.waitFor(() => expect(chatHarness.readProviderSettings).toHaveBeenCalledOnce());
    await expect(chatHarness.composition.close()).resolves.toBeUndefined();
  });
});
