import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import {
  OpenAICompatibleProvider,
  ProviderError,
  type FetchLike,
  type OpenAIRequestPolicy
} from './openai-provider';

export interface LocalModelConnection {
  generation: string;
  baseUrl: string;
  token: string;
  modelId: string;
}

export interface LocalModelConnectionPort {
  getReadyConnection(): LocalModelConnection;
}

const localRequestBody = {
  stream: false,
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
  parallel_tool_calls: false,
  parse_tool_calls: true
} as const;

const LOCAL_INPUT_TOKEN_BUDGET = 6_400;
const CONSERVATIVE_UTF8_BYTES_PER_TOKEN = 3;
const LOCAL_READ_RESULT_CHARACTER_BUDGET = 4_000;

function boundLocalReadResult(content: string): Readonly<{ content: string; lineCount: number }> {
  if (content.length <= LOCAL_READ_RESULT_CHARACTER_BUDGET) {
    return { content, lineCount: content.length === 0 ? 0 : content.split('\n').length };
  }
  const lines = content.split('\n');
  const retained: string[] = [];
  let characters = 0;
  for (const line of lines) {
    const nextCharacters = characters + (retained.length === 0 ? 0 : 1) + line.length;
    if (nextCharacters > LOCAL_READ_RESULT_CHARACTER_BUDGET) {
      // 首行本身超限时仍保留一行的明确字符截断，避免把非空文件伪装成零行。
      if (retained.length === 0) {
        retained.push(line.slice(0, LOCAL_READ_RESULT_CHARACTER_BUDGET));
      }
      break;
    }
    retained.push(line);
    characters = nextCharacters;
  }
  return { content: retained.join('\n'), lineCount: retained.length };
}

/** 仅本地请求压缩当前读取结果；云 Provider 与 FileToolService 的公开上限保持不变。 */
function applyLocalToolResultBudget(messages: ModelRequest['messages']): ModelRequest['messages'] {
  let changed = false;
  const bounded = messages.map(message => {
    if (message.role !== 'tool') return message;
    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (
      typeof result !== 'object'
      || result === null
      || Array.isArray(result)
      || Reflect.get(result, 'toolName') !== 'read_file'
      || typeof Reflect.get(result, 'content') !== 'string'
    ) return message;
    const originalContent = Reflect.get(result, 'content') as string;
    const next = boundLocalReadResult(originalContent);
    if (next.content === originalContent) return message;
    const startLine = Reflect.get(result, 'startLine');
    changed = true;
    return {
      ...message,
      content: JSON.stringify({
        ...result,
        content: next.content,
        ...(Number.isSafeInteger(startLine)
          ? { endLine: (startLine as number) + next.lineCount - 1 }
          : {}),
        truncated: true
      })
    };
  });
  return changed ? bounded : messages;
}

function estimateInputTokens(request: ModelRequest, messages: readonly ModelRequest['messages'][number][]): number {
  const serialized = JSON.stringify({
    messages,
    tools: request.tools,
    responseSchema: request.responseContract?.jsonSchema ?? null
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / CONSERVATIVE_UTF8_BYTES_PER_TOKEN);
}

/**
 * 本地 8192 上下文只从最早完整回合开始删除；系统、当前用户、最近完整回合与工具链保持原样。
 * 受保护内容自身超预算时仍完整发送，不以截断用户正文换取表面达标。
 */
function applyLocalContextBudget(request: ModelRequest): ModelRequest {
  const locallyBoundedMessages = applyLocalToolResultBudget(request.messages);
  const boundedRequest = locallyBoundedMessages === request.messages
    ? request
    : { ...request, messages: locallyBoundedMessages };
  if (estimateInputTokens(boundedRequest, locallyBoundedMessages) <= LOCAL_INPUT_TOKEN_BUDGET) {
    return boundedRequest;
  }

  const groups: number[][] = [];
  let currentGroup: number[] | null = null;
  locallyBoundedMessages.forEach((message, index) => {
    if (message.role === 'system') return;
    if (message.role === 'user') {
      if (currentGroup !== null) groups.push(currentGroup);
      currentGroup = [index];
      return;
    }
    currentGroup ??= [];
    currentGroup.push(index);
  });
  if (currentGroup !== null) groups.push(currentGroup);

  // 最后组包含当前用户及本轮工具链；倒数第二组是最近完整历史回合。
  const removableGroups = groups.slice(0, Math.max(0, groups.length - 2));
  const removed = new Set<number>();
  let messages = locallyBoundedMessages;
  for (const group of removableGroups) {
    if (estimateInputTokens(boundedRequest, messages) <= LOCAL_INPUT_TOKEN_BUDGET) break;
    group.forEach(index => removed.add(index));
    messages = locallyBoundedMessages.filter((_message, index) => !removed.has(index));
  }
  return messages === request.messages ? request : { ...request, messages };
}

function assertCurrentGeneration(
  connectionPort: LocalModelConnectionPort,
  generation: string
): void {
  try {
    if (connectionPort.getReadyConnection().generation === generation) return;
  } catch {
    // 取得初始连接后的任何非 ready 状态都表示本次调用已经失效。
  }
  throw new ProviderError('LOCAL_MODEL_CONNECTION_STALE', false);
}

function assertNoReasoningLeak(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const choices = Reflect.get(raw, 'choices');
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = Reflect.get(choice, 'message');
    if (typeof message !== 'object' || message === null) continue;
    const content = Reflect.get(message, 'content');
    if (
      Object.prototype.hasOwnProperty.call(message, 'reasoning_content')
      || (typeof content === 'string' && /<\/?think(?:\s[^>]*)?>/iu.test(content))
    ) {
      throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
    }
  }
}

function createRequestPolicy(
  connectionPort: LocalModelConnectionPort,
  generation: string,
  request: ModelRequest
): OpenAIRequestPolicy {
  const streamVisibleText = request.responseContract !== undefined
    && request.tools.length === 0
    && request.toolChoice === 'none'
    && request.onTextDelta !== undefined;
  let reasoningTagTail = '';
  return {
    body: {
      ...localRequestBody,
      stream: streamVisibleText,
      ...(request.toolChoice === 'required' ? { temperature: 0 } : {}),
      // 锁定的 llama.cpp 支持在 json_object 中附带 Schema；只约束本地结构化回合。
      ...(request.responseContract === undefined
        ? {}
        : {
            response_format: {
              type: 'json_object',
              schema: request.responseContract.jsonSchema
            }
          })
    },
    responseMode: streamVisibleText ? 'sse' : 'json',
    ...(streamVisibleText
      ? {
          onTextDelta: (delta: string): void => {
            assertCurrentGeneration(connectionPort, generation);
            request.onTextDelta?.(delta);
          },
          validateProjectedText: (delta: string): void => {
            const candidate = reasoningTagTail + delta;
            if (/<\/?think(?:\s|>)/iu.test(candidate)) {
              throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
            }
            // 最长危险前缀是 `</think`；固定尾窗即可识别跨事件标签且保持线性。
            reasoningTagTail = candidate.slice(-7);
          }
        }
      : {}),
    validateResponse(raw: unknown): void {
      assertCurrentGeneration(connectionPort, generation);
      assertNoReasoningLeak(raw);
    }
  };
}

/** 本地模型只复用 OpenAI 传输协议；连接有效性与非思考约束始终由 Main 强制。 */
export class LocalModelProvider implements ModelProvider {
  constructor(
    private readonly connectionPort: LocalModelConnectionPort,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const budgetedRequest = applyLocalContextBudget(request);
    const connection = this.connectionPort.getReadyConnection();
    const provider = new OpenAICompatibleProvider(
      {
        baseUrl: connection.baseUrl,
        modelId: connection.modelId
      },
      async () => {
        assertCurrentGeneration(this.connectionPort, connection.generation);
        return connection.token;
      },
      this.fetchClient,
      createRequestPolicy(this.connectionPort, connection.generation, budgetedRequest)
    );
    try {
      return await provider.respond({
        ...budgetedRequest,
        reasoningMode: 'disabled'
      }, signal);
    } catch (error) {
      assertCurrentGeneration(this.connectionPort, connection.generation);
      throw error;
    }
  }
}
