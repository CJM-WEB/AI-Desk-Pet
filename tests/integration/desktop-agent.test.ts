import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentLoop,
  type ModelProvider,
  type ModelResponse
} from '@myself/agent-core';
import type { CharacterManifestV2 } from '@myself/character-runtime';
import type { ProviderProfileV2, TaskEvent } from '@myself/shared-types';
import { FileToolService } from '@myself/file-tools';
import { AgentService } from '../../apps/desktop/src/main/agent/agent-service';
import { PermissionPolicy } from '../../apps/desktop/src/main/agent/permission-policy';
import { PendingActionStore } from '../../apps/desktop/src/main/agent/pending-action-store';
import {
  createBuiltinFileToolRegistry
} from '../../apps/desktop/src/main/agent/tool-registry';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import { CharacterBehaviorService } from '../../apps/desktop/src/main/characters/character-behavior-service';
import { CharacterMotionService } from '../../apps/desktop/src/main/characters/character-motion-service';
import { PrivacySessionRegistry } from
  '../../apps/desktop/src/main/agent/disclosure-policy';
import { ConversationChatAdapter } from
  '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import {
  createMainConversationComposition,
  type MainConversationAgentFactoryInput
} from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import {
  createAuthorizedRoot,
  type AuthorizedRootFixture
} from '../fixtures/authorized-root';
import {
  startProviderServer,
  type ProviderServerFixture,
  type ProviderStep
} from '../fixtures/provider-server';

const toolNames = [
  'builtin.files.list_directory',
  'builtin.files.read_text',
  'builtin.files.create_file',
  'builtin.files.create_directory',
  'builtin.files.rename_entry',
  'builtin.files.move_to_recycle_bin'
] as const;
const internalToolNames = [
  'list_directory',
  'read_text_file',
  'create_file',
  'create_directory',
  'rename_entry',
  'move_to_recycle_bin'
] as const;

const roots: AuthorizedRootFixture[] = [];
const servers: ProviderServerFixture[] = [];
const compileProcesses: ChildProcess[] = [];
const rendererEventStreams: Array<{
  events: TaskEvent[];
  authorizedRoot: string;
  apiKey: string;
}> = [];

afterEach(async () => {
  try {
    for (const stream of rendererEventStreams.splice(0)) {
      assertRendererSafe(stream.events, stream.authorizedRoot, stream.apiKey);
    }
  } finally {
    try {
      await Promise.all(servers.splice(0).map(server => server.close()));
    } finally {
      for (const child of compileProcesses.splice(0)) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all(roots.splice(0).map(root => root.cleanup()));
    }
  }
});

function waitForCompileMessage(
  child: ChildProcess,
  expectedType: string
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`等待编译子进程消息超时：${expectedType}`));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (
        typeof message !== 'object'
        || message === null
        || !('type' in message)
        || message.type !== expectedType
      ) return;
      cleanup();
      resolveMessage(message as Record<string, unknown>);
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectMessage(new Error(`编译子进程提前退出：${String(code)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function collectNestedStrings(value: unknown, collected: string[] = []): string[] {
  if (typeof value === 'string') {
    collected.push(value);
    return collected;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedStrings(item, collected);
    return collected;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectNestedStrings(item, collected);
  }
  return collected;
}

function assertRendererSafe(events: TaskEvent[], authorizedRoot: string, apiKey: string): void {
  for (const value of collectNestedStrings(events)) {
    expect(value).not.toContain(apiKey);
    expect(value).not.toContain(`Bearer ${apiKey}`);
    expect(value.toLowerCase()).not.toContain('authorization');
    expect(value).not.toContain(authorizedRoot);
  }
}

function expectProviderExchange(
  providerServer: ProviderServerFixture,
  expectedRequests: number
): void {
  expect(providerServer.requests).toHaveLength(expectedRequests);
  for (const requestLog of providerServer.requests) {
    expect(requestLog).toMatchObject({
      method: 'POST',
      model: 'task-9a-model'
    });
    expect(Object.keys(requestLog).sort()).toEqual([
      'messageRoleCounts', 'method', 'model', 'toolCount'
    ]);
    expect(Object.values(requestLog.messageRoleCounts).reduce((sum, count) => sum + count, 0))
      .toBeGreaterThan(0);
  }
  expect(providerServer.remainingSteps()).toBe(0);
  providerServer.assertComplete();
}

function toolCall(
  requestId: string,
  toolName: (typeof toolNames)[number],
  arguments_: Record<string, unknown>
): ModelResponse {
  return {
    type: 'tool_request',
    request: { requestId, toolName, arguments: arguments_ }
  };
}

async function harness(steps: ProviderStep[]) {
  const authorized = await createAuthorizedRoot();
  roots.push(authorized);
  const providerServer = await startProviderServer(steps);
  servers.push(providerServer);
  const loop = new AgentLoop();
  const pending = new PendingActionStore({
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  const events: TaskEvent[] = [];
  rendererEventStreams.push({
    events,
    authorizedRoot: authorized.root,
    apiKey: providerServer.apiKey
  });
  const provider = new OpenAICompatibleProvider({
    id: 'task-9a-provider',
    displayName: '任务九脚本服务',
    baseUrl: providerServer.baseUrl,
    model: 'task-9a-model',
    hasStoredSecret: true
  }, async () => providerServer.apiKey);
  const registry = createBuiltinFileToolRegistry();
  const permissionPolicy = new PermissionPolicy({ highRiskEnabled: false });
  let carryStarted = 0;
  let carryEnded = 0;
  const taskCarry = {
    beginTaskCarry: () => {
      carryStarted += 1;
      return {
        playbackToken: 'integration-carry-token',
        actionId: 'integration-carry-action',
        commitFrameId: 'integration-commit-frame'
      };
    },
    endTaskCarry: () => {
      carryEnded += 1;
    }
  };
  const service = new AgentService({
    loop,
    pending,
    createSession: async () => ({
      provider,
      fileTools: authorized.fileTools,
      fileDisclosureAllowed: true,
      tools: registry.definitions(),
      toolRuntime: {
        prepare: raw => registry.prepare(raw, permissionPolicy),
        executeRead: request => authorized.fileTools.executeRead(request)
      },
      messages: []
    }),
    emit: event => events.push(event),
    taskCarry,
    createConversationId: () => 'conversation-task-9a'
  });
  return {
    authorized,
    events,
    loop,
    pending,
    providerServer,
    service,
    carryCounts: () => ({ started: carryStarted, ended: carryEnded })
  };
}

function pendingAction(events: TaskEvent[]) {
  const event = events.find(candidate => candidate.type === 'pending_action');
  if (!event || event.type !== 'pending_action') throw new Error('缺少待确认动作');
  return event.action;
}

const behaviorSemantics = ['idle', 'listen', 'think', 'move', 'celebrate', 'fail'] as const;

/** 固定 V2 角色让集成断言独立于生产默认角色的素材与命名。 */
function createBehaviorManifest(): CharacterManifestV2 {
  const states: CharacterManifestV2['states'] = behaviorSemantics.map(semantic => ({
    id: `${semantic}-state`,
    name: `${semantic} 状态`,
    kind: 'primary',
    semantic,
    tags: [],
    intensity: 10,
    coexistWithStateIds: [],
    forbiddenStateIds: [],
    enterConditions: [],
    exitConditions: [],
    agentInferable: semantic === 'think',
    actionIds: [`${semantic}-action`]
  }));
  states.push({
    id: 'agent-focus',
    name: 'Agent 专注',
    kind: 'primary',
    semantic: { kind: 'custom', value: 'focus' },
    tags: [],
    intensity: 80,
    coexistWithStateIds: [],
    forbiddenStateIds: [],
    enterConditions: [],
    exitConditions: [],
    agentInferable: true,
    actionIds: ['focus-action']
  });
  const actions: CharacterManifestV2['actions'] = behaviorSemantics.map(semantic => ({
    id: `${semantic}-action`,
    name: `${semantic} 动作`,
    semantic,
    tags: [],
    preference: 1,
    cooldownMs: 0,
    repeatSuppressionMs: 0,
    loopPolicy: 'never',
    interrupt: 'normal',
    allowedPrimaryStateIds: [],
    forbiddenPrimaryStateIds: [],
    requiredModifierStateIds: [],
    forbiddenModifierStateIds: [],
    direction: 'any'
  }));
  actions.push({
    ...actions.find(action => action.semantic === 'think')!,
    id: 'focus-action',
    name: '专注动作'
  });
  return {
    version: 2,
    id: 'integration-behavior-v2',
    name: '集成行为角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'task-9',
    identity: {
      description: '自主行为闭环集成角色', background: '固定测试夹具', traits: [],
      languageStyle: '简洁', formsOfAddress: [], likes: [], dislikes: [],
      behavioralTendencies: [], boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default',
    defaultStateId: 'idle-state',
    states,
    actions,
    skins: [{
      id: 'default',
      name: '默认皮肤',
      presentations: actions.map(action => ({
        actionId: action.id,
        fps: 8,
        frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      })),
      semanticFallbacks: []
    }],
    resources: [{
      assetId: 'atlas', fileName: 'atlas.png', sha256: 'a'.repeat(64), byteLength: 1
    }]
  };
}

function scriptedProvider(responses: ModelResponse[]): ModelProvider {
  return {
    async respond() {
      const response = responses.shift();
      if (!response) throw new Error('集成模型脚本已耗尽');
      return response;
    }
  };
}

function conversationProfile(id: string, baseUrl: string): ProviderProfileV2 {
  return {
    id,
    displayName: id,
    modelId: 'conversation-model',
    hasStoredSecret: true,
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl,
    additionalParameters: {},
    capabilities: ['chat', 'tools']
  };
}

const conversationPrimary = conversationProfile(
  'conversation-primary',
  'https://conversation-a.example/v1'
);
const conversationSameFallback = conversationProfile(
  'conversation-same-fallback',
  'https://conversation-a.example/v1/'
);
const conversationCross = conversationProfile(
  'conversation-cross',
  'https://conversation-b.example/v1'
);

function conversationIntegrationHarness(input: {
  responses: string[];
  authorizedRootPath?: string | null;
  incognito?: boolean;
}) {
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('integration-conversation', {
    incognito: input.incognito ?? false
  });
  let chatProfileId = conversationPrimary.id;
  const providerSettings = {
    profiles: [conversationPrimary, conversationSameFallback, conversationCross],
    route: {
      primaryProfileId: conversationPrimary.id,
      chatProfileId,
      agentProfileId: conversationPrimary.id,
      visionProfileId: null,
      fallbackProfileIds: [conversationSameFallback.id, conversationCross.id],
      allowCrossProviderFallback: true
    }
  };
  const events: TaskEvent[] = [];
  const chatRequests: Array<{ profileId: string; request: Parameters<ModelProvider['respond']>[0] }> = [];
  const fileSubmissions: Array<{
    text: string;
    visibleHistory: readonly unknown[];
  }> = [];
  const agentFactoryInputs: Array<MainConversationAgentFactoryInput<
    { dataCategories: { file: boolean } },
    { name: string }
  >> = [];
  const readAuthorizedRootPath = vi.fn(async () => input.authorizedRootPath ?? null);
  const readPrivacySettings = vi.fn(async () => ({ dataCategories: { file: true } }));
  const readEnabledReadTools = vi.fn(async () => [{ name: 'read_text_file' }]);
  const createAgentService = vi.fn((factoryInput: MainConversationAgentFactoryInput<
    { dataCategories: { file: boolean } },
    { name: string }
  >) => {
    agentFactoryInputs.push(factoryInput);
    return {
      async submitFileTask(submission: {
        text: string;
        visibleHistory: readonly unknown[];
      }) {
        fileSubmissions.push(submission);
        factoryInput.emit({
          type: 'message',
          role: 'assistant',
          text: '文件任务已由安全 Agent 完成'
        });
        factoryInput.emit({ type: 'phase', phase: 'success' });
      },
      cancelActive: vi.fn(),
      confirm: vi.fn(async () => undefined),
      cancelAction: vi.fn(),
      resetForNewConversation: vi.fn(async () => undefined),
      close: vi.fn(),
      onPlaybackStarted: vi.fn(() => true),
      onPlaybackTerminal: vi.fn(() => true),
      onCommitFrame: vi.fn(() => true),
      advanceFileTaskTransaction: vi.fn(() => true),
      invalidateFileTaskPlaybackGrant: vi.fn(() => true)
    };
  });
  const composition = createMainConversationComposition({
    catalog: [],
    privacySessions,
    sessionId: 'integration-conversation',
    readProviderSettings: async () => ({
      ...providerSettings,
      route: { ...providerSettings.route, chatProfileId }
    }),
    readAuthorizedRootPath,
    readPrivacySettings,
    readEnabledReadTools,
    createChatAdapter: profile => new ConversationChatAdapter({
      async respond(request) {
        chatRequests.push({ profileId: profile.id, request });
        const response = input.responses.shift();
        if (!response) throw new Error('聊天响应脚本已耗尽');
        return { type: 'text', text: response };
      }
    }),
    createAgentService,
    emit: event => events.push(event)
  });
  return {
    agentFactoryInputs,
    chatRequests,
    composition,
    createAgentService,
    events,
    fileSubmissions,
    readAuthorizedRootPath,
    readEnabledReadTools,
    readPrivacySettings,
    setChatProfile(profileId: string) {
      chatProfileId = profileId;
    }
  };
}

function latestDisclosureRequest(events: TaskEvent[]): string {
  const event = [...events].reverse().find(candidate => (
    candidate.type === 'history_disclosure_required'
  ));
  if (!event || event.type !== 'history_disclosure_required') {
    throw new Error('缺少历史披露请求');
  }
  return event.requestId;
}

describe('桌面会话分流纵向集成', () => {
  test('无授权根可连续普通聊天且第二轮收到有界可见历史', async () => {
    const fixture = conversationIntegrationHarness({
      responses: [
        '第一轮回复',
        '第二轮回复'
      ]
    });

    await fixture.composition.coordinator.submit('第一轮消息');
    await fixture.composition.coordinator.submit('第二轮消息');

    expect(fixture.chatRequests).toHaveLength(2);
    expect(fixture.chatRequests[1]?.request.tools).toEqual([]);
    expect(fixture.chatRequests[1]?.request.messages.slice(1)).toEqual([
      { role: 'user', content: '第一轮消息' },
      { role: 'assistant', content: '第一轮回复' },
      { role: 'user', content: '第二轮消息' }
    ]);
    expect(fixture.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(fixture.readPrivacySettings).not.toHaveBeenCalled();
    expect(fixture.readEnabledReadTools).not.toHaveBeenCalled();
    expect(fixture.createAgentService).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  test('模糊请求按默认聊天返回自然文本且隔离目录无变化', async () => {
    const authorized = await createAuthorizedRoot();
    roots.push(authorized);
    const before = await readdir(authorized.root, { recursive: true });
    const fixture = conversationIntegrationHarness({
      responses: ['无法确定请求类型'],
      authorizedRootPath: authorized.root
    });

    await fixture.composition.coordinator.submit('帮我整理一下');

    expect(fixture.events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '无法确定请求类型'
    });
    await expect(readdir(authorized.root, { recursive: true })).resolves.toEqual(before);
    expect(fixture.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(fixture.createAgentService).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  test('明确文件请求无授权时公开稳定错误', async () => {
    const fixture = conversationIntegrationHarness({
      responses: []
    });

    await expect(fixture.composition.coordinator.submit('读取 docs/note.txt'))
      .rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });
    expect(fixture.readAuthorizedRootPath).toHaveBeenCalledOnce();
    expect(fixture.createAgentService).not.toHaveBeenCalled();
    expect(fixture.chatRequests).toEqual([]);
    await fixture.composition.close();
  });

  test('授权后的明确文件请求进入既有 Agent 且排除跨 Provider fallback', async () => {
    const authorized = await createAuthorizedRoot();
    roots.push(authorized);
    const fixture = conversationIntegrationHarness({
      responses: [],
      authorizedRootPath: authorized.root
    });

    await fixture.composition.coordinator.submit('读取 docs/note.txt');

    expect(fixture.fileSubmissions).toEqual([{
      text: '读取 docs/note.txt',
      visibleHistory: []
    }]);
    expect(fixture.agentFactoryInputs[0]?.fallbackProfiles.map(profile => profile.id))
      .toEqual([conversationSameFallback.id]);
    expect(fixture.agentFactoryInputs[0]?.fallbackProfiles.map(profile => profile.id))
      .not.toContain(conversationCross.id);
    expect(fixture.chatRequests).toEqual([]);
    await fixture.composition.close();
  });

  test('跨 Provider 仅发送当前消息时历史为空且当前消息继续执行', async () => {
    const fixture = conversationIntegrationHarness({
      responses: [
        '来源回复',
        '目标回复'
      ],
      incognito: true
    });
    await fixture.composition.coordinator.submit('来源消息');
    fixture.setChatProfile(conversationCross.id);

    await fixture.composition.coordinator.submit('当前目标消息');
    const requestId = latestDisclosureRequest(fixture.events);
    await fixture.composition.coordinator.resolveHistoryDisclosure(
      requestId,
      'current_message_only'
    );

    expect(fixture.chatRequests[1]?.profileId).toBe(conversationCross.id);
    expect(fixture.chatRequests[1]?.request.messages.slice(1)).toEqual([
      { role: 'user', content: '当前目标消息' }
    ]);
    await fixture.composition.close();
  });

  test('跨 Provider 单次共享只恢复原请求且旧、伪造、重复请求均失效', async () => {
    const fixture = conversationIntegrationHarness({
      responses: [
        '来源回复',
        '目标回复',
        '再次回复'
      ]
    });
    await fixture.composition.coordinator.submit('来源消息');
    fixture.setChatProfile(conversationCross.id);
    await fixture.composition.coordinator.submit('目标消息');
    const firstRequestId = latestDisclosureRequest(fixture.events);

    await expect(fixture.composition.coordinator.resolveHistoryDisclosure(
      'forged-request',
      'share_once'
    )).rejects.toMatchObject({ code: 'DISCLOSURE_REQUEST_EXPIRED' });
    await fixture.composition.coordinator.resolveHistoryDisclosure(
      firstRequestId,
      'share_once'
    );
    expect(fixture.chatRequests[1]?.request.messages.slice(1)).toEqual([
      { role: 'user', content: '来源消息' },
      { role: 'assistant', content: '来源回复' },
      { role: 'user', content: '目标消息' }
    ]);
    await expect(fixture.composition.coordinator.resolveHistoryDisclosure(
      firstRequestId,
      'share_once'
    )).rejects.toMatchObject({ code: 'DISCLOSURE_REQUEST_EXPIRED' });

    await fixture.composition.coordinator.submit('再次发送');
    const secondRequestId = latestDisclosureRequest(fixture.events);
    expect(secondRequestId).not.toBe(firstRequestId);
    await expect(fixture.composition.coordinator.resolveHistoryDisclosure(
      firstRequestId,
      'share_once'
    )).rejects.toMatchObject({ code: 'DISCLOSURE_REQUEST_EXPIRED' });
    await fixture.composition.coordinator.resolveHistoryDisclosure(
      secondRequestId,
      'current_message_only'
    );
    expect(fixture.chatRequests[2]?.request.messages.slice(1)).toEqual([
      { role: 'user', content: '再次发送' }
    ]);
    await fixture.composition.close();
  });
});

describe('桌面 Agent 真实服务集成', () => {
  test('自主行为最小闭环按可信事件组合 Agent、Main 行为与窗口运动', async () => {
    let now = 0;
    let bounds = { x: 10, y: 20, width: 256, height: 256 };
    const positions: Array<{ x: number; y: number }> = [];
    const motion = new CharacterMotionService({
      window: {
        getBounds: () => ({ ...bounds }),
        setPosition: (x, y) => {
          bounds = { ...bounds, x, y };
          positions.push({ x, y });
        }
      },
      getWorkAreas: () => [{ x: 0, y: 0, width: 1_024, height: 768 }],
      now: () => now,
      random: () => 0.75
    });
    let token = 0;
    const behavior = new CharacterBehaviorService({
      store: {
        getActiveManifestV2: async () => createBehaviorManifest(),
        getActive: async () => { throw new Error('不应读取 V1 回退'); }
      },
      motion,
      now: () => now,
      random: () => 0,
      createPlaybackToken: () => `integration-token-${++token}`,
      idleIntervalMs: 100
    });
    const behaviorEvents: Array<{
      revision: number;
      stateId?: string;
      actionId: string;
      playbackToken: string;
    }> = [];
    behavior.subscribe(event => {
      if (event.type !== 'behavior-authority') behaviorEvents.push(event);
    });
    motion.subscribe(snapshot => behavior.handleMovement(snapshot));
    await behavior.initialize();

    const initialIdle = behaviorEvents.at(-1)!;
    expect(initialIdle).toMatchObject({ stateId: 'idle-state', actionId: 'idle-action' });
    behavior.applyPlaybackFeedback({
      playbackToken: initialIdle.playbackToken,
      actionId: initialIdle.actionId,
      status: 'started',
      occurredAtMs: now
    });
    behavior.handleUserInteraction();
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'idle-action' });
    expect(behaviorEvents.at(-1)?.playbackToken).not.toBe(initialIdle.playbackToken);

    const responses: ModelResponse[] = [{
      type: 'text',
      text: '进入专注状态',
      behaviorIntent: {
        stateIntent: { stateId: 'agent-focus' },
        actionSemantic: 'think',
        urgency: 70,
        explanation: '需要专注回应'
      }
    }, {
      type: 'text',
      text: '非法意图已降级',
      behaviorIntent: {
        stateIntent: { stateId: 'missing-state' },
        actionSemantic: 'think',
        urgency: 70,
        explanation: '不存在的状态'
      }
    }, {
      type: 'text',
      text: '无行为意图'
    }];
    const taskEvents: TaskEvent[] = [];
    const agent = new AgentService({
      loop: new AgentLoop(),
      pending: new PendingActionStore(),
      createSession: async () => ({
        provider: scriptedProvider(responses),
        fileTools: {} as never,
        fileDisclosureAllowed: false,
        tools: [],
        toolRuntime: {
          prepare: () => { throw new Error('不应准备工具'); },
          executeRead: async () => { throw new Error('不应执行工具'); }
        },
        messages: []
      }),
      emit: event => {
        taskEvents.push(event);
        behavior.handleTaskEvent(event);
      },
      emitBehaviorIntent: intent => behavior.handleAgentIntent(intent)
    });
    // 生产链由 Main Coordinator 先发布 listening，再把明确文件任务交给 Agent。
    const submitAgentTask = async (text: string): Promise<void> => {
      const listening = { type: 'phase', phase: 'listening' } as const;
      taskEvents.push(listening);
      behavior.handleTaskEvent(listening);
      await agent.submitFileTask({ text, visibleHistory: [] });
    };

    await submitAgentTask('执行合法意图');
    expect(taskEvents.filter(event => event.type === 'phase').slice(0, 2)).toEqual([
      { type: 'phase', phase: 'listening' },
      { type: 'phase', phase: 'thinking' }
    ]);
    expect(behaviorEvents).toContainEqual(expect.objectContaining({
      stateId: 'agent-focus', actionId: 'focus-action'
    }));
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'celebrate-action' });

    const illegalStart = behaviorEvents.length;
    await submitAgentTask('执行非法意图');
    expect(behaviorEvents.slice(illegalStart).filter(event => (
      event.stateId === 'think-state' && event.actionId === 'think-action'
    ))).toHaveLength(3);
    expect(behaviorEvents.slice(illegalStart)).not.toContainEqual(expect.objectContaining({
      stateId: 'missing-state'
    }));

    const noIntentStart = behaviorEvents.length;
    await submitAgentTask('执行无意图降级');
    expect(behaviorEvents.slice(noIntentStart)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'listen-action' }),
      expect.objectContaining({ actionId: 'think-action' }),
      expect.objectContaining({ actionId: 'celebrate-action' })
    ]));

    motion.requestIntent('wander');
    now = 100;
    motion.tick();
    now = 200;
    motion.tick();
    expect(behaviorEvents).toContainEqual(expect.objectContaining({ actionId: 'move-action' }));
    expect(positions.length).toBeGreaterThan(0);

    behavior.handleTaskEvent({ type: 'phase', phase: 'error' });
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'fail-action' });
    const failure = behaviorEvents.at(-1)!;
    behavior.applyPlaybackFeedback({
      playbackToken: failure.playbackToken,
      actionId: failure.actionId,
      status: 'started',
      occurredAtMs: now
    });
    behavior.applyPlaybackFeedback({
      playbackToken: failure.playbackToken,
      actionId: failure.actionId,
      status: 'completed',
      occurredAtMs: now + 1
    });
    behavior.handleTaskEvent({ type: 'phase', phase: 'idle' });
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'idle-action' });
  });

  test('Renderer 真实图集编译挂起时 Main Agent 请求仍先完成', async () => {
    const fixture = await harness([{
      response: { type: 'text', text: 'Agent 在编译期间正常响应' }
    }]);
    const child = fork(
      join(process.cwd(), 'tests', 'fixtures', 'character-compile-process.mjs'),
      [],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_PET_WORKSPACE_ROOT: process.cwd()
        },
        execArgv: ['--experimental-strip-types'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    );
    compileProcesses.push(child);

    await waitForCompileMessage(child, 'ready');
    child.send({ type: 'start_compile' });
    await waitForCompileMessage(child, 'decode_started');

    let compileCompleted = false;
    const compileResult = waitForCompileMessage(child, 'compile_completed')
      .then(result => {
        compileCompleted = true;
        return result;
      });

    await fixture.service.submitFileTask({
      text: '编译角色时继续响应',
      visibleHistory: []
    });

    expect(compileCompleted).toBe(false);
    expect(fixture.events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: 'Agent 在编译期间正常响应'
    });
    expectProviderExchange(fixture.providerServer, 1);

    child.send({ type: 'release_decode' });
    await expect(compileResult).resolves.toMatchObject({
      width: 2,
      height: 2,
      frameCount: 1
    });
  });

  test('只通过六个允许工具列出授权目录', async () => {
    const fixture = await harness([
      {
        response: toolCall('list-1', 'builtin.files.list_directory', { relativePath: '.' }),
        inspect: request => expect(request.tools.map(tool => tool.function.name)).toEqual(toolNames)
      },
      {
        response: { type: 'text', text: '目录已列出' },
        inspect: request => {
          const assistantCall = request.messages.at(-2);
          if (
            !assistantCall
            || assistantCall.role !== 'assistant'
            || !assistantCall.toolRequest
          ) {
            throw new Error('缺少助手工具调用历史');
          }
          expect(assistantCall.toolRequest).toEqual({
            requestId: 'list-1',
            toolName: 'builtin.files.list_directory',
            arguments: { relativePath: '.' }
          });
          expect(assistantCall.toolRequest.toolName).toMatch(/^builtin\.files\./u);
          expect(internalToolNames).not.toContain(assistantCall.toolRequest.toolName);

          const last = request.messages.at(-1);
          if (!last || last.role !== 'tool') throw new Error('缺少列目录结果');
          const result = JSON.parse(last.content) as {
            toolName: string;
            relativePath: string;
            entries: Array<{ name: string; type: string }>;
          };
          expect(result).toMatchObject({
            toolName: 'list_directory',
            relativePath: '.',
            entries: expect.arrayContaining([
              expect.objectContaining({ name: 'docs', type: 'directory' })
            ])
          });
        }
      }
    ]);
    expect(() => assertRendererSafe([{
      type: 'message',
      role: 'assistant',
      text: fixture.authorized.root
    }], fixture.authorized.root, fixture.providerServer.apiKey)).toThrow();

    await fixture.service.submitFileTask({ text: '列出授权目录', visibleHistory: [] });

    expectProviderExchange(fixture.providerServer, 2);
    expect(fixture.providerServer.inspectionErrors).toEqual([]);
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '目录已列出'
    });
    expect(JSON.stringify(fixture.events)).not.toContain(fixture.authorized.root);
  });

  test('读取受限 UTF-8 文本并作为不可信数据交回模型', async () => {
    const content = '你好，任务九。';
    const fixture = await harness([
      {
        response: toolCall(
          'read-1',
          'builtin.files.read_text',
          { relativePath: 'docs/note.txt' }
        )
      },
      {
        response: { type: 'text', text: '文本已读取' },
        inspect: request => {
          const last = request.messages.at(-1);
          expect(last).toMatchObject({ role: 'tool', toolCallId: 'read-1' });
          if (!last || last.role !== 'tool') throw new Error('缺少工具结果');
          expect(JSON.parse(last.content)).toMatchObject({
            toolName: 'read_text_file',
            relativePath: 'docs/note.txt',
            content,
            untrustedDataNotice: expect.stringContaining('不可信数据')
          });
        }
      }
    ]);
    await writeFile(join(fixture.authorized.root, 'docs', 'note.txt'), content, 'utf8');

    await fixture.service.submitFileTask({
      text: '读取 docs/note.txt',
      visibleHistory: []
    });

    expectProviderExchange(fixture.providerServer, 2);
    expect(fixture.providerServer.inspectionErrors).toEqual([]);
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '文本已读取'
    });
  });

  test('新建预览后取消时文件系统保持不变', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'create-cancel',
          'builtin.files.create_file',
          { relativePath: 'cancelled.txt' }
        )
      }
    ]);
    await fixture.service.submitFileTask({
      text: '新建 cancelled.txt',
      visibleHistory: []
    });
    const action = pendingAction(fixture.events);

    fixture.service.cancelAction(action.actionId);

    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.root, 'cancelled.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('回收站预览使用显式 operation，取消不执行系统操作', async () => {
    const fixture = await harness([{
      response: toolCall(
        'recycle-cancel',
        'builtin.files.move_to_recycle_bin',
        { relativePath: 'docs' }
      )
    }]);

    await fixture.service.submitFileTask({
      text: '将 docs 移入回收站',
      visibleHistory: []
    });
    const action = pendingAction(fixture.events);
    expect(action).toMatchObject({
      operation: 'move_to_recycle_bin',
      summary: '将 docs 移入回收站',
      targetRelativePath: 'docs'
    });

    fixture.service.cancelAction(action.actionId);

    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.root, 'docs'))).resolves.toBeDefined();
  });

  test('回收站确认在匹配提交帧前保持原文件并在提交后只执行一次', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'recycle-confirm',
          'builtin.files.move_to_recycle_bin',
          { relativePath: 'docs/old.txt' }
        )
      },
      { response: { type: 'text', text: 'old.txt 已移入回收站' } }
    ]);
    const source = join(fixture.authorized.root, 'docs', 'old.txt');
    const recycled = join(fixture.authorized.root, 'docs', '.recycled-old.txt');
    await writeFile(source, '旧内容', 'utf8');
    fixture.authorized.fileTools = new FileToolService(fixture.authorized.policy, {
      moveToRecycleBin: absolutePath => rename(absolutePath, recycled)
    });

    await fixture.service.submitFileTask({
      text: '把 docs/old.txt 移入回收站',
      visibleHistory: []
    });
    const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
    await Promise.resolve();

    await expect(readFile(source, 'utf8')).resolves.toBe('旧内容');
    expect(fixture.service.onPlaybackStarted(
      'integration-carry-token',
      'integration-carry-action'
    )).toBe(true);
    await expect(readFile(source, 'utf8')).resolves.toBe('旧内容');
    expect(fixture.service.onCommitFrame(
      'integration-carry-token',
      'integration-carry-action',
      'integration-commit-frame'
    )).toBe(true);
    expect(fixture.service.onCommitFrame(
      'integration-carry-token',
      'integration-carry-action',
      'integration-commit-frame'
    )).toBe(false);
    await confirming;

    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(recycled, 'utf8')).resolves.toBe('旧内容');
    expect(fixture.carryCounts()).toEqual({ started: 1, ended: 1 });
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('回收站事务拒绝乱序、伪造、过期和跨角色令牌并在提交前中断', async () => {
    const fixture = await harness([{
      response: toolCall(
        'recycle-token-matrix',
        'builtin.files.move_to_recycle_bin',
        { relativePath: 'docs/token.txt' }
      )
    }]);
    const source = join(fixture.authorized.root, 'docs', 'token.txt');
    await writeFile(source, '令牌矩阵', 'utf8');
    let recycleCalls = 0;
    fixture.authorized.fileTools = new FileToolService(fixture.authorized.policy, {
      moveToRecycleBin: async () => {
        recycleCalls += 1;
      }
    });

    await fixture.service.submitFileTask({
      text: '把 docs/token.txt 移入回收站',
      visibleHistory: []
    });
    const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
    await Promise.resolve();

    expect(fixture.service.onCommitFrame(
      'integration-carry-token',
      'integration-carry-action',
      'integration-commit-frame'
    )).toBe(false);
    expect(fixture.service.onPlaybackStarted('forged-token', 'integration-carry-action'))
      .toBe(false);
    expect(fixture.service.onPlaybackStarted(
      'integration-carry-token',
      'integration-carry-action'
    )).toBe(true);
    for (const [token, actionId, frameId] of [
      ['expired-token', 'integration-carry-action', 'integration-commit-frame'],
      ['integration-carry-token', 'cross-character-action', 'integration-commit-frame'],
      ['integration-carry-token', 'integration-carry-action', 'wrong-frame']
    ] as const) {
      expect(fixture.service.onCommitFrame(token, actionId, frameId)).toBe(false);
    }
    expect(fixture.service.invalidateFileTaskPlaybackGrant()).toBe(true);

    await expect(confirming).rejects.toMatchObject({
      code: 'FILE_TASK_PLAYBACK_CANCELLED'
    });
    expect(recycleCalls).toBe(0);
    await expect(readFile(source, 'utf8')).resolves.toBe('令牌矩阵');
    expectProviderExchange(fixture.providerServer, 1);
  });

  test('系统回收站失败时原文件保留且事务只发布一次失败终态', async () => {
    const fixture = await harness([{
      response: toolCall(
        'recycle-port-failure',
        'builtin.files.move_to_recycle_bin',
        { relativePath: 'docs/failure.txt' }
      )
    }]);
    const source = join(fixture.authorized.root, 'docs', 'failure.txt');
    await writeFile(source, '保留内容', 'utf8');
    let recycleCalls = 0;
    fixture.authorized.fileTools = new FileToolService(fixture.authorized.policy, {
      moveToRecycleBin: async () => {
        recycleCalls += 1;
        throw new Error('测试回收站拒绝');
      }
    });

    await fixture.service.submitFileTask({
      text: '把 docs/failure.txt 移入回收站',
      visibleHistory: []
    });
    const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
    await Promise.resolve();
    expect(fixture.service.onPlaybackStarted(
      'integration-carry-token',
      'integration-carry-action'
    )).toBe(true);
    expect(fixture.service.onCommitFrame(
      'integration-carry-token',
      'integration-carry-action',
      'integration-commit-frame'
    )).toBe(true);

    await expect(confirming).rejects.toMatchObject({ code: 'FILE_TASK_EXECUTION_FAILED' });
    expect(recycleCalls).toBe(1);
    await expect(readFile(source, 'utf8')).resolves.toBe('保留内容');
    expect(fixture.events.filter(event => (
      event.type === 'error' && event.code === 'FILE_TASK_EXECUTION_FAILED'
    ))).toHaveLength(1);
    expect(fixture.carryCounts()).toEqual({ started: 1, ended: 1 });
    expectProviderExchange(fixture.providerServer, 1);
  });

  test('生产组合根只通过 Electron shell.trashItem 注入回收站端口', async () => {
    const mainSource = await readFile(
      join(process.cwd(), 'apps/desktop/src/main/index.ts'),
      'utf8'
    );

    expect(mainSource).toContain(': absolutePath => shell.trashItem(absolutePath)');
    expect(mainSource).toContain('? absolutePath => moveToE2eRecycleBin(absolutePath)');
    expect(mainSource).not.toContain("from '@myself/file-tools/electron'");
  });

  test('新建预览后确认会真实创建空文件', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'create-confirm',
          'builtin.files.create_file',
          { relativePath: 'created.txt' }
        )
      },
      { response: { type: 'text', text: '空文件已创建' } }
    ]);
    await fixture.service.submitFileTask({ text: '新建 created.txt', visibleHistory: [] });

    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    expectProviderExchange(fixture.providerServer, 2);
    await expect(readFile(join(fixture.authorized.root, 'created.txt'), 'utf8')).resolves.toBe('');
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '空文件已创建'
    });
  });

  test('重命名预览后确认会移动源条目且不复制', async () => {
    const fixture = await harness([
      {
        response: toolCall('rename-confirm', 'builtin.files.rename_entry', {
          sourceRelativePath: 'docs/before.txt',
          targetRelativePath: 'docs/after.txt'
        })
      },
      { response: { type: 'text', text: '重命名已完成' } }
    ]);
    await writeFile(join(fixture.authorized.root, 'docs', 'before.txt'), '原始内容', 'utf8');
    await fixture.service.submitFileTask({ text: '重命名文件', visibleHistory: [] });

    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    expectProviderExchange(fixture.providerServer, 2);
    await expect(lstat(join(fixture.authorized.root, 'docs', 'before.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.authorized.root, 'docs', 'after.txt'), 'utf8'))
      .resolves.toBe('原始内容');
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '重命名已完成'
    });
  });

  test('越界路径在预览阶段被拒绝', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'outside-1',
          'builtin.files.create_file',
          { relativePath: '../outside.txt' }
        )
      }
    ]);

    await expect(fixture.service.submitFileTask({
      text: '新建越界文件',
      visibleHistory: []
    })).rejects.toMatchObject({
      code: 'PATH_INVALID'
    });
    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.base, 'outside.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('重复目标被拒绝且不覆盖原内容', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'duplicate-1',
          'builtin.files.create_file',
          { relativePath: 'existing.txt' }
        )
      }
    ]);
    const target = join(fixture.authorized.root, 'existing.txt');
    await writeFile(target, '必须保留', 'utf8');

    await expect(fixture.service.submitFileTask({
      text: '新建 existing.txt',
      visibleHistory: []
    })).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
    expectProviderExchange(fixture.providerServer, 1);
    await expect(readFile(target, 'utf8')).resolves.toBe('必须保留');
  });

  test('模拟应用重启后旧待确认动作失效且不会执行', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'restart-1',
          'builtin.files.create_file',
          { relativePath: 'stale.txt' }
        )
      }
    ]);
    await fixture.service.submitFileTask({ text: '新建 stale.txt', visibleHistory: [] });
    const staleActionId = pendingAction(fixture.events).actionId;
    fixture.service.clearPending('application_exit');

    await expect(fixture.service.confirm(staleActionId)).rejects.toThrow('ACTION_EXPIRED');
    await expect(lstat(join(fixture.authorized.root, 'stale.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const restartedEvents: TaskEvent[] = [];
    rendererEventStreams.push({
      events: restartedEvents,
      authorizedRoot: fixture.authorized.root,
      apiKey: fixture.providerServer.apiKey
    });
    const restarted = new AgentService({
      loop: new AgentLoop(),
      pending: new PendingActionStore(),
      createSession: async () => { throw new Error('确认旧动作时不应创建会话'); },
      emit: event => restartedEvents.push(event)
    });

    await expect(restarted.confirm(staleActionId)).rejects.toThrow('ACTION_EXPIRED');
    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.root, 'stale.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(restartedEvents).toContainEqual(expect.objectContaining({
      type: 'error', code: 'ACTION_EXPIRED'
    }));
  });
});
