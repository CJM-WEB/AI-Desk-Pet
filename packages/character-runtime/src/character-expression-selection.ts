import type { MovementControlPlan } from './character-behavior-plan';
import type { CharacterMoodUpdate } from './character-mood';
import type { CharacterBackgroundSelection, CharacterExplicitPlayback, CharacterExpressionPlanInput } from './character-expression-plan';

/** Main 内部接纳结果；Provider 扁平协议只由正式 Adapter 定义和校验。 */
export type CharacterExpressionSelectionDecision = Readonly<{
  moodUpdate?: CharacterMoodUpdate;
  expressionPlan?: CharacterExpressionPlanInput;
  backgroundSelection?: CharacterBackgroundSelection | null;
  explicitPlayback?: CharacterExplicitPlayback;
  movementControl: MovementControlPlan;
  requestKind: 'ambient' | 'state' | 'action' | 'movement';
}>;
