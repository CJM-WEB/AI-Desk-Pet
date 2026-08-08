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
  getLocalOffset?: () => Point;
  saveLocalOffset?: (offset: Point) => Promise<void>;
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
  setPersistenceMode(mode: PetPositionPersistenceMode): void;
  flush(): Promise<void>;
}

export type PetPositionPersistenceMode = 'desktop' | 'folder' | 'disabled';

type PendingPosition = {
  mode: Exclude<PetPositionPersistenceMode, 'disabled'>;
  point: Point;
};

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

export function createPetPositionController(
  options: PetPositionControllerOptions
): PetPositionController {
  let persistenceMode: PetPositionPersistenceMode = 'desktop';
  let pendingPosition: PendingPosition | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writeQueue = Promise.resolve();

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // 错误记录本身不得影响应用退出或产生未处理拒绝。
    }
  };

  const saveSafely = async (pending: PendingPosition): Promise<void> => {
    try {
      if (pending.mode === 'desktop') {
        await options.savePosition(pending.point);
      } else if (options.saveLocalOffset) {
        await options.saveLocalOffset(pending.point);
      }
    } catch (error) {
      reportError(error);
    }
  };

  const persistPending = async (): Promise<void> => {
    const pending = pendingPosition;
    pendingPosition = null;
    if (pending) writeQueue = writeQueue.then(() => saveSafely(pending));
    await writeQueue;
  };

  options.window.on('move', () => {
    if (persistenceMode === 'disabled') return;
    let point: Point;
    try {
      if (persistenceMode === 'folder') {
        if (!options.getLocalOffset) return;
        point = options.getLocalOffset();
      } else {
        const [x = 0, y = 0] = options.window.getPosition();
        point = { x, y };
      }
    } catch (error) {
      reportError(error);
      return;
    }
    pendingPosition = { mode: persistenceMode, point };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persistPending();
    }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  });

  return {
    setPersistenceMode(mode: PetPositionPersistenceMode): void {
      if (persistenceMode === mode) return;
      persistenceMode = mode;
      pendingPosition = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async flush(): Promise<void> {
      while (true) {
        if (timer) clearTimeout(timer);
        timer = null;
        await persistPending();
        const observedQueue = writeQueue;
        await observedQueue;
        if (pendingPosition === null && timer === null && observedQueue === writeQueue) return;
      }
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
        try {
          options.onError?.(error);
        } catch {
          // 错误记录失败也必须继续退出。
        }
      }
      exitReady = true;
      options.quit();
    })();
    await activeFlush;
  };
}
