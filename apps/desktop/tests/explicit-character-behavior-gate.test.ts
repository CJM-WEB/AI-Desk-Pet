import { describe, expect, test } from 'vitest';
import { parseExplicitCharacterBehavior } from
  '../src/main/conversation/explicit-character-behavior-gate';

describe('显式桌宠行为 Gate', () => {
  test.each([
    ['停下', { kind: 'stop_movement' }],
    ['别走了', { kind: 'stop_movement' }],
    ['stop moving', { kind: 'stop_movement' }],
    ['恢复活动', { kind: 'resume_movement' }],
    ['可以动了', { kind: 'resume_movement' }],
    ['resume moving', { kind: 'resume_movement' }],
    ['向左一点', { kind: 'move', motion: { kind: 'relative', direction: 'left', distance: 'near' } }],
    ['往上远一点', { kind: 'move', motion: { kind: 'relative', direction: 'up', distance: 'far' } }],
    ['move right a little', { kind: 'move', motion: { kind: 'relative', direction: 'right', distance: 'near' } }],
    ['去右下角', { kind: 'move', motion: { kind: 'region', region: 'bottom_right' } }],
    ['go to the top left', { kind: 'move', motion: { kind: 'region', region: 'top_left' } }],
    ['走一走', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['walk around', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }]
  ] as const)('只解析命令式首句“%s”', (text, explicitDirective) => {
    expect(parseExplicitCharacterBehavior(text)).toEqual({
      capabilityText: text,
      explicitDirective
    });
  });

  test('组合指令只移除行为前缀并保留后续能力文本', () => {
    expect(parseExplicitCharacterBehavior('停下并删除 old.txt')).toEqual({
      capabilityText: '删除 old.txt',
      explicitDirective: { kind: 'stop_movement' }
    });
    expect(parseExplicitCharacterBehavior('stop moving and delete old.txt')).toEqual({
      capabilityText: 'delete old.txt',
      explicitDirective: { kind: 'stop_movement' }
    });
  });

  test.each([
    '别移动这个文件',
    '向左移动这个文件',
    'move right file.txt',
    '我们讨论一下“停下”是什么意思',
    '他说：停下',
    'stop talking about moving files',
    '> 停下',
    '“停下”',
    '`停下`',
    '```text\n停下\n```'
  ])('讨论、引用、代码或文件否定语句“%s”不会执行桌宠行为', text => {
    expect(parseExplicitCharacterBehavior(text)).toBeNull();
  });
});
