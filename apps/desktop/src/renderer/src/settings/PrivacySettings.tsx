import { useEffect, useState } from 'react';
import { FolderLock, ShieldCheck, Unplug } from 'lucide-react';
import type {
  PrivacyRuntimeSupportDto,
  PrivacySettingsDto,
  SettingsDashboardDto
} from '../../../shared/myself-api';

export interface PrivacySettingsProps {
  privacy: PrivacySettingsDto;
  runtimeSupport: PrivacyRuntimeSupportDto;
  authorizedRoot: SettingsDashboardDto['authorizedRoot'];
  busy: boolean;
  incognito: boolean;
  onSave(input: PrivacySettingsDto): void;
  onIncognitoChange(value: boolean): void;
  onChooseRoot(): void;
  onRevokeRoot(): void;
}

const categoryLabels = {
  file: ['文件', '仅在明确任务中发送所需文件内容'],
  screenshot: ['截图', '允许发送当前任务需要的屏幕图像'],
  clipboard: ['剪贴板', '允许读取并发送当前剪贴板内容'],
  memory: ['长期记忆', '允许模型请求使用本地长期记忆']
} as const;

export function PrivacySettings(props: PrivacySettingsProps) {
  const [privacy, setPrivacy] = useState(props.privacy);

  useEffect(() => {
    setPrivacy(props.privacy);
  }, [props.privacy]);

  return (
    <div className="settings-pane privacy-settings">
      <section className="settings-band" aria-labelledby="privacy-heading">
        <div className="pane-heading">
          <div>
            <h2 id="privacy-heading">数据披露</h2>
            <p>各类别独立授权，不会互相联动。</p>
          </div>
          <ShieldCheck size={20} />
        </div>
        <div className="permission-list">
          {Object.entries(categoryLabels).map(([key, [label, help]]) => {
            const category = key as keyof PrivacySettingsDto['dataCategories'];
            const supported = props.runtimeSupport.dataCategories[category];
            return (
              <label className="permission-row" key={category}>
                <span>
                  <strong>{label}</strong>
                  <small>{supported ? help : `${help}（尚未接入运行时）`}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label={`${label}数据授权`}
                  checked={supported && privacy.dataCategories[category]}
                  disabled={props.busy || !supported}
                  onChange={event => setPrivacy(current => ({
                    ...current,
                    dataCategories: {
                      ...current.dataCategories,
                      [category]: event.target.checked
                    }
                  }))}
                />
              </label>
            );
          })}
          <label className="permission-row">
            <span>
              <strong>启用本地长期记忆</strong>
              <small>
                正文只保存在本机，可随时关闭。
                {!props.runtimeSupport.longTermMemory ? '（尚未接入运行时）' : ''}
              </small>
            </span>
            <input
              type="checkbox"
              checked={props.runtimeSupport.longTermMemory && privacy.longTermMemory}
              disabled={props.busy || !props.runtimeSupport.longTermMemory}
              onChange={event => setPrivacy(current => ({
                ...current,
                longTermMemory: event.target.checked
              }))}
            />
          </label>
          <label className="permission-row">
            <span><strong>无痕会话</strong><small>关闭会话后不保留对话和记忆。</small></span>
            <input
              type="checkbox"
              checked={props.incognito}
              disabled={props.busy}
              onChange={event => props.onIncognitoChange(event.target.checked)}
            />
          </label>
        </div>

        <fieldset className="proactivity-fieldset">
          <legend>
            主动性{!props.runtimeSupport.proactivity ? '（尚未接入运行时）' : ''}
          </legend>
          <div className="segmented-control">
            {([
              ['passive', '被动'],
              ['assistive', '辅助'],
              ['autonomous', '自主']
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={privacy.proactivityMode === mode}
                disabled={props.busy || !props.runtimeSupport.proactivity}
                onClick={() => setPrivacy(current => ({ ...current, proactivityMode: mode }))}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <button
          className="primary-button"
          type="button"
          disabled={props.busy}
          onClick={() => props.onSave(privacy)}
        >
          保存隐私设置
        </button>
      </section>

      <section className="settings-band" aria-labelledby="root-heading">
        <div className="pane-heading">
          <div>
            <h2 id="root-heading">授权目录</h2>
            <p>工具只能访问该目录内的相对路径。</p>
          </div>
          <FolderLock size={20} />
        </div>
        <div className="authorized-root">
          <div>
            <strong>{props.authorizedRoot?.displayName ?? '尚未授权目录'}</strong>
            <span>{props.authorizedRoot?.pathHint ?? '只显示经过隐私处理的路径摘要'}</span>
          </div>
          <div className="root-actions">
            <button type="button" disabled={props.busy} onClick={props.onChooseRoot}>
              选择目录
            </button>
            <button
              className="danger-text-button"
              type="button"
              disabled={props.busy || !props.authorizedRoot}
              onClick={props.onRevokeRoot}
            >
              <Unplug size={16} />撤销目录权限
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
