import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  chatWindowOptions,
  bindPetWindowInteractionLifecycle,
  petWindowOptions,
  setPetWindowPosition,
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
  it('连续定位不回灌系统膨胀宽高，每次只提交一次固定尺寸', () => {
    const submissions: Array<{ x: number; y: number; width: number; height: number }> = [];
    const window = {
      getBounds: () => { throw new Error('移动不能回读尺寸'); },
      setBounds: (bounds: typeof submissions[number]) => submissions.push(bounds)
    };
    for (let step = 0; step < 80; step++) {
      // 模拟传入 OS 实际 bounds；即使带有增长宽高，定位也只能消费坐标。
      const position = { x: step, y: -step, width: 181 + step, height: 221 + step };
      setPetWindowPosition(window, position);
    }
    expect(submissions).toHaveLength(80);
    expect(submissions.every(bounds => bounds.width === 180 && bounds.height === 220)).toBe(true);
    expect(submissions.at(-1)).toEqual({ x: 79, y: -79, width: 180, height: 220 });
  });

  it('创建透明、普通层级且不进入任务栏的固定尺寸桌宠窗口', () => {
    expect(petWindowOptions('preload.js')).toMatchObject({
      width: 180,
      height: 220,
      minWidth: 180,
      maxWidth: 180,
      minHeight: 220,
      maxHeight: 220,
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
      width: 712,
      height: 46,
      transparent: true,
      frame: false,
      thickFrame: false,
      alwaysOnTop: true,
      resizable: false,
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
  ] as const)('webContents %s 时失败开放，仍允许后续 Renderer', event => {
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

    expect(controller.endDrag).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('气泡固定只展示preload参数，历史不再创建独立背板窗口', () => {
    expect(windowManager.bubbleWindowOptions).toBeTypeOf('function');
    expect(windowManager).not.toHaveProperty('historyBackdropWindowOptions');
    expect(windowManager).not.toHaveProperty('createHistoryBackdropWindow');
    expect(windowManager.bubbleWindowOptions('preload.js').webPreferences).toMatchObject({
      ...secureWebPreferences('preload.js'), additionalArguments: ['--myself-chat-bubble']
    });
  });
});

describe('preload 白名单', () => {
  it('只暴露固定 myself API，不暴露 ipcRenderer 或通用 invoke', async () => {
    const source = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("contextBridge.exposeInMainWorld('myself', isChatBubble ? { chatPresentation: api.chatPresentation } : api)");
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

  it('Main 用动态当前 chat getter 注册 Coordinator 入口', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main).toContain(
      'registerAgentIpc(ipcMain, conversationIpcService, getCurrentChatWebContents)'
    );
  });

  it('同一chat页面reload也撤销展示代次；辅助窗在下一次创建前已登记启动清理', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const loading = main.slice(main.indexOf('const loading = (): void =>'), main.indexOf("window.on('closed', failed)"));
    expect(loading).toContain("if (surface === 'island') { presentationBridge.clear(); presentation.clear(); }");
    const bubbleCreation = main.indexOf('let bubble = createBubbleWindow(');
    const presentationCreation = main.indexOf('let presentation!: ChatPresentationWindowController');
    expect(main.slice(bubbleCreation, presentationCreation)).toContain('startupCleanup.add(');
    expect(main).not.toContain('createHistoryBackdropWindow');
    expect(main).not.toContain("setBackgroundMaterial('acrylic')");
  });

  it('Main 由会话投影器独占 taskEvent 窗口投递', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main).toContain(
      'const conversationEventProjection = new ConversationEventProjection({'
    );
    // 持久化先接纳已验证事件；所有 taskEvent 窗口投递仍只由投影器完成。
    const validated = main.indexOf('const validated = taskEventSchema.parse(event);');
    const persisted = main.indexOf('conversationSession.observe(validated);');
    const projected = main.indexOf('conversationEventProjection.publish(validated);');
    expect(validated).toBeGreaterThanOrEqual(0);
    expect(persisted).toBeGreaterThan(validated);
    expect(projected).toBeGreaterThan(persisted);
    expect(main).toContain('behavior: characterBehaviorDirector');
    expect(main).not.toContain('characterBehavior.handleTaskEvent(event)');
    expect(main).not.toContain(
      'for (const window of [pet, chat, settings, characterWorkshopWindows.getCurrent()])'
    );
    expect(main).not.toContain('ipcChannels.taskEvent');
  });

  it('在 pet 生命周期内唯一创建交互控制器且菜单不扩大 Renderer 命中', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main.match(/new PetWindowInteractionController\(/gu)).toHaveLength(1);
    expect(main).toMatch(
      /bindPetWindowInteractionLifecycle\(\s*pet,\s*petWindowInteraction\s*\)/u
    );
    expect(main).toContain('registerPetWindowInteractionIpc(');
    expect(main).toContain("pet.webContents.on('context-menu', openPetContextMenu)");
  });
});
