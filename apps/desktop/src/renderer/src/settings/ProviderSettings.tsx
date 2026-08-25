import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { KeyRound, PlugZap, Save, Trash2 } from 'lucide-react';
import type {
  ModelCapability,
  ModelRouteConfig,
  StoredProviderProfileV2
} from '@myself/shared-types';
import type {
  SaveProviderProfileInput,
  SettingsDashboardDto
} from '../../../shared/myself-api';

export interface ProviderSettingsProps {
  dashboard: SettingsDashboardDto;
  busy: boolean;
  onSave(input: SaveProviderProfileInput): void;
  onTest(profileId: string): void;
  onRouteSave(route: ModelRouteConfig): void;
  onDelete(profileId: string): void;
}

function profileCapabilities(
  dashboard: SettingsDashboardDto,
  profileId: string
): ModelCapability[] {
  const profile = dashboard.profiles.find(item => item.id === profileId);
  if (!profile) return [];
  if (profile.mode === 'custom') return profile.capabilities ?? ['chat'];
  const provider = dashboard.catalog.find(item => item.providerId === profile.providerId);
  if (!provider) return [];
  return provider.models.find(item => item.modelId === profile.modelId)
    ?.capabilities ?? profile.capabilities ?? ['chat'];
}

export function ProviderSettings(props: ProviderSettingsProps) {
  const firstProvider = props.dashboard.catalog[0];
  const [providerId, setProviderId] = useState(firstProvider?.providerId ?? '');
  const selectedProvider = props.dashboard.catalog.find(item => item.providerId === providerId)
    ?? firstProvider;
  const firstModel = selectedProvider?.models[0];
  const [modelId, setModelId] = useState(firstModel?.modelId ?? '');
  const selectedModel = selectedProvider?.models.find(item => item.modelId === modelId);
  const [displayName, setDisplayName] = useState(selectedProvider?.displayName ?? '');
  const [secret, setSecret] = useState('');
  const [persistSecret, setPersistSecret] = useState(true);
  const [customMode, setCustomMode] = useState(false);
  const [protocol, setProtocol] = useState<'openai-compatible' | 'anthropic' | 'gemini'>(
    selectedProvider?.protocol ?? 'openai-compatible'
  );
  const [baseUrl, setBaseUrl] = useState(selectedProvider?.baseUrl ?? '');
  const [customModelId, setCustomModelId] = useState('');
  const [additionalParameters, setAdditionalParameters] = useState('');
  const [formError, setFormError] = useState('');
  const [route, setRoute] = useState<ModelRouteConfig>(props.dashboard.route);
  const capabilities = selectedModel?.capabilities ?? ['chat'];

  useEffect(() => {
    const provider = props.dashboard.catalog[0];
    setProviderId(provider?.providerId ?? '');
    setModelId(provider?.models[0]?.modelId ?? '');
    setDisplayName(provider?.displayName ?? '');
    setProtocol(provider?.protocol ?? 'openai-compatible');
    setBaseUrl(provider?.baseUrl ?? '');
    setRoute(props.dashboard.route);
  }, [props.dashboard.catalog, props.dashboard.route]);

  const profileOptions = useMemo(() => props.dashboard.profiles.map(profile => ({
    profile,
    capabilities: profileCapabilities(props.dashboard, profile.id)
  })), [props.dashboard]);

  const selectProvider = (nextProviderId: string): void => {
    const provider = props.dashboard.catalog.find(item => item.providerId === nextProviderId);
    setProviderId(nextProviderId);
    setModelId(provider?.models[0]?.modelId ?? '');
    setDisplayName(provider?.displayName ?? '');
    setProtocol(provider?.protocol ?? 'openai-compatible');
    setBaseUrl(provider?.baseUrl ?? '');
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFormError('');
    const id = `${customMode ? 'custom' : providerId}-${Date.now()}`;
    let profile: StoredProviderProfileV2;
    if (customMode) {
      let parsedParameters: Record<string, string | number | boolean> = {};
      try {
        const value = JSON.parse(additionalParameters || '{}') as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('INVALID_ADDITIONAL_PARAMETERS');
        }
        const entries = Object.entries(value);
        if (entries.some(([, item]) => !['string', 'number', 'boolean'].includes(typeof item))) {
          throw new Error('INVALID_ADDITIONAL_PARAMETERS');
        }
        parsedParameters = value as Record<string, string | number | boolean>;
      } catch {
        setFormError('额外参数必须是仅包含字符串、数字或布尔值的 JSON 对象。');
        return;
      }
      profile = {
        id,
        displayName,
        mode: 'custom',
        protocol,
        baseUrl,
        modelId: customModelId,
        additionalParameters: parsedParameters,
        capabilities: ['chat', 'tools']
      };
    } else {
      profile = {
        id,
        displayName,
        mode: 'preset',
        providerId,
        modelId,
        capabilities
      };
    }
    props.onSave({
      profile,
      ...(secret ? { secret } : {}),
      persistSecret
    });
    setSecret('');
  };

  return (
    <div className="settings-pane provider-settings">
      <section className="settings-band" aria-labelledby="provider-heading">
        <div className="pane-heading">
          <div>
            <h2 id="provider-heading">模型档案</h2>
            <p>普通模式只需选择服务、模型并填写密钥。</p>
          </div>
          <label className="compact-toggle">
            <input
              type="checkbox"
              checked={customMode}
              onChange={event => setCustomMode(event.target.checked)}
            />
            自定义
          </label>
        </div>

        <form className="provider-form" onSubmit={submit}>
          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
          <div className="form-grid">
            <label>
              提供商
              <select
                value={providerId}
                disabled={customMode || props.busy}
                onChange={event => selectProvider(event.target.value)}
              >
                {props.dashboard.catalog.map(provider => (
                  <option key={provider.providerId} value={provider.providerId}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              模型
              <>
                <input
                  list="preset-model-options"
                  value={modelId}
                  disabled={customMode || props.busy}
                  onChange={event => setModelId(event.target.value.trim())}
                />
                <datalist id="preset-model-options">
                  {selectedProvider?.models.map(model => (
                    <option key={model.modelId} value={model.modelId}>{model.displayName}</option>
                  ))}
                </datalist>
              </>
            </label>
            <small>列表没有新模型时，可直接输入服务商公布的模型 ID；未知模型默认仅启用聊天。</small>
            <label className="wide-field">
              <span className="label-with-icon"><KeyRound size={16} />API Key</span>
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                placeholder="密钥只交给 Electron Main 安全存储"
                onChange={event => setSecret(event.target.value)}
              />
            </label>
          </div>

          <div className="capability-row" aria-label="模型能力">
            {capabilities.map(capability => (
              <span className="capability-badge" key={capability}>{capability}</span>
            ))}
          </div>

          <details className="advanced-settings">
            <summary>高级设置</summary>
            <div className="form-grid">
              <label>
                档案名称
                <input value={displayName} onChange={event => setDisplayName(event.target.value)} />
              </label>
              <label>
                协议
                <select
                  value={protocol}
                  disabled={!customMode}
                  onChange={event => setProtocol(event.target.value as typeof protocol)}
                >
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label className="wide-field">
                Base URL
                <input
                  type="url"
                  value={baseUrl}
                  disabled={!customMode}
                  onChange={event => setBaseUrl(event.target.value)}
                />
              </label>
              <label>
                Model ID
                <input
                  value={customModelId}
                  disabled={!customMode}
                  onChange={event => setCustomModelId(event.target.value)}
                />
              </label>
              <label>
                额外参数（JSON）
                <input
                  value={additionalParameters}
                  disabled={!customMode}
                  placeholder='{"temperature":0.2}'
                  onChange={event => setAdditionalParameters(event.target.value)}
                />
              </label>
            </div>
          </details>

          <div className="form-footer">
            <label className="compact-toggle">
              <input
                type="checkbox"
                checked={persistSecret}
                onChange={event => setPersistSecret(event.target.checked)}
              />
              使用 Windows 安全存储
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={props.busy}
            >
              <Save size={16} />保存档案
            </button>
          </div>
        </form>
      </section>

      <section className="settings-band" aria-labelledby="profiles-heading">
        <div className="pane-heading">
          <div><h2 id="profiles-heading">已保存档案</h2><p>每个档案使用独立密钥槽。</p></div>
        </div>
        <div className="profile-list">
          {props.dashboard.profiles.length === 0
            ? <p className="empty-state">尚未保存模型档案。</p>
            : props.dashboard.profiles.map(profile => (
              <div className="profile-row" key={profile.id}>
                <div>
                  <strong>{profile.displayName}</strong>
                  <span>{profile.modelId} · {profile.hasStoredSecret ? '密钥已保存' : '缺少密钥'}</span>
                </div>
                <div className="icon-actions">
                  <button
                    type="button"
                    title="测试连接"
                    aria-label={`测试 ${profile.displayName} 连接`}
                    disabled={props.busy || !profile.hasStoredSecret}
                    onClick={() => props.onTest(profile.id)}
                  >
                    <PlugZap size={17} />
                  </button>
                  <button
                    type="button"
                    title="删除档案"
                    aria-label={`删除 ${profile.displayName}`}
                    disabled={props.busy}
                    onClick={() => props.onDelete(profile.id)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
        </div>
      </section>

      <section className="settings-band" aria-labelledby="route-heading">
        <div className="pane-heading">
          <div><h2 id="route-heading">模型路由</h2><p>Agent 和视觉路由会在保存前校验能力。</p></div>
        </div>
        <div className="route-grid">
          {([
            ['primaryProfileId', '主模型', undefined],
            ['chatProfileId', '对话模型', 'chat'],
            ['agentProfileId', 'Agent 模型', 'tools'],
            ['visionProfileId', '视觉模型', 'vision']
          ] as const).map(([key, label, required]) => (
            <label key={key}>
              {label}
              <select
                value={route[key] ?? ''}
                onChange={event => setRoute(current => ({
                  ...current,
                  [key]: event.target.value || null
                }))}
              >
                <option value="">跟随主模型</option>
                {profileOptions.map(({ profile, capabilities: profileCaps }) => (
                  <option
                    key={profile.id}
                    value={profile.id}
                    disabled={required !== undefined && !profileCaps.includes(required)}
                  >
                    {profile.displayName}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            备用模型
            <select
              value={route.fallbackProfileIds[0] ?? ''}
              onChange={event => setRoute(current => ({
                ...current,
                fallbackProfileIds: event.target.value ? [event.target.value] : []
              }))}
            >
              <option value="">不使用备用模型</option>
              {profileOptions.map(({ profile }) => (
                <option key={profile.id} value={profile.id}>{profile.displayName}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="compact-toggle route-authorization">
          <input
            type="checkbox"
            checked={route.allowCrossProviderFallback}
            onChange={event => setRoute(current => ({
              ...current,
              allowCrossProviderFallback: event.target.checked
            }))}
          />
          允许跨提供商备用
        </label>
        <p className="field-help">开启后，故障转移会把必要上下文发送给另一家提供商。</p>
        <button
          className="quiet-button"
          type="button"
          disabled={props.busy}
          onClick={() => props.onRouteSave(route)}
        >
          <Save size={16} />保存路由
        </button>
      </section>
    </div>
  );
}
