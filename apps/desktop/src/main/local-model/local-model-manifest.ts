import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';

type ManifestReasonCode = NonNullable<LocalModelPublicStatus['reasonCode']>;

export interface LocalModelManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface LocalModelManifestBackend {
  executable: string;
  files: LocalModelManifestFile[];
}

export interface LocalModelManifestDocument {
  schemaVersion: number;
  platform: string;
  arch: string;
  runtime: {
    revision: string;
    license: LocalModelManifestFile;
    backends: {
      cpu: LocalModelManifestBackend;
      vulkan: LocalModelManifestBackend;
    };
  };
  model: {
    id: string;
    sourceRepository: string;
    sourceRevision: string;
    quantizationRepository: string;
    quantizationRevision: string;
    file: LocalModelManifestFile;
    license: LocalModelManifestFile;
  };
}

export interface LocalModelReleasePolicy {
  schemaVersion: 1;
  platform: 'win32';
  arch: 'x64';
  runtimeRevision: string;
  model: {
    id: 'ai-pet-local';
    sourceRepository: string;
    sourceRevision: string;
    quantizationRepository: string;
    quantizationRevision: string;
    fileName: string;
    size: number;
    sha256: string;
  };
}

export interface ValidatedLocalModelManifest {
  root: string;
  modelId: string;
  modelPath: string;
  backends: {
    cpu: { executablePath: string; workingDirectory: string };
    vulkan: { executablePath: string; workingDirectory: string };
  };
}

interface ModelHashCache {
  applicationVersion: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  sha256: string;
}

export interface ValidateLocalModelManifestOptions {
  root: string;
  applicationVersion: string;
  cachePath: string;
  releasePolicy?: LocalModelReleasePolicy;
  signal?: AbortSignal;
  hashFile?: LocalModelHashFile;
}

export type LocalModelHashFile = (path: string, signal: AbortSignal) => Promise<string>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: sha256Schema
}).strict();
const backendSchema = z.object({
  executable: z.string().min(1),
  files: z.array(manifestFileSchema).min(1)
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.number().int(),
  platform: z.string(),
  arch: z.string(),
  runtime: z.object({
    revision: z.string().min(1),
    license: manifestFileSchema,
    backends: z.object({ cpu: backendSchema, vulkan: backendSchema }).strict()
  }).strict(),
  model: z.object({
    id: z.string().min(1),
    sourceRepository: z.string().min(1),
    sourceRevision: z.string().min(1),
    quantizationRepository: z.string().min(1),
    quantizationRevision: z.string().min(1),
    file: manifestFileSchema,
    license: manifestFileSchema
  }).strict()
}).strict();

const cacheSchema = z.object({
  applicationVersion: z.string(),
  filePath: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  dev: z.number(),
  ino: z.number(),
  sha256: sha256Schema
}).strict();

export const BUILTIN_LOCAL_MODEL_RELEASE: LocalModelReleasePolicy = Object.freeze({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  runtimeRevision: 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9',
  model: Object.freeze({
    id: 'ai-pet-local',
    sourceRepository: 'Qwen/Qwen3.5-4B',
    sourceRevision: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
    quantizationRepository: 'unsloth/Qwen3.5-4B-GGUF',
    quantizationRevision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: 2_740_937_888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'
  })
});

export class LocalModelManifestError extends Error {
  constructor(readonly reasonCode: ManifestReasonCode) {
    super(reasonCode);
    this.name = 'LocalModelManifestError';
  }
}

/**
 * manifest 是安装资源的唯一入口；所有条目先约束为根内普通文件，再执行精确 allowlist 与哈希校验。
 * GGUF 缓存只优化重复完整哈希，不能替代安装包签名或固定发行身份。
 */
export async function validateLocalModelManifest(
  options: ValidateLocalModelManifestOptions
): Promise<ValidatedLocalModelManifest> {
  const policy = options.releasePolicy ?? BUILTIN_LOCAL_MODEL_RELEASE;
  const hashFile = options.hashFile ?? sha256File;
  const signal = options.signal ?? new AbortController().signal;
  let root: string;
  let manifest: LocalModelManifestDocument;
  try {
    throwIfAborted(signal);
    root = await realpath(options.root);
    throwIfAborted(signal);
    const manifestPath = resolve(root, 'manifest.json');
    const manifestStats = await stat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.size > 256 * 1024) {
      throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    }
    manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    throwIfAborted(signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof LocalModelManifestError) throw error;
    if (isMissingFileError(error)) throw new LocalModelManifestError('RESOURCE_MISSING');
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }

  assertReleaseIdentity(manifest, policy);
  const entries = collectEntries(manifest);
  const resolvedEntries = new Map<string, string>();
  for (const entry of entries) {
    throwIfAborted(signal);
    if (resolvedEntries.has(entry.path)) throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    resolvedEntries.set(entry.path, await resolveManifestFile(root, entry.path));
  }
  assertExecutableListed(manifest.runtime.backends.cpu);
  assertExecutableListed(manifest.runtime.backends.vulkan);
  await assertExactAllowlist(root, new Set(['manifest.json', ...resolvedEntries.keys()]), signal);

  for (const entry of entries) {
    throwIfAborted(signal);
    const file = resolvedEntries.get(entry.path);
    if (file === undefined) throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    const fileStats = await stat(file);
    if (fileStats.size !== entry.size) throw new LocalModelManifestError('RESOURCE_HASH_MISMATCH');
    if (entry === manifest.model.file) {
      await verifyModelHash(options, file, entry, fileStats, hashFile, signal);
    } else if (await hashFile(file, signal) !== entry.sha256) {
      throw new LocalModelManifestError('RESOURCE_HASH_MISMATCH');
    }
  }

  const cpuExecutable = resolvedEntries.get(manifest.runtime.backends.cpu.executable);
  const vulkanExecutable = resolvedEntries.get(manifest.runtime.backends.vulkan.executable);
  const modelPath = resolvedEntries.get(manifest.model.file.path);
  if (cpuExecutable === undefined || vulkanExecutable === undefined || modelPath === undefined) {
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
  return Object.freeze({
    root,
    modelId: manifest.model.id,
    modelPath,
    backends: Object.freeze({
      cpu: Object.freeze({ executablePath: cpuExecutable, workingDirectory: dirname(cpuExecutable) }),
      vulkan: Object.freeze({ executablePath: vulkanExecutable, workingDirectory: dirname(vulkanExecutable) })
    })
  });
}

function assertReleaseIdentity(
  manifest: LocalModelManifestDocument,
  policy: LocalModelReleasePolicy
): void {
  if (
    manifest.schemaVersion !== policy.schemaVersion
    || manifest.platform !== policy.platform
    || manifest.arch !== policy.arch
    || process.platform !== policy.platform
    || process.arch !== policy.arch
    || manifest.runtime.revision !== policy.runtimeRevision
    || manifest.model.id !== policy.model.id
    || manifest.model.sourceRepository !== policy.model.sourceRepository
    || manifest.model.sourceRevision !== policy.model.sourceRevision
    || manifest.model.quantizationRepository !== policy.model.quantizationRepository
    || manifest.model.quantizationRevision !== policy.model.quantizationRevision
  ) {
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
  if (
    manifest.model.file.path.split('/').at(-1) !== policy.model.fileName
    || manifest.model.file.size !== policy.model.size
    || manifest.model.file.sha256 !== policy.model.sha256
  ) {
    throw new LocalModelManifestError('RESOURCE_HASH_MISMATCH');
  }
}

function collectEntries(manifest: LocalModelManifestDocument): LocalModelManifestFile[] {
  return [
    manifest.runtime.license,
    ...manifest.runtime.backends.cpu.files,
    ...manifest.runtime.backends.vulkan.files,
    manifest.model.file,
    manifest.model.license
  ];
}

function assertExecutableListed(backend: LocalModelManifestBackend): void {
  if (!backend.files.some(file => file.path === backend.executable)) {
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
}

async function resolveManifestFile(root: string, manifestPath: string): Promise<string> {
  if (
    manifestPath.includes('\\')
    || manifestPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    || isAbsolute(manifestPath)
  ) {
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
  const candidate = resolve(root, ...manifestPath.split('/'));
  assertWithinRoot(root, candidate);
  try {
    const linkStats = await lstat(candidate);
    if (!linkStats.isFile() || linkStats.isSymbolicLink()) {
      throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    }
    const realCandidate = await realpath(candidate);
    assertWithinRoot(root, realCandidate);
    return realCandidate;
  } catch (error) {
    if (error instanceof LocalModelManifestError) throw error;
    if (isMissingFileError(error)) throw new LocalModelManifestError('RESOURCE_MISSING');
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
}

function assertWithinRoot(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))) {
    return;
  }
  throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
}

async function assertExactAllowlist(
  root: string,
  allowlist: ReadonlySet<string>,
  signal: AbortSignal
): Promise<void> {
  const actual = new Set<string>();
  await walkFiles(root, '', actual, signal);
  if (actual.size !== allowlist.size || [...actual].some(path => !allowlist.has(path))) {
    throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
  }
}

async function walkFiles(
  root: string,
  relativeDirectory: string,
  result: Set<string>,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const directory = relativeDirectory === '' ? root : resolve(root, ...relativeDirectory.split('/'));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    if (entry.isDirectory()) {
      await walkFiles(root, relativePath, result, signal);
    } else if (entry.isFile()) {
      result.add(relativePath);
    } else {
      throw new LocalModelManifestError('RUNTIME_INCOMPATIBLE');
    }
  }
}

async function verifyModelHash(
  options: ValidateLocalModelManifestOptions,
  file: string,
  entry: LocalModelManifestFile,
  fileStats: Stats,
  hashFile: LocalModelHashFile,
  signal: AbortSignal
): Promise<void> {
  const expectedCache: ModelHashCache = {
    applicationVersion: options.applicationVersion,
    filePath: file,
    size: fileStats.size,
    mtimeMs: fileStats.mtimeMs,
    ctimeMs: fileStats.ctimeMs,
    dev: fileStats.dev,
    ino: fileStats.ino,
    sha256: entry.sha256
  };
  const cached = await readModelCache(options.cachePath, signal);
  if (cached !== undefined && cacheMatches(cached, expectedCache)) return;
  if (await hashFile(file, signal) !== entry.sha256) throw new LocalModelManifestError('RESOURCE_HASH_MISMATCH');
  throwIfAborted(signal);
  await writeModelCache(options.cachePath, expectedCache, signal);
}

async function readModelCache(path: string, signal: AbortSignal): Promise<ModelHashCache | undefined> {
  try {
    throwIfAborted(signal);
    const source = await readFile(path, 'utf8');
    throwIfAborted(signal);
    return cacheSchema.parse(JSON.parse(source));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function cacheMatches(left: ModelHashCache, right: ModelHashCache): boolean {
  return Object.keys(right).every(key => left[key as keyof ModelHashCache] === right[key as keyof ModelHashCache]);
}

async function writeModelCache(path: string, cache: ModelHashCache, signal: AbortSignal): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    throwIfAborted(signal);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
    throwIfAborted(signal);
    await rename(temporaryPath, path);
  } catch (error) {
    // 缓存失败不能改变已经完成的资源校验事实。
    await unlink(temporaryPath).catch(() => undefined);
    if (isAbortError(error)) throw error;
  }
}

/** 大型 GGUF 只做流式哈希；取消会主动销毁文件流，避免继续读取 2.55 GiB payload。 */
function sha256File(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolveHash(hash.digest('hex'));
      else reject(error);
    };
    const onAbort = (): void => {
      const error = createAbortError();
      stream.destroy(error);
      finish(error);
    };
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', finish);
    stream.once('end', () => finish());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'AbortError';
}

function createAbortError(): Error {
  return new DOMException('操作已取消', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}
