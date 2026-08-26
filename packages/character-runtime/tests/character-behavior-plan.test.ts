import { describe, expect, test } from 'vitest';
import {
  characterChatResponseJsonSchema,
  characterBehaviorPlanSchema,
  movementControlPlanSchema,
  motionPlanSchema,
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
    { kind: 'play', target: { kind: 'semantic', semantic: 'celebrate' }, emotion: 'happy' },
    { kind: 'move', direction: 'left', distance: 'near' },
    { kind: 'move_region', region: 'top_left' },
    { kind: 'stop_movement' },
    { kind: 'resume_movement' }
  ])('接受合法计划 %#', plan => {
    expect(characterBehaviorPlanSchema.safeParse(plan).success).toBe(true);
  });

  test.each([
    { kind: 'play', target: { kind: 'action_name', name: '挥手', actionId: 'private-action' } },
    { kind: 'move', direction: 'left', distance: 'near', x: 10, y: 20 },
    { kind: 'play', target: { kind: 'action_name', name: '挥手', toolName: 'builtin.files.delete_file' } },
    { kind: 'play', target: { kind: 'state_name', name: 'C:\\Users\\Administrator\\secret' } },
    { kind: 'move', direction: 'diagonal', distance: 'near' },
    { kind: 'stop_movement', extra: true },
    { kind: 'play', target: { kind: 'state_name', name: '   ' } },
    { kind: 'play', target: { kind: 'action_name', name: 'a'.repeat(121) } }
  ])('拒绝越权或无效计划 %#', plan => {
    expect(characterBehaviorPlanSchema.safeParse(plan).success).toBe(false);
  });

  test('公开清单只保留角色名称、语义、状态动作名称和标签', () => {
    const catalog = publicBehaviorCatalogSchema.parse({
      characterName: '小猫',
      semantics: ['idle', 'move'],
      stateNames: ['休息', '散步'],
      actionNames: ['眨眼', '走路'],
      tags: ['gentle', 'indoor']
    });

    expect(Object.keys(catalog).sort()).toEqual([
      'actionNames',
      'characterName',
      'semantics',
      'stateNames',
      'tags'
    ]);
    expect(publicBehaviorCatalogSchema.safeParse({
      ...catalog,
      actionId: 'private-action',
      absolutePath: 'C:\\Users\\Administrator\\secret',
      capabilityRef: 'builtin.files.delete_file'
    }).success).toBe(false);
  });

  test('聊天 JSON Schema 与合法的 none、play 计划同构', () => {
    expect(characterBehaviorPlanSchema.safeParse({ kind: 'none', emotion: 'calm' }).success).toBe(true);
    expect(characterBehaviorPlanSchema.safeParse({
      kind: 'play',
      target: { kind: 'tag', tag: 'gentle' },
      emotion: 'happy'
    }).success).toBe(true);

    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<Record<string, unknown>>;
    };
    const kindOf = (plan: Record<string, unknown>) => (
      (plan.properties as Record<string, { const?: string }> | undefined)?.['kind']?.const
    );
    const none = behaviorPlan.oneOf.find(plan => kindOf(plan) === 'none');
    const play = behaviorPlan.oneOf.find(plan => kindOf(plan) === 'play');
    if (!none || !play) throw new Error('缺少 none 或 play JSON Schema 分支');

    expect(none).toMatchObject({
      additionalProperties: false,
      properties: { emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] } }
    });
    expect(play).toMatchObject({
      additionalProperties: false,
      properties: {
        emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] },
        target: { oneOf: expect.any(Array) }
      }
    });
    expect((play.properties as Record<string, { oneOf?: unknown[] }> | undefined)?.['target']?.oneOf)
      .toHaveLength(4);
  });

  test('聊天 JSON Schema 不声明越权 target 字段，并对每个 target 分支严格封闭', () => {
    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const play = behaviorPlan.oneOf.find(plan => (plan.properties['kind'] as { const?: string }).const === 'play');
    if (!play) throw new Error('缺少 play JSON Schema 分支');
    const targets = (play.properties['target'] as { oneOf: Array<Record<string, unknown>> }).oneOf;

    expect(targets).toHaveLength(4);
    for (const target of targets) {
      expect(target).toMatchObject({ additionalProperties: false });
      expect(Object.keys((target.properties ?? {}) as Record<string, unknown>)).not.toEqual(
        expect.arrayContaining(['actionId', 'toolName', 'x', 'y'])
      );
    }
    expect(targets.map(target => target.required).sort()).toEqual([
      ['kind', 'name'],
      ['kind', 'name'],
      ['kind', 'semantic'],
      ['kind', 'tag']
    ]);
    expect(targets.map(target => (target.properties as Record<string, { const?: string }>)['kind']?.const).sort())
      .toEqual(['action_name', 'semantic', 'state_name', 'tag']);
  });

  test('聊天 JSON Schema 的名称规则拒绝全空白且允许合法 Unicode 名称', () => {
    const behaviorPlan = (characterChatResponseJsonSchema.properties as Record<string, unknown>)['behaviorPlan'] as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const play = behaviorPlan.oneOf.find(plan => (plan.properties['kind'] as { const?: string }).const === 'play');
    if (!play) throw new Error('缺少 play JSON Schema 分支');
    const actionTarget = ((play.properties['target'] as { oneOf: Array<{ properties: Record<string, unknown> }> }).oneOf)
      .find(target => (target.properties['kind'] as { const?: string }).const === 'action_name');
    if (!actionTarget) throw new Error('缺少 action_name JSON Schema 分支');
    const pattern = (actionTarget.properties['name'] as { pattern: string }).pattern;

    expect(characterBehaviorPlanSchema.safeParse({
      kind: 'play', target: { kind: 'action_name', name: '   ' }
    }).success).toBe(false);
    expect(new RegExp(pattern, 'u').test('   ')).toBe(false);
    expect(new RegExp(pattern, 'u').test('挥手✨')).toBe(true);
  });

  test.each([
    { mode: 'none', durationSeconds: null, target: 'current', distance: 'none' },
    { mode: 'stop', durationSeconds: null, target: 'current', distance: 'none' },
    { mode: 'once', durationSeconds: 1, target: 'random_work_area', distance: 'near' },
    { mode: 'continuous', durationSeconds: 600, target: 'bottom_right', distance: 'far' }
  ])('接受受限 motionPlan %#', motionPlan => {
    expect(motionPlanSchema.safeParse(motionPlan).success).toBe(true);
  });

  test.each([
    { mode: 'continuous', durationSeconds: 0, target: 'random_work_area', distance: 'medium' },
    { mode: 'continuous', durationSeconds: 601, target: 'random_work_area', distance: 'medium' },
    { mode: 'continuous', durationSeconds: 1.5, target: 'random_work_area', distance: 'medium' },
    { mode: 'once', durationSeconds: null, target: { x: 1, y: 2 }, distance: 'far' },
    { mode: 'once', durationSeconds: 1, target: 'outside', distance: 'far' },
    { mode: 'stop', durationSeconds: null, target: 'current', distance: 'none', extra: true },
    { mode: 'once', durationSeconds: null, target: 'random_work_area', distance: 'exact_pixels' }
  ])('拒绝越界或包含坐标的 motionPlan %#', motionPlan => {
    expect(motionPlanSchema.safeParse(motionPlan).success).toBe(false);
  });

  test('聊天 JSON Schema 强制要求严格 motionPlan', () => {
    expect(characterChatResponseJsonSchema.required).toEqual(
      expect.arrayContaining(['motionPlan', 'behaviorPlan'])
    );
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('motionPlan');
    expect(characterChatResponseJsonSchema.properties.motionPlan.required).toEqual(
      expect.arrayContaining(['distance'])
    );
  });
});
