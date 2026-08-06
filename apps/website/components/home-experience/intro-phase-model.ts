import type { ExperiencePhase } from './types';

export type IntroPhaseEvent = 'drawing-done' | 'settled' | 'skip';

/** 保留磁吸开场的阶段机，当前官网不引用，后续复用时可直接接回。 */
export function isIntroPhase(phase: ExperiencePhase): boolean {
  return phase === 'drawing' || phase === 'settling';
}

export function reduceIntroPhase(
  phase: ExperiencePhase,
  event: IntroPhaseEvent
): ExperiencePhase {
  if (event === 'skip') {
    return isIntroPhase(phase) ? 'interactive' : phase;
  }
  if (event === 'drawing-done') {
    return phase === 'drawing' ? 'settling' : phase;
  }
  return phase === 'settling' ? 'interactive' : phase;
}

export function deriveHomeExperiencePhase(
  phase: ExperiencePhase,
  exitProgress: number
): ExperiencePhase {
  return phase === 'interactive' && exitProgress > 0 ? 'exiting' : phase;
}
