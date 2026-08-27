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
import {
  readStructuredTextSse,
  shouldStreamStructuredText
} from './structured-text-stream';

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

const MAX_STREAM_CONTENT_CHARACTERS = 64 * 1024;
const MAX_SSE_EVENT_CHARACTERS = 256 * 1024;
const MAX_SSE_TRANSPORT_CHARACTERS = 512 * 1024;
const MAX_SSE_EVENT_DATA_LINES = 1_024;
const DEEPSEEK_CHARACTER_CHAT_MAX_TOKENS = 4_096;
const SSE_YIELD_EVERY_EVENTS = 32;

type ProjectorPhase =
  | 'root'
  | 'plain_text'
  | 'key_or_end'
  | 'key'
  | 'colon'
  | 'value'
  | 'skip_string'
  | 'skip_complex'
  | 'skip_primitive'
  | 'comma_or_end'
  | 'target_string'
  | 'done';

/** 持久化游标保证每个结构化响应字符最多扫描一次，并按契约允许纯文本正文降级。 */
class IncrementalTopLevelTextProjector {
  private index = 0;
  private phase: ProjectorPhase = 'root';
  private keyCharacters: string[] = [];
  private keyEscaped = false;
  private currentKey = '';
  private skipEscaped = false;
  private skipInString = false;
  private skipClosers: string[] = [];

  constructor(
    private readonly field: string,
    private readonly allowPlainTextFallback: boolean
  ) {}

  project(source: string): string {
    const projection: string[] = [];
    if (this.phase === 'root') {
      const firstVisibleIndex = source.search(/\S/u);
      if (firstVisibleIndex < 0) return '';
      if (source[firstVisibleIndex] !== '{') {
        if (!this.allowPlainTextFallback) this.malformed();
        this.phase = 'plain_text';
      }
    }
    while (this.index < source.length) {
      const character = source[this.index]!;
      if (this.phase === 'plain_text') {
        projection.push(source.slice(this.index));
        this.index = source.length;
        continue;
      }
      if (this.phase === 'root') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== '{') this.malformed();
        this.index += 1;
        this.phase = 'key_or_end';
        continue;
      }
      if (this.phase === 'key_or_end') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        if (character !== '"') this.malformed();
        this.keyCharacters = ['"'];
        this.keyEscaped = false;
        this.index += 1;
        this.phase = 'key';
        continue;
      }
      if (this.phase === 'key') {
        this.keyCharacters.push(character);
        this.index += 1;
        if (this.keyEscaped) { this.keyEscaped = false; continue; }
        if (character === '\\') { this.keyEscaped = true; continue; }
        if (character !== '"') continue;
        try {
          this.currentKey = JSON.parse(this.keyCharacters.join('')) as string;
        } catch {
          this.malformed();
        }
        this.keyCharacters = [];
        this.phase = 'colon';
        continue;
      }
      if (this.phase === 'colon') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== ':') this.malformed();
        this.index += 1;
        this.phase = 'value';
        continue;
      }
      if (this.phase === 'value') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (this.currentKey === this.field) {
          if (character !== '"') this.malformed();
          this.index += 1;
          this.phase = 'target_string';
          continue;
        }
        if (character === '"') {
          this.index += 1;
          this.skipEscaped = false;
          this.phase = 'skip_string';
          continue;
        }
        if (character === '{' || character === '[') {
          this.skipClosers = [character === '{' ? '}' : ']'];
          this.skipInString = false;
          this.skipEscaped = false;
          this.index += 1;
          this.phase = 'skip_complex';
          continue;
        }
        this.phase = 'skip_primitive';
        continue;
      }
      if (this.phase === 'skip_string') {
        this.index += 1;
        if (this.skipEscaped) { this.skipEscaped = false; continue; }
        if (character === '\\') { this.skipEscaped = true; continue; }
        if (character === '"') this.phase = 'comma_or_end';
        continue;
      }
      if (this.phase === 'skip_complex') {
        this.index += 1;
        if (this.skipInString) {
          if (this.skipEscaped) this.skipEscaped = false;
          else if (character === '\\') this.skipEscaped = true;
          else if (character === '"') this.skipInString = false;
          continue;
        }
        if (character === '"') { this.skipInString = true; continue; }
        if (character === '{' || character === '[') {
          this.skipClosers.push(character === '{' ? '}' : ']');
          continue;
        }
        if (character === '}' || character === ']') {
          if (this.skipClosers.pop() !== character) this.malformed();
          if (this.skipClosers.length === 0) this.phase = 'comma_or_end';
        }
        continue;
      }
      if (this.phase === 'skip_primitive') {
        if (character === ',') { this.index += 1; this.phase = 'key_or_end'; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        this.index += 1;
        continue;
      }
      if (this.phase === 'comma_or_end') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character === ',') { this.index += 1; this.phase = 'key_or_end'; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        this.malformed();
      }
      if (this.phase === 'target_string') {
        if (character === '"') { this.index += 1; this.phase = 'comma_or_end'; continue; }
        if (character !== '\\') {
          const codePoint = source.codePointAt(this.index);
          if (codePoint === undefined) break;
          const decoded = String.fromCodePoint(codePoint);
          if (decoded.length === 2 && this.index + 1 >= source.length) break;
          if (codePoint < 0x20) this.malformed();
          projection.push(decoded);
          this.index += decoded.length;
          continue;
        }
        const escape = source[this.index + 1];
        if (escape === undefined) break;
        const simpleEscapes: Readonly<Record<string, string>> = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
        };
        if (escape !== 'u') {
          const decoded = simpleEscapes[escape];
          if (decoded === undefined) this.malformed();
          projection.push(decoded);
          this.index += 2;
          continue;
        }
        const hex = source.slice(this.index + 2, this.index + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-f]{4}$/iu.test(hex)) this.malformed();
        const unit = Number.parseInt(hex, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const lowPrefix = source.slice(this.index + 6, this.index + 8);
          const lowHex = source.slice(this.index + 8, this.index + 12);
          if (lowPrefix.length < 2 || lowHex.length < 4) break;
          if (lowPrefix !== '\\u' || !/^[0-9a-f]{4}$/iu.test(lowHex)) this.malformed();
          const low = Number.parseInt(lowHex, 16);
          if (low < 0xdc00 || low > 0xdfff) this.malformed();
          projection.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00));
          this.index += 12;
          continue;
        }
        projection.push(String.fromCharCode(unit));
        this.index += 6;
        continue;
      }
      if (this.phase === 'done') {
        if (!/\s/u.test(character)) this.malformed();
        this.index += 1;
      }
    }
    return projection.join('');
  }

  private malformed(): never {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
}

function splitVisibleProjection(held: string, delta: string): Readonly<{ visible: string; held: string }> {
  const candidate = held + delta;
  const normalized = candidate.toLocaleLowerCase();
  let heldCharacters = 0;
  for (const forbiddenPrefix of ['<think', '</think']) {
    for (let length = 1; length <= forbiddenPrefix.length; length += 1) {
      if (normalized.endsWith(forbiddenPrefix.slice(0, length))) {
        heldCharacters = Math.max(heldCharacters, length);
      }
    }
  }
  return heldCharacters === 0
    ? { visible: candidate, held: '' }
    : {
        visible: candidate.slice(0, -heldCharacters),
        held: candidate.slice(-heldCharacters)
      };
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
  let projectedCharacters = 0;
  let heldProjection = '';
  let streamDone = false;
  let dispatchedEvents = 0;
  const projector = request.responseContract === undefined
    ? null
    : new IncrementalTopLevelTextProjector(
        request.responseContract.textField,
        request.responseContract.allowPlainTextFallback
      );

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
    const projectionDelta = projector === null ? fragment : projector.project(content);
    projectedCharacters += projectionDelta.length;
    if (projectedCharacters > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    validateProjectedText?.(projectionDelta);
    // 只暂存可能组成 think 标签的固定长度后缀；普通正文不做累计重扫。
    const split = splitVisibleProjection(heldProjection, projectionDelta);
    heldProjection = split.held;
    if (split.visible.length > 0) {
      抛出已取消(signal);
      onTextDelta?.(split.visible);
    }
  };

  const acceptLine = (line: string): boolean => {
    if (line === '') {
      const hasEvent = eventData.length > 0;
      dispatch();
      return hasEvent;
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
    return false;
  };

  const acceptText = async (text: string): Promise<void> => {
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
      if (acceptLine(line)) {
        dispatchedEvents += 1;
        if (dispatchedEvents % SSE_YIELD_EVERY_EVENTS === 0) {
          // 单个网络块也可能包含大量事件；周期性让步使定时 Abort 不被同步解析饿死。
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          抛出已取消(signal);
        }
      }
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
      await acceptText(decoder.decode(chunk.value, { stream: true }));
      if (streamDone) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!streamDone) {
      await acceptText(decoder.decode());
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

async function readCloudOpenAISse(
  response: Response,
  request: ModelRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!response.ok) throw normalizeHttpError(response.status);
  return readStructuredTextSse(response, {
    request,
    signal,
    malformed: () => { throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false); },
    normalizeReadError: error => normalizeFetchError(error, signal),
    decodeEvent: (_eventName, data) => {
      if (data === '[DONE]') return { done: true };
      let raw: unknown;
      try { raw = JSON.parse(data); } catch { throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false); }
      if (typeof raw !== 'object' || raw === null) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      const choices = Reflect.get(raw, 'choices');
      const choice = Array.isArray(choices) ? choices[0] : undefined;
      const delta = typeof choice === 'object' && choice !== null ? Reflect.get(choice, 'delta') : undefined;
      if (typeof delta !== 'object' || delta === null) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      const toolCalls = Reflect.get(delta, 'tool_calls');
      if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length > 0)) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      // 云端推理字段既不公开也不作为本地模型泄漏处理；只消费可见 content。
      const content = Reflect.get(delta, 'content');
      if (content !== undefined && content !== null && typeof content !== 'string') {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      return typeof content === 'string' ? { fragment: content } : {};
    },
    toRaw: content => ({ choices: [{ message: { content } }] })
  });
}

/** 三类 Provider 只以可见正文作为成功前置条件，隐藏字段留给聊天适配器逐项校验。 */
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
  const required = contract.jsonSchema['required'];
  if (
    !contract.allowPlainTextFallback
    && Array.isArray(required)
    && required.some(field => (
      typeof field !== 'string'
      || !Object.prototype.hasOwnProperty.call(decoded.structured_output, field)
    ))
  ) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
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

/** DeepSeek 偶发空正文只允许在无工具的桌宠聊天边界重试，避免重复任何可执行操作。 */
function isEmptyCompatibleContent(raw: unknown): boolean {
  const parsed = compatibleResponseSchema.safeParse(raw);
  if (!parsed.success) return false;
  const message = parsed.data.choices[0]?.message;
  if (message === undefined || (message.tool_calls?.length ?? 0) > 0) return false;
  return message.content === undefined || message.content === null || message.content === '';
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
    const cloudStructuredStream = this.requestPolicy === undefined
      && shouldStreamStructuredText(request);
    const deepSeekCharacterChat = this.config.providerId === 'deepseek'
      && request.responseContract?.name === 'character_chat';
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
    const requestBody = JSON.stringify({
      ...this.config.additionalParameters,
      model: this.config.modelId,
      messages: request.messages.map(message => serializeMessage(message, toolNameCodec)),
      tools,
      tool_choice: toolChoice,
      ...(request.responseContract === undefined
        ? {}
        : { response_format: { type: 'json_object' } }),
      ...(cloudStructuredStream ? { stream: true } : {}),
      ...(deepSeekCharacterChat
        ? { thinking: { type: 'disabled' }, max_tokens: DEEPSEEK_CHARACTER_CHAT_MAX_TOKENS }
        : this.config.providerId === 'deepseek' && request.reasoningMode === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : {}),
      ...this.requestPolicy?.body
    });
    const attemptCount = deepSeekCharacterChat ? 2 : 1;

    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchClient(chatCompletionsUrl(this.config.baseUrl), {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await this.getSecret()}`
          },
          body: requestBody
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
        : cloudStructuredStream
          ? response.headers.get('content-type')?.toLocaleLowerCase().includes('application/json')
            ? await readProviderJson(response)
            : await readCloudOpenAISse(response, request, signal)
          : await readProviderJson(response);
      this.requestPolicy?.validateResponse(rawResponse);
      if (attempt === 0 && deepSeekCharacterChat && isEmptyCompatibleContent(rawResponse)) continue;
      return normalizeResponse(
        rawResponse,
        toolNameCodec,
        request.responseContract
      );
    }

    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
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
