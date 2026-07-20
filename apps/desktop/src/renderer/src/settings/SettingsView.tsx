import { useEffect, useState, type FormEvent } from 'react';
import type { PublicSettings } from '@myself/shared-types';
import type { LocalDataScope, MyselfApi } from '../../../shared/myself-api';

export type SettingsFields = {
  displayName: string;
  baseUrl: string;
  model: string;
  secret: string;
  persistSecret: boolean;
};

type BusyAction = 'save' | 'test' | 'root' | 'clear' | null;

export interface SettingsFormProps {
  settings: PublicSettings;
  fields: SettingsFields;
  busyAction: BusyAction;
  notice: { tone: 'success' | 'error' | 'info'; text: string } | null;
  onFieldChange(name: keyof SettingsFields, value: string | boolean): void;
  onSave(event: FormEvent): void;
  onTest(): void;
  onChooseRoot(): void;
  onClear(scope: LocalDataScope): void;
  onClose(): void;
}

export function SettingsForm(props: SettingsFormProps) {
  const busy = props.busyAction !== null;
  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div><span className="companion-kicker">MYSELF</span><h1>陪伴设置</h1></div>
        <button type="button" onClick={props.onClose}>关闭设置</button>
      </header>

      {props.notice ? <div className={`settings-notice notice-${props.notice.tone}`} role="status">{props.notice.text}</div> : null}

      <form className="settings-section" onSubmit={props.onSave}>
        <div className="section-heading"><div><span>01</span><h2>模型伙伴</h2></div><p>连接你信任的兼容模型服务</p></div>
        <div className="field-grid">
          <label>显示名称<input value={props.fields.displayName} required onChange={event => props.onFieldChange('displayName', event.target.value)} /></label>
          <label>模型名称<input value={props.fields.model} required onChange={event => props.onFieldChange('model', event.target.value)} /></label>
          <label className="wide-field">Base URL<input type="url" value={props.fields.baseUrl} required placeholder="https://api.example.com/v1" onChange={event => props.onFieldChange('baseUrl', event.target.value)} /></label>
          <label className="wide-field">API Key<input type="password" autoComplete="new-password" value={props.fields.secret} required placeholder={props.settings.provider?.hasStoredSecret ? '已安全保存；修改配置时请重新输入' : '只会发送给你选择的模型服务'} onChange={event => props.onFieldChange('secret', event.target.value)} /></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={props.fields.persistSecret} onChange={event => props.onFieldChange('persistSecret', event.target.checked)} />使用 Windows 安全存储保存 API Key</label>
        <div className="section-actions">
          <button className="primary-button" type="submit" disabled={busy}>{props.busyAction === 'save' ? '正在保存…' : '保存模型配置'}</button>
          <button className="quiet-button" type="button" disabled={busy} onClick={props.onTest}>{props.busyAction === 'test' ? '正在测试…' : '测试连接'}</button>
        </div>
      </form>

      <section className="settings-section">
        <div className="section-heading"><div><span>02</span><h2>工作目录</h2></div><p>Myself 只会访问你主动授权的位置</p></div>
        <div className="root-card">
          <div><strong>{props.settings.authorizedRoot?.displayName ?? '尚未选择目录'}</strong><span>{props.settings.authorizedRoot?.pathHint ?? '选择后只会显示经过隐私处理的路径摘要'}</span></div>
          <button className="primary-button" type="button" disabled={busy} onClick={props.onChooseRoot}>{props.busyAction === 'root' ? '正在选择…' : '选择工作目录'}</button>
        </div>
        <p className="privacy-note">文件内容可能会发送给你配置的模型服务；Myself 不会访问授权目录之外的位置，所有写操作都需要你确认。</p>
      </section>

      <section className="settings-section danger-section">
        <div className="section-heading"><div><span>03</span><h2>本地数据</h2></div><p>按范围清理保存在这台电脑上的信息</p></div>
        <div className="clear-actions">
          <button type="button" disabled={busy} onClick={() => props.onClear('conversation')}>清除对话摘要</button>
          <button type="button" disabled={busy} onClick={() => props.onClear('audit')}>清除操作摘要</button>
          <button type="button" disabled={busy} onClick={() => props.onClear('secret')}>清除已保存密钥</button>
          <button className="danger-button" type="button" disabled={busy} onClick={() => props.onClear('all')}>清除全部本地数据</button>
        </div>
      </section>
    </main>
  );
}

const emptySettings: PublicSettings = {
  version: 1,
  provider: null,
  authorizedRoot: null,
  petPosition: null,
  fileDisclosureAccepted: false
};

function fieldsFor(settings: PublicSettings): SettingsFields {
  return {
    displayName: settings.provider?.displayName ?? '',
    baseUrl: settings.provider?.baseUrl ?? '',
    model: settings.provider?.model ?? '',
    secret: '',
    persistSecret: true
  };
}

export function SettingsView({ api = window.myself }: { api?: MyselfApi }) {
  const [settings, setSettings] = useState<PublicSettings>(emptySettings);
  const [fields, setFields] = useState<SettingsFields>(() => fieldsFor(emptySettings));
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<SettingsFormProps['notice']>({ tone: 'info', text: '正在读取本地设置…' });

  useEffect(() => {
    let active = true;
    void api.getSettings().then(value => {
      if (!active) return;
      setSettings(value);
      setFields(fieldsFor(value));
      setNotice(null);
    }).catch(() => {
      if (active) setNotice({ tone: 'error', text: '无法读取本地设置，请重新打开设置窗口。' });
    });
    return () => { active = false; };
  }, [api]);

  const run = async (action: Exclude<BusyAction, null>, operation: () => Promise<void>): Promise<void> => {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await operation();
    } catch {
      setNotice({ tone: 'error', text: '操作没有完成，请检查输入后重试。' });
    } finally {
      setBusyAction(null);
    }
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    void run('save', async () => {
      const updated = await api.saveProvider(fields);
      setSettings(updated);
      setFields(current => ({ ...current, secret: '' }));
      setNotice({ tone: 'success', text: '模型配置已安全保存。' });
    });
  };

  const testConnection = (): void => {
    void run('test', async () => {
      const result = await api.testProvider();
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message });
    });
  };

  const chooseRoot = (): void => {
    void run('root', async () => {
      const updated = await api.chooseAuthorizedRoot();
      setSettings(updated);
      setNotice({ tone: 'success', text: updated.authorizedRoot ? '工作目录已更新。' : '没有更改工作目录。' });
    });
  };

  const clearData = (scope: LocalDataScope): void => {
    if (scope === 'all' && !window.confirm('确定清除全部本地设置和已保存密钥吗？此操作不会删除工作目录中的文件。')) return;
    void run('clear', async () => {
      const updated = await api.clearLocalData(scope);
      setSettings(updated);
      if (scope === 'all') setFields(fieldsFor(updated));
      setNotice({ tone: 'success', text: '所选本地数据已清除。' });
    });
  };

  return (
    <SettingsForm
      settings={settings}
      fields={fields}
      busyAction={busyAction}
      notice={notice}
      onFieldChange={(name, value) => setFields(current => ({ ...current, [name]: value }))}
      onSave={save}
      onTest={testConnection}
      onChooseRoot={chooseRoot}
      onClear={clearData}
      onClose={() => window.close()}
    />
  );
}
