// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SettingsDashboardDto } from '../src/shared/myself-api';
import { SettingsView, SettingsWorkspace } from '../src/renderer/src/settings/SettingsView';

const dashboard: SettingsDashboardDto = {
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
    dataCategories: { file: false, screenshot: false, clipboard: false, memory: false },
    longTermMemory: false,
    proactivityMode: 'assistive'
  },
  privacyRuntimeSupport: {
    dataCategories: { file: true, screenshot: false, clipboard: false, memory: false },
    longTermMemory: false,
    proactivity: false
  },
  petAlwaysOnTop: false,
  authorizedRoot: null
};

function workspace(
  notice: Parameters<typeof SettingsWorkspace>[0]['notice'],
  onDismissNotice = vi.fn()
) {
  return (
    <SettingsWorkspace
      dashboard={dashboard}
      activeTab="models"
      busy={false}
      notice={notice}
      onDismissNotice={onDismissNotice}
      onTabChange={vi.fn()}
      onClose={vi.fn()}
      providerActions={{ onSave: vi.fn(), onTest: vi.fn(), onRouteSave: vi.fn(), onDelete: vi.fn() }}
      privacyActions={{
        incognito: false,
        onSave: vi.fn(),
        onPetAlwaysOnTopChange: vi.fn(),
        onIncognitoChange: vi.fn(),
        onChooseRoot: vi.fn(),
        onRevokeRoot: vi.fn()
      }}
      onClear={vi.fn()}
      onOpenCharacterWorkshop={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('设置页瞬时提示', () => {
  test('陈旧的初始读取不会覆盖后完成操作的 dashboard 或 success 提示', async () => {
    let rejectInitialDashboard: ((reason?: unknown) => void) | undefined;
    const newerDashboard: SettingsDashboardDto = {
      ...dashboard,
      profiles: [{
        id: 'newer-profile',
        displayName: '较新档案',
        mode: 'preset',
        providerId: 'openai',
        modelId: 'newer-model',
        hasStoredSecret: false
      }]
    };
    const api = {
      getSettingsDashboard: vi.fn(() => new Promise<SettingsDashboardDto>((_resolve, reject) => {
        rejectInitialDashboard = reject;
      })),
      saveProviderProfile: vi.fn(async () => newerDashboard)
    };
    render(<SettingsView api={api as never} />);

    fireEvent.click(screen.getByRole('button', { name: '保存档案' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('status').textContent).toContain('模型档案已保存');
    expect(screen.getAllByText('较新档案').length).toBeGreaterThan(0);

    await act(async () => {
      rejectInitialDashboard?.(new Error('陈旧读取失败'));
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toContain('模型档案已保存');
    expect(screen.getAllByText('较新档案').length).toBeGreaterThan(0);
  });

  test.each([
    ['success', 'status'],
    ['info', 'status'],
    ['warning', 'alert'],
    ['error', 'alert']
  ] as const)('%s 提示在三秒前保留且三秒时按 id 关闭', async (tone, role) => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismissNotice = vi.fn();
    render(workspace({ id: `notice-${tone}`, tone, text: `${tone} 消息` }, onDismissNotice));

    expect(screen.getByRole(role).textContent).toContain(`${tone} 消息`);
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismissNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismissNotice).toHaveBeenCalledExactlyOnceWith(`notice-${tone}`);
  });

  test('可手动关闭，hover 与焦点暂停后从剩余时间恢复，且不抢焦点', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismissNotice = vi.fn();
    render(workspace({ id: 'paused', tone: 'info', text: '可暂停提示' }, onDismissNotice));
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: '关闭设置提示：可暂停提示' });

    expect(document.activeElement).not.toBe(close);
    await vi.advanceTimersByTimeAsync(1000);
    fireEvent.mouseEnter(toast);
    fireEvent.focus(close);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDismissNotice).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    fireEvent.blur(close, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(1999);
    expect(onDismissNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismissNotice).toHaveBeenCalledExactlyOnceWith('paused');

    render(workspace({ id: 'manual', tone: 'success', text: '立即关闭' }, onDismissNotice));
    fireEvent.click(screen.getByRole('button', { name: '关闭设置提示：立即关闭' }));
    expect(onDismissNotice).toHaveBeenLastCalledWith('manual');
  });

  test('新提示替换旧提示后，旧 timer 不会关闭新提示', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    const onDismissNotice = vi.fn();
    const view = render(workspace({ id: 'old', tone: 'error', text: '旧提示' }, onDismissNotice));

    await vi.advanceTimersByTimeAsync(2000);
    view.rerender(workspace({ id: 'new', tone: 'success', text: '新提示' }, onDismissNotice));
    await vi.advanceTimersByTimeAsync(2999);
    expect(onDismissNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDismissNotice).toHaveBeenCalledExactlyOnceWith('new');
  });

  test('真实 SettingsView 在读取失败时以 error toast 展示，旧 loading timer 不会移除它', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'performance', 'setTimeout'] });
    let rejectDashboard: ((reason?: unknown) => void) | undefined;
    const api = {
      getSettingsDashboard: vi.fn(() => new Promise<SettingsDashboardDto>((_resolve, reject) => {
        rejectDashboard = reject;
      }))
    };
    render(<SettingsView api={api as never} />);

    expect(screen.getByRole('status').textContent).toContain('正在读取本地设置');
    await act(async () => {
      rejectDashboard?.(new Error('读取失败'));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('无法读取设置');
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(screen.getByRole('alert').textContent).toContain('无法读取设置');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('浮层保留 fixed 视口定位、无正文 notice，并只使用安全动画属性', () => {
    const markup = renderToStaticMarkup(
      workspace({ id: 'structure', tone: 'info', text: '结构提示' })
    );
    const styles = readFileSync(
      resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
      'utf8'
    );

    expect(markup).toContain('transient-toast-layer');
    expect(markup).not.toContain('notice-success');
    expect(markup.indexOf('transient-toast-layer')).toBeLessThan(
      markup.indexOf('settings-pane')
    );
    expect(styles).toMatch(/\.transient-toast-layer\s*\{[^}]*position:\s*fixed[^}]*top:\s*68px[^}]*right:\s*16px[^}]*width:\s*min\(360px,\s*calc\(100vw\s*-\s*32px\)\)/s);
    expect(styles).toMatch(/\.transient-toast\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*animation:\s*transient-toast-enter/s);
    expect(styles).toMatch(/@keyframes transient-toast-enter\s*\{\s*from\s*\{\s*opacity:[^}]*transform:[^}]*\}\s*to\s*\{\s*opacity:[^}]*transform:/s);
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.transient-toast\s*\{\s*animation-duration:\s*1ms/s);
  });
});
