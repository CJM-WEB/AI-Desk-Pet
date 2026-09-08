import {
type ModelProvider,
type ModelResponse
} from '@myself/agent-core';
import {
characterManifestV3Schema,
createPublicBehaviorCatalog,
type CharacterManifestV3
} from '../../packages/character-runtime/src';
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
import type { CapabilityTaskServicePort } from '../../apps/desktop/src/main/conversation/capability-task-adapter';
import { ConversationChatAdapter } from '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import {
createMainConversationComposition,
type MainConversationCodingTaskFactoryInput
} from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import type { ProviderSettingsSnapshot } from '../../apps/desktop/src/main/storage/settings-store';
import { resourceFields,v3Fixture } from '../../packages/character-runtime/tests/character-v3-fixture';
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

/** 复用既有 V3 作者夹具，只增加本闭环的自定义状态及两个动作。 */
function createBehaviorManifest(): CharacterManifestV3 {
  const draft = v3Fixture();
  draft.id = 'integration-behavior-v3';
  draft.name = '集成角色';
  draft.states.push({
    ...draft.states[0]!, id: 'agent-focus', name: 'Agent 专注',
    description: '认真思考并为伙伴的小进展感到欣喜。', agentInferable: true,
    actionIds: ['focus-action', 'celebrate-action']
  });
  for (const [id, name, description] of [
    ['focus-action', '专注动作', '托腮认真思考。'],
    ['celebrate-action', '庆祝动作', '为伙伴的小进展轻轻鼓掌。']
  ]) {
    draft.actions.push({ ...draft.actions[0]!, id, name, description, loopPolicy: 'never' });
    draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId: id });
  }
  return characterManifestV3Schema.parse({ ...draft, ...resourceFields });
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

function completeIntegrationExpression(response: ModelResponse): ModelResponse {
  return { type: 'structured', structured_output: { moodUpdate: null, expressionPlan: null,
    requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' },
    ...(response.type === 'text' ? response.structured_output : {}) } };
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
  createCodingTaskService?: (
    factoryInput: MainConversationCodingTaskFactoryInput<{ dataCategories: { memory: boolean } }>
  ) => CapabilityTaskServicePort;
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
  const expressionRequests: Array<Parameters<ModelProvider['respond']>[0]> = [];
  let pendingExpression: ModelResponse = { type: 'text', text: '' };
  const fileSubmissions: Array<{
    text: string;
    visibleHistory: readonly unknown[];
  }> = [];
  const codingTaskFactoryInputs: Array<MainConversationCodingTaskFactoryInput<
    { dataCategories: { memory: boolean } }
  >> = [];
  const readAuthorizedRootPath = vi.fn(async () => input.authorizedRootPath ?? null);
  const readPrivacySettings = vi.fn(async () => ({
    dataCategories: { memory: false }
  }));
  const createCodingTaskService = vi.fn((factoryInput: MainConversationCodingTaskFactoryInput<
    { dataCategories: { memory: boolean } }
  >) => {
    codingTaskFactoryInputs.push(factoryInput);
    if (input.createCodingTaskService) return input.createCodingTaskService(factoryInput);
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
        if (request.responseContract) {
          expressionRequests.push(request);
          return completeIntegrationExpression(pendingExpression);
        }
        chatRequests.push({ profileId: profile.id, request });
        const response = input.responses.shift();
        if (!response) throw new Error('聊天响应脚本已耗尽');
        pendingExpression = typeof response === 'string' ? { type: 'text', text: response } : response;
        return pendingExpression.type === 'text' ? { type: 'text', text: pendingExpression.text } : pendingExpression;
      }
    }),
    createCodingTaskService,
    behavior: input.behavior ?? conversationBehaviorDouble(),
    emit: event => {
      input.behavior?.handleTaskEvent(event);
      events.push(event);
    }
  });
  return {
    codingTaskFactoryInputs,
    chatRequests, expressionRequests,
    composition,
    createCodingTaskService,
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
      originalText: text, capabilityText: text, explicitDirective: null
    })),
    getChatContext: vi.fn(() => ({
      character: createPublicBehaviorCatalog(createBehaviorManifest(), 'base'),
      runtime: { moving: false, dragging: false, carrying: false, movementMode: 2 },
      proactivityMode: 'assistive', recentActions: []
    })),
    captureExpressionContext: vi.fn(() => null),
    completeUserPrompt: vi.fn(),
    handleChatResponseFinished: vi.fn(),
    handleTaskEvent: vi.fn(),
    applyPlaybackFeedback: vi.fn(),
    cancelActive: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

/** 沿用 Coordinator、Adapter、Director 和真实 V3 Service，仅隔离窗口位移与持久设置。 */
async function behaviorDirectorIntegrationFixture(now = performance.now.bind(performance)) {
  let target = 0;
  const notices: Array<{ code: string; message: string }> = [];
  const motion = {
    getSnapshot: vi.fn(() => ({
      revision: 1, timestampMs: 0, position: { x: 0, y: 0 }, target: { x: 0, y: 0 },
      direction: 'right' as const, moving: false, carrying: false
    })),
    requestIntent: vi.fn(() => ({
      revision: 1, timestampMs: 0, position: { x: 0, y: 0 }, target: { x: ++target, y: 0 },
      direction: 'right' as const, moving: true, carrying: false
    })),
    applyTaskEvent: vi.fn(),
    stop: vi.fn()
  };
  const behavior = new CharacterBehaviorService({
    store: { getActiveManifestV3: async () => createBehaviorManifest() },
    motion, now, random: () => 0
  });
  await behavior.initialize();
  const saveMovementMode = vi.fn<(mode: 0 | 1 | 2) => Promise<void>>();
  const director = new CharacterBehaviorDirector({
    behavior, motion, now, initialGeneration: 'integration-chat-generation',
    initialSettings: { movementMode: 2, proactivityMode: 'assistive' },
    saveMovementMode, publishNotice: notice => notices.push(notice)
  });
  saveMovementMode.mockImplementation(async movementMode => {
    director.applyBehaviorSettings({ movementMode, proactivityMode: 'assistive' });
  });
  return { behavior, director, motion, notices, saveMovementMode };
}

/** 在真实 Service 接纳当前 token 的首帧后，Director 才能位移。 */
function acknowledgePreparedPlayback(fixture: Awaited<ReturnType<typeof behaviorDirectorIntegrationFixture>>) {
  const current = fixture.behavior.snapshot()?.schedule.current;
  if (!current) throw new Error('缺少待播放动作');
  fixture.director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: performance.now() });
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
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: 'read-nonce' }]), inspectRaw: request => { const messages = JSON.stringify(request.messages); expect(messages).toContain('之前普通聊天'); expect(messages).toContain('普通聊天回复'); } },
      { response: request => { const messages = request.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>; expect(messages.find(message => message.tool_call_id === 'read-nonce')?.content).toContain(nonce); return codingResponse(nonce); } }
    ], { chatResponses: [{ type: 'text', text: '普通聊天回复' }] });
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
    expect(fixture.chatRequests[1]?.request.tools.map(tool => tool.function.name)).toEqual(['request_task_authorization']);
    expect(fixture.chatRequests[1]?.request.messages.filter(message => message.role !== 'system')).toEqual([
      { role: 'user', content: '第一轮消息' },
      { role: 'assistant', content: '第一轮回复' },
      { role: 'user', content: '第二轮消息' }
    ]);
    expect(fixture.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(fixture.readPrivacySettings).not.toHaveBeenCalled();
    expect(fixture.createCodingTaskService).not.toHaveBeenCalled();
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
    expect(fixture.createCodingTaskService).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  test('明确文件请求无授权时公开稳定错误', async () => {
    const fixture = conversationIntegrationHarness({
      responses: [{ type: 'tool_request', request: { requestId: 'scope-native', toolName: 'request_task_authorization', arguments: {} } }]
    });

    await expect(fixture.composition.coordinator.submit('读取 docs/note.txt'))
      .rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });
    expect(fixture.readAuthorizedRootPath).toHaveBeenCalledOnce();
    expect(fixture.createCodingTaskService).not.toHaveBeenCalled();
    expect(fixture.chatRequests).toHaveLength(1);
    await fixture.composition.close();
  });

  test('讨论后台命令保持聊天且不创建任务', async () => {
    const fixture = conversationIntegrationHarness({ responses: ['后台命令不能在此执行。'] });
    await fixture.composition.coordinator.submit('讨论后台运行构建');
    expect(fixture.createCodingTaskService).not.toHaveBeenCalled();
    expect(fixture.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(fixture.chatRequests).toHaveLength(1);
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
    expect(fixture.chatRequests[1]?.request.messages.filter(message => message.role !== 'system')).toEqual([
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
    expect(fixture.chatRequests[1]?.request.messages.filter(message => message.role !== 'system')).toEqual([
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
    expect(fixture.chatRequests[2]?.request.messages.filter(message => message.role !== 'system')).toEqual([
      { role: 'user', content: '再次发送' }
    ]);
    await fixture.composition.close();
  });

  test.each(['focus-action', 'celebrate-action'])(
    '普通聊天顺序两请求按自定义状态与动作 ID %s 提交正文和表现', async actionId => {
      const behaviorFixture = await behaviorDirectorIntegrationFixture();
      const fixture = conversationIntegrationHarness({
        responses: [{
          type: 'text', text: '正文与动作来自独立响应',
          structured_output: {
            moodUpdate: { summary: '认真而欣喜', strength: 0.8 },
            expressionPlan: { states: [{ stateId: 'agent-focus', score: 1,
              activity: null, actions: [{ actionId, score: 1 }] }] }
          }
        }],
        behavior: behaviorFixture.director
      });

      await fixture.composition.coordinator.submit('请自然回应并配合动作');

      expect(fixture.chatRequests).toHaveLength(1);
      expect(fixture.chatRequests[0]?.request).toMatchObject({
        toolChoice: 'auto'
      });
      expect(fixture.chatRequests[0]?.request.responseContract).toBeUndefined();
      expect(fixture.expressionRequests).toHaveLength(1);
      expect(fixture.expressionRequests[0]).toMatchObject({
        tools: [], toolChoice: 'none', responseContract: { name: 'character_expression' }
      });
      expect(fixture.events).toContainEqual({
        type: 'message', role: 'assistant', text: '正文与动作来自独立响应'
      });
      expect(behaviorFixture.behavior.snapshot()).toMatchObject({
        stateId: 'agent-focus', schedule: { current: { actionId } }
      });
      await fixture.composition.close();
    }
  );

  test.each(['向左一点', '去右下角'])('明确移动“%s”无行走素材时保持零位移', async text => {
    let now = 0;
    const behaviorFixture = await behaviorDirectorIntegrationFixture(() => now);
    const fixture = conversationIntegrationHarness({ responses: ['本轮回复'], behavior: behaviorFixture.director });
    await fixture.composition.coordinator.submit(text);
    expect(behaviorFixture.motion.requestIntent).not.toHaveBeenCalled();
    now = 8000; behaviorFixture.director.advance();
    expect(behaviorFixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(behaviorFixture.notices).toContainEqual({ code: 'CHARACTER_ACTION_UNAVAILABLE', message: '请先配置对应状态和动作。' });
    await fixture.composition.close();
  });

  test('Provider 建议不存在动作时保留正文且不播放非法动作', async () => {
    const behaviorFixture = await behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '仍然保留的自然正文',
        structured_output: {
          expressionPlan: { states: [{ stateId: 'agent-focus', score: 1,
            minStrength: 0, maxStrength: 1, actions: [{ actionId: 'missing-action', score: 1 }] }] }
        }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('普通聊天');

    expect(fixture.events).toContainEqual({
      type: 'message', role: 'assistant', text: '仍然保留的自然正文'
    });
    expect(fixture.chatRequests).toHaveLength(1);
    expect(fixture.expressionRequests).toHaveLength(1);
    expect(behaviorFixture.behavior.snapshot()?.schedule.current?.actionId).toBe('breathe');
    await fixture.composition.close();
  });

  test.each([
    ['停下', 0],
    ['恢复活动', 2]
  ] as const)('本地明确“%s”在 Provider 前持久化运动模式', async (text, movementMode) => {
    const behaviorFixture = await behaviorDirectorIntegrationFixture();
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
    const behaviorFixture = await behaviorDirectorIntegrationFixture();
    const fixture = conversationIntegrationHarness({
      responses: [{
        type: 'text',
        text: '我会继续活动。',
        structured_output: {
          movementControl: { kind: 'set_mode', mode: 1 }, expressionPlan: { states: [{ stateId: 'agent-focus', score: 1, activity: 'moving', actions: [{ actionId: 'focus-action', score: 1 }] }] }
        }
      }],
      behavior: behaviorFixture.director
    });

    await fixture.composition.coordinator.submit('请陪我一直活动');
    behaviorFixture.director.requestPersistentMovement();
    expect(behaviorFixture.motion.requestIntent).not.toHaveBeenCalled();
    acknowledgePreparedPlayback(behaviorFixture);
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
    const behaviorFixture = await behaviorDirectorIntegrationFixture();
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
          movementControl: { kind: 'set_mode', mode: 2 }, expressionPlan: { states: [{ stateId: 'agent-focus', score: 1, activity: 'moving', actions: [{ actionId: 'focus-action', score: 1 }] }] }
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
      expect(behaviorFixture.motion.requestIntent).not.toHaveBeenCalled();
      acknowledgePreparedPlayback(behaviorFixture);
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
        character: createPublicBehaviorCatalog(createBehaviorManifest(), 'base'),
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

    expect(fixture.expressionRequests[1]?.messages.filter(message => message.role === 'system')
      .map(message => message.content).join('\n')).toContain('"movementMode":0');
    expect(behavior.getChatContext).toHaveBeenCalledTimes(2);
    await fixture.composition.close();
  });

  test('真实 HTTP Provider 顺序发送正文与独立表现', async () => {
    const providerServer = await startProviderServer([
      { response: { type: 'text', text: 'fixture 独立正文' } },
      { response: { type: 'structured', structured_output: {
        moodUpdate: { summary: '认真而欣喜', strength: 0.8 }, movementControl: { kind: 'keep' },
        requestKind: 'ambient', explicitPlayback: null,
        expressionPlan: { states: [{ stateId: 'agent-focus', score: 1, activity: null, actions: [{ actionId: 'celebrate-action', score: 1 }] }] }
      } } }
    ]);
    servers.push(providerServer);
    const behaviorFixture = await behaviorDirectorIntegrationFixture();
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
      type: 'message', role: 'assistant', text: 'fixture 独立正文'
    });
    expect(behaviorFixture.behavior.snapshot()).toMatchObject({
      stateId: 'agent-focus', schedule: { current: { actionId: 'celebrate-action' } }
    });
    await fixture.composition.close();
  });
});

describe('桌面 Agent 真实服务集成', () => {
  test('自定义心情表现与真实窗口运动独立且旧播放令牌失效', async () => {
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
        id: 'integration-display', workAreaDip: { x: 0, y: 0, width: 1_024, height: 768 }
      }],
      getGeometrySnapshot: () => ({
        revision: 1, characterId: 'integration-character', scale: 1,
        footAnchorDip: { x: bounds.x + 128, y: bounds.y + 256 },
        visualBoundsInWindowDip: { x: 0, y: 0, width: 256, height: 256 },
        windowBoundsDip: bounds, displayId: 'integration-display'
      }),
      now: () => now, random: () => 0.75
    });
    const manifest = createBehaviorManifest();
    const travelAction = { ...manifest.actions[0]!, id: 'travel-action', name: '行走', loopPolicy: 'until-interrupted' as const };
    manifest.actions.push(travelAction);
    manifest.states.push({ ...manifest.states[1]!, id: 'travel-custom', name: '自定义移动', actionIds: ['travel-action'] });
    manifest.skins[0]!.presentations.push({ ...manifest.skins[0]!.presentations[0]!, actionId: 'travel-action' });
    const behavior = new CharacterBehaviorService({
      store: { getActiveManifestV3: async () => manifest },
      motion, now: () => now, random: () => 0
    });
    motion.subscribe(snapshot => behavior.handleMovement(snapshot));
    await behavior.initialize();
    const initialIdle = behavior.snapshot()!.schedule.current!;
    expect(initialIdle).toMatchObject({ stateId: 'rest', actionId: 'breathe' });
    behavior.applyPlaybackFeedback({
      playbackToken: initialIdle.playbackToken, actionId: initialIdle.actionId,
      status: 'started', occurredAtMs: now
    });
    behavior.handleUserInteraction();
    expect(behavior.snapshot()?.schedule.current?.playbackToken).toBe(initialIdle.playbackToken);
    behavior.applyDecision({
      context: behavior.context()!, eventId: 'mood', source: 'chat',
      moodUpdate: { summary: '安心陪伴', strength: 0.8 },
      expressionPlan: { states: [{ stateId: 'agent-focus', score: 1,
        minStrength: 0, maxStrength: 1, actions: [{ actionId: 'focus-action', score: 1 }] },
        { stateId: 'travel-custom', score: .1, minStrength: 0, maxStrength: 1, when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'travel-action', score: 1 }] }] }
    });
    const director = new CharacterBehaviorDirector({
      behavior, motion, now: () => now, initialGeneration: 'integration-autonomous',
      initialSettings: { movementMode: 2, proactivityMode: 'autonomous' },
      saveMovementMode: async () => undefined
    });
    try {
      motion.subscribe(snapshot => director.handleMotionSnapshot(snapshot));
      await director.prepareUserPrompt('向右一点');
      expect(positions).toHaveLength(0);
      const prepared = behavior.snapshot()!.schedule.current!;
      expect(prepared.stateId).toBe('travel-custom');
      director.applyPlaybackFeedback({ playbackToken: prepared.playbackToken, actionId: prepared.actionId, status: 'started', occurredAtMs: now });
      let snapshot = motion.getSnapshot();
      for (let step = 1; step <= 100 && (step === 1 || snapshot.moving); step += 1) {
        now = step * 100;
        snapshot = motion.tick();
      }
      expect(positions.length).toBeGreaterThan(0);
      expect(snapshot.moving).toBe(false);
      expect(Math.hypot(snapshot.position.x - snapshot.target.x, snapshot.position.y - snapshot.target.y))
        .toBeLessThanOrEqual(24);
      expect(behavior.snapshot()).toMatchObject({
        stateId: 'agent-focus', mood: { summary: '安心陪伴' }
      });
      expect(() => behavior.applyPlaybackFeedback({
        playbackToken: initialIdle.playbackToken, actionId: initialIdle.actionId,
        status: 'started', occurredAtMs: now
      })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
      const beforeLateCompletion = behavior.snapshot();
      expect(() => behavior.applyPlaybackFeedback({
        playbackToken: initialIdle.playbackToken, actionId: initialIdle.actionId,
        status: 'completed', occurredAtMs: now
      })).not.toThrow();
      expect(behavior.snapshot()).toEqual(beforeLateCompletion);
      now = 13000; director.advance();
      // 有限情绪片段到期后不重放旧动作，但心情继续按宿主时间衰减。
      expect(behavior.snapshot()).toMatchObject({ stateId: 'rest', mood: { summary: '安心陪伴' },
        schedule: { current: { actionId: 'breathe' } } });
    } finally {
      await director.close();
    }
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
          execArgv: ['--experimental-transform-types'],
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
