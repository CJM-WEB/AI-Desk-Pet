import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { characterManifestV2Schema } from '@myself/character-runtime';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PetVisualGeometryAuthority } from '../src/main/characters/pet-visual-geometry';
import {
  migrateLegacyPetPosition,
  restorePetPlacement
} from '../src/main/windows/pet-position';
import type {
  PetPlacementGeometry,
  PetPlacementResult
} from '../src/main/windows/pet-position';
import {
  SettingsStore,
  storedPetPlacementSchema
} from '../src/main/storage/settings-store';

function expectSchemaValidSuccess(result: PetPlacementResult): PetPlacementResult & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(storedPetPlacementSchema.safeParse(result.placement).success).toBe(true);
  return result;
}

const GEOMETRY_RESOURCE_REVISION = 'a'.repeat(64);

function strictGeometryManifest() {
  return characterManifestV2Schema.parse({
    version: 2,
    id: 'character-a',
    name: '组合测试角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '组合测试角色',
      background: '测试背景',
      traits: [],
      languageStyle: '简洁',
      formsOfAddress: [],
      likes: [],
      dislikes: [],
      behavioralTendencies: [],
      boundaries: [],
      exampleLines: []
    },
    defaultSkinId: 'default-skin',
    defaultStateId: 'idle-state',
    states: [{
      id: 'idle-state',
      name: '待机',
      kind: 'primary',
      semantic: 'idle',
      tags: [],
      intensity: 1,
      coexistWithStateIds: [],
      forbiddenStateIds: [],
      enterConditions: [],
      exitConditions: [],
      agentInferable: true,
      actionIds: ['idle-action']
    }],
    actions: [{
      id: 'idle-action',
      name: '待机动作',
      semantic: 'idle',
      tags: [],
      preference: 1,
      cooldownMs: 0,
      repeatSuppressionMs: 0,
      loopPolicy: 'presentation',
      interrupt: 'normal',
      allowedPrimaryStateIds: [],
      forbiddenPrimaryStateIds: [],
      requiredModifierStateIds: [],
      forbiddenModifierStateIds: [],
      direction: 'any'
    }],
    skins: [{
      id: 'default-skin',
      name: '默认皮肤',
      semanticFallbacks: [],
      presentations: [{
        actionId: 'idle-action',
        fps: 12,
        frames: [{ assetId: 'idle-asset', x: 0, y: 0, width: 100, height: 100 }],
        anchors: { ground: { x: 0.5, y: 0.9 } },
        geometry: {
          visualBounds: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
          groundAnchor: { x: 0.5, y: 0.9 },
          resourceRevision: GEOMETRY_RESOURCE_REVISION
        }
      }]
    }],
    resources: [
      {
        assetId: 'thumbnail',
        fileName: 'thumbnail.png',
        sha256: GEOMETRY_RESOURCE_REVISION,
        byteLength: 1
      },
      {
        assetId: 'idle-asset',
        fileName: 'idle.png',
        sha256: GEOMETRY_RESOURCE_REVISION,
        byteLength: 1
      }
    ]
  });
}

class FakePetWindow {
  private readonly moveListeners: Array<() => void> = [];
  private position: [number, number] = [0, 0];

  on(event: 'move', listener: () => void): this {
    if (event === 'move') this.moveListeners.push(listener);
    return this;
  }

  getPosition(): number[] { return this.position; }

  moveTo(x: number, y: number): void {
    this.position = [x, y];
    for (const listener of this.moveListeners) listener();
  }
}

afterEach(() => vi.useRealTimers());

describe('按角色脚底锚点恢复', () => {
  const primary = {
    id: 'primary',
    workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 }
  };
  const secondary = {
    id: 'secondary',
    workAreaDip: { x: -1280, y: -200, width: 1280, height: 1024 }
  };
  const geometryForScale = (scale: number): PetPlacementGeometry => ({
    geometryRevision: 7,
    windowSizeDip: { width: 180 * scale, height: 220 * scale },
    footOffsetInWindowDip: { x: 90 * scale, y: 200 * scale },
    visualBoundsFromFootDip: {
      x: -70 * scale,
      y: -180 * scale,
      width: 140 * scale,
      height: 180 * scale
    }
  });

  test('旧坐标按窗口最大正交集选择负坐标副屏并转为默认几何脚底锚点', () => {
    const result = expectSchemaValidSuccess(migrateLegacyPetPosition({
      legacyPosition: { x: -1200, y: 700 },
      characterId: 'character-a',
      geometry: geometryForScale(1),
      displays: [primary, secondary],
      primaryDisplayId: primary.id
    }));

    expect(result).toEqual({
      ok: true,
      placement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: -1110, y: 824 },
        displayId: secondary.id
      },
      windowPosition: { x: -1200, y: 624 },
      geometryRevision: 7,
      requiresPersistence: true
    });
  });

  test('G2 viewport 内脚底偏移叠加非零 window offset 后迁移与恢复无固定漂移', () => {
    const authority = new PetVisualGeometryAuthority('character-a');
    const shape = authority.updateShape({
      manifest: strictGeometryManifest(),
      skinId: 'default-skin',
      actionId: 'idle-action',
      actionRevision: 1,
      resourceRevision: GEOMETRY_RESOURCE_REVISION,
      direction: 'right',
      scale: 1,
      viewportSizeDip: { width: 100, height: 100 }
    });
    expect(shape).toEqual({ ok: true, revision: 1 });
    if (!shape.ok) throw new Error('G2 形状几何必须成功');
    const layout = authority.getShapeLayout(shape.revision);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('G2 必须返回待提交局部布局');
    const viewportInWindowDip = { x: 23, y: 17, width: 100, height: 100 };
    const geometry: PetPlacementGeometry = {
      geometryRevision: layout.revision,
      windowSizeDip: { width: 180, height: 220 },
      footOffsetInWindowDip: {
        x: viewportInWindowDip.x + layout.footOffsetInViewportDip.x,
        y: viewportInWindowDip.y + layout.footOffsetInViewportDip.y
      },
      visualBoundsFromFootDip: layout.visualBoundsFromFootDip
    };
    expect(geometry.footOffsetInWindowDip).toEqual({ x: 73, y: 107 });

    const migrated = expectSchemaValidSuccess(migrateLegacyPetPosition({
      legacyPosition: { x: 300, y: 200 },
      characterId: 'character-a',
      geometry,
      displays: [primary],
      primaryDisplayId: primary.id
    }));
    expect(migrated).toMatchObject({
      placement: { footAnchorDip: { x: 373, y: 307 } },
      windowPosition: { x: 300, y: 200 },
      geometryRevision: shape.revision
    });

    const restored = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: migrated.placement,
      characterId: 'character-a',
      geometryForScale: () => geometry,
      displays: [primary],
      primaryDisplayId: primary.id
    }));
    expect(restored).toMatchObject({
      placement: { footAnchorDip: { x: 373, y: 307 } },
      windowPosition: { x: 300, y: 200 },
      geometryRevision: shape.revision,
      requiresPersistence: false
    });
  });

  test('真实存储 pending 经纯迁移后以原坐标 CAS 为 ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-pet-placement-'));
    const file = join(directory, 'settings.json');
    try {
      const store = new SettingsStore(file, async () => false);
      await writeFile(file, JSON.stringify({
        version: 1,
        provider: null,
        authorizedRoot: null,
        petPosition: { x: -1200, y: 700 },
        fileDisclosureAccepted: false
      }), 'utf8');
      const state = await store.getPetPlacementState('character-a');
      expect(state.kind).toBe('pending-legacy');
      if (state.kind !== 'pending-legacy') throw new Error('测试前置条件要求旧位置待迁移');

      const migrated = expectSchemaValidSuccess(migrateLegacyPetPosition({
        legacyPosition: state.windowPosition,
        characterId: 'character-a',
        geometry: geometryForScale(1),
        displays: [primary, secondary],
        primaryDisplayId: primary.id
      }));
      await store.commitPetPlacementMigration({
        expectedWindowPosition: state.windowPosition,
        placement: migrated.placement
      });

      await expect(store.getPetPlacementState('character-a')).resolves.toEqual({
        kind: 'ready',
        placement: migrated.placement
      });
      expect(await readFile(file, 'utf8')).not.toContain('windowPosition');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('旧窗口与两屏交集面积相同时优先主屏', () => {
    const result = expectSchemaValidSuccess(migrateLegacyPetPosition({
      legacyPosition: { x: -90, y: 100 },
      characterId: 'character-a',
      geometry: geometryForScale(1),
      displays: [secondary, primary],
      primaryDisplayId: primary.id
    }));

    expect(result.ok && result.placement.displayId).toBe(primary.id);
  });

  test('已保存副屏存在时精确反算负坐标窗口位置', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: -1000, y: 500 },
        displayId: secondary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary, secondary],
      primaryDisplayId: primary.id
    }));

    expect(result).toEqual({
      ok: true,
      placement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: -1000, y: 500 },
        displayId: secondary.id
      },
      windowPosition: { x: -1090, y: 300 },
      geometryRevision: 7,
      requiresPersistence: false
    });
  });

  test('合法显示器上仅单轴越界时只夹取该轴并回写锚点', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: -1400, y: 500 },
        displayId: secondary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary, secondary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      ok: true,
      placement: { footAnchorDip: { x: -1210, y: 500 }, displayId: secondary.id },
      windowPosition: { x: -1300, y: 300 },
      requiresPersistence: true
    });
  });

  test('有限越界缩放夹取到上限并使用对应真实几何', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 9,
        footAnchorDip: { x: 1000, y: 700 },
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      ok: true,
      placement: { scale: 2 },
      windowPosition: { x: 820, y: 300 },
      requiresPersistence: true
    });
  });

  test('显示器消失时保留合法缩放并在主屏生成可见默认锚点', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1.5,
        footAnchorDip: { x: 5000, y: 5000 },
        displayId: 'removed'
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toEqual({
      ok: true,
      placement: {
        characterId: 'character-a',
        scale: 1.5,
        footAnchorDip: { x: 1799, y: 1024 },
        displayId: primary.id
      },
      windowPosition: { x: 1664, y: 724 },
      geometryRevision: 7,
      requiresPersistence: true
    });
  });

  test('损坏位置恢复为主屏 scale 1 默认位置', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: Number.NaN,
        footAnchorDip: { x: Number.POSITIVE_INFINITY, y: 100 },
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toEqual({
      ok: true,
      placement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: 1834, y: 1024 },
        displayId: primary.id
      },
      windowPosition: { x: 1744, y: 824 },
      geometryRevision: 7,
      requiresPersistence: true
    });
  });

  test('损坏的脚底锚点结构不会让恢复算法抛异常', () => {
    expect(expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: null,
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }))).toMatchObject({
      ok: true,
      placement: { characterId: 'character-a', scale: 1, displayId: primary.id },
      windowPosition: { x: 1744, y: 824 },
      requiresPersistence: true
    });
  });

  test('角色不匹配的位置不会被当前角色继承', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-b',
        scale: 1,
        footAnchorDip: { x: 100, y: 100 },
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      ok: true,
      placement: { characterId: 'character-a', scale: 1, displayId: primary.id },
      windowPosition: { x: 1744, y: 824 },
      requiresPersistence: true
    });
  });

  test('非法当前角色不会产生无法持久化的成功结果', () => {
    expect(restorePetPlacement({
      savedPlacement: null,
      characterId: '../bad',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    })).toEqual({ ok: false, code: 'PET_PLACEMENT_INPUT_INVALID' });
  });

  test('空白和超长 displayId 不会进入成功 placement', () => {
    const blankResult = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: 1000, y: 500 },
        displayId: '   '
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));
    expect(blankResult).toMatchObject({
      placement: { displayId: primary.id },
      windowPosition: { x: 1744, y: 824 },
      requiresPersistence: true
    });

    const overlongDisplayId = 'd'.repeat(257);
    const overlongResult = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: -1000, y: 500 },
        displayId: overlongDisplayId
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary, { ...secondary, id: overlongDisplayId }],
      primaryDisplayId: primary.id
    }));
    expect(overlongResult).toMatchObject({
      placement: { displayId: primary.id },
      windowPosition: { x: 1744, y: 824 },
      requiresPersistence: true
    });
  });

  test('含 extra 字段的存储位置按损坏输入恢复为默认', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: 1000, y: 500 },
        displayId: primary.id,
        extra: true
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      placement: { characterId: 'character-a', scale: 1, displayId: primary.id },
      windowPosition: { x: 1744, y: 824 },
      requiresPersistence: true
    });
  });

  test('大透明 padding 不会把已可见的脚底锚点推回屏内', () => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip: { x: 100, y: 500 },
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale: () => ({
        geometryRevision: 11,
        windowSizeDip: { width: 1000, height: 1000 },
        footOffsetInWindowDip: { x: 500, y: 900 },
        visualBoundsFromFootDip: { x: -50, y: -100, width: 100, height: 100 }
      }),
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      placement: { footAnchorDip: { x: 100, y: 500 } },
      windowPosition: { x: -400, y: -400 },
      geometryRevision: 11,
      requiresPersistence: false
    });
  });

  test.each([
    ['left', { x: 0, y: 500 }, { x: 70, y: 500 }, { x: -20, y: 300 }],
    ['right', { x: 1920, y: 500 }, { x: 1850, y: 500 }, { x: 1760, y: 300 }],
    ['top', { x: 1000, y: 0 }, { x: 1000, y: 180 }, { x: 910, y: -20 }],
    ['bottom', { x: 1000, y: 1100 }, { x: 1000, y: 1040 }, { x: 910, y: 840 }]
  ] as const)('可见矩形越过 $0 边时只夹取脚底锚点', (
    _edge,
    footAnchorDip,
    expectedFoot,
    expectedWindow
  ) => {
    const result = expectSchemaValidSuccess(restorePetPlacement({
      savedPlacement: {
        characterId: 'character-a',
        scale: 1,
        footAnchorDip,
        displayId: primary.id
      },
      characterId: 'character-a',
      geometryForScale,
      displays: [primary],
      primaryDisplayId: primary.id
    }));

    expect(result).toMatchObject({
      placement: { footAnchorDip: expectedFoot },
      windowPosition: expectedWindow,
      geometryRevision: 7,
      requiresPersistence: true
    });
  });

  test('空显示器列表或几何返回非有限值时安全失败', () => {
    expect(restorePetPlacement({
      savedPlacement: null,
      characterId: 'character-a',
      geometryForScale,
      displays: [],
      primaryDisplayId: primary.id
    })).toEqual({ ok: false, code: 'PET_PLACEMENT_DISPLAY_UNAVAILABLE' });
    expect(restorePetPlacement({
      savedPlacement: null,
      characterId: 'character-a',
      geometryForScale: () => ({
        geometryRevision: 7,
        windowSizeDip: { width: Number.MAX_VALUE, height: 220 },
        footOffsetInWindowDip: { x: Number.MAX_VALUE, y: 200 },
        visualBoundsFromFootDip: { x: -70, y: -180, width: 140, height: 180 }
      }),
      displays: [primary],
      primaryDisplayId: primary.id
    })).toEqual({ ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' });
  });

  test('可见矩形 extent 溢出时安全失败', () => {
    expect(restorePetPlacement({
      savedPlacement: null,
      characterId: 'character-a',
      geometryForScale: () => ({
        geometryRevision: 7,
        windowSizeDip: { width: 180, height: 220 },
        footOffsetInWindowDip: { x: 90, y: 200 },
        visualBoundsFromFootDip: {
          x: Number.MAX_VALUE,
          y: -180,
          width: Number.MAX_VALUE,
          height: 180
        }
      }),
      displays: [primary],
      primaryDisplayId: primary.id
    })).toEqual({ ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' });
  });

  test('可见矩形大于工作区时不伪装为已完全约束', () => {
    expect(restorePetPlacement({
      savedPlacement: null,
      characterId: 'character-a',
      geometryForScale: () => ({
        geometryRevision: 8,
        windowSizeDip: { width: 2100, height: 220 },
        footOffsetInWindowDip: { x: 1050, y: 200 },
        visualBoundsFromFootDip: { x: -1000, y: -180, width: 2000, height: 180 }
      }),
      displays: [primary],
      primaryDisplayId: primary.id
    })).toEqual({ ok: false, code: 'PET_PLACEMENT_GEOMETRY_INVALID' });
  });
});
