import type { Rectangle } from 'electron';
import {
  clampPositionToVisibleWorkArea,
  defaultPetPosition,
  type Point,
  type WindowSize
} from './window-manager';
import {
  storedPetPlacementSchema,
  type StoredPetPlacement
} from '../storage/settings-store';

export type PetDisplayDescription = Readonly<{
  id: string;
  workAreaDip: Rectangle;
}>;

export type PetPlacementGeometry = Readonly<{
  geometryRevision: number;
  windowSizeDip: WindowSize;
  /** 窗口左上角到脚底的偏移；G4 需把 viewport offset 与 shape layout 偏移相加后传入。 */
  footOffsetInWindowDip: Point;
  visualBoundsFromFootDip: Rectangle;
}>;

type PetPlacementSuccess = Readonly<{
  ok: true;
  placement: StoredPetPlacement;
  windowPosition: Point;
  geometryRevision: number;
  requiresPersistence: boolean;
}>;

type PetPlacementFailure = Readonly<{
  ok: false;
  code: 'PET_PLACEMENT_DISPLAY_UNAVAILABLE'
    | 'PET_PLACEMENT_GEOMETRY_INVALID'
    | 'PET_PLACEMENT_INPUT_INVALID';
}>;

export type PetPlacementResult = PetPlacementSuccess | PetPlacementFailure;

type LegacyMigrationInput = Readonly<{
  legacyPosition: Point;
  characterId: string;
  geometry: PetPlacementGeometry;
  displays: readonly PetDisplayDescription[];
  primaryDisplayId: string;
}>;

type PlacementRestoreInput = Readonly<{
  savedPlacement: unknown;
  characterId: string;
  geometryForScale: (scale: number) => PetPlacementGeometry;
  displays: readonly PetDisplayDescription[];
  primaryDisplayId: string;
}>;

const MIN_PET_SCALE = 0.5;
const MAX_PET_SCALE = 2;
const DEFAULT_VISUAL_EDGE_MARGIN_DIP = 16;

function finitePoint(point: unknown): point is Point {
  if (!point || typeof point !== 'object') return false;
  return Number.isFinite(Reflect.get(point, 'x'))
    && Number.isFinite(Reflect.get(point, 'y'));
}

function validRectangle(rectangle: Rectangle): boolean {
  return Number.isFinite(rectangle.x)
    && Number.isFinite(rectangle.y)
    && Number.isFinite(rectangle.width)
    && Number.isFinite(rectangle.height)
    && rectangle.width > 0
    && rectangle.height > 0
    && Number.isFinite(rectangle.x + rectangle.width)
    && Number.isFinite(rectangle.y + rectangle.height)
    && Number.isFinite(rectangle.width * rectangle.height);
}

function validGeometry(geometry: PetPlacementGeometry): boolean {
  return Number.isSafeInteger(geometry.geometryRevision)
    && geometry.geometryRevision >= 0
    && Number.isFinite(geometry.windowSizeDip.width)
    && Number.isFinite(geometry.windowSizeDip.height)
    && geometry.windowSizeDip.width > 0
    && geometry.windowSizeDip.height > 0
    && finitePoint(geometry.footOffsetInWindowDip)
    && Number.isFinite(
      geometry.windowSizeDip.width + Math.abs(geometry.footOffsetInWindowDip.x)
    )
    && Number.isFinite(
      geometry.windowSizeDip.height + Math.abs(geometry.footOffsetInWindowDip.y)
    )
    && validRectangle(geometry.visualBoundsFromFootDip);
}

function validDisplays(
  displays: readonly PetDisplayDescription[],
  primaryDisplayId: string
): Readonly<{
  displays: readonly PetDisplayDescription[];
  primary: PetDisplayDescription;
}> | null {
  const valid = displays.filter(display => display.id.trim().length > 0
    && validRectangle(display.workAreaDip));
  const primary = valid.find(display => display.id === primaryDisplayId);
  return primary ? { displays: valid, primary } : null;
}

function placementFromFoot(
  characterId: string,
  scale: number,
  displayId: string,
  footAnchorDip: Point,
  geometry: PetPlacementGeometry,
  requiresPersistence: boolean
): PetPlacementResult {
  const windowPosition = {
    x: footAnchorDip.x - geometry.footOffsetInWindowDip.x,
    y: footAnchorDip.y - geometry.footOffsetInWindowDip.y
  };
  if (!finitePoint(windowPosition) || !finitePoint(footAnchorDip)) {
    return { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
  }
  const placement = storedPetPlacementSchema.safeParse({
    characterId,
    scale,
    footAnchorDip,
    displayId
  });
  if (!placement.success) return { ok: false, code: 'PET_PLACEMENT_INPUT_INVALID' };
  return {
    ok: true,
    placement: placement.data,
    windowPosition,
    geometryRevision: geometry.geometryRevision,
    requiresPersistence
  };
}

function clampFootAnchor(
  footAnchorDip: Point,
  geometry: PetPlacementGeometry,
  display: PetDisplayDescription,
  edgeMarginDip = 0
): Point | null {
  const visual = geometry.visualBoundsFromFootDip;
  const displayRight = display.workAreaDip.x + display.workAreaDip.width;
  const displayBottom = display.workAreaDip.y + display.workAreaDip.height;
  const visualRight = visual.x + visual.width;
  const visualBottom = visual.y + visual.height;
  const minimumX = display.workAreaDip.x - visual.x + edgeMarginDip;
  const minimumY = display.workAreaDip.y - visual.y + edgeMarginDip;
  const rawMaximumX = displayRight - visualRight - edgeMarginDip;
  const rawMaximumY = displayBottom - visualBottom - edgeMarginDip;
  if (![
    displayRight, displayBottom, visualRight, visualBottom,
    minimumX, minimumY, rawMaximumX, rawMaximumY
  ].every(Number.isFinite)) return null;
  if (rawMaximumX < minimumX || rawMaximumY < minimumY) return null;
  const clamped = {
    x: Math.min(rawMaximumX, Math.max(minimumX, footAnchorDip.x)),
    y: Math.min(rawMaximumY, Math.max(minimumY, footAnchorDip.y))
  };
  return finitePoint(clamped) ? clamped : null;
}

function defaultPlacement(
  characterId: string,
  scale: number,
  geometry: PetPlacementGeometry,
  display: PetDisplayDescription
): PetPlacementResult {
  const visual = geometry.visualBoundsFromFootDip;
  const displayRight = display.workAreaDip.x + display.workAreaDip.width;
  const displayBottom = display.workAreaDip.y + display.workAreaDip.height;
  const visualRight = visual.x + visual.width;
  const visualBottom = visual.y + visual.height;
  const candidateFoot = {
    x: displayRight - visualRight - DEFAULT_VISUAL_EDGE_MARGIN_DIP,
    y: displayBottom - visualBottom - DEFAULT_VISUAL_EDGE_MARGIN_DIP
  };
  const footAnchorDip = finitePoint(candidateFoot)
    ? clampFootAnchor(
      candidateFoot,
      geometry,
      display,
      DEFAULT_VISUAL_EDGE_MARGIN_DIP
    ) ?? clampFootAnchor(candidateFoot, geometry, display)
    : null;
  return footAnchorDip
    ? placementFromFoot(characterId, scale, display.id, footAnchorDip, geometry, true)
    : { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
}

function intersectionArea(
  position: Point,
  size: WindowSize,
  workArea: Rectangle
): number {
  const windowRight = position.x + size.width;
  const windowBottom = position.y + size.height;
  const workAreaRight = workArea.x + workArea.width;
  const workAreaBottom = workArea.y + workArea.height;
  if (![windowRight, windowBottom, workAreaRight, workAreaBottom].every(Number.isFinite)) {
    return 0;
  }
  const width = Math.max(0, Math.min(windowRight, workAreaRight) - Math.max(position.x, workArea.x));
  const height = Math.max(0, Math.min(windowBottom, workAreaBottom) - Math.max(position.y, workArea.y));
  const area = width * height;
  return Number.isFinite(area) ? area : 0;
}

/**
 * 旧窗口左上角只在一次性迁移中使用；显示器按正交集面积选择，同面积明确优先主屏。
 * 成功结果必须由存储层原子写成新格式后再清除旧字段。
 */
export function migrateLegacyPetPosition(input: LegacyMigrationInput): PetPlacementResult {
  const displaySet = validDisplays(input.displays, input.primaryDisplayId);
  if (!displaySet) return { ok: false, code: 'PET_PLACEMENT_DISPLAY_UNAVAILABLE' };
  if (!validGeometry(input.geometry)) {
    return { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
  }
  if (!finitePoint(input.legacyPosition)) {
    return defaultPlacement(input.characterId, 1, input.geometry, displaySet.primary);
  }

  let selected = displaySet.primary;
  let selectedArea = intersectionArea(
    input.legacyPosition,
    input.geometry.windowSizeDip,
    selected.workAreaDip
  );
  for (const display of displaySet.displays) {
    if (display.id === selected.id) continue;
    const area = intersectionArea(
      input.legacyPosition,
      input.geometry.windowSizeDip,
      display.workAreaDip
    );
    if (area > selectedArea) {
      selected = display;
      selectedArea = area;
    }
  }
  if (selectedArea === 0) {
    return defaultPlacement(input.characterId, 1, input.geometry, displaySet.primary);
  }
  const candidateFoot = {
    x: input.legacyPosition.x + input.geometry.footOffsetInWindowDip.x,
    y: input.legacyPosition.y + input.geometry.footOffsetInWindowDip.y
  };
  const footAnchorDip = finitePoint(candidateFoot)
    ? clampFootAnchor(candidateFoot, input.geometry, selected)
    : null;
  if (!footAnchorDip) return { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
  return placementFromFoot(
    input.characterId,
    1,
    selected.id,
    footAnchorDip,
    input.geometry,
    true
  );
}

type ParsedStoredPlacement = Readonly<{
  placement: StoredPetPlacement;
  normalized: boolean;
}>;

function readSavedPlacement(value: unknown): ParsedStoredPlacement | null {
  const parsed = storedPetPlacementSchema.safeParse(value);
  if (!parsed.success) return null;
  if (!value || typeof value !== 'object') return null;
  return {
    placement: parsed.data,
    normalized: Reflect.get(value, 'scale') !== parsed.data.scale
      || Reflect.get(value, 'displayId') !== parsed.data.displayId
  };
}

function geometryAtScale(
  geometryForScale: PlacementRestoreInput['geometryForScale'],
  scale: number
): PetPlacementGeometry | null {
  try {
    const geometry = geometryForScale(scale);
    return validGeometry(geometry) ? geometry : null;
  } catch {
    return null;
  }
}

/**
 * 新格式以脚底锚点为唯一持久位置；窗口左上角仅由当前角色真实几何反算。
 * G4 接管窗口布局前保留旧 restorePetPosition/controller，调用方不得把它们写回新格式。
 */
export function restorePetPlacement(input: PlacementRestoreInput): PetPlacementResult {
  const displaySet = validDisplays(input.displays, input.primaryDisplayId);
  if (!displaySet) return { ok: false, code: 'PET_PLACEMENT_DISPLAY_UNAVAILABLE' };

  const parsedSaved = readSavedPlacement(input.savedPlacement);
  const saved = parsedSaved?.placement;
  const savedMatchesCharacter = saved?.characterId === input.characterId;
  const finiteScale = savedMatchesCharacter && Number.isFinite(saved.scale);
  const scale = finiteScale
    ? Math.min(MAX_PET_SCALE, Math.max(MIN_PET_SCALE, saved.scale))
    : 1;
  const geometry = geometryAtScale(input.geometryForScale, scale);
  if (!geometry) return { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
  if (!savedMatchesCharacter || !finiteScale) {
    return defaultPlacement(input.characterId, 1, geometry, displaySet.primary);
  }

  const display = displaySet.displays.find(candidate => candidate.id === saved.displayId);
  if (!display) return defaultPlacement(input.characterId, scale, geometry, displaySet.primary);
  const footAnchorDip = clampFootAnchor(saved.footAnchorDip, geometry, display);
  if (!footAnchorDip) return { ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' };
  const scaleChanged = parsedSaved?.normalized ?? false;
  const positionChanged = footAnchorDip.x !== saved.footAnchorDip.x
    || footAnchorDip.y !== saved.footAnchorDip.y;
  return placementFromFoot(
    input.characterId,
    scale,
    display.id,
    footAnchorDip,
    geometry,
    scaleChanged || positionChanged
  );
}

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
) {
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
    async freezeAndFlush(): Promise<void> {
      frozen = true;
      await flushAll();
    }
  };
}
