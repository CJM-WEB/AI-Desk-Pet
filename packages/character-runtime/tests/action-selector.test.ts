import { describe, expect, test } from 'vitest';
import {
  type CharacterManifestV1,
  characterManifestV1Schema,
  selectCharacterAction
} from '../src';

type ActionInput = {
  id: string;
  weight?: number;
  direction?: 'left' | 'right' | 'any';
  frameCount?: number;
};

type StateInput = {
  id: 'idle' | 'moving' | 'carrying';
  actions: ActionInput[];
};

function createManifest(states: StateInput[]): CharacterManifestV1 {
  return characterManifestV1Schema.parse({
    version: 1,
    id: 'character-current',
    name: '当前角色',
    thumbnailAssetId: 'thumbnail-1',
    compilerVersion: 'compiler-1.0.0',
    resources: [
      {
        assetId: 'thumbnail-1',
        fileName: 'thumbnail.webp',
        sha256: 'a'.repeat(64),
        byteLength: 1024
      },
      {
        assetId: 'atlas-current',
        fileName: 'atlas-current.png',
        sha256: 'b'.repeat(64),
        byteLength: 4096
      }
    ],
    states: states.map((state) => ({
      id: state.id,
      kind: 'core' as const,
      actions: state.actions.map((action) => ({
        id: action.id,
        name: action.id,
        fps: 12,
        loop: true,
        weight: action.weight ?? 1,
        direction: action.direction,
        frames: Array.from({ length: action.frameCount ?? 1 }, () => ({
          assetId: 'atlas-current',
          x: 0,
          y: 0,
          width: 256,
          height: 256
        })),
        anchors: {
          ground: { x: 0.5, y: 1 }
        }
      }))
    }))
  });
}

describe('动作选择器', () => {
  test('目标状态缺失时只回退到当前角色待机动作', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] }
    ]);

    const result = selectCharacterAction({
      manifest,
      stateId: 'carrying',
      direction: 'right',
      recentActionIds: [],
      random: () => 0
    });

    expect(result.reason).toBe('idle_fallback');
    expect(result.stateId).toBe('idle');
    expect(result.action.id).toBe('idle-breathe');
    expect(result.action.frames[0]?.assetId).toBe('atlas-current');
  });

  test('按方向筛选并排除冷却中的动作', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-right', direction: 'right' },
          { id: 'move-left-a', direction: 'left' },
          { id: 'move-left-b', direction: 'left' },
          { id: 'move-any', direction: 'any' }
        ]
      }
    ]);

    const result = selectCharacterAction({
      manifest,
      stateId: 'moving',
      direction: 'left',
      recentActionIds: ['move-left-a', 'move-any'],
      random: () => 0
    });

    expect(result.reason).toBe('matched');
    expect(result.stateId).toBe('moving');
    expect(result.action.id).toBe('move-left-b');
  });

  test('全部候选处于冷却时恢复完整候选池', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-left-a', direction: 'left' },
          { id: 'move-left-b', direction: 'left' }
        ]
      }
    ]);

    const result = selectCharacterAction({
      manifest,
      stateId: 'moving',
      direction: 'left',
      recentActionIds: ['move-left-a', 'move-left-b'],
      random: () => 0.75
    });

    expect(result.action.id).toBe('move-left-b');
  });

  test('按权重和注入随机源确定性选择动作', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-light', weight: 1 },
          { id: 'move-heavy', weight: 3 }
        ]
      }
    ]);

    const low = selectCharacterAction({
      manifest,
      stateId: 'moving',
      recentActionIds: [],
      random: () => 0.24
    });
    const boundary = selectCharacterAction({
      manifest,
      stateId: 'moving',
      recentActionIds: [],
      random: () => 0.25
    });

    expect(low.action.id).toBe('move-light');
    expect(boundary.action.id).toBe('move-heavy');
  });

  test.each([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    -0.01,
    1,
    1.01,
    Number.POSITIVE_INFINITY
  ])('随机源返回非法值 %s 时抛出稳定错误码', (randomValue) => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      { id: 'moving', actions: [{ id: 'move-a' }, { id: 'move-b' }] }
    ]);

    expect(() => selectCharacterAction({
      manifest,
      stateId: 'moving',
      recentActionIds: [],
      random: () => randomValue
    })).toThrow('CHARACTER_RANDOM_OUT_OF_RANGE');
  });

  test('忽略零值、负数和非有限权重的动作', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-zero' },
          { id: 'move-negative' },
          { id: 'move-infinite' },
          { id: 'move-valid', weight: 1 }
        ]
      }
    ]);
    const movingState = manifest.states.find((state) => state.id === 'moving');

    if (!movingState) {
      throw new Error('测试清单缺少移动状态');
    }

    movingState.actions[0]!.weight = 0;
    movingState.actions[1]!.weight = -1;
    movingState.actions[2]!.weight = Number.POSITIVE_INFINITY;

    const result = selectCharacterAction({
      manifest,
      stateId: 'moving',
      recentActionIds: [],
      random: () => 0
    });

    expect(result.action.id).toBe('move-valid');
  });

  test('重复动作标识不增加同一动作的选择权重', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-duplicate', weight: 1 },
          { id: 'move-duplicate', weight: 1 },
          { id: 'move-distinct', weight: 1 }
        ]
      }
    ]);

    const result = selectCharacterAction({
      manifest,
      stateId: 'moving',
      recentActionIds: [],
      random: () => 0.5
    });

    expect(result.action.id).toBe('move-distinct');
  });

  test('待机状态也没有可用动作时抛出稳定错误码', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-right', direction: 'right' }] }
    ]);

    expect(() => selectCharacterAction({
      manifest,
      stateId: 'carrying',
      direction: 'left',
      recentActionIds: [],
      random: () => 0
    })).toThrow('CHARACTER_IDLE_UNAVAILABLE');
  });

  test('不修改清单和冷却输入', () => {
    const manifest = createManifest([
      { id: 'idle', actions: [{ id: 'idle-breathe' }] },
      {
        id: 'moving',
        actions: [
          { id: 'move-left-a', direction: 'left' },
          { id: 'move-left-b', direction: 'left' }
        ]
      }
    ]);
    const recentActionIds = ['move-left-a'];
    const beforeManifest = structuredClone(manifest);
    const beforeRecentActionIds = [...recentActionIds];

    const result = selectCharacterAction({
      manifest,
      stateId: 'moving',
      direction: 'left',
      recentActionIds,
      random: () => 0
    });

    expect(result.action.id).toBe('move-left-b');
    expect(manifest).toEqual(beforeManifest);
    expect(recentActionIds).toEqual(beforeRecentActionIds);
  });
});
