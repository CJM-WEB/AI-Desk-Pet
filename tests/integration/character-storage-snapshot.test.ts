import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  snapshotCharacterPersistence,
  snapshotDirectoryTree
} from '../fixtures/character-storage-snapshot';

let temporaryDirectory = '';

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('角色持久化摘要 fixture', () => {
  test('摘要覆盖根文件、嵌套文件、活动角色和规范索引', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-storage-snapshot-'));
    const charactersDirectory = join(temporaryDirectory, 'characters');
    await mkdir(join(charactersDirectory, 'user-pet', 'draft'), { recursive: true });
    await writeFile(
      join(charactersDirectory, 'index.json'),
      '{"characters":[],"activeCharacterId":"user-pet","version":1}',
      'utf8'
    );
    await writeFile(join(charactersDirectory, 'root.tmp'), '临时证据', 'utf8');
    await writeFile(
      join(charactersDirectory, 'user-pet', 'draft', 'draft.json'),
      '{"revision":2}',
      'utf8'
    );

    const snapshot = await snapshotCharacterPersistence(charactersDirectory);

    expect(snapshot.activeCharacterId).toBe('user-pet');
    expect(snapshot.canonicalIndex).toBe(
      '{"activeCharacterId":"user-pet","characters":[],"version":1}'
    );
    expect(snapshot.tree).toContainEqual({
      path: 'root.tmp',
      type: 'file',
      size: Buffer.byteLength('临时证据'),
      sha256: createHash('sha256').update('临时证据').digest('hex')
    });
    expect(snapshot.tree.some(entry =>
      entry.path === 'user-pet/draft/draft.json'
      && entry.type === 'file'
    )).toBe(true);
  });

  test('目录摘要记录链接但绝不跟随链接读取外部内容', async ({ skip }) => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-storage-link-'));
    const rootDirectory = join(temporaryDirectory, 'characters');
    const outsideDirectory = join(temporaryDirectory, 'outside');
    await mkdir(rootDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, 'secret.txt'), '不得进入摘要', 'utf8');

    try {
      await symlink(
        outsideDirectory,
        join(rootDirectory, 'linked-pet'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : '';
      if (code === 'EPERM' || code === 'EACCES') {
        skip();
        return;
      }
      throw error;
    }

    const tree = await snapshotDirectoryTree(rootDirectory);

    expect(tree).toContainEqual({
      path: 'linked-pet',
      type: 'link',
      size: expect.any(Number),
      sha256: null
    });
    expect(tree.some(entry => entry.path.includes('secret.txt'))).toBe(false);
  });
});
