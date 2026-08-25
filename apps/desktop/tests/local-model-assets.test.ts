import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

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
    runtimeLicense: { path: string; sha256: string };
    modelLicense: { path: string; sha256: string };
    notices: { path: string; sha256: string };
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
  notices: 'fixture-notices-with-fixed-sources'
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
      sha256: sha256(contents.runtimeLicense)
    },
    modelLicense: {
      path: 'licenses/Qwen3.5-4B-LICENSE.txt',
      sha256: sha256(contents.modelLicense)
    },
    notices: {
      path: 'THIRD-PARTY-NOTICES.txt',
      sha256: sha256(contents.notices)
    }
  }
};

async function loadVerifier(): Promise<{
  verifyLocalModelAssets: (root: string, policy: FixturePolicy) => Promise<void>;
}> {
  const moduleUrl = new URL('../scripts/verify-local-model-assets.mjs', import.meta.url);
  return import(moduleUrl.href);
}

async function loadStager(): Promise<{
  replaceStagedResourceRoot: (
    currentRoot: string,
    stagedRoot: string,
    renamePath?: typeof rename
  ) => Promise<void>;
}> {
  const moduleUrl = new URL('../scripts/stage-local-model.mjs', import.meta.url);
  return import(moduleUrl.href);
}

async function writeResource(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
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

  test('测试使用小型模型 fixture', async () => {
    const fixture = await createFixture();
    const model = await readFile(join(fixture.root, 'payload/model', fixturePolicy.model.fileName));

    expect(model.byteLength).toBeLessThan(1024);
  });
});

describe('本地模型发行资源暂存事务', () => {
  test('完整 staging 根准备完成后整体替换旧资源根', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-stage-swap-')));
    temporaryDirectories.push(workspace);
    const currentRoot = join(workspace, 'local-model');
    const stagedRoot = join(workspace, 'local-model.partial');
    await writeResource(currentRoot, 'marker.txt', 'old');
    await writeResource(stagedRoot, 'marker.txt', 'new');
    const { replaceStagedResourceRoot } = await loadStager();

    await replaceStagedResourceRoot(currentRoot, stagedRoot);

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

    await expect(replaceStagedResourceRoot(currentRoot, stagedRoot, failStagedMove)).rejects.toThrow(
      'fixture staged move failed'
    );

    await expect(readFile(join(currentRoot, 'marker.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(join(stagedRoot, 'marker.txt'), 'utf8')).resolves.toBe('new');
    expect((await readdir(workspace)).sort()).toEqual(['local-model', 'local-model.partial']);
  });
});
