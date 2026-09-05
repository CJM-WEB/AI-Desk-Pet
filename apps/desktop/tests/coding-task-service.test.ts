import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, waitForPermission } from './fixtures/coding-task-http';
import type { CodingSessionEvent } from '@myself/coding-task-core';
import type { TaskEvent } from '@myself/shared-types';
import { CodingTaskService } from '../src/main/agent/coding-task-service';
import { commandResource } from '@myself/coding-task-core';

test('真实 Core 读取的正文先于清理完成后的成功终态', async () => {
  const nonce = randomUUID();
  let onEvent: (event: CodingSessionEvent) => void = () => undefined;
  const f = await fixture([[{ name: 'read', args: { path: 'note.txt' } }], nonce], { onEvent: event => onEvent(event) });
  const events: TaskEvent[] = [];
  const facts: unknown[] = [];
  let cleaned = false;
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: f.directory, dataDirectory: f.dataDirectory, approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => { onEvent = options.onEvent; return { ...f.session, close: async () => { await f.session.close(); cleaned = true; } }; },
    emit: event => { if (event.type === 'phase' && event.phase === 'success') expect(cleaned).toBe(true); events.push(event); },
    emitTrustedToolResult: fact => facts.push(fact)
  });
  try {
    await writeFile(join(f.directory, 'note.txt'), nonce);
    await service.submitFileTask({ text: '帮我看看 note.txt 里写了什么', visibleHistory: [] });
    expect(JSON.stringify(f.requests[1])).toContain(nonce);
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: nonce });
    expect(facts).toContainEqual(expect.objectContaining({ toolName: 'read', ok: true }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  } finally { await service.close(); await f.close(); }
});

test('Core 提前 completed 不提前释放，close 失败不发布成功或取消', async () => {
  const events: TaskEvent[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({ run: async () => { options.onEvent({ type: 'phase', phase: 'completed' }); return { text: '已获得正文', toolCalls: 0 }; }, replyPermission: async () => undefined, close: async () => { throw new Error('私有清理错误'); } }),
    emit: event => events.push(event)
  });
  await service.submitFileTask({ text: '任务', visibleHistory: [] });
  expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '已获得正文' });
  expect(events).not.toContainEqual({ type: 'phase', phase: 'success' });
  expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  expect(JSON.stringify(events)).not.toContain('私有清理错误');
  await expect(service.close()).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
});

test.each([
  { waiting: 'http', ending: 'cancel' }, { waiting: 'http', ending: 'reset' },
  { waiting: 'permission', ending: 'cancel' }, { waiting: 'permission', ending: 'reset' }
] as const)('真实 Core 在 $waiting 等待时 $ending，许可失效且迟到 HTTP 正文不公开', async ({ waiting, ending }) => {
  let release!: (text: string) => void;
  const delayed = new Promise<string>(resolve => { release = resolve; });
  let forward: (event: CodingSessionEvent) => void = () => undefined;
  const f = await fixture(waiting === 'http' ? [delayed] : [[{ name: 'write', args: { path: 'note.txt', content: '未批准覆盖' } }]], { onEvent: event => forward(event) });
  const events: TaskEvent[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: f.directory, dataDirectory: f.dataDirectory, approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => { forward = options.onEvent; return f.session; },
    emit: event => events.push(event)
  });
  try {
    await writeFile(join(f.directory, 'note.txt'), '原始正文');
    const run = service.submitFileTask({ text: '执行当前任务', visibleHistory: [] });
    let permissionId = '';
    if (waiting === 'permission') permissionId = (await waitForPermission(f.events, 'overwrite')).id;
    else await expect.poll(() => f.requests.length).toBe(1);
    if (ending === 'cancel') await service.cancelActive();
    else await service.resetForNewConversation();
    await run;
    release('迟到的网络正文');
    if (permissionId) await expect(service.confirm(permissionId)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(await readFile(join(f.directory, 'note.txt'), 'utf8')).toBe('原始正文');
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    expect(events).not.toContainEqual({ type: 'phase', phase: 'success' });
    expect(JSON.stringify(events)).not.toContain('迟到的网络正文');
  } finally { release('测试清理'); await service.close(); await f.close(); }
});

test('许可卡只投影已验证命令，未决 run 接收 once/reject 并拒绝重复 id', async () => {
  const events: TaskEvent[] = [];
  const replies: unknown[] = [];
  let finish!: () => void;
  let shown!: () => void;
  const permissionShown = new Promise<void>(resolve => { shown = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cwd = 'D:\\task';
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: cwd, dataDirectory: 'D:\\data', commandShell: shell, approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({ run: async () => {
      for (const id of ['permission-1', 'permission-2']) options.onEvent({ type: 'permission', id, action: 'bash', resources: [commandResource(shell, cwd, 'pnpm.cmd test')], metadata: { command: 'pnpm.cmd test', cwd, shell, secret: '不能进入卡片' }, callId: '私有调用' });
      shown(); await done; return { text: '总结', toolCalls: 0 };
    }, replyPermission: async (id, decision) => { replies.push({ id, decision }); }, close: async () => undefined }),
    emit: event => events.push(event)
  });
  const run = service.submitFileTask({ text: '检查', visibleHistory: [] });
  await permissionShown;
  expect(events.filter(event => event.type === 'task_permission_required')).toHaveLength(2);
  expect(JSON.stringify(events)).toContain('pnpm.cmd test');
  expect(JSON.stringify(events)).not.toContain('不能进入卡片');
  await service.confirm('permission-1');
  await expect(service.confirm('permission-1')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  await service.cancelAction('permission-2');
  expect(replies).toEqual([{ id: 'permission-1', decision: 'once' }, { id: 'permission-2', decision: 'reject' }]);
  finish(); await run;
  expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  await expect(service.confirm('permission-2')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
});

test.each(['cancel', 'reset', 'close'] as const)('%s 等待 run 和 close 屏障，丢弃迟到正文与工具结果', async action => {
  const events: TaskEvent[] = [];
  const facts: unknown[] = [];
  let finishRun!: () => void;
  let finishCleanup!: () => void;
  let started!: () => void;
  let cleanupStarted!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const cleanupEntered = new Promise<void>(resolve => { cleanupStarted = resolve; });
  const runGate = new Promise<void>(resolve => { finishRun = resolve; });
  const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({ run: async () => { started(); await runGate; options.onEvent({ type: 'tool', name: 'write', callId: 'late', status: 'completed' }); return { text: '迟到正文', toolCalls: 1 }; }, replyPermission: async () => undefined, close: async () => { cleanupStarted(); await cleanupGate; } }),
    emit: event => events.push(event), emitTrustedToolResult: result => facts.push(result)
  });
  const submission = service.submitFileTask({ text: '任务', visibleHistory: [] });
  await running;
  let settled = false;
  const ending = (action === 'cancel' ? service.cancelActive() : action === 'reset' ? service.resetForNewConversation() : service.close()).then(() => { settled = true; });
  await expect(service.submitFileTask({ text: '下一任务', visibleHistory: [] })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
  finishRun(); await cleanupEntered;
  expect(settled).toBe(false);
  expect(events.some(event => event.type === 'phase' && ['success', 'cancelled'].includes(event.phase))).toBe(false);
  finishCleanup(); await Promise.all([submission, ending]);
  expect(facts).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('迟到正文');
  if (action !== 'close') expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
});

test.each([{ exits: [1], expected: 'error' }, { exits: [1, 0], expected: 'success' }] as const)('命令退出事实 $exits 决定最近命令结果，不由模型成功声明覆盖', async ({ exits, expected }) => {
  const events: TaskEvent[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({ run: async () => { for (const exit of exits) options.onEvent({ type: 'tool', name: 'bash', callId: `command-${exit}`, status: 'completed', facts: { exit } }); options.onEvent({ type: 'phase', phase: 'completed' }); return { text: '模型声称测试通过', toolCalls: exits.length }; }, replyPermission: async () => undefined, close: async () => undefined }),
    emit: event => events.push(event)
  });
  await service.submitFileTask({ text: '运行测试', visibleHistory: [] });
  expect(events.at(-1)).toEqual({ type: 'phase', phase: expected });
});

test('零工具的正在读取回复也明确结束，不制造永久运行', async () => {
  let forward: (event: CodingSessionEvent) => void = () => undefined;
  const f = await fixture(['正在读取文件'], { onEvent: event => forward(event) });
  const events: TaskEvent[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: f.directory, dataDirectory: f.dataDirectory, approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => { forward = options.onEvent; return f.session; }, emit: event => events.push(event)
  });
  try {
    expect(await service.submitFileTask({ text: '读取文件', visibleHistory: [] })).toEqual({ kind: 'completed', acted: false });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  } finally { await service.close(); await f.close(); }
});

test.each(['unknown', 'hash', 'oversized', 'overflow'] as const)('畸形或超限许可 %s 封闭失败并清理当前任务', async kind => {
  const events: TaskEvent[] = [];
  let cleaned = false;
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', commandShell: 'powershell.exe', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({
      run: async (_text, signal) => {
        for (let index = 0; index < (kind === 'overflow' ? 17 : 1); index += 1) {
          options.onEvent(kind === 'hash'
            ? { type: 'permission', id: 'permission-1', action: 'bash', resources: ['command-sha256:tampered'], metadata: { command: 'private-command', cwd: 'D:\\task' } }
            : { type: 'permission', id: `permission-${index}`, action: kind === 'unknown' ? 'arbitrary' : 'overwrite', resources: [kind === 'oversized' ? 'x'.repeat(1025) : 'D:\\task\\note.txt'] });
        }
        expect(signal.aborted).toBe(true);
        throw new Error('私有Core中止');
      }, replyPermission: async () => undefined, close: async () => { cleaned = true; }
    }), emit: event => events.push(event)
  });
  await service.submitFileTask({ text: '任务', visibleHistory: [] });
  expect(cleaned).toBe(true);
  expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  expect(events.filter(event => event.type === 'task_permission_required')).toHaveLength(kind === 'overflow' ? 16 : 0);
  expect(JSON.stringify(events)).not.toContain('private-command');
  await expect(service.confirm('permission-0')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
});
