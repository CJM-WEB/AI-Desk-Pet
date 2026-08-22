import type { ModelProvider, ToolRisk } from '@myself/agent-core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  providerCatalog,
  type ModelRouteConfig,
  type ProviderProfileV2
} from '@myself/shared-types';
import type {
  McpServerDto,
  McpServerInput,
  PrivacySettingsDto,
  SaveProviderProfileInput,
  SettingsDashboardDto
} from '../../shared/myself-api';
import { desktopRuntimeCapabilities } from '../../shared/desktop-runtime-capabilities';
import type { PrivacySessionRegistry } from '../agent/disclosure-policy';
import type { ToolRegistration } from '../agent/tool-registry';
import type { McpServerSnapshot } from '../mcp/mcp-manager';
import { assertMcpHttpUrl } from '../mcp/mcp-manager';
import { mcpToolDefinitionFingerprint } from '../mcp/mcp-tool-adapter';
import type {
  McpServerConfig,
  McpServerStore
} from '../mcp/mcp-server-store';
import type {
  McpServerSettings,
  PrivacySettings
} from '../storage/settings-store';
import type { SecretSnapshot } from '../storage/secret-store';

export type TrustedMcpFingerprintLookup = (
  serverId: string,
  toolName: string
) => string | undefined;

export function createTrustedMcpRiskResolver(
  trustedFingerprint: TrustedMcpFingerprintLookup
): (serverId: string, tool: Tool) => ToolRisk {
  return (serverId, tool) => (
    trustedFingerprint(serverId, tool.name) === mcpToolDefinitionFingerprint(tool)
      ? 'read'
      : 'recoverable'
  );
}

interface SettingsAccess {
  getProviderSettings(): Promise<{
    profiles: ProviderProfileV2[];
    route: ModelRouteConfig;
  }>;
  saveProviderProfile(profile: ProviderProfileV2): Promise<void>;
  deleteProviderProfile(profileId: string): Promise<void>;
  saveModelRoute(route: ModelRouteConfig): Promise<void>;
  getPrivacySettings(): Promise<PrivacySettings>;
  savePrivacySettings(settings: PrivacySettings): Promise<void>;
  getPetAlwaysOnTop(): Promise<boolean>;
  savePetAlwaysOnTop(enabled: boolean): Promise<void>;
  getPublic(): Promise<{
    authorizedRoot: SettingsDashboardDto['authorizedRoot'];
  }>;
  revokeAuthorizedRoot(): Promise<void>;
  getMcpServerSettings(): Promise<McpServerSettings[]>;
  saveMcpServerSettings(settings: McpServerSettings): Promise<void>;
  deleteMcpServerSettings(serverId: string): Promise<void>;
}

interface SecretAccess {
  save(profileId: string, secret: string, persist: boolean): Promise<void>;
  readForProviderCall(profileId?: string): Promise<string>;
  clear(profileId?: string): Promise<void>;
  snapshot(profileId: string): Promise<SecretSnapshot>;
  restore(profileId: string, snapshot: SecretSnapshot): Promise<void>;
}

interface ProviderAccess {
  create(
    profile: ProviderProfileV2,
    getSecret: () => Promise<string>
  ): ModelProvider;
}

interface McpManagerAccess {
  connect(serverId: string): Promise<McpServerSnapshot>;
  disconnect(serverId: string): Promise<void>;
  close(): Promise<void>;
  toolRegistrations(serverId: string): ToolRegistration[];
  executeTool(
    executionToolName: string,
    arguments_: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export interface DesktopSettingsServiceOptions {
  settings: SettingsAccess;
  secrets: SecretAccess;
  providers: ProviderAccess;
  mcpStore: McpServerStore;
  mcpManager: McpManagerAccess;
  privacySessions: PrivacySessionRegistry;
  sessionId: string;
  applyPetAlwaysOnTop(enabled: boolean): Promise<void> | void;
}

interface DiscoveredTool {
  name: string;
  description: string;
  readOnly: boolean;
  definitionFingerprint: string;
}

function publicMcpServer(
  config: McpServerConfig,
  status: McpServerDto['status'],
  tools: readonly DiscoveredTool[]
): McpServerDto {
  const transport = config.transport.type === 'stdio'
    ? {
        type: 'stdio' as const,
        summary: [config.transport.command, ...(config.transport.args ?? [])].join(' '),
        secretNames: Object.keys(config.transport.env ?? {}).sort()
      }
    : {
        type: 'http' as const,
        summary: config.transport.url,
        secretNames: Object.keys(config.transport.headers ?? {}).sort()
      };
  return {
    id: config.id,
    enabled: config.enabled,
    status,
    transport,
    tools: tools.map(tool => ({
      ...tool,
      enabled: config.capabilities.tools[tool.name]?.enabled === true
    }))
  };
}

function initialMcpConfig(input: McpServerInput): McpServerConfig {
  if (input.transport.type === 'http') assertMcpHttpUrl(input.transport.url);
  return {
    id: input.id,
    enabled: input.enabled,
    transport: structuredClone(input.transport),
    capabilities: {
      tools: {},
      resources: { enabled: false },
      prompts: { enabled: false }
    }
  };
}

function secretRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  ));
}

function parseMcpSecrets(raw: string): {
  env: Record<string, string>;
  headers: Record<string, string>;
} {
  try {
    const value = JSON.parse(raw) as { env?: unknown; headers?: unknown };
    return {
      env: secretRecord(value.env),
      headers: secretRecord(value.headers)
    };
  } catch {
    return { env: {}, headers: {} };
  }
}

/** 集中约束已关闭的 MCP 运行时入口。 */
function assertMcpEnabled(): void {
  if (!desktopRuntimeCapabilities.mcp) {
    throw new Error('MCP_MODULE_DISABLED');
  }
}

export class DesktopSettingsService {
  private readonly statuses = new Map<string, McpServerDto['status']>();
  private readonly discoveredTools = new Map<string, DiscoveredTool[]>();
  private petAlwaysOnTopQueue: Promise<void> = Promise.resolve();
  private petAlwaysOnTopFrozen = false;
  private petAlwaysOnTopFlush: Promise<void> | undefined;

  constructor(private readonly options: DesktopSettingsServiceOptions) {}

  async initialize(): Promise<void> {
    if (!desktopRuntimeCapabilities.mcp) return;
    for (const stored of await this.options.settings.getMcpServerSettings()) {
      const secrets: ReturnType<typeof parseMcpSecrets> = await this.options.secrets
        .readForProviderCall(`mcp:${stored.id}`)
        .then(parseMcpSecrets)
        .catch(() => ({ env: {}, headers: {} }));
      const transport = stored.transport.type === 'stdio'
        ? {
            type: 'stdio' as const,
            command: stored.transport.command,
            args: stored.transport.args,
            cwd: stored.transport.cwd,
            env: Object.fromEntries(stored.transport.secretNames.flatMap(name => (
              secrets.env[name] === undefined ? [] : [[name, secrets.env[name]]]
            ))),
            inheritEnv: stored.transport.inheritEnv
          }
        : {
            type: 'http' as const,
            url: stored.transport.url,
            headers: Object.fromEntries(stored.transport.secretNames.flatMap(name => (
              secrets.headers[name] === undefined ? [] : [[name, secrets.headers[name]]]
            )))
          };
      this.options.mcpStore.upsert({
        id: stored.id,
        enabled: stored.enabled,
        transport,
        capabilities: {
          tools: Object.fromEntries(Object.entries(stored.tools).map(([name, tool]) => [
            name,
            {
              enabled: tool.enabled,
              ...(tool.trustedReadFingerprint
                ? { trustedReadFingerprint: tool.trustedReadFingerprint }
                : {})
            }
          ])),
          resources: { enabled: false },
          prompts: { enabled: false }
        }
      });
      this.discoveredTools.set(stored.id, Object.entries(stored.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        readOnly: tool.trustedReadFingerprint !== undefined
          && tool.trustedReadFingerprint === tool.definitionFingerprint,
        definitionFingerprint: tool.definitionFingerprint ?? ''
      })));
      this.statuses.set(stored.id, 'disconnected');
    }
  }

  async getDashboard(): Promise<SettingsDashboardDto> {
    const [providerSettings, privacy, publicSettings, petAlwaysOnTop] = await Promise.all([
      this.options.settings.getProviderSettings(),
      this.options.settings.getPrivacySettings(),
      this.options.settings.getPublic(),
      this.options.settings.getPetAlwaysOnTop()
    ]);
    return {
      catalog: structuredClone(providerCatalog),
      profiles: providerSettings.profiles,
      route: providerSettings.route,
      mcpServers: desktopRuntimeCapabilities.mcp
        ? this.options.mcpStore.list().map(config => (
          publicMcpServer(
            config,
            this.statuses.get(config.id) ?? 'disconnected',
            this.discoveredTools.get(config.id) ?? []
          )
        ))
        : [],
      privacy,
      privacyRuntimeSupport: {
        dataCategories: {
          file: true,
          screenshot: false,
          clipboard: false,
          memory: false
        },
        longTermMemory: false,
        proactivity: false
      },
      petAlwaysOnTop,
      authorizedRoot: publicSettings.authorizedRoot
    };
  }

  async saveProviderProfile(input: SaveProviderProfileInput): Promise<SettingsDashboardDto> {
    const existing = (await this.options.settings.getProviderSettings()).profiles.find(
      profile => profile.id === input.profile.id
    );
    const profile: ProviderProfileV2 = {
      ...input.profile,
      hasStoredSecret: input.secret !== undefined || existing?.hasStoredSecret === true
    };
    const secretSnapshot = input.secret === undefined
      ? undefined
      : await this.options.secrets.snapshot(profile.id);
    await this.options.settings.saveProviderProfile(profile);
    if (input.secret !== undefined && secretSnapshot) {
      try {
        await this.options.secrets.save(profile.id, input.secret, input.persistSecret);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          if (existing) {
            await this.options.settings.saveProviderProfile(existing);
          } else {
            await this.options.settings.deleteProviderProfile(profile.id);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await this.options.secrets.restore(profile.id, secretSnapshot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'PROVIDER_SAVE_ROLLBACK_FAILED');
        }
        throw error;
      }
    }
    return this.getDashboard();
  }

  async deleteProviderProfile(profileId: string): Promise<SettingsDashboardDto> {
    const providerSettings = await this.options.settings.getProviderSettings();
    const existing = providerSettings.profiles.find(profile => profile.id === profileId);
    const secretSnapshot = await this.options.secrets.snapshot(profileId);
    await this.options.settings.deleteProviderProfile(profileId);
    try {
      await this.options.secrets.clear(profileId);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (existing) {
        try {
          await this.options.settings.saveProviderProfile(existing);
          await this.options.settings.saveModelRoute(providerSettings.route);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await this.options.secrets.restore(profileId, secretSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'PROVIDER_DELETE_ROLLBACK_FAILED');
      }
      throw error;
    }
    return this.getDashboard();
  }

  async saveModelRoute(route: ModelRouteConfig): Promise<SettingsDashboardDto> {
    await this.options.settings.saveModelRoute(route);
    return this.getDashboard();
  }

  async testProviderProfile(
    profileId: string
  ): Promise<{ ok: boolean; message: string }> {
    const profile = (await this.options.settings.getProviderSettings()).profiles.find(
      candidate => candidate.id === profileId
    );
    if (!profile || !profile.hasStoredSecret) {
      return { ok: false, message: '请先保存该档案的 API Key。' };
    }
    try {
      const provider = this.options.providers.create(
        profile,
        () => this.options.secrets.readForProviderCall(profile.id)
      );
      const result = await provider.respond({
        messages: [
          { role: 'system', content: '这是连接测试，只需返回简短文本。' },
          { role: 'user', content: '请回复“连接成功”。' }
        ],
        tools: [],
        toolChoice: 'none',
        reasoningMode: 'provider_default'
      }, AbortSignal.timeout(15_000));
      return result.type === 'text'
        ? { ok: true, message: '连接成功。' }
        : { ok: false, message: '模型服务响应格式不兼容。' };
    } catch {
      return { ok: false, message: '连接失败，请检查档案和网络。' };
    }
  }

  async upsertMcpServer(input: McpServerInput): Promise<
    | { kind: 'saved'; dashboard: SettingsDashboardDto }
    | {
      kind: 'confirmation_required';
      summary: ReturnType<McpServerStore['getStdioLaunchSummary']>;
    }
  > {
    assertMcpEnabled();
    const previousConfig = this.options.mcpStore.get(input.id);
    const previousStatus = this.statuses.get(input.id);
    const previousTools = structuredClone(this.discoveredTools.get(input.id));
    const secretId = `mcp:${input.id}`;
    const secretSnapshot = await this.options.secrets.snapshot(secretId);
    if (previousConfig) {
      await this.options.mcpManager.disconnect(input.id);
    }
    try {
      this.options.mcpStore.upsert(initialMcpConfig(input));
      this.discoveredTools.delete(input.id);
      const secretPayload = input.transport.type === 'stdio'
        ? { env: input.transport.env ?? {} }
        : { headers: input.transport.headers ?? {} };
      const secretValues = Object.values(secretPayload)[0];
      const hasSecrets = secretValues && Object.keys(secretValues).length > 0;
      if (hasSecrets) {
        await this.options.secrets.save(
          secretId,
          JSON.stringify(secretPayload),
          true
        );
      } else {
        await this.options.secrets.clear(secretId);
      }
      await this.persistMcp(input.id);
      this.statuses.set(input.id, 'disconnected');
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        if (previousConfig) {
          this.options.mcpStore.upsert(previousConfig);
        } else {
          this.options.mcpStore.remove(input.id);
        }
        if (previousTools) {
          this.discoveredTools.set(input.id, previousTools);
        } else {
          this.discoveredTools.delete(input.id);
        }
        if (previousConfig) {
          this.statuses.set(input.id, 'disconnected');
        } else if (previousStatus) {
          this.statuses.set(input.id, previousStatus);
        } else {
          this.statuses.delete(input.id);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        await this.options.secrets.restore(secretId, secretSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'MCP_SAVE_ROLLBACK_FAILED');
      }
      throw error;
    }
    if (input.transport.type === 'stdio') {
      return {
        kind: 'confirmation_required',
        summary: this.options.mcpStore.getStdioLaunchSummary(input.id)
      };
    }
    return { kind: 'saved', dashboard: await this.getDashboard() };
  }

  async confirmMcpLaunch(
    serverId: string,
    fingerprint: string
  ): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    this.options.mcpStore.confirmStdioLaunch(serverId, fingerprint);
    return this.getDashboard();
  }

  async testMcpServer(serverId: string): Promise<{ ok: boolean; message: string }> {
    assertMcpEnabled();
    const previousConfig = this.options.mcpStore.get(serverId);
    const previousTools = structuredClone(this.discoveredTools.get(serverId));
    let connected = false;
    try {
      const snapshot = await this.options.mcpManager.connect(serverId);
      connected = true;
      const config = this.options.mcpStore.get(serverId);
      if (!config) throw new Error('MCP_SERVER_NOT_FOUND');
      const tools = snapshot.tools.map(tool => {
        const definitionFingerprint = mcpToolDefinitionFingerprint(tool);
        return {
          name: tool.name,
          description: tool.description ?? 'MCP 工具',
          readOnly: config.capabilities.tools[tool.name]?.trustedReadFingerprint
            === definitionFingerprint,
          definitionFingerprint
        };
      });
      config.capabilities.tools = Object.fromEntries(tools.map(tool => [
        tool.name,
        {
          enabled: tool.readOnly
            && config.capabilities.tools[tool.name]?.enabled === true,
          ...(tool.readOnly
            ? { trustedReadFingerprint: tool.definitionFingerprint }
            : {})
        }
      ]));
      this.options.mcpStore.upsert(config);
      this.discoveredTools.set(serverId, tools);
      this.statuses.set(serverId, 'connected');
      await this.persistMcp(serverId);
      return { ok: true, message: `发现 ${tools.length} 个工具。` };
    } catch {
      if (previousConfig) this.options.mcpStore.upsert(previousConfig);
      if (previousTools) {
        this.discoveredTools.set(serverId, previousTools);
      } else {
        this.discoveredTools.delete(serverId);
      }
      if (connected) {
        try {
          await this.options.mcpManager.disconnect(serverId);
          this.statuses.set(serverId, 'disconnected');
        } catch {
          this.statuses.set(serverId, 'error');
        }
      } else {
        this.statuses.set(serverId, 'error');
      }
      return { ok: false, message: 'MCP 连接失败，请检查配置。' };
    }
  }

  async setMcpServerEnabled(
    serverId: string,
    enabled: boolean
  ): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    const previousConfig = this.options.mcpStore.get(serverId);
    const previousStatus = this.statuses.get(serverId);
    if (!enabled) {
      await this.options.mcpManager.disconnect(serverId);
      this.statuses.set(serverId, 'disconnected');
    }
    try {
      this.options.mcpStore.setServerEnabled(serverId, enabled);
      await this.persistMcp(serverId);
    } catch (error) {
      if (previousConfig) this.options.mcpStore.upsert(previousConfig);
      if (enabled) {
        if (previousStatus) this.statuses.set(serverId, previousStatus);
        else this.statuses.delete(serverId);
      }
      throw error;
    }
    return this.getDashboard();
  }

  async setMcpToolEnabled(
    serverId: string,
    toolName: string,
    enabled: boolean
  ): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    const tool = this.discoveredTools.get(serverId)?.find(item => item.name === toolName);
    if (!tool?.readOnly && enabled) throw new Error('MCP_WRITE_TOOL_DISABLED');
    const previousConfig = this.options.mcpStore.get(serverId);
    await this.options.mcpManager.disconnect(serverId);
    this.statuses.set(serverId, 'disconnected');
    try {
      this.options.mcpStore.setToolEnabled(serverId, toolName, enabled);
      await this.persistMcp(serverId);
    } catch (error) {
      if (previousConfig) this.options.mcpStore.upsert(previousConfig);
      throw error;
    }
    return this.getDashboard();
  }

  async authorizeMcpToolReadOnly(
    serverId: string,
    toolName: string
  ): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    const tool = this.discoveredTools.get(serverId)?.find(item => item.name === toolName);
    if (!tool || !tool.definitionFingerprint) throw new Error('MCP_TOOL_NOT_DISCOVERED');
    const previousConfig = this.options.mcpStore.get(serverId);
    if (!previousConfig?.capabilities.tools[toolName]) {
      throw new Error('MCP_TOOL_NOT_DISCOVERED');
    }
    await this.options.mcpManager.disconnect(serverId);
    this.statuses.set(serverId, 'disconnected');
    try {
      const config = structuredClone(previousConfig);
      config.capabilities.tools[toolName] = {
        enabled: true,
        trustedReadFingerprint: tool.definitionFingerprint
      };
      this.options.mcpStore.upsert(config);
      tool.readOnly = true;
      await this.persistMcp(serverId);
    } catch (error) {
      this.options.mcpStore.upsert(previousConfig);
      tool.readOnly = previousConfig.capabilities.tools[toolName]
        ?.trustedReadFingerprint === tool.definitionFingerprint;
      throw error;
    }
    return this.getDashboard();
  }

  async revokeMcpToolReadOnly(
    serverId: string,
    toolName: string
  ): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    const tool = this.discoveredTools.get(serverId)?.find(item => item.name === toolName);
    const previousConfig = this.options.mcpStore.get(serverId);
    if (!tool || !previousConfig?.capabilities.tools[toolName]) {
      throw new Error('MCP_TOOL_NOT_DISCOVERED');
    }
    await this.options.mcpManager.disconnect(serverId);
    this.statuses.set(serverId, 'disconnected');
    try {
      const config = structuredClone(previousConfig);
      config.capabilities.tools[toolName] = { enabled: false };
      this.options.mcpStore.upsert(config);
      tool.readOnly = false;
      await this.persistMcp(serverId);
    } catch (error) {
      this.options.mcpStore.upsert(previousConfig);
      tool.readOnly = previousConfig.capabilities.tools[toolName]
        ?.trustedReadFingerprint === tool.definitionFingerprint;
      throw error;
    }
    return this.getDashboard();
  }

  async deleteMcpServer(serverId: string): Promise<SettingsDashboardDto> {
    assertMcpEnabled();
    const config = this.options.mcpStore.get(serverId);
    const secretId = `mcp:${serverId}`;
    const secretSnapshot = await this.options.secrets.snapshot(secretId);
    await this.options.mcpManager.disconnect(serverId);
    this.statuses.set(serverId, 'disconnected');
    try {
      await this.options.settings.deleteMcpServerSettings(serverId);
      await this.options.secrets.clear(secretId);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (config) {
        try {
          await this.persistMcp(serverId);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await this.options.secrets.restore(secretId, secretSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'MCP_DELETE_ROLLBACK_FAILED');
      }
      throw error;
    }
    this.options.mcpStore.remove(serverId);
    this.statuses.delete(serverId);
    this.discoveredTools.delete(serverId);
    return this.getDashboard();
  }

  async savePrivacySettings(input: PrivacySettingsDto): Promise<SettingsDashboardDto> {
    await this.options.settings.savePrivacySettings(input);
    return this.getDashboard();
  }

  /** 先提交运行态再落盘；任一步失败都把窗口层级恢复到旧值。 */
  savePetAlwaysOnTop(enabled: boolean): Promise<SettingsDashboardDto> {
    if (this.petAlwaysOnTopFrozen) {
      return Promise.reject(new Error('PET_ALWAYS_ON_TOP_FROZEN'));
    }
    const transaction = this.petAlwaysOnTopQueue.then(() => (
      this.commitPetAlwaysOnTop(enabled)
    ));
    this.petAlwaysOnTopQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  /** 退出前同步冻结入口，并等待此前已接收的置顶事务全部完成补偿。 */
  freezeAndFlushPetAlwaysOnTop(): Promise<void> {
    this.petAlwaysOnTopFrozen = true;
    this.petAlwaysOnTopFlush ??= this.petAlwaysOnTopQueue;
    return this.petAlwaysOnTopFlush;
  }

  private async commitPetAlwaysOnTop(enabled: boolean): Promise<SettingsDashboardDto> {
    const previous = await this.options.settings.getPetAlwaysOnTop();
    try {
      await this.options.applyPetAlwaysOnTop(enabled);
    } catch (error) {
      try {
        await this.options.applyPetAlwaysOnTop(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'PET_ALWAYS_ON_TOP_APPLY_ROLLBACK_FAILED'
        );
      }
      throw error;
    }
    try {
      await this.options.settings.savePetAlwaysOnTop(enabled);
    } catch (error) {
      try {
        await this.options.applyPetAlwaysOnTop(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'PET_ALWAYS_ON_TOP_PERSIST_ROLLBACK_FAILED'
        );
      }
      throw error;
    }
    return this.getDashboard();
  }

  async setIncognitoSession(incognito: boolean): Promise<{ incognito: boolean }> {
    this.options.privacySessions.register(this.options.sessionId, { incognito });
    return { incognito };
  }

  async revokeAuthorizedRoot(): Promise<SettingsDashboardDto> {
    await this.options.settings.revokeAuthorizedRoot();
    return this.getDashboard();
  }

  async close(): Promise<void> {
    await this.options.mcpManager.close();
    this.options.privacySessions.unregister(this.options.sessionId);
  }

  async enabledReadToolRegistrations(): Promise<
    ToolRegistration[]
  > {
    if (!desktopRuntimeCapabilities.mcp) return [];
    const registrations: ToolRegistration[] = [];
    for (const server of this.options.mcpStore.list().filter(config => config.enabled)) {
      try {
        if (this.statuses.get(server.id) !== 'connected') {
          await this.options.mcpManager.connect(server.id);
          this.statuses.set(server.id, 'connected');
        }
        registrations.push(
          ...this.options.mcpManager.toolRegistrations(server.id)
            .filter(registration => registration.enabled && registration.risk === 'read')
        );
      } catch {
        this.statuses.set(server.id, 'error');
      }
    }
    return registrations;
  }

  async executeMcpRead(
    executionToolName: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    assertMcpEnabled();
    return this.options.mcpManager.executeTool(
      executionToolName,
      arguments_,
      signal ? { signal } : {}
    );
  }

  private async persistMcp(serverId: string): Promise<void> {
    const config = this.options.mcpStore.get(serverId);
    if (!config) return;
    const tools = Object.fromEntries((this.discoveredTools.get(serverId) ?? []).map(tool => [
      tool.name,
      {
        enabled: config.capabilities.tools[tool.name]?.enabled === true,
        readOnly: tool.readOnly,
        description: tool.description,
        definitionFingerprint: tool.definitionFingerprint,
        ...(config.capabilities.tools[tool.name]?.trustedReadFingerprint
          ? {
              trustedReadFingerprint:
                config.capabilities.tools[tool.name]!.trustedReadFingerprint
            }
          : {})
      }
    ]));
    const transport: McpServerSettings['transport'] = config.transport.type === 'stdio'
      ? {
          type: 'stdio',
          command: config.transport.command,
          args: [...(config.transport.args ?? [])],
          cwd: config.transport.cwd!,
          secretNames: Object.keys(config.transport.env ?? {}).sort(),
          inheritEnv: [...(config.transport.inheritEnv ?? [])]
        }
      : {
          type: 'http',
          url: config.transport.url,
          secretNames: Object.keys(config.transport.headers ?? {}).sort()
        };
    await this.options.settings.saveMcpServerSettings({
      id: config.id,
      enabled: config.enabled,
      transport,
      tools
    });
  }
}
