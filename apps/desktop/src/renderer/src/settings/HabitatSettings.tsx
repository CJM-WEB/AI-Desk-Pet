import { useEffect, useState } from 'react';
import type {
  HabitatDashboardDto,
  HabitatPreferencesInput
} from '../../../shared/habitat-ipc';

export interface HabitatSettingsProps {
  dashboard: HabitatDashboardDto | null;
  loading: boolean;
  busy: boolean;
  busyLabel: string | null;
  onAdd(): void;
  onToggleDirectory(directoryId: string, enabled: boolean): void;
  onRemove(directoryId: string): void;
  onSavePreferences(input: HabitatPreferencesInput): void;
  onEnter(directoryId: string): void;
  onSummon(): void;
  onRecall(): void;
}

const busyReasonText: Record<NonNullable<HabitatDashboardDto['busyReason']>, string> = {
  entering: '正在进入目录空间…',
  summoning: '正在呼唤桌宠…',
  recalling: '正在召回桌面…',
  'checking-availability': '正在检查目录可用性…'
};

const habitatErrorMessages: Partial<Record<string, string>> = {
  HABITAT_OPERATION_BUSY: '另一个空间操作尚未完成，请稍后再试。',
  HABITAT_ENTRY_BLOCKED: '当前任务或交互尚未结束，暂时不能进入目录空间。',
  HABITAT_AUTOMATION_BLOCKED: '当前主动性设置不允许自动藏身。',
  HABITAT_DIRECTORY_NOT_FOUND: '目录配置已不存在，请刷新后重试。',
  HABITAT_DIRECTORY_UNAVAILABLE: '目录当前不可用，请检查磁盘或目录状态。',
  HABITAT_DIRECTORY_DISABLED: '请先启用这个目录配置。',
  HABITAT_DIRECTORY_IN_USE: '请先召回桌面，再删除当前目录配置。',
  HABITAT_DIRECTORY_DUPLICATE: '这个目录已经添加过了。',
  HABITAT_DIRECTORY_IDENTITY_CONFLICT: '目录身份已变化，无法继续使用该配置。',
  HABITAT_DIRECTORY_INVALID: '所选目录无效。',
  HABITAT_DIRECTORY_UNSAFE: '所选目录不是安全的普通目录。',
  HABITAT_DIRECTORY_PROTECTED: '系统或应用保护目录不能用作空间。',
  HABITAT_DIRECTORY_UNSUPPORTED: '暂不支持网络盘、移动盘或云占位目录。',
  HABITAT_DISABLED: '请先启用目录空间功能。',
  HABITAT_DIALOG_FAILED: '无法打开目录选择窗口，请稍后重试。',
  HABITAT_STORAGE_CHANGED: '空间配置已被其他操作更新，请重试。',
  HABITAT_STORAGE_FAILED: '无法保存空间配置，请检查本地存储。',
  HABITAT_SUMMON_FAILED: '无法打开当前目录空间，请检查目录状态。',
  HABITAT_WINDOW_FAILED: '桌宠窗口状态更新失败，请重试。'
};

export function habitatErrorMessage(error: unknown): string {
  const candidates: unknown[] = error && typeof error === 'object'
    ? [
        'code' in error ? (error as { code?: unknown }).code : undefined,
        error instanceof Error ? error.message : undefined
      ]
    : [error];
  const code = candidates
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.match(/HABITAT_[A-Z_]+/u)?.[0])
    .find((value): value is string => value !== undefined) ?? '';
  return habitatErrorMessages[code]
    ?? '空间操作未完成，请稍后重试。';
}

function currentText(current: HabitatDashboardDto['current']): string {
  if (current.kind === 'desktop') return '当前在桌面';
  if (current.visibility === 'visible') return '当前空间已显示';
  if (current.visibility === 'lost') return '当前空间已失联';
  return '当前藏在目录空间';
}

export function HabitatSettings(props: HabitatSettingsProps) {
  const [enabled, setEnabled] = useState(false);
  const [autoHideEnabled, setAutoHideEnabled] = useState(false);
  const [idleDelaySeconds, setIdleDelaySeconds] = useState('30');

  useEffect(() => {
    if (!props.dashboard) return;
    setEnabled(props.dashboard.enabled);
    setAutoHideEnabled(props.dashboard.autoHideEnabled);
    setIdleDelaySeconds(String(props.dashboard.idleDelayMs / 1_000));
  }, [
    props.dashboard?.enabled,
    props.dashboard?.autoHideEnabled,
    props.dashboard?.idleDelayMs
  ]);

  if (props.loading) {
    return (
      <section className="settings-pane" aria-label="目录空间">
        <div className="settings-notice notice-info" role="status">
          正在读取空间设置…
        </div>
      </section>
    );
  }

  if (!props.dashboard) {
    return (
      <section className="settings-pane" aria-label="目录空间">
        <div className="settings-notice notice-error" role="alert">
          无法读取空间设置，请稍后重试。
        </div>
      </section>
    );
  }

  const dashboard = props.dashboard;
  const activeBusyLabel = props.busyLabel
    ?? (dashboard.busyReason ? busyReasonText[dashboard.busyReason] : null);
  const unavailable = props.busy || dashboard.busyReason !== null;
  const seconds = Number(idleDelaySeconds);
  const delayValid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400;
  const currentDirectoryId = dashboard.current.kind === 'folder'
    ? dashboard.current.directoryId
    : null;

  return (
    <section
      className="settings-pane"
      role="region"
      aria-labelledby="habitat-settings-heading"
      aria-busy={unavailable}
    >
      {activeBusyLabel ? (
        <div className="settings-notice notice-info" role="status">
          {activeBusyLabel}
        </div>
      ) : null}
      {dashboard.errorCode ? (
        <div className="settings-notice notice-error" role="alert">
          {habitatErrorMessage({ code: dashboard.errorCode })}
        </div>
      ) : null}

      <section className="settings-band">
        <div className="pane-heading">
          <div>
            <h2 id="habitat-settings-heading">目录空间</h2>
            <p>控制桌宠是否可以进入已授权的本地目录空间。</p>
          </div>
          <button
            className="quiet-button"
            type="button"
            disabled={unavailable}
            onClick={props.onAdd}
          >
            添加目录
          </button>
        </div>

        <div className="form-grid">
          <label className="compact-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={unavailable}
              onChange={event => setEnabled(event.currentTarget.checked)}
            />
            <span>启用目录空间</span>
          </label>
          <label className="compact-toggle">
            <input
              type="checkbox"
              checked={autoHideEnabled}
              disabled={unavailable || !enabled}
              onChange={event => setAutoHideEnabled(event.currentTarget.checked)}
            />
            <span>自动藏身</span>
          </label>
          <label>
            <span>空闲延迟（秒）</span>
            <input
              type="number"
              min={1}
              max={86_400}
              step={1}
              value={idleDelaySeconds}
              disabled={unavailable || !enabled || !autoHideEnabled}
              aria-describedby="habitat-idle-help"
              onChange={event => setIdleDelaySeconds(event.currentTarget.value)}
            />
          </label>
          <p id="habitat-idle-help" className="field-help">
            连续空闲达到此时间后，自动藏身策略才会尝试进入目录。
          </p>
        </div>
        {!delayValid ? (
          <p className="field-error" role="alert">空闲延迟必须是 1 到 86400 秒的整数。</p>
        ) : null}
        <div className="form-footer">
          <span className="field-help">关闭总开关不会删除任何目录配置。</span>
          <button
            className="primary-button"
            type="button"
            disabled={unavailable || !delayValid}
            onClick={() => props.onSavePreferences({
              enabled,
              autoHideEnabled,
              idleDelayMs: seconds * 1_000
            })}
          >
            保存空间偏好
          </button>
        </div>
      </section>

      <section className="settings-band" aria-labelledby="habitat-current-heading">
        <div className="pane-heading">
          <div>
            <h2 id="habitat-current-heading">当前状态</h2>
            <p>{currentText(dashboard.current)}</p>
          </div>
        </div>
        <div className="root-actions">
          <button
            type="button"
            disabled={
              unavailable
              || !enabled
              || dashboard.current.kind === 'desktop'
              || dashboard.current.visibility === 'lost'
            }
            onClick={props.onSummon}
          >
            呼唤桌宠
          </button>
          <button
            type="button"
            disabled={unavailable || dashboard.current.kind === 'desktop'}
            onClick={props.onRecall}
          >
            召回桌面
          </button>
        </div>
      </section>

      <section className="settings-band" aria-labelledby="habitat-directories-heading">
        <div className="pane-heading">
          <div>
            <h2 id="habitat-directories-heading">已配置目录</h2>
            <p>目录只显示公开名称和末级提示，不显示磁盘绝对路径。</p>
          </div>
        </div>
        {dashboard.directories.length === 0 ? (
          <p className="empty-state">尚未添加目录空间。</p>
        ) : (
          <div className="profile-list">
            {dashboard.directories.map(directory => {
              const isCurrent = currentDirectoryId === directory.id;
              const canEnter = enabled
                && directory.enabled
                && directory.availability === 'available'
                && !isCurrent
                && !unavailable;
              return (
                <article className="settings-band" key={directory.id}>
                  <div className="pane-heading">
                    <div>
                      <h2>{directory.displayName}</h2>
                      <p>{directory.pathHint}</p>
                    </div>
                    <span className="capability-badge">
                      {directory.availability === 'available' ? '可用' : '失联'}
                    </span>
                  </div>
                  <label className="compact-toggle">
                    <input
                      type="checkbox"
                      aria-label={`启用目录：${directory.displayName}`}
                      checked={directory.enabled}
                      disabled={unavailable}
                      onChange={event => props.onToggleDirectory(
                        directory.id,
                        event.currentTarget.checked
                      )}
                    />
                    <span>启用此目录</span>
                  </label>
                  <div className="server-actions">
                    <button
                      className="quiet-button"
                      type="button"
                      aria-label={`立即藏到${directory.displayName}`}
                      title={canEnter ? undefined : '目录需已启用、可用且当前无其他操作'}
                      disabled={!canEnter}
                      onClick={() => props.onEnter(directory.id)}
                    >
                      立即藏到这里
                    </button>
                    <button
                      className="danger-text-button"
                      type="button"
                      aria-label={`删除${directory.displayName}配置`}
                      disabled={unavailable || isCurrent}
                      onClick={() => props.onRemove(directory.id)}
                    >
                      删除配置
                    </button>
                  </div>
                  <p className="field-help">只删除这条配置，不会删除磁盘目录。</p>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
