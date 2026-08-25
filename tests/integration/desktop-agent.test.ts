import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentLoop,
  CAPABILITY_CLARIFICATION_TOOL_NAME,
  type ModelProvider,
  type ModelResponse
} from '@myself/agent-core';
import type {
  BehaviorTarget,
  CharacterBehaviorAuthorization,
  CharacterManifestV2,
  ResolvedBehaviorTarget
} from '@myself/character-runtime';
import { characterManifestV2Schema } from '../../packages/character-runtime/src/character-v2-schema';
import type { ProviderProfileV2, TaskEvent } from '@myself/shared-types';
import { FileToolService } from '@myself/file-tools';
import { AgentService } from '../../apps/desktop/src/main/agent/agent-service';
import { PermissionPolicy } from '../../apps/desktop/src/main/agent/permission-policy';
import { PendingActionStore } from '../../apps/desktop/src/main/agent/pending-action-store';
import {
  createBuiltinFileToolRegistry,
  createBuiltinPowerShellToolRegistry
} from '../../apps/desktop/src/main/agent/tool-registry';
import { PowerShellTool } from '../../apps/desktop/src/main/agent/powershell-tool';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import { createOpenAIToolNameCodec } from
  '../../apps/desktop/src/main/providers/openai-tool-name-codec';
import { CharacterBehaviorService } from '../../apps/desktop/src/main/characters/character-behavior-service';
import { CharacterMotionService } from '../../apps/desktop/src/main/characters/character-motion-service';
import { PrivacySessionRegistry } from
  '../../apps/desktop/src/main/agent/disclosure-policy';
import { ConversationChatAdapter } from
  '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import type { CapabilityTaskAgentPort } from
  '../../apps/desktop/src/main/conversation/capability-task-adapter';
import {
  createMainConversationComposition,
  type MainConversationAgentFactoryInput
} from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import type { ConversationBehaviorPort } from
  '../../apps/desktop/src/main/characters/character-behavior-director';
import { CharacterBehaviorDirector } from
  '../../apps/desktop/src/main/characters/character-behavior-director';
import {
  createAuthorizedRoot,
  type AuthorizedRootFixture
} from '../fixtures/authorized-root';
import {
  startProviderServer,
  type ProviderServerFixture,
  type ProviderStep
} from '../fixtures/provider-server';
import { parseMainE2eState } from '../fixtures/electron-app';

const strictGeometryState = () => ({
  revision: 1,
  petWindowVisible: true,
  petWindowAlwaysOnTop: true,
  processedExplorerEventRevision: 0,
  processedExplorerEvent: null,
  bridge: { state: 'ready', observing: true, polling: true, eventRevision: 1 },
  layer: { status: 'active', activationRevision: 1, errorRevision: 0 },
  geometry: {
    revision: 2,
    scaleTick: 10,
    visualBoundsInWindowRatio: { x: 0.1, y: 0.2, width: 0.7, height: 0.75 },
    outOfBounds: false
  }
});

describe('E2E 几何探针最小披露边界', () => {
  test('只接受严格四字段几何摘要', () => {
    expect(parseMainE2eState(strictGeometryState()).geometry).toEqual(
      strictGeometryState().geometry
    );
  });

  test('拒绝旧九字段几何契约', () => {
    const state = strictGeometryState();
    state.geometry = {
      revision: 2,
      scaleTick: 10,
      settled: true,
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 },
      footOffsetInViewportDip: { x: 79, y: 174 },
      windowSizeDip: { width: 180, height: 220 },
      settingsPlacementMatchesAuthority: true,
      actualWindowBoundsMatchAuthority: true,
      actualOriginMatchesFootOffset: true
    } as unknown as typeof state.geometry;

    expect(() => parseMainE2eState(state)).toThrow('ELECTRON_E2E_MAIN_STATE_INVALID');
  });

  test.each([
    ['footAnchorDip', { x: 390, y: 400 }],
    ['windowBoundsDip', { x: 300, y: 200, width: 180, height: 220 }],
    ['displayId', 'display-1']
  ] as const)('拒绝额外敏感字段 %s', (field, value) => {
    const state = strictGeometryState();
    Object.assign(state.geometry, { [field]: value });

    expect(() => parseMainE2eState(state)).toThrow('ELECTRON_E2E_MAIN_STATE_INVALID');
  });
});

const toolNames = [
  'builtin.files.list_files',
  'builtin.files.read_file',
  'builtin.files.create_file',
  'builtin.files.move_file',
  'builtin.files.create_directory',
  'builtin.files.apply_patch',
  'builtin.files.delete_file'
] as const;
const internalToolNames = [
  'list_files',
  'read_file',
  'create_file',
  'move_file',
  'create_directory',
  'apply_patch',
  'delete_file'
] as const;
const providerToolNameCodec = createOpenAIToolNameCodec([
  ...toolNames,
  'builtin.powershell.run',
  CAPABILITY_CLARIFICATION_TOOL_NAME
].map(name => ({
  type: 'function' as const,
  function: { name, description: '', parameters: {} }
})));

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
  toolName: (typeof toolNames)[number]
    | 'builtin.powershell.run'
    | typeof CAPABILITY_CLARIFICATION_TOOL_NAME,
  arguments_: Record<string, unknown>
): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: providerToolNameCodec.encode(toolName),
      arguments: arguments_
    }
  };
}

async function harness(
  steps: ProviderStep[],
  taskKind: 'file' | 'powershell' = 'file',
  powershell?: PowerShellTool,
  emitBehaviorIntent?: (intent: Parameters<CharacterBehaviorService['handleAgentIntent']>[0]) => void,
  onTaskEvent?: (event: TaskEvent) => void
) {
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
  const registry = taskKind === 'powershell'
    ? createBuiltinPowerShellToolRegistry()
    : createBuiltinFileToolRegistry();
  const permissionPolicy = new PermissionPolicy({ highRiskEnabled: taskKind === 'powershell' });
  const service = new AgentService({
    loop,
    pending,
    createSession: async () => taskKind === 'powershell'
      ? {
          taskKind: 'powershell' as const,
          provider,
          powershell: powershell ?? new PowerShellTool(),
          workingDirectory: authorized.root,
          workingDirectoryLabel: '授权工作目录',
          generation: 'integration-powershell-generation',
          tools: registry.definitions(),
          toolRuntime: {
            prepare: raw => registry.prepare(raw, permissionPolicy),
            executeRead: async () => { throw new Error('TOOL_UNKNOWN'); }
          },
          messages: []
        }
      : {
          taskKind: 'file' as const,
          provider,
          fileTools: authorized.fileTools,
          fileDisclosureAllowed: true,
          tools: registry.definitions(),
          toolRuntime: {
            prepare: raw => registry.prepare(raw, permissionPolicy),
            executeRead: request => authorized.fileTools.executeRead(request)
          },
          messages: []
    },
    emit: event => {
      events.push(event);
      onTaskEvent?.(event);
    },
    emitBehaviorIntent,
    createConversationId: () => 'conversation-task-9a'
  });
  return {
    authorized,
    events,
    loop,
    pending,
    providerServer,
    service
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
  return characterManifestV2Schema.parse({
    version: 2,
    id: 'integration-behavior-v2',
    name: '集成行为角色',
    thumbnailAssetId: 'atlas',
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
        anchors: { ground: { x: 0.5, y: 1 } },
        geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 },
          groundAnchor: { x: 0.5, y: 1 },
          resourceRevision: 'a'.repeat(64)
        }
      })),
      semanticFallbacks: []
    }],
    resources: [{
      assetId: 'atlas', fileName: 'atlas.png', sha256: 'a'.repeat(64), byteLength: 1
    }]
  });
}

function compatibleToolCall(
  requestId: string,
  providerToolName: string,
  arguments_: Record<string, unknown>
): unknown {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: requestId,
          type: 'function',
          function: {
            name: providerToolName,
            arguments: JSON.stringify(arguments_)
          }
        }]
      }
    }]
  };
}

function compatibleText(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

/**
 * 直接驱动正式 OpenAI-compatible Adapter 与真实文件服务，只隔离远端 HTTP 和系统回收站。
 * 响应 fixture 保留 DeepSeek 实际使用的 message.tool_calls 线格式。
 */
async function deepSeekHarness(input: {
  responses: unknown[];
  fileDisclosureAllowed?: boolean;
  moveToRecycleBin?: (absolutePath: string) => Promise<void>;
}) {
  const authorized = await createAuthorizedRoot();
  roots.push(authorized);
  const responses = [...input.responses];
  const requestBodies: Array<Record<string, unknown>> = [];
  const apiKey = 'deepseek-integration-secret';
  const fetchClient = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) throw new Error('DeepSeek 响应脚本已耗尽');
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-v4-flash',
    providerId: 'deepseek'
  }, async () => apiKey, fetchClient);
  const loop = new AgentLoop();
  const pending = new PendingActionStore({
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  const events: TaskEvent[] = [];
  rendererEventStreams.push({ events, authorizedRoot: authorized.root, apiKey });
  const registry = createBuiltinFileToolRegistry();
  const permissionPolicy = new PermissionPolicy({ highRiskEnabled: false });
  const fileTools = new FileToolService(authorized.policy, {
    moveToRecycleBin: input.moveToRecycleBin ?? (async () => undefined)
  });
  const service = new AgentService({
    loop,
    pending,
    createSession: async () => ({
      taskKind: 'file' as const,
      provider,
      fileTools,
      fileDisclosureAllowed: input.fileDisclosureAllowed ?? true,
      tools: registry.definitions(),
      toolRuntime: {
        prepare: raw => registry.prepare(raw, permissionPolicy),
        executeRead: request => fileTools.executeRead(request)
      },
      messages: []
    }),
    emit: event => events.push(event),
    createConversationId: () => 'conversation-deepseek-integration'
  });
  return { authorized, events, fetchClient, requestBodies, responses, service };
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
  responses: Array<string | ModelResponse>;
  authorizedRootPath?: string | null;
  incognito?: boolean;
  fileDisclosureAllowed?: boolean;
  behavior?: ConversationBehaviorPort;
  createChatAdapter?: () => ConversationChatAdapter;
  createAgentService?: (
    factoryInput: MainConversationAgentFactoryInput<{ dataCategories: { file: boolean } }>
  ) => CapabilityTaskAgentPort;
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
    { dataCategories: { file: boolean } }
  >> = [];
  const readAuthorizedRootPath = vi.fn(async () => input.authorizedRootPath ?? null);
  const readPrivacySettings = vi.fn(async () => ({
    dataCategories: { file: input.fileDisclosureAllowed ?? true }
  }));
  const createAgentService = vi.fn((factoryInput: MainConversationAgentFactoryInput<
    { dataCategories: { file: boolean } }
  >) => {
    agentFactoryInputs.push(factoryInput);
    if (input.createAgentService) return input.createAgentService(factoryInput);
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
        return { kind: 'completed' as const, acted: true };
      },
      cancelActive: vi.fn(),
      confirm: vi.fn(async () => undefined),
      cancelAction: vi.fn(),
      resetForNewConversation: vi.fn(async () => undefined),
      close: vi.fn()
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
    createChatAdapter: profile => input.createChatAdapter?.() ?? new ConversationChatAdapter({
      async respond(request) {
        chatRequests.push({ profileId: profile.id, request });
        const response = input.responses.shift();
        if (!response) throw new Error('聊天响应脚本已耗尽');
        return typeof response === 'string' ? { type: 'text', text: response } : response;
      }
    }),
    createAgentService,
    behavior: input.behavior ?? conversationBehaviorDouble(),
    emit: event => {
      input.behavior?.handleTaskEvent(event);
      events.push(event);
    }
  });
  return {
    agentFactoryInputs,
    chatRequests,
    composition,
    createAgentService,
    events,
    fileSubmissions,
    readAuthorizedRootPath,
    readPrivacySettings,
    setChatProfile(profileId: string) {
      chatProfileId = profileId;
    }
  };
}

function conversationBehaviorDouble(
  overrides: Partial<ConversationBehaviorPort> = {}
): ConversationBehaviorPort {
  return {
    prepareUserPrompt: vi.fn(async text => ({
      originalText: text,
      capabilityText: text,
      explicitDirective: null
    })),
    getChatContext: vi.fn(() => ({
      character: {
        characterName: '集成角色',
        semantics: ['idle', 'move', 'celebrate'],
        stateNames: ['Agent 专注'],
        actionNames: ['专注动作'],
        tags: [],
        candidates: [
          { kind: 'state_name', name: 'Agent 专注', semantic: 'focus', tags: [] },
          { kind: 'action_name', name: '专注动作', semantic: 'think', tags: [] }
        ]
      },
      runtime: {
        moving: false,
        dragging: false,
        carrying: false,
        movementStopped: false
      },
      proactivityMode: 'assistive',
      recentActions: []
    })),
    completeUserPrompt: vi.fn(),
    handleTaskEvent: vi.fn(),
    applyPlaybackFeedback: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

/** B7 纵向用例只伪造既有 Service/Motion 端口，真实执行 Coordinator、Adapter 与 Director。 */
function behaviorDirectorIntegrationFixture() {
  let token = 0;
  const notices: Array<{ code: string; message: string }> = [];
  const behavior = {
    getPublicBehaviorCatalog: vi.fn(() => ({
      characterName: '集成角色',
      semantics: ['idle', 'move', 'celebrate'] as const,
      stateNames: ['Agent 专注'],
      actionNames: ['专注动作'],
      tags: [],
      candidates: [
        { kind: 'state_name' as const, name: 'Agent 专注', semantic: 'focus', tags: [] },
        { kind: 'action_name' as const, name: '专注动作', semantic: 'think', tags: [] }
      ]
    })),
    getRecentPublicActions: vi.fn(() => []),
    resolveBehaviorTarget: vi.fn((target: BehaviorTarget): ResolvedBehaviorTarget => {
      if (target.kind === 'semantic') return target;
      if (target.kind === 'action_name' && target.name === '专注动作') {
        return { kind: 'action', actionId: 'focus-action' };
      }
      throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    }),
    isMovementBehaviorTarget: vi.fn((target: ResolvedBehaviorTarget) => (
      target.kind === 'semantic' && target.semantic === 'move'
    )),
    requestDirectedBehavior: vi.fn((target: ResolvedBehaviorTarget): CharacterBehaviorAuthorization => ({
      kind: 'play',
      actionId: target.kind === 'action'
        ? target.actionId
        : target.kind === 'state'
          ? `${target.stateId}-action`
          : `${target.semantic}-action`,
      playbackToken: `integration-chat-token-${++token}`,
      semantic: target.kind === 'semantic' ? target.semantic : 'think'
    })),
    requestProactiveBehavior: vi.fn((): CharacterBehaviorAuthorization => ({ kind: 'none' })),
    isMovementAgentIntent: vi.fn(() => false),
    handleAgentIntent: vi.fn((): CharacterBehaviorAuthorization => ({ kind: 'none' })),
    handleTaskEvent: vi.fn((): CharacterBehaviorAuthorization => ({ kind: 'none' })),
    applyPlaybackFeedback: vi.fn(),
    advance: vi.fn(() => []),
    handleActiveCharacterChanged: vi.fn(async () => undefined),
    close: vi.fn()
  };
  const motion = {
    getSnapshot: vi.fn(() => ({
      revision: 1,
      timestampMs: 0,
      position: { x: 0, y: 0 },
      target: null,
      direction: 'right' as const,
      moving: false,
      carrying: false
    })),
    requestIntent: vi.fn(() => ({
      revision: 1,
      timestampMs: 0,
      position: { x: 0, y: 0 },
      target: { x: ++token, y: 0 },
      direction: 'right' as const,
      moving: true,
      carrying: false
    })),
    stop: vi.fn()
  };
  const saveMovementStopped = vi.fn<(stopped: boolean) => Promise<void>>();
  const director = new CharacterBehaviorDirector({
    behavior,
    motion,
    initialGeneration: 'integration-chat-generation',
    initialSettings: { movementStopped: false, proactivityMode: 'assistive' },
    saveMovementStopped,
    publishNotice: notice => notices.push(notice)
  });
  saveMovementStopped.mockImplementation(async stopped => {
    director.applyBehaviorSettings({ movementStopped: stopped, proactivityMode: 'assistive' });
  });
  return { behavior, director, motion, notices, saveMovementStopped };
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

  test('后台 PowerShell 在组合入口稳定拒绝且不创建 Agent 或聊天请求', async () => {
    const fixture = conversationIntegrationHarness({ responses: [] });

    await expect(fixture.composition.coordinator.submit('后台运行构建'))
      .rejects.toMatchObject({ code: 'POWERSHELL_BACKGROUND_UNSUPPORTED' });

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

    expect(fixture.fileSubmissions).toEqual([expect.objectContaining({
      text: '读取 docs/note.txt',
      visibleHistory: []
    })]);
    expect(fixture.agentFactoryInputs[0]?.fallbackProfiles.map(profile => profile.id))
      .toEqual([conversationSameFallback.id]);
    expect(fixture.agentFactoryInputs[0]?.fallbackProfiles.map(profile => profile.id))
      .not.toContain(conversationCross.id);
    expect(fixture.chatRequests).toEqual([]);
    await fixture.composition.close();
  });

  test('默认隐私经完整聊天链解码 DeepSeek tool_calls 后确认落盘', async () => {
    const authorized = await createAuthorizedRoot();
    roots.push(authorized);
    const responses = [
      compatibleToolCall('vertical-create', 'builtin__files__create_file', {
        relativePath: 'Docs/Report.TXT', content: '正文'
      }),
      compatibleText('已创建文件')
    ];
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://deepseek.example/v1', modelId: 'deepseek-test', providerId: 'deepseek'
    }, async () => 'vertical-secret', vi.fn(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error('纵向 Provider 响应耗尽');
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const registry = createBuiltinFileToolRegistry();
    const permissionPolicy = new PermissionPolicy({ highRiskEnabled: false });
    const fixture = conversationIntegrationHarness({
      responses: [],
      authorizedRootPath: authorized.root,
      fileDisclosureAllowed: false,
      createAgentService: factoryInput => new AgentService({
        loop: new AgentLoop(),
        pending: new PendingActionStore(),
        createSession: async () => ({
          taskKind: 'file' as const,
          provider,
          fileTools: authorized.fileTools,
          fileDisclosureAllowed: false,
          tools: registry.definitions(),
          toolRuntime: {
            prepare: raw => registry.prepare(raw, permissionPolicy),
            executeRead: request => authorized.fileTools.executeRead(request)
          },
          messages: []
        }),
        emit: factoryInput.emit,
        createConversationId: () => 'vertical-file-conversation'
      })
    });
    const target = join(authorized.root, 'Docs', 'Report.TXT');

    await fixture.composition.coordinator.submit('创建 Docs\\Report.TXT 并写入正文');
    expect((requestBodies[0]?.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual([
      'builtin__files__create_file',
      'builtin__capability__request_clarification'
    ]);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const action = pendingAction(fixture.events);

    await fixture.composition.capabilityTasks.resolveAction(action.actionId, 'confirm');

    expect(await readFile(target, 'utf8')).toBe('正文');
    expect((await lstat(target)).isFile()).toBe(true);
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

  test.each([
    ['标准语义', { kind: 'play', target: { kind: 'semantic', semantic: 'celebrate' } }],
    ['当前角色自定义动作名', { kind: 'play', target: { kind: 'action_name', name: '专注动作' } }]
  ] as const)('同一次普通聊天 Provider 响应同时提交正文与%s', async (_label, behaviorPlan) => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '正文与动作来自同一次响应',
        structured_output: { behaviorPlan }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('请自然回应并配合动作');

    expect(fixture.chatRequests).toHaveLength(1);
    expect(fixture.chatRequests[0]?.request).toMatchObject({
      tools: [],
      toolChoice: 'none',
      responseContract: { type: 'json_object', name: 'character_chat' }
    });
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '正文与动作来自同一次响应'
    });
    expect(behaviorFixture.behavior.requestDirectedBehavior).toHaveBeenCalledOnce();
    await fixture.composition.close();
  });

  test.each([
    ['向左一点', { kind: 'relative', direction: 'left', distance: 'near' }],
    ['去右下角', { kind: 'region', region: 'bottom_right' }]
  ] as const)('明确移动“%s”在普通聊天 Provider 前取得动作授权并提交对象化运动', async (text, expectedIntent) => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const providerRespond = vi.fn(async (): Promise<ModelResponse> => ({
      type: 'text', text: '移动指令已处理', structured_output: {}
    }));
    const fixture = conversationIntegrationHarness({
      responses: [],
      behavior: behaviorFixture.director,
      createChatAdapter: () => new ConversationChatAdapter({ respond: providerRespond })
    });

    await fixture.composition.coordinator.submit(text);

    expect(behaviorFixture.behavior.requestDirectedBehavior).toHaveBeenCalledWith(
      { kind: 'semantic', semantic: 'move' },
      { urgency: 100, systemForced: true }
    );
    expect(behaviorFixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith(expectedIntent);
    expect(behaviorFixture.motion.requestIntent.mock.invocationCallOrder[0])
      .toBeLessThan(providerRespond.mock.invocationCallOrder[0]!);
    await fixture.composition.close();
  });

  test('Provider 建议不存在动作时保留正文、发布稳定提示且不以 idle 冒充', async () => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '仍然保留的自然正文',
        structured_output: {
          behaviorPlan: { kind: 'play', target: { kind: 'action_name', name: '不存在动作' } }
        }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('普通聊天');

    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '仍然保留的自然正文'
    });
    expect(behaviorFixture.notices).toEqual([{
      code: 'CHARACTER_ACTION_UNAVAILABLE',
      message: '当前角色没有可播放的对应动作。'
    }]);
    expect(behaviorFixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  test.each([
    ['停下', true],
    ['恢复活动', false]
  ] as const)('本地明确“%s”在 Provider 前持久化停止锁', async (text, stopped) => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const providerRespond = vi.fn(async (): Promise<ModelResponse> => ({
      type: 'text', text: '普通回复', structured_output: {}
    }));
    const fixture = conversationIntegrationHarness({
      responses: [],
      behavior: behaviorFixture.director,
      createChatAdapter: () => new ConversationChatAdapter({ respond: providerRespond })
    });

    await fixture.composition.coordinator.submit(text);

    expect(behaviorFixture.saveMovementStopped).toHaveBeenCalledExactlyOnceWith(stopped);
    expect(behaviorFixture.saveMovementStopped.mock.invocationCallOrder[0])
      .toBeLessThan(providerRespond.mock.invocationCallOrder[0]!);
    await fixture.composition.close();
  });

  test('普通聊天的持续 motionPlan 仅监视诊断快照，并在停止后终止续行', async () => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '我会继续活动。',
        structured_output: {
          behaviorPlan: { kind: 'none' },
          motionPlan: {
            mode: 'continuous',
            durationSeconds: null,
            target: 'random_work_area',
            distance: 'medium'
          }
        }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('请陪我活动一会');
    expect(behaviorFixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: true,
      continuousMovementRequested: true,
      currentTargetType: 'random_work_area'
    });
    behaviorFixture.director.handleMotionSnapshot({
      revision: 2, timestampMs: 1, position: { x: 0, y: 0 }, target: { x: 1, y: 1 },
      direction: 'right', moving: true, carrying: false
    });
    behaviorFixture.director.handleMotionSnapshot({
      revision: 3, timestampMs: 2, position: { x: 1, y: 1 }, target: { x: 1, y: 1 },
      direction: 'right', moving: false, carrying: false
    });
    expect(behaviorFixture.motion.requestIntent).toHaveBeenCalledTimes(2);

    await behaviorFixture.director.prepareUserPrompt('别乱跑');
    expect(behaviorFixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: false,
      continuousMovementRequested: false,
      currentTargetType: null
    });
    await fixture.composition.close();
  });

  test('跨 Provider 披露确认后重新读取当前行为上下文而不复用确认前快照', async () => {
    let movementStopped = false;
    const behavior = conversationBehaviorDouble({
      getChatContext: vi.fn(() => ({
        character: {
          characterName: '披露角色', semantics: ['idle'],
          stateNames: [], actionNames: [], tags: []
        },
        runtime: {
          moving: false, dragging: false, carrying: false, movementStopped
        },
        proactivityMode: 'assistive',
        recentActions: []
      }))
    });
    const fixture = conversationIntegrationHarness({
      responses: ['来源回复', '跨 Provider 回复'],
      behavior
    });
    await fixture.composition.coordinator.submit('来源消息');
    fixture.setChatProfile(conversationCross.id);
    await fixture.composition.coordinator.submit('目标消息');
    movementStopped = true;

    await fixture.composition.coordinator.resolveHistoryDisclosure(
      latestDisclosureRequest(fixture.events),
      'share_once'
    );

    expect(fixture.chatRequests[1]?.request.messages[0]?.content)
      .toContain('"movementStopped":true');
    expect(behavior.getChatContext).toHaveBeenCalledTimes(2);
    await fixture.composition.close();
  });

  test('真实 OpenAI-compatible fixture 保留同次 JSON Output 的正文与行为计划', async () => {
    const providerServer = await startProviderServer([{
      response: {
        type: 'text',
        text: 'fixture 同次正文',
        structured_output: {
          behaviorPlan: { kind: 'play', target: { kind: 'semantic', semantic: 'celebrate' } }
        }
      }
    }]);
    servers.push(providerServer);
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const provider = new OpenAICompatibleProvider({
      providerId: 'openai-compatible',
      modelId: 'behavior-json-model',
      baseUrl: providerServer.baseUrl
    }, async () => providerServer.apiKey);
    const fixture = conversationIntegrationHarness({
      responses: [],
      behavior: behaviorFixture.director,
      createChatAdapter: () => new ConversationChatAdapter(provider)
    });

    await fixture.composition.coordinator.submit('同次正文与动作');

    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: 'fixture 同次正文'
    });
    expect(behaviorFixture.behavior.requestDirectedBehavior).toHaveBeenCalledOnce();
    await fixture.composition.close();
  });

  test('PowerShell 确认后返回真实 stdout、stderr 与退出码', async () => {
    const fixture = await harness([
      {
        response: toolCall('powershell-success', 'builtin.powershell.run', {
          command: "Write-Output 'integration-stdout'; [Console]::Error.Write('integration-stderr'); exit 0"
        }),
        inspect: request => expect(request.tools.map(tool => tool.function.name))
          .toEqual(['builtin__powershell__run'])
      },
      {
        response: { type: 'text', text: 'PowerShell 已完成' },
        inspect: request => {
          const result = request.messages.at(-1);
          if (!result || result.role !== 'tool') throw new Error('MISSING_POWERSHELL_RESULT');
          expect(JSON.parse(result.content)).toMatchObject({
            toolName: 'powershell',
            ok: true,
            status: 'succeeded',
            exitCode: 0,
            stdout: expect.stringContaining('integration-stdout'),
            stderr: expect.stringContaining('integration-stderr')
          });
        }
      }
    ], 'powershell');

    await fixture.service.submitFileTask({ text: '执行 PowerShell 命令', visibleHistory: [] });
    const action = pendingAction(fixture.events);
    expect(action).toMatchObject({
      category: 'powershell',
      operation: 'powershell',
      command: expect.stringContaining('integration-stdout'),
      workingDirectoryLabel: '授权工作目录'
    });

    await fixture.service.confirm(action.actionId);

    expectProviderExchange(fixture.providerServer, 2);
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: 'PowerShell 已完成'
    });
  });

  test('PowerShell 非零退出会把真实失败结果续跑为 error 终态', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    const spawn = vi.fn(() => child);
    const powershell = new PowerShellTool({
      processPort: { spawn, killTree: async () => undefined }
    });
    const fixture = await harness([
      {
        response: toolCall('powershell-failure', 'builtin.powershell.run', {
          command: 'exit 7'
        })
      },
      {
        response: { type: 'text', text: '命令失败' },
        inspect: request => {
          const last = request.messages.at(-1);
          if (!last || last.role !== 'tool') throw new Error('缺少 PowerShell 失败结果');
          expect(JSON.parse(last.content)).toMatchObject({
            toolName: 'powershell', ok: false, status: 'failed', exitCode: 7
          });
        }
      }
    ], 'powershell', powershell);

    await fixture.service.submitFileTask({ text: '执行 exit 7', visibleHistory: [] });
    const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
    await Promise.resolve();
    child.emit('close', 7);
    await confirming;

    expect(spawn).toHaveBeenCalledOnce();
    expect(fixture.events).toContainEqual({ type: 'phase', phase: 'error' });
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('取消 PowerShell 确认不启动进程', async () => {
    const spawn = vi.fn();
    const powershell = new PowerShellTool({
      processPort: {
        spawn: spawn as never,
        killTree: async () => undefined
      }
    });
    const fixture = await harness([{
      response: toolCall('powershell-cancel', 'builtin.powershell.run', {
        command: 'Write-Output no-spawn'
      })
    }], 'powershell', powershell);

    await fixture.service.submitFileTask({ text: '执行 Write-Output no-spawn', visibleHistory: [] });
    fixture.service.cancelAction(pendingAction(fixture.events).actionId);

    expect(spawn).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual({ type: 'phase', phase: 'cancelled' });
    expectProviderExchange(fixture.providerServer, 1);
  });

  test('reset 等待 PowerShell 收敛并忽略迟到 close 事件', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4322,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    const killTree = vi.fn(async () => undefined);
    const fixture = await harness([
      {
        response: toolCall('powershell-reset', 'builtin.powershell.run', {
          command: 'Write-Output reset-late'
        })
      },
      { response: { type: 'text', text: '迟到总结不得公开' } }
    ], 'powershell', new PowerShellTool({
      processPort: { spawn: vi.fn(() => child), killTree }
    }));

    await fixture.service.submitFileTask({ text: '执行 Write-Output reset-late', visibleHistory: [] });
    const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
    await Promise.resolve();
    const resetting = fixture.service.resetForNewConversation();
    child.emit('close', 0);
    await resetting;
    await confirming;

    expect(killTree).toHaveBeenCalledWith(4322);
    expect(fixture.events).not.toContainEqual({
      type: 'message', role: 'assistant', text: '迟到总结不得公开'
    });
    expect(fixture.providerServer.requests).toHaveLength(1);
    expect(fixture.providerServer.remainingSteps()).toBe(1);
  });

  test('PowerShell 静默超时公开 error 且迟到流事件不会续跑 Provider', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4323,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    const spawn = vi.fn(() => child);
    const fixture = await harness([
      {
        response: toolCall('powershell-timeout', 'builtin.powershell.run', {
          command: 'Write-Output timeout-late'
        })
      },
      {
        response: { type: 'text', text: '命令已超时。' },
        inspect: request => {
          const result = request.messages.at(-1);
          if (!result || result.role !== 'tool') throw new Error('缺少 PowerShell 超时结果');
          expect(JSON.parse(result.content)).toMatchObject({
            toolName: 'powershell',
            ok: false,
            status: 'timed_out',
            timeoutKind: 'idle'
          });
        }
      }
    ], 'powershell', new PowerShellTool({
      processPort: { spawn, killTree: async () => undefined }
    }));

    await fixture.service.submitFileTask({ text: '执行 Write-Output timeout-late', visibleHistory: [] });
    vi.useFakeTimers();
    try {
      const confirming = fixture.service.confirm(pendingAction(fixture.events).actionId);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      await confirming;
    } finally {
      vi.useRealTimers();
    }

    expect(spawn).toHaveBeenCalledOnce();
    expect(fixture.events).toContainEqual({ type: 'phase', phase: 'error' });
    expectProviderExchange(fixture.providerServer, 2);
    const eventsAfterTimeout = [...fixture.events];
    child.stdout.write('late-stdout');
    child.stderr.write('late-stderr');
    child.emit('close', 0);
    await Promise.resolve();
    expect(fixture.events).toEqual(eventsAfterTimeout);
    expect(fixture.providerServer.requests).toHaveLength(2);
  });
});

describe('桌面 Agent 真实服务集成', () => {
  test('行为集成清单经严格 Schema 自证', () => {
    const manifest = createBehaviorManifest();

    expect(characterManifestV2Schema.parse(manifest)).toEqual(manifest);
  });

  test('DeepSeek 外部别名删除空目录时确认前无副作用且确认后只进入一次隔离回收站', async () => {
    const recycledName = '.recycled-deepseek-empty';
    let recycledPath = '';
    const recycle = vi.fn(async (absolutePath: string) => {
      recycledPath = join(absolutePath, '..', recycledName);
      await rename(absolutePath, recycledPath);
    });
    const fixture = await deepSeekHarness({
      responses: [
        compatibleToolCall(
          'deepseek-delete-empty',
          'builtin__files__delete_file',
          { relativePath: 'empty' }
        ),
        compatibleText('empty 已移入回收站')
      ],
      moveToRecycleBin: recycle
    });
    const source = join(fixture.authorized.root, 'empty');
    await mkdir(source);

    await fixture.service.submitFileTask({
      text: '帮我把当前目录下的empty文件夹删除了',
      visibleHistory: []
    });

    expect(fixture.events.filter(event => (
      event.type === 'pending_action' || event.type === 'message'
    )).map(event => event.type)).toEqual(['pending_action']);
    await expect(lstat(source)).resolves.toBeDefined();
    expect(recycle).not.toHaveBeenCalled();
    expect(fixture.requestBodies[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      tool_choice: 'required',
      thinking: { type: 'disabled' }
    });
    expect((fixture.requestBodies[0]?.tools as Array<{ function: { name: string } }>).map(
      tool => tool.function.name
    )).toContain('builtin__files__delete_file');

    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    expect(recycle).toHaveBeenCalledOnce();
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(recycledPath)).resolves.toBeDefined();
    expect(fixture.fetchClient).toHaveBeenCalledTimes(2);
    expect(fixture.responses).toHaveLength(0);
    expect(fixture.requestBodies[1]).toMatchObject({ tools: [], tool_choice: 'none' });
    expect(fixture.events.filter(event => event.type === 'message')).toEqual([{
      type: 'message', role: 'assistant', text: 'empty 已移入回收站'
    }]);
  });

  test('DeepSeek 外部别名创建文件显示确认且独占创建拒绝覆盖同名目标', async () => {
    const fixture = await deepSeekHarness({
      responses: [
        compatibleToolCall(
          'deepseek-create-file',
          'builtin__files__create_file',
          { relativePath: 'created.txt', content: 'DeepSeek 受控正文\n' }
        ),
        compatibleText('created.txt 已创建'),
        compatibleToolCall(
          'deepseek-create-duplicate',
          'builtin__files__create_file',
          { relativePath: 'created.txt', content: '不得覆盖\n' }
        )
      ]
    });
    const target = join(fixture.authorized.root, 'created.txt');

    await fixture.service.submitFileTask({ text: '创建 created.txt', visibleHistory: [] });
    expect(pendingAction(fixture.events)).toMatchObject({
      operation: 'create_file',
      targetRelativePath: 'created.txt'
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });

    await fixture.service.confirm(pendingAction(fixture.events).actionId);
    await expect(readFile(target, 'utf8')).resolves.toBe('DeepSeek 受控正文\n');
    await expect(fixture.service.submitFileTask({
      text: '再次创建 created.txt',
      visibleHistory: []
    })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });

    await expect(readFile(target, 'utf8')).resolves.toBe('DeepSeek 受控正文\n');
    expect(fixture.events.filter(event => event.type === 'pending_action')).toHaveLength(1);
    expect(fixture.fetchClient).toHaveBeenCalledTimes(3);
  });

  test('DeepSeek 结构化澄清只公开宿主固定文案且不产生确认或文件副作用', async () => {
    const fixture = await deepSeekHarness({
      responses: [compatibleToolCall(
        'deepseek-clarification',
        'builtin__capability__request_clarification',
        { missingField: 'target_path' }
      )]
    });
    const before = await readdir(fixture.authorized.root, { recursive: true });

    await fixture.service.submitFileTask({ text: '帮我创建一个文件', visibleHistory: [] });

    expect(fixture.events.filter(event => event.type === 'message')).toEqual([{
      type: 'message', role: 'assistant', text: '请提供目标文件或目录的相对路径。'
    }]);
    expect(fixture.events.some(event => event.type === 'pending_action')).toBe(false);
    await expect(readdir(fixture.authorized.root, { recursive: true })).resolves.toEqual(before);
    expect(fixture.fetchClient).toHaveBeenCalledOnce();
  });

  test('文件数据授权关闭时只读文件工具不暴露给 DeepSeek', async () => {
    const fixture = await deepSeekHarness({
      fileDisclosureAllowed: false,
      responses: [compatibleToolCall(
        'deepseek-file-disclosure-disabled',
        'builtin__capability__request_clarification',
        { missingField: 'file_data_authorization' }
      )]
    });
    const before = await readdir(fixture.authorized.root, { recursive: true });

    await fixture.service.submitFileTask({
      text: '列出 private 目录', visibleHistory: [], planningHint: { operation: 'list_files' }
    });

    expect((fixture.requestBodies[0]?.tools as Array<{ function: { name: string } }>).map(
      tool => tool.function.name
    )).toEqual([
      'builtin__capability__request_clarification'
    ]);
    expect(fixture.events.filter(event => event.type === 'message')).toEqual([{
      type: 'message', role: 'assistant', text: '请先开启文件数据授权。'
    }]);
    expect(fixture.events.some(event => event.type === 'pending_action')).toBe(false);
    await expect(readdir(fixture.authorized.root, { recursive: true })).resolves.toEqual(before);
  });

  test('文件数据授权关闭时 DeepSeek 明确目录创建和删除仍走 Main 确认及回收站闭环', async () => {
    const recycledName = '.recycled-private-directory';
    let recycledPath = '';
    const recycle = vi.fn(async (absolutePath: string) => {
      recycledPath = join(absolutePath, '..', recycledName);
      await rename(absolutePath, recycledPath);
    });
    const fixture = await deepSeekHarness({
      fileDisclosureAllowed: false,
      moveToRecycleBin: recycle,
      responses: [
        compatibleToolCall(
          'private-create-directory',
          'builtin__files__create_directory',
          { relativePath: 'private-directory' }
        ),
        compatibleText('目录已创建'),
        compatibleToolCall(
          'private-delete-directory',
          'builtin__files__delete_file',
          { relativePath: 'private-directory' }
        ),
        compatibleText('目录已移入回收站')
      ]
    });
    const target = join(fixture.authorized.root, 'private-directory');

    await fixture.service.submitFileTask({
      text: '创建 private-directory 目录',
      visibleHistory: [],
      planningHint: { operation: 'create_directory' }
    });

    expect((fixture.requestBodies[0]?.tools as Array<{ function: { name: string } }>).map(
      tool => tool.function.name
    )).toEqual([
      'builtin__files__create_directory',
      'builtin__capability__request_clarification'
    ]);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.service.confirm(pendingAction(fixture.events).actionId);
    expect((await lstat(target)).isDirectory()).toBe(true);

    await fixture.service.submitFileTask({
      text: '删除 private-directory 目录',
      visibleHistory: [],
      planningHint: { operation: 'delete_file' }
    });

    expect((fixture.requestBodies[2]?.tools as Array<{ function: { name: string } }>).map(
      tool => tool.function.name
    )).toEqual([
      'builtin__files__delete_file',
      'builtin__capability__request_clarification'
    ]);
    await expect(lstat(target)).resolves.toBeDefined();
    const deleteEvent = fixture.events.filter(event => event.type === 'pending_action').at(-1);
    if (!deleteEvent || deleteEvent.type !== 'pending_action') throw new Error('缺少删除确认卡');
    await fixture.service.confirm(deleteEvent.action.actionId);

    expect(recycle).toHaveBeenCalledOnce();
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(recycledPath)).isDirectory()).toBe(true);
  });

  test('文件数据授权关闭时 DeepSeek 创建文件和补丁均绑定目标并产生真实副作用', async () => {
    const fixture = await deepSeekHarness({
      fileDisclosureAllowed: false,
      responses: [
        compatibleToolCall('private-create-file', 'builtin__files__create_file', {
          relativePath: 'private.txt', content: 'before\n'
        }),
        compatibleText('文件已创建'),
        compatibleToolCall('private-apply-patch', 'builtin__files__apply_patch', {
          relativePath: 'private.txt', patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
        }),
        compatibleText('文件已修改')
      ]
    });
    const target = join(fixture.authorized.root, 'private.txt');

    await fixture.service.submitFileTask({
      text: '创建 private.txt 并写入正文', visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });
    await fixture.service.confirm(pendingAction(fixture.events).actionId);
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n');

    await fixture.service.submitFileTask({
      text: '修改 private.txt', visibleHistory: [],
      planningHint: { operation: 'apply_patch' }
    });
    const patchEvent = fixture.events.filter(event => event.type === 'pending_action').at(-1);
    if (!patchEvent || patchEvent.type !== 'pending_action') throw new Error('缺少补丁确认卡');
    await fixture.service.confirm(patchEvent.action.actionId);
    await expect(readFile(target, 'utf8')).resolves.toBe('after\n');
  });

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
      getDisplays: () => [{
        id: 'integration-display',
        workAreaDip: { x: 0, y: 0, width: 1_024, height: 768 }
      }],
      getGeometrySnapshot: () => ({
        revision: 1,
        characterId: 'integration-character',
        scale: 1,
        footAnchorDip: { x: bounds.x + 128, y: bounds.y + 256 },
        visualBoundsInWindowDip: { x: 0, y: 0, width: 256, height: 256 },
        windowBoundsDip: bounds,
        displayId: 'integration-display'
      }),
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
    const fixture = await harness(
      responses.flatMap((response, index) => ([
        { response: toolCall(`behavior-read-${index}`, 'builtin.files.list_files', { relativePath: '.' }) },
        { response }
      ])),
      'file',
      undefined,
      intent => behavior.handleAgentIntent(intent),
      event => behavior.handleTaskEvent(event)
    );
    const taskEvents = fixture.events;
    // 生产链由 Main Coordinator 先发布 listening，再把明确文件任务交给 Agent。
    const submitAgentTask = async (text: string): Promise<void> => {
      const listening = { type: 'phase', phase: 'listening' } as const;
      taskEvents.push(listening);
      behavior.handleTaskEvent(listening);
      await fixture.service.submitFileTask({ text, visibleHistory: [] });
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

    const autonomousDirector = new CharacterBehaviorDirector({
      behavior,
      motion,
      initialGeneration: 'integration-autonomous',
      initialSettings: { movementStopped: false, proactivityMode: 'autonomous' },
      saveMovementStopped: async () => undefined
    });
    expect(autonomousDirector.requestBehaviorPlan({
      kind: 'play', target: { kind: 'semantic', semantic: 'move' }
    }, 'local-idle')).toMatchObject({ kind: 'play', semantic: 'move' });
    let motionSnapshot = motion.getSnapshot();
    for (let step = 1; step <= 100 && (step === 1 || motionSnapshot.moving); step += 1) {
      now = step * 100;
      motionSnapshot = motion.tick();
    }
    expect(behaviorEvents).toContainEqual(expect.objectContaining({ actionId: 'move-action' }));
    expect(positions.length).toBeGreaterThan(0);
    expect(motionSnapshot.moving).toBe(false);
    expect(Math.hypot(
      motionSnapshot.position.x - motionSnapshot.target.x,
      motionSnapshot.position.y - motionSnapshot.target.y
    )).toBeLessThanOrEqual(24);
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'idle-action' });

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
    await autonomousDirector.close();
  });

  test('Renderer 真实图集编译挂起时 Main Agent 请求仍先完成', async () => {
    const fixture = await harness([{
      response: toolCall('compile-list', 'builtin.files.list_files', { relativePath: '.' })
    }, {
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
    expectProviderExchange(fixture.providerServer, 2);

    child.send({ type: 'release_decode' });
    await expect(compileResult).resolves.toMatchObject({
      width: 2,
      height: 2,
      frameCount: 1
    });
  });

  test('能力规划通过七个文件工具和结构化澄清工具列出授权目录', async () => {
    const fixture = await harness([
      {
        response: toolCall('list-1', 'builtin.files.list_files', { relativePath: '.' }),
        inspect: request => expect(request.tools.map(tool => tool.function.name)).toEqual([
          'builtin__files__list_files',
          'builtin__files__read_file',
          'builtin__files__create_file',
          'builtin__files__move_file',
          'builtin__files__create_directory',
          'builtin__files__apply_patch',
          'builtin__files__delete_file',
          'builtin__capability__request_clarification'
        ])
      },
      {
        response: { type: 'text', text: '目录已列出' },
        inspect: request => {
          const last = request.messages.at(-1);
          expect(last).toMatchObject({ role: 'tool', toolCallId: 'list-1' });
          if (!last || last.role !== 'tool') throw new Error('缺少列目录工具结果');
          expect(JSON.parse(last.content)).toMatchObject({
            toolName: 'list_files',
            relativePath: '.',
            entries: expect.arrayContaining([
              expect.objectContaining({ relativePath: 'docs', type: 'directory' })
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
    const content = '第一行\n第二行\n第三行\n';
    const fixture = await harness([
      {
        response: toolCall(
          'read-1',
          'builtin.files.read_file',
          { relativePath: 'docs/note.txt', startLine: 2, lineCount: 1 }
        )
      },
      {
        response: { type: 'text', text: '文本已读取' },
        inspect: request => {
          const last = request.messages.at(-1);
          expect(last).toMatchObject({ role: 'tool', toolCallId: 'read-1' });
          if (!last || last.role !== 'tool') throw new Error('缺少工具结果');
          expect(JSON.parse(last.content)).toMatchObject({
            toolName: 'read_file',
            relativePath: 'docs/note.txt',
            content: '第二行',
            startLine: 2,
            endLine: 2,
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

  test('口头拒绝只触发一次协议修复并继续真实工具调用', async () => {
    const fixture = await harness([
      { response: { type: 'text', text: '我没有权限执行这个文件任务。' } },
      {
        response: toolCall('repair-after-refusal', 'builtin.files.create_file', {
          relativePath: 'repaired.txt', content: '已修复\n'
        }),
        inspect: request => {
          expect(request.tools.map(tool => tool.function.name)).toEqual([
            'builtin__files__list_files',
            'builtin__files__read_file',
            'builtin__files__create_file',
            'builtin__files__move_file',
            'builtin__files__apply_patch',
            'builtin__files__delete_file',
            'builtin__capability__request_clarification'
          ]);
          expect(request.messages.at(-1)).toMatchObject({
            role: 'system', content: expect.stringContaining('CAPABILITY_PLAN_PROTOCOL_INVALID')
          });
        }
      },
      { response: { type: 'text', text: '文件已创建。' } }
    ]);

    await fixture.service.submitFileTask({ text: '创建 repaired.txt', visibleHistory: [] });
    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    await expect(readFile(join(fixture.authorized.root, 'repaired.txt'), 'utf8')).resolves.toBe('已修复\n');
    expectProviderExchange(fixture.providerServer, 3);
  });

  test('真实 OpenAI-compatible 修复轮不泄露内部澄清名并使用当轮外部别名', async () => {
    const clarificationResponse: ModelResponse = {
      type: 'tool_request',
      request: {
        requestId: 'repair-with-provider-alias',
        toolName: '由当轮请求替换',
        arguments: { missingField: 'target_path' }
      }
    };
    const fixture = await harness([
      { response: { type: 'text', text: '请补充信息。' } },
      {
        response: clarificationResponse,
        inspect: request => {
          const providerDefinition = request.tools.find(tool => (
            tool.function.description.includes('澄清')
          ));
          if (!providerDefinition) throw new Error('缺少结构化澄清工具');
          const responseRequest = clarificationResponse.request as { toolName: string };
          responseRequest.toolName = providerDefinition.function.name;
          const systemMessage = request.messages.at(-1);
          expect(systemMessage).toMatchObject({ role: 'system' });
          if (!systemMessage || systemMessage.role !== 'system') {
            throw new Error('缺少协议修复系统消息');
          }
          expect(systemMessage.content).not.toContain(
            'builtin.capability.request_clarification'
          );
        }
      }
    ]);

    await fixture.service.submitFileTask({ text: '帮我创建一个文件', visibleHistory: [] });

    expect(fixture.events.filter(event => event.type === 'message')).toEqual([{
      type: 'message', role: 'assistant', text: '请提供目标文件或目录的相对路径。'
    }]);
    expect(fixture.providerServer.inspectionErrors).toEqual([]);
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('连续口头伪成功在一次修复后稳定报 CAPABILITY_PLAN_PROTOCOL_INVALID', async () => {
    const fixture = await harness([
      { response: { type: 'text', text: '文件已经创建完成。' } },
      { response: { type: 'text', text: '文件已经创建完成。' } }
    ]);

    await expect(fixture.service.submitFileTask({ text: '创建 fake-success.txt', visibleHistory: [] }))
      .rejects.toMatchObject({ code: 'CAPABILITY_PLAN_PROTOCOL_INVALID' });
    await expect(lstat(join(fixture.authorized.root, 'fake-success.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('回收站预览使用显式 operation，取消不执行系统操作', async () => {
    const fixture = await harness([{
      response: toolCall(
        'recycle-cancel',
        'builtin.files.delete_file',
        { relativePath: 'docs' }
      )
    }]);

    await fixture.service.submitFileTask({
      text: '将 docs 移入回收站',
      visibleHistory: []
    });
    const action = pendingAction(fixture.events);
    expect(action).toMatchObject({
      operation: 'delete_file',
      summary: '删除目录 docs',
      targetRelativePath: 'docs'
    });

    fixture.service.cancelAction(action.actionId);

    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.root, 'docs'))).resolves.toBeDefined();
  });

  test('没有搬运动作端口时回收站确认后立即执行且只执行一次', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'recycle-confirm',
          'builtin.files.delete_file',
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
    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(recycled, 'utf8')).resolves.toBe('旧内容');
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('空目录确认后经回收站端口移除', async () => {
    const fixture = await harness([
      { response: toolCall('delete-empty-directory', 'builtin.files.delete_file', { relativePath: 'empty' }) },
      { response: { type: 'text', text: '空目录已移入回收站' } }
    ]);
    const source = join(fixture.authorized.root, 'empty');
    const recycled = join(fixture.authorized.root, '.recycled-empty');
    await mkdir(source);
    fixture.authorized.fileTools = new FileToolService(fixture.authorized.policy, {
      moveToRecycleBin: absolutePath => rename(absolutePath, recycled)
    });

    await fixture.service.submitFileTask({ text: '删除 empty', visibleHistory: [] });
    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(recycled)).resolves.toBeDefined();
    expectProviderExchange(fixture.providerServer, 2);
  });

  test('非空目录在确认前被拒绝且不调用回收站端口', async () => {
    const fixture = await harness([{
      response: toolCall('delete-nonempty-directory', 'builtin.files.delete_file', { relativePath: 'nonempty' })
    }]);
    const target = join(fixture.authorized.root, 'nonempty');
    await mkdir(target);
    await writeFile(join(target, 'child.txt'), '保留', 'utf8');
    const recycle = vi.fn(async () => undefined);
    fixture.authorized.fileTools = new FileToolService(fixture.authorized.policy, {
      moveToRecycleBin: recycle
    });

    await expect(fixture.service.submitFileTask({ text: '删除 nonempty', visibleHistory: [] }))
      .rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
    expect(recycle).not.toHaveBeenCalled();
    await expect(readFile(join(target, 'child.txt'), 'utf8')).resolves.toBe('保留');
  });

  test('系统回收站失败时原文件保留且只发布一次失败终态', async () => {
    const fixture = await harness([{
      response: toolCall(
        'recycle-port-failure',
        'builtin.files.delete_file',
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
    await expect(fixture.service.confirm(pendingAction(fixture.events).actionId))
      .rejects.toMatchObject({ code: 'RECYCLE_BIN_FAILED' });
    expect(recycleCalls).toBe(1);
    await expect(readFile(source, 'utf8')).resolves.toBe('保留内容');
    expect(fixture.events.filter(event => (
      event.type === 'error' && event.code === 'RECYCLE_BIN_FAILED'
    ))).toHaveLength(1);
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

  test('新建带正文文件确认后会独占创建并保留正文', async () => {
    const fixture = await harness([
      {
        response: toolCall(
          'create-confirm',
          'builtin.files.create_file',
          { relativePath: 'created.txt', content: '受控正文\n' }
        )
      },
      { response: { type: 'text', text: '空文件已创建' } }
    ]);
    await fixture.service.submitFileTask({ text: '新建 created.txt', visibleHistory: [] });

    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    expectProviderExchange(fixture.providerServer, 2);
    await expect(readFile(join(fixture.authorized.root, 'created.txt'), 'utf8')).resolves.toBe('受控正文\n');
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '空文件已创建'
    });
  });

  test('重命名预览后确认会移动源条目且不复制', async () => {
    const fixture = await harness([
      {
        response: toolCall('patch-confirm', 'builtin.files.apply_patch', {
          relativePath: 'docs/before.txt',
          patch: '@@ -1,1 +1,1 @@\n-原始内容\n+修改后内容\n'
        })
      },
      { response: { type: 'text', text: '补丁已应用' } }
    ]);
    await writeFile(join(fixture.authorized.root, 'docs', 'before.txt'), '原始内容', 'utf8');
    await fixture.service.submitFileTask({ text: '修改文件', visibleHistory: [] });

    await fixture.service.confirm(pendingAction(fixture.events).actionId);

    expectProviderExchange(fixture.providerServer, 2);
    await expect(readFile(join(fixture.authorized.root, 'docs', 'before.txt'), 'utf8'))
      .resolves.toBe('修改后内容');
    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '补丁已应用'
    });
  });

  test('补丁确认后外部改动会以 ENTRY_CHANGED 拒绝且保留外部内容', async () => {
    const fixture = await harness([{
      response: toolCall('patch-entry-changed', 'builtin.files.apply_patch', {
        relativePath: 'docs/conflict.txt',
        patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
      })
    }]);
    const target = join(fixture.authorized.root, 'docs', 'conflict.txt');
    await writeFile(target, 'before\n', 'utf8');

    await fixture.service.submitFileTask({ text: '修改 docs/conflict.txt', visibleHistory: [] });
    await writeFile(target, 'external\n', 'utf8');

    await expect(fixture.service.confirm(pendingAction(fixture.events).actionId))
      .rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(readFile(target, 'utf8')).resolves.toBe('external\n');
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'ENTRY_CHANGED'
    }));
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

  test('旧文件工具名在本地工具注册表稳定拒绝为 TOOL_UNKNOWN', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(() => registry.prepare({
      requestId: 'legacy-list',
      toolName: 'builtin.files.list_directory',
      arguments: { relativePath: '.' }
    }, policy)).toThrow('TOOL_UNKNOWN');
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
