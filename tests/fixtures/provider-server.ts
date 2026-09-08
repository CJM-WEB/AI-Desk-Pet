import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelMessage, ModelRequest, ModelResponse } from '@myself/agent-core';

export type ProviderInspectionRequest = ModelRequest & Readonly<{
  toolChoiceWasExplicit: boolean;
  localPolicyWasForced: boolean;
  responseFormatWasJsonObject: boolean;
}>;

export interface ProviderStep {
  response: ModelResponse | ProviderSseResponse | ((request: Record<string, unknown>) => ProviderSseResponse);
  inspect?: (request: ProviderInspectionRequest) => void;
  inspectRaw?: (request: Record<string, unknown>) => void;
  gate?: ProviderResponseGate;
}

export interface ProviderSseResponse {
  type: 'sse';
  chunks: unknown[];
}

/** 原 OpenAI Chat SSE；仅脚本化模型输出，执行与结果回注由正式 Core 完成。 */
export function codingResponse(value: string | Array<{ name: string; args: Record<string, unknown>; id?: string }>): ProviderSseResponse {
  const delta = typeof value === 'string' ? { content: value } : {
    tool_calls: value.map((tool, index) => ({ index, id: tool.id ?? `call_${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }))
  };
  return { type: 'sse', chunks: [
    { id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }] }
  ] };
}

export interface ProviderResponseGate {
  isWaiting(): boolean;
  release(): void;
  waitForRelease(): Promise<void>;
}

export type ProviderScript = ProviderStep[] | ((apiKey: string) => ProviderStep[]);

export interface ProviderRequestLog {
  method: string;
  model: string;
  messageRoleCounts: Record<ModelMessage['role'], number>;
  toolCount: number;
}

export interface ProviderServerFixture {
  baseUrl: string;
  apiKey: string;
  requests: ProviderRequestLog[];
  inspectionErrors: string[];
  remainingSteps(): number;
  assertComplete(): void;
  waitForCompletedResponses(count: number): Promise<void>;
  close(): Promise<void>;
}

/** 由测试条件显式释放响应，避免通过墙钟休眠制造可观察窗口。 */
export function createProviderResponseGate(): ProviderResponseGate {
  let waiting = false;
  let released = false;
  let resolveRelease!: () => void;
  const releasedPromise = new Promise<void>(resolve => {
    resolveRelease = resolve;
  });
  return {
    isWaiting: () => waiting,
    release() {
      if (released) return;
      released = true;
      resolveRelease();
    },
    async waitForRelease() {
      waiting = true;
      await releasedPromise;
      waiting = false;
    }
  };
}

export async function startProviderServer(
  steps: ProviderScript
): Promise<ProviderServerFixture> {
  const requests: ProviderRequestLog[] = [];
  const inspectionErrors: string[] = [];
  const apiKey = `myself-e2e-${randomBytes(24).toString('hex')}`;
  const script = [...(typeof steps === 'function' ? steps(apiKey) : steps)];
  let unexpectedRequestCount = 0;
  let completedResponseCount = 0;
  const completionWaiters: Array<{ count: number; resolve: () => void }> = [];
  const markResponseCompleted = () => {
    completedResponseCount += 1;
    for (let index = completionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = completionWaiters[index];
      if (waiter && completedResponseCount >= waiter.count) {
        completionWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '请求方法无效' } }));
      return;
    }
    if (url.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '请求端点无效' } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '请求授权无效' } }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let parsed: ProviderInspectionRequest;
    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      parsed = normalizeRequest(rawRequest);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '请求格式无效' } }));
      return;
    }

    // 持久摘要仅保留路由计数，正文、密钥、路径和工具名均停留在当前请求内。
    const messageRoleCounts: ProviderRequestLog['messageRoleCounts'] = {
      system: 0,
      user: 0,
      assistant: 0,
      tool: 0
    };
    for (const message of parsed.messages) messageRoleCounts[message.role] += 1;
    requests.push({
      method: request.method ?? '',
      model: isRecord(rawRequest) && typeof rawRequest.model === 'string' ? rawRequest.model : '',
      messageRoleCounts,
      toolCount: parsed.tools.length
    });
    const step = script.shift();
    if (!step) {
      unexpectedRequestCount += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '测试脚本没有更多响应' } }));
      markResponseCompleted();
      return;
    }
    if (step.inspect || step.inspectRaw) {
      try {
        step.inspect?.(parsed);
        step.inspectRaw?.(rawRequest as Record<string, unknown>);
      } catch {
        inspectionErrors.push('脚本化 Provider 请求检查失败');
      }
    }
    // 客户端取消或 fixture 关闭时解除门闩，不留下等待响应的服务协程。
    const release = () => step.gate?.release();
    response.once('close', release);
    if (step.gate) await step.gate.waitForRelease();
    response.off('close', release);
    if (response.destroyed) return;
    try {
      const result = typeof step.response === 'function' ? step.response(rawRequest as Record<string, unknown>) : step.response;
      if (result.type === 'sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of result.chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(compatibleResponse(result)));
      }
    } catch {
      inspectionErrors.push('脚本化 Provider 响应构造失败');
      response.destroy();
    }
    // reset 会主动中止客户端连接；以脚本步骤执行完 response.end 作为确定性完成屏障。
    markResponseCompleted();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    requests,
    inspectionErrors,
    remainingSteps: () => script.length,
    assertComplete() {
      if (script.length > 0) {
        throw new Error(`脚本化 Provider 仍有 ${script.length} 个响应未消费`);
      }
      // 同时拒绝脚本耗尽后的请求，避免 500 响应被上层错误路径掩盖成假绿。
      if (unexpectedRequestCount > 0) {
        throw new Error(`脚本化 Provider 收到 ${unexpectedRequestCount} 个额外请求`);
      }
    },
    waitForCompletedResponses(count) {
      if (!Number.isSafeInteger(count) || count < 0) {
        return Promise.reject(new Error('脚本化 Provider 响应完成数量无效'));
      }
      if (completedResponseCount >= count) return Promise.resolve();
      return new Promise<void>(resolve => completionWaiters.push({ count, resolve }));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeAssistantToolRequest(message: Record<string, unknown>) {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) {
    throw new Error('助手工具调用格式无效');
  }
  const call = message.tool_calls[0];
  if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function)) {
    throw new Error('助手工具调用格式无效');
  }
  const functionCall = call.function;
  if (
    typeof functionCall.name !== 'string'
    || typeof functionCall.arguments !== 'string'
  ) {
    throw new Error('助手工具调用格式无效');
  }
  const arguments_ = JSON.parse(functionCall.arguments) as unknown;
  if (!isRecord(arguments_)) throw new Error('助手工具调用参数无效');
  return {
    requestId: call.id,
    toolName: functionCall.name,
    arguments: arguments_
  };
}

function normalizeRequest(value: unknown): ProviderInspectionRequest {
  if (!isRecord(value) || !Array.isArray(value.messages) || (value.tools !== undefined && !Array.isArray(value.tools))) {
    throw new Error('请求格式无效');
  }
  const tools = (value.tools ?? []) as ModelRequest['tools'];
  const rawToolChoice = value.tool_choice;
  const toolChoiceWasExplicit = rawToolChoice !== undefined;
  const toolChoice = rawToolChoice === undefined
    ? tools.length === 0 ? 'none' : 'auto'
    : rawToolChoice;
  if (toolChoice !== 'auto' && toolChoice !== 'required' && toolChoice !== 'none') {
    throw new Error('工具选择策略无效');
  }
  const localPolicyWasForced = value.stream === false
    && value.reasoning_effort === 'none'
    && isRecord(value.chat_template_kwargs)
    && value.chat_template_kwargs.enable_thinking === false
    && value.parallel_tool_calls === false
    && value.parse_tool_calls === true;
  const responseFormatWasJsonObject = isRecord(value.response_format)
    && value.response_format.type === 'json_object';
  const reasoningMode = (
    isRecord(value.thinking) && value.thinking.type === 'disabled'
  ) || localPolicyWasForced
    ? 'disabled'
    : 'provider_default';
  const messages = value.messages.map((message): ModelMessage => {
    if (!isRecord(message) || typeof message.role !== 'string') {
      throw new Error('消息格式无效');
    }
    const role = message.role;
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') {
        throw new Error('工具消息格式无效');
      }
      return {
        role: 'tool' as const,
        toolCallId: message.tool_call_id,
        content: message.content
      };
    }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error('消息角色无效');
    }
    if (role === 'assistant' && message.tool_calls !== undefined && value.stream !== true) {
      return {
        role,
        content: typeof message.content === 'string' ? message.content : '',
        toolRequest: normalizeAssistantToolRequest(message)
      };
    }
    return {
      role,
      content: typeof message.content === 'string' ? message.content : ''
    };
  });
  // inspect 只观察本次请求契约；这些字段不进入去标识化持久摘要。
  return {
    messages,
    tools,
    toolChoice,
    reasoningMode,
    toolChoiceWasExplicit,
    localPolicyWasForced,
    responseFormatWasJsonObject
  };
}

function compatibleResponse(response: ModelResponse): unknown {
  if (response.type === 'structured') {
    return { choices: [{ message: { content: JSON.stringify(response.structured_output) } }] };
  }
  if (response.type === 'text') {
    return {
      choices: [{
        message: {
          content: response.text,
          ...((response.emotion !== undefined || response.behaviorIntent !== undefined)
            ? {
                metadata: {
                  ...(response.emotion === undefined ? {} : { emotion: response.emotion }),
                  ...(response.behaviorIntent === undefined
                    ? {}
                    : { behaviorIntent: response.behaviorIntent })
                }
              }
            : {})
        }
      }]
    };
  }
  const request = response.request;
  if (!isRecord(request)
    || typeof request.requestId !== 'string'
    || typeof request.toolName !== 'string'
    || !isRecord(request.arguments)) {
    throw new Error('脚本化工具请求无效');
  }
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: request.requestId,
          type: 'function',
          function: {
            name: request.toolName,
            arguments: JSON.stringify(request.arguments)
          }
        }]
      }
    }]
  };
}
