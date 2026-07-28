import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as ipcRegistration from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';

type Handler = (event: unknown, input?: unknown) => unknown;
type CharacterRegistration = (
  ipcMain: IpcMain,
  service: ReturnType<typeof characterServiceDouble>,
  dialogs: ReturnType<typeof dialogDouble>
) => void;

const invoke = vi.fn(async () => undefined);
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

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
    listCharacters: vi.fn(async () => []),
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
    readCharacterSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
    publishCharacter: vi.fn(async () => undefined),
    activateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => 'imported-character'),
    exportCharacterPackage: vi.fn(async () => undefined),
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

describe('角色白名单 IPC', () => {
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
    ['characterActivate', { characterId: 'demo', extra: true }],
    ['characterDelete', { characterId: 'demo', extra: true }],
    ['characterPackageImport', { extra: true }],
    ['characterPackageExport', { characterId: 'demo', extra: true }],
    ['characterRuntimeSnapshotGet', { extra: true }]
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
  test('只编排现有服务，并按 manifest 资源标识发布编译产物', async () => {
    const module = await import(
      '../src/main/characters/character-actions'
    ).catch(() => null) as null | {
      CharacterActions: new (dependencies: Record<string, unknown>) => {
        publishCharacter(input: {
          characterId: string;
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
      manifest,
      resources: [{ assetId: 'idle-atlas', bytes }]
    });
    expect(store.publishCompiled).toHaveBeenCalledWith('demo', manifest, {
      'idle-atlas.png': bytes
    });

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
