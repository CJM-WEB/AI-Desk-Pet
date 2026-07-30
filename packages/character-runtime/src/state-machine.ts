import type { TaskPhase } from '@myself/shared-types';
import type { CoreCharacterState } from './character-schema';

export type CharacterState = CoreCharacterState;
export type CharacterMotionMode = 'animated' | 'static';

export const CHARACTER_TRANSIENT_DURATION_MS = 1_500;

export function characterStateFor(phase: TaskPhase): CharacterState {
  if (phase === 'thinking') return 'thinking';
  if (phase === 'acting') return 'acting';
  if (phase === 'success') return 'success';
  if (phase === 'error') return 'error';
  if (phase === 'listening' || phase === 'awaiting_confirmation') return 'listening';
  return 'idle';
}

export function transientDurationFor(state: CharacterState): number | null {
  return state === 'success' || state === 'error'
    ? CHARACTER_TRANSIENT_DURATION_MS
    : null;
}

export function motionModeFor(reducedMotion: boolean): CharacterMotionMode {
  return reducedMotion ? 'static' : 'animated';
}
