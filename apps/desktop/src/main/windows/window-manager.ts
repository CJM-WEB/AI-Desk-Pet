import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
  WebPreferences
} from 'electron';

const PET_WIDTH = 180;
const PET_HEIGHT = 220;
const EDGE_MARGIN = 16;

export type Point = { x: number; y: number };
export type WindowSize = { width: number; height: number };
export type BrowserWindowConstructor = new (
  options?: BrowserWindowConstructorOptions
) => BrowserWindow;

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true
  };
}

export function petWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: PET_WIDTH,
    height: PET_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: secureWebPreferences(preload)
  };
}

export function chatWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 420,
    height: 520,
    minWidth: 360,
    minHeight: 420,
    frame: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#fffaf2',
    webPreferences: secureWebPreferences(preload)
  };
}

export function settingsWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 720,
    height: 620,
    minWidth: 640,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fffaf2',
    webPreferences: secureWebPreferences(preload)
  };
}

export function characterWorkshopWindowOptions(
  preload: string
): BrowserWindowConstructorOptions {
  return {
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fffaf2',
    webPreferences: secureWebPreferences(preload)
  };
}

export function lockNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export function createPetWindow(
  BrowserWindowClass: BrowserWindowConstructor,
  preload: string
): BrowserWindow {
  const window = new BrowserWindowClass(petWindowOptions(preload));
  lockNavigation(window);
  return window;
}

export function createChatWindow(
  BrowserWindowClass: BrowserWindowConstructor,
  preload: string
): BrowserWindow {
  const window = new BrowserWindowClass(chatWindowOptions(preload));
  lockNavigation(window);
  return window;
}

export function createSettingsWindow(
  BrowserWindowClass: BrowserWindowConstructor,
  preload: string
): BrowserWindow {
  const window = new BrowserWindowClass(settingsWindowOptions(preload));
  lockNavigation(window);
  return window;
}

export function createCharacterWorkshopWindow(
  BrowserWindowClass: BrowserWindowConstructor,
  preload: string
): BrowserWindow {
  const window = new BrowserWindowClass(characterWorkshopWindowOptions(preload));
  lockNavigation(window);
  return window;
}

function isFullyVisible(position: Point, size: WindowSize, workArea: Rectangle): boolean {
  return position.x >= workArea.x
    && position.y >= workArea.y
    && position.x + size.width <= workArea.x + workArea.width
    && position.y + size.height <= workArea.y + workArea.height;
}

export function clampPositionToVisibleWorkArea(
  position: Point,
  size: WindowSize,
  workAreas: readonly Rectangle[]
): Point {
  if (workAreas.some(workArea => isFullyVisible(position, size, workArea))) return position;
  const primary = workAreas[0];
  if (!primary) return { x: 0, y: 0 };
  return {
    x: Math.max(primary.x, primary.x + primary.width - size.width - EDGE_MARGIN),
    y: Math.max(primary.y, primary.y + primary.height - size.height - EDGE_MARGIN)
  };
}

export function defaultPetPosition(workArea: Rectangle): Point {
  return clampPositionToVisibleWorkArea(
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
    { width: PET_WIDTH, height: PET_HEIGHT },
    [workArea]
  );
}
