import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react';
import {
  FlaskConical,
  Plus,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2
} from 'lucide-react';
import type {
  McpLaunchSummaryDto,
  McpServerDto,
  McpServerInput
} from '../../../shared/myself-api';

export interface McpLaunchConfirmation extends McpLaunchSummaryDto {
  serverId: string;
}

export interface McpSettingsProps {
  servers: McpServerDto[];
  busy: boolean;
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
}

function statusText(status: McpServerDto['status']): string {
  return {
    connected: '已连接',
    disconnected: '未连接',
    error: '连接失败'
  }[status];
}

export function McpSettings(props: McpSettingsProps) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [serverId, setServerId] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [url, setUrl] = useState('');
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [pendingReadAuthorization, setPendingReadAuthorization] = useState<{
    serverId: string;
    toolName: string;
  } | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (props.launchSummary) cancelButtonRef.current?.focus();
  }, [props.launchSummary]);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onCancelLaunch();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const secret = secretName && secretValue ? { [secretName]: secretValue } : undefined;
    props.onUpsert({
      id: serverId,
      enabled: true,
      transport: transport === 'stdio'
        ? {
            type: 'stdio',
            command,
            ...(args.trim() ? { args: args.trim().split(/\s+/u) } : {}),
            ...(cwd ? { cwd } : {}),
            ...(secret ? { env: secret } : {})
          }
        : {
            type: 'http',
            url,
            ...(secret ? { headers: secret } : {})
          }
    });
    setSecretValue('');
  };

  return (
    <div className="settings-pane mcp-settings">
      <section className="settings-band" aria-labelledby="mcp-list-heading">
        <div className="pane-heading">
          <div><h2 id="mcp-list-heading">MCP 服务</h2><p>服务与工具可独立启停。</p></div>
        </div>
        {props.servers.length === 0
          ? <p className="empty-state">尚未添加 MCP 服务。</p>
          : <div className="mcp-list">{props.servers.map(server => (
            <article className="mcp-server" key={server.id}>
              <header>
                <div className="server-title">
                  <Server size={17} />
                  <div><strong>{server.id}</strong><span>{server.transport.summary}</span></div>
                </div>
                <span className={`status-label status-${server.status}`}>
                  {statusText(server.status)}
                </span>
              </header>
              <div className="server-actions">
                <label className="compact-toggle">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    disabled={props.busy}
                    onChange={event => props.onToggleServer(server.id, event.target.checked)}
                  />
                  启用服务
                </label>
                <button
                  type="button"
                  title="测试连接"
                  aria-label={`测试 ${server.id} 连接`}
                  disabled={props.busy || !server.enabled}
                  onClick={() => props.onTest(server.id)}
                >
                  <FlaskConical size={17} />
                </button>
                <button
                  type="button"
                  title="删除服务"
                  aria-label={`删除 ${server.id}`}
                  disabled={props.busy}
                  onClick={() => props.onDelete(server.id)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
              <div className="tool-list">
                {server.tools.map(tool => (
                  <div className="tool-row" key={tool.name}>
                    <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
                    <span className="tool-trust-actions">
                      {tool.readOnly ? (
                        <button
                          type="button"
                          title="撤销本地只读授权"
                          aria-label={`撤销 ${tool.name} 只读授权`}
                          disabled={props.busy}
                          onClick={() => props.onRevokeReadOnly(server.id, tool.name)}
                        >
                          <ShieldOff size={16} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="授权为只读工具"
                          aria-label={`授权 ${tool.name} 为只读`}
                          disabled={props.busy}
                          onClick={() => setPendingReadAuthorization({
                            serverId: server.id,
                            toolName: tool.name
                          })}
                        >
                          <ShieldCheck size={16} />
                        </button>
                      )}
                      <input
                        aria-label={`${tool.name} 工具开关`}
                        type="checkbox"
                        checked={tool.enabled}
                        disabled={props.busy}
                        onChange={event => {
                          if (!tool.readOnly) {
                            setPendingReadAuthorization({
                              serverId: server.id,
                              toolName: tool.name
                            });
                            return;
                          }
                          props.onToggleTool(server.id, tool.name, event.target.checked);
                        }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            </article>
          ))}</div>}
        <p className="safety-inline">
          <ShieldAlert size={16} />
          MCP 工具默认禁用；只有经本机逐工具确认的只读工具才可启用。
        </p>
      </section>

      <section className="settings-band" aria-labelledby="mcp-add-heading">
        <div className="pane-heading">
          <div><h2 id="mcp-add-heading">添加服务</h2><p>HTTP 仅允许 HTTPS 或本机回环地址。</p></div>
        </div>
        <div className="segmented-control" aria-label="MCP 传输方式">
          <button type="button" aria-pressed={transport === 'stdio'} onClick={() => setTransport('stdio')}>stdio</button>
          <button type="button" aria-pressed={transport === 'http'} onClick={() => setTransport('http')}>HTTP</button>
        </div>
        <form className="mcp-form form-grid" onSubmit={submit}>
          <label>
            服务 ID
            <input required value={serverId} onChange={event => setServerId(event.target.value)} />
          </label>
          {transport === 'stdio' ? <>
            <label>
              程序绝对路径
              <input required value={command} onChange={event => setCommand(event.target.value)} />
            </label>
            <label>
              参数
              <input value={args} onChange={event => setArgs(event.target.value)} />
            </label>
            <label>
              工作目录
              <input value={cwd} onChange={event => setCwd(event.target.value)} />
            </label>
          </> : <label className="wide-field">
            HTTP URL
            <input type="url" required value={url} onChange={event => setUrl(event.target.value)} />
          </label>}
          <label>
            {transport === 'stdio' ? '环境变量名' : '认证 Header 名'}
            <input value={secretName} onChange={event => setSecretName(event.target.value)} />
          </label>
          <label>
            认证值
            <input
              type="password"
              autoComplete="new-password"
              value={secretValue}
              onChange={event => setSecretValue(event.target.value)}
            />
          </label>
          <button className="primary-button wide-field" type="submit" disabled={props.busy}>
            <Plus size={16} />添加服务
          </button>
        </form>
      </section>

      {props.launchSummary ? (
        <section
          ref={dialogRef}
          className="launch-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="launch-heading"
          aria-describedby="launch-description"
          onKeyDown={handleDialogKeyDown}
        >
          <div className="pane-heading">
            <div>
              <h2 id="launch-heading">确认启动本地服务</h2>
              <p id="launch-description">请核对实际启动边界。</p>
            </div>
          </div>
          <dl>
            <div><dt>程序</dt><dd>{props.launchSummary.command}</dd></div>
            <div><dt>参数</dt><dd>{props.launchSummary.args.join(' ') || '无'}</dd></div>
            <div><dt>目录</dt><dd>{props.launchSummary.cwd}</dd></div>
            <div><dt>显式环境变量</dt><dd>{props.launchSummary.explicitEnvNames.join(', ') || '无'}</dd></div>
            <div><dt>继承环境变量</dt><dd>{props.launchSummary.inheritedEnvNames.join(', ') || '无'}</dd></div>
          </dl>
          <div className="dialog-actions">
            <button
              ref={cancelButtonRef}
              type="button"
              disabled={props.busy}
              onClick={props.onCancelLaunch}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={props.busy}
              onClick={() => props.onConfirmLaunch(
                props.launchSummary!.serverId,
                props.launchSummary!.fingerprint
              )}
            >
              确认并保存
            </button>
          </div>
        </section>
      ) : null}

      {pendingReadAuthorization ? (
        <section
          className="launch-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="read-authorization-heading"
          aria-describedby="read-authorization-description"
        >
          <div className="pane-heading">
            <div>
              <h2 id="read-authorization-heading">确认本地只读授权</h2>
              <p id="read-authorization-description">
                MCP 的自报信息不可信。请仅在你确认该工具不会创建、修改或删除数据时授权。
              </p>
            </div>
          </div>
          <p className="field-help">
            工具：{pendingReadAuthorization.serverId} / {pendingReadAuthorization.toolName}
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              disabled={props.busy}
              onClick={() => setPendingReadAuthorization(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={props.busy}
              onClick={() => {
                props.onAuthorizeReadOnly(
                  pendingReadAuthorization.serverId,
                  pendingReadAuthorization.toolName
                );
                setPendingReadAuthorization(null);
              }}
            >
              我确认该工具仅执行只读操作
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
