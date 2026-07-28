import { useEffect, useState } from 'react';
import { Bot, Database, ShieldCheck, Wrench, X } from 'lucide-react';
import type {
  McpServerInput,
  MyselfApi,
  PrivacySettingsDto,
  SaveProviderProfileInput,
  SettingsDashboardDto
} from '../../../shared/myself-api';
import type { LocalDataScope } from '../../../shared/myself-api';
import type { ModelRouteConfig } from '@myself/shared-types';
import { ProviderSettings } from './ProviderSettings';
import {
  McpSettings,
  type McpLaunchConfirmation
} from './McpSettings';
import { PrivacySettings } from './PrivacySettings';

export type SettingsTab = 'models' | 'tools' | 'privacy' | 'local';
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

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
  mcpServers: [],
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
  authorizedRoot: null
};

export interface SettingsWorkspaceProps {
  dashboard: SettingsDashboardDto;
  activeTab: SettingsTab;
  busy: boolean;
  notice: Notice;
  onTabChange(tab: SettingsTab): void;
  onClose(): void;
  providerActions: {
    onSave(input: SaveProviderProfileInput): void;
    onTest(profileId: string): void;
    onRouteSave(route: ModelRouteConfig): void;
    onDelete(profileId: string): void;
  };
  mcpActions: {
    launchSummary: McpLaunchConfirmation | null;
    onCancelLaunch(): void;
    onUpsert(input: McpServerInput): void;
    onConfirmLaunch(serverId: string, fingerprint: string): void;
    onTest(serverId: string): void;
    onToggleServer(serverId: string, enabled: boolean): void;
    onToggleTool(serverId: string, toolName: string, enabled: boolean): void;
    onAuthorizeReadOnly(serverId: string, toolName: string): void;
    onRevokeReadOnly(serverId: string, toolName: string): void;
    onDelete(serverId: string): void;
  };
  privacyActions: {
    incognito: boolean;
    onSave(input: PrivacySettingsDto): void;
    onIncognitoChange(value: boolean): void;
    onChooseRoot(): void;
    onRevokeRoot(): void;
  };
  onClear(scope: LocalDataScope): void;
}

const tabs = [
  ['models', '模型', Bot],
  ['tools', '工具', Wrench],
  ['privacy', '隐私', ShieldCheck],
  ['local', '本地数据', Database]
] as const;

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div><span className="companion-kicker">AI PET</span><h1>设置</h1></div>
        <button type="button" aria-label="关闭设置" title="关闭设置" onClick={props.onClose}>
          <X size={18} />
        </button>
      </header>
      <nav className="settings-tabs" aria-label="设置分类">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-current={props.activeTab === id ? 'page' : undefined}
            onClick={() => props.onTabChange(id)}
          >
            <Icon size={17} />{label}
          </button>
        ))}
      </nav>
      {props.notice
        ? <div className={`settings-notice notice-${props.notice.tone}`} role="status">
            {props.notice.text}
          </div>
        : null}
      {props.activeTab === 'models' ? (
        <ProviderSettings
          dashboard={props.dashboard}
          busy={props.busy}
          {...props.providerActions}
        />
      ) : null}
      {props.activeTab === 'tools' ? (
        <McpSettings
          servers={props.dashboard.mcpServers}
          busy={props.busy}
          {...props.mcpActions}
        />
      ) : null}
      {props.activeTab === 'privacy' ? (
        <PrivacySettings
          privacy={props.dashboard.privacy}
          runtimeSupport={props.dashboard.privacyRuntimeSupport}
          authorizedRoot={props.dashboard.authorizedRoot}
          busy={props.busy}
          {...props.privacyActions}
        />
      ) : null}
      {props.activeTab === 'local' ? (
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
  const [launchSummary, setLaunchSummary] = useState<McpLaunchConfirmation | null>(null);
  const [notice, setNotice] = useState<Notice>({
    tone: 'info',
    text: '正在读取本地设置…'
  });

  useEffect(() => {
    let active = true;
    void api.getSettingsDashboard().then(value => {
      if (!active) return;
      setDashboard(value);
      setNotice(null);
    }).catch(() => {
      if (active) setNotice({ tone: 'error', text: '无法读取设置，请重新打开窗口。' });
    });
    return () => { active = false; };
  }, [api]);

  const run = async (
    operation: () => Promise<
      SettingsDashboardDto
      | { dashboard?: SettingsDashboardDto; notice?: Exclude<Notice, null> }
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
        setNotice({ tone: 'success', text: success });
      } else {
        if (result?.dashboard) setDashboard(result.dashboard);
        setNotice(result?.notice ?? { tone: 'success', text: success });
      }
    } catch {
      setNotice({ tone: 'error', text: '操作未完成，请检查输入后重试。' });
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
      mcpActions={{
        launchSummary,
        onCancelLaunch: () => {
          setLaunchSummary(null);
          setNotice({ tone: 'info', text: '已取消启动 MCP 服务。' });
        },
        onUpsert: input => void run(async () => {
          const result = await api.upsertMcpServer(input);
          if (result.kind === 'confirmation_required') {
            setLaunchSummary({ serverId: input.id, ...result.summary });
            return {
              notice: {
                tone: 'info' as const,
                text: '请核对启动摘要；确认前服务不会启动。'
              }
            };
          }
          setLaunchSummary(null);
          return result.dashboard;
        }, 'MCP 配置已保存。'),
        onConfirmLaunch: (serverId, fingerprint) => void run(async () => {
          const result = await api.confirmMcpLaunch(serverId, fingerprint);
          setLaunchSummary(null);
          return result;
        }, '启动边界已确认。'),
        onTest: serverId => void run(async () => {
          const result = await api.testMcpServer(serverId);
          return {
            dashboard: await api.getSettingsDashboard(),
            notice: { tone: result.ok ? 'success' : 'error', text: result.message }
          };
        }, 'MCP 连接测试完成。'),
        onToggleServer: (serverId, enabled) => void run(
          () => api.setMcpServerEnabled(serverId, enabled),
          '服务状态已更新。'
        ),
        onToggleTool: (serverId, toolName, enabled) => void run(
          () => api.setMcpToolEnabled(serverId, toolName, enabled),
          '工具状态已更新。'
        ),
        onAuthorizeReadOnly: (serverId, toolName) => void run(
          () => api.authorizeMcpToolReadOnly(serverId, toolName),
          '本地只读授权已保存，工具已启用。'
        ),
        onRevokeReadOnly: (serverId, toolName) => void run(
          () => api.revokeMcpToolReadOnly(serverId, toolName),
          '本地只读授权已撤销，工具已禁用。'
        ),
        onDelete: serverId => void run(
          () => api.deleteMcpServer(serverId),
          'MCP 服务已删除。'
        )
      }}
      privacyActions={{
        incognito,
        onSave: input => void run(() => api.savePrivacySettings(input), '隐私设置已保存。'),
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
    />
  );
}
