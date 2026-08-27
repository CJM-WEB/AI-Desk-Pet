import { describe, expect, test } from 'vitest';
import {
  characterChatResponseJsonSchema,
  characterChatResponseSchema,
  characterBehaviorPlanSchema,
  movementControlPlanSchema,
  publicBehaviorCatalogSchema
} from '../src/character-behavior-plan';

describe('角色行为计划协议', () => {
  test.each([
    { kind: 'keep' },
    { kind: 'set_mode', mode: 0 },
    { kind: 'set_mode', mode: 1 },
    { kind: 'set_mode', mode: 2 },
    { kind: 'move_once', target: 'random_work_area', distance: 'near' },
    { kind: 'move_once', target: 'top_left', distance: 'far' }
  ])('接受合法运动控制计划 %#', plan => {
    expect(movementControlPlanSchema.safeParse(plan).success).toBe(true);
  });

  test.each([
    { kind: 'keep', extra: true },
    { kind: 'set_mode', mode: 3 },
    { kind: 'set_mode' },
    { kind: 'move_once', target: 'current', distance: 'near' },
    { kind: 'move_once', target: 'random_work_area', distance: 'none' },
    { kind: 'move_once', target: { x: 1, y: 2 }, distance: 'far' }
  ])('拒绝额外字段或越界运动控制计划 %#', plan => {
    expect(movementControlPlanSchema.safeParse(plan).success).toBe(false);
  });

  test.each([
    { kind: 'none', emotion: 'calm' },
    { kind: 'play_state', state: '开心', emotion: 'happy' },
    {
      kind: 'play_state', state: '开心', action: '挥手', duration: 'extended', emotion: 'happy'
    },
    { kind: 'move', direction: 'left', distance: 'near' },
    { kind: 'move_region', region: 'top_left' }
  ])('接受合法计划 %#', plan => {
    expect(characterBehaviorPlanSchema.safeParse(plan).success).toBe(true);
  });

  test.each([
    { kind: 'play', target: { kind: 'action_name', name: '挥手' } },
    { kind: 'play_state', state: '开心', action: '挥手', actionId: 'private-action' },
    { kind: 'play_state', state: 'C:\\Users\\Administrator\\secret' },
    { kind: 'play_state', state: '开心', action: '   ' },
    { kind: 'play_state', state: '开心', duration: 'forever' },
    { kind: 'play', target: { kind: 'action_name', name: '挥手', actionId: 'private-action' } },
    { kind: 'move', direction: 'left', distance: 'near', x: 10, y: 20 },
    { kind: 'play', target: { kind: 'action_name', name: '挥手', toolName: 'builtin.files.delete_file' } },
    { kind: 'play', target: { kind: 'state_name', name: 'C:\\Users\\Administrator\\secret' } },
    { kind: 'move', direction: 'diagonal', distance: 'near' },
    { kind: 'stop_movement' },
    { kind: 'resume_movement' },
    { kind: 'stop_movement', extra: true },
    { kind: 'play', target: { kind: 'state_name', name: '   ' } },
    { kind: 'play', target: { kind: 'action_name', name: 'a'.repeat(121) } }
  ])('拒绝越权或无效计划 %#', plan => {
    expect(characterBehaviorPlanSchema.safeParse(plan).success).toBe(false);
  });

  test('公开清单只保留有界角色人设与状态动作层级', () => {
    const catalog = publicBehaviorCatalogSchema.parse({
      identity: {
        name: '小猫', description: '温和的桌面伙伴', background: '来自数字花园',
        traits: ['gentle'], languageStyle: '简洁', likes: ['阳光'],
        behavioralTendencies: ['主动陪伴']
      },
      states: [{
        name: '休息', semantic: 'idle', description: '安静休息', tags: ['indoor'],
        actions: [{ name: '眨眼', semantic: 'idle', description: '轻轻眨眼', tags: ['gentle'] }]
      }]
    });

    expect(Object.keys(catalog).sort()).toEqual(['identity', 'states']);
    expect(publicBehaviorCatalogSchema.safeParse({
      ...catalog,
      actionId: 'private-action',
      absolutePath: 'C:\\Users\\Administrator\\secret',
      capabilityRef: 'builtin.files.delete_file'
    }).success).toBe(false);
  });

  test('聊天 JSON Schema 与合法的 none、play_state 计划同构', () => {
    expect(characterBehaviorPlanSchema.safeParse({ kind: 'none', emotion: 'calm' }).success).toBe(true);
    expect(characterBehaviorPlanSchema.safeParse({
      kind: 'play_state',
      state: '休息',
      action: '眨眼',
      duration: 'brief',
      emotion: 'happy'
    }).success).toBe(true);

    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<Record<string, unknown>>;
    };
    const kindOf = (plan: Record<string, unknown>) => (
      (plan.properties as Record<string, { const?: string }> | undefined)?.['kind']?.const
    );
    const none = behaviorPlan.oneOf.find(plan => kindOf(plan) === 'none');
    const playState = behaviorPlan.oneOf.find(plan => kindOf(plan) === 'play_state');
    if (!none || !playState) throw new Error('缺少 none 或 play_state JSON Schema 分支');

    expect(none).toMatchObject({
      additionalProperties: false,
      properties: { emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] } }
    });
    expect(playState).toMatchObject({
      additionalProperties: false,
      required: ['kind', 'state'],
      properties: {
        emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] },
        state: expect.objectContaining({ type: 'string' }),
        action: expect.objectContaining({ type: 'string' }),
        duration: { enum: ['brief', 'normal', 'extended'] }
      }
    });
  });

  test('聊天 JSON Schema 不声明旧扁平目标或私有控制字段', () => {
    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const playState = behaviorPlan.oneOf.find(
      plan => (plan.properties['kind'] as { const?: string }).const === 'play_state'
    );
    if (!playState) throw new Error('缺少 play_state JSON Schema 分支');

    expect(Object.keys(playState.properties).sort()).toEqual([
      'action', 'duration', 'emotion', 'kind', 'state'
    ]);
    expect(playState.properties).not.toHaveProperty('target');
    expect(playState.properties).not.toHaveProperty('actionId');
    expect(playState.properties).not.toHaveProperty('toolName');
  });

  test('聊天 JSON Schema 的名称规则拒绝全空白且允许合法 Unicode 名称', () => {
    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const playState = behaviorPlan.oneOf.find(
      plan => (plan.properties['kind'] as { const?: string }).const === 'play_state'
    );
    if (!playState) throw new Error('缺少 play_state JSON Schema 分支');
    const pattern = (playState.properties['action'] as { pattern: string }).pattern;

    expect(characterBehaviorPlanSchema.safeParse({
      kind: 'play_state', state: '休息', action: '   '
    }).success).toBe(false);
    expect(new RegExp(pattern, 'u').test('   ')).toBe(false);
    expect(new RegExp(pattern, 'u').test('挥手✨')).toBe(true);
  });

  test('聊天 JSON Schema 只用严格 movementControl 承载运动策略', () => {
    expect(characterChatResponseJsonSchema.required).toEqual(
      expect.arrayContaining(['movementControl', 'behaviorPlan'])
    );
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('movementControl');
    expect(characterChatResponseJsonSchema.properties).not.toHaveProperty('motionPlan');
    expect(characterChatResponseJsonSchema.properties.movementControl.oneOf).toHaveLength(3);
  });

  test.each([
    { kind: 'move', direction: 'left', distance: 'near' },
    { kind: 'move_region', region: 'bottom_right' }
  ])('聊天 behaviorPlan 不再具有运动策略权限 %#', behaviorPlan => {
    expect(characterChatResponseSchema.safeParse({
      text: '我会移动。',
      activity: '移动',
      status: 'moving',
      movementControl: { kind: 'keep' },
      behaviorPlan
    }).success).toBe(false);
  });
});
