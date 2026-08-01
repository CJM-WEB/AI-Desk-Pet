import type {
  ActionFrame,
  CharacterActionDefinitionV2,
  CharacterDraftV2,
  CharacterIdentityV2,
  CharacterSkinV2,
  CharacterStateDefinitionV2,
  DraftActionClip
} from '@myself/character-runtime';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  CharacterEvent,
  CharacterPublishInput,
  CharacterSummaryDto,
  CharacterWorkshopSourceDto
} from '../../../../shared/character-ipc';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  compileAtlas,
  type AtlasSourceFrame
} from '../import/atlas-compiler';
import { imageMimeType } from '../import/image-decoder';
import { characterOperationMessage } from '../../../../shared/character-recovery';

export type WorkshopBusyAction =
  | 'loading'
  | 'creating'
  | 'saving'
  | 'compiling'
  | 'activating'
  | 'importing'
  | 'exporting'
  | 'deleting'
  | null;

export type WorkshopToast = {
  id: string;
  tone: 'success' | 'info' | 'warning' | 'error';
  text: string;
};

export type CharacterWorkshopApi = Pick<
  MyselfApi,
  | 'listCharacters'
  | 'createCharacter'
  | 'duplicateCharacter'
  | 'getCharacterDraft'
  | 'listCharacterSources'
  | 'saveCharacterDraft'
  | 'chooseCharacterSources'
  | 'publishCharacter'
  | 'activateCharacter'
  | 'deleteCharacter'
  | 'importCharacterPackage'
  | 'exportCharacterPackage'
  | 'subscribeCharacterEvents'
  | 'readCharacterSource'
>;

export type ImportedWorkshopSource = {
  assetId: string;
  displayName: string;
  mimeType: 'image/png' | 'image/webp';
};

export type CharacterWorkshopSelectedEntity =
  | { kind: 'identity' }
  | { kind: 'skin'; skinId: string }
  | { kind: 'state'; stateId: string }
  | { kind: 'action'; actionId: string };

export type CharacterReferenceImpact = {
  safeReferencePaths: string[];
  blockingReferencePaths: string[];
};

type LegacyWorkshopActionPatch = Partial<DraftActionClip>;

export interface CharacterWorkshopDependencies {
  /** 测试可注入稳定 ID；生产默认使用加密安全的 UUID。 */
  createToastId?(): string;
  inspectImage?(bytes: Uint8Array, mimeType: string): Promise<{
    width: number;
    height: number;
  }>;
  compileAction?(input: {
    atlasAssetId: string;
    frames: AtlasSourceFrame[];
  }): Promise<{
    assetId: string;
    fileName: string;
    sha256: string;
    bytes: Uint8Array;
    frames: ActionFrame[];
  }>;
}

export interface CharacterWorkshopState {
  characters: CharacterSummaryDto[];
  selectedCharacterId: string | null;
  draft: CharacterDraftV2 | null;
  selectedEntity: CharacterWorkshopSelectedEntity;
  selectedSkinId: string | null;
  selectedStateId: string | null;
  selectedActionId: string | null;
  draftStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  compileStatus: 'idle' | 'compiling' | 'success' | 'error';
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  busyAction: WorkshopBusyAction;
  toastQueue: WorkshopToast[];
  availableSources: ImportedWorkshopSource[];
  load(): Promise<void>;
  mount(): () => void;
  selectCharacter(characterId: string): Promise<void>;
  selectIdentity(): void;
  selectSkin(skinId: string): void;
  selectState(stateId: string): void;
  selectAction(actionId: string): void;
  createCharacter(name: string): Promise<void>;
  duplicateCharacter(characterId: string): Promise<void>;
  deleteCharacter(characterId: string): Promise<void>;
  activateCharacter(characterId: string, confirmIncomplete?: boolean): Promise<void>;
  importCharacterPackage(): Promise<void>;
  exportCharacterPackage(): Promise<void>;
  importSources(): Promise<void>;
  updateIdentity(patch: Partial<CharacterIdentityV2>): void;
  addSkin(name: string): void;
  duplicateSkin(skinId: string, name: string): void;
  updateSkin(skinId: string, patch: Partial<CharacterSkinV2>): void;
  setDefaultSkin(skinId: string): void;
  requestRemoveSkin(skinId: string, confirm?: boolean): CharacterReferenceImpact;
  addState(input: {
    name: string;
    kind: 'primary' | 'modifier';
    semantic: CharacterStateDefinitionV2['semantic'];
  }): void;
  updateState(stateId: string, patch: Partial<CharacterStateDefinitionV2>): void;
  requestRemoveState(stateId: string, confirm?: boolean): CharacterReferenceImpact;
  addAction(stateId?: string, name?: string): void;
  updateAction(actionId: string, patch: Partial<CharacterActionDefinitionV2>): void;
  requestRemoveAction(actionId: string, confirm?: boolean): CharacterReferenceImpact;
  removeAction(stateId: string, actionId: string): void;
  removeExtensionState(stateId: string): void;
  addExtensionState(name: string, event: 'single_click' | 'double_click' | 'context_menu'): void;
  applySpriteSheet(input: {
    sourceAssetId: string;
    rows: number;
    columns: number;
    frameCount: number;
  }): Promise<void>;
  compileAndPublish(): Promise<void>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  updateCurrentAction(patch: LegacyWorkshopActionPatch): void;
  flushDraft(): Promise<void>;
  dismissToast(id: string): void;
  dispose(): void;
}

type WorkshopStore = StoreApi<CharacterWorkshopState>;

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : 'CHARACTER_OPERATION_FAILED';
  return characterOperationMessage(code);
}

function initialSelection(draft: CharacterDraftV2): {
  skinId: string | null;
  stateId: string | null;
  actionId: string | null;
  entity: CharacterWorkshopSelectedEntity;
} {
  const skin = draft.skins.find(candidate => candidate.id === draft.defaultSkinId)
    ?? draft.skins[0];
  const state = draft.states.find(candidate => candidate.id === draft.defaultStateId)
    ?? draft.states[0];
  const actionId = state?.actionIds.find(id => draft.actions.some(action => action.id === id))
    ?? null;
  return {
    skinId: skin?.id ?? null,
    stateId: state?.id ?? null,
    actionId,
    entity: actionId
      ? { kind: 'action', actionId }
      : state
        ? { kind: 'state', stateId: state.id }
        : skin
          ? { kind: 'skin', skinId: skin.id }
          : { kind: 'identity' }
  };
}

function cloneDraft(draft: CharacterDraftV2): CharacterDraftV2 {
  return structuredClone(draft);
}

function sameSelectedEntity(
  left: CharacterWorkshopSelectedEntity,
  right: CharacterWorkshopSelectedEntity
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'identity' && right.kind === 'identity') return true;
  if (left.kind === 'skin' && right.kind === 'skin') return left.skinId === right.skinId;
  if (left.kind === 'state' && right.kind === 'state') return left.stateId === right.stateId;
  return left.kind === 'action'
    && right.kind === 'action'
    && left.actionId === right.actionId;
}

/** 从可读名称生成有界、确定且碰撞安全的 V2 标识符。 */
function createEntityId(
  name: string,
  fallback: string,
  usedIds: ReadonlySet<string>
): string {
  const normalized = name.trim().toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 112);
  const base = normalized || fallback;
  let candidate = base.slice(0, 120);
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const postfix = `-${suffix++}`;
    candidate = `${base.slice(0, 120 - postfix.length)}${postfix}`;
  }
  return candidate;
}

async function inspectBrowserImage(
  bytes: Uint8Array,
  mimeType: string
): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([
    Uint8Array.from(bytes).buffer
  ], { type: mimeType }));
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

async function compileBrowserAction(input: {
  atlasAssetId: string;
  frames: AtlasSourceFrame[];
}): Promise<{
  assetId: string;
  fileName: string;
  sha256: string;
  bytes: Uint8Array;
  frames: ActionFrame[];
}> {
  const compiled = await compileAtlas({
    atlasAssetId: input.atlasAssetId,
    mimeType: 'image/png',
    frames: input.frames
  }, (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(compiled.bytes).buffer
  );
  const sha256 = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return {
    assetId: input.atlasAssetId,
    fileName: `${input.atlasAssetId}.png`,
    sha256,
    bytes: compiled.bytes,
    frames: compiled.frames
  };
}

/**
 * 工作室状态只依赖白名单 API；定时器、订阅和异步版本均封装在 store 实例内。
 */
export function createCharacterWorkshopStore(
  api: CharacterWorkshopApi,
  dependencies: CharacterWorkshopDependencies = {}
): WorkshopStore {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveInFlight: Promise<void> | null = null;
  let saveRequested = false;
  let draftRevision = 0;
  let savedRevision = 0;
  let selectionRevision = 0;
  let workspaceTargetRevision = 0;
  let listRevision = 0;
  let eventRefreshRevision = 0;
  let eventLoading = false;
  let unsubscribe: (() => void) | undefined;
  const createToastId = dependencies.createToastId ?? (() => crypto.randomUUID());

  const store = createStore<CharacterWorkshopState>((set, get) => {
    /** 只追加提示，确保多个异步操作的到达顺序不会互相覆盖。 */
    function enqueueToast(toast: Omit<WorkshopToast, 'id'>): void {
      set(current => ({
        toastQueue: [...current.toastQueue, { id: createToastId(), ...toast }]
      }));
    }

    /** 只有工作区实际目标变化时才推进 ABA 屏障令牌。 */
    function setWorkspaceTarget(
      patch: Partial<Pick<CharacterWorkshopState,
        'selectedEntity' | 'selectedSkinId' | 'selectedStateId' | 'selectedActionId'>>
    ): void {
      const current = get();
      const nextEntity = patch.selectedEntity ?? current.selectedEntity;
      const nextSkinId = patch.selectedSkinId === undefined
        ? current.selectedSkinId
        : patch.selectedSkinId;
      const nextStateId = patch.selectedStateId === undefined
        ? current.selectedStateId
        : patch.selectedStateId;
      const nextActionId = patch.selectedActionId === undefined
        ? current.selectedActionId
        : patch.selectedActionId;
      if (
        !sameSelectedEntity(current.selectedEntity, nextEntity)
        || current.selectedSkinId !== nextSkinId
        || current.selectedStateId !== nextStateId
        || current.selectedActionId !== nextActionId
      ) {
        workspaceTargetRevision += 1;
      }
      set(patch);
    }

    function setDraft(
      draft: CharacterDraftV2,
      sources: readonly CharacterWorkshopSourceDto[] = []
    ): void {
      const selection = initialSelection(draft);
      draftRevision += 1;
      savedRevision = draftRevision;
      workspaceTargetRevision += 1;
      set({
        selectedCharacterId: draft.id,
        draft: cloneDraft(draft),
        selectedEntity: selection.entity,
        selectedSkinId: selection.skinId,
        selectedStateId: selection.stateId,
        selectedActionId: selection.actionId,
        availableSources: sources.map(({ assetId, displayName, mimeType }) => ({
          assetId,
          displayName,
          mimeType
        })),
        draftStatus: 'idle',
        compileStatus: 'idle'
      });
    }

    async function refreshCharacters(): Promise<CharacterSummaryDto[]> {
      const requestRevision = ++listRevision;
      const characters = await api.listCharacters();
      if (requestRevision === listRevision) set({ characters });
      return characters;
    }

    async function loadSelectedDraft(
      characterId: string,
      requestRevision: number
    ): Promise<void> {
      const [loadedDraft, sources] = await Promise.all([
        api.getCharacterDraft(characterId),
        api.listCharacterSources(characterId)
      ]);
      if (requestRevision !== selectionRevision) return;
      setDraft(loadedDraft, sources);
    }

    async function reportFailure(
      action: WorkshopBusyAction,
      operation: () => Promise<void>
    ): Promise<boolean> {
      set({ busyAction: action });
      try {
        await operation();
        return true;
      } catch (error) {
        enqueueToast({ tone: 'error', text: errorText(error) });
        return false;
      } finally {
        if (get().busyAction === action) set({ busyAction: null });
      }
    }

    function scheduleSave(): void {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        // 定时保存无人等待结果；失败状态已由 flushDraft 写入 store，此处只消费 rejection。
        void get().flushDraft().catch(() => undefined);
      }, 500);
    }

    /** 所有领域编辑统一经过深克隆，并在提交前收敛可能失效的选择。 */
    function updateDraft(
      mutate: (draft: CharacterDraftV2) => void,
      requestedEntity?: CharacterWorkshopSelectedEntity
    ): void {
      const current = get();
      if (!current.draft) return;
      const next = cloneDraft(current.draft);
      mutate(next);

      const selectedSkin = next.skins.find(skin => skin.id === current.selectedSkinId)
        ?? next.skins.find(skin => skin.id === next.defaultSkinId)
        ?? next.skins[0];
      const selectedState = next.states.find(state => state.id === current.selectedStateId)
        ?? next.states.find(state => state.id === next.defaultStateId)
        ?? next.states[0];
      const selectedActionId = selectedState?.actionIds.find(actionId => (
        next.actions.some(action => action.id === actionId)
      )) ?? null;
      const candidateEntity = requestedEntity ?? current.selectedEntity;
      const selectedEntity: CharacterWorkshopSelectedEntity = (
        candidateEntity.kind === 'identity'
        || (candidateEntity.kind === 'skin' && next.skins.some(skin => skin.id === candidateEntity.skinId))
        || (candidateEntity.kind === 'state' && next.states.some(state => state.id === candidateEntity.stateId))
        || (
          candidateEntity.kind === 'action'
          && selectedState?.actionIds.includes(candidateEntity.actionId)
          && next.actions.some(action => action.id === candidateEntity.actionId)
        )
      )
        ? candidateEntity
        : selectedActionId
          ? { kind: 'action', actionId: selectedActionId }
          : selectedState
            ? { kind: 'state', stateId: selectedState.id }
            : selectedSkin
              ? { kind: 'skin', skinId: selectedSkin.id }
              : { kind: 'identity' };
      const resolvedActionId = selectedEntity.kind === 'action'
        ? selectedEntity.actionId
        : selectedActionId;

      draftRevision += 1;
      if (
        !sameSelectedEntity(current.selectedEntity, selectedEntity)
        || current.selectedSkinId !== (selectedSkin?.id ?? null)
        || current.selectedStateId !== (selectedState?.id ?? null)
        || current.selectedActionId !== resolvedActionId
      ) {
        workspaceTargetRevision += 1;
      }
      set({
        draft: next,
        selectedEntity,
        selectedSkinId: selectedSkin?.id ?? null,
        selectedStateId: selectedState?.id ?? null,
        selectedActionId: resolvedActionId,
        draftStatus: 'dirty'
      });
      scheduleSave();
    }

    function hasPendingDraft(): boolean {
      return get().draftStatus === 'dirty'
        || get().draftStatus === 'saving'
        || get().draftStatus === 'error';
    }

    async function flushBeforeSelectionChange(): Promise<boolean> {
      try {
        await get().flushDraft();
        return get().draftStatus !== 'error';
      } catch {
        return false;
      }
    }

    async function refreshFromEvent(event: CharacterEvent): Promise<void> {
      const requestRevision = ++eventRefreshRevision;
      if (event.type === 'compile-result' && event.characterId === get().selectedCharacterId) {
        set({ compileStatus: event.ok ? 'success' : 'error' });
        if (!event.ok) enqueueToast({ tone: 'error', text: event.errorCode });
      }
      if (event.type === 'active-character-changed') {
        set({
          characters: get().characters.map(character => ({
            ...character,
            active: character.id === event.characterId
          }))
        });
      }

      const usesEventLoading = get().busyAction === null
        || (eventLoading && get().busyAction === 'loading');
      if (usesEventLoading) {
        eventLoading = true;
        set({ busyAction: 'loading' });
      }
      try {
        const characters = await refreshCharacters();
        if (requestRevision !== eventRefreshRevision) return;
        const selectedId = get().selectedCharacterId;
        if (
          selectedId
          && !characters.some(character => character.id === selectedId)
        ) {
          const next = characters.find(character => character.active)
            ?? characters[0];
          const requestRevision = ++selectionRevision;
          if (next) {
            await loadSelectedDraft(next.id, requestRevision);
          } else {
            workspaceTargetRevision += 1;
            set({
              selectedCharacterId: null,
              draft: null,
              selectedEntity: { kind: 'identity' },
              selectedSkinId: null,
              selectedStateId: null,
              selectedActionId: null,
              draftStatus: 'idle',
              compileStatus: 'idle'
            });
          }
        }
      } catch (error) {
        enqueueToast({ tone: 'error', text: errorText(error) });
      } finally {
        if (requestRevision === eventRefreshRevision && eventLoading) {
          if (get().busyAction === 'loading') set({ busyAction: null });
          eventLoading = false;
        }
      }
    }

    return {
      characters: [],
      selectedCharacterId: null,
      draft: null,
      selectedEntity: { kind: 'identity' },
      selectedSkinId: null,
      selectedStateId: null,
      selectedActionId: null,
      draftStatus: 'idle',
      compileStatus: 'idle',
      loadStatus: 'idle',
      busyAction: null,
      toastQueue: [],
      availableSources: [],

      async load() {
        const requestRevision = ++selectionRevision;
        set({
          loadStatus: 'loading',
          busyAction: 'loading',
          toastQueue: []
        });
        try {
          const characters = await refreshCharacters();
          if (requestRevision !== selectionRevision) return;
          const currentId = get().selectedCharacterId;
          const selected = characters.find(character => character.id === currentId)
            ?? characters.find(character => character.active)
            ?? characters[0];
          if (!selected) {
            if (get().draft) workspaceTargetRevision += 1;
            set({
              selectedCharacterId: null,
              draft: null,
              selectedEntity: { kind: 'identity' },
              selectedSkinId: null,
              selectedStateId: null,
              selectedActionId: null,
              draftStatus: 'idle',
              compileStatus: 'idle',
              loadStatus: 'ready'
            });
            return;
          }
          await loadSelectedDraft(selected.id, requestRevision);
          if (requestRevision === selectionRevision) set({ loadStatus: 'ready' });
        } catch (error) {
          if (requestRevision === selectionRevision) {
            set({ loadStatus: 'error' });
            enqueueToast({ tone: 'error', text: errorText(error) });
          }
        } finally {
          if (
            requestRevision === selectionRevision
            && get().busyAction === 'loading'
          ) {
            set({ busyAction: null });
          }
        }
      },

      mount() {
        if (!unsubscribe) {
          unsubscribe = api.subscribeCharacterEvents(event => {
            void refreshFromEvent(event);
          });
        }
        void get().load();
        return () => get().dispose();
      },

      async selectCharacter(characterId) {
        if (characterId === get().selectedCharacterId && get().draft) return;
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        const requestRevision = ++selectionRevision;
        set({ busyAction: 'loading' });
        try {
          await loadSelectedDraft(characterId, requestRevision);
        } catch (error) {
          if (requestRevision === selectionRevision) {
            enqueueToast({ tone: 'error', text: errorText(error) });
          }
        } finally {
          if (
            requestRevision === selectionRevision
            && get().busyAction === 'loading'
          ) {
            set({ busyAction: null });
          }
        }
      },

      selectState(stateId) {
        const state = get().draft?.states.find(candidate => candidate.id === stateId);
        if (!state) return;
        const actionId = state.actionIds.find(id => (
          get().draft?.actions.some(action => action.id === id)
        )) ?? null;
        setWorkspaceTarget({
          selectedEntity: { kind: 'state', stateId },
          selectedStateId: stateId,
          selectedActionId: actionId
        });
      },

      selectIdentity() {
        setWorkspaceTarget({ selectedEntity: { kind: 'identity' } });
      },

      selectSkin(skinId) {
        if (!get().draft?.skins.some(skin => skin.id === skinId)) return;
        setWorkspaceTarget({
          selectedSkinId: skinId,
          selectedEntity: { kind: 'skin', skinId }
        });
      },

      selectAction(actionId) {
        const state = get().draft?.states.find(
          candidate => candidate.id === get().selectedStateId
        );
        if (
          state?.actionIds.includes(actionId)
          && get().draft?.actions.some(action => action.id === actionId)
        ) {
          setWorkspaceTarget({
            selectedEntity: { kind: 'action', actionId },
            selectedActionId: actionId
          });
        }
      },

      async createCharacter(name) {
        const normalizedName = name.trim();
        if (!normalizedName) {
          enqueueToast({ tone: 'error', text: '角色名称不能为空。' });
          return;
        }
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('creating', async () => {
          const created = await api.createCharacter({ name: normalizedName });
          await refreshCharacters();
          selectionRevision += 1;
          setDraft(created);
          enqueueToast({ tone: 'success', text: '角色已创建。' });
        });
      },

      async duplicateCharacter(characterId) {
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('creating', async () => {
          const duplicate = await api.duplicateCharacter(characterId);
          await refreshCharacters();
          const requestRevision = ++selectionRevision;
          await loadSelectedDraft(duplicate.id, requestRevision);
          enqueueToast({ tone: 'success', text: '角色副本已创建。' });
        });
      },

      async deleteCharacter(characterId) {
        if (
          get().selectedCharacterId === characterId
          && hasPendingDraft()
          && !await flushBeforeSelectionChange()
        ) {
          return;
        }
        await reportFailure('deleting', async () => {
          await api.deleteCharacter(characterId);
          const characters = await refreshCharacters();
          if (get().selectedCharacterId === characterId) {
            const next = characters.find(character => character.active)
              ?? characters[0];
            selectionRevision += 1;
            if (next) {
              const requestRevision = selectionRevision;
              await loadSelectedDraft(next.id, requestRevision);
            } else {
              workspaceTargetRevision += 1;
              set({
                selectedCharacterId: null,
                draft: null,
                selectedEntity: { kind: 'identity' },
                selectedSkinId: null,
                selectedStateId: null,
                selectedActionId: null,
                draftStatus: 'idle',
                compileStatus: 'idle'
              });
            }
          }
          enqueueToast({ tone: 'success', text: '角色已删除。' });
        });
      },

      async activateCharacter(characterId, confirmIncomplete = false) {
        await reportFailure('activating', async () => {
          if (confirmIncomplete) {
            await api.activateCharacter(characterId, { confirmIncomplete: true });
          } else {
            await api.activateCharacter(characterId);
          }
          set({
            characters: get().characters.map(character => ({
              ...character,
              active: character.id === characterId
            }))
          });
          enqueueToast({ tone: 'success', text: '角色已启用。' });
          await refreshCharacters();
        });
      },

      async importCharacterPackage() {
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('importing', async () => {
          const result = await api.importCharacterPackage();
          if (result.kind === 'cancelled') {
            enqueueToast({ tone: 'info', text: '已取消导入角色包。' });
            return;
          }
          await refreshCharacters();
          const requestRevision = ++selectionRevision;
          await loadSelectedDraft(result.characterId, requestRevision);
          enqueueToast({ tone: 'success', text: '角色包已导入。' });
        });
      },

      async exportCharacterPackage() {
        const characterId = get().selectedCharacterId;
        if (!characterId) return;
        await reportFailure('exporting', async () => {
          const result = await api.exportCharacterPackage(characterId);
          enqueueToast(result.kind === 'cancelled'
            ? { tone: 'info', text: '已取消导出角色包。' }
            : { tone: 'success', text: '角色包已导出。' });
        });
      },

      async importSources() {
        const characterId = get().selectedCharacterId;
        if (!characterId) return;
        const requestRevision = selectionRevision;
        await reportFailure('importing', async () => {
          const result = await api.chooseCharacterSources(characterId);
          if (result.kind === 'selected') {
            const sources = await api.listCharacterSources(characterId);
            if (
              requestRevision === selectionRevision
              && get().selectedCharacterId === characterId
            ) {
              set({
                availableSources: sources.map(({ assetId, displayName, mimeType }) => ({
                  assetId,
                  displayName,
                  mimeType
                }))
              });
            }
          }
          enqueueToast(result.kind === 'cancelled'
            ? { tone: 'info', text: '已取消导入素材。' }
            : { tone: 'success', text: `已导入 ${result.sources.length} 个素材。` });
        });
      },

      updateIdentity(patch) {
        const safePatch = structuredClone(patch);
        updateDraft(draft => Object.assign(draft.identity, safePatch));
      },

      addSkin(name) {
        const normalizedName = name.trim();
        const current = get();
        if (!current.draft || !normalizedName) return;
        const id = createEntityId(
          normalizedName,
          'skin',
          new Set(current.draft.skins.map(skin => skin.id))
        );
        updateDraft(draft => {
          draft.skins.push({
            id,
            name: normalizedName,
            presentations: [],
            semanticFallbacks: []
          });
        }, { kind: 'skin', skinId: id });
        setWorkspaceTarget({ selectedSkinId: id });
      },

      duplicateSkin(skinId, name) {
        const normalizedName = name.trim();
        const current = get();
        const source = current.draft?.skins.find(skin => skin.id === skinId);
        if (!current.draft || !source || !normalizedName) return;
        const id = createEntityId(
          normalizedName,
          'skin',
          new Set(current.draft.skins.map(skin => skin.id))
        );
        updateDraft(draft => {
          draft.skins.push({ ...structuredClone(source), id, name: normalizedName });
        }, { kind: 'skin', skinId: id });
        setWorkspaceTarget({ selectedSkinId: id });
      },

      updateSkin(skinId, patch) {
        if (!get().draft?.skins.some(skin => skin.id === skinId)) return;
        const { id: _ignoredId, ...safePatch } = structuredClone(patch);
        updateDraft(draft => {
          Object.assign(draft.skins.find(skin => skin.id === skinId)!, safePatch);
        });
      },

      setDefaultSkin(skinId) {
        if (!get().draft?.skins.some(skin => skin.id === skinId)) return;
        updateDraft(draft => {
          draft.defaultSkinId = skinId;
        }, { kind: 'skin', skinId });
        setWorkspaceTarget({ selectedSkinId: skinId });
      },

      requestRemoveSkin(skinId, confirm = false) {
        const current = get();
        const skinIndex = current.draft?.skins.findIndex(skin => skin.id === skinId) ?? -1;
        if (!current.draft || skinIndex < 0) {
          return { safeReferencePaths: [], blockingReferencePaths: [] };
        }
        const skin = current.draft.skins[skinIndex]!;
        const impact: CharacterReferenceImpact = {
          safeReferencePaths: [
            ...(skin.presentations.length > 0 ? [`skins.${skinIndex}.presentations`] : []),
            ...(skin.semanticFallbacks.length > 0 ? [`skins.${skinIndex}.semanticFallbacks`] : [])
          ],
          blockingReferencePaths: current.draft.defaultSkinId === skinId
            ? ['defaultSkinId']
            : []
        };
        if (
          impact.blockingReferencePaths.length === 0
          && (impact.safeReferencePaths.length === 0 || confirm)
        ) {
          updateDraft(draft => {
            draft.skins = draft.skins.filter(candidate => candidate.id !== skinId);
          });
        }
        return impact;
      },

      addState(input) {
        const normalizedName = input.name.trim();
        const current = get();
        if (!current.draft || !normalizedName) return;
        const id = createEntityId(
          normalizedName,
          'state',
          new Set(current.draft.states.map(state => state.id))
        );
        const safeSemantic = structuredClone(input.semantic);
        updateDraft(draft => {
          draft.states.push({
            id,
            name: normalizedName,
            kind: input.kind,
            semantic: safeSemantic,
            tags: [],
            intensity: 50,
            coexistWithStateIds: [],
            forbiddenStateIds: [],
            enterConditions: [],
            exitConditions: [],
            agentInferable: false,
            actionIds: []
          });
        }, { kind: 'state', stateId: id });
        setWorkspaceTarget({ selectedStateId: id, selectedActionId: null });
      },

      updateState(stateId, patch) {
        if (!get().draft?.states.some(state => state.id === stateId)) return;
        const { id: _ignoredId, ...safePatch } = structuredClone(patch);
        updateDraft(draft => {
          Object.assign(draft.states.find(state => state.id === stateId)!, safePatch);
        });
      },

      requestRemoveState(stateId, confirm = false) {
        const current = get();
        const targetIndex = current.draft?.states.findIndex(state => state.id === stateId) ?? -1;
        if (!current.draft || targetIndex < 0) {
          return { safeReferencePaths: [], blockingReferencePaths: [] };
        }
        const safeReferencePaths: string[] = [];
        current.draft.states.forEach((state, index) => {
          if (state.coexistWithStateIds.includes(stateId)) safeReferencePaths.push(`states.${index}.coexistWithStateIds`);
          if (state.forbiddenStateIds.includes(stateId)) safeReferencePaths.push(`states.${index}.forbiddenStateIds`);
          if (state.enterConditions.some(condition => (
            condition.clauses.some(clause => clause.kind === 'state' && clause.stateId === stateId)
          ))) safeReferencePaths.push(`states.${index}.enterConditions`);
          if (state.exitConditions.some(condition => (
            condition.clauses.some(clause => clause.kind === 'state' && clause.stateId === stateId)
          ))) safeReferencePaths.push(`states.${index}.exitConditions`);
        });
        current.draft.actions.forEach((action, index) => {
          (['allowedPrimaryStateIds', 'forbiddenPrimaryStateIds', 'requiredModifierStateIds', 'forbiddenModifierStateIds'] as const)
            .forEach(field => {
              if (action[field].includes(stateId)) safeReferencePaths.push(`actions.${index}.${field}`);
            });
        });
        const impact: CharacterReferenceImpact = {
          safeReferencePaths,
          blockingReferencePaths: current.draft.defaultStateId === stateId
            ? ['defaultStateId']
            : []
        };
        if (impact.blockingReferencePaths.length === 0 && (safeReferencePaths.length === 0 || confirm)) {
          updateDraft(draft => {
            draft.states = draft.states.filter(state => state.id !== stateId);
            draft.states.forEach(state => {
              state.coexistWithStateIds = state.coexistWithStateIds.filter(id => id !== stateId);
              state.forbiddenStateIds = state.forbiddenStateIds.filter(id => id !== stateId);
              const cleanConditions = (conditions: typeof state.enterConditions) => conditions
                .map(condition => ({
                  ...condition,
                  clauses: condition.clauses.filter(
                    clause => clause.kind !== 'state' || clause.stateId !== stateId
                  )
                }))
                .filter(condition => condition.clauses.length > 0);
              state.enterConditions = cleanConditions(state.enterConditions);
              state.exitConditions = cleanConditions(state.exitConditions);
            });
            draft.actions.forEach(action => {
              action.allowedPrimaryStateIds = action.allowedPrimaryStateIds.filter(id => id !== stateId);
              action.forbiddenPrimaryStateIds = action.forbiddenPrimaryStateIds.filter(id => id !== stateId);
              action.requiredModifierStateIds = action.requiredModifierStateIds.filter(id => id !== stateId);
              action.forbiddenModifierStateIds = action.forbiddenModifierStateIds.filter(id => id !== stateId);
            });
          });
        }
        return impact;
      },

      addAction(stateId, name = '') {
        const current = get();
        const targetStateId = stateId ?? current.selectedStateId;
        const state = current.draft?.states.find(candidate => candidate.id === targetStateId);
        if (!current.draft || !state) return;
        const normalizedName = name.trim() || `动作 ${state.actionIds.length + 1}`;
        const id = createEntityId(
          `${state.id}-action`,
          'action',
          new Set(current.draft.actions.map(action => action.id))
        );
        updateDraft(draft => {
          draft.actions.push({
            id,
            name: normalizedName,
            semantic: typeof state.semantic === 'string' ? state.semantic : 'idle',
            tags: [],
            preference: 1,
            cooldownMs: 0,
            repeatSuppressionMs: 0,
            loopPolicy: 'presentation',
            interrupt: 'normal',
            allowedPrimaryStateIds: [],
            forbiddenPrimaryStateIds: [],
            requiredModifierStateIds: [],
            forbiddenModifierStateIds: [],
            direction: 'any'
          });
          draft.states.find(candidate => candidate.id === targetStateId)!.actionIds.push(id);
        }, { kind: 'action', actionId: id });
        setWorkspaceTarget({
          selectedEntity: { kind: 'action', actionId: id },
          selectedStateId: targetStateId,
          selectedActionId: id
        });
      },

      updateAction(actionId, patch) {
        if (!get().draft?.actions.some(action => action.id === actionId)) return;
        const { id: _ignoredId, ...safePatch } = structuredClone(patch);
        updateDraft(draft => {
          Object.assign(draft.actions.find(action => action.id === actionId)!, safePatch);
        });
      },

      requestRemoveAction(actionId, confirm = false) {
        const current = get();
        if (!current.draft?.actions.some(action => action.id === actionId)) {
          return { safeReferencePaths: [], blockingReferencePaths: [] };
        }
        const safeReferencePaths: string[] = [];
        current.draft.states.forEach((state, index) => {
          if (state.actionIds.includes(actionId)) safeReferencePaths.push(`states.${index}.actionIds`);
        });
        current.draft.skins.forEach((skin, index) => {
          if (skin.presentations.some(presentation => presentation.actionId === actionId)) {
            safeReferencePaths.push(`skins.${index}.presentations`);
          }
          if (skin.semanticFallbacks.some(fallback => fallback.actionId === actionId)) {
            safeReferencePaths.push(`skins.${index}.semanticFallbacks`);
          }
        });
        const blockingReferencePaths = current.draft.actions.flatMap((action, index) => [
          ...(action.failureFallbackActionId === actionId
            ? [`actions.${index}.failureFallbackActionId`]
            : []),
          ...(action.interruptedFallbackActionId === actionId
            ? [`actions.${index}.interruptedFallbackActionId`]
            : [])
        ]);
        const impact = { safeReferencePaths, blockingReferencePaths };
        if (blockingReferencePaths.length === 0 && (safeReferencePaths.length === 0 || confirm)) {
          updateDraft(draft => {
            draft.actions = draft.actions.filter(action => action.id !== actionId);
            draft.states.forEach(state => {
              state.actionIds = state.actionIds.filter(id => id !== actionId);
            });
            draft.skins.forEach(skin => {
              skin.presentations = skin.presentations.filter(presentation => presentation.actionId !== actionId);
              skin.semanticFallbacks = skin.semanticFallbacks.filter(fallback => fallback.actionId !== actionId);
            });
          });
        }
        return impact;
      },

      /** 旧组件在 Task 8 改造前继续通过确认入口删除。 */
      removeAction(_stateId, actionId) {
        get().requestRemoveAction(actionId, true);
      },

      removeExtensionState(stateId) {
        get().requestRemoveState(stateId, true);
      },

      addExtensionState(name, _event) {
        get().addState({
          name,
          kind: 'modifier',
          semantic: { kind: 'custom', value: createEntityId(name, 'state', new Set()) }
        });
      },

      async applySpriteSheet(input) {
        const current = get();
        const characterId = current.selectedCharacterId;
        const requestTargetRevision = workspaceTargetRevision;
        const skinId = current.selectedSkinId;
        const actionId = current.selectedActionId;
        const source = current.availableSources.find(candidate => (
          candidate.assetId === input.sourceAssetId
        ));
        if (!source || !current.draft || !characterId || !skinId || !actionId) {
          enqueueToast({ tone: 'error', text: '请先选择动作和已导入素材。' });
          return;
        }
        /** 异步读取期间任一工作区目标变化都使本次结果失效。 */
        const isStillCurrent = (): boolean => {
          const latest = get();
          return workspaceTargetRevision === requestTargetRevision
            && latest.selectedCharacterId === characterId
            && latest.draft?.id === characterId
            && latest.selectedSkinId === skinId
            && latest.selectedActionId === actionId
            && latest.availableSources.some(candidate => candidate.assetId === source.assetId)
            && latest.draft.skins.some(skin => skin.id === skinId)
            && latest.draft.actions.some(action => action.id === actionId);
        };
        if (
          !Number.isSafeInteger(input.rows)
          || !Number.isSafeInteger(input.columns)
          || !Number.isSafeInteger(input.frameCount)
          || input.rows < 1
          || input.columns < 1
          || input.frameCount < 1
          || input.frameCount > input.rows * input.columns
        ) {
          enqueueToast({ tone: 'error', text: '精灵图网格参数无效。' });
          return;
        }
        let bytes: Uint8Array;
        let dimensions: { width: number; height: number };
        try {
          bytes = await api.readCharacterSource(
            characterId,
            source.assetId
          );
          if (!isStillCurrent()) return;
          dimensions = await (dependencies.inspectImage ?? inspectBrowserImage)(
            bytes,
            source.mimeType
          );
          if (!isStillCurrent()) return;
        } catch (error) {
          if (!isStillCurrent()) return;
          enqueueToast({ tone: 'error', text: errorText(error) });
          return;
        }
        if (
          dimensions.width % input.columns !== 0
          || dimensions.height % input.rows !== 0
        ) {
          enqueueToast({ tone: 'error', text: '图片尺寸不能被网格整除。' });
          return;
        }
        const width = dimensions.width / input.columns;
        const height = dimensions.height / input.rows;
        const frames = Array.from({ length: input.frameCount }, (_, index) => ({
          id: `frame-${index + 1}`,
          assetId: source.assetId,
          x: (index % input.columns) * width,
          y: Math.floor(index / input.columns) * height,
          width,
          height
        }));
        if (!isStillCurrent()) return;
        updateDraft(draft => {
          const skin = draft.skins.find(candidate => candidate.id === skinId);
          if (!skin) return;
          const existing = skin.presentations.find(
            presentation => presentation.actionId === actionId
          );
          if (existing) {
            existing.frames = frames;
          } else {
            skin.presentations.push({
              actionId,
              fps: 8,
              anchors: { ground: { x: 0.5, y: 1 } },
              frames
            });
          }
        });
        enqueueToast({ tone: 'success', text: '精灵图网格已应用到当前动作。' });
      },

      async compileAndPublish() {
        const current = get();
        if (!current.draft || !current.selectedCharacterId) return;
        await reportFailure('compiling', async () => {
          await get().flushDraft();
          if (draftRevision !== savedRevision || get().draftStatus !== 'saved') {
            throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
          }
          const latest = cloneDraft(get().draft!);
          const sourceCache = new Map<string, Promise<Uint8Array>>();
          const readSource = (assetId: string): Promise<Uint8Array> => {
            let pending = sourceCache.get(assetId);
            if (!pending) {
              pending = api.readCharacterSource(latest.id, assetId);
              sourceCache.set(assetId, pending);
            }
            return pending;
          };
          const resources: CharacterPublishInput['resources'] = [];
          const manifestResources: Array<{
            assetId: string;
            fileName: string;
            sha256: string;
            byteLength: number;
          }> = [];
          const states = [];
          const defaultSkin = latest.skins.find(skin => skin.id === latest.defaultSkinId)
            ?? latest.skins[0];
          for (const [stateIndex, state] of latest.states.entries()) {
            const actions = [];
            for (const [actionIndex, actionId] of state.actionIds.entries()) {
              const action = latest.actions.find(candidate => candidate.id === actionId);
              const presentation = defaultSkin?.presentations.find(
                candidate => candidate.actionId === actionId
              );
              if (!action || !presentation || presentation.frames.length === 0) continue;
              const atlasAssetId = `atlas-${stateIndex + 1}-${actionIndex + 1}`;
              const sourceFrames: AtlasSourceFrame[] = [];
              for (const [frameIndex, frame] of presentation.frames.entries()) {
                const bytes = await readSource(frame.assetId);
                sourceFrames.push({
                  frameId: frame.id ?? `frame-${frameIndex + 1}`,
                  sourceAssetId: frame.assetId,
                  bytes,
                  mimeType: imageMimeType(bytes),
                  sourceRect: {
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height
                  },
                  ...(frame.durationMs === undefined
                    ? {}
                    : { durationMs: frame.durationMs }),
                  ...(frame.anchors === undefined
                    ? {}
                    : { anchors: frame.anchors })
                });
              }
              const compiled = await (dependencies.compileAction ?? compileBrowserAction)({
                atlasAssetId,
                frames: sourceFrames
              });
              resources.push({
                assetId: compiled.assetId,
                bytes: Uint8Array.from(compiled.bytes)
              });
              manifestResources.push({
                assetId: compiled.assetId,
                fileName: compiled.fileName,
                sha256: compiled.sha256,
                byteLength: compiled.bytes.byteLength
              });
              actions.push({
                id: action.id,
                name: action.name,
                fps: presentation.fps,
                loop: action.loopPolicy !== 'never',
                weight: action.preference,
                direction: action.direction,
                anchors: presentation.anchors,
                frames: compiled.frames
              });
            }
            states.push({
              id: state.id,
              kind: state.id === 'idle' || state.id === 'thinking' ? 'core' : 'extension',
              actions
            });
          }
          if (resources.length === 0) {
            throw new Error('CHARACTER_IDLE_UNAVAILABLE');
          }
          // Task 7 会将这一旧播放器编译边界替换为严格 V2 发布。
          await (api.publishCharacter as (input: unknown) => Promise<void>)({
            characterId: latest.id,
            manifest: {
              version: 1,
              id: latest.id,
              name: latest.name,
              thumbnailAssetId: resources[0]!.assetId,
              compilerVersion: 'character-atlas-compiler-v1',
              resources: manifestResources,
              states
            },
            resources
          });
          set({ compileStatus: 'success' });
          enqueueToast({ tone: 'success', text: '运行版本已编译并发布。' });
          await refreshCharacters();
        });
      },

      async publishCharacter(input) {
        set({ compileStatus: 'compiling' });
        const published = await reportFailure('compiling', async () => {
          await api.publishCharacter(input);
          if (input.characterId === get().selectedCharacterId) {
            set({ compileStatus: 'success' });
          }
          enqueueToast({ tone: 'success', text: '运行版本已发布。' });
          await refreshCharacters();
        });
        if (!published) set({ compileStatus: 'error' });
      },

      updateCurrentAction(patch) {
        const current = get();
        if (!current.selectedActionId) return;
        const safePatch = structuredClone(patch);
        const { frames, fps, name, direction, loop, weight } = safePatch;
        const actionPatch: Partial<CharacterActionDefinitionV2> = {
          ...(name === undefined ? {} : { name }),
          ...(direction === undefined ? {} : { direction }),
          ...(loop === undefined ? {} : { loopPolicy: loop ? 'presentation' : 'never' }),
          ...(weight === undefined ? {} : { preference: weight })
        };
        if (frames === undefined && fps === undefined) {
          get().updateAction(current.selectedActionId, actionPatch);
          return;
        }
        const actionId = current.selectedActionId;
        const skinId = current.selectedSkinId;
        updateDraft(draft => {
          Object.assign(draft.actions.find(action => action.id === actionId)!, actionPatch);
          const skin = draft.skins.find(candidate => candidate.id === skinId);
          if (!skin) return;
          let presentation = skin.presentations.find(candidate => candidate.actionId === actionId);
          if (!presentation) {
            presentation = {
              actionId,
              fps: fps ?? 8,
              anchors: { ground: { x: 0.5, y: 1 } },
              frames: frames ?? []
            };
            skin.presentations.push(presentation);
          } else {
            if (frames !== undefined) presentation.frames = frames;
            if (fps !== undefined) presentation.fps = fps;
          }
        });
      },

      flushDraft() {
        if (saveTimer !== undefined) {
          clearTimeout(saveTimer);
          saveTimer = undefined;
        }
        saveRequested = true;
        if (saveInFlight) return saveInFlight;

        const operation = async () => {
          while (saveRequested) {
            saveRequested = false;
            const current = get();
            if (
              !current.draft
              || !current.selectedCharacterId
              || (current.draftStatus !== 'dirty' && current.draftStatus !== 'error')
            ) continue;
            const characterId = current.selectedCharacterId;
            const revision = draftRevision;
            const pendingDraft = cloneDraft(current.draft);
            set({ draftStatus: 'saving' });
            try {
              await api.saveCharacterDraft(characterId, pendingDraft);
              savedRevision = revision;
              if (
                get().selectedCharacterId === characterId
                && draftRevision === revision
              ) {
                set({ draftStatus: 'saved' });
              } else if (
                get().selectedCharacterId === characterId
                && draftRevision !== revision
              ) {
                saveRequested = true;
              }
            } catch (error) {
              if (
                get().selectedCharacterId === characterId
                && draftRevision === revision
              ) {
                set({ draftStatus: 'error' });
                enqueueToast({ tone: 'error', text: errorText(error) });
                throw error;
              }
              saveRequested = true;
            }
          }
        };
        saveInFlight = operation().finally(() => {
          saveInFlight = null;
        });
        return saveInFlight;
      },

      dismissToast(id) {
        set(current => ({
          toastQueue: current.toastQueue.filter(toast => toast.id !== id)
        }));
      },

      dispose() {
        if (saveTimer !== undefined) {
          clearTimeout(saveTimer);
          saveTimer = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
      }
    };
  });

  return store;
}
