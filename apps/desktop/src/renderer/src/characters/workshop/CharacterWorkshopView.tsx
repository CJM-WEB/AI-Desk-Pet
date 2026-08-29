import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject
} from 'react';
import {
  Box,
  CheckCircle2,
  Download,
  ImagePlus,
  LoaderCircle,
  PackageOpen,
  Play,
  Plus,
  Save
} from 'lucide-react';
import { useStore } from 'zustand';
import {
  resolveCharacterPresentation,
  STANDARD_CHARACTER_SEMANTICS,
  type DraftActionClip
} from '@myself/character-runtime';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  DEFAULT_WORKSHOP_LAYOUT,
  type WorkshopLayoutSettings
} from '../../../../shared/workshop-layout-ipc';
import type {
  CharacterRecoveryIssueDto,
  CharacterRecoverySnapshotDto
} from '../../../../shared/character-ipc';
import { characterRecoveryPresentation } from '../../../../shared/character-recovery';
import {
  createCharacterWorkshopStore,
  type CharacterWorkshopApi,
  type CharacterWorkshopState,
  type WorkshopBusyAction
} from '../store/character-workshop-store';
import { CharacterList } from './CharacterList';
import { CharacterIdentityInspector } from './CharacterIdentityInspector';
import { StateInspector } from './StateInspector';
import { StateList } from './StateList';
import { ActionInspector } from './ActionInspector';
import {
  ActionTimeline,
  ensureStableFrameIds
} from './ActionTimeline';
import { AnchorEditor } from './AnchorEditor';
import {
  createPreviewState,
  normalizePreviewState,
  PreviewControls,
  type PreviewState
} from './PreviewControls';
import { useModalDialog } from './use-modal-dialog';
import { WorkshopSplitter } from './WorkshopSplitter';
import {
  clampWorkshopLayout,
  preferredWorkshopLayoutForRenderedWidth,
  WORKSHOP_CENTER_MIN,
  WORKSHOP_LEFT_MIN,
  WORKSHOP_RIGHT_MIN,
  WORKSHOP_SIDEBAR_BOTTOM_MIN,
  WORKSHOP_SIDEBAR_TOP_MIN,
  WORKSHOP_SPLITTER_SIZE,
  WORKSHOP_STAGE_HEADER_HEIGHT,
  WORKSHOP_STAGE_MIN,
  WORKSHOP_TIMELINE_MIN,
  type WorkshopLayoutBounds
} from './workshop-layout';
import { AtlasImportPanel } from './AtlasImportPanel';
import {
  TransientToastLayer,
  type TransientToast
} from '../../components/TransientToastLayer';
import {
  DraftCharacterPreview,
  draftActionFromResolvedPresentation
} from './DraftCharacterPreview';
import './character-workshop.css';

/** 工作室保留既有的提示持续时间策略。 */
function workshopToastDurationMs(toast: TransientToast): 3000 | 6000 {
  return toast.tone === 'warning' || toast.tone === 'error' ? 6000 : 3000;
}

export interface CharacterWorkshopViewProps {
  api: CharacterWorkshopApi & Pick<
    MyselfApi,
    | 'onCharacterWorkshopFlushRequested'
    | 'getCharacterRecoverySnapshot'
    | 'getWorkshopLayout'
    | 'saveWorkshopLayout'
  >;
}

export interface CharacterWorkshopWorkspaceProps {
  state: CharacterWorkshopState;
  api: Pick<MyselfApi, 'readCharacterSource'>;
  pendingDeleteCharacterId?: string | null;
  recoveryIssues?: readonly CharacterRecoveryIssueDto[];
  recoveryLoadFailed?: boolean;
  layout?: WorkshopLayoutSettings;
  layoutBounds?: WorkshopLayoutBounds;
  columnsRef?: RefObject<HTMLDivElement | null>;
  layoutNotice?: string | null;
  onLayoutChange?(key: keyof WorkshopLayoutSettings, value: number): void;
  onLayoutCommit?(key: keyof WorkshopLayoutSettings, value: number): void;
}

function currentAction(state: CharacterWorkshopState): DraftActionClip | null {
  if (!state.draft || !state.selectedSkinId || !state.selectedActionId) {
    return null;
  }
  const resolved = resolveCharacterPresentation(
    state.draft,
    state.selectedSkinId,
    state.selectedActionId
  );
  if (!resolved) return null;
  const requestedAction = state.draft.actions.find(
    candidate => candidate.id === state.selectedActionId
  );
  const projected = draftActionFromResolvedPresentation(resolved);
  return requestedAction ? {
    ...projected,
    id: requestedAction.id,
    name: requestedAction.name,
    loop: requestedAction.loopPolicy !== 'never',
    weight: requestedAction.preference,
    direction: requestedAction.direction
  } : projected;
}

type SpriteSheetInput = Parameters<CharacterWorkshopState['applySpriteSheet']>[0];

type PendingConfigurationDelete =
  | {
      kind: 'action';
      id: string;
      name: string;
      safeReferencePaths: string[];
      blockingReferencePaths: string[];
    }
  | {
      kind: 'state';
      id: string;
      name: string;
      safeReferencePaths: string[];
      blockingReferencePaths: string[];
    }
  | {
      kind: 'frame';
      id: string;
      name: string;
      safeReferencePaths: string[];
      blockingReferencePaths: string[];
    }
  | {
      kind: 'sprite-sheet';
      id: string;
      name: string;
      input: SpriteSheetInput;
      safeReferencePaths: string[];
      blockingReferencePaths: string[];
    };

/**
 * 动作身份切换边界：即使新旧帧数相同，也从新动作首帧重新对齐预览与时间轴。
 */
export function previewAtActionStart(
  preview: PreviewState,
  action: DraftActionClip | null
): { preview: PreviewState; selectedFrameId: string | null } {
  const frames = action ? ensureStableFrameIds(action.frames) : [];
  return {
    preview: {
      ...normalizePreviewState(preview, frames.length),
      playing: false,
      frameIndex: frames.length > 0 ? 0 : -1,
      loop: action?.loop ?? preview.loop,
      speed: action?.playbackRate ?? 1,
      direction: action?.mirrorX ? 'left' : 'right'
    },
    selectedFrameId: frames[0]?.id ?? null
  };
}

export function previewActionIdentity(
  characterId: string | null,
  draftId: string | null,
  stateId: string | null,
  actionId: string | null,
  skinId: string | null
): string {
  return JSON.stringify([characterId, draftId, stateId, actionId, skinId]);
}

function draftStatusLabel(state: CharacterWorkshopState): string {
  if (state.draftStatus === 'dirty') return '有未保存修改';
  if (state.draftStatus === 'saving') return '正在保存';
  if (state.draftStatus === 'saved') return '草稿已保存';
  if (state.draftStatus === 'error') return '保存失败';
  return state.draft ? '草稿已载入' : '未选择角色';
}

const busyActionLabels: Record<
  Exclude<WorkshopBusyAction, null>,
  string
> = {
  loading: '正在加载…',
  creating: '正在创建…',
  saving: '正在保存…',
  compiling: '正在编译…',
  activating: '正在启用…',
  importing: '正在导入…',
  exporting: '正在导出…',
  deleting: '正在删除…'
};

function activityLabel(state: CharacterWorkshopState): string | null {
  if (state.busyAction) return busyActionLabels[state.busyAction];
  if (state.draftStatus === 'saving') return busyActionLabels.saving;
  return null;
}

export function CharacterWorkshopWorkspace(
  props: CharacterWorkshopWorkspaceProps
) {
  const { state } = props;
  const layout = props.layout ?? DEFAULT_WORKSHOP_LAYOUT;
  const layoutBounds = props.layoutBounds ?? { width: 1_120, height: 659 };
  const onLayoutChange = props.onLayoutChange ?? (() => undefined);
  const onLayoutCommit = props.onLayoutCommit ?? (() => undefined);
  const leftMax = Math.max(
    WORKSHOP_LEFT_MIN,
    Math.floor(layoutBounds.width)
      - (WORKSHOP_SPLITTER_SIZE * 2)
      - WORKSHOP_CENTER_MIN
      - layout.rightWidth
  );
  const rightMax = Math.max(
    WORKSHOP_RIGHT_MIN,
    Math.floor(layoutBounds.width)
      - (WORKSHOP_SPLITTER_SIZE * 2)
      - WORKSHOP_CENTER_MIN
      - layout.leftWidth
  );
  const sidebarTopMax = Math.max(
    WORKSHOP_SIDEBAR_TOP_MIN,
    Math.floor(layoutBounds.height) - WORKSHOP_SPLITTER_SIZE - WORKSHOP_SIDEBAR_BOTTOM_MIN
  );
  const stageMax = Math.max(
    WORKSHOP_STAGE_MIN,
    Math.floor(layoutBounds.height)
      - WORKSHOP_STAGE_HEADER_HEIGHT
      - WORKSHOP_SPLITTER_SIZE
      - WORKSHOP_TIMELINE_MIN
  );
  const layoutStyle: CSSProperties & Record<`--workshop-${string}`, string> = {
    '--workshop-left-width': `${layout.leftWidth}px`,
    '--workshop-right-width': `${layout.rightWidth}px`,
    '--workshop-sidebar-top-height': `${layout.sidebarTopHeight}px`,
    '--workshop-stage-height': `${layout.stageHeight}px`
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [characterName, setCharacterName] = useState('');
  const [internalPendingDelete, setInternalPendingDelete] = useState<string | null>(null);
  const [pendingActivation, setPendingActivation] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>(() => (
    createPreviewState(currentAction(state)?.frames.length ?? 0)
  ));
  const [perFrameAnchors, setPerFrameAnchors] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [extensionName, setExtensionName] = useState('');
  const [pendingConfigurationDelete, setPendingConfigurationDelete] = useState<
    PendingConfigurationDelete | null
  >(null);
  const previousActionIdentityRef = useRef<string | null>(null);
  const sceneFrameIndexRef = useRef<number | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);
  const configurationDeleteDialogRef = useRef<HTMLDialogElement>(null);
  const extensionFormRef = useRef<HTMLFormElement>(null);
  const extensionNameInputRef = useRef<HTMLInputElement>(null);
  const pendingDelete = props.pendingDeleteCharacterId === undefined
    ? internalPendingDelete
    : props.pendingDeleteCharacterId;
  const selectedCharacter = state.characters.find(
    character => character.id === state.selectedCharacterId
  );
  const selectedState = state.draft?.states.find(
    candidate => candidate.id === state.selectedStateId
  ) ?? null;
  const selectedActionDefinition = state.draft?.actions.find(
    candidate => candidate.id === state.selectedActionId
  ) ?? null;
  const migrationRecovery = Boolean(
    selectedCharacter?.migrationErrorCode === 'CHARACTER_MIGRATION_FAILED'
    && selectedCharacter.migrationRecoveryAvailable
    && !state.draft
  );
  const deleteCharacter = state.characters.find(
    character => character.id === pendingDelete
  );
  const action = useMemo(() => currentAction(state), [
    state.draft,
    state.selectedSkinId,
    state.selectedActionId
  ]);
  const selectedPresentation = useMemo(() => {
    if (!state.draft || !state.selectedSkinId || !state.selectedActionId) return null;
    return resolveCharacterPresentation(
      state.draft,
      state.selectedSkinId,
      state.selectedActionId
    )?.presentation ?? null;
  }, [state.draft, state.selectedSkinId, state.selectedActionId]);
  const activationCharacter = state.characters.find(
    character => character.id === pendingActivation
  );
  const activationDialogRef = useModalDialog(Boolean(activationCharacter));
  const extensionDialogRef = useModalDialog(extensionOpen);
  const busy = state.busyAction !== null;
  const activity = activityLabel(state);
  const frameCount = action?.frames.length ?? 0;
  const actionIdentity = action
    ? previewActionIdentity(
      state.selectedCharacterId,
      state.draft?.id ?? null,
      state.selectedStateId,
      action.id,
      state.selectedSkinId
    )
    : null;

  /** 统一同步预览帧与时间轴选中项；只有用户主动选帧时才暂停播放。 */
  const syncPreviewFrame = (frameIndex: number, pausePlayback: boolean) => {
    const frame = action
      ? ensureStableFrameIds(action.frames)[frameIndex]
      : null;
    if (!frame?.id) return;
    sceneFrameIndexRef.current = pausePlayback ? null : frameIndex;
    setPreview(current => ({
      ...normalizePreviewState(current, frameCount),
      frameIndex,
      playing: pausePlayback ? false : current.playing
    }));
    setSelectedFrameId(frame.id);
  };

  useEffect(() => {
    const frames = action ? ensureStableFrameIds(action.frames) : [];
    const actionChanged = previousActionIdentityRef.current
      !== actionIdentity;
    previousActionIdentityRef.current = actionIdentity;
    if (actionChanged) {
      setSelectedFrameId(frames[0]?.id ?? null);
      setPreview(current => previewAtActionStart(current, action).preview);
      return;
    }
    const selectedFrameIndex = frames.findIndex(
      frame => frame.id === selectedFrameId
    );
    if (selectedFrameIndex < 0) {
      setSelectedFrameId(frames[0]?.id ?? null);
      setPreview(current => previewAtActionStart(current, action).preview);
      return;
    }
    setPreview(current => current.frameIndex === selectedFrameIndex
      ? current
      : {
        ...normalizePreviewState(current, frames.length),
        frameIndex: selectedFrameIndex,
        playing: sceneFrameIndexRef.current === selectedFrameIndex
          ? current.playing
          : false
      });
    sceneFrameIndexRef.current = null;
  }, [action, actionIdentity, selectedFrameId]);

  useEffect(() => {
    setPreview(current => {
      const next = normalizePreviewState(current, frameCount);
      return next.frameIndex === current.frameIndex
        && next.playing === current.playing
        ? current
        : next;
    });
  }, [frameCount]);

  useEffect(() => {
    if (pendingDelete && !deleteDialogRef.current?.open) {
      deleteDialogRef.current?.showModal();
    }
  }, [pendingDelete]);

  useEffect(() => {
    if (createOpen && !createDialogRef.current?.open) {
      createDialogRef.current?.showModal();
    }
  }, [createOpen]);

  useEffect(() => {
    const dialog = configurationDeleteDialogRef.current;
    if (!pendingConfigurationDelete || !dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [pendingConfigurationDelete]);

  function closeDeleteDialog(): void {
    deleteDialogRef.current?.close();
    setInternalPendingDelete(null);
  }

  function closeCreateDialog(): void {
    createDialogRef.current?.close();
    setCreateOpen(false);
    setCharacterName('');
  }

  function closeActivationDialog(): void {
    setPendingActivation(null);
  }

  function closeExtensionDialog(): void {
    extensionFormRef.current?.reset();
    setExtensionName('');
    setExtensionOpen(false);
  }

  function submitCreate(event: FormEvent): void {
    event.preventDefault();
    if (!characterName.trim()) return;
    void state.createCharacter(characterName);
    closeCreateDialog();
  }

  function cancelOnEscape(
    event: KeyboardEvent<HTMLDialogElement>,
    close: () => void
  ): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function openReferenceDelete(
    kind: Exclude<PendingConfigurationDelete['kind'], 'sprite-sheet'>,
    id: string,
    name: string,
    impact: { safeReferencePaths: string[]; blockingReferencePaths: string[] }
  ): void {
    // 无引用目标已由 Store 原子删除；有引用时交由对话框解释并确认。
    if (impact.safeReferencePaths.length === 0 && impact.blockingReferencePaths.length === 0) {
      return;
    }
    setPendingConfigurationDelete({ kind, id, name, ...impact });
  }

  function requestDeleteAction(actionId: string): void {
    const definition = state.draft?.actions.find(candidate => candidate.id === actionId);
    if (!definition) return;
    openReferenceDelete('action', actionId, definition.name, state.requestRemoveAction(actionId));
  }

  function requestDeleteState(stateId: string): void {
    const definition = state.draft?.states.find(candidate => candidate.id === stateId);
    if (!definition) return;
    openReferenceDelete('state', stateId, definition.name, state.requestRemoveState(stateId));
  }

  /** 单帧删除先走 Store 引用审计；排序、复制等批量变更仍沿用完整帧数组更新。 */
  function updateTimelineFrames(frames: DraftActionClip['frames']): void {
    const previousFrames = action ? ensureStableFrameIds(action.frames) : [];
    const nextIds = new Set(frames.map(frame => frame.id));
    const removed = previousFrames.filter(frame => !nextIds.has(frame.id));
    if (removed.length === 1 && frames.length === previousFrames.length - 1) {
      const target = removed[0]!;
      openReferenceDelete(
        'frame',
        target.id,
        `帧 ${target.id}`,
        state.requestRemoveCurrentFrame(target.id)
      );
      return;
    }
    state.updateCurrentAction({ frames });
  }

  async function applySpriteSheet(input: SpriteSheetInput): Promise<void> {
    const impact = await state.applySpriteSheet(input);
    if (!impact || (
      impact.safeReferencePaths.length === 0
      && impact.blockingReferencePaths.length === 0
    )) return;
    setPendingConfigurationDelete({
      kind: 'sprite-sheet',
      id: 'sprite-sheet-grid',
      name: '精灵图网格',
      input,
      ...impact
    });
  }

  function closeConfigurationDeleteDialog(): void {
    if (configurationDeleteDialogRef.current?.open) {
      configurationDeleteDialogRef.current.close();
    }
    setPendingConfigurationDelete(null);
  }

  function confirmConfigurationDelete(): void {
    if (!pendingConfigurationDelete) return;
    if (pendingConfigurationDelete.blockingReferencePaths.length > 0) return;
    if (pendingConfigurationDelete.kind === 'action') {
      state.requestRemoveAction(pendingConfigurationDelete.id, true);
    } else if (pendingConfigurationDelete.kind === 'state') {
      state.requestRemoveState(pendingConfigurationDelete.id, true);
    } else if (pendingConfigurationDelete.kind === 'frame') {
      state.requestRemoveCurrentFrame(pendingConfigurationDelete.id, true);
    } else {
      void state.applySpriteSheet(pendingConfigurationDelete.input, true);
    }
    closeConfigurationDeleteDialog();
  }

  return (
    <main
      className="character-workshop-shell"
      aria-busy={busy || state.draftStatus === 'saving'}
    >
      <header className="workshop-header">
        <div className="workshop-title">
          <Box size={20} aria-hidden="true" />
          <div>
            <span className="workshop-eyebrow">AI Pet</span>
            <h1>角色工作室</h1>
          </div>
        </div>
        <div className="workshop-statuses">
          <div
            className="workshop-activity"
            aria-live="polite"
            aria-atomic="true"
          >
            {activity ? (
              <>
                <LoaderCircle size={15} aria-hidden="true" />
                <span>{activity}</span>
              </>
            ) : (
              <span className="activity-idle">就绪</span>
            )}
          </div>
          <div className="draft-indicator" data-status={state.draftStatus}>
            <span aria-hidden="true" />
            {draftStatusLabel(state)}
          </div>
        </div>
      </header>

      <nav className="workshop-toolbar" aria-label="角色工作室命令">
        <button type="button" disabled={busy} onClick={() => setCreateOpen(true)}>
          <Plus size={16} />新建角色
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void state.importCharacterPackage()}
        >
          <PackageOpen size={16} />导入角色包
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          type="button"
          disabled={busy || !state.selectedCharacterId}
          onClick={() => void state.importSources()}
        >
          <ImagePlus size={16} />导入素材
        </button>
        <button
          type="button"
          disabled={busy || !state.draft || state.draftStatus === 'saved'}
          onClick={() => void state.flushDraft()}
        >
          <Save size={16} />保存草稿
        </button>
        <button
          type="button"
          disabled={busy || !state.selectedCharacterId}
          onClick={() => void state.exportCharacterPackage()}
        >
          <Download size={16} />导出角色包
        </button>
        <button
          className="primary-command"
          type="button"
          disabled={busy || !state.draft}
          onClick={() => void state.compileAndPublish()}
        >
          <Play size={16} />编译并发布
        </button>
        <button
          className="primary-command"
          type="button"
          disabled={busy || !selectedCharacter || selectedCharacter.active}
          onClick={() => {
            if (!selectedCharacter) return;
            if (
              selectedCharacter.completeness === 'incomplete'
              && selectedCharacter.activationConfirmationRequired !== false
            ) {
              setPendingActivation(selectedCharacter.id);
              return;
            }
            void state.activateCharacter(selectedCharacter.id);
          }}
        >
          <CheckCircle2 size={16} />启用角色
        </button>
      </nav>

      <TransientToastLayer
        queue={state.toastQueue}
        onDismiss={state.dismissToast}
        durationMs={workshopToastDurationMs}
        ariaLabel="工作台提示"
      />

      {props.recoveryLoadFailed ? (
        <p className="migration-recovery" role="alert">
          恢复状态暂时无法读取，请稍后重试。
        </p>
      ) : props.recoveryIssues?.map(issue => {
        const presentation = characterRecoveryPresentation(issue.errorCode);
        return (
          <section
            className="migration-recovery"
            aria-live="polite"
            key={issue.errorCode}
          >
            <p role="alert">{presentation.text}</p>
            <p>受影响能力：{presentation.affectedCapabilities.join('、')}</p>
            <p>{presentation.suggestion}</p>
          </section>
        );
      })}

      {props.layoutNotice ? (
        <p className="workshop-layout-notice" role="status">{props.layoutNotice}</p>
      ) : null}

      <div className="workshop-columns" ref={props.columnsRef} style={layoutStyle}>
        <aside className="workshop-sidebar" aria-label="角色与状态">
          <section className="workshop-section character-section">
            <div className="section-heading">
              <h2>角色</h2>
              <small>{state.characters.length}</small>
            </div>
            {state.loadStatus === 'loading' ? (
              <p className="workshop-loading">正在加载角色</p>
            ) : (
              <CharacterList
                characters={state.characters}
                selectedCharacterId={state.selectedCharacterId}
                disabled={busy}
                onSelect={id => void state.selectCharacter(id)}
                onDuplicate={id => void state.duplicateCharacter(id)}
                onDelete={setInternalPendingDelete}
              />
            )}
            {state.draft ? (
              <button
                className="identity-select-command"
                type="button"
                disabled={busy}
                aria-pressed={state.selectedEntity.kind === 'identity'}
                onClick={state.selectIdentity}
              >
                编辑角色人设
              </button>
            ) : null}
            {state.loadStatus === 'error' && !migrationRecovery ? (
              <button
                className="retry-button"
                type="button"
                disabled={busy}
                onClick={() => void state.load()}
              >
                重新加载
              </button>
            ) : null}
          </section>
          <WorkshopSplitter
            label="调整角色区与状态区高度"
            orientation="horizontal"
            value={layout.sidebarTopHeight}
            min={WORKSHOP_SIDEBAR_TOP_MIN}
            max={sidebarTopMax}
            onChange={value => onLayoutChange('sidebarTopHeight', value)}
            onCommit={value => onLayoutCommit('sidebarTopHeight', value)}
          />
          <section className="workshop-section state-section">
            <div className="section-heading">
              <h2>状态与动作</h2>
              <button
                className="section-heading-command"
                type="button"
                aria-label="添加扩展状态"
                title="添加扩展状态"
                disabled={busy || !state.draft}
                onClick={() => setExtensionOpen(true)}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <StateList
              states={state.draft?.states ?? []}
              actions={state.draft?.actions ?? []}
              defaultStateId={state.draft?.defaultStateId ?? ''}
              selectedStateId={state.selectedStateId}
              selectedActionId={state.selectedActionId}
              disabled={busy}
              onSelectState={state.selectState}
              onSelectAction={state.selectAction}
              onAddAction={state.addAction}
              onRequestDeleteState={requestDeleteState}
              onRequestDeleteAction={requestDeleteAction}
            />
          </section>
        </aside>

        <WorkshopSplitter
          label="调整角色侧栏宽度"
          orientation="vertical"
          value={layout.leftWidth}
          min={WORKSHOP_LEFT_MIN}
          max={leftMax}
          onChange={value => onLayoutChange('leftWidth', value)}
          onCommit={value => onLayoutCommit('leftWidth', value)}
        />

        <section className="workshop-stage" aria-labelledby="preview-heading">
          <div className="stage-heading">
            <div>
              <span>画布</span>
              <h2 id="preview-heading">实时预览</h2>
            </div>
            <small>{selectedCharacter?.name ?? '未选择角色'}</small>
          </div>
          <div className="preview-workspace">
            <DraftCharacterPreview
              characterId={state.selectedCharacterId}
              draft={state.draft}
              selectedSkinId={state.selectedSkinId}
              stateId={state.selectedStateId}
              actionId={state.selectedActionId}
              selectedFrameId={selectedFrameId}
              preview={preview}
              api={props.api}
              onFrameChange={frameIndex => syncPreviewFrame(frameIndex, false)}
              onPlayingChange={playing => {
                setPreview(current => current.playing === playing
                  ? current
                  : { ...current, playing });
              }}
            />
            <PreviewControls
              state={preview}
              frameCount={frameCount}
              disabled={busy}
              onChange={next => {
                setPreview(next);
                const presentationPatch = {
                  ...(next.speed === preview.speed
                    ? {}
                    : { playbackRate: next.speed }),
                  ...(next.direction === preview.direction
                    ? {}
                    : { mirrorX: next.direction === 'left' })
                };
                if (Object.keys(presentationPatch).length > 0) {
                  state.updateCurrentAction(presentationPatch);
                }
                const nextFrame = action
                  ? ensureStableFrameIds(action.frames)[next.frameIndex]
                  : null;
                if (nextFrame?.id) setSelectedFrameId(nextFrame.id);
              }}
            />
          </div>
          <WorkshopSplitter
            label="调整预览区与时间轴高度"
            orientation="horizontal"
            value={layout.stageHeight}
            min={WORKSHOP_STAGE_MIN}
            max={stageMax}
            onChange={value => onLayoutChange('stageHeight', value)}
            onCommit={value => onLayoutCommit('stageHeight', value)}
          />
          {action ? (
            <ActionTimeline
              frames={action.frames}
              selectedFrameId={selectedFrameId}
              disabled={busy}
              onSelect={frameId => {
                const frameIndex = ensureStableFrameIds(
                  action.frames
                ).findIndex(frame => frame.id === frameId);
                if (frameIndex < 0) return;
                syncPreviewFrame(frameIndex, true);
              }}
              onChange={updateTimelineFrames}
            />
          ) : (
            <div className="timeline-empty">当前没有可编辑动作</div>
          )}
        </section>

        <WorkshopSplitter
          label="调整属性侧栏宽度"
          orientation="vertical"
          value={layout.rightWidth}
          min={WORKSHOP_RIGHT_MIN}
          max={rightMax}
          valueDirection={-1}
          onChange={value => onLayoutChange('rightWidth', value)}
          onCommit={value => onLayoutCommit('rightWidth', value)}
        />

        <aside className="workshop-inspector" aria-labelledby="properties-heading">
          <div className="section-heading">
            <h2 id="properties-heading">
              {migrationRecovery
                ? '迁移恢复'
                : state.selectedEntity.kind === 'identity'
                  ? '角色人设'
                  : state.selectedEntity.kind === 'state'
                      ? '状态属性'
                      : state.selectedEntity.kind === 'action'
                        ? '动作属性'
                        : '属性'}
            </h2>
          </div>
          {migrationRecovery && selectedCharacter ? (
            <section className="migration-recovery" aria-live="polite">
              <h3>{selectedCharacter.name}</h3>
              <p role="alert">旧版角色迁移失败，原始数据仍可恢复。</p>
              <p>你可以重试读取；若问题持续，请先导出恢复包再处理原始数据。</p>
              <div className="recovery-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void state.selectCharacter(selectedCharacter.id)}
                >
                  重试读取
                </button>
                <button
                  type="button"
                  disabled={busy || !selectedCharacter.migrationRecoveryAvailable}
                  onClick={() => void state.exportCharacterPackage()}
                >
                  导出恢复包
                </button>
              </div>
            </section>
          ) : state.draft && state.selectedEntity.kind === 'identity' ? (
            <CharacterIdentityInspector
              identity={state.draft.identity}
              disabled={busy}
              onChange={state.updateIdentity}
            />
          ) : state.selectedEntity.kind === 'state' && selectedState ? (
            <StateInspector
              state={selectedState}
              allStates={state.draft?.states ?? []}
              disabled={busy}
              onChange={patch => state.updateState(selectedState.id, patch)}
            />
          ) : state.selectedEntity.kind === 'action' && selectedActionDefinition ? (
            <>
              <AtlasImportPanel
                sources={state.availableSources}
                disabled={busy}
                onApply={applySpriteSheet}
              />
              <ActionInspector
                action={selectedActionDefinition}
                actions={state.draft?.actions ?? []}
                states={state.draft?.states ?? []}
                presentation={selectedPresentation}
                disabled={busy}
                onChange={patch => state.updateAction(selectedActionDefinition.id, patch)}
                onCommitFrameChange={state.setCurrentActionCommitFrame}
              />
              {action ? (
                <AnchorEditor
                  action={action}
                  frameId={selectedFrameId}
                  perFrame={perFrameAnchors}
                  disabled={busy}
                  onPerFrameChange={setPerFrameAnchors}
                  onChange={next => state.updateCurrentAction(next)}
                />
              ) : null}
            </>
          ) : (
            <p className="workshop-empty inspector-empty">请选择角色后编辑动作</p>
          )}
        </aside>
      </div>

      {createOpen ? (
        <dialog
          ref={createDialogRef}
          aria-modal="true"
          aria-labelledby="create-character-title"
          onCancel={event => {
            event.preventDefault();
            closeCreateDialog();
          }}
          onKeyDown={event => cancelOnEscape(event, closeCreateDialog)}
        >
          <form className="workshop-dialog" onSubmit={submitCreate}>
            <h2 id="create-character-title">新建角色</h2>
            <p>创建一个独立草稿，之后可导入 PNG 或 WebP 素材。</p>
            <label>
              角色名称
              <input
                autoFocus
                value={characterName}
                maxLength={120}
                onChange={event => setCharacterName(event.currentTarget.value)}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={closeCreateDialog}>取消</button>
              <button
                className="primary-command"
                type="submit"
                disabled={!characterName.trim()}
              >
                创建角色
              </button>
            </div>
          </form>
        </dialog>
      ) : null}

      {deleteCharacter ? (
        <dialog
          ref={deleteDialogRef}
          aria-modal="true"
          aria-labelledby="delete-character-title"
          onCancel={event => {
            event.preventDefault();
            closeDeleteDialog();
          }}
          onKeyDown={event => cancelOnEscape(event, closeDeleteDialog)}
        >
          <div className="workshop-dialog">
            <h2 id="delete-character-title">
              删除角色“{deleteCharacter.name}”
            </h2>
            <p>角色草稿、素材和已编译资源将一并删除，此操作无法撤销。</p>
            <div className="dialog-actions">
              <button type="button" autoFocus onClick={closeDeleteDialog}>
                取消
              </button>
              <button
                className="danger-command"
                type="button"
                onClick={() => {
                  void state.deleteCharacter(deleteCharacter.id);
                  closeDeleteDialog();
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </dialog>
      ) : null}

      <dialog
        ref={activationDialogRef}
        aria-modal="true"
        aria-labelledby="activation-requirements-title"
        onCancel={event => {
          event.preventDefault();
          closeActivationDialog();
        }}
        onKeyDown={event => cancelOnEscape(event, closeActivationDialog)}
      >
        <div className="workshop-dialog">
          <h2 id="activation-requirements-title">发布要求尚未满足</h2>
          <p>“{activationCharacter?.name ?? ''}”仍有以下发布要求未满足。</p>
          <div className="missing-state-list">
            {(activationCharacter?.missingRequirements ?? []).map(requirement => (
              <span key={requirement}>
                {requirement === 'default-state-action-missing'
                  ? '默认状态缺少动作'
                  : '默认表现不可播放'}
              </span>
            ))}
          </div>
          <div className="dialog-actions">
            <button type="button" autoFocus onClick={closeActivationDialog}>
              返回完善
            </button>
            <button
              className="primary-command"
              type="button"
              disabled={!activationCharacter}
              onClick={() => {
                if (!activationCharacter) return;
                closeActivationDialog();
                void state.activateCharacter(activationCharacter.id, true);
              }}
            >
              仍然使用
            </button>
          </div>
        </div>
      </dialog>

      {pendingConfigurationDelete ? (
        <dialog
          ref={configurationDeleteDialogRef}
          aria-modal="true"
          aria-labelledby="delete-configuration-title"
          onCancel={event => {
            event.preventDefault();
            closeConfigurationDeleteDialog();
          }}
          onKeyDown={event => cancelOnEscape(
            event,
            closeConfigurationDeleteDialog
          )}
        >
          <div className="workshop-dialog">
            <h2 id="delete-configuration-title">
              {pendingConfigurationDelete.kind === 'sprite-sheet'
                ? '替换精灵图网格并清理提交帧'
                : `删除${pendingConfigurationDelete.kind === 'action'
                  ? '动作'
                  : pendingConfigurationDelete.kind === 'state'
                    ? '状态'
                    : '帧'}“${pendingConfigurationDelete.name}”`}
            </h2>
            <p>操作会清理以下安全引用；阻塞引用必须先重选，系统不会自动猜测替代项。</p>
            {pendingConfigurationDelete.safeReferencePaths.length > 0 ? (
              <section aria-labelledby="safe-reference-title">
                <h3 id="safe-reference-title">可安全清理的引用</h3>
                <ul className="reference-path-list">
                  {pendingConfigurationDelete.safeReferencePaths.map(path => (
                    <li key={path}><code>{path}</code></li>
                  ))}
                </ul>
              </section>
            ) : null}
            {pendingConfigurationDelete.blockingReferencePaths.length > 0 ? (
              <section aria-labelledby="blocking-reference-title">
                <h3 id="blocking-reference-title">阻塞删除的引用</h3>
                <ul className="reference-path-list blocking-reference-list">
                  {pendingConfigurationDelete.blockingReferencePaths.map(path => (
                    <li key={path}><code>{path}</code></li>
                  ))}
                </ul>
                <p role="alert">请先重选这些引用，再重新请求删除。</p>
              </section>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                autoFocus
                onClick={closeConfigurationDeleteDialog}
              >
                取消
              </button>
              <button
                className="danger-command"
                type="button"
                disabled={pendingConfigurationDelete.blockingReferencePaths.length > 0}
                onClick={confirmConfigurationDelete}
              >
                确认删除
              </button>
            </div>
          </div>
        </dialog>
      ) : null}

      <dialog
        ref={extensionDialogRef}
        aria-modal="true"
        aria-labelledby="extension-state-title"
        onCancel={event => {
          event.preventDefault();
          closeExtensionDialog();
        }}
        onKeyDown={event => cancelOnEscape(event, closeExtensionDialog)}
      >
        <form
          ref={extensionFormRef}
          className="workshop-dialog"
          onSubmit={event => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const name = String(formData.get('extensionName') ?? '').trim();
            if (!name) {
              extensionNameInputRef.current?.focus();
              return;
            }
            const kind = String(formData.get('stateKind') ?? 'modifier');
            const semantic = String(formData.get('stateSemantic') ?? 'idle');
            const normalizedSemantic = STANDARD_CHARACTER_SEMANTICS.find(
              candidate => candidate === semantic
            ) ?? 'idle';
            state.addState({
              name,
              kind: kind === 'primary' ? 'primary' : 'modifier',
              semantic: normalizedSemantic
            });
            closeExtensionDialog();
          }}
        >
          <h2 id="extension-state-title">新建扩展状态</h2>
          <label>
            状态名称
            <input
              ref={extensionNameInputRef}
              autoFocus
              name="extensionName"
              value={extensionName}
              onChange={event => setExtensionName(event.currentTarget.value)}
            />
          </label>
          <label>
            状态类别
            <select
              name="stateKind"
              defaultValue="modifier"
            >
              <option value="primary">主状态</option>
              <option value="modifier">修饰状态</option>
            </select>
          </label>
          <label>
            标准语义
            <select
              name="stateSemantic"
              defaultValue="idle"
            >
              {STANDARD_CHARACTER_SEMANTICS.map(semantic => (
                <option key={semantic} value={semantic}>{semantic}</option>
              ))}
            </select>
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={closeExtensionDialog}>
              取消
            </button>
            <button
              className="primary-command"
              type="submit"
              disabled={!extensionName.trim()}
            >
              创建扩展状态
            </button>
          </div>
        </form>
      </dialog>
    </main>
  );
}

export function CharacterWorkshopView(props: CharacterWorkshopViewProps) {
  const [store] = useState(() => createCharacterWorkshopStore(props.api));
  const state = useStore(store);
  const [recoverySnapshot, setRecoverySnapshot] = useState<
    CharacterRecoverySnapshotDto | null
  >(null);
  const [recoveryLoadFailed, setRecoveryLoadFailed] = useState(false);
  const [layout, setLayout] = useState<WorkshopLayoutSettings>(DEFAULT_WORKSHOP_LAYOUT);
  const [layoutBounds, setLayoutBounds] = useState<WorkshopLayoutBounds>({
    width: 1_120,
    height: 659
  });
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const layoutBoundsRef = useRef(layoutBounds);
  const preferredLayoutRef = useRef<WorkshopLayoutSettings>(DEFAULT_WORKSHOP_LAYOUT);
  // 同一挂载生命周期复用读取，避免 React StrictMode 重放 effect 时重复 IPC。
  const recoverySnapshotPromiseRef = useRef<Promise<CharacterRecoverySnapshotDto> | null>(null);
  const layoutPromiseRef = useRef<Promise<WorkshopLayoutSettings> | null>(null);

  useEffect(() => {
    let active = true;
    const dispose = store.getState().mount();
    const unsubscribeFlush = props.api.onCharacterWorkshopFlushRequested(
      () => store.getState().flushDraft()
    );
    const recoverySnapshotPromise = recoverySnapshotPromiseRef.current
      ??= props.api.getCharacterRecoverySnapshot();
    const layoutPromise = layoutPromiseRef.current ??= props.api.getWorkshopLayout();
    void recoverySnapshotPromise.then(snapshot => {
      if (active) setRecoverySnapshot(snapshot);
    }).catch(() => {
      if (active) setRecoveryLoadFailed(true);
    });
    void layoutPromise.then(value => {
      if (!active) return;
      preferredLayoutRef.current = value;
      setLayout(clampWorkshopLayout(value, layoutBoundsRef.current));
    }).catch(() => {
      if (active) setLayoutNotice('工作台布局暂时无法读取，已使用默认布局。');
    });
    return () => {
      active = false;
      unsubscribeFlush();
      dispose();
    };
  }, [props.api, store]);

  useEffect(() => {
    const columns = columnsRef.current;
    if (!columns || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const contentRect = entries[0]?.contentRect;
      if (!contentRect) return;
      const nextBounds = { width: contentRect.width, height: contentRect.height };
      layoutBoundsRef.current = nextBounds;
      setLayoutBounds(nextBounds);
      setLayout(clampWorkshopLayout(preferredLayoutRef.current, nextBounds));
    });
    observer.observe(columns);
    return () => observer.disconnect();
  }, []);

  const changeLayout = (key: keyof WorkshopLayoutSettings, value: number) => {
    setLayout(current => clampWorkshopLayout({ ...current, [key]: value }, layoutBoundsRef.current));
  };

  const commitLayout = (key: keyof WorkshopLayoutSettings, value: number) => {
    // 只规范本次交互字段；其他字段的窗口临时 clamp 不能污染持久偏好。
    const preferred = key === 'leftWidth' || key === 'rightWidth'
      ? preferredWorkshopLayoutForRenderedWidth(
          preferredLayoutRef.current,
          layoutBoundsRef.current,
          key,
          value
        )
      : {
          ...preferredLayoutRef.current,
          [key]: Math.min(4_096, Math.max(1, Math.round(value)))
        };
    preferredLayoutRef.current = preferred;
    setLayout(clampWorkshopLayout(preferred, layoutBoundsRef.current));
    setLayoutNotice(null);
    void props.api.saveWorkshopLayout(preferred).catch(() => {
      setLayoutNotice('工作台布局暂时无法保存，本次调整仍会保留到窗口关闭。');
    });
  };

  const recoveryIssues = recoverySnapshot?.issues.filter(
    issue => issue.characterId === state.selectedCharacterId
  ) ?? [];
  return (
    <CharacterWorkshopWorkspace
      state={state}
      api={props.api}
      recoveryIssues={recoveryIssues}
      recoveryLoadFailed={recoveryLoadFailed}
      layout={layout}
      layoutBounds={layoutBounds}
      columnsRef={columnsRef}
      layoutNotice={layoutNotice}
      onLayoutChange={changeLayout}
      onLayoutCommit={commitLayout}
    />
  );
}
