/**
 * 用户自然表达矩阵只描述业务意图，不承担 Provider 协议解码职责。
 * Gate 与 Director 共用这一事实源，避免各层复制原句后形成自证循环。
 */
export const persistentMovementIntentCases = [
  {
    prompt: '停止不动',
    mode: 0,
    movementControl: { kind: 'set_mode', mode: 0 },
    explicitDirective: { kind: 'stop_movement' }
  },
  {
    prompt: '让他一直运动',
    mode: 1,
    movementControl: { kind: 'set_mode', mode: 1 },
    explicitDirective: { kind: 'continuous_movement' }
  },
  {
    prompt: '让他时不时动一下',
    mode: 2,
    movementControl: { kind: 'set_mode', mode: 2 },
    explicitDirective: { kind: 'resume_movement' }
  }
] as const;

export const transientBehaviorIntentCases = {
  moveFar: {
    prompt: '跑远一点',
    movementControl: {
      kind: 'move_once', target: 'random_work_area', distance: 'far'
    },
    explicitDirective: {
      kind: 'move', motion: { kind: 'wander', scope: 'work_area', distance: 'far' }
    }
  },
} as const;
