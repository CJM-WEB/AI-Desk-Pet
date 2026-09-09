import type { LocalModelPublicStatus } from '../../../shared/local-model-ipc';
import { localModelReasonText } from '../local-model-status';

export interface LocalModelSettingsCardProps {
  status: LocalModelPublicStatus;
  busy: boolean;
  onEnabledChange?: ((enabled: boolean) => void) | undefined;
}

function statusText(status: LocalModelPublicStatus): string {
  if (!status.enabled || status.phase === 'disabled') return '已关闭';
  if (status.phase === 'validating') return '正在检查资源';
  if (status.phase === 'loading') return '本地模型加载中';
  if (status.phase === 'stopping') return '正在停止本地模型';
  if (status.phase === 'faulted') return '本地模型启动失败';
  return status.backend === 'cpu' ? 'CPU 兼容模式' : 'Vulkan 已就绪';
}

/** 本地模型卡只展示公开状态，并保持云端档案表单独立可编辑。 */
export function LocalModelSettingsCard({
  status,
  busy,
  onEnabledChange
}: LocalModelSettingsCardProps) {
  const actionDisabled = busy || onEnabledChange === undefined;

  return (
    <section className="settings-band local-model-card" aria-labelledby="local-model-heading">
      <div className="pane-heading">
        <div>
          <h2 id="local-model-heading">内置本地模型</h2>
          <p>Qwen3.5-4B · 无需 API Key</p>
        </div>
        <label className="compact-toggle">
          <input
            aria-label="启用内置本地模型"
            checked={status.enabled}
            disabled={actionDisabled}
            role="switch"
            type="checkbox"
            onChange={event => onEnabledChange?.(event.target.checked)}
          />
          {busy ? '正在切换…' : status.enabled ? '已开启' : '已关闭'}
        </label>
      </div>
      <p className="local-model-status">{statusText(status)}</p>
      {status.backend === 'cpu' && status.phase === 'ready' ? (
        <p className="field-help">CPU 兼容模式可继续聊天和执行 Agent，但响应速度可能较慢。</p>
      ) : null}
      {status.phase === 'faulted' ? (
        <div className="local-model-fault" role="alert">
          <p>原因：{localModelReasonText(status.reasonCode)}</p>
          <button
            className="quiet-button"
            type="button"
            disabled={actionDisabled}
            onClick={() => onEnabledChange?.(true)}
          >
            重新加载
          </button>
        </div>
      ) : null}
      <p className="field-help">开启期间聊天和 Agent 不调用云模型，视觉暂不可用。</p>
    </section>
  );
}
