import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { characterManifestV3Schema, createPublicBehaviorCatalog } from '../../packages/character-runtime/src/index';
import type { ModelRequest } from '@myself/agent-core';
import {
  CharacterExpressionAdapter,
  characterAutonomyResponseContract,
  characterExpressionResponseContract
} from '../../apps/desktop/src/main/conversation/character-expression-adapter';
import { conversationTaskInstructions } from '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import { LocalModelProvider } from '../../apps/desktop/src/main/providers/local-model-provider';
import { characterBehaviorRoles } from '../../apps/desktop/src/main/characters/character-behavior-bindings';

const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(
  resolve('apps/desktop/resources/characters/default/compiled/manifest.json'), 'utf8')));
const behaviorContext = { character: createPublicBehaviorCatalog(manifest, manifest.defaultSkinId),
  runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false,
    carrying: false, movementMode: 0 as const }, proactivityMode: 'autonomous' as const, recentActions: [] };
const emptyBindings = Object.fromEntries(characterBehaviorRoles.map(role => [role, null]));
const emptyExpression = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null };

const decisionSchema = { anyOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['task'] }, text: { type: 'string', enum: [''] }
  }, required: ['kind', 'text'] },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['chat'] },
    text: { type: 'string', minLength: 1, maxLength: 4000 }
  }, required: ['kind', 'text'] }
] };

/** 启动与 Electron 同一假推理进程，只验证环回协议，不依赖真实模型或窗口。 */
describe('本地模型进程夹具协议', () => {
  let directory: string;
  let child: ChildProcess;
  let closed: Promise<unknown>;
  let baseUrl: string;
  const token = 'local-model-fixture-protocol-token';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'myself-local-protocol-'));
    const tokenFile = join(directory, 'token');
    const readyFile = join(directory, 'ready');
    await Promise.all([writeFile(tokenFile, token), writeFile(readyFile, '')]);
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('本地夹具端口不可用');
    await new Promise<void>((resolveClose, rejectClose) => reservation.close(error => error ? rejectClose(error) : resolveClose()));
    baseUrl = `http://127.0.0.1:${address.port}`;
    child = spawn(process.execPath, [resolve('tests/fixtures/fake-local-model-process.mjs'),
      '--mode=server', `--port=${address.port}`, `--token-file=${tokenFile}`,
      `--ready-file=${readyFile}`, '--stderr-canary=fixture-protocol-stderr'
    ], { shell: false, windowsHide: true, stdio: 'ignore' });
    closed = once(child, 'close');
    await vi.waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      expect(response.status).toBe(200);
    }, { timeout: 5_000 });
  });

  afterAll(async () => {
    if (child) { child.kill(); await closed; }
    if (directory) {
      await Promise.all(['token', 'ready'].map(file => unlink(join(directory, file))));
      await rmdir(directory);
    }
  });

  async function post(content: string, schema?: unknown, tools: unknown[] = []) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ai-pet-local', messages: [{ role: 'user', content }],
        tools, tool_choice: tools.length ? 'auto' : 'none', stream: false,
        ...(schema === undefined ? {} : { response_format: { type: 'json_object', schema } }) })
    });
  }

  async function request(content: string, schema: unknown) {
    const response = await post(content, schema);
    expect(response.status).toBe(200);
    const payload = await response.json() as { choices: Array<{ message: { content: string | null; tool_calls?: unknown[] } }> };
    return payload.choices[0]!.message;
  }

  test('真实 LocalModelProvider 主入口通过假进程 HTTP 交付正文与固定任务申请', async () => {
    const provider = new LocalModelProvider({ getReadyConnection: () => ({
      generation: 'fixture-protocol-generation', baseUrl: `${baseUrl}/v1`, token, modelId: 'ai-pet-local'
    }) });
    // 只构造宿主公开入口，让生产 Provider 自行生成线上 Schema，避免与夹具互相复制而假绿。
    const respond = (content: string) => provider.respond({
      purpose: 'conversation', messages: [{ role: 'system', content: conversationTaskInstructions },
        { role: 'user', content }],
      tools: [{ type: 'function', function: { name: 'request_task_authorization',
        description: '发起正式任务范围申请，仅用于用户已要求实际查阅、修改或执行命令。',
        parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
      } }], toolChoice: 'auto', reasoningMode: 'disabled'
    }, new AbortController().signal);

    await expect(respond('本地模型窗口生命周期问候')).resolves.toEqual({
      type: 'text', text: '本地模型 fixture 回复'
    });
    await expect(respond('请创建 switch-stale.txt')).resolves.toEqual({
      type: 'tool_request', request: { requestId: expect.any(String),
        toolName: 'request_task_authorization', arguments: {} }
    });
  });

  test.each([
    ['本地模型窗口生命周期问候', { kind: 'chat', text: '本地模型 fixture 回复' }],
    ['请创建 switch-stale.txt', { kind: 'task', text: '' }]
  ])('严格判别请求按生命周期样例返回合法分支：%s', async (prompt, expected) => {
    const message = await request(prompt, decisionSchema);
    expect(message.tool_calls).toBeUndefined();
    expect(JSON.parse(message.content!)).toEqual(expected);
  });

  test('真实用途匹配入口通过 LocalModelProvider 与 HTTP 交付九项独立绑定', async () => {
    const provider = new LocalModelProvider({ getReadyConnection: () => ({
      generation: 'fixture-bindings-generation', baseUrl: `${baseUrl}/v1`, token, modelId: 'ai-pet-local'
    }) });
    const requests = vi.spyOn(provider, 'respond');
    await expect(new CharacterExpressionAdapter(provider).respondBindings({
      behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual(emptyBindings);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0]![0]).toMatchObject({ tools: [], toolChoice: 'none', reasoningMode: 'disabled' });
  });

  test('独立角色表现返回正式扁平协议', async () => {
    const message = await request('本地模型窗口生命周期问候', characterExpressionResponseContract.jsonSchema);
    const output = JSON.parse(message.content!);
    expect(characterExpressionResponseContract.validateStructuredOutput(output)).toBe(true);
    expect(output).toEqual(emptyExpression);
  });

  test('自主表现只返回自主协议字段', async () => {
    const message = await request('准备移动', characterAutonomyResponseContract.jsonSchema);
    const output = JSON.parse(message.content!);
    expect(characterAutonomyResponseContract.validateStructuredOutput(output)).toBe(true);
    expect(output).toEqual(emptyExpression);
  });

  test('扁平表现的嵌套配对与自主控制 Schema 不得放宽', async () => {
    const expression = characterExpressionResponseContract.jsonSchema;
    const autonomy = characterAutonomyResponseContract.jsonSchema;
    for (const schema of [
      { ...expression, additionalProperties: true },
      { ...expression, required: expression.required.filter(field => field !== 'mode') },
      { ...expression, properties: { ...expression.properties, choice: { type: 'object' } } },
      { ...autonomy, properties: { ...autonomy.properties, mode: expression.properties.mode } }
    ]) {
      const response = await post('不能放宽表现协议', schema);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { message: 'LOCAL_MODEL_E2E_SCHEMA_UNSUPPORTED' } });
    }
  });

  test('用途匹配的完整角色与合法配对约束不得放宽', async () => {
    let captured: ModelRequest | undefined;
    // 从正式适配器捕获动态作者配对 Schema，避免测试自己复制一份合法协议。
    await new CharacterExpressionAdapter({ respond: async request => {
      captured = request; return { type: 'structured', structured_output: emptyBindings };
    } }).respondBindings({ behaviorContext, signal: new AbortController().signal });
    const schema = captured!.responseContract!.jsonSchema as {
      required: string[]; properties: Record<string, unknown>; $defs: Record<string, unknown>
    };
    for (const invalid of [
      { ...schema, additionalProperties: true },
      { ...schema, required: schema.required.filter(role => role !== 'moving') },
      { ...schema, properties: { ...schema.properties, moving: { type: 'object' } } },
      { ...schema, $defs: { choice: { anyOf: [{ type: 'object' }, { type: 'null' }] } } }
    ]) {
      const response = await post('不能放宽用途协议', invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { message: 'LOCAL_MODEL_E2E_SCHEMA_UNSUPPORTED' } });
    }
  });

  test.each([
    undefined,
    { type: 'object', properties: { unrelated: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['moodUpdate', 'expressionPlan', 'backgroundSelection'],
      properties: { moodUpdate: { type: 'null' }, expressionPlan: { type: 'null' }, backgroundSelection: { type: 'null' } } },
    { anyOf: [{ type: 'object', properties: { kind: { enum: ['chat'] } } }] },
    { ...decisionSchema, anyOf: decisionSchema.anyOf.map(branch => ({ ...branch, additionalProperties: true })) }
  ])('缺失、无关及放宽后的 Schema 明确失败，不能回退旧混合协议：%j', async schema => {
    const response = await post('本地模型窗口生命周期问候', schema);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'LOCAL_MODEL_E2E_SCHEMA_UNSUPPORTED' } });
  });

  test('旧文件工具请求不能作为当前任务授权入口', async () => {
    const response = await post('请创建 switch-stale.txt', undefined, [{ type: 'function', function: {
      name: 'builtin__files__create_file', parameters: { type: 'object' }
    } }]);
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty('choices');
  });

  test('合法判别 Schema 的对象字段重排不改变识别结果', async () => {
    const reordered = { anyOf: decisionSchema.anyOf.map(branch => ({
      required: branch.required, properties: { text: branch.properties.text, kind: branch.properties.kind },
      additionalProperties: branch.additionalProperties, type: branch.type
    })) };
    const message = await request('本地模型窗口生命周期问候', reordered);
    expect(JSON.parse(message.content!)).toEqual({ kind: 'chat', text: '本地模型 fixture 回复' });
  });
});
