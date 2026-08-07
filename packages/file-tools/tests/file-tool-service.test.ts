import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileToolService, type VerifiedWriteAction } from '../src/file-tool-service';
import { PathPolicy } from '../src/path-policy';
import type { RecycleBinPort } from '../src/recycle-bin-port';
import { toolArguments } from '../src/schemas';

const temporaryRoots: string[] = [];

async function fixtureService(recycleBinPort?: RecycleBinPort) {
  const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'docs'));
  return {
    root,
    service: new FileToolService(await PathPolicy.create(root), recycleBinPort)
  };
}

function movingRecycleBinPort(): RecycleBinPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async moveToRecycleBin(absolutePath) {
      calls.push(absolutePath);
      await rename(
        absolutePath,
        join(dirname(absolutePath), `.recycled-${basename(absolutePath)}`)
      );
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('FileToolService.preview 与 executeWrite', () => {
  it('回收站工具参数只接受非空相对路径', () => {
    expect(toolArguments.move_to_recycle_bin.parse({ relativePath: 'docs/old.txt' })).toEqual({
      relativePath: 'docs/old.txt'
    });
    expect(() => toolArguments.move_to_recycle_bin.parse({ relativePath: '' })).toThrow();
    expect(() => toolArguments.move_to_recycle_bin.parse({ relativePath: '   ' })).toThrow();
    expect(() => toolArguments.move_to_recycle_bin.parse({ relativePath: '/docs/old.txt' })).toThrow();
    expect(() => toolArguments.move_to_recycle_bin.parse({ relativePath: 'C:\\docs\\old.txt' })).toThrow();
    expect(() => toolArguments.move_to_recycle_bin.parse({
      relativePath: 'docs/old.txt',
      recursive: true
    })).toThrow();
  });

  it('公开写动作契约包含回收站分支且不携带系统能力', () => {
    const action = {
      id: 'recycle-1',
      toolName: 'move_to_recycle_bin',
      targetRelativePath: 'docs/old.txt'
    } satisfies VerifiedWriteAction;

    expect(action).toEqual({
      id: 'recycle-1',
      toolName: 'move_to_recycle_bin',
      targetRelativePath: 'docs/old.txt'
    });
  });

  it('预览新建文件时不修改磁盘，执行时排他创建空文件', async () => {
    const { service, root } = await fixtureService();
    const target = join(root, 'notes.md');

    const action = await service.preview({
      requestId: 'create-file-1',
      toolName: 'create_file',
      arguments: { relativePath: 'notes.md' }
    });

    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(action).toMatchObject({
      toolName: 'create_file',
      targetRelativePath: 'notes.md'
    });
    expect(JSON.stringify(action)).not.toContain(root);

    await service.executeWrite(action);
    expect((await lstat(target)).isFile()).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('');
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  });

  it('取消新建文件预览时磁盘保持不变', async () => {
    const { service, root } = await fixtureService();

    await service.preview({
      requestId: 'cancel-create-file',
      toolName: 'create_file',
      arguments: { relativePath: 'cancelled.md' }
    });

    await expect(lstat(join(root, 'cancelled.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('只创建一层目录且不递归创建父目录', async () => {
    const { service, root } = await fixtureService();
    const action = await service.preview({
      requestId: 'create-directory-1',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/new-directory' }
    });

    await service.executeWrite(action);
    expect((await lstat(join(root, 'docs', 'new-directory'))).isDirectory()).toBe(true);

    await expect(service.preview({
      requestId: 'create-directory-2',
      toolName: 'create_directory',
      arguments: { relativePath: 'missing/new-directory' }
    })).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });

  it('只允许在同一父目录内重命名且不覆盖目标', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'before.txt'), 'before', 'utf8');
    const action = await service.preview({
      requestId: 'rename-1',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/before.txt',
        targetRelativePath: 'docs/after.txt'
      }
    });

    await service.executeWrite(action);
    await expect(readFile(join(root, 'docs', 'after.txt'), 'utf8')).resolves.toBe('before');
    await expect(lstat(join(root, 'docs', 'before.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(join(root, 'docs', 'source.txt'), 'source', 'utf8');
    await writeFile(join(root, 'docs', 'existing.txt'), 'existing', 'utf8');
    await expect(service.preview({
      requestId: 'rename-2',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetRelativePath: 'docs/existing.txt'
      }
    })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(readFile(join(root, 'docs', 'existing.txt'), 'utf8')).resolves.toBe('existing');
  });

  it.runIf(process.platform === 'win32')('按 Windows 不区分大小写语义判断同一父目录', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'before.txt'), 'before', 'utf8');

    const action = await service.preview({
      requestId: 'rename-case-insensitive',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/before.txt',
        targetRelativePath: 'DOCS/after.txt'
      }
    });
    await service.executeWrite(action);

    await expect(readFile(join(root, 'docs', 'after.txt'), 'utf8')).resolves.toBe('before');
  });

  it('拒绝跨目录重命名和重命名授权根目录', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'docs', 'source.txt'), 'source', 'utf8');

    await expect(service.preview({
      requestId: 'rename-cross-directory',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetRelativePath: 'other/source.txt'
      }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    await expect(service.preview({
      requestId: 'rename-root',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: '.',
        targetRelativePath: 'renamed-root'
      }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it('执行前重新验证目标，预览后出现的冲突不会被覆盖', async () => {
    const { service, root } = await fixtureService();
    const action = await service.preview({
      requestId: 'late-conflict',
      toolName: 'create_file',
      arguments: { relativePath: 'late.txt' }
    });
    await writeFile(join(root, 'late.txt'), 'keep', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
    await expect(readFile(join(root, 'late.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('重命名预览后的目标冲突不会覆盖文件', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'source.txt'), 'source', 'utf8');
    const action = await service.preview({
      requestId: 'late-rename-conflict',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetRelativePath: 'docs/target.txt'
      }
    });
    await writeFile(join(root, 'docs', 'target.txt'), 'target', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(root, 'docs', 'target.txt'), 'utf8')).resolves.toBe('target');
  });

  it('拒绝伪造或复制的待执行动作', async () => {
    const { service } = await fixtureService();
    const action = await service.preview({
      requestId: 'unforgeable',
      toolName: 'create_file',
      arguments: { relativePath: 'safe.txt' }
    });
    const forged = { ...action } as VerifiedWriteAction;

    await expect(service.executeWrite(forged)).rejects.toMatchObject({
      code: 'ACTION_EXPIRED'
    });
  });

  it.each([
    ['普通文件', 'docs/old.txt', false],
    ['普通目录', 'docs/old-directory', true]
  ] as const)('通过可注入端口把%s移出原路径且公开动作不泄露绝对路径', async (
    _label,
    relativePath,
    directory
  ) => {
    const port = movingRecycleBinPort();
    const { service, root } = await fixtureService(port);
    const target = join(root, relativePath);
    if (directory) await mkdir(target);
    else await writeFile(target, '待回收内容', 'utf8');

    const action = await service.preview({
      requestId: `recycle-${relativePath}`,
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath }
    });

    expect(action).toEqual(expect.objectContaining({
      toolName: 'move_to_recycle_bin',
      targetRelativePath: relativePath.replaceAll('\\', '/')
    }));
    expect(JSON.stringify(action)).not.toContain(root);
    const resolvedTarget = await realpath(target);
    await service.executeWrite(action);

    expect(port.calls).toEqual([resolvedTarget]);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('拒绝回收授权根本身、越界路径和链接目标', async ({ skip }) => {
    const port = movingRecycleBinPort();
    const { service, root } = await fixtureService(port);
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

    await expect(service.preview({
      requestId: 'recycle-root',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: '.' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(service.preview({
      requestId: 'recycle-outside',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: '../outside/secret.txt' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    try {
      await symlink(outside, join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        skip(`当前系统不允许创建测试 Junction：${String(error.code)}`);
        return;
      }
      throw error;
    }
    await expect(service.preview({
      requestId: 'recycle-link',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: 'outside-link' }
    })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
    expect(port.calls).toEqual([]);
  });

  it('提交前目标被同路径新实体替换时返回 ENTRY_CHANGED 且不调用端口', async () => {
    const port = movingRecycleBinPort();
    const { service, root } = await fixtureService(port);
    const target = join(root, 'docs', 'replace-me.txt');
    const original = join(root, 'docs', 'original.txt');
    await writeFile(target, 'original', 'utf8');
    const action = await service.preview({
      requestId: 'recycle-replaced',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: 'docs/replace-me.txt' }
    });
    await rename(target, original);
    await writeFile(target, 'replacement', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    expect(port.calls).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('replacement');
  });

  it('提交前目标消失时返回稳定错误、动作被消费且不调用端口', async () => {
    const port = movingRecycleBinPort();
    const { service, root } = await fixtureService(port);
    const target = join(root, 'docs', 'vanished.txt');
    await writeFile(target, 'vanished', 'utf8');
    const action = await service.preview({
      requestId: 'recycle-vanished',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: 'docs/vanished.txt' }
    });
    await rm(target);

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(port.calls).toEqual([]);
  });

  it('回收动作在任何副作用前消费，成功、失败或伪造都不能重复调用端口', async () => {
    const port: RecycleBinPort = {
      moveToRecycleBin: vi.fn(async () => {
        throw new Error('系统错误包含 C:\\private\\secret.txt');
      })
    };
    const { service, root } = await fixtureService(port);
    await writeFile(join(root, 'docs', 'fail.txt'), 'keep', 'utf8');
    const action = await service.preview({
      requestId: 'recycle-port-failure',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: 'docs/fail.txt' }
    });

    const firstError = await service.executeWrite(action).then(
      () => null,
      error => error as Error & { code: string }
    );
    if (!firstError) throw new Error('预期回收站端口失败');
    expect(firstError).toMatchObject({ code: 'RECYCLE_BIN_FAILED' });
    expect(firstError.message).toBe('无法将目标移入系统回收站');
    expect(firstError.message).not.toContain(root);
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(service.executeWrite({ ...action })).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(port.moveToRecycleBin).toHaveBeenCalledTimes(1);
    await expect(readFile(join(root, 'docs', 'fail.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('拒绝没有移走目标却返回成功的端口，且动作仍不可重放', async () => {
    const port: RecycleBinPort = { moveToRecycleBin: vi.fn(async () => undefined) };
    const { service, root } = await fixtureService(port);
    await writeFile(join(root, 'docs', 'still-here.txt'), 'keep', 'utf8');
    const action = await service.preview({
      requestId: 'recycle-false-success',
      toolName: 'move_to_recycle_bin',
      arguments: { relativePath: 'docs/still-here.txt' }
    });

    await expect(service.executeWrite(action)).rejects.toMatchObject({
      code: 'RECYCLE_BIN_FAILED',
      message: '系统回收站未移走目标'
    });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(port.moveToRecycleBin).toHaveBeenCalledTimes(1);
  });

  it('现有创建与重命名写动作也统一为一次性，失败后不可重放', async () => {
    const { service, root } = await fixtureService();
    const createAction = await service.preview({
      requestId: 'one-shot-create',
      toolName: 'create_file',
      arguments: { relativePath: 'one-shot.txt' }
    });
    await writeFile(join(root, 'one-shot.txt'), 'collision', 'utf8');
    await expect(service.executeWrite(createAction)).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(service.executeWrite(createAction)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });

    await writeFile(join(root, 'docs', 'before-one-shot.txt'), 'before', 'utf8');
    const renameAction = await service.preview({
      requestId: 'one-shot-rename',
      toolName: 'rename_entry',
      arguments: {
        sourceRelativePath: 'docs/before-one-shot.txt',
        targetRelativePath: 'docs/after-one-shot.txt'
      }
    });
    await service.executeWrite(renameAction);
    await expect(service.executeWrite(renameAction)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  });

  it('读工具不能生成待确认写动作', async () => {
    const { service } = await fixtureService();

    await expect(service.preview({
      requestId: 'invalid-preview',
      toolName: 'list_directory',
      arguments: { relativePath: '.' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it('拒绝多余参数和超过 1024 个字符的路径', async () => {
    const { service } = await fixtureService();

    await expect(service.preview({
      requestId: 'unknown-argument',
      toolName: 'create_file',
      arguments: { relativePath: 'safe.txt', overwrite: true }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    await expect(service.preview({
      requestId: 'long-path',
      toolName: 'create_file',
      arguments: { relativePath: 'a'.repeat(1025) }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });
});

describe('FileToolService.executeRead', () => {
  it('只列出直接子项并返回本地元数据，不暴露绝对路径', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'a.txt'), 'hello', 'utf8');
    await mkdir(join(root, 'docs', 'nested'));
    await writeFile(join(root, 'docs', 'nested', 'hidden.txt'), 'hidden', 'utf8');

    const result = await service.executeRead({
      requestId: 'list-1',
      toolName: 'list_directory',
      arguments: { relativePath: 'docs' }
    });

    expect(result).toMatchObject({
      toolName: 'list_directory',
      relativePath: 'docs',
      truncated: false
    });
    if (result.toolName !== 'list_directory') throw new Error('预期目录结果');
    expect(result.entries.map(entry => entry.name).sort()).toEqual(['a.txt', 'nested']);
    expect(result.entries.find(entry => entry.name === 'a.txt')).toMatchObject({
      type: 'file',
      size: 5
    });
    expect(result.entries.find(entry => entry.name === 'nested')).toMatchObject({
      type: 'directory',
      size: null
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('hidden.txt');
  });

  it('默认列出授权根目录，最多返回 200 项并标记截断', async () => {
    const { service, root } = await fixtureService();
    await Promise.all(Array.from({ length: 201 }, async (_, index) => {
      await writeFile(join(root, `entry-${String(index).padStart(3, '0')}.txt`), '', 'utf8');
    }));

    const result = await service.executeRead({
      requestId: 'list-limit',
      toolName: 'list_directory',
      arguments: {}
    });

    if (result.toolName !== 'list_directory') throw new Error('预期目录结果');
    expect(result.relativePath).toBe('.');
    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('列目录时识别链接但不跟随链接', async () => {
    const { service, root } = await fixtureService();
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await service.executeRead({
      requestId: 'list-link',
      toolName: 'list_directory',
      arguments: {}
    });

    if (result.toolName !== 'list_directory') throw new Error('预期目录结果');
    expect(result.entries.find(entry => entry.name === 'outside-link')).toMatchObject({
      type: 'symbolic_link',
      size: null
    });
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });

  it('读取有效 UTF-8 普通文本并附带不可信数据警告', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'note.txt'), '你好，Myself', 'utf8');

    const result = await service.executeRead({
      requestId: 'read-text',
      toolName: 'read_text_file',
      arguments: { relativePath: 'docs/note.txt' }
    });

    expect(result).toMatchObject({
      toolName: 'read_text_file',
      relativePath: 'docs/note.txt',
      content: '你好，Myself'
    });
    if (result.toolName !== 'read_text_file') throw new Error('预期文本结果');
    expect(result.sizeBytes).toBe(Buffer.byteLength('你好，Myself'));
    expect(result.untrustedDataNotice).toContain('不可信数据');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('拒绝超过 1 MiB、无效 UTF-8 和非普通文件', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    await writeFile(join(root, 'docs', 'invalid.txt'), Buffer.from([0xc3, 0x28]));

    await expect(service.executeRead({
      requestId: 'read-large',
      toolName: 'read_text_file',
      arguments: { relativePath: 'docs/large.txt' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });

    await expect(service.executeRead({
      requestId: 'read-invalid',
      toolName: 'read_text_file',
      arguments: { relativePath: 'docs/invalid.txt' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });

    await expect(service.executeRead({
      requestId: 'read-directory',
      toolName: 'read_text_file',
      arguments: { relativePath: 'docs' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
  });

  it('写工具不能通过只读入口执行', async () => {
    const { service } = await fixtureService();

    await expect(service.executeRead({
      requestId: 'invalid-read',
      toolName: 'create_file',
      arguments: { relativePath: 'unexpected.txt' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });
});
