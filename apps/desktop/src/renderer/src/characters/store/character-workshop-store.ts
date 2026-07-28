import type {
  ActionFrame,
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
import {
  compileAtlas,
  type AtlasSourceFrame
} from '../import/atlas-compiler';
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
  | 'readCharacterSource'
>;

export type ImportedWorkshopSource = {
  assetId: string;
  displayName: string;
  mimeType: 'image/png' | 'image/webp';
};

export interface CharacterWorkshopDependencies {
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
  draft: CharacterDraftV1 | null;
  selectedStateId: CharacterStateId | null;
  selectedActionId: string | null;
  draftStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  compileStatus: 'idle' | 'compiling' | 'success' | 'error';
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  busyAction: WorkshopBusyAction;
  notice: WorkshopNotice;
  availableSources: ImportedWorkshopSource[];
  load(): Promise<void>;
  mount(): () => void;
  selectCharacter(characterId: string): Promise<void>;
  selectState(stateId: CharacterStateId): void;
  selectAction(actionId: string): void;
  createCharacter(name: string): Promise<void>;
  duplicateCharacter(characterId: string): Promise<void>;
  deleteCharacter(characterId: string): Promise<void>;
  activateCharacter(characterId: string, confirmIncomplete?: boolean): Promise<void>;
  importCharacterPackage(): Promise<void>;
  exportCharacterPackage(): Promise<void>;
  importSources(): Promise<void>;
  addAction(): void;
  addExtensionState(name: string, event: 'single_click' | 'double_click' | 'context_menu'): void;
  applySpriteSheet(input: {
    sourceAssetId: string;
    rows: number;
    columns: number;
    frameCount: number;
  }): Promise<void>;
  compileAndPublish(): Promise<void>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  updateCurrentAction(patch: Partial<DraftActionClip>): void;
  flushDraft(): Promise<void>;
  clearNotice(): void;
  dispose(): void;
}

type WorkshopStore = StoreApi<CharacterWorkshopState>;

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : 'CHARACTER_OPERATION_FAILED';
  return characterOperationMessage(code);
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

function imageMimeType(bytes: Uint8Array): 'image/png' | 'image/webp' {
  const png = [0x89, 0x50, 0x4e, 0x47].every((value, index) => bytes[index] === value);
  if (png) return 'image/png';
  const webp = bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
  if (webp) return 'image/webp';
  throw new Error('CHARACTER_IMAGE_MIME_UNSUPPORTED');
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
  let listRevision = 0;
  let eventRefreshRevision = 0;
  let eventLoading = false;
  let unsubscribe: (() => void) | undefined;

  const store = createStore<CharacterWorkshopState>((set, get) => {
    function setDraft(draft: CharacterDraftV1): void {
      const selection = initialSelection(draft);
      draftRevision += 1;
      savedRevision = draftRevision;
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
      availableSources: [],

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
                },
            ...(result.kind === 'selected'
              ? {
                  availableSources: result.sources.map(source => ({
                    assetId: source.assetId,
                    displayName: source.displayName,
                    mimeType: source.mimeType
                  }))
                }
              : {})
          });
        });
      },

      addAction() {
        const current = get();
        if (!current.draft || !current.selectedStateId) return;
        const nextDraft = cloneDraft(current.draft);
        const state = nextDraft.states.find(candidate => (
          candidate.id === current.selectedStateId
        ));
        if (!state) return;
        const base = `${String(state.id).replace(/[^a-z0-9]+/gu, '-')}-action`;
        let index = state.actions.length + 1;
        let id = `${base}-${index}`;
        while (state.actions.some(action => action.id === id)) {
          id = `${base}-${++index}`;
        }
        state.actions.push({
          id,
          name: `动作 ${index}`,
          fps: 8,
          loop: true,
          weight: 1,
          direction: 'any',
          anchors: { ground: { x: 0.5, y: 1 } },
          frames: []
        });
        draftRevision += 1;
        set({
          draft: nextDraft,
          selectedActionId: id,
          draftStatus: 'dirty',
          notice: null
        });
        scheduleSave();
      },

      addExtensionState(name, event) {
        const normalized = name.trim().toLocaleLowerCase('en-US')
          .replace(/[^a-z0-9_-]+/gu, '-')
          .replace(/^-+|-+$/gu, '');
        if (!normalized) {
          set({ notice: { tone: 'error', text: '扩展状态名称不能为空。' } });
          return;
        }
        const current = get();
        if (!current.draft) return;
        const id = `custom:${normalized}` as `custom:${string}`;
        if (current.draft.states.some(state => state.id === id)) {
          set({ notice: { tone: 'error', text: '扩展状态已存在。' } });
          return;
        }
        const nextDraft = cloneDraft(current.draft);
        nextDraft.states.push({
          id,
          kind: 'extension',
          triggers: { events: [event], keywords: [], emotions: [] },
          actions: []
        });
        draftRevision += 1;
        set({
          draft: nextDraft,
          selectedStateId: id,
          selectedActionId: null,
          draftStatus: 'dirty',
          notice: null
        });
        scheduleSave();
      },

      async applySpriteSheet(input) {
        const current = get();
        const source = current.availableSources.find(candidate => (
          candidate.assetId === input.sourceAssetId
        ));
        if (!source || !current.draft || !current.selectedStateId || !current.selectedActionId) {
          set({ notice: { tone: 'error', text: '请先选择动作和已导入素材。' } });
          return;
        }
        if (
          !Number.isSafeInteger(input.rows)
          || !Number.isSafeInteger(input.columns)
          || !Number.isSafeInteger(input.frameCount)
          || input.rows < 1
          || input.columns < 1
          || input.frameCount < 1
          || input.frameCount > input.rows * input.columns
        ) {
          set({ notice: { tone: 'error', text: '精灵图网格参数无效。' } });
          return;
        }
        const bytes = await api.readCharacterSource(
          current.selectedCharacterId!,
          source.assetId
        );
        const dimensions = await (dependencies.inspectImage ?? inspectBrowserImage)(
          bytes,
          source.mimeType
        );
        if (
          dimensions.width % input.columns !== 0
          || dimensions.height % input.rows !== 0
        ) {
          set({ notice: { tone: 'error', text: '图片尺寸不能被网格整除。' } });
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
        get().updateCurrentAction({ frames });
        set({ notice: { tone: 'success', text: '精灵图网格已应用到当前动作。' } });
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
          const manifestResources: CharacterPublishInput['manifest']['resources'] = [];
          const states = [];
          for (const [stateIndex, state] of latest.states.entries()) {
            const actions = [];
            for (const [actionIndex, action] of state.actions.entries()) {
              if (action.frames.length === 0) continue;
              const atlasAssetId = `atlas-${stateIndex + 1}-${actionIndex + 1}`;
              const sourceFrames: AtlasSourceFrame[] = [];
              for (const [frameIndex, frame] of action.frames.entries()) {
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
              actions.push({ ...action, frames: compiled.frames });
            }
            states.push({ ...state, actions });
          }
          if (resources.length === 0) {
            throw new Error('CHARACTER_IDLE_UNAVAILABLE');
          }
          await api.publishCharacter({
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
          set({
            compileStatus: 'success',
            notice: { tone: 'success', text: '运行版本已编译并发布。' }
          });
          await refreshCharacters();
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
              savedRevision = revision;
              if (
                get().selectedCharacterId === characterId
                && draftRevision === revision
              ) {
                set({
                  draftStatus: 'saved',
                  notice: { tone: 'success', text: '草稿已保存。' }
                });
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
                set({
                  draftStatus: 'error',
                  notice: { tone: 'error', text: errorText(error) }
                });
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
