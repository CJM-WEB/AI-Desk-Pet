import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, waitForPermission } from './fixtures/coding-task-http';
import type { CodingSessionEvent } from '@myself/coding-task-core';
import type { TaskEvent } from '@myself/shared-types';
import { CodingTaskService } from '../src/main/agent/coding-task-service';
import { commandResource } from '@myself/coding-task-core';

test('循环许可仅投影工具与次数，结束直接中断并等待 run 与 close 两个屏障', async () => {
  const events: TaskEvent[] = [];
  const replies: unknown[] = [];
  const facts: unknown[] = [];
  let finishRun!: () => void;
  let finishCleanup!: () => void;
  let currentSignal!: AbortSignal;
  let cleanupEntered = false;
  const runGate = new Promise<void>(resolve => { finishRun = resolve; });
  const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({
      run: async (_text, signal) => {
        currentSignal = signal;
        for (const id of ['loop-1', 'loop-2']) options.onEvent({ type: 'permission', id, action: 'doom_loop', resources: ['read'], metadata: { repeatCount: 3, path: '私有路径', command: '私有命令' }, callId: '私有调用' });
        options.onEvent({ type: 'permission', id: 'ordinary', action: 'overwrite', resources: ['目标'] });
        await runGate;
        options.onEvent({ type: 'tool', name: 'read', callId: 'late', status: 'completed' });
        options.onEvent({ type: 'text', text: '迟到文本' });
        return { text: '迟到正文', toolCalls: 1 };
      },
      replyPermission: async (id, decision) => { replies.push({ id, decision }); },
      close: async () => { cleanupEntered = true; await cleanupGate; }
    }), emit: event => events.push(event), emitTrustedToolResult: fact => facts.push(fact)
  });
  const run = service.submitFileTask({ text: '检查', visibleHistory: [] });
  let ending: Promise<void> | undefined;
  try {
    await expect.poll(() => !!currentSignal).toBe(true);
    expect(events.filter(event => event.type === 'task_permission_required')).toEqual([
      ...['loop-1', 'loop-2'].map(actionId => ({ type: 'task_permission_required', actionId, summary: '重复操作保护', request: { action: 'doom_loop', tool: 'read', repeatCount: 3 } })),
      { type: 'task_permission_required', actionId: 'ordinary', summary: '覆盖已有文件', request: { action: 'overwrite', resources: ['目标'] } }
    ]);
    await service.confirm('loop-1');
    await expect(service.confirm('loop-1')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    let settled = false;
    ending = service.cancelAction('loop-2').then(() => { settled = true; });
    expect(currentSignal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(cleanupEntered).toBe(false);
    await expect(service.confirm('ordinary')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(replies).toEqual([{ id: 'loop-1', decision: 'once' }]);
    finishRun();
    await expect.poll(() => cleanupEntered).toBe(true);
    expect(settled).toBe(false);
    expect(events.some(event => event.type === 'phase' && ['success', 'cancelled'].includes(event.phase))).toBe(false);
    finishCleanup(); await ending; await run;
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    expect(facts).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/私有|迟到/u);
  } finally { finishRun(); finishCleanup(); await ending?.catch(() => undefined); await run; await service.close(); }
});

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
    createSession: async options => ({ run: async () => { options.onEvent({ type: 'permission', id: 'loop-ending', action: 'doom_loop', resources: ['read'], metadata: { repeatCount: 3 } }); started(); await runGate; options.onEvent({ type: 'tool', name: 'write', callId: 'late', status: 'completed' }); return { text: '迟到正文', toolCalls: 1 }; }, replyPermission: async () => undefined, close: async () => { cleanupStarted(); await cleanupGate; } }),
    emit: event => events.push(event), emitTrustedToolResult: result => facts.push(result)
  });
  const submission = service.submitFileTask({ text: '任务', visibleHistory: [] });
  await running;
  let settled = false;
  const ending = (action === 'cancel' ? service.cancelActive() : action === 'reset' ? service.resetForNewConversation() : service.close()).then(() => { settled = true; });
  await expect(service.confirm('loop-ending')).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  await expect(service.submitFileTask({ text: '下一任务', visibleHistory: [] })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
  finishRun(); await cleanupEntered;
  expect(settled).toBe(false);
  expect(events.some(event => event.type === 'phase' && ['success', 'cancelled'].includes(event.phase))).toBe(false);
  finishCleanup(); await Promise.all([submission, ending]);
  expect(facts).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('迟到正文');
  if (action !== 'close') expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
});

test.each([
  { results: [{ exit: 1 }], expected: 'error', expectedFacts: [false] },
  { results: [{ exit: 1 }, { exit: 0 }], expected: 'success', expectedFacts: [false, true] },
  { results: [{ timeout: true }], expected: 'error', expectedFacts: [false] },
  { results: [{ timeout: true }, { exit: 0 }], expected: 'success', expectedFacts: [false, true] }
] as const)('命令事实 $results 决定最近命令结果，不由模型成功声明覆盖', async ({ results, expected, expectedFacts }) => {
  const events: TaskEvent[] = [];
  const facts: { ok: boolean }[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({ run: async () => { for (const [index, result] of results.entries()) options.onEvent({ type: 'tool', name: 'bash', callId: `command-${index}`, status: 'completed', facts: result }); options.onEvent({ type: 'phase', phase: 'completed' }); return { text: '模型声称测试通过', toolCalls: results.length }; }, replyPermission: async () => undefined, close: async () => undefined }),
    emit: event => events.push(event), emitTrustedToolResult: fact => facts.push(fact)
  });
  await service.submitFileTask({ text: '运行测试', visibleHistory: [] });
  expect.soft(facts.map(fact => fact.ok)).toEqual(expectedFacts);
  expect(events.at(-1)).toEqual({ type: 'phase', phase: expected });
});

test.each(['resolve', 'reject'] as const)('真实 Core 回收站 %s 结算前 reset 不释放任务所有权', async settlement => {
  let entered!: () => void;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  let forward: (event: CodingSessionEvent) => void = () => undefined;
  const f = await fixture([[{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: note.txt\n*** Add File: late.txt\n+迟到变更\n*** End Patch' } }], '迟到成功'], {
    trashFile: async path => { entered(); await gate; await rename(path, path + '.trashed'); },
    onEvent: event => forward(event)
  });
  const events: TaskEvent[] = [];
  const facts: unknown[] = [];
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: f.directory, dataDirectory: f.dataDirectory, approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => { forward = options.onEvent; return f.session; },
    emit: event => events.push(event), emitTrustedToolResult: fact => facts.push(fact)
  });
  let run: Promise<unknown> | undefined;
  let resetting: Promise<void> | undefined;
  try {
    await writeFile(join(f.directory, 'note.txt'), '原始正文');
    run = service.submitFileTask({ text: '删除文件', visibleHistory: [] });
    await service.confirm((await waitForPermission(f.events, 'delete')).id);
    await started;
    let runSettled = false;
    void run.then(() => { runSettled = true; });
    resetting = service.resetForNewConversation();
    // 进入信号已证明宿主正在执行；短观察窗只用于检查取消是否提前结算。
    expect(await Promise.race([resetting.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 100))])).toBe('pending');
    expect(runSettled).toBe(false);
    await expect(service.submitFileTask({ text: '下一任务', visibleHistory: [] })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    if (settlement === 'resolve') release(); else reject(new Error('回收站拒绝'));
    await Promise.all([run, resetting]);
    expect(await readFile(join(f.directory, settlement === 'resolve' ? 'note.txt.trashed' : 'note.txt'), 'utf8')).toBe('原始正文');
    await expect(readFile(join(f.directory, 'late.txt'))).rejects.toBeDefined();
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    expect(events).not.toContainEqual({ type: 'phase', phase: 'success' });
    expect(facts).toEqual([]);
  } finally { release(); await run; await resetting; await service.close(); await f.close(); }
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

test.each(['unknown', 'hash', 'oversized', 'overflow', 'loop-resources', 'loop-tool', 'loop-count'] as const)('畸形或超限许可 %s 封闭失败并清理当前任务', async kind => {
  const events: TaskEvent[] = [];
  let cleaned = false;
  const service = new CodingTaskService({
    sessionOptions: async () => ({ directory: 'D:\\task', dataDirectory: 'D:\\data', commandShell: 'powershell.exe', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
    createSession: async options => ({
      run: async (_text, signal) => {
        for (let index = 0; index < (kind === 'overflow' ? 17 : 1); index += 1) {
          options.onEvent(kind.startsWith('loop-')
            ? { type: 'permission', id: 'loop-invalid', action: 'doom_loop', resources: kind === 'loop-resources' ? ['read', 'write'] : [kind === 'loop-tool' ? 'unknown' : 'read'], metadata: { repeatCount: kind === 'loop-count' ? 2 : 3 } }
            : kind === 'hash'
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
