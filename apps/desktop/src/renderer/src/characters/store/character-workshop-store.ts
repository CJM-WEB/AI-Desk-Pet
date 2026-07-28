import type {
  CharacterDraftV1,
  CharacterStateId,
  DraftActionClip
} from '@myself/character-runtime';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  CharacterEvent,
  CharacterPublishInput,
  CharacterSummaryDto
} from '../../../../shared/character-ipc';
import type { MyselfApi } from '../../../../shared/myself-api';

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

export type WorkshopNotice = {
  tone: 'success' | 'error' | 'info';
  text: string;
} | null;

export type CharacterWorkshopApi = Pick<
  MyselfApi,
  | 'listCharacters'
  | 'createCharacter'
  | 'duplicateCharacter'
  | 'getCharacterDraft'
  | 'saveCharacterDraft'
  | 'chooseCharacterSources'
  | 'publishCharacter'
  | 'activateCharacter'
  | 'deleteCharacter'
  | 'importCharacterPackage'
  | 'exportCharacterPackage'
  | 'subscribeCharacterEvents'
>;

type EditableActionFields = Pick<
  DraftActionClip,
  'name' | 'fps' | 'loop' | 'weight' | 'direction'
>;

export interface CharacterWorkshopState {
  characters: CharacterSummaryDto[];
  selectedCharacterId: string | null;
  draft: CharacterDraftV1 | null;
  selectedStateId: CharacterStateId | null;
  selectedActionId: string | null;
  draftStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  compileStatus: 'idle' | 'compiling' | 'success' | 'error';
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  busyAction: WorkshopBusyAction;
  notice: WorkshopNotice;
  load(): Promise<void>;
  mount(): () => void;
  selectCharacter(characterId: string): Promise<void>;
  selectState(stateId: CharacterStateId): void;
  selectAction(actionId: string): void;
  createCharacter(name: string): Promise<void>;
  duplicateCharacter(characterId: string): Promise<void>;
  deleteCharacter(characterId: string): Promise<void>;
  activateCharacter(characterId: string): Promise<void>;
  importCharacterPackage(): Promise<void>;
  exportCharacterPackage(): Promise<void>;
  importSources(): Promise<void>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  updateCurrentAction(patch: Partial<EditableActionFields>): void;
  flushDraft(): Promise<void>;
  clearNotice(): void;
  dispose(): void;
}

type WorkshopStore = StoreApi<CharacterWorkshopState>;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'CHARACTER_OPERATION_FAILED';
}

function initialSelection(draft: CharacterDraftV1): {
  stateId: CharacterStateId | null;
  actionId: string | null;
} {
  const state = draft.states.find(candidate => candidate.id === 'idle')
    ?? draft.states[0];
  return {
    stateId: state?.id ?? null,
    actionId: state?.actions[0]?.id ?? null
  };
}

function cloneDraft(draft: CharacterDraftV1): CharacterDraftV1 {
  return structuredClone(draft);
}

/**
 * 工作室状态只依赖白名单 API；定时器、订阅和异步版本均封装在 store 实例内。
 */
export function createCharacterWorkshopStore(
  api: CharacterWorkshopApi
): WorkshopStore {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveInFlight: Promise<void> | null = null;
  let saveRequested = false;
  let draftRevision = 0;
  let selectionRevision = 0;
  let listRevision = 0;
  let eventRefreshRevision = 0;
  let eventLoading = false;
  let unsubscribe: (() => void) | undefined;

  const store = createStore<CharacterWorkshopState>((set, get) => {
    function setDraft(draft: CharacterDraftV1): void {
      const selection = initialSelection(draft);
      draftRevision += 1;
      set({
        selectedCharacterId: draft.id,
        draft: cloneDraft(draft),
        selectedStateId: selection.stateId,
        selectedActionId: selection.actionId,
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
      const loadedDraft = await api.getCharacterDraft(characterId);
      if (requestRevision !== selectionRevision) return;
      setDraft(loadedDraft);
    }

    async function reportFailure(
      action: WorkshopBusyAction,
      operation: () => Promise<void>
    ): Promise<void> {
      set({ busyAction: action, notice: null });
      try {
        await operation();
      } catch (error) {
        set({
          notice: { tone: 'error', text: errorText(error) }
        });
      } finally {
        if (get().busyAction === action) set({ busyAction: null });
      }
    }

    function scheduleSave(): void {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void get().flushDraft();
      }, 500);
    }

    function hasPendingDraft(): boolean {
      return get().draftStatus === 'dirty' || get().draftStatus === 'saving';
    }

    async function flushBeforeSelectionChange(): Promise<boolean> {
      await get().flushDraft();
      return get().draftStatus !== 'error';
    }

    async function refreshFromEvent(event: CharacterEvent): Promise<void> {
      const requestRevision = ++eventRefreshRevision;
      if (event.type === 'compile-result' && event.characterId === get().selectedCharacterId) {
        set({
          compileStatus: event.ok ? 'success' : 'error',
          ...(event.ok
            ? {}
            : {
                notice: {
                  tone: 'error' as const,
                  text: event.errorCode
                }
              })
        });
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
            set({
              selectedCharacterId: null,
              draft: null,
              selectedStateId: null,
              selectedActionId: null,
              draftStatus: 'idle',
              compileStatus: 'idle'
            });
          }
        }
      } catch (error) {
        set({ notice: { tone: 'error', text: errorText(error) } });
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
      selectedStateId: null,
      selectedActionId: null,
      draftStatus: 'idle',
      compileStatus: 'idle',
      loadStatus: 'idle',
      busyAction: null,
      notice: null,

      async load() {
        const requestRevision = ++selectionRevision;
        set({
          loadStatus: 'loading',
          busyAction: 'loading',
          notice: null
        });
        try {
          const characters = await refreshCharacters();
          if (requestRevision !== selectionRevision) return;
          const currentId = get().selectedCharacterId;
          const selected = characters.find(character => character.id === currentId)
            ?? characters.find(character => character.active)
            ?? characters[0];
          if (!selected) {
            set({
              selectedCharacterId: null,
              draft: null,
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
            set({
              loadStatus: 'error',
              notice: { tone: 'error', text: errorText(error) }
            });
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
        set({
          selectedCharacterId: characterId,
          draft: null,
          selectedStateId: null,
          selectedActionId: null,
          draftStatus: 'idle',
          compileStatus: 'idle',
          busyAction: 'loading',
          notice: null
        });
        try {
          await loadSelectedDraft(characterId, requestRevision);
        } catch (error) {
          if (requestRevision === selectionRevision) {
            set({ notice: { tone: 'error', text: errorText(error) } });
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
        set({
          selectedStateId: stateId,
          selectedActionId: state.actions[0]?.id ?? null
        });
      },

      selectAction(actionId) {
        const state = get().draft?.states.find(
          candidate => candidate.id === get().selectedStateId
        );
        if (state?.actions.some(action => action.id === actionId)) {
          set({ selectedActionId: actionId });
        }
      },

      async createCharacter(name) {
        const normalizedName = name.trim();
        if (!normalizedName) {
          set({ notice: { tone: 'error', text: '角色名称不能为空。' } });
          return;
        }
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('creating', async () => {
          const created = await api.createCharacter({ name: normalizedName });
          await refreshCharacters();
          selectionRevision += 1;
          setDraft(created);
          set({ notice: { tone: 'success', text: '角色已创建。' } });
        });
      },

      async duplicateCharacter(characterId) {
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('creating', async () => {
          const duplicate = await api.duplicateCharacter(characterId);
          await refreshCharacters();
          selectionRevision += 1;
          setDraft(duplicate);
          set({ notice: { tone: 'success', text: '角色副本已创建。' } });
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
              set({
                selectedCharacterId: null,
                draft: null,
                selectedStateId: null,
                selectedActionId: null,
                draftStatus: 'idle',
                compileStatus: 'idle'
              });
            }
          }
          set({ notice: { tone: 'success', text: '角色已删除。' } });
        });
      },

      async activateCharacter(characterId) {
        await reportFailure('activating', async () => {
          await api.activateCharacter(characterId);
          set({
            characters: get().characters.map(character => ({
              ...character,
              active: character.id === characterId
            })),
            notice: { tone: 'success', text: '角色已启用。' }
          });
          await refreshCharacters();
        });
      },

      async importCharacterPackage() {
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        await reportFailure('importing', async () => {
          const result = await api.importCharacterPackage();
          if (result.kind === 'cancelled') {
            set({ notice: { tone: 'info', text: '已取消导入角色包。' } });
            return;
          }
          await refreshCharacters();
          const requestRevision = ++selectionRevision;
          await loadSelectedDraft(result.characterId, requestRevision);
          set({ notice: { tone: 'success', text: '角色包已导入。' } });
        });
      },

      async exportCharacterPackage() {
        const characterId = get().selectedCharacterId;
        if (!characterId) return;
        await reportFailure('exporting', async () => {
          const result = await api.exportCharacterPackage(characterId);
          set({
            notice: result.kind === 'cancelled'
              ? { tone: 'info', text: '已取消导出角色包。' }
              : { tone: 'success', text: '角色包已导出。' }
          });
        });
      },

      async importSources() {
        const characterId = get().selectedCharacterId;
        if (!characterId) return;
        await reportFailure('importing', async () => {
          const result = await api.chooseCharacterSources(characterId);
          set({
            notice: result.kind === 'cancelled'
              ? { tone: 'info', text: '已取消导入素材。' }
              : {
                  tone: 'success',
                  text: `已导入 ${result.sources.length} 个素材。`
                }
          });
        });
      },

      async publishCharacter(input) {
        set({ compileStatus: 'compiling' });
        await reportFailure('compiling', async () => {
          await api.publishCharacter(input);
          if (input.characterId === get().selectedCharacterId) {
            set({ compileStatus: 'success' });
          }
          set({ notice: { tone: 'success', text: '运行版本已发布。' } });
          await refreshCharacters();
        });
        if (get().busyAction === null && get().notice?.tone === 'error') {
          set({ compileStatus: 'error' });
        }
      },

      updateCurrentAction(patch) {
        const current = get();
        if (!current.draft || !current.selectedStateId || !current.selectedActionId) {
          return;
        }
        const nextDraft = cloneDraft(current.draft);
        const state = nextDraft.states.find(
          candidate => candidate.id === current.selectedStateId
        );
        const action = state?.actions.find(
          candidate => candidate.id === current.selectedActionId
        );
        if (!action) return;
        Object.assign(action, patch);
        draftRevision += 1;
        set({
          draft: nextDraft,
          draftStatus: 'dirty',
          notice: null
        });
        scheduleSave();
      },

      flushDraft() {
        if (saveTimer) {
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
              || current.draftStatus !== 'dirty'
            ) continue;
            const characterId = current.selectedCharacterId;
            const revision = draftRevision;
            const pendingDraft = cloneDraft(current.draft);
            set({ draftStatus: 'saving' });
            try {
              await api.saveCharacterDraft(characterId, pendingDraft);
              if (
                get().selectedCharacterId === characterId
                && draftRevision === revision
              ) {
                set({
                  draftStatus: 'saved',
                  notice: { tone: 'success', text: '草稿已保存。' }
                });
              }
            } catch (error) {
              if (
                get().selectedCharacterId === characterId
                && draftRevision === revision
              ) {
                set({
                  draftStatus: 'error',
                  notice: { tone: 'error', text: errorText(error) }
                });
              }
            }
          }
        };
        saveInFlight = operation().finally(() => {
          saveInFlight = null;
        });
        return saveInFlight;
      },

      clearNotice() {
        set({ notice: null });
      },

      dispose() {
        if (saveTimer) {
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
