import type { AboutFeatureId } from './about-content';

export interface AboutInteractionState {
  hoveredId: AboutFeatureId | null;
  focusedId: AboutFeatureId | null;
  mobileLockedId: AboutFeatureId | null;
}

export type AboutInteractionEvent =
  | { type: 'SET_HOVER'; id: AboutFeatureId | null }
  | { type: 'SET_FOCUS'; id: AboutFeatureId | null }
  | { type: 'TOGGLE_MOBILE_LOCK'; id: AboutFeatureId }
  | { type: 'CLEAR_MOBILE_LOCK' }
  | { type: 'RESET' };

export interface AboutNormalizedPoint {
  x: number;
  y: number;
}

export interface AboutSafeZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 中央标题及其留白区域不触发周围功能面板的预览。
export const ABOUT_SAFE_ZONE: AboutSafeZone = {
  x: 0.31,
  y: 0.32,
  width: 0.38,
  height: 0.36
};

export const initialAboutInteraction: AboutInteractionState = {
  hoveredId: null,
  focusedId: null,
  mobileLockedId: null
};

export function visibleAboutFeatureId(
  state: AboutInteractionState
): AboutFeatureId | null {
  return state.mobileLockedId ?? state.focusedId ?? state.hoveredId;
}

export function reduceAboutInteraction(
  state: AboutInteractionState,
  event: AboutInteractionEvent
): AboutInteractionState {
  switch (event.type) {
    case 'SET_HOVER':
      return state.hoveredId === event.id
        ? state
        : { ...state, hoveredId: event.id };

    case 'SET_FOCUS':
      return state.focusedId === event.id
        ? state
        : { ...state, focusedId: event.id };

    case 'TOGGLE_MOBILE_LOCK':
      return {
        ...state,
        mobileLockedId:
          state.mobileLockedId === event.id ? null : event.id
      };

    case 'CLEAR_MOBILE_LOCK':
      return state.mobileLockedId === null
        ? state
        : { ...state, mobileLockedId: null };

    case 'RESET':
      return initialAboutInteraction;
  }
}

export function isInsideAboutSafeZone(
  point: AboutNormalizedPoint,
  zone: AboutSafeZone = ABOUT_SAFE_ZONE
): boolean {
  const tolerance = Number.EPSILON * 8;

  return point.x >= zone.x - tolerance
    && point.x <= zone.x + zone.width + tolerance
    && point.y >= zone.y - tolerance
    && point.y <= zone.y + zone.height + tolerance;
}
