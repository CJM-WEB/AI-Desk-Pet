import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  chatWindowOptions,
  bindPetWindowInteractionLifecycle,
  clampPositionToVisibleWorkArea,
  petWindowOptions,
  secureWebPreferences,
  settingsWindowOptions
} from '../src/main/windows/window-manager';
import * as windowManager from '../src/main/windows/window-manager';

describe('secureWebPreferences', () => {
  it('禁用 Node 集成并启用上下文隔离和沙盒', () => {
    const preferences = secureWebPreferences('C:\\app\\preload.js');

    expect(preferences).toMatchObject({
      preload: 'C:\\app\\preload.js',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    });
  });
});

describe('窗口安全配置', () => {
  it('创建透明、普通层级且不进入任务栏的固定尺寸桌宠窗口', () => {
    expect(petWindowOptions('preload.js')).toMatchObject({
      width: 180,
      height: 220,
      transparent: true,
      frame: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: false,
      show: false
    });
  });

  it('只在显式 E2E 模式向桌宠 preload 传入固定探针标记', () => {
    expect(petWindowOptions('preload.js').webPreferences?.additionalArguments)
      .toBeUndefined();
    expect(petWindowOptions('preload.js', {
      enableE2eProbe: true
    }).webPreferences?.additionalArguments).toEqual(['--myself-e2e-probe']);
  });

  it('聊天与设置使用互相独立的隐藏窗口', () => {
    expect(chatWindowOptions('preload.js')).toMatchObject({
      width: 420,
      height: 520,
      show: false
    });
    expect(settingsWindowOptions('preload.js')).toMatchObject({
      width: 720,
      height: 620,
      autoHideMenuBar: true,
      show: false
    });
    expect(chatWindowOptions('preload.js').webPreferences).toEqual(
      secureWebPreferences('preload.js')
    );
    expect(settingsWindowOptions('preload.js').webPreferences).toEqual(
      secureWebPreferences('preload.js')
    );
  });

  it('角色工作室使用独立安全窗口', () => {
    const optionsFactory = (
      windowManager as unknown as {
        characterWorkshopWindowOptions?: typeof settingsWindowOptions;
      }
    ).characterWorkshopWindowOptions;
    expect(optionsFactory, '应提供角色工作室窗口配置').toBeTypeOf('function');
    if (!optionsFactory) return;

    expect(optionsFactory('preload.js')).toMatchObject({
      width: 1120,
      height: 760,
      minWidth: 900,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true
    });
    expect(optionsFactory('preload.js').webPreferences).toEqual(
      secureWebPreferences('preload.js')
    );
  });
});

describe('桌宠交互控制器生命周期', () => {
  it('窗口绑定时初始化穿透，关闭时幂等 dispose', () => {
    const listeners = new Map<string, () => void>();
    const webContents = {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn()
    };
    const window = {
      webContents,
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeListener: vi.fn((event: string) => listeners.delete(event))
    };
    const controller = {
      setPassthrough: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };

    const release = bindPetWindowInteractionLifecycle(window, controller);
    expect(controller.setPassthrough).toHaveBeenCalledWith(true);
    listeners.get('closed')?.();
    release();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    'render-process-gone',
    'will-navigate'
  ] as const)('webContents %s 时只结束拖拽并失败开放，仍允许后续 Renderer', event => {
    const windowListeners = new Map<string, () => void>();
    const webContentsListeners = new Map<string, () => void>();
    const webContents = {
      on: vi.fn((name: string, listener: () => void) => {
        webContentsListeners.set(name, listener);
      }),
      once: vi.fn((name: string, listener: () => void) => {
        webContentsListeners.set(name, listener);
      }),
      removeListener: vi.fn((name: string) => {
        webContentsListeners.delete(name);
      })
    };
    const window = {
      webContents,
      once: vi.fn((name: string, listener: () => void) => {
        windowListeners.set(name, listener);
      }),
      removeListener: vi.fn((name: string) => {
        windowListeners.delete(name);
      })
    };
    const controller = {
      setPassthrough: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };

    const release = bindPetWindowInteractionLifecycle(window, controller);
    webContentsListeners.get(event)?.();

    expect(controller.endDrag).toHaveBeenCalledWith('cancelled');
    expect(controller.setPassthrough).toHaveBeenLastCalledWith(true);
    expect(controller.dispose).not.toHaveBeenCalled();

    release();
    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(window.removeListener).toHaveBeenCalledWith(
      'closed',
      expect.any(Function)
    );
    for (const lifecycleEvent of [
      'render-process-gone',
      'destroyed',
      'will-navigate'
    ]) {
      expect(webContents.removeListener).toHaveBeenCalledWith(
        lifecycleEvent,
        expect.any(Function)
      );
    }
  });

  it('webContents destroyed 时最终 dispose，主动释放保持幂等', () => {
    const listeners = new Map<string, () => void>();
    const webContents = {
      on: vi.fn((name: string, listener: () => void) => {
        listeners.set(name, listener);
      }),
      once: vi.fn((name: string, listener: () => void) => {
        listeners.set(name, listener);
      }),
      removeListener: vi.fn()
    };
    const window = {
      webContents,
      once: vi.fn(),
      removeListener: vi.fn()
    };
    const controller = {
      setPassthrough: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };

    const release = bindPetWindowInteractionLifecycle(window, controller);
    listeners.get('destroyed')?.();
    release();

    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(controller.endDrag).not.toHaveBeenCalled();
  });
});

describe('桌宠位置恢复', () => {
  const workAreas = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: -200, width: 1280, height: 1024 }
  ];

  it('保留仍然完全可见的位置', () => {
    expect(clampPositionToVisibleWorkArea(
      { x: 2000, y: 100 },
      { width: 180, height: 220 },
      workAreas
    )).toEqual({ x: 2000, y: 100 });
  });

  it('把不可见位置收敛到主显示器工作区右下角', () => {
    expect(clampPositionToVisibleWorkArea(
      { x: 5000, y: 5000 },
      { width: 180, height: 220 },
      workAreas
    )).toEqual({ x: 1724, y: 804 });
  });
});

describe('preload 白名单', () => {
  it('只暴露固定 myself API，不暴露 ipcRenderer 或通用 invoke', async () => {
    const source = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("contextBridge.exposeInMainWorld('myself', api)");
    expect(source).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer/u);
    expect(source).not.toMatch(/\binvoke\s*:\s*/u);
    expect(source).not.toMatch(/\(channel(?:Name)?\s*:/u);
  });

  it('为沙盒窗口构建并引用 CommonJS preload', async () => {
    const config = await readFile(new URL('../electron.vite.config.ts', import.meta.url), 'utf8');
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(config).toMatch(/format:\s*'cjs'/u);
    expect(main).toContain("'../preload/index.cjs'");
    expect(main).not.toContain("'../preload/index.mjs'");
  });

  it('在 Main 只注册 Coordinator 聊天入口并通过固定任务事件通道推送状态', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main).toContain('createMainConversationComposition({');
    expect(main).toContain('registerAgentIpc(ipcMain, conversationIpcService)');
    expect(main).not.toContain('registerAgentIpc(ipcMain, agentService)');
    expect(main).toContain('webContents.send(ipcChannels.taskEvent, event)');
  });

  it('在 pet 生命周期内唯一创建交互控制器并复用现有菜单弹出回调', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main.match(/new PetWindowInteractionController\(/gu)).toHaveLength(1);
    expect(main).toMatch(
      /bindPetWindowInteractionLifecycle\(\s*pet,\s*petWindowInteraction\s*\)/u
    );
    expect(main).toContain('registerPetWindowInteractionIpc(');
    expect(main).toContain('const openPetContextMenu = () =>');
  });
});
