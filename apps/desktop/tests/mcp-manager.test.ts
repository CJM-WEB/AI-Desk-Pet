import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PermissionPolicy } from '../src/main/agent/permission-policy';
import { ToolRegistry } from '../src/main/agent/tool-registry';
import {
  assertMcpHttpUrl,
  McpManager,
  McpManagerError
} from '../src/main/mcp/mcp-manager';
import {
  McpServerStore,
  type McpServerConfig
} from '../src/main/mcp/mcp-server-store';
import {
  adaptMcpTool,
  enforceMcpOutputLimit
} from '../src/main/mcp/mcp-tool-adapter';
import {
  startHttpMcpTestServer,
  startRedirectingHttpTestServer
} from './fixtures/mcp-http-test-server';

function stdioConfig(): McpServerConfig {
  return {
    id: 'local-notes',
    enabled: true,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: ['server.js']
    },
    capabilities: {
      tools: {
        search: { enabled: true },
        update: { enabled: false }
      },
      resources: {
        enabled: true,
        items: { handbook: { enabled: true } }
      },
      prompts: {
        enabled: true,
        items: { summarize: { enabled: true } }
      }
    }
  };
}

describe('McpServerStore', () => {
  test('服务与工具启停共同决定工具是否可用', () => {
    const store = new McpServerStore([stdioConfig()]);

    expect(store.isToolEnabled('local-notes', 'search')).toBe(true);
    expect(store.isToolEnabled('local-notes', 'update')).toBe(false);

    store.setServerEnabled('local-notes', false);
    expect(store.isToolEnabled('local-notes', 'search')).toBe(false);

    store.setServerEnabled('local-notes', true);
    store.setToolEnabled('local-notes', 'search', false);
    expect(store.isToolEnabled('local-notes', 'search')).toBe(false);
  });

  test('返回配置副本并保留资源与提示词启停结构', () => {
    const store = new McpServerStore([stdioConfig()]);

    const first = store.get('local-notes');
    expect(first?.capabilities).toMatchObject({
      resources: { enabled: true, items: { handbook: { enabled: true } } },
      prompts: { enabled: true, items: { summarize: { enabled: true } } }
    });

    first!.capabilities.prompts.enabled = false;
    expect(store.get('local-notes')?.capabilities.prompts.enabled).toBe(true);
  });

  test('资源和提示词支持类别与逐项启停', () => {
    const store = new McpServerStore([stdioConfig()]);

    expect(store.isResourceEnabled('local-notes', 'handbook')).toBe(true);
    expect(store.isPromptEnabled('local-notes', 'summarize')).toBe(true);

    store.setResourceEnabled('local-notes', 'handbook', false);
    store.setPromptEnabled('local-notes', 'summarize', false);

    expect(store.isResourceEnabled('local-notes', 'handbook')).toBe(false);
    expect(store.isPromptEnabled('local-notes', 'summarize')).toBe(false);
  });

  test('未知服务或工具使用稳定错误码', () => {
    const store = new McpServerStore([stdioConfig()]);

    expect(() => store.setServerEnabled('missing', false)).toThrowError(
      expect.objectContaining({ code: 'MCP_SERVER_NOT_FOUND' })
    );
    expect(() => store.setToolEnabled('local-notes', 'missing', false)).toThrowError(
      expect.objectContaining({ code: 'MCP_TOOL_NOT_FOUND' })
    );
  });

  test('拒绝相对 stdio command，避免通过 PATH 解析可执行文件', () => {
    const config = stdioConfig();
    config.transport = {
      type: 'stdio',
      command: 'node',
      args: ['server.js']
    };

    expect(() => new McpServerStore([config])).toThrowError(
      expect.objectContaining({ code: 'MCP_CONFIG_INVALID' })
    );
  });

  test('普通配置不能注入 risk 字段降低本地风险', () => {
    const config = stdioConfig() as unknown as Record<string, unknown>;
    const capabilities = config['capabilities'] as {
      tools: Record<string, Record<string, unknown>>;
    };
    capabilities.tools['search']!['risk'] = 'read';

    expect(() => new McpServerStore([
      config as unknown as McpServerConfig
    ])).toThrowError(
      expect.objectContaining({ code: 'MCP_CONFIG_INVALID' })
    );
  });

  test('stdio 启动确认后配置漂移会在启动复验时被拒绝', () => {
    const store = new McpServerStore([stdioConfig()]);
    const summary = store.getStdioLaunchSummary('local-notes');
    store.confirmStdioLaunch('local-notes', summary.fingerprint);

    const changed = store.get('local-notes')!;
    if (changed.transport.type !== 'stdio') throw new Error('测试配置必须是 stdio');
    changed.transport.args = ['changed-server.js'];
    store.upsert(changed);

    expect(() => store.assertStdioLaunchConfirmed('local-notes')).toThrowError(
      expect.objectContaining({ code: 'MCP_STDIO_LAUNCH_CHANGED' })
    );
  });

  test('省略 cwd 时摘要固定实际 canonical cwd 且不受后续进程 cwd 变化影响', () => {
    const originalCwd = process.cwd();
    const canonicalCwd = realpathSync.native(originalCwd);
    const store = new McpServerStore([stdioConfig()]);
    const summary = store.getStdioLaunchSummary('local-notes');
    store.confirmStdioLaunch('local-notes', summary.fingerprint);

    try {
      expect(summary.cwd).toBe(canonicalCwd);
      process.chdir(import.meta.dirname);

      expect(() => store.assertStdioLaunchConfirmed('local-notes')).not.toThrow();
      const config = store.get('local-notes')!;
      expect(config.transport.type === 'stdio' && config.transport.cwd).toBe(canonicalCwd);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('McpManager HTTP 响应体边界', () => {
  test('响应体在 SDK 完整缓冲前超过传输上限会中止并关闭连接', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer body-limit');
    const manager = new McpManager({
      store: new McpServerStore([{
        id: 'http-body-limit',
        enabled: true,
        transport: {
          type: 'http',
          url: httpServer.url,
          headers: { Authorization: 'Bearer body-limit' }
        },
        capabilities: {
          tools: { echo: { enabled: true } },
          resources: { enabled: false },
          prompts: { enabled: false }
        }
      }]),
      inputLimitBytes: 32 * 1024,
      outputLimitBytes: 32 * 1024,
      httpBodyLimitBytes: 2 * 1024
    });

    try {
      await manager.connect('http-body-limit');
      await expect(manager.callTool(
        'http-body-limit',
        'echo',
        { text: 'x'.repeat(8 * 1024) }
      )).rejects.toMatchObject({
        code: 'MCP_HTTP_BODY_LIMIT_EXCEEDED',
        message: 'MCP_HTTP_BODY_LIMIT_EXCEEDED'
      });
      await expect(manager.callTool(
        'http-body-limit',
        'echo',
        { text: 'closed' }
      )).rejects.toMatchObject({ code: 'MCP_CONNECTION_CLOSED' });
    } finally {
      await manager.close();
      await httpServer.close();
    }
  });

  test('风险仅由 Main 受信 resolver 降级，默认仍为 recoverable', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer risk-resolver');
    const config: McpServerConfig = {
      id: 'http-risk-resolver',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer risk-resolver' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const defaultManager = new McpManager({
      store: new McpServerStore([config])
    });
    const trustedManager = new McpManager({
      store: new McpServerStore([config]),
      riskResolver: () => 'read'
    });

    try {
      await defaultManager.connect(config.id);
      expect(defaultManager.toolRegistrations(config.id)[0]?.risk).toBe('recoverable');
      await defaultManager.close();

      await trustedManager.connect(config.id);
      expect(trustedManager.toolRegistrations(config.id)[0]?.risk).toBe('read');
    } finally {
      await defaultManager.close().catch(() => undefined);
      await trustedManager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('HTTP 302 不会自动跟随且保留原请求 headers 与 signal', async () => {
    const httpServer = await startRedirectingHttpTestServer();
    const originalFetch = globalThis.fetch;
    const observedInit: RequestInit[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      observedInit.push(init ?? {});
      return originalFetch(input, init);
    });
    const manager = new McpManager({
      store: new McpServerStore([{
        id: 'http-redirect-blocked',
        enabled: true,
        transport: {
          type: 'http',
          url: httpServer.sourceUrl,
          headers: { Authorization: 'Bearer redirect-secret' }
        },
        capabilities: {
          tools: {},
          resources: { enabled: false },
          prompts: { enabled: false }
        }
      }]),
      defaultTimeoutMs: 1_000
    });

    try {
      await expect(manager.connect('http-redirect-blocked')).rejects.toMatchObject({
        code: 'MCP_HTTP_REDIRECT_BLOCKED',
        message: 'MCP_HTTP_REDIRECT_BLOCKED'
      });
      expect(httpServer.targetHits).toBe(0);
      expect(httpServer.authorizations).toContain('Bearer redirect-secret');
      expect(observedInit.some(init => (
        init.redirect === 'manual'
        && init.signal instanceof AbortSignal
      ))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });
});

describe('MCP HTTP URL 策略', () => {
  test.each([
    'https://mcp.example.com/rpc',
    'http://localhost:3100/rpc',
    'http://127.0.0.1:3100/rpc',
    'http://[::1]:3100/rpc'
  ])('允许 HTTPS 或真实本机回环地址：%s', value => {
    expect(assertMcpHttpUrl(value).href).toBe(new URL(value).href);
  });

  test.each([
    'http://mcp.example.com/rpc',
    'http://localhost.evil.example/rpc',
    'http://127.0.0.1.evil.example/rpc',
    'ftp://localhost/rpc',
    'https://user:secret@mcp.example.com/rpc'
  ])('拒绝不安全或伪造的 MCP 地址：%s', value => {
    expect(() => assertMcpHttpUrl(value)).toThrowError(
      expect.objectContaining({ code: 'MCP_HTTP_URL_UNSAFE' })
    );
  });
});

describe('MCP 工具适配器', () => {
  test('规范化公开名并生成严格参数 Schema', () => {
    const registration = adaptMcpTool({
      serverId: 'Research Server!',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'Search Docs',
        description: '搜索文档',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            count: { type: 'integer', minimum: 1 }
          },
          required: ['query']
        }
      },
      localRisk: 'read'
    });

    expect(registration.definition.function.name).toBe(
      'mcp.research_server.search_docs'
    );
    expect(registration.executionToolName).toMatch(
      /^mcp-internal\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    );
    expect(registration.executionToolName).not.toContain('Research Server!');
    expect(registration.argumentsSchema.safeParse({ query: 'MCP', count: 2 }).success)
      .toBe(true);
    expect(registration.argumentsSchema.safeParse({ query: '', count: 2 }).success)
      .toBe(false);
    expect(registration.argumentsSchema.safeParse({ query: 'MCP', extra: true }).success)
      .toBe(false);
  });

  test('冒号不能让不同服务与工具得到相同内部执行名', () => {
    const first = adaptMcpTool({
      serverId: 'a',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'b:c',
        inputSchema: { type: 'object', properties: {} }
      }
    });
    const second = adaptMcpTool({
      serverId: 'a:b',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'c',
        inputSchema: { type: 'object', properties: {} }
      }
    });

    expect(first.executionToolName).not.toBe(second.executionToolName);
  });

  test('服务或工具禁用时不暴露且直接 prepare 也会失败', () => {
    const registry = new ToolRegistry();
    registry.register(adaptMcpTool({
      serverId: 'notes',
      serverEnabled: true,
      toolEnabled: false,
      tool: {
        name: 'read',
        inputSchema: { type: 'object', properties: {} }
      },
      localRisk: 'read'
    }));

    expect(registry.definitions()).toEqual([]);
    expect(() => registry.prepare({
      requestId: 'disabled-mcp-1',
      toolName: 'mcp.notes.read',
      arguments: {}
    }, new PermissionPolicy({ highRiskEnabled: false }))).toThrowError(
      expect.objectContaining({ code: 'TOOL_DISABLED' })
    );
  });

  test('服务自报只读不能降低本地默认风险下限', () => {
    const registration = adaptMcpTool({
      serverId: 'remote',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'claimed-read',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false }
      }
    });

    expect(registration.risk).toBe('recoverable');
  });

  test('服务自报破坏性可以提高显式本地只读风险', () => {
    const registration = adaptMcpTool({
      serverId: 'remote',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'dangerous',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      localRisk: 'read'
    });

    expect(registration.risk).toBe('high');
  });

  test('完整执行 MCP JSON Schema 的格式与必填约束', () => {
    const registration = adaptMcpTool({
      serverId: 'schema',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'invite',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' }
          },
          required: ['email']
        }
      },
      localRisk: 'read'
    });

    expect(registration.argumentsSchema.safeParse({ email: 'pet@example.com' }).success)
      .toBe(true);
    expect(registration.argumentsSchema.safeParse({ email: 'not-an-email' }).success)
      .toBe(false);
    expect(registration.argumentsSchema.safeParse({}).success).toBe(false);
  });

  test('重复根 $id 的工具使用彼此独立的验证器', () => {
    const first = adaptMcpTool({
      serverId: 'schema-one',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'first',
        inputSchema: {
          $id: 'https://example.invalid/shared-schema',
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a']
        }
      }
    });
    const second = adaptMcpTool({
      serverId: 'schema-two',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'second',
        inputSchema: {
          $id: 'https://example.invalid/shared-schema',
          type: 'object',
          properties: { b: { type: 'string' } },
          required: ['b']
        }
      }
    });

    expect(first.argumentsSchema.safeParse({ a: 'ok' }).success).toBe(true);
    expect(second.argumentsSchema.safeParse({ a: 'wrong-tool' }).success).toBe(false);
    expect(second.argumentsSchema.safeParse({ b: 'ok' }).success).toBe(true);
  });

  test('允许本地 $ref 且拒绝外部 $ref', () => {
    const local = adaptMcpTool({
      serverId: 'local-ref',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'local',
        inputSchema: {
          type: 'object',
          definitions: {
            item: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value']
            }
          },
          properties: { item: { $ref: '#/definitions/item' } },
          required: ['item']
        }
      }
    });

    expect(local.argumentsSchema.safeParse({ item: { value: 'ok' } }).success)
      .toBe(true);
    expect(() => adaptMcpTool({
      serverId: 'external-ref',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'external',
        inputSchema: {
          type: 'object',
          properties: {
            item: { $ref: 'https://attacker.invalid/schema.json' }
          }
        }
      }
    })).toThrowError(expect.objectContaining({
      code: 'MCP_INPUT_SCHEMA_EXTERNAL_REF'
    }));
  });

  test('拒绝超过序列化字节上限的工具 Schema', () => {
    expect(() => adaptMcpTool({
      serverId: 'large-schema',
      serverEnabled: true,
      toolEnabled: true,
      tool: {
        name: 'large',
        inputSchema: {
          type: 'object',
          description: 'x'.repeat(70_000),
          properties: {}
        }
      }
    })).toThrowError(expect.objectContaining({
      code: 'MCP_INPUT_SCHEMA_LIMIT'
    }));
  });

  test('输出超限使用稳定错误且不回显完整内容', () => {
    const oversized = { content: [{ type: 'text', text: 'sensitive-'.repeat(200) }] };

    expect(() => enforceMcpOutputLimit(oversized, 128)).toThrowError(
      expect.objectContaining({
        code: 'MCP_OUTPUT_LIMIT_EXCEEDED',
        message: 'MCP_OUTPUT_LIMIT_EXCEEDED'
      })
    );
    try {
      enforceMcpOutputLimit(oversized, 128);
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-sensitive-sensitive');
    }
  });

  test('正常输出保持原值', () => {
    const value = { content: [{ type: 'text', text: 'ok' }] };

    expect(enforceMcpOutputLimit(value, 128)).toBe(value);
  });

  test('不可序列化输出使用稳定错误码', () => {
    expect(() => enforceMcpOutputLimit(undefined, 128)).toThrowError(
      expect.objectContaining({
        code: 'MCP_OUTPUT_INVALID',
        message: 'MCP_OUTPUT_INVALID'
      })
    );
  });

  test.each([
    ['灾难性 pattern', {
      type: 'object' as const,
      properties: {
        value: { type: 'string', pattern: '^(a+)+$' }
      }
    }],
    ['普通 pattern', {
      type: 'object' as const,
      properties: {
        value: { type: 'string', pattern: '^[a-z]+$' }
      }
    }],
    ['patternProperties', {
      type: 'object' as const,
      patternProperties: {
        '^item_': { type: 'string' }
      }
    }]
  ])('拒绝远端 %s 且不进入 AJV 编译', (_label, inputSchema) => {
    const getValidator = vi.spyOn(AjvJsonSchemaValidator.prototype, 'getValidator');

    try {
      expect(() => adaptMcpTool({
        serverId: 'regex-server',
        serverEnabled: true,
        toolEnabled: true,
        tool: {
          name: 'regex-tool',
          inputSchema
        }
      })).toThrowError(expect.objectContaining({
        code: 'MCP_INPUT_SCHEMA_UNSUPPORTED'
      }));
      expect(getValidator).not.toHaveBeenCalled();
    } finally {
      getValidator.mockRestore();
    }
  });
});

test('McpManagerError 只公开稳定错误码', () => {
  const error = new McpManagerError('MCP_CONNECTION_FAILED');

  expect(error.code).toBe('MCP_CONNECTION_FAILED');
  expect(error.message).toBe('MCP_CONNECTION_FAILED');
});

const fixturePath = resolve(
  import.meta.dirname,
  'fixtures/mcp-test-server.ts'
);

function fixtureConfig(
  id: string,
  overrides: Partial<McpServerConfig> = {}
): McpServerConfig {
  return {
    id,
    enabled: true,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      env: { MCP_ALLOWED: 'visible' }
    },
    capabilities: {
      tools: {
        echo: { enabled: true },
        environment: { enabled: true },
        delayed: { enabled: true },
        'large-output': { enabled: true },
        crash: { enabled: true }
      },
      resources: { enabled: true },
      prompts: { enabled: true }
    },
    ...overrides
  };
}

function textContent(result: unknown): string {
  const value = result as { content: Array<{ type: string; text?: string }> };
  return value.content.find(item => item.type === 'text')?.text ?? '';
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return false;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('McpManager stdio 集成', () => {
  const managers: McpManager[] = [];

  afterEach(async () => {
    delete process.env['MCP_TEST_SECRET'];
    await Promise.all(managers.splice(0).map(manager => manager.close()));
  });

  function createManager(
    configs: McpServerConfig[],
    outputLimitBytes = 4096,
    inputLimitBytes = 64 * 1024
  ): McpManager {
    const store = new McpServerStore(configs);
    for (const config of store.list()) {
      if (config.transport.type !== 'stdio') continue;
      const summary = store.getStdioLaunchSummary(config.id);
      store.confirmStdioLaunch(config.id, summary.fingerprint);
    }
    const manager = new McpManager({
      store,
      defaultTimeoutMs: 1_000,
      outputLimitBytes,
      inputLimitBytes
    });
    managers.push(manager);
    return manager;
  }

  test('通过官方 stdio 传输发现工具、资源和提示词', async () => {
    const manager = createManager([fixtureConfig('discovery')]);

    const snapshot = await manager.connect('discovery');

    expect(snapshot.tools.map(tool => tool.name)).toEqual([
      'crash',
      'delayed',
      'echo',
      'environment',
      'large-output'
    ]);
    expect(snapshot.resources.map(resource => resource.name)).toEqual(['test-resource']);
    expect(snapshot.prompts.map(prompt => prompt.name)).toEqual(['test-prompt']);
    expect(manager.getChildPid('discovery')).toEqual(expect.any(Number));
  });

  test('stdio 子进程只收到显式环境且不继承父进程敏感变量', async () => {
    process.env['MCP_TEST_SECRET'] = 'must-not-leak';
    const store = new McpServerStore([fixtureConfig('environment')]);
    const summary = store.getStdioLaunchSummary('environment');
    store.confirmStdioLaunch('environment', summary.fingerprint);
    const manager = new McpManager({
      store,
      defaultTimeoutMs: 1_000,
      environment: {
        ...process.env,
        PATH: 'C:\\attacker-controlled-path',
        MCP_TEST_SECRET: 'must-not-leak'
      }
    });
    managers.push(manager);
    await manager.connect('environment');

    const result = await manager.callTool('environment', 'environment', {});

    expect(JSON.parse(textContent(result))).toEqual({
      allowed: 'visible',
      hasSensitive: false,
      path: null,
      cwd: summary.cwd
    });
  });

  test('确认后改变父进程 cwd 不会改变 stdio 子进程实际 cwd', async () => {
    const originalCwd = process.cwd();
    const store = new McpServerStore([fixtureConfig('fixed-cwd')]);
    const summary = store.getStdioLaunchSummary('fixed-cwd');
    store.confirmStdioLaunch('fixed-cwd', summary.fingerprint);
    const manager = new McpManager({ store, defaultTimeoutMs: 1_000 });
    managers.push(manager);

    try {
      process.chdir(import.meta.dirname);
      await manager.connect('fixed-cwd');
      const result = await manager.callTool('fixed-cwd', 'environment', {});

      expect(JSON.parse(textContent(result)).cwd).toBe(summary.cwd);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('未确认的 stdio 启动不会创建子进程', async () => {
    const manager = new McpManager({
      store: new McpServerStore([fixtureConfig('unconfirmed')]),
      defaultTimeoutMs: 1_000
    });
    managers.push(manager);

    await expect(manager.connect('unconfirmed')).rejects.toMatchObject({
      code: 'MCP_STDIO_LAUNCH_UNCONFIRMED'
    });
    expect(manager.getChildPid('unconfirmed')).toBeUndefined();
  });

  test('调用前拒绝序列化字节超限的参数', async () => {
    const manager = createManager([fixtureConfig('input-limit')], 4096, 128);
    await manager.connect('input-limit');

    await expect(manager.callTool(
      'input-limit',
      'echo',
      { text: 'x'.repeat(2_000) }
    )).rejects.toMatchObject({
      code: 'MCP_INPUT_LIMIT_EXCEEDED',
      message: 'MCP_INPUT_LIMIT_EXCEEDED'
    });
  });

  test('stdio 服务大量写入 stderr 不会形成无界管道或阻塞连接', async () => {
    const config = fixtureConfig('stderr-limit');
    if (config.transport.type !== 'stdio') throw new Error('测试配置必须是 stdio');
    config.transport.env = {
      ...config.transport.env,
      MCP_STDERR_BYTES: String(2 * 1024 * 1024)
    };
    const manager = createManager([config]);

    await manager.connect('stderr-limit');
    const result = await manager.callTool('stderr-limit', 'echo', { text: 'ok' });

    expect(textContent(result)).toBe('ok');
  });

  test('服务或工具禁用时即使直接调用也会失败', async () => {
    const toolDisabled = fixtureConfig('tool-disabled');
    toolDisabled.capabilities.tools.echo!.enabled = false;
    const serverDisabled = fixtureConfig('server-disabled', { enabled: false });
    const manager = createManager([toolDisabled, serverDisabled]);

    await expect(manager.connect('server-disabled')).rejects.toMatchObject({
      code: 'MCP_SERVER_DISABLED'
    });
    await manager.connect('tool-disabled');
    expect(manager.toolRegistrations('tool-disabled')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enabled: false,
          definition: expect.objectContaining({
            function: expect.objectContaining({ name: 'mcp.tool-disabled.echo' })
          })
        })
      ])
    );
    await expect(manager.callTool('tool-disabled', 'echo', { text: 'blocked' }))
      .rejects.toMatchObject({ code: 'MCP_TOOL_DISABLED' });
  });

  test('ToolRegistry 内部执行名可回调对应 MCP 服务和工具', async () => {
    const manager = createManager([fixtureConfig('registry-execution')]);
    await manager.connect('registry-execution');
    const registry = new ToolRegistry();
    for (const registration of manager.toolRegistrations('registry-execution')) {
      registry.register(registration);
    }
    const prepared = registry.prepare({
      requestId: 'mcp-registry-1',
      toolName: 'mcp.registry-execution.echo',
      arguments: { text: 'through-registry' }
    }, new PermissionPolicy({ highRiskEnabled: false }));

    const result = await manager.executeTool(
      prepared.executionRequest.toolName,
      prepared.executionRequest.arguments
    );

    expect(textContent(result)).toBe('through-registry');
  });

  test('工具调用超时会终止等待且不会误报成功', async () => {
    const manager = createManager([fixtureConfig('timeout')]);
    await manager.connect('timeout');
    const startedAt = Date.now();

    await expect(manager.callTool(
      'timeout',
      'delayed',
      { delayMs: 500 },
      { timeoutMs: 30 }
    )).rejects.toMatchObject({ code: 'MCP_TOOL_TIMEOUT' });

    expect(Date.now() - startedAt).toBeLessThan(300);
  });

  test('AbortSignal 取消会终止等待且不会误报成功', async () => {
    const manager = createManager([fixtureConfig('cancel')]);
    await manager.connect('cancel');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(manager.callTool(
      'cancel',
      'delayed',
      { delayMs: 500 },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: 'MCP_TOOL_CANCELLED' });
  });

  test('超过并发上限时使用稳定错误且不启动额外调用', async () => {
    const store = new McpServerStore([fixtureConfig('concurrency')]);
    const summary = store.getStdioLaunchSummary('concurrency');
    store.confirmStdioLaunch('concurrency', summary.fingerprint);
    const manager = new McpManager({
      store,
      defaultTimeoutMs: 1_000,
      maxConcurrentCallsPerServer: 1
    });
    managers.push(manager);
    await manager.connect('concurrency');
    const first = manager.callTool('concurrency', 'delayed', { delayMs: 100 });

    await expect(manager.callTool(
      'concurrency',
      'echo',
      { text: 'must-not-run' }
    )).rejects.toMatchObject({ code: 'MCP_CONCURRENCY_LIMIT' });
    await expect(first).resolves.toBeDefined();
  });

  test('输出超限不回显完整远端内容', async () => {
    const manager = createManager([fixtureConfig('output-limit')], 256);
    await manager.connect('output-limit');

    await expect(manager.callTool(
      'output-limit',
      'large-output',
      { size: 2_000 }
    )).rejects.toMatchObject({
      code: 'MCP_OUTPUT_LIMIT_EXCEEDED',
      message: 'MCP_OUTPUT_LIMIT_EXCEEDED'
    });
  });

  test('一个服务崩溃不会影响其他服务', async () => {
    const manager = createManager([
      fixtureConfig('unstable'),
      fixtureConfig('healthy')
    ]);
    await manager.connect('unstable');
    await manager.connect('healthy');

    await expect(manager.callTool('unstable', 'crash', {})).rejects.toMatchObject({
      code: 'MCP_CONNECTION_CLOSED'
    });
    const healthyResult = await manager.callTool(
      'healthy',
      'echo',
      { text: 'still-alive' }
    );

    expect(textContent(healthyResult)).toBe('still-alive');
  });

  test('关闭 manager 后所有 stdio 子进程均已退出', async () => {
    const manager = createManager([
      fixtureConfig('close-one'),
      fixtureConfig('close-two')
    ]);
    await manager.connect('close-one');
    await manager.connect('close-two');
    const pids = [
      manager.getChildPid('close-one'),
      manager.getChildPid('close-two')
    ] as number[];

    await manager.close();

    expect(manager.getChildPid('close-one')).toBeUndefined();
    expect(manager.getChildPid('close-two')).toBeUndefined();
    expect(pids.map(isProcessRunning)).toEqual([false, false]);
    expect(await Promise.all(pids.map(waitForProcessExit))).toEqual([true, true]);
  });
});

describe('McpManager Streamable HTTP 集成', () => {
  test('通过回环 HTTP 发现并调用工具且发送配置认证头', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer http-secret');
    const manager = new McpManager({
      store: new McpServerStore([{
        id: 'http-local',
        enabled: true,
        transport: {
          type: 'http',
          url: httpServer.url,
          headers: { Authorization: 'Bearer http-secret' }
        },
        capabilities: {
          tools: { echo: { enabled: true } },
          resources: { enabled: false },
          prompts: { enabled: false }
        }
      }])
    });

    try {
      const snapshot = await manager.connect('http-local');
      const result = await manager.callTool(
        'http-local',
        'echo',
        { text: 'from-http' }
      );

      expect(snapshot.tools.map(tool => tool.name)).toEqual(['echo']);
      expect(textContent(result)).toBe('from-http');
      expect(httpServer.authorizations.length).toBeGreaterThan(0);
      expect(new Set(httpServer.authorizations)).toEqual(new Set(['Bearer http-secret']));
    } finally {
      await manager.close();
      await httpServer.close();
    }
  });

  test('HTTP 认证失败只返回稳定错误且不泄漏认证头', async () => {
    const secret = 'Bearer should-never-appear';
    const httpServer = await startHttpMcpTestServer('Bearer expected');
    const manager = new McpManager({
      store: new McpServerStore([{
        id: 'http-auth-failure',
        enabled: true,
        transport: {
          type: 'http',
          url: httpServer.url,
          headers: { Authorization: secret }
        },
        capabilities: {
          tools: {},
          resources: { enabled: false },
          prompts: { enabled: false }
        }
      }])
    });

    try {
      const error = await manager.connect('http-auth-failure').catch(value => value);

      expect(error).toMatchObject({
        code: 'MCP_CONNECTION_FAILED',
        message: 'MCP_CONNECTION_FAILED'
      });
      expect(String(error)).not.toContain(secret);
    } finally {
      await manager.close();
      await httpServer.close();
    }
  });

  test('同一服务并发 connect 只执行一次初始化', async () => {
    const httpServer = await startHttpMcpTestServer(
      'Bearer single-flight',
      { initializeDelayMs: 80 }
    );
    const config: McpServerConfig = {
      id: 'http-single-flight',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer single-flight' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });

    try {
      const [first, second] = await Promise.all([
        manager.connect(config.id),
        manager.connect(config.id)
      ]);

      expect(first).toEqual(second);
      expect(httpServer.initializationCount).toBe(1);
    } finally {
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('close 等待进行中的 connect 且关闭开始后不得写回连接', async () => {
    const httpServer = await startHttpMcpTestServer(
      'Bearer close-race',
      { initializeDelayMs: 100 }
    );
    const config: McpServerConfig = {
      id: 'http-close-race',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer close-race' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    const connectPromise = manager.connect(config.id);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));

    const firstClose = manager.close();
    const secondClose = manager.close();

    expect(firstClose).toBe(secondClose);
    await expect(connectPromise).rejects.toMatchObject({ code: 'MCP_MANAGER_CLOSED' });
    await expect(firstClose).resolves.toBeUndefined();
    await expect(manager.callTool(config.id, 'echo', { text: 'blocked' }))
      .rejects.toMatchObject({ code: 'MCP_CONNECTION_CLOSED' });
    await httpServer.close();
  });

  test('并发 disconnect 复用同一关闭 Promise', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer disconnect-once');
    const config: McpServerConfig = {
      id: 'http-disconnect-once',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer disconnect-once' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });

    try {
      await manager.connect(config.id);
      const first = manager.disconnect(config.id);
      const second = manager.disconnect(config.id);

      expect(first).toBe(second);
      await first;
    } finally {
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('旧连接延迟触发 onclose 不得删除同服务的新连接', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer reconnect-identity');
    const config: McpServerConfig = {
      id: 'http-reconnect-identity',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer reconnect-identity' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    const connections = (
      manager as unknown as {
        connections: Map<string, { client: Client }>;
      }
    ).connections;

    try {
      await manager.connect(config.id);
      const oldClient = connections.get(config.id)!.client;
      await manager.disconnect(config.id);
      await manager.connect(config.id);

      oldClient.onclose?.();
      const result = await manager.callTool(config.id, 'echo', { text: 'new-alive' });

      expect(textContent(result)).toBe('new-alive');
    } finally {
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('可验证的关闭失败向调用方返回稳定错误', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer close-failure');
    const config: McpServerConfig = {
      id: 'http-close-failure',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer close-failure' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    await manager.connect(config.id);
    const connections = (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections;
    const close = vi.spyOn(Client.prototype, 'close')
      .mockRejectedValueOnce(new Error('secret-close-detail'));

    try {
      await expect(manager.disconnect(config.id)).rejects.toMatchObject({
        code: 'MCP_CLOSE_FAILED',
        message: 'MCP_CLOSE_FAILED'
      });
      expect(connections.has(config.id)).toBe(true);

      close.mockRestore();
      await expect(manager.disconnect(config.id)).resolves.toBeUndefined();
      expect(connections.has(config.id)).toBe(false);
    } finally {
      close.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('关闭失败后的并发 connect 先单飞重试清理且成功前不覆盖旧连接', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer reconnect-after-close-failure');
    const config: McpServerConfig = {
      id: 'http-reconnect-after-close-failure',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer reconnect-after-close-failure' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    const connections = (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections;
    await manager.connect(config.id);
    const oldConnection = connections.get(config.id);
    const close = vi.spyOn(Client.prototype, 'close')
      .mockRejectedValueOnce(new Error('first-close-failed'))
      .mockRejectedValueOnce(new Error('connect-cleanup-failed'));

    try {
      await expect(manager.disconnect(config.id)).rejects.toMatchObject({
        code: 'MCP_CLOSE_FAILED'
      });
      expect(connections.get(config.id)).toBe(oldConnection);

      const firstReconnect = manager.connect(config.id);
      const secondReconnect = manager.connect(config.id);
      await expect(firstReconnect).rejects.toMatchObject({ code: 'MCP_CLOSE_FAILED' });
      await expect(secondReconnect).rejects.toMatchObject({ code: 'MCP_CLOSE_FAILED' });
      expect(close).toHaveBeenCalledTimes(2);
      expect(httpServer.initializationCount).toBe(1);
      expect(connections.get(config.id)).toBe(oldConnection);

      await expect(manager.connect(config.id)).resolves.toMatchObject({
        serverId: config.id
      });
      expect(httpServer.initializationCount).toBe(2);
      expect(connections.get(config.id)).not.toBe(oldConnection);
    } finally {
      close.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('manager close 失败会保留连接并允许调用方显式重试', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer manager-close-retry');
    const config: McpServerConfig = {
      id: 'http-manager-close-retry',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer manager-close-retry' }
      },
      capabilities: {
        tools: { echo: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    const connections = (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections;
    await manager.connect(config.id);
    const close = vi.spyOn(Client.prototype, 'close')
      .mockRejectedValueOnce(new Error('first-close-failed'));

    try {
      await expect(manager.close()).rejects.toMatchObject({ code: 'MCP_CLOSE_FAILED' });
      expect(connections.has(config.id)).toBe(true);

      close.mockRestore();
      await expect(manager.close()).resolves.toBeUndefined();
      expect(connections.has(config.id)).toBe(false);
    } finally {
      close.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('连接建立失败且清理失败时返回关闭错误并保留管理入口', async () => {
    const config: McpServerConfig = {
      id: 'http-connect-cleanup-failure',
      enabled: true,
      transport: {
        type: 'http',
        url: 'http://127.0.0.1:9/mcp'
      },
      capabilities: {
        tools: {},
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });
    const connections = (
      manager as unknown as {
        connections: Map<string, unknown>;
      }
    ).connections;
    const connect = vi.spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('connect-failed'));
    const close = vi.spyOn(Client.prototype, 'close')
      .mockRejectedValueOnce(new Error('cleanup-failed'));

    try {
      await expect(manager.connect(config.id)).rejects.toMatchObject({
        code: 'MCP_CLOSE_FAILED'
      });
      expect(connections.has(config.id)).toBe(true);

      connect.mockRestore();
      close.mockRestore();
      await expect(manager.disconnect(config.id)).resolves.toBeUndefined();
    } finally {
      connect.mockRestore();
      close.mockRestore();
      await manager.close().catch(() => undefined);
    }
  });

  test('发现阶段拒绝归一化后公开名碰撞的工具', async () => {
    const httpServer = await startHttpMcpTestServer(
      'Bearer collision',
      { toolNames: ['foo.bar', 'foo_bar'] }
    );
    const config: McpServerConfig = {
      id: 'collision',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer collision' }
      },
      capabilities: {
        tools: {
          'foo.bar': { enabled: true },
          foo_bar: { enabled: true }
        },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const manager = new McpManager({ store: new McpServerStore([config]) });

    try {
      await expect(manager.connect(config.id)).rejects.toMatchObject({
        code: 'MCP_TOOL_NAME_COLLISION',
        message: 'MCP_TOOL_NAME_COLLISION'
      });
    } finally {
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('工具、资源和提示词发现会遍历全部分页并共享总超时预算', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer pagination');
    const config: McpServerConfig = {
      id: 'pagination',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer pagination' }
      },
      capabilities: {
        tools: {
          first: { enabled: true },
          second: { enabled: true }
        },
        resources: { enabled: true },
        prompts: { enabled: true }
      }
    };
    const tool = (name: string) => ({
      name,
      inputSchema: { type: 'object' as const, properties: {} }
    });
    const listTools = vi.spyOn(Client.prototype, 'listTools')
      .mockResolvedValueOnce({ tools: [tool('first')], nextCursor: 'tools-2' })
      .mockResolvedValueOnce({ tools: [tool('second')] });
    const listResources = vi.spyOn(Client.prototype, 'listResources')
      .mockResolvedValueOnce({
        resources: [{ uri: 'test://one', name: 'resource-one' }],
        nextCursor: 'resources-2'
      })
      .mockResolvedValueOnce({
        resources: [{ uri: 'test://two', name: 'resource-two' }]
      });
    const listPrompts = vi.spyOn(Client.prototype, 'listPrompts')
      .mockResolvedValueOnce({
        prompts: [{ name: 'prompt-one' }],
        nextCursor: 'prompts-2'
      })
      .mockResolvedValueOnce({
        prompts: [{ name: 'prompt-two' }]
      });
    const manager = new McpManager({
      store: new McpServerStore([config]),
      defaultTimeoutMs: 1_000
    });

    try {
      const snapshot = await manager.connect(config.id);

      expect(snapshot.tools.map(item => item.name)).toEqual(['first', 'second']);
      expect(snapshot.resources.map(item => item.name)).toEqual([
        'resource-one',
        'resource-two'
      ]);
      expect(snapshot.prompts.map(item => item.name)).toEqual([
        'prompt-one',
        'prompt-two'
      ]);
      expect(listTools.mock.calls[1]?.[0]).toEqual({ cursor: 'tools-2' });
      expect(listResources.mock.calls[1]?.[0]).toEqual({ cursor: 'resources-2' });
      expect(listPrompts.mock.calls[1]?.[0]).toEqual({ cursor: 'prompts-2' });
      const firstBudget = listTools.mock.calls[0]?.[1]?.timeout ?? 0;
      const lastBudget = listPrompts.mock.calls[1]?.[1]?.timeout ?? 0;
      expect(lastBudget).toBeLessThanOrEqual(firstBudget);
      expect(lastBudget).toBeGreaterThan(0);
    } finally {
      listTools.mockRestore();
      listResources.mockRestore();
      listPrompts.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });

  test('重复发现 cursor 会稳定失败且停止继续请求', async () => {
    const httpServer = await startHttpMcpTestServer('Bearer cursor-loop');
    const config: McpServerConfig = {
      id: 'cursor-loop',
      enabled: true,
      transport: {
        type: 'http',
        url: httpServer.url,
        headers: { Authorization: 'Bearer cursor-loop' }
      },
      capabilities: {
        tools: { first: { enabled: true } },
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    };
    const listTools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [{
        name: 'first',
        inputSchema: { type: 'object', properties: {} }
      }],
      nextCursor: 'same-cursor'
    });
    const manager = new McpManager({ store: new McpServerStore([config]) });

    try {
      await expect(manager.connect(config.id)).rejects.toMatchObject({
        code: 'MCP_DISCOVERY_CURSOR_LOOP'
      });
      expect(listTools).toHaveBeenCalledTimes(2);
    } finally {
      listTools.mockRestore();
      await manager.close().catch(() => undefined);
      await httpServer.close();
    }
  });
});
