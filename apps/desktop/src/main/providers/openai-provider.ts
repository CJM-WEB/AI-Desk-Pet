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
import { TopLevelTextProjector } from './top-level-text-projector';
import { ProviderResponseError } from './provider-response-error';

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
          arguments: z.unknown()
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
    throw new ProviderResponseError('HTTP_BODY_NOT_JSON', 'transport');
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
  if (!parsed.success) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');

  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length > 1) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  if (
    toolCalls.length === 1
    && typeof message.content === 'string'
    && message.content.length > 0
  ) {
    throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  }

  const toolCall = toolCalls[0];
  if (toolCall) {
    try {
      if (typeof toolCall.function.arguments !== 'string') {
        throw new ProviderResponseError('TOOL_ARGUMENTS_INVALID', 'tool_call');
      }
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
      if (error instanceof ProviderError || error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError('TOOL_ARGUMENTS_INVALID', 'tool_call');
    }
  }

  if (typeof message.content !== 'string') {
    throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  }
  const response = responseContract === undefined
    ? { type: 'text' as const, text: message.content }
    : normalizeResponseContractText(message.content, responseContract);
  if (responseContract === undefined && response.type === 'text') {
    if (message.metadata?.emotion !== undefined) {
      const emotion = characterEmotionLabelSchema.safeParse(message.metadata.emotion);
      if (!emotion.success) {
        throw new ProviderResponseError('CONTROL_SCHEMA_INVALID', 'chat_control');
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
  if (response.body === null) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');

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
  const projector = request.responseContract?.name !== 'character_chat'
    ? null
    : new TopLevelTextProjector({
        field: request.responseContract.textField,
        allowPlainTextFallback: request.responseContract.allowPlainTextFallback,
        malformed: () => { throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream'); }
      });

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
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    const choices = Reflect.get(raw, 'choices');
    const choice = Array.isArray(choices) ? choices[0] : undefined;
    const delta = typeof choice === 'object' && choice !== null
      ? Reflect.get(choice, 'delta')
      : undefined;
    if (typeof delta !== 'object' || delta === null) {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    if (Object.prototype.hasOwnProperty.call(delta, 'reasoning_content')) {
      throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
    }
    if (Object.prototype.hasOwnProperty.call(delta, 'tool_calls')) {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    const fragment = Reflect.get(delta, 'content');
    if (fragment !== undefined && fragment !== null && typeof fragment !== 'string') {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    if (typeof fragment !== 'string' || fragment.length === 0) return;
    if (content.length + fragment.length > MAX_STREAM_CONTENT_CHARACTERS) {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    }
    content += fragment;
    const projectionDelta = projector === null ? fragment : projector.project(content);
    projectedCharacters += projectionDelta.length;
    if (projectedCharacters > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) {
      throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
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
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
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
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
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
    if (!streamDone) throw new ProviderResponseError('STREAM_TERMINAL_MISSING', 'stream');
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
    malformed: () => { throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream'); },
    terminalMissing: () => { throw new ProviderResponseError('STREAM_TERMINAL_MISSING', 'stream'); },
    normalizeReadError: error => normalizeFetchError(error, signal),
    decodeEvent: (_eventName, data) => {
      if (data === '[DONE]') return { done: true };
      let raw: unknown;
      try { raw = JSON.parse(data); } catch {
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
      }
      if (typeof raw !== 'object' || raw === null) {
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
      }
      const choices = Reflect.get(raw, 'choices');
      const choice = Array.isArray(choices) ? choices[0] : undefined;
      const delta = typeof choice === 'object' && choice !== null ? Reflect.get(choice, 'delta') : undefined;
      if (typeof delta !== 'object' || delta === null) {
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
      }
      const toolCalls = Reflect.get(delta, 'tool_calls');
      if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length > 0)) {
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
      }
      // 云端推理字段既不公开也不作为本地模型泄漏处理；只消费可见 content。
      const content = Reflect.get(delta, 'content');
      if (content !== undefined && content !== null && typeof content !== 'string') {
        throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
      }
      return typeof content === 'string' ? { fragment: content } : {};
    },
    toRaw: content => ({ choices: [{ message: { content } }] })
  });
}

/** 各 Provider 共用契约解码；聊天隐藏字段留给适配器，自主只返回完整有效的无正文信封。 */
export function normalizeResponseContractText(
  raw: string,
  contract: ModelResponseContract
): Exclude<ModelResponse, { type: 'tool_request' }> {
  const decoded = decodeResponseContractText(raw, contract);
  if (decoded.kind === 'invalid') {
    throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
  }
  if (decoded.kind === 'plain_text') {
    return { type: 'text', text: decoded.text };
  }
  if (decoded.kind === 'structured_only') {
    return { type: 'structured', structured_output: decoded.structured_output };
  }
  const required = contract.jsonSchema['required'];
  if (
    contract.name === 'character_chat' && !contract.allowPlainTextFallback
    && Array.isArray(required)
    && required.some(field => (
      typeof field !== 'string'
      || !Object.prototype.hasOwnProperty.call(decoded.structured_output, field)
    ))
  ) {
    throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
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
    && (request.tools.length > 0 || request.toolChoice !== 'none'
      || request.responseContract.name === 'character_autonomy' && request.onTextDelta !== undefined)
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

    throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
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
