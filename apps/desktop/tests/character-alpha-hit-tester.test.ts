import { describe, expect, test } from 'vitest';
import {
  hitTestCharacterAlpha,
  type CharacterHitSnapshot
} from '../src/renderer/src/characters/player/character-alpha-hit-tester';

function snapshot(
  bytes: number[],
  direction: 'left' | 'right' = 'right'
): CharacterHitSnapshot {
  return {
    mask: { width: 4, height: 1, bytes: new Uint8Array(bytes) },
    sourceRect: { x: 0, y: 0, width: 4, height: 1 },
    frameBounds: { x: 10, y: 20, width: 40, height: 10 },
    direction
  };
}

describe('角色逐帧 Alpha 命中', () => {
  test('仅将大于默认阈值 16 的不透明像素判为命中', () => {
    const current = snapshot([0, 16, 17, 255]);

    expect(hitTestCharacterAlpha(current, { x: 15, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 25, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 35, y: 25 })).toBe(true);
    expect(hitTestCharacterAlpha(current, { x: 45, y: 25 })).toBe(true);
  });

  test('将画布左向布局镜像映射到源帧右侧 Alpha', () => {
    const current = snapshot([0, 0, 0, 255], 'left');

    expect(hitTestCharacterAlpha(current, { x: 15, y: 25 })).toBe(true);
    expect(hitTestCharacterAlpha(current, { x: 45, y: 25 })).toBe(false);
  });

  test('透明空洞、负坐标和四边越界均不命中', () => {
    const current = snapshot([255, 0, 255, 255]);

    expect(hitTestCharacterAlpha(current, { x: 25, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: -1, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 10, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 50, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha(current, { x: 15, y: 30 })).toBe(false);
  });

  test('无效快照和异常数据均 fail-open，不抛出异常', () => {
    expect(hitTestCharacterAlpha(null, { x: 10, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(snapshot([255]), { x: Number.NaN, y: 20 })).toBe(false);
    expect(hitTestCharacterAlpha(snapshot([255]), { x: 10, y: Infinity })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      frameBounds: { x: 0, y: 0, width: 0, height: 1 }
    }, { x: 0, y: 0 })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      sourceRect: { x: 3, y: 0, width: 2, height: 1 }
    }, { x: 15, y: 25 })).toBe(false);
    expect(hitTestCharacterAlpha({
      ...snapshot([255, 255, 255, 255]),
      mask: { width: 4, height: 1, bytes: new Uint8Array(3) }
    }, { x: 15, y: 25 })).toBe(false);
  });
});
