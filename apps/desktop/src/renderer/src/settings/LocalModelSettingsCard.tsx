import type { LocalModelPublicStatus } from '../../../shared/local-model-ipc';

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

function reasonText(reasonCode: LocalModelPublicStatus['reasonCode']): string {
  const reasons: Record<NonNullable<LocalModelPublicStatus['reasonCode']>, string> = {
    RESOURCE_MISSING: '内置资源缺失',
    RESOURCE_HASH_MISMATCH: '内置资源校验失败',
    RUNTIME_INCOMPATIBLE: '运行时不兼容',
    VULKAN_UNAVAILABLE: 'Vulkan 不可用',
    CPU_START_FAILED: 'CPU 兼容模式启动失败',
    MODEL_LOAD_TIMEOUT: '模型加载超时',
    PORT_CONFLICT: '本地端口冲突',
    PROCESS_CRASHED: '本地模型进程意外退出',
    PROTOCOL_INCOMPATIBLE: '本地模型协议不兼容',
    PROCESS_CLEANUP_FAILED: '本地模型进程清理失败'
  };
  return reasonCode ? reasons[reasonCode] : '本地模型启动失败';
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
          <p>原因：{reasonText(status.reasonCode)}</p>
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
