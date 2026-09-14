import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { characterDraftV3Schema, characterManifestV3Schema, type CharacterDraftV3, type CharacterManifestV3 } from '@myself/character-runtime';
import { characterSourceCatalogV1Schema, characterSourceFileName, type CharacterSourceCatalogV1 } from '@myself/character-assets';
import { z } from 'zod';

const revisionSchema = z.object({ version: z.literal(1), revision: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u) }).strict();
const journalSchema = z.object({ version: z.literal(1), backupId: z.string().uuid(), hadPrevious: z.boolean(), index: z.unknown() }).strict();
export interface OfficialDefaultBundle {
  revision: z.output<typeof revisionSchema>;
  draft: CharacterDraftV3;
  manifest: CharacterManifestV3;
  catalog: CharacterSourceCatalogV1;
  sources: Record<string, Uint8Array>;
  assets: Record<string, Uint8Array>;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 备份与恢复不能沿用户放入的目录链接读写其他位置。 */
async function assertPlainTree(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('CHARACTER_PATH_UNSAFE');
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await assertPlainTree(join(path, name));
  }
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readVerified(path: string, expected: { byteLength: number; sha256: string }): Promise<Uint8Array> {
  const bytes = await readFile(path);
  if (bytes.length !== expected.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
  }
  return bytes;
}

function assertDraftSources(draft: CharacterDraftV3, catalog: CharacterSourceCatalogV1): void {
  if (draft.id !== catalog.characterId) throw new Error('CHARACTER_ID_MISMATCH');
  const sourceIds = new Set(catalog.sources.map(source => source.assetId));
  if (draft.skins.some(skin => skin.presentations.some(presentation => presentation.frames.some(frame => !sourceIds.has(frame.assetId))))) {
    throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
  }
}

/** 先完整验证固定快照和草稿引用；校验失败前不创建任何本机角色数据。 */
export async function readOfficialDefaultBundle(directory: string): Promise<OfficialDefaultBundle> {
  await assertPlainTree(directory);
  const revision = revisionSchema.parse(await json(join(directory, 'builtin-version.json')));
  const draft = characterDraftV3Schema.parse(await json(join(directory, 'draft', 'draft.json')));
  const manifest = characterManifestV3Schema.parse(await json(join(directory, 'compiled', 'manifest.json')));
  const catalog = characterSourceCatalogV1Schema.parse(await json(join(directory, 'source', 'catalog.json')));
  if (draft.id !== 'builtin-default' || manifest.id !== draft.id || catalog.characterId !== draft.id) throw new Error('CHARACTER_ID_MISMATCH');
  assertDraftSources(draft, catalog);
  const sources: Record<string, Uint8Array> = {};
  for (const source of catalog.sources) {
    const fileName = characterSourceFileName(source);
    sources[fileName] = await readVerified(join(directory, 'source', fileName), source);
  }
  const assets: Record<string, Uint8Array> = {};
  for (const resource of manifest.resources) assets[resource.fileName] = await readVerified(join(directory, 'compiled', resource.fileName), resource);
  return { revision, draft, manifest, catalog, sources, assets };
}

interface InstallationHost {
  directory: string;
  index: unknown;
  assertPath(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  restoreIndex(index: unknown): Promise<void>;
  runtimeReady(): Promise<boolean>;
  installDocuments(): Promise<void>;
}

/** 所有 Store 索引操作前先恢复外层事务；失败继续关闭后续读写，不能覆盖随后提交的新索引。 */
export async function recoverOfficialDefaultInstallation(
  host: Pick<InstallationHost, 'directory' | 'assertPath' | 'restoreIndex'>
): Promise<void> {
  const current = join(host.directory, 'builtin-default');
  const journalFile = join(host.directory, '.official-default-installation.json');
  const backupRoot = join(host.directory, '.official-default-backups');
  await host.assertPath(journalFile);

  if (await exists(journalFile)) {
    await host.assertPath(current);
    await host.assertPath(backupRoot);
    const journal = journalSchema.parse(await json(journalFile));
    const backup = join(backupRoot, journal.backupId);
    await host.assertPath(backup);
    await assertPlainTree(backup);
    if (journal.hadPrevious) await assertPlainTree(join(backup, 'previous'));
    if (await exists(current)) {
      await assertPlainTree(current);
      await rename(current, join(backup, `interrupted-${randomUUID()}`));
    }
    if (journal.hadPrevious) await cp(join(backup, 'previous'), current, { recursive: true, errorOnExist: true, force: false });
    await host.restoreIndex(journal.index);
    await rm(journalFile);
  }
}

/** 在 Store 串行队列内连接源图、草稿、发布三个阶段；未完成记录总是先回滚。 */
export async function installOfficialDefaultBundle(bundle: OfficialDefaultBundle | undefined, host: InstallationHost): Promise<void> {
  await recoverOfficialDefaultInstallation(host);
  if (!bundle) return;
  const current = join(host.directory, 'builtin-default');
  const journalFile = join(host.directory, '.official-default-installation.json');
  const backupRoot = join(host.directory, '.official-default-backups');
  await host.assertPath(current);
  await host.assertPath(backupRoot);
  if (await exists(current)) await assertPlainTree(current);
  try {
    const installed = revisionSchema.parse(await json(join(current, 'builtin-revision.json')));
    if (installed.revision === bundle.revision.revision && await host.runtimeReady()) {
      const draft = characterDraftV3Schema.parse(await json(join(current, 'draft', 'draft.json')));
      const catalog = characterSourceCatalogV1Schema.parse(await json(join(current, 'source', 'catalog.json')));
      if (catalog.characterId !== 'builtin-default') throw new Error('CHARACTER_ID_MISMATCH');
      assertDraftSources(draft, catalog);
      for (const source of catalog.sources) await readVerified(join(current, 'source', characterSourceFileName(source)), source);
      return;
    }
  } catch {
    // 丢失修订或运行/源图损坏必须重装；已有创作数据先完整保留。
  }

  const backupId = randomUUID();
  const backup = join(backupRoot, backupId);
  const hadPrevious = await exists(current);
  await mkdir(backup, { recursive: true });
  if (hadPrevious) {
    await assertPlainTree(current);
    await cp(current, join(backup, 'previous'), { recursive: true, errorOnExist: true, force: false });
  }
  await host.writeText(journalFile, JSON.stringify({ version: 1, backupId, hadPrevious, index: host.index }));
  try {
    await mkdir(current, { recursive: true });
    const sourceDirectory = join(current, 'source');
    if (await exists(sourceDirectory)) await rename(sourceDirectory, join(backup, 'replaced-source'));
    await mkdir(sourceDirectory);
    for (const [name, bytes] of Object.entries(bundle.sources)) await writeFile(join(sourceDirectory, name), bytes, { flag: 'wx' });
    await host.writeText(join(sourceDirectory, 'catalog.json'), JSON.stringify(bundle.catalog));
    for (const source of bundle.catalog.sources) await readVerified(join(sourceDirectory, characterSourceFileName(source)), source);
    await host.installDocuments();
    await host.writeText(join(current, 'builtin-revision.json'), JSON.stringify(bundle.revision));
    await rm(journalFile);
  } catch (error) {
    // 回滚失败保留 journal 和原副本；下一次启动必须先恢复，不能确认修订。
    await recoverOfficialDefaultInstallation(host).catch(() => undefined);
    throw error;
  }
}
