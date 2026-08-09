import { describe, expect, test, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { HabitatSettingsService } from '../src/main/habitat/habitat-settings-service';
import { registerHabitatIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import {
  habitatDashboardSchema,
  habitatDirectoryIdInputSchema,
  habitatDirectoryToggleInputSchema,
  habitatEmptyInputSchema,
  habitatPreferencesInputSchema,
  type HabitatDashboardDto
} from '../src/shared/habitat-ipc';
import type { PetHabitatSnapshot } from '../src/main/habitat/pet-habitat-store';

const dashboard: HabitatDashboardDto = {
  enabled: true,
  autoHideEnabled: false,
  idleDelayMs: 30_000,
  directories: [{
    id: 'directory-1',
    displayName: '项目空间',
    pathHint: 'project',
    enabled: true,
    availability: 'available'
  }],
  current: {
    kind: 'folder',
    directoryId: 'directory-1',
    visibility: 'hidden'
  },
  busyReason: null,
  errorCode: null
};

describe('Habitat 共享 IPC Schema', () => {
  test('所有命令输入拒绝未知字段和 Renderer 私有参数', () => {
    expect(habitatEmptyInputSchema.safeParse({ absolutePath: 'C:\\private' }).success)
      .toBe(false);
    expect(habitatDirectoryIdInputSchema.safeParse({
      directoryId: 'directory-1',
      hwnd: '123'
    }).success).toBe(false);
    expect(habitatDirectoryToggleInputSchema.safeParse({
      directoryId: 'directory-1',
      enabled: true,
      x: 10,
      y: 20
    }).success).toBe(false);
    expect(habitatPreferencesInputSchema.safeParse({
      enabled: true,
      autoHideEnabled: false,
      idleDelayMs: 30_000,
      bridgeCommand: 'attach'
    }).success).toBe(false);
  });

  test('目录标识仅接受稳定不透明标识', () => {
    expect(habitatDirectoryIdInputSchema.parse({
      directoryId: 'directory_1-safe'
    })).toEqual({ directoryId: 'directory_1-safe' });
    expect(habitatDirectoryIdInputSchema.safeParse({
      directoryId: 'C:\\Users\\Alice\\project'
    }).success).toBe(false);
  });

  test('Dashboard 只接受公开目录提示和公开空间状态', () => {
    expect(habitatDashboardSchema.parse(dashboard)).toEqual(dashboard);
    expect(habitatDashboardSchema.safeParse({
      ...dashboard,
      directories: [{
        ...dashboard.directories[0],
        absolutePath: 'C:\\Users\\Alice\\project',
        identity: { dev: 1, ino: 2 }
      }]
    }).success).toBe(false);
    expect(habitatDashboardSchema.safeParse({
      ...dashboard,
      internalState: 'revealing',
      explorerHwnd: '123'
    }).success).toBe(false);
  });
});

function serviceHarness(options: {
  selectedPath?: string | null;
  state?: 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost' | 'entering';
  operation?: 'enter' | 'recall' | 'summon' | 'availability' | null;
} = {}) {
  let stored: PetHabitatSnapshot = {
    version: 1,
    preferences: {
      enabled: true,
      autoHideEnabled: false,
      idleDelayMs: 30_000
    },
    directories: [{
      id: 'directory-1',
      displayName: '项目空间',
      pathHint: 'project',
      absolutePath: 'C:\\Users\\Alice\\project',
      identity: { dev: 1, ino: 2 },
      enabled: true
    }],
    location: { kind: 'desktop', position: null }
  };
  const store = {
    load: vi.fn(async () => structuredClone(stored)),
    save: vi.fn(async (next: PetHabitatSnapshot) => {
      stored = structuredClone(next);
    }),
    updatePreferences: vi.fn(async (preferences: PetHabitatSnapshot['preferences']) => {
      stored = { ...stored, preferences: structuredClone(preferences) };
    }),
    addDirectory: vi.fn(async (directory: PetHabitatSnapshot['directories'][number]) => {
      stored = { ...stored, directories: [...stored.directories, structuredClone(directory)] };
      return 'added' as const;
    }),
    setDirectoryEnabled: vi.fn(async (directoryId: string, enabled: boolean) => {
      const index = stored.directories.findIndex(directory => directory.id === directoryId);
      if (index < 0) return 'missing' as const;
      const directories = stored.directories.slice();
      directories[index] = { ...directories[index]!, enabled };
      stored = { ...stored, directories };
      return 'updated' as const;
    }),
    removeDirectory: vi.fn(async (directoryId: string) => {
      if (!stored.directories.some(directory => directory.id === directoryId)) {
        return 'missing' as const;
      }
      if (
        stored.location.kind === 'folder'
        && stored.location.directoryId === directoryId
      ) return 'in-use' as const;
      stored = {
        ...stored,
        directories: stored.directories.filter(directory => directory.id !== directoryId)
      };
      return 'removed' as const;
    })
  };
  const directoryPolicy = {
    authorize: vi.fn(async () => ({
      id: 'directory-2',
      displayName: '资料空间',
      pathHint: 'docs',
      absolutePath: 'D:\\Private\\docs',
      identity: { dev: 3, ino: 4 },
      enabled: true
    })),
    availability: vi.fn(async () => 'available' as const)
  };
  const habitat = {
    snapshot: vi.fn(() => ({
      state: options.state ?? 'desktop',
      directoryId: options.state?.startsWith('folder') ? 'directory-1' : null,
      operation: options.operation ?? null,
      closed: false
    })),
    enterDirectory: vi.fn(async () => undefined),
    summon: vi.fn(async () => undefined),
    recallToDesktop: vi.fn(async () => undefined)
  };
  const chooseDirectory = vi.fn(async () => options.selectedPath ?? null);
  const service = new HabitatSettingsService({
    store,
    directoryPolicy,
    habitat,
    chooseDirectory
  });
  return {
    service,
    store,
    directoryPolicy,
    habitat,
    chooseDirectory,
    readStored: () => structuredClone(stored),
    replaceStored: (next: PetHabitatSnapshot) => { stored = structuredClone(next); }
  };
}

describe('HabitatSettingsService', () => {
  test('Dashboard 仅投影公开目录提示并把在途操作映射为具体忙碌原因', async () => {
    const harness = serviceHarness({ state: 'entering', operation: 'enter' });

    const result = await harness.service.getDashboard();
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      enabled: true,
      current: { kind: 'desktop' },
      busyReason: 'entering'
    });
    expect(serialized).not.toContain('absolutePath');
    expect(serialized).not.toContain('C:\\Users');
    expect(serialized).not.toMatch(/\b(?:dev|ino|identity|operation|closed)\b/u);
  });

  test('目录选择取消不写入，选中后只把绝对路径交给 Policy 授权', async () => {
    const cancelled = serviceHarness();
    await expect(cancelled.service.chooseAndAddDirectory()).resolves.toMatchObject({
      kind: 'cancelled'
    });
    expect(cancelled.directoryPolicy.authorize).not.toHaveBeenCalled();
    expect(cancelled.store.save).not.toHaveBeenCalled();

    const added = serviceHarness({ selectedPath: 'D:\\Private\\docs' });
    const result = await added.service.chooseAndAddDirectory();

    expect(added.directoryPolicy.authorize).toHaveBeenCalledWith(
      'D:\\Private\\docs',
      expect.arrayContaining([expect.objectContaining({ id: 'directory-1' })])
    );
    expect(result).toMatchObject({
      kind: 'added',
      dashboard: {
        directories: expect.arrayContaining([
          expect.objectContaining({ id: 'directory-2', pathHint: 'docs' })
        ])
      }
    });
    expect(JSON.stringify(result)).not.toContain('D:\\Private');
  });

  test('统一保存三项偏好并只修改目录配置记录', async () => {
    const harness = serviceHarness();

    await harness.service.savePreferences({
      enabled: false,
      autoHideEnabled: true,
      idleDelayMs: 90_000
    });
    expect(harness.readStored().preferences).toEqual({
      enabled: false,
      autoHideEnabled: true,
      idleDelayMs: 90_000
    });

    await harness.service.setDirectoryEnabled('directory-1', false);
    expect(harness.readStored().directories[0]?.enabled).toBe(false);

    await harness.service.removeDirectory('directory-1');
    expect(harness.readStored().directories).toEqual([]);
  });

  test('所有设置写入只调用封闭原子 Store 端口', async () => {
    const harness = serviceHarness({ selectedPath: 'D:\\Private\\docs' });

    await harness.service.savePreferences({
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 60_000
    });
    await harness.service.setDirectoryEnabled('directory-1', false);
    await harness.service.chooseAndAddDirectory();
    await harness.service.removeDirectory('directory-1');

    expect(harness.store.updatePreferences).toHaveBeenCalledOnce();
    expect(harness.store.setDirectoryEnabled).toHaveBeenCalledWith('directory-1', false);
    expect(harness.store.addDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'directory-2' })
    );
    expect(harness.store.removeDirectory).toHaveBeenCalledWith('directory-1');
    expect(harness.store.save).not.toHaveBeenCalled();
  });

  test('拒绝删除当前目录配置且不泄露依赖异常细节', async () => {
    const harness = serviceHarness();
    const current = harness.readStored();
    current.location = {
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-09T00:00:00.000Z',
      previousDesktopPosition: { x: 1, y: 2 },
      localOffset: { x: 3, y: 4 }
    };
    harness.replaceStored(current);

    await expect(harness.service.removeDirectory('directory-1')).rejects.toMatchObject({
      code: 'HABITAT_DIRECTORY_IN_USE',
      message: 'HABITAT_DIRECTORY_IN_USE'
    });
    harness.store.load.mockRejectedValueOnce(new Error('C:\\Private\\secret'));
    await expect(harness.service.getDashboard()).rejects.toMatchObject({
      code: 'HABITAT_OPERATION_FAILED',
      message: 'HABITAT_OPERATION_FAILED'
    });
  });

  test('功能或目录停用时拒绝进入，已知忙碌错误保持稳定码', async () => {
    const harness = serviceHarness();
    const disabled = harness.readStored();
    disabled.preferences.enabled = false;
    harness.replaceStored(disabled);
    await expect(harness.service.enterDirectory('directory-1')).rejects.toMatchObject({
      code: 'HABITAT_DISABLED'
    });

    disabled.preferences.enabled = true;
    disabled.directories[0]!.enabled = false;
    harness.replaceStored(disabled);
    await expect(harness.service.enterDirectory('directory-1')).rejects.toMatchObject({
      code: 'HABITAT_DIRECTORY_DISABLED'
    });

    disabled.directories[0]!.enabled = true;
    harness.replaceStored(disabled);
    harness.habitat.enterDirectory.mockRejectedValueOnce(new Error('HABITAT_OPERATION_BUSY'));
    await expect(harness.service.enterDirectory('directory-1')).rejects.toMatchObject({
      code: 'HABITAT_OPERATION_BUSY',
      message: 'HABITAT_OPERATION_BUSY'
    });
  });
});

type Handler = (event: unknown, input?: unknown) => unknown;

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function habitatIpcServiceDouble() {
  return {
    getDashboard: vi.fn(async () => dashboard),
    chooseAndAddDirectory: vi.fn(async () => ({
      kind: 'cancelled' as const,
      dashboard
    })),
    setDirectoryEnabled: vi.fn(async () => dashboard),
    removeDirectory: vi.fn(async () => dashboard),
    savePreferences: vi.fn(async () => dashboard),
    enterDirectory: vi.fn(async () => dashboard),
    summon: vi.fn(async () => dashboard),
    recall: vi.fn(async () => dashboard)
  };
}

describe('Habitat IPC 注册边界', () => {
  test('只注册计划内八项命令并将严格公开字段交给服务', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = habitatIpcServiceDouble();
    registerHabitatIpc(ipcMain, service);

    expect([...handlers.keys()]).toEqual([
      ipcChannels.habitatDashboardGet,
      ipcChannels.habitatDirectoryChoose,
      ipcChannels.habitatDirectoryToggle,
      ipcChannels.habitatDirectoryRemove,
      ipcChannels.habitatPreferencesSave,
      ipcChannels.habitatEnter,
      ipcChannels.habitatSummon,
      ipcChannels.habitatRecall
    ]);

    await handlers.get(ipcChannels.habitatDirectoryToggle)?.({}, {
      directoryId: 'directory-1',
      enabled: false
    });
    await handlers.get(ipcChannels.habitatPreferencesSave)?.({}, {
      enabled: true,
      autoHideEnabled: false,
      idleDelayMs: 30_000
    });
    await handlers.get(ipcChannels.habitatEnter)?.({}, { directoryId: 'directory-1' });

    expect(service.setDirectoryEnabled).toHaveBeenCalledWith('directory-1', false);
    expect(service.savePreferences).toHaveBeenCalledWith({
      enabled: true,
      autoHideEnabled: false,
      idleDelayMs: 30_000
    });
    expect(service.enterDirectory).toHaveBeenCalledWith('directory-1');
  });

  test('未知字段和私有控制参数在调用服务前稳定拒绝', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = habitatIpcServiceDouble();
    registerHabitatIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.habitatDashboardGet)?.({}, {
      absolutePath: 'C:\\Private'
    })).rejects.toMatchObject({
      code: 'HABITAT_INPUT_INVALID',
      message: 'HABITAT_INPUT_INVALID'
    });
    await expect(handlers.get(ipcChannels.habitatDirectoryToggle)?.({}, {
      directoryId: 'directory-1',
      enabled: true,
      actionToken: 'private-token'
    })).rejects.toMatchObject({ code: 'HABITAT_INPUT_INVALID' });
    expect(service.getDashboard).not.toHaveBeenCalled();
    expect(service.setDirectoryEnabled).not.toHaveBeenCalled();
  });

  test('服务意外返回私有字段时稳定关闭响应边界', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = habitatIpcServiceDouble();
    service.getDashboard.mockResolvedValueOnce({
      ...dashboard,
      absolutePath: 'C:\\Private'
    } as never);
    registerHabitatIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.habitatDashboardGet)?.({}, {}))
      .rejects.toMatchObject({
        code: 'HABITAT_RESPONSE_INVALID',
        message: 'HABITAT_RESPONSE_INVALID'
      });
  });
});
