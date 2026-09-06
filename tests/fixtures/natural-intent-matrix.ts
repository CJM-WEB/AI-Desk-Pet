/**
 * 用户自然表达矩阵只描述业务意图，不承担 Provider 协议解码职责。
 * Gate、Coordinator 与 Director 共用这一事实源，避免各层复制原句后形成自证循环。
 */
export const conversationIntentCases = [
  { prompt: '你好呀', route: 'chat' },
  { prompt: '帮我在当前目录下创建ab.txt文件', route: 'file' },
  { prompt: '把 A 移动到 B', route: 'file' },
  { prompt: '执行 PowerShell 测试', route: 'powershell' }
] as const;

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

/**
 * 协议夹具刻意不携带用户原句：输入是独立的线协议 JSON，期望是解码结果。
 * 这里验证 codec 保真，不宣称脚本模型理解了自然语言。
 */
export const characterChatProtocolCases = [
  { name: "普通聊天计划",
    wireJson: "{\"text\":\"你好，我在。\",\"movementControl\":{\"kind\":\"keep\"},\"capabilityPlan\":{\"kind\":\"chat\"}}",
    decoded: {"text":"你好，我在。","movementControl":{"kind":"keep"},"capabilityPlan":{"kind":"chat"}}
  },
  { name: "持久运动模式计划",
    wireJson: "{\"text\":\"已切换模式。\",\"movementControl\":{\"kind\":\"set_mode\",\"mode\":1},\"capabilityPlan\":{\"kind\":\"chat\"}}",
    decoded: {"text":"已切换模式。","movementControl":{"kind":"set_mode","mode":1},"capabilityPlan":{"kind":"chat"}}
  },
  { name: "单次远距离运动计划",
    wireJson: "{\"text\":\"开始移动。\",\"movementControl\":{\"kind\":\"move_once\",\"target\":\"random_work_area\",\"distance\":\"far\"},\"capabilityPlan\":{\"kind\":\"chat\"}}",
    decoded: {"text":"开始移动。","movementControl":{"kind":"move_once","target":"random_work_area","distance":"far"},"capabilityPlan":{"kind":"chat"}}
  },
  { name: "两级状态动作计划",
    wireJson: "{\"text\":\"开始挥手。\",\"movementControl\":{\"kind\":\"keep\"},\"moodUpdate\":{\"summary\":\"开心\",\"strength\":0.8},\"expressionPlan\":{\"states\":[{\"stateId\":\"protocol-state\",\"score\":1,\"minStrength\":0,\"maxStrength\":1,\"actions\":[{\"actionId\":\"protocol-action\",\"score\":1}]}]},\"capabilityPlan\":{\"kind\":\"chat\"}}",
    decoded: {"text":"开始挥手。","movementControl":{"kind":"keep"},"moodUpdate":{"summary":"开心","strength":0.8,"halfLifeMs":300000},"expressionPlan":{"validForMs":1200000,"states":[{"stateId":"protocol-state","score":1,"minStrength":0,"maxStrength":1,"actions":[{"actionId":"protocol-action","score":1}]}]},"capabilityPlan":{"kind":"chat"}}
  }
] as const;
