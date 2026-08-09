// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { HabitatDashboardDto } from '../src/shared/habitat-ipc';
import type { MyselfApi, SettingsDashboardDto } from '../src/shared/myself-api';
import {
  HabitatSettings,
  habitatErrorMessage
} from '../src/renderer/src/settings/HabitatSettings';
import {
  availableSettingsTabs,
  SettingsView
} from '../src/renderer/src/settings/SettingsView';

const desktopDashboard: HabitatDashboardDto = {
  enabled: true,
  autoHideEnabled: false,
  idleDelayMs: 30_000,
  directories: [{
    id: 'directory-1',
    displayName: '项目空间',
    pathHint: 'project',
    enabled: true,
    availability: 'available'
  }],
  current: { kind: 'desktop' },
  busyReason: null,
  errorCode: null
};

const settingsDashboard: SettingsDashboardDto = {
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

afterEach(cleanup);

describe('HabitatSettings', () => {
  test('加载态使用可感知状态提示且不提前开放操作', () => {
    render(
      <HabitatSettings
        dashboard={null}
        loading
        busy={false}
        busyLabel={null}
        onAdd={vi.fn()}
        onToggleDirectory={vi.fn()}
        onRemove={vi.fn()}
        onSavePreferences={vi.fn()}
        onEnter={vi.fn()}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    expect(screen.getByRole('status').textContent).toContain('正在读取空间设置');
    expect(screen.queryByRole('button', { name: '添加目录' })).toBeNull();
  });

  test('加载结束但没有 Dashboard 时显示明确错误而不是继续显示加载态', () => {
    render(
      <HabitatSettings
        dashboard={null}
        loading={false}
        busy={false}
        busyLabel={null}
        onAdd={vi.fn()}
        onToggleDirectory={vi.fn()}
        onRemove={vi.fn()}
        onSavePreferences={vi.fn()}
        onEnter={vi.fn()}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    expect(screen.getByRole('alert').textContent).toContain('无法读取空间设置');
    expect(screen.queryByText(/正在读取空间设置/u)).toBeNull();
  });

  test('显示可见标签、当前状态、公开目录提示和不删除磁盘目录说明', () => {
    render(
      <HabitatSettings
        dashboard={desktopDashboard}
        loading={false}
        busy={false}
        busyLabel={null}
        onAdd={vi.fn()}
        onToggleDirectory={vi.fn()}
        onRemove={vi.fn()}
        onSavePreferences={vi.fn()}
        onEnter={vi.fn()}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    expect(screen.getByRole('region', { name: '目录空间' })).toBeTruthy();
    expect((screen.getByLabelText('启用目录空间') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('自动藏身') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('空闲延迟（秒）') as HTMLInputElement).value).toBe('30');
    expect(screen.getByText('当前在桌面')).toBeTruthy();
    expect(screen.getByText('项目空间')).toBeTruthy();
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getByText('可用')).toBeTruthy();
    expect(screen.getByText(/只删除这条配置，不会删除磁盘目录/u)).toBeTruthy();
  });

  test('偏好与目录操作始终使用不透明目录标识', () => {
    const onSavePreferences = vi.fn();
    const onToggleDirectory = vi.fn();
    const onRemove = vi.fn();
    const onEnter = vi.fn();
    render(
      <HabitatSettings
        dashboard={desktopDashboard}
        loading={false}
        busy={false}
        busyLabel={null}
        onAdd={vi.fn()}
        onToggleDirectory={onToggleDirectory}
        onRemove={onRemove}
        onSavePreferences={onSavePreferences}
        onEnter={onEnter}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText('自动藏身'));
    fireEvent.change(screen.getByLabelText('空闲延迟（秒）'), {
      target: { value: '45' }
    });
    fireEvent.click(screen.getByRole('button', { name: '保存空间偏好' }));
    expect(onSavePreferences).toHaveBeenCalledWith({
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 45_000
    });

    fireEvent.click(screen.getByLabelText('启用目录：项目空间'));
    fireEvent.click(screen.getByRole('button', { name: '立即藏到项目空间' }));
    fireEvent.click(screen.getByRole('button', { name: '删除项目空间配置' }));
    expect(onToggleDirectory).toHaveBeenCalledWith('directory-1', false);
    expect(onEnter).toHaveBeenCalledWith('directory-1');
    expect(onRemove).toHaveBeenCalledWith('directory-1');
  });

  test('关闭、失联、当前目录和忙碌状态提供明确 disabled 与原因', () => {
    const unavailable: HabitatDashboardDto = {
      ...desktopDashboard,
      enabled: false,
      directories: [{
        ...desktopDashboard.directories[0]!,
        availability: 'unavailable'
      }],
      busyReason: 'checking-availability'
    };
    render(
      <HabitatSettings
        dashboard={unavailable}
        loading={false}
        busy
        busyLabel="正在检查目录可用性…"
        onAdd={vi.fn()}
        onToggleDirectory={vi.fn()}
        onRemove={vi.fn()}
        onSavePreferences={vi.fn()}
        onEnter={vi.fn()}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    expect(screen.getByRole('status').textContent).toContain('正在检查目录可用性');
    expect((screen.getByRole('button', { name: '添加目录' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', {
      name: '立即藏到项目空间'
    }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '呼唤桌宠' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '召回桌面' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText('失联')).toBeTruthy();
  });

  test('Dashboard 稳定错误和 Electron 包装错误都显示具体中文原因', () => {
    expect(habitatErrorMessage(Object.assign(
      new Error('Error invoking remote method: HABITAT_ENTRY_BLOCKED'),
      { code: 'ERR_FAILED' }
    ))).toContain('当前任务或交互尚未结束');

    render(
      <HabitatSettings
        dashboard={{
          ...desktopDashboard,
          errorCode: 'HABITAT_DIRECTORY_UNAVAILABLE'
        }}
        loading={false}
        busy={false}
        busyLabel={null}
        onAdd={vi.fn()}
        onToggleDirectory={vi.fn()}
        onRemove={vi.fn()}
        onSavePreferences={vi.fn()}
        onEnter={vi.fn()}
        onSummon={vi.fn()}
        onRecall={vi.fn()}
      />
    );

    expect(screen.getByRole('alert').textContent).toContain('目录当前不可用');
  });
});

describe('SettingsView 空间入口与反馈', () => {
  test('空间是独立 tab，保存成功和阻塞错误都使用可感知反馈', async () => {
    const saveHabitatPreferences = vi.fn(async () => desktopDashboard);
    const enterHabitatDirectory = vi.fn(async () => {
      throw Object.assign(new Error('HABITAT_ENTRY_BLOCKED'), {
        code: 'HABITAT_ENTRY_BLOCKED'
      });
    });
    const api = {
      getSettingsDashboard: vi.fn(async () => settingsDashboard),
      getHabitatDashboard: vi.fn(async () => desktopDashboard),
      saveHabitatPreferences,
      enterHabitatDirectory,
      chooseAndAddHabitatDirectory: vi.fn(),
      setHabitatDirectoryEnabled: vi.fn(),
      removeHabitatDirectory: vi.fn(),
      summonHabitat: vi.fn(),
      recallHabitat: vi.fn()
    } as unknown as MyselfApi;
    render(<SettingsView api={api} />);

    expect(availableSettingsTabs()).toContain('habitat');
    fireEvent.click(await screen.findByRole('button', { name: '空间' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存空间偏好' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('空间偏好已保存');
    });

    fireEvent.click(screen.getByRole('button', { name: '立即藏到项目空间' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('当前任务或交互尚未结束');
    });
  });
});
