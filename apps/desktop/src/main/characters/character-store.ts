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
  characterDraftV2Schema,
  characterManifestV2Schema,
  characterV2Completeness,
  projectCharacterManifestV2ToLegacy,
  type CharacterDraftV2,
  type CharacterManifestV1,
  type CharacterManifestV2,
  type CharacterV2CompletenessIssue
} from '@myself/character-runtime';
import { z } from 'zod';
import { atomicWriteText } from '../storage/atomic-file-coordinator';
import { characterError } from './character-errors';
import {
  migrateCharacterDocument,
  migrateCharacterManifest
} from './character-migrations';

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
const PACKAGE_IMPORT_OWNER = '.package-import-owner.json';
const IMPORT_TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAFT_REVISION = IMPORT_TRANSACTION_ID;

const indexEntrySchema = z.object({
  id: z.string().regex(SAFE_CHARACTER_ID),
  name: z.string().trim().min(1).max(120),
  thumbnailAssetId: z.string().regex(SAFE_CHARACTER_ID).nullable(),
  draftRevision: z.string().regex(DRAFT_REVISION).optional(),
  draftVersion: z.literal(2).optional(),
  compiledVersion: z.literal(2).optional(),
  migrationErrorCode: z.literal('CHARACTER_MIGRATION_FAILED').optional()
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
  version: z.union([z.literal(1), z.literal(2)]),
  phase: z.enum(['prepared', 'old-moved', 'installed', 'rolling-back']),
  hadPreviousRuntime: z.boolean().optional(),
  keepBackup: z.boolean().default(false),
  previousEntry: transactionEntrySchema,
  nextEntry: transactionEntrySchema
}).strict().superRefine((transaction, context) => {
  if (transaction.version === 2 && transaction.hadPreviousRuntime === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '第二版发布事务必须记录上一运行版本状态。',
      path: ['hadPreviousRuntime']
    });
  }
}).transform(transaction => ({
  ...transaction,
  hadPreviousRuntime: transaction.version === 1
    ? true
    : transaction.hadPreviousRuntime!
}));
const draftTransactionSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['prepared', 'installed', 'rolling-back']),
  keepBackup: z.boolean().default(false),
  previousEntry: transactionEntrySchema,
  nextEntry: transactionEntrySchema
}).strict();

type CharacterIndex = z.output<typeof characterIndexSchema>;
type CharacterIndexEntry = z.output<typeof indexEntrySchema>;
type PublishTransaction = z.output<typeof publishTransactionSchema>;
type DraftTransaction = z.output<typeof draftTransactionSchema>;
type LoadedIndex = { index: CharacterIndex; writable: boolean };

export type CharacterCreateOptions = {
  importTransactionId?: string;
};

export type CharacterSummary = {
  id: string;
  name: string;
  thumbnailAssetId: string | null;
  active: boolean;
  completeness: 'complete' | 'incomplete' | 'broken';
  missingRequirements: CharacterV2CompletenessIssue[];
  migrationErrorCode?: 'CHARACTER_MIGRATION_FAILED';
  migrationRecoveryAvailable: boolean;
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
  onRecoveryDirectoryCandidate?: (
    characterId: string,
    directory: string
  ) => Promise<void>;
  onImportRollbackCheckpoint?: (
    checkpoint: 'before-rename',
    characterId: string
  ) => Promise<void>;
};

export type CharacterIndexRecoveryResult = {
  recovered: boolean;
  recoveredCharacterIds: string[];
  skipped: Array<{
    characterId: string;
    reason: 'CHARACTER_RECOVERY_DIRECTORY_SKIPPED';
  }>;
  warnings: Array<'CHARACTER_RECOVERY_RECORD_WRITE_FAILED'>;
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

function activationFingerprint(manifest: CharacterManifestV2): string {
  // 指纹绑定当前发布清单；重新发布后必须重新确认不完整状态。
  return sha256(JSON.stringify(manifest));
}

function cloneIndex(index: CharacterIndex): CharacterIndex {
  return structuredClone(index);
}

function indexEntry(
  characterId: string,
  name: string,
  thumbnailAssetId: string | null,
  versions: Pick<CharacterIndexEntry, 'draftVersion' | 'compiledVersion'> = {
    draftVersion: 2
  }
): CharacterIndexEntry {
  return { id: characterId, name, thumbnailAssetId, ...versions };
}

function entryMatchesDraft(entry: CharacterIndexEntry, draft: CharacterDraftV2): boolean {
  return (
    entry.id === draft.id
    && entry.name === draft.name
    && entry.thumbnailAssetId === (draft.thumbnailAssetId ?? null)
  );
}

function entryMatchesManifest(
  entry: CharacterIndexEntry,
  manifest: Pick<CharacterManifestV2, 'id' | 'name' | 'thumbnailAssetId'>
): boolean {
  return (
    entry.id === manifest.id
    && entry.name === manifest.name
    && entry.thumbnailAssetId === manifest.thumbnailAssetId
  );
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

function sameFileIdentity(
  left: { directoryDev: number; directoryIno: number; ownerDev: number; ownerIno: number },
  right: { directoryDev: number; directoryIno: number; ownerDev: number; ownerIno: number }
): boolean {
  return left.directoryDev === right.directoryDev
    && left.directoryIno === right.directoryIno
    && left.ownerDev === right.ownerDev
    && left.ownerIno === right.ownerIno;
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
  /** 保存调用入队前即登记新修订，使在途发布可在提交前观察到后到编辑。 */
  private readonly pendingDraftRevisions = new Map<
    string,
    { revision: string; reused: boolean }
  >();
  /** 调用方令牌在单次 Main 生命周期内只能预留一次，防止 R1→R2→R1 绕回。 */
  private readonly seenDraftRevisions = new Map<string, Set<string>>();
  private readonly writeText: typeof atomicWriteText;
  private readonly renamePath: (source: string, destination: string) => Promise<void>;
  private readonly removePath: (
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ) => Promise<void>;
  private readonly onRuntimeReadCheckpoint: NonNullable<
    CharacterStoreDependencies['onRuntimeReadCheckpoint']
  >;
  private readonly onRecoveryDirectoryCandidate: NonNullable<
    CharacterStoreDependencies['onRecoveryDirectoryCandidate']
  >;
  private readonly onImportRollbackCheckpoint: NonNullable<
    CharacterStoreDependencies['onImportRollbackCheckpoint']
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
    this.onRecoveryDirectoryCandidate = dependencies.onRecoveryDirectoryCandidate
      ?? (async () => undefined);
    this.onImportRollbackCheckpoint = dependencies.onImportRollbackCheckpoint
      ?? (async () => undefined);
  }

  list(): Promise<CharacterSummary[]> {
    return this.enqueue(async () => {
      const loaded = await this.loadIndex();
      if (!loaded.writable) return [];
      const originalIndex = JSON.stringify(loaded.index);
      const summaries: CharacterSummary[] = [];
      for (const entry of loaded.index.characters) {
        summaries.push(await this.summary(entry, loaded.index));
      }
      if (JSON.stringify(loaded.index) !== originalIndex) {
        await this.writeIndex(loaded.index);
      }
      return summaries.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    });
  }

  /**
   * 索引损坏时只重建目录清单，不删除或改写任何角色目录。
   * 每个可验证的草稿或运行版本都会重新进入索引，原索引由 loadIndex 保留证据副本。
   */
  recoverCorruptIndex(): Promise<CharacterIndexRecoveryResult> {
    return this.enqueue(async () => {
      const loaded = await this.loadIndex();
      if (loaded.writable) {
        return {
          recovered: false,
          recoveredCharacterIds: [],
          skipped: [],
          warnings: []
        };
      }

      const recovered = emptyIndex();
      const skipped: CharacterIndexRecoveryResult['skipped'] = [];
      const warnings: CharacterIndexRecoveryResult['warnings'] = [];
      const entries = await readdir(this.directory, { withFileTypes: true });
      for (const directoryEntry of entries) {
        if (!SAFE_CHARACTER_ID.test(directoryEntry.name)) continue;
        const characterId = directoryEntry.name;
        try {
          if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
            throw characterError('CHARACTER_PATH_UNSAFE');
          }
          const candidateDirectory = this.characterDirectory(characterId);
          await this.onRecoveryDirectoryCandidate(characterId, candidateDirectory);
          await this.assertSafeCharacterPath(characterId);

          let recoveredEntry: CharacterIndexEntry | null = null;
          try {
            const draft = await this.readDraftFrom(this.draftFile(characterId), characterId);
            recoveredEntry = indexEntry(
              characterId,
              draft.name,
              draft.thumbnailAssetId ?? null
            );
          } catch {
            // 草稿不可解析时继续尝试只读运行版本；原目录和坏文件保持不动。
          }
          if (!recoveredEntry) {
            const manifest = await this.readRuntimeFrom(
              this.compiledDirectory(characterId),
              characterId
            );
            recoveredEntry = indexEntry(characterId, manifest.name, manifest.thumbnailAssetId);
          }
          recovered.characters.push(recoveredEntry);
        } catch {
          skipped.push({
            characterId,
            reason: 'CHARACTER_RECOVERY_DIRECTORY_SKIPPED'
          });
        }
      }

      recovered.characters.sort((left, right) => left.id.localeCompare(right.id, 'en'));
      const recoveryRecord = {
        version: 1,
        reason: 'CHARACTER_INDEX_UNAVAILABLE',
        recoveredCharacterIds: recovered.characters.map(character => character.id),
        skipped
      };
      const recordHash = sha256(JSON.stringify(recoveryRecord)).slice(0, 16);
      try {
        await this.safeWriteText(
          join(this.directory, `index-recovery-${recordHash}.json`),
          json(recoveryRecord)
        );
      } catch {
        warnings.push('CHARACTER_RECOVERY_RECORD_WRITE_FAILED');
      }
      await this.writeIndex(recovered);
      return {
        recovered: true,
        recoveredCharacterIds: recoveryRecord.recoveredCharacterIds,
        skipped,
        warnings
      };
    });
  }

  create(
    input: { id: string; name: string },
    options: CharacterCreateOptions = {}
  ): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(input.id);
      const name = z.string().trim().min(1).max(120).parse(input.name);
      const importTransactionId = options.importTransactionId === undefined
        ? undefined
        : z.string().regex(IMPORT_TRANSACTION_ID).parse(options.importTransactionId);
      const loaded = await this.requireWritableIndex();
      if (loaded.characters.some(character => character.id === input.id)) {
        throw characterError('CHARACTER_ALREADY_EXISTS');
      }

      const characterDirectory = this.characterDirectory(input.id);
      await this.assertSafePath(characterDirectory);
      const draft = characterDraftV2Schema.parse({
        version: 2,
        id: input.id,
        name,
        identity: {
          description: name,
          background: '尚未填写角色背景。',
          traits: [],
          languageStyle: '未指定',
          formsOfAddress: [],
          likes: [],
          dislikes: [],
          behavioralTendencies: [],
          boundaries: [],
          exampleLines: []
        },
        defaultSkinId: 'default',
        defaultStateId: 'idle',
        skins: [{
          id: 'default',
          name: '默认皮肤',
          presentations: [],
          semanticFallbacks: []
        }],
        states: [{
          id: 'idle',
          name: '待机',
          kind: 'primary',
          semantic: 'idle',
          tags: [],
          intensity: 0.5,
          suggestedDurationMs: 3000,
          coexistWithStateIds: [],
          forbiddenStateIds: [],
          enterConditions: [],
          exitConditions: [],
          agentInferable: true,
          actionIds: []
        }],
        actions: []
      });

      try {
        await Promise.all([
          mkdir(join(characterDirectory, 'source'), { recursive: true }),
          mkdir(join(characterDirectory, 'draft'), { recursive: true }),
          mkdir(join(characterDirectory, 'compiled'), { recursive: true })
        ]);
        if (importTransactionId) {
          await this.safeWriteText(
            this.packageImportOwnerFile(input.id),
            json({ version: 1, characterId: input.id, importTransactionId })
          );
        }
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

  rollbackImportedCharacter(
    characterId: string,
    importTransactionId: string
  ): Promise<boolean> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      z.string().regex(IMPORT_TRANSACTION_ID).parse(importTransactionId);
      const ownerFile = this.packageImportOwnerFile(characterId);
      const characterDirectory = this.characterDirectory(characterId);
      const originalIdentity = await this.readImportOwnershipIdentity(
        characterDirectory,
        ownerFile,
        characterId,
        importTransactionId
      );
      if (!originalIdentity) return false;

      const index = await this.requireWritableIndex();
      if (index.activeCharacterId === characterId) return false;
      const originalIndex = cloneIndex(index);
      const tombstone = this.deleteTombstone(characterId);
      await this.assertSafePath(characterDirectory);
      await this.assertSafePath(tombstone);
      await this.onImportRollbackCheckpoint('before-rename', characterId);
      const currentIdentity = await this.readImportOwnershipIdentity(
        characterDirectory,
        ownerFile,
        characterId,
        importTransactionId
      );
      if (!currentIdentity || !sameFileIdentity(originalIdentity, currentIdentity)) {
        return false;
      }
      try {
        await this.removePath(tombstone, { recursive: true, force: true });
        await this.renamePath(characterDirectory, tombstone);
        const movedIdentity = await this.readImportOwnershipIdentity(
          tombstone,
          join(tombstone, PACKAGE_IMPORT_OWNER),
          characterId,
          importTransactionId
        );
        if (!movedIdentity || !sameFileIdentity(originalIdentity, movedIdentity)) {
          if (!(await exists(characterDirectory))) {
            await this.renamePath(tombstone, characterDirectory);
          }
          return false;
        }
        index.characters = index.characters.filter(entry => entry.id !== characterId);
        delete index.incompleteActivationConfirmations[characterId];
        await this.writeIndex(index);
      } catch (error) {
        if (await exists(tombstone)) {
          await this.renamePath(tombstone, characterDirectory).catch(() => undefined);
        }
        await this.writeIndex(originalIndex).catch(() => undefined);
        throw error;
      }
      await this.removePath(tombstone, { recursive: true, force: true })
        .catch(() => undefined);
      return true;
    });
  }

  private async readImportOwnershipIdentity(
    characterDirectory: string,
    ownerFile: string,
    characterId: string,
    importTransactionId: string
  ): Promise<{ directoryDev: number; directoryIno: number; ownerDev: number; ownerIno: number } | null> {
    await this.assertSafePath(characterDirectory);
    await this.assertSafePath(ownerFile);
    try {
      const [directoryStats, ownerStats, ownerText] = await Promise.all([
        lstat(characterDirectory),
        lstat(ownerFile),
        readFile(ownerFile, 'utf8')
      ]);
      if (
        !directoryStats.isDirectory()
        || directoryStats.isSymbolicLink()
        || !ownerStats.isFile()
        || ownerStats.isSymbolicLink()
      ) {
        return null;
      }
      const owner = JSON.parse(ownerText) as unknown;
      if (
        typeof owner !== 'object'
        || owner === null
        || !('version' in owner)
        || owner.version !== 1
        || !('characterId' in owner)
        || owner.characterId !== characterId
        || !('importTransactionId' in owner)
        || owner.importTransactionId !== importTransactionId
      ) {
        return null;
      }
      return {
        directoryDev: directoryStats.dev,
        directoryIno: directoryStats.ino,
        ownerDev: ownerStats.dev,
        ownerIno: ownerStats.ino
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  completeImportedCharacter(
    characterId: string,
    importTransactionId: string
  ): Promise<boolean> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      z.string().regex(IMPORT_TRANSACTION_ID).parse(importTransactionId);
      const ownerFile = this.packageImportOwnerFile(characterId);
      await this.assertSafePath(ownerFile);
      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(ownerFile, 'utf8'));
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
      if (
        typeof owner !== 'object'
        || owner === null
        || !('version' in owner)
        || owner.version !== 1
        || !('characterId' in owner)
        || owner.characterId !== characterId
        || !('importTransactionId' in owner)
        || owner.importTransactionId !== importTransactionId
      ) {
        return false;
      }
      await this.removePath(ownerFile, { force: true });
      return true;
    });
  }

  saveDraft(
    characterId: string,
    draft: CharacterDraftV2,
    draftRevision?: string
  ): Promise<void> {
    const parsedRevision = draftRevision === undefined
      ? undefined
      : z.string().regex(DRAFT_REVISION).safeParse(draftRevision);
    const revisionReservation = parsedRevision?.success
      ? {
          revision: parsedRevision.data,
          reused: this.rememberDraftRevision(characterId, parsedRevision.data)
        }
      : undefined;
    if (revisionReservation) {
      this.pendingDraftRevisions.set(characterId, revisionReservation);
    }
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      if (parsedRevision && !parsedRevision.success) {
        throw characterError('CHARACTER_DRAFT_REVISION_CONFLICT');
      }
      if (revisionReservation?.reused) {
        throw characterError('CHARACTER_DRAFT_REVISION_CONFLICT');
      }
      const parsed = characterDraftV2Schema.safeParse(draft);
      if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
      if (parsed.data.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }

      const index = await this.requireCharacter(characterId);
      if (
        revisionReservation
        && this.entry(index, characterId).draftRevision === revisionReservation.revision
      ) {
        revisionReservation.reused = true;
        throw characterError('CHARACTER_DRAFT_REVISION_CONFLICT');
      }
      await this.assertSafeCharacterPath(characterId, join('draft'));
      await this.recoverDraftTransaction(characterId, index);
      await this.installDraftTransaction(
        characterId,
        index,
        parsed.data,
        parsedRevision?.success ? { draftRevision: parsedRevision.data } : {}
      );
    });
  }

  getDraft(characterId: string): Promise<CharacterDraftV2> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      await this.recoverDraftTransaction(characterId, index);
      return this.ensureDraftV2(characterId, index);
    });
  }

  publishCompiled(
    characterId: string,
    manifest: CharacterManifestV2,
    assets: Readonly<Record<string, Uint8Array>>,
    draftRevision?: string
  ): Promise<void> {
    const parsedRevision = draftRevision === undefined
      ? undefined
      : z.string().regex(DRAFT_REVISION).safeParse(draftRevision);
    if (parsedRevision?.success) {
      this.rememberDraftRevision(characterId, parsedRevision.data);
    }
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      if (draftRevision !== undefined) {
        z.string().regex(DRAFT_REVISION).parse(draftRevision);
        this.assertDraftRevision(characterId, index, draftRevision);
      }
      const parsedManifest = this.parseManifest(manifest);
      if (parsedManifest.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }
      this.validateAssets(parsedManifest, assets);

      await this.assertSafeCharacterPath(characterId);
      await this.recoverPublishTransaction(characterId, index);
      await this.installPublishedTransaction(
        characterId,
        index,
        parsedManifest,
        assets,
        draftRevision === undefined ? {} : { expectedDraftRevision: draftRevision }
      );
    });
  }

  getRuntimeManifest(characterId: string): Promise<CharacterManifestV1> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      await this.recoverPublishTransaction(characterId, index);
      return projectCharacterManifestV2ToLegacy(
        await this.ensurePublishedV2(characterId, index)
      );
    });
  }

  getPublishedManifest(characterId: string): Promise<CharacterManifestV2> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      await this.recoverPublishTransaction(characterId, index);
      return this.ensurePublishedV2(characterId, index);
    });
  }

  setActive(characterId: string, confirmIncomplete = false): Promise<void> {
    return this.enqueue(async () => {
      assertCharacterId(characterId);
      const index = await this.requireCharacter(characterId);
      const manifest = await this.ensurePublishedV2(characterId, index);
      const missing = characterV2Completeness(manifest);
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
      return projectCharacterManifestV2ToLegacy(
        await this.ensurePublishedV2(loaded.activeCharacterId, loaded)
      );
    });
  }

  /** 仅供 Main 行为引擎读取发布后的 V2 清单，不经过 Renderer 边界。 */
  getActiveManifestV2(): Promise<CharacterManifestV2> {
    return this.enqueue(async () => {
      const loaded = await this.requireWritableIndex();
      if (loaded.activeCharacterId === null) {
        throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
      }
      return this.ensurePublishedV2(loaded.activeCharacterId, loaded);
    });
  }

  readActiveRuntimeAsset(assetId: string): Promise<Uint8Array> {
    return this.enqueue(async () => {
      assertCharacterId(assetId);
      const index = await this.requireWritableIndex();
      if (index.activeCharacterId === null) {
        throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
      }
      await this.ensurePublishedV2(index.activeCharacterId, index);
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

  private rememberDraftRevision(characterId: string, revision: string): boolean {
    const seen = this.seenDraftRevisions.get(characterId) ?? new Set<string>();
    const reused = seen.has(revision);
    seen.add(revision);
    this.seenDraftRevisions.set(characterId, seen);
    return reused;
  }

  private assertDraftRevision(
    characterId: string,
    index: CharacterIndex,
    expectedRevision: string
  ): void {
    const entry = this.entry(index, characterId);
    const pendingRevision = this.pendingDraftRevisions.get(characterId);
    if (
      entry.draftRevision !== expectedRevision
      || (
        pendingRevision !== undefined
        && (pendingRevision.revision !== expectedRevision || pendingRevision.reused)
      )
    ) {
      throw characterError('CHARACTER_DRAFT_REVISION_CONFLICT');
    }
  }

  /** 索引写盘成功后才替换共享内存，避免失败提交污染后续恢复流程。 */
  private async commitIndexUpdate(
    index: CharacterIndex,
    update: (nextIndex: CharacterIndex) => void
  ): Promise<void> {
    const nextIndex = cloneIndex(index);
    update(nextIndex);
    await this.writeIndex(nextIndex);
    Object.assign(index, cloneIndex(nextIndex));
  }

  /** 复用草稿事务安装 V2；迁移时仅在提交成功后保留 V1 恢复点。 */
  private async installDraftTransaction(
    characterId: string,
    index: CharacterIndex,
    draft: CharacterDraftV2,
    options: { keepBackup?: boolean; draftRevision?: string } = {}
  ): Promise<void> {
    const originalIndex = cloneIndex(index);
    const previousEntry = this.entry(index, characterId);
    const nextEntry = indexEntry(
      characterId,
      draft.name,
      draft.thumbnailAssetId ?? null,
      { draftVersion: 2, compiledVersion: previousEntry.compiledVersion }
    );
    nextEntry.draftRevision = options.draftRevision ?? previousEntry.draftRevision;
    const transaction: DraftTransaction = {
      version: 1,
      phase: 'prepared',
      keepBackup: options.keepBackup ?? false,
      previousEntry: structuredClone(previousEntry),
      nextEntry
    };

    try {
      await this.safeWriteText(this.draftNextFile(characterId), json(draft));
      await this.removePath(this.draftBackupFile(characterId), { force: true });
      await this.writeDraftMarker(characterId, transaction);
      await this.renamePath(this.draftFile(characterId), this.draftBackupFile(characterId));
      await this.renamePath(this.draftNextFile(characterId), this.draftFile(characterId));
      transaction.phase = 'installed';
      await this.writeDraftMarker(characterId, transaction);
      await this.commitIndexUpdate(index, nextIndex => {
        this.replaceEntry(nextIndex, nextEntry);
      });
    } catch (error) {
      await this.rollbackDraftTransaction(characterId, originalIndex).catch(() => undefined);
      throw error;
    }
    await this.cleanupDraftTransaction(characterId, transaction.keepBackup);
  }

  private async ensureDraftV2(
    characterId: string,
    index: CharacterIndex
  ): Promise<CharacterDraftV2> {
    const migrated = await this.readDraftMigration(
      this.draftFile(characterId),
      characterId,
      true
    );
    if (migrated.sourceVersion === 2) return migrated.document;
    await this.installDraftTransaction(characterId, index, migrated.document, {
      keepBackup: true
    });
    return migrated.document;
  }

  /** 复用发布事务安装 V2 清单及原资源字节，不复制 source 目录。 */
  private async installPublishedTransaction(
    characterId: string,
    index: CharacterIndex,
    manifest: CharacterManifestV2,
    assets: Readonly<Record<string, Uint8Array>>,
    options: { keepBackup?: boolean; expectedDraftRevision?: string } = {}
  ): Promise<void> {
    const originalIndex = cloneIndex(index);
    const previousEntry = structuredClone(this.entry(index, characterId));
    const nextEntry = indexEntry(characterId, manifest.name, manifest.thumbnailAssetId, {
      draftVersion: previousEntry.draftVersion ?? 2,
      compiledVersion: 2
    });
    nextEntry.draftRevision = previousEntry.draftRevision;
    const transaction: PublishTransaction = {
      version: 2,
      phase: 'prepared',
      hadPreviousRuntime: await exists(join(this.compiledDirectory(characterId), 'manifest.json')),
      keepBackup: options.keepBackup ?? false,
      previousEntry,
      nextEntry
    };

    try {
      await this.removePath(this.compiledNextDirectory(characterId), {
        recursive: true,
        force: true
      });
      await mkdir(this.compiledNextDirectory(characterId), { recursive: false });
      for (const resource of manifest.resources) {
        await durableWrite(
          join(this.compiledNextDirectory(characterId), resource.fileName),
          assets[resource.fileName]!.slice()
        );
      }
      await this.safeWriteText(
        join(this.compiledNextDirectory(characterId), 'manifest.json'),
        json(manifest)
      );
      await this.readPublishedFrom(this.compiledNextDirectory(characterId), characterId);
      if (options.expectedDraftRevision !== undefined) {
        this.assertDraftRevision(characterId, index, options.expectedDraftRevision);
      }
      await this.removePath(this.compiledBackupDirectory(characterId), {
        recursive: true,
        force: true
      });
      await this.writePublishMarker(characterId, transaction);
      if (options.expectedDraftRevision !== undefined) {
        this.assertDraftRevision(characterId, index, options.expectedDraftRevision);
      }
      await this.renamePath(
        this.compiledDirectory(characterId),
        this.compiledBackupDirectory(characterId)
      );
      transaction.phase = 'old-moved';
      await this.writePublishMarker(characterId, transaction);
      if (options.expectedDraftRevision !== undefined) {
        this.assertDraftRevision(characterId, index, options.expectedDraftRevision);
      }
      await this.renamePath(
        this.compiledNextDirectory(characterId),
        this.compiledDirectory(characterId)
      );
      transaction.phase = 'installed';
      await this.writePublishMarker(characterId, transaction);
      if (options.expectedDraftRevision !== undefined) {
        this.assertDraftRevision(characterId, index, options.expectedDraftRevision);
      }
      await this.commitIndexUpdate(index, nextIndex => {
        this.replaceEntry(nextIndex, nextEntry);
        delete nextIndex.incompleteActivationConfirmations[characterId];
      });
      if (options.expectedDraftRevision !== undefined) {
        this.assertDraftRevision(characterId, index, options.expectedDraftRevision);
      }
    } catch (error) {
      await this.rollbackPublishTransaction(characterId, originalIndex).catch(() => undefined);
      throw error;
    }
    await this.cleanupPublishTransaction(characterId, transaction.keepBackup);
  }

  private async ensurePublishedV2(
    characterId: string,
    index: CharacterIndex
  ): Promise<CharacterManifestV2> {
    const migrated = await this.readPublishedFrom(
      this.compiledDirectory(characterId),
      characterId
    );
    if (migrated.sourceVersion === 2) return migrated.document;
    await this.installPublishedTransaction(
      characterId,
      index,
      migrated.document,
      migrated.assets,
      { keepBackup: true }
    );
    return migrated.document;
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
        const current = await this.readDraftMigration(currentFile, characterId);
        try {
          const backup = await this.readDraftMigration(backupFile, characterId);
          if (!(current.sourceVersion === 2 && backup.sourceVersion === 1)) {
            await this.removePath(backupFile, { force: true });
          }
        } catch {
          // 无 marker 的 backup 只是可选恢复点，损坏时不得阻断有效 current。
        }
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
        await this.commitIndexUpdate(index, nextIndex => {
          this.replaceEntry(nextIndex, transaction.nextEntry);
        });
        await this.cleanupDraftTransaction(characterId, transaction.keepBackup);
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
    await this.commitIndexUpdate(index, nextIndex => {
      this.replaceEntry(nextIndex, transaction.previousEntry);
    });
    await this.cleanupDraftTransaction(characterId);
  }

  private async rollbackDraftTransaction(
    characterId: string,
    originalIndex: CharacterIndex
  ): Promise<void> {
    const hasMarker = await exists(this.draftMarkerFile(characterId));
    if (hasMarker) {
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
    await this.cleanupDraftTransaction(characterId, !hasMarker);
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

  private async cleanupDraftTransaction(
    characterId: string,
    keepBackup = false
  ): Promise<void> {
    await this.removePath(this.draftNextFile(characterId), { force: true });
    if (!keepBackup) {
      await this.removePath(this.draftBackupFile(characterId), { force: true });
    }
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
        let current: Awaited<ReturnType<CharacterStore['readPublishedFrom']>>;
        try {
          current = await this.readPublishedFrom(compiled, characterId);
        } catch {
          throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
        }

        let preserveBackup = false;
        try {
          const backupManifest = await this.readPublishedFrom(backup, characterId);
          preserveBackup = current.sourceVersion === 2 && backupManifest.sourceVersion === 1;
        } catch {
          // 无 marker 的 backup 只是可选恢复点，损坏时不得阻断有效 current。
          preserveBackup = true;
        }

        if (current.sourceVersion === 2) {
          const manifest = current.document;
          if (!(
            previousEntry.compiledVersion === 2
            && entryMatchesManifest(previousEntry, manifest)
          )) {
            await this.commitIndexUpdate(index, nextIndex => {
              this.replaceEntry(nextIndex, indexEntry(
                characterId,
                manifest.name,
                manifest.thumbnailAssetId,
                { draftVersion: previousEntry.draftVersion ?? 2, compiledVersion: 2 }
              ));
              delete nextIndex.incompleteActivationConfirmations[characterId];
            });
          }
        }

        if (!preserveBackup) {
          try {
            await this.removePath(backup, { recursive: true, force: true });
          } catch {
            // 已提交版本保持生效，固定 backup 留待下次启动继续清理。
          }
        }
      }
      await this.removePath(next, { recursive: true, force: true });
      return;
    }

    const transaction = await this.readTransaction(markerFile, publishTransactionSchema);
    if (transaction.phase === 'installed') {
      let currentIsValid = false;
      try {
        const manifest = await this.readPublishedFrom(compiled, characterId);
        currentIsValid = entryMatchesManifest(transaction.nextEntry, manifest.document);
      } catch {
        currentIsValid = false;
      }
      if (currentIsValid) {
        await this.commitIndexUpdate(index, nextIndex => {
          this.replaceEntry(nextIndex, transaction.nextEntry);
          delete nextIndex.incompleteActivationConfirmations[characterId];
        });
        await this.cleanupPublishTransaction(characterId, transaction.keepBackup);
        return;
      }
      // installed 的 current 缺失或无效时，只能回滚到已验证 backup。
    }

    if (await exists(backup)) {
      await this.restoreCompiledBackup(characterId, transaction);
    } else if (!transaction.hadPreviousRuntime) {
      await mkdir(compiled, { recursive: true });
    } else {
      const manifest = await this.readRuntimeFrom(compiled, characterId);
      if (!entryMatchesManifest(transaction.previousEntry, manifest)) {
        throw characterError('CHARACTER_TRANSACTION_INVALID');
      }
    }
    await this.commitIndexUpdate(index, nextIndex => {
      this.replaceEntry(nextIndex, transaction.previousEntry);
    });
    await this.cleanupPublishTransaction(characterId);
  }

  private async rollbackPublishTransaction(
    characterId: string,
    originalIndex: CharacterIndex
  ): Promise<void> {
    const hasMarker = await exists(this.publishMarkerFile(characterId));
    if (hasMarker) {
      const transaction = await this.readTransaction(
        this.publishMarkerFile(characterId),
        publishTransactionSchema
      );
      if (await exists(this.compiledBackupDirectory(characterId))) {
        await this.restoreCompiledBackup(characterId, transaction);
      } else if (!transaction.hadPreviousRuntime) {
        await mkdir(this.compiledDirectory(characterId), { recursive: true });
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
    await this.cleanupPublishTransaction(characterId, !hasMarker);
  }

  private async restoreCompiledBackup(
    characterId: string,
    transaction: PublishTransaction
  ): Promise<void> {
    const backup = this.compiledBackupDirectory(characterId);
    if (transaction.hadPreviousRuntime) {
      const manifest = await this.readRuntimeFrom(backup, characterId);
      if (!entryMatchesManifest(transaction.previousEntry, manifest)) {
        throw characterError('CHARACTER_TRANSACTION_INVALID');
      }
    }
    transaction.phase = 'rolling-back';
    await this.writePublishMarker(characterId, transaction);
    await this.removePath(this.compiledDirectory(characterId), {
      recursive: true,
      force: true
    });
    await this.renamePath(backup, this.compiledDirectory(characterId));
  }

  private async cleanupPublishTransaction(
    characterId: string,
    keepBackup = false
  ): Promise<void> {
    await this.removePath(this.compiledNextDirectory(characterId), {
      recursive: true,
      force: true
    });
    if (!keepBackup) {
      await this.removePath(this.compiledBackupDirectory(characterId), {
        recursive: true,
        force: true
      });
    }
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

  private async readTransaction<TSchema extends z.ZodTypeAny>(
    file: string,
    schema: TSchema
  ): Promise<z.output<TSchema>> {
    try {
      return schema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      throw characterError('CHARACTER_TRANSACTION_INVALID');
    }
  }

  private async readDraftFrom(
    file: string,
    characterId: string
  ): Promise<CharacterDraftV2> {
    return (await this.readDraftMigration(file, characterId)).document;
  }

  private async readDraftMigration(
    file: string,
    characterId: string,
    preserveCorrupt = false
  ): Promise<ReturnType<typeof migrateCharacterDocument>> {
    await this.assertSafePath(file);
    let source = '';
    try {
      source = await readFile(file, 'utf8');
      const migrated = migrateCharacterDocument(JSON.parse(source));
      if (migrated.document.id !== characterId) {
        throw characterError('CHARACTER_ID_MISMATCH');
      }
      return migrated;
    } catch (error) {
      if (preserveCorrupt && source) {
        await this.preserveCorruptText(file, source);
      }
      if (
        preserveCorrupt
        && error instanceof Error
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

  private parseManifest(raw: unknown): CharacterManifestV2 {
    const parsed = characterManifestV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw characterError('CHARACTER_MANIFEST_INVALID');
    }
    return parsed.data;
  }

  private validateAssets(
    manifest: CharacterManifestV2,
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

  private async readRuntimeFrom(
    directory: string,
    characterId: string
  ): Promise<CharacterManifestV1> {
    const migrated = await this.readPublishedFrom(directory, characterId);
    return projectCharacterManifestV2ToLegacy(migrated.document);
  }

  private async readPublishedFrom(
    directory: string,
    characterId: string
  ): Promise<ReturnType<typeof migrateCharacterManifest> & {
    assets: Readonly<Record<string, Uint8Array>>;
  }> {
    await this.assertSafePath(directory);
    const directoryIdentity = await this.captureRuntimeIdentity(directory, 'directory');
    const manifestFile = join(directory, 'manifest.json');
    const manifestBytes = await this.readStableRuntimeFile(
      manifestFile,
      directory,
      directoryIdentity,
      'runtime:manifest-after-open'
    );
    let migrated: ReturnType<typeof migrateCharacterManifest>;
    try {
      migrated = migrateCharacterManifest(JSON.parse(manifestBytes.toString('utf8')));
    } catch (error) {
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
    if (migrated.document.id !== characterId) {
      throw characterError('CHARACTER_RUNTIME_UNAVAILABLE');
    }
    const assets: Record<string, Uint8Array> = {};
    for (const resource of migrated.document.resources) {
      const resourceFile = join(directory, resource.fileName);
      assets[resource.fileName] = new Uint8Array(await this.readStableRuntimeFile(
        resourceFile,
        directory,
        directoryIdentity,
        'runtime:resource-after-open'
      ));
    }
    this.validateAssets(migrated.document, assets);
    return { ...migrated, assets };
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
    const migrated = migrateCharacterManifest(JSON.parse(manifestBytes.toString('utf8')));
    const manifest = migrated.document;
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
    index: CharacterIndex
  ): Promise<CharacterSummary> {
    const base = () => ({
      id: entry.id,
      name: entry.name,
      thumbnailAssetId: entry.thumbnailAssetId,
      active: index.activeCharacterId === entry.id
    });
    const compiledManifest = join(this.compiledDirectory(entry.id), 'manifest.json');
    if (await exists(compiledManifest)) {
      try {
        const manifest = await this.ensurePublishedV2(entry.id, index);
        const missing = characterV2Completeness(manifest);
        delete this.entry(index, entry.id).migrationErrorCode;
        return {
          ...base(),
          completeness: missing.length === 0 ? 'complete' : 'incomplete',
          missingRequirements: missing,
          migrationRecoveryAvailable: false,
          activationConfirmationRequired: (
            missing.length > 0
            && index.incompleteActivationConfirmations[entry.id]
              !== activationFingerprint(manifest)
          )
        };
      } catch (error) {
        const migrationFailed = error instanceof Error && (
          error.message === 'CHARACTER_MIGRATION_FAILED'
          || error.message === 'CHARACTER_VERSION_UNSUPPORTED'
        );
        if (migrationFailed) {
          this.entry(index, entry.id).migrationErrorCode = 'CHARACTER_MIGRATION_FAILED';
        }
        return {
          ...base(),
          completeness: 'broken',
          missingRequirements: [],
          ...(migrationFailed
            ? { migrationErrorCode: 'CHARACTER_MIGRATION_FAILED' as const }
            : {}),
          migrationRecoveryAvailable: migrationFailed,
          activationConfirmationRequired: false
        };
      }
    }

    try {
      const draft = await this.ensureDraftV2(entry.id, index);
      delete this.entry(index, entry.id).migrationErrorCode;
      return {
        ...base(),
        completeness: 'incomplete',
        missingRequirements: characterV2Completeness(draft),
        migrationRecoveryAvailable: false,
        activationConfirmationRequired: true
      };
    } catch (error) {
      const migrationFailed = error instanceof Error && (
        error.message === 'CHARACTER_MIGRATION_FAILED'
        || error.message === 'CHARACTER_VERSION_UNSUPPORTED'
      );
      if (migrationFailed) {
        this.entry(index, entry.id).migrationErrorCode = 'CHARACTER_MIGRATION_FAILED';
      }
      return {
        ...base(),
        completeness: 'broken',
        missingRequirements: [],
        ...(migrationFailed
          ? { migrationErrorCode: 'CHARACTER_MIGRATION_FAILED' as const }
          : {}),
        migrationRecoveryAvailable: migrationFailed,
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

  private packageImportOwnerFile(characterId: string): string {
    return join(this.characterDirectory(characterId), PACKAGE_IMPORT_OWNER);
  }

  private deleteTombstone(characterId: string): string {
    return join(this.directory, `${characterId}${DELETE_TOMBSTONE_SUFFIX}`);
  }
}
