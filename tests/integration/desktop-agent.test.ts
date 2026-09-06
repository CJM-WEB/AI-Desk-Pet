import {
type ModelProvider,
type ModelResponse
} from '@myself/agent-core';
import type {
BehaviorTarget,
CharacterBehaviorAuthorization,
CharacterBehaviorPlan,
CharacterManifestV2,
ResolvedBehaviorTarget
} from '@myself/character-runtime';
import type { ProviderCatalogEntry,ProviderProfileV2,TaskEvent } from '@myself/shared-types';
import { fork,type ChildProcess } from 'node:child_process';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach,describe,expect,test,vi } from 'vitest';
import { PrivacySessionRegistry } from '../../apps/desktop/src/main/agent/disclosure-policy';
import type { ConversationBehaviorPort } from '../../apps/desktop/src/main/characters/character-behavior-director';
import { CharacterBehaviorDirector } from '../../apps/desktop/src/main/characters/character-behavior-director';
import { CharacterBehaviorService } from '../../apps/desktop/src/main/characters/character-behavior-service';
import { CharacterMotionService } from '../../apps/desktop/src/main/characters/character-motion-service';
import { CharacterProactivityScheduler } from '../../apps/desktop/src/main/characters/character-proactivity-scheduler';
import type { CapabilityTaskAgentPort } from '../../apps/desktop/src/main/conversation/capability-task-adapter';
import { ConversationChatAdapter } from '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import {
createMainConversationComposition,
type MainConversationAgentFactoryInput
} from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import type { ProviderSettingsSnapshot } from '../../apps/desktop/src/main/storage/settings-store';
import { characterManifestV2Schema } from '../../packages/character-runtime/src/character-v2-schema';
import { createAuthorizedRoot,createCodingConversation,type AuthorizedRootFixture } from '../fixtures/authorized-root';
import { parseMainE2eState } from '../fixtures/electron-app';
import {
codingResponse,startProviderServer,
type ProviderServerFixture
} from '../fixtures/provider-server';

const strictGeometryState = () => ({
  revision: 1,
  buildIdentity: {
    commitShortHash: '0123456789ab',
    buildRootCategory: 'linked_worktree'
  },
  petWindowVisible: true,
  petWindowAlwaysOnTop: true,
  processedExplorerEventRevision: 0,
  processedExplorerEvent: null,
  petWindowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
  petNativeDragging: false,
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
  test.each([
    ['非短哈希', { commitShortHash: 'not-a-commit', buildRootCategory: 'linked_worktree' }],
    ['未知构建根类别', {
      commitShortHash: '0123456789ab', buildRootCategory: 'C:\\private\\checkout'
    }],
    ['额外构建路径', {
      commitShortHash: '0123456789ab',
      buildRootCategory: 'linked_worktree',
      buildRootPath: 'C:\\private\\checkout'
    }]
  ] as const)('拒绝构建身份中的%s', (_name, buildIdentity) => {
    const state = { ...strictGeometryState(), buildIdentity };

    expect(() => parseMainE2eState(state)).toThrow('ELECTRON_E2E_MAIN_STATE_INVALID');
  });

  test('只接受四个有限整数构成的桌宠窗口边界', () => {
    expect(parseMainE2eState(strictGeometryState()).petWindowBoundsDip).toEqual({
      x: 300,
      y: 200,
      width: 180,
      height: 220
    });

    const state = strictGeometryState();
    state.petWindowBoundsDip = { ...state.petWindowBoundsDip, path: '禁止披露' } as unknown as (
      typeof state.petWindowBoundsDip
    );
    expect(() => parseMainE2eState(state)).toThrow('ELECTRON_E2E_MAIN_STATE_INVALID');
  });

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
const providerFileToolNames = [
  'builtin__files__list_files',
  'builtin__files__read_file',
  'builtin__files__glob_files',
  'builtin__files__grep_files',
  'builtin__files__create_file',
  'builtin__files__move_file',
  'builtin__files__create_directory',
  'builtin__files__apply_patch',
  'builtin__files__edit_file',
  'builtin__files__delete_file'
] as const;
const providerFilePlanningToolNames = [
  ...providerFileToolNames,
  'builtin__capability__request_clarification'
] as const;
const internalToolNames = [
  'list_files',
  'read_file',
  'glob_files',
  'grep_files',
  'create_file',
  'move_file',
  'create_directory',
  'apply_patch',
  'edit_file',
  'delete_file'
] as const;

const roots: AuthorizedRootFixture[] = [];
const servers: ProviderServerFixture[] = [];
const compileProcesses: ChildProcess[] = [];

afterEach(async () => {
    try {
      await Promise.all(servers.splice(0).map(server => server.close()));
    } finally {
      for (const child of compileProcesses.splice(0)) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all(roots.splice(0).map(root => root.cleanup()));
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

function completeIntegrationChatResponse(response: ModelResponse): ModelResponse {
  if (response.type !== 'text') return response;
  return {
    ...response,
    structured_output: {
      activity: '集成聊天',
      status: 'idle',
      movementControl: { kind: 'keep' },
      behaviorPlan: { kind: 'none' },
      capabilityPlan: { kind: 'chat' },
      ...response.structured_output
    }
  };
}

function conversationIntegrationHarness(input: {
  responses: Array<string | ModelResponse>;
  authorizedRootPath?: string | null;
  providerSettings?: ProviderSettingsSnapshot;
  catalog?: readonly ProviderCatalogEntry[];
  assertProviderReady?: (profile: ProviderProfileV2) => void;
  incognito?: boolean;
  behavior?: ConversationBehaviorPort;
  createChatAdapter?: () => ConversationChatAdapter;
  createAgentService?: (
    factoryInput: MainConversationAgentFactoryInput<{ dataCategories: { memory: boolean } }>
  ) => CapabilityTaskAgentPort;
}) {
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('integration-conversation', {
    incognito: input.incognito ?? false
  });
  const defaultProviderSettings: ProviderSettingsSnapshot = {
    profiles: [conversationPrimary, conversationSameFallback, conversationCross],
    route: {
      primaryProfileId: conversationPrimary.id,
      chatProfileId: conversationPrimary.id,
      agentProfileId: conversationPrimary.id,
      visionProfileId: null,
      fallbackProfileIds: [conversationSameFallback.id, conversationCross.id],
      allowCrossProviderFallback: true
    }
  };
  const providerSettings = input.providerSettings ?? defaultProviderSettings;
  let chatProfileId = providerSettings.route.chatProfileId;
  const events: TaskEvent[] = [];
  const chatRequests: Array<{ profileId: string; request: Parameters<ModelProvider['respond']>[0] }> = [];
  const fileSubmissions: Array<{
    text: string;
    visibleHistory: readonly unknown[];
  }> = [];
  const agentFactoryInputs: Array<MainConversationAgentFactoryInput<
    { dataCategories: { memory: boolean } }
  >> = [];
  const readAuthorizedRootPath = vi.fn(async () => input.authorizedRootPath ?? null);
  const readPrivacySettings = vi.fn(async () => ({
    dataCategories: { memory: false }
  }));
  const createAgentService = vi.fn((factoryInput: MainConversationAgentFactoryInput<
    { dataCategories: { memory: boolean } }
  >) => {
    agentFactoryInputs.push(factoryInput);
    if (input.createAgentService) return input.createAgentService(factoryInput);
    throw new Error('普通聊天不应创建任务服务');
  });
  const composition = createMainConversationComposition({
    catalog: input.catalog ?? [],
    privacySessions,
    sessionId: 'integration-conversation',
    ...(input.assertProviderReady === undefined ? {} : { assertProviderReady: input.assertProviderReady }),
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
        return completeIntegrationChatResponse(
          typeof response === 'string' ? { type: 'text', text: response } : response
        );
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
        identity: {
          name: '集成角色', description: '集成测试角色', background: '测试环境', traits: [],
          languageStyle: '简洁', likes: [], behavioralTendencies: []
        },
        states: [{
          name: 'Agent 专注', semantic: 'focus', tags: [],
          actions: [
            { name: '专注动作', semantic: 'think', tags: [] },
            { name: '庆祝动作', semantic: 'celebrate', tags: [] }
          ]
        }]
      },
      runtime: {
        moving: false,
        dragging: false,
        carrying: false,
        movementMode: 2
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
      identity: {
        name: '集成角色', description: '集成测试角色', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [{
        name: 'Agent 专注', semantic: 'focus', tags: [],
        actions: [
          { name: '专注动作', semantic: 'think', tags: [] },
          { name: '庆祝动作', semantic: 'celebrate', tags: [] }
        ]
      }]
    })),
    getRecentPublicActions: vi.fn(() => []),
    resolveBehaviorTarget: vi.fn((target: BehaviorTarget): ResolvedBehaviorTarget => {
      if (target.kind === 'semantic') return target;
      if (target.kind === 'action_name' && target.name === '专注动作') {
        return { kind: 'action', actionId: 'focus-action' };
      }
      throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    }),
    resolveBehaviorStatePlan: vi.fn((plan: Extract<CharacterBehaviorPlan, { kind: 'play_state' }>): ResolvedBehaviorTarget => {
      if (plan.state !== 'Agent 专注') throw new Error('CHARACTER_ACTION_UNAVAILABLE');
      if (plan.action === undefined) return { kind: 'state', stateId: 'agent-focus' };
      if (plan.action === '专注动作' || plan.action === 'think') {
        return { kind: 'state_action', stateId: 'agent-focus', actionId: 'focus-action' };
      }
      if (plan.action === '庆祝动作' || plan.action === 'celebrate') {
        return { kind: 'state_action', stateId: 'agent-focus', actionId: 'celebrate-action' };
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
        : target.kind === 'state_action'
          ? target.actionId
          : target.kind === 'state'
          ? `${target.stateId}-action`
          : `${target.semantic}-action`,
      playbackToken: `integration-chat-token-${++token}`,
      semantic: target.kind === 'semantic'
        ? target.semantic
        : target.kind === 'state_action' && target.actionId === 'celebrate-action'
          ? 'celebrate'
          : 'think'
    })),
    requestProactiveBehavior: vi.fn((target: BehaviorTarget): CharacterBehaviorAuthorization => (
      target.kind === 'semantic' && target.semantic === 'move'
        ? {
            kind: 'play', actionId: 'move-action',
            playbackToken: `integration-proactive-token-${++token}`, semantic: 'move'
          }
        : { kind: 'none' }
    )),
    isMovementAgentIntent: vi.fn(() => false),
    handleAgentIntent: vi.fn((): CharacterBehaviorAuthorization => ({ kind: 'none' })),
    handleTaskEvent: vi.fn((): CharacterBehaviorAuthorization => ({ kind: 'none' })),
    applyPlaybackFeedback: vi.fn(),
    advance: vi.fn(() => []),
    cancelStateLifecycle: vi.fn(),
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
  const saveMovementMode = vi.fn<(mode: 0 | 1 | 2) => Promise<void>>();
  const director = new CharacterBehaviorDirector({
    behavior,
    motion,
    initialGeneration: 'integration-chat-generation',
    initialSettings: { movementMode: 2, proactivityMode: 'assistive' },
    saveMovementMode,
    publishNotice: notice => notices.push(notice)
  });
  saveMovementMode.mockImplementation(async movementMode => {
    director.applyBehaviorSettings({ movementMode, proactivityMode: 'assistive' });
  });
  return { behavior, director, motion, notices, saveMovementMode };
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
  test('正式范围授权后第三次循环卡仅继续一次，第四次结束任务且原输入不改写', async () => {
    const text = '读取 note.txt';
    const fixture = await createCodingConversation(Array.from({ length: 4 }, (_, index) => ({
      response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: `loop-${index + 1}` }]),
      inspectRaw: (request: Record<string, unknown>) => {
        const messages = request.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>;
        expect(messages).toContainEqual(expect.objectContaining({ role: 'user', content: text }));
        expect(messages.filter(message => message.role === 'tool')).toHaveLength(index);
      }
    })));
    try {
      await writeFile(join(fixture.authorized.root, 'note.txt'), '循环私有正文');
      await fixture.composition.coordinator.submit(text);
      expect(fixture.creates()).toBe(0);
      expect(fixture.provider.requests).toHaveLength(0);
      const scope = fixture.events.find(event => event.type === 'capability_authorization_required');
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await fixture.composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm');
      const permissions = () => fixture.events.filter(event => event.type === 'task_permission_required');
      await expect.poll(() => permissions().length).toBe(1);
      const third = permissions()[0]!;
      expect(third.request).toEqual({ action: 'doom_loop', tool: 'read', repeatCount: 3 });
      expect(fixture.provider.requests).toHaveLength(3);
      await fixture.composition.coordinator.resolveFileAction(third.actionId, 'confirm');
      await expect.poll(() => permissions().length).toBe(2);
      const fourth = permissions()[1]!;
      expect(fourth.request).toEqual({ action: 'doom_loop', tool: 'read', repeatCount: 4 });
      expect(fourth.actionId).not.toBe(third.actionId);
      await expect(fixture.composition.coordinator.resolveFileAction(third.actionId, 'confirm')).rejects.toBeDefined();
      await fixture.composition.coordinator.resolveFileAction(fourth.actionId, 'cancel');
      expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
      await expect(fixture.composition.coordinator.resolveFileAction(fourth.actionId, 'confirm')).rejects.toBeDefined();
      expect(fixture.provider.requests).toHaveLength(4);
      expect(JSON.stringify(permissions())).not.toMatch(/循环私有正文|note.txt|loop-[1-4]/u);
      expect(fixture.provider.inspectionErrors).toEqual([]);
      fixture.provider.assertComplete();
    } finally { await fixture.close(); }
  }, 15000);
  test('正式组合取消真实 PowerShell 时保持 owner，进程退出后才发布终态', async () => {
    const fixture = await createCodingConversation([{ response: codingResponse([{ name: 'bash', args: { command: 'Set-Content -LiteralPath marker.pid -Value $PID; Start-Sleep -Seconds 120', workdir: '.' } }]) }]);
    try {
      await fixture.authorize('运行 PowerShell 命令检查项目');
      await vi.waitFor(() => expect(fixture.events.some(event => event.type === 'task_permission_required')).toBe(true), { timeout: 10000 });
      const permission = fixture.events.find(event => event.type === 'task_permission_required');
      if (permission?.type !== 'task_permission_required') throw new Error('缺少命令许可');
      await fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm');
      let pid = 0;
      await vi.waitFor(async () => { pid = Number((await readFile(join(fixture.authorized.root, 'marker.pid'), 'utf8')).trim()); expect(pid).toBeGreaterThan(0); }, { timeout: 10000 });
      expect(() => process.kill(pid, 0)).not.toThrow();
      const cancelling = fixture.composition.coordinator.cancelActive();
      await expect(fixture.composition.coordinator.submit('新的普通聊天')).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
      await cancelling;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
      expect(fixture.events).not.toContainEqual({ type: 'phase', phase: 'success' });
      fixture.provider.assertComplete();
    } finally { await fixture.close(); }
  }, 30000);

  test('正式任务读取随机正文并将真实结果回注，普通聊天历史只保留可见回合', async () => {
    const nonce = crypto.randomUUID();
    const fixture = await createCodingConversation([
      { response: completeIntegrationChatResponse({ type: 'text', text: '普通聊天回复' }), inspect: request => expect(request.tools).toEqual([]) },
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: 'read-nonce' }]), inspectRaw: request => { const messages = JSON.stringify(request.messages); expect(messages).toContain('之前普通聊天'); expect(messages).toContain('普通聊天回复'); } },
      { response: request => { const messages = request.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>; expect(messages.find(message => message.tool_call_id === 'read-nonce')?.content).toContain(nonce); return codingResponse(nonce); } }
    ]);
    try {
      await writeFile(join(fixture.authorized.root, 'note.txt'), nonce);
      await fixture.composition.coordinator.submit('之前普通聊天');
      expect(fixture.creates()).toBe(0);
      await fixture.authorize('读取 note.txt');
      await vi.waitFor(() => expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'success' }), { timeout: 10000 });
      expect(fixture.events).toContainEqual({ type: 'message', role: 'assistant', text: nonce });
      expect(fixture.provider.inspectionErrors).toEqual([]);
      fixture.provider.assertComplete();
    } finally { await fixture.close(); }
  }, 30000);

  test.each([
    { mode: 'cancel', loop: false }, { mode: 'reset', loop: false }, { mode: 'configuration', loop: false },
    { mode: 'cancel', loop: true }, { mode: 'reset', loop: true }, { mode: 'configuration', loop: true }
  ] as const)('正式任务 $mode 后旧许可失效且新 generation 可继续，循环=$loop', async ({ mode, loop }) => {
    const fixture = await createCodingConversation([
      { response: codingResponse(loop ? Array.from({ length: 3 }, (_, index) => ({ name: 'read', args: { path: 'existing.txt' }, id: `loop-reset-${index}` })) : [{ name: 'write', args: { path: 'existing.txt', content: '不应覆盖' } }]) },
      { response: codingResponse('新任务结束') }
    ]);
    try {
      await writeFile(join(fixture.authorized.root, 'existing.txt'), '原字节');
      await fixture.authorize('修改 existing.txt 文件');
      await vi.waitFor(() => expect(fixture.events.some(event => event.type === 'task_permission_required')).toBe(true), { timeout: 10000 });
      const permission = fixture.events.find(event => event.type === 'task_permission_required');
      if (permission?.type !== 'task_permission_required') throw new Error('缺少覆盖许可');
      if (mode === 'configuration') { fixture.profile.modelId = 'changed-model'; await fixture.composition.resetForConfigurationChange(); }
      else if (mode === 'reset') await fixture.composition.coordinator.resetConversation();
      else await fixture.composition.coordinator.cancelActive();
      await expect(fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm')).rejects.toBeDefined();
      expect(await readFile(join(fixture.authorized.root, 'existing.txt'), 'utf8')).toBe('原字节');
      const next = fixture.events.length;
      await fixture.authorize('读取 existing.txt');
      await vi.waitFor(() => expect(fixture.events.slice(next)).toContainEqual({ type: 'message', role: 'assistant', text: '新任务结束' }), { timeout: 10000 });
      expect(fixture.creates()).toBe(2);
      expect(fixture.provider.requests.at(-1)?.model).toBe(mode === 'configuration' ? 'changed-model' : 'coding-fixture-model');
      fixture.provider.assertComplete();
      expect(fixture.provider.inspectionErrors).toEqual([]);
    } finally { await fixture.close(); }
  }, 30000);

  test('正式命令中间失败后修复重测，最新真实退出码决定状态追问', async () => {
    const fixture = await createCodingConversation([
      { response: codingResponse([{ name: 'bash', args: { command: 'exit 7', workdir: '.' } }]) },
      { response: codingResponse([{ name: 'bash', args: { command: 'exit 0', workdir: '.' } }]) },
      { response: codingResponse('修复后命令通过') }
    ]);
    try {
      await fixture.authorize('运行 PowerShell 命令检查项目');
      for (let index = 0; index < 2; index += 1) {
        await vi.waitFor(() => expect(fixture.events.filter(event => event.type === 'task_permission_required')).toHaveLength(index + 1), { timeout: 10000 });
        const permission = fixture.events.filter(event => event.type === 'task_permission_required')[index]!;
        if (permission.type !== 'task_permission_required') throw new Error('缺少命令许可');
        await fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm');
      }
      await vi.waitFor(() => expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'success' }), { timeout: 10000 });
      await fixture.composition.coordinator.submit('任务完成了吗');
      expect(fixture.events).toContainEqual({ type: 'message', role: 'assistant', text: '上一个任务已结束，状态：运行结束。收到 2 项实际工具结果。最近命令退出码：0。' });
      fixture.provider.assertComplete();
    } finally { await fixture.close(); }
  }, 30000);

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
    ['标准语义', { kind: 'play_state', state: 'Agent 专注', action: 'celebrate' }],
    ['当前角色自定义动作名', { kind: 'play_state', state: 'Agent 专注', action: '专注动作' }]
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
    ['向左一点', { kind: 'region', region: 'left' }],
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
          behaviorPlan: { kind: 'play_state', state: 'Agent 专注', action: '不存在动作' }
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
    ['停下', 0],
    ['恢复活动', 2]
  ] as const)('本地明确“%s”在 Provider 前持久化运动模式', async (text, movementMode) => {
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

    expect(behaviorFixture.saveMovementMode).toHaveBeenCalledExactlyOnceWith(
      movementMode, expect.any(Function)
    );
    expect(behaviorFixture.saveMovementMode.mock.invocationCallOrder[0])
      .toBeLessThan(providerRespond.mock.invocationCallOrder[0]!);
    await fixture.composition.close();
  });

  test('普通聊天 set_mode(1) 经唯一控制入口持久化，并由 Scheduler 请求持续运动', async () => {
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '我会继续活动。',
        structured_output: {
          behaviorPlan: { kind: 'none' },
          movementControl: { kind: 'set_mode', mode: 1 }
        }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('请陪我一直活动');
    behaviorFixture.director.requestPersistentMovement();
    expect(behaviorFixture.director.getDiagnosticSnapshot()).toMatchObject({
      movementMode: 1,
      continuousTargetType: 'random_work_area',
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
      movementMode: 0,
      continuousTargetType: null,
      currentTargetType: null
    });
    await fixture.composition.close();
  });

  test('Provider 的 mode=2 在 passive 主动性下仍由 10 秒时钟请求真实运动', async () => {
    vi.useFakeTimers();
    const behaviorFixture = behaviorDirectorIntegrationFixture();
    behaviorFixture.director.applyBehaviorSettings({ movementMode: 2, proactivityMode: 'passive' });
    const scheduler = new CharacterProactivityScheduler({
      director: behaviorFixture.director,
      random: () => 0
    });
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '我会偶尔走动。',
        structured_output: {
          behaviorPlan: { kind: 'none' },
          movementControl: { kind: 'set_mode', mode: 2 }
        }
      }],
      behavior: behaviorFixture.director
    });
    try {
      await fixture.composition.coordinator.submit('请自行安排休闲节奏');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(behaviorFixture.motion.requestIntent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(behaviorFixture.motion.requestIntent).toHaveBeenCalledOnce();
      expect(behaviorFixture.director.getDiagnosticSnapshot().movementMode).toBe(2);
    } finally {
      await scheduler.close();
      await fixture.composition.close();
      vi.useRealTimers();
    }
  });

  test('跨 Provider 披露确认后重新读取当前行为上下文而不复用确认前快照', async () => {
    let movementMode: 0 | 2 = 2;
    const behavior = conversationBehaviorDouble({
      getChatContext: vi.fn(() => ({
        character: {
          identity: {
            name: '披露角色', description: '披露测试角色', background: '测试环境', traits: [],
            languageStyle: '简洁', likes: [], behavioralTendencies: []
          },
          states: []
        },
        runtime: {
          moving: false, dragging: false, carrying: false, movementMode
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
    movementMode = 0;

    await fixture.composition.coordinator.resolveHistoryDisclosure(
      latestDisclosureRequest(fixture.events),
      'share_once'
    );

    expect(fixture.chatRequests[1]?.request.messages[0]?.content)
      .toContain('"movementMode":0');
    expect(behavior.getChatContext).toHaveBeenCalledTimes(2);
    await fixture.composition.close();
  });

  test('真实 OpenAI-compatible fixture 保留同次 JSON Output 的正文与行为计划', async () => {
    const providerServer = await startProviderServer([{
      response: {
        type: 'text',
        text: 'fixture 同次正文',
        structured_output: {
          activity: '庆祝',
          status: 'celebrate',
          movementControl: { kind: 'keep' },
          behaviorPlan: { kind: 'play_state', state: 'Agent 专注', action: 'celebrate' },
          capabilityPlan: { kind: 'chat' }
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
});

describe('桌面 Agent 真实服务集成', () => {
  test('行为集成清单经严格 Schema 自证', () => {
    const manifest = createBehaviorManifest();

    expect(characterManifestV2Schema.parse(manifest)).toEqual(manifest);
  });

  test('自主行为最小闭环保持 Main 行为与窗口运动', async () => {
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

    const autonomousDirector = new CharacterBehaviorDirector({
      behavior,
      motion,
      initialGeneration: 'integration-autonomous',
      initialSettings: { movementMode: 2, proactivityMode: 'autonomous' },
      saveMovementMode: async () => undefined
    });
    expect(autonomousDirector.requestBehaviorPlan({
      kind: 'move', direction: 'right', distance: 'near'
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
    const fixture = await createCodingConversation([{ response: codingResponse('Agent 在编译期间正常响应') }]);
    try {
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

      await fixture.authorize('读取角色文件');
      await vi.waitFor(() => expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'success' }), { timeout: 10000 });

      expect(compileCompleted).toBe(false);
      expect(fixture.events).toContainEqual({
        type: 'message',
        role: 'assistant',
        text: 'Agent 在编译期间正常响应'
      });
      fixture.provider.assertComplete();

      child.send({ type: 'release_decode' });
      await expect(compileResult).resolves.toMatchObject({
        width: 2,
        height: 2,
        frameCount: 1
      });
    } finally {
      // 包括编译、授权和断言失败，均沿正式夹具关闭顺序释放会话、HTTP 与隔离根。
      await fixture.close();
    }
  });
});
