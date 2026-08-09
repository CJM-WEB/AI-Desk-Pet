import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolDefinition
} from '@myself/agent-core';
import { z } from 'zod';
import {
  type FetchLike,
  type ProviderAdapterConfig,
  ProviderError,
  normalizeFetchError,
  readProviderJson
} from './openai-provider';

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

interface NormalizedGeminiResponse {
  response: ModelResponse;
  thoughtSignature?: {
    requestId: string;
    value: string;
  };
}

function normalizeResponse(
  raw: unknown,
  createFallbackRequestId: (toolName: string) => string
): NormalizedGeminiResponse {
  const parsed = geminiResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const parts = parsed.data.candidates[0]?.content.parts;
  if (!parts) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const textParts = parts.filter(part => 'text' in part);
  const functionParts = parts.filter(part => 'functionCall' in part);

  if (textParts.length === parts.length) {
    return {
      response: {
        type: 'text',
        text: textParts.map(part => part.text).join('')
      }
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

    let response: Response;
    try {
      response = await this.fetchClient(
        generateContentUrl(this.config.baseUrl, this.config.modelId),
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

    const normalized = normalizeResponse(
      await readProviderJson(response),
      toolName => `gemini-call-${toolName}-${this.nextFallbackRequestId++}`
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
