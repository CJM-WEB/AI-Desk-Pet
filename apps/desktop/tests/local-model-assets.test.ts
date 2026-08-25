import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { BUILTIN_LOCAL_MODEL_RELEASE } from '../src/main/local-model/local-model-manifest';

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface FixtureManifest {
  schemaVersion: number;
  platform: string;
  arch: string;
  notices: ManifestFile;
  runtime: {
    revision: string;
    license: ManifestFile;
    backends: Record<'cpu' | 'vulkan', { executable: string; files: ManifestFile[] }>;
  };
  model: {
    id: string;
    sourceRepository: string;
    sourceRevision: string;
    quantizationRepository: string;
    quantizationRevision: string;
    file: ManifestFile;
    license: ManifestFile;
  };
}

interface FixturePolicy {
  schemaVersion: 1;
  platform: 'win32';
  arch: 'x64';
  runtimeRevision: string;
  model: {
    id: string;
    sourceRepository: string;
    sourceRevision: string;
    quantizationRepository: string;
    quantizationRevision: string;
    fileName: string;
    size: number;
    sha256: string;
  };
  documents: {
    runtimeLicense: { path: string; size: number; sha256: string };
    modelLicense: { path: string; size: number; sha256: string };
    notices: { path: string; size: number; sha256: string };
  };
}

const temporaryDirectories: string[] = [];
const contents = {
  cpuServer: 'fixture-cpu-server',
  cpuDll: 'fixture-cpu-dll',
  vulkanServer: 'fixture-vulkan-server',
  vulkanDll: 'fixture-vulkan-dll',
  model: 'fixture-small-model',
  runtimeLicense: 'fixture-mit-license',
  modelLicense: 'fixture-apache-license',
  notices: 'fixture-notices\nwith-fixed-sources'
} as const;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const fixturePolicy: FixturePolicy = {
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  runtimeRevision: 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9',
  model: {
    id: 'ai-pet-local',
    sourceRepository: 'Qwen/Qwen3.5-4B',
    sourceRevision: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
    quantizationRepository: 'unsloth/Qwen3.5-4B-GGUF',
    quantizationRevision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: Buffer.byteLength(contents.model),
    sha256: sha256(contents.model)
  },
  documents: {
    runtimeLicense: {
      path: 'licenses/llama.cpp-LICENSE.txt',
      size: Buffer.byteLength(contents.runtimeLicense),
      sha256: sha256(contents.runtimeLicense)
    },
    modelLicense: {
      path: 'licenses/Qwen3.5-4B-LICENSE.txt',
      size: Buffer.byteLength(contents.modelLicense),
      sha256: sha256(contents.modelLicense)
    },
    notices: {
      path: 'THIRD-PARTY-NOTICES.txt',
      size: Buffer.byteLength(contents.notices),
      sha256: sha256(contents.notices)
    }
  }
};

async function loadVerifier(): Promise<{
  BUILTIN_LOCAL_MODEL_ASSET_POLICY: FixturePolicy;
  verifyLocalModelAssets: (root: string, policy: FixturePolicy) => Promise<void>;
}> {
  const moduleUrl = new URL('../scripts/verify-local-model-assets.mjs', import.meta.url);
  return import(moduleUrl.href);
}

async function loadStager(): Promise<{
  downloadFixedModelFile: (options: {
    url: string;
    target: string;
    relativePath: string;
    expectedSize: number;
    expectedSha256: string;
    timeoutMs: number;
    signal?: AbortSignal;
    fetchImpl: (
      input: string,
      init: { redirect: 'follow'; signal: AbortSignal }
    ) => Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null }>;
  }) => Promise<ManifestFile>;
  replaceStagedResourceRoot: (
    currentRoot: string,
    stagedRoot: string,
    options?: {
      expectedCurrentRoot?: string;
      renamePath?: typeof rename;
      removePath?: typeof rm;
      onWarning?: (code: string) => void;
    }
  ) => Promise<{ warningCode: string | null }>;
}> {
  const moduleUrl = new URL('../scripts/stage-local-model.mjs', import.meta.url);
  return import(moduleUrl.href);
}

async function writeResource(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function readStageLockSnapshot(lockRoot: string): Promise<Record<string, string>> {
  const entries = (await readdir(lockRoot)).sort();
  return Object.fromEntries(await Promise.all(entries.map(async name => [
    name,
    await readFile(join(lockRoot, name), 'utf8')
  ])));
}

function entry(path: string, content: string): ManifestFile {
  return { path, size: Buffer.byteLength(content), sha256: sha256(content) };
}

async function createFixture(
  mutate?: (manifest: FixtureManifest, root: string) => void | Promise<void>
): Promise<{ root: string; manifest: FixtureManifest }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-assets-')));
  temporaryDirectories.push(root);
  const manifest: FixtureManifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    notices: entry(fixturePolicy.documents.notices.path, contents.notices),
    runtime: {
      revision: fixturePolicy.runtimeRevision,
      license: entry(fixturePolicy.documents.runtimeLicense.path, contents.runtimeLicense),
      backends: {
        cpu: {
          executable: 'payload/runtime/cpu/llama-server.exe',
          files: [
            entry('payload/runtime/cpu/llama-server.exe', contents.cpuServer),
            entry('payload/runtime/cpu/ggml-cpu.dll', contents.cpuDll)
          ]
        },
        vulkan: {
          executable: 'payload/runtime/vulkan/llama-server.exe',
          files: [
            entry('payload/runtime/vulkan/llama-server.exe', contents.vulkanServer),
            entry('payload/runtime/vulkan/ggml-vulkan.dll', contents.vulkanDll)
          ]
        }
      }
    },
    model: {
      id: fixturePolicy.model.id,
      sourceRepository: fixturePolicy.model.sourceRepository,
      sourceRevision: fixturePolicy.model.sourceRevision,
      quantizationRepository: fixturePolicy.model.quantizationRepository,
      quantizationRevision: fixturePolicy.model.quantizationRevision,
      file: entry(`payload/model/${fixturePolicy.model.fileName}`, contents.model),
      license: entry(fixturePolicy.documents.modelLicense.path, contents.modelLicense)
    }
  };

  await writeResource(root, 'payload/runtime/cpu/llama-server.exe', contents.cpuServer);
  await writeResource(root, 'payload/runtime/cpu/ggml-cpu.dll', contents.cpuDll);
  await writeResource(root, 'payload/runtime/vulkan/llama-server.exe', contents.vulkanServer);
  await writeResource(root, 'payload/runtime/vulkan/ggml-vulkan.dll', contents.vulkanDll);
  await writeResource(root, `payload/model/${fixturePolicy.model.fileName}`, contents.model);
  await writeResource(root, fixturePolicy.documents.runtimeLicense.path, contents.runtimeLicense);
  await writeResource(root, fixturePolicy.documents.modelLicense.path, contents.modelLicense);
  await writeResource(root, fixturePolicy.documents.notices.path, contents.notices);
  await mutate?.(manifest, root);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { root, manifest };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('本地模型发行资源 verifier', () => {
  test('精确 allowlist、固定来源和真实哈希均匹配时通过', async () => {
    const fixture = await createFixture();
    const { verifyLocalModelAssets } = await loadVerifier();

    await expect(verifyLocalModelAssets(fixture.root, fixturePolicy)).resolves.toBeUndefined();
  });

  test.each([
    ['错误 SHA', async (manifest: FixtureManifest) => { manifest.runtime.backends.cpu.files[1]!.sha256 = '0'.repeat(64); }],
    ['错误 runtime revision', async (manifest: FixtureManifest) => { manifest.runtime.revision = 'wrong'; }],
    ['错误模型 revision', async (manifest: FixtureManifest) => { manifest.model.quantizationRevision = 'wrong'; }],
    ['缺少许可证', async (_manifest: FixtureManifest, root: string) => {
      await unlink(join(root, 'licenses', 'Qwen3.5-4B-LICENSE.txt'));
    }],
    ['存在 llama-cli.exe', async (manifest: FixtureManifest, root: string) => {
      const forbidden = entry('payload/runtime/cpu/llama-cli.exe', 'forbidden');
      manifest.runtime.backends.cpu.files.push(forbidden);
      await writeResource(root, forbidden.path, 'forbidden');
    }],
    ['存在 llama-rpc-server.exe', async (manifest: FixtureManifest, root: string) => {
      const forbidden = entry('payload/runtime/cpu/llama-rpc-server.exe', 'forbidden');
      manifest.runtime.backends.cpu.files.push(forbidden);
      await writeResource(root, forbidden.path, 'forbidden');
    }],
    ['存在 mmproj', async (_manifest: FixtureManifest, root: string) => {
      await writeResource(root, 'payload/model/mmproj-model-f16.gguf', 'forbidden');
    }],
    ['存在第二模型', async (_manifest: FixtureManifest, root: string) => {
      await writeResource(root, 'payload/model/another.gguf', 'forbidden');
    }],
    ['存在额外 EXE', async (manifest: FixtureManifest, root: string) => {
      const forbidden = entry('payload/runtime/vulkan/benchmark.exe', 'forbidden');
      manifest.runtime.backends.vulkan.files.push(forbidden);
      await writeResource(root, forbidden.path, 'forbidden');
    }]
  ])('%s 时拒绝打包', async (_name, mutate) => {
    const fixture = await createFixture(mutate);
    const { verifyLocalModelAssets } = await loadVerifier();

    await expect(verifyLocalModelAssets(fixture.root, fixturePolicy)).rejects.toThrow();
  });

  test.each([
    ['许可证', async (manifest: FixtureManifest, root: string) => {
      const path = fixturePolicy.documents.runtimeLicense.path;
      await writeResource(root, path, 'replacement-license');
      manifest.runtime.license = entry(path, 'replacement-license');
    }],
    ['来源说明', async (manifest: FixtureManifest, root: string) => {
      const path = fixturePolicy.documents.notices.path;
      await writeResource(root, path, 'replacement-notices');
      manifest.notices = entry(path, 'replacement-notices');
    }]
  ])('%s 被替换且同步改写 manifest 时仍拒绝', async (_name, mutate) => {
    const fixture = await createFixture(mutate);
    const { verifyLocalModelAssets } = await loadVerifier();

    await expect(verifyLocalModelAssets(fixture.root, fixturePolicy)).rejects.toThrow();
  });

  test('发行文本改为 CRLF 并同步改写 manifest 时仍按原始字节拒绝', async () => {
    const fixture = await createFixture(async (manifest, root) => {
      const path = fixturePolicy.documents.notices.path;
      const crlfNotices = contents.notices.replace(/\n/gu, '\r\n');
      await writeResource(root, path, crlfNotices);
      manifest.notices = entry(path, crlfNotices);
    });
    const { verifyLocalModelAssets } = await loadVerifier();

    await expect(verifyLocalModelAssets(fixture.root, fixturePolicy)).rejects.toThrow(
      'DOCUMENT_IDENTITY_MISMATCH'
    );
  });

  test('verifier 与 runtime 复用同一个生产发行 identity', async () => {
    const identityModuleUrl = new URL(
      '../src/main/local-model/local-model-release-identity.mjs',
      import.meta.url
    );
    const { BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY } = await import(identityModuleUrl.href);
    const { BUILTIN_LOCAL_MODEL_ASSET_POLICY } = await loadVerifier();

    expect(BUILTIN_LOCAL_MODEL_ASSET_POLICY).toBe(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY);
    expect(BUILTIN_LOCAL_MODEL_RELEASE).toBe(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY);
    expect(Object.isFrozen(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY)).toBe(true);
    expect(Object.isFrozen(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY.model)).toBe(true);
    expect(Object.isFrozen(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY.documents)).toBe(true);
    for (const document of Object.values(BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY.documents)) {
      expect(Object.isFrozen(document)).toBe(true);
    }
  });

  test('生产 manifest 与发行文本原始字节逐项匹配单一 policy', async () => {
    const root = new URL('../resources/local-model/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as FixtureManifest;
    const identityModuleUrl = new URL(
      '../src/main/local-model/local-model-release-identity.mjs',
      import.meta.url
    );
    const { BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY: policy } = await import(identityModuleUrl.href);
    const documents = [
      [manifest.runtime.license, policy.documents.runtimeLicense],
      [manifest.model.license, policy.documents.modelLicense],
      [manifest.notices, policy.documents.notices]
    ] as const;

    for (const [manifestEntry, expected] of documents) {
      const bytes = await readFile(new URL(expected.path, root));
      expect(manifestEntry).toEqual(expected);
      expect(bytes.byteLength).toBe(expected.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
    }
  });

  test('测试使用小型模型 fixture', async () => {
    const fixture = await createFixture();
    const model = await readFile(join(fixture.root, 'payload/model', fixturePolicy.model.fileName));

    expect(model.byteLength).toBeLessThan(1024);
  });
});

describe('本地模型发行资源暂存事务', () => {
  test('默认事务拒绝删除非固定 resources/local-model 根', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-safety-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const stagedRoot = join(workspace, 'local-model.partial');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(stagedRoot, 'marker.txt', 'new');
    const { replaceStagedResourceRoot } = await loadStager();

    await expect(replaceStagedResourceRoot(currentRoot, stagedRoot)).rejects.toThrow(
      'STAGE_TRANSACTION_PATH_INVALID'
    );
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
  });

  test('resources 父目录是 Junction 时在写锁前拒绝且不触及目标目录', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-parent-junction-')));
    temporaryDirectories.push(workspace);
    const targetParent = join(workspace, 'junction-target');
    const linkedParent = join(workspace, 'linked-resources');
    const currentRoot = join(linkedParent, 'local-model');
    const stagedRoot = join(linkedParent, 'local-model.partial');
    await writeResource(join(targetParent, 'local-model'), 'marker.txt', 'old');
    await writeResource(join(targetParent, 'local-model.partial'), 'marker.txt', 'new');
    await symlink(targetParent, linkedParent, 'junction');
    const { replaceStagedResourceRoot } = await loadStager();

    await expect(replaceStagedResourceRoot(currentRoot, stagedRoot, {
      expectedCurrentRoot: currentRoot
    })).rejects.toThrow('STAGE_TRANSACTION_PATH_INVALID');

    expect((await readdir(targetParent)).sort()).toEqual(['local-model', 'local-model.partial']);
    await expect(readFile(join(targetParent, 'local-model', 'marker.txt'), 'utf8')).resolves.toBe('old');
  });

  test('模型下载 stall 时超时 Abort 并删除 partial', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-download-stall-')));
    temporaryDirectories.push(workspace);
    const target = join(workspace, 'model.gguf');
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = async (
      _input: string,
      init: { redirect: 'follow'; signal: AbortSignal }
    ): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }> => {
      requestSignal = init.signal;
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
          }
        })
      };
    };
    const { downloadFixedModelFile } = await loadStager();

    await expect(downloadFixedModelFile({
      url: 'https://fixed.invalid/model.gguf',
      target,
      relativePath: 'payload/model/model.gguf',
      expectedSize: 4,
      expectedSha256: sha256('data'),
      timeoutMs: 20,
      fetchImpl
    })).rejects.toThrow('MODEL_DOWNLOAD_TIMEOUT');

    expect(requestSignal?.aborted).toBe(true);
    await expect(readFile(`${target}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('下载字节超过固定 size 时立即中止未结束流并删除 partial', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-download-oversize-')));
    temporaryDirectories.push(workspace);
    const target = join(workspace, 'model.gguf');
    const fetchImpl = async (): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }> => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('12345', 'utf8'));
          // 故意不 close；实现必须在首块超限时立即销毁流水线，不能等待流结束或 timeout。
        }
      })
    });
    const { downloadFixedModelFile } = await loadStager();

    await expect(downloadFixedModelFile({
      url: 'https://fixed.invalid/model.gguf',
      target,
      relativePath: 'payload/model/model.gguf',
      expectedSize: 4,
      expectedSha256: sha256('1234'),
      timeoutMs: 1_000,
      fetchImpl
    })).rejects.toThrow('MODEL_DOWNLOAD_OVERSIZE');

    await expect(readFile(`${target}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('调用方 Abort 会中止 stall 下载并清理 partial', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-download-abort-')));
    temporaryDirectories.push(workspace);
    const target = join(workspace, 'model.gguf');
    const caller = new AbortController();
    let notifyRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { notifyRequestStarted = resolve; });
    const fetchImpl = async (
      _input: string,
      init: { redirect: 'follow'; signal: AbortSignal }
    ): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }> => {
      notifyRequestStarted();
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
          }
        })
      };
    };
    const { downloadFixedModelFile } = await loadStager();
    const downloading = downloadFixedModelFile({
      url: 'https://fixed.invalid/model.gguf',
      target,
      relativePath: 'payload/model/model.gguf',
      expectedSize: 4,
      expectedSha256: sha256('data'),
      timeoutMs: 1_000,
      signal: caller.signal,
      fetchImpl
    });
    await requestStarted;

    caller.abort(new Error('fixture caller abort'));

    await expect(downloading).rejects.toThrow('fixture caller abort');
    await expect(readFile(`${target}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('多块下载精确匹配 size/SHA 后原子改名并返回 manifest 条目', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-download-success-')));
    temporaryDirectories.push(workspace);
    const target = join(workspace, 'model.gguf');
    const fetchImpl = async (): Promise<{ ok: boolean; body: ReadableStream<Uint8Array> }> => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('da', 'utf8'));
          controller.enqueue(Buffer.from('ta', 'utf8'));
          controller.close();
        }
      })
    });
    const { downloadFixedModelFile } = await loadStager();

    await expect(downloadFixedModelFile({
      url: 'https://fixed.invalid/model.gguf',
      target,
      relativePath: 'payload/model/model.gguf',
      expectedSize: 4,
      expectedSha256: sha256('data'),
      timeoutMs: 1_000,
      fetchImpl
    })).resolves.toEqual({
      path: 'payload/model/model.gguf',
      size: 4,
      sha256: sha256('data')
    });

    await expect(readFile(target, 'utf8')).resolves.toBe('data');
    await expect(readFile(`${target}.partial`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('完整 staging 根准备完成后整体替换旧资源根', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-swap-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const stagedRoot = join(workspace, 'local-model.partial');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(stagedRoot, 'marker.txt', 'new');
    const { replaceStagedResourceRoot } = await loadStager();

    await replaceStagedResourceRoot(currentRoot, stagedRoot, { expectedCurrentRoot: currentRoot });

    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('new');
    expect(await readdir(workspace)).toEqual(['local-model']);
  });

  test('切换 staging 根失败时恢复旧资源且不留下备份根', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-rollback-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const stagedRoot = join(workspace, 'local-model.partial');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(stagedRoot, 'marker.txt', 'new');
    const { replaceStagedResourceRoot } = await loadStager();
    const failStagedMove: typeof rename = async (from, to) => {
      if (from === stagedRoot) throw new Error('fixture staged move failed');
      await rename(from, to);
    };

    await expect(replaceStagedResourceRoot(currentRoot, stagedRoot, {
      expectedCurrentRoot: currentRoot,
      renamePath: failStagedMove
    })).rejects.toThrow(
      'fixture staged move failed'
    );

    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(join(stagedRoot, 'marker.txt'), 'utf8')).resolves.toBe('new');
    expect((await readdir(workspace)).sort()).toEqual(['local-model', 'local-model.partial']);
  });

  test('第一事务持有 rollback 备份时第二事务稳定 BUSY 且不能删除备份', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-lock-rollback-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const firstStagedRoot = join(workspace, 'local-model.partial-first');
    const secondStagedRoot = join(workspace, 'local-model.partial-second');
    const backupRoot = join(workspace, 'local-model.previous');
    const lockPath = join(workspace, 'local-model.stage.lock');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(firstStagedRoot, 'marker.txt', 'first');
    await writeResource(secondStagedRoot, 'marker.txt', 'second');
    let enterCommitRename!: () => void;
    let releaseCommitRename!: () => void;
    const commitRenameEntered = new Promise<void>(resolve => { enterCommitRename = resolve; });
    const commitRenameReleased = new Promise<void>(resolve => { releaseCommitRename = resolve; });
    const { replaceStagedResourceRoot } = await loadStager();
    const failAfterInterleave: typeof rename = async (from, to) => {
      if (from === firstStagedRoot) {
        enterCommitRename();
        await commitRenameReleased;
        throw new Error('fixture commit rename failed');
      }
      await rename(from, to);
    };
    const first = replaceStagedResourceRoot(currentRoot, firstStagedRoot, {
      expectedCurrentRoot: currentRoot,
      renamePath: failAfterInterleave
    });
    await commitRenameEntered;
    const firstLockSnapshot = await readStageLockSnapshot(lockPath);

    await expect(replaceStagedResourceRoot(currentRoot, secondStagedRoot, {
      expectedCurrentRoot: currentRoot
    })).rejects.toThrow('STAGE_TRANSACTION_BUSY');
    await expect(readFile(join(backupRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    await expect(readStageLockSnapshot(lockPath)).resolves.toEqual(firstLockSnapshot);

    releaseCommitRename();
    await expect(first).rejects.toThrow('fixture commit rename failed');
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(join(secondStagedRoot, 'marker.txt'), 'utf8')).resolves.toBe('second');
    await expect(readFile(backupRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('第一事务提交后清理备份期间第二事务稳定 BUSY 且不能抢先清理', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-lock-cleanup-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const firstStagedRoot = join(workspace, 'local-model.partial-first');
    const secondStagedRoot = join(workspace, 'local-model.partial-second');
    const backupRoot = join(workspace, 'local-model.previous');
    const lockPath = join(workspace, 'local-model.stage.lock');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(firstStagedRoot, 'marker.txt', 'first');
    await writeResource(secondStagedRoot, 'marker.txt', 'second');
    let enterCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
    const cleanupReleased = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const { replaceStagedResourceRoot } = await loadStager();
    const pauseBackupCleanup: typeof rm = async (path, options) => {
      if (path === backupRoot) {
        enterCleanup();
        await cleanupReleased;
      }
      await rm(path, options);
    };
    const first = replaceStagedResourceRoot(currentRoot, firstStagedRoot, {
      expectedCurrentRoot: currentRoot,
      removePath: pauseBackupCleanup
    });
    await cleanupEntered;
    const firstLockSnapshot = await readStageLockSnapshot(lockPath);

    await expect(replaceStagedResourceRoot(currentRoot, secondStagedRoot, {
      expectedCurrentRoot: currentRoot
    })).rejects.toThrow('STAGE_TRANSACTION_BUSY');
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('first');
    await expect(readFile(join(backupRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    await expect(readStageLockSnapshot(lockPath)).resolves.toEqual(firstLockSnapshot);

    releaseCleanup();
    await expect(first).resolves.toEqual({ warningCode: null });
    await expect(readFile(join(secondStagedRoot, 'marker.txt'), 'utf8')).resolves.toBe('second');
    await expect(readFile(backupRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('事务失败且锁根被替换为 Junction 时告警且不删除根外 owner', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-lock-warning-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const stagedRoot = join(workspace, 'local-model.partial');
    const lockPath = join(workspace, 'local-model.stage.lock');
    const displacedLockPath = join(workspace, 'local-model.stage.lock.displaced');
    const foreignRoot = join(workspace, 'foreign-lock-target');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(stagedRoot, 'marker.txt', 'new');
    const warnings: string[] = [];
    const { replaceStagedResourceRoot } = await loadStager();
    const failAfterLockReplacement: typeof rename = async (from, to) => {
      if (from === stagedRoot) {
        const [ownerFileName] = await readdir(lockPath);
        if (ownerFileName === undefined) throw new Error('fixture owner missing');
        const ownerMetadata = await readFile(join(lockPath, ownerFileName), 'utf8');
        await rename(lockPath, displacedLockPath);
        await mkdir(foreignRoot);
        await writeFile(join(foreignRoot, ownerFileName), ownerMetadata, 'utf8');
        await symlink(foreignRoot, lockPath, 'junction');
        throw new Error('fixture commit rename failed');
      }
      await rename(from, to);
    };

    await expect(replaceStagedResourceRoot(currentRoot, stagedRoot, {
      expectedCurrentRoot: currentRoot,
      renamePath: failAfterLockReplacement,
      onWarning: code => warnings.push(code)
    })).rejects.toThrow('fixture commit rename failed');

    expect(warnings).toEqual(['STAGE_TRANSACTION_LOCK_CLEANUP_PENDING']);
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    const [foreignOwnerFileName] = await readdir(foreignRoot);
    if (foreignOwnerFileName === undefined) throw new Error('fixture foreign owner missing');
    await expect(readFile(join(foreignRoot, foreignOwnerFileName), 'utf8')).resolves.toContain(
      '"schemaVersion":1'
    );
  });

  test('commit 后备份删除失败只告警，下一次事务先清旧备份再安全切换', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-cleanup-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const firstStagedRoot = join(workspace, 'local-model.partial-first');
    const secondStagedRoot = join(workspace, 'local-model.partial-second');
    const backupRoot = join(workspace, 'local-model.previous');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(firstStagedRoot, 'marker.txt', 'new');
    const warnings: string[] = [];
    const failBackupCleanup: typeof rm = async path => {
      if (path === backupRoot) throw new Error('fixture backup cleanup denied');
    };
    const { replaceStagedResourceRoot } = await loadStager();

    await expect(replaceStagedResourceRoot(currentRoot, firstStagedRoot, {
      expectedCurrentRoot: currentRoot,
      removePath: failBackupCleanup,
      onWarning: code => warnings.push(code)
    })).resolves.toEqual({ warningCode: 'STAGE_BACKUP_CLEANUP_PENDING' });
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('new');
    await expect(readFile(join(backupRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    expect(warnings).toEqual(['STAGE_BACKUP_CLEANUP_PENDING']);

    await writeResource(secondStagedRoot, 'marker.txt', 'newest');
    await expect(replaceStagedResourceRoot(currentRoot, secondStagedRoot, {
      expectedCurrentRoot: currentRoot
    })).resolves.toEqual({
      warningCode: null
    });
    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('newest');
    expect(await readdir(workspace)).toEqual(['local-model']);
  });
});
