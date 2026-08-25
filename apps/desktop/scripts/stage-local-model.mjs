import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import {
  BUILTIN_LOCAL_MODEL_ASSET_POLICY,
  verifyLocalModelAssets
} from './verify-local-model-assets.mjs';

const LLAMA_REPOSITORY = 'https://github.com/ggml-org/llama.cpp.git';
const LLAMA_COMMIT = BUILTIN_LOCAL_MODEL_ASSET_POLICY.runtimeRevision;
const MODEL = BUILTIN_LOCAL_MODEL_ASSET_POLICY.model;
const MODEL_URL = `https://huggingface.co/${MODEL.quantizationRepository}/resolve/${MODEL.quantizationRevision}/${MODEL.fileName}?download=true`;
const MODEL_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1_000;
const RESOURCE_ROOT = fileURLToPath(new URL('../resources/local-model', import.meta.url));
const STAGE_TRANSACTION_LOCK_NAME = 'local-model.stage.lock';

/** 维护者暂存入口没有 URL、revision 或输出目录参数，所有发行身份都来自仓库固定常量。 */
async function stageLocalModel() {
  const workRoot = await mkdtemp(join(tmpdir(), 'ai-pet-local-model-stage-'));
  const stagedResourceRoot = `${RESOURCE_ROOT}.partial-${process.pid}`;
  try {
    await rm(stagedResourceRoot, { recursive: true, force: true });
    await copyFixedMetadata(RESOURCE_ROOT, stagedResourceRoot);
    const sourceRoot = join(workRoot, 'llama.cpp');
    await checkoutFixedLlamaSource(sourceRoot);
    const backends = {
      cpu: await buildAndStageBackend(sourceRoot, workRoot, stagedResourceRoot, 'cpu', false),
      vulkan: await buildAndStageBackend(sourceRoot, workRoot, stagedResourceRoot, 'vulkan', true)
    };
    const modelEntry = await stageFixedModel(stagedResourceRoot);
    await writeStagedManifest(stagedResourceRoot, backends, modelEntry);
    await verifyLocalModelAssets(stagedResourceRoot);
    await replaceStagedResourceRoot(RESOURCE_ROOT, stagedResourceRoot);
    console.log('固定本地模型资源暂存并校验通过。');
  } finally {
    // 临时源码和构建树不属于发行物；固定根由 mkdtemp 创建，清理不会触及仓库资源。
    await Promise.all([
      rm(workRoot, { recursive: true, force: true }),
      rm(stagedResourceRoot, { recursive: true, force: true })
    ]);
  }
}

async function copyFixedMetadata(currentRoot, stagedRoot) {
  const relativePaths = [
    'manifest.json',
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.notices.path,
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.runtimeLicense.path,
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.modelLicense.path
  ];
  for (const relativePath of relativePaths) {
    const target = join(stagedRoot, ...relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(currentRoot, ...relativePath.split('/')), target);
  }
}

async function checkoutFixedLlamaSource(sourceRoot) {
  await mkdir(sourceRoot, { recursive: true });
  await run('git', ['init', '--quiet'], sourceRoot);
  await run('git', ['remote', 'add', 'origin', LLAMA_REPOSITORY], sourceRoot);
  await run('git', ['fetch', '--depth', '1', 'origin', LLAMA_COMMIT], sourceRoot);
  await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], sourceRoot);
  const actualCommit = (await capture('git', ['rev-parse', 'HEAD'], sourceRoot)).trim();
  if (actualCommit !== LLAMA_COMMIT) throw new Error('LLAMA_REVISION_MISMATCH');
}

async function buildAndStageBackend(sourceRoot, workRoot, stagedResourceRoot, backend, enableVulkan) {
  const buildRoot = join(workRoot, `build-${backend}`);
  const cmakeArguments = [
    '-S', sourceRoot,
    '-B', buildRoot,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=ON',
    '-DGGML_NATIVE=OFF',
    '-DGGML_RPC=OFF',
    '-DGGML_OPENMP=OFF',
    `-DGGML_VULKAN=${enableVulkan ? 'ON' : 'OFF'}`,
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_APP=OFF',
    '-DLLAMA_BUILD_TOOLS=ON',
    '-DLLAMA_BUILD_SERVER=ON',
    '-DLLAMA_BUILD_UI=OFF',
    '-DLLAMA_USE_PREBUILT_UI=OFF',
    '-DLLAMA_TOOLS_INSTALL=OFF',
    '-DLLAMA_TESTS_INSTALL=OFF',
    '-DLLAMA_OPENSSL=OFF',
    '-DLLAMA_SUBPROCESS=OFF'
  ];
  await run('cmake', cmakeArguments, workRoot);
  await run('cmake', ['--build', buildRoot, '--config', 'Release', '--target', 'llama-server'], workRoot);

  const serverCandidates = await findNamedFiles(buildRoot, 'llama-server.exe');
  if (serverCandidates.length !== 1) throw new Error('LLAMA_SERVER_OUTPUT_INVALID');
  const outputDirectory = dirname(serverCandidates[0]);
  const outputFiles = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (entry.name === 'llama-server.exe' || entry.name.toLowerCase().endsWith('.dll')))
    .map(entry => join(outputDirectory, entry.name));
  if (!outputFiles.some(path => basename(path) === 'llama-server.exe')) {
    throw new Error('LLAMA_SERVER_OUTPUT_MISSING');
  }

  const targetRoot = join(stagedResourceRoot, 'payload', 'runtime', backend);
  await mkdir(targetRoot, { recursive: true });
  for (const source of outputFiles) await copyFile(source, join(targetRoot, basename(source)));
  return Promise.all(outputFiles
    .map(path => basename(path))
    .sort((left, right) => left.localeCompare(right))
    .map(name => createManifestEntry(join(targetRoot, name), `payload/runtime/${backend}/${name}`)));
}

async function stageFixedModel(stagedResourceRoot) {
  const modelRoot = join(stagedResourceRoot, 'payload', 'model');
  const target = join(modelRoot, MODEL.fileName);
  await mkdir(modelRoot, { recursive: true });
  if (await isOrdinaryFile(target)) {
    const existing = await createManifestEntry(target, `payload/model/${MODEL.fileName}`);
    if (existing.size !== MODEL.size || existing.sha256 !== MODEL.sha256) {
      throw new Error('EXISTING_MODEL_MISMATCH');
    }
    return existing;
  }

  return downloadFixedModelFile({
    url: MODEL_URL,
    target,
    relativePath: `payload/model/${MODEL.fileName}`,
    expectedSize: MODEL.size,
    expectedSha256: MODEL.sha256,
    timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS,
    fetchImpl: fetch
  });
}

/** 下载过程中同时计数与哈希；超时、外部取消或首个超限块都会销毁流并清理 partial。 */
export async function downloadFixedModelFile(options) {
  const partial = `${options.target}.partial`;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    options.signal?.reason ?? new DOMException('操作已取消', 'AbortError')
  );
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('MODEL_DOWNLOAD_TIMEOUT')),
    options.timeoutMs
  );
  timeout.unref?.();

  await mkdir(dirname(options.target), { recursive: true });
  await rm(partial, { force: true });
  let byteCount = 0;
  const hash = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.byteLength;
      if (byteCount > options.expectedSize) {
        callback(new Error('MODEL_DOWNLOAD_OVERSIZE'));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    }
  });

  try {
    const response = await options.fetchImpl(options.url, {
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok || response.body === null) throw new Error('MODEL_DOWNLOAD_FAILED');
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(partial, { flags: 'wx' }),
      { signal: controller.signal }
    );
    const sha256 = hash.digest('hex');
    if (byteCount !== options.expectedSize || sha256 !== options.expectedSha256) {
      throw new Error('MODEL_DOWNLOAD_MISMATCH');
    }
    await rename(partial, options.target);
    return { path: options.relativePath, size: byteCount, sha256 };
  } catch (error) {
    await rm(partial, { force: true });
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function writeStagedManifest(stagedResourceRoot, backends, modelEntry) {
  const manifestPath = join(stagedResourceRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = BUILTIN_LOCAL_MODEL_ASSET_POLICY.schemaVersion;
  manifest.platform = BUILTIN_LOCAL_MODEL_ASSET_POLICY.platform;
  manifest.arch = BUILTIN_LOCAL_MODEL_ASSET_POLICY.arch;
  manifest.runtime.revision = BUILTIN_LOCAL_MODEL_ASSET_POLICY.runtimeRevision;
  manifest.model.id = MODEL.id;
  manifest.model.sourceRepository = MODEL.sourceRepository;
  manifest.model.sourceRevision = MODEL.sourceRevision;
  manifest.model.quantizationRepository = MODEL.quantizationRepository;
  manifest.model.quantizationRevision = MODEL.quantizationRevision;
  manifest.notices = await createManifestEntry(
    join(RESOURCE_ROOT, BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.notices.path),
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.notices.path
  );
  manifest.runtime.license = await createManifestEntry(
    join(RESOURCE_ROOT, BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.runtimeLicense.path),
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.runtimeLicense.path
  );
  manifest.model.license = await createManifestEntry(
    join(RESOURCE_ROOT, BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.modelLicense.path),
    BUILTIN_LOCAL_MODEL_ASSET_POLICY.documents.modelLicense.path
  );
  manifest.runtime.backends.cpu.files = backends.cpu;
  manifest.runtime.backends.vulkan.files = backends.vulkan;
  manifest.model.file = modelEntry;
  const partial = `${manifestPath}.partial`;
  await writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(partial, manifestPath);
}

/** 排他锁覆盖备份检查、commit/rollback 和提交后清理，确保固定 backup 始终只有一个事务所有。 */
export async function replaceStagedResourceRoot(currentRoot, stagedRoot, options = {}) {
  const current = resolve(currentRoot);
  const staged = resolve(stagedRoot);
  const expectedCurrent = resolve(options.expectedCurrentRoot ?? RESOURCE_ROOT);
  const parent = dirname(current);
  if (
    current !== expectedCurrent
    || basename(current) !== 'local-model'
    || dirname(staged) !== parent
    || !basename(staged).startsWith('local-model.partial')
  ) {
    throw new Error('STAGE_TRANSACTION_PATH_INVALID');
  }
  // 锁本身也是写入；必须先拒绝 resources 父目录 Junction，持锁后再复核以收窄检查窗口。
  await assertOrdinaryDirectory(parent);
  const backupRoot = join(parent, 'local-model.previous');
  const renamePath = options.renamePath ?? rename;
  const removePath = options.removePath ?? rm;
  const onWarning = options.onWarning ?? (code => console.warn(code));
  const transactionLock = await acquireStageTransactionLock(parent, options.lockOperations);
  let result;
  let transactionError;

  try {
    await assertOrdinaryDirectory(parent);
    await assertOrdinaryDirectory(current);
    await assertOrdinaryDirectory(staged);
    // 删除范围已收窄为同一父目录内的唯一固定备份名，且只有持锁事务可以检查或删除它。
    if (await pathExists(backupRoot)) {
      await assertOrdinaryDirectory(backupRoot);
      await removePath(backupRoot, { recursive: true, force: false });
      if (await pathExists(backupRoot)) throw new Error('STAGE_BACKUP_CLEANUP_FAILED');
    }
    await renamePath(current, backupRoot);
    try {
      // 第二次 rename 是 commit point；此前失败回滚，之后清理失败不能重解释资源切换结果。
      await renamePath(staged, current);
    } catch (error) {
      await renamePath(backupRoot, current);
      throw error;
    }
    try {
      await removePath(backupRoot, { recursive: true, force: false });
      if (await pathExists(backupRoot)) throw new Error('STAGE_BACKUP_CLEANUP_FAILED');
      result = { warningCode: null };
    } catch {
      const warningCode = 'STAGE_BACKUP_CLEANUP_PENDING';
      emitWarning(onWarning, warningCode);
      result = { warningCode };
    }
  } catch (error) {
    transactionError = error;
  }

  const lockWarning = await transactionLock.release();
  if (lockWarning !== null) {
    emitWarning(onWarning, lockWarning);
    if (result?.warningCode === null || result === undefined) result = { warningCode: lockWarning };
  }
  if (transactionError !== undefined) throw transactionError;
  return result;
}

/** 预制非空所有权目录后原子发布；锁存在即稳定 BUSY，不猜测进程存活性或自动删 stale 锁。 */
async function acquireStageTransactionLock(parent, operations = {}) {
  const lockRoot = join(parent, STAGE_TRANSACTION_LOCK_NAME);
  const token = randomUUID();
  const candidateRoot = join(parent, `${STAGE_TRANSACTION_LOCK_NAME}.candidate-${process.pid}-${token}`);
  const ownerFileName = `owner-${token}.json`;
  const candidateOwnerPath = join(candidateRoot, ownerFileName);
  const metadata = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token
  })}\n`;
  let candidateCreated = false;
  try {
    await mkdir(candidateRoot);
    candidateCreated = true;
    await (operations.writeOwner ?? writeStageLockOwner)(candidateOwnerPath, metadata);
  } catch (error) {
    if (candidateCreated) {
      await unlink(candidateOwnerPath).catch(() => {});
      await rmdir(candidateRoot).catch(() => {});
    }
    throw error;
  }

  try {
    // fixed lock 始终以非空目录出现；rename 是唯一发布点，只有此处的真实冲突才属于 BUSY。
    await (operations.publishCandidate ?? rename)(candidateRoot, lockRoot);
  } catch (error) {
    await unlink(candidateOwnerPath).catch(() => {});
    await rmdir(candidateRoot).catch(() => {});
    if (await isStageLockCollision(error, lockRoot)) {
      throw new Error('STAGE_TRANSACTION_BUSY');
    }
    throw error;
  }

  return {
    async release() {
      let warningCode = null;
      let ownerRemoved = false;
      try {
        await assertOrdinaryDirectory(lockRoot);
        const entries = await readdir(lockRoot);
        if (entries.length !== 1 || entries[0] !== ownerFileName) throw new Error('STAGE_LOCK_OWNER_MISMATCH');
        if (await readFile(join(lockRoot, ownerFileName), 'utf8') !== metadata) {
          throw new Error('STAGE_LOCK_OWNER_MISMATCH');
        }
        // 严格拒绝 Junction 且 owner 精确匹配后，才删除本事务随机命名的所有权文件。
        await unlink(join(lockRoot, ownerFileName));
        ownerRemoved = true;
      } catch {
        warningCode = 'STAGE_TRANSACTION_LOCK_CLEANUP_PENDING';
      }
      if (ownerRemoved) {
        try {
          await assertOrdinaryDirectory(lockRoot);
          if ((await readdir(lockRoot)).length !== 0) throw new Error('STAGE_LOCK_OWNER_MISMATCH');
          // 另一 owner 存在时非递归 rmdir 必然失败，绝不递归删除或清空他人活跃锁。
          await rmdir(lockRoot);
        } catch {
          warningCode = 'STAGE_TRANSACTION_LOCK_CLEANUP_PENDING';
        }
      }
      return warningCode;
    }
  };
}

async function writeStageLockOwner(path, metadata) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(metadata, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isStageLockCollision(error, lockRoot) {
  if (typeof error !== 'object' || error === null) return false;
  const code = String(Reflect.get(error, 'code'));
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
  if (code !== 'EPERM') return false;
  try {
    const metadata = await lstat(lockRoot);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function emitWarning(onWarning, warningCode) {
  try {
    onWarning(warningCode);
  } catch {
    // commit point 后观察端口失败不能把成功切换重新解释为失败。
  }
}

async function createManifestEntry(path, relativePath) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('STAGED_RESOURCE_NOT_FILE');
  return { path: relativePath, size: metadata.size, sha256: await sha256File(path) };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function isOrdinaryFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

async function assertOrdinaryDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('STAGE_TRANSACTION_PATH_INVALID');
  }
  if (resolve(await realpath(path)) !== resolve(path)) {
    throw new Error('STAGE_TRANSACTION_PATH_INVALID');
  }
}

async function findNamedFiles(root, fileName) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await findNamedFiles(path, fileName));
    else if (entry.isFile() && entry.name === fileName) matches.push(path);
  }
  return matches;
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolveRun();
      else reject(new Error(`STAGE_COMMAND_FAILED:${command}:${code ?? 'signal'}`));
    });
  });
}

function capture(command, args, cwd) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolveOutput(output);
      else reject(new Error(`STAGE_COMMAND_FAILED:${command}:${code ?? 'signal'}`));
    });
  });
}

const invokedAsScript = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  if (process.argv.length !== 2) throw new Error('STAGE_ARGUMENTS_NOT_ALLOWED');
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('STAGE_REQUIRES_WINDOWS_X64');
  }
  await stageLocalModel();
}
