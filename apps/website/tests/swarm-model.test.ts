import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  advanceSwarmFrame,
  canGenerateParticle,
  computeFrameStep,
  FileSwarm,
  resolveSwarmSeed,
  selectEnabledFileKind,
  transitionPreviewHold
} from '../components/home-experience/FileSwarm';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';
import { CONTENT_POOL } from '../components/home-experience/content-pool';
import {
  advanceParticle,
  createSeededRandom,
  isPlacementAllowed,
  spawnParticle
} from '../components/home-experience/swarm-model';
import type { FileParticle, Rect, SpawnViewport } from '../components/home-experience/swarm-model';

const viewport: SpawnViewport = {
  width: 1440,
  height: 900,
  safeZoneRatio: EXPERIENCE_CONFIG.swarm.safeZoneRatio
};

function createParticle(overrides: Partial<FileParticle> = {}): FileParticle {
  return {
    id: 'particle-1',
    kind: 'txt',
    preview: CONTENT_POOL.txt[0]!,
    x: 100,
    y: 100,
    width: 120,
    height: 120,
    rotation: 0,
    scale: 1,
    remainingMs: 1000,
    isHeld: false,
    phase: 'floating',
    ...overrides
  };
}

describe('确定性随机源', () => {
  it('相同固定种子生成相同的三项随机序列', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });
});

describe('文件队列调度策略', () => {
  it('合法整数 URL 种子优先于随机后备值', () => {
    let fallbackCalls = 0;

    expect(resolveSwarmSeed('?seed=42', () => {
      fallbackCalls += 1;
      return 99;
    })).toBe(42);
    expect(fallbackCalls).toBe(0);
  });

  it('非法 URL 种子调用随机后备值', () => {
    let fallbackCalls = 0;

    expect(resolveSwarmSeed('?seed=4.2', () => {
      fallbackCalls += 1;
      return 99;
    })).toBe(99);
    expect(fallbackCalls).toBe(1);
  });

  it('仅在未暂停的 interactive 阶段且低于上限时允许生成', () => {
    expect(canGenerateParticle({
      phase: 'interactive',
      isPaused: false,
      activeCount: 9,
      disabledKindCount: 0
    })).toBe(true);
    expect(canGenerateParticle({
      phase: 'exiting',
      isPaused: false,
      activeCount: 9,
      disabledKindCount: 0
    })).toBe(false);
    expect(canGenerateParticle({
      phase: 'interactive',
      isPaused: true,
      activeCount: 9,
      disabledKindCount: 0
    })).toBe(false);
    expect(canGenerateParticle({
      phase: 'interactive',
      isPaused: false,
      activeCount: 10,
      disabledKindCount: 0
    })).toBe(false);
  });

  it('选择文件类型时排除失败类型且全失败后返回 null', () => {
    expect(selectEnabledFileKind(() => 0, new Set(['txt']))).toBe('pdf');
    expect(selectEnabledFileKind(
      () => 0.5,
      new Set(['txt', 'pdf', 'ppt', 'xls', 'img', 'empty', 'folder'])
    )).toBeNull();
  });
});

describe('预览保持来源', () => {
  it('鼠标进入后触发 focus 仍保持 pointer 模式', () => {
    const pointerHeld = transitionPreviewHold(
      { pointer: false, focus: false, mode: null },
      'pointer-enter'
    );

    expect(transitionPreviewHold(pointerHeld, 'focus')).toEqual({
      pointer: true,
      focus: true,
      mode: 'pointer'
    });
  });

  it('鼠标离开但焦点保留时切换到 keyboard 模式', () => {
    const bothHeld = {
      pointer: true,
      focus: true,
      mode: 'pointer' as const
    };

    expect(transitionPreviewHold(bothHeld, 'pointer-leave')).toEqual({
      pointer: false,
      focus: true,
      mode: 'keyboard'
    });
  });
});

describe('帧调度基线', () => {
  it('暂停后清空的基线在恢复首帧不扣除暂停时间', () => {
    expect(computeFrameStep(null, 5000)).toEqual({
      deltaMs: 0,
      nextFrameAt: 5000
    });
    expect(computeFrameStep(5000, 5016)).toEqual({
      deltaMs: 16,
      nextFrameAt: 5016
    });
  });

  it('无粒子或全部保持时复用原数组引用', () => {
    const empty: FileParticle[] = [];
    const held = [createParticle({ isHeld: true })];

    expect(advanceSwarmFrame(empty, 16)).toBe(empty);
    expect(advanceSwarmFrame(held, 16)).toBe(held);
  });

  it('存在活动粒子时返回新数组并推进生命周期', () => {
    const active = [createParticle({ isHeld: false, remainingMs: 1000 })];
    const advanced = advanceSwarmFrame(active, 16);

    expect(advanced).not.toBe(active);
    expect(advanced[0]!.remainingMs).toBe(984);
  });
});

describe('粒子放置约束', () => {
  it('拒绝位于 1440x900 视口中央安全区的候选矩形', () => {
    expect(isPlacementAllowed(
      { x: 660, y: 390, width: 120, height: 120 },
      [],
      viewport
    )).toBe(false);
  });

  it('拒绝越过 24 像素视口边距的候选矩形', () => {
    expect(isPlacementAllowed(
      { x: 23, y: 100, width: 96, height: 96 },
      [],
      viewport
    )).toBe(false);
  });

  it('拒绝与现有矩形间距不足 18 像素的候选矩形', () => {
    const existing: Rect[] = [{ x: 100, y: 100, width: 96, height: 96 }];

    expect(isPlacementAllowed(
      { x: 213, y: 100, width: 96, height: 96 },
      existing,
      viewport
    )).toBe(false);
  });
});

describe('粒子生成', () => {
  it('使用同一随机源生成边距内的位置和指定范围内的外观属性', () => {
    const particle = spawnParticle({
      id: 'particle-1',
      now: 100,
      viewport: { width: 320, height: 240, safeZoneRatio: 0 },
      existing: [],
      random: createSeededRandom(123)
    });

    expect(particle).not.toBeNull();
    expect(particle).toMatchObject({ id: 'particle-1', phase: 'entering' });
    expect(particle!.width).toBeGreaterThanOrEqual(96);
    expect(particle!.width).toBeLessThan(144);
    expect(particle!.height).toBe(particle!.width);
    expect(particle!.x).toBeGreaterThanOrEqual(24);
    expect(particle!.x + particle!.width).toBeLessThanOrEqual(296);
    expect(particle!.y).toBeGreaterThanOrEqual(24);
    expect(particle!.y + particle!.height).toBeLessThanOrEqual(216);
    expect(particle!.rotation).toBeGreaterThanOrEqual(-8);
    expect(particle!.rotation).toBeLessThan(8);
    expect(particle!.scale).toBeGreaterThanOrEqual(0.88);
    expect(particle!.scale).toBeLessThan(1.12);
    expect(particle!.remainingMs).toBeGreaterThanOrEqual(EXPERIENCE_CONFIG.swarm.lifetimeMs[0]);
    expect(particle!.remainingMs).toBeLessThan(EXPERIENCE_CONFIG.swarm.lifetimeMs[1]);
  });

  it('在 320x240 视口被完全占满时返回 null', () => {
    const particle = spawnParticle({
      id: 'particle-1',
      now: 100,
      viewport: { width: 320, height: 240, safeZoneRatio: 0 },
      existing: [{ x: 24, y: 24, width: 272, height: 192 }],
      random: () => 0
    });

    expect(particle).toBeNull();
  });

  it('在粒子多次推进期间保持生成内容的对象引用', () => {
    const particle = spawnParticle({
      id: 'particle-1',
      now: 100,
      viewport: { width: 320, height: 240, safeZoneRatio: 0 },
      existing: [],
      random: () => 0
    });
    const firstAdvance = advanceParticle(particle!, 100);
    const secondAdvance = advanceParticle(firstAdvance, 100);

    expect(firstAdvance.preview).toBe(particle!.preview);
    expect(secondAdvance.preview).toBe(particle!.preview);
  });
});

describe('粒子生命周期', () => {
  it('被保持时冻结生命周期', () => {
    const particle = createParticle({ isHeld: true });

    expect(advanceParticle(particle, 600).remainingMs).toBe(1000);
  });

  it('移开后继续扣减生命周期', () => {
    const particle = createParticle({ isHeld: false });

    expect(advanceParticle(particle, 600).remainingMs).toBe(400);
  });

  it('剩余时间达到 500 毫秒时进入离场阶段且不会低于零', () => {
    const particle = createParticle({ remainingMs: 700 });
    const advanced = advanceParticle(particle, 200);

    expect(advanced).toMatchObject({ remainingMs: 500, phase: 'leaving' });
    expect(advanceParticle(advanced, 1000).remainingMs).toBe(0);
  });
});

describe('文件队列根层', () => {
  it('服务端初始渲染暴露零活动粒子计数', () => {
    const markup = renderToStaticMarkup(createElement(FileSwarm, {
      phase: 'interactive',
      pointer: { x: 0, y: 0 },
      isPaused: false,
      progress: 0
    }));

    expect(markup).toContain('data-active-count="0"');
    expect(markup.match(/data-testid="file-preview"/g) ?? []).toHaveLength(0);
  });
});
