import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { CodingSession, CodingSessionEvent } from '../src/index';
const { createCodingSession }: typeof import('../src/index') = process.env.CODING_CORE_BUNDLE
  ? await import(pathToFileURL(process.env.CODING_CORE_BUNDLE).href)
  : await import('../src/index');

const directories: string[] = [];
const servers: Server[] = [];
test.runIf(process.env.CODING_TEST_ELECTRON === '1')('验收运行于实际 Electron 内置 Node', () => {
  expect(process.versions.electron).toBe('43.5.0');
  expect(process.versions.node).toBe('24.19.0');
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// 终态夹具保持真实核心与磁盘操作，仅控制远端模型协议的响应。
async function terminalFixture(mode: 'missing' | 'reject' | 'http' | 'cancel' | 'success', contextWindow = 8192) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet-terminal-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-terminal-data-'));
  directories.push(directory, dataDirectory);
  const secret = randomUUID();
  const outside = join(dataDirectory, 'outside.txt');
  await writeFile(outside, secret);
  const requests: unknown[] = [];
  const errors: unknown[] = [];
  const events: CodingSessionEvent[] = [];
  const controller = new AbortController();
  let session: CodingSession;
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      requests.push(JSON.parse(body));
      if (mode === 'http') { response.writeHead(500); response.end('{"error":{"message":"fixture unavailable"}}'); return; }
      if (mode === 'cancel') { controller.abort(); return; }
      const delta = mode === 'success' ? { content: requests.length === 1 ? 'first' : 'second' } : requests.length === 1
        ? { tool_calls: [{ index: 0, id: 'call_terminal', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: mode === 'reject' ? outside : 'missing.txt' }) } }] }
        : { content: requests.length === 2 ? '读取失败' : 'recovered' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ id: 'terminal', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'terminal', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: mode !== 'success' && requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  session = await createCodingSession({ directory, dataDirectory, approvedCommands: [], model: {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, modelId: 'fixture',
    contextWindow, outputTokens: 1024, readCredential: async () => 'fixture'
  }, onEvent: event => {
    events.push(event);
    if (event.type === 'permission') queueMicrotask(() => { void session.replyPermission(event.id, 'reject').catch(error => errors.push(error)); });
  } });
  return { session, events, errors, controller, requests, secret };
}

test.each(['missing', 'reject'] as const)('读取终态：%s 不泄露正文且不会停留在运行中', async mode => {
  const fixture = await terminalFixture(mode);
  try {
    await fixture.session.run('请读取文件', fixture.controller.signal).catch(error => { if (mode !== 'reject') throw error; });
    expect(fixture.errors).toEqual([]);
    expect(JSON.stringify(fixture.requests)).not.toContain(fixture.secret);
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'read', status: 'failed' }));
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'failed' });
    if (mode === 'reject') expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'permission', action: 'external_directory' }));
  } finally { await fixture.session.close(); }
});

test('HTTP 失败必须产生失败终态', async () => {
  const fixture = await terminalFixture('http');
  try {
    await fixture.session.run('请读取文件', fixture.controller.signal).catch(() => undefined);
    expect(fixture.errors).toEqual([]);
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'failed' });
  } finally { await fixture.session.close(); }
});

test('取消中断在途模型请求并结束任务', async () => {
  const fixture = await terminalFixture('cancel');
  try {
    await expect(fixture.session.run('请读取文件', fixture.controller.signal)).rejects.toBeDefined();
    expect(fixture.errors).toEqual([]);
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
  } finally { await fixture.session.close(); }
});

test('同一会话连续成功时每次仅返回本轮正文', async () => {
  const fixture = await terminalFixture('success');
  try {
    expect(await fixture.session.run('第一轮', fixture.controller.signal)).toEqual({ text: 'first', toolCalls: 0 });
    expect(await fixture.session.run('第二轮', fixture.controller.signal)).toEqual({ text: 'second', toolCalls: 0 });
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'completed' });
    expect(JSON.stringify(fixture.requests[1])).toContain('first');
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.session.close(); }
});

test('同一会话工具失败后成功不继承旧调用数和失败终态', async () => {
  const fixture = await terminalFixture('missing');
  try {
    expect(await fixture.session.run('读取不存在的文件', fixture.controller.signal)).toEqual({ text: '读取失败', toolCalls: 1 });
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'failed' });
    expect(await fixture.session.run('请直接回答 recovered', fixture.controller.signal)).toEqual({ text: 'recovered', toolCalls: 0 });
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'completed' });
    expect(JSON.stringify(fixture.requests[2])).toContain('call_terminal');
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.session.close(); }
});

test('本轮输入触发原自动压缩后仍返回本轮成功结果', async () => {
  const fixture = await terminalFixture('success', 25000);
  try {
    const result = await fixture.session.run('x'.repeat(40000), fixture.controller.signal);
    expect(fixture.requests).toHaveLength(2);
    expect(JSON.stringify(fixture.requests[0])).toContain('Create a new anchored summary');
    expect(JSON.stringify(fixture.requests[1])).toContain('first');
    expect(result).toEqual({ text: 'second', toolCalls: 0 });
    expect(fixture.events.at(-1)).toEqual({ type: 'phase', phase: 'completed' });
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.session.close(); }
});

// 随机正文只能经由原 read 工具进入第二轮请求；模型夹具不接触文件。
test('原 runner 将真实 read 结果关联到调用并生成最终正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet-read-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-data-'));
  directories.push(directory, dataDirectory);
  const nonce = randomUUID();
  await writeFile(join(directory, 'note.txt'), nonce, 'utf8');
  const bodies: Array<{ messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }> = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      bodies.push(JSON.parse(body));
      const delta = bodies.length === 1
        ? { tool_calls: [{ index: 0, id: 'call_read_note', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) } }] }
        : { content: nonce };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const events: CodingSessionEvent[] = [];
  const session = await createCodingSession({ directory, dataDirectory, approvedCommands: [], model: {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, modelId: 'fixture',
    contextWindow: 8192, outputTokens: 1024, readCredential: async () => 'fixture'
  }, onEvent: event => events.push(event) });
  try {
    const result = await session.run('请读取 note.txt 并显示内容', new AbortController().signal);
    expect(errors).toEqual([]);
    expect(JSON.stringify(bodies[0])).not.toContain(nonce);
    const returned = bodies[1]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_read_note');
    expect(JSON.stringify(returned?.content)).toContain(nonce);
    expect(result.text).toContain(nonce);
    expect(result.toolCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'read', status: 'completed' }));
  } finally { await session.close(); }
});
