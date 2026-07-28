import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve
} from 'node:path';
import {
  characterManifestV1Schema,
  CORE_CHARACTER_STATES,
  type CharacterDraftV1,
  type CharacterManifestV1,
  type CoreCharacterState
} from '@myself/character-runtime';
import { z } from 'zod';
import { atomicWriteText } from '../storage/atomic-file-coordinator';
import { characterError } from './character-errors';
import { migrateCharacterDocument } from './character-migrations';

const DEFAULT_CHARACTER_ID = 'builtin-default';
const SAFE_CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const PUBLISH_MARKER = 'publish-transaction.json';
const COMPILED_NEXT = 'compiled.next';
const COMPILED_BACKUP = 'compiled.backup';
const DRAFT_MARKER = 'draft-transaction.json';
const DRAFT_NEXT = 'draft.next.json';
const DRAFT_BACKUP = 'draft.backup.json';
const DELETE_TOMBSTONE_SUFFIX = '.delete-tombstone';

const indexEntrySchema = z.object({
  id: z.string().regex(SAFE_CHARACTER_ID),
  name: z.string().trim().min(1).max(120),
  thumbnailAssetId: z.string().regex(SAFE_CHARACTER_ID).nullable()
}).strict();

const characterIndexSchema = z.object({
  version: z.literal(1),
  activeCharacterId: z.string().regex(SAFE_CHARACTER_ID).nullable(),
  characters: z.array(indexEntrySchema),
  incompleteActivationConfirmations: z.record(
    z.string().regex(SAFE_CHARACTER_ID),
    z.string().regex(SHA_256)
  ).default({})
}).strict().superRefine((index, context) => {
  const ids = new Set<string>();
  index.characters.forEach((entry, entryIndex) => {
    if (ids.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '角色索引中的角色标识必须唯一。',
        path: ['characters', entryIndex, 'id']
      });
    }
    ids.add(entry.id);
  });
  if (index.activeCharacterId !== null && !ids.has(index.activeCharacterId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '活动角色必须引用索引中的角色。',
      path: ['activeCharacterId']
    });
  }
});

const transactionEntrySchema = indexEntrySchema;
const publishTransactionSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['prepared', 'old-moved', 'installed', 'rolling-back']),
  previousEntry: transactionEntrySchema,
  nextEntry: transactionEntrySchema
}).strict();
const draftTransactionSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['prepared', 'installed', 'rolling-back']),
  previousEntry: transactionEntrySchema,
  nextEntry: transactionEntrySchema
}).strict();

type CharacterIndex = z.output<typeof characterIndexSchema>;
type CharacterIndexEntry = z.output<typeof indexEntrySchema>;
type PublishTransaction = z.output<typeof publishTransactionSchema>;
type DraftTransaction = z.output<typeof draftTransactionSchema>;
type LoadedIndex = { index: CharacterIndex; writable: boolean };

export type CharacterSummary = {
  id: string;
  name: string;
  thumbnailAssetId: string | null;
  active: boolean;
  completeness: 'complete' | 'incomplete' | 'broken';
  missingCoreStates: CoreCharacterState[];
  activationConfirmationRequired: boolean;
};

export type CharacterStoreDependencies = {
  writeText?: typeof atomicWriteText;
  renamePath?: (source: string, destination: string) => Promise<void>;
  removePath?: (
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ) => Promise<void>;
  onRuntimeReadCheckpoint?: (
    checkpoint: 'runtime:manifest-after-open' | 'runtime:resource-after-open',
    targetPath: string
  ) => Promise<void>;
};

type RuntimePathIdentity = {
  device: number;
  inode: number;
  physicalPath: string;
  kind: 'directory' | 'file';
};

function emptyIndex(): CharacterIndex {
  return {
    version: 1,
    activeCharacterId: null,
    characters: [],
    incompleteActivationConfirmations: {}
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function assertCharacterId(characterId: string): void {
  if (!SAFE_CHARACTER_ID.test(characterId)) {
    throw characterError('CHARACTER_INVALID_ID');
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function activationFingerprint(manifest: CharacterManifestV1): string {
  // 指纹绑定当前发布清单；重新发布后必须重新确认不完整状态。
  return sha256(JSON.stringify(manifest));
}

function cloneIndex(index: CharacterIndex): CharacterIndex {
  return structuredClone(index);
}

function indexEntry(
  characterId: string,
  name: string,
  thumbnailAssetId: string | null
): CharacterIndexEntry {
  return { id: characterId, name, thumbnailAssetId };
}

function entryMatchesDraft(entry: CharacterIndexEntry, draft: CharacterDraftV1): boolean {
  return (
    entry.id === draft.id
    && entry.name === draft.name
    && entry.thumbnailAssetId === (draft.thumbnailAssetId ?? null)
  );
}

function entryMatchesManifest(
  entry: CharacterIndexEntry,
  manifest: CharacterManifestV1
): boolean {
  return (
    entry.id === manifest.id
    && entry.name === manifest.name
    && entry.thumbnailAssetId === manifest.thumbnailAssetId
  );
}

function missingCoreStates(
  document: Pick<CharacterDraftV1, 'states'> | Pick<CharacterManifestV1, 'states'>
): CoreCharacterState[] {
  return CORE_CHARACTER_STATES.filter((stateId) => {
    const state = document.states.find(candidate => candidate.id === stateId);
    return !state || state.actions.length === 0;
  });
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function durableWrite(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Electron Main 的角色存储。公开操作串行执行，磁盘事务使用固定名称并可在下次启动恢复。
 */
export class CharacterStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly writeText: typeof atomicWriteText;
  private readonly renamePath: (source: string, destination: string) => Promise<void>;
  private readonly removePath: (
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ) => Promise<void>;
  private readonly onRuntimeReadCheckpoint: NonNullable<
    CharacterStoreDependencies['onRuntimeReadCheckpoint']
  >;

  constructor(
    private readonly directory: string,
    dependencies: CharacterStoreDependencies = {}
  ) {
    this.writeText = dependencies.writeText ?? atomicWriteText;
    this.renamePath = dependencies.renamePath ?? rename;
    this.removePath = dependencies.removePath ?? rm;
    this.onRuntimeReadCheckpoint = dependencies.onRuntimeReadCheckpoint
      ?? (async () => undefined);
  }

  list(): Promise<CharacterSummary[]> {
    return this.enqueue(async () => {
      const loaded = await this.loadIndex();
      if (!loaded.writable) return [];
      const summaries = await Promise.all(loaded.index.characters.map(async entry => (
        this.summary(
          entry,
          loaded.index.activeCharacterId,
          loaded.index.incompleteActivationConfirmations
        )
      )));
      return summaries.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    });
  }

  create(input: { id: string; name: string }): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(input.id);
      const name = z.string().trim().min(1).max(120).parse(input.name);
      const loaded = await this.requireWritableIndex();
      if (loaded.characters.some(character => character.id === input.id)) {
        throw characterError('CHARACTER_ALREADY_EXISTS');
      }

      const characterDirectory = this.characterDirectory(input.id);
      await this.assertSafePath(characterDirectory);
      const draft = migrateCharacterDocument({
        version: 1,
        id: input.id,
        name,
        states: CORE_CHARACTER_STATES.map(stateId => ({
          id: stateId,
          kind: 'core',
          actions: []
        }))
      });

      try {
        await Promise.all([
          mkdir(join(characterDirectory, 'source'), { recursive: true }),
          mkdir(join(characterDirectory, 'draft'), { recursive: true }),
          mkdir(join(characterDirectory, 'compiled'), { recursive: true })
        ]);
        await this.safeWriteText(this.draftFile(input.id), json(draft));
        loaded.characters.push(indexEntry(input.id, name, null));
        await this.writeIndex(loaded);
      } catch (error) {
        await this.removePath(characterDirectory, {
          recursive: true,
          force: true
        }).catch(() => undefined);
        throw error;
      }
    });
  }

  saveDraft(characterId: string, draft: CharacterDraftV1): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const parsed = migrateCharacterDocument(draft);
      if (parsed.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }

      const index = await this.requireCharacter(characterId);
      const originalIndex = cloneIndex(index);
      const previousEntry = this.entry(index, characterId);
      const nextEntry = indexEntry(
        characterId,
        parsed.name,
        parsed.thumbnailAssetId ?? null
      );
      const transaction: DraftTransaction = {
        version: 1,
        phase: 'prepared',
        previousEntry: structuredClone(previousEntry),
        nextEntry
      };

      await this.assertSafeCharacterPath(characterId, join('draft'));
      await this.recoverDraftTransaction(characterId, index);
      try {
        await this.safeWriteText(this.draftNextFile(characterId), json(parsed));
        await this.writeDraftMarker(characterId, transaction);
        await this.removePath(this.draftBackupFile(characterId), { force: true });
        await this.renamePath(this.draftFile(characterId), this.draftBackupFile(characterId));
        await this.renamePath(this.draftNextFile(characterId), this.draftFile(characterId));
        transaction.phase = 'installed';
        await this.writeDraftMarker(characterId, transaction);

        this.replaceEntry(index, nextEntry);
        await this.writeIndex(index);
      } catch (error) {
        await this.rollbackDraftTransaction(characterId, originalIndex).catch(() => undefined);
        throw error;
      }
      await this.cleanupDraftTransaction(characterId);
    });
  }

  getDraft(characterId: string): Promise<CharacterDraftV1> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      await this.recoverDraftTransaction(characterId, index);
      return this.readDraft(characterId);
    });
  }

  publishCompiled(
    characterId: string,
    manifest: CharacterManifestV1,
    assets: Readonly<Record<string, Uint8Array>>
  ): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      const parsedManifest = this.parseManifest(manifest);
      if (parsedManifest.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }
      this.validateAssets(parsedManifest, assets);

      const originalIndex = cloneIndex(index);
      const previousEntry = structuredClone(this.entry(index, characterId));
      const nextEntry = indexEntry(
        characterId,
        parsedManifest.name,
        parsedManifest.thumbnailAssetId
      );
      const transaction: PublishTransaction = {
        version: 1,
        phase: 'prepared',
        previousEntry,
        nextEntry
      };

      await this.assertSafeCharacterPath(characterId);
      await this.recoverPublishTransaction(characterId, index);
      try {
        await this.removePath(this.compiledNextDirectory(characterId), {
          recursive: true,
          force: true
        });
        await mkdir(this.compiledNextDirectory(characterId), { recursive: false });
        for (const resource of parsedManifest.resources) {
          await durableWrite(
            join(this.compiledNextDirectory(characterId), resource.fileName),
            assets[resource.fileName]!.slice()
          );
        }
        await this.safeWriteText(
          join(this.compiledNextDirectory(characterId), 'manifest.json'),
          json(parsedManifest)
        );
        await this.readRuntimeFrom(this.compiledNextDirectory(characterId), characterId);
        await this.writePublishMarker(characterId, transaction);

        await this.removePath(this.compiledBackupDirectory(characterId), {
          recursive: true,
          force: true
        });
        await this.renamePath(
          this.compiledDirectory(characterId),
          this.compiledBackupDirectory(characterId)
        );
        transaction.phase = 'old-moved';
        await this.writePublishMarker(characterId, transaction);
        await this.renamePath(
          this.compiledNextDirectory(characterId),
          this.compiledDirectory(characterId)
        );
        transaction.phase = 'installed';
        await this.writePublishMarker(characterId, transaction);

        this.replaceEntry(index, nextEntry);
        delete index.incompleteActivationConfirmations[characterId];
        await this.writeIndex(index);
      } catch (error) {
        await this.rollbackPublishTransaction(characterId, originalIndex).catch(() => undefined);
        throw error;
      }
      await this.cleanupPublishTransaction(characterId);
    });
  }

  getRuntimeManifest(characterId: string): Promise<CharacterManifestV1> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      await this.recoverPublishTransaction(characterId, index);
      return this.readRuntime(characterId);
    });
  }

  setActive(characterId: string, confirmIncomplete = false): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      const manifest = await this.readRuntime(characterId);
      const missing = missingCoreStates(manifest);
      const fingerprint = activationFingerprint(manifest);
      const confirmed = index.incompleteActivationConfirmations[characterId];
      if (missing.length > 0 && confirmed !== fingerprint && !confirmIncomplete) {
        throw characterError('CHARACTER_INCOMPLETE_CONFIRMATION_REQUIRED');
      }
      if (missing.length > 0) {
        index.incompleteActivationConfirmations[characterId] = fingerprint;
      } else {
        delete index.incompleteActivationConfirmations[characterId];
      }
      index.activeCharacterId = characterId;
      await this.writeIndex(index);
    });
  }

  getActive(): Promise<CharacterManifestV1> {
    return this.enqueue(async () => {
      const loaded = await this.requireWritableIndex();
      if (loaded.activeCharacterId === null) {
        throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
      }
      return this.readRuntime(loaded.activeCharacterId);
    });
  }

  readActiveRuntimeAsset(assetId: string): Promise<Uint8Array> {
    return this.enqueue(async () => {
      assertCharacterId(assetId);
      const index = await this.requireWritableIndex();
      if (index.activeCharacterId === null) {
        throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
      }
      try {
        return await this.readRuntimeAssetFrom(
          this.compiledDirectory(index.activeCharacterId),
          index.activeCharacterId,
          assetId
        );
      } catch (error) {
        if (
          error instanceof Error
          && /^CHARACTER_[A-Z0-9_]+$/u.test(error.message)
        ) {
          throw error;
        }
        throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
      }
    });
  }

  delete(characterId: string): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      if (characterId === DEFAULT_CHARACTER_ID) {
        throw characterError('CHARACTER_DEFAULT_DELETE_REJECTED');
      }

      const index = await this.requireCharacter(characterId);
      if (index.activeCharacterId === characterId) {
        throw characterError('CHARACTER_ACTIVE_DELETE_REJECTED');
      }
      const originalIndex = cloneIndex(index);
      const characterDirectory = this.characterDirectory(characterId);
      const tombstone = this.deleteTombstone(characterId);
      await this.assertSafePath(characterDirectory);
      await this.assertSafePath(tombstone);

      try {
        await this.removePath(tombstone, { recursive: true, force: true });
        await this.renamePath(characterDirectory, tombstone);
        index.characters = index.characters.filter(character => character.id !== characterId);
        delete index.incompleteActivationConfirmations[characterId];
        await this.writeIndex(index);
      } catch (error) {
        if (await exists(tombstone)) {
          await this.removePath(characterDirectory, {
            recursive: true,
            force: true
          }).catch(() => undefined);
          await this.renamePath(tombstone, characterDirectory).catch(() => undefined);
        }
        await this.writeIndex(originalIndex).catch(() => undefined);
        throw error;
      }

      // 索引写入是删除提交点；后续清理失败只保留墓碑供启动恢复。
      await this.removePath(tombstone, {
        recursive: true,
        force: true
      }).catch(() => undefined);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const transaction = this.queue.then(operation);
    this.queue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  private async loadIndex(): Promise<LoadedIndex> {
    await this.ensureSafeRoot();
    const file = this.indexFile();
    await this.assertSafePath(file);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const index = emptyIndex();
      await this.writeIndex(index);
      return { index, writable: true };
    }

    const raw = (() => {
      try {
        return JSON.parse(source) as unknown;
      } catch {
        return undefined;
      }
    })();
    const parsed = characterIndexSchema.safeParse(raw);
    if (!parsed.success) {
      await this.preserveCorruptText(file, source);
      return { index: emptyIndex(), writable: false };
    }

    await this.recoverDeleteTombstones(parsed.data);
    await this.recoverAllCharacterTransactions(parsed.data);
    return { index: parsed.data, writable: true };
  }

  private async requireWritableIndex(): Promise<CharacterIndex> {
    const loaded = await this.loadIndex();
    if (!loaded.writable) throw characterError('CHARACTER_INDEX_UNAVAILABLE');
    return loaded.index;
  }

  private async requireCharacter(characterId: string): Promise<CharacterIndex> {
    const index = await this.requireWritableIndex();
    if (!index.characters.some(character => character.id === characterId)) {
      throw characterError('CHARACTER_NOT_FOUND');
    }
    await this.assertSafeCharacterPath(characterId);
    return index;
  }

  private writeIndex(index: CharacterIndex): Promise<void> {
    return this.safeWriteText(this.indexFile(), json(characterIndexSchema.parse(index)));
  }

  private async preserveCorruptText(file: string, source: string): Promise<void> {
    const corruptFile = `${file}.corrupt-${sha256(source).slice(0, 16)}`;
    await this.assertSafePath(corruptFile);
    if (!(await exists(corruptFile))) {
      await this.safeWriteText(corruptFile, source);
    }
  }

  private entry(index: CharacterIndex, characterId: string): CharacterIndexEntry {
    const entry = index.characters.find(character => character.id === characterId);
    if (!entry) throw characterError('CHARACTER_NOT_FOUND');
    return entry;
  }

  private replaceEntry(index: CharacterIndex, replacement: CharacterIndexEntry): void {
    const entryIndex = index.characters.findIndex(entry => entry.id === replacement.id);
    if (entryIndex < 0) throw characterError('CHARACTER_NOT_FOUND');
    index.characters[entryIndex] = structuredClone(replacement);
  }

  private async recoverAllCharacterTransactions(index: CharacterIndex): Promise<void> {
    for (const entry of index.characters) {
      await this.assertSafeCharacterPath(entry.id);
      await this.recoverDraftTransaction(entry.id, index);
      await this.recoverPublishTransaction(entry.id, index);
    }
  }

  private async recoverDeleteTombstones(index: CharacterIndex): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(DELETE_TOMBSTONE_SUFFIX)) continue;
      const characterId = entry.name.slice(0, -DELETE_TOMBSTONE_SUFFIX.length);
      if (!SAFE_CHARACTER_ID.test(characterId)) continue;
      const tombstone = this.deleteTombstone(characterId);
      await this.assertSafePath(tombstone);
      const characterDirectory = this.characterDirectory(characterId);
      if (index.characters.some(character => character.id === characterId)) {
        if (!(await exists(characterDirectory))) {
          await this.renamePath(tombstone, characterDirectory);
        } else {
          await this.removePath(tombstone, { recursive: true, force: true });
        }
      } else {
        await this.removePath(tombstone, { recursive: true, force: true });
      }
    }
  }

  private async recoverDraftTransaction(
    characterId: string,
    index: CharacterIndex
  ): Promise<void> {
    const markerFile = this.draftMarkerFile(characterId);
    const backupFile = this.draftBackupFile(characterId);
    const nextFile = this.draftNextFile(characterId);
    const currentFile = this.draftFile(characterId);
    await this.assertSafeCharacterPath(characterId, 'draft');
    await this.assertSafePath(markerFile);
    await this.assertSafePath(backupFile);
    await this.assertSafePath(nextFile);
    await this.assertSafePath(currentFile);

    if (!(await exists(markerFile))) {
      if (await exists(backupFile)) {
        if (!(await exists(currentFile))) {
          throw characterError('CHARACTER_TRANSACTION_INVALID');
        }
        await this.readDraftFrom(currentFile, characterId);
        await this.removePath(backupFile, { force: true });
      }
      await this.removePath(nextFile, { force: true });
      return;
    }

    const transaction = await this.readTransaction(markerFile, draftTransactionSchema);
    if (transaction.phase === 'installed') {
      let currentIsValid = false;
      try {
        const current = await this.readDraftFrom(currentFile, characterId);
        currentIsValid = entryMatchesDraft(transaction.nextEntry, current);
      } catch {
        currentIsValid = false;
      }
      if (currentIsValid) {
        this.replaceEntry(index, transaction.nextEntry);
        await this.writeIndex(index);
        await this.cleanupDraftTransaction(characterId);
        return;
      }
      // installed 的 current 缺失或无效时，只能回滚到已验证 backup。
    }

    if (await exists(backupFile)) {
      await this.restoreDraftBackup(characterId, transaction);
    } else {
      const current = await this.readDraftFrom(currentFile, characterId);
      if (!entryMatchesDraft(transaction.previousEntry, current)) {
        throw characterError('CHARACTER_TRANSACTION_INVALID');
      }
    }
    this.replaceEntry(index, transaction.previousEntry);
    await this.writeIndex(index);
    await this.cleanupDraftTransaction(characterId);
  }

  private async rollbackDraftTransaction(
    characterId: string,
    originalIndex: CharacterIndex
  ): Promise<void> {
    if (await exists(this.draftMarkerFile(characterId))) {
      const transaction = await this.readTransaction(
        this.draftMarkerFile(characterId),
        draftTransactionSchema
      );
      if (await exists(this.draftBackupFile(characterId))) {
        await this.restoreDraftBackup(characterId, transaction);
      } else {
        const current = await this.readDraftFrom(this.draftFile(characterId), characterId);
        if (!entryMatchesDraft(transaction.previousEntry, current)) {
          throw characterError('CHARACTER_TRANSACTION_INVALID');
        }
      }
    }
    await this.writeIndex(originalIndex);
    await this.cleanupDraftTransaction(characterId);
  }

  private async restoreDraftBackup(
    characterId: string,
    transaction: DraftTransaction
  ): Promise<void> {
    const backupFile = this.draftBackupFile(characterId);
    const backup = await this.readDraftFrom(backupFile, characterId);
    if (!entryMatchesDraft(transaction.previousEntry, backup)) {
      throw characterError('CHARACTER_TRANSACTION_INVALID');
    }
    transaction.phase = 'rolling-back';
    await this.writeDraftMarker(characterId, transaction);
    await this.removePath(this.draftFile(characterId), { force: true });
    await this.renamePath(backupFile, this.draftFile(characterId));
  }

  private async cleanupDraftTransaction(characterId: string): Promise<void> {
    await this.removePath(this.draftNextFile(characterId), { force: true });
    await this.removePath(this.draftBackupFile(characterId), { force: true });
    await this.removePath(this.draftMarkerFile(characterId), { force: true });
  }

  private writeDraftMarker(
    characterId: string,
    transaction: DraftTransaction
  ): Promise<void> {
    return this.safeWriteText(
      this.draftMarkerFile(characterId),
      json(draftTransactionSchema.parse(transaction))
    );
  }

  private async recoverPublishTransaction(
    characterId: string,
    index: CharacterIndex
  ): Promise<void> {
    const markerFile = this.publishMarkerFile(characterId);
    const compiled = this.compiledDirectory(characterId);
    const backup = this.compiledBackupDirectory(characterId);
    const next = this.compiledNextDirectory(characterId);
    await this.assertSafeCharacterPath(characterId);
    await this.assertSafePath(markerFile);
    await this.assertSafePath(compiled);
    await this.assertSafePath(backup);
    await this.assertSafePath(next);

    if (!(await exists(markerFile))) {
      if (await exists(backup)) {
        const previousEntry = structuredClone(this.entry(index, characterId));
        try {
          const manifest = await this.readRuntimeFrom(compiled, characterId);
          this.replaceEntry(index, indexEntry(
            characterId,
            manifest.name,
            manifest.thumbnailAssetId
          ));
          delete index.incompleteActivationConfirmations[characterId];
          await this.writeIndex(index);
        } catch {
          this.replaceEntry(index, previousEntry);
          throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
        }
        try {
          await this.removePath(backup, { recursive: true, force: true });
        } catch {
          // 已提交版本保持生效，固定 backup 留待下次启动继续清理。
        }
      }
      await this.removePath(next, { recursive: true, force: true });
      return;
    }

    const transaction = await this.readTransaction(markerFile, publishTransactionSchema);
    if (transaction.phase === 'installed') {
      let currentIsValid = false;
      try {
        const manifest = await this.readRuntimeFrom(compiled, characterId);
        currentIsValid = entryMatchesManifest(transaction.nextEntry, manifest);
      } catch {
        currentIsValid = false;
      }
      if (currentIsValid) {
        this.replaceEntry(index, transaction.nextEntry);
        delete index.incompleteActivationConfirmations[characterId];
        await this.writeIndex(index);
        await this.cleanupPublishTransaction(characterId);
        return;
      }
      // installed 的 current 缺失或无效时，只能回滚到已验证 backup。
    }

    if (await exists(backup)) {
      await this.restoreCompiledBackup(characterId, transaction);
    } else {
      const manifest = await this.readRuntimeFrom(compiled, characterId);
      if (!entryMatchesManifest(transaction.previousEntry, manifest)) {
        throw characterError('CHARACTER_TRANSACTION_INVALID');
      }
    }
    this.replaceEntry(index, transaction.previousEntry);
    await this.writeIndex(index);
    await this.cleanupPublishTransaction(characterId);
  }

  private async rollbackPublishTransaction(
    characterId: string,
    originalIndex: CharacterIndex
  ): Promise<void> {
    if (await exists(this.publishMarkerFile(characterId))) {
      const transaction = await this.readTransaction(
        this.publishMarkerFile(characterId),
        publishTransactionSchema
      );
      if (await exists(this.compiledBackupDirectory(characterId))) {
        await this.restoreCompiledBackup(characterId, transaction);
      } else {
        const manifest = await this.readRuntimeFrom(
          this.compiledDirectory(characterId),
          characterId
        );
        if (!entryMatchesManifest(transaction.previousEntry, manifest)) {
          throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
        }
      }
    }
    await this.writeIndex(originalIndex);
    await this.cleanupPublishTransaction(characterId);
  }

  private async restoreCompiledBackup(
    characterId: string,
    transaction: PublishTransaction
  ): Promise<void> {
    const backup = this.compiledBackupDirectory(characterId);
    const manifest = await this.readRuntimeFrom(backup, characterId);
    if (!entryMatchesManifest(transaction.previousEntry, manifest)) {
      throw characterError('CHARACTER_TRANSACTION_INVALID');
    }
    transaction.phase = 'rolling-back';
    await this.writePublishMarker(characterId, transaction);
    await this.removePath(this.compiledDirectory(characterId), {
      recursive: true,
      force: true
    });
    await this.renamePath(backup, this.compiledDirectory(characterId));
  }

  private async cleanupPublishTransaction(characterId: string): Promise<void> {
    await this.removePath(this.compiledNextDirectory(characterId), {
      recursive: true,
      force: true
    });
    await this.removePath(this.compiledBackupDirectory(characterId), {
      recursive: true,
      force: true
    });
    await this.removePath(this.publishMarkerFile(characterId), { force: true });
  }

  private writePublishMarker(
    characterId: string,
    transaction: PublishTransaction
  ): Promise<void> {
    return this.safeWriteText(
      this.publishMarkerFile(characterId),
      json(publishTransactionSchema.parse(transaction))
    );
  }

  private async readTransaction<T>(
    file: string,
    schema: z.ZodType<T>
  ): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      throw characterError('CHARACTER_TRANSACTION_INVALID');
    }
  }

  private async readDraft(characterId: string): Promise<CharacterDraftV1> {
    const file = this.draftFile(characterId);
    await this.assertSafePath(file);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw characterError('CHARACTER_MIGRATION_FAILED');
    }

    try {
      return migrateCharacterDocument(JSON.parse(source));
    } catch (error) {
      await this.preserveCorruptText(file, source);
      if (
        error instanceof Error
        && (
          error.message === 'CHARACTER_MIGRATION_FAILED'
          || error.message === 'CHARACTER_VERSION_UNSUPPORTED'
        )
      ) {
        throw error;
      }
      throw characterError('CHARACTER_MIGRATION_FAILED');
    }
  }

  private async readDraftFrom(
    file: string,
    characterId: string
  ): Promise<CharacterDraftV1> {
    await this.assertSafePath(file);
    try {
      const draft = migrateCharacterDocument(JSON.parse(await readFile(file, 'utf8')));
      if (draft.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }
      return draft;
    } catch {
      throw characterError('CHARACTER_MIGRATION_FAILED');
    }
  }

  private parseManifest(raw: unknown): CharacterManifestV1 {
    const parsed = characterManifestV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw characterError('CHARACTER_MANIFEST_INVALID');
    }
    return parsed.data;
  }

  private validateAssets(
    manifest: CharacterManifestV1,
    assets: Readonly<Record<string, Uint8Array>>
  ): void {
    const expectedFiles = new Set(manifest.resources.map(resource => resource.fileName));
    const suppliedFiles = Object.keys(assets);
    if (
      expectedFiles.size !== manifest.resources.length
      || suppliedFiles.length !== expectedFiles.size
      || suppliedFiles.some(file => !expectedFiles.has(file))
    ) {
      throw characterError('CHARACTER_RESOURCE_INTEGRITY_FAILED');
    }

    for (const resource of manifest.resources) {
      const bytes = assets[resource.fileName];
      if (
        !(bytes instanceof Uint8Array)
        || bytes.byteLength !== resource.byteLength
        || sha256(bytes) !== resource.sha256
      ) {
        throw characterError('CHARACTER_RESOURCE_INTEGRITY_FAILED');
      }
    }
  }

  private async readRuntime(characterId: string): Promise<CharacterManifestV1> {
    try {
      return await this.readRuntimeFrom(this.compiledDirectory(characterId), characterId);
    } catch {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
  }

  private async readRuntimeFrom(
    directory: string,
    characterId: string
  ): Promise<CharacterManifestV1> {
    await this.assertSafePath(directory);
    const directoryIdentity = await this.captureRuntimeIdentity(directory, 'directory');
    const manifestFile = join(directory, 'manifest.json');
    const manifestBytes = await this.readStableRuntimeFile(
      manifestFile,
      directory,
      directoryIdentity,
      'runtime:manifest-after-open'
    );
    const manifest = this.parseManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (manifest.id !== characterId) {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
    const assets: Record<string, Uint8Array> = {};
    for (const resource of manifest.resources) {
      const resourceFile = join(directory, resource.fileName);
      assets[resource.fileName] = new Uint8Array(await this.readStableRuntimeFile(
        resourceFile,
        directory,
        directoryIdentity,
        'runtime:resource-after-open'
      ));
    }
    this.validateAssets(manifest, assets);
    return manifest;
  }

  private async readRuntimeAssetFrom(
    directory: string,
    characterId: string,
    assetId: string
  ): Promise<Uint8Array> {
    await this.assertSafePath(directory);
    const directoryIdentity = await this.captureRuntimeIdentity(directory, 'directory');
    const manifestFile = join(directory, 'manifest.json');
    const manifestBytes = await this.readStableRuntimeFile(
      manifestFile,
      directory,
      directoryIdentity,
      'runtime:manifest-after-open'
    );
    const manifest = this.parseManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (manifest.id !== characterId) {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
    const resource = manifest.resources.find(candidate => candidate.assetId === assetId);
    if (!resource) throw characterError('CHARACTER_RESOURCE_NOT_FOUND');

    const resourceFile = join(directory, resource.fileName);
    const bytes = new Uint8Array(await this.readStableRuntimeFile(
      resourceFile,
      directory,
      directoryIdentity,
      'runtime:resource-after-open'
    ));
    if (
      bytes.byteLength !== resource.byteLength
      || sha256(bytes) !== resource.sha256
    ) {
      throw characterError('CHARACTER_RESOURCE_INTEGRITY_FAILED');
    }
    return bytes;
  }

  /**
   * 运行时文件只通过已核验句柄读取，并在读取前后确认文件与 compiled 目录未换位。
   */
  private async readStableRuntimeFile(
    file: string,
    directory: string,
    directoryIdentity: RuntimePathIdentity,
    checkpoint: 'runtime:manifest-after-open' | 'runtime:resource-after-open'
  ): Promise<Buffer> {
    try {
      await this.assertRuntimeIdentity(directory, directoryIdentity);
      const pathIdentity = await this.captureRuntimeIdentity(file, 'file');
      const handle = await open(file, 'r');
      try {
        const handleInfo = await handle.stat();
        if (
          !handleInfo.isFile()
          || Number(handleInfo.dev) !== pathIdentity.device
          || Number(handleInfo.ino) !== pathIdentity.inode
        ) {
          throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
        }

        await this.assertRuntimeIdentity(directory, directoryIdentity);
        await this.onRuntimeReadCheckpoint(checkpoint, file);
        const bytes = await handle.readFile();
        await this.assertRuntimeIdentity(file, pathIdentity);
        await this.assertRuntimeIdentity(directory, directoryIdentity);
        return bytes;
      } finally {
        await handle.close();
      }
    } catch {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
  }

  private async captureRuntimeIdentity(
    target: string,
    kind: RuntimePathIdentity['kind']
  ): Promise<RuntimePathIdentity> {
    const info = await lstat(target);
    if (
      info.isSymbolicLink()
      || (kind === 'file' ? !info.isFile() : !info.isDirectory())
    ) {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
    return {
      device: Number(info.dev),
      inode: Number(info.ino),
      physicalPath: await realpath(target),
      kind
    };
  }

  private async assertRuntimeIdentity(
    target: string,
    expected: RuntimePathIdentity
  ): Promise<void> {
    const actual = await this.captureRuntimeIdentity(target, expected.kind);
    if (
      actual.device !== expected.device
      || actual.inode !== expected.inode
      || actual.physicalPath !== expected.physicalPath
    ) {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
  }

  private async summary(
    entry: CharacterIndexEntry,
    activeCharacterId: string | null,
    confirmations: Readonly<Record<string, string>>
  ): Promise<CharacterSummary> {
    const compiledManifest = join(this.compiledDirectory(entry.id), 'manifest.json');
    if (await exists(compiledManifest)) {
      try {
        const manifest = await this.readRuntime(entry.id);
        const missing = missingCoreStates(manifest);
        return {
          ...entry,
          active: activeCharacterId === entry.id,
          completeness: missing.length === 0 ? 'complete' : 'incomplete',
          missingCoreStates: missing,
          activationConfirmationRequired: (
            missing.length > 0
            && confirmations[entry.id] !== activationFingerprint(manifest)
          )
        };
      } catch {
        return {
          ...entry,
          active: activeCharacterId === entry.id,
          completeness: 'broken',
          missingCoreStates: [],
          activationConfirmationRequired: false
        };
      }
    }

    try {
      const draft = await this.readDraft(entry.id);
      return {
        ...entry,
        active: activeCharacterId === entry.id,
        completeness: 'incomplete',
        missingCoreStates: missingCoreStates(draft),
        activationConfirmationRequired: true
      };
    } catch {
      return {
        ...entry,
        active: activeCharacterId === entry.id,
        completeness: 'broken',
        missingCoreStates: [],
        activationConfirmationRequired: false
      };
    }
  }

  private async ensureSafeRoot(): Promise<void> {
    const absolute = resolve(this.directory);
    await this.assertNoLinks(dirname(absolute));
    await mkdir(absolute, { recursive: true });
    await this.assertNoLinks(absolute);
  }

  private async assertSafeCharacterPath(
    characterId: string,
    child?: string
  ): Promise<void> {
    const target = child
      ? join(this.characterDirectory(characterId), child)
      : this.characterDirectory(characterId);
    await this.assertSafePath(target);
  }

  private async assertSafePath(target: string): Promise<void> {
    const root = resolve(this.directory);
    const absoluteTarget = resolve(target);
    if (!isContained(root, absoluteTarget)) {
      throw characterError('CHARACTER_PATH_UNSAFE');
    }
    await this.ensureSafeRoot();
    await this.assertNoLinks(absoluteTarget);

    const physicalRoot = await realpath(root);
    let existing = absoluteTarget;
    while (!(await exists(existing))) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const physicalExisting = await realpath(existing);
    if (!isContained(physicalRoot, physicalExisting)) {
      throw characterError('CHARACTER_PATH_UNSAFE');
    }
  }

  private async assertNoLinks(target: string): Promise<void> {
    const absolute = resolve(target);
    const root = parse(absolute).root;
    const segments = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw characterError('CHARACTER_PATH_UNSAFE');
        }
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
    }
  }

  private async safeWriteText(file: string, content: string): Promise<void> {
    await this.assertSafePath(file);
    await this.writeText(file, content);
  }

  private indexFile(): string {
    return join(this.directory, 'index.json');
  }

  private characterDirectory(characterId: string): string {
    return join(this.directory, characterId);
  }

  private draftDirectory(characterId: string): string {
    return join(this.characterDirectory(characterId), 'draft');
  }

  private draftFile(characterId: string): string {
    return join(this.draftDirectory(characterId), 'draft.json');
  }

  private draftNextFile(characterId: string): string {
    return join(this.draftDirectory(characterId), DRAFT_NEXT);
  }

  private draftBackupFile(characterId: string): string {
    return join(this.draftDirectory(characterId), DRAFT_BACKUP);
  }

  private draftMarkerFile(characterId: string): string {
    return join(this.draftDirectory(characterId), DRAFT_MARKER);
  }

  private compiledDirectory(characterId: string): string {
    return join(this.characterDirectory(characterId), 'compiled');
  }

  private compiledNextDirectory(characterId: string): string {
    return join(this.characterDirectory(characterId), COMPILED_NEXT);
  }

  private compiledBackupDirectory(characterId: string): string {
    return join(this.characterDirectory(characterId), COMPILED_BACKUP);
  }

  private publishMarkerFile(characterId: string): string {
    return join(this.characterDirectory(characterId), PUBLISH_MARKER);
  }

  private deleteTombstone(characterId: string): string {
    return join(this.directory, `${characterId}${DELETE_TOMBSTONE_SUFFIX}`);
  }
}
