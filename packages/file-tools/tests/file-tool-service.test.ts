import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileToolService, type VerifiedWriteAction } from '../src/file-tool-service';
import { PathPolicy } from '../src/path-policy';
import { toolArguments } from '../src/schemas';

const temporaryRoots: string[] = [];

async function fixtureService() {
  const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'docs'));
  return { root, service: new FileToolService(await PathPolicy.create(root)) };
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
    await expect(service.executeWrite(action)).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
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
