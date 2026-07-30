import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Prompt, Resource, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRisk } from '@myself/agent-core';
import type { ToolRegistration } from '../agent/tool-registry';
import {
  type McpServerConfig,
  McpServerStore,
  type McpStdioTransportConfig
} from './mcp-server-store';
import {
  adaptMcpTool,
  enforceMcpOutputLimit,
  mcpExecutionToolName,
  mcpPublicToolName
} from './mcp-tool-adapter';

export class McpManagerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'McpManagerError';
    this.code = code;
  }
}

export interface McpServerSnapshot {
  serverId: string;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface McpManagerOptions {
  store: McpServerStore;
  defaultTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  maxDiscoveryPages?: number;
  maxDiscoveryItems?: number;
  inputLimitBytes?: number;
  outputLimitBytes?: number;
  httpBodyLimitBytes?: number;
  processExitTimeoutMs?: number;
  maxConcurrentCallsPerServer?: number;
  environment?: NodeJS.ProcessEnv;
  riskResolver?: (serverId: string, tool: Tool) => ToolRisk;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ManagedConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  snapshot: McpServerSnapshot;
  state: 'connecting' | 'connected' | 'closing' | 'close-failed' | 'closed';
  closed: boolean;
  activeCalls: number;
  closePromise?: Promise<void>;
  httpBodyLimitState?: { exceeded: boolean };
  childPid?: number;
}

interface DiscoveryPage<T> {
  items: T[];
  nextCursor?: string;
}

interface HttpBodyLimitState {
  exceeded: boolean;
  onExceeded?: () => void;
}

function minimalEnvironment(
  config: McpStdioTransportConfig,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  // SDK 会补入自身默认白名单，因此先显式清空，再恢复本地允许项。
  const environment = Object.fromEntries(
    DEFAULT_INHERITED_ENV_VARS.map(name => [name, ''])
  );
  const runtimeAllowlist = process.platform === 'win32'
    ? ['SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP']
    : [];
  for (const name of [...runtimeAllowlist, ...(config.inheritEnv ?? [])]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...config.env };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function limitedHttpFetch(
  limitBytes: number,
  state: HttpBodyLimitState
): typeof fetch {
  const markExceeded = (): void => {
    state.exceeded = true;
    state.onExceeded?.();
  };
  return async (input, init) => {
    const response = await fetch(input, {
      ...init,
      redirect: 'manual'
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new McpManagerError('MCP_HTTP_REDIRECT_BLOCKED');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limitBytes) {
      markExceeded();
      void response.body?.cancel().catch(() => undefined);
      throw new McpManagerError('MCP_HTTP_BODY_LIMIT_EXCEEDED');
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const reader = response.body.getReader();
    const limitedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > limitBytes) {
            markExceeded();
            void reader.cancel().catch(() => undefined);
            controller.error(new McpManagerError('MCP_HTTP_BODY_LIMIT_EXCEEDED'));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
    return new Response(limitedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

export function assertMcpHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpManagerError('MCP_HTTP_URL_UNSAFE');
  }

  if (url.username || url.password) {
    throw new McpManagerError('MCP_HTTP_URL_UNSAFE');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && loopbackHosts.has(url.hostname);
  if (!secure && !localHttp) {
    throw new McpManagerError('MCP_HTTP_URL_UNSAFE');
  }
  return url;
}

export class McpManager {
  private readonly store: McpServerStore;
  private readonly defaultTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly maxDiscoveryPages: number;
  private readonly maxDiscoveryItems: number;
  private readonly inputLimitBytes: number;
  private readonly outputLimitBytes: number;
  private readonly httpBodyLimitBytes: number;
  private readonly processExitTimeoutMs: number;
  private readonly maxConcurrentCallsPerServer: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly riskResolver: (serverId: string, tool: Tool) => ToolRisk;
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly connectPromises = new Map<string, Promise<McpServerSnapshot>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(options: McpManagerOptions) {
    this.store = options.store;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? this.defaultTimeoutMs;
    this.maxDiscoveryPages = options.maxDiscoveryPages ?? 20;
    this.maxDiscoveryItems = options.maxDiscoveryItems ?? 1_000;
    this.inputLimitBytes = options.inputLimitBytes ?? 64 * 1024;
    this.outputLimitBytes = options.outputLimitBytes ?? 1024 * 1024;
    this.httpBodyLimitBytes = options.httpBodyLimitBytes ?? 1024 * 1024;
    this.processExitTimeoutMs = options.processExitTimeoutMs ?? 1_000;
    this.maxConcurrentCallsPerServer = options.maxConcurrentCallsPerServer ?? 4;
    this.environment = options.environment ?? process.env;
    this.riskResolver = options.riskResolver ?? (() => 'recoverable');
  }

  connect(serverId: string): Promise<McpServerSnapshot> {
    if (this.closing) return Promise.reject(new McpManagerError('MCP_MANAGER_CLOSED'));
    const pending = this.connectPromises.get(serverId);
    if (pending) return pending.then(snapshot => structuredClone(snapshot));

    const existing = this.connections.get(serverId);
    if (existing?.state === 'connected') {
      return Promise.resolve(structuredClone(existing.snapshot));
    }

    const waitForPrevious = existing
      ? this.closeManagedConnection(serverId, existing)
      : Promise.resolve();
    const connectPromise = waitForPrevious.then(() => this.startConnection(serverId));
    this.connectPromises.set(serverId, connectPromise);
    void connectPromise.finally(() => {
      if (this.connectPromises.get(serverId) === connectPromise) {
        this.connectPromises.delete(serverId);
      }
    }).catch(() => undefined);
    return connectPromise.then(snapshot => structuredClone(snapshot));
  }

  private async startConnection(serverId: string): Promise<McpServerSnapshot> {
    if (this.closing) throw new McpManagerError('MCP_MANAGER_CLOSED');
    const config = this.requireEnabledServer(serverId);
    if (config.transport.type === 'stdio') {
      this.store.assertStdioLaunchConfirmed(serverId);
    }
    const httpBodyLimitState: HttpBodyLimitState = { exceeded: false };
    const transport = config.transport.type === 'stdio'
      ? new StdioClientTransport({
          command: config.transport.command,
          ...(config.transport.args ? { args: config.transport.args } : {}),
          ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
          env: minimalEnvironment(config.transport, this.environment),
          stderr: 'ignore'
        })
      : new StreamableHTTPClientTransport(assertMcpHttpUrl(config.transport.url), {
          fetch: limitedHttpFetch(this.httpBodyLimitBytes, httpBodyLimitState),
          requestInit: {
            headers: new Headers(config.transport.headers)
          }
        });
    if (transport instanceof StreamableHTTPClientTransport) {
      httpBodyLimitState.onExceeded = () => {
        void transport.close().catch(() => undefined);
      };
    }
    const client = new Client(
      { name: 'myself-desktop', version: '0.1.0' },
      { capabilities: {} }
    );
    const connection: ManagedConnection = {
      client,
      transport,
      snapshot: { serverId, tools: [], resources: [], prompts: [] },
      state: 'connecting',
      closed: false,
      activeCalls: 0,
      ...(config.transport.type === 'http' ? { httpBodyLimitState } : {})
    };
    this.connections.set(serverId, connection);
    client.onclose = () => {
      connection.closed = true;
      if (connection.state !== 'closing') connection.state = 'closed';
      if (
        connection.state !== 'closing'
        && this.connections.get(serverId) === connection
      ) {
        this.connections.delete(serverId);
      }
    };
    client.onerror = () => {
      // SDK 错误可能包含远端文本，此处仅由调用路径转换为稳定错误码。
    };

    try {
      // SDK 1.29.0 的可选回调类型与 exactOptionalPropertyTypes 不兼容。
      await client.connect(transport as unknown as Transport, {
        timeout: this.defaultTimeoutMs,
        maxTotalTimeout: this.defaultTimeoutMs
      });
      if (transport instanceof StdioClientTransport) {
        const childPid = transport.pid;
        if (childPid !== null) connection.childPid = childPid;
      }
      if (this.closing || this.connections.get(serverId) !== connection) {
        throw new McpManagerError('MCP_MANAGER_CLOSED');
      }
      connection.snapshot = await this.discover(serverId, config, client);
      this.assertNoToolNameCollisions(connection);
      if (this.closing || this.connections.get(serverId) !== connection) {
        throw new McpManagerError('MCP_MANAGER_CLOSED');
      }
      connection.state = 'connected';
      return structuredClone(connection.snapshot);
    } catch (error) {
      if (transport instanceof StdioClientTransport) {
        const childPid = transport.pid;
        if (connection.childPid === undefined && childPid !== null) {
          connection.childPid = childPid;
        }
      }
      let cleanupError: unknown;
      try {
        await this.closeManagedConnection(serverId, connection);
      } catch (closeError) {
        cleanupError = closeError;
      }
      if (cleanupError) throw new McpManagerError('MCP_CLOSE_FAILED');
      if (this.closing) throw new McpManagerError('MCP_MANAGER_CLOSED');
      if (connection.httpBodyLimitState?.exceeded) {
        throw new McpManagerError('MCP_HTTP_BODY_LIMIT_EXCEEDED');
      }
      if (error instanceof McpManagerError) throw error;
      throw new McpManagerError('MCP_CONNECTION_FAILED');
    }
  }

  toolRegistrations(serverId: string): ToolRegistration[] {
    const connection = this.requireConnection(serverId);
    const config = this.store.get(serverId);
    if (!config) throw new McpManagerError('MCP_SERVER_NOT_FOUND');

    return connection.snapshot.tools.map(tool => {
      const state = config.capabilities.tools[tool.name];
      return adaptMcpTool({
        serverId,
        serverEnabled: config.enabled,
        toolEnabled: state?.enabled === true,
        tool,
        localRisk: this.riskResolver(serverId, structuredClone(tool))
      });
    });
  }

  async callTool(
    serverId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
    options: McpCallOptions = {}
  ): Promise<unknown> {
    const connection = this.requireConnection(serverId);
    const config = this.store.get(serverId);
    if (!config?.enabled) throw new McpManagerError('MCP_SERVER_DISABLED');
    if (!this.store.isToolEnabled(serverId, toolName)) {
      throw new McpManagerError('MCP_TOOL_DISABLED');
    }

    const registration = this.toolRegistrations(serverId).find(
      candidate => candidate.executionToolName === mcpExecutionToolName(serverId, toolName)
    );
    if (!registration) throw new McpManagerError('MCP_TOOL_NOT_FOUND');
    const parsed = registration.argumentsSchema.safeParse(arguments_);
    if (!parsed.success) throw new McpManagerError('MCP_TOOL_ARGUMENTS_INVALID');
    let inputBytes: number;
    try {
      inputBytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    } catch {
      throw new McpManagerError('MCP_TOOL_ARGUMENTS_INVALID');
    }
    if (inputBytes > this.inputLimitBytes) {
      throw new McpManagerError('MCP_INPUT_LIMIT_EXCEEDED');
    }
    if (connection.activeCalls >= this.maxConcurrentCallsPerServer) {
      throw new McpManagerError('MCP_CONCURRENCY_LIMIT');
    }

    connection.activeCalls += 1;
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: parsed.data },
        undefined,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: options.timeoutMs ?? this.defaultTimeoutMs,
          maxTotalTimeout: options.timeoutMs ?? this.defaultTimeoutMs
        }
      );
      if (result.isError === true) throw new McpManagerError('MCP_TOOL_FAILED');
      return enforceMcpOutputLimit(result, this.outputLimitBytes);
    } catch (error) {
      if (connection.httpBodyLimitState?.exceeded) {
        await this.disconnect(serverId);
        throw new McpManagerError('MCP_HTTP_BODY_LIMIT_EXCEEDED');
      }
      if (error instanceof McpManagerError) throw error;
      if (
        error instanceof Error
        && 'code' in error
        && (
          error.code === 'MCP_OUTPUT_LIMIT_EXCEEDED'
          || error.code === 'MCP_OUTPUT_INVALID'
        )
      ) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw new McpManagerError('MCP_TOOL_CANCELLED');
      }
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpManagerError('MCP_TOOL_TIMEOUT');
      }
      if (
        connection.closed
        || (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
      ) {
        throw new McpManagerError('MCP_CONNECTION_CLOSED');
      }
      throw new McpManagerError('MCP_TOOL_CALL_FAILED');
    } finally {
      connection.activeCalls -= 1;
    }
  }

  async executeTool(
    executionToolName: string,
    arguments_: Record<string, unknown>,
    options: McpCallOptions = {}
  ): Promise<unknown> {
    for (const serverId of this.connections.keys()) {
      const registration = this.toolRegistrations(serverId).find(
        candidate => candidate.executionToolName === executionToolName
      );
      if (registration) {
        const tool = this.connections.get(serverId)?.snapshot.tools.find(
          candidate => mcpExecutionToolName(serverId, candidate.name) === executionToolName
        );
        if (tool) return this.callTool(serverId, tool.name, arguments_, options);
      }
    }
    throw new McpManagerError('MCP_TOOL_NOT_FOUND');
  }

  getChildPid(serverId: string): number | undefined {
    return this.connections.get(serverId)?.childPid;
  }

  disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (connection) return this.closeManagedConnection(serverId, connection);

    const pending = this.connectPromises.get(serverId);
    if (!pending) return Promise.resolve();
    const queued = pending.then(
      () => this.disconnect(serverId),
      error => {
        if (error instanceof McpManagerError && error.code === 'MCP_MANAGER_CLOSED') return;
        throw error;
      }
    );
    return queued;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const closeAttempt = (async () => {
      const failures: unknown[] = [];
      const attempted = new Set<ManagedConnection>();
      const closeCurrent = async (): Promise<void> => {
        const results = await Promise.allSettled(
          [...this.connections.entries()]
            .filter(([, connection]) => !attempted.has(connection))
            .map(([serverId, connection]) => {
              attempted.add(connection);
              return this.closeManagedConnection(serverId, connection);
            })
        );
        failures.push(...results.filter(result => result.status === 'rejected'));
      };

      await closeCurrent();
      await Promise.allSettled([...this.connectPromises.values()]);
      await closeCurrent();
      if (failures.length > 0) throw new McpManagerError('MCP_CLOSE_FAILED');
    })();
    this.closePromise = closeAttempt;
    void closeAttempt.catch(() => {
      if (this.closePromise === closeAttempt) delete this.closePromise;
    });
    return closeAttempt;
  }

  private requireEnabledServer(serverId: string): McpServerConfig {
    const config = this.store.get(serverId);
    if (!config) throw new McpManagerError('MCP_SERVER_NOT_FOUND');
    if (!config.enabled) throw new McpManagerError('MCP_SERVER_DISABLED');
    return config;
  }

  private requireConnection(serverId: string): ManagedConnection {
    const connection = this.connections.get(serverId);
    if (!connection || connection.closed || connection.state !== 'connected') {
      throw new McpManagerError('MCP_CONNECTION_CLOSED');
    }
    return connection;
  }

  private closeManagedConnection(
    serverId: string,
    connection: ManagedConnection
  ): Promise<void> {
    if (connection.closePromise) return connection.closePromise;
    if (
      connection.childPid === undefined
      && connection.transport instanceof StdioClientTransport
    ) {
      const childPid = connection.transport.pid;
      if (childPid !== null) connection.childPid = childPid;
    }
    connection.state = 'closing';
    connection.closePromise = (async () => {
      let failed = false;
      try {
        await connection.client.close();
      } catch {
        failed = true;
      }
      try {
        await connection.transport.close();
      } catch {
        failed = true;
      }

      if (
        connection.childPid !== undefined
        && !await this.waitForProcessExit(connection.childPid)
      ) {
        failed = true;
      }
      if (failed) {
        connection.closed = false;
        connection.state = 'close-failed';
        throw new McpManagerError('MCP_CLOSE_FAILED');
      }

      connection.closed = true;
      connection.state = 'closed';
      if (this.connections.get(serverId) === connection) {
        this.connections.delete(serverId);
      }
    })().finally(() => {
      if (connection.state === 'close-failed') {
        delete connection.closePromise;
      }
    });
    return connection.closePromise;
  }

  private async waitForProcessExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + this.processExitTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        return error instanceof Error
          && 'code' in error
          && error.code === 'ESRCH';
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    return false;
  }

  private assertNoToolNameCollisions(connection: ManagedConnection): void {
    const names = new Set<string>();
    for (const tool of connection.snapshot.tools) {
      const publicName = mcpPublicToolName(connection.snapshot.serverId, tool.name);
      if (names.has(publicName)) {
        throw new McpManagerError('MCP_TOOL_NAME_COLLISION');
      }
      names.add(publicName);
    }

    for (const candidate of this.connections.values()) {
      if (candidate === connection || candidate.state !== 'connected') continue;
      for (const tool of candidate.snapshot.tools) {
        const publicName = mcpPublicToolName(candidate.snapshot.serverId, tool.name);
        if (names.has(publicName)) {
          throw new McpManagerError('MCP_TOOL_NAME_COLLISION');
        }
      }
    }
  }

  private async discover(
    serverId: string,
    config: McpServerConfig,
    client: Client
  ): Promise<McpServerSnapshot> {
    const deadline = Date.now() + this.discoveryTimeoutMs;
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools
      ? await this.listAllDiscoveryPages(
          (cursor, requestOptions) => client
            .listTools(cursor ? { cursor } : undefined, requestOptions)
            .then(page => ({
              items: page.tools,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
            })),
          deadline
        )
      : [];
    const resources = capabilities?.resources && config.capabilities.resources.enabled
      ? await this.listAllDiscoveryPages(
          (cursor, requestOptions) => client
            .listResources(cursor ? { cursor } : undefined, requestOptions)
            .then(page => ({
              items: page.resources,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
            })),
          deadline
        )
      : [];
    const prompts = capabilities?.prompts && config.capabilities.prompts.enabled
      ? await this.listAllDiscoveryPages(
          (cursor, requestOptions) => client
            .listPrompts(cursor ? { cursor } : undefined, requestOptions)
            .then(page => ({
              items: page.prompts,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
            })),
          deadline
        )
      : [];
    return {
      serverId,
      tools: sortByName(tools),
      resources: sortByName(resources),
      prompts: sortByName(prompts)
    };
  }

  private async listAllDiscoveryPages<T>(
    loadPage: (
      cursor: string | undefined,
      requestOptions: { timeout: number; maxTotalTimeout: number }
    ) => Promise<DiscoveryPage<T>>,
    deadline: number
  ): Promise<T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageNumber = 1; ; pageNumber += 1) {
      if (pageNumber > this.maxDiscoveryPages) {
        throw new McpManagerError('MCP_DISCOVERY_PAGE_LIMIT');
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new McpManagerError('MCP_DISCOVERY_TIMEOUT');
      }

      const page = await loadPage(cursor, {
        timeout: remainingMs,
        maxTotalTimeout: remainingMs
      });
      items.push(...page.items);
      if (items.length > this.maxDiscoveryItems) {
        throw new McpManagerError('MCP_DISCOVERY_ITEM_LIMIT');
      }
      if (!page.nextCursor) return items;
      if (seenCursors.has(page.nextCursor)) {
        throw new McpManagerError('MCP_DISCOVERY_CURSOR_LOOP');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}
