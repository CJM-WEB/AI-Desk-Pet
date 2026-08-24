import type {
  ActionFrame,
  CharacterActionDefinitionV2,
  CharacterDraftV2,
  CharacterIdentityV2,
  CharacterSkinV2,
  CharacterStateDefinitionV2,
  DraftActionClip,
  PresentationGeometryV2
} from '@myself/character-runtime';
import {
  characterManifestV2Schema,
  resolveCharacterPresentation
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
    groundAnchor: { x: number; y: number };
  }): Promise<{
    assetId: string;
    fileName: string;
    sha256: string;
    bytes: Uint8Array;
    frames: ActionFrame[];
    geometry: Omit<PresentationGeometryV2, 'resourceRevision'>;
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
  setCurrentActionCommitFrame(frameId: string | null): void;
  requestRemoveCurrentFrame(frameId: string, confirm?: boolean): CharacterReferenceImpact;
  requestRemoveAction(actionId: string, confirm?: boolean): CharacterReferenceImpact;
  removeAction(stateId: string, actionId: string): void;
  removeExtensionState(stateId: string): void;
  addExtensionState(name: string, event: 'single_click' | 'double_click' | 'context_menu'): void;
  applySpriteSheet(input: {
    sourceAssetId: string;
    rows: number;
    columns: number;
    frameCount: number;
  }, confirmCommitFrameRemoval?: boolean): Promise<CharacterReferenceImpact | void>;
  compileAndPublish(): Promise<void>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  updateCurrentAction(patch: LegacyWorkshopActionPatch): void;
  flushDraft(): Promise<void>;
  dismissToast(id: string): void;
  dispose(): void;
}

type WorkshopStore = StoreApi<CharacterWorkshopState>;
const COMPILE_CANCELLED = Symbol('CHARACTER_COMPILE_CANCELLED');

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
  groundAnchor: { x: number; y: number };
}): Promise<{
  assetId: string;
  fileName: string;
  sha256: string;
  bytes: Uint8Array;
  frames: ActionFrame[];
  geometry: Omit<PresentationGeometryV2, 'resourceRevision'>;
}> {
  const compiled = await compileAtlas({
    atlasAssetId: input.atlasAssetId,
    mimeType: 'image/png',
    frames: input.frames,
    groundAnchor: input.groundAnchor
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
    frames: compiled.frames,
    geometry: compiled.geometry
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
  let compileInFlight: Promise<void> | null = null;
  let localCompileEventBarrier: {
    characterId: string;
    selectionRevision: number;
    draftRevision: number;
  } | null = null;
  let saveRequested = false;
  let draftRevision = 0;
  let savedRevision = 0;
  let savedDraftRevisionToken: string | null = null;
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

    const migrationReadFailureText = '旧版角色迁移读取失败，请重试或导出恢复包。';

    function isMigrationRecoveryTarget(characterId: string): boolean {
      return get().characters.some(character => (
        character.id === characterId
        && character.migrationErrorCode === 'CHARACTER_MIGRATION_FAILED'
        && character.migrationRecoveryAvailable
      ));
    }

    /** 初次加载与手动重试共用同一恢复上下文，避免原始路径或堆栈进入提示层。 */
    function enterMigrationRecovery(characterId: string): void {
      workspaceTargetRevision += 1;
      set({
        selectedCharacterId: characterId,
        draft: null,
        selectedEntity: { kind: 'identity' },
        selectedSkinId: null,
        selectedStateId: null,
        selectedActionId: null,
        availableSources: [],
        draftStatus: 'idle',
        compileStatus: 'idle',
        loadStatus: 'error'
      });
      enqueueToast({ tone: 'error', text: migrationReadFailureText });
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
      savedDraftRevisionToken = null;
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
        if (error !== COMPILE_CANCELLED) {
          enqueueToast({ tone: 'error', text: errorText(error) });
        }
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
        draftStatus: 'dirty',
        compileStatus: 'idle'
      });
      if (compileInFlight) {
        // 发布在途时立即把新修订送往 Main，使提交前的修订令牌复核可观察到编辑。
        void get().flushDraft().catch(() => undefined);
      } else {
        scheduleSave();
      }
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
      if (event.type === 'compile-result') {
        const barrier = localCompileEventBarrier;
        const belongsToLocalAttempt = barrier?.characterId === event.characterId;
        const targetsSelectedCharacter = event.characterId === get().selectedCharacterId;
        const localAttemptIsCurrent = belongsToLocalAttempt && (
          barrier.selectionRevision === selectionRevision
          && barrier.draftRevision === draftRevision
          && get().draft?.id === barrier.characterId
        );
        // Main 每次发布只产生一个结果事件；消费后恢复后续外部事件的既有语义。
        if (belongsToLocalAttempt) localCompileEventBarrier = null;
        if (targetsSelectedCharacter && (!belongsToLocalAttempt || localAttemptIsCurrent)) {
          set({ compileStatus: event.ok ? 'success' : 'error' });
          if (!event.ok) enqueueToast({ tone: 'error', text: event.errorCode });
        }
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
        let attemptedCharacterId: string | null = null;
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
          attemptedCharacterId = selected.id;
          await loadSelectedDraft(selected.id, requestRevision);
          if (requestRevision === selectionRevision) set({ loadStatus: 'ready' });
        } catch (error) {
          if (requestRevision === selectionRevision) {
            if (attemptedCharacterId && isMigrationRecoveryTarget(attemptedCharacterId)) {
              enterMigrationRecovery(attemptedCharacterId);
            } else {
              set({ loadStatus: 'error' });
              enqueueToast({ tone: 'error', text: errorText(error) });
            }
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
        // 选择意图立即失效化旧异步任务，实际工作区仍等待当前草稿安全落盘。
        const requestRevision = ++selectionRevision;
        if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
        if (requestRevision !== selectionRevision) return;
        set({ busyAction: 'loading' });
        try {
          await loadSelectedDraft(characterId, requestRevision);
        } catch (error) {
          if (requestRevision === selectionRevision) {
            if (isMigrationRecoveryTarget(characterId)) {
              enterMigrationRecovery(characterId);
            } else {
              enqueueToast({ tone: 'error', text: errorText(error) });
            }
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
        const exportSelectionRevision = selectionRevision;
        const exportDraftRevision = draftRevision;
        await reportFailure('exporting', async () => {
          if (hasPendingDraft() && !await flushBeforeSelectionChange()) return;
          // 保存等待期间目标或草稿发生变化时，旧导出请求不得读取另一修订。
          if (
            selectionRevision !== exportSelectionRevision
            || draftRevision !== exportDraftRevision
            || get().selectedCharacterId !== characterId
            || hasPendingDraft()
          ) return;
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
          const action = draft.actions.find(candidate => candidate.id === actionId)!;
          Object.assign(action, safePatch);
          if (safePatch.semantic === undefined) return;
          // 动作换语义后，原皮肤回退已不再是同语义安全引用。
          draft.skins.forEach(skin => {
            skin.semanticFallbacks = skin.semanticFallbacks.filter(fallback => (
              fallback.actionId !== actionId || fallback.semantic === action.semantic
            ));
            // 提交帧是 carry 专属语义；离开 carry 时必须跨皮肤清除。
            if (action.semantic !== 'carry') {
              skin.presentations.forEach(presentation => {
                if (presentation.actionId === actionId) delete presentation.commitFrameId;
              });
            }
          });
        });
      },

      setCurrentActionCommitFrame(frameId) {
        const current = get();
        const { draft, selectedActionId: actionId, selectedSkinId: skinId } = current;
        if (!draft || !actionId || !skinId) return;
        const action = draft.actions.find(candidate => candidate.id === actionId);
        const skin = draft.skins.find(candidate => candidate.id === skinId);
        const resolved = resolveCharacterPresentation(draft, skinId, actionId);
        if (!action || action.semantic !== 'carry' || !skin || !resolved) return;
        if (frameId !== null && !resolved.presentation.frames.some(frame => frame.id === frameId)) {
          return;
        }
        updateDraft(next => {
          const targetSkin = next.skins.find(candidate => candidate.id === skinId)!;
          let presentation = targetSkin.presentations.find(candidate => candidate.actionId === actionId);
          if (!presentation) {
            const inherited = resolveCharacterPresentation(next, skinId, actionId);
            if (!inherited) return;
            presentation = {
              ...structuredClone(inherited.presentation),
              actionId
            };
            targetSkin.presentations.push(presentation);
          }
          if (frameId === null) delete presentation.commitFrameId;
          else presentation.commitFrameId = frameId;
        });
      },

      requestRemoveCurrentFrame(frameId, confirm = false) {
        const current = get();
        const { draft, selectedActionId: actionId, selectedSkinId: skinId } = current;
        if (!draft || !actionId || !skinId) {
          return { safeReferencePaths: [], blockingReferencePaths: [] };
        }
        const skinIndex = draft.skins.findIndex(candidate => candidate.id === skinId);
        const resolved = resolveCharacterPresentation(draft, skinId, actionId);
        const frameMatches = resolved?.presentation.frames.filter(frame => frame.id === frameId) ?? [];
        if (skinIndex < 0 || !resolved || frameMatches.length !== 1) {
          return { safeReferencePaths: [], blockingReferencePaths: [] };
        }
        const exactPresentationIndex = draft.skins[skinIndex]!.presentations.findIndex(
          candidate => candidate.actionId === actionId
        );
        const referenced = resolved.presentation.commitFrameId === frameId;
        const safeReferencePaths = referenced
          ? [exactPresentationIndex >= 0
            ? `skins.${skinIndex}.presentations.${exactPresentationIndex}.commitFrameId`
            : `skins.${skinIndex}.presentations`]
          : [];
        const impact = { safeReferencePaths, blockingReferencePaths: [] };
        if (referenced && !confirm) return impact;

        updateDraft(next => {
          const targetSkin = next.skins.find(candidate => candidate.id === skinId)!;
          let presentation = targetSkin.presentations.find(candidate => candidate.actionId === actionId);
          if (!presentation) {
            const inherited = resolveCharacterPresentation(next, skinId, actionId);
            if (!inherited) return;
            presentation = {
              ...structuredClone(inherited.presentation),
              actionId
            };
            targetSkin.presentations.push(presentation);
          }
          if (presentation.frames.filter(frame => frame.id === frameId).length !== 1) return;
          if (presentation.commitFrameId === frameId) delete presentation.commitFrameId;
          presentation.frames = presentation.frames.filter(frame => frame.id !== frameId);
        });
        return impact;
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

      async applySpriteSheet(input, confirmCommitFrameRemoval = false) {
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
        const currentCommitFrameId = (): string | undefined => {
          const latest = get();
          return latest.draft
            ? resolveCharacterPresentation(
              latest.draft,
              skinId,
              actionId
            )?.presentation.commitFrameId
            : undefined;
        };
        const markerImpact = (): CharacterReferenceImpact | null => {
          const latest = get();
          const skinIndex = latest.draft?.skins.findIndex(skin => skin.id === skinId) ?? -1;
          const presentationIndex = skinIndex < 0
            ? -1
            : latest.draft!.skins[skinIndex]!.presentations.findIndex(
              presentation => presentation.actionId === actionId
            );
          if (!currentCommitFrameId()) return null;
          return {
            safeReferencePaths: [presentationIndex >= 0
              ? `skins.${skinIndex}.presentations.${presentationIndex}.commitFrameId`
              : `skins.${skinIndex}.presentations`],
            blockingReferencePaths: []
          };
        };
        const markerAtRequest = currentCommitFrameId();
        const initialImpact = markerImpact();
        if (initialImpact && !confirmCommitFrameRemoval) return initialImpact;
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
        // 旧确认只授权清理请求时看到的引用，等待期间的新标记不会被覆盖。
        if (currentCommitFrameId() !== markerAtRequest) return markerImpact() ?? undefined;
        updateDraft(draft => {
          const skin = draft.skins.find(candidate => candidate.id === skinId);
          if (!skin) return;
          const existing = skin.presentations.find(
            presentation => presentation.actionId === actionId
          );
          if (existing) {
            existing.frames = frames;
            delete existing.commitFrameId;
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

      compileAndPublish() {
        if (compileInFlight) return compileInFlight;
        const current = get();
        if (!current.draft || !current.selectedCharacterId) return Promise.resolve();
        const characterId = current.selectedCharacterId;
        const compileSelectionRevision = selectionRevision;
        let cancelled = false;

        const isSelectionCurrent = (): boolean => (
          selectionRevision === compileSelectionRevision
          && get().selectedCharacterId === characterId
          && get().draft?.id === characterId
        );
        const cancelUnless = (condition: boolean): void => {
          if (condition) return;
          cancelled = true;
          throw COMPILE_CANCELLED;
        };

        set({ compileStatus: 'compiling' });
        const publishedOperation = reportFailure('compiling', async () => {
          if (savedDraftRevisionToken === null) {
            set({ draftStatus: 'dirty' });
          }
          try {
            await get().flushDraft();
          } catch (error) {
            cancelUnless(isSelectionCurrent());
            throw error;
          }
          cancelUnless(isSelectionCurrent());
          if (
            draftRevision !== savedRevision
            || !['idle', 'saved'].includes(get().draftStatus)
          ) {
            throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
          }
          const latest = cloneDraft(get().draft!);
          const compileDraftRevision = draftRevision;
          const compileDraftRevisionToken = savedDraftRevisionToken;
          if (compileDraftRevisionToken === null) {
            throw new Error('CHARACTER_DRAFT_SAVE_FAILED');
          }
          const isCompileCurrent = (): boolean => (
            isSelectionCurrent() && draftRevision === compileDraftRevision
          );
          const awaitCurrent = async <T>(pending: Promise<T>): Promise<T> => {
            try {
              const result = await pending;
              cancelUnless(isCompileCurrent());
              return result;
            } catch (error) {
              cancelUnless(isCompileCurrent());
              throw error;
            }
          };
          const defaultState = latest.states.find(state => state.id === latest.defaultStateId);
          const hasPlayableDefault = defaultState?.actionIds.some(actionId => (
            resolveCharacterPresentation(latest, latest.defaultSkinId, actionId) !== null
          ));
          if (!hasPlayableDefault) {
            throw new Error('CHARACTER_DEFAULT_PRESENTATION_UNAVAILABLE');
          }
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
          const resourceByHash = new Map<string, { assetId: string }>();
          const compilationByFrames = new Map<string, Promise<Awaited<ReturnType<
            NonNullable<CharacterWorkshopDependencies['compileAction']>
          >>>>();
          const compiledSkins = [];
          for (const [skinIndex, skin] of latest.skins.entries()) {
            const presentations = [];
            for (const [presentationIndex, presentation] of skin.presentations.entries()) {
              if (presentation.frames.length === 0) continue;
              const atlasAssetId = `atlas-${skinIndex + 1}-${presentationIndex + 1}`;
              const sourceFrames: AtlasSourceFrame[] = [];
              for (const [frameIndex, frame] of presentation.frames.entries()) {
                const bytes = await awaitCurrent(readSource(frame.assetId));
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
              // 几何同时依赖帧与表现 ground；资源内容仍在编译后按摘要去重。
              const compilationKey = JSON.stringify({
                frames: presentation.frames,
                groundAnchor: presentation.anchors.ground
              });
              let compilation = compilationByFrames.get(compilationKey);
              if (!compilation) {
                compilation = (dependencies.compileAction ?? compileBrowserAction)({
                  atlasAssetId,
                  frames: sourceFrames,
                  groundAnchor: presentation.anchors.ground
                });
                compilationByFrames.set(compilationKey, compilation);
              }
              const compiled = await awaitCurrent(compilation);
              const existingResource = resourceByHash.get(compiled.sha256);
              const resourceAssetId = existingResource?.assetId ?? compiled.assetId;
              if (!existingResource) {
                resourceByHash.set(compiled.sha256, { assetId: compiled.assetId });
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
              }
              presentations.push({
                actionId: presentation.actionId,
                fps: presentation.fps,
                ...(presentation.playbackRate === undefined
                  ? {}
                  : { playbackRate: presentation.playbackRate }),
                ...(presentation.mirrorX === undefined
                  ? {}
                  : { mirrorX: presentation.mirrorX }),
                anchors: presentation.anchors,
                ...(presentation.commitFrameId === undefined
                  ? {}
                  : { commitFrameId: presentation.commitFrameId }),
                ...(presentation.regions === undefined
                  ? {}
                  : { regions: presentation.regions }),
                geometry: {
                  ...compiled.geometry,
                  resourceRevision: compiled.sha256
                },
                frames: compiled.frames.map(frame => ({
                  ...frame,
                  assetId: resourceAssetId
                }))
              });
            }
            compiledSkins.push({
              ...skin,
              presentations
            });
          }
          cancelUnless(isCompileCurrent());
          const manifest = characterManifestV2Schema.parse({
            ...latest,
            thumbnailAssetId: manifestResources[0]!.assetId,
            compilerVersion: 'character-atlas-compiler-v2',
            resources: manifestResources,
            skins: compiledSkins
          });
          cancelUnless(isCompileCurrent());
          localCompileEventBarrier = {
            characterId: latest.id,
            selectionRevision: compileSelectionRevision,
            draftRevision: compileDraftRevision
          };
          await awaitCurrent(api.publishCharacter({
            characterId: latest.id,
            draftRevision: compileDraftRevisionToken,
            manifest,
            resources
          }));
          set({ compileStatus: 'success' });
          enqueueToast({ tone: 'success', text: '运行版本已编译并发布。' });
          // 发布已经提交后，索引刷新失败不应把成功发布反转为失败。
          try {
            await refreshCharacters();
          } catch {
            // 后续索引事件仍会刷新视图；此处保留发布成功状态和单一成功提示。
          }
        });
        const operation = publishedOperation.then(published => {
          if (!published && !cancelled && isSelectionCurrent()) {
            set({ compileStatus: 'error' });
          }
        });
        const tracked = operation.finally(() => {
          if (compileInFlight === tracked) compileInFlight = null;
        });
        compileInFlight = tracked;
        return tracked;
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
        const {
          frames,
          fps,
          playbackRate,
          mirrorX,
          anchors,
          regions,
          name,
          direction,
          loop,
          weight
        } = safePatch;
        const actionPatch: Partial<CharacterActionDefinitionV2> = {
          ...(name === undefined ? {} : { name }),
          ...(direction === undefined ? {} : { direction }),
          ...(loop === undefined ? {} : { loopPolicy: loop ? 'presentation' : 'never' }),
          ...(weight === undefined ? {} : { preference: weight })
        };
        if (
          frames === undefined
          && fps === undefined
          && playbackRate === undefined
          && mirrorX === undefined
          && anchors === undefined
          && regions === undefined
        ) {
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
            // 回退表现首次被编辑时先克隆为当前皮肤的精确覆盖，避免改写来源。
            const resolved = resolveCharacterPresentation(draft, skin.id, actionId);
            presentation = {
              ...(resolved ? structuredClone(resolved.presentation) : {}),
              actionId,
              fps: fps ?? resolved?.presentation.fps ?? 8,
              anchors: anchors
                ?? structuredClone(resolved?.presentation.anchors)
                ?? { ground: { x: 0.5, y: 1 } },
              frames: frames
                ?? structuredClone(resolved?.presentation.frames)
                ?? []
            };
            skin.presentations.push(presentation);
          }
          if (frames !== undefined) {
            presentation.frames = frames;
            if (
              presentation.commitFrameId
              && !frames.some(frame => frame.id === presentation.commitFrameId)
            ) delete presentation.commitFrameId;
          }
          if (fps !== undefined) presentation.fps = fps;
          if (playbackRate !== undefined) presentation.playbackRate = playbackRate;
          if (mirrorX !== undefined) presentation.mirrorX = mirrorX;
          if (anchors !== undefined) presentation.anchors = anchors;
          if (regions !== undefined) presentation.regions = regions;
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
            const persistenceRevision = crypto.randomUUID();
            set({ draftStatus: 'saving' });
            try {
              await api.saveCharacterDraft(
                characterId,
                pendingDraft,
                persistenceRevision
              );
              savedRevision = revision;
              if (get().selectedCharacterId === characterId) {
                savedDraftRevisionToken = persistenceRevision;
              }
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
