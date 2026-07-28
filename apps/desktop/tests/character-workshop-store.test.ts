import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import type {
  CharacterEvent,
  CharacterPublishInput,
  CharacterSummaryDto
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
});

describe('角色工作室 Zustand 状态层', () => {
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
      busyAction: null,
      notice: { tone: 'success' }
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
      notice: {
        tone: 'error',
        text: 'CHARACTER_DRAFT_SAVE_FAILED'
      }
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
      notice: { tone: 'success' }
    });

    await store.getState().duplicateCharacter('nova');
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'copy',
      notice: { tone: 'success' }
    });

    await store.getState().activateCharacter('copy');
    expect(api.activateCharacter).toHaveBeenCalledWith('copy');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      notice: { tone: 'success' }
    });

    await store.getState().importSources();
    expect(api.chooseCharacterSources).toHaveBeenCalledWith('copy');
    expect(store.getState().notice).toMatchObject({ tone: 'success' });

    await store.getState().exportCharacterPackage();
    expect(api.exportCharacterPackage).toHaveBeenCalledWith('copy');
    expect(store.getState().notice).toMatchObject({ tone: 'success' });

    await store.getState().importCharacterPackage();
    expect(store.getState()).toMatchObject({
      selectedCharacterId: 'imported',
      busyAction: null,
      notice: { tone: 'success' }
    });

    await store.getState().deleteCharacter('imported');
    expect(api.deleteCharacter).toHaveBeenCalledWith('imported');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      notice: { tone: 'success' }
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
    expect(store.getState().notice).toEqual({
      tone: 'info',
      text: expect.stringContaining('取消')
    });
    await store.getState().exportCharacterPackage();
    expect(store.getState().notice).toEqual({
      tone: 'info',
      text: expect.stringContaining('取消')
    });
    await store.getState().activateCharacter('nova');
    expect(store.getState()).toMatchObject({
      busyAction: null,
      notice: {
        tone: 'error',
        text: expect.stringContaining('CHARACTER_INCOMPLETE')
      }
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
    await settle();
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
});
