import { describe, expect, test } from 'vitest';
import type { CharacterState } from '@myself/character-runtime';
import { presentationFor } from '../src/renderer/src/character/state-map';

describe('桌宠核心状态展示映射', () => {
  test('全部核心状态都有完整展示文案', () => {
    const states: CharacterState[] = [
      'idle',
      'listening',
      'thinking',
      'moving',
      'acting',
      'carrying',
      'success',
      'error'
    ];

    for (const state of states) {
      expect(presentationFor(state)).toMatchObject({
        face: expect.any(String),
        label: expect.any(String),
        detail: expect.any(String)
      });
    }
  });
});
