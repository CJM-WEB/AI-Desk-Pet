import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
  WebPreferences
} from 'electron';

const PET_WIDTH = 180;
const PET_HEIGHT = 220;

export type Point = { x: number; y: number };
export type WindowSize = { width: number; height: number };
export type VisualAnchorConstraintInput = Readonly<{
  anchorDip: Point;
  visualBoundsFromAnchorDip: Rectangle;
  workAreaDip: Rectangle;
  edgeMarginDip?: number;
}>;
export type VisualWindowConstraintInput = Readonly<{
  windowPositionDip: Point;
  visualBoundsInWindowDip: Rectangle;
  workAreaDip: Rectangle;
}>;
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

export function petWindowOptions(
  preload: string,
  options: { enableE2eProbe?: boolean } = {}
): BrowserWindowConstructorOptions {
  return {
    width: PET_WIDTH,
    height: PET_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      ...secureWebPreferences(preload),
      ...(options.enableE2eProbe
        ? { additionalArguments: ['--myself-e2e-probe'] }
        : {})
    }
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
  preload: string,
  options: { enableE2eProbe?: boolean } = {}
): BrowserWindow {
  const window = new BrowserWindowClass(petWindowOptions(preload, options));
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

type PetWindowInteractionLifecycleWindow = {
  webContents: {
    on(name: PetWebContentsTransientEvent, listener: () => void): void;
    once(name: 'destroyed', listener: () => void): void;
    removeListener(
      name: PetWebContentsLifecycleEvent,
      listener: () => void
    ): void;
  };
  once(name: 'closed', listener: () => void): void;
  removeListener(name: 'closed', listener: () => void): void;
};

type PetWebContentsLifecycleEvent =
  | PetWebContentsTransientEvent
  | 'destroyed';

type PetWebContentsTransientEvent =
  | 'render-process-gone'
  | 'will-navigate';

type PetWindowInteractionLifecycleController = {
  setPassthrough(ignore: boolean): void;
  dispose(): void;
};

/** 将控制器严格绑定到单个桌宠窗口生命周期，并提供幂等主动清理。 */
export function bindPetWindowInteractionLifecycle(
  window: PetWindowInteractionLifecycleWindow,
  controller: PetWindowInteractionLifecycleController
): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    window.removeListener('closed', release);
    for (const event of webContentsLifecycleEvents) {
      window.webContents.removeListener(
        event,
        event === 'destroyed' ? release : failOpen
      );
    }
    controller.dispose();
  };
  const failOpen = (): void => {
    if (released) return;
    controller.setPassthrough(true);
  };
  controller.setPassthrough(true);
  window.once('closed', release);
  for (const event of webContentsTransientEvents) {
    window.webContents.on(event, failOpen);
  }
  window.webContents.once('destroyed', release);
  return release;
}

const webContentsLifecycleEvents: readonly PetWebContentsLifecycleEvent[] = [
  'render-process-gone',
  'destroyed',
  'will-navigate'
];

const webContentsTransientEvents: readonly PetWebContentsTransientEvent[] = [
  'render-process-gone',
  'will-navigate'
];

type AxisRange = Readonly<{ minimum: number; maximum: number }>;

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validRectangle(rectangle: Rectangle): boolean {
  return Number.isFinite(rectangle.x)
    && Number.isFinite(rectangle.y)
    && Number.isFinite(rectangle.width)
    && Number.isFinite(rectangle.height)
    && rectangle.width > 0
    && rectangle.height > 0
    && Number.isFinite(rectangle.x + rectangle.width)
    && Number.isFinite(rectangle.y + rectangle.height);
}

/**
 * 所有桌宠边界入口共享同一组可见矩形允许区间；窗口透明 padding 不参与约束。
 */
function visualAnchorRanges(
  visualBoundsFromAnchorDip: Rectangle,
  workAreaDip: Rectangle,
  edgeMarginDip: number
): Readonly<{ x: AxisRange; y: AxisRange }> | null {
  if (!validRectangle(visualBoundsFromAnchorDip)
    || !validRectangle(workAreaDip)
    || !Number.isFinite(edgeMarginDip)
    || edgeMarginDip < 0) return null;
  const workAreaRight = workAreaDip.x + workAreaDip.width;
  const workAreaBottom = workAreaDip.y + workAreaDip.height;
  const visualRight = visualBoundsFromAnchorDip.x + visualBoundsFromAnchorDip.width;
  const visualBottom = visualBoundsFromAnchorDip.y + visualBoundsFromAnchorDip.height;
  const ranges = {
    x: {
      minimum: workAreaDip.x + edgeMarginDip - visualBoundsFromAnchorDip.x,
      maximum: workAreaRight - edgeMarginDip - visualRight
    },
    y: {
      minimum: workAreaDip.y + edgeMarginDip - visualBoundsFromAnchorDip.y,
      maximum: workAreaBottom - edgeMarginDip - visualBottom
    }
  };
  if (![ranges.x.minimum, ranges.x.maximum, ranges.y.minimum, ranges.y.maximum]
    .every(Number.isFinite)) return null;
  return ranges.x.minimum <= ranges.x.maximum && ranges.y.minimum <= ranges.y.maximum
    ? ranges
    : null;
}

/** 以脚底等语义锚点连续投影到最近合法位置，角色动作切换时不会产生额外位移。 */
export function clampAnchorToVisualWorkArea(
  input: VisualAnchorConstraintInput
): Point | null {
  if (!finitePoint(input.anchorDip)) return null;
  const ranges = visualAnchorRanges(
    input.visualBoundsFromAnchorDip,
    input.workAreaDip,
    input.edgeMarginDip ?? 0
  );
  if (!ranges) return null;
  return {
    x: Math.min(ranges.x.maximum, Math.max(ranges.x.minimum, input.anchorDip.x)),
    y: Math.min(ranges.y.maximum, Math.max(ranges.y.minimum, input.anchorDip.y))
  };
}

/**
 * Windows 实际窗口原点为整数；允许区间向内取整，避免小数视觉边界在右下缘溢出。
 */
export function clampIntegerWindowPositionToVisualWorkArea(
  input: VisualWindowConstraintInput
): Point | null {
  if (!finitePoint(input.windowPositionDip)) return null;
  const ranges = visualAnchorRanges(
    input.visualBoundsInWindowDip,
    input.workAreaDip,
    0
  );
  if (!ranges) return null;
  const minimumX = Math.ceil(ranges.x.minimum);
  const maximumX = Math.floor(ranges.x.maximum);
  const minimumY = Math.ceil(ranges.y.minimum);
  const maximumY = Math.floor(ranges.y.maximum);
  if (minimumX > maximumX || minimumY > maximumY) return null;
  const desiredX = Math.round(input.windowPositionDip.x);
  const desiredY = Math.round(input.windowPositionDip.y);
  return {
    x: Math.min(maximumX, Math.max(minimumX, desiredX)),
    y: Math.min(maximumY, Math.max(minimumY, desiredY))
  };
}
