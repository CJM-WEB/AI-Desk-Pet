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
  Plus,
  Upload,
  X
} from 'lucide-react';
import { useStore } from 'zustand';
import type { DraftActionClip } from '@myself/character-runtime';
import {
  createCharacterWorkshopStore,
  type CharacterWorkshopApi,
  type CharacterWorkshopState,
  type WorkshopBusyAction
} from '../store/character-workshop-store';
import { CharacterList } from './CharacterList';
import { StateList } from './StateList';
import './character-workshop.css';

export interface CharacterWorkshopViewProps {
  api: CharacterWorkshopApi;
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
  const busy = state.busyAction !== null;
  const activity = activityLabel(state);

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
          disabled={busy || !state.selectedCharacterId}
          onClick={() => void state.exportCharacterPackage()}
        >
          <Download size={16} />导出角色包
        </button>
        <button
          className="primary-command"
          type="button"
          disabled={busy || !selectedCharacter || selectedCharacter.active}
          onClick={() => selectedCharacter
            && void state.activateCharacter(selectedCharacter.id)}
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
          <div className="preview-placeholder">
            <Upload size={28} aria-hidden="true" />
            <strong>预览将在动作素材编译后显示</strong>
            <span>当前阶段提供稳定画布占位，不模拟未实现的播放能力。</span>
          </div>
          <div className="timeline-placeholder" aria-label="时间轴预留区域">
            <div>
              <strong>时间轴</strong>
              <span>时间轴将在下一阶段提供</span>
            </div>
            <div className="timeline-track" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </section>

        <aside className="workshop-inspector" aria-labelledby="properties-heading">
          <div className="section-heading">
            <h2 id="properties-heading">动作属性</h2>
          </div>
          {action ? (
            <form className="action-properties">
              <label>
                动作名称
                <input
                  value={action.name}
                  disabled={busy}
                  onChange={event => state.updateCurrentAction({
                    name: event.currentTarget.value
                  })}
                />
              </label>
              <div className="property-grid">
                <label>
                  帧率
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={action.fps}
                    disabled={busy}
                    onChange={event => {
                      const value = Number(event.currentTarget.value);
                      if (value >= 1 && value <= 60) {
                        state.updateCurrentAction({ fps: value });
                      }
                    }}
                  />
                </label>
                <label>
                  权重
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={action.weight}
                    disabled={busy}
                    onChange={event => {
                      const value = Number(event.currentTarget.value);
                      if (value > 0 && value <= 100) {
                        state.updateCurrentAction({ weight: value });
                      }
                    }}
                  />
                </label>
              </div>
              <label>
                朝向
                <select
                  value={action.direction ?? 'any'}
                  disabled={busy}
                  onChange={event => state.updateCurrentAction({
                    direction: event.currentTarget.value as 'left' | 'right' | 'any'
                  })}
                >
                  <option value="any">任意</option>
                  <option value="left">向左</option>
                  <option value="right">向右</option>
                </select>
              </label>
              <label className="toggle-row">
                <span>
                  <strong>循环播放</strong>
                  <small>动作结束后从头继续</small>
                </span>
                <input
                  type="checkbox"
                  checked={action.loop}
                  disabled={busy}
                  onChange={event => state.updateCurrentAction({
                    loop: event.currentTarget.checked
                  })}
                />
              </label>
              <dl className="action-summary">
                <div><dt>动作标识</dt><dd>{action.id}</dd></div>
                <div><dt>帧数</dt><dd>{action.frames.length}</dd></div>
                <div><dt>编译状态</dt><dd>{state.compileStatus}</dd></div>
              </dl>
            </form>
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
    </main>
  );
}

export function CharacterWorkshopView(props: CharacterWorkshopViewProps) {
  const [store] = useState(() => createCharacterWorkshopStore(props.api));
  const state = useStore(store);

  useEffect(() => {
    const dispose = store.getState().mount();
    const flush = () => {
      void store.getState().flushDraft();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
      dispose();
    };
  }, [store]);

  return <CharacterWorkshopWorkspace state={state} />;
}
