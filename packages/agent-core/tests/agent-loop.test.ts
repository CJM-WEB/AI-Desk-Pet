import { describe, expect, test, vi } from 'vitest';
import { toolRequestSchema } from '@myself/shared-types';
import { AgentLoop } from '../src/agent-loop';
import type {
  AgentEvent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  PreparedToolRequest,
  RunContext,
  ToolDefinition,
  ToolRuntime
} from '../src/types';

const toolNames = [
  'builtin.files.list_directory',
  'builtin.files.read_text',
  'builtin.files.create_file',
  'builtin.files.create_directory',
  'builtin.files.rename_entry'
] as const;

const tools: ToolDefinition[] = toolNames.map(name => ({
  type: 'function' as const,
  function: { name, description: `${name} 工具`, parameters: { type: 'object' } }
}));

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error('测试 Provider 没有更多响应');
    return response;
  }
}

async function collectEvents(context: RunContext): Promise<AgentEvent[]> {
  return collect(new AgentLoop().run('请处理文件', context));
}

async function collect(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function readRequest(requestId: string): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: 'builtin.files.read_text',
      arguments: { relativePath: 'notes.txt' }
    }
  };
}

function createToolRuntime(): ToolRuntime {
  const executionNames: Record<string, string> = {
    'builtin.files.list_directory': 'list_directory',
    'builtin.files.read_text': 'read_text_file',
    'builtin.files.create_file': 'create_file',
    'builtin.files.create_directory': 'create_directory',
    'builtin.files.rename_entry': 'rename_entry'
  };
  const recoverable = new Set([
    'builtin.files.create_file',
    'builtin.files.create_directory',
    'builtin.files.rename_entry'
  ]);
  return {
    prepare(raw): PreparedToolRequest {
      const request = toolRequestSchema.parse(raw);
      const executionToolName = executionNames[request.toolName];
      if (!executionToolName) throw new Error('TOOL_UNKNOWN');
      const requiresConfirmation = recoverable.has(request.toolName);
      return {
        request,
        executionRequest: { ...request, toolName: executionToolName },
        risk: requiresConfirmation ? 'recoverable' : 'read',
        decision: requiresConfirmation ? 'confirm' : 'allow',
        auditSummary: `测试操作 ${String(request.arguments['relativePath'] ?? '')}`
      };
    },
    executeRead: vi.fn(async () => ({ content: '文件内容' }))
  };
}

function context(provider: ModelProvider, signal = new AbortController().signal): RunContext {
  return {
    messages: [],
    provider,
    tools,
    toolRuntime: createToolRuntime(),
    signal
  };
}

describe('AgentLoop', () => {
  test('只执行 ToolRuntime 准备后允许的内部读取请求', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'read-runtime-1',
          toolName: 'builtin.files.read_text',
          arguments: { relativePath: 'notes.txt' }
        }
      },
      { type: 'text', text: '读取完成' }
    ]);
    const executeRead = vi.fn(async () => ({ content: '文件内容' }));
    const prepared: PreparedToolRequest = {
      request: {
        requestId: 'read-runtime-1',
        toolName: 'builtin.files.read_text',
        arguments: { relativePath: 'notes.txt' }
      },
      executionRequest: {
        requestId: 'read-runtime-1',
        toolName: 'read_text_file',
        arguments: { relativePath: 'notes.txt' }
      },
      risk: 'read',
      decision: 'allow',
      auditSummary: '读取文本 notes.txt'
    };
    const prepare = vi.fn(() => prepared);
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: { prepare, executeRead },
      signal: new AbortController().signal
    } as unknown as RunContext;

    const events = await collectEvents(runContext);

    expect(prepare).toHaveBeenCalledOnce();
    expect(executeRead).toHaveBeenCalledExactlyOnceWith(prepared.executionRequest);
    expect(events).toContainEqual({ type: 'message', text: '读取完成' });
  });

  test('可恢复请求确认前不执行并携带 Main 私有执行信息', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-runtime-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }]);
    const prepared: PreparedToolRequest = {
      request: {
        requestId: 'write-runtime-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      },
      executionRequest: {
        requestId: 'write-runtime-1',
        toolName: 'create_file',
        arguments: { relativePath: 'result.txt' }
      },
      risk: 'recoverable',
      decision: 'confirm',
      auditSummary: '创建文件 result.txt'
    };
    const executeRead = vi.fn();
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: { prepare: vi.fn(() => prepared), executeRead },
      signal: new AbortController().signal
    } as unknown as RunContext;

    const events = await collectEvents(runContext);

    expect(executeRead).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'write_request',
      request: prepared.request,
      executionRequest: prepared.executionRequest,
      risk: 'recoverable',
      auditSummary: '创建文件 result.txt',
      continuationToken: expect.stringMatching(/^continue_/u)
    }));
  });

  test('明确拒绝的工具不执行也不要求模型纠错', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'denied-1',
        toolName: 'mcp.system.delete',
        arguments: {}
      }
    }]);
    const executeRead = vi.fn();
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: {
        prepare: vi.fn(() => ({
          request: {
            requestId: 'denied-1',
            toolName: 'mcp.system.delete',
            arguments: {}
          },
          executionRequest: {
            requestId: 'denied-1',
            toolName: 'delete',
            arguments: {}
          },
          risk: 'high',
          decision: 'deny',
          auditSummary: '删除条目'
        })),
        executeRead
      },
      signal: new AbortController().signal
    } as unknown as RunContext;

    await expect(collectEvents(runContext)).rejects.toThrow('TOOL_PERMISSION_DENIED');
    expect(provider.requests).toHaveLength(1);
    expect(executeRead).not.toHaveBeenCalled();
  });

  test('纯文本响应直接生成助手消息', async () => {
    const provider = new ScriptedProvider([{ type: 'text', text: '处理完成' }]);

    await expect(collectEvents(context(provider))).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual(tools);
  });

  test('读取工具执行后把结果交回模型生成最终文本', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      { type: 'text', text: 'notes.txt 的内容已读取' }
    ]);
    const runContext = context(provider);

    const events = await collectEvents(runContext);

    expect(runContext.toolRuntime.executeRead).toHaveBeenCalledOnce();
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'read-1',
      content: '{"content":"文件内容"}'
    });
    expect(events.at(-2)).toEqual({ type: 'message', text: 'notes.txt 的内容已读取' });
  });

  test('写工具请求暂停并返回只用于 Main 的继续令牌', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }]);
    const runContext = context(provider);

    const events = await collectEvents(runContext);

    expect(runContext.toolRuntime.executeRead).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'write_request',
      request: expect.objectContaining({ requestId: 'write-1' }),
      continuationToken: expect.stringMatching(/^continue_/u)
    }));
    expect(events).toContainEqual({ type: 'phase', phase: 'awaiting_confirmation' });
  });

  test('无效工具请求只允许模型修正一次', async () => {
    const invalid = {
      type: 'tool_request' as const,
      request: { requestId: 'bad-1', toolName: 'delete_everything', arguments: {} }
    };
    const provider = new ScriptedProvider([invalid, { type: 'text', text: '已修正' }]);

    const events = await collectEvents(context(provider));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('INVALID_TOOL_REQUEST')
    }));
    expect(events).toContainEqual({ type: 'message', text: '已修正' });
  });

  test('第二次无效工具请求立即失败', async () => {
    const invalid = {
      type: 'tool_request' as const,
      request: { requestId: 'bad-1', toolName: 'delete_everything', arguments: {} }
    };
    const provider = new ScriptedProvider([invalid, invalid]);

    await expect(collectEvents(context(provider))).rejects.toThrow('AGENT_INVALID_TOOL_REQUEST');
    expect(provider.requests).toHaveLength(2);
  });

  test('最多请求四次模型响应且绝不发起第五次', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      readRequest('read-2'),
      readRequest('read-3'),
      readRequest('read-4'),
      { type: 'text', text: '不应被请求' }
    ]);

    await expect(collectEvents(context(provider))).rejects.toThrow('AGENT_MAX_TURNS');
    expect(provider.requests).toHaveLength(4);
  });

  test('开始前已中止时产生取消状态且不调用模型', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider([{ type: 'text', text: '不应被请求' }]);

    await expect(collectEvents(context(provider, controller.signal))).resolves.toEqual([
      { type: 'phase', phase: 'cancelled' }
    ]);
    expect(provider.requests).toHaveLength(0);
  });

  test('确认后单次消费继续令牌并把真实工具结果交回模型', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'write-1',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      },
      { type: 'text', text: 'result.txt 已创建' }
    ]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('创建 result.txt', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    const resumed = await collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true, toolName: 'create_file', targetRelativePath: 'result.txt' },
      runContext
    ));

    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'write-1',
      content: '{"ok":true,"toolName":"create_file","targetRelativePath":"result.txt"}'
    });
    expect(resumed).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: 'result.txt 已创建' },
      { type: 'phase', phase: 'success' }
    ]);
    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).rejects.toThrow('ACTION_EXPIRED');
  });

  test('丢弃继续令牌后不能恢复', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-1',
        toolName: 'builtin.files.create_directory',
        arguments: { relativePath: 'output' }
      }
    }]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('创建 output', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    loop.discard(writeEvent.continuationToken);

    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).rejects.toThrow('ACTION_EXPIRED');
  });

  test('第四次响应才请求写操作时不发起第五次模型调用', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      readRequest('read-2'),
      readRequest('read-3'),
      {
        type: 'tool_request',
        request: {
          requestId: 'write-4',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      },
      { type: 'text', text: '不应被请求' }
    ]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('读取后创建文件', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).resolves.toEqual([
      { type: 'message', text: '本地文件操作已完成；已达到模型响应轮次上限。' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(provider.requests).toHaveLength(4);
  });
});
