import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
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
const RESOURCE_ROOT = fileURLToPath(new URL('../resources/local-model', import.meta.url));

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
  const partial = `${target}.partial`;
  await mkdir(modelRoot, { recursive: true });
  if (await isOrdinaryFile(target)) {
    const existing = await createManifestEntry(target, `payload/model/${MODEL.fileName}`);
    if (existing.size !== MODEL.size || existing.sha256 !== MODEL.sha256) {
      throw new Error('EXISTING_MODEL_MISMATCH');
    }
    return existing;
  }

  await rm(partial, { force: true });
  try {
    const response = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!response.ok || response.body === null) throw new Error('MODEL_DOWNLOAD_FAILED');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    const entry = await createManifestEntry(partial, `payload/model/${MODEL.fileName}`);
    if (entry.size !== MODEL.size || entry.sha256 !== MODEL.sha256) {
      throw new Error('MODEL_DOWNLOAD_MISMATCH');
    }
    await rename(partial, target);
    return entry;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
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

/** 完整 staging 根已通过 verifier 后才切换；第二次 rename 失败会把旧根恢复。 */
export async function replaceStagedResourceRoot(currentRoot, stagedRoot, renamePath = rename) {
  const backupRoot = `${currentRoot}.previous-${process.pid}`;
  if (await pathExists(backupRoot)) throw new Error('STAGE_BACKUP_ALREADY_EXISTS');
  await renamePath(currentRoot, backupRoot);
  try {
    await renamePath(stagedRoot, currentRoot);
  } catch (error) {
    await renamePath(backupRoot, currentRoot);
    throw error;
  }
  await rm(backupRoot, { recursive: true, force: true });
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
