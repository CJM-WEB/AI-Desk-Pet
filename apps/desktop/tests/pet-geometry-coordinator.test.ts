import { describe, expect, test, vi } from 'vitest';
import { characterManifestV2Schema, type CharacterManifestV2 } from '@myself/character-runtime';
import { PetGeometryCoordinator } from '../src/main/windows/pet-geometry-coordinator';
import type { CharacterGeometryBinding } from '../src/main/characters/character-behavior-service';
import { PetVisualGeometryAuthority } from '../src/main/characters/pet-visual-geometry';
import { CharacterMotionService } from '../src/main/characters/character-motion-service';

const RESOURCE_REVISION = 'a'.repeat(64);

function realManifest(groundX = 0.5, characterId = 'pet-a'): CharacterManifestV2 {
  return characterManifestV2Schema.parse({
    version: 2,
    id: characterId,
    name: '视口收敛测试角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '视口收敛测试角色', background: '测试背景', traits: [], languageStyle: '简洁',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default-skin',
    defaultStateId: 'idle-state',
    states: [{
      id: 'idle-state', name: '待机', kind: 'primary', semantic: 'idle', tags: [], intensity: 1,
      coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [], exitConditions: [],
      agentInferable: true, actionIds: ['idle-action']
    }],
    actions: [{
      id: 'idle-action', name: '待机动作', semantic: 'idle', tags: [], preference: 1,
      cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
      allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
      forbiddenModifierStateIds: [], direction: 'any'
    }],
    skins: [{
      id: 'default-skin', name: '默认皮肤', semanticFallbacks: [],
      presentations: [{
        actionId: 'idle-action', fps: 12,
        frames: [{ assetId: 'idle-asset', x: 0, y: 0, width: 100, height: 100 }],
        anchors: { ground: { x: groundX, y: 0.9 } },
        geometry: {
          visualBounds: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
          groundAnchor: { x: groundX, y: 0.9 }, resourceRevision: RESOURCE_REVISION
        }
      }]
    }],
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: RESOURCE_REVISION, byteLength: 1 },
      { assetId: 'idle-asset', fileName: 'idle.png', sha256: RESOURCE_REVISION, byteLength: 1 }
    ]
  });
}

function fixture(options: {
  saveFails?: boolean;
  layoutBlocked?: () => boolean;
  getBinding?: () => CharacterGeometryBinding | null;
  savedScale?: number;
} = {}) {
  let bounds = { x: 300, y: 200, width: 180, height: 220 };
  let snapshot: Record<string, unknown> | null = null;
  let pendingScale = 1.1;
  let pendingViewport = { width: 110, height: 110 };
  let pendingSnapshot = {
    revision: 2,
    characterId: 'pet-a',
    scale: 1.1,
    footAnchorDip: { x: 370, y: 300 },
    visualBoundsInWindowDip: { x: 40, y: 20, width: 66, height: 88 },
    windowBoundsDip: { x: 291, y: 190, width: 198, height: 242 },
    displayId: 'display-1'
  };
  const authority = {
    getSnapshot: vi.fn(() => snapshot),
    updateShape: vi.fn((input: { scale: number; viewportSizeDip: typeof pendingViewport }) => {
      pendingScale = input.scale;
      pendingViewport = { ...input.viewportSizeDip };
      return { ok: true as const, revision: 2 };
    }),
    getShapeLayout: vi.fn(() => ({
      revision: 2, characterId: 'pet-a', scale: pendingScale,
      viewportSizeDip: pendingViewport,
      footOffsetInViewportDip: { x: pendingViewport.width / 2, y: pendingViewport.height * 0.9 },
      visualBoundsFromFootDip: { x: -33, y: -88, width: 66, height: 88 }
    })),
    preparePlacement: vi.fn((input: { windowBoundsDip: typeof bounds }) => {
      pendingSnapshot = {
        ...pendingSnapshot,
        scale: pendingScale,
        windowBoundsDip: input.windowBoundsDip
      };
      return { ok: true as const, token: 'pet-geometry-transaction-1', snapshot: pendingSnapshot };
    }),
    commitPreparedPlacement: vi.fn(() => {
      snapshot = pendingSnapshot;
      return { ok: true as const, snapshot: pendingSnapshot };
    }),
    rollbackPreparedPlacement: vi.fn(() => {
      snapshot = null;
      return { ok: true as const };
    }),
    discardPreparedPlacement: vi.fn(() => ({ ok: true as const })),
    discardPendingShape: vi.fn()
  };
  let coordinator!: PetGeometryCoordinator;
  const setBounds = vi.fn((next: typeof bounds) => {
    bounds = { ...next };
    queueMicrotask(() => void coordinator.commitViewport({
      viewportInWindowDip: {
        x: 20, y: 10,
        width: next.width - 80,
        height: next.height - 120
      }
    }));
  });
  const savePetPlacement = options.saveFails
    ? vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('WRITE_FAILED'))
    : vi.fn().mockResolvedValue(undefined);
  const publishRenderView = vi.fn();
  coordinator = new PetGeometryCoordinator({
    window: {
      getBounds: () => ({ ...bounds }),
      setBounds,
      isDestroyed: () => false
    },
    authority: authority as never,
    settings: {
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'ready',
        placement: {
          characterId: 'pet-a', scale: options.savedScale ?? 1,
          footAnchorDip: { x: 370, y: 300 }, displayId: 'display-1'
        }
      }),
      savePetPlacement,
      commitPetPlacementMigration: vi.fn()
    },
    getGeometryBinding: options.getBinding ?? (() => ({
      generation: 1, manifest: { id: 'pet-a' } as never, skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: 'a'.repeat(64), direction: 'right'
    })),
    displays: () => [{
      id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 }
    }],
    primaryDisplayId: () => 'display-1',
    publishRenderView,
    expectProgrammaticPosition: vi.fn(),
    ...(options.layoutBlocked ? { isLayoutBlocked: options.layoutBlocked } : {})
  });
  return {
    coordinator, authority, setBounds, savePetPlacement, publishRenderView,
    getBounds: () => bounds
  };
}

describe('Main 桌宠几何原子协调器', () => {
  test('运动服务只把规范化后的 Int32 整数坐标交给原生窗口', () => {
    let now = 0;
    const bounds = { x: 0, y: 0, width: 180, height: 220 };
    const setPosition = vi.fn();
    const service = new CharacterMotionService({
      window: { getBounds: () => bounds, setPosition },
      getDisplays: () => [{
        id: 'display-1',
        workAreaDip: { x: -3_000_000_000, y: -3_000_000_000, width: 6_000_000_000, height: 6_000_000_000 }
      }],
      getGeometrySnapshot: () => ({
        revision: 1,
        characterId: 'pet-a',
        scale: 1,
        footAnchorDip: { x: 90, y: 220 },
        visualBoundsInWindowDip: { x: 0, y: 0, width: 180, height: 220 },
        windowBoundsDip: bounds,
        displayId: 'display-1'
      }),
      now: () => now,
      maxDeltaMs: 1_000
    });
    const moveAndTick = (target: { x: number; y: number }, speed = 10_000): void => {
      service.moveTo(target, speed);
      now += 1_000;
      service.tick();
    };

    moveAndTick({ x: -0.1, y: 2 });
    const [negativeZeroX, positiveY] = setPosition.mock.calls[0] ?? [];
    expect(Object.is(negativeZeroX, 0)).toBe(true);
    expect(positiveY).toBe(2);

    moveAndTick({ x: 2, y: -0.1 });
    const [positiveX, negativeZeroY] = setPosition.mock.calls[1] ?? [];
    expect(positiveX).toBe(2);
    expect(Object.is(negativeZeroY, 0)).toBe(true);

    moveAndTick({ x: -1, y: -200 });
    expect(setPosition).toHaveBeenNthCalledWith(3, -1, -200);

    expect(() => service.moveTo({ x: Number.NaN, y: 2 })).toThrow(
      'CHARACTER_MOTION_INPUT_INVALID'
    );
    expect(() => service.moveTo({ x: Number.POSITIVE_INFINITY, y: 2 })).toThrow(
      'CHARACTER_MOTION_INPUT_INVALID'
    );
    expect(setPosition).toHaveBeenCalledTimes(3);

    service.moveTo({ x: 2_147_483_648, y: 2 }, 3_000_000_000);
    now += 1_000;
    expect(() => service.tick()).toThrow('CHARACTER_POSITION_INVALID');
    expect(setPosition).toHaveBeenCalledTimes(3);
  });

  test.each([0.5, 2])('旧持久尺寸 %s 启动时统一归一为默认 100%%', async savedScale => {
    const value = fixture({ savedScale });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 }
    });

    expect(value.authority.updateShape).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: 1 }),
      'pet-a'
    );
    expect(value.coordinator.inspectRelativeGeometry()?.scaleTick).toBe(10);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: 1 })
    );
  });

  test('真实 viewport 先到而行为绑定后到时可由缓存恢复初始化', async () => {
    let ready = false;
    const value = fixture({
      getBinding: () => ready ? {
        generation: 1, manifest: { id: 'pet-a' } as never, skinId: 'default-skin',
        actionId: 'idle-action', actionRevision: 3,
        resourceRevision: 'a'.repeat(64), direction: 'right' as const
      } : null
    });
    await expect(value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 }
    })).rejects.toThrow('PET_GEOMETRY_BINDING_UNAVAILABLE');
    ready = true;

    await (value.coordinator as unknown as { refreshBinding(): Promise<void> }).refreshBinding();
    await (value.coordinator as unknown as { refreshBinding(): Promise<void> }).refreshBinding();

    expect(value.savePetPlacement).toHaveBeenCalledOnce();
    expect(value.publishRenderView).toHaveBeenCalledOnce();
  });
});

type Viewport = Readonly<{ x: number; y: number; width: number; height: number }>;

function realAuthorityFixture(options: {
  blocked?: () => boolean;
  userMoving?: () => boolean;
  actualViewport?: (expectedBounds: Viewport, previous: Viewport, call: number) => Viewport | null;
  actualBounds?: (candidate: Viewport, previous: Viewport, call: number) => Viewport;
  initialBounds?: Viewport;
  initialViewport?: Viewport;
  getPetPlacementState?: ReturnType<typeof vi.fn>;
  savePetPlacement?: ReturnType<typeof vi.fn>;
  getBinding?: () => CharacterGeometryBinding | null;
  displays?: readonly Readonly<{ id: string; workAreaDip: Viewport }>[];
  primaryDisplayId?: string;
  setBoundsError?: (candidate: Viewport, call: number) => Error | null;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  expectProgrammaticPosition?: (point: Readonly<{ x: number; y: number }>) => unknown;
  windowDestroyed?: () => boolean;
  getBoundsError?: () => Error | null;
} = {}) {
  let bounds = options.initialBounds
    ? { ...options.initialBounds }
    : { x: 300, y: 200, width: 180, height: 220 };
  let viewport: Viewport = options.initialViewport
    ? { ...options.initialViewport }
    : { x: 20, y: 10, width: 158, height: 193 };
  const fixedWindowSize = { width: bounds.width, height: bounds.height };
  let setBoundsCall = 0;
  const authority = new PetVisualGeometryAuthority('pet-a');
  const savePetPlacement = options.savePetPlacement ?? vi.fn().mockResolvedValue(undefined);
  const commitPetPlacementMigration = vi.fn().mockResolvedValue(undefined);
  const publishRenderView = vi.fn();
  const updateShape = vi.spyOn(authority, 'updateShape');
  const preparePlacement = vi.spyOn(authority, 'preparePlacement');
  const commitPreparedPlacement = vi.spyOn(authority, 'commitPreparedPlacement');
  const rollbackPreparedPlacement = vi.spyOn(authority, 'rollbackPreparedPlacement');
  let coordinator!: PetGeometryCoordinator;
  const setBounds = vi.fn((candidate: Viewport) => {
    const next = { x: candidate.x, y: candidate.y, ...fixedWindowSize };
    const previous = viewport;
    const previousBounds = bounds;
    setBoundsCall += 1;
    const setBoundsError = options.setBoundsError?.(next, setBoundsCall);
    if (setBoundsError) throw setBoundsError;
    const actualBounds = options.actualBounds
      ? options.actualBounds(next, previousBounds, setBoundsCall)
      : next;
    bounds = { x: actualBounds.x, y: actualBounds.y, ...fixedWindowSize };
    const actualOverride = options.actualViewport?.(next, previous, setBoundsCall);
    const actual = actualOverride === undefined ? previous : actualOverride;
    if (!actual) return;
    viewport = { ...actual };
    queueMicrotask(() => void coordinator.commitViewport({ viewportInWindowDip: viewport }));
  });
  const binding: CharacterGeometryBinding = {
    generation: 1,
    manifest: realManifest(),
    skinId: 'default-skin',
    actionId: 'idle-action',
    actionRevision: 3,
    resourceRevision: RESOURCE_REVISION,
    direction: 'right'
  };
  coordinator = new PetGeometryCoordinator({
    window: {
      getBounds: () => {
        const error = options.getBoundsError?.();
        if (error) throw error;
        return { ...bounds };
      },
      setBounds,
      isDestroyed: options.windowDestroyed ?? (() => false)
    },
    authority,
    settings: {
      getPetPlacementState: options.getPetPlacementState ?? vi.fn().mockResolvedValue({
        kind: 'ready',
        placement: {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      }),
      savePetPlacement,
      commitPetPlacementMigration
    },
    getGeometryBinding: options.getBinding ?? (() => binding),
    displays: () => options.displays ?? [{
      id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 }
    }],
    primaryDisplayId: () => options.primaryDisplayId ?? 'display-1',
    publishRenderView,
    expectProgrammaticPosition: (options.expectProgrammaticPosition ?? vi.fn()) as never,
    ...(options.blocked ? { isLayoutBlocked: options.blocked } : {}),
    ...(options.userMoving ? { isUserMoving: options.userMoving } : {}),
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {})
  });
  const commitViewport = coordinator.commitViewport.bind(coordinator);
  coordinator.commitViewport = input => {
    viewport = { ...input.viewportInWindowDip };
    return commitViewport(input);
  };
  return {
    coordinator,
    authority,
    updateShape,
    preparePlacement,
    commitPreparedPlacement,
    rollbackPreparedPlacement,
    setBounds,
    savePetPlacement,
    commitPetPlacementMigration,
    publishRenderView,
    getBounds: () => ({ ...bounds }),
    setCurrentBounds: (next: Viewport) => { bounds = { ...next }; },
    setCurrentViewport: (next: Viewport) => { viewport = { ...next }; }
  };
}

describe('G4 viewport settle 补充状态机', () => {
  test('Renderer viewport 与角色换绑只调整位置，运行期保持启动窗口尺寸', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({ getBinding: () => binding });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const startupSize = { width: value.getBounds().width, height: value.getBounds().height };
    value.setBounds.mockClear();

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 155, height: 195 }
    });
    binding = {
      ...binding,
      generation: 2,
      manifest: realManifest(0.4),
      actionRevision: 4
    };
    await value.coordinator.refreshBinding();

    expect(value.setBounds).toHaveBeenCalled();
    expect(value.setBounds.mock.calls.every(([bounds]) => (
      bounds.width === startupSize.width && bounds.height === startupSize.height
    ))).toBe(true);
    expect(value.getBounds()).toMatchObject(startupSize);
    expect(value.authority.getSnapshot()?.windowBoundsDip).toMatchObject(startupSize);
  });

  test('真实 authority 从 158×193 收敛到 158×194 时先更新 shape 再 placement 且保持脚底', async () => {
    const value = realAuthorityFixture();
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const before = value.authority.getSnapshot();
    value.updateShape.mockClear();
    value.preparePlacement.mockClear();

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });

    const after = value.authority.getSnapshot();
    expect(after?.revision).toBeGreaterThan(before!.revision);
    expect(after?.footAnchorDip).toEqual(before?.footAnchorDip);
    expect(value.updateShape.mock.invocationCallOrder[0])
      .toBeLessThan(value.preparePlacement.mock.invocationCallOrder[0]!);
  });


  test('普通 move 且 viewport 尺寸相同时只更新 placement，offset-only 不增 revision', async () => {
    const value = realAuthorityFixture();
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    const revision = value.authority.getSnapshot()!.revision;
    value.updateShape.mockClear();
    value.setCurrentBounds({ x: 360, y: 250, width: 180, height: 220 });
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 21, y: 11, width: 158, height: 193 } });
    value.coordinator.handleWindowMoved();
    await value.coordinator.resumePendingLayout();

    expect(value.updateShape).not.toHaveBeenCalled();
    expect(value.authority.getSnapshot()?.revision).toBe(revision);
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual({
      x: 360, y: 250, width: 180, height: 220
    });
  });

  test('普通 move 后尺寸变化先 shape settle，再以当前 dragged bounds 保存新 foot', async () => {
    let blocked = false;
    const value = realAuthorityFixture({ blocked: () => blocked });
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    value.updateShape.mockClear();
    value.preparePlacement.mockClear();
    blocked = true;
    value.setCurrentBounds({ x: 420, y: 260, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 } });
    blocked = false;
    await value.coordinator.resumePendingLayout();

    expect(value.updateShape.mock.invocationCallOrder[0])
      .toBeLessThan(value.preparePlacement.mock.invocationCallOrder[0]!);
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual({ x: 420, y: 260, width: 180, height: 220 });
  });


  test('无 placementDirty 的 size settle 保持旧 foot，与 adopt-current-window 分支不同', async () => {
    const preserve = realAuthorityFixture();
    await preserve.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    const oldFoot = preserve.authority.getSnapshot()!.footAnchorDip;
    preserve.setCurrentBounds({ x: 500, y: 300, width: 180, height: 220 });
    await preserve.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 157, height: 194 } });
    expect(preserve.authority.getSnapshot()?.footAnchorDip).toEqual(oldFoot);

    let blocked = false;
    const adopt = realAuthorityFixture({ blocked: () => blocked });
    await adopt.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    blocked = true;
    adopt.setCurrentBounds({ x: 500, y: 300, width: 180, height: 220 });
    adopt.coordinator.handleWindowMoved();
    await adopt.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 157, height: 194 } });
    blocked = false;
    await adopt.coordinator.resumePendingLayout();
    expect(adopt.authority.getSnapshot()?.footAnchorDip).not.toEqual(oldFoot);
    expect(adopt.authority.getSnapshot()?.windowBoundsDip.x).toBe(500);
  });





  test('settle 期间收到新尺寸只追加一次 latest，重复事件不自激', async () => {
    const value = realAuthorityFixture();
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    let injected = false;
    value.savePetPlacement.mockImplementation(async () => {
      if (injected) return;
      injected = true;
      void value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 160, height: 196 } });
      void value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 160, height: 196 } });
    });
    value.updateShape.mockClear();
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 159, height: 195 } });
    await value.coordinator.resumePendingLayout();
    expect(value.updateShape).toHaveBeenCalledTimes(2);
    expect(value.authority.getSnapshot()?.revision).toBe(3);
  });

  test('非缩放 settle 的原点量化后只提交 actual，adopt-current-window 与重复 viewport 不自激', async () => {
    let quantizeNextBounds = false;
    let quantizedBounds: Viewport | null = null;
    const preserve = realAuthorityFixture({
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'ready' as const,
        placement: null
      }),
      actualBounds: candidate => {
        if (!quantizeNextBounds) return candidate;
        quantizeNextBounds = false;
        quantizedBounds = {
          x: Math.round(candidate.x),
          y: Math.round(candidate.y),
          width: candidate.width,
          height: candidate.height
        };
        return quantizedBounds;
      },
      actualViewport: (_candidate, previous) => quantizedBounds
        ? { x: previous.x, y: previous.y, width: 160, height: 196 }
        : previous
    });
    await preserve.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const rollbackBaseline = preserve.rollbackPreparedPlacement.mock.calls.length;
    quantizeNextBounds = true;

    await preserve.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 159, height: 195 }
    });

    const preserveSnapshot = preserve.authority.getSnapshot();
    expect(preserve.rollbackPreparedPlacement)
      .toHaveBeenCalledTimes(rollbackBaseline + 1);
    expect(preserveSnapshot?.windowBoundsDip).toEqual(quantizedBounds);
    expect(preserve.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: preserveSnapshot?.footAnchorDip
    }));
    expect(preserve.authority.getShapeLayout(preserveSnapshot!.revision)?.viewportSizeDip)
      .toEqual({ width: 160, height: 196 });
    const preserveRevisions = preserve.updateShape.mock.calls.length;
    const preserveSaves = preserve.savePetPlacement.mock.calls.length;
    const preserveBroadcasts = preserve.publishRenderView.mock.calls.length;
    await preserve.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 160, height: 196 }
    });
    expect(preserve.updateShape).toHaveBeenCalledTimes(preserveRevisions);
    expect(preserve.savePetPlacement).toHaveBeenCalledTimes(preserveSaves);
    expect(preserve.publishRenderView).toHaveBeenCalledTimes(preserveBroadcasts);

    let blocked = false;
    const adopt = realAuthorityFixture({ blocked: () => blocked });
    await adopt.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    const draggedBounds = { x: 480, y: 280, width: 180, height: 220 };
    adopt.setCurrentBounds(draggedBounds);
    adopt.coordinator.handleWindowMoved();
    await adopt.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 160, height: 196 }
    });
    blocked = false;
    await adopt.coordinator.resumePendingLayout();
    expect(adopt.authority.getSnapshot()?.windowBoundsDip).toEqual(draggedBounds);
    expect(adopt.setBounds).not.toHaveBeenCalled();
  });

  test('pending-legacy 初始化固定尺寸 setBounds 被 OS 量化后只提交 actual bounds 并迁移实际脚底', async () => {
    const actualBounds = { x: 1570, y: 803, width: 181, height: 221 };
    const value = realAuthorityFixture({
      initialBounds: { x: 0, y: 0, width: 181, height: 221 },
      initialViewport: { x: 20, y: 10, width: 158, height: 194 },
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'pending-legacy' as const,
        windowPosition: { x: 1569.921875, y: 803.359375 }
      }),
      actualBounds: candidate => candidate.width === 181
        ? actualBounds
        : candidate,
      actualViewport: () => ({ x: 20, y: 10, width: 158, height: 194 })
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });

    expect(value.preparePlacement).toHaveBeenCalledTimes(2);
    expect(value.preparePlacement.mock.calls[0]?.[0]).toMatchObject({
      windowBoundsDip: { width: 181, height: 221 }
    });
    expect(value.rollbackPreparedPlacement).toHaveBeenCalledOnce();
    expect(value.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual(actualBounds);
    expect(value.savePetPlacement).not.toHaveBeenCalled();
    expect(value.commitPetPlacementMigration).toHaveBeenCalledOnce();
    expect(value.commitPetPlacementMigration).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: expect.objectContaining({
        footAnchorDip: value.authority.getSnapshot()?.footAnchorDip
      })
    }));
  });

  test('ready 恢复遭 OS 量化时以 actual bounds 提交事务并在真实 viewport 到达后恢复持久脚底', async () => {
    const savedFoot = { x: 399.5, y: 388.1 };
    let quantizeFirstBounds = true;
    const value = realAuthorityFixture({
      initialBounds: { x: 0, y: 0, width: 181, height: 221 },
      initialViewport: { x: 20, y: 10, width: 158, height: 194 },
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'ready' as const,
        placement: {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: savedFoot, displayId: 'display-1'
        }
      }),
      actualBounds: candidate => {
        if (!quantizeFirstBounds) return candidate;
        quantizeFirstBounds = false;
        return {
          x: Math.ceil(candidate.x),
          y: Math.ceil(candidate.y),
          width: candidate.width + 1,
          height: candidate.height
        };
      },
      actualViewport: (_candidate, previous, call) => call === 1
        ? { ...previous, width: 159 }
        : previous
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });

    const snapshot = value.authority.getSnapshot();
    expect(snapshot?.footAnchorDip).toEqual(savedFoot);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: savedFoot
    }));
    expect(snapshot?.windowBoundsDip).toEqual(value.getBounds());
    const layout = value.authority.getShapeLayout(snapshot!.revision)!;
    expect(snapshot?.footAnchorDip).toEqual({
      x: value.getBounds().x + 20 + layout.footOffsetInViewportDip.x,
      y: value.getBounds().y + 10 + layout.footOffsetInViewportDip.y
    });
  });

  test('ready 持久脚底跨连续 viewport 的量化误差不累计', async () => {
    const savedFoot = { x: 399, y: 388.2 };
    const value = realAuthorityFixture({
      initialBounds: { x: 0, y: 0, width: 181, height: 221 },
      initialViewport: { x: 20, y: 10, width: 158, height: 194 },
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'ready' as const,
        placement: {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: savedFoot, displayId: 'display-1'
        }
      }),
      actualBounds: candidate => ({ ...candidate, x: Math.ceil(candidate.x) })
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 159, height: 194 }
    });
    expect(value.authority.getSnapshot()?.footAnchorDip.x).toBe(399.5);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: { x: 399.5, y: savedFoot.y }
    }));
    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 160, height: 194 }
    });
    expect(value.authority.getSnapshot()?.footAnchorDip).toEqual(savedFoot);
    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);
  });

  test('ready 恢复目标忽略程序化 move 且仅由 CharacterMotion 确认的用户拖拽接管', async () => {
    let userMoving = false;
    const value = realAuthorityFixture({
      blocked: () => userMoving,
      userMoving: () => userMoving
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const restoredFoot = value.authority.getSnapshot()!.footAnchorDip;
    value.savePetPlacement.mockClear();

    value.setCurrentBounds({ x: 310, y: 210, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    await value.coordinator.resumePendingLayout();
    expect(value.savePetPlacement).not.toHaveBeenCalled();
    expect(value.authority.getSnapshot()?.footAnchorDip).toEqual(restoredFoot);

    userMoving = true;
    value.setCurrentBounds({ x: 520, y: 320, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    userMoving = false;
    await value.coordinator.resumePendingLayout();
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual({
      x: 520, y: 320, width: 180, height: 220
    });
    expect(value.savePetPlacement).toHaveBeenCalledOnce();
  });

  test('ready 尚无角色 placement 时采用 OS actual 生成默认脚底而不进入恢复等待', async () => {
    const actualBounds = { x: 1570, y: 803, width: 181, height: 221 };
    const value = realAuthorityFixture({
      blocked: () => true,
      initialBounds: { x: 0, y: 0, width: 181, height: 221 },
      initialViewport: { x: 20, y: 10, width: 158, height: 194 },
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'ready' as const,
        placement: null
      }),
      actualBounds: () => actualBounds,
      actualViewport: () => ({ x: 20, y: 10, width: 158, height: 194 })
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });

    const snapshot = value.authority.getSnapshot();
    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);
    expect(snapshot?.windowBoundsDip).toEqual(actualBounds);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: snapshot?.footAnchorDip
    }));
  });

  test('初始化在途收到 latest viewport 时在首次提交后 dirty settle 且不被 no-op initialize 吞掉', async () => {
    let releaseState!: () => void;
    const stateGate = new Promise<void>(resolve => { releaseState = resolve; });
    const getPetPlacementState = vi.fn(async () => {
      await stateGate;
      return {
        kind: 'ready' as const,
        placement: {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      };
    });
    const value = realAuthorityFixture({ getPetPlacementState });
    const initializing = value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    await Promise.resolve();
    const latest = value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 }
    });
    releaseState();

    await Promise.all([initializing, latest]);

    const snapshot = value.authority.getSnapshot();
    expect(snapshot?.revision).toBe(2);
    expect(value.authority.getShapeLayout(snapshot!.revision)?.viewportSizeDip)
      .toEqual({ width: 158, height: 194 });
    expect(value.savePetPlacement).toHaveBeenCalledTimes(2);
    expect(value.publishRenderView).toHaveBeenCalledTimes(2);
  });

  test('freezeAndFlush 遇 viewportDirty+placementDirty 时先 settle/adopt 再保存最终拖拽', async () => {
    let blocked = false;
    const value = realAuthorityFixture({ blocked: () => blocked });
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 } });
    blocked = true;
    value.setCurrentBounds({ x: 520, y: 310, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    await value.coordinator.commitViewport({ viewportInWindowDip: { x: 20, y: 10, width: 158, height: 194 } });
    await expect(value.coordinator.freezeAndFlush()).resolves.toBeUndefined();
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual({ x: 520, y: 310, width: 180, height: 220 });
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: value.authority.getSnapshot()?.footAnchorDip
    }));
  });


  test('用户 move 落盘失败回滚 authority、保留实际窗口并允许 dirty 重试', async () => {
    const savePetPlacement = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('WRITE_FAILED'))
      .mockResolvedValue(undefined);
    const value = realAuthorityFixture({ savePetPlacement });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const oldSnapshot = value.authority.getSnapshot();
    const draggedBounds = { x: 520, y: 320, width: 180, height: 220 };
    value.setCurrentBounds(draggedBounds);
    value.coordinator.handleWindowMoved();

    await expect(value.coordinator.resumePendingLayout()).rejects.toThrow('WRITE_FAILED');
    expect(value.authority.getSnapshot()).toEqual(oldSnapshot);
    expect(value.getBounds()).toEqual(draggedBounds);

    await value.coordinator.resumePendingLayout();
    expect(value.authority.getSnapshot()?.windowBoundsDip).toEqual(draggedBounds);
    expect(savePetPlacement).toHaveBeenCalledTimes(3);
  });

  test('用户 move 到负坐标副屏时按实际窗口相交区域切换 display', async () => {
    const value = realAuthorityFixture({
      displays: [
        { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } },
        { id: 'display-2', workAreaDip: { x: -1280, y: -200, width: 1280, height: 1024 } }
      ]
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    value.setCurrentBounds({ x: -640, y: 180, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();

    await value.coordinator.resumePendingLayout();

    expect(value.authority.getSnapshot()).toMatchObject({
      displayId: 'display-2', windowBoundsDip: { x: -640, y: 180 }
    });
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      displayId: 'display-2'
    }));
  });

  test('跨屏 move 同时发生 viewport settle 时按最终视觉脚底切换 display', async () => {
    let blocked = false;
    const value = realAuthorityFixture({
      blocked: () => blocked,
      displays: [
        { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } },
        { id: 'display-2', workAreaDip: { x: -1280, y: -200, width: 1280, height: 1024 } }
      ]
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    value.setCurrentBounds({ x: -640, y: 180, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 159, height: 194 }
    });
    blocked = false;

    await value.coordinator.resumePendingLayout();

    expect(value.authority.getSnapshot()).toMatchObject({
      displayId: 'display-2', windowBoundsDip: { x: -640, y: 180 }
    });
  });


  test.each(['成功', '失败'] as const)(
    '无 viewport waiter 的持久化%s前整个 FIFO 仍标记布局进行中',
    async outcome => {
      let settleSave!: () => void;
      let rejectSave!: (error: Error) => void;
      const pendingSave = new Promise<void>((resolve, reject) => {
        settleSave = resolve;
        rejectSave = reject;
      });
      const savePetPlacement = vi.fn().mockResolvedValue(undefined);
      const value = realAuthorityFixture({
        savePetPlacement,
        setTimeout: vi.fn(() => 1 as never) as unknown as typeof globalThis.setTimeout
      });
      await value.coordinator.commitViewport({
        viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
      });
      savePetPlacement.mockImplementationOnce(() => pendingSave);
      value.setCurrentBounds({ x: 320, y: 220, width: 180, height: 220 });
      value.coordinator.handleWindowMoved();

      const operation = value.coordinator.resumePendingLayout();
      await vi.waitFor(() => expect(savePetPlacement).toHaveBeenCalledTimes(2));
      expect(value.coordinator.isLayoutInFlight()).toBe(true);

      if (outcome === '成功') {
        settleSave();
        await expect(operation).resolves.toBeUndefined();
      } else {
        rejectSave(new Error('WRITE_FAILED'));
        await expect(operation).rejects.toThrow('WRITE_FAILED');
      }
      expect(value.coordinator.isLayoutInFlight()).toBe(false);
    }
  );


  test('自动运动到达终点后 idle binding 采用实际终点脚底而不回拉', async () => {
    let blocked = false;
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({
      blocked: () => blocked,
      userMoving: () => false,
      getBinding: () => binding
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    value.setCurrentBounds({ x: 400, y: 200, width: 180, height: 220 });
    binding = { ...binding, generation: 2, manifest: realManifest(0.4), actionRevision: 4 };
    await value.coordinator.refreshBinding();

    value.setCurrentBounds({ x: 700, y: 200, width: 180, height: 220 });
    blocked = false;
    binding = { ...binding, generation: 3, manifest: realManifest(), actionRevision: 5 };
    await value.coordinator.refreshBinding();

    expect(value.authority.getSnapshot()?.footAnchorDip.x).toBeCloseTo(783.2);
    expect(value.authority.getSnapshot()?.footAnchorDip.y).toBeCloseTo(387.2);
  });

  test('拖拽期间积压的 binding 在释放后采用最终实际脚底', async () => {
    let blocked = false;
    let userMoving = false;
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({
      blocked: () => blocked,
      userMoving: () => userMoving,
      getBinding: () => binding
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    userMoving = true;
    value.setCurrentBounds({ x: 700, y: 200, width: 180, height: 220 });
    binding = { ...binding, generation: 2, manifest: realManifest(0.4), actionRevision: 4 };
    await value.coordinator.refreshBinding();

    userMoving = false;
    blocked = false;
    await value.coordinator.resumePendingLayout();

    expect(value.authority.getSnapshot()?.footAnchorDip.x).toBeCloseTo(799);
    expect(value.authority.getSnapshot()?.footAnchorDip.y).toBeCloseTo(387.2);
  });

  test('小数动作几何贴右下边时先向内整数化窗口原点', async () => {
    const value = realAuthorityFixture({
      displays: [{ id: 'display-1', workAreaDip: { x: 0, y: 0, width: 400, height: 400 } }],
      actualBounds: candidate => ({
        ...candidate,
        x: Math.round(candidate.x),
        y: Math.round(candidate.y)
      })
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });

    const snapshot = value.authority.getSnapshot()!;
    expect(Number.isInteger(snapshot.windowBoundsDip.x)).toBe(true);
    expect(Number.isInteger(snapshot.windowBoundsDip.y)).toBe(true);
    expect(snapshot.windowBoundsDip.x + snapshot.visualBoundsInWindowDip.x
      + snapshot.visualBoundsInWindowDip.width).toBeLessThanOrEqual(400);
    expect(snapshot.windowBoundsDip.y + snapshot.visualBoundsInWindowDip.y
      + snapshot.visualBoundsInWindowDip.height).toBeLessThanOrEqual(400);
  });

  test('脚底位于屏间隙时按视觉交集选屏而不受透明窗口交集误导', async () => {
    let blocked = false;
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({
      blocked: () => blocked,
      userMoving: () => false,
      getBinding: () => binding,
      displays: [
        { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 400, height: 800 } },
        { id: 'display-2', workAreaDip: { x: 450, y: 0, width: 400, height: 800 } }
      ]
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    // 脚底 x=430 落在间隙；透明窗口与左屏交集更大，但可见矩形与右屏交集更大。
    value.setCurrentBounds({ x: 331, y: 200, width: 180, height: 220 });
    binding = { ...binding, generation: 2, manifest: realManifest(0.4), actionRevision: 4 };

    await value.coordinator.refreshBinding();

    expect(value.authority.getSnapshot()?.displayId).toBe('display-2');
  });

  test('binding 刷新仅发生原点量化且无 viewport 事件时保存 actual 并自行 settled', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({
      getBinding: () => binding,
      actualBounds: candidate => ({ ...candidate, x: Math.round(candidate.x) }),
      actualViewport: () => null
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    binding = { ...binding, generation: 2, manifest: realManifest(0.503), actionRevision: 4 };

    await value.coordinator.refreshBinding();

    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
      footAnchorDip: value.authority.getSnapshot()?.footAnchorDip
    }));
  });

  test('binding 刷新在布局 blocked 时只保留 latest，释放后进入同一 FIFO', async () => {
    let blocked = false;
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const value = realAuthorityFixture({
      blocked: () => blocked,
      userMoving: () => blocked,
      getBinding: () => binding
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    const oldRevision = value.authority.getSnapshot()!.revision;
    const oldSaves = value.savePetPlacement.mock.calls.length;
    blocked = true;
    binding = { ...binding, generation: 2, manifest: realManifest(0.4), actionRevision: 4 };

    await value.coordinator.refreshBinding();
    binding = { ...binding, generation: 3, manifest: realManifest(0.3), actionRevision: 5 };
    await value.coordinator.refreshBinding();
    expect(value.authority.getSnapshot()?.revision).toBe(oldRevision);
    expect(value.savePetPlacement).toHaveBeenCalledTimes(oldSaves);

    blocked = false;
    await value.coordinator.resumePendingLayout();
    expect(value.authority.getSnapshot()!.revision).toBeGreaterThan(oldRevision);
    expect(value.savePetPlacement).toHaveBeenCalledTimes(oldSaves + 1);
    expect(value.authority.getShapeLayout(value.authority.getSnapshot()!.revision)
      ?.footOffsetInViewportDip.x).toBeCloseTo(47.4);
  });


  test('settle 候选与 actual 跨屏时按 actual bounds 和当前脚底重选 display', async () => {
    let blocked = false;
    let quantizeAcrossDisplay = false;
    const value = realAuthorityFixture({
      blocked: () => blocked,
      displays: [
        { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } },
        { id: 'display-2', workAreaDip: { x: -1280, y: -200, width: 1280, height: 1024 } }
      ],
      actualBounds: candidate => {
        if (!quantizeAcrossDisplay) return candidate;
        quantizeAcrossDisplay = false;
        return { ...candidate, x: -640, y: 180 };
      },
      actualViewport: (_candidate, previous) => previous
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    value.coordinator.handleWindowMoved();
    await value.coordinator.resumePendingLayout();
    quantizeAcrossDisplay = true;
    blocked = true;
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 21, y: 10, width: 159, height: 194 }
    });
    blocked = false;

    await value.coordinator.resumePendingLayout();

    expect(value.authority.getSnapshot()).toMatchObject({
      displayId: 'display-2', windowBoundsDip: { x: -640, y: 180 }
    });
  });

  test('applyLayout 候选与 actual 跨屏时按 actual bounds 和当前脚底重选 display', async () => {
    let quantizeAcrossDisplay = true;
    const value = realAuthorityFixture({
      displays: [
        { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } },
        { id: 'display-2', workAreaDip: { x: -1280, y: -200, width: 1280, height: 1024 } }
      ],
      getPetPlacementState: vi.fn().mockResolvedValue({
        kind: 'pending-legacy' as const,
        windowPosition: { x: 500, y: 300 }
      }),
      actualBounds: candidate => {
        if (!quantizeAcrossDisplay) return candidate;
        quantizeAcrossDisplay = false;
        return { ...candidate, x: -640, y: 180 };
      },
      actualViewport: (_candidate, previous) => previous
    });

    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });

    expect(value.authority.getSnapshot()).toMatchObject({
      displayId: 'display-2', windowBoundsDip: { x: -640, y: 180 }
    });
  });

  test('dirty 与角色切换并存时先应用新角色 placement，不能把旧角色脚底写给新角色', async () => {
    let blocked = false;
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const petBPlacement = {
      characterId: 'pet-b', scale: 1,
      footAnchorDip: { x: 800, y: 600 }, displayId: 'display-1'
    };
    const getPetPlacementState = vi.fn(async (characterId: string) => ({
      kind: 'ready' as const,
      placement: characterId === 'pet-b' ? petBPlacement : {
        characterId: 'pet-a', scale: 1,
        footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
      }
    }));
    const value = realAuthorityFixture({
      blocked: () => blocked,
      getBinding: () => binding,
      getPetPlacementState
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    blocked = true;
    value.setCurrentBounds({ x: 520, y: 320, width: 180, height: 220 });
    value.coordinator.handleWindowMoved();
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 159, height: 194 }
    });
    binding = {
      ...binding,
      generation: 2,
      manifest: realManifest(0.5, 'pet-b'),
      actionRevision: 4
    };
    await value.coordinator.refreshBinding();
    blocked = false;

    await value.coordinator.resumePendingLayout();

    expect(getPetPlacementState).toHaveBeenCalledWith('pet-b');
    expect(value.authority.getSnapshot()).toMatchObject({
      characterId: 'pet-b', footAnchorDip: petBPlacement.footAnchorDip
    });
    expect(value.savePetPlacement).not.toHaveBeenCalledWith(expect.objectContaining({
      characterId: 'pet-b', footAnchorDip: { x: 619, y: 507.2 }
    }));
  });


  test('角色切换到已有 placement 时保留目标脚底但尺寸固定为 100%', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const petBPlacement = {
      characterId: 'pet-b', scale: 1.3,
      footAnchorDip: { x: 800, y: 600 }, displayId: 'display-1'
    };
    const value = realAuthorityFixture({
      getBinding: () => binding,
      getPetPlacementState: vi.fn(async (characterId: string) => ({
        kind: 'ready' as const,
        placement: characterId === 'pet-b' ? petBPlacement : {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      }))
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    binding = {
      ...binding,
      generation: 2,
      manifest: realManifest(0.5, 'pet-b'),
      actionRevision: 4
    };

    await value.coordinator.refreshBinding();

    expect(value.authority.getSnapshot()).toMatchObject({
      characterId: 'pet-b', scale: 1, footAnchorDip: petBPlacement.footAnchorDip
    });
    expect(value.coordinator.inspectRelativeGeometry()?.scaleTick).toBe(10);
  });






  test('角色切换 ready placement 遇一次 bounds 量化且无 viewport 事件时自行 settled', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    let quantizeOnce = false;
    const petBPlacement = {
      characterId: 'pet-b', scale: 1,
      footAnchorDip: { x: 800.5, y: 600.2 }, displayId: 'display-1'
    };
    const value = realAuthorityFixture({
      getBinding: () => binding,
      getPetPlacementState: vi.fn(async (characterId: string) => ({
        kind: 'ready' as const,
        placement: characterId === 'pet-b' ? petBPlacement : {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      })),
      actualBounds: candidate => {
        if (!quantizeOnce) return candidate;
        quantizeOnce = false;
        return { ...candidate, x: Math.ceil(candidate.x) };
      },
      actualViewport: () => null
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    binding = { ...binding, generation: 2, manifest: realManifest(0.5, 'pet-b'), actionRevision: 4 };
    quantizeOnce = true;

    await value.coordinator.refreshBinding();

    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);
    expect(value.authority.getSnapshot()).toMatchObject({
      characterId: 'pet-b', footAnchorDip: petBPlacement.footAnchorDip
    });
  });




  test('角色 ready 持续量化在单轴 0.5 DIP 内采纳 actual 并同步 settled', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const desired = {
      characterId: 'pet-b', scale: 1,
      footAnchorDip: { x: 800.5, y: 600.2 }, displayId: 'display-1'
    };
    const value = realAuthorityFixture({
      getBinding: () => binding,
      getPetPlacementState: vi.fn(async (characterId: string) => ({
        kind: 'ready' as const,
        placement: characterId === 'pet-b' ? desired : {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      })),
      actualBounds: candidate => ({ ...candidate, x: Math.round(candidate.x) }),
      actualViewport: () => null
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    binding = { ...binding, generation: 2, manifest: realManifest(0.5, 'pet-b'), actionRevision: 4 };

    await value.coordinator.refreshBinding();

    const snapshot = value.authority.getSnapshot()!;
    expect(Math.abs(snapshot.footAnchorDip.x - desired.footAnchorDip.x)).toBeLessThanOrEqual(0.5);
    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(true);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(placementFromTestSnapshot(snapshot));
  });


  test('持续量化误差超过 0.5 DIP 时保留 desired 且有界停止不忙循环', async () => {
    let binding: CharacterGeometryBinding = {
      generation: 1, manifest: realManifest(), skinId: 'default-skin',
      actionId: 'idle-action', actionRevision: 3,
      resourceRevision: RESOURCE_REVISION, direction: 'right'
    };
    const desired = {
      characterId: 'pet-b', scale: 1,
      footAnchorDip: { x: 800, y: 600 }, displayId: 'display-1'
    };
    const value = realAuthorityFixture({
      getBinding: () => binding,
      getPetPlacementState: vi.fn(async (characterId: string) => ({
        kind: 'ready' as const,
        placement: characterId === 'pet-b' ? desired : {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 399, y: 387.2 }, displayId: 'display-1'
        }
      })),
      actualBounds: candidate => ({ ...candidate, x: candidate.x + 1 }),
      actualViewport: () => null
    });
    await value.coordinator.commitViewport({
      viewportInWindowDip: { x: 20, y: 10, width: 158, height: 193 }
    });
    binding = { ...binding, generation: 2, manifest: realManifest(0.5, 'pet-b'), actionRevision: 4 };
    const baselineCalls = value.setBounds.mock.calls.length;

    await value.coordinator.refreshBinding();

    expect(value.coordinator.inspectRelativeGeometry()?.settled).toBe(false);
    expect(value.savePetPlacement).toHaveBeenLastCalledWith(desired);
    expect(value.setBounds.mock.calls.length - baselineCalls).toBe(2);
  });


});

function placementFromTestSnapshot(snapshot: NonNullable<ReturnType<PetVisualGeometryAuthority['getSnapshot']>>) {
  return {
    characterId: snapshot.characterId,
    scale: snapshot.scale,
    footAnchorDip: snapshot.footAnchorDip,
    displayId: snapshot.displayId
  };
}
