import { EXPERIENCE_CONFIG } from './config';
import type { ExperiencePhase } from './types';

export interface ExperienceState {
  phase: ExperiencePhase;
  progress: number;
}

export type ExperienceEvent =
  | { type: 'ASSETS_READY' }
  | { type: 'DRAWING_DONE' }
  | { type: 'SETTLED' }
  | { type: 'SKIP_INTRO' }
  | { type: 'SET_PROGRESS'; progress: number };

const EXIT_PROGRESS = 0.82;

// 统一处理所有进入进度模型的数值，确保状态不会越过两端边界。
export function clampProgress(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value >= 1 ? 1 : value;
}

// 滚轮和键盘都通过同一个增量入口更新进度。
export function applyProgressDelta(current: number, delta: number): number {
  return clampProgress(current + delta);
}

// 只有低速停止时才执行边界吸附，快速滑动保留用户当前意图。
export function snapProgress(value: number, velocity: number): number {
  const clampedValue = clampProgress(value);
  if (!Number.isFinite(velocity) || Math.abs(velocity) > 0.02) {
    return clampedValue;
  }

  const { snapThreshold } = EXPERIENCE_CONFIG.progress;
  if (clampedValue <= snapThreshold) {
    return 0;
  }

  return clampedValue >= 1 - snapThreshold ? 1 : clampedValue;
}

// 阶段事件只推进允许的相邻阶段，跳过开场和进度退出独立处理。
export function reduceExperience(
  state: ExperienceState,
  event: ExperienceEvent
): ExperienceState {
  switch (event.type) {
    case 'ASSETS_READY':
      return state.phase === 'loading' ? { ...state, phase: 'drawing' } : state;
    case 'DRAWING_DONE':
      return state.phase === 'drawing' ? { ...state, phase: 'settling' } : state;
    case 'SETTLED':
      return state.phase === 'settling' ? { ...state, phase: 'interactive' } : state;
    case 'SKIP_INTRO':
      return { phase: 'interactive', progress: 0 };
    case 'SET_PROGRESS': {
      const progress = clampProgress(event.progress);
      return {
        phase: progress >= EXIT_PROGRESS ? 'exiting' : 'interactive',
        progress
      };
    }
  }
}
