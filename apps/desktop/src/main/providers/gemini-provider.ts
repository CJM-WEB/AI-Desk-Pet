import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolDefinition
} from '@myself/agent-core';
import { z } from 'zod';
import {
  assertResponseContractRequest,
  type FetchLike,
  type ProviderAdapterConfig,
  ProviderError,
  normalizeFetchError,
  normalizeHttpError,
  normalizeResponseContractText,
  readProviderJson
} from './openai-provider';
import {
  readStructuredTextSse,
  shouldStreamStructuredText
} from './structured-text-stream';

const geminiPartSchema = z.union([
  z.object({
    text: z.string()
  }).strict(),
  z.object({
    functionCall: z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      args: z.record(z.unknown())
    }).strict(),
    thoughtSignature: z.string().optional()
  }).strict()
]);

const geminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(geminiPartSchema).min(1)
    })
  })).min(1)
});

function generateContentUrl(baseUrl: string, modelId: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(
    `models/${encodeURIComponent(modelId)}:generateContent`,
    normalizedBase
  );
}

function parseToolResult(content: string): Record<string, unknown> {
  try {
    return z.record(z.unknown()).parse(JSON.parse(content));
  } catch {
    return { content };
  }
}

function serializeMessages(
  messages: ModelMessage[],
  thoughtSignatures: ReadonlyMap<string, string>
): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();

  return messages
    .filter(message => message.role !== 'system')
    .map(message => {
      if (message.role === 'system') {
        throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
      }
      if (message.role === 'assistant' && message.toolRequest) {
        toolNames.set(message.toolRequest.requestId, message.toolRequest.toolName);
        const functionCallPart: Record<string, unknown> = {
          functionCall: {
            id: message.toolRequest.requestId,
            name: message.toolRequest.toolName,
            args: message.toolRequest.arguments
          }
        };
        const thoughtSignature = thoughtSignatures.get(message.toolRequest.requestId);
        if (thoughtSignature !== undefined) {
          functionCallPart.thoughtSignature = thoughtSignature;
        }
        return {
          role: 'model',
          parts: [functionCallPart]
        };
      }
      if (message.role === 'tool') {
        const toolName = toolNames.get(message.toolCallId);
        if (!toolName) {
          throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
        }
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: message.toolCallId,
              name: toolName,
              response: parseToolResult(message.content)
            }
          }]
        };
      }
      return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      };
    });
}

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  };
}

function streamGenerateContentUrl(baseUrl: string, modelId: string): URL {
  const url = generateContentUrl(baseUrl, modelId);
  url.pathname = url.pathname.replace(/:generateContent$/u, ':streamGenerateContent');
  url.searchParams.set('alt', 'sse');
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transformGeminiSchemaNode(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  const transformed: Record<string, unknown> = {};
  if (typeof schema.$id === 'string') transformed.$id = schema.$id;
  if (typeof schema.$anchor === 'string') transformed.$anchor = schema.$anchor;
  if (isRecord(schema.$defs)) {
    transformed.$defs = Object.fromEntries(
      Object.entries(schema.$defs).map(([name, definition]) => [
        name,
        transformGeminiSchemaNode(definition)
      ])
    );
  }
  // 引用节点保留 Gemini 支持的标识，但不携带当前转换器已排除的约束字段。
  if (typeof schema.$ref === 'string') {
    transformed.$ref = schema.$ref;
    return transformed;
  }
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union !== undefined) transformed.anyOf = union.map(transformGeminiSchemaNode);

  const stringConst = typeof schema.const === 'string' ? schema.const : undefined;
  const inferredType = stringConst !== undefined
    || (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === 'string'))
    ? 'string'
    : undefined;
  const type = typeof schema.type === 'string' ? schema.type : inferredType;
  if (type !== undefined) transformed.type = type;
  if (stringConst !== undefined) transformed.enum = [stringConst];
  else if (Array.isArray(schema.enum)) transformed.enum = [...schema.enum];
  if (typeof schema.title === 'string') transformed.title = schema.title;
  if (typeof schema.description === 'string') transformed.description = schema.description;

  if (type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    transformed.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        transformGeminiSchemaNode(child)
      ])
    );
    transformed.additionalProperties = false;
    if (Array.isArray(schema.required)) transformed.required = [...schema.required];
  } else if (type === 'array') {
    if ('items' in schema) transformed.items = transformGeminiSchemaNode(schema.items);
    if (Array.isArray(schema.prefixItems)) {
      transformed.prefixItems = schema.prefixItems.map(transformGeminiSchemaNode);
    }
    if (typeof schema.minItems === 'number') transformed.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') transformed.maxItems = schema.maxItems;
  } else if (type === 'string') {
    if (typeof schema.format === 'string') transformed.format = schema.format;
  } else if (type === 'number' || type === 'integer') {
    if (typeof schema.minimum === 'number') transformed.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') transformed.maximum = schema.maximum;
  }
  return transformed;
}

/** 仅生成 Gemini legacy 结构化输出支持的 Schema 子集；本地仍校验原始契约。 */
export function toGeminiResponseJsonSchema(
  schema: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return transformGeminiSchemaNode(schema) as Record<string, unknown>;
}

interface NormalizedGeminiResponse {
  response: ModelResponse;
  thoughtSignature?: {
    requestId: string;
    value: string;
  };
}

function normalizeResponse(
  raw: unknown,
  createFallbackRequestId: (toolName: string) => string,
  responseContract: ModelRequest['responseContract']
): NormalizedGeminiResponse {
  const parsed = geminiResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const parts = parsed.data.candidates[0]?.content.parts;
  if (!parts) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const textParts = parts.filter(part => 'text' in part);
  const functionParts = parts.filter(part => 'functionCall' in part);

  if (textParts.length === parts.length) {
    const text = textParts.map(part => part.text).join('');
    return {
      response: responseContract === undefined
        ? { type: 'text', text }
        : normalizeResponseContractText(text, responseContract)
    };
  }
  if (functionParts.length === 1 && parts.length === 1) {
    const functionPart = functionParts[0];
    const call = functionPart?.functionCall;
    if (!call) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    const requestId = call.id ?? createFallbackRequestId(call.name);
    const response: ModelResponse = {
      type: 'tool_request',
      request: {
        requestId,
        toolName: call.name,
        arguments: call.args
      }
    };
    if (functionPart.thoughtSignature === undefined) return { response };
    return {
      response,
      thoughtSignature: {
        requestId,
        value: functionPart.thoughtSignature
      }
    };
  }
  throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
}

export class GeminiProvider implements ModelProvider {
  private readonly thoughtSignatures = new Map<string, string>();
  private nextFallbackRequestId = 1;

  constructor(
    private readonly config: ProviderAdapterConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    assertResponseContractRequest(request);
    const structuredStream = shouldStreamStructuredText(request);
    const systemParts = request.messages
      .filter(message => message.role === 'system')
      .map(message => ({ text: message.content }));
    const body: Record<string, unknown> = {
      ...this.config.additionalParameters,
      contents: serializeMessages(request.messages, this.thoughtSignatures),
      // 普通聊天保持协议层工具数组也为空，避免空声明包装被服务端解释为工具能力。
      tools: request.tools.length === 0
        ? []
        : [{ functionDeclarations: request.tools.map(serializeTool) }]
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }
    if (request.responseContract !== undefined) {
      body.generationConfig = {
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiResponseJsonSchema(request.responseContract.jsonSchema)
      };
    }

    let response: Response;
    try {
      response = await this.fetchClient(
        structuredStream
          ? streamGenerateContentUrl(this.config.baseUrl, this.config.modelId)
          : generateContentUrl(this.config.baseUrl, this.config.modelId),
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': await this.getSecret()
          },
          body: JSON.stringify(body)
        }
      );
    } catch (error) {
      normalizeFetchError(error, signal);
    }

    const raw = structuredStream
      ? await readGeminiStructuredSse(response, request, signal)
      : await readProviderJson(response);
    const normalized = normalizeResponse(
      raw,
      toolName => `gemini-call-${toolName}-${this.nextFallbackRequestId++}`,
      request.responseContract
    );
    if (normalized.thoughtSignature) {
      this.thoughtSignatures.set(
        normalized.thoughtSignature.requestId,
        normalized.thoughtSignature.value
      );
    }
    return normalized.response;
  }
}

async function readGeminiStructuredSse(
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
      let raw: unknown;
      try { raw = JSON.parse(data); } catch { throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false); }
      if (typeof raw !== 'object' || raw === null) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      const candidates = Reflect.get(raw, 'candidates');
      const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
      if (typeof candidate !== 'object' || candidate === null) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      const content = Reflect.get(candidate, 'content');
      const parts = typeof content === 'object' && content !== null ? Reflect.get(content, 'parts') : undefined;
      if (!Array.isArray(parts)) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      let fragment = '';
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        // Gemini 的 Part 可以携带思考、函数等非可见数据；普通聊天流只累积非 thought 的显式正文。
        if (Reflect.get(part, 'thought') === true) continue;
        const text = Reflect.get(part, 'text');
        if (typeof text === 'string') fragment += text;
      }
      return {
        fragment,
        ...(typeof Reflect.get(candidate, 'finishReason') === 'string' ? { done: true } : {})
      };
    },
    toRaw: content => ({ candidates: [{ content: { parts: [{ text: content }] } }] })
  });
}
