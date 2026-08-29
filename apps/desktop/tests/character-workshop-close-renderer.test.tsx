// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import type { CharacterDraftV2 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';

const draft: CharacterDraftV2 = {
  version: 2,
  id: 'nova',
  name: 'Nova',
  identity: {
    description: '桌面伙伴', background: '来自桌面', traits: ['友好'],
    languageStyle: '简洁', formsOfAddress: ['朋友'], likes: ['晴天'],
    dislikes: ['噪声'], behavioralTendencies: ['问候'], boundaries: ['尊重隐私'],
    exampleLines: ['你好。']
  },
  defaultSkinId: 'default',
  defaultStateId: 'idle',
  skins: [{ id: 'default', name: '默认皮肤', presentations: [], semanticFallbacks: [] }],
  states: [{
    id: 'idle',
    name: '待机', kind: 'primary', semantic: 'idle', tags: [], intensity: 20,
    coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [],
    exitConditions: [], agentInferable: true, actionIds: ['idle-main']
  }],
  actions: [{
    id: 'idle-main', name: '轻呼吸', semantic: 'idle', tags: [], preference: 1,
    cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
    allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
    forbiddenModifierStateIds: [], direction: 'any'
  }]
};

const characters: CharacterSummaryDto[] = [{
  id: 'nova',
  name: 'Nova',
  thumbnailAssetId: null,
  active: true,
  completeness: 'complete',
  missingRequirements: [],
  migrationRecoveryAvailable: false
}];

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) { this.open = true; }
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) { this.open = false; }
    }
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

type CharacterWorkshopViewApi = Parameters<typeof CharacterWorkshopView>[0]['api'];

function workshopApi(
  overrides: Partial<CharacterWorkshopViewApi> = {}
): CharacterWorkshopViewApi {
  return {
    listCharacters: vi.fn(async () => characters),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    getCharacterDraft: vi.fn(async () => draft),
    listCharacterSources: vi.fn(async () => []),
    saveCharacterDraft: vi.fn(),
    chooseCharacterSources: vi.fn(),
    readCharacterSource: vi.fn(),
    publishCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    getCharacterRecoverySnapshot: vi.fn(async () => ({
      fallbackErrorCode: null,
      issues: []
    })),
    getWorkshopLayout: vi.fn(async () => ({
      leftWidth: 300, rightWidth: 300, sidebarTopHeight: 290, stageHeight: 460
    })),
    saveWorkshopLayout: vi.fn(async value => value),
    onCharacterWorkshopFlushRequested: vi.fn(() => vi.fn()),
    ...overrides
  };
}

describe('角色工作室恢复提示', () => {
  test('只读取一次快照并随当前选择过滤内存问题，不触发写操作', async () => {
    const getRecovery = vi.fn(async () => ({
      fallbackErrorCode: null,
      issues: [{
        characterId: 'nova',
        errorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED' as const
      }, {
        characterId: 'luna',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' as const
      }]
    }));
    const listedCharacters: CharacterSummaryDto[] = [characters[0]!, {
      ...characters[0]!, id: 'luna', name: 'Luna', active: false
    }];
    const api = workshopApi({
      listCharacters: vi.fn(async () => listedCharacters),
      getCharacterDraft: vi.fn(async characterId => ({
        ...draft,
        id: characterId,
        name: characterId === 'luna' ? 'Luna' : 'Nova'
      })),
      getCharacterRecoverySnapshot: getRecovery
    });

    render(<StrictMode><CharacterWorkshopView api={api} /></StrictMode>);
    expect(await screen.findByText('角色草稿恢复受阻，当前草稿无法安全保存或发布。'))
      .toBeTruthy();
    expect(screen.queryByText('角色导入恢复暂未完成，现有角色数据保持不变。'))
      .toBeNull();

    const lunaButton = within(screen.getByRole('list', { name: '角色列表' }))
      .getByText('Luna').closest('button');
    if (!lunaButton) throw new Error('缺少 Luna 选择按钮');
    fireEvent.click(lunaButton);
    expect(await screen.findByText('角色导入恢复暂未完成，现有角色数据保持不变。'))
      .toBeTruthy();
    expect(screen.queryByText('角色草稿恢复受阻，当前草稿无法安全保存或发布。'))
      .toBeNull();
    expect(getRecovery).toHaveBeenCalledOnce();
    expect(api.saveCharacterDraft).not.toHaveBeenCalled();
    expect(api.publishCharacter).not.toHaveBeenCalled();
    expect(api.activateCharacter).not.toHaveBeenCalled();
  });

  test('快照读取失败时只显示通用安全文案', async () => {
    const api = workshopApi({
      getCharacterRecoverySnapshot: vi.fn(async () => {
        throw new Error('C:\\Users\\private\\marker.json owner-token-sentinel');
      })
    });

    render(<CharacterWorkshopView api={api} />);

    expect(await screen.findByText('恢复状态暂时无法读取，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('C:\\Users\\private');
    expect(document.body.textContent).not.toContain('owner-token-sentinel');
  });
});

describe('角色工作室 Renderer 关闭刷新', () => {
  test('Main 请求刷新时等待当前 store 的 flushDraft 完成', async () => {
    let flushListener: (() => Promise<void>) | null = null;
    let releaseSave = (): void => {};
    const savePending = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const saveCharacterDraft = vi.fn(() => savePending);
    const unsubscribe = vi.fn();
    const api = workshopApi({
      saveCharacterDraft,
      onCharacterWorkshopFlushRequested: vi.fn((listener: () => Promise<void>) => {
        flushListener = listener;
        return unsubscribe;
      })
    });

    const rendered = render(<CharacterWorkshopView api={api} />);
    const nameInput = await screen.findByLabelText('动作名称');
    fireEvent.change(nameInput, { target: { value: '轻呼吸新版' } });
    await waitFor(() => expect(flushListener).not.toBeNull());

    const flush = { promise: null as Promise<void> | null };
    act(() => {
      flush.promise = flushListener?.() ?? null;
    });
    await waitFor(() => expect(saveCharacterDraft).toHaveBeenCalledOnce());
    if (!flush.promise) throw new Error('未注册草稿刷新监听器');
    let settled = false;
    void flush.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSave();
    await act(async () => {
      await flush.promise;
    });
    expect(settled).toBe(true);

    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test('已发布摘要不完整时不以当前草稿完整度绕过启用确认', async () => {
    const completeDraft: CharacterDraftV2 = {
      ...draft,
      skins: [{
        ...draft.skins[0]!,
        presentations: [{
          actionId: 'idle-main',
          fps: 8,
          frames: [{
            id: 'frame-1',
            assetId: 'idle-atlas',
            x: 0,
            y: 0,
            width: 256,
            height: 256
          }],
          anchors: { ground: { x: 0.5, y: 1 } }
        }]
      }]
    };
    const staleCharacters: CharacterSummaryDto[] = [{
      ...characters[0]!,
      active: false,
      completeness: 'incomplete',
      missingRequirements: ['default-presentation-unplayable']
    }];
    const activateCharacter = vi.fn(async () => undefined);
    const api = workshopApi({
      listCharacters: vi.fn(async () => staleCharacters),
      getCharacterDraft: vi.fn(async () => completeDraft),
      activateCharacter,
    });

    render(<CharacterWorkshopView api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '启用角色' }));

    const dialog = await screen.findByRole('dialog', { name: '发布要求尚未满足' });
    expect(dialog.textContent).toContain('默认表现不可播放');
    expect(activateCharacter).not.toHaveBeenCalled();
  });
});
