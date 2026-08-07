import { lstat, readFile, writeFile } from 'node:fs/promises';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  type ModelProvider,
  type ModelResponse
} from '@myself/agent-core';
import type { CharacterManifestV2 } from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import { AgentService } from '../../apps/desktop/src/main/agent/agent-service';
import { PermissionPolicy } from '../../apps/desktop/src/main/agent/permission-policy';
import { PendingActionStore } from '../../apps/desktop/src/main/agent/pending-action-store';
import {
  createBuiltinFileToolRegistry
} from '../../apps/desktop/src/main/agent/tool-registry';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import { CharacterBehaviorService } from '../../apps/desktop/src/main/characters/character-behavior-service';
import { CharacterMotionService } from '../../apps/desktop/src/main/characters/character-motion-service';
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
      pathname: '/v1/chat/completions',
      authorizationPresent: true
    });
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
    createConversationId: () => 'conversation-task-9a'
  });
  return { authorized, events, loop, pending, providerServer, service };
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

    await agent.submit('执行合法意图');
    expect(taskEvents.filter(event => event.type === 'phase').slice(0, 2)).toEqual([
      { type: 'phase', phase: 'listening' },
      { type: 'phase', phase: 'thinking' }
    ]);
    expect(behaviorEvents).toContainEqual(expect.objectContaining({
      stateId: 'agent-focus', actionId: 'focus-action'
    }));
    expect(behaviorEvents.at(-1)).toMatchObject({ actionId: 'celebrate-action' });

    const illegalStart = behaviorEvents.length;
    await agent.submit('执行非法意图');
    expect(behaviorEvents.slice(illegalStart).filter(event => (
      event.stateId === 'think-state' && event.actionId === 'think-action'
    ))).toHaveLength(3);
    expect(behaviorEvents.slice(illegalStart)).not.toContainEqual(expect.objectContaining({
      stateId: 'missing-state'
    }));

    const noIntentStart = behaviorEvents.length;
    await agent.submit('执行无意图降级');
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

    await fixture.service.submit('编译角色时继续响应');

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

    await fixture.service.submit('列出授权目录');

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

    await fixture.service.submit('读取 docs/note.txt');

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
    await fixture.service.submit('新建 cancelled.txt');
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

    await fixture.service.submit('将 docs 移入回收站');
    const action = pendingAction(fixture.events);
    expect(action).toMatchObject({
      operation: 'move_to_recycle_bin',
      targetRelativePath: 'docs'
    });

    fixture.service.cancelAction(action.actionId);

    expectProviderExchange(fixture.providerServer, 1);
    await expect(lstat(join(fixture.authorized.root, 'docs'))).resolves.toBeDefined();
  });

  test('生产组合根只通过 Electron shell.trashItem 注入回收站端口', async () => {
    const mainSource = await readFile(
      join(process.cwd(), 'apps/desktop/src/main/index.ts'),
      'utf8'
    );

    expect(mainSource).toMatch(
      /new FileToolService\(policy,\s*\{\s*moveToRecycleBin:\s*absolutePath\s*=>\s*shell\.trashItem\(absolutePath\)\s*\}\)/u
    );
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
    await fixture.service.submit('新建 created.txt');

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
    await fixture.service.submit('重命名文件');

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

    await expect(fixture.service.submit('新建越界文件')).rejects.toMatchObject({
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

    await expect(fixture.service.submit('新建 existing.txt')).rejects.toMatchObject({
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
    await fixture.service.submit('新建 stale.txt');
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
