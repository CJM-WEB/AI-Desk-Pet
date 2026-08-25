import {
  decodeResponseContractText,
  type ModelResponseContract,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolDefinition
} from '@myself/agent-core';
import {
  ASSISTANT_STREAM_TEXT_MAX_CHARACTERS,
  characterEmotionLabelSchema,
  type ProviderProfile
} from '@myself/shared-types';
import { characterAgentBehaviorIntentSchema } from '@myself/character-runtime';
import { z } from 'zod';
import {
  createOpenAIToolNameCodec,
  type OpenAIToolNameCodec
} from './openai-tool-name-codec';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type AdditionalParameterValue = string | number | boolean;

export interface ProviderAdapterConfig {
  baseUrl: string;
  modelId: string;
  providerId?: string;
  additionalParameters?: Record<string, AdditionalParameterValue>;
}

type OpenAICompatibleConfig = ProviderAdapterConfig | ProviderProfile;

export interface OpenAIRequestPolicy {
  body: Readonly<Record<string, unknown>>;
  validateResponse(raw: unknown): void;
  responseMode?: 'json' | 'sse';
  onTextDelta?: (delta: string) => void;
  validateProjectedText?: (text: string) => void;
}

const compatibleResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      metadata: z.object({
        emotion: z.unknown().optional(),
        behaviorIntent: z.unknown().optional()
      }).optional(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1),
          arguments: z.string()
        })
      })).optional()
    })
  })).min(1)
});

const toolArgumentsSchema = z.record(z.unknown());

export class ProviderError extends Error {
  readonly name = 'ProviderError';

  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | undefined = undefined
  ) {
    super(code);
  }
}

function chatCompletionsUrl(baseUrl: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('chat/completions', normalizedBase);
}

function resolveOpenAIConfig(config: OpenAICompatibleConfig): ProviderAdapterConfig {
  if ('modelId' in config) return config;
  return {
    baseUrl: config.baseUrl,
    modelId: config.model
  };
}

export function normalizeHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTHENTICATION_FAILED', false, status);
  }
  if (status === 404) return new ProviderError('PROVIDER_ENDPOINT_NOT_FOUND', false, status);
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMITED', true, status);
  if (status >= 500) return new ProviderError('PROVIDER_SERVER_ERROR', true, status);
  return new ProviderError('PROVIDER_REQUEST_FAILED', false, status);
}

export function normalizeFetchError(error: unknown, _signal: AbortSignal): never {
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    throw new ProviderError('PROVIDER_TIMEOUT', true);
  }
  throw new ProviderError('PROVIDER_NETWORK_ERROR', true);
}

export async function readProviderJson(response: Response): Promise<unknown> {
  if (!response.ok) throw normalizeHttpError(response.status);

  try {
    return await response.json();
  } catch {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
}

function serializeMessage(
  message: ModelMessage,
  toolNameCodec: OpenAIToolNameCodec
): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  if (message.role === 'assistant' && message.toolRequest) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: message.toolRequest.requestId,
        type: 'function',
        function: {
          name: toolNameCodec.encode(message.toolRequest.toolName),
          arguments: JSON.stringify(message.toolRequest.arguments)
        }
      }]
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeResponse(
  raw: unknown,
  toolNameCodec: OpenAIToolNameCodec,
  responseContract: ModelResponseContract | undefined
): ModelResponse {
  const parsed = compatibleResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length > 1) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  if (
    toolCalls.length === 1
    && typeof message.content === 'string'
    && message.content.length > 0
  ) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }

  const toolCall = toolCalls[0];
  if (toolCall) {
    try {
      const argumentsValue = toolArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
      let toolName: string;
      try {
        toolName = toolNameCodec.decode(toolCall.function.name);
      } catch {
        throw new ProviderError('PROVIDER_UNKNOWN_TOOL_CALL', false);
      }
      return {
        type: 'tool_request',
        request: {
          requestId: toolCall.id,
          toolName,
          arguments: argumentsValue
        }
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
  }

  if (typeof message.content !== 'string') {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  const response = responseContract === undefined
    ? { type: 'text' as const, text: message.content }
    : normalizeResponseContractText(message.content, responseContract);
  if (responseContract === undefined) {
    if (message.metadata?.emotion !== undefined) {
      const emotion = characterEmotionLabelSchema.safeParse(message.metadata.emotion);
      if (!emotion.success) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      response.emotion = emotion.data;
    }
    // 旧元数据只服务无响应契约的能力任务；结构化聊天以正文契约为唯一来源。
    const behaviorIntent = characterAgentBehaviorIntentSchema.safeParse(
      message.metadata?.behaviorIntent
    );
    if (behaviorIntent.success) response.behaviorIntent = behaviorIntent.data;
  }
  return response;
}

type ParsedJsonString = Readonly<{ value: string; end: number }>;

const MAX_STREAM_CONTENT_CHARACTERS = 64 * 1024;
const MAX_SSE_EVENT_CHARACTERS = 256 * 1024;
const MAX_SSE_TRANSPORT_CHARACTERS = 512 * 1024;
const MAX_SSE_EVENT_DATA_LINES = 1_024;

function 跳过空白(source: string, start: number): number {
  let index = start;
  while (/\s/u.test(source[index] ?? '')) index += 1;
  return index;
}

function 读取完整Json字符串(source: string, start: number): ParsedJsonString | null {
  if (source[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      return {
        value: JSON.parse(source.slice(start, index + 1)) as string,
        end: index + 1
      };
    } catch {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
  }
  return null;
}

function 跳过完整Json值(source: string, start: number): number | null {
  const first = source[start];
  if (first === undefined) return null;
  if (first === '"') return 读取完整Json字符串(source, start)?.end ?? null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    if (depth === 0 && (character === ',' || character === '}')) {
      const value = source.slice(start, index).trim();
      try {
        JSON.parse(value);
        return index;
      } catch {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
    }
  }
  return null;
}

function 查找顶层字段值(source: string, field: string): number | null {
  let index = 跳过空白(source, 0);
  if (source[index] !== '{') return null;
  index += 1;
  while (index < source.length) {
    index = 跳过空白(source, index);
    if (source[index] === '}') return null;
    const key = 读取完整Json字符串(source, index);
    if (key === null) return null;
    index = 跳过空白(source, key.end);
    if (source[index] !== ':') return null;
    index = 跳过空白(source, index + 1);
    if (key.value === field) return index;
    const valueEnd = 跳过完整Json值(source, index);
    if (valueEnd === null) return null;
    index = 跳过空白(source, valueEnd);
    if (source[index] !== ',') return null;
    index += 1;
  }
  return null;
}

function 解码部分Json字符串(source: string, start: number): string {
  if (source[start] !== '"') return '';
  let result = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') return result;
    if (character !== '\\') {
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined) return result;
      const decoded = String.fromCodePoint(codePoint);
      if (decoded.length === 2 && index + 1 >= source.length) return result;
      if (codePoint < 0x20) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      result += decoded;
      index += decoded.length - 1;
      continue;
    }

    const escape = source[index + 1];
    if (escape === undefined) return result;
    const simpleEscapes: Readonly<Record<string, string>> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
    };
    if (escape !== 'u') {
      const decoded = simpleEscapes[escape];
      if (decoded === undefined) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      result += decoded;
      index += 1;
      continue;
    }

    const hex = source.slice(index + 2, index + 6);
    if (hex.length < 4) return result;
    if (!/^[0-9a-f]{4}$/iu.test(hex)) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    const unit = Number.parseInt(hex, 16);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const lowPrefix = source.slice(index + 6, index + 8);
      const lowHex = source.slice(index + 8, index + 12);
      if (lowPrefix.length < 2 || lowHex.length < 4) return result;
      if (lowPrefix !== '\\u' || !/^[0-9a-f]{4}$/iu.test(lowHex)) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      const low = Number.parseInt(lowHex, 16);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      result += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00);
      index += 11;
      continue;
    }
    result += String.fromCharCode(unit);
    index += 5;
  }
  return result;
}

/** 只从结构化 JSON 的顶层正文属性提取稳定前缀，隐藏控制字段与未完成 escape。 */
function 投影顶层正文(source: string, field: string): string {
  const start = 查找顶层字段值(source, field);
  return start === null ? '' : 解码部分Json字符串(source, start);
}

function 抛出已取消(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Aborted', 'AbortError');
}

async function readProviderSse(
  response: Response,
  request: ModelRequest,
  signal: AbortSignal,
  onTextDelta: ((delta: string) => void) | undefined,
  validateProjectedText: ((text: string) => void) | undefined
): Promise<unknown> {
  if (!response.ok) throw normalizeHttpError(response.status);
  if (response.body === null) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let eventData: string[] = [];
  let eventCharacters = 0;
  let transportCharacters = 0;
  let content = '';
  let projected = '';
  let emittedCharacters = 0;
  let streamDone = false;

  const dispatch = (): void => {
    if (eventData.length === 0) return;
    const data = eventData.join('\n');
    eventData = [];
    eventCharacters = 0;
    if (data === '[DONE]') {
      streamDone = true;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    const choices = Reflect.get(raw, 'choices');
    const choice = Array.isArray(choices) ? choices[0] : undefined;
    const delta = typeof choice === 'object' && choice !== null
      ? Reflect.get(choice, 'delta')
      : undefined;
    if (typeof delta !== 'object' || delta === null) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    if (Object.prototype.hasOwnProperty.call(delta, 'reasoning_content')) {
      throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
    }
    if (Object.prototype.hasOwnProperty.call(delta, 'tool_calls')) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    const fragment = Reflect.get(delta, 'content');
    if (fragment !== undefined && fragment !== null && typeof fragment !== 'string') {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    if (typeof fragment !== 'string' || fragment.length === 0) return;
    if (content.length + fragment.length > MAX_STREAM_CONTENT_CHARACTERS) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    content += fragment;
    const nextProjected = request.responseContract === undefined
      ? content
      : 投影顶层正文(content, request.responseContract.textField);
    if (!nextProjected.startsWith(projected)) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    if (nextProjected.length > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    projected = nextProjected;
    validateProjectedText?.(projected);
    // 未闭合标签先暂存，避免跨 chunk 的 <think> 在识别完整前泄露标签前缀。
    const lastOpenTag = projected.lastIndexOf('<');
    const lastCloseTag = projected.lastIndexOf('>');
    const safeCharacters = lastOpenTag > lastCloseTag ? lastOpenTag : projected.length;
    const visibleDelta = projected.slice(emittedCharacters, safeCharacters);
    emittedCharacters = safeCharacters;
    if (visibleDelta.length > 0) {
      抛出已取消(signal);
      onTextDelta?.(visibleDelta);
    }
  };

  const acceptLine = (line: string): void => {
    if (line === '') {
      dispatch();
    } else if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /u, '');
      if (
        eventData.length >= MAX_SSE_EVENT_DATA_LINES
        || eventCharacters + value.length > MAX_SSE_EVENT_CHARACTERS
      ) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      eventData.push(value);
      eventCharacters += value.length;
    }
  };

  const acceptText = (text: string): void => {
    let offset = 0;
    while (!streamDone && offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(offset, end);
      transportCharacters += fragment.length + (newline < 0 ? 0 : 1);
      if (
        transportCharacters > MAX_SSE_TRANSPORT_CHARACTERS
        || lineBuffer.length + fragment.length > MAX_SSE_EVENT_CHARACTERS
      ) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      lineBuffer += fragment;
      if (newline < 0) return;
      const line = lineBuffer.replace(/\r$/u, '');
      lineBuffer = '';
      offset = newline + 1;
      acceptLine(line);
    }
  };

  try {
    while (true) {
      抛出已取消(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        normalizeFetchError(error, signal);
      }
      if (chunk.done) break;
      acceptText(decoder.decode(chunk.value, { stream: true }));
      if (streamDone) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!streamDone) {
      acceptText(decoder.decode());
      if (lineBuffer.length > 0) {
        const finalLine = lineBuffer;
        lineBuffer = '';
        acceptLine(finalLine.replace(/\r$/u, ''));
      }
      dispatch();
    }
    if (!streamDone) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    choices: [{
      message: {
        content
      }
    }]
  };
}

/** 三类 Provider 共用同一正文降级规则，避免协议适配器各自实现不一致的恢复逻辑。 */
export function normalizeResponseContractText(
  raw: string,
  contract: ModelResponseContract
): Extract<ModelResponse, { type: 'text' }> {
  const decoded = decodeResponseContractText(raw, contract);
  if (decoded.kind === 'invalid') {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  if (decoded.kind === 'plain_text') {
    return { type: 'text', text: decoded.text };
  }
  return {
    type: 'text',
    text: decoded.text,
    structured_output: decoded.structured_output
  };
}

/** 响应契约没有系统权限，也不得与工具调用复用同一次 Provider 请求。 */
export function assertResponseContractRequest(request: ModelRequest): void {
  if (
    request.responseContract !== undefined
    && (request.tools.length > 0 || request.toolChoice !== 'none')
  ) {
    throw new ProviderError('PROVIDER_RESPONSE_CONTRACT_CONFLICT', false);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    config: OpenAICompatibleConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch,
    private readonly requestPolicy?: OpenAIRequestPolicy
  ) {
    this.config = resolveOpenAIConfig(config);
  }

  private readonly config: ProviderAdapterConfig;

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    assertResponseContractRequest(request);
    // 单次请求复用同一映射，确保定义、续传历史与响应名称处于同一 Provider 命名空间。
    const toolChoice = resolveToolChoice(request);
    const toolNameCodec = createOpenAIToolNameCodec(codecDefinitions(request));
    const tools = request.tools.map(definition => ({
      ...definition,
      function: {
        ...definition.function,
        name: toolNameCodec.encode(definition.function.name)
      }
    }));
    let response: Response;
    try {
      response = await this.fetchClient(chatCompletionsUrl(this.config.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.getSecret()}`
        },
        body: JSON.stringify({
          ...this.config.additionalParameters,
          model: this.config.modelId,
          messages: request.messages.map(message => serializeMessage(message, toolNameCodec)),
          tools,
          tool_choice: toolChoice,
          ...(request.responseContract === undefined
            ? {}
            : { response_format: { type: 'json_object' } }),
          ...(this.config.providerId === 'deepseek' && request.reasoningMode === 'disabled'
            ? { thinking: { type: 'disabled' } }
            : {}),
          ...this.requestPolicy?.body
        })
      });
    } catch (error) {
      if (this.requestPolicy !== undefined && error instanceof ProviderError) throw error;
      normalizeFetchError(error, signal);
    }

    const rawResponse = this.requestPolicy?.responseMode === 'sse'
      ? await readProviderSse(
          response,
          request,
          signal,
          this.requestPolicy.onTextDelta,
          this.requestPolicy.validateProjectedText
        )
      : await readProviderJson(response);
    this.requestPolicy?.validateResponse(rawResponse);
    return normalizeResponse(
      rawResponse,
      toolNameCodec,
      request.responseContract
    );
  }
}

function resolveToolChoice(request: ModelRequest): ModelRequest['toolChoice'] {
  if (request.tools.length === 0 && request.toolChoice !== 'none') {
    throw new ProviderError('PROVIDER_TOOL_CHOICE_INVALID', false);
  }
  if (request.tools.length > 0 && request.toolChoice === 'none') {
    throw new ProviderError('PROVIDER_TOOL_CHOICE_INVALID', false);
  }
  return request.toolChoice;
}

function codecDefinitions(request: ModelRequest): ToolDefinition[] {
  return [
    ...request.tools,
    ...request.messages.flatMap(message => (
      message.role === 'assistant' && message.toolRequest
        ? [{
            type: 'function' as const,
            function: {
              name: message.toolRequest.toolName,
              description: '',
              parameters: {}
            }
          }]
        : []
    ))
  ];
}
