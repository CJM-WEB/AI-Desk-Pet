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
import { ConversationHistory } from '../src/main/conversation/conversation-history';
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
import { LocalModelProvider } from '../src/main/providers/local-model-provider';
import { characterBehaviorRoles, type CharacterBehaviorBindings } from '../src/main/characters/character-behavior-bindings';
import type { CharacterActivityInput } from '../src/main/conversation/conversation-chat-adapter';

function behaviorDouble(): ConversationBehaviorPort {
  return {
    prepareUserPrompt: vi.fn(async text => ({
      originalText: text,
      capabilityText: text,
      explicitDirective: null
    })),
    getChatContext: vi.fn(() => ({
      character: { idleStateId: 'idle',
        identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
          name: '测试角色', description: '测试角色', background: '测试环境', traits: [],
          languageStyle: '简洁', likes: [], behavioralTendencies: []
        },
        states: []
      },
      runtime: {
        chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 2 as const
      },
      proactivityMode: 'assistive' as const,
      recentActions: []
    })),
    completeUserPrompt: vi.fn(),
    captureExpressionContext: vi.fn(() => null),
    handleChatResponseFinished: vi.fn(),
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
    respond: vi.fn(async (request: ModelRequest) => request.responseContract ? { type: 'structured' as const, structured_output: { kind: 'none', choice: null, mode: 'keep', target: null, distance: null } } : response)
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
  chatProvider?: ModelProvider;
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
    createChatAdapter: () => new ConversationChatAdapter(input.chatProvider ?? providerWith(
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

// 通过真实本地 Provider 和 ChatAdapter 进入 Main，模型决定不能跳过范围授权。
function localDecisionHarness(content: string | Promise<string>) {
  // 延迟和非法载荷仅注入主判别，独立表现不能误消费主请求的等待屏障。
  const mainRequests: RequestInit[] = [];
  const expressionRequests: RequestInit[] = [];
  const fetchClient = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const main = Boolean(body.response_format?.schema.anyOf);
    (main ? mainRequests : expressionRequests).push(init!);
    return new Response(JSON.stringify({ choices: [{ message: { content: main ? await content : JSON.stringify({
      kind: 'none', choice: null, mode: 'keep', target: null, distance: null
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = new LocalModelProvider({ getReadyConnection: () => ({ generation: 'local-1',
    baseUrl: 'http://127.0.0.1:43123/v1', token: 'private-local-token', modelId: 'builtin-local' }) }, fetchClient);
  const harness = baseOptions({ chatProvider: provider, catalog: [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
    assertProviderReady: value => assertProviderReady(value, { enabled: true, phase: 'ready', backend: 'cpu', reasonCode: null }) });
  harness.readProviderSettings.mockResolvedValue(createLocalModelRoutingSnapshot(harness.providerSettings, true));
  return { ...harness, fetchClient, mainRequests, expressionRequests };
}

function assertLocalRequestBoundaries(harness: ReturnType<typeof localDecisionHarness>): void {
  expect(harness.mainRequests).toHaveLength(1);
  expect(harness.expressionRequests).toHaveLength(1);
  expect(JSON.parse(String(harness.expressionRequests[0]?.body))).toMatchObject({ tools: [], tool_choice: 'none' });
  expect(harness.fetchClient).toHaveBeenCalledTimes(2);
}

describe('Main 会话组合模块', () => {
  test('独立用途请求仅接纳到当前用途表，不触发心情、正文或文件任务', async () => {
    const harness = baseOptions();
    const bindings = Object.fromEntries(characterBehaviorRoles.map(role => [role, null])) as CharacterBehaviorBindings;
    const applied: unknown[] = [];
    const context = { contextRevision: 0, moodRevision: 0, instance: Symbol('用途上下文') };
    const behavior = { ...harness.behavior, captureExpressionContext: () => context };
    const composition = createMainConversationComposition({ ...harness.options, behavior: behavior as never,
      autonomy: { getBehaviorLifecycleGeneration: () => 3, getActivityBlockers: () => ({ closed: false, chatting: false, capabilityTask: false, awaitingConfirmation: false, dragging: false }),
        applyBehaviorBindings: (input: unknown) => applied.push(input), applyAutonomousDecision: () => { throw new Error('用途响应不得用作心情'); } } as never,
      createChatAdapter: () => ({ respondBindings: async (input: CharacterActivityInput) => input.beforeProviderCall() ? bindings : null, respondAutonomous: async () => null }) as never
    });
    try {
      await composition.requestAutonomousDecision({ purpose: 'bindings', idleForMs: 0, signal: new AbortController().signal, beforeProviderCall: () => true });
      expect(applied).toEqual([{ bindings, context: behavior.captureExpressionContext(), lifecycle: 3 }]);
      expect(harness.events).toEqual([]); expect(harness.factoryInputs).toEqual([]);
    } finally { await composition.close(); await harness.composition.close(); }
  });

  test.each(['signal', 'lifecycle'] as const)('用途准备期间%s变化，迟到用途表不能接纳', async invalidation => {
    const harness = baseOptions(); const pause = deferred(); const started = deferred(); let generation = 0;
    const applied: unknown[] = [];
    const controller = new AbortController();
    const composition = createMainConversationComposition({ ...harness.options,
      behavior: { ...harness.behavior, captureExpressionContext: () => ({ contextRevision: 0, moodRevision: 0, instance: Symbol('用途上下文') }) },
      autonomy: { getBehaviorLifecycleGeneration: () => generation, getActivityBlockers: () => ({ closed: false, chatting: false, capabilityTask: false, awaitingConfirmation: false, dragging: false }),
        applyBehaviorBindings: (input: unknown) => applied.push(input), applyAutonomousDecision: () => undefined } as never,
      createChatAdapter: () => ({ respondBindings: async (input: CharacterActivityInput) => { if (!input.beforeProviderCall()) return null; started.resolve(); await pause.promise; return Object.fromEntries(characterBehaviorRoles.map(role => [role, null])); }, respondAutonomous: async () => null }) as never
    });
    try {
      const request = composition.requestAutonomousDecision({ purpose: 'bindings', idleForMs: 0, signal: controller.signal, beforeProviderCall: () => true });
      await started.promise;
      if (invalidation === 'signal') controller.abort(); else generation++;
      pause.resolve(); await request; expect(applied).toEqual([]);
    } finally { await composition.close(); await harness.composition.close(); }
  });

  test.each(['confirm', 'cancel'] as const)('Qwen 判别只申请范围，%s 决定是否创建执行服务', async resolution => {
    const harness = localDecisionHarness('{"kind":"task","text":""}');
    try {
      await harness.composition.coordinator.submit('那 a 目录下又有什么？');
      const scope = harness.events.find(event => event.type === 'capability_authorization_required');
      expect(scope).toMatchObject({ directory: testRoot, modelId: 'builtin-local', actions: ['read', 'create', 'edit'] });
      expect(harness.factoryInputs).toHaveLength(0);
      assertLocalRequestBoundaries(harness);
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await harness.composition.coordinator.resolveCapabilityAuthorization(scope.requestId, resolution);
      if (resolution === 'confirm') {
        await expect.poll(() => harness.factoryInputs.length).toBe(1);
        expect(harness.factoryInputs[0]?.primaryProfile.id).toBe('builtin-local');
      } else expect(harness.factoryInputs).toHaveLength(0);
    } finally { await harness.composition.close(); }
  });

  test.each(['cancel', 'reset'] as const)('Qwen 判别在 %s 后迟到时没有范围或执行', async action => {
    let finish!: (content: string) => void;
    const harness = localDecisionHarness(new Promise(resolve => { finish = resolve; }));
    const running = harness.composition.coordinator.submit('看吧，看看里面写了什么');
    try {
      await vi.waitFor(() => expect(harness.mainRequests).toHaveLength(1));
      if (action === 'reset') await harness.composition.resetForConfigurationChange();
      else await harness.composition.coordinator.cancelActive();
      finish('{"kind":"task","text":""}');
      await running;
      expect(harness.events.some(event => event.type === 'capability_authorization_required')).toBe(false);
      expect(harness.readAuthorizedRootPath).not.toHaveBeenCalled();
      expect(harness.factoryInputs).toHaveLength(0);
    } finally { finish('{"kind":"task","text":""}'); await running; await harness.composition.close(); }
  });

  test.each(['{"kind":"task","text":"","path":"PRIVATE_PATH_CANARY","approved":true}',
    '{"kind":"task","text":"PRIVATE_PATH_CANARY"}'])('非法 Qwen 判别不申请且不公开原文，零工具表现不提升权限：%s', async content => {
    const harness = localDecisionHarness(content);
    try {
      await expect(harness.composition.coordinator.submit('查看文件')).rejects.toMatchObject({ code: 'PROVIDER_MALFORMED_RESPONSE' });
      assertLocalRequestBoundaries(harness);
      expect(harness.events.some(event => event.type === 'capability_authorization_required')).toBe(false);
      expect(harness.factoryInputs).toHaveLength(0);
      expect(JSON.stringify(harness.events)).not.toContain('PRIVATE_PATH_CANARY');
      expect(harness.events).toContainEqual({ type: 'phase', phase: 'error' });
    } finally { await harness.composition.close(); }
  });

  test('不支持的任务协议在范围准备时明确拒绝，普通聊天入口保留', async () => {
    const harness = baseOptions();
    harness.providerSettings.profiles = [{ ...primary, mode: 'custom', protocol: 'anthropic', baseUrl: 'https://example.com', additionalParameters: {} }];
    harness.providerSettings.route.fallbackProfileIds = [];
    harness.providerSettings.route.allowCrossProviderFallback = false;
    await expect(harness.composition.capabilityTasks.prepareSnapshot({ generation: 'g1', taskKind: 'file' })).rejects.toMatchObject({ code: 'CODING_MODEL_PROTOCOL_UNSUPPORTED' });
    expect(harness.factoryInputs).toHaveLength(0);
    await harness.composition.close();
  });
  test('单一发送真实读取先确认范围，确认 IPC 不等待最终正文', async () => {
    const nonce = randomUUID();
    let forward: (event: CodingSessionEvent) => void = () => undefined;
    const f = await fixture([[{ name: 'read', args: { path: 'note.txt' } }], nonce], { onEvent: event => forward(event) });
    const base = baseOptions({
      chatResponse: { type: 'tool_request', request: { requestId: 'native-1', toolName: 'request_task_authorization', arguments: {} } }
    });
    await base.composition.close();
    const events: TaskEvent[] = [];
    let creates = 0;
    const createChatAdapter = vi.fn(base.options.createChatAdapter);
    const execution = deferred();
    const composition = createMainConversationComposition({ ...base.options, createChatAdapter,
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
      expect(createChatAdapter).toHaveBeenCalledOnce();
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
    const base = baseOptions({ chatResponse: { type: 'tool_request', request: { requestId: 'native-1', toolName: 'request_task_authorization', arguments: {} } } });
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
    // 正文与表现独立交付，正文结束不代表无工具表现回调已经到达。
    await expect.poll(() => vi.mocked(harness.behavior.completeUserPrompt).mock.calls.length).toBe(1);
    expect(harness.behavior.completeUserPrompt).toHaveBeenCalledExactlyOnceWith({
      generation: expect.any(String), signal: expect.any(AbortSignal),
      explicitDirective: null,
      eventId: expect.any(String), context: null, movementControl: { kind: 'keep' }, expressionPlan: { states: [] }, expressionStatus: 'no_match', requestKind: 'ambient'
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

  test('新运行实例使用恢复的有界上下文，不重建任何文件任务', async () => {
    const chatProvider = providerWith({ type: 'text', text: '能够接上之前的话' });
    const harness = baseOptions({ chatProvider });
    await harness.composition.close();
    const history = new ConversationHistory();
    history.append({ userText: '上次退出前的问题', assistantText: '上次保存的回复', providerIdentity: 'custom:openai-compatible:https://same.example/v1' });
    const restored = createMainConversationComposition({ ...harness.options, history });
    try {
      await restored.coordinator.submit('继续上次聊天');
      const request = vi.mocked(chatProvider.respond).mock.calls.map(call => call[0]).find(item => !item.responseContract)!;
      expect(request.messages).toContainEqual({ role: 'user', content: '上次退出前的问题' });
      expect(request.messages).toContainEqual({ role: 'assistant', content: '上次保存的回复' });
      expect(harness.factoryInputs).toEqual([]);
    } finally { await restored.close(); }
  });

  test('普通配置失效后下一轮仍取得原对话上下文', async () => {
    const chatProvider = providerWith({ type: 'text', text: '记得之前的话' });
    const harness = baseOptions({ chatProvider });
    try {
      await harness.composition.coordinator.submit('请记住这句普通聊天');
      await harness.composition.resetForConfigurationChange();
      await harness.composition.coordinator.submit('我刚才说了什么');
      const request = vi.mocked(chatProvider.respond).mock.calls.map(call => call[0]).filter(item => !item.responseContract).at(-1)!;
      expect(request.messages).toContainEqual({ role: 'user', content: '请记住这句普通聊天' });
      expect(request.messages).toContainEqual({ role: 'assistant', content: '记得之前的话' });
    } finally { await harness.composition.close(); }
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

  test('原生申请范围在配置 generation 变化后不能激活', async () => {
    const harness = baseOptions({ chatResponse: { type: 'tool_request', request: { requestId: 'native-1', toolName: 'request_task_authorization', arguments: {} } } });
    try {
      await harness.composition.coordinator.submit('note.txt 里面写了什么？');
      const scope = harness.events.find(event => event.type === 'capability_authorization_required');
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await harness.composition.resetForConfigurationChange();
      await expect(harness.composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
      expect(harness.factoryInputs).toHaveLength(0);
    } finally { await harness.composition.close(); }
  });

  test('Provider 配置切换撤销在途主请求，迟到原生申请不产生范围卡', async () => {
    let complete!: (response: ModelResponse) => void;
    const harness = baseOptions({ chatResponse: new Promise(resolve => { complete = resolve; }) });
    const running = harness.composition.coordinator.submit('可以，先看看');
    await vi.waitFor(() => expect(harness.behavior.getChatContext).toHaveBeenCalledOnce());
    await harness.composition.resetForConfigurationChange();
    complete({ type: 'tool_request', request: { requestId: 'old', toolName: 'request_task_authorization', arguments: {} } });
    await running;
    expect(harness.events.some(event => event.type === 'capability_authorization_required')).toBe(false);
    expect(harness.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(harness.factoryInputs).toHaveLength(0);
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
