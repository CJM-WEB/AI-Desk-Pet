import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
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
  Save,
  Upload,
  X
} from 'lucide-react';
import { useStore } from 'zustand';
import type { DraftActionClip } from '@myself/character-runtime';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  createCharacterWorkshopStore,
  type CharacterWorkshopApi,
  type CharacterWorkshopState,
  type WorkshopBusyAction
} from '../store/character-workshop-store';
import { CharacterList } from './CharacterList';
import { StateList } from './StateList';
import { ActionInspector } from './ActionInspector';
import {
  ActionTimeline,
  ensureStableFrameIds
} from './ActionTimeline';
import { AnchorEditor } from './AnchorEditor';
import { IncompleteCharacterDialog } from './IncompleteCharacterDialog';
import { PreviewControls } from './PreviewControls';
import { AtlasImportPanel } from './AtlasImportPanel';
import './character-workshop.css';

export interface CharacterWorkshopViewProps {
  api: CharacterWorkshopApi & Pick<
    MyselfApi,
    'onCharacterWorkshopFlushRequested'
  >;
}

export interface CharacterWorkshopWorkspaceProps {
  state: CharacterWorkshopState;
  pendingDeleteCharacterId?: string | null;
}

function currentAction(state: CharacterWorkshopState): DraftActionClip | null {
  const selectedState = state.draft?.states.find(
    candidate => candidate.id === state.selectedStateId
  );
  return selectedState?.actions.find(
    candidate => candidate.id === state.selectedActionId
  ) ?? null;
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
  const [createOpen, setCreateOpen] = useState(false);
  const [characterName, setCharacterName] = useState('');
  const [internalPendingDelete, setInternalPendingDelete] = useState<string | null>(null);
  const [pendingActivation, setPendingActivation] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [perFrameAnchors, setPerFrameAnchors] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [extensionName, setExtensionName] = useState('');
  const [extensionEvent, setExtensionEvent] = useState<
    'single_click' | 'double_click' | 'context_menu'
  >('single_click');
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);
  const pendingDelete = props.pendingDeleteCharacterId === undefined
    ? internalPendingDelete
    : props.pendingDeleteCharacterId;
  const selectedCharacter = state.characters.find(
    character => character.id === state.selectedCharacterId
  );
  const deleteCharacter = state.characters.find(
    character => character.id === pendingDelete
  );
  const action = currentAction(state);
  const activationCharacter = state.characters.find(
    character => character.id === pendingActivation
  );
  const busy = state.busyAction !== null;
  const activity = activityLabel(state);

  useEffect(() => {
    const frames = action ? ensureStableFrameIds(action.frames) : [];
    if (!frames.some(frame => frame.id === selectedFrameId)) {
      setSelectedFrameId(frames[0]?.id ?? null);
    }
  }, [action, selectedFrameId]);

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

  function closeDeleteDialog(): void {
    deleteDialogRef.current?.close();
    setInternalPendingDelete(null);
  }

  function closeCreateDialog(): void {
    createDialogRef.current?.close();
    setCreateOpen(false);
    setCharacterName('');
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
          disabled={busy || !state.selectedStateId}
          onClick={state.addAction}
        >
          <Plus size={16} />添加动作
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
          disabled={busy || !state.draft}
          onClick={() => setExtensionOpen(true)}
        >
          <Plus size={16} />扩展状态
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

      {state.notice ? (
        <div
          className={`workshop-notice notice-${state.notice.tone}`}
          role={state.notice.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{state.notice.text}</span>
          <button
            type="button"
            aria-label="关闭通知"
            title="关闭通知"
            onClick={state.clearNotice}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      <div className="workshop-columns">
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
            {state.loadStatus === 'error' ? (
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
          <section className="workshop-section state-section">
            <div className="section-heading">
              <h2>状态与动作</h2>
            </div>
            <StateList
              states={state.draft?.states ?? []}
              selectedStateId={state.selectedStateId}
              selectedActionId={state.selectedActionId}
              disabled={busy}
              onSelectState={state.selectState}
              onSelectAction={state.selectAction}
            />
          </section>
        </aside>

        <section className="workshop-stage" aria-labelledby="preview-heading">
          <div className="stage-heading">
            <div>
              <span>画布</span>
              <h2 id="preview-heading">实时预览</h2>
            </div>
            <small>{selectedCharacter?.name ?? '未选择角色'}</small>
          </div>
          <div className="preview-workspace">
            <Upload size={28} aria-hidden="true" />
            <strong>{action ? action.name : '请选择动作'}</strong>
            <span>
              {action
                ? '播放控制只使用当前草稿的内存快照。'
                : '选择动作后可编辑时间轴与锚点。'}
            </span>
            <PreviewControls
              frameCount={action?.frames.length ?? 0}
              disabled={busy}
            />
          </div>
          {action ? (
            <ActionTimeline
              frames={action.frames}
              selectedFrameId={selectedFrameId}
              disabled={busy}
              onSelect={setSelectedFrameId}
              onChange={frames => state.updateCurrentAction({ frames })}
            />
          ) : (
            <div className="timeline-empty">当前没有可编辑动作</div>
          )}
        </section>

        <aside className="workshop-inspector" aria-labelledby="properties-heading">
          <div className="section-heading">
            <h2 id="properties-heading">动作属性</h2>
          </div>
          {action ? (
            <>
              <AtlasImportPanel
                sources={state.availableSources}
                disabled={busy}
                onApply={state.applySpriteSheet}
              />
              <ActionInspector
                action={action}
                disabled={busy}
                onChange={state.updateCurrentAction}
              />
              <AnchorEditor
                action={action}
                frameId={selectedFrameId}
                perFrame={perFrameAnchors}
                disabled={busy}
                onPerFrameChange={setPerFrameAnchors}
                onChange={next => state.updateCurrentAction(next)}
              />
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

      {activationCharacter ? (
        <IncompleteCharacterDialog
          characterName={activationCharacter.name}
          missingStates={activationCharacter.missingCoreStates}
          onCancel={() => setPendingActivation(null)}
          onConfirm={() => {
            setPendingActivation(null);
            void state.activateCharacter(activationCharacter.id, true);
          }}
        />
      ) : null}

      {extensionOpen ? (
        <dialog open aria-modal="true" aria-labelledby="extension-state-title">
          <form
            className="workshop-dialog"
            onSubmit={event => {
              event.preventDefault();
              state.addExtensionState(extensionName, extensionEvent);
              setExtensionOpen(false);
              setExtensionName('');
            }}
          >
            <h2 id="extension-state-title">新建扩展状态</h2>
            <label>
              状态名称
              <input
                autoFocus
                value={extensionName}
                onChange={event => setExtensionName(event.currentTarget.value)}
              />
            </label>
            <label>
              触发方式
              <select
                aria-label="扩展状态触发方式"
                value={extensionEvent}
                onChange={event => setExtensionEvent(
                  event.currentTarget.value as typeof extensionEvent
                )}
              >
                <option value="single_click">单击</option>
                <option value="double_click">双击</option>
                <option value="context_menu">右键</option>
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setExtensionOpen(false)}>
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
      ) : null}
    </main>
  );
}

export function CharacterWorkshopView(props: CharacterWorkshopViewProps) {
  const [store] = useState(() => createCharacterWorkshopStore(props.api));
  const state = useStore(store);

  useEffect(() => {
    const dispose = store.getState().mount();
    const unsubscribeFlush = props.api.onCharacterWorkshopFlushRequested(
      () => store.getState().flushDraft()
    );
    return () => {
      unsubscribeFlush();
      dispose();
    };
  }, [props.api, store]);

  return <CharacterWorkshopWorkspace state={state} />;
}
