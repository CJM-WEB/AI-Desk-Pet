export type DownloadSide = 'faq' | 'notice' | null;

export type VisibleDownloadSide = Exclude<DownloadSide, null>;

export type PreviewHoldSource = 'pointer' | 'focus';

type PreviewHolds = Record<
  VisibleDownloadSide,
  Record<PreviewHoldSource, boolean>
>;

type PreviewSuppressions = Record<VisibleDownloadSide, boolean>;

export type DownloadInteractionState = {
  activePlatformIndex: number;
  previewHolds: PreviewHolds;
  previewOrder: VisibleDownloadSide[];
  suppressedPreviews: PreviewSuppressions;
  lockedSide: VisibleDownloadSide | null;
};

export type DownloadInteractionEvent =
  | { type: 'SELECT_PLATFORM'; index: number }
  | {
      type: 'SET_PREVIEW_HOLD';
      side: VisibleDownloadSide;
      source: PreviewHoldSource;
      held: boolean;
    }
  | { type: 'TOGGLE_LOCK'; side: VisibleDownloadSide }
  | { type: 'RESET' };

// 初始状态不持有任何临时或锁定面板。
export const initialDownloadInteraction: DownloadInteractionState = {
  activePlatformIndex: 0,
  previewHolds: {
    faq: { pointer: false, focus: false },
    notice: { pointer: false, focus: false }
  },
  previewOrder: [],
  suppressedPreviews: {
    faq: false,
    notice: false
  },
  lockedSide: null
};

// 使用数学取模处理前后边界，使平台数量不被状态模型写死。
export function rotatePlatformIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

function isSideHeld(
  holds: PreviewHolds,
  side: VisibleDownloadSide
): boolean {
  return holds[side].pointer || holds[side].focus;
}

export function visibleDownloadSide(state: DownloadInteractionState): DownloadSide {
  if (state.lockedSide) return state.lockedSide;

  for (let index = state.previewOrder.length - 1; index >= 0; index -= 1) {
    const side = state.previewOrder[index]!;
    if (
      isSideHeld(state.previewHolds, side)
      && !state.suppressedPreviews[side]
    ) {
      return side;
    }
  }

  return null;
}

// hold、锁定和显式关闭抑制统一归约，组件只负责上报输入来源。
export function reduceDownloadInteraction(
  state: DownloadInteractionState,
  event: DownloadInteractionEvent
): DownloadInteractionState {
  switch (event.type) {
    case 'SELECT_PLATFORM':
      return { ...state, activePlatformIndex: event.index };

    case 'SET_PREVIEW_HOLD': {
      if (state.previewHolds[event.side][event.source] === event.held) {
        return state;
      }

      const sideHolds = {
        ...state.previewHolds[event.side],
        [event.source]: event.held
      };
      const previewHolds = {
        ...state.previewHolds,
        [event.side]: sideHolds
      };
      const sideStillHeld = sideHolds.pointer || sideHolds.focus;
      const previewOrder = event.held
        ? [
            ...state.previewOrder.filter((side) => side !== event.side),
            event.side
          ]
        : sideStillHeld
          ? state.previewOrder
          : state.previewOrder.filter((side) => side !== event.side);
      const suppressedPreviews = !sideStillHeld
        && state.suppressedPreviews[event.side]
        ? {
            ...state.suppressedPreviews,
            [event.side]: false
          }
        : state.suppressedPreviews;

      return {
        ...state,
        previewHolds,
        previewOrder,
        suppressedPreviews
      };
    }

    case 'TOGGLE_LOCK': {
      const unlocking = state.lockedSide === event.side;
      const shouldSuppress = unlocking
        && isSideHeld(state.previewHolds, event.side);

      return {
        ...state,
        lockedSide: unlocking ? null : event.side,
        suppressedPreviews: {
          ...state.suppressedPreviews,
          [event.side]: shouldSuppress
        }
      };
    }

    case 'RESET':
      return initialDownloadInteraction;
  }
}
