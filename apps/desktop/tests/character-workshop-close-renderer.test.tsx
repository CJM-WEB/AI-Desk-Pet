// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV2 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import type { MyselfApi } from '../src/shared/myself-api';
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

afterEach(() => {
  cleanup();
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
    const api = {
      listCharacters: vi.fn(async () => characters),
      createCharacter: vi.fn(),
      duplicateCharacter: vi.fn(),
      getCharacterDraft: vi.fn(async () => draft),
      listCharacterSources: vi.fn(async () => []),
      saveCharacterDraft,
      chooseCharacterSources: vi.fn(),
      readCharacterSource: vi.fn(),
      publishCharacter: vi.fn(),
      activateCharacter: vi.fn(),
      deleteCharacter: vi.fn(),
      importCharacterPackage: vi.fn(),
      exportCharacterPackage: vi.fn(),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      onCharacterWorkshopFlushRequested: vi.fn((listener: () => Promise<void>) => {
        flushListener = listener;
        return unsubscribe;
      })
    } satisfies Pick<
      MyselfApi,
      | 'listCharacters'
      | 'createCharacter'
      | 'duplicateCharacter'
      | 'getCharacterDraft'
      | 'listCharacterSources'
      | 'saveCharacterDraft'
      | 'chooseCharacterSources'
      | 'readCharacterSource'
      | 'publishCharacter'
      | 'activateCharacter'
      | 'deleteCharacter'
      | 'importCharacterPackage'
      | 'exportCharacterPackage'
      | 'subscribeCharacterEvents'
      | 'onCharacterWorkshopFlushRequested'
    >;

    const rendered = render(<CharacterWorkshopView api={api} />);
    const nameInput = await screen.findByLabelText('动作名称');
    fireEvent.change(nameInput, { target: { value: '轻呼吸新版' } });
    await waitFor(() => expect(flushListener).not.toBeNull());

    let flushPromise: Promise<void> | null = null;
    act(() => {
      flushPromise = flushListener?.() ?? null;
    });
    await waitFor(() => expect(saveCharacterDraft).toHaveBeenCalledOnce());
    let settled = false;
    void flushPromise?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSave();
    await act(async () => {
      await flushPromise;
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
    const api = {
      listCharacters: vi.fn(async () => staleCharacters),
      createCharacter: vi.fn(),
      duplicateCharacter: vi.fn(),
      getCharacterDraft: vi.fn(async () => completeDraft),
      listCharacterSources: vi.fn(async () => []),
      saveCharacterDraft: vi.fn(),
      chooseCharacterSources: vi.fn(),
      readCharacterSource: vi.fn(),
      publishCharacter: vi.fn(),
      activateCharacter,
      deleteCharacter: vi.fn(),
      importCharacterPackage: vi.fn(),
      exportCharacterPackage: vi.fn(),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      onCharacterWorkshopFlushRequested: vi.fn(() => vi.fn())
    } satisfies Pick<
      MyselfApi,
      | 'listCharacters'
      | 'createCharacter'
      | 'duplicateCharacter'
      | 'getCharacterDraft'
      | 'listCharacterSources'
      | 'saveCharacterDraft'
      | 'chooseCharacterSources'
      | 'readCharacterSource'
      | 'publishCharacter'
      | 'activateCharacter'
      | 'deleteCharacter'
      | 'importCharacterPackage'
      | 'exportCharacterPackage'
      | 'subscribeCharacterEvents'
      | 'onCharacterWorkshopFlushRequested'
    >;

    render(<CharacterWorkshopView api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '启用角色' }));

    const dialog = await screen.findByRole('dialog', { name: '发布要求尚未满足' });
    expect(dialog.textContent).toContain('默认表现不可播放');
    expect(activateCharacter).not.toHaveBeenCalled();
  });
});
