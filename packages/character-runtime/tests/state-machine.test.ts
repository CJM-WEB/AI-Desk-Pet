import { describe, expect, test } from 'vitest';
import type { TaskPhase } from '@myself/shared-types';
import {
  CHARACTER_TRANSIENT_DURATION_MS,
  characterStateFor,
  motionModeFor,
  transientDurationFor
} from '../src/state-machine';

describe('角色状态机', () => {
  test.each<[TaskPhase, string]>([
    ['idle', 'idle'],
    ['listening', 'listening'],
    ['thinking', 'thinking'],
    ['awaiting_confirmation', 'listening'],
    ['acting', 'acting'],
    ['success', 'success'],
    ['error', 'error'],
    ['cancelled', 'idle']
  ])('%s 映射为 %s', (phase, expected) => {
    expect(characterStateFor(phase)).toBe(expected);
  });

  test('成功和错误状态固定停留 1500 毫秒', () => {
    expect(CHARACTER_TRANSIENT_DURATION_MS).toBe(1_500);
    expect(transientDurationFor('success')).toBe(1_500);
    expect(transientDurationFor('error')).toBe(1_500);
    expect(transientDurationFor('thinking')).toBeNull();
  });

  test('减少动态效果使用静态模式', () => {
    expect(motionModeFor(true)).toBe('static');
    expect(motionModeFor(false)).toBe('animated');
  });
});
