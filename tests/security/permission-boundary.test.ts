import { type ModelResponse } from '@myself/agent-core';
import { type TaskEvent } from '@myself/shared-types';
import {
appendFile,
lstat,
mkdtemp,
readFile,
rename,
rm,
writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,test,vi } from 'vitest';
import { PrivacySessionRegistry } from '../../apps/desktop/src/main/agent/disclosure-policy';
import type { ConversationBehaviorPort } from '../../apps/desktop/src/main/characters/character-behavior-director';
import { CharacterBehaviorDirector } from '../../apps/desktop/src/main/characters/character-behavior-director';
import { ConversationChatAdapter } from '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import {
createMainConversationComposition
} from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import {
createMainE2eExplorerBridge
} from '../../apps/desktop/src/main/e2e-boundary';
import {
buildExplorerBridgeSpawnSpec
} from '../../apps/desktop/src/main/explorer/explorer-space-client';
import {
parseBridgeLine,
serializeBridgeCommand
} from '../../apps/desktop/src/main/explorer/explorer-space-protocol';
import { LocalModelRuntime } from '../../apps/desktop/src/main/local-model/local-model-runtime';
import { LocalModelProvider } from '../../apps/desktop/src/main/providers/local-model-provider';
import {
createAuthorizedRoot,
createCodingConversation,
type AuthorizedRootFixture
} from '../fixtures/authorized-root';
import { scanLocalModelCapabilityBoundary } from '../fixtures/local-model-security-scan';
import {
codingResponse,
type ProviderServerFixture
} from '../fixtures/provider-server';

const roots: AuthorizedRootFixture[] = [];
const servers: ProviderServerFixture[] = [];

afterEach(async () => {
  try {
    await Promise.all(servers.splice(0).map(server => server.close()));
  } finally {
    try {
      await Promise.all(roots.splice(0).map(root => root.cleanup()));
    } finally {
      vi.restoreAllMocks();
    }
  }
});


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

function securityProfile() {
  return {
    id: 'security-chat-profile',
    displayName: '安全会话服务',
    modelId: 'security-model',
    hasStoredSecret: true,
    mode: 'custom' as const,
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://security.example/v1',
    additionalParameters: {},
    capabilities: ['chat', 'tools'] as const
  };
}

function completeSecurityChatResponse(response: ModelResponse): ModelResponse {
  if (response.type !== 'text') return response;
  return {
    ...response,
    structured_output: {
      moodUpdate: null,
      expressionPlan: null,
      movementControl: { kind: 'keep' },
      capabilityPlan: { kind: 'chat' },
      ...response.structured_output
    }
  };
}

function conversationSecurityHarness(input: {
  chatText: string;
  chatResponse?: ModelResponse;
  authorizedRootPath?: string | null;
  behavior?: ConversationBehaviorPort;
}) {
  const profile = securityProfile();
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('security-conversation', { incognito: true });
  const events: TaskEvent[] = [];
  const modelRequests: Array<{
    tools: unknown[];
    toolChoice: unknown;
    responseContract: unknown;
  }> = [];
  const readAuthorizedRootPath = vi.fn(async () => input.authorizedRootPath ?? null);
  const readPrivacySettings = vi.fn(async () => ({ dataCategories: { file: true } }));
  const createPathPolicy = vi.fn(() => ({ kind: 'path-policy' }));
  const createCodingTaskService = vi.fn(() => {
    createPathPolicy();
    throw new Error('SECURITY_AGENT_FACTORY_MUST_NOT_RUN');
  });
  const composition = createMainConversationComposition({
    catalog: [],
    privacySessions,
    sessionId: 'security-conversation',
    readProviderSettings: async () => ({
      profiles: [profile],
      route: {
        primaryProfileId: profile.id,
        chatProfileId: profile.id,
        agentProfileId: profile.id,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      }
    }),
    readAuthorizedRootPath,
    readPrivacySettings,
    createChatAdapter: () => new ConversationChatAdapter({
      async respond(request) {
        modelRequests.push({
          tools: request.tools,
          toolChoice: request.toolChoice,
          responseContract: request.responseContract
        });
        return completeSecurityChatResponse(
          input.chatResponse ?? { type: 'text', text: input.chatText }
        );
      }
    }),
    createCodingTaskService,
    behavior: input.behavior ?? securityBehaviorDouble(),
    emit: event => events.push(event)
  });
  return {
    composition,
    createCodingTaskService,
    createPathPolicy,
    events,
    modelRequests,
    readAuthorizedRootPath,
    readPrivacySettings
  };
}

function securityBehaviorDouble(
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
        idleStateId: 'idle',
        identity: {
          name: '安全角色', description: '安全测试角色', background: '测试环境', traits: [],
          languageStyle: '简洁', formsOfAddress: [], likes: [], dislikes: [],
          behavioralTendencies: [], boundaries: [], exampleLines: []
        },
        states: []
      },
      runtime: {
        moving: false, dragging: false, carrying: false, movementMode: 2
      },
      proactivityMode: 'assistive',
      recentActions: []
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

function movementLockDirector() {
  const saveMovementMode = vi.fn<(mode: 0 | 1 | 2) => Promise<void>>();
  const behavior = {
    context: vi.fn(() => null),
    snapshot: vi.fn(() => null),
    applyDecision: vi.fn(() => ({ kind: 'none' as const })),
    invalidateContext: vi.fn(),
    recordTrustedEvent: vi.fn(),
    handleUserInteraction: vi.fn(),
    getPublicBehaviorCatalog: vi.fn(() => ({
      idleStateId: 'idle',
      identity: {
        name: '安全角色', description: '安全测试角色', background: '测试环境', traits: [],
        languageStyle: '简洁', formsOfAddress: [], likes: [], dislikes: [],
        behavioralTendencies: [], boundaries: [], exampleLines: []
      },
      states: []
    })),
    getRecentPublicActions: vi.fn(() => []),
    resolveBehaviorTarget: vi.fn(() => { throw new Error('CHARACTER_ACTION_UNAVAILABLE'); }),
    resolveBehaviorStatePlan: vi.fn(() => { throw new Error('CHARACTER_ACTION_UNAVAILABLE'); }),
    requestDirectedBehavior: vi.fn(() => ({ kind: 'none' as const })),
    requestProactiveBehavior: vi.fn(() => ({ kind: 'none' as const })),
    handleAgentIntent: vi.fn(() => ({ kind: 'none' as const })),
    handleTaskEvent: vi.fn(() => ({ kind: 'none' as const })),
    applyPlaybackFeedback: vi.fn(),
    advance: vi.fn(() => []),
    cancelStateLifecycle: vi.fn(),
    handleActiveCharacterChanged: vi.fn(async () => undefined),
    close: vi.fn()
  };
  const director = new CharacterBehaviorDirector({
    behavior,
    motion: {
      getSnapshot: () => ({
        revision: 0, timestampMs: 0, position: { x: 0, y: 0 }, target: null,
        direction: 'right', moving: false, carrying: false
      }),
      requestIntent: vi.fn(),
      stop: vi.fn()
    },
    initialGeneration: 'security-generation',
    initialSettings: { movementMode: 2, proactivityMode: 'assistive' },
    saveMovementMode
  });
  return { director, saveMovementMode };
}

describe('权限边界安全回归', () => {
  test('循环卡一次许可不能代替外部目录许可，结束使并存许可立即失效', async () => {
    const fixture = await createCodingConversation([
      { response: () => codingResponse(Array.from({ length: 4 }, (_, index) => ({ name: 'read', args: { path: join(fixture.authorized.base, 'outside.txt') }, id: `private-loop-call-${index}` }))) }
    ]);
    try {
      await writeFile(join(fixture.authorized.base, 'outside.txt'), '外部私有正文');
      await fixture.authorize('读取 outside.txt 文件');
      const permissions = () => fixture.events.filter(event => event.type === 'task_permission_required');
      await expect.poll(() => permissions().filter(event => event.request.action === 'doom_loop').length).toBe(1);
      await expect.poll(() => permissions().filter(event => event.request.action === 'external_directory').length).toBe(2);
      const third = permissions().find(event => event.request.action === 'doom_loop')!;
      expect(third.request).toEqual({ action: 'doom_loop', tool: 'read', repeatCount: 3 });
      expect(JSON.stringify(third)).not.toMatch(/outside|private|metadata|resources|source|callId/u);
      await fixture.composition.coordinator.resolveFileAction(third.actionId, 'confirm');
      await expect.poll(() => permissions().filter(event => event.request.action === 'doom_loop').length).toBe(2);
      await expect.poll(() => permissions().filter(event => event.request.action === 'external_directory').length).toBe(3);
      const fourth = permissions().filter(event => event.request.action === 'doom_loop')[1]!;
      await fixture.composition.coordinator.resolveFileAction(fourth.actionId, 'cancel');
      expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
      for (const permission of permissions()) await expect(fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm')).rejects.toBeDefined();
      expect(fixture.provider.requests).toHaveLength(1);
      expect(JSON.stringify(fixture.events)).not.toContain('外部私有正文');
      fixture.provider.assertComplete();
    } finally { await fixture.close(); }
  }, 15000);
  test('正式范围前零请求，拒绝外部目录许可后无越界副作用且模型仍可读取范围内文件', async () => {
    const nonce = crypto.randomUUID();
    const fixture = await createCodingConversation([
      { response: () => codingResponse([{ name: 'write', args: { path: join(fixture.authorized.base, 'outside.txt'), content: '不应写入' }, id: 'private-call-id' }]) },
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' } }]), inspectRaw: request => { expect(JSON.stringify(request.messages)).toContain('rejected'); } },
      { response: request => { const result = JSON.stringify(request.messages); expect(result).toContain(nonce); return codingResponse(nonce); } }
    ]);
    try {
      await writeFile(join(fixture.authorized.root, 'note.txt'), nonce);
      await fixture.composition.coordinator.submit('读取 note.txt 并写入结果文件');
      expect(fixture.creates()).toBe(0);
      expect(fixture.provider.requests).toEqual([]);
      const scope = fixture.events.find(event => event.type === 'capability_authorization_required');
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await fixture.composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm');
      await vi.waitFor(() => expect(fixture.events.some(event => event.type === 'task_permission_required')).toBe(true), { timeout: 10000 });
      const permission = fixture.events.find(event => event.type === 'task_permission_required');
      if (permission?.type !== 'task_permission_required') throw new Error('缺少具体许可');
      expect(permission.request.action).toBe('external_directory');
      expect(Object.keys(permission).sort()).toEqual(['actionId', 'request', 'summary', 'type']);
      await fixture.composition.coordinator.resolveFileAction(permission.actionId, 'cancel');
      await vi.waitFor(() => expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'success' }), { timeout: 10000 });
      expect(fixture.events).toContainEqual({ type: 'message', role: 'assistant', text: nonce });
      await expect(lstat(join(fixture.authorized.base, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const nonContent = fixture.events.filter(event => !['message', 'capability_authorization_required', 'task_permission_required'].includes(event.type));
      for (const canary of [nonce, fixture.provider.apiKey, fixture.authorized.root, 'private-call-id']) expect(JSON.stringify(nonContent)).not.toContain(canary);
      expect(JSON.stringify(fixture.events)).not.toContain(fixture.provider.apiKey);
      fixture.provider.assertComplete();
      expect(fixture.provider.inspectionErrors).toEqual([]);
    } finally { await fixture.close(); }
  }, 30000);

  test.each([false, true])('正式删除只消费当前许可一次；回收站失败=%s 保留目标并脱敏', async fail => {
    let calls = 0;
    const fixture = await createCodingConversation([
      { response: codingResponse([{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: target.txt\n*** End Patch' } }]) },
      { response: request => { expect(JSON.stringify(request.messages)).toContain(fail ? 'error' : 'target.txt'); return codingResponse('已按真实工具结果结束'); } }
    ], { trashFile: async path => { calls += 1; expect(path).toBe(join(fixture.authorized.root, 'target.txt')); if (fail) throw new Error(`private-trash-cause:${path}`); await rename(path, join(fixture.authorized.base, 'recycled.txt')); } });
    try {
      await writeFile(join(fixture.authorized.root, 'target.txt'), '回收站正文');
      await fixture.authorize('删除 target.txt 文件');
      await vi.waitFor(() => expect(fixture.events.some(event => event.type === 'task_permission_required')).toBe(true), { timeout: 10000 });
      const permission = fixture.events.find(event => event.type === 'task_permission_required');
      if (permission?.type !== 'task_permission_required') throw new Error('缺少删除许可');
      expect(permission.request.action).toBe('delete');
      expect(calls).toBe(0);
      await expect(fixture.composition.coordinator.resolveFileAction('forged-id', 'confirm')).rejects.toBeDefined();
      await fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm');
      await vi.waitFor(() => expect(fixture.events.some(event => event.type === 'phase' && ['success', 'error'].includes(event.phase))).toBe(true), { timeout: 10000 });
      await expect(fixture.composition.coordinator.resolveFileAction(permission.actionId, 'confirm')).rejects.toBeDefined();
      expect(calls).toBe(1);
      expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: fail ? 'error' : 'success' });
      expect(await readFile(join(fixture.authorized[fail ? 'root' : 'base'], fail ? 'target.txt' : 'recycled.txt'), 'utf8')).toBe('回收站正文');
      expect(JSON.stringify(fixture.events)).not.toContain('private-trash-cause');
      fixture.provider.assertComplete();
      expect(fixture.provider.inspectionErrors).toEqual([]);
    } finally { await fixture.close(); }
  }, 30000);

  test('本地 Runtime 与 Provider 的依赖图不持有文件、PowerShell、授权根或 shell 执行能力', async () => {
    const scan = await scanLocalModelCapabilityBoundary([
      join(process.cwd(), 'apps/desktop/src/main/local-model/local-model-runtime.ts'),
      join(process.cwd(), 'apps/desktop/src/main/providers/local-model-provider.ts')
    ]);

    expect(scan).toEqual({
      forbiddenDependencies: [],
      unsafeSpawnOptions: []
    });
  });

  test('语义扫描会穿透导入并识别 shorthand 与后续赋值形成的最终危险 spawn 参数', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'myself-local-model-scan-'));
    const entryPath = join(fixtureRoot, 'entry.ts');
    const dependencyPath = join(fixtureRoot, 'unsafe.ts');
    try {
      await writeFile(entryPath, "import './unsafe';\n", 'utf8');
      await writeFile(dependencyPath, [
        "import { spawn as startProcess } from 'node:child_process';",
        'export const authRoot = new Map<string, string>();',
        'const shell = false;',
        'const windowsHide = true;',
        'const options = { shell, windowsHide };',
        'options.shell = true;',
        "startProcess('fixture', [], options);"
      ].join('\n'), 'utf8');

      const scan = await scanLocalModelCapabilityBoundary([entryPath]);

      expect(scan.forbiddenDependencies).toEqual([
        expect.stringContaining('unsafe.ts:authRoot')
      ]);
      expect(scan.unsafeSpawnOptions).toEqual([
        expect.stringContaining('unsafe.ts:7')
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('无法证明为不可变安全字面量的 namespace、spread、assign 与条件赋值均判为危险', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'myself-local-model-mutations-'));
    const fixtures = {
      'namespace-spawn.ts': [
        "import * as childProcess from 'node:child_process';",
        "childProcess.spawn('fixture', [], { shell: true, windowsHide: true });"
      ],
      'namespace-exec.ts': [
        "import * as childProcess from 'node:child_process';",
        "childProcess.exec('fixture', { windowsHide: true });"
      ],
      'namespace-alias.ts': [
        "import * as childProcess from 'node:child_process';",
        'const launch = childProcess.spawn;',
        "launch('fixture', [], { shell: true, windowsHide: true });"
      ],
      'namespace-object-alias.ts': [
        "import * as childProcess from 'node:child_process';",
        'const processApi = childProcess;',
        "processApi.spawn('fixture', [], { shell: true, windowsHide: true });"
      ],
      'dynamic-method.ts': [
        "import * as childProcess from 'node:child_process';",
        "declare const method: 'spawn';",
        "childProcess[method]('fixture', [], { shell: false, windowsHide: true });"
      ],
      'conditional-call-alias.ts': [
        "import * as childProcess from 'node:child_process';",
        'declare const condition: boolean;',
        'const launch = condition ? childProcess.spawn : childProcess.exec;',
        "launch('fixture', [], { shell: false, windowsHide: true });"
      ],
      'spread.ts': [
        "import { spawn } from 'node:child_process';",
        'declare const untrusted: { shell?: boolean };',
        "spawn('fixture', [], { shell: false, windowsHide: true, ...untrusted });"
      ],
      'object-assign.ts': [
        "import { spawn } from 'node:child_process';",
        'declare const untrusted: { shell?: boolean };',
        'const options = { shell: false, windowsHide: true };',
        'Object.assign(options, untrusted);',
        "spawn('fixture', [], options);"
      ],
      'conditional-assignment.ts': [
        "import { spawn } from 'node:child_process';",
        'declare const condition: boolean;',
        'const options = { shell: true, windowsHide: false };',
        'if (condition) { options.shell = false; options.windowsHide = true; }',
        "spawn('fixture', [], options);"
      ]
    } as const;
    try {
      const paths = await Promise.all(Object.entries(fixtures).map(async ([name, lines]) => {
        const path = join(fixtureRoot, name);
        await writeFile(path, lines.join('\n'), 'utf8');
        return path;
      }));

      const scan = await scanLocalModelCapabilityBoundary(paths);

      expect(scan.unsafeSpawnOptions).toEqual([
        'conditional-assignment.ts:5',
        'conditional-call-alias.ts:4',
        'dynamic-method.ts:3',
        'namespace-alias.ts:3',
        'namespace-exec.ts:2',
        'namespace-object-alias.ts:3',
        'namespace-spawn.ts:2',
        'object-assign.ts:5',
        'spread.ts:3'
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('跨本地 re-export 与后续赋值的 child_process alias 仍失败关闭', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'myself-local-model-reexports-'));
    const fixtures = {
      'bridge.ts': ["export { spawn as launch } from 'node:child_process';"],
      'bridge-consumer.ts': [
        "import { launch } from './bridge';",
        "launch('fixture', [], { shell: true, windowsHide: true });"
      ],
      'assignment-alias.ts': [
        "import { spawn } from 'node:child_process';",
        'let launch;',
        'launch = spawn;',
        "launch('fixture', [], { shell: true, windowsHide: true });"
      ],
      'bridge-one.ts': ["export { spawn as firstLaunch } from 'node:child_process';"],
      'bridge-two.ts': ["export { firstLaunch as launch } from './bridge-one';"],
      'bridge-two-consumer.ts': [
        "import { launch } from './bridge-two';",
        "launch('fixture', [], { shell: true, windowsHide: true });"
      ],
      'safe-inline.ts': [
        "import { spawn } from 'node:child_process';",
        "spawn('fixture', [], { shell: false, windowsHide: true });"
      ]
    } as const;
    try {
      await Promise.all(Object.entries(fixtures).map(async ([name, lines]) => {
        await writeFile(join(fixtureRoot, name), lines.join('\n'), 'utf8');
      }));

      const scan = await scanLocalModelCapabilityBoundary([
        join(fixtureRoot, 'bridge-consumer.ts'),
        join(fixtureRoot, 'assignment-alias.ts'),
        join(fixtureRoot, 'bridge-two-consumer.ts'),
        join(fixtureRoot, 'safe-inline.ts')
      ]);

      expect(scan.unsafeSpawnOptions).toEqual([
        'assignment-alias.ts:4',
        'bridge-consumer.ts:2',
        'bridge-two-consumer.ts:2'
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('本地模型公开状态、Provider 错误与普通日志不泄露连接和正文 canary', async () => {
    const canaries = [
      'token-canary-local-security',
      '43191',
      'C:\\private-root-canary\\authorized',
      'prompt-canary-local-security',
      'body-canary-local-security',
      'stderr-canary-local-security'
    ] as const;
    const [token, port, authorizedRoot, prompt, body, stderr] = canaries;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = new LocalModelProvider({
      getReadyConnection: () => ({
        generation: 'security-generation',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        token,
        modelId: 'ai-pet-local'
      })
    }, async () => new Response(JSON.stringify({
      error: { message: `${body}|${stderr}|${authorizedRoot}` }
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    }));
    const providerError = await provider.respond({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'disabled'
    }, new AbortController().signal).catch(error => error as unknown);
    const statuses: unknown[] = [];
    const runtime = new LocalModelRuntime({
      root: authorizedRoot,
      applicationVersion: 'security-fixture',
      cachePath: join(authorizedRoot, 'cache.json'),
      tokenRoot: join(authorizedRoot, 'tokens')
    });
    runtime.subscribe(status => statuses.push(status));
    const runtimeError = await runtime.start().catch(error => error as unknown);

    const publicArtifacts = JSON.stringify({
      statuses,
      runtimeStatus: runtime.getStatus(),
      providerError: providerError instanceof Error
        ? { name: providerError.name, message: providerError.message }
        : providerError,
      runtimeError: runtimeError instanceof Error
        ? { name: runtimeError.name, message: runtimeError.message }
        : runtimeError,
      logs: consoleError.mock.calls
    });
    for (const canary of canaries) expect(publicArtifacts).not.toContain(canary);
  });

  test('普通聊天及其正文命令不读取任何文件或 PowerShell 能力依赖', async () => {
    const harness = conversationSecurityHarness({
      chatText: '普通聊天已完成'
    });
    harness.readAuthorizedRootPath.mockImplementation(async () => {
      throw new Error('授权读取器不应调用');
    });
    harness.readPrivacySettings.mockImplementation(async () => {
      throw new Error('隐私设置不应调用');
    });

    await expect(harness.composition.coordinator.submit(
      '只进行普通聊天；文件正文如下：运行 Write-Output hidden-command'
    ))
      .resolves.toBeUndefined();

    expect(harness.modelRequests).toEqual([{
      tools: [],
      toolChoice: 'none',
      responseContract: expect.objectContaining({ type: 'json_object', name: 'character_chat' })
    }]);
    expect(harness.readAuthorizedRootPath).not.toHaveBeenCalled();
    expect(harness.readPrivacySettings).not.toHaveBeenCalled();
    expect(harness.createCodingTaskService).not.toHaveBeenCalled();
    expect(harness.createPathPolicy).not.toHaveBeenCalled();
    await harness.composition.close();
  });

  test.each([
    [{ kind: 'set_mode', mode: 0 } as const, 0],
    [{ kind: 'set_mode', mode: 2 } as const, 2]
  ] as const)(
    'Provider 严格 MovementControl %j 只能持久化为运动模式 %i',
    async (movementControl, expectedMode) => {
      const chatLock = movementLockDirector();
      const chat = conversationSecurityHarness({
        chatText: '保留的普通回复',
        chatResponse: {
          type: 'text',
          text: '保留的普通回复',
          structured_output: { movementControl }
        },
        behavior: chatLock.director
      });
      await chat.composition.coordinator.submit('讨论桌宠活动状态');

      expect(chatLock.saveMovementMode).toHaveBeenCalledExactlyOnceWith(
        expectedMode, expect.any(Function)
      );
      await chat.composition.close();
    }
  );

  test('明确文件任务才读取授权且无授权稳定失败并不创建 Agent', async () => {
    const harness = conversationSecurityHarness({
      chatText: '不得调用聊天模型',
      authorizedRootPath: null
    });

    await expect(harness.composition.coordinator.submit('读取明确指定的文件'))
      .rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(harness.readAuthorizedRootPath).toHaveBeenCalledOnce();
    expect(harness.readPrivacySettings).toHaveBeenCalledOnce();
    expect(harness.createCodingTaskService).not.toHaveBeenCalled();
    expect(harness.createPathPolicy).not.toHaveBeenCalled();
    expect(harness.modelRequests).toEqual([]);
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'FILE_AUTHORIZATION_REQUIRED'
    }));
    await harness.composition.close();
  });

  test('桥接协议拒绝伪造窗口命令', () => {
    const validSnapshot = {
      version: 1,
      type: 'explorer-snapshot',
      nonce: 'a'.repeat(32),
      sequence: 1,
      status: 'ready',
      windowType: 'explorer',
      instanceId: 'instance-1',
      hwnd: '123',
      rect: { x: 0, y: 0, width: 800, height: 600 },
      foreground: true,
      minimized: false
    };
    expect(parseBridgeLine(JSON.stringify(validSnapshot))).toEqual(validSnapshot);
    for (const forgedSnapshot of [
      { ...validSnapshot, version: 2 },
      { ...validSnapshot, sequence: 0 },
      { ...validSnapshot, hwnd: '0' },
      { ...validSnapshot, hwnd: 'window:123:0' },
      { ...validSnapshot, foreground: false },
      { ...validSnapshot, path: 'C:\\Private' },
      { ...validSnapshot, command: 'show-window' }
    ]) {
      expect(() => parseBridgeLine(JSON.stringify(forgedSnapshot)))
        .toThrow('BRIDGE_PROTOCOL_INVALID');
    }
    expect(() => serializeBridgeCommand({
      version: 1,
      nonce: 'a'.repeat(32),
      requestId: 'request-1',
      command: 'open-explorer'
    } as never)).toThrow('BRIDGE_COMMAND_INVALID');
  });

  test('桥接启动计划固定系统可执行文件、资源脚本和最小环境', () => {
    const spec = buildExplorerBridgeSpawnSpec({
      windowsDirectory: 'C:\\Windows',
      resourceRoot: 'C:\\Program Files\\AI Pet\\resources',
      tempDirectory: 'C:\\Temp\\ai-pet-bridge'
    });

    expect(spec).toEqual({
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'C:\\Program Files\\AI Pet\\resources\\windows\\explorer-space-bridge.ps1'
      ],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          TEMP: 'C:\\Temp\\ai-pet-bridge',
          TMP: 'C:\\Temp\\ai-pet-bridge'
        }
      }
    });
    expect(JSON.stringify(spec)).not.toMatch(
      /API_KEY|Authorization|AUTHORIZED_ROOT|MCP|MYSELF_E2E/iu
    );
  });

  test('Main fake 只消费固定无参数令牌并在崩溃时失败关闭', async () => {
    const base = await createAuthorizedRoot();
    roots.push(base);
    const eventFile = join(base.root, 'main-e2e-explorer-events');
    const createScriptedBridge = createMainE2eExplorerBridge as unknown as (
      options: {
        eventFile: string;
        pollIntervalMs: number;
      }
    ) => ReturnType<typeof createMainE2eExplorerBridge>;
    const bridge = createScriptedBridge({
      eventFile,
      pollIntervalMs: 1
    });
    const snapshots: unknown[] = [];
    const errors: Error[] = [];
    bridge.on('snapshot', snapshot => snapshots.push(snapshot));
    bridge.on('error', error => errors.push(error));

    await bridge.start();
    await bridge.startObserving();
    await appendFile(eventFile, [
      'layer-error',
      'stale-sequence',
      'non-explorer',
      'ambiguous',
      'foreground-explorer',
      'minimized',
      'blurred',
      'crash'
    ].join('\n') + '\n', 'utf8');
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(snapshots).toHaveLength(8);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'ready', instanceId: 'e2e-explorer-layer-error' }),
      expect.objectContaining({ status: 'ambiguous' }),
      expect.objectContaining({ status: 'ready', instanceId: 'e2e-explorer-foreground' })
    ]));
    for (const snapshot of snapshots) expect(snapshot).not.toHaveProperty('path');
    expect(snapshots.filter(snapshot => (
      typeof snapshot === 'object'
      && snapshot !== null
      && 'status' in snapshot
      && snapshot.status === 'none'
    ))).toHaveLength(3);
    const stalePair = snapshots.filter(snapshot => (
      typeof snapshot === 'object'
      && snapshot !== null
      && 'instanceId' in snapshot
      && snapshot.instanceId === 'e2e-explorer-exact'
      && 'sequence' in snapshot
      && snapshot.sequence === 2
    ));
    expect(stalePair).toHaveLength(2);
    expect(bridge.snapshot()).toEqual({
      state: 'failed',
      errorCode: 'E2E_BRIDGE_CRASHED'
    });
    await bridge.close();
  });

});
