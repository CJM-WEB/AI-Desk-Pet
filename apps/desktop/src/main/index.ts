import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  Tray,
  type Rectangle
} from 'electron';
import { registerSettingsIpc, registerWindowIpc } from './ipc/register-ipc';
import { SecretStore } from './storage/secret-store';
import { SettingsStore } from './storage/settings-store';
import {
  createChatWindow,
  createPetWindow,
  createSettingsWindow,
  defaultPetPosition
} from './windows/window-manager';

let tray: Tray | null = null;
let isQuitting = false;

function rendererUrl(view: 'pet' | 'chat' | 'settings'): string | null {
  const developmentUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!developmentUrl) return null;
  const url = new URL(developmentUrl);
  url.searchParams.set('view', view);
  return url.toString();
}

async function loadRenderer(
  window: BrowserWindow,
  view: 'pet' | 'chat' | 'settings'
): Promise<void> {
  const url = rendererUrl(view);
  if (url) {
    await window.loadURL(url);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } });
}

function createTrayImage() {
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8ZkAAAAASUVORK5CYII='
  );
  return image.resize({ width: 16, height: 16 });
}

function positionChatNearPet(pet: BrowserWindow, chat: BrowserWindow): void {
  const petBounds = pet.getBounds();
  const chatBounds = chat.getBounds();
  const display = screen.getDisplayNearestPoint({ x: petBounds.x, y: petBounds.y });
  const workArea = display.workArea;
  const gap = 8;
  const left = petBounds.x - chatBounds.width - gap;
  const right = petBounds.x + petBounds.width + gap;
  const x = left >= workArea.x ? left : Math.min(right, workArea.x + workArea.width - chatBounds.width);
  const y = Math.min(
    Math.max(petBounds.y, workArea.y),
    workArea.y + workArea.height - chatBounds.height
  );
  chat.setPosition(x, y);
}

async function createApplicationWindows(): Promise<void> {
  Menu.setApplicationMenu(null);
  const preload = join(__dirname, '../preload/index.cjs');
  const pet = createPetWindow(BrowserWindow, preload);
  let chat = createChatWindow(BrowserWindow, preload);
  let settings = createSettingsWindow(BrowserWindow, preload);

  const primaryWorkArea: Rectangle = screen.getPrimaryDisplay().workArea;
  const petPosition = defaultPetPosition(primaryWorkArea);
  pet.setPosition(petPosition.x, petPosition.y);

  const hideOnClose = (window: BrowserWindow): void => {
    window.on('close', event => {
      if (isQuitting) return;
      event.preventDefault();
      window.hide();
    });
  };
  hideOnClose(chat);
  hideOnClose(settings);

  const ensureChatWindow = async (): Promise<BrowserWindow> => {
    if (!chat.isDestroyed()) return chat;
    chat = createChatWindow(BrowserWindow, preload);
    hideOnClose(chat);
    await loadRenderer(chat, 'chat');
    return chat;
  };
  const ensureSettingsWindow = async (): Promise<BrowserWindow> => {
    if (!settings.isDestroyed()) return settings;
    settings = createSettingsWindow(BrowserWindow, preload);
    hideOnClose(settings);
    await loadRenderer(settings, 'settings');
    return settings;
  };

  const showChat = async (): Promise<void> => {
    const chatWindow = await ensureChatWindow();
    positionChatNearPet(pet, chatWindow);
    chatWindow.show();
    chatWindow.focus();
  };
  const showSettings = async (): Promise<void> => {
    const settingsWindow = await ensureSettingsWindow();
    settingsWindow.show();
    settingsWindow.focus();
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开聊天', click: () => void showChat() },
    { label: '设置', click: () => void showSettings() },
    {
      label: '显示/隐藏桌宠',
      click: () => pet.isVisible() ? pet.hide() : pet.show()
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);

  tray = new Tray(createTrayImage());
  tray.setToolTip('Myself AI 桌宠');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => void showChat());
  pet.webContents.on('context-menu', () => tray?.popUpContextMenu(contextMenu));

  registerWindowIpc(ipcMain, app.getVersion(), {
    openChat: showChat,
    openSettings: showSettings,
    hideChat: () => {
      if (!chat.isDestroyed()) chat.hide();
    },
    quit: () => app.quit()
  });

  const storageDirectory = app.getPath('userData');
  const secrets = new SecretStore(join(storageDirectory, 'provider-secret.bin'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptStringAsync(value),
    decryptString: async value => (await safeStorage.decryptStringAsync(value)).result
  });
  const settingsStore = new SettingsStore(
    join(storageDirectory, 'settings.json'),
    () => secrets.hasStoredSecret()
  );
  registerSettingsIpc(ipcMain, settingsStore, secrets);

  await Promise.all([
    loadRenderer(pet, 'pet'),
    loadRenderer(chat, 'chat'),
    loadRenderer(settings, 'settings')
  ]);
  pet.show();
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  await createApplicationWindows();
});
