// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import {
  CharacterWorkshopWorkspace
} from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import type {
  CharacterWorkshopState
} from '../src/renderer/src/characters/store/character-workshop-store';

vi.mock(
  '../src/renderer/src/characters/workshop/DraftCharacterPreview',
  () => ({ DraftCharacterPreview: () => <div aria-label="预览占位" /> })
);

const showModal = vi.fn(function (this: HTMLDialogElement): void {
  this.open = true;
});
const closeDialog = vi.fn(function (this: HTMLDialogElement): void {
  this.open = false;
});

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: showModal },
    close: { configurable: true, value: closeDialog }
  });
});

afterEach(() => {
  cleanup();
  showModal.mockClear();
  closeDialog.mockClear();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

const configuredDraft: CharacterDraftV1 = {
  version: 1,
  id: 'nova',
  name: 'Nova',
  states: [{
    id: 'idle',
    kind: 'core',
    actions: [{
      id: 'idle-main',
      name: '轻呼吸',
      fps: 8,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: [{
        id: 'frame-1',
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        x: 0,
        y: 0,
        width: 32,
        height: 32
      }]
    }, {
      id: 'idle-empty',
      name: '空动作',
      fps: 8,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: []
    }]
  }, {
    id: 'custom:wave',
    kind: 'extension',
    triggers: { events: [], keywords: [], emotions: [] },
    actions: []
  }]
};

function stateDouble(): CharacterWorkshopState {
  return {
    characters: [{
      id: 'nova',
      name: 'Nova',
      thumbnailAssetId: null,
      active: true,
      completeness: 'complete',
      missingCoreStates: []
    }],
    selectedCharacterId: 'nova',
    draft: structuredClone(configuredDraft),
    selectedStateId: 'idle',
    selectedActionId: 'idle-main',
    draftStatus: 'saved',
    compileStatus: 'idle',
    loadStatus: 'ready',
    busyAction: null,
    toastQueue: [],
    availableSources: [],
    load: vi.fn(async () => undefined),
    mount: vi.fn(() => () => undefined),
    selectCharacter: vi.fn(async () => undefined),
    selectState: vi.fn(),
    selectAction: vi.fn(),
    createCharacter: vi.fn(async () => undefined),
    duplicateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    activateCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => undefined),
    exportCharacterPackage: vi.fn(async () => undefined),
    importSources: vi.fn(async () => undefined),
    addAction: vi.fn(),
    removeAction: vi.fn(),
    addExtensionState: vi.fn(),
    removeExtensionState: vi.fn(),
    applySpriteSheet: vi.fn(async () => undefined),
    compileAndPublish: vi.fn(async () => undefined),
    publishCharacter: vi.fn(async () => undefined),
    updateCurrentAction: vi.fn(),
    flushDraft: vi.fn(async () => undefined),
    dismissToast: vi.fn(),
    dispose: vi.fn()
  };
}

function renderWorkspace(state: CharacterWorkshopState): void {
  render(
    <CharacterWorkshopWorkspace
      state={state}
      api={{ readCharacterSource: vi.fn(async () => new Uint8Array()) }}
    />
  );
}

describe('状态与动作行级删除', () => {
  test('非空配置以模态打开且 Escape 关闭时不删除', () => {
    const state = stateDouble();
    renderWorkspace(state);

    fireEvent.click(screen.getByRole('button', {
      name: '删除动作“轻呼吸”'
    }));
    const dialog = screen.getByRole('dialog');
    expect(showModal).toHaveBeenCalledOnce();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(closeDialog).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.removeAction).not.toHaveBeenCalled();
  });

  test('空动作直接删除而有帧动作必须确认', () => {
    const state = stateDouble();
    renderWorkspace(state);

    fireEvent.click(screen.getByRole('button', {
      name: '删除动作“空动作”'
    }));
    expect(state.removeAction).toHaveBeenCalledWith('idle', 'idle-empty');

    fireEvent.click(screen.getByRole('button', {
      name: '删除动作“轻呼吸”'
    }));
    expect(state.removeAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog').textContent).toContain('1 帧');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(state.removeAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', {
      name: '删除动作“轻呼吸”'
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(state.removeAction).toHaveBeenLastCalledWith('idle', 'idle-main');
  });

  test('空扩展状态直接删除', () => {
    const state = stateDouble();
    renderWorkspace(state);

    fireEvent.click(screen.getByRole('button', {
      name: '删除扩展状态“wave”'
    }));
    expect(state.removeExtensionState).toHaveBeenCalledWith('custom:wave');
  });

  test('包含动作的扩展状态必须确认', () => {
    const state = stateDouble();
    const extension = state.draft?.states.find(
      candidate => candidate.id === 'custom:wave'
    );
    const idleAction = state.draft?.states[0]?.actions[0];
    if (!extension || !idleAction) throw new Error('测试草稿不完整');
    extension.actions = [{ ...structuredClone(idleAction), id: 'wave-main' }];
    renderWorkspace(state);

    fireEvent.click(screen.getByRole('button', {
      name: '删除扩展状态“wave”'
    }));
    expect(state.removeExtensionState).not.toHaveBeenCalled();
    const dialogText = screen.getByRole('dialog').textContent;
    expect(dialogText).toContain('删除扩展状态“wave”');
    expect(dialogText).toContain('1 个动作');

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(state.removeExtensionState).toHaveBeenCalledWith('custom:wave');
  });
});
