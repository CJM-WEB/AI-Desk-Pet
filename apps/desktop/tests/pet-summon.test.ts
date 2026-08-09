import { Menu, type MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => ({ items: template })
  }
}));

type WindowCommandsModule = {
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
