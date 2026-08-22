import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  BehaviorReflectionDiagnosticPort,
  createBehaviorReflectionAdapter,
  type BehaviorReflectionDiagnostic
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
    const events: BehaviorReflectionDiagnostic[] = [];
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
    const noPlan = provider({ type: 'text', text: 'private', structured_output: {} });
    let providerCall = 0;
    const stale = createBehaviorReflectionAdapter({
      createProvider: () => providerCall++ === 0 ? late.current : noPlan.current,
      diagnostics,
      now: () => 0
    });
    const pending = stale.reflect({ context, signal: new AbortController().signal });
    await stale.reflect({ context, signal: new AbortController().signal });
    resolve({
      type: 'text', text: 'private-late',
      structured_output: { behaviorPlan: { kind: 'play', target: { kind: 'action_name', name: '眨眼' } } }
    });
    await expect(pending).resolves.toBeNull();
    await stale.close();

    expect(events.filter(event => event.phase === 'dropped').map(event => event.reasonCode))
      .toEqual(['BLOCKED', 'ABORTED', 'STALE_GENERATION', 'NO_PLAN']);
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

  test('慢 Provider 工厂等待期间 close 后不调用 respond，且 STARTED 必有终端诊断', async () => {
    let resolveProvider!: (value: ModelProvider) => void;
    const respond = vi.fn<ModelProvider['respond']>();
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: Array<{ phase: string; reasonCode?: string }> = [];
    diagnostics.subscribe(event => events.push(event));
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => new Promise(done => { resolveProvider = done; }),
      diagnostics,
      now: () => 0
    });

    const pending = adapter.reflect({ context, signal: new AbortController().signal });
    const closing = adapter.close();
    await expect(Promise.race([
      closing.then(() => 'closed'),
      new Promise<string>(done => setTimeout(() => done('timeout'), 25))
    ])).resolves.toBe('closed');
    resolveProvider({ respond });

    await expect(pending).resolves.toBeNull();
    expect(respond).not.toHaveBeenCalled();
    expect(events).toEqual([
      { code: 'BEHAVIOR_REFLECTION_STARTED', phase: 'started' },
      {
        code: 'BEHAVIOR_REFLECTION_DROPPED', phase: 'dropped', durationMs: 0,
        reasonCode: 'ABORTED'
      }
    ]);
  });

  test('Provider respond 永不 settle 时 close 有界并同步发布唯一 ABORTED 终端', async () => {
    let resolveResponse!: (value: ModelResponse) => void;
    const respond = vi.fn(() => new Promise<ModelResponse>(done => { resolveResponse = done; }));
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: BehaviorReflectionDiagnostic[] = [];
    diagnostics.subscribe(event => events.push(event));
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => ({ respond }), diagnostics, now: () => 0
    });
    const pending = adapter.reflect({ context, signal: new AbortController().signal });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());

    const closeResult = await Promise.race([
      adapter.close().then(() => 'closed'),
      new Promise<string>(done => setTimeout(() => done('timeout'), 25))
    ]);

    expect(closeResult).toBe('closed');
    expect(events).toEqual([
      { code: 'BEHAVIOR_REFLECTION_STARTED', phase: 'started' },
      {
        code: 'BEHAVIOR_REFLECTION_DROPPED', phase: 'dropped', durationMs: 0,
        reasonCode: 'ABORTED'
      }
    ]);
    await expect(pending).resolves.toBeNull();
    resolveResponse({
      type: 'text', text: 'late-private',
      structured_output: {
        behaviorPlan: { kind: 'play', target: { kind: 'semantic', semantic: 'idle' } }
      }
    });
    await Promise.resolve();
    expect(events).toHaveLength(2);
  });

  test.each([
    { kind: 'move', direction: 'left', distance: 'medium' },
    { kind: 'move', direction: 'left', distance: 'far' },
    { kind: 'move_region', region: 'top_left' },
    { kind: 'stop_movement' },
    { kind: 'resume_movement' }
  ])('严格丢弃非原地或非 near 的反思计划 %#', async behaviorPlan => {
    const diagnostics = new BehaviorReflectionDiagnosticPort();
    const events: BehaviorReflectionDiagnostic[] = [];
    diagnostics.subscribe(event => events.push(event));
    const target = provider({ type: 'text', text: 'private', structured_output: { behaviorPlan } });
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => target.current,
      diagnostics,
      now: () => 0
    });

    await expect(adapter.reflect({ context, signal: new AbortController().signal }))
      .resolves.toBeNull();
    expect(events.at(-1)).toMatchObject({ reasonCode: 'INVALID_PLAN' });
  });

  test('复用聊天 JSON Output 提示契约的小写 json 与精确示例', async () => {
    const target = provider({ type: 'text', text: 'private', structured_output: {} });
    const adapter = createBehaviorReflectionAdapter({
      createProvider: () => target.current,
      diagnostics: new BehaviorReflectionDiagnosticPort()
    });

    await adapter.reflect({ context, signal: new AbortController().signal });

    const system = target.request()?.messages[0]?.content ?? '';
    expect(system).toContain('请只返回 json 对象，不要添加对象外文字。');
    expect(system).toContain(
      '格式示例：{"text":"我会陪着你。","behaviorPlan":{"kind":"none","emotion":"calm"}}'
    );
  });
});
