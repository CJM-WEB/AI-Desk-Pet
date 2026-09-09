import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY } from '../src/main/local-model/local-model-release-identity.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BACKEND_NAMES = ['cpu', 'vulkan'];

export const BUILTIN_LOCAL_MODEL_ASSET_POLICY = BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY;

/**
 * 打包门禁只接受固定发行身份，并把 manifest 列表与磁盘普通文件做双向精确比对。
 * 测试可传入等形小 fixture 策略；命令行入口始终使用上面的生产策略。
 */
export async function verifyLocalModelAssets(
  resourceRoot,
  policy = BUILTIN_LOCAL_MODEL_ASSET_POLICY
) {
  const root = await realpath(resourceRoot).catch(() => fail('RESOURCE_ROOT_MISSING'));
  const manifestPath = resolve(root, 'manifest.json');
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8').catch(() => fail('MANIFEST_MISSING'))));
  assertReleaseIdentity(manifest, policy);
  assertBackend(manifest.runtime.backends.cpu, 'cpu');
  assertBackend(manifest.runtime.backends.vulkan, 'vulkan');

  const entries = [
    manifest.notices,
    manifest.runtime.license,
    ...manifest.runtime.backends.cpu.files,
    ...manifest.runtime.backends.vulkan.files,
    manifest.model.file,
    manifest.model.license
  ];
  const paths = new Set(['manifest.json']);
  for (const entry of entries) {
    if (paths.has(entry.path)) fail('DUPLICATE_PATH');
    paths.add(entry.path);
    const target = await resolveOrdinaryFile(root, entry.path);
    const metadata = await stat(target);
    if (metadata.size !== entry.size || await sha256File(target) !== entry.sha256) {
      fail('HASH_MISMATCH');
    }
  }

  const actual = new Set();
  await walkOrdinaryFiles(root, '', actual);
  if (actual.size !== paths.size || [...actual].some(path => !paths.has(path))) {
    fail('ALLOWLIST_MISMATCH');
  }
}

function parseManifest(value) {
  assertRecord(value, ['schemaVersion', 'platform', 'arch', 'notices', 'runtime', 'model']);
  const runtime = value.runtime;
  const model = value.model;
  assertRecord(runtime, ['revision', 'license', 'backends']);
  assertRecord(runtime.backends, BACKEND_NAMES);
  assertRecord(model, [
    'id',
    'sourceRepository',
    'sourceRevision',
    'quantizationRepository',
    'quantizationRevision',
    'file',
    'license'
  ]);
  return {
    schemaVersion: requireInteger(value.schemaVersion),
    platform: requireString(value.platform),
    arch: requireString(value.arch),
    notices: parseFile(value.notices),
    runtime: {
      revision: requireString(runtime.revision),
      license: parseFile(runtime.license),
      backends: {
        cpu: parseBackend(runtime.backends.cpu),
        vulkan: parseBackend(runtime.backends.vulkan)
      }
    },
    model: {
      id: requireString(model.id),
      sourceRepository: requireString(model.sourceRepository),
      sourceRevision: requireString(model.sourceRevision),
      quantizationRepository: requireString(model.quantizationRepository),
      quantizationRevision: requireString(model.quantizationRevision),
      file: parseFile(model.file),
      license: parseFile(model.license)
    }
  };
}

function parseBackend(value) {
  assertRecord(value, ['executable', 'files']);
  if (!Array.isArray(value.files)) fail('MANIFEST_INVALID');
  return {
    executable: requireString(value.executable),
    files: value.files.map(parseFile)
  };
}

function parseFile(value) {
  assertRecord(value, ['path', 'size', 'sha256']);
  const path = requireString(value.path);
  const size = requireInteger(value.size);
  const sha256 = requireString(value.sha256);
  if (size < 0 || !SHA256_PATTERN.test(sha256)) fail('MANIFEST_INVALID');
  return { path, size, sha256 };
}

function assertReleaseIdentity(manifest, policy) {
  if (
    manifest.schemaVersion !== policy.schemaVersion
    || manifest.platform !== policy.platform
    || manifest.arch !== policy.arch
    || manifest.runtime.revision !== policy.runtimeRevision
    || manifest.model.id !== policy.model.id
    || manifest.model.sourceRepository !== policy.model.sourceRepository
    || manifest.model.sourceRevision !== policy.model.sourceRevision
    || manifest.model.quantizationRepository !== policy.model.quantizationRepository
    || manifest.model.quantizationRevision !== policy.model.quantizationRevision
  ) {
    fail('RELEASE_IDENTITY_MISMATCH');
  }
  if (
    manifest.model.file.path !== `payload/model/${policy.model.fileName}`
    || manifest.model.file.size !== policy.model.size
    || manifest.model.file.sha256 !== policy.model.sha256
  ) {
    fail('MODEL_IDENTITY_MISMATCH');
  }
  assertDocumentIdentity(manifest.runtime.license, policy.documents.runtimeLicense);
  assertDocumentIdentity(manifest.model.license, policy.documents.modelLicense);
  assertDocumentIdentity(manifest.notices, policy.documents.notices);
}

function assertDocumentIdentity(entry, expected) {
  if (
    entry.path !== expected.path
    || entry.size !== expected.size
    || entry.sha256 !== expected.sha256
  ) fail('DOCUMENT_IDENTITY_MISMATCH');
}

function assertBackend(backend, name) {
  const prefix = `payload/runtime/${name}/`;
  const executable = `${prefix}llama-server.exe`;
  if (backend.executable !== executable || backend.files.length === 0) {
    fail('RUNTIME_ALLOWLIST_MISMATCH');
  }
  for (const entry of backend.files) {
    const lowerPath = entry.path.toLowerCase();
    if (
      !entry.path.startsWith(prefix)
      || (entry.path !== executable && !lowerPath.endsWith('.dll'))
      || lowerPath.includes('rpc')
    ) {
      fail('RUNTIME_ALLOWLIST_MISMATCH');
    }
  }
  if (!backend.files.some(entry => entry.path === executable)) {
    fail('RUNTIME_ALLOWLIST_MISMATCH');
  }
}

async function resolveOrdinaryFile(root, manifestPath) {
  if (
    isAbsolute(manifestPath)
    || manifestPath.includes('\\')
    || manifestPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('PATH_INVALID');
  }
  const candidate = resolve(root, ...manifestPath.split('/'));
  assertWithinRoot(root, candidate);
  const metadata = await lstat(candidate).catch(() => fail('RESOURCE_MISSING'));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('RESOURCE_NOT_ORDINARY');
  const actual = await realpath(candidate);
  assertWithinRoot(root, actual);
  return actual;
}

function assertWithinRoot(root, target) {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    fail('PATH_ESCAPES_ROOT');
  }
}

async function walkOrdinaryFiles(root, relativeDirectory, result) {
  const directory = relativeDirectory === '' ? root : resolve(root, ...relativeDirectory.split('/'));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) fail('RESOURCE_NOT_ORDINARY');
    if (entry.isDirectory()) await walkOrdinaryFiles(root, relativePath, result);
    else if (entry.isFile()) result.add(relativePath);
    else fail('RESOURCE_NOT_ORDINARY');
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function assertRecord(value, exactKeys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('MANIFEST_INVALID');
  const keys = Object.keys(value).sort();
  const expected = [...exactKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('MANIFEST_INVALID');
  }
}

function requireString(value) {
  if (typeof value !== 'string' || value.length === 0) fail('MANIFEST_INVALID');
  return value;
}

function requireInteger(value) {
  if (!Number.isSafeInteger(value)) fail('MANIFEST_INVALID');
  return value;
}

function fail(code) {
  throw new Error(code);
}

const defaultResourceRoot = fileURLToPath(new URL('../resources/local-model', import.meta.url));
const invokedAsScript = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  if (process.argv.length !== 2) fail('ARGUMENTS_NOT_ALLOWED');
  await verifyLocalModelAssets(defaultResourceRoot)
    .then(() => console.log('固定本地模型资源校验通过。'))
    .catch(error => {
      console.error(`LOCAL_MODEL_ASSETS_INVALID ${error instanceof Error ? error.message : 'UNKNOWN'}`);
      process.exitCode = 1;
    });
}
