// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StateList } from '../src/renderer/src/characters/workshop/StateList';
import { ActionInspector } from '../src/renderer/src/characters/workshop/ActionInspector';
import { StateInspector } from '../src/renderer/src/characters/workshop/StateInspector';
import { CharacterWorkshopWorkspace } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import type { CharacterWorkshopState } from '../src/renderer/src/characters/store/character-workshop-store';

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

const actions = [{
  id: 'idle-main', name: '轻呼吸', tags: [], preference: 1,
  cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation' as const,
  interrupt: 'normal' as const, direction: 'any' as const
}];

const states = [{
  id: 'idle', name: '待机', tags: [],
  intensity: 20, enterConditions: [],
  exitConditions: [], agentInferable: false, actionIds: ['idle-main']
}, {
  id: 'focus', name: '专注', tags: [],
  intensity: 60, enterConditions: [],
  exitConditions: [], agentInferable: true, actionIds: []
}, {
  id: 'happy', name: '开心', tags: [],
  intensity: 80, enterConditions: [],
  exitConditions: [], agentInferable: true, actionIds: []
}];

function stateDouble(
  overrides: Partial<CharacterWorkshopState> = {}
): CharacterWorkshopState {
  const draft = {
    version: 3 as const,
    id: 'nova',
    name: 'Nova',
    identity: {
      description: '桌面伙伴', background: '来自桌面', traits: ['友好'],
      languageStyle: '简洁', formsOfAddress: ['朋友'], likes: ['晴天'],
      dislikes: ['噪声'], behavioralTendencies: ['问候'], boundaries: ['尊重隐私'],
      exampleLines: ['你好。']
    },
    defaultSkinId: 'default', idleStateId: 'idle',
    skins: [{ id: 'default', name: '默认皮肤', presentations: [], }],
    states: [states[0]!], actions
  };
  return {
    characters: [{
      id: 'nova', name: 'Nova', thumbnailAssetId: null, active: true,
      completeness: 'complete', missingRequirements: [], migrationRecoveryAvailable: false
    }],
    migrationReview: { issues: [], resolutions: [] },
    resolveMigrationIssue: vi.fn(),
    setIdleState: vi.fn(),
    selectedCharacterId: 'nova', draft, selectedEntity: { kind: 'action', actionId: 'idle-main' },
    selectedSkinId: 'default', selectedStateId: 'idle', selectedActionId: 'idle-main',
    draftStatus: 'saved', closeConfirmationPending: false,
    compileStatus: 'idle', loadStatus: 'ready', busyAction: null,
    toastQueue: [], availableSources: [], load: vi.fn(async () => undefined),
    mount: vi.fn(() => () => undefined), selectCharacter: vi.fn(async () => undefined),
    selectIdentity: vi.fn(), selectSkin: vi.fn(), selectState: vi.fn(), selectAction: vi.fn(),
    createCharacter: vi.fn(async () => undefined), duplicateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined), activateCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => undefined), exportCharacterPackage: vi.fn(async () => undefined),
    importSources: vi.fn(async () => undefined), updateIdentity: vi.fn(), addSkin: vi.fn(),
    duplicateSkin: vi.fn(), updateSkin: vi.fn(), setDefaultSkin: vi.fn(),
    requestRemoveSkin: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    addState: vi.fn(), updateState: vi.fn(),
    requestRemoveState: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    addAction: vi.fn(), updateAction: vi.fn(),
    setCurrentActionCommitFrame: vi.fn(),
    requestRemoveCurrentFrame: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    requestRemoveAction: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    applySpriteSheet: vi.fn(async () => undefined), compileAndPublish: vi.fn(async () => undefined),
    publishCharacter: vi.fn(async () => undefined), updateCurrentAction: vi.fn(),
    prepareWindowClose: vi.fn(async () => true), resumeAfterClosePrompt: vi.fn(),
    discardUnsavedDraft: vi.fn(async () => undefined),
    flushDraft: vi.fn(async () => undefined), dismissToast: vi.fn(), dispose: vi.fn(),
    ...overrides
  };
}

function renderWorkspace(state: CharacterWorkshopState): ReturnType<typeof render> {
  return render(
    <CharacterWorkshopWorkspace
      state={state}
      api={{ readCharacterSource: vi.fn(async () => new Uint8Array()) }}
    />
  );
}

describe('V2 状态与动作结构化交互', () => {
  test('所有非兜底状态均可请求删除并显示自定义名称', () => {
    const onRequestDeleteState = vi.fn();
    render(
      <StateList
        states={states}
        actions={actions}
        idleStateId="idle"
        selectedStateId="idle"
        selectedActionId="idle-main"
        disabled={false}
        onSelectState={vi.fn()}
        onSelectAction={vi.fn()}
        onAddAction={vi.fn()}
        onRequestDeleteState={onRequestDeleteState}
        onRequestDeleteAction={vi.fn()}
      />
    );

    expect(screen.getByText('兜底状态')).not.toBeNull();
    expect(screen.queryByText('主状态')).toBeNull();
    expect(screen.queryByRole('button', { name: '删除状态“待机”' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除状态“专注”' }));
    expect(onRequestDeleteState).toHaveBeenCalledWith('focus');
  });

  test('动作失败回退选择提交合法动作 ID', () => {
    const onChange = vi.fn();
    const action = { ...actions[0]!, id: 'wave', name: '挥手', };
    render(
      <ActionInspector
        action={action}
        actions={[action, actions[0]!]}
        states={[]}
        disabled={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText('动作失败回退'), {
      target: { value: 'idle-main' }
    });
    expect(onChange).toHaveBeenCalledWith({ failureFallbackActionId: 'idle-main' });
  });

  test('动作标签只提交安全标识且最多 32 项', () => {
    const onChange = vi.fn();
    const inspector = render(
      <ActionInspector
        action={{ ...actions[0]!, tags: ['calm'] }}
        actions={actions}
        states={states}
        disabled={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText('新增动作标签'), {
      target: { value: 'quiet-focus' }
    });
    fireEvent.click(screen.getByRole('button', { name: '添加动作标签' }));
    expect(onChange).toHaveBeenCalledWith({ tags: ['calm', 'quiet-focus'] });

    fireEvent.change(screen.getByLabelText('新增动作标签'), {
      target: { value: '非法 标签' }
    });
    expect((screen.getByRole('button', {
      name: '添加动作标签'
    }) as HTMLButtonElement).disabled).toBe(true);

    inspector.rerender(
      <ActionInspector
        action={{
          ...actions[0]!,
          tags: Array.from({ length: 32 }, (_, index) => `tag-${index}`)
        }}
        actions={actions}
        states={states}
        disabled={false}
        onChange={onChange}
      />
    );
    expect((screen.getByLabelText('新增动作标签') as HTMLInputElement).disabled)
      .toBe(true);
  });

  test('动作建议时长只提交有界整数并可清空', () => {
    const onChange = vi.fn();
    render(
      <ActionInspector
        action={{ ...actions[0]!, durationMs: 1_200 }}
        actions={actions}
        states={states}
        disabled={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText('动作建议持续时间（毫秒）'), {
      target: { value: '3600000' }
    });
    expect(onChange).toHaveBeenCalledWith({ durationMs: 3_600_000 });
    fireEvent.change(screen.getByLabelText('动作建议持续时间（毫秒）'), {
      target: { value: '' }
    });
    expect(onChange).toHaveBeenCalledWith({ durationMs: undefined });
  });

  test('回退候选排除会形成传递环路的动作', () => {
    const current = { ...actions[0]!, id: 'action-a', name: '动作 A' };
    const cyclicCandidate = {
      ...actions[0]!, id: 'action-b', name: '动作 B', failureFallbackActionId: 'action-a'
    };
    render(
      <ActionInspector
        action={current}
        actions={[current, cyclicCandidate]}
        states={states}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    const fallback = screen.getByLabelText('动作失败回退') as HTMLSelectElement;
    expect(fallback.querySelector('option[value="action-b"]')).toBeNull();
  });

  test('状态标签通过结构化编辑器添加与删除', () => {
    const onChange = vi.fn();
    render(
      <StateInspector
        state={{ ...states[0]!, tags: ['calm'] }}
        allStates={states}
        disabled={false}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText('新增状态标签'), {
      target: { value: 'quiet-focus' }
    });
    fireEvent.click(screen.getByRole('button', { name: '添加状态标签' }));
    expect(onChange).toHaveBeenCalledWith({ tags: ['calm', 'quiet-focus'] });
    fireEvent.click(screen.getByRole('button', { name: '删除状态标签“calm”' }));
    expect(onChange).toHaveBeenCalledWith({ tags: [] });
  });

  test('正式 V3 字段编辑器继承工作室禁用态', () => {
    render(
      <>
        <ActionInspector
          action={actions[0]!}
          actions={actions}
          states={states}
          disabled
          onChange={vi.fn()}
        />
      </>
    );

    expect((screen.getByLabelText('新增动作标签') as HTMLInputElement).disabled)
      .toBe(true);
    expect((screen.getByLabelText('动作建议持续时间（毫秒）') as HTMLInputElement).disabled)
      .toBe(true);
  });

  test('阻塞引用逐行说明并禁用确认，Escape 关闭且不强制删除', () => {
    const requestRemoveAction = vi.fn(() => ({
      safeReferencePaths: ['states.0.actionIds'],
      blockingReferencePaths: ['actions.1.failureFallbackActionId']
    }));
    renderWorkspace(stateDouble({ requestRemoveAction }));

    fireEvent.click(screen.getByRole('button', { name: '删除动作“轻呼吸”' }));
    expect(screen.getByText('states.0.actionIds')).toBeTruthy();
    expect(screen.getByText('actions.1.failureFallbackActionId')).toBeTruthy();
    expect(screen.getByText(/请先重选/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(requestRemoveAction).toHaveBeenCalledTimes(1);
    expect(requestRemoveAction).not.toHaveBeenCalledWith('idle-main', true);
  });

  test('只有安全引用时确认统一传入 true', () => {
    const requestRemoveAction = vi.fn(() => ({
      safeReferencePaths: ['states.0.actionIds'], blockingReferencePaths: []
    }));
    renderWorkspace(stateDouble({ requestRemoveAction }));

    fireEvent.click(screen.getByRole('button', { name: '删除动作“轻呼吸”' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(requestRemoveAction).toHaveBeenLastCalledWith('idle-main', true);
  });

  test('迁移失败角色显示稳定恢复说明并提供重试与恢复导出', () => {
    const selectCharacter = vi.fn(async () => undefined);
    const exportCharacterPackage = vi.fn(async () => undefined);
    renderWorkspace(stateDouble({
      characters: [{
        id: 'legacy', name: '旧版角色', thumbnailAssetId: null, active: false,
        completeness: 'broken', missingRequirements: [],
        migrationErrorCode: 'CHARACTER_MIGRATION_FAILED', migrationRecoveryAvailable: true
      }],
      migrationReview: { issues: [], resolutions: [] },
    resolveMigrationIssue: vi.fn(),
    setIdleState: vi.fn(),
    selectedCharacterId: 'legacy', draft: null, selectedEntity: { kind: 'identity' },
      selectedSkinId: null, selectedStateId: null, selectedActionId: null,
      loadStatus: 'error', selectCharacter, exportCharacterPackage,
      toastQueue: [{
        id: 'migration-read', tone: 'error',
        text: '旧版角色迁移读取失败，请重试或导出恢复包。'
      }]
    }));

    expect(screen.getByText('旧版角色迁移失败，原始数据仍可恢复。')).toBeTruthy();
    expect(screen.queryByText(/C:\\Users\\secret/u)).toBeNull();
    expect(screen.getByText('旧版角色迁移读取失败，请重试或导出恢复包。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
    fireEvent.click(screen.getByRole('button', { name: '导出恢复包' }));
    expect(selectCharacter).toHaveBeenCalledWith('legacy');
    expect(exportCharacterPackage).toHaveBeenCalledOnce();
  });

  test('迁移恢复直接呈现 Store 稳定错误和后续操作反馈', () => {
    const initial = stateDouble({
      characters: [{
        id: 'legacy', name: '旧版角色', thumbnailAssetId: null, active: false,
        completeness: 'broken', missingRequirements: [],
        migrationErrorCode: 'CHARACTER_MIGRATION_FAILED', migrationRecoveryAvailable: true
      }],
      migrationReview: { issues: [], resolutions: [] },
    resolveMigrationIssue: vi.fn(),
    setIdleState: vi.fn(),
    selectedCharacterId: 'legacy', draft: null, selectedEntity: { kind: 'identity' },
      selectedSkinId: null, selectedStateId: null, selectedActionId: null,
      loadStatus: 'error',
      toastQueue: [{
        id: 'migration-read', tone: 'error',
        text: '旧版角色迁移读取失败，请重试或导出恢复包。'
      }]
    });
    const workspace = renderWorkspace(initial);
    expect(screen.getByText('旧版角色迁移读取失败，请重试或导出恢复包。')).toBeTruthy();

    workspace.rerender(
      <CharacterWorkshopWorkspace
        state={{
          ...initial,
          toastQueue: [
            { id: 'retry-failed', tone: 'error', text: '重试读取失败，请稍后重试。' }
          ]
        }}
        api={{ readCharacterSource: vi.fn(async () => new Uint8Array()) }}
      />
    );
    expect(screen.getByText('重试读取失败，请稍后重试。')).toBeTruthy();

    workspace.rerender(
      <CharacterWorkshopWorkspace
        state={{
          ...initial,
          toastQueue: [
            { id: 'export-failed', tone: 'error', text: '恢复包导出失败，请检查目标位置。' }
          ]
        }}
        api={{ readCharacterSource: vi.fn(async () => new Uint8Array()) }}
      />
    );
    expect(screen.getByText('恢复包导出失败，请检查目标位置。')).toBeTruthy();
  });
});
