/** 作者用途解释只保存合法动作引用；事件发生、保持期限和系统权限始终由 Main 决定。 */
export const characterBehaviorRoles = [
  'chatting', 'taskRunning', 'awaitingConfirmation', 'moving',
  'success', 'error', 'praise', 'boredom', 'rest'
] as const;
export type CharacterBehaviorRole = typeof characterBehaviorRoles[number];
export type CharacterBehaviorChoice = Readonly<{ stateId: string; actionId: string }>;
export type CharacterBehaviorBindings = Readonly<Record<CharacterBehaviorRole, CharacterBehaviorChoice | null>>;
