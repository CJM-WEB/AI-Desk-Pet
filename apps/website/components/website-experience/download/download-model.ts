export type DownloadSide = 'faq' | 'notice' | null;

export type VisibleDownloadSide = Exclude<DownloadSide, null>;

export type PreviewHoldSource = 'pointer' | 'focus';

type PreviewHolds = Record<
  VisibleDownloadSide,
  Record<PreviewHoldSource, boolean>
>;

export type DownloadSideMode =
  | { kind: 'desktop-preview'; side: DownloadSide }
  | { kind: 'mobile-open'; side: DownloadSide };

export type DownloadInteractionState = {
  activePlatformIndex: number;
  desktopPreviewHolds: PreviewHolds;
  desktopPreviewOrder: VisibleDownloadSide[];
  mobileOpenSide: DownloadSide;
};

export type DownloadInteractionEvent =
  | { type: 'SELECT_PLATFORM'; index: number }
  | {
      type: 'SET_DESKTOP_PREVIEW_HOLD';
      side: VisibleDownloadSide;
      source: PreviewHoldSource;
      held: boolean;
    }
  | { type: 'OPEN_MOBILE_SIDE'; side: VisibleDownloadSide }
  | { type: 'CLOSE_MOBILE_SIDE' }
  | { type: 'RESET' };

export const initialDownloadInteraction: DownloadInteractionState = {
  activePlatformIndex: 0,
  desktopPreviewHolds: {
    faq: { pointer: false, focus: false },
    notice: { pointer: false, focus: false }
  },
  desktopPreviewOrder: [],
  mobileOpenSide: null
};

// 使用数学取模处理前后边界，使平台数量增加后仍保持连续堆叠。
export function rotatePlatformIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

function isDesktopSideHeld(
  holds: PreviewHolds,
  side: VisibleDownloadSide
): boolean {
  return holds[side].pointer || holds[side].focus;
}

function resolveDesktopPreviewSide(
  state: DownloadInteractionState
): DownloadSide {
  for (let index = state.desktopPreviewOrder.length - 1; index >= 0; index -= 1) {
    const side = state.desktopPreviewOrder[index]!;
    if (isDesktopSideHeld(state.desktopPreviewHolds, side)) return side;
  }

  return null;
}

// 通过单一派生模式隔离桌面临时预览与移动端轻触打开，禁止桌面锁定状态回流。
export function resolveDownloadSideMode(
  state: DownloadInteractionState,
  isMobile: boolean
): DownloadSideMode {
  return isMobile
    ? { kind: 'mobile-open', side: state.mobileOpenSide }
    : { kind: 'desktop-preview', side: resolveDesktopPreviewSide(state) };
}

export function reduceDownloadInteraction(
  state: DownloadInteractionState,
  event: DownloadInteractionEvent
): DownloadInteractionState {
  switch (event.type) {
    case 'SELECT_PLATFORM':
      return { ...state, activePlatformIndex: event.index };

    case 'SET_DESKTOP_PREVIEW_HOLD': {
      if (
        state.desktopPreviewHolds[event.side][event.source] === event.held
      ) {
        return state;
      }

      const sideHolds = {
        ...state.desktopPreviewHolds[event.side],
        [event.source]: event.held
      };
      const desktopPreviewHolds = {
        ...state.desktopPreviewHolds,
        [event.side]: sideHolds
      };
      const sideStillHeld = sideHolds.pointer || sideHolds.focus;
      const desktopPreviewOrder = event.held
        ? [
            ...state.desktopPreviewOrder.filter((side) => side !== event.side),
            event.side
          ]
        : sideStillHeld
          ? state.desktopPreviewOrder
          : state.desktopPreviewOrder.filter((side) => side !== event.side);

      return {
        ...state,
        desktopPreviewHolds,
        desktopPreviewOrder
      };
    }

    case 'OPEN_MOBILE_SIDE':
      return { ...state, mobileOpenSide: event.side };

    case 'CLOSE_MOBILE_SIDE':
      return state.mobileOpenSide === null
        ? state
        : { ...state, mobileOpenSide: null };

    case 'RESET':
      return initialDownloadInteraction;
  }
}
