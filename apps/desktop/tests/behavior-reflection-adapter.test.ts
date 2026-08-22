import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  BehaviorReflectionDiagnosticPort,
  createBehaviorReflectionAdapter
} from '../src/main/characters/behavior-reflection-adapter';
import type { ConversationBehaviorContext } from
  '../src/main/characters/character-behavior-director';

const context: ConversationBehaviorContext = {
  character: {
    characterName: '公开角色', semantics: ['idle'], stateNames: ['待机'],
    actionNames: ['眨眼'], tags: []
  },
  runtime: { moving: false, dragging: false, carrying: false, movementStopped: false },
  proactivityMode: 'autonomous',
  recentActions: []
};

function provider(response: ModelResponse | Promise<ModelResponse> | (() => Promise<ModelResponse>)) {
  let request: ModelRequest | null = null;
  const current: ModelProvider = {
    respond: vi.fn(async next => {
      request = next;
      return typeof response === 'function' ? response() : response;
    })
  };
  return { current, request: () => request };
}

describe('BehaviorReflectionAdapter', () => {
  test('只用当前 Provider、去标识上下文和无权限响应契约返回本地校验计划', async () => {
    const target = provider({
      type: 'text',
      text: '不得公开的 Provider 原文',
      structured_output: {
        behaviorPlan: { kind: 'play', target: { kind: 'action_name', name: '眨眼' } }
      }
    });
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const published = vi.fn();
    diagnostics.subscribe(published);
    const adapter = createBehaviorReflectionAdapter({
      createProvider: async () => target.current,
      diagnostics,
      now: () => 100
    });

    await expect(adapter.reflect({ context, signal: new AbortController().signal })).resolves.toEqual({
      kind: 'play', target: { kind: 'action_name', name: '眨眼' }
    });

    expect(target.request()).toMatchObject({
      tools: [],
      toolChoice: 'none',
      responseContract: { type: 'json_object', name: 'character_chat' }
    });
    expect(JSON.stringify(target.request())).toContain('公开角色');
    expect(published.mock.calls.map(call => call[0])).toEqual([
      { code: 'BEHAVIOR_REFLECTION_STARTED', phase: 'started' },
      {
        code: 'BEHAVIOR_REFLECTION_COMPLETED', phase: 'completed',
        hadPlan: true, durationMs: 0
      }
    ]);
    expect(JSON.stringify(published.mock.calls)).not.toContain('Provider 原文');
    expect(Object.keys(adapter)).not.toEqual(expect.arrayContaining([
      'file', 'powershell', 'mcp', 'history', 'message'
    ]));
  });

  test.each([
    ['NO_PLAN', { type: 'text', text: 'private', structured_output: {} } as ModelResponse],
    ['INVALID_PLAN', {
      type: 'text', text: 'private', structured_output: { behaviorPlan: { kind: 'move', direction: 'private' } }
    } as ModelResponse],
    ['PROVIDER_ERROR', () => Promise.reject(new Error('C:\\private\\provider.txt'))]
  ] as const)('%s 只发布有限原因码且不公开正文或异常', async (reasonCode, response) => {
    const target = provider(response);
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: unknown[] = [];
    diagnostics.subscribe(event => events.push(event));
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => target.current,
      diagnostics,
      now: () => 50
    });

    await adapter.reflect({ context, signal: new AbortController().signal }).catch(() => null);

    expect(events[0]).toEqual({ code: 'BEHAVIOR_REFLECTION_STARTED', phase: 'started' });
    expect(events.at(-1)).toMatchObject({
      code: 'BEHAVIOR_REFLECTION_DROPPED', phase: 'dropped', reasonCode
    });
    expect(JSON.stringify(events)).not.toMatch(/private|[A-Z]:\\/u);
  });

  test('BLOCKED、ABORTED 与 STALE_GENERATION 都丢弃且迟到正文无效', async () => {
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: Array<{ reasonCode?: string }> = [];
    diagnostics.subscribe(event => events.push(event));
    const target = provider({ type: 'text', text: 'private', structured_output: {} });
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => target.current, diagnostics, now: () => 0
    });

    await adapter.reflect({
      context: { ...context, runtime: { ...context.runtime, moving: true } },
      signal: new AbortController().signal
    });
    const aborted = new AbortController();
    aborted.abort();
    await adapter.reflect({ context, signal: aborted.signal });

    let resolve!: (value: ModelResponse) => void;
    const late = provider(new Promise<ModelResponse>(done => { resolve = done; }));
    const stale = createBehaviorReflectionAdapter({
      createProvider: () => late.current, diagnostics, now: () => 0
    });
    const pending = stale.reflect({ context, signal: new AbortController().signal });
    await stale.close();
    resolve({
      type: 'text', text: 'private-late',
      structured_output: { behaviorPlan: { kind: 'play', target: { kind: 'action_name', name: '眨眼' } } }
    });
    await expect(pending).resolves.toBeNull();

    expect(events.filter(event => event.reasonCode).map(event => event.reasonCode))
      .toEqual(['BLOCKED', 'ABORTED', 'STALE_GENERATION']);
  });

  test('completed 仅带 hadPlan 与 durationMs；端口拒绝未知原因和额外字段', async () => {
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: unknown[] = [];
    diagnostics.subscribe(event => events.push(event));
    const target = provider({
      type: 'text', text: 'private', structured_output: { behaviorPlan: { kind: 'none' } }
    });
    let now = 10;
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => target.current, diagnostics, now: () => now++
    });

    await adapter.reflect({ context, signal: new AbortController().signal });

    expect(events.at(-1)).toEqual({
      code: 'BEHAVIOR_REFLECTION_DROPPED', phase: 'dropped', durationMs: 1,
      reasonCode: 'NO_PLAN'
    });
    expect(() => diagnostics.publish({
      code: 'BEHAVIOR_REFLECTION_DROPPED', phase: 'dropped', reasonCode: 'PRIVATE'
    })).toThrow();
    expect(() => diagnostics.publish({
      code: 'BEHAVIOR_REFLECTION_COMPLETED', phase: 'completed', hadPlan: true,
      durationMs: 1,
      text: 'leak',
      path: 'C:\\private\\file.txt',
      x: 10,
      characterId: 'private-character-id',
      providerOutput: 'raw'
    })).toThrow();
  });
});
