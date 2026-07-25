export type DownloadSide = 'faq' | 'notice' | null;

export type DownloadInteractionState = {
  activePlatformIndex: number;
  previewSide: DownloadSide;
  lockedSide: Exclude<DownloadSide, null> | null;
};

export type DownloadInteractionEvent =
  | { type: 'SELECT_PLATFORM'; index: number }
  | { type: 'PREVIEW_SIDE'; side: DownloadSide }
  | { type: 'CLEAR_PREVIEW'; side: Exclude<DownloadSide, null> }
  | { type: 'TOGGLE_LOCK'; side: Exclude<DownloadSide, null> }
  | { type: 'RESET' };

// 初始状态不持有任何临时或锁定面板。
export const initialDownloadInteraction: DownloadInteractionState = {
  activePlatformIndex: 0,
  previewSide: null,
  lockedSide: null
};

// 使用数学取模处理前后边界，使平台数量不被状态模型写死。
export function rotatePlatformIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function visibleDownloadSide(state: DownloadInteractionState): DownloadSide {
  return state.lockedSide ?? state.previewSide;
}

// 状态机只返回新状态，不读写外部数据；锁定面板始终屏蔽临时预览。
export function reduceDownloadInteraction(
  state: DownloadInteractionState,
  event: DownloadInteractionEvent
): DownloadInteractionState {
  switch (event.type) {
    case 'SELECT_PLATFORM':
      return { ...state, activePlatformIndex: event.index };
    case 'PREVIEW_SIDE':
      return state.lockedSide ? state : { ...state, previewSide: event.side };
    case 'CLEAR_PREVIEW':
      return state.previewSide === event.side
        ? { ...state, previewSide: null }
        : state;
    case 'TOGGLE_LOCK':
      return {
        ...state,
        previewSide: null,
        lockedSide: state.lockedSide === event.side ? null : event.side
      };
    case 'RESET':
      return initialDownloadInteraction;
  }
}
