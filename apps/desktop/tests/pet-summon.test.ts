import { Menu, type MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => ({ items: template })
  }
}));

type DirectoryOpenRequest = {
  directory: Readonly<{ absolutePath: string }>;
  signal: AbortSignal;
};

type WindowCommandsModule = {
  createVerifiedDirectoryOpener(
    openPath: (absolutePath: string) => Promise<string>
  ): (request: DirectoryOpenRequest) => Promise<void>;
  buildApplicationTrayMenu(options: {
    togglePetVisibility(): void;
    openChat(): void;
    openCharacterWorkshop(): void;
    quickSwitchItems: MenuItemConstructorOptions[];
    openSettings(): void;
    quit(): void;
  }): MenuItemConstructorOptions[];
};

async function loadModule(): Promise<WindowCommandsModule | null> {
  try {
    return await import(new URL(
      '../src/main/windows/window-commands.ts',
      import.meta.url
    ).href) as WindowCommandsModule;
  } catch {
    return null;
  }
}

describe('目录打开边界', () => {
  test('Main 内部绝对路径只交给受限 openPath', async () => {
    const module = await loadModule();
    expect(module, '应提供受限目录打开器').not.toBeNull();
    if (!module) return;
    const openPath = vi.fn(async () => '');
    const openDirectory = module.createVerifiedDirectoryOpener(openPath);

    await openDirectory({
      directory: { absolutePath: 'C:\\Private Habitat\\Exact' },
      signal: new AbortController().signal
    });

    expect(openPath).toHaveBeenCalledExactlyOnceWith('C:\\Private Habitat\\Exact');
  });

  test.each([
    ['非空返回', vi.fn(async () => 'The system cannot find the path specified.')],
    ['调用拒绝', vi.fn(async () => { throw new Error('C:\\Private\\Secret'); })]
  ])('openPath %s时只暴露稳定失败码', async (_label, openPath) => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    await expect(module.createVerifiedDirectoryOpener(openPath)({
      directory: { absolutePath: 'C:\\Private\\Exact' },
      signal: new AbortController().signal
    })).rejects.toThrow('HABITAT_SUMMON_FAILED');
  });
});

describe('生产托盘菜单', () => {
  test('恢复普通窗口命令且不再暴露目录空间命令', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const template = module.buildApplicationTrayMenu({
      togglePetVisibility: vi.fn(),
      openChat: vi.fn(),
      openCharacterWorkshop: vi.fn(),
      quickSwitchItems: [],
      openSettings: vi.fn(),
      quit: vi.fn()
    });
    const trayLabels = Menu.buildFromTemplate(template).items
      .map(item => item.label)
      .filter((label): label is string => Boolean(label));

    expect(trayLabels).toEqual([
      '显示/隐藏桌宠',
      '打开聊天',
      '角色工作室',
      '切换角色',
      '设置',
      '退出'
    ]);
    expect(trayLabels).not.toEqual(expect.arrayContaining([
      '藏到目录',
      '呼唤桌宠',
      '召回桌面'
    ]));
    for (const removedLabel of ['藏到目录', '呼唤桌宠', '召回桌面']) {
      expect(trayLabels).not.toContain(removedLabel);
    }
  });
});
