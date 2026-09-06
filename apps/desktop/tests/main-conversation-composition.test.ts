import { tmpdir } from 'node:os';
const testRoot = await realpath(tmpdir());
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
  type MainConversationCodingTaskFactoryInput
} from '../src/main/conversation/main-conversation-composition';
import type { ConversationBehaviorPort } from
  '../src/main/characters/character-behavior-director';
import {
  BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY,
  createLocalModelRoutingSnapshot
} from '../src/main/local-model/local-model-route';
import { assertProviderReady } from '../src/main/settings/session-preflight';
import type { ProviderSettingsSnapshot } from '../src/main/storage/settings-store';
import { fixture } from './fixtures/coding-task-http';
import { CodingTaskService } from '../src/main/agent/coding-task-service';
import { writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodingSessionEvent } from '@myself/coding-task-core';
import { fileURLToPath } from 'node:url';
import { resolveCodingTaskResources } from '../src/main/agent/coding-task-resources';

function behaviorDouble(): ConversationBehaviorPort {
  return {
    prepareUserPrompt: vi.fn(async text => ({
      originalText: text,
      capabilityText: text,
      explicitDirective: null
    })),
    getChatContext: vi.fn(() => ({
      character: {
        identity: {
          name: '测试角色', description: '测试角色', background: '测试环境', traits: [],
          languageStyle: '简洁', likes: [], behavioralTendencies: []
        },
        states: []
      },
      runtime: {
        moving: false, dragging: false, carrying: false, movementMode: 2 as const
      },
      proactivityMode: 'assistive' as const,
      recentActions: []
    })),
    completeUserPrompt: vi.fn(),
    handleTaskEvent: vi.fn(),
    applyPlaybackFeedback: vi.fn(),
    cancelActive: vi.fn(),
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

function codingTaskServiceDouble(overrides: Record<string, unknown> = {}) {
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
  createCodingTaskService?: (factory: MainConversationCodingTaskFactoryInput<
    { dataCategories: { memory: boolean } }
  >) => ReturnType<typeof codingTaskServiceDouble>;
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
  const readAuthorizedRootPath = vi.fn(async () => testRoot);
  const privacySettings = { dataCategories: { memory: false } };
  const readPrivacySettings = vi.fn(async () => privacySettings);
  const factoryInputs: Array<MainConversationCodingTaskFactoryInput<
    typeof privacySettings
  >> = [];
  const createdCodingTaskProfiles: string[] = [];
  const createCodingTaskService = vi.fn((factoryInput: MainConversationCodingTaskFactoryInput<
    typeof privacySettings
  >) => {
    factoryInputs.push(factoryInput);
    createdCodingTaskProfiles.push(factoryInput.primaryProfile.id);
    createdCodingTaskProfiles.push(...factoryInput.fallbackProfiles.map(item => item.id));
    return input.createCodingTaskService?.(factoryInput) ?? codingTaskServiceDouble();
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
    createCodingTaskService,
    behavior,
    emit: (event: TaskEvent) => events.push(event)
  };
  const composition = createMainConversationComposition(options);
  return {
    composition,
    behavior,
    createdCodingTaskProfiles,
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
  test('不支持的任务协议在范围准备时明确拒绝，普通聊天入口保留', async () => {
    const harness = baseOptions();
    harness.providerSettings.profiles = [{ ...primary, mode: 'custom', protocol: 'anthropic', baseUrl: 'https://example.com', additionalParameters: {} }];
    harness.providerSettings.route.fallbackProfileIds = [];
    harness.providerSettings.route.allowCrossProviderFallback = false;
    await expect(harness.composition.capabilityTasks.prepareSnapshot({ generation: 'g1', taskKind: 'file' })).rejects.toMatchObject({ code: 'CODING_MODEL_PROTOCOL_UNSUPPORTED' });
    expect(harness.factoryInputs).toHaveLength(0);
    await harness.composition.close();
  });
  test('自然读取表现降级后仍先确认正式范围，确认 IPC 不等待最终正文', async () => {
    const nonce = randomUUID();
    let forward: (event: CodingSessionEvent) => void = () => undefined;
    const f = await fixture([[{ name: 'read', args: { path: 'note.txt' } }], nonce], { onEvent: event => forward(event) });
    const base = baseOptions({ chatResponse: { type: 'text', text: '申请任务', structured_output: { text: '申请任务', activity: '等待授权', status: 'idle', behaviorPlan: { kind: 'none', emotion: 'neutral' }, movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'agent_task' } } } });
    await base.composition.close();
    const events: TaskEvent[] = [];
    let creates = 0;
    const execution = deferred();
    const composition = createMainConversationComposition({ ...base.options,
      readAuthorizedRootPath: async () => f.directory,
      createCodingTaskService: input => {
        creates += 1;
        return new CodingTaskService({
          sessionOptions: async () => ({ directory: input.snapshot.authorizedRootPath, dataDirectory: f.dataDirectory, approvedCommands: [], model: { baseUrl: '', modelId: primary.modelId, contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
          createSession: async options => { forward = options.onEvent; return { ...f.session, run: async (text, signal) => { await execution.promise; return f.session.run(text, signal); } }; },
          emit: input.emit, emitTrustedToolResult: input.emitTrustedToolResult
        });
      }, emit: event => events.push(event)
    });
    try {
      await writeFile(join(f.directory, 'note.txt'), nonce);
      await writeFile(join(f.directory, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest run', lint: 'eslint .' } }));
      await composition.coordinator.submit('帮我看看 note.txt 里写了什么');
      expect(creates).toBe(0);
      expect(f.requests).toHaveLength(0);
      const scope = events.find(event => event.type === 'capability_authorization_required');
      expect(scope).toBeDefined();
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      expect(scope).toMatchObject({ directory: await realpath(f.directory), modelId: 'model-test', approvedCommands: ['pnpm.cmd run test', 'pnpm.cmd run lint'], actions: ['read', 'create', 'edit'] });
      let confirmed = false;
      const confirmation = composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm').then(() => { confirmed = true; });
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
      expect(confirmed).toBe(true);
      execution.resolve();
      await confirmation;
      await expect.poll(() => events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
      expect(events).toContainEqual({ type: 'message', role: 'assistant', text: nonce });
      expect(JSON.stringify(f.requests[1])).toContain(nonce);
      await composition.coordinator.submit('任务完成了吗');
      expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '上一个任务已结束，状态：运行结束。收到 1 项实际工具结果。' });
    } finally { execution.resolve(); await composition.close(); await f.close(); }
  });

  test.each([0, 7])('正式 Core 命令退出码 %s 与实际操作数进入状态追问', async exit => {
    const resources = await resolveCodingTaskResources({ appPath: fileURLToPath(new URL('..', import.meta.url)), isPackaged: false, resourcesPath: '' });
    let forward: (event: CodingSessionEvent) => void = () => undefined;
    const f = await fixture([[{ name: 'bash', args: { command: `exit ${exit}`, cwd: '.' } }], '模型声称运行完成'], { ...resources, onEvent: event => forward(event) });
    const base = baseOptions();
    await base.composition.close();
    const events: TaskEvent[] = [];
    const composition = createMainConversationComposition({ ...base.options,
      readAuthorizedRootPath: async () => f.directory,
      createCodingTaskService: input => new CodingTaskService({
        sessionOptions: async () => ({ ...resources, directory: input.snapshot.authorizedRootPath, dataDirectory: f.dataDirectory, approvedCommands: input.snapshot.approvedCommands, model: { baseUrl: '', modelId: primary.modelId, contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
        createSession: async options => { forward = options.onEvent; return f.session; },
        emit: input.emit, emitTrustedToolResult: input.emitTrustedToolResult
      }), emit: event => events.push(event)
    });
    try {
      await composition.coordinator.submit('执行 PowerShell 命令检查项目');
      const scope = events.find(event => event.type === 'capability_authorization_required');
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm');
      await expect.poll(() => events.some(event => event.type === 'task_permission_required')).toBe(true);
      const permission = events.find(event => event.type === 'task_permission_required');
      if (permission?.type !== 'task_permission_required') throw new Error('缺少命令许可');
      await composition.coordinator.resolveFileAction(permission.actionId, 'confirm');
      await expect.poll(() => events.at(-1), { timeout: 10000 }).toEqual({ type: 'phase', phase: exit === 0 ? 'success' : 'error' });
      expect(JSON.stringify(f.requests[1])).toContain(`exit ${exit}`);
      await composition.coordinator.submit('任务完成了吗');
      expect(events).toContainEqual({ type: 'message', role: 'assistant', text: `上一个任务已结束，状态：${exit === 0 ? '运行结束' : '失败'}。收到 1 项实际工具结果。最近命令退出码：${exit}。` });
    } finally { await composition.close(); await f.close(); }
  });

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
      movementControl: null,
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
      directory: testRoot, modelId: 'model-test', approvedCommands: [],
      capabilityRevision: expect.any(String)
    });
    expect(harness.createdCodingTaskProfiles).toEqual(['primary']);
    expect(harness.createdCodingTaskProfiles).not.toContain('cross-fallback');
    expect(harness.factoryInputs[0]?.snapshot).toEqual({
      providerSettings: harness.providerSettings,
      authorizedRootPath: testRoot,
      taskKind: 'file',
      approvedCommands: [],
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
    harness.readAuthorizedRootPath.mockResolvedValue(process.cwd());

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
    const agent = codingTaskServiceDouble({
      resetForNewConversation: vi.fn(() => writeBarrier.promise)
    });
    const fileHarness = baseOptions({ createCodingTaskService: () => agent });
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
