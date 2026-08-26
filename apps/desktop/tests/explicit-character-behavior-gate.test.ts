import { describe, expect, test } from 'vitest';
import { parseExplicitCharacterBehavior } from
  '../src/main/conversation/explicit-character-behavior-gate';

describe('显式桌宠行为 Gate', () => {
  test.each([
    ['停下', { kind: 'stop_movement' }],
    ['别走了', { kind: 'stop_movement' }],
    ['静止不动', { kind: 'stop_movement' }],
    ['保持静止', { kind: 'stop_movement' }],
    ['不要再动', { kind: 'stop_movement' }],
    ['别乱跑', { kind: 'stop_movement' }],
    ['停止不动', { kind: 'stop_movement' }],
    ['你停止不动', { kind: 'stop_movement' }],
    ['stop moving', { kind: 'stop_movement' }],
    ['恢复活动', { kind: 'resume_movement' }],
    ['可以动了', { kind: 'resume_movement' }],
    ['resume moving', { kind: 'resume_movement' }],
    ['向左一点', { kind: 'move', motion: { kind: 'relative', direction: 'left', distance: 'near' } }],
    ['往上远一点', { kind: 'move', motion: { kind: 'relative', direction: 'up', distance: 'far' } }],
    ['move right a little', { kind: 'move', motion: { kind: 'relative', direction: 'right', distance: 'near' } }],
    ['去右下角', { kind: 'move', motion: { kind: 'region', region: 'bottom_right' } }],
    ['go to the top left', { kind: 'move', motion: { kind: 'region', region: 'top_left' } }],
    ['请你移动', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['动', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['运动', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['跑', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['移动一下', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['你动一下', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['你跑一下', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['活动一下', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['开始运动', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['跑一跑', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['走一走', { kind: 'move', motion: { kind: 'wander', scope: 'short' } }],
    ['保持运动', { kind: 'continuous_movement' }],
    ['保持移动', { kind: 'continuous_movement' }],
    ['一直运动', { kind: 'continuous_movement' }],
    ['一直走', { kind: 'continuous_movement' }],
    ['一直跑', { kind: 'continuous_movement' }],
    ['继续跑', { kind: 'continuous_movement' }],
    ['跑远一点', { kind: 'move', motion: { kind: 'wander', scope: 'work_area', distance: 'far' } }],
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
    expect(parseExplicitCharacterBehavior('请播放挥手动作然后删除 old.txt')).toEqual({
      capabilityText: '删除 old.txt',
      explicitDirective: {
        kind: 'play',
        target: { kind: 'action_name', name: '挥手' }
      }
    });
  });

  test.each([
    ['请做一个后空翻动作', '后空翻'],
    ['请播放挥手动作', '挥手'],
    ['请表演庆祝动作', '庆祝'],
    ['please play wave animation', 'wave'],
    ['perform celebrate action', 'celebrate']
  ] as const)('动作终止词限定的命令“%s”解析为精确动作名并保留原文', (text, name) => {
    expect(parseExplicitCharacterBehavior(text)).toEqual({
      capabilityText: text,
      explicitDirective: {
        kind: 'play',
        target: { kind: 'action_name', name }
      }
    });
  });

  test('动作名长度按 Unicode 字符而非 UTF-16 码元计算', () => {
    const name = '跃'.repeat(119) + '✨';
    const text = `请播放${name}动作`;
    expect(parseExplicitCharacterBehavior(text)).toEqual({
      capabilityText: text,
      explicitDirective: { kind: 'play', target: { kind: 'action_name', name } }
    });
  });

  test.each([
    '请做一个动作',
    '请做一个文件',
    '请做一个发布计划',
    '请播放 C:/pet/wave.png 动作',
    '请播放 assets\\wave 动作',
    '请播放“挥手”动作',
    '请讨论播放挥手动作',
    `请播放${'✨'.repeat(121)}动作`,
    'please play animation',
    'please play assets/wave animation',
    'discuss playing wave animation'
  ])('空名、非动作命令、讨论、路径或非法名称“%s”不取得播放权限', text => {
    expect(parseExplicitCharacterBehavior(text)).toBeNull();
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
