import { PermissionV2 } from '@opencode-ai/core/permission';
import { Effect } from 'effect';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, waitForPermission, type Step } from './fixture';
import { randomUUID } from 'node:crypto';

test('单文件 grep 外部许可等待时被换为私有文件链接，批准后不读取正文', async () => {
  const { rename } = await import('node:fs/promises');
  const { helper, ripgrepExecutable } = await import('./windows-fixture');
  const steps: Step[] = [];
  const f = await fixture(steps, { windowsJobHelper: await helper(), ripgrepExecutable: await ripgrepExecutable() });
  const controller = new AbortController(); let execution: ReturnType<typeof f.session.run> | undefined;
  const nonce = `private-nonce-${randomUUID()}`;
  try {
    const target = join(f.dataDirectory, 'ordinary.txt');
    const secret = join(f.dataDirectory, '.codex', 'secret.txt');
    await mkdir(join(f.dataDirectory, '.codex')); await writeFile(secret, nonce); await writeFile(target, 'ordinary');
    steps.push([{ name: 'grep', args: { path: target, pattern: 'nonce' } }], '结束');
    execution = f.session.run('搜索外部文件', controller.signal);
    const permission = await waitForPermission(f.events, 'external_directory');
    await rename(target, target + '.original'); await symlink(secret, target, 'file');
    await f.session.replyPermission(permission.id, 'once');
    const result = await execution;
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).not.toContain(nonce);
    expect(JSON.stringify(result)).not.toContain(nonce);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'grep', status: 'failed' }));
  } finally { controller.abort(); await execution?.catch(() => undefined); await f.close(); }
});

test.each(['reject', 'once'] as const)('覆盖等待与 %s 后保持原字节或用户新字节', async decision => {
  const f = await fixture([[{ name: 'write', args: { path: 'existing.txt', content: 'after' } }], '结束']);
  const controller = new AbortController();
  let execution: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.directory, 'existing.txt'), 'before');
    execution = f.session.run('重写 existing.txt', controller.signal).catch(() => undefined);
    const permission = await waitForPermission(f.events, 'overwrite');
    expect(await readFile(join(f.directory, 'existing.txt'), 'utf8')).toBe('before');
    if (decision === 'once') await writeFile(join(f.directory, 'existing.txt'), 'changed-by-user');
    await f.session.replyPermission(permission.id, decision); await execution;
    expect(f.requests).toHaveLength(2);
    expect(await readFile(join(f.directory, 'existing.txt'), 'utf8')).toBe(decision === 'once' ? 'changed-by-user' : 'before');
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'write', status: 'failed' }));
  } finally { controller.abort(); await execution; await f.close(); }
});

test.each([
  { command: 'node check.cjs', workdir: '.', approved: true },
  { command: 'node check.cjs & echo unexpected>marker.txt', workdir: '.', approved: false },
  { command: 'node check.cjs\necho unexpected>marker.txt', workdir: '.', approved: false },
  { command: 'node check.cjs', workdir: 'subdir', approved: false },
  { command: 'echo wildcard-other>marker.txt', workdir: '.', approved: false }
])('命令完整匹配：$command / $workdir', async item => {
  const { helper } = await import('./windows-fixture');
  const f = await fixture([[{ name: 'bash', args: { command: item.command, workdir: item.workdir } }], '结束'], { approvedCommands: ['node check.cjs', 'echo wildcard-*>marker.txt'], windowsJobHelper: await helper() });
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await mkdir(join(f.directory, 'subdir')); await writeFile(join(f.directory, 'check.cjs'), 'require("node:fs").writeFileSync("marker.txt","approved");');
    execution = f.session.run('运行命令', controller.signal).catch(() => undefined);
    if (!item.approved) {
      const permission = await waitForPermission(f.events, 'bash');
      expect(permission.resources).toMatchObject([expect.stringMatching(/^command-sha256:[a-f0-9]{64}$/u)]);
      expect(permission.metadata).toMatchObject({ command: item.command });
      await f.session.replyPermission(permission.id, 'reject');
      await expect(f.session.replyPermission(permission.id, 'once')).rejects.toBeDefined();
    }
    await execution;
    if (item.approved) expect(await readFile(join(f.directory, 'marker.txt'), 'utf8')).toBe('approved');
    else { await expect(readFile(join(f.directory, 'marker.txt'))).rejects.toBeDefined(); await expect(readFile(join(f.directory, 'subdir', 'marker.txt'))).rejects.toBeDefined(); }
  } finally { controller.abort(); await execution; await f.close(); }
});

test('混合补丁删除许可拒绝前没有其他文件副作用', async () => {
  const f = await fixture([[{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Delete File: old.txt\n*** End Patch' } }], '结束']);
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.directory, 'old.txt'), 'old');
    execution = f.session.run('应用补丁', controller.signal).catch(() => undefined);
    const permission = await waitForPermission(f.events, 'delete');
    await expect(readFile(join(f.directory, 'new.txt'))).rejects.toBeDefined();
    await f.session.replyPermission(permission.id, 'reject'); await execution;
    await expect(readFile(join(f.directory, 'new.txt'))).rejects.toBeDefined();
    expect(await readFile(join(f.directory, 'old.txt'), 'utf8')).toBe('old');
  } finally { controller.abort(); await execution; await f.close(); }
});

test.each(['read', 'glob', 'grep', 'write', 'edit'] as const)('%s 拒绝 Junction 和私有配置路径', async name => {
  for (const target of ['link', '.codex']) {
    const args = name === 'glob' || name === 'grep' ? { pattern: 'private', path: target } : { path: target + '/secret.txt', content: 'changed', oldString: 'private', newString: 'changed' };
    const f = await fixture([[{ name, args }], '结束']); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await writeFile(join(f.dataDirectory, 'secret.txt'), 'private-nonce');
      await symlink(f.dataDirectory, join(f.directory, 'link'), 'junction');
      await mkdir(join(f.directory, '.codex')); await writeFile(join(f.directory, '.codex', 'secret.txt'), 'private-nonce');
      await f.session.run('处理文件', controller.signal).catch(() => undefined);
      expect(JSON.stringify(f.requests)).not.toContain('private-nonce');
      expect(await readFile(join(f.dataDirectory, 'secret.txt'), 'utf8')).toBe('private-nonce');
      expect(await readFile(join(f.directory, '.codex', 'secret.txt'), 'utf8')).toBe('private-nonce');
      expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name, status: 'failed' }));
    } finally { clearTimeout(timer); controller.abort(); await f.close(); }
  }
});

test('新文件、精确编辑与多工具 ID 经过原 runner 连续执行', async () => {
  const f = await fixture([
    [{ name: 'write', args: { path: 'one.txt', content: 'one' }, id: 'write_one' }, { name: 'write', args: { path: 'two.txt', content: 'two' }, id: 'write_two' }],
    [{ name: 'edit', args: { path: 'one.txt', oldString: 'one', newString: 'three' } }], '完成'
  ]);
  try {
    const result = await f.session.run('创建后编辑', new AbortController().signal);
    expect(await readFile(join(f.directory, 'one.txt'), 'utf8')).toBe('three');
    expect(await readFile(join(f.directory, 'two.txt'), 'utf8')).toBe('two');
    expect(result.toolCalls).toBe(3);
    expect(f.requests[1]?.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['write_one', 'write_two']);
    expect(f.events.filter(e => e.type === 'permission')).toEqual([]);
  } finally { await f.close(); }
});

test('删除只能调用宿主回收站；缺回调或批量删除均无副作用', async () => {
  for (const mode of ['missing', 'trash', 'batch']) {
    const trashed: string[] = [];
    const { rename } = await import('node:fs/promises');
    const patchText = '*** Begin Patch\n*** Delete File: old.txt\n' + (mode === 'batch' ? '*** Delete File: second.txt\n' : '') + '*** End Patch';
    const f = await fixture([[{ name: 'apply_patch', args: { patchText } }], '结束'], { ...(mode === 'trash' ? { trashFile: async (path: string) => { trashed.push(path); await rename(path, path + '.trashed'); } } : {}), onEvent: event => { if (event.type === 'permission') queueMicrotask(() => { void f.session.replyPermission(event.id, 'once'); }); } });
    try {
      await writeFile(join(f.directory, 'old.txt'), 'old'); await writeFile(join(f.directory, 'second.txt'), 'second');
      await f.session.run('删除指定文件', new AbortController().signal);
      if (mode === 'trash') { expect(trashed).toHaveLength(1); expect(await readFile(join(f.directory, 'old.txt.trashed'), 'utf8')).toBe('old'); }
      else { expect(trashed).toHaveLength(0); expect(await readFile(join(f.directory, 'old.txt'), 'utf8')).toBe('old'); }
      expect(await readFile(join(f.directory, 'second.txt'), 'utf8')).toBe('second');
    } finally { await f.close(); }
  }
});

test('任务实例不共享命令许可或待处理 ID，取消后许可失效', async () => {
  const { helper } = await import('./windows-fixture'); const command = 'echo scoped';
  const a = await fixture([[{ name: 'bash', args: { command } }], '结束'], { approvedCommands: [command], windowsJobHelper: await helper() });
  const b = await fixture([[{ name: 'bash', args: { command } }], '结束'], { windowsJobHelper: await helper() });
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await a.session.run('执行已批准命令', new AbortController().signal);
    execution = b.session.run('同命令新任务', controller.signal).catch(() => undefined);
    const permission = await waitForPermission(b.events, 'bash');
    await expect(a.session.replyPermission(permission.id, 'once')).rejects.toBeDefined();
    controller.abort(); await execution;
    await expect(b.session.replyPermission(permission.id, 'once')).rejects.toBeDefined();
    expect(b.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
  } finally { controller.abort(); await execution; await a.close(); await b.close(); }
});

test('覆盖许可等待时父目录改为 Junction，批准后仍拒绝越界写入', async () => {
  const { rename } = await import('node:fs/promises');
  const f = await fixture([[{ name: 'write', args: { path: 'subdir/victim.txt', content: 'after' } }], '结束']);
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await mkdir(join(f.directory, 'subdir')); await writeFile(join(f.directory, 'subdir', 'victim.txt'), 'before'); await writeFile(join(f.dataDirectory, 'victim.txt'), 'before');
    execution = f.session.run('覆盖文件', controller.signal).catch(() => undefined);
    const permission = await waitForPermission(f.events, 'overwrite');
    await rename(join(f.directory, 'subdir'), join(f.directory, 'original')); await symlink(f.dataDirectory, join(f.directory, 'subdir'), 'junction');
    await f.session.replyPermission(permission.id, 'once'); await execution;
    expect(await readFile(join(f.dataDirectory, 'victim.txt'), 'utf8')).toBe('before');
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'write', status: 'failed' }));
  } finally { controller.abort(); await execution; await f.close(); }
});

// 模型必须收到真实拒绝语义，同时原任务仍可继续执行其他已许可读取。
test.each([
  { name: 'bash', action: 'bash', args: { command: 'Remove-Item keep.txt', workdir: '.' } },
  { name: 'apply_patch', action: 'delete', args: { patchText: '*** Begin Patch\n*** Delete File: keep.txt\n*** End Patch' } },
])('$name 拒绝反馈保留用户决定且不取消其他许可操作', async item => {
  const f = await fixture([[{ name: item.name, args: item.args }], [{ name: 'read', args: { path: 'note.txt' } }], '结束']);
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.directory, 'keep.txt'), 'unchanged');
    await writeFile(join(f.directory, 'note.txt'), 'allowed-read');
    execution = f.session.run('执行本轮任务', controller.signal);
    const permission = await waitForPermission(f.events, item.action);
    await f.session.replyPermission(permission.id, 'reject');
    await execution;
    expect(f.requests).toHaveLength(3);
    const refusal = JSON.stringify(f.requests[1]!.messages.filter(message => message.role === 'tool'));
    expect(refusal).toContain('The user rejected permission');
    expect(refusal).not.toContain('Unable to');
    expect(await readFile(join(f.directory, 'keep.txt'), 'utf8')).toBe('unchanged');
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'read', status: 'completed' }));
    await f.session.close();
  } finally { controller.abort(); await execution?.catch(() => undefined); await f.close(); }
});

test('V2拒绝错误经真实Effect保留明确决定与补充反馈，未知异常不被透传', async () => {
  expect(PermissionV2.rejectionMessage(new Error('private diagnostic'))).toBeUndefined();
  for (const error of [new PermissionV2.DeclinedError(), new PermissionV2.CorrectedError({ feedback: 'keep the file' })]) {
    const message = await Effect.runPromise(Effect.fail(error).pipe(Effect.catch(value => Effect.succeed(value.message))));
    expect(message).toContain('The user rejected permission');
    expect(message).toContain('Do not retry');
    if (error instanceof PermissionV2.CorrectedError) expect(message).toContain('keep the file');
  }
});

test('外部目录读取拒绝反馈明确，随后独立根内读取仍正常完成', async () => {
  const steps: Step[] = [];
  const f = await fixture(steps); const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    const outside = join(f.dataDirectory, 'outside.txt');
    await writeFile(outside, 'private-outside'); await writeFile(join(f.directory, 'note.txt'), 'allowed-read');
    steps.push([{ name: 'read', args: { path: outside } }], [{ name: 'read', args: { path: 'note.txt' } }], '结束');
    execution = f.session.run('读取本轮文件', controller.signal);
    const permission = await waitForPermission(f.events, 'external_directory');
    await f.session.replyPermission(permission.id, 'reject'); await execution;
    expect(f.requests).toHaveLength(3);
    const refusal = JSON.stringify(f.requests[1]!.messages.filter(message => message.role === 'tool'));
    expect(refusal).toContain('The user rejected permission');
    expect(JSON.stringify(f.requests)).not.toContain('private-outside');
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'read', status: 'completed' }));
    await f.session.close();
  } finally { controller.abort(); await execution?.catch(() => undefined); await f.close(); }
});
