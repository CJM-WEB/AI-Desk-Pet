import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  chatWindowOptions,
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
  it('创建透明、置顶且不进入任务栏的固定尺寸桌宠窗口', () => {
    expect(petWindowOptions('preload.js')).toMatchObject({
      width: 180,
      height: 220,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false
    });
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

  it('在 Main 注册 Agent IPC 并只通过固定任务事件通道推送状态', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(main).toContain('registerAgentIpc(ipcMain, agentService)');
    expect(main).toContain('webContents.send(ipcChannels.taskEvent, event)');
  });
});
