import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import { FileToolService } from '../src/file-tool-service';
import { PathPolicy } from '../src/path-policy';
import type { RecycleBinPort } from '../src/recycle-bin-port';
import { toolArguments } from '../src/schemas';

const temporaryRoots: string[] = [];

/** 为每个用例隔离授权根目录，避免文件系统状态互相影响。 */
async function fixtureService(
  recycleBinPort?: RecycleBinPort,
  getAuthorizationGeneration?: () => number,
  renameOperation?: (source: string, destination: string) => Promise<void>
): Promise<{ service: FileToolService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'docs'));
  const fileOperations = renameOperation === undefined
    ? undefined
    : { open, rename: renameOperation, unlink, mkdir };
  return {
    service: new FileToolService(
      await PathPolicy.create(root),
      recycleBinPort,
      getAuthorizationGeneration,
      fileOperations
    ),
    root
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('文件工具 schema', () => {
  it('查询与精确编辑参数保持严格，且旧工具名称不存在', () => {
    expect(Object.keys(toolArguments).sort()).toEqual([
      'apply_patch',
      'create_directory',
      'create_file',
      'delete_file',
      'edit_file',
      'glob_files',
      'grep_files',
      'list_files',
      'move_file',
      'read_file'
    ]);
    expect((toolArguments as Record<string, unknown>)['copy_file']).toBeUndefined();
    expect(() => toolArguments.create_file.parse({ relativePath: 'a.txt', extra: true })).toThrow();
    expect(() => toolArguments.create_directory.parse({ relativePath: 'abc', recursive: true })).toThrow();
    expect(() => toolArguments.move_file.parse({
      sourceRelativePath: 'source.txt',
      targetDirectoryRelativePath: 'target',
      overwrite: true
    })).toThrow();
    expect(() => toolArguments.edit_file.parse({
      relativePath: 'source.txt',
      oldString: 'old',
      newString: 'new',
      fuzzy: true
    })).toThrow();
    expect((toolArguments as Record<string, unknown>)['copy_entry']).toBeUndefined();
  });
});

describe('FileToolService.executeRead', () => {
  it('list_files 默认不递归，并只返回相对摘要', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'visible.txt'), 'visible', 'utf8');
    await mkdir(join(root, 'docs', 'nested'));
    await writeFile(join(root, 'docs', 'nested', 'hidden.txt'), 'hidden', 'utf8');

    const result = await service.executeRead({
      requestId: 'list-default',
      toolName: 'list_files',
      arguments: { relativePath: 'docs' }
    });

    expect(result).toMatchObject({ toolName: 'list_files', relativePath: 'docs', truncated: false });
    if (result.toolName !== 'list_files') throw new Error('预期目录结果');
    expect(result.entries.map(entry => entry.relativePath).sort()).toEqual(['docs/nested', 'docs/visible.txt']);
    expect(result.entries.every(entry => !('modifiedAt' in entry) && !('size' in entry))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('hidden.txt');
  });

  it('list_files 按最大深度递归，达到最大结果时截断', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'docs', 'nested'));
    await writeFile(join(root, 'docs', 'a.txt'), '', 'utf8');
    await writeFile(join(root, 'docs', 'nested', 'b.txt'), '', 'utf8');
    await writeFile(join(root, 'docs', 'nested', 'c.txt'), '', 'utf8');

    const deep = await service.executeRead({
      requestId: 'list-deep',
      toolName: 'list_files',
      arguments: { relativePath: 'docs', maxDepth: 2, maxResults: 10 }
    });
    if (deep.toolName !== 'list_files') throw new Error('预期目录结果');
    expect(deep.entries.map(entry => entry.relativePath)).toContain('docs/nested/b.txt');

    const limited = await service.executeRead({
      requestId: 'list-limited',
      toolName: 'list_files',
      arguments: { relativePath: 'docs', maxDepth: 2, maxResults: 2 }
    });
    if (limited.toolName !== 'list_files') throw new Error('预期目录结果');
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('list_files 将链接作为条目返回但绝不下钻', async ({ skip }) => {
    const { service, root } = await fixtureService();
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    try {
      await symlink(outside, join(root, 'docs', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error instanceof Error && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES')) {
        skip(`当前系统不允许创建测试 Junction：${String((error as NodeJS.ErrnoException).code)}`);
        return;
      }
      throw error;
    }

    const result = await service.executeRead({
      requestId: 'list-link',
      toolName: 'list_files',
      arguments: { relativePath: 'docs', maxDepth: 4 }
    });

    if (result.toolName !== 'list_files') throw new Error('预期目录结果');
    expect(result.entries).toContainEqual({ relativePath: 'docs/outside-link', type: 'symbolic_link' });
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });

  it('read_file 按请求行范围返回内容并标记截断', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'lines.txt'), 'first\nsecond\nthird\nfourth\n', 'utf8');

    const result = await service.executeRead({
      requestId: 'read-lines',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/lines.txt', startLine: 2, lineCount: 2 }
    });

    expect(result).toMatchObject({
      toolName: 'read_file',
      relativePath: 'docs/lines.txt',
      startLine: 2,
      endLine: 3,
      content: 'second\nthird',
      truncated: true
    });
  });

  it('read_file 将 UTF-8 BOM 与 CRLF 视为编码细节，不污染分页正文', async () => {
    const { service, root } = await fixtureService();
    await writeFile(
      join(root, 'docs', 'windows.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n第二行\r\n第三行', 'utf8')])
    );

    const result = await service.executeRead({
      requestId: 'read-bom-crlf',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/windows.txt', startLine: 2, lineCount: 1 }
    });

    expect(result).toMatchObject({
      toolName: 'read_file',
      startLine: 2,
      endLine: 2,
      content: '第二行',
      truncated: true
    });
    expect(JSON.stringify(result)).not.toContain('\\r');
    expect(JSON.stringify(result)).not.toContain('\uFEFF');
  });

  it('read_file 拒绝包含 NUL 的二进制内容，即使字节序列是合法 UTF-8', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'nul.dat'), Buffer.from([0x61, 0x00, 0x62]));

    await expect(service.executeRead({
      requestId: 'read-nul',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/nul.dat' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
  });

  it('glob_files 只返回授权根内普通文件并按相对路径确定性排序', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'docs', 'nested'));
    await mkdir(join(root, 'docs', 'node_modules'));
    await writeFile(join(root, 'docs', 'z.ts'), '', 'utf8');
    await writeFile(join(root, 'docs', 'a.ts'), '', 'utf8');
    await writeFile(join(root, 'docs', 'nested', 'b.ts'), '', 'utf8');
    await writeFile(join(root, 'docs', '.hidden.ts'), '', 'utf8');
    await writeFile(join(root, 'docs', 'node_modules', 'dependency.ts'), '', 'utf8');

    const result = await service.executeRead({
      requestId: 'glob-typescript',
      toolName: 'glob_files',
      arguments: { relativePath: 'docs', pattern: '**/*.ts', maxResults: 10 }
    });

    expect(result).toEqual({
      toolName: 'glob_files',
      relativePath: 'docs',
      paths: ['docs/a.ts', 'docs/nested/b.ts', 'docs/z.ts'],
      truncated: false
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('glob_files 在排序后按 maxResults 截断并明确标记', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'b.txt'), '', 'utf8');
    await writeFile(join(root, 'docs', 'a.txt'), '', 'utf8');

    const result = await service.executeRead({
      requestId: 'glob-limited',
      toolName: 'glob_files',
      arguments: { relativePath: 'docs', pattern: '*.txt', maxResults: 1 }
    });

    expect(result).toEqual({
      toolName: 'glob_files',
      relativePath: 'docs',
      paths: ['docs/a.txt'],
      truncated: true
    });
  });

  it('glob_files 在下钻前重新校验后代目录，拒绝检查后被替换成的 Junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(root, outside);
    await mkdir(join(root, 'docs', 'nested'), { recursive: true });
    await writeFile(join(root, 'docs', 'nested', 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'outside.txt'), 'outside', 'utf8');
    const policy = await PathPolicy.create(root);
    const resolveExisting = policy.resolveExisting.bind(policy);
    let replaced = false;
    policy.resolveExisting = async relativePath => {
      if (!replaced && relativePath.replaceAll('\\', '/') === 'docs/nested') {
        replaced = true;
        await rm(join(root, 'docs', 'nested'), { recursive: true });
        await symlink(outside, join(root, 'docs', 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      return await resolveExisting(relativePath);
    };
    const service = new FileToolService(policy);

    await expect(service.executeRead({
      requestId: 'glob-descendant-race',
      toolName: 'glob_files',
      arguments: { relativePath: 'docs', pattern: '**/*.txt' }
    })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
    expect(replaced).toBe(true);
  });

  it('grep_files 在读取前重新校验后代文件，拒绝检查后被替换成的链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(root, outside);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'victim.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'outside.txt'), 'outside secret', 'utf8');
    const policy = await PathPolicy.create(root);
    const resolveExisting = policy.resolveExisting.bind(policy);
    let replaced = false;
    let victimResolutions = 0;
    policy.resolveExisting = async relativePath => {
      if (relativePath.replaceAll('\\', '/') === 'docs/victim.txt') {
        victimResolutions += 1;
        if (!replaced && victimResolutions === 2) {
          replaced = true;
          await unlink(join(root, 'docs', 'victim.txt'));
          await symlink(join(outside, 'outside.txt'), join(root, 'docs', 'victim.txt'), 'file');
        }
      }
      return await resolveExisting(relativePath);
    };
    const service = new FileToolService(policy);

    await expect(service.executeRead({
      requestId: 'grep-descendant-race',
      toolName: 'grep_files',
      arguments: { relativePath: 'docs', pattern: 'outside', include: '**/*.txt' }
    })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
    expect(replaced).toBe(true);
  });

  it('grep_files 在路径校验返回后再遭链接替换时仍拒绝读取根外正文', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(root, outside);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'victim.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'outside.txt'), 'outside secret', 'utf8');
    const policy = await PathPolicy.create(root);
    const resolveExisting = policy.resolveExisting.bind(policy);
    let replacedAfterValidation = false;
    let victimResolutions = 0;
    policy.resolveExisting = async relativePath => {
      const resolved = await resolveExisting(relativePath);
      if (relativePath.replaceAll('\\', '/') === 'docs/victim.txt') {
        victimResolutions += 1;
        if (!replacedAfterValidation && victimResolutions === 2) {
          try {
            await unlink(join(root, 'docs', 'victim.txt'));
            await symlink(join(outside, 'outside.txt'), join(root, 'docs', 'victim.txt'), 'file');
          } catch (error) {
            if (error instanceof Error && 'code' in error
              && ((error as NodeJS.ErrnoException).code === 'EPERM'
                || (error as NodeJS.ErrnoException).code === 'EACCES')) {
              skip(`当前系统不允许创建测试链接：${String((error as NodeJS.ErrnoException).code)}`);
              return resolved;
            }
            throw error;
          }
          replacedAfterValidation = true;
        }
      }
      return resolved;
    };
    const service = new FileToolService(policy);

    await expect(service.executeRead({
      requestId: 'grep-post-validation-race',
      toolName: 'grep_files',
      arguments: { relativePath: 'docs', pattern: 'outside', include: '**/*.txt' }
    })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
    expect(replacedAfterValidation).toBe(true);
  });

  it('read_file 在句柄打开后原文件被原地改写时拒绝返回混合快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'docs'));
    const target = join(root, 'docs', 'changing.txt');
    await writeFile(target, 'before', 'utf8');
    const policy = await PathPolicy.create(root);
    const resolveExisting = policy.resolveExisting.bind(policy);
    let resolutions = 0;
    policy.resolveExisting = async relativePath => {
      const resolved = await resolveExisting(relativePath);
      if (relativePath.replaceAll('\\', '/') === 'docs/changing.txt') {
        resolutions += 1;
        if (resolutions === 2) await writeFile(target, 'after with a different size', 'utf8');
      }
      return resolved;
    };
    const service = new FileToolService(policy);

    await expect(service.executeRead({
      requestId: 'read-in-place-change',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/changing.txt', startLine: 1, lineCount: 10 }
    })).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    expect(resolutions).toBe(2);
  });

  it('glob_files 的访问预算统计不匹配条目，不能靠海量噪声绕过上限', async () => {
    const { service, root } = await fixtureService();
    const batchSize = 100;
    for (let start = 0; start < 5_000; start += batchSize) {
      await Promise.all(Array.from({ length: batchSize }, (_value, offset) => (
        writeFile(join(root, 'docs', `noise-${String(start + offset).padStart(4, '0')}.txt`), '', 'utf8')
      )));
    }
    await writeFile(join(root, 'docs', 'z-target.match'), '', 'utf8');

    const result = await service.executeRead({
      requestId: 'glob-visited-entry-budget',
      toolName: 'glob_files',
      arguments: { relativePath: 'docs', pattern: '*.match', maxResults: 10 }
    });

    expect(result).toEqual({
      toolName: 'glob_files',
      relativePath: 'docs',
      paths: [],
      truncated: true
    });
  }, 20_000);

  it('grep_files 对匹配行返回相对路径与行号，并以完整匹配为单位截断', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'b.txt'), 'none\nneedle second\n', 'utf8');
    await writeFile(join(root, 'docs', 'a.txt'), 'needle first\nnone\n', 'utf8');
    await writeFile(join(root, 'docs', 'ignored.md'), 'needle ignored\n', 'utf8');

    const result = await service.executeRead({
      requestId: 'grep-needle',
      toolName: 'grep_files',
      arguments: {
        relativePath: 'docs',
        pattern: 'needle',
        include: '**/*.txt',
        maxResults: 1
      }
    });

    expect(result).toEqual({
      toolName: 'grep_files',
      relativePath: 'docs',
      matches: [{ relativePath: 'docs/a.txt', lineNumber: 1, lineText: 'needle first' }],
      truncated: true
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('read_file 拒绝二进制、超限和非普通文件', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'binary.bin'), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, 'docs', 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));

    await expect(service.executeRead({
      requestId: 'read-binary',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/binary.bin' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
    await expect(service.executeRead({
      requestId: 'read-large',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/large.txt' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
    await expect(service.executeRead({
      requestId: 'read-directory',
      toolName: 'read_file',
      arguments: { relativePath: 'docs' }
    })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
    await expect(lstat(join(root, 'docs', 'binary.bin'))).resolves.toBeDefined();
  });

  it('read_file 对单行 1 MiB 文本施加严格返回字符上限', async () => {
    const { service, root } = await fixtureService();
    const content = '界'.repeat(Math.floor((1024 * 1024) / 3));
    await writeFile(join(root, 'docs', 'single-line.txt'), content, 'utf8');

    const result = await service.executeRead({
      requestId: 'read-single-line-limit',
      toolName: 'read_file',
      arguments: { relativePath: 'docs/single-line.txt', startLine: 1, lineCount: 1 }
    });

    if (result.toolName !== 'read_file') throw new Error('预期文件读取结果');
    expect(result.content.length).toBeLessThan(content.length);
    expect(result.content.endsWith('\uFFFD')).toBe(false);
    expect(result).toMatchObject({ startLine: 1, endLine: 1, truncated: true });
  });
});

describe('FileToolService.preview 与 executeWrite', () => {
  it('move_file 确认前不移动，确认后以源 basename 原子移入目标目录', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '移动正文', 'utf8');

    const action = await service.preview({
      requestId: 'move-file',
      toolName: 'move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'target'
      }
    });

    expect(action).toMatchObject({
      operation: 'move_file',
      sourceRelativePath: 'docs/source.txt',
      targetRelativePath: 'target/source.txt'
    });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('移动正文');
    await expect(lstat(join(root, 'target', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await service.executeWrite(action);

    await expect(lstat(join(root, 'docs', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'target', 'source.txt'), 'utf8')).resolves.toBe('移动正文');
  });

  it('move_file 允许把子目录中的文件移动到授权根目录', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'source.txt'), '根目录目标', 'utf8');

    const action = await service.preview({
      requestId: 'move-to-root',
      toolName: 'move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: '.'
      }
    });

    expect(action).toMatchObject({
      operation: 'move_file',
      sourceRelativePath: 'docs/source.txt',
      targetRelativePath: 'source.txt'
    });
    await service.executeWrite(action);
    await expect(readFile(join(root, 'source.txt'), 'utf8')).resolves.toBe('根目录目标');
    await expect(lstat(join(root, 'docs', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('move_file 拒绝覆盖、源或目标目录确认后变化，且不产生移动副作用', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '源内容', 'utf8');
    await writeFile(join(root, 'target', 'source.txt'), '既有目标', 'utf8');

    await expect(service.preview({
      requestId: 'move-overwrite',
      toolName: 'move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'target'
      }
    })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('源内容');

    await unlink(join(root, 'target', 'source.txt'));
    const action = await service.preview({
      requestId: 'move-race',
      toolName: 'move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'target'
      }
    });
    await rm(join(root, 'target'), { recursive: true });
    await mkdir(join(root, 'target'));

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('源内容');
    await expect(lstat(join(root, 'target', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('move_file 在授权 generation 变化后过期且不能重放', async () => {
    let generation = 1;
    const { service, root } = await fixtureService(undefined, () => generation);
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '仍在源处', 'utf8');
    const action = await service.preview({
      requestId: 'move-expired',
      toolName: 'move_file',
      arguments: { sourceRelativePath: 'docs/source.txt', targetDirectoryRelativePath: 'target' }
    });

    generation = 2;
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('仍在源处');
    await expect(lstat(join(root, 'target', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('move_file 在确认后源路径被替换时拒绝执行', async () => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '原始内容', 'utf8');
    const action = await service.preview({
      requestId: 'move-source-replaced',
      toolName: 'move_file',
      arguments: { sourceRelativePath: 'docs/source.txt', targetDirectoryRelativePath: 'target' }
    });
    await unlink(join(root, 'docs', 'source.txt'));
    await writeFile(join(root, 'docs', 'source.txt'), '替换内容', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('替换内容');
    await expect(lstat(join(root, 'target', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('move_file 在 rename 返回后目标被替换时拒绝发布成功', async () => {
    const { service, root } = await fixtureService(undefined, undefined, async (source, target) => {
      await rename(source, target);
      await unlink(target);
      await writeFile(target, '竞争替换内容', 'utf8');
    });
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '原始内容', 'utf8');
    const action = await service.preview({
      requestId: 'move-target-replaced-after-rename',
      toolName: 'move_file',
      arguments: { sourceRelativePath: 'docs/source.txt', targetDirectoryRelativePath: 'target' }
    });

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'MOVE_RESULT_UNCERTAIN' });
    await expect(lstat(join(root, 'docs', 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'target', 'source.txt'), 'utf8')).resolves.toBe('竞争替换内容');
  });

  it('move_file 在 rename 返回但源仍存在时拒绝发布成功', async () => {
    const { service, root } = await fixtureService(undefined, undefined, async (source, target) => {
      await writeFile(target, await readFile(source, 'utf8'), 'utf8');
    });
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '原始内容', 'utf8');
    const action = await service.preview({
      requestId: 'move-source-remains-after-rename',
      toolName: 'move_file',
      arguments: { sourceRelativePath: 'docs/source.txt', targetDirectoryRelativePath: 'target' }
    });

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'MOVE_RESULT_UNCERTAIN' });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('原始内容');
    await expect(readFile(join(root, 'target', 'source.txt'), 'utf8')).resolves.toBe('原始内容');
  });

  it.each([
    ['EEXIST', 'TARGET_EXISTS', async () => undefined],
    ['EPERM', 'PERMISSION_DENIED', async () => undefined],
    ['EPERM', 'TARGET_EXISTS', async (_root: string, target: string) => writeFile(target, '竞争目标', 'utf8')],
    ['EACCES', 'PERMISSION_DENIED', async () => undefined],
    ['EXDEV', 'CROSS_VOLUME_UNSUPPORTED', async () => undefined]
  ] as const)('move_file 将 Windows %s rename 失败映射为 %s', async (errnoCode, expectedCode, beforeFailure) => {
    let rootForFailure = '';
    const { service, root } = await fixtureService(undefined, undefined, async (_source, target) => {
      await beforeFailure(rootForFailure, target);
      throw Object.assign(new Error(errnoCode), { code: errnoCode });
    });
    rootForFailure = root;
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'docs', 'source.txt'), '原始内容', 'utf8');
    const action = await service.preview({
      requestId: `move-errno-${errnoCode}-${expectedCode}`,
      toolName: 'move_file',
      arguments: { sourceRelativePath: 'docs/source.txt', targetDirectoryRelativePath: 'target' }
    });

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: expectedCode });
    await expect(readFile(join(root, 'docs', 'source.txt'), 'utf8')).resolves.toBe('原始内容');
  });

  it('create_directory 逐次确认后只创建一个父目录已存在的相对目录', async () => {
    const { service, root } = await fixtureService();
    const action = await service.preview({
      requestId: 'create-directory',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/abc' }
    });

    expect(action).toEqual({
      operation: 'create_directory',
      authorizationGeneration: 0,
      targetRelativePath: 'docs/abc'
    });
    await expect(lstat(join(root, 'docs', 'abc'))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.executeWrite(action);
    await expect(lstat(join(root, 'docs', 'abc'))).resolves.toMatchObject({});
  });

  it('create_directory 拒绝目标冲突、越界、缺失父目录和链接父目录', async ({ skip }) => {
    const { service, root } = await fixtureService();
    await mkdir(join(root, 'docs', 'existing'));
    await expect(service.preview({
      requestId: 'create-directory-existing',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/existing' }
    })).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(service.preview({
      requestId: 'create-directory-outside',
      toolName: 'create_directory',
      arguments: { relativePath: '../outside' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(service.preview({
      requestId: 'create-directory-missing-parent',
      toolName: 'create_directory',
      arguments: { relativePath: 'missing/child' }
    })).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });

    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(outside);
    try {
      await symlink(outside, join(root, 'docs', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error instanceof Error && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES')) {
        skip(`当前系统不允许创建测试 Junction：${String((error as NodeJS.ErrnoException).code)}`);
        return;
      }
      throw error;
    }
    await expect(service.preview({
      requestId: 'create-directory-link-parent',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/outside-link/child' }
    })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
  });

  it('create_directory 确认后复核 generation、父目录与目标冲突', async () => {
    let generation = 1;
    const { service, root } = await fixtureService(undefined, () => generation);
    const expired = await service.preview({
      requestId: 'create-directory-generation',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/generation' }
    });
    generation = 2;
    await expect(service.executeWrite(expired)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });

    const conflict = await service.preview({
      requestId: 'create-directory-race',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/race' }
    });
    await mkdir(join(root, 'docs', 'race'));
    await expect(service.executeWrite(conflict)).rejects.toMatchObject({ code: 'TARGET_EXISTS' });

    const changedParent = await service.preview({
      requestId: 'create-directory-parent-race',
      toolName: 'create_directory',
      arguments: { relativePath: 'docs/parent-race' }
    });
    await rm(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'docs'));
    await expect(service.executeWrite(changedParent)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
  });

  it('create_file 只在私有动作保存正文并以排他方式创建', async () => {
    const { service, root } = await fixtureService();
    const action = await service.preview({
      requestId: 'create-preview',
      toolName: 'create_file',
      arguments: { relativePath: 'created.txt', content: '私有正文' }
    });

    expect(action).toEqual({
      operation: 'create_file',
      authorizationGeneration: 0,
      targetRelativePath: 'created.txt',
      contentCharacters: 4,
      contentPreview: '私有正文',
      contentPreviewSuppressedReason: null,
      previewTruncated: false
    });
    expect(JSON.stringify(action)).not.toContain(root);
    await expect(lstat(join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await service.executeWrite(action);
    await expect(lstat(join(root, 'created.txt'))).resolves.toBeDefined();
  });

  it('create_file 拒绝预览后出现的同名条目且动作不可重放', async () => {
    const { service, root } = await fixtureService();
    const action = await service.preview({
      requestId: 'create-race',
      toolName: 'create_file',
      arguments: { relativePath: 'existing.txt' }
    });
    await writeFile(join(root, 'existing.txt'), 'existing', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  });

  it.each([
    ['API key 赋值', 'api_key = sk-private-value'],
    ['带前缀 API key 赋值', 'OPENAI_API_KEY=sk-private-value'],
    ['Bearer 凭据', 'Authorization: Bearer abc'],
    ['PEM 私钥', '-----BEGIN PRIVATE KEY-----\nprivate-material'],
    ['PEM 证书', '-----BEGIN CERTIFICATE-----\nprivate-material'],
    ['password 赋值', 'password="private-value"'],
    ['secret 赋值', 'secret: private-value'],
    ['token 赋值', 'token = private-value']
  ])('create_file 对%s抑制公开正文预览', async (_label, content) => {
    const { service } = await fixtureService();
    const action = await service.preview({
      requestId: `create-sensitive-${_label}`,
      toolName: 'create_file',
      arguments: { relativePath: 'sensitive.txt', content }
    });

    expect(action).toMatchObject({
      operation: 'create_file',
      contentCharacters: Array.from(content).length,
      contentPreview: null,
      contentPreviewSuppressedReason: 'sensitive'
    });
    expect(JSON.stringify(action)).not.toContain('private');
  });

  it('create_file 对过长正文只公开字符数和抑制原因', async () => {
    const { service } = await fixtureService();
    const content = '长'.repeat(201);
    const action = await service.preview({
      requestId: 'create-long-preview',
      toolName: 'create_file',
      arguments: { relativePath: 'long.txt', content }
    });

    expect(action).toMatchObject({
      operation: 'create_file',
      contentCharacters: 201,
      contentPreview: null,
      contentPreviewSuppressedReason: 'too_long'
    });
    expect(JSON.stringify(action)).not.toContain('长');
  });

  it.each(['write', 'close'] as const)('create_file 在%s失败后清理本次新建目标', async failure => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'docs'));
    const fileOperations = {
      open: async (path: string, flags: string) => {
        const handle = await open(path, flags);
        return {
          stat: async (_options: { bigint: true }) => handle.stat({ bigint: true }),
          writeFile: async (content: string, encoding: BufferEncoding) => {
            if (failure === 'write') {
              await handle.writeFile('partial', encoding);
              throw new Error('注入写入失败');
            }
            await handle.writeFile(content, encoding);
          },
          close: async () => {
            await handle.close();
            if (failure === 'close') throw new Error('注入关闭失败');
          }
        };
      },
      rename,
      unlink
    };
    const service = new FileToolService(await PathPolicy.create(root), undefined, undefined, fileOperations);
    const action = await service.preview({
      requestId: `create-${failure}-failure`,
      toolName: 'create_file',
      arguments: { relativePath: 'docs/failed.txt', content: '完整正文' }
    });

    await expect(service.executeWrite(action)).rejects.toBeDefined();
    await expect(lstat(join(root, 'docs', 'failed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('edit_file 确认前无副作用，确认后保持 UTF-8 BOM 与 CRLF', async () => {
    const { service, root } = await fixtureService();
    const target = join(root, 'docs', 'edit-windows.txt');
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8')
    ]);
    await writeFile(target, original);

    const action = await service.preview({
      requestId: 'edit-bom-crlf',
      toolName: 'edit_file',
      arguments: {
        relativePath: 'docs/edit-windows.txt',
        oldString: 'alpha\nbeta',
        newString: 'first\nsecond'
      }
    });

    expect(action).toMatchObject({
      operation: 'apply_patch',
      targetRelativePath: 'docs/edit-windows.txt',
      addedLines: 2,
      removedLines: 2
    });
    await expect(readFile(target)).resolves.toEqual(original);

    await service.executeWrite(action);
    const changed = await readFile(target);
    expect([...changed.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(changed.toString('utf8')).toBe('\uFEFFfirst\r\nsecond\r\ngamma\r\n');
  });

  it('edit_file 只接受唯一精确匹配，replaceAll 必须显式开启', async () => {
    const { service, root } = await fixtureService();
    const target = join(root, 'docs', 'repeated.txt');
    await writeFile(target, 'same\nsame\n', 'utf8');

    await expect(service.preview({
      requestId: 'edit-ambiguous',
      toolName: 'edit_file',
      arguments: { relativePath: 'docs/repeated.txt', oldString: 'same', newString: 'changed' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(readFile(target, 'utf8')).resolves.toBe('same\nsame\n');

    const action = await service.preview({
      requestId: 'edit-all',
      toolName: 'edit_file',
      arguments: {
        relativePath: 'docs/repeated.txt',
        oldString: 'same',
        newString: 'changed',
        replaceAll: true
      }
    });
    await service.executeWrite(action);
    await expect(readFile(target, 'utf8')).resolves.toBe('changed\nchanged\n');
  });

  it('edit_file 在精确匹配缺失时只采用唯一的逐行缩进纠错候选', async () => {
    const { service, root } = await fixtureService();
    await writeFile(
      join(root, 'docs', 'indented.ts'),
      'function demo() {\n  const before = 1;\n  return before;\n}\n',
      'utf8'
    );

    const action = await service.preview({
      requestId: 'edit-unique-line-trimmed',
      toolName: 'edit_file',
      arguments: {
        relativePath: 'docs/indented.ts',
        oldString: 'const before = 1;\nreturn before;',
        newString: 'const after = 2;\nreturn after;'
      }
    });

    expect(action).toMatchObject({
      operation: 'apply_patch',
      targetRelativePath: 'docs/indented.ts'
    });
    expect(action.operation === 'apply_patch' ? action.diffPreview : '').toContain('const before = 1;');
    await service.executeWrite(action);
    await expect(readFile(join(root, 'docs', 'indented.ts'), 'utf8')).resolves.toBe(
      'function demo() {\n  const after = 2;\n  return after;\n}\n'
    );
  });

  it('edit_file 的逐行纠错候选不唯一时拒绝猜测', async () => {
    const { service, root } = await fixtureService();
    await writeFile(
      join(root, 'docs', 'ambiguous.txt'),
      '  alpha\n  beta\nseparator\n    alpha\n    beta\n',
      'utf8'
    );

    await expect(service.preview({
      requestId: 'edit-ambiguous-line-trimmed',
      toolName: 'edit_file',
      arguments: {
        relativePath: 'docs/ambiguous.txt',
        oldString: 'alpha\nbeta',
        newString: 'changed'
      }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(readFile(join(root, 'docs', 'ambiguous.txt'), 'utf8')).resolves.toContain('separator');
  });

  it('edit_file 对不存在文本与相同替换内容失败关闭', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'exact.txt'), 'actual\n', 'utf8');

    for (const [oldString, newString] of [['missing', 'new'], ['actual', 'actual']] as const) {
      await expect(service.preview({
        requestId: `edit-invalid-${oldString}`,
        toolName: 'edit_file',
        arguments: { relativePath: 'docs/exact.txt', oldString, newString }
      })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    }
    await expect(readFile(join(root, 'docs', 'exact.txt'), 'utf8')).resolves.toBe('actual\n');
  });

  it('edit_file 确认后基础内容变化时拒绝 CAS 写入且动作不可重放', async () => {
    const { service, root } = await fixtureService();
    const target = join(root, 'docs', 'edit-race.txt');
    await writeFile(target, 'before\n', 'utf8');
    const action = await service.preview({
      requestId: 'edit-race',
      toolName: 'edit_file',
      arguments: { relativePath: 'docs/edit-race.txt', oldString: 'before', newString: 'after' }
    });
    await writeFile(target, 'external\n', 'utf8');

    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(readFile(target, 'utf8')).resolves.toBe('external\n');
  });

  it('apply_patch 只公开补丁摘要并以预览版本作为基础写入', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'patch.txt'), 'before\n', 'utf8');
    const action = await service.preview({
      requestId: 'patch-preview',
      toolName: 'apply_patch',
      arguments: {
        relativePath: 'docs/patch.txt',
        patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
      }
    });

    expect(action).toMatchObject({
      operation: 'apply_patch',
      authorizationGeneration: 0,
      targetRelativePath: 'docs/patch.txt',
      addedLines: 1,
      removedLines: 1,
      previewTruncated: false
    });
    if (action.operation !== 'apply_patch') throw new Error('预期补丁动作');
    expect(action.diffPreview).toContain('-before');
    await service.executeWrite(action);
    await expect(readFile(join(root, 'docs', 'patch.txt'), 'utf8')).resolves.toBe('after\n');
  });

  it('previewMany 保留带相对路径的单文件 hunk 补丁兼容入口', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'legacy.txt'), 'before\n', 'utf8');

    const actions = await service.previewMany({
      requestId: 'patch-single-hunk',
      toolName: 'apply_patch',
      arguments: {
        relativePath: 'docs/legacy.txt',
        patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
      }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      operation: 'apply_patch',
      targetRelativePath: 'docs/legacy.txt'
    });
  });

  it.each([
    '--- other.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n',
    '+++ other.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n'
  ])('previewMany 拒绝只有单侧文件头的畸形补丁', async patch => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'target.txt'), 'before\n', 'utf8');

    await expect(service.previewMany({
      requestId: 'patch-partial-header',
      toolName: 'apply_patch',
      arguments: { relativePath: 'docs/target.txt', patch }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it('apply_patch 多文件请求拆成逐文件独立动作并分别复核基础内容', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'first.txt'), 'first old\n', 'utf8');
    await writeFile(join(root, 'docs', 'second.txt'), 'second old\n', 'utf8');
    const patch = [
      createTwoFilesPatch('docs/first.txt', 'docs/first.txt', 'first old\n', 'first new\n'),
      createTwoFilesPatch('docs/second.txt', 'docs/second.txt', 'second old\n', 'second new\n')
    ].join('\n');

    const actions = await service.previewMany({
      requestId: 'patch-many',
      toolName: 'apply_patch',
      arguments: { patch }
    });

    expect(actions.map(action => action.targetRelativePath)).toEqual([
      'docs/first.txt',
      'docs/second.txt'
    ]);
    await expect(readFile(join(root, 'docs', 'first.txt'), 'utf8')).resolves.toBe('first old\n');
    await service.executeWrite(actions[0]!);
    await expect(readFile(join(root, 'docs', 'first.txt'), 'utf8')).resolves.toBe('first new\n');
    await expect(readFile(join(root, 'docs', 'second.txt'), 'utf8')).resolves.toBe('second old\n');

    await writeFile(join(root, 'docs', 'second.txt'), 'competitor\n', 'utf8');
    await expect(service.executeWrite(actions[1]!)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(readFile(join(root, 'docs', 'second.txt'), 'utf8')).resolves.toBe('competitor\n');
  });

  it('apply_patch 拒绝不匹配补丁和预览后的基础内容变化', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'changed.txt'), 'before\n', 'utf8');

    await expect(service.preview({
      requestId: 'patch-mismatch',
      toolName: 'apply_patch',
      arguments: { relativePath: 'docs/changed.txt', patch: '@@ -1,1 +1,1 @@\n-other\n+after\n' }
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    const action = await service.preview({
      requestId: 'patch-changed',
      toolName: 'apply_patch',
      arguments: { relativePath: 'docs/changed.txt', patch: '@@ -1,1 +1,1 @@\n-before\n+after\n' }
    });
    await writeFile(join(root, 'docs', 'changed.txt'), 'changed\n', 'utf8');
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  });

  it('apply_patch 将 hunk 正文 --- 与 +++ 分别计为删除和新增行', async () => {
    const { service, root } = await fixtureService();
    await writeFile(join(root, 'docs', 'markers.txt'), '---\n', 'utf8');

    const action = await service.preview({
      requestId: 'patch-markers',
      toolName: 'apply_patch',
      arguments: { relativePath: 'docs/markers.txt', patch: '@@ -1,1 +1,1 @@\n----\n++++\n' }
    });

    expect(action).toMatchObject({ operation: 'apply_patch', addedLines: 1, removedLines: 1 });
  });

  it.each(['write', 'close', 'rename'] as const)('apply_patch 在临时文件%s失败后清理本次临时文件', async failure => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'docs'));
    const target = join(root, 'docs', 'patch-failure.txt');
    await writeFile(target, 'before\n', 'utf8');
    const fileOperations = {
      open: async (path: string, flags: string) => {
        const handle = await open(path, flags);
        return {
          stat: async (_options: { bigint: true }) => handle.stat({ bigint: true }),
          writeFile: async (content: string, encoding: BufferEncoding) => {
            if (failure === 'write') {
              await handle.writeFile('partial', encoding);
              throw new Error('注入写入失败');
            }
            await handle.writeFile(content, encoding);
          },
          close: async () => {
            await handle.close();
            if (failure === 'close') throw new Error('注入关闭失败');
          }
        };
      },
      rename: async (source: string, destination: string) => {
        if (failure === 'rename') throw new Error('注入改名失败');
        await rename(source, destination);
      },
      unlink
    };
    const service = new FileToolService(await PathPolicy.create(root), undefined, undefined, fileOperations);
    const action = await service.preview({
      requestId: `patch-${failure}-failure`,
      toolName: 'apply_patch',
      arguments: {
        relativePath: 'docs/patch-failure.txt',
        patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
      }
    });

    await expect(service.executeWrite(action)).rejects.toBeDefined();
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n');
    expect((await readdir(join(root, 'docs'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('apply_patch 清理前核对临时文件身份，不删除竞争方替换文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'docs'));
    const target = join(root, 'docs', 'patch-race.txt');
    await writeFile(target, 'before\n', 'utf8');
    let competingPath = '';
    const fileOperations = {
      open: async (path: string, flags: string) => {
        const handle = await open(path, flags);
        return {
          stat: async (_options: { bigint: true }) => handle.stat({ bigint: true }),
          writeFile: (content: string, encoding: BufferEncoding) => handle.writeFile(content, encoding),
          close: () => handle.close()
        };
      },
      rename: async (source: string) => {
        competingPath = source;
        await unlink(source);
        await writeFile(source, '竞争方文件', 'utf8');
        throw new Error('注入改名失败');
      },
      unlink
    };
    const service = new FileToolService(await PathPolicy.create(root), undefined, undefined, fileOperations);
    const action = await service.preview({
      requestId: 'patch-rename-race',
      toolName: 'apply_patch',
      arguments: {
        relativePath: 'docs/patch-race.txt',
        patch: '@@ -1,1 +1,1 @@\n-before\n+after\n'
      }
    });

    await expect(service.executeWrite(action)).rejects.toBeDefined();
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n');
    await expect(readFile(competingPath, 'utf8')).resolves.toBe('竞争方文件');
  });

  it('delete_file 只通过回收站端口删除普通文件和空目录', async () => {
    const calls: string[] = [];
    const { service, root } = await fixtureService({
      async moveToRecycleBin(absolutePath) {
        calls.push(absolutePath);
        await rm(absolutePath, { recursive: true, force: false });
      }
    });
    await writeFile(join(root, 'docs', 'delete.txt'), '删除我', 'utf8');

    const fileAction = await service.preview({
      requestId: 'delete-file',
      toolName: 'delete_file',
      arguments: { relativePath: 'docs/delete.txt' }
    });
    expect(fileAction).toEqual({
      operation: 'delete_file',
      authorizationGeneration: 0,
      targetRelativePath: 'docs/delete.txt',
      targetType: 'file'
    });
    await service.executeWrite(fileAction);
    expect(calls).toHaveLength(1);
    await expect(lstat(join(root, 'docs', 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(join(root, 'docs', 'empty'));
    const directoryAction = await service.preview({
      requestId: 'delete-directory',
      toolName: 'delete_file',
      arguments: { relativePath: 'docs/empty' }
    });
    expect(directoryAction).toMatchObject({ operation: 'delete_file', targetType: 'empty_directory' });
  });

  it('delete_file 拒绝授权根、链接和非空目录，且动作绑定身份与 generation', async ({ skip }) => {
    let generation = 3;
    const { service, root } = await fixtureService({ async moveToRecycleBin() {} }, () => generation);
    await mkdir(join(root, 'docs', 'non-empty'));
    await writeFile(join(root, 'docs', 'non-empty', 'child.txt'), '', 'utf8');
    await writeFile(join(root, 'docs', 'replace.txt'), '原始内容', 'utf8');

    await expect(service.preview({ requestId: 'delete-root', toolName: 'delete_file', arguments: { relativePath: '.' } })).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(service.preview({ requestId: 'delete-non-empty', toolName: 'delete_file', arguments: { relativePath: 'docs/non-empty' } })).rejects.toMatchObject({ code: 'ENTRY_TYPE_UNSUPPORTED' });
    const action = await service.preview({ requestId: 'delete-changed', toolName: 'delete_file', arguments: { relativePath: 'docs/replace.txt' } });
    generation = 4;
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });

    const outside = await mkdtemp(join(tmpdir(), 'myself-file-tools-outside-'));
    temporaryRoots.push(outside);
    try {
      await symlink(outside, join(root, 'docs', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error instanceof Error && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES')) {
        skip(`当前系统不允许创建测试 Junction：${String((error as NodeJS.ErrnoException).code)}`);
        return;
      }
      throw error;
    }
    await expect(service.preview({ requestId: 'delete-link', toolName: 'delete_file', arguments: { relativePath: 'docs/outside-link' } })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' });
  });

  it('delete_file 将回收站端口失败转换为稳定错误且动作不可重放', async () => {
    const { service, root } = await fixtureService({
      async moveToRecycleBin() {
        throw new Error('系统错误包含 C:\\private\\secret.txt');
      }
    });
    await writeFile(join(root, 'docs', 'failed-delete.txt'), '保留', 'utf8');
    const action = await service.preview({
      requestId: 'delete-port-failure',
      toolName: 'delete_file',
      arguments: { relativePath: 'docs/failed-delete.txt' }
    });

    const error = await service.executeWrite(action).then(
      () => null,
      reason => reason as Error & { code: string; cause?: unknown }
    );
    expect(error).toMatchObject({ code: 'RECYCLE_BIN_FAILED', message: '无法将目标移入系统回收站' });
    expect(error?.message).not.toContain('private');
    expect(error?.cause).toBeUndefined();
    await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(readFile(join(root, 'docs', 'failed-delete.txt'), 'utf8')).resolves.toBe('保留');
  });

  it('所有写动作拒绝克隆，删除预览后的同路径替换会失效', async () => {
    const calls: string[] = [];
    const { service, root } = await fixtureService({ async moveToRecycleBin(path) { calls.push(path); } });
    const createAction = await service.preview({ requestId: 'clone-create', toolName: 'create_file', arguments: { relativePath: 'clone.txt' } });
    await expect(service.executeWrite({ ...createAction })).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });

    await writeFile(join(root, 'docs', 'replace.txt'), '初始', 'utf8');
    const deleteAction = await service.preview({ requestId: 'replace-delete', toolName: 'delete_file', arguments: { relativePath: 'docs/replace.txt' } });
    await rm(join(root, 'docs', 'replace.txt'));
    await writeFile(join(root, 'docs', 'replace.txt'), '替换', 'utf8');
    await expect(service.executeWrite(deleteAction)).rejects.toMatchObject({ code: 'ENTRY_CHANGED' });
    await expect(service.executeWrite(deleteAction)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(calls).toEqual([]);
  });
});
