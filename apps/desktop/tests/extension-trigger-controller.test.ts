import { describe, expect, test } from 'vitest';
import {
  extensionDefinitionsFromManifest,
  ExtensionTriggerController,
  type ExtensionTriggerDefinition
} from '../src/renderer/src/characters/player/extension-trigger-controller';
import type { CharacterManifestV1 } from '@myself/character-runtime';

const definitions: ExtensionTriggerDefinition[] = [
  {
    stateId: 'custom:wave',
    triggers: ['idle', 'single_click'],
    keywords: ['你好']
  },
  {
    stateId: 'custom:dance',
    triggers: ['double_click', 'context_menu'],
    keywords: ['跳舞'],
    emotions: ['happy']
  }
];

describe('扩展触发控制器', () => {
  test('覆盖待机、单击、双击、右键、关键词和 LLM 情绪', () => {
    const controller = new ExtensionTriggerController(definitions, () => 0);
    expect(controller.idle()?.stateId).toBe('custom:wave');
    expect(controller.pointer('single_click')?.stateId).toBe('custom:wave');
    expect(controller.pointer('double_click')?.stateId).toBe('custom:dance');
    expect(controller.pointer('context_menu')?.stateId).toBe('custom:dance');
    expect(controller.keyword('请跳舞')?.stateId).toBe('custom:dance');
    expect(controller.emotion('happy')?.stateId).toBe('custom:dance');
  });

  test('未知 LLM 扩展标识和未知情绪均被拒绝', () => {
    const controller = new ExtensionTriggerController(definitions);
    expect(controller.llmState('custom:missing')).toBeNull();
    expect(controller.emotion('unknown')).toBeNull();
  });

  test('只从当前 manifest 中构建有效扩展规则', () => {
    const current = {
      states: [{
        id: 'custom:wave',
        kind: 'extension',
        triggers: {
          events: ['single_click'],
          keywords: ['你好'],
          emotions: ['happy']
        },
        actions: []
      }, { id: 'idle', kind: 'core', actions: [] }]
    } as unknown as CharacterManifestV1;
    expect(extensionDefinitionsFromManifest(current)).toEqual([{
      stateId: 'custom:wave',
      triggers: ['single_click'],
      keywords: ['你好'],
      emotions: ['happy']
    }]);
  });

  test('关键词执行 NFKC、trim 和英文词边界且保留中日韩匹配', () => {
    const controller = new ExtensionTriggerController([
      { stateId: 'custom:cat', triggers: [], keywords: [' cat ', '你好'] }
    ]);
    expect(controller.keyword('concatenate')).toBeNull();
    expect(controller.keyword('say ＣＡＴ now')?.stateId).toBe('custom:cat');
    expect(controller.keyword('请说你好呀')?.stateId).toBe('custom:cat');
    expect(controller.keyword('   ')).toBeNull();
  });

  test.each(['thinking', 'acting', 'success', 'error'] as const)(
    '核心请求 %s 立即中断扩展并由既有仲裁器裁决',
    phase => {
      const controller = new ExtensionTriggerController(definitions, () => 0);
      expect(controller.pointer('single_click')?.type).toBe('extension');
      const snapshot = controller.reduce({ type: 'task', phase });
      expect(snapshot).toEqual({ stateId: phase, source: 'system' });
    }
  );

  test('搬运请求立即中断扩展并由既有仲裁器裁决', () => {
    const controller = new ExtensionTriggerController(definitions, () => 0);
    expect(controller.pointer('single_click')?.type).toBe('extension');
    expect(controller.reduce({ type: 'movement', carrying: true }))
      .toEqual({ stateId: 'carrying', source: 'system' });
  });

  test('单击延迟到双击窗口结束，双击取消单击且不影响聊天命令语义', () => {
    const controller = new ExtensionTriggerController(definitions);
    const first = controller.handlePointer('single_click', 100);
    expect(first.request).toBeNull();
    expect(first.openChat).toBe(false);
    const second = controller.handlePointer('double_click', 200);
    expect(second.request?.stateId).toBe('custom:dance');
    expect(second.openChat).toBe(true);
    expect(controller.flushPointer(500)).toBeNull();
  });

  test('右键只产生菜单触发，不打开聊天', () => {
    const controller = new ExtensionTriggerController(definitions);
    expect(controller.handlePointer('context_menu', 0)).toEqual({
      request: { type: 'extension', stateId: 'custom:dance' },
      openChat: false
    });
  });
});
