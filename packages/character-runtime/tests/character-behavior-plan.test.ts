import { describe, expect, test } from 'vitest';
import {
  characterBehaviorPlanSchema,
  publicBehaviorCatalogSchema
} from '../src/character-behavior-plan';

describe('角色行为计划协议', () => {
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
});
