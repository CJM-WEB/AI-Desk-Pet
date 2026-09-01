import {
  characterManifestV2Schema,
  type CharacterManifestV2,
  type PresentationGeometryV2
} from '@myself/character-runtime';
import { z } from 'zod';

export type Point = Readonly<{ x: number; y: number }>;
export type Rectangle = Readonly<{ x: number; y: number; width: number; height: number }>;

export type PetGeometrySnapshot = Readonly<{
  revision: number;
  characterId: string;
  scale: number;
  footAnchorDip: Point;
  visualBoundsInWindowDip: Rectangle;
  windowBoundsDip: Rectangle;
  displayId: string;
}>;

export type PetGeometryErrorCode =
  | 'PET_GEOMETRY_INPUT_INVALID'
  | 'PET_GEOMETRY_MANIFEST_INVALID'
  | 'PET_GEOMETRY_CHARACTER_MISMATCH'
  | 'PET_GEOMETRY_ACTION_REVISION_INVALID'
  | 'PET_GEOMETRY_ACTION_REVISION_STALE'
  | 'PET_GEOMETRY_ACTION_REVISION_CONFLICT'
  | 'PET_GEOMETRY_ACTION_UNKNOWN'
  | 'PET_GEOMETRY_RESOURCE_REVISION_MISMATCH'
  | 'PET_GEOMETRY_DIRECTION_MISMATCH'
  | 'PET_GEOMETRY_SCALE_INVALID'
  | 'PET_GEOMETRY_VIEWPORT_INVALID'
  | 'PET_GEOMETRY_WINDOW_INVALID'
  | 'PET_GEOMETRY_DISPLAY_INVALID'
  | 'PET_GEOMETRY_COMPUTATION_INVALID'
  | 'PET_GEOMETRY_SHAPE_MISSING'
  | 'PET_GEOMETRY_BASE_REVISION_STALE'
  | 'PET_GEOMETRY_VIEWPORT_SIZE_MISMATCH'
  | 'PET_GEOMETRY_TRANSACTION_ACTIVE'
  | 'PET_GEOMETRY_TRANSACTION_STALE'
  | 'PET_GEOMETRY_TRANSACTION_REVISION_MISMATCH'
  | 'PET_GEOMETRY_TRANSACTION_ALREADY_COMMITTED';

export type PetGeometryUpdateResult =
  | Readonly<{ ok: true; snapshot: PetGeometrySnapshot }>
  | Readonly<{ ok: false; code: PetGeometryErrorCode }>;

export type PetGeometryShapeUpdateResult =
  | Readonly<{ ok: true; revision: number }>
  | Readonly<{ ok: false; code: PetGeometryErrorCode }>;

export type PetGeometryPlacementPrepareResult =
  | Readonly<{ ok: true; token: string; snapshot: PetGeometrySnapshot }>
  | Readonly<{ ok: false; code: PetGeometryErrorCode }>;

export type PetGeometryTransactionResult =
  | Readonly<{ ok: true; snapshot?: PetGeometrySnapshot }>
  | Readonly<{ ok: false; code: PetGeometryErrorCode }>;

type VisibleGeometry = Pick<PresentationGeometryV2, 'visualBounds' | 'groundAnchor'>;

const shapeInputSchema = z.object({
  manifest: z.unknown(),
  skinId: z.unknown(),
  actionId: z.unknown(),
  actionRevision: z.unknown(),
  resourceRevision: z.unknown(),
  direction: z.unknown(),
  scale: z.unknown(),
  viewportSizeDip: z.unknown()
}).strict();
const placementInputSchema = z.object({
  baseRevision: z.unknown(),
  viewportInWindowDip: z.unknown(),
  windowBoundsDip: z.unknown(),
  display: z.unknown()
}).strict();
const placementTransactionInputSchema = z.object({
  token: z.string().regex(/^pet-geometry-transaction-[1-9][0-9]*$/u),
  baseRevision: z.number().int().safe().nonnegative()
}).strict();
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
const revisionSchema = z.number().int().safe().nonnegative();
const resourceRevisionSchema = z.string().regex(/^[a-f0-9]{64}(?:\.[a-f0-9]{64})*$/u);
const directionSchema = z.enum(['left', 'right']);
const finiteNumberSchema = z.number().finite();
const rectangleSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema,
  height: finiteNumberSchema
}).strict();
const sizeSchema = z.object({
  width: finiteNumberSchema,
  height: finiteNumberSchema
}).strict();
const displaySchema = z.object({
  id: z.string().trim().min(1).max(256),
  workAreaDip: rectangleSchema
}).strict();

function failure(code: PetGeometryErrorCode): Readonly<{
  ok: false;
  code: PetGeometryErrorCode;
}> {
  return Object.freeze({ ok: false, code });
}

/** 快照通过克隆隔绝调用方引用，再递归冻结所有嵌套值。 */
function cloneAndFreeze<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
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
 * 首次真实 viewport 提交前，以实际窗口全范围提供短暂的保守视觉几何。
 * 正式快照一旦可用即完全替代它，不保留固定尺寸双轨。
 */
export function createConservativePetGeometrySnapshot(input: Readonly<{
  characterId: string;
  windowBoundsDip: Rectangle;
  displayId: string;
}>): PetGeometrySnapshot | null {
  if (
    input.characterId.trim().length === 0
    || input.displayId.trim().length === 0
    || !validRectangle(input.windowBoundsDip)
  ) return null;
  const snapshot: PetGeometrySnapshot = {
    revision: 0,
    characterId: input.characterId,
    scale: 1,
    footAnchorDip: {
      x: input.windowBoundsDip.x + input.windowBoundsDip.width / 2,
      y: input.windowBoundsDip.y + input.windowBoundsDip.height
    },
    visualBoundsInWindowDip: {
      x: 0,
      y: 0,
      width: input.windowBoundsDip.width,
      height: input.windowBoundsDip.height
    },
    windowBoundsDip: { ...input.windowBoundsDip },
    displayId: input.displayId
  };
  return cloneAndFreeze(snapshot) as PetGeometrySnapshot;
}

function viewportFitsWindow(viewport: Rectangle, window: Rectangle): boolean {
  return validRectangle(viewport)
    && viewport.x >= 0
    && viewport.y >= 0
    && viewport.x + viewport.width <= window.width
    && viewport.y + viewport.height <= window.height;
}

function rectanglesIntersect(left: Rectangle, right: Rectangle): boolean {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * 为未来多可见表现保留共同脚底 DIP 坐标系的纯联合 seam。
 * 调用方必须先把各表现从自身归一化画布转换为同一脚底原点下的 DIP 矩形。
 */
export function unionVisiblePresentationBounds(
  bounds: readonly Rectangle[]
): Rectangle {
  if (bounds.length === 0 || bounds.some(rectangle => !validRectangle(rectangle))) {
    throw new RangeError('PET_GEOMETRY_VISIBLE_SET_INVALID');
  }
  const left = Math.min(...bounds.map(rectangle => rectangle.x));
  const top = Math.min(...bounds.map(rectangle => rectangle.y));
  const right = Math.max(...bounds.map(rectangle => rectangle.x + rectangle.width));
  const bottom = Math.max(...bounds.map(rectangle => rectangle.y + rectangle.height));
  const union = { x: left, y: top, width: right - left, height: bottom - top };
  if (!validRectangle(union)) {
    throw new RangeError('PET_GEOMETRY_VISIBLE_SET_INVALID');
  }
  return Object.freeze(union);
}

function expectedResourceRevision(
  manifest: CharacterManifestV2,
  frameAssetIds: readonly string[]
): string {
  const revisions = new Map(manifest.resources.map(resource => [resource.assetId, resource.sha256]));
  return [...new Set(frameAssetIds.map(assetId => revisions.get(assetId)!))].sort().join('.');
}

function directedGeometry(
  geometry: PresentationGeometryV2,
  direction: 'left' | 'right'
): VisibleGeometry {
  if (direction === 'right') return geometry;
  return {
    visualBounds: {
      ...geometry.visualBounds,
      x: 1 - geometry.visualBounds.x - geometry.visualBounds.width
    },
    groundAnchor: { ...geometry.groundAnchor, x: 1 - geometry.groundAnchor.x }
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 与正式 Pixi 播放器一致，以动作最大帧画布等比适配 viewport。 */
function fitPresentation(
  frames: readonly Readonly<{ width: number; height: number }>[],
  viewport: Rectangle,
  ground: Point
): Readonly<{ width: number; height: number; groundInWindow: Point }> {
  const sourceWidth = Math.max(...frames.map(frame => frame.width));
  const sourceHeight = Math.max(...frames.map(frame => frame.height));
  // viewport 已是 Renderer 实际画布在当前窗口中的 DIP 矩形，不能再次乘持久 scale。
  const screenWidth = viewport.width;
  const screenHeight = viewport.height;
  const fitScale = Math.min(screenWidth / sourceWidth, screenHeight / sourceHeight);
  const width = sourceWidth * fitScale;
  const height = sourceHeight * fitScale;
  const groundX = clamp(
    screenWidth / 2,
    width * ground.x,
    screenWidth - width * (1 - ground.x)
  );
  const groundY = clamp(
    screenHeight,
    height * ground.y,
    screenHeight - height * (1 - ground.y)
  );
  return {
    width,
    height,
    groundInWindow: { x: viewport.x + groundX, y: viewport.y + groundY }
  };
}

/** 仅供 Main 布局事务预演；不进入 IPC，也不包含任何全局坐标。 */
export type PetShapeLayout = Readonly<{
  revision: number;
  characterId: string;
  scale: number;
  viewportSizeDip: Readonly<{ width: number; height: number }>;
  /** 相对 viewport 左上角；G4 还需叠加 viewportInWindowDip offset 才是窗口内脚底。 */
  footOffsetInViewportDip: Point;
  /** 相对脚底原点，用于按真实可见范围钳制而不是按透明窗口钳制。 */
  visualBoundsFromFootDip: Rectangle;
}>;

type ShapeState = Readonly<{
  shape: PetShapeLayout;
  shapeKey: string;
  actionRevision: number;
  actionBinding: string;
}>;

type PlacementTransaction = {
  token: string;
  baseRevision: number;
  phase: 'prepared' | 'committed';
  selected: ShapeState;
  nextSnapshot: PetGeometrySnapshot;
  previousActive: ShapeState | null;
  previousPending: ShapeState | null;
  previousSnapshot: PetGeometrySnapshot | null;
  previousCharacterId: string;
};

type ShapeRollbackBaseline = Pick<
  PlacementTransaction,
  'previousActive' | 'previousPending' | 'previousSnapshot' | 'previousCharacterId'
>;

/** Main 内的纯几何权威；G2b 不负责注册 IPC 或绑定窗口生命周期。 */
export class PetVisualGeometryAuthority {
  private snapshot: PetGeometrySnapshot | null = null;
  private active: ShapeState | null = null;
  private pending: ShapeState | null = null;
  private lastIssuedShapeRevision = 0;
  private placementTransaction: PlacementTransaction | null = null;
  private shapeRollbackBaseline: ShapeRollbackBaseline | null = null;
  private lastPlacementTransactionId = 0;

  constructor(private initialCharacterId: string) {
    if (!identifierSchema.safeParse(initialCharacterId).success) {
      throw new RangeError('PET_GEOMETRY_CHARACTER_INVALID');
    }
  }

  getSnapshot(): PetGeometrySnapshot | null {
    return this.snapshot ? cloneAndFreeze(this.snapshot) as PetGeometrySnapshot : null;
  }

  /** 按 revision 只读当前局部形状，供 G4 在提交 placement 前计算窗口布局。 */
  getShapeLayout(revision: number): PetShapeLayout | null {
    if (!revisionSchema.safeParse(revision).success) return null;
    const state = this.pending?.shape.revision === revision
      ? this.pending
      : this.active?.shape.revision === revision
        ? this.active
        : null;
    return state ? cloneAndFreeze(state.shape) as PetShapeLayout : null;
  }

  /** 只在角色、动作、方向、scale 或 viewport 尺寸边界调用，不接收逐帧通知。 */
  updateShape(
    candidate: unknown,
    activeCharacterId = this.active?.shape.characterId ?? this.initialCharacterId
  ): PetGeometryShapeUpdateResult {
    if (!identifierSchema.safeParse(activeCharacterId).success) {
      return failure('PET_GEOMETRY_INPUT_INVALID');
    }
    const envelope = shapeInputSchema.safeParse(candidate);
    if (!envelope.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    const input = envelope.data;

    const parsedManifest = characterManifestV2Schema.safeParse(input.manifest);
    if (!parsedManifest.success) return failure('PET_GEOMETRY_MANIFEST_INVALID');
    const manifest = parsedManifest.data;
    if (manifest.id !== activeCharacterId) return failure('PET_GEOMETRY_CHARACTER_MISMATCH');

    const skinId = identifierSchema.safeParse(input.skinId);
    const actionId = identifierSchema.safeParse(input.actionId);
    const resourceRevision = resourceRevisionSchema.safeParse(input.resourceRevision);
    const direction = directionSchema.safeParse(input.direction);
    if (
      !skinId.success || !actionId.success || !resourceRevision.success
      || !direction.success
    ) return failure('PET_GEOMETRY_INPUT_INVALID');

    const actionRevision = revisionSchema.safeParse(input.actionRevision);
    if (!actionRevision.success) return failure('PET_GEOMETRY_ACTION_REVISION_INVALID');
    const actionBinding = JSON.stringify([
      skinId.data, actionId.data, resourceRevision.data
    ]);
    const activeForCharacter = this.active?.shape.characterId === activeCharacterId
      ? this.active
      : null;
    const pendingForCharacter = this.pending?.shape.characterId === activeCharacterId
      ? this.pending
      : null;
    for (const baseline of [activeForCharacter, pendingForCharacter]) {
      if (!baseline) continue;
      if (actionRevision.data < baseline.actionRevision) {
        return failure('PET_GEOMETRY_ACTION_REVISION_STALE');
      }
      if (
        actionRevision.data === baseline.actionRevision
        && actionBinding !== baseline.actionBinding
      ) return failure('PET_GEOMETRY_ACTION_REVISION_CONFLICT');
    }

    const scale = finiteNumberSchema.safeParse(input.scale);
    if (!scale.success || scale.data < 0.5 || scale.data > 2) {
      return failure('PET_GEOMETRY_SCALE_INVALID');
    }
    const viewportSize = sizeSchema.safeParse(input.viewportSizeDip);
    if (
      !viewportSize.success
      || !validRectangle({ x: 0, y: 0, ...viewportSize.data })
    ) {
      return failure('PET_GEOMETRY_VIEWPORT_INVALID');
    }

    const action = manifest.actions.find(item => item.id === actionId.data);
    const skin = manifest.skins.find(item => item.id === skinId.data);
    const presentation = skin?.presentations.find(item => item.actionId === actionId.data);
    if (!action || !presentation) return failure('PET_GEOMETRY_ACTION_UNKNOWN');
    if (action.direction !== 'any' && action.direction !== direction.data) {
      return failure('PET_GEOMETRY_DIRECTION_MISMATCH');
    }
    const expectedRevision = expectedResourceRevision(
      manifest,
      presentation.frames.map(frame => frame.assetId)
    );
    if (
      resourceRevision.data !== expectedRevision
      || presentation.geometry.resourceRevision !== expectedRevision
    ) return failure('PET_GEOMETRY_RESOURCE_REVISION_MISMATCH');

    const visibleGeometry = directedGeometry(presentation.geometry, direction.data);
    const ground = visibleGeometry.groundAnchor;
    const fit = fitPresentation(
      presentation.frames,
      { x: 0, y: 0, ...viewportSize.data },
      ground
    );
    const relativeBounds = unionVisiblePresentationBounds([{
      x: (visibleGeometry.visualBounds.x - ground.x) * fit.width,
      y: (visibleGeometry.visualBounds.y - ground.y) * fit.height,
      width: visibleGeometry.visualBounds.width * fit.width,
      height: visibleGeometry.visualBounds.height * fit.height
    }]);
    const nextShapeKey = JSON.stringify([
      manifest.id, skinId.data, actionId.data, expectedRevision, direction.data,
      presentation.geometry.visualBounds, presentation.geometry.groundAnchor,
      Math.max(...presentation.frames.map(frame => frame.width)),
      Math.max(...presentation.frames.map(frame => frame.height)),
      scale.data, viewportSize.data.width, viewportSize.data.height
    ]);
    const matchingState = this.pending?.shapeKey === nextShapeKey
      ? this.pending
      : this.active?.shapeKey === nextShapeKey
        ? this.active
        : null;
    const revision = matchingState?.shape.revision ?? this.lastIssuedShapeRevision + 1;
    if (!revisionSchema.safeParse(revision).success) {
      return failure('PET_GEOMETRY_COMPUTATION_INVALID');
    }
    const nextShape: PetShapeLayout = {
      revision,
      characterId: manifest.id,
      scale: scale.data,
      viewportSizeDip: viewportSize.data,
      footOffsetInViewportDip: fit.groundInWindow,
      visualBoundsFromFootDip: relativeBounds
    };
    if (
      !finitePoint(nextShape.footOffsetInViewportDip)
      || !validRectangle(nextShape.visualBoundsFromFootDip)
    ) return failure('PET_GEOMETRY_COMPUTATION_INVALID');

    if (
      this.active !== null
      && matchingState === this.active
      && actionRevision.data === this.active.actionRevision
      && actionBinding === this.active.actionBinding
    ) return Object.freeze({ ok: true, revision });

    this.shapeRollbackBaseline ??= {
      previousActive: this.active,
      previousPending: this.pending,
      previousSnapshot: this.snapshot,
      previousCharacterId: this.initialCharacterId
    };
    this.lastIssuedShapeRevision = Math.max(this.lastIssuedShapeRevision, revision);
    this.pending = cloneAndFreeze({
      shape: nextShape,
      shapeKey: nextShapeKey,
      actionRevision: actionRevision.data,
      actionBinding
    }) as ShapeState;
    return Object.freeze({ ok: true, revision });
  }

  /** G4 原子窗口布局失败时显式丢弃未提交形状；重复调用不影响 active。 */
  discardPendingShape(): void {
    this.pending = this.shapeRollbackBaseline?.previousPending ?? null;
    this.shapeRollbackBaseline = null;
  }

  /**
   * 预演 placement 只生成候选快照，不提交 active；窗口与持久化事务可在此后安全失败。
   */
  preparePlacement(candidate: unknown): PetGeometryPlacementPrepareResult {
    if (this.placementTransaction) return failure('PET_GEOMETRY_TRANSACTION_ACTIVE');
    const envelope = placementInputSchema.safeParse(candidate);
    if (!envelope.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    if (!this.active && !this.pending) return failure('PET_GEOMETRY_SHAPE_MISSING');
    const input = envelope.data;
    const baseRevision = revisionSchema.safeParse(input.baseRevision);
    if (!baseRevision.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    const selected = this.pending?.shape.revision === baseRevision.data
      ? this.pending
      : this.active?.shape.revision === baseRevision.data
        ? this.active
        : null;
    if (!selected) {
      return failure('PET_GEOMETRY_BASE_REVISION_STALE');
    }
    const shape = selected.shape;

    const windowBounds = rectangleSchema.safeParse(input.windowBoundsDip);
    if (!windowBounds.success || !validRectangle(windowBounds.data)) {
      return failure('PET_GEOMETRY_WINDOW_INVALID');
    }
    const viewport = rectangleSchema.safeParse(input.viewportInWindowDip);
    if (!viewport.success || !viewportFitsWindow(viewport.data, windowBounds.data)) {
      return failure('PET_GEOMETRY_VIEWPORT_INVALID');
    }
    if (
      viewport.data.width !== shape.viewportSizeDip.width
      || viewport.data.height !== shape.viewportSizeDip.height
    ) return failure('PET_GEOMETRY_VIEWPORT_SIZE_MISMATCH');
    const display = displaySchema.safeParse(input.display);
    if (
      !display.success
      || !validRectangle(display.data.workAreaDip)
      || !rectanglesIntersect(windowBounds.data, display.data.workAreaDip)
    ) return failure('PET_GEOMETRY_DISPLAY_INVALID');

    const footInWindow = {
      x: viewport.data.x + shape.footOffsetInViewportDip.x,
      y: viewport.data.y + shape.footOffsetInViewportDip.y
    };
    const nextSnapshot: PetGeometrySnapshot = {
      revision: shape.revision,
      characterId: shape.characterId,
      scale: shape.scale,
      footAnchorDip: {
        x: windowBounds.data.x + footInWindow.x,
        y: windowBounds.data.y + footInWindow.y
      },
      visualBoundsInWindowDip: {
        x: footInWindow.x + shape.visualBoundsFromFootDip.x,
        y: footInWindow.y + shape.visualBoundsFromFootDip.y,
        width: shape.visualBoundsFromFootDip.width,
        height: shape.visualBoundsFromFootDip.height
      },
      windowBoundsDip: windowBounds.data,
      displayId: display.data.id
    };
    if (
      !finitePoint(nextSnapshot.footAnchorDip)
      || !validRectangle(nextSnapshot.visualBoundsInWindowDip)
      || !validRectangle(nextSnapshot.windowBoundsDip)
    ) return failure('PET_GEOMETRY_COMPUTATION_INVALID');
    const transactionId = this.lastPlacementTransactionId + 1;
    if (!Number.isSafeInteger(transactionId)) {
      return failure('PET_GEOMETRY_COMPUTATION_INVALID');
    }
    this.lastPlacementTransactionId = transactionId;
    const frozenSnapshot = cloneAndFreeze(nextSnapshot) as PetGeometrySnapshot;
    const token = `pet-geometry-transaction-${transactionId}`;
    const rollback = this.shapeRollbackBaseline ?? {
      previousActive: this.active,
      previousPending: this.pending,
      previousSnapshot: this.snapshot,
      previousCharacterId: this.initialCharacterId
    };
    this.placementTransaction = {
      token,
      baseRevision: shape.revision,
      phase: 'prepared',
      selected,
      nextSnapshot: frozenSnapshot,
      ...rollback
    };
    return Object.freeze({ ok: true, token, snapshot: cloneAndFreeze(frozenSnapshot) });
  }

  /** token 与 revision 同时绑定，避免异步落盘期间把候选提交到另一形状。 */
  commitPreparedPlacement(candidate: unknown): PetGeometryTransactionResult {
    const input = placementTransactionInputSchema.safeParse(candidate);
    if (!input.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    const transaction = this.placementTransaction;
    if (!transaction || input.data.token !== transaction.token) {
      return failure('PET_GEOMETRY_TRANSACTION_STALE');
    }
    if (input.data.baseRevision !== transaction.baseRevision) {
      return failure('PET_GEOMETRY_TRANSACTION_REVISION_MISMATCH');
    }
    if (transaction.phase === 'committed') {
      return failure('PET_GEOMETRY_TRANSACTION_ALREADY_COMMITTED');
    }
    this.active = transaction.selected;
    if (this.pending === transaction.selected) this.pending = null;
    this.initialCharacterId = transaction.selected.shape.characterId;
    this.snapshot = transaction.nextSnapshot;
    transaction.phase = 'committed';
    return Object.freeze({ ok: true, snapshot: this.getSnapshot()! });
  }

  /** 事务无论是否已 commit 均可回滚；旧 active、pending 与 revision 快照整体恢复。 */
  rollbackPreparedPlacement(candidate: unknown): PetGeometryTransactionResult {
    const input = placementTransactionInputSchema.safeParse(candidate);
    if (!input.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    const transaction = this.placementTransaction;
    if (!transaction || input.data.token !== transaction.token) {
      return failure('PET_GEOMETRY_TRANSACTION_STALE');
    }
    if (input.data.baseRevision !== transaction.baseRevision) {
      return failure('PET_GEOMETRY_TRANSACTION_REVISION_MISMATCH');
    }
    this.active = transaction.previousActive;
    this.pending = transaction.previousPending;
    this.snapshot = transaction.previousSnapshot;
    this.initialCharacterId = transaction.previousCharacterId;
    this.placementTransaction = null;
    this.shapeRollbackBaseline = null;
    return Object.freeze({ ok: true });
  }

  /** 成功事务收口后仅销毁回滚证据，正式快照保持不变。 */
  discardPreparedPlacement(candidate: unknown): PetGeometryTransactionResult {
    const input = placementTransactionInputSchema.safeParse(candidate);
    if (!input.success) return failure('PET_GEOMETRY_INPUT_INVALID');
    const transaction = this.placementTransaction;
    if (!transaction || input.data.token !== transaction.token) {
      return failure('PET_GEOMETRY_TRANSACTION_STALE');
    }
    if (input.data.baseRevision !== transaction.baseRevision) {
      return failure('PET_GEOMETRY_TRANSACTION_REVISION_MISMATCH');
    }
    this.placementTransaction = null;
    this.shapeRollbackBaseline = null;
    return Object.freeze({ ok: true });
  }

  /** 兼容既有调用者的同步便捷入口，内部仍走同一事务权威。 */
  updatePlacement(candidate: unknown): PetGeometryUpdateResult {
    const prepared = this.preparePlacement(candidate);
    if (!prepared.ok) return prepared;
    const transaction = { token: prepared.token, baseRevision: prepared.snapshot.revision };
    const committed = this.commitPreparedPlacement(transaction);
    if (!committed.ok || !committed.snapshot) {
      this.rollbackPreparedPlacement(transaction);
      return committed as PetGeometryUpdateResult;
    }
    this.discardPreparedPlacement(transaction);
    return Object.freeze({ ok: true, snapshot: committed.snapshot });
  }
}
