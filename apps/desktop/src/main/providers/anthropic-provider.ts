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
  normalizeResponseContractText,
  readProviderJson
} from './openai-provider';
import { ProviderResponseError } from './provider-response-error';

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown()
  })
]);

const anthropicResponseSchema = z.object({
  content: z.array(anthropicContentBlockSchema).min(1)
});

function messagesUrl(baseUrl: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('messages', normalizedBase);
}

function serializeMessage(message: ModelMessage): {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
} {
  if (message.role === 'system') {
    throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
  }
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content
      }]
    };
  }
  if (message.role === 'assistant' && message.toolRequest) {
    return {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: message.toolRequest.requestId,
        name: message.toolRequest.toolName,
        input: message.toolRequest.arguments
      }]
    };
  }
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: message.content }]
  };
}

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  };
}

const anthropicStringFormats = new Set([
  'date-time', 'time', 'date', 'duration', 'email',
  'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transformAnthropicSchemaNode(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  const transformed: Record<string, unknown> = {};
  if (isRecord(schema.$defs)) {
    transformed.$defs = Object.fromEntries(
      Object.entries(schema.$defs).map(([name, definition]) => [
        name,
        transformAnthropicSchemaNode(definition)
      ])
    );
  }
  // Anthropic 的引用节点只保留引用及已递归转换的定义，避免透传不支持的兄弟约束。
  if (typeof schema.$ref === 'string') {
    transformed.$ref = schema.$ref;
    return transformed;
  }
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union !== undefined) {
    transformed.anyOf = union.map(transformAnthropicSchemaNode);
  } else if (Array.isArray(schema.allOf)) {
    transformed.allOf = schema.allOf.map(transformAnthropicSchemaNode);
  }

  const inferredType = typeof schema.const === 'string'
    || (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === 'string'))
    ? 'string'
    : undefined;
  const type = typeof schema.type === 'string' ? schema.type : inferredType;
  if (type !== undefined) transformed.type = type;
  if (Array.isArray(schema.enum)) transformed.enum = [...schema.enum];
  if ('const' in schema) transformed.const = schema.const;
  if (typeof schema.title === 'string') transformed.title = schema.title;
  if (typeof schema.description === 'string') transformed.description = schema.description;

  if (type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    transformed.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        transformAnthropicSchemaNode(child)
      ])
    );
    transformed.additionalProperties = false;
    if (Array.isArray(schema.required)) transformed.required = [...schema.required];
  } else if (type === 'array') {
    if ('items' in schema) transformed.items = transformAnthropicSchemaNode(schema.items);
    if (schema.minItems === 0 || schema.minItems === 1) {
      transformed.minItems = schema.minItems;
    }
  } else if (
    type === 'string'
    && typeof schema.format === 'string'
    && anthropicStringFormats.has(schema.format)
  ) {
    transformed.format = schema.format;
  }
  return transformed;
}

/** 仅生成 Anthropic 结构化输出支持的 Schema 子集；原始 Schema 留给本地严格校验。 */
export function toAnthropicResponseJsonSchema(
  schema: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return transformAnthropicSchemaNode(schema) as Record<string, unknown>;
}

function normalizeResponse(
  raw: unknown,
  responseContract: ModelRequest['responseContract'], purpose?: ModelRequest['purpose']
): ModelResponse {
  const parsed = anthropicResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');

  const blocks = parsed.data.content;
  const textBlocks = blocks.filter(block => block.type === 'text');
  const toolBlocks = blocks.filter(block => block.type === 'tool_use');

  if (textBlocks.length === blocks.length) {
    const text = textBlocks.map(block => block.text).join('');
    return responseContract === undefined
      ? { type: 'text', text }
      : normalizeResponseContractText(text, responseContract);
  }
  if (toolBlocks.length === 1 && (blocks.length === 1 || purpose === 'conversation' && textBlocks.length + toolBlocks.length === blocks.length)) {
    const tool = toolBlocks[0];
    if (!tool) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
    const input = z.record(z.unknown()).safeParse(tool.input);
    if (!input.success) throw new ProviderResponseError('TOOL_ARGUMENTS_INVALID', 'tool_call');
    return {
      type: 'tool_request',
      request: {
        requestId: tool.id,
        toolName: tool.name,
        arguments: input.data
      }
    };
  }
  throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
}

export class AnthropicProvider implements ModelProvider {
  constructor(
    private readonly config: ProviderAdapterConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    assertResponseContractRequest(request);
    const systemMessages = request.messages
      .filter(message => message.role === 'system')
      .map(message => message.content);
    const messages = request.messages
      .filter(message => message.role !== 'system')
      .map(serializeMessage);
    const body: Record<string, unknown> = {
      ...this.config.additionalParameters,
      model: this.config.modelId,
      max_tokens: 4096,
      messages,
      tools: request.tools.map(serializeTool)
    };
    if (systemMessages.length > 0) body.system = systemMessages.join('\n\n');
    if (request.responseContract !== undefined) {
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: toAnthropicResponseJsonSchema(request.responseContract.jsonSchema)
        }
      };
    }

    let response: Response;
    try {
      response = await this.fetchClient(messagesUrl(this.config.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': await this.getSecret(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      normalizeFetchError(error, signal);
    }

    const raw = await readProviderJson(response);
    return normalizeResponse(raw, request.responseContract, request.purpose);
  }
}
