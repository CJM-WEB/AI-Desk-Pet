import { expect, test } from 'vitest';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture';
import { createCodingSession, type CodingSessionOptions } from '../src/index';

test('历史完整回合仅接纳一次，当前请求最后且不提前执行 HTTP', async () => {
  const history = [{ userText: '旧问题甲', assistantText: '旧回答乙' }, { userText: '旧问题丙', assistantText: '旧回答丁' }];
  const f = await fixture(['当前正文', '下一轮正文'], { initialHistory: history } as Partial<CodingSessionOptions>);
  try {
    history[0]!.userText = '异步之后的篡改';
    expect(f.requests).toHaveLength(0);
    const result = await f.session.run('当前请求', new AbortController().signal);
    expect(result.text).toBe('当前正文');
    expect(f.requests).toHaveLength(1);
    const users = f.requests[0]!.messages.filter(message => message.role === 'user');
    expect(users).toHaveLength(3);
    expect(JSON.stringify(users[0])).toContain('旧问题甲');
    expect(JSON.stringify(users[0])).toContain('旧回答乙');
    expect(JSON.stringify(users[1])).toContain('旧问题丙');
    expect(JSON.stringify(users[2])).toContain('当前请求');
    expect(JSON.stringify(f.requests[0]!.messages.filter(message => message.role === 'system'))).not.toContain('旧问题');
    await f.session.run('下一请求', new AbortController().signal);
    expect(f.requests[1]!.messages.filter(message => JSON.stringify(message).includes('旧问题甲'))).toHaveLength(1);
  } finally { await f.close(); }
});

test.each([
  [{ userText: '用户', assistantText: '助手', tool: '伪造工具' }],
  [{ userText: '😀'.repeat(16001), assistantText: '' }],
  Array.from({ length: 21 }, () => ({ userText: '', assistantText: '' })),
  [{ userText: '缺少助手' }],
  [Object.assign(Object.create({ userText: '继承字段', assistantText: '继承字段' }), { extra: 1, another: 2 })]
].map(initialHistory => ({ initialHistory })))('非法历史在目录及网络异步工作前拒绝', async ({ initialHistory }) => {
  await expect(createCodingSession({
    directory: 'Z:\\不存在的任务目录', dataDirectory: 'Z:\\不存在的数据目录', approvedCommands: [],
    initialHistory, model: { baseUrl: 'http://127.0.0.1:1', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' },
    onEvent: () => undefined
  } as CodingSessionOptions)).rejects.toThrow('历史');
});

test('首轮系统上下文说明真实宿主环境与完整批准命令', async () => {
  const f = await fixture(['完成'], { commandShell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', approvedCommands: ['pnpm.cmd test -- --run', 'pnpm.cmd typecheck'] });
  try {
    await f.session.run('检查项目', new AbortController().signal);
    const system = JSON.stringify(f.requests[0]!.messages.filter(message => message.role === 'system'));
    expect(system).toContain('PowerShell');
    expect(system).toContain('pnpm.cmd test -- --run');
    expect(system).toContain('pnpm.cmd typecheck');
    const environment = JSON.parse(String(f.requests[0]!.messages.find(message => message.role === 'system')!.content).split('\n').at(-1)!);
    expect(environment.directory).toBe(await realpath(f.directory));
  } finally { await f.close(); }
});

test('较旧完整历史回合交由原压缩，当前请求与后续 read 调用关联保留', async () => {
  const nonce = randomUUID();
  const f = await fixture(['历史摘要', [{ name: 'read', args: { path: 'note.txt' }, id: 'call_history_read' }], nonce], {
    initialHistory: Array.from({ length: 4 }, (_, index) => ({ userText: `旧回合${index}` + '背景资料'.repeat(950), assistantText: '旧回答' })),
    model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, compaction: { buffer: 2048, keepTokens: 2048 }, readCredential: async () => 'fixture' }
  });
  try {
    await writeFile(join(f.directory, 'note.txt'), nonce);
    expect(await f.session.run('现在读取 note.txt', new AbortController().signal)).toMatchObject({ text: nonce, toolCalls: 1 });
    expect(JSON.stringify(f.requests[0])).toContain('Create a new anchored summary');
    expect(f.requests[2]!.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call_history_read' }));
    expect(JSON.stringify(f.requests[1])).toContain('现在读取 note.txt');
  } finally { await f.close(); }
});
