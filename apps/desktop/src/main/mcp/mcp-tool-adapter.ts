import { createHash } from 'node:crypto';
import type { ToolRisk } from '@myself/agent-core';
import { toolNameSchema } from '@myself/shared-types';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { z } from 'zod';
import type { ToolRegistration } from '../agent/tool-registry';

interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object> | undefined;
    required?: string[] | undefined;
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    [key: string]: unknown;
  } | undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 本地授权绑定完整工具定义；远端声明只能改变指纹并使授权失效，不能自行获得授权。
 */
export function mcpToolDefinitionFingerprint(tool: McpToolDescriptor): string {
  return createHash('sha256').update(canonicalJson(tool)).digest('hex');
}

export interface AdaptMcpToolOptions {
  serverId: string;
  serverEnabled: boolean;
  toolEnabled: boolean;
  tool: McpToolDescriptor;
  localRisk?: ToolRisk;
}

function adapterError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function normalizeMcpNameSegment(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/_{2,}/g, '_');
  return normalized || 'unnamed';
}

export function mcpPublicToolName(serverId: string, toolName: string): string {
  return `mcp.${normalizeMcpNameSegment(serverId)}.${normalizeMcpNameSegment(toolName)}`;
}

export function mcpExecutionToolName(serverId: string, toolName: string): string {
  const encodedServerId = Buffer.from(serverId, 'utf8').toString('base64url');
  const encodedToolName = Buffer.from(toolName, 'utf8').toString('base64url');
  return `mcp-internal.${encodedServerId}.${encodedToolName}`;
}

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_NODES = 2_000;
const MAX_SCHEMA_DEPTH = 32;

interface SchemaTraversalState {
  nodes: number;
}

function hardenJsonSchema(
  value: unknown,
  depth = 0,
  state: SchemaTraversalState = { nodes: 0 }
): unknown {
  state.nodes += 1;
  if (depth > MAX_SCHEMA_DEPTH || state.nodes > MAX_SCHEMA_NODES) {
    throw adapterError('MCP_INPUT_SCHEMA_LIMIT');
  }
  if (Array.isArray(value)) {
    return value.map(item => hardenJsonSchema(item, depth + 1, state));
  }
  if (!value || typeof value !== 'object') return value;

  const hardened: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'pattern' || key === 'patternProperties') {
      throw adapterError('MCP_INPUT_SCHEMA_UNSUPPORTED');
    }
    if (
      key === '$ref'
      && (typeof item !== 'string' || !item.startsWith('#'))
    ) {
      throw adapterError('MCP_INPUT_SCHEMA_EXTERNAL_REF');
    }
    hardened[key] = hardenJsonSchema(item, depth + 1, state);
  }
  if (hardened['type'] === 'object' && hardened['additionalProperties'] === undefined) {
    hardened['additionalProperties'] = false;
  }
  return hardened;
}

function createArgumentsSchema(
  inputSchema: McpToolDescriptor['inputSchema']
): {
  hardenedSchema: McpToolDescriptor['inputSchema'];
  zodSchema: z.ZodType<Record<string, unknown>>;
} {
  let serializedSchema: string;
  try {
    serializedSchema = JSON.stringify(inputSchema);
  } catch {
    throw adapterError('MCP_INPUT_SCHEMA_UNSUPPORTED');
  }
  if (Buffer.byteLength(serializedSchema, 'utf8') > MAX_SCHEMA_BYTES) {
    throw adapterError('MCP_INPUT_SCHEMA_LIMIT');
  }

  const hardenedSchema = hardenJsonSchema(inputSchema);
  if (!hardenedSchema || typeof hardenedSchema !== 'object' || Array.isArray(hardenedSchema)) {
    throw adapterError('MCP_INPUT_SCHEMA_UNSUPPORTED');
  }

  try {
    const schemaValidator = new AjvJsonSchemaValidator();
    const validate = schemaValidator.getValidator<Record<string, unknown>>(
      hardenedSchema as JsonSchemaType
    );
    return {
      hardenedSchema: hardenedSchema as McpToolDescriptor['inputSchema'],
      zodSchema: z.custom<Record<string, unknown>>(
        value => validate(value).valid,
        { message: 'MCP_TOOL_ARGUMENTS_INVALID' }
      )
    };
  } catch {
    throw adapterError('MCP_INPUT_SCHEMA_UNSUPPORTED');
  }
}

function riskRank(risk: ToolRisk): number {
  return { read: 0, recoverable: 1, high: 2 }[risk];
}

function maximumRisk(first: ToolRisk, second: ToolRisk): ToolRisk {
  return riskRank(first) >= riskRank(second) ? first : second;
}

function remoteRisk(tool: McpToolDescriptor): ToolRisk {
  if (tool.annotations?.destructiveHint === true) return 'high';
  if (tool.annotations?.readOnlyHint === true) return 'read';
  return 'recoverable';
}

export function adaptMcpTool(options: AdaptMcpToolOptions): ToolRegistration {
  const publicName = mcpPublicToolName(options.serverId, options.tool.name);
  if (!toolNameSchema.safeParse(publicName).success) {
    throw adapterError('MCP_TOOL_NAME_INVALID');
  }
  const argumentsSchema = createArgumentsSchema(options.tool.inputSchema);

  return {
    definition: {
      type: 'function',
      function: {
        name: publicName,
        description: options.tool.description ?? 'MCP 工具',
        parameters: argumentsSchema.hardenedSchema
      }
    },
    argumentsSchema: argumentsSchema.zodSchema,
    executionToolName: mcpExecutionToolName(options.serverId, options.tool.name),
    risk: maximumRisk(options.localRisk ?? 'recoverable', remoteRisk(options.tool)),
    enabled: options.serverEnabled && options.toolEnabled,
    auditSummary: () => `调用 MCP 工具 ${publicName}`
  };
}

export function enforceMcpOutputLimit<T>(value: T, limitBytes: number): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw adapterError('MCP_OUTPUT_INVALID');
  }
  if (serialized === undefined) throw adapterError('MCP_OUTPUT_INVALID');
  if (Buffer.byteLength(serialized, 'utf8') > limitBytes) {
    throw adapterError('MCP_OUTPUT_LIMIT_EXCEEDED');
  }
  return value;
}
