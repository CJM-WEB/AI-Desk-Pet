import type { ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { DesktopSettingsService } from '../src/main/settings/desktop-settings-service';

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
  const privacySessions = new PrivacySessionRegistry();
  const applyPetAlwaysOnTop = vi.fn<(enabled: boolean) => Promise<void>>(
    async () => undefined
  );
  const options = {
    settings,
    secrets,
    providers,
    privacySessions,
    sessionId: 'desktop-session',
    applyPetAlwaysOnTop
  };
  const service = new DesktopSettingsService(options);
  return {
    service,
    options,
    settings,
    secrets,
    providers,
    privacySessions,
    applyPetAlwaysOnTop,
    readStoredPetAlwaysOnTop: () => storedPetAlwaysOnTop,
    setStoredPetAlwaysOnTop: (enabled: boolean) => { storedPetAlwaysOnTop = enabled; }
  };
}

describe('DesktopSettingsService', () => {
  test('正式设置服务依赖不含 MCP Manager 或 Store', () => {
    const optionKeys = Object.keys(createFixture().options);

    for (const key of ['mcpStore', 'mcpManager']) {
      expect(optionKeys).not.toContain(key);
    }
  });

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

  test('无痕切换是 Main 会话动作而非持久设置', async () => {
    const fixture = createFixture();

    await expect(fixture.service.setIncognitoSession(true)).resolves.toEqual({
      incognito: true
    });
    expect(fixture.privacySessions.isLongTermMemoryAllowed('desktop-session')).toBe(false);
    expect(fixture.settings.savePrivacySettings).not.toHaveBeenCalled();
  });

});
