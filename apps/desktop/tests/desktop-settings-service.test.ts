import type { ModelProvider } from '@myself/agent-core';
import { providerCatalog } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { McpServerStore } from '../src/main/mcp/mcp-server-store';
import type { McpServerSettings } from '../src/main/storage/settings-store';
import {
  createTrustedMcpRiskResolver,
  DesktopSettingsService
} from '../src/main/settings/desktop-settings-service';
import { mcpToolDefinitionFingerprint } from '../src/main/mcp/mcp-tool-adapter';
import { desktopRuntimeCapabilities } from '../src/shared/desktop-runtime-capabilities';

function providerSnapshot() {
  return {
    profiles: [{
      id: 'openai-main',
      displayName: 'OpenAI 主档案',
      mode: 'preset' as const,
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      hasStoredSecret: true
    }],
    route: {
      primaryProfileId: 'openai-main',
      chatProfileId: null,
      agentProfileId: 'openai-main',
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    }
  };
}

function createFixture() {
  let storedPetAlwaysOnTop = false;
  const settings = {
    getProviderSettings: vi.fn(async () => providerSnapshot()),
    saveProviderProfile: vi.fn(async () => undefined),
    deleteProviderProfile: vi.fn(async () => undefined),
    saveModelRoute: vi.fn(async () => undefined),
    getPrivacySettings: vi.fn(async () => ({
      dataCategories: {
        file: false,
        screenshot: false,
        clipboard: false,
        memory: false
      },
      longTermMemory: false,
      proactivityMode: 'assistive' as const
    })),
    savePrivacySettings: vi.fn(async () => undefined),
    getPetAlwaysOnTop: vi.fn(async () => storedPetAlwaysOnTop),
    savePetAlwaysOnTop: vi.fn(async (enabled: boolean) => {
      storedPetAlwaysOnTop = enabled;
    }),
    getPublic: vi.fn(async () => ({
      version: 1 as const,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    })),
    revokeAuthorizedRoot: vi.fn(async () => undefined)
    ,
    getMcpServerSettings: vi.fn(async (): Promise<McpServerSettings[]> => []),
    saveMcpServerSettings: vi.fn(async () => undefined),
    deleteMcpServerSettings: vi.fn(async () => undefined)
  };
  const secrets = {
    save: vi.fn(async () => undefined),
    readForProviderCall: vi.fn(async () => 'sk-private-service-value'),
    clear: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ kind: 'persisted' as const, encrypted: Buffer.from('old') })),
    restore: vi.fn(async () => undefined)
  };
  const provider: ModelProvider = {
    respond: vi.fn(async () => ({ type: 'text' as const, text: 'ok' }))
  };
  const providers = {
    create: vi.fn((
      _profile: ReturnType<typeof providerSnapshot>['profiles'][number],
      _getSecret: () => Promise<string>
    ) => provider)
  };
  const mcpStore = new McpServerStore();
  const mcpStoreMethods = {
    get: vi.spyOn(mcpStore, 'get'),
    list: vi.spyOn(mcpStore, 'list'),
    upsert: vi.spyOn(mcpStore, 'upsert'),
    remove: vi.spyOn(mcpStore, 'remove'),
    confirmStdioLaunch: vi.spyOn(mcpStore, 'confirmStdioLaunch'),
    setServerEnabled: vi.spyOn(mcpStore, 'setServerEnabled'),
    setToolEnabled: vi.spyOn(mcpStore, 'setToolEnabled')
  };
  const mcpManager = {
    connect: vi.fn(async (serverId: string) => ({
      serverId,
      tools: [
        {
          name: 'read-note',
          description: '读取笔记',
          inputSchema: { type: 'object' as const, properties: {} },
          annotations: { readOnlyHint: true }
        },
        {
          name: 'delete-note',
          description: '删除笔记',
          inputSchema: { type: 'object' as const, properties: {} },
          annotations: { destructiveHint: true }
        }
      ],
      resources: [],
      prompts: []
    })),
    disconnect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    toolRegistrations: vi.fn(() => []),
    executeTool: vi.fn(async () => ({ ok: true }))
  };
  const privacySessions = new PrivacySessionRegistry();
  const applyPetAlwaysOnTop = vi.fn<(enabled: boolean) => Promise<void>>(
    async () => undefined
  );
  const service = new DesktopSettingsService({
    settings,
    secrets,
    providers,
    mcpStore,
    mcpManager,
    privacySessions,
    sessionId: 'desktop-session',
    applyPetAlwaysOnTop
  });
  return {
    service,
    settings,
    secrets,
    providers,
    mcpStore,
    mcpStoreMethods,
    mcpManager,
    privacySessions,
    applyPetAlwaysOnTop,
    readStoredPetAlwaysOnTop: () => storedPetAlwaysOnTop,
    setStoredPetAlwaysOnTop: (enabled: boolean) => { storedPetAlwaysOnTop = enabled; }
  };
}

describe('DesktopSettingsService', () => {
  test('独立保存桌宠置顶偏好并立即应用运行态', async () => {
    const fixture = createFixture();

    const dashboard = await fixture.service.savePetAlwaysOnTop(true);

    expect(fixture.applyPetAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.settings.savePetAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(dashboard).toHaveProperty('petAlwaysOnTop', true);
    expect(fixture.settings.savePrivacySettings).not.toHaveBeenCalled();
  });

  test('运行态应用失败时恢复旧窗口与动态图层且不写磁盘', async () => {
    const fixture = createFixture();
    let runtime = false;
    let dynamicLayer = true;
    fixture.applyPetAlwaysOnTop.mockImplementation(async enabled => {
      runtime = enabled;
      dynamicLayer = !enabled;
    });
    fixture.applyPetAlwaysOnTop.mockImplementationOnce(async enabled => {
      runtime = enabled;
      dynamicLayer = !enabled;
      throw new Error('TOPMOST_APPLY_FAILED');
    });

    await expect(fixture.service.savePetAlwaysOnTop(true))
      .rejects.toThrow('TOPMOST_APPLY_FAILED');

    expect(runtime).toBe(false);
    expect(dynamicLayer).toBe(true);
    await expect(fixture.settings.getPetAlwaysOnTop()).resolves.toBe(false);
    expect(fixture.settings.savePetAlwaysOnTop).not.toHaveBeenCalled();
  });

  test('持久化失败时恢复旧窗口与动态图层', async () => {
    const fixture = createFixture();
    let runtime = false;
    let dynamicLayer = true;
    fixture.applyPetAlwaysOnTop.mockImplementation(async enabled => {
      runtime = enabled;
      dynamicLayer = !enabled;
    });
    fixture.settings.savePetAlwaysOnTop.mockRejectedValueOnce(new Error('PERSIST_FAILED'));

    await expect(fixture.service.savePetAlwaysOnTop(true)).rejects.toThrow('PERSIST_FAILED');

    expect(runtime).toBe(false);
    expect(dynamicLayer).toBe(true);
    await expect(fixture.settings.getPetAlwaysOnTop()).resolves.toBe(false);
    expect(fixture.applyPetAlwaysOnTop).toHaveBeenNthCalledWith(2, false);
  });

  test('持久化与回滚同时失败时返回包含两者的稳定聚合错误', async () => {
    const fixture = createFixture();
    const persistError = new Error('PERSIST_FAILED');
    const rollbackError = new Error('ROLLBACK_FAILED');
    fixture.settings.savePetAlwaysOnTop.mockRejectedValueOnce(persistError);
    fixture.applyPetAlwaysOnTop
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError);

    const failure = await fixture.service.savePetAlwaysOnTop(true).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('PET_ALWAYS_ON_TOP_PERSIST_ROLLBACK_FAILED');
    expect(failure.errors).toEqual([persistError, rollbackError]);
  });

  test('运行态应用与回滚同时失败时返回包含两者的稳定聚合错误', async () => {
    const fixture = createFixture();
    const applyError = new Error('APPLY_FAILED');
    const rollbackError = new Error('ROLLBACK_FAILED');
    fixture.applyPetAlwaysOnTop
      .mockRejectedValueOnce(applyError)
      .mockRejectedValueOnce(rollbackError);

    const failure = await fixture.service.savePetAlwaysOnTop(true).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('PET_ALWAYS_ON_TOP_APPLY_ROLLBACK_FAILED');
    expect(failure.errors).toEqual([applyError, rollbackError]);
    expect(fixture.settings.savePetAlwaysOnTop).not.toHaveBeenCalled();
  });

  test('并发置顶保存按到达顺序串行且后项失败回滚到前项已提交值', async () => {
    const fixture = createFixture();
    let runtime = false;
    let dynamicLayer = true;
    let releaseFirst = (): void => undefined;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    fixture.applyPetAlwaysOnTop.mockImplementation(async enabled => {
      if (enabled && runtime === false) await firstBlocked;
      runtime = enabled;
      dynamicLayer = !enabled;
    });
    fixture.settings.savePetAlwaysOnTop.mockImplementationOnce(async enabled => {
      fixture.setStoredPetAlwaysOnTop(enabled);
    });
    fixture.settings.savePetAlwaysOnTop.mockImplementationOnce(async () => {
      throw new Error('SECOND_PERSIST_FAILED');
    });

    const first = fixture.service.savePetAlwaysOnTop(true);
    await vi.waitFor(() => expect(fixture.applyPetAlwaysOnTop).toHaveBeenCalledTimes(1));
    const second = fixture.service.savePetAlwaysOnTop(false);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow('SECOND_PERSIST_FAILED');

    expect(runtime).toBe(true);
    expect(dynamicLayer).toBe(false);
    expect(fixture.readStoredPetAlwaysOnTop()).toBe(true);
  });

  test('冻结置顶队列后拒绝新保存并等待既有事务收敛且保持幂等', async () => {
    const fixture = createFixture();
    let release = (): void => undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    fixture.applyPetAlwaysOnTop.mockImplementationOnce(async () => blocked);

    const first = fixture.service.savePetAlwaysOnTop(true);
    const second = fixture.service.savePetAlwaysOnTop(false);
    await vi.waitFor(() => expect(fixture.applyPetAlwaysOnTop).toHaveBeenCalledOnce());
    const flush = fixture.service.freezeAndFlushPetAlwaysOnTop();
    expect(fixture.service.freezeAndFlushPetAlwaysOnTop()).toBe(flush);
    await expect(fixture.service.savePetAlwaysOnTop(true))
      .rejects.toThrow('PET_ALWAYS_ON_TOP_FROZEN');
    release();
    await Promise.all([first, second, flush]);
    expect(fixture.readStoredPetAlwaysOnTop()).toBe(false);
  });

  test('Dashboard 明确声明当前隐私能力的运行时支持范围', async () => {
    const fixture = createFixture();

    expect((await fixture.service.getDashboard()).privacyRuntimeSupport).toEqual({
      dataCategories: {
        file: true,
        screenshot: false,
        clipboard: false,
        memory: false
      },
      longTermMemory: false,
      proactivity: false
    });
  });

  test('恶意 MCP 自报 readOnlyHint 不能降低 Main 本地风险', () => {
    const resolveRisk = createTrustedMcpRiskResolver(() => undefined);

    expect(resolveRisk('evil-server', {
      name: 'claimed-read',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
    })).toBe('recoverable');
  });

  test('只有 Main 本地配置可以把指定 MCP 工具标记为 read', () => {
    const trustedTool = {
      name: 'echo',
      description: '只返回输入文本',
      inputSchema: { type: 'object' as const, properties: {} }
    };
    const trustedFingerprint = mcpToolDefinitionFingerprint(trustedTool);
    const resolveRisk = createTrustedMcpRiskResolver(
      (serverId, toolName) => (
        serverId === 'trusted-server' && toolName === 'echo'
          ? trustedFingerprint
          : undefined
      )
    );

    expect(resolveRisk('trusted-server', trustedTool)).toBe('read');
    expect(resolveRisk('trusted-server', {
      name: 'unknown',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
    })).toBe('recoverable');
    expect(resolveRisk('trusted-server', {
      ...trustedTool,
      description: '定义已经变化'
    })).toBe('recoverable');
  });

  test('保存档案按 profileId 写入密钥且 Dashboard 不含密钥正文', async () => {
    const fixture = createFixture();
    await fixture.service.saveProviderProfile({
      profile: {
        id: 'deepseek-agent',
        displayName: 'DeepSeek Agent',
        mode: 'preset',
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash'
      },
      secret: 'sk-new-private-value',
      persistSecret: true
    });

    expect(fixture.secrets.save).toHaveBeenCalledWith(
      'deepseek-agent',
      'sk-new-private-value',
      true
    );
    expect(fixture.settings.saveProviderProfile).toHaveBeenCalledWith({
      id: 'deepseek-agent',
      displayName: 'DeepSeek Agent',
      mode: 'preset',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      hasStoredSecret: true
    });
    expect(JSON.stringify(await fixture.service.getDashboard()))
      .not.toContain('sk-new-private-value');
  });

  test('Provider 密钥保存失败时恢复旧档案和旧密钥快照', async () => {
    const fixture = createFixture();
    fixture.secrets.save.mockRejectedValueOnce(new Error('SECRET_WRITE_FAILED'));

    await expect(fixture.service.saveProviderProfile({
      profile: {
        id: 'openai-main',
        displayName: '新端点',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://new.example.com/v1',
        modelId: 'new-model',
        additionalParameters: {}
      },
      secret: 'sk-new',
      persistSecret: true
    })).rejects.toThrow('SECRET_WRITE_FAILED');

    expect(fixture.settings.saveProviderProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'openai-main',
        displayName: 'OpenAI 主档案',
        providerId: 'openai'
      })
    );
    expect(fixture.secrets.restore).toHaveBeenCalledWith(
      'openai-main',
      expect.objectContaining({ kind: 'persisted' })
    );
  });

  test('Provider 设置保存失败时不写入新密钥', async () => {
    const fixture = createFixture();
    fixture.settings.saveProviderProfile.mockRejectedValueOnce(
      new Error('SETTINGS_WRITE_FAILED')
    );

    await expect(fixture.service.saveProviderProfile({
      profile: {
        id: 'openai-main',
        displayName: '新端点',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://new.example.com/v1',
        modelId: 'new-model',
        additionalParameters: {}
      },
      secret: 'sk-new',
      persistSecret: true
    })).rejects.toThrow('SETTINGS_WRITE_FAILED');

    expect(fixture.secrets.save).not.toHaveBeenCalled();
  });

  test('删除 Provider 时密钥清理失败会恢复档案、路由和旧密钥', async () => {
    const fixture = createFixture();
    fixture.secrets.clear.mockRejectedValueOnce(new Error('SECRET_CLEAR_FAILED'));

    await expect(
      fixture.service.deleteProviderProfile('openai-main')
    ).rejects.toThrow('SECRET_CLEAR_FAILED');

    expect(fixture.settings.saveProviderProfile).toHaveBeenCalledWith(
      providerSnapshot().profiles[0]
    );
    expect(fixture.settings.saveModelRoute).toHaveBeenCalledWith(providerSnapshot().route);
    expect(fixture.secrets.restore).toHaveBeenCalledWith(
      'openai-main',
      expect.objectContaining({ kind: 'persisted' })
    );
  });

  test('Provider 连接测试使用所选协议档案和对应密钥槽', async () => {
    const fixture = createFixture();

    await expect(fixture.service.testProviderProfile('openai-main')).resolves.toEqual({
      ok: true,
      message: '连接成功。'
    });
    expect(fixture.providers.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openai-main', providerId: 'openai' }),
      expect.any(Function)
    );
    const readSecret = fixture.providers.create.mock.calls[0]?.[1];
    await expect(readSecret?.()).resolves.toBe('sk-private-service-value');
    expect(fixture.secrets.readForProviderCall).toHaveBeenCalledWith('openai-main');
  });

  describe.skipIf(!desktopRuntimeCapabilities.mcp)(
    'MCP 运行时能力关闭前的历史服务行为',
    () => {

  test('stdio 保存只返回实际启动摘要，确认前不连接', async () => {
    const fixture = createFixture();

    const result = await fixture.service.upsertMcpServer({
      id: 'local-tools',
      enabled: true,
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['fixture.js'],
        cwd: process.cwd(),
        env: { TOKEN: 'private-token' },
        inheritEnv: []
      }
    });

    expect(result).toMatchObject({
      kind: 'confirmation_required',
      summary: {
        command: process.execPath,
        args: ['fixture.js'],
        explicitEnvNames: ['TOKEN']
      }
    });
    expect(fixture.mcpManager.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(fixture.secrets.save).toHaveBeenCalledWith(
      'mcp:local-tools',
      JSON.stringify({ env: { TOKEN: 'private-token' } }),
      true
    );
    expect(fixture.settings.saveMcpServerSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local-tools',
        transport: expect.objectContaining({ secretNames: ['TOKEN'] })
      })
    );
  });

  test('确认后未知工具即使自报只读也默认禁用', async () => {
    const fixture = createFixture();
    const saved = await fixture.service.upsertMcpServer({
      id: 'local-tools',
      enabled: true,
      transport: {
        type: 'stdio',
        command: process.execPath,
        cwd: process.cwd()
      }
    });
    if (saved.kind !== 'confirmation_required') throw new Error('缺少启动确认摘要');

    await fixture.service.confirmMcpLaunch('local-tools', saved.summary.fingerprint);
    await expect(fixture.service.testMcpServer('local-tools')).resolves.toEqual({
      ok: true,
      message: '发现 2 个工具。'
    });

    const config = fixture.mcpStore.get('local-tools');
    expect(config?.capabilities.tools).toEqual({
      'read-note': { enabled: false },
      'delete-note': { enabled: false }
    });
  });

  test('用户明确本地授权后按定义指纹标记 read 并原子启用', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' }
    });
    await fixture.service.testMcpServer('remote');

    await expect(
      fixture.service.setMcpToolEnabled('remote', 'read-note', true)
    ).rejects.toThrow('MCP_WRITE_TOOL_DISABLED');

    const dashboard = await fixture.service.authorizeMcpToolReadOnly(
      'remote',
      'read-note'
    );
    expect(dashboard.mcpServers[0]?.tools).toContainEqual(expect.objectContaining({
      name: 'read-note',
      readOnly: true,
      enabled: true
    }));
    expect(JSON.stringify(dashboard)).not.toContain('trustedReadFingerprint');

    expect(fixture.mcpStore.get('remote')?.capabilities.tools['read-note'])
      .toEqual(expect.objectContaining({
        enabled: true,
        trustedReadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }));
  });

  test('MCP 工具定义变化时本地只读授权自动失效并禁用工具', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' }
    });
    await fixture.service.testMcpServer('remote');
    await fixture.service.authorizeMcpToolReadOnly('remote', 'read-note');
    fixture.mcpManager.connect.mockResolvedValueOnce({
      serverId: 'remote',
      tools: [{
        name: 'read-note',
        description: '定义已经变化',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true }
      }],
      resources: [],
      prompts: []
    });

    await fixture.service.testMcpServer('remote');

    expect(fixture.mcpStore.get('remote')?.capabilities.tools['read-note'])
      .toEqual({ enabled: false });
    expect((await fixture.service.getDashboard()).mcpServers[0]?.tools[0])
      .toMatchObject({ readOnly: false, enabled: false });
  });

  test('撤销本地只读授权会禁用工具并清理持久指纹', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' }
    });
    await fixture.service.testMcpServer('remote');
    await fixture.service.authorizeMcpToolReadOnly('remote', 'read-note');

    const dashboard = await fixture.service.revokeMcpToolReadOnly('remote', 'read-note');

    expect(fixture.mcpStore.get('remote')?.capabilities.tools['read-note'])
      .toEqual({ enabled: false });
    expect(dashboard.mcpServers[0]?.tools).toContainEqual(expect.objectContaining({
      name: 'read-note',
      readOnly: false,
      enabled: false
    }));
  });

  test('删除 MCP 服务先断开连接再移除配置', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer private-header' }
      }
    });

    await fixture.service.deleteMcpServer('remote-tools');

    expect(fixture.mcpManager.disconnect).toHaveBeenCalledWith('remote-tools');
    expect(fixture.mcpStore.get('remote-tools')).toBeUndefined();
    expect(fixture.settings.deleteMcpServerSettings).toHaveBeenCalledWith('remote-tools');
    expect(fixture.secrets.clear).toHaveBeenCalledWith('mcp:remote-tools');
    expect(fixture.mcpStore.list()).toEqual([]);
  });

  test('删除 MCP 时密钥清理失败会恢复持久配置和旧密钥', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'secret' }
      }
    });
    fixture.settings.saveMcpServerSettings.mockClear();
    fixture.secrets.clear.mockRejectedValueOnce(new Error('SECRET_CLEAR_FAILED'));

    await expect(fixture.service.deleteMcpServer('remote'))
      .rejects.toThrow('SECRET_CLEAR_FAILED');

    expect(fixture.mcpStore.get('remote')).toBeDefined();
    expect(fixture.settings.saveMcpServerSettings).toHaveBeenCalledOnce();
    expect(fixture.secrets.restore).toHaveBeenCalledWith(
      'mcp:remote',
      expect.objectContaining({ kind: 'persisted' })
    );
  });

  test('更新 MCP 服务时断开失败则保留原配置', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://first.example.com'
      }
    });
    fixture.mcpManager.disconnect.mockRejectedValueOnce(new Error('MCP_CLOSE_FAILED'));

    await expect(fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://second.example.com'
      }
    })).rejects.toThrow('MCP_CLOSE_FAILED');
    expect(fixture.mcpStore.get('remote-tools')?.transport).toEqual({
      type: 'http',
      url: 'https://first.example.com'
    });
  });

  test('MCP 密钥写入失败时恢复旧内存配置且不持久化新端点', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://first.example.com',
        headers: { Authorization: 'old-secret' }
      }
    });
    fixture.settings.saveMcpServerSettings.mockClear();
    fixture.secrets.save.mockRejectedValueOnce(new Error('SECRET_WRITE_FAILED'));

    await expect(fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://second.example.com',
        headers: { Authorization: 'new-secret' }
      }
    })).rejects.toThrow('SECRET_WRITE_FAILED');

    expect(fixture.mcpStore.get('remote-tools')?.transport).toMatchObject({
      type: 'http',
      url: 'https://first.example.com'
    });
    expect(fixture.settings.saveMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.secrets.restore).toHaveBeenCalled();
  });

  test('MCP 设置持久化失败时恢复旧配置和旧密钥快照', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://first.example.com',
        headers: { Authorization: 'old-secret' }
      }
    });
    fixture.settings.saveMcpServerSettings.mockRejectedValueOnce(
      new Error('SETTINGS_WRITE_FAILED')
    );

    await expect(fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://second.example.com',
        headers: { Authorization: 'new-secret' }
      }
    })).rejects.toThrow('SETTINGS_WRITE_FAILED');

    expect(fixture.mcpStore.get('remote-tools')?.transport).toMatchObject({
      type: 'http',
      url: 'https://first.example.com'
    });
    expect(fixture.secrets.restore).toHaveBeenCalledWith(
      'mcp:remote-tools',
      expect.objectContaining({ kind: 'persisted' })
    );
  });

  test('禁用 MCP 时断开失败不伪造状态或持久化禁用值', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com'
      }
    });
    await fixture.service.testMcpServer('remote-tools');
    const persistedBefore = fixture.settings.saveMcpServerSettings.mock.calls.length;
    fixture.mcpManager.disconnect.mockRejectedValueOnce(new Error('MCP_CLOSE_FAILED'));

    await expect(
      fixture.service.setMcpServerEnabled('remote-tools', false)
    ).rejects.toThrow('MCP_CLOSE_FAILED');

    expect(fixture.mcpStore.get('remote-tools')?.enabled).toBe(true);
    expect(fixture.settings.saveMcpServerSettings).toHaveBeenCalledTimes(persistedBefore);
    expect((await fixture.service.getDashboard()).mcpServers[0]).toMatchObject({
      enabled: true,
      status: 'connected'
    });
  });

  test('禁用 MCP 持久化失败时恢复启用配置但保持实际断开状态', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' }
    });
    fixture.settings.saveMcpServerSettings.mockRejectedValueOnce(
      new Error('SETTINGS_WRITE_FAILED')
    );

    await expect(fixture.service.setMcpServerEnabled('remote', false))
      .rejects.toThrow('SETTINGS_WRITE_FAILED');

    expect(fixture.mcpStore.get('remote')).toMatchObject({ enabled: true });
    expect((await fixture.service.getDashboard()).mcpServers[0]).toMatchObject({
      enabled: true,
      status: 'disconnected'
    });
  });

  test('MCP 工具发现持久化失败时恢复发现前配置并断开连接', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' }
    });
    fixture.settings.saveMcpServerSettings.mockRejectedValueOnce(
      new Error('SETTINGS_WRITE_FAILED')
    );

    await expect(fixture.service.testMcpServer('remote')).resolves.toEqual({
      ok: false,
      message: 'MCP 连接失败，请检查配置。'
    });

    expect(fixture.mcpStore.get('remote')?.capabilities.tools).toEqual({});
    expect(fixture.mcpManager.disconnect).toHaveBeenCalledWith('remote');
    expect((await fixture.service.getDashboard()).mcpServers[0]?.tools).toEqual([]);
  });
    }
  );

  test('无痕切换是 Main 会话动作而非持久设置', async () => {
    const fixture = createFixture();

    await expect(fixture.service.setIncognitoSession(true)).resolves.toEqual({
      incognito: true
    });
    expect(fixture.privacySessions.isLongTermMemoryAllowed('desktop-session')).toBe(false);
    expect(fixture.settings.savePrivacySettings).not.toHaveBeenCalled();
  });

  describe.skipIf(!desktopRuntimeCapabilities.mcp)(
    'MCP 运行时能力关闭前的 Dashboard 行为',
    () => {

  test('Dashboard 使用内置目录并只公开 MCP 认证字段名', async () => {
    const fixture = createFixture();
    await fixture.service.upsertMcpServer({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer private-header' }
      }
    });

    const dashboard = await fixture.service.getDashboard();

    expect(dashboard.catalog).toEqual(providerCatalog);
    expect(dashboard.mcpServers).toEqual([
      expect.objectContaining({
        id: 'remote-tools',
        transport: expect.objectContaining({
          type: 'http',
          secretNames: ['Authorization']
        })
      })
    ]);
    expect(JSON.stringify(dashboard)).not.toContain('Bearer private-header');
  });
    }
  );
});

describe('MCP 运行时能力边界', () => {
  test('MCP 禁用时初始化、Dashboard 和工具注册不恢复数据', async () => {
    const fixture = createFixture();
    fixture.settings.getMcpServerSettings.mockResolvedValueOnce([{
      id: 'server-1',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        secretNames: ['Authorization']
      },
      tools: {
        'read-note': {
          enabled: true,
          readOnly: true,
          description: '读取笔记',
          definitionFingerprint: 'fingerprint'
        }
      }
    }]);

    await fixture.service.initialize();

    expect(fixture.settings.getMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.secrets.readForProviderCall).not.toHaveBeenCalled();
    expect(fixture.mcpStore.list()).toEqual([]);
    expect((await fixture.service.getDashboard()).mcpServers).toEqual([]);
    expect(await fixture.service.enabledReadToolRegistrations()).toEqual([]);
    expect(fixture.mcpManager.connect).not.toHaveBeenCalled();
    expect(fixture.settings.saveMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.settings.deleteMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.secrets.save).not.toHaveBeenCalled();
    expect(fixture.secrets.clear).not.toHaveBeenCalled();

    const populatedFixture = createFixture();
    populatedFixture.mcpStore.upsert({
      id: 'server-1',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.com' },
      capabilities: {
        tools: {},
        resources: { enabled: false },
        prompts: { enabled: false }
      }
    });
    populatedFixture.mcpStoreMethods.list.mockClear();

    expect((await populatedFixture.service.getDashboard()).mcpServers).toEqual([]);
    expect(await populatedFixture.service.enabledReadToolRegistrations()).toEqual([]);
    expect(populatedFixture.mcpStoreMethods.list).not.toHaveBeenCalled();
    expect(populatedFixture.mcpManager.connect).not.toHaveBeenCalled();
  });

  test('MCP 禁用时所有操作统一拒绝且不产生副作用', async () => {
    const fixture = createFixture();
    const input = {
      id: 'server-1',
      enabled: true,
      transport: {
        type: 'http' as const,
        url: 'https://mcp.example.com',
        headers: { Authorization: 'private-token' }
      }
    };
    const operations = [
      () => fixture.service.upsertMcpServer(input),
      () => fixture.service.confirmMcpLaunch('server-1', 'fingerprint'),
      () => fixture.service.testMcpServer('server-1'),
      () => fixture.service.setMcpServerEnabled('server-1', true),
      () => fixture.service.setMcpToolEnabled('server-1', 'read-note', true),
      () => fixture.service.authorizeMcpToolReadOnly('server-1', 'read-note'),
      () => fixture.service.revokeMcpToolReadOnly('server-1', 'read-note'),
      () => fixture.service.deleteMcpServer('server-1'),
      () => fixture.service.executeMcpRead('mcp.server-1.read-note', {})
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toThrow('MCP_MODULE_DISABLED');
    }

    expect(fixture.settings.getMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.settings.saveMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.settings.deleteMcpServerSettings).not.toHaveBeenCalled();
    expect(fixture.secrets.readForProviderCall).not.toHaveBeenCalled();
    expect(fixture.secrets.snapshot).not.toHaveBeenCalled();
    expect(fixture.secrets.save).not.toHaveBeenCalled();
    expect(fixture.secrets.clear).not.toHaveBeenCalled();
    expect(fixture.secrets.restore).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.get).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.list).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.upsert).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.remove).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.confirmStdioLaunch).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.setServerEnabled).not.toHaveBeenCalled();
    expect(fixture.mcpStoreMethods.setToolEnabled).not.toHaveBeenCalled();
    expect(fixture.mcpManager.connect).not.toHaveBeenCalled();
    expect(fixture.mcpManager.disconnect).not.toHaveBeenCalled();
    expect(fixture.mcpManager.executeTool).not.toHaveBeenCalled();

    await fixture.service.setIncognitoSession(true);
    expect(fixture.privacySessions.isRegistered('desktop-session')).toBe(true);

    await fixture.service.close();
    expect(fixture.mcpManager.close).toHaveBeenCalledOnce();
    expect(fixture.privacySessions.isRegistered('desktop-session')).toBe(false);
  });
});
