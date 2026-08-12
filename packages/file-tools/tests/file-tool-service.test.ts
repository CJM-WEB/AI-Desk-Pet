import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileToolService } from '../src/file-tool-service';
import { PathPolicy } from '../src/path-policy';
import type { RecycleBinPort } from '../src/recycle-bin-port';
import { toolArguments } from '../src/schemas';

const temporaryRoots: string[] = [];

/** 为每个用例隔离授权根目录，避免文件系统状态互相影响。 */
async function fixtureService(
  recycleBinPort?: RecycleBinPort,
  getAuthorizationGeneration?: () => number
): Promise<{ service: FileToolService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'myself-file-tools-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'docs'));
  return { service: new FileToolService(await PathPolicy.create(root), recycleBinPort, getAuthorizationGeneration), root };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('五个工具 schema', () => {
  it('只公开五个严格参数 schema，且旧工具名称不存在', () => {
    expect(Object.keys(toolArguments).sort()).toEqual([
      'apply_patch',
      'create_file',
      'delete_file',
      'list_files',
      'read_file'
    ]);
    expect(() => toolArguments.create_file.parse({ relativePath: 'a.txt', extra: true })).toThrow();
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
});

describe('FileToolService.preview 与 executeWrite', () => {
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
