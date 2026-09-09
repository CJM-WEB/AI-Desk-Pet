// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import type { CharacterDraftV3 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';

const draft: CharacterDraftV3 = {
  version: 3,
  id: 'nova',
  name: 'Nova',
  identity: {
    description: '桌面伙伴', background: '来自桌面', traits: ['友好'],
    languageStyle: '简洁', formsOfAddress: ['朋友'], likes: ['晴天'],
    dislikes: ['噪声'], behavioralTendencies: ['问候'], boundaries: ['尊重隐私'],
    exampleLines: ['你好。']
  },
  defaultSkinId: 'default',
  idleStateId: 'idle',
  skins: [{ id: 'default', name: '默认皮肤', presentations: [], }],
  states: [{
    id: 'idle',
    name: '待机', tags: [], intensity: 20, enterConditions: [],
    exitConditions: [], agentInferable: true, actionIds: ['idle-main']
  }],
  actions: [{
    id: 'idle-main', name: '轻呼吸', tags: [], preference: 1,
    cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal', direction: 'any'
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
    getCharacterMigrationReview: vi.fn(async () => ({ issues: [], resolutions: [] })),
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
      getCharacterMigrationReview: vi.fn(async () => ({ issues: [], resolutions: [] })),
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
  test('应用退出请求仍等待当前 store 的显式保存完成', async () => {
    let closeListener: ((reason: 'window_close' | 'app_quit') => Promise<boolean>) | null = null;
    let releaseSave = (): void => {};
    const savePending = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const saveCharacterDraft = vi.fn(() => savePending);
    const unsubscribe = vi.fn();
    const api = workshopApi({
      saveCharacterDraft,
      onCharacterWorkshopFlushRequested: vi.fn((listener: (
        reason: 'window_close' | 'app_quit'
      ) => Promise<boolean>) => {
        closeListener = listener;
        return unsubscribe;
      })
    });

    const rendered = render(<CharacterWorkshopView api={api} />);
    const nameInput = await screen.findByLabelText('动作名称');
    fireEvent.change(nameInput, { target: { value: '轻呼吸新版' } });
    await waitFor(() => expect(closeListener).not.toBeNull());

    const flush = { promise: null as Promise<boolean> | null };
    act(() => {
      flush.promise = closeListener?.('app_quit') ?? null;
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
    await expect(flush.promise).resolves.toBe(true);

    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test('未保存窗口关闭显示常驻右上角提示，继续编辑不保存也不关闭', async () => {
    let closeListener: ((reason: 'window_close' | 'app_quit') => Promise<boolean>) | null = null;
    const api = workshopApi({
      onCharacterWorkshopFlushRequested: vi.fn((listener: (
        reason: 'window_close' | 'app_quit'
      ) => Promise<boolean>) => {
        closeListener = listener;
        return vi.fn();
      })
    });
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<CharacterWorkshopView api={api} />);
    fireEvent.change(await screen.findByLabelText('动作名称'), {
      target: { value: '尚未保存的动作' }
    });
    await waitFor(() => expect(closeListener).not.toBeNull());

    const requestClose = closeListener as unknown as (
      reason: 'window_close' | 'app_quit'
    ) => Promise<boolean>;
    await expect(requestClose('window_close')).resolves.toBe(false);

    expect(await screen.findByText('草稿尚未保存，确定要关闭工作台吗？')).toBeTruthy();
    expect(api.saveCharacterDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => {
      expect(screen.queryByText('草稿尚未保存，确定要关闭工作台吗？')).toBeNull();
    });
    expect(closeWindow).not.toHaveBeenCalled();
  });

  test('仍然关闭会恢复最后持久化草稿后再次触发标准窗口关闭', async () => {
    let closeListener: ((reason: 'window_close' | 'app_quit') => Promise<boolean>) | null = null;
    const getCharacterDraft = vi.fn(async () => structuredClone(draft));
    const api = workshopApi({
      getCharacterDraft,
      onCharacterWorkshopFlushRequested: vi.fn((listener: (
        reason: 'window_close' | 'app_quit'
      ) => Promise<boolean>) => {
        closeListener = listener;
        return vi.fn();
      })
    });
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<CharacterWorkshopView api={api} />);
    fireEvent.change(await screen.findByLabelText('动作名称'), {
      target: { value: '准备放弃的动作' }
    });
    await waitFor(() => expect(closeListener).not.toBeNull());
    const requestClose = closeListener as unknown as (
      reason: 'window_close' | 'app_quit'
    ) => Promise<boolean>;
    await requestClose('window_close');

    fireEvent.click(await screen.findByRole('button', { name: '仍然关闭' }));

    await waitFor(() => expect(getCharacterDraft).toHaveBeenCalledTimes(2));
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(api.saveCharacterDraft).not.toHaveBeenCalled();
  });

  test('已发布摘要不完整时不以当前草稿完整度绕过启用确认', async () => {
    const completeDraft: CharacterDraftV3 = {
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
      getCharacterMigrationReview: vi.fn(async () => ({ issues: [], resolutions: [] })),
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
