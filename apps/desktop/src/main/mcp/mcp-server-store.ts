import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export interface McpCapabilityState {
  enabled: boolean;
}

export interface McpCapabilityCollectionState extends McpCapabilityState {
  items?: Record<string, McpCapabilityState>;
}

export type McpToolState = McpCapabilityState;

export interface McpServerCapabilitiesConfig {
  tools: Record<string, McpToolState>;
  resources: McpCapabilityCollectionState;
  prompts: McpCapabilityCollectionState;
}

export interface McpStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: string[];
}

export interface McpHttpTransportConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: McpStdioTransportConfig | McpHttpTransportConfig;
  capabilities: McpServerCapabilitiesConfig;
}

export interface McpStdioLaunchSummary {
  command: string;
  args: string[];
  cwd: string;
  explicitEnvNames: string[];
  inheritedEnvNames: string[];
  fingerprint: string;
}

const capabilityStateSchema = z.object({
  enabled: z.boolean()
}).strict();

const capabilityCollectionSchema = z.object({
  enabled: z.boolean(),
  items: z.record(z.string(), capabilityStateSchema).optional()
}).strict();

const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.array(z.string().min(1)).optional()
}).strict();

const httpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional()
}).strict();

const serverConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  transport: z.discriminatedUnion('type', [
    stdioTransportSchema,
    httpTransportSchema
  ]),
  capabilities: z.object({
    tools: z.record(z.string(), capabilityStateSchema),
    resources: capabilityCollectionSchema,
    prompts: capabilityCollectionSchema
  }).strict()
}).strict();

function storeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function canonicalizeStdioTransport(
  transport: McpStdioTransportConfig
): McpStdioTransportConfig {
  if (!isAbsolute(transport.command)) throw storeError('MCP_CONFIG_INVALID');

  let command: string;
  let cwd: string;
  try {
    command = realpathSync.native(transport.command);
    const configuredCwd = transport.cwd ?? process.cwd();
    if (!isAbsolute(configuredCwd)) throw storeError('MCP_CONFIG_INVALID');
    cwd = realpathSync.native(configuredCwd);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MCP_CONFIG_INVALID') {
      throw error;
    }
    throw storeError('MCP_CONFIG_INVALID');
  }

  return {
    ...transport,
    command,
    cwd,
    ...(transport.inheritEnv
      ? { inheritEnv: [...new Set(transport.inheritEnv)].sort() }
      : {})
  };
}

function launchFingerprint(transport: McpStdioTransportConfig): string {
  const env = Object.fromEntries(
    Object.entries(transport.env ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash('sha256').update(JSON.stringify({
    command: transport.command,
    args: transport.args ?? [],
    cwd: transport.cwd ?? null,
    env,
    inheritEnv: transport.inheritEnv ?? []
  })).digest('hex');
}

export class McpServerStore {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly confirmedLaunches = new Map<string, string>();

  constructor(initial: McpServerConfig[] = []) {
    for (const config of initial) this.upsert(config);
  }

  upsert(config: McpServerConfig): void {
    const result = serverConfigSchema.safeParse(config);
    if (!result.success) throw storeError('MCP_CONFIG_INVALID');

    const parsed = result.data as McpServerConfig;
    const normalized = parsed.transport.type === 'stdio'
      ? {
          ...parsed,
          transport: canonicalizeStdioTransport(parsed.transport)
        }
      : parsed;
    this.servers.set(normalized.id, structuredClone(normalized));
  }

  get(serverId: string): McpServerConfig | undefined {
    const config = this.servers.get(serverId);
    if (!config) return undefined;
    const current = structuredClone(config);
    if (current.transport.type === 'stdio') {
      current.transport = canonicalizeStdioTransport(current.transport);
    }
    return current;
  }

  list(): McpServerConfig[] {
    return [...this.servers.values()].map(config => structuredClone(config));
  }

  getStdioLaunchSummary(serverId: string): McpStdioLaunchSummary {
    const config = this.requireServer(serverId);
    if (config.transport.type !== 'stdio') throw storeError('MCP_STDIO_REQUIRED');
    const transport = canonicalizeStdioTransport(config.transport);
    return {
      command: transport.command,
      args: [...(transport.args ?? [])],
      cwd: transport.cwd!,
      explicitEnvNames: Object.keys(transport.env ?? {}).sort(),
      inheritedEnvNames: [...(transport.inheritEnv ?? [])],
      fingerprint: launchFingerprint(transport)
    };
  }

  confirmStdioLaunch(serverId: string, fingerprint: string): void {
    const current = this.getStdioLaunchSummary(serverId);
    if (current.fingerprint !== fingerprint) {
      throw storeError('MCP_STDIO_CONFIRMATION_MISMATCH');
    }
    this.confirmedLaunches.set(serverId, fingerprint);
  }

  assertStdioLaunchConfirmed(serverId: string): void {
    const confirmed = this.confirmedLaunches.get(serverId);
    if (!confirmed) throw storeError('MCP_STDIO_LAUNCH_UNCONFIRMED');
    if (confirmed !== this.getStdioLaunchSummary(serverId).fingerprint) {
      throw storeError('MCP_STDIO_LAUNCH_CHANGED');
    }
  }

  setServerEnabled(serverId: string, enabled: boolean): void {
    const config = this.requireServer(serverId);
    config.enabled = enabled;
  }

  setToolEnabled(serverId: string, toolName: string, enabled: boolean): void {
    const config = this.requireServer(serverId);
    const tool = config.capabilities.tools[toolName];
    if (!tool) throw storeError('MCP_TOOL_NOT_FOUND');
    tool.enabled = enabled;
  }

  isToolEnabled(serverId: string, toolName: string): boolean {
    const config = this.servers.get(serverId);
    return config?.enabled === true
      && config.capabilities.tools[toolName]?.enabled === true;
  }

  setResourceEnabled(serverId: string, resourceName: string, enabled: boolean): void {
    this.setCapabilityItemEnabled(
      serverId,
      'resources',
      resourceName,
      enabled,
      'MCP_RESOURCE_NOT_FOUND'
    );
  }

  setPromptEnabled(serverId: string, promptName: string, enabled: boolean): void {
    this.setCapabilityItemEnabled(
      serverId,
      'prompts',
      promptName,
      enabled,
      'MCP_PROMPT_NOT_FOUND'
    );
  }

  isResourceEnabled(serverId: string, resourceName: string): boolean {
    return this.isCapabilityItemEnabled(serverId, 'resources', resourceName);
  }

  isPromptEnabled(serverId: string, promptName: string): boolean {
    return this.isCapabilityItemEnabled(serverId, 'prompts', promptName);
  }

  private requireServer(serverId: string): McpServerConfig {
    const config = this.servers.get(serverId);
    if (!config) throw storeError('MCP_SERVER_NOT_FOUND');
    return config;
  }

  private setCapabilityItemEnabled(
    serverId: string,
    capability: 'resources' | 'prompts',
    itemName: string,
    enabled: boolean,
    missingCode: string
  ): void {
    const collection = this.requireServer(serverId).capabilities[capability];
    const item = collection.items?.[itemName];
    if (!item) throw storeError(missingCode);
    item.enabled = enabled;
  }

  private isCapabilityItemEnabled(
    serverId: string,
    capability: 'resources' | 'prompts',
    itemName: string
  ): boolean {
    const config = this.servers.get(serverId);
    const collection = config?.capabilities[capability];
    return config?.enabled === true
      && collection?.enabled === true
      && collection.items?.[itemName]?.enabled === true;
  }
}
