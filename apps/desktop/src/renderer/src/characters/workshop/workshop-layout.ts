import {
  DEFAULT_WORKSHOP_LAYOUT,
  type WorkshopLayoutSettings
} from '../../../../shared/workshop-layout-ipc';

export type WorkshopLayoutBounds = Readonly<{ width: number; height: number }>;

export const WORKSHOP_DESKTOP_BREAKPOINT = 920;
export const WORKSHOP_SPLITTER_SIZE = 8;
export const WORKSHOP_LEFT_MIN = 250;
export const WORKSHOP_CENTER_MIN = 380;
export const WORKSHOP_RIGHT_MIN = 250;
export const WORKSHOP_SIDEBAR_TOP_MIN = 220;
export const WORKSHOP_SIDEBAR_BOTTOM_MIN = 220;
export const WORKSHOP_STAGE_HEADER_HEIGHT = 50;
export const WORKSHOP_STAGE_MIN = 280;
export const WORKSHOP_TIMELINE_MIN = 150;

const MAX_PERSISTED_LAYOUT_VALUE = 4_096;

function finiteInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_PERSISTED_LAYOUT_VALUE, Math.max(1, Math.round(value)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 桌面布局统一在 Renderer 根据工作区 content box 收敛；窄屏只规范持久值，
 * 不把响应式堆叠尺寸反写为用户的桌面偏好。
 */
export function clampWorkshopLayout(
  value: WorkshopLayoutSettings,
  bounds: WorkshopLayoutBounds
): WorkshopLayoutSettings {
  let leftWidth = finiteInteger(value.leftWidth, DEFAULT_WORKSHOP_LAYOUT.leftWidth);
  let rightWidth = finiteInteger(value.rightWidth, DEFAULT_WORKSHOP_LAYOUT.rightWidth);
  let sidebarTopHeight = finiteInteger(
    value.sidebarTopHeight,
    DEFAULT_WORKSHOP_LAYOUT.sidebarTopHeight
  );
  let stageHeight = finiteInteger(value.stageHeight, DEFAULT_WORKSHOP_LAYOUT.stageHeight);

  if (!Number.isFinite(bounds.width) || bounds.width <= WORKSHOP_DESKTOP_BREAKPOINT) {
    return {
      leftWidth,
      rightWidth,
      sidebarTopHeight: Math.max(WORKSHOP_SIDEBAR_TOP_MIN, sidebarTopHeight),
      stageHeight: Math.max(WORKSHOP_STAGE_MIN, stageHeight)
    };
  }

  leftWidth = Math.max(WORKSHOP_LEFT_MIN, leftWidth);
  rightWidth = Math.max(WORKSHOP_RIGHT_MIN, rightWidth);
  const sideBudget = Math.max(
    WORKSHOP_LEFT_MIN + WORKSHOP_RIGHT_MIN,
    Math.floor(bounds.width) - WORKSHOP_CENTER_MIN - (WORKSHOP_SPLITTER_SIZE * 2)
  );
  const excess = (leftWidth + rightWidth) - sideBudget;
  if (excess > 0) {
    const leftFlexible = leftWidth - WORKSHOP_LEFT_MIN;
    const rightFlexible = rightWidth - WORKSHOP_RIGHT_MIN;
    const flexibleTotal = leftFlexible + rightFlexible;
    if (flexibleTotal > 0) {
      const leftReduction = Math.round(excess * (leftFlexible / flexibleTotal));
      leftWidth = Math.max(WORKSHOP_LEFT_MIN, leftWidth - leftReduction);
      rightWidth = Math.max(WORKSHOP_RIGHT_MIN, sideBudget - leftWidth);
    }
  }

  const finiteHeight = Number.isFinite(bounds.height) ? Math.floor(bounds.height) : 0;
  sidebarTopHeight = clamp(
    sidebarTopHeight,
    WORKSHOP_SIDEBAR_TOP_MIN,
    finiteHeight - WORKSHOP_SPLITTER_SIZE - WORKSHOP_SIDEBAR_BOTTOM_MIN
  );
  stageHeight = clamp(
    stageHeight,
    WORKSHOP_STAGE_MIN,
    finiteHeight
      - WORKSHOP_STAGE_HEADER_HEIGHT
      - WORKSHOP_SPLITTER_SIZE
      - WORKSHOP_TIMELINE_MIN
  );

  return { leftWidth, rightWidth, sidebarTopHeight, stageHeight };
}
