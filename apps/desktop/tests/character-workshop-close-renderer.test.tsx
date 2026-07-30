// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import type { MyselfApi } from '../src/shared/myself-api';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';

const draft: CharacterDraftV1 = {
  version: 1,
  id: 'nova',
  name: 'Nova',
  states: [{
    id: 'idle',
    kind: 'core',
    actions: [{
      id: 'idle-main',
      name: '轻呼吸',
      fps: 12,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: []
    }]
  }]
};

const characters: CharacterSummaryDto[] = [{
  id: 'nova',
  name: 'Nova',
  thumbnailAssetId: null,
  active: true,
  completeness: 'complete',
  missingCoreStates: []
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
    const fpsInput = await screen.findByDisplayValue('12');
    fireEvent.change(fpsInput, { target: { value: '24' } });
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
});
