import type { IpcMain } from 'electron';
import {
  convertCharacterDraftV1ToV2,
  convertCharacterManifestV1ToV2,
  type CharacterDraftV1,
  type CharacterManifestV1
} from '@myself/character-runtime';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as ipcRegistration from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import {
  characterRuntimeSnapshotSchema,
  type CharacterSummaryDto,
  type CharacterWorkshopSourceDto
} from '../src/shared/character-ipc';
import type { MyselfApi } from '../src/shared/myself-api';

type Handler = (event: unknown, input?: unknown) => unknown;
type CharacterRegistration = (
  ipcMain: IpcMain,
  service: ReturnType<typeof characterServiceDouble>,
  dialogs: ReturnType<typeof dialogDouble>,
  recoveryErrorCode?: () => string | null
) => void;

const invoke = vi.fn(async (): Promise<unknown> => undefined);
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

function createDraftV1(): CharacterDraftV1 {
  return {
    version: 1,
    id: 'demo',
    name: '演示角色',
    states: []
  };
}

function createLegacyManifestV1(): CharacterManifestV1 {
  return {
    version: 1,
    id: 'demo',
    name: '演示角色',
    thumbnailAssetId: 'atlas',
    compilerVersion: 'test-v1',
    resources: [{
      assetId: 'atlas',
      fileName: 'atlas.png',
      sha256: '0'.repeat(64),
      byteLength: 1
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'idle-main',
        name: '待机',
        fps: 8,
        loop: true,
        weight: 1,
        frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      }]
    }]
  };
}

function createDraftV2() {
  return convertCharacterDraftV1ToV2(createDraftV1()).document;
}

function createManifestV2() {
  return convertCharacterManifestV1ToV2(createLegacyManifestV1()).document;
}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, on, removeListener }
}));

await import('../src/preload/index');

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function characterServiceDouble() {
  return {
    listCharacters: vi.fn(async (): Promise<CharacterSummaryDto[]> => []),
    createCharacter: vi.fn(async () => ({
      version: 1,
      id: 'new-character',
      name: '新角色',
      states: []
    })),
    duplicateCharacter: vi.fn(async () => ({
      version: 1,
      id: 'copy-character',
      name: '角色副本',
      states: []
    })),
    getCharacterDraft: vi.fn(async () => ({
      version: 1,
      id: 'demo',
      name: '示例角色',
      states: []
    })),
    saveCharacterDraft: vi.fn(async () => undefined),
    chooseCharacterSources: vi.fn(async () => []),
    listCharacterSources: vi.fn(
      async (): Promise<CharacterWorkshopSourceDto[]> => []
    ),
    readCharacterSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
    publishCharacter: vi.fn(async () => undefined),
    activateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => 'imported-character'),
    exportCharacterPackage: vi.fn(
      async (): Promise<'exported' | 'recovery-exported'> => 'exported'
    ),
    getCharacterRuntimeSnapshot: vi.fn(async () => null),
    readCharacterRuntimeAsset: vi.fn(async () => new Uint8Array([4, 5, 6]))
  };
}

function dialogDouble() {
  return {
    chooseCharacterSources: vi.fn(async () => ({
      canceled: false,
      filePaths: ['C:\\selected\\idle.png']
    })),
    chooseCharacterPackage: vi.fn(async () => ({
      canceled: false,
      filePaths: ['C:\\selected\\character.zip']
    })),
    chooseCharacterExportDestination: vi.fn(async (): Promise<{
      canceled: boolean;
      filePath?: string;
    }> => ({
      canceled: false,
      filePath: 'C:\\selected\\export.zip'
    }))
  };
}

function requireCharacterRegistration(): CharacterRegistration {
  const registration = (
    ipcRegistration as unknown as { registerCharacterIpc?: CharacterRegistration }
  ).registerCharacterIpc;
  expect(registration, '应提供角色白名单 IPC 注册器').toBeTypeOf('function');
  if (!registration) throw new Error('CHARACTER_IPC_NOT_IMPLEMENTED');
  return registration;
}

function channel(name: string): string {
  const value = (ipcChannels as unknown as Record<string, string>)[name];
  expect(value, `应声明固定 IPC 通道 ${name}`).toBeTypeOf('string');
  if (!value) throw new Error(`CHARACTER_CHANNEL_MISSING:${name}`);
  return value;
}

beforeEach(() => {
  invoke.mockClear();
  on.mockClear();
  removeListener.mockClear();
});

describe('V2 角色 IPC 边界', () => {
  test('草稿保存与发布只接受 V2，运行快照继续接受 V1', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterDraftSave'))?.({}, {
      characterId: 'demo',
      draftRevision: '11111111-1111-4111-8111-111111111111',
      draft: createDraftV2()
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(channel('characterDraftSave'))?.({}, {
      characterId: 'demo',
      draftRevision: '11111111-1111-4111-8111-111111111111',
      draft: createDraftV1()
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });

    const manifest = createManifestV2();
    await expect(handlers.get(channel('characterPublish'))?.({}, {
      characterId: 'demo',
      draftRevision: '11111111-1111-4111-8111-111111111111',
      manifest,
      resources: [{ assetId: 'atlas', bytes: new Uint8Array([1]) }]
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(channel('characterPublish'))?.({}, {
      characterId: 'demo',
      draftRevision: '11111111-1111-4111-8111-111111111111',
      manifest: createLegacyManifestV1(),
      resources: [{ assetId: 'atlas', bytes: new Uint8Array([1]) }]
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });

    expect(characterRuntimeSnapshotSchema.parse({
      activeCharacterId: 'demo',
      manifest: createLegacyManifestV1()
    })).toBeTruthy();
  });

  test('角色列表严格返回迁移恢复摘要', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    service.listCharacters.mockResolvedValueOnce([{
      id: 'demo',
      name: '演示角色',
      thumbnailAssetId: null,
      active: false,
      completeness: 'broken',
      missingRequirements: [],
      migrationErrorCode: 'CHARACTER_MIGRATION_FAILED',
      migrationRecoveryAvailable: true,
      activationConfirmationRequired: false
    }]);
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterList'))?.({}, {})).resolves.toEqual({
      characters: [{
        id: 'demo',
        name: '演示角色',
        thumbnailAssetId: null,
        active: false,
        completeness: 'broken',
        missingRequirements: [],
        migrationErrorCode: 'CHARACTER_MIGRATION_FAILED',
        migrationRecoveryAvailable: true,
        activationConfirmationRequired: false
      }]
    });
  });

  test('恢复导出沿用角色导出通道并返回专用结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    service.exportCharacterPackage.mockResolvedValueOnce('recovery-exported');
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterPackageExport'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ kind: 'recovery-exported' });
  });

  test('应用服务仅在迁移失败时把普通导出切换为恢复导出', async () => {
    const packages = {
      importCharacter: vi.fn(async () => 'unused'),
      exportCharacter: vi.fn(async () => {
        throw new Error('CHARACTER_MIGRATION_FAILED');
      }),
      exportCharacterRecovery: vi.fn(async () => undefined)
    };
    const { CharacterActions } = await import(
      '../src/main/characters/character-actions'
    );
    const actions = new CharacterActions({
      store: {} as never,
      assets: {} as never,
      packages
    });

    await expect(actions.exportCharacterPackage('demo', 'C:\\selected\\demo.zip'))
      .resolves.toBe('recovery-exported');
    expect(packages.exportCharacterRecovery).toHaveBeenCalledWith(
      'demo',
      'C:\\selected\\demo.zip'
    );
  });
});

describe('角色白名单 IPC', () => {
  test('素材目录查询只接受角色标识并通过固定通道返回公开元数据', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    const sources = [{
      assetId: '00000000-0000-4000-8000-000000000001',
      displayName: 'idle.png',
      mimeType: 'image/png' as const
    }];
    service.listCharacterSources.mockResolvedValue(sources);
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterSourcesList'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ sources });
    await expect(handlers.get(channel('characterSourcesList'))?.({}, {
      characterId: '../outside'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });

    const api = exposedApi as MyselfApi;
    expect(api.listCharacterSources, 'preload 应暴露素材目录查询').toBeTypeOf('function');
    if (!api.listCharacterSources) return;
    invoke.mockResolvedValueOnce({ sources });
    await api.listCharacterSources('demo');
    expect(invoke).toHaveBeenCalledWith(
      ipcChannels.characterSourcesList,
      { characterId: 'demo' }
    );
  });

  test('不完整确认只通过固定布尔字段贯穿 preload 与 Main', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterActivate'))?.({}, {
      characterId: 'demo',
      confirmIncomplete: true
    })).resolves.toEqual({ ok: true });
    expect(service.activateCharacter).toHaveBeenCalledWith('demo', true);

    await exposedApi?.activateCharacter('demo', { confirmIncomplete: true });
    expect(invoke).toHaveBeenCalledWith(
      ipcChannels.characterActivate,
      { characterId: 'demo', confirmIncomplete: true }
    );
  });

  test('拒绝路径型角色标识和多余字段，且不会进入应用服务', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterDraftGet'))?.({}, {
      characterId: '../outside',
      arbitraryPath: 'C:\\private'
    })).rejects.toMatchObject({
      code: 'CHARACTER_INPUT_INVALID',
      message: 'CHARACTER_INPUT_INVALID'
    });
    expect(service.getCharacterDraft).not.toHaveBeenCalled();
  });

  test.each([
    ['characterList', { extra: true }],
    ['characterCreate', { name: '新角色', extra: true }],
    ['characterDuplicate', { characterId: 'demo', extra: true }],
    ['characterSourceRead', {
      characterId: 'demo',
      assetId: 'idle-atlas',
      extra: true
    }],
    ['characterActivate', {
      characterId: 'demo',
      confirmIncomplete: true,
      extra: true
    }],
    ['characterDelete', { characterId: 'demo', extra: true }],
    ['characterPackageImport', { extra: true }],
    ['characterPackageExport', { characterId: 'demo', extra: true }],
    ['characterRuntimeSnapshotGet', { extra: true }],
    ['characterRecoverySnapshotGet', { extra: true }]
  ] as const)('%s 拒绝多余 payload 字段', async (channelName, payload) => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel(channelName))?.({}, payload))
      .rejects.toMatchObject({
        code: 'CHARACTER_INPUT_INVALID',
        message: 'CHARACTER_INPUT_INVALID'
      });
    expect(Object.values(service).every(method => method.mock.calls.length === 0))
      .toBe(true);
  });

  test('启动恢复快照只接受空输入并返回固定稳定错误码', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(
      ipcMain,
      service,
      dialogDouble(),
      () => 'CHARACTER_INDEX_UNAVAILABLE'
    );
    const handler = handlers.get(channel('characterRecoverySnapshotGet'));

    await expect(handler?.({}, {})).resolves.toEqual({
      errorCode: 'CHARACTER_INDEX_UNAVAILABLE'
    });
    await expect(handler?.({}, { path: 'C:\\private' })).rejects.toMatchObject({
      code: 'CHARACTER_INPUT_INVALID'
    });
  });

  test('运行时资源只接受当前角色的资源标识，不接受 characterId 或文件名', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    requireCharacterRegistration()(ipcMain, service, dialogDouble());
    const handler = handlers.get(channel('characterRuntimeAssetRead'));

    await expect(handler?.({}, {
      assetId: 'idle-atlas',
      characterId: 'other-character'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
    await expect(handler?.({}, {
      assetId: 'idle-atlas',
      fileName: '..\\private.png'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
    expect(service.readCharacterRuntimeAsset).not.toHaveBeenCalled();

    await expect(handler?.({}, { assetId: 'idle-atlas' })).resolves.toEqual({
      bytes: new Uint8Array([4, 5, 6])
    });
    expect(service.readCharacterRuntimeAsset).toHaveBeenCalledWith('idle-atlas');
  });

  test('源素材、导入和导出路径只能来自 Main dialog，并区分取消结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    const dialogs = dialogDouble();
    requireCharacterRegistration()(ipcMain, service, dialogs);

    await expect(handlers.get(channel('characterSourcesChoose'))?.({}, {
      characterId: 'demo',
      paths: ['C:\\private\\bypass.png']
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
    expect(dialogs.chooseCharacterSources).not.toHaveBeenCalled();

    await expect(handlers.get(channel('characterSourcesChoose'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ kind: 'selected', sources: [] });
    expect(service.chooseCharacterSources).toHaveBeenCalledWith(
      'demo',
      ['C:\\selected\\idle.png']
    );

    await expect(handlers.get(channel('characterPackageImport'))?.({}, {
      packagePath: 'C:\\private\\bypass.zip'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
    await expect(handlers.get(channel('characterPackageImport'))?.({}, {}))
      .resolves.toEqual({
        kind: 'imported',
        characterId: 'imported-character'
      });
    expect(service.importCharacterPackage).toHaveBeenCalledWith(
      'C:\\selected\\character.zip'
    );

    await expect(handlers.get(channel('characterPackageExport'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ kind: 'exported' });
    expect(service.exportCharacterPackage).toHaveBeenCalledWith(
      'demo',
      'C:\\selected\\export.zip'
    );

    dialogs.chooseCharacterSources.mockResolvedValueOnce({
      canceled: true,
      filePaths: []
    });
    dialogs.chooseCharacterPackage.mockResolvedValueOnce({
      canceled: true,
      filePaths: []
    });
    dialogs.chooseCharacterExportDestination.mockResolvedValueOnce({
      canceled: true
    });
    await expect(handlers.get(channel('characterSourcesChoose'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ kind: 'cancelled' });
    await expect(handlers.get(channel('characterPackageImport'))?.({}, {}))
      .resolves.toEqual({ kind: 'cancelled' });
    await expect(handlers.get(channel('characterPackageExport'))?.({}, {
      characterId: 'demo'
    })).resolves.toEqual({ kind: 'cancelled' });
  });

  test('严格校验公开结果并把内部路径错误映射为稳定错误码', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = characterServiceDouble();
    service.getCharacterRuntimeSnapshot.mockResolvedValueOnce({
      activeCharacterId: 'demo',
      manifest: null,
      localPath: 'C:\\private\\compiled'
    } as never);
    requireCharacterRegistration()(ipcMain, service, dialogDouble());

    await expect(handlers.get(channel('characterRuntimeSnapshotGet'))?.({}, {}))
      .rejects.toMatchObject({
        code: 'CHARACTER_OPERATION_FAILED',
        message: 'CHARACTER_OPERATION_FAILED'
      });

    service.getCharacterDraft.mockRejectedValueOnce(
      new Error('ENOENT: C:\\private\\characters\\demo\\draft.json')
    );
    await expect(handlers.get(channel('characterDraftGet'))?.({}, {
      characterId: 'demo'
    })).rejects.toMatchObject({
      code: 'CHARACTER_OPERATION_FAILED',
      message: 'CHARACTER_OPERATION_FAILED'
    });
  });
});

describe('角色事件 preload 边界', () => {
  test('只订阅固定通道、隐藏 Electron event，并用原包装函数可靠取消', () => {
    const listener = vi.fn();
    const api = exposedApi as MyselfApi & {
      subscribeCharacterEvents?: (callback: (event: unknown) => void) => () => void;
    };
    expect(api.subscribeCharacterEvents, 'preload 应暴露角色事件订阅').toBeTypeOf('function');
    if (!api.subscribeCharacterEvents) return;

    const unsubscribe = api.subscribeCharacterEvents(listener);
    expect(on).toHaveBeenCalledOnce();
    const [eventChannel, wrappedListener] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];
    expect(eventChannel).toBe(channel('characterEvent'));

    const electronEvent = { sender: '不得暴露' };
    const payload = { type: 'index-changed' };
    wrappedListener(electronEvent, payload);
    expect(listener).toHaveBeenCalledWith(payload);
    expect(listener).not.toHaveBeenCalledWith(electronEvent, payload);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(eventChannel, wrappedListener);
  });

  test('多个订阅各自持有包装 listener，取消一个不会移除另一个', () => {
    const first = vi.fn();
    const second = vi.fn();
    const api = exposedApi as MyselfApi & {
      subscribeCharacterEvents?: (callback: (event: unknown) => void) => () => void;
    };
    expect(api.subscribeCharacterEvents).toBeTypeOf('function');
    if (!api.subscribeCharacterEvents) return;

    const unsubscribeFirst = api.subscribeCharacterEvents(first);
    const unsubscribeSecond = api.subscribeCharacterEvents(second);
    const [firstChannel, firstWrapped] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void
    ];
    const [secondChannel, secondWrapped] = on.mock.calls[1] as [
      string,
      (event: unknown, payload: unknown) => void
    ];

    expect(firstWrapped).not.toBe(secondWrapped);
    unsubscribeFirst();
    expect(removeListener).toHaveBeenCalledWith(firstChannel, firstWrapped);
    expect(removeListener).not.toHaveBeenCalledWith(secondChannel, secondWrapped);

    secondWrapped({ sender: '不得暴露' }, { type: 'index-changed' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ type: 'index-changed' });

    unsubscribeSecond();
    expect(removeListener).toHaveBeenCalledWith(secondChannel, secondWrapped);
  });
});

describe('CharacterActions 应用服务', () => {
  test('列出角色素材直接复用素材服务且不改变角色索引', async () => {
    const sources = [{
      assetId: '00000000-0000-4000-8000-000000000001',
      displayName: 'idle.png',
      mimeType: 'image/png' as const
    }];
    const storedSources = [{
      ...sources[0]!,
      byteLength: 4,
      sha256: '0'.repeat(64)
    }];
    const assets = {
      listSources: vi.fn(async () => storedSources)
    };
    const store = {
      list: vi.fn(async () => [])
    };
    const { CharacterActions } = await import(
      '../src/main/characters/character-actions'
    );
    const actions = new CharacterActions({
      store: store as never,
      assets: assets as never,
      packages: {} as never
    });

    await expect(actions.listCharacterSources('demo')).resolves.toEqual(sources);
    expect(assets.listSources).toHaveBeenCalledWith('demo');
    expect(store.list).not.toHaveBeenCalled();
  });

  test('只编排现有服务，并按 manifest 资源标识发布编译产物', async () => {
    const module = await import(
      '../src/main/characters/character-actions'
    ).catch(() => null) as null | {
      CharacterActions: new (dependencies: Record<string, unknown>) => {
        publishCharacter(input: {
          characterId: string;
          draftRevision: string;
          manifest: Record<string, unknown>;
          resources: Array<{ assetId: string; bytes: Uint8Array }>;
        }): Promise<void>;
        readCharacterRuntimeAsset(assetId: string): Promise<Uint8Array>;
      };
    };
    expect(module, '应在 Main characters 边界提供薄应用服务').not.toBeNull();
    if (!module) return;

    const store = {
      publishCompiled: vi.fn(async () => undefined),
      readActiveRuntimeAsset: vi.fn(async () => new Uint8Array([9]))
    };
    const actions = new module.CharacterActions({
      store,
      assets: {},
      packages: {}
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest = {
      version: 1,
      id: 'demo',
      name: '示例角色',
      thumbnailAssetId: 'idle-atlas',
      compilerVersion: 'test-v1',
      resources: [{
        assetId: 'idle-atlas',
        fileName: 'idle-atlas.png',
        sha256: '0'.repeat(64),
        byteLength: bytes.byteLength
      }],
      states: []
    };

    await actions.publishCharacter({
      characterId: 'demo',
      draftRevision: '11111111-1111-4111-8111-111111111111',
      manifest,
      resources: [{ assetId: 'idle-atlas', bytes }]
    });
    expect(store.publishCompiled).toHaveBeenCalledWith('demo', manifest, {
      'idle-atlas.png': bytes
    }, '11111111-1111-4111-8111-111111111111');

    await expect(actions.readCharacterRuntimeAsset('idle-atlas'))
      .resolves.toEqual(new Uint8Array([9]));
    expect(store.readActiveRuntimeAsset).toHaveBeenCalledWith('idle-atlas');
  });

  test('已提交操作不受异常 listener 影响且其余 listener 仍收到事件', async () => {
    const module = await import(
      '../src/main/characters/character-actions'
    ).catch(() => null) as null | {
      CharacterActions: new (dependencies: Record<string, unknown>) => {
        activateCharacter(characterId: string): Promise<void>;
        subscribeCharacterEvents(
          listener: (event: unknown) => void
        ): () => void;
      };
    };
    expect(module).not.toBeNull();
    if (!module) return;

    const store = {
      setActive: vi.fn(async () => undefined)
    };
    const actions = new module.CharacterActions({
      store,
      assets: {},
      packages: {}
    });
    const healthyListener = vi.fn();
    actions.subscribeCharacterEvents(() => {
      throw new Error('LISTENER_FAILED');
    });
    actions.subscribeCharacterEvents(healthyListener);

    await expect(actions.activateCharacter('demo')).resolves.toBeUndefined();

    expect(store.setActive).toHaveBeenCalledWith('demo');
    expect(healthyListener).toHaveBeenNthCalledWith(1, {
      type: 'active-character-changed',
      characterId: 'demo'
    });
    expect(healthyListener).toHaveBeenNthCalledWith(2, {
      type: 'index-changed'
    });
  });

  test('已提交操作遇到窗口 send 异常仍广播其他目标并刷新菜单', async () => {
    const [actionsModule, windowModule] = await Promise.all([
      import('../src/main/characters/character-actions'),
      import('../src/main/windows/window-commands')
    ]);
    const store = {
      setActive: vi.fn(async () => undefined)
    };
    const actions = new actionsModule.CharacterActions({
      store: store as never,
      assets: {} as never,
      packages: {} as never
    });
    const delivered = vi.fn();
    const failedSend = vi.fn(() => {
      throw new Error('SEND_FAILED');
    });
    const target = (send: (channel: string, payload: unknown) => void) => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send
      }
    });
    const refreshMenu = vi.fn();
    actions.subscribeCharacterEvents(event => {
      windowModule.broadcastCharacterEvent([
        target(failedSend),
        target(delivered)
      ], channel('characterEvent'), event);
    });
    actions.subscribeCharacterEvents(refreshMenu);

    await expect(actions.activateCharacter('demo')).resolves.toBeUndefined();

    expect(failedSend).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenNthCalledWith(
      1,
      channel('characterEvent'),
      { type: 'active-character-changed', characterId: 'demo' }
    );
    expect(delivered).toHaveBeenNthCalledWith(
      2,
      channel('characterEvent'),
      { type: 'index-changed' }
    );
    expect(refreshMenu).toHaveBeenCalledTimes(2);
  });
});
