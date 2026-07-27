import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentLoop, type ModelResponse } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import { AgentService } from '../../apps/desktop/src/main/agent/agent-service';
import { PermissionPolicy } from '../../apps/desktop/src/main/agent/permission-policy';
import { PendingActionStore } from '../../apps/desktop/src/main/agent/pending-action-store';
import {
  createBuiltinFileToolRegistry
} from '../../apps/desktop/src/main/agent/tool-registry';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
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
  'builtin.files.rename_entry'
] as const;
const internalToolNames = [
  'list_directory',
  'read_text_file',
  'create_file',
  'create_directory',
  'rename_entry'
] as const;

const roots: AuthorizedRootFixture[] = [];
const servers: ProviderServerFixture[] = [];
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
      await Promise.all(roots.splice(0).map(root => root.cleanup()));
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

describe('桌面 Agent 真实服务集成', () => {
  test('只通过五个允许工具列出授权目录', async () => {
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
