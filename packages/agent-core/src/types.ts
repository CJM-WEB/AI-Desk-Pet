import type { ToolName, ToolRequest } from '@myself/shared-types';

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolRequest?: ToolRequest }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolDefinition[];
}

export type ModelResponse =
  | { type: 'text'; text: string }
  | { type: 'tool_request'; request: unknown };

export interface ModelProvider {
  respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ToolExecutor {
  executeRead(request: ToolRequest): Promise<unknown>;
}

export interface RunContext {
  messages: ModelMessage[];
  provider: ModelProvider;
  tools: ToolDefinition[];
  writeTools: ReadonlySet<ToolName>;
  executor: ToolExecutor;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'phase'; phase: 'thinking' | 'acting' | 'awaiting_confirmation' | 'success' | 'cancelled' }
  | { type: 'message'; text: string }
  | { type: 'write_request'; request: ToolRequest; continuationToken: string };
