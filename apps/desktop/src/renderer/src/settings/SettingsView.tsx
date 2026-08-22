import { useEffect, useRef, useState } from 'react';
import { Bot, Box, Database, ShieldCheck, X } from 'lucide-react';
import type {
  MyselfApi,
  PrivacySettingsDto,
  SaveProviderProfileInput,
  SettingsDashboardDto
} from '../../../shared/myself-api';
import type { LocalDataScope } from '../../../shared/myself-api';
import type { ModelRouteConfig } from '@myself/shared-types';
import { ProviderSettings } from './ProviderSettings';
import { PrivacySettings } from './PrivacySettings';
import {
  TransientToastLayer,
  type TransientToast
} from '../components/TransientToastLayer';
export type SettingsTab = 'models' | 'privacy' | 'local';
type Notice = TransientToast | null;
type NoticePayload = Omit<TransientToast, 'id'>;

const emptyDashboard: SettingsDashboardDto = {
  catalog: [],
  profiles: [],
  route: {
    primaryProfileId: null,
    chatProfileId: null,
    agentProfileId: null,
    visionProfileId: null,
    fallbackProfileIds: [],
    allowCrossProviderFallback: false
  },
  privacy: {
    dataCategories: {
      file: false,
      screenshot: false,
      clipboard: false,
      memory: false
    },
    longTermMemory: false,
    proactivityMode: 'assistive'
  },
  privacyRuntimeSupport: {
    dataCategories: {
      file: true,
      screenshot: false,
      clipboard: false,
      memory: false
    },
    longTermMemory: false,
    proactivity: false
  },
  petAlwaysOnTop: false,
  authorizedRoot: null
};

export interface SettingsWorkspaceProps {
  dashboard: SettingsDashboardDto;
  activeTab: SettingsTab;
  busy: boolean;
  notice: Notice;
  onDismissNotice(id: string): void;
  onTabChange(tab: SettingsTab): void;
  onClose(): void;
  providerActions: {
    onSave(input: SaveProviderProfileInput): void;
    onTest(profileId: string): void;
    onRouteSave(route: ModelRouteConfig): void;
    onDelete(profileId: string): void;
  };
  privacyActions: {
    incognito: boolean;
    onSave(input: PrivacySettingsDto): void;
    onPetAlwaysOnTopChange(enabled: boolean): void;
    onIncognitoChange(value: boolean): void;
    onChooseRoot(): void;
    onRevokeRoot(): void;
  };
  onClear(scope: LocalDataScope): void;
  onOpenCharacterWorkshop(): void;
}

const tabs = [
  ['models', '模型', Bot],
  ['privacy', '隐私', ShieldCheck],
  ['local', '本地数据', Database]
] as const;

export function availableSettingsTabs(): readonly SettingsTab[] {
  return tabs.map(([id]) => id);
}

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  const activeTab = props.activeTab;

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div><span className="companion-kicker">AI PET</span><h1>设置</h1></div>
        <div className="settings-header-actions">
          <button
            className="settings-workshop-button"
            type="button"
            onClick={props.onOpenCharacterWorkshop}
          >
            <Box size={17} />角色工作室
          </button>
          <button type="button" aria-label="关闭设置" title="关闭设置" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      <TransientToastLayer
        queue={props.notice ? [props.notice] : []}
        onDismiss={props.onDismissNotice}
        durationMs={() => 3000}
        ariaLabel="设置提示"
      />
      <nav className="settings-tabs" aria-label="设置分类">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => props.onTabChange(id)}
          >
            <Icon size={17} />{label}
          </button>
        ))}
      </nav>
      {activeTab === 'models' ? (
        <ProviderSettings
          dashboard={props.dashboard}
          busy={props.busy}
          {...props.providerActions}
        />
      ) : null}
      {activeTab === 'privacy' ? (
        <PrivacySettings
          privacy={props.dashboard.privacy}
          runtimeSupport={props.dashboard.privacyRuntimeSupport}
          authorizedRoot={props.dashboard.authorizedRoot}
          busy={props.busy}
          petAlwaysOnTop={props.dashboard.petAlwaysOnTop}
          {...props.privacyActions}
        />
      ) : null}
      {activeTab === 'local' ? (
        <section className="settings-band local-data-pane" aria-labelledby="local-heading">
          <div className="pane-heading">
            <div><h2 id="local-heading">本地数据</h2><p>按范围清理，不会删除授权目录中的文件。</p></div>
          </div>
          <div className="local-data-actions">
            <button type="button" disabled={props.busy} onClick={() => props.onClear('conversation')}>清除对话摘要</button>
            <button type="button" disabled={props.busy} onClick={() => props.onClear('audit')}>清除操作摘要</button>
            <button type="button" disabled={props.busy} onClick={() => props.onClear('secret')}>清除当前密钥</button>
            <button className="danger-button" type="button" disabled={props.busy} onClick={() => props.onClear('all')}>清除全部本地数据</button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

export function SettingsView({ api = window.myself }: { api?: MyselfApi }) {
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [activeTab, setActiveTab] = useState<SettingsTab>('models');
  const [busy, setBusy] = useState(false);
  const [incognito, setIncognito] = useState(false);
  const noticeSequence = useRef(0);
  const [notice, setNotice] = useState<Notice>({
    id: 'settings-toast-0',
    tone: 'info',
    text: '正在读取本地设置…'
  });

  /** 所有设置操作共用同一个入口，保证提示 id 单调递增并替换当前提示。 */
  const showNotice = (next: NoticePayload): void => {
    noticeSequence.current += 1;
    setNotice({ ...next, id: `settings-toast-${noticeSequence.current}` });
  };

  /** 仅关闭仍与回调 id 对应的提示，隔离过期 timer 和异步回调。 */
  const dismissNotice = (id: string): void => {
    setNotice(current => current?.id === id ? null : current);
  };

  useEffect(() => {
    let active = true;
    const initialLoadOwner = noticeSequence.current;
    void api.getSettingsDashboard().then(result => {
      if (!active || noticeSequence.current !== initialLoadOwner) return;
      setDashboard(result);
      dismissNotice('settings-toast-0');
    }).catch(() => {
      if (active && noticeSequence.current === initialLoadOwner) {
        showNotice({ tone: 'error', text: '无法读取设置，请重新打开窗口。' });
      }
    });
    return () => { active = false; };
  }, [api]);

  const run = async (
    operation: () => Promise<
      SettingsDashboardDto
      | { dashboard?: SettingsDashboardDto; notice?: NoticePayload }
      | void
    >,
    success: string
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await operation();
      if (result && 'catalog' in result) {
        setDashboard(result);
        showNotice({ tone: 'success', text: success });
      } else {
        if (result?.dashboard) setDashboard(result.dashboard);
        showNotice(result?.notice ?? { tone: 'success', text: success });
      }
    } catch {
      showNotice({ tone: 'error', text: '操作未完成，请检查输入后重试。' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsWorkspace
      dashboard={dashboard}
      activeTab={activeTab}
      busy={busy}
      notice={notice}
      onDismissNotice={dismissNotice}
      onTabChange={setActiveTab}
      onClose={() => window.close()}
      providerActions={{
        onSave: input => void run(() => api.saveProviderProfile(input), '模型档案已保存。'),
        onTest: profileId => void run(async () => {
          const result = await api.testProviderProfile(profileId);
          return {
            notice: result.ok
              ? { tone: 'success', text: '连接测试完成。' }
              : { tone: 'error', text: result.message }
          };
        }, '连接测试完成。'),
        onRouteSave: route => void run(() => api.saveModelRoute(route), '模型路由已保存。'),
        onDelete: profileId => void run(
          () => api.deleteProviderProfile(profileId),
          '模型档案已删除。'
        )
      }}
      privacyActions={{
        incognito,
        onSave: input => void run(() => api.savePrivacySettings(input), '隐私设置已保存。'),
        onPetAlwaysOnTopChange: enabled => void run(
          () => api.savePetAlwaysOnTop(enabled),
          enabled ? '桌宠已置顶。' : '桌宠已恢复动态图层。'
        ),
        onIncognitoChange: value => void run(async () => {
          await api.setIncognitoSession(value);
          setIncognito(value);
        }, value ? '已进入无痕会话。' : '已退出无痕会话。'),
        onChooseRoot: () => void run(async () => {
          await api.chooseAuthorizedRoot();
          return api.getSettingsDashboard();
        }, '授权目录已更新。'),
        onRevokeRoot: () => void run(() => api.revokeAuthorizedRoot(), '目录权限已撤销。')
      }}
      onClear={scope => {
        if (
          scope === 'all'
          && !window.confirm('确定清除全部本地设置和已保存密钥吗？')
        ) return;
        void run(async () => {
          await api.clearLocalData(scope);
          return api.getSettingsDashboard();
        }, '所选本地数据已清除。');
      }}
      onOpenCharacterWorkshop={() => void api.openCharacterWorkshop()}
    />
  );
}
