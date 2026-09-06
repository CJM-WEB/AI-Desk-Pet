import type {
  CharacterEmotionLabel,
  ToolName,
  ToolRequest
} from '@myself/shared-types';
import type { CharacterAgentBehaviorIntent } from '@myself/character-runtime';
import type { ProviderProfileV2 } from '@myself/shared-types';
import type { ModelResponseContract } from './response-contract';

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

/** Provider 历史需要保留已被本地拒绝的原始工具调用，因此不能收窄为已通过本地执行边界的 ToolRequest。 */
export type ModelToolRequest = Readonly<{
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}>;

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolRequest?: ModelToolRequest }
  | { role: 'tool'; content: string; toolCallId: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoicePolicy = 'auto' | 'required' | 'none';
export type ReasoningMode = 'provider_default' | 'disabled';

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  toolChoice: ToolChoicePolicy;
  reasoningMode: ReasoningMode;
  responseContract?: ModelResponseContract;
  /** 仅投影已经完整解码的可见正文；最终事实仍以 respond 的完整返回值为准。 */
  onTextDelta?: (delta: string) => void;
}

export type ModelResponse =
  | {
      type: 'text';
      text: string;
      emotion?: CharacterEmotionLabel;
      behaviorIntent?: CharacterAgentBehaviorIntent;
      structured_output?: Record<string, unknown>;
    }
  | { type: 'structured'; structured_output: Record<string, unknown> }
  | { type: 'tool_request'; request: unknown };

export type FilePlanningOperation =
  | 'list_files'
  | 'read_file'
  | 'glob_files'
  | 'grep_files'
  | 'create_file'
  | 'create_directory'
  | 'apply_patch'
  | 'edit_file'
  | 'delete_file'
  | 'move_file';

/** 文件规划提示只辅助缺参和受限文件名读取，不能授权、收窄工具面或声明本地执行结果。 */
export type FilePlanningHint = Readonly<{
  operation: FilePlanningOperation;
  missingField?: 'target_path';
  targetNameQuery?: string;
}>;

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
