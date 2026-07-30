import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface DirectoryTreeEntry {
  path: string;
  type: 'directory' | 'file' | 'link' | 'other';
  size: number;
  sha256: string | null;
}

export interface CharacterPersistenceSnapshot {
  indexBytesBase64: string;
  canonicalIndex: string;
  activeCharacterId: string | null;
  tree: DirectoryTreeEntry[];
}

/** 递归排序 JSON 键，避免仅由对象键顺序导致持久化比较误报。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function portableRelativePath(rootDirectory: string, file: string): string {
  return relative(rootDirectory, file).split(sep).join('/');
}

/** 只使用 lstat 判型；目录链接和 junction 会被记录但绝不会被跟随。 */
export async function snapshotDirectoryTree(
  rootDirectory: string
): Promise<DirectoryTreeEntry[]> {
  const result: DirectoryTreeEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const names = await readdir(directory);
    names.sort((left, right) => left.localeCompare(right));

    for (const name of names) {
      const entryPath = join(directory, name);
      const stats = await lstat(entryPath);
      const path = portableRelativePath(rootDirectory, entryPath);

      if (stats.isSymbolicLink()) {
        result.push({ path, type: 'link', size: stats.size, sha256: null });
        continue;
      }
      if (stats.isDirectory()) {
        result.push({ path, type: 'directory', size: stats.size, sha256: null });
        await visit(entryPath);
        continue;
      }
      if (stats.isFile()) {
        const bytes = await readFile(entryPath);
        result.push({
          path,
          type: 'file',
          size: stats.size,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
        continue;
      }
      result.push({ path, type: 'other', size: stats.size, sha256: null });
    }
  }

  await visit(rootDirectory);
  return result;
}

export async function snapshotCharacterPersistence(
  charactersDirectory: string
): Promise<CharacterPersistenceSnapshot> {
  const indexBytes = await readFile(join(charactersDirectory, 'index.json'));
  const index = JSON.parse(indexBytes.toString('utf8')) as {
    activeCharacterId?: unknown;
  };

  return {
    indexBytesBase64: indexBytes.toString('base64'),
    canonicalIndex: canonicalJson(index),
    activeCharacterId: typeof index.activeCharacterId === 'string'
      ? index.activeCharacterId
      : null,
    tree: await snapshotDirectoryTree(charactersDirectory)
  };
}
