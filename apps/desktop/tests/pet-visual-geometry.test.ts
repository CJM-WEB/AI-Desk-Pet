import { characterManifestV2Schema, type CharacterManifestV2 } from '@myself/character-runtime';
import { describe, expect, test } from 'vitest';
import {
  PetVisualGeometryAuthority as ProductionPetVisualGeometryAuthority,
  type PetGeometryUpdateResult,
  unionVisiblePresentationBounds
} from '../src/main/characters/pet-visual-geometry';
import {
  fitCharacterFrames,
  resolveDirectionalAnchor
} from '../src/renderer/src/characters/player/pixi-character-player';

const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);

function manifest(id = 'pet-a'): CharacterManifestV2 {
  return characterManifestV2Schema.parse({
    version: 2,
    id,
    name: '几何测试角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '几何测试角色', background: '测试背景', traits: [], languageStyle: '简洁',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default-skin',
    defaultStateId: 'idle-state',
    states: [{
      id: 'idle-state', name: '待机', kind: 'primary', semantic: 'idle', tags: [], intensity: 1,
      coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [], exitConditions: [],
      agentInferable: true, actionIds: ['idle-action', 'move-action']
    }],
    actions: [
      {
        id: 'idle-action', name: '待机动作', semantic: 'idle', tags: [], preference: 1,
        cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
        allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
        forbiddenModifierStateIds: [], direction: 'any'
      },
      {
        id: 'move-action', name: '移动动作', semantic: 'move', tags: [], preference: 1,
        cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
        allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
        forbiddenModifierStateIds: [], direction: 'left'
      }
    ],
    skins: [{
      id: 'default-skin', name: '默认皮肤', semanticFallbacks: [],
      presentations: [
        {
          actionId: 'idle-action', fps: 12,
          frames: [{ assetId: 'idle-asset', x: 0, y: 0, width: 100, height: 100 }],
          anchors: { ground: { x: 0.5, y: 0.9 } },
          geometry: {
            visualBounds: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
            groundAnchor: { x: 0.5, y: 0.9 }, resourceRevision: REVISION_A
          }
        },
        {
          actionId: 'move-action', fps: 12,
          frames: [{ assetId: 'move-asset', x: 0, y: 0, width: 100, height: 100 }],
          anchors: { ground: { x: 0.4, y: 0.95 } },
          geometry: {
            visualBounds: { x: 0.1, y: 0.2, width: 0.7, height: 0.75 },
            groundAnchor: { x: 0.4, y: 0.95 }, resourceRevision: REVISION_B
          }
        }
      ]
    }],
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: REVISION_A, byteLength: 1 },
      { assetId: 'idle-asset', fileName: 'idle.png', sha256: REVISION_A, byteLength: 1 },
      { assetId: 'move-asset', fileName: 'move.png', sha256: REVISION_B, byteLength: 1 }
    ]
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    manifest: manifest(),
    skinId: 'default-skin',
    actionId: 'idle-action',
    actionRevision: 3,
    resourceRevision: REVISION_A,
    direction: 'right',
    scale: 1,
    viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
    windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
    display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } },
    ...overrides
  };
}

/** 仅供既有断言组合正式双端口；生产类不保留会深解析 Manifest 的 update 别名。 */
class PetVisualGeometryAuthority extends ProductionPetVisualGeometryAuthority {
  update(candidate: unknown, activeCharacterId?: string): PetGeometryUpdateResult {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return this.updateShape(candidate, activeCharacterId) as PetGeometryUpdateResult;
    }
    const {
      viewportInWindowDip, windowBoundsDip, display, ...shapeCandidate
    } = candidate as Record<string, unknown>;
    const viewport = viewportInWindowDip as Record<string, unknown> | undefined;
    const shape = this.updateShape({
      ...shapeCandidate,
      viewportSizeDip: { width: viewport?.width, height: viewport?.height }
    }, activeCharacterId);
    if (!shape.ok) return shape;
    return this.updatePlacement({
      baseRevision: shape.revision,
      viewportInWindowDip,
      windowBoundsDip,
      display
    });
  }
}

describe('Main 私有桌宠视觉几何权威', () => {
  test('shape 与 placement 分口，placement 不解析清单且绑定当前 base revision 和 viewport size', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.updatePlacement({
      baseRevision: 1,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_SHAPE_MISSING' });

    const shape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 3, resourceRevision: REVISION_A, direction: 'right', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    expect(shape).toEqual({ ok: true, revision: 1 });
    expect(authority.getShapeLayout(1)).toEqual({
      revision: 1,
      characterId: 'pet-a',
      scale: 1,
      viewportSizeDip: { width: 100, height: 100 },
      footOffsetInViewportDip: { x: 50, y: 90 },
      visualBoundsFromFootDip: { x: -30, y: -80, width: 60, height: 80 }
    });
    expect(authority.updatePlacement({
      baseRevision: 0,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_BASE_REVISION_STALE' });
    expect(authority.updatePlacement({
      baseRevision: 1,
      viewportInWindowDip: { x: 20, y: 10, width: 120, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_VIEWPORT_SIZE_MISMATCH' });
    expect(authority.getSnapshot()).toBeNull();
    expect(authority.updatePlacement({
      baseRevision: 1,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toMatchObject({
      ok: true,
      snapshot: { revision: 1, footAnchorDip: { x: 370, y: 300 } }
    });
  });

  test('pending placement 失败不污染 active，旧 revision 和动作绑定仍可继续使用', () => {
    const authority = new ProductionPetVisualGeometryAuthority('pet-a');
    const shape1 = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 3, resourceRevision: REVISION_A, direction: 'right', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    expect(shape1).toEqual({ ok: true, revision: 1 });
    const placement = (baseRevision: number, x = 300) => ({
      baseRevision,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    });
    expect(authority.updatePlacement(placement(1))).toMatchObject({
      ok: true, snapshot: { revision: 1, characterId: 'pet-a' }
    });
    const committed = authority.getSnapshot();

    const shape2 = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'move-action',
      actionRevision: 4, resourceRevision: REVISION_B, direction: 'left', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    expect(shape2).toEqual({ ok: true, revision: 2 });
    expect(authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'move-action',
      actionRevision: 4, resourceRevision: REVISION_B, direction: 'left', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    })).toEqual({ ok: true, revision: 2 });
    expect(authority.getSnapshot()).toEqual(committed);
    expect(authority.updatePlacement({
      ...placement(2),
      display: { id: 'wrong-display', workAreaDip: { x: -1920, y: 0, width: 1920, height: 1040 } }
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_DISPLAY_INVALID' });
    expect(authority.getSnapshot()).toEqual(committed);

    expect(authority.updatePlacement(placement(1, 360))).toMatchObject({
      ok: true,
      snapshot: { revision: 1, characterId: 'pet-a', windowBoundsDip: { x: 360 } }
    });
    authority.discardPendingShape();
    authority.discardPendingShape();
    expect(authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 3, resourceRevision: REVISION_A, direction: 'right', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    })).toEqual({ ok: true, revision: 1 });
    expect(authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 4, resourceRevision: REVISION_A, direction: 'right', scale: 1.5,
      viewportSizeDip: { width: 100, height: 100 }
    })).toEqual({ ok: true, revision: 3 });
  });

  test('placement 事务提交后仍可回滚到旧 active 快照，成功收口后旧 token 失效', () => {
    const authority = new ProductionPetVisualGeometryAuthority('pet-a');
    const firstShape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 3, resourceRevision: REVISION_A, direction: 'right', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    if (!firstShape.ok) throw new Error('测试前置条件要求 shape 成功');
    const first = authority.updatePlacement({
      baseRevision: firstShape.revision,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    });
    if (!first.ok) throw new Error('测试前置条件要求 placement 成功');

    const secondShape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 4, resourceRevision: REVISION_A, direction: 'right', scale: 1.1,
      viewportSizeDip: { width: 110, height: 110 }
    });
    if (!secondShape.ok) throw new Error('测试前置条件要求新 shape 成功');
    const prepared = authority.preparePlacement({
      baseRevision: secondShape.revision,
      viewportInWindowDip: { x: 20, y: 10, width: 110, height: 110 },
      windowBoundsDip: { x: 295, y: 191, width: 198, height: 242 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    });
    if (!prepared.ok) throw new Error('测试前置条件要求预演成功');
    expect(authority.getSnapshot()).toEqual(first.snapshot);
    expect(authority.commitPreparedPlacement({
      token: prepared.token,
      baseRevision: secondShape.revision
    })).toMatchObject({ ok: true, snapshot: { revision: secondShape.revision, scale: 1.1 } });
    expect(authority.commitPreparedPlacement({
      token: prepared.token,
      baseRevision: secondShape.revision
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_TRANSACTION_ALREADY_COMMITTED' });
    expect(authority.rollbackPreparedPlacement({
      token: prepared.token,
      baseRevision: secondShape.revision
    })).toEqual({ ok: true });
    expect(authority.getSnapshot()).toEqual(first.snapshot);
    expect(authority.commitPreparedPlacement({
      token: prepared.token,
      baseRevision: secondShape.revision
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_TRANSACTION_STALE' });

    expect(authority.getShapeLayout(secondShape.revision)).toBeNull();
    const retryShape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 4, resourceRevision: REVISION_A, direction: 'right', scale: 1.1,
      viewportSizeDip: { width: 110, height: 110 }
    });
    expect(retryShape).toEqual({ ok: true, revision: 3 });
    if (!retryShape.ok) throw new Error('测试前置条件要求重试 shape 成功');
    const retry = authority.preparePlacement({
      baseRevision: retryShape.revision,
      viewportInWindowDip: { x: 20, y: 10, width: 110, height: 110 },
      windowBoundsDip: { x: 295, y: 191, width: 198, height: 242 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    });
    if (!retry.ok) throw new Error('测试前置条件要求重试预演成功');
    expect(authority.commitPreparedPlacement({
      token: retry.token,
      baseRevision: firstShape.revision
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_TRANSACTION_REVISION_MISMATCH' });
    expect(authority.commitPreparedPlacement({
      token: retry.token,
      baseRevision: retryShape.revision
    }).ok).toBe(true);
    expect(authority.discardPreparedPlacement({
      token: retry.token,
      baseRevision: retryShape.revision
    })).toEqual({ ok: true });
    expect(authority.rollbackPreparedPlacement({
      token: retry.token,
      baseRevision: retryShape.revision
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_TRANSACTION_STALE' });
  });

  test('G4 可在提交 placement 前读取 pending 形状且失败丢弃后保留旧 active', () => {
    const authority = new ProductionPetVisualGeometryAuthority('pet-a');
    const activeShape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'idle-action',
      actionRevision: 3, resourceRevision: REVISION_A, direction: 'right', scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    expect(activeShape).toEqual({ ok: true, revision: 1 });
    expect(authority.updatePlacement({
      baseRevision: 1,
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    const committed = authority.getSnapshot();

    const pendingShape = authority.updateShape({
      manifest: manifest(), skinId: 'default-skin', actionId: 'move-action',
      actionRevision: 4, resourceRevision: REVISION_B, direction: 'left', scale: 1.5,
      viewportSizeDip: { width: 150, height: 120 }
    });
    expect(pendingShape).toEqual({ ok: true, revision: 2 });
    const layout = authority.getShapeLayout(2);
    expect(layout).toMatchObject({
      revision: 2,
      characterId: 'pet-a',
      scale: 1.5,
      viewportSizeDip: { width: 150, height: 120 },
      footOffsetInViewportDip: { x: 75, y: 114 },
      visualBoundsFromFootDip: { y: -90, width: 84, height: 90 }
    });
    expect(layout?.visualBoundsFromFootDip.x).toBeCloseTo(-48);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout?.footOffsetInViewportDip)).toBe(true);
    expect(Object.isFrozen(layout?.viewportSizeDip)).toBe(true);
    expect(Object.isFrozen(layout?.visualBoundsFromFootDip)).toBe(true);
    expect(authority.getShapeLayout(2)).not.toBe(layout);
    expect(authority.getShapeLayout(1)?.revision).toBe(1);
    expect(authority.getSnapshot()).toEqual(committed);

    expect(authority.updatePlacement({
      baseRevision: 2,
      viewportInWindowDip: { x: 10, y: 10, width: 150, height: 120 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      display: { id: 'wrong-display', workAreaDip: { x: -1920, y: 0, width: 1920, height: 1040 } }
    })).toEqual({ ok: false, code: 'PET_GEOMETRY_DISPLAY_INVALID' });
    authority.discardPendingShape();

    expect(authority.getShapeLayout(2)).toBeNull();
    expect(authority.getShapeLayout(1)).toEqual({
      revision: 1,
      characterId: 'pet-a',
      scale: 1,
      viewportSizeDip: { width: 100, height: 100 },
      footOffsetInViewportDip: { x: 50, y: 90 },
      visualBoundsFromFootDip: { x: -30, y: -80, width: 60, height: 80 }
    });
    expect(authority.getShapeLayout(999)).toBeNull();
    expect(authority.getSnapshot()).toEqual(committed);
    expect(authority.updatePlacement({
      baseRevision: 1,
      viewportInWindowDip: { x: 30, y: 20, width: 100, height: 100 },
      windowBoundsDip: { x: 360, y: 240, width: 180, height: 220 },
      display: { id: 'display-1', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    })).toMatchObject({ ok: true, snapshot: { revision: 1, windowBoundsDip: { x: 360 } } });
  });

  test('从正式清单的当前单一表现计算窗口内视觉矩形和全局脚底锚点', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const result = authority.update(input());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('测试前置条件要求更新成功');
    expect(result.snapshot).toMatchObject({
      revision: 1,
      characterId: 'pet-a',
      scale: 1,
      footAnchorDip: { x: 370, y: 300 },
      windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 },
      displayId: 'display-1'
    });
    expect(result.snapshot.visualBoundsInWindowDip.x).toBeCloseTo(40);
    expect(result.snapshot.visualBoundsInWindowDip.y).toBeCloseTo(20);
    expect(result.snapshot.visualBoundsInWindowDip.width).toBeCloseTo(60);
    expect(result.snapshot.visualBoundsInWindowDip.height).toBeCloseTo(80);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.footAnchorDip)).toBe(true);
  });

  test('按播放器的统一等比适配计算非方形表现，不把 viewport 强行拉伸为素材画布', () => {
    const wideManifest = structuredClone(manifest());
    wideManifest.skins[0]!.presentations[0]!.frames[0]!.width = 200;
    const authority = new PetVisualGeometryAuthority('pet-a');
    const result = authority.update(input({ manifest: wideManifest }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('测试前置条件要求更新成功');
    expect(result.snapshot.footAnchorDip.y).toBeCloseTo(305);
    expect(result.snapshot.visualBoundsInWindowDip).toMatchObject({ x: 40 });
    expect(result.snapshot.visualBoundsInWindowDip.y).toBeCloseTo(65);
    expect(result.snapshot.visualBoundsInWindowDip.width).toBeCloseTo(60);
    expect(result.snapshot.visualBoundsInWindowDip.height).toBeCloseTo(40);
    const rendererFit = fitCharacterFrames(
      wideManifest.skins[0]!.presentations[0]!.frames,
      { width: 100, height: 100 },
      { x: 0.5, y: 0.9 }
    );
    expect(result.snapshot.footAnchorDip).toEqual({
      x: 300 + 20 + rendererFit.x,
      y: 200 + 10 + rendererFit.y
    });
  });

  test('纯联合 seam 按共同脚底锚点合并多输入，生产更新仍拒绝伪造可见集合', () => {
    const union = unionVisiblePresentationBounds([
      { x: -30, y: -80, width: 60, height: 80 },
      { x: -20, y: -50, width: 30, height: 50 }
    ]);
    expect(union).toEqual({ x: -30, y: -80, width: 60, height: 80 });
    expect(() => unionVisiblePresentationBounds([{
      x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1
    }])).toThrow('PET_GEOMETRY_VISIBLE_SET_INVALID');

    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input({ visiblePresentationIds: ['idle-action', 'move-action'] })))
      .toEqual({ ok: false, code: 'PET_GEOMETRY_INPUT_INVALID' });
    expect(authority.update(input({ modifierStateIds: [] })))
      .toEqual({ ok: false, code: 'PET_GEOMETRY_INPUT_INVALID' });
  });

  test('相同形状更新和 placement 只重算位置', () => {
    const animatedManifest = manifest();
    const frames = animatedManifest.skins[0]!.presentations[0]!.frames;
    frames.push({ ...frames[0]! }, { ...frames[0]! });
    const authority = new PetVisualGeometryAuthority('pet-a');
    const first = authority.update(input({ manifest: animatedManifest }));
    const repeated = authority.update(input({ manifest: animatedManifest, actionRevision: 4 }));
    const placement = authority.update(input({
      manifest: animatedManifest,
      actionRevision: 5,
      viewportInWindowDip: { x: 30, y: 15, width: 100, height: 100 },
      windowBoundsDip: { x: -400, y: 250, width: 180, height: 220 },
      display: { id: 'display-2', workAreaDip: { x: -1920, y: 0, width: 1920, height: 1040 } }
    }));
    const scaled = authority.update(input({ manifest: animatedManifest, actionRevision: 6, scale: 1.5 }));

    expect(first.ok && first.snapshot.revision).toBe(1);
    expect(repeated.ok && repeated.snapshot.revision).toBe(1);
    expect(placement.ok && placement.snapshot).toMatchObject({
      revision: 1, displayId: 'display-2', windowBoundsDip: { x: -400, y: 250 }
    });
    expect(scaled.ok && scaled.snapshot.revision).toBe(2);
  });

  test('动作、方向和 viewport 尺寸变化增加 revision，窗口内 offset 不增加', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input()).ok).toBe(true);
    const direction = authority.update(input({ actionRevision: 4, direction: 'left' }));
    const viewportSize = authority.update(input({
      actionRevision: 5,
      direction: 'left',
      viewportInWindowDip: { x: 20, y: 10, width: 120, height: 100 }
    }));
    const action = authority.update(input({
      actionId: 'move-action', actionRevision: 6, resourceRevision: REVISION_B,
      direction: 'left'
    }));

    expect(direction.ok && direction.snapshot.revision).toBe(2);
    expect(direction.ok && direction.snapshot.visualBoundsInWindowDip.x).toBeCloseTo(40);
    expect(viewportSize.ok && viewportSize.snapshot.revision).toBe(3);
    expect(action.ok && action.snapshot.revision).toBe(4);
  });

  test('Main 显式切换活动角色时保持 revision 单调，清单身份不匹配则拒绝', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input()).ok).toBe(true);
    expect(authority.update(input({ manifest: manifest('pet-b') }), 'pet-a')).toEqual({
      ok: false, code: 'PET_GEOMETRY_CHARACTER_MISMATCH'
    });
    const switched = authority.update(input({ manifest: manifest('pet-b') }), 'pet-b');
    expect(switched.ok && switched.snapshot).toMatchObject({ revision: 2, characterId: 'pet-b' });
  });

  test('同资源哈希下正式表现的裁切或几何变化仍建立新的形状 revision', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input()).ok).toBe(true);
    const changed = manifest();
    changed.skins[0]!.presentations[0]!.frames[0]!.width = 200;
    changed.skins[0]!.presentations[0]!.geometry.visualBounds = {
      x: 0.1, y: 0.1, width: 0.7, height: 0.8
    };
    const result = authority.update(input({ manifest: changed, actionRevision: 4 }));
    expect(result.ok && result.snapshot.revision).toBe(2);
  });

  test('viewport 是实际窗口局部矩形，scale 只改变持久状态和 shape revision', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const first = authority.update(input());
    const scaled = authority.update(input({ scale: 2, actionRevision: 4 }));
    expect(first.ok && scaled.ok).toBe(true);
    if (!first.ok || !scaled.ok) throw new Error('测试前置条件要求更新成功');
    expect(scaled.snapshot.revision).toBe(2);
    expect(scaled.snapshot.scale).toBe(2);
    expect(scaled.snapshot.footAnchorDip).toEqual(first.snapshot.footAnchorDip);
    expect(scaled.snapshot.visualBoundsInWindowDip).toEqual(first.snapshot.visualBoundsInWindowDip);
  });

  test('同一角色同一 actionRevision 绑定 skin/action/resource，冲突拒绝且不污染基线', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const first = authority.update(input());
    expect(first.ok).toBe(true);
    expect(authority.update(input({
      actionId: 'move-action', resourceRevision: REVISION_B, direction: 'left'
    }))).toEqual({ ok: false, code: 'PET_GEOMETRY_ACTION_REVISION_CONFLICT' });
    expect(authority.update(input({ resourceRevision: REVISION_B })))
      .toEqual({ ok: false, code: 'PET_GEOMETRY_ACTION_REVISION_CONFLICT' });
    const alternateSkin = manifest();
    alternateSkin.skins.push({ ...structuredClone(alternateSkin.skins[0]!), id: 'alternate-skin' });
    expect(authority.update(input({ manifest: alternateSkin, skinId: 'alternate-skin' })))
      .toEqual({ ok: false, code: 'PET_GEOMETRY_ACTION_REVISION_CONFLICT' });
    expect(authority.getSnapshot()).toEqual(first.ok ? first.snapshot : null);

    // direction 来自独立运动快照，不属于行为动作授权 revision 的绑定字段。
    const direction = authority.update(input({ direction: 'left' }));
    expect(direction.ok && direction.snapshot.revision).toBe(2);
  });

  test('显式切换角色重置 action revision 基线但保持 geometry revision 单调', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input({ actionRevision: 9 })).ok).toBe(true);
    const switched = authority.update(input({
      manifest: manifest('pet-b'), actionRevision: 0
    }), 'pet-b');
    expect(switched.ok && switched.snapshot).toMatchObject({ revision: 2, characterId: 'pet-b' });
  });

  test('窗口必须与含负坐标的 display 工作区正面积相交', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input({
      windowBoundsDip: { x: -600, y: 100, width: 180, height: 220 },
      display: { id: 'display-left', workAreaDip: { x: -1920, y: 0, width: 1920, height: 1040 } }
    })).ok).toBe(true);
    const valid = authority.getSnapshot();
    expect(authority.update(input({
      actionRevision: 4,
      windowBoundsDip: { x: 1920, y: 100, width: 180, height: 220 },
      display: { id: 'display-main', workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 } }
    }))).toEqual({ ok: false, code: 'PET_GEOMETRY_DISPLAY_INVALID' });
    expect(authority.getSnapshot()).toEqual(valid);
  });

  test('输入矩形边界溢出时返回稳定错误且保留最后有效快照', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const valid = authority.update(input());
    expect(valid.ok).toBe(true);
    expect(authority.update(input({
      actionRevision: 4,
      viewportInWindowDip: {
        x: Number.MAX_VALUE * 0.9, y: 0,
        width: Number.MAX_VALUE * 0.1, height: 100
      },
      windowBoundsDip: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 220 },
      display: {
        id: 'overflow-display',
        workAreaDip: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1040 }
      }
    }))).toEqual({ ok: false, code: 'PET_GEOMETRY_WINDOW_INVALID' });
    expect(authority.getSnapshot()).toEqual(valid.ok ? valid.snapshot : null);
  });

  test('ground 为零且最终 foot 有限时仍拒绝右边界溢出的 window/display', () => {
    const zeroGround = manifest();
    const presentation = zeroGround.skins[0]!.presentations[0]!;
    presentation.anchors.ground = { x: 0, y: 0 };
    presentation.geometry.groundAnchor = { x: 0, y: 0 };
    const authority = new PetVisualGeometryAuthority('pet-a');
    const valid = authority.update(input());
    expect(valid.ok).toBe(true);
    expect(authority.update(input({
      manifest: zeroGround,
      actionRevision: 4,
      viewportInWindowDip: { x: 0, y: 0, width: 100, height: 100 },
      windowBoundsDip: {
        x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 220
      },
      display: {
        id: 'overflow-display',
        workAreaDip: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1040 }
      }
    }))).toEqual({ ok: false, code: 'PET_GEOMETRY_WINDOW_INVALID' });
    expect(authority.getSnapshot()).toEqual(valid.ok ? valid.snapshot : null);
  });

  test('非对称视觉几何和脚底锚点按 viewport 水平镜像', () => {
    const asymmetric = manifest();
    const presentation = asymmetric.skins[0]!.presentations[0]!;
    presentation.anchors.ground = { x: 0.3, y: 0.9 };
    presentation.geometry.groundAnchor = { x: 0.3, y: 0.9 };
    presentation.geometry.visualBounds = { x: 0.1, y: 0.1, width: 0.4, height: 0.8 };
    const authority = new PetVisualGeometryAuthority('pet-a');
    const right = authority.update(input({ manifest: asymmetric }));
    const left = authority.update(input({ manifest: asymmetric, direction: 'left' }));
    expect(right.ok && left.ok).toBe(true);
    if (!right.ok || !left.ok) throw new Error('测试前置条件要求更新成功');
    expect(right.snapshot.footAnchorDip.x).toBeCloseTo(350);
    expect(left.snapshot.footAnchorDip.x).toBeCloseTo(390);
    expect(right.snapshot.visualBoundsInWindowDip.x).toBeCloseTo(30);
    expect(left.snapshot.visualBoundsInWindowDip.x).toBeCloseTo(70);
    expect(left.snapshot.visualBoundsInWindowDip.width)
      .toBeCloseTo(right.snapshot.visualBoundsInWindowDip.width);
    const frames = presentation.frames;
    const rightFit = fitCharacterFrames(frames, { width: 100, height: 100 }, { x: 0.3, y: 0.9 });
    const leftFit = fitCharacterFrames(
      frames,
      { width: 100, height: 100 },
      resolveDirectionalAnchor({ x: 0.3, y: 0.9 }, 'left')
    );
    expect(right.snapshot.footAnchorDip.x).toBeCloseTo(300 + 20 + rightFit.x);
    expect(left.snapshot.footAnchorDip.x).toBeCloseTo(300 + 20 + leftFit.x);
  });

  test.each([
    [input({ scale: 0.49 }), 'PET_GEOMETRY_SCALE_INVALID'],
    [input({ scale: 2.01 }), 'PET_GEOMETRY_SCALE_INVALID'],
    [input({ viewportInWindowDip: { x: 0, y: 0, width: Number.NaN, height: 10 } }), 'PET_GEOMETRY_VIEWPORT_INVALID'],
    [input({ viewportInWindowDip: { x: 100, y: 0, width: 100, height: 100 } }), 'PET_GEOMETRY_VIEWPORT_INVALID'],
    [input({ windowBoundsDip: { x: 0, y: 0, width: 0, height: 100 } }), 'PET_GEOMETRY_WINDOW_INVALID'],
    [input({ display: { id: '', workAreaDip: { x: 0, y: 0, width: 100, height: 100 } } }), 'PET_GEOMETRY_DISPLAY_INVALID'],
    [input({ actionId: 'unknown-action', actionRevision: 4 }), 'PET_GEOMETRY_ACTION_UNKNOWN'],
    [input({ frameIndex: 99 }), 'PET_GEOMETRY_INPUT_INVALID'],
    [input({ resourceRevision: REVISION_B, actionRevision: 4 }), 'PET_GEOMETRY_RESOURCE_REVISION_MISMATCH'],
    [input({
      actionId: 'move-action', resourceRevision: REVISION_B, direction: 'right', actionRevision: 4
    }), 'PET_GEOMETRY_DIRECTION_MISMATCH'],
    [input({ manifest: manifest('pet-b') }), 'PET_GEOMETRY_CHARACTER_MISMATCH']
  ])('拒绝非法更新并保留最后有效快照 %#', (candidate, code) => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const valid = authority.update(input());
    expect(valid.ok).toBe(true);
    expect(authority.update(candidate)).toEqual({ ok: false, code });
    expect(authority.getSnapshot()).toEqual(valid.ok ? valid.snapshot : null);
  });

  test('拒绝过期 action revision、非正式清单和额外伪造字段', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    expect(authority.update(input()).ok).toBe(true);
    expect(authority.update(input({ actionRevision: 2 }))).toEqual({
      ok: false, code: 'PET_GEOMETRY_ACTION_REVISION_STALE'
    });
    expect(authority.update(input({ actionRevision: Number.MAX_SAFE_INTEGER + 1 }))).toEqual({
      ok: false, code: 'PET_GEOMETRY_ACTION_REVISION_INVALID'
    });
    const missingGeometry = structuredClone(manifest()) as unknown as Record<string, unknown>;
    const skins = missingGeometry.skins as Array<{ presentations: Array<Record<string, unknown>> }>;
    Reflect.deleteProperty(skins[0]!.presentations[0]!, 'geometry');
    expect(authority.update(input({ manifest: missingGeometry }))).toEqual({
      ok: false, code: 'PET_GEOMETRY_MANIFEST_INVALID'
    });
    expect(authority.update(input({ finalGlobalVisualBounds: { x: 0, y: 0, width: 1, height: 1 } })))
      .toEqual({ ok: false, code: 'PET_GEOMETRY_INPUT_INVALID' });
  });

  test('返回值与内部快照隔离且深冻结', () => {
    const authority = new PetVisualGeometryAuthority('pet-a');
    const result = authority.update(input());
    if (!result.ok) throw new Error('测试前置条件要求更新成功');
    expect(() => { (result.snapshot.footAnchorDip as { x: number }).x = -1; }).toThrow();
    expect(authority.getSnapshot()?.footAnchorDip.x).toBe(370);
    expect(authority.getSnapshot()).not.toBe(result.snapshot);
  });
});
