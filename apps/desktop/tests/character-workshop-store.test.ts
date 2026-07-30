import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import type {
  CharacterEvent,
  CharacterPublishInput,
  CharacterSummaryDto,
  CharacterWorkshopSourceDto
} from '../src/shared/character-ipc';
import {
  createCharacterWorkshopStore,
  type CharacterWorkshopApi
} from '../src/renderer/src/characters/store/character-workshop-store';

function draft(
  id: string,
  name: string,
  actionName = '待机'
): CharacterDraftV1 {
  return {
    version: 1,
    id,
    name,
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'idle-main',
        name: actionName,
        fps: 12,
        loop: true,
        weight: 1,
        anchors: { ground: { x: 0.5, y: 1 } },
        frames: []
      }]
    }, {
      id: 'thinking',
      kind: 'core',
      actions: []
    }]
  };
}

function summary(
  id: string,
  name: string,
  active = false
): CharacterSummaryDto {
  return {
    id,
    name,
    thumbnailAssetId: null,
    active,
    completeness: 'incomplete',
    missingCoreStates: ['listening']
  };
}

function publishInput(characterId: string): CharacterPublishInput {
  return {
    characterId,
    manifest: {
      version: 1,
      id: characterId,
      name: '待发布角色',
      thumbnailAssetId: 'idle-atlas',
      compilerVersion: 'test-compiler-v1',
      resources: [{
        assetId: 'idle-atlas',
        fileName: 'idle-atlas.png',
        sha256: 'a'.repeat(64),
        byteLength: 1
      }],
      states: [{
        id: 'idle',
        kind: 'core',
        actions: [{
          id: 'idle-main',
          name: '待机',
          fps: 12,
          loop: true,
          weight: 1,
          anchors: { ground: { x: 0.5, y: 1 } },
          frames: [{
            assetId: 'idle-atlas',
            x: 0,
            y: 0,
            width: 1,
            height: 1
          }]
        }]
      }]
    },
    resources: [{
      assetId: 'idle-atlas',
      bytes: new Uint8Array([1])
    }]
  };
}

function sourceDto(
  assetId: string,
  displayName: string
): CharacterWorkshopSourceDto {
  return {
    assetId,
    displayName,
    mimeType: 'image/png'
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function apiDouble(overrides: Partial<CharacterWorkshopApi> = {}) {
  let listener: ((event: CharacterEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const api: CharacterWorkshopApi = {
    listCharacters: vi.fn(async () => [
      summary('default', 'AI Pet 默认角色', true),
      summary('nova', 'Nova')
    ]),
    createCharacter: vi.fn(async ({ name }) => draft('created', name)),
    duplicateCharacter: vi.fn(async () => draft('copy', 'Nova 副本')),
    getCharacterDraft: vi.fn(async id => draft(id, id === 'default' ? 'AI Pet 默认角色' : 'Nova')),
    saveCharacterDraft: vi.fn(async () => undefined),
    listCharacterSources: vi.fn(async () => []),
    chooseCharacterSources: vi.fn(async () => ({
      kind: 'selected' as const,
      sources: [{
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        displayName: 'idle.png',
        mimeType: 'image/png' as const,
        byteLength: 128,
        sha256: 'a'.repeat(64)
      }]
    })),
    readCharacterSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
    publishCharacter: vi.fn(async () => undefined),
    activateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => ({
      kind: 'imported' as const,
      characterId: 'imported'
    })),
    exportCharacterPackage: vi.fn(async () => ({ kind: 'exported' as const })),
    subscribeCharacterEvents: vi.fn(callback => {
      listener = callback;
      return unsubscribe;
    }),
    ...overrides
  };
  return {
    api,
    emit: (event: CharacterEvent) => listener?.(event),
    unsubscribe
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('角色工作室 Zustand 状态层', () => {
  test('自动保存成功只更新保存状态，失败入队且按 ID 关闭不影响后续提示', async () => {
    const firstIds = ['toast-1', 'toast-2'];
    const { api } = apiDouble();
    const savedStore = createCharacterWorkshopStore(api, {
      createToastId: () => firstIds.shift()!
    });
    await savedStore.getState().load();
    savedStore.getState().updateCurrentAction({ name: '自动保存成功' });
    await savedStore.getState().flushDraft();

    expect(savedStore.getState()).toMatchObject({
      draftStatus: 'saved',
      toastQueue: []
    });

    const { api: failingApi } = apiDouble({
      saveCharacterDraft: vi.fn(async () => {
        throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
      })
    });
    const failingStore = createCharacterWorkshopStore(failingApi, {
      createToastId: () => firstIds.shift()!
    });
    await failingStore.getState().load();
    failingStore.getState().updateCurrentAction({ name: '自动保存失败' });
    await expect(failingStore.getState().flushDraft()).rejects.toThrow();

    expect(failingStore.getState()).toMatchObject({
      draftStatus: 'error',
      toastQueue: [{
        id: 'toast-1',
        tone: 'error',
        text: '角色草稿保存失败，请检查角色素材后重试。'
      }]
    });
    failingStore.setState({
      toastQueue: [
        ...failingStore.getState().toastQueue,
        { id: 'toast-2', tone: 'info', text: '后续提示。' }
      ]
    });
    failingStore.getState().dismissToast('toast-1');
    expect(failingStore.getState().toastQueue).toEqual([
      { id: 'toast-2', tone: 'info', text: '后续提示。' }
    ]);
    failingStore.getState().dismissToast('unknown');
    expect(failingStore.getState().toastQueue).toHaveLength(1);
  });

  test('保存 timer 句柄为 0 时重调度、显式保存和卸载都会清理它', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => (
      0 as unknown as ReturnType<typeof setTimeout>
    ));
    const { api } = apiDouble();
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().updateCurrentAction({ name: '第一次调度' });
    store.getState().updateCurrentAction({ name: '第二次调度' });
    await store.getState().flushDraft();
    store.getState().updateCurrentAction({ name: '卸载前调度' });
    store.getState().dispose();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(1, 0);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(2, 0);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(3, 0);
  });

  test('500ms 自动保存会消费失败的 Promise，但显式 flush 仍会拒绝', async () => {
    vi.useFakeTimers();
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(async () => {
        throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
      })
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '定时失败' });
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(store.getState()).toMatchObject({
      draftStatus: 'error',
      toastQueue: [expect.objectContaining({ tone: 'error' })]
    });
    store.getState().updateCurrentAction({ name: '显式失败' });
    await expect(store.getState().flushDraft()).rejects.toThrow();
  });

  test('工作室关闭后不扫描或读取素材目录', async () => {
    vi.useFakeTimers();
    const chooseCharacterSources = vi.fn(async () => ({
      kind: 'selected' as const,
      sources: [{
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        displayName: 'idle.png',
        mimeType: 'image/png' as const,
        byteLength: 4,
        sha256: 'a'.repeat(64)
      }]
    }));
    const readCharacterSource = vi.fn(async () => new Uint8Array([
      0x89, 0x50, 0x4e, 0x47
    ]));
    const { api, unsubscribe } = apiDouble({
      chooseCharacterSources,
      readCharacterSource,
      listCharacterSources: vi.fn(async () => [
        sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
      ])
    });
    const store = createCharacterWorkshopStore(api, {
      inspectImage: async () => ({ width: 2, height: 2 })
    });

    const dispose = store.getState().mount();
    await vi.waitFor(() => expect(store.getState().loadStatus).toBe('ready'));
    await store.getState().importSources();
    await store.getState().applySpriteSheet({
      sourceAssetId: '123e4567-e89b-42d3-a456-426614174000',
      rows: 1,
      columns: 1,
      frameCount: 1
    });
    const readsAtClose = readCharacterSource.mock.calls.length;
    dispose();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(readsAtClose).toBeGreaterThan(0);
    expect(readCharacterSource).toHaveBeenCalledTimes(readsAtClose);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test('可在选中状态创建动作并把导入精灵图按 2x2 写入四帧', async () => {
    const { api } = apiDouble({
      listCharacterSources: vi.fn(async () => [
        sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
      ])
    });
    const store = createCharacterWorkshopStore(api, {
      inspectImage: async () => ({ width: 1024, height: 1024 })
    });
    await store.getState().load();

    store.getState().addAction();
    await store.getState().importSources();
    await store.getState().applySpriteSheet({
      sourceAssetId: '123e4567-e89b-42d3-a456-426614174000',
      rows: 2,
      columns: 2,
      frameCount: 4
    });

    const action = store.getState().draft!.states[0]!.actions.at(-1)!;
    expect(action.frames).toHaveLength(4);
    expect(action.frames.map(frame => [frame.x, frame.y, frame.width, frame.height]))
      .toEqual([
        [0, 0, 512, 512],
        [512, 0, 512, 512],
        [0, 512, 512, 512],
        [512, 512, 512, 512]
      ]);
  });

  test('应用网格读取素材失败时转为错误提示而不向调用方拒绝', async () => {
    const { api } = apiDouble({
      readCharacterSource: vi.fn(async () => {
        throw new Error('CHARACTER_SOURCE_READ_FAILED');
      })
    });
    const store = createCharacterWorkshopStore(api, {
      inspectImage: async () => ({ width: 1, height: 1 })
    });
    await store.getState().load();
    await store.getState().importSources();

    await expect(store.getState().applySpriteSheet({
      sourceAssetId: '123e4567-e89b-42d3-a456-426614174000',
      rows: 1,
      columns: 1,
      frameCount: 1
    })).resolves.toBeUndefined();
    expect(store.getState().toastQueue.at(-1)).toMatchObject({ tone: 'error' });
  });

  test('应用网格检查图片失败时转为错误提示而不向调用方拒绝', async () => {
    const { api } = apiDouble();
    const store = createCharacterWorkshopStore(api, {
      inspectImage: async () => {
        throw new Error('CHARACTER_IMAGE_INSPECT_FAILED');
      }
    });
    await store.getState().load();
    await store.getState().importSources();

    await expect(store.getState().applySpriteSheet({
      sourceAssetId: '123e4567-e89b-42d3-a456-426614174000',
      rows: 1,
      columns: 1,
      frameCount: 1
    })).resolves.toBeUndefined();
    expect(store.getState().toastQueue.at(-1)).toMatchObject({ tone: 'error' });
  });

  test('发布命令编译草稿动作、保存草稿并调用正式发布 API', async () => {
    const publishCharacter = vi.fn(async () => undefined);
    const { api } = apiDouble({
      publishCharacter,
      readCharacterSource: vi.fn(async () => new Uint8Array([
        0x89, 0x50, 0x4e, 0x47
      ]))
    });
    const store = createCharacterWorkshopStore(api, {
      compileAction: async input => ({
        assetId: input.atlasAssetId,
        fileName: `${input.atlasAssetId}.png`,
        sha256: 'b'.repeat(64),
        bytes: new Uint8Array([9]),
        frames: input.frames.map((frame, index) => ({
          assetId: input.atlasAssetId,
          x: index,
          y: 0,
          width: 1,
          height: 1
        }))
      })
    });
    await store.getState().load();
    const state = store.getState();
    state.updateCurrentAction({
      frames: [{
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        x: 0,
        y: 0,
        width: 1,
        height: 1
      }]
    });

    await store.getState().compileAndPublish();

    expect(api.saveCharacterDraft).toHaveBeenCalled();
    expect(publishCharacter).toHaveBeenCalledWith(expect.objectContaining({
      characterId: 'default',
      manifest: expect.objectContaining({
        compilerVersion: 'character-atlas-compiler-v1'
      })
    }));
  });

  test('草稿保存失败时中止编译发布', async () => {
    const publishCharacter = vi.fn(async () => undefined);
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(async () => {
        throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
      }),
      publishCharacter
    });
    const compileAction = vi.fn();
    const store = createCharacterWorkshopStore(api, { compileAction });
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '未保存修改' });

    await store.getState().compileAndPublish();

    expect(compileAction).not.toHaveBeenCalled();
    expect(publishCharacter).not.toHaveBeenCalled();
    expect(store.getState().draftStatus).toBe('error');
  });

  test('发布失败只按本次结果设置编译错误，不受其他提示覆盖', async () => {
    const publishing = deferred<void>();
    const { api } = apiDouble({
      publishCharacter: vi.fn(() => publishing.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    let appendedOtherToast = false;
    const unsubscribe = store.subscribe(state => {
      if (appendedOtherToast || state.toastQueue.at(-1)?.tone !== 'error') return;
      appendedOtherToast = true;
      store.setState({
        toastQueue: [...state.toastQueue, {
          id: 'unrelated',
          tone: 'info',
          text: '其他操作已取消。'
        }]
      });
    });

    const operation = store.getState().publishCharacter(publishInput('default'));
    publishing.reject(new Error('CHARACTER_PUBLISH_FAILED'));
    await operation;
    unsubscribe();

    expect(store.getState()).toMatchObject({
      busyAction: null,
      compileStatus: 'error'
    });
    expect(store.getState().toastQueue.at(-1)).toMatchObject({
      id: 'unrelated',
      tone: 'info'
    });
  });

  test('保存期间再次编辑时只发布最后一次成功持久化的稳定修订', async () => {
    const firstSave = deferred<void>();
    const publishCharacter = vi.fn(async () => undefined);
    const saveCharacterDraft = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);
    const { api } = apiDouble({
      saveCharacterDraft,
      publishCharacter,
      readCharacterSource: vi.fn(async () => new Uint8Array([
        0x89, 0x50, 0x4e, 0x47
      ]))
    });
    const store = createCharacterWorkshopStore(api, {
      compileAction: async input => ({
        assetId: input.atlasAssetId,
        fileName: `${input.atlasAssetId}.png`,
        sha256: 'b'.repeat(64),
        bytes: new Uint8Array([9]),
        frames: input.frames.map(frame => ({
          assetId: input.atlasAssetId,
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }))
      })
    });
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '第一次修改' });
    store.getState().updateCurrentAction({
      frames: [{
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        x: 0,
        y: 0,
        width: 1,
        height: 1
      }]
    });
    const publishing = store.getState().compileAndPublish();
    await settle();
    store.getState().updateCurrentAction({ name: '最终修改' });
    firstSave.resolve();
    await publishing;

    expect(saveCharacterDraft).toHaveBeenCalledTimes(2);
    expect(publishCharacter).toHaveBeenCalledWith(expect.objectContaining({
      manifest: expect.objectContaining({
        states: expect.arrayContaining([
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({ name: '最终修改' })
            ])
          })
        ])
      })
    }));
  });

  test('同一素材被多帧和多动作引用时编译阶段只读取一次源文件', async () => {
    const sourceAssetId = '123e4567-e89b-42d3-a456-426614174000';
    const readCharacterSource = vi.fn(async () => new Uint8Array([
      0x89, 0x50, 0x4e, 0x47
    ]));
    const { api } = apiDouble({ readCharacterSource });
    const store = createCharacterWorkshopStore(api, {
      compileAction: async input => ({
        assetId: input.atlasAssetId,
        fileName: `${input.atlasAssetId}.png`,
        sha256: 'b'.repeat(64),
        bytes: new Uint8Array([9]),
        frames: input.frames.map(frame => ({
          assetId: input.atlasAssetId,
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }))
      })
    });
    await store.getState().load();
    store.getState().updateCurrentAction({
      frames: [0, 1, 2, 3].map(index => ({
        assetId: sourceAssetId,
        x: index,
        y: 0,
        width: 1,
        height: 1
      }))
    });
    store.getState().addAction();
    store.getState().updateCurrentAction({
      frames: [{
        assetId: sourceAssetId,
        x: 0,
        y: 0,
        width: 1,
        height: 1
      }]
    });

    await store.getState().compileAndPublish();

    expect(readCharacterSource).toHaveBeenCalledTimes(1);
  });

  test('可创建带单击触发器的扩展状态', async () => {
    const { api } = apiDouble();
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().addExtensionState('wave', 'single_click');

    expect(store.getState().draft!.states.at(-1)).toMatchObject({
      id: 'custom:wave',
      kind: 'extension',
      triggers: { events: ['single_click'] }
    });
  });
  test('加载后选择启用角色、idle 状态和默认动作', async () => {
    const { api } = apiDouble();
    const store = createCharacterWorkshopStore(api);

    const loading = store.getState().load();
    expect(store.getState().busyAction).toBe('loading');
    await loading;

    expect(store.getState()).toMatchObject({
      busyAction: null,
      selectedCharacterId: 'default',
      selectedStateId: 'idle',
      selectedActionId: 'idle-main',
      loadStatus: 'ready'
    });
    expect(store.getState().characters).toHaveLength(2);
  });

  test('编辑动作后严格等待 500ms 自动保存，flushDraft 会立即保存且并发调用单飞', async () => {
    vi.useFakeTimers();
    const saving = deferred<void>();
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(() => saving.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().updateCurrentAction({ name: '挥手' });
    expect(store.getState().draftStatus).toBe('dirty');
    await vi.advanceTimersByTimeAsync(499);
    expect(api.saveCharacterDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1);
    expect(store.getState().busyAction).toBeNull();
    expect(store.getState().draftStatus).toBe('saving');
    const firstFlush = store.getState().flushDraft();
    const secondFlush = store.getState().flushDraft();
    expect(api.saveCharacterDraft).toHaveBeenCalledTimes(1);

    saving.resolve();
    await Promise.all([firstFlush, secondFlush]);
    expect(store.getState()).toMatchObject({
      busyAction: null,
      draftStatus: 'saved'
    });
    expect(api.saveCharacterDraft).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        states: expect.arrayContaining([
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({ name: '挥手' })
            ])
          })
        ])
      })
    );
  });

  test('角色切换会先提交旧草稿，新角色编辑随后串行保存', async () => {
    vi.useFakeTimers();
    const oldSave = deferred<void>();
    const saveCharacterDraft = vi.fn()
      .mockImplementationOnce(() => oldSave.promise)
      .mockResolvedValueOnce(undefined);
    const { api } = apiDouble({ saveCharacterDraft });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().updateCurrentAction({ name: '默认角色动作' });
    const selection = store.getState().selectCharacter('nova');
    await settle();
    expect(saveCharacterDraft).toHaveBeenCalledTimes(1);
    expect(store.getState().selectedCharacterId).toBe('default');

    oldSave.resolve();
    await selection;
    store.getState().updateCurrentAction({ name: 'Nova 新动作' });
    const newFlush = store.getState().flushDraft();
    await newFlush;

    expect(saveCharacterDraft).toHaveBeenNthCalledWith(
      2,
      'nova',
      expect.objectContaining({ id: 'nova' })
    );
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'nova',
      draftStatus: 'saved',
      busyAction: null
    });
  });

  test('角色切换期间保留已有错误与后续排队提示的到达顺序', async () => {
    const novaDraft = deferred<CharacterDraftV1>();
    const exportCharacterPackage = vi.fn()
      .mockRejectedValueOnce(new Error('CHARACTER_PACKAGE_EXPORT_FAILED'))
      .mockResolvedValueOnce({ kind: 'cancelled' as const });
    const getCharacterDraft = vi.fn()
      .mockResolvedValueOnce(draft('default', 'AI Pet 默认角色'))
      .mockImplementationOnce(() => novaDraft.promise);
    const { api } = apiDouble({
      exportCharacterPackage,
      getCharacterDraft
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    await store.getState().exportCharacterPackage();

    const selection = store.getState().selectCharacter('nova');
    await settle();
    await store.getState().exportCharacterPackage();
    novaDraft.resolve(draft('nova', 'Nova'));
    await selection;

    expect(store.getState().toastQueue.map(toast => ({
      tone: toast.tone,
      text: toast.text
    }))).toEqual([{
      tone: 'error',
      text: '角色包格式、路径或容量不符合要求，导入导出已停止。'
    }, {
      tone: 'info',
      text: '已取消导出角色包。'
    }]);
  });

  test('旧保存失败不能覆盖同角色的新修订，新修订仍会串行提交', async () => {
    vi.useFakeTimers();
    const oldSave = deferred<void>();
    const saveCharacterDraft = vi.fn()
      .mockImplementationOnce(() => oldSave.promise)
      .mockResolvedValueOnce(undefined);
    const { api } = apiDouble({ saveCharacterDraft });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().updateCurrentAction({ name: '旧修订' });
    const firstFlush = store.getState().flushDraft();
    store.getState().updateCurrentAction({ name: '新修订' });
    const secondFlush = store.getState().flushDraft();
    oldSave.reject(new Error('CHARACTER_OLD_SAVE_FAILED'));
    await Promise.all([firstFlush, secondFlush]);

    expect(saveCharacterDraft).toHaveBeenCalledTimes(2);
    expect(saveCharacterDraft).toHaveBeenNthCalledWith(
      2,
      'default',
      expect.objectContaining({
        states: expect.arrayContaining([
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({ name: '新修订' })
            ])
          })
        ])
      })
    );
    expect(store.getState()).toMatchObject({
      draftStatus: 'saved',
      busyAction: null
    });
  });

  test('切换前保存失败时保留当前角色和错误通知', async () => {
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(async () => {
        throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
      })
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '尚未保存' });

    await store.getState().selectCharacter('nova');

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'default',
      draftStatus: 'error',
      toastQueue: [expect.objectContaining({
        tone: 'error',
        text: '角色草稿保存失败，请检查角色素材后重试。'
      })]
    });
  });

  test('创建会先保存当前脏草稿，再替换为新角色', async () => {
    const saving = deferred<void>();
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(() => saving.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '创建前保存' });

    const operation = store.getState().createCharacter('新伙伴');
    await settle();
    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(api.createCharacter).not.toHaveBeenCalled();

    saving.resolve();
    await operation;
    expect(api.createCharacter).toHaveBeenCalledWith({ name: '新伙伴' });
    expect(store.getState().selectedCharacterId).toBe('created');
  });

  test('乱序角色草稿加载响应不能覆盖较新的角色选择', async () => {
    const novaDraft = deferred<CharacterDraftV1>();
    const { api } = apiDouble({
      listCharacters: vi.fn(async () => [
        summary('default', 'AI Pet 默认角色', true),
        summary('nova', 'Nova'),
        summary('orbit', 'Orbit')
      ]),
      getCharacterDraft: vi.fn(id => (
        id === 'nova'
          ? novaDraft.promise
          : Promise.resolve(draft(id, id === 'orbit' ? 'Orbit' : 'AI Pet 默认角色'))
      ))
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    const firstSelection = store.getState().selectCharacter('nova');
    const secondSelection = store.getState().selectCharacter('orbit');
    await secondSelection;
    novaDraft.resolve(draft('nova', 'Nova'));
    await firstSelection;

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'orbit',
      draft: expect.objectContaining({ id: 'orbit' }),
      busyAction: null
    });
  });

  test('新建、复制、删除、启用、导入导出与素材导入都有明确 busy 和成功通知', async () => {
    const characters = [
      summary('default', 'AI Pet 默认角色', true),
      summary('nova', 'Nova'),
      summary('created', '新伙伴'),
      summary('copy', 'Nova 副本'),
      summary('imported', '导入角色')
    ];
    const { api } = apiDouble({
      listCharacters: vi.fn(async () => characters)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    const creating = store.getState().createCharacter('新伙伴');
    expect(store.getState().busyAction).toBe('creating');
    await creating;
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'created',
      busyAction: null,
      toastQueue: [expect.objectContaining({ tone: 'success' })]
    });

    await store.getState().duplicateCharacter('nova');
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'copy',
      toastQueue: expect.arrayContaining([expect.objectContaining({ tone: 'success' })])
    });

    await store.getState().activateCharacter('copy');
    expect(api.activateCharacter).toHaveBeenCalledWith('copy');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      toastQueue: expect.arrayContaining([expect.objectContaining({ tone: 'success' })])
    });

    await store.getState().importSources();
    expect(api.chooseCharacterSources).toHaveBeenCalledWith('copy');
    expect(store.getState().toastQueue.at(-1)).toMatchObject({ tone: 'success' });

    await store.getState().exportCharacterPackage();
    expect(api.exportCharacterPackage).toHaveBeenCalledWith('copy');
    expect(store.getState().toastQueue.at(-1)).toMatchObject({ tone: 'success' });

    await store.getState().importCharacterPackage();
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'imported',
      busyAction: null,
      toastQueue: expect.arrayContaining([expect.objectContaining({ tone: 'success' })])
    });

    await store.getState().deleteCharacter('imported');
    expect(api.deleteCharacter).toHaveBeenCalledWith('imported');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      toastQueue: expect.arrayContaining([expect.objectContaining({ tone: 'success' })])
    });
  });

  test('取消导入导出给出信息通知，异步失败恢复 busy 并产生错误通知', async () => {
    const { api } = apiDouble({
      importCharacterPackage: vi.fn(async () => ({ kind: 'cancelled' as const })),
      exportCharacterPackage: vi.fn(async () => ({ kind: 'cancelled' as const })),
      activateCharacter: vi.fn(async () => {
        throw new Error('CHARACTER_INCOMPLETE');
      })
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    await store.getState().importCharacterPackage();
    expect(store.getState().toastQueue.at(-1)).toMatchObject({
      tone: 'info',
      text: expect.stringContaining('取消')
    });
    await store.getState().exportCharacterPackage();
    expect(store.getState().toastQueue.at(-1)).toMatchObject({
      tone: 'info',
      text: expect.stringContaining('取消')
    });
    await store.getState().activateCharacter('nova');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      toastQueue: expect.arrayContaining([expect.objectContaining({
        tone: 'error',
        text: '该角色动作不完整，需要确认后才能启用。'
      })])
    });
  });

  test('删除当前脏角色会先保存，并在删除请求结束前持续保持 deleting', async () => {
    const saving = deferred<void>();
    const deleting = deferred<void>();
    const { api } = apiDouble({
      saveCharacterDraft: vi.fn(() => saving.promise),
      deleteCharacter: vi.fn(() => deleting.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '删除前保存' });

    const operation = store.getState().deleteCharacter('default');
    await settle();

    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(api.deleteCharacter).not.toHaveBeenCalled();
    saving.resolve();
    await vi.waitFor(() => {
      expect(api.deleteCharacter).toHaveBeenCalledWith('default');
    });
    expect(store.getState().busyAction).toBe('deleting');

    deleting.resolve();
    await operation;
    expect(store.getState().busyAction).toBeNull();
  });

  test('导出期间触发 500ms 自动保存不会抢占或清空 exporting', async () => {
    vi.useFakeTimers();
    const exporting = deferred<Awaited<
      ReturnType<CharacterWorkshopApi['exportCharacterPackage']>
    >>();
    const { api } = apiDouble({
      exportCharacterPackage: vi.fn(() => exporting.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '导出交叠保存' });

    const operation = store.getState().exportCharacterPackage();
    expect(store.getState().busyAction).toBe('exporting');
    await vi.advanceTimersByTimeAsync(500);

    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(store.getState().draftStatus).toBe('saved');
    expect(store.getState().busyAction).toBe('exporting');

    exporting.resolve({ kind: 'exported' });
    await operation;
    expect(store.getState().busyAction).toBeNull();
  });

  test('素材导入期间触发 500ms 自动保存不会抢占或清空 importing', async () => {
    vi.useFakeTimers();
    const importing = deferred<Awaited<
      ReturnType<CharacterWorkshopApi['chooseCharacterSources']>
    >>();
    const { api } = apiDouble({
      chooseCharacterSources: vi.fn(() => importing.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '素材导入交叠保存' });

    const operation = store.getState().importSources();
    expect(store.getState().busyAction).toBe('importing');
    await vi.advanceTimersByTimeAsync(500);

    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(store.getState().busyAction).toBe('importing');

    importing.resolve({ kind: 'cancelled' });
    await operation;
    expect(store.getState().busyAction).toBeNull();
  });

  test('启用期间触发 500ms 自动保存不会抢占或清空 activating', async () => {
    vi.useFakeTimers();
    const activating = deferred<void>();
    const { api } = apiDouble({
      activateCharacter: vi.fn(() => activating.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '启用交叠保存' });

    const operation = store.getState().activateCharacter('nova');
    expect(store.getState().busyAction).toBe('activating');
    await vi.advanceTimersByTimeAsync(500);

    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(store.getState().busyAction).toBe('activating');

    activating.resolve();
    await operation;
    expect(store.getState().busyAction).toBeNull();
  });

  test('发布期间触发 500ms 自动保存不会抢占或清空 compiling', async () => {
    vi.useFakeTimers();
    const publishing = deferred<void>();
    const { api } = apiDouble({
      publishCharacter: vi.fn(() => publishing.promise)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().updateCurrentAction({ name: '发布交叠保存' });

    const operation = store.getState().publishCharacter(publishInput('default'));
    expect(store.getState().busyAction).toBe('compiling');
    await vi.advanceTimersByTimeAsync(500);

    expect(api.saveCharacterDraft).toHaveBeenCalledOnce();
    expect(store.getState().busyAction).toBe('compiling');
    expect(store.getState().compileStatus).toBe('compiling');

    publishing.resolve();
    await operation;
    expect(store.getState()).toMatchObject({
      busyAction: null,
      compileStatus: 'success'
    });
  });

  test('事件刷新角色索引并更新匹配角色编译状态，销毁时取消订阅和定时器', async () => {
    vi.useFakeTimers();
    const { api, emit, unsubscribe } = apiDouble();
    const store = createCharacterWorkshopStore(api);
    const dispose = store.getState().mount();
    await vi.waitFor(() => {
      expect(store.getState().loadStatus).toBe('ready');
    });
    expect(api.listCharacters).toHaveBeenCalledTimes(1);

    emit({ type: 'compile-result', characterId: 'default', ok: true });
    await settle();
    expect(store.getState().compileStatus).toBe('success');
    expect(api.listCharacters).toHaveBeenCalledTimes(2);

    store.getState().updateCurrentAction({ name: '卸载前草稿' });
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.saveCharacterDraft).not.toHaveBeenCalled();
  });

  test('索引事件移除当前角色时自动选择新的启用角色', async () => {
    const listCharacters = vi.fn()
      .mockResolvedValueOnce([
        summary('default', 'AI Pet 默认角色', true),
        summary('nova', 'Nova')
      ])
      .mockResolvedValueOnce([
        summary('orbit', 'Orbit', true)
      ]);
    const { api, emit } = apiDouble({
      listCharacters,
      getCharacterDraft: vi.fn(async id => draft(id, id === 'orbit' ? 'Orbit' : 'AI Pet 默认角色'))
    });
    const store = createCharacterWorkshopStore(api);
    store.getState().mount();
    await vi.waitFor(() => {
      expect(store.getState().loadStatus).toBe('ready');
    });

    emit({ type: 'index-changed' });
    await vi.waitFor(() => {
      expect(store.getState().selectedCharacterId).toBe('orbit');
    });

    expect(store.getState().draft).toMatchObject({ id: 'orbit' });
    expect(store.getState().busyAction).toBeNull();
  });

  test('两个角色事件并发刷新时，新响应先到会保留新响应选中的角色', async () => {
    const older = deferred<CharacterSummaryDto[]>();
    const newer = deferred<CharacterSummaryDto[]>();
    const listCharacters = vi.fn()
      .mockResolvedValueOnce([
        summary('default', 'AI Pet 默认角色', true)
      ])
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const { api, emit } = apiDouble({
      listCharacters,
      getCharacterDraft: vi.fn(async id => draft(id, id === 'orbit' ? 'Orbit' : 'AI Pet 默认角色'))
    });
    const store = createCharacterWorkshopStore(api);
    store.getState().mount();
    await vi.waitFor(() => {
      expect(store.getState().loadStatus).toBe('ready');
    });

    emit({ type: 'index-changed' });
    emit({ type: 'index-changed' });
    await vi.waitFor(() => {
      expect(listCharacters).toHaveBeenCalledTimes(3);
    });
    newer.resolve([summary('orbit', 'Orbit', true)]);

    await vi.waitFor(() => {
      expect(store.getState().selectedCharacterId).toBe('orbit');
    });
    expect(store.getState().characters).toEqual([
      summary('orbit', 'Orbit', true)
    ]);
    expect(store.getState().busyAction).toBeNull();
  });

  test('两个角色事件并发刷新时，旧响应后到不能切回旧角色', async () => {
    const older = deferred<CharacterSummaryDto[]>();
    const newer = deferred<CharacterSummaryDto[]>();
    const listCharacters = vi.fn()
      .mockResolvedValueOnce([
        summary('default', 'AI Pet 默认角色', true)
      ])
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const { api, emit } = apiDouble({
      listCharacters,
      getCharacterDraft: vi.fn(async id => draft(id, id === 'orbit' ? 'Orbit' : 'AI Pet 默认角色'))
    });
    const store = createCharacterWorkshopStore(api);
    store.getState().mount();
    await vi.waitFor(() => {
      expect(store.getState().loadStatus).toBe('ready');
    });

    emit({ type: 'index-changed' });
    emit({ type: 'index-changed' });
    await vi.waitFor(() => {
      expect(listCharacters).toHaveBeenCalledTimes(3);
    });
    newer.resolve([summary('orbit', 'Orbit', true)]);
    await vi.waitFor(() => {
      expect(store.getState().selectedCharacterId).toBe('orbit');
    });

    older.resolve([summary('default', 'AI Pet 默认角色', true)]);
    await vi.waitFor(() => {
      expect(store.getState().busyAction).toBeNull();
    });
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'orbit',
      draft: expect.objectContaining({ id: 'orbit' }),
      characters: [summary('orbit', 'Orbit', true)]
    });
  });

  test('启动时原子恢复活动角色草稿与完整素材目录', async () => {
    const sources = [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png'),
      sourceDto('123e4567-e89b-42d3-a456-426614174001', 'moving.png')
    ];
    const { api } = apiDouble({
      listCharacterSources: vi.fn(async () => sources)
    });
    const store = createCharacterWorkshopStore(api);

    await store.getState().load();

    expect(api.getCharacterDraft).toHaveBeenCalledWith('default');
    expect(api.listCharacterSources).toHaveBeenCalledWith('default');
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'default',
      availableSources: sources
    });
  });

  test('导入新批次后重新读取完整素材目录而不覆盖旧素材', async () => {
    const complete = [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png'),
      sourceDto('123e4567-e89b-42d3-a456-426614174001', 'moving.png')
    ];
    const { api } = apiDouble({
      chooseCharacterSources: vi.fn(async () => ({
        kind: 'selected' as const,
        sources: [{
          ...complete[1]!,
          byteLength: 128,
          sha256: 'a'.repeat(64)
        }]
      })),
      listCharacterSources: vi.fn()
        .mockResolvedValueOnce([complete[0]!])
        .mockResolvedValueOnce(complete)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    await store.getState().importSources();

    expect(store.getState().availableSources).toHaveLength(2);
  });

  test('旧角色导入的迟到素材目录不会覆盖新角色工作区', async () => {
    const oldDirectory = deferred<CharacterWorkshopSourceDto[]>();
    const defaultSources = [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
    ];
    const novaSources = [
      sourceDto('123e4567-e89b-42d3-a456-426614174001', 'nova.png')
    ];
    const listCharacterSources = vi.fn()
      .mockResolvedValueOnce(defaultSources)
      .mockImplementationOnce(() => oldDirectory.promise)
      .mockResolvedValueOnce(novaSources);
    const { api } = apiDouble({
      chooseCharacterSources: vi.fn(async () => ({
        kind: 'selected' as const,
        sources: [{
          ...defaultSources[0]!,
          byteLength: 128,
          sha256: 'a'.repeat(64)
        }]
      })),
      listCharacterSources
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    const importing = store.getState().importSources();
    await settle();
    const selection = store.getState().selectCharacter('nova');
    await selection;
    oldDirectory.resolve(defaultSources);
    await importing;

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'nova',
      draft: expect.objectContaining({ id: 'nova' }),
      availableSources: novaSources
    });
  });

  test('草稿先返回而素材仍在加载时保持稳定工作区', async () => {
    const sources = deferred<CharacterWorkshopSourceDto[]>();
    const previousSources = [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
    ];
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async id => draft(id, id === 'nova' ? 'Nova' : '默认角色')),
      listCharacterSources: vi.fn(id => (
        id === 'nova' ? sources.promise : Promise.resolve(previousSources)
      ))
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    const selection = store.getState().selectCharacter('nova');
    await settle();

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'default',
      draft: expect.objectContaining({ id: 'default' }),
      availableSources: previousSources
    });
    sources.resolve([sourceDto('123e4567-e89b-42d3-a456-426614174001', 'moving.png')]);
    await selection;

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'nova',
      draft: expect.objectContaining({ id: 'nova' })
    });
  });

  test('旧角色素材请求晚到时不能覆盖较新的角色选择', async () => {
    const novaSources = deferred<CharacterWorkshopSourceDto[]>();
    const { api } = apiDouble({
      listCharacters: vi.fn(async () => [
        summary('default', '默认角色', true),
        summary('nova', 'Nova'),
        summary('orbit', 'Orbit')
      ]),
      getCharacterDraft: vi.fn(async id => draft(id, id === 'orbit' ? 'Orbit' : id)),
      listCharacterSources: vi.fn(id => (
        id === 'nova'
          ? novaSources.promise
          : Promise.resolve([sourceDto('123e4567-e89b-42d3-a456-426614174000', `${id}.png`)])
      ))
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    const firstSelection = store.getState().selectCharacter('nova');
    const secondSelection = store.getState().selectCharacter('orbit');
    await secondSelection;
    novaSources.resolve([sourceDto('123e4567-e89b-42d3-a456-426614174001', 'nova.png')]);
    await firstSelection;

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'orbit',
      draft: expect.objectContaining({ id: 'orbit' }),
      availableSources: [sourceDto('123e4567-e89b-42d3-a456-426614174000', 'orbit.png')]
    });
  });

  test('素材目录读取失败时保留稳定角色草稿与素材列表', async () => {
    const previousSources = [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
    ];
    const { api } = apiDouble({
      listCharacterSources: vi.fn(id => (
        id === 'nova'
          ? Promise.reject(new Error('CHARACTER_SOURCE_LIST_FAILED'))
          : Promise.resolve(previousSources)
      ))
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    await store.getState().selectCharacter('nova');

    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'default',
      draft: expect.objectContaining({ id: 'default' }),
      availableSources: previousSources
    });
  });

  test('可直接向指定状态添加动作并选中新动作', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states.push({ id: 'moving', kind: 'core', actions: [] });
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().addAction('moving');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'moving',
      selectedActionId: 'moving-action-1',
      draftStatus: 'dirty'
    });
  });

  test('删除当前动作后优先选中原索引处的下一个动作', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states[0]!.actions.push({
      ...structuredClone(loadedDraft.states[0]!.actions[0]!),
      id: 'idle-next'
    });
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().removeAction('idle', 'idle-main');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'idle',
      selectedActionId: 'idle-next',
      draftStatus: 'dirty'
    });
  });

  test('删除当前最后一个动作后选中前一个动作', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states[0]!.actions.push({
      ...structuredClone(loadedDraft.states[0]!.actions[0]!),
      id: 'idle-next'
    });
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().selectAction('idle-next');

    store.getState().removeAction('idle', 'idle-next');

    expect(store.getState().selectedActionId).toBe('idle-main');
  });

  test('删除唯一动作进入自动保存但保留源素材', async () => {
    vi.useFakeTimers();
    const { api } = apiDouble({
      listCharacterSources: vi.fn(async () => [
        sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
      ])
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().removeAction('idle', 'idle-main');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'idle',
      selectedActionId: null,
      draftStatus: 'dirty',
      availableSources: expect.arrayContaining([
        expect.objectContaining({ displayName: 'idle.png' })
      ])
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.saveCharacterDraft).toHaveBeenCalled();
  });

  test('删除非当前动作时保留当前有效动作选择', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states.push({
      id: 'moving',
      kind: 'core',
      actions: [{
        ...structuredClone(loadedDraft.states[0]!.actions[0]!),
        id: 'moving-main'
      }]
    });
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().removeAction('moving', 'moving-main');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'idle',
      selectedActionId: 'idle-main'
    });
  });

  test('核心状态不能被删除', async () => {
    const { api } = apiDouble();
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    const before = structuredClone(store.getState().draft);

    store.getState().removeExtensionState('idle');

    expect(store.getState()).toMatchObject({
      draft: before,
      selectedStateId: 'idle',
      selectedActionId: 'idle-main',
      draftStatus: 'idle'
    });
  });

  test('删除当前扩展状态后回退到第一个核心状态及其首个动作', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states.push({
      id: 'custom:wave',
      kind: 'extension',
      triggers: { events: ['single_click'], keywords: [], emotions: [] },
      actions: [{
        ...structuredClone(loadedDraft.states[0]!.actions[0]!),
        id: 'wave-main'
      }]
    });
    const sources = [sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')];
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft),
      listCharacterSources: vi.fn(async () => sources)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();
    store.getState().selectState('custom:wave');

    store.getState().removeExtensionState('custom:wave');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'idle',
      selectedActionId: 'idle-main',
      draftStatus: 'dirty',
      availableSources: sources
    });
  });

  test('删除非当前扩展状态时保留当前有效选择', async () => {
    const loadedDraft = draft('default', 'AI Pet 默认角色');
    loadedDraft.states.push({
      id: 'custom:wave',
      kind: 'extension',
      triggers: { events: ['single_click'], keywords: [], emotions: [] },
      actions: []
    });
    const { api } = apiDouble({
      getCharacterDraft: vi.fn(async () => loadedDraft)
    });
    const store = createCharacterWorkshopStore(api);
    await store.getState().load();

    store.getState().removeExtensionState('custom:wave');

    expect(store.getState()).toMatchObject({
      selectedStateId: 'idle',
      selectedActionId: 'idle-main'
    });
  });
});
