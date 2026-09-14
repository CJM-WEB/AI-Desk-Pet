import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { characterManifestV3Schema, createPublicBehaviorCatalog } from '@myself/character-runtime';
import type { ModelProvider, ModelRequest } from '@myself/agent-core';
import { CharacterExpressionAdapter } from '../src/main/conversation/character-expression-adapter';
import { characterBehaviorRoles, type CharacterBehaviorBindings } from '../src/main/characters/character-behavior-bindings';

const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(new URL('../resources/characters/default/compiled/manifest.json', import.meta.url), 'utf8')));
const character = createPublicBehaviorCatalog(manifest, manifest.defaultSkinId);
const behaviorContext = { character, runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false,
  moving: false, dragging: false, carrying: false, movementMode: 0 as const }, proactivityMode: 'autonomous' as const, recentActions: [] };
const bindings = Object.fromEntries(characterBehaviorRoles.map(role => [role, null])) as CharacterBehaviorBindings;
const input = { behaviorContext, signal: new AbortController().signal };
const providerFor = (output: Record<string, unknown>): ModelProvider => ({ respond: async () => ({ type: 'structured', structured_output: output }) });

test('用途匹配只读取作者公开目录且一次返回独立配对，同一动作可以服务多个用途', async () => {
  const output = { ...bindings, chatting: { stateId: 'state-7', actionId: 'state-7-action' },
    success: { stateId: 'state-8', actionId: 'state-8-action' }, praise: { stateId: 'state-8', actionId: 'state-8-action' } };
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { respond: async request => { requests.push(request); return { type: 'structured', structured_output: output }; } };
  expect(await new CharacterExpressionAdapter(provider).respondBindings(input)).toEqual(output);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none', reasoningMode: 'disabled' });
  expect(JSON.stringify(requests[0])).toContain('执行任务时表现工作状态');
  expect(JSON.stringify(requests[0])).not.toContain('idleForMs');
});
test.each([
  { ...bindings, moving: { stateId: 'state-6', actionId: 'state-7-action' } },
  { ...bindings, success: { stateId: 'unknown', actionId: 'unknown' } },
  { ...bindings, execute: 'powershell' },
])('非法用途输出不能成为可执行候选', async output => {
  await expect(new CharacterExpressionAdapter(providerFor(output)).respondBindings(input)).rejects.toThrow();
});
test('禁止推断的状态不进入用途匹配，未展示配对不能接纳', async () => {
  const restricted = { ...behaviorContext, character: { ...character,
    states: character.states.map(state => ({ ...state, agentInferable: state.stateId !== 'state-7' })) } };
  await expect(new CharacterExpressionAdapter(providerFor({ ...bindings, chatting: { stateId: 'state-7', actionId: 'state-7-action' } }))
    .respondBindings({ ...input, behaviorContext: restricted })).rejects.toThrow();
});
test('用途匹配超时会取消 Provider', async () => {
  vi.useFakeTimers();
  try {
    let child: AbortSignal | undefined;
    const provider: ModelProvider = { respond: async (_request, signal) => { child = signal; return new Promise(() => undefined); } };
    const rejected = expect(new CharacterExpressionAdapter(provider).respondBindings(input)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(12_000); await rejected;
    expect(child?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});
test('精简夸赞反应不依赖预先存在的心情强度，且不绑定聊天活动', async () => {
  const provider = providerFor({ kind: 'reaction', choice: { stateId: 'state-8', actionId: 'state-8-action' }, mode: 'keep', target: null, distance: null });
  expect(await new CharacterExpressionAdapter(provider).respond({ ...input, text: '你真棒' }, 'chat')).toMatchObject({
    requestKind: 'ambient', expressionPlan: { states: [{ stateId: 'state-8', minStrength: 0, lifetime: 'episode' }] }
  });
});
test.each(['continuous', 'intermittent'] as const)('精简%s意图复用已验证移动用途', async mode => {
  const provider = providerFor({ kind: 'movement', choice: null, mode, target: null, distance: null });
  const context = { ...behaviorContext, bindings: { ...bindings, moving: { stateId: 'state', actionId: 'state-action' } } };
  expect(await new CharacterExpressionAdapter(provider).respond({ ...input, behaviorContext: context, text: '动一动' }, 'chat')).toMatchObject({
    requestKind: 'movement', movementControl: { kind: 'set_mode', mode: mode === 'continuous' ? 1 : 2 },
    expressionPlan: { states: [{ stateId: 'state', when: { moving: true }, lifetime: 'condition' }] }
  });
});

test.each(['continuous', 'intermittent'] as const)('真实Qwen将%s称作持续背景时，已验证的移动用途仍按位移处理', async mode => {
  const choice = { stateId: 'state', actionId: 'state-action' };
  const provider = providerFor({ kind: 'background', choice, mode, target: null, distance: null });
  const reply = await new CharacterExpressionAdapter(provider).respond({ ...input,
    behaviorContext: { ...behaviorContext, bindings: { ...bindings, moving: choice } }, text: '一直动或间歇动' }, 'chat');
  expect(reply?.requestKind).toBe('movement');
  expect(reply?.movementControl).toEqual({ kind: 'set_mode', mode: mode === 'continuous' ? 1 : 2 });
  expect(reply).not.toHaveProperty('backgroundSelection');
  expect(reply).not.toHaveProperty('explicitPlayback');
});

test.each(['keep', 'still'] as const)('模型不能把已绑定移动动画作为%s的长期背景原地循环', async mode => {
  const choice = { stateId: 'state', actionId: 'state-action' };
  const provider = providerFor({ kind: 'background', choice, mode, target: null, distance: null });
  await expect(new CharacterExpressionAdapter(provider).respond({ ...input,
    behaviorContext: { ...behaviorContext, bindings: { ...bindings, moving: choice } }, text: '隔一会儿动一下' }, 'chat'))
    .rejects.toThrow();
});
