import type {
  CharacterEmotionLabel,
  ToolName,
  ToolRequest
} from '@myself/shared-types';
import type { ProviderProfileV2 } from '@myself/shared-types';

export type ModelRequestKind = 'chat' | 'agent' | 'vision';

export interface RouteDisclosure {
  allowedCrossProviderProfileIds: ReadonlySet<string>;
}

export interface ModelDisclosureTarget {
  profileId: string;
  providerIdentity: string;
}

export interface ModelSelection {
  profile: ProviderProfileV2;
  disclosureTarget: ModelDisclosureTarget;
  fallbackProfiles: ProviderProfileV2[];
}

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
  | { type: 'text'; text: string; emotion?: CharacterEmotionLabel }
  | { type: 'tool_request'; request: unknown };

export interface ModelProvider {
  respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export type ToolRisk = 'read' | 'recoverable' | 'high';
export type ToolDecision = 'allow' | 'confirm' | 'deny';

export interface PreparedToolRequest {
  request: ToolRequest;
  executionRequest: ToolRequest;
  risk: ToolRisk;
  decision: ToolDecision;
  auditSummary: string;
}

export interface ToolRuntime {
  prepare(raw: unknown): PreparedToolRequest;
  executeRead(request: ToolRequest): Promise<unknown>;
}

export interface RunContext {
  messages: ModelMessage[];
  provider: ModelProvider;
  tools: ToolDefinition[];
  toolRuntime: ToolRuntime;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'phase'; phase: 'thinking' | 'acting' | 'awaiting_confirmation' | 'success' | 'cancelled' }
  | { type: 'message'; text: string }
  | { type: 'emotion'; label: CharacterEmotionLabel }
  | {
      type: 'write_request';
      request: ToolRequest;
      executionRequest: ToolRequest;
      risk: ToolRisk;
      auditSummary: string;
      continuationToken: string;
    };
