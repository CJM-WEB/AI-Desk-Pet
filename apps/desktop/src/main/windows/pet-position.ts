import type { Rectangle } from 'electron';
import {
  clampPositionToVisibleWorkArea,
  defaultPetPosition,
  type Point,
  type WindowSize
} from './window-manager';

interface MoveAwareWindow {
  on(event: 'move', listener: () => void): unknown;
  getPosition(): number[];
}

interface PetPositionControllerOptions {
  window: MoveAwareWindow;
  savePosition: (position: Point) => Promise<void>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

interface QuitEvent {
  preventDefault(): void;
}

interface QuitAfterPositionFlushOptions {
  flush: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
}

export interface PetPositionController {
  flush(): Promise<void>;
  freezeAndFlush(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function restorePetPosition(
  savedPosition: Point | null,
  windowSize: WindowSize,
  workAreas: readonly Rectangle[]
): Point {
  const primaryWorkArea = workAreas[0];
  if (!savedPosition) {
    return primaryWorkArea ? defaultPetPosition(primaryWorkArea) : { x: 0, y: 0 };
  }
  return clampPositionToVisibleWorkArea(savedPosition, windowSize, workAreas);
}

/** 桌宠位置只写入桌面坐标，并在退出冻结后排空最后一次移动。 */
export function createPetPositionController(
  options: PetPositionControllerOptions
): PetPositionController {
  let pendingPosition: Point | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writeQueue = Promise.resolve();
  let frozen = false;

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* 日志失败不得影响退出。 */ }
  };
  const persistPending = async (): Promise<void> => {
    const pending = pendingPosition;
    pendingPosition = null;
    if (pending) {
      writeQueue = writeQueue.then(async () => {
        try { await options.savePosition(pending); } catch (error) { reportError(error); }
      });
    }
    await writeQueue;
  };
  const flushAll = async (): Promise<void> => {
    while (true) {
      if (timer) clearTimeout(timer);
      timer = null;
      await persistPending();
      const observedQueue = writeQueue;
      await observedQueue;
      if (pendingPosition === null && timer === null && observedQueue === writeQueue) return;
    }
  };

  options.window.on('move', () => {
    if (frozen) return;
    const [x = 0, y = 0] = options.window.getPosition();
    pendingPosition = { x, y };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persistPending();
    }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  });

  return {
    flush: flushAll,
    async freezeAndFlush(): Promise<void> {
      frozen = true;
      await flushAll();
    }
  };
}

export function createQuitAfterPositionFlush(
  options: QuitAfterPositionFlushOptions
): (event: QuitEvent) => Promise<void> {
  let exitReady = false;
  let activeFlush: Promise<void> | null = null;
  return async event => {
    if (exitReady) return;
    event.preventDefault();
    activeFlush ??= (async () => {
      try {
        await options.flush();
      } catch (error) {
        try { options.onError?.(error); } catch { /* 日志失败也必须继续退出。 */ }
      }
      exitReady = true;
      options.quit();
    })();
    await activeFlush;
  };
}
