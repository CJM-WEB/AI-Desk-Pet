import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import type { ProviderProfileV2, TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { ConversationChatAdapter } from
  '../src/main/conversation/conversation-chat-adapter';
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
    { dataCategories: { file: boolean } }
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
  const options = {
    catalog: [],
    privacySessions,
    sessionId: 'desktop-session',
    readProviderSettings,
    readAuthorizedRootPath,
    readPrivacySettings,
    createChatAdapter: () => new ConversationChatAdapter(providerWith(
      input.chatResponse ?? {
        type: 'text',
        text: '你好'
      }
    )),
    createAgentService,
    emit: (event: TaskEvent) => events.push(event)
  };
  const composition = createMainConversationComposition(options);
  return {
    composition,
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
    await harness.composition.close();
  });

  test('文件 Agent 与元数据消费同一设置快照并只创建同源 fallback', async () => {
    const harness = baseOptions();

    const target = await harness.composition.capabilityTasks.prepareTarget({ generation: 'generation-1', taskKind: 'file' });

    expect(target).toEqual({
      profileId: 'primary',
      providerIdentity: 'custom:openai-compatible:https://same.example/v1',
      providerName: 'primary'
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
