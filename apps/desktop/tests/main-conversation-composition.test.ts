import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import type { ProviderProfileV2, TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { ConversationTurnAdapter } from
  '../src/main/conversation/conversation-turn-adapter';
import {
  createMainConversationComposition,
  type MainConversationAgentFactoryInput
} from '../src/main/conversation/main-conversation-composition';

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
    submitFileTask: vi.fn(async () => undefined),
    cancelActive: vi.fn(),
    confirm: vi.fn(async () => undefined),
    cancelAction: vi.fn(),
    onPlaybackStarted: vi.fn(() => true),
    onPlaybackTerminal: vi.fn(() => true),
    onCommitFrame: vi.fn(() => true),
    advanceFileTaskTransaction: vi.fn(() => true),
    invalidateFileTaskPlaybackGrant: vi.fn(() => true),
    resetForNewConversation: vi.fn(async () => undefined),
    close: vi.fn(),
    ...overrides
  };
}

function baseOptions(input: {
  chatResponse?: ModelResponse | Promise<ModelResponse>;
  createAgent?: (factory: MainConversationAgentFactoryInput<
    { dataCategories: { file: boolean } },
    { name: string }
  >) => ReturnType<typeof agentDouble>;
} = {}) {
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('desktop-session', { incognito: false });
  const providerSettings = {
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
  const enabledReadTools = [{ name: 'safe-read' }];
  const readEnabledReadTools = vi.fn(async () => enabledReadTools);
  const factoryInputs: Array<MainConversationAgentFactoryInput<
    typeof privacySettings,
    { name: string }
  >> = [];
  const createdAgentProfiles: string[] = [];
  const createAgentService = vi.fn((factoryInput: MainConversationAgentFactoryInput<
    typeof privacySettings,
    { name: string }
  >) => {
    factoryInputs.push(factoryInput);
    createdAgentProfiles.push(factoryInput.primaryProfile.id);
    createdAgentProfiles.push(...factoryInput.fallbackProfiles.map(item => item.id));
    return input.createAgent?.(factoryInput) ?? agentDouble();
  });
  const events: TaskEvent[] = [];
  const composition = createMainConversationComposition({
    catalog: [],
    privacySessions,
    sessionId: 'desktop-session',
    readProviderSettings,
    readAuthorizedRootPath,
    readPrivacySettings,
    readEnabledReadTools,
    createChatAdapter: () => new ConversationTurnAdapter(providerWith(
      input.chatResponse ?? {
        type: 'text',
        text: '{"kind":"chat_reply","text":"你好"}'
      }
    )),
    createAgentService,
    emit: event => events.push(event)
  });
  return {
    composition,
    createdAgentProfiles,
    enabledReadTools,
    events,
    factoryInputs,
    privacySettings,
    providerSettings,
    readAuthorizedRootPath,
    readEnabledReadTools,
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
    expect(harness.readEnabledReadTools).not.toHaveBeenCalled();
    expect(harness.factoryInputs).toHaveLength(0);
    await harness.composition.close();
  });

  test('文件 Agent 与元数据消费同一设置快照并只创建同源 fallback', async () => {
    const harness = baseOptions();

    const target = await harness.composition.fileTasks.prepareTarget('generation-1');

    expect(target).toEqual({
      profileId: 'primary',
      providerIdentity: 'custom:openai-compatible:https://same.example/v1',
      providerName: 'primary'
    });
    expect(harness.createdAgentProfiles).toEqual(['primary', 'same-fallback']);
    expect(harness.createdAgentProfiles).not.toContain('cross-fallback');
    expect(harness.factoryInputs[0]?.snapshot.providerSettings)
      .toBe(harness.providerSettings);
    expect(harness.factoryInputs[0]?.snapshot.privacySettings)
      .toBe(harness.privacySettings);
    expect(harness.factoryInputs[0]?.snapshot.enabledReadTools)
      .toBe(harness.enabledReadTools);
    await harness.composition.close();
  });

  test('配置重置撤销旧目标并允许从新授权快照重新创建', async () => {
    const harness = baseOptions();
    await harness.composition.fileTasks.prepareTarget('generation-old');
    harness.readAuthorizedRootPath.mockResolvedValue('E:\\new-root');

    await harness.composition.resetForConfigurationChange();
    await expect(harness.composition.fileTasks.prepareTarget('generation-new'))
      .resolves.toMatchObject({ profileId: 'primary' });

    expect(harness.factoryInputs).toHaveLength(2);
    await harness.composition.close();
  });

  test('关闭等待文件不可逆屏障，但不等待不服从取消的普通聊天 Provider', async () => {
    const writeBarrier = deferred();
    const agent = agentDouble({
      resetForNewConversation: vi.fn(() => writeBarrier.promise)
    });
    const fileHarness = baseOptions({ createAgent: () => agent });
    await fileHarness.composition.fileTasks.prepareTarget('generation-write');
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
