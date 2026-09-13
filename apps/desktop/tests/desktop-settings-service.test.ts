import type { ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { DesktopSettingsService } from '../src/main/settings/desktop-settings-service';
import type { LocalModelPublicStatus } from '../src/shared/local-model-ipc';
import { DEFAULT_WORKSHOP_LAYOUT } from '../src/shared/workshop-layout-ipc';
import type { IpcMain } from 'electron';
import { CharacterExpressionEngine, characterManifestV3Schema } from '@myself/character-runtime';
import { v3Fixture, resourceFields } from '../../../packages/character-runtime/tests/character-v3-fixture';
import { registerAdvancedSettingsIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import { ModelChangeCoordinator } from '../src/main/settings/model-change-coordinator';

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
  let behaviorSettings: {
    movementMode: 0 | 1 | 2;
    proactivityMode: 'passive' | 'assistive' | 'autonomous';
  } = {
    movementMode: 2,
    proactivityMode: 'assistive' as const
  };
  const settings = {
    getProviderSettings: vi.fn(async () => providerSnapshot()),
    saveProviderProfile: vi.fn(async () => undefined),
    deleteProviderProfile: vi.fn(async () => undefined),
    saveModelRoute: vi.fn(async () => undefined),
    getPrivacySettings: vi.fn(async () => ({
      autonomousMoodEnabled: true,
      dataCategories: {
        memory: false
      },
      longTermMemory: false,
      proactivityMode: 'assistive' as const
    })),
    savePrivacySettings: vi.fn(async (input: {
      proactivityMode: 'passive' | 'assistive' | 'autonomous';
    }) => {
      behaviorSettings = { ...behaviorSettings, proactivityMode: input.proactivityMode };
      return Object.freeze({ ...behaviorSettings });
    }),
    saveMovementMode: vi.fn(async (movementMode: 0 | 1 | 2) => {
      behaviorSettings = { ...behaviorSettings, movementMode };
      return Object.freeze({ ...behaviorSettings });
    }),
    getWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT),
    saveWorkshopLayout: vi.fn(async input => input),
    getPetAlwaysOnTop: vi.fn(async () => storedPetAlwaysOnTop),
    savePetAlwaysOnTop: vi.fn(async (enabled: boolean) => {
      storedPetAlwaysOnTop = enabled;
    }),
    getPublic: vi.fn(async () => ({
      version: 1 as const,
      provider: null,
      authorizedRoot: null,
      petPosition: null
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
  const applyCharacterBehaviorSettings = vi.fn();
  const applyAutonomousMoodEnabled = vi.fn();
  const localModelStatus: LocalModelPublicStatus = {
    enabled: true,
    phase: 'ready',
    backend: 'vulkan',
    reasonCode: null
  };
  const localModel = {
    getStatus: vi.fn(() => localModelStatus),
    setEnabled: vi.fn(async () => undefined)
  };
  const confirmModelChange = vi.fn(async () => true);
  const invalidateConfiguration = vi.fn<() => Promise<void>>(async () => undefined);
  const onModelChanged = vi.fn(async () => undefined);
  const onIncognitoChanged = vi.fn<(enabled: boolean) => Promise<void>>(async () => undefined);
  const modelChanges = new ModelChangeCoordinator({
    readConfiguration: async () => ({ ...await settings.getProviderSettings(), localModelEnabled: localModel.getStatus().enabled }),
    confirmModelChange, invalidateConfiguration, onModelChanged
  });
  const options = {
    settings,
    secrets,
    providers,
    privacySessions,
    sessionId: 'desktop-session',
    localModel,
    modelChanges,
    onIncognitoChanged,
    applyPetAlwaysOnTop,
    applyCharacterBehaviorSettings,
    applyAutonomousMoodEnabled
  };
  const service = new DesktopSettingsService(options);
  return {
    service,
    options,
    settings,
    secrets,
    providers,
    provider,
    privacySessions,
    applyPetAlwaysOnTop,
    applyCharacterBehaviorSettings,
    localModel,
    confirmModelChange,
    invalidateConfiguration,
    onModelChanged,
    onIncognitoChanged,
    readStoredPetAlwaysOnTop: () => storedPetAlwaysOnTop,
    setStoredPetAlwaysOnTop: (enabled: boolean) => { storedPetAlwaysOnTop = enabled; }
  };
}

describe('DesktopSettingsService', () => {
  test('取消活动模型档案更新、删除和路由切换时保留设置密钥与旧对话', async () => {
    const f = createFixture();
    f.localModel.getStatus.mockReturnValue({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
    f.confirmModelChange.mockResolvedValue(false);
    await expect(f.service.saveProviderProfile({ profile: { ...providerSnapshot().profiles[0]!, modelId: 'new-model' }, secret: 'new-secret', persistSecret: true })).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    await expect(f.service.deleteProviderProfile('openai-main')).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    await expect(f.service.saveModelRoute({ ...providerSnapshot().route, primaryProfileId: null, agentProfileId: null })).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    expect(f.confirmModelChange).toHaveBeenCalledTimes(3);
    expect(f.settings.saveProviderProfile).not.toHaveBeenCalled();
    expect(f.settings.deleteProviderProfile).not.toHaveBeenCalled();
    expect(f.settings.saveModelRoute).not.toHaveBeenCalled();
    expect(f.secrets.save).not.toHaveBeenCalled(); expect(f.secrets.clear).not.toHaveBeenCalled();
    expect(f.invalidateConfiguration).not.toHaveBeenCalled(); expect(f.onModelChanged).not.toHaveBeenCalled();
  });

  test('无痕开关先应用会话隐私并等待存储hook完成才返回', async () => {
    const f = createFixture(); let release!: () => void; let settled = false;
    f.onIncognitoChanged.mockImplementation(async () => {
      expect(f.privacySessions.isLongTermMemoryAllowed('desktop-session')).toBe(false);
      await new Promise<void>(resolve => { release = resolve; });
    });
    const changing = f.service.setIncognitoSession(true).then(() => { settled = true; });
    await vi.waitFor(() => expect(f.onIncognitoChanged).toHaveBeenCalledWith(true));
    expect(settled).toBe(false); release(); await changing;
  });

  test('Qwen覆盖期间保存云配置不确认不清空，但提交前等待旧运行失效', async () => {
    const f = createFixture(); let release!: () => void;
    f.invalidateConfiguration.mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
    const saved = f.service.saveModelRoute({ ...providerSnapshot().route, primaryProfileId: null });
    await vi.waitFor(() => expect(f.invalidateConfiguration).toHaveBeenCalledOnce());
    expect(f.settings.saveModelRoute).not.toHaveBeenCalled(); release(); await saved;
    expect(f.settings.saveModelRoute).toHaveBeenCalledOnce();
    expect(f.confirmModelChange).not.toHaveBeenCalled(); expect(f.onModelChanged).not.toHaveBeenCalled();
  });
  test('同一隐私 IPC 关闭自主心情保留已有心情，既有隐私变化仍重置', async () => {
    const f = createFixture();
    const engine = new CharacterExpressionEngine({ manifest: characterManifestV3Schema.parse({ ...v3Fixture(), ...resourceFields }), now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'chat', source: 'chat', moodUpdate: { summary: '开心', strength: 1 } });
    const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
    const ipc = { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, handler: (event: unknown, raw: unknown) => unknown) => handlers.set(name, handler) } as unknown as IpcMain;
    const reset = vi.fn(() => { engine.reset(); });
    registerAdvancedSettingsIpc(ipc, f.service, { onConfigurationChanged: reset });
    const save = handlers.get(ipcChannels.settingsPrivacySave)!;
    const input = { dataCategories: { memory: false }, longTermMemory: false, proactivityMode: 'assistive', autonomousMoodEnabled: false };
    await expect(save({}, input)).resolves.toBeDefined();
    expect(engine.snapshot().mood?.summary).toBe('开心');
    expect(reset).not.toHaveBeenCalled();
    expect(f.options.applyAutonomousMoodEnabled).toHaveBeenCalledWith(false);
    await save({}, { ...input, proactivityMode: 'passive' });
    expect(reset).toHaveBeenCalledOnce();
    expect(engine.snapshot().mood).toBeNull();
  });
  test('正式设置服务依赖不含 MCP Manager 或 Store', () => {
    const optionKeys = Object.keys(createFixture().options);

    for (const key of ['mcpStore', 'mcpManager']) {
      expect(optionKeys).not.toContain(key);
    }
  });

  test('本地模型设置边界只接收公开状态与开关动作', async () => {
    const fixture = createFixture();

    const dashboard = await fixture.service.setLocalModelEnabled(false);

    expect(fixture.localModel.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(dashboard.localModel).toEqual({
      enabled: true,
      phase: 'ready',
      backend: 'vulkan',
      reasonCode: null
    });
    expect(Object.keys(fixture.options.localModel)).toEqual(['getStatus', 'setEnabled']);
    expect(JSON.stringify(dashboard.localModel)).not.toMatch(/port|token|path|pid|stderr/iu);
  });

  test('Dashboard 严格拒绝混入本地模型私有连接字段的状态', async () => {
    const fixture = createFixture();
    fixture.localModel.getStatus.mockReturnValueOnce({
      enabled: true,
      phase: 'ready',
      backend: 'cpu',
      reasonCode: null,
      port: 43123
    } as unknown as LocalModelPublicStatus);

    await expect(fixture.service.getDashboard()).rejects.toThrow();
  });

  test('独立保存桌宠置顶偏好并立即应用运行态', async () => {
    const fixture = createFixture();

    const dashboard = await fixture.service.savePetAlwaysOnTop(true);

    expect(fixture.applyPetAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.settings.savePetAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(dashboard).toHaveProperty('petAlwaysOnTop', true);
    expect(fixture.settings.savePrivacySettings).not.toHaveBeenCalled();
  });

  test('隐私档位成功原子落盘后才把完整快照通知行为 Director', async () => {
    const fixture = createFixture();

    await fixture.service.savePrivacySettings({
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivityMode: 'passive'
    });

    expect(fixture.applyCharacterBehaviorSettings).toHaveBeenCalledExactlyOnceWith({
      movementMode: 2,
      proactivityMode: 'passive'
    });
    expect(fixture.settings.savePrivacySettings.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.applyCharacterBehaviorSettings.mock.invocationCallOrder[0]!);
  });

  test('本地 Gate 保存停止状态成功后才通知同一行为快照 sink', async () => {
    const fixture = createFixture();

    await fixture.service.saveMovementMode(0);

    expect(fixture.applyCharacterBehaviorSettings).toHaveBeenCalledExactlyOnceWith({
      movementMode: 0,
      proactivityMode: 'assistive'
    });
    expect(fixture.settings.saveMovementMode.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.applyCharacterBehaviorSettings.mock.invocationCallOrder[0]!);
  });

  test('停止状态落盘失败时不通知行为快照 sink', async () => {
    const fixture = createFixture();
    fixture.settings.saveMovementMode.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await expect(fixture.service.saveMovementMode(0)).rejects.toThrow('WRITE_FAILED');

    expect(fixture.applyCharacterBehaviorSettings).not.toHaveBeenCalled();
  });

  test('运动轮次在落盘返回前失效时不应用迟到行为快照', async () => {
    const fixture = createFixture();
    let current = true;
    fixture.settings.saveMovementMode.mockImplementationOnce(async movementMode => {
      current = false;
      return { movementMode, proactivityMode: 'assistive' };
    });

    await fixture.service.saveMovementMode(1, () => current);

    expect(fixture.applyCharacterBehaviorSettings).not.toHaveBeenCalled();
  });

  test('隐私档位落盘失败时不通知行为快照 sink', async () => {
    const fixture = createFixture();
    fixture.settings.savePrivacySettings.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await expect(fixture.service.savePrivacySettings({
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivityMode: 'autonomous'
    })).rejects.toThrow('WRITE_FAILED');

    expect(fixture.applyCharacterBehaviorSettings).not.toHaveBeenCalled();
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
        memory: false
      },
      longTermMemory: false,
      proactivity: true
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
