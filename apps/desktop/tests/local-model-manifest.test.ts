import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  validateLocalModelManifest,
  type LocalModelManifestDocument,
  type LocalModelReleasePolicy
} from '../src/main/local-model/local-model-manifest';

const temporaryDirectories: string[] = [];
const runtimeRevision = 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9';
const modelRevision = '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a';
const quantizationRevision = 'e87f176479d0855a907a41277aca2f8ee7a09523';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const contents = {
  cpuExe: 'fixture-cpu-executable',
  cpuDll: 'fixture-cpu-library',
  vulkanExe: 'fixture-vulkan-executable',
  vulkanDll: 'fixture-vulkan-library',
  model: 'fixture-small-gguf',
  runtimeLicense: 'fixture-mit-license',
  modelLicense: 'fixture-apache-license'
} as const;

const policy: LocalModelReleasePolicy = {
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  runtimeRevision,
  model: {
    id: 'ai-pet-local',
    sourceRepository: 'Qwen/Qwen3.5-4B',
    sourceRevision: modelRevision,
    quantizationRepository: 'unsloth/Qwen3.5-4B-GGUF',
    quantizationRevision,
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: Buffer.byteLength(contents.model),
    sha256: sha256(contents.model)
  }
};

async function writeResource(root: string, path: string, content: string): Promise<void> {
  const file = join(root, ...path.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function createFixture(
  mutate?: (manifest: LocalModelManifestDocument) => void
): Promise<{ root: string; cachePath: string; manifest: LocalModelManifestDocument }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-manifest-')));
  temporaryDirectories.push(root);
  const manifest: LocalModelManifestDocument = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    runtime: {
      revision: runtimeRevision,
      license: {
        path: 'licenses/llama.cpp-MIT.txt',
        size: Buffer.byteLength(contents.runtimeLicense),
        sha256: sha256(contents.runtimeLicense)
      },
      backends: {
        cpu: {
          executable: 'payload/cpu/llama-server.exe',
          files: [
            {
              path: 'payload/cpu/llama-server.exe',
              size: Buffer.byteLength(contents.cpuExe),
              sha256: sha256(contents.cpuExe)
            },
            {
              path: 'payload/cpu/ggml-cpu.dll',
              size: Buffer.byteLength(contents.cpuDll),
              sha256: sha256(contents.cpuDll)
            }
          ]
        },
        vulkan: {
          executable: 'payload/vulkan/llama-server.exe',
          files: [
            {
              path: 'payload/vulkan/llama-server.exe',
              size: Buffer.byteLength(contents.vulkanExe),
              sha256: sha256(contents.vulkanExe)
            },
            {
              path: 'payload/vulkan/ggml-vulkan.dll',
              size: Buffer.byteLength(contents.vulkanDll),
              sha256: sha256(contents.vulkanDll)
            }
          ]
        }
      }
    },
    model: {
      id: policy.model.id,
      sourceRepository: policy.model.sourceRepository,
      sourceRevision: modelRevision,
      quantizationRepository: policy.model.quantizationRepository,
      quantizationRevision,
      file: {
        path: `payload/model/${policy.model.fileName}`,
        size: policy.model.size,
        sha256: policy.model.sha256
      },
      license: {
        path: 'licenses/Qwen3.5-4B-Apache-2.0.txt',
        size: Buffer.byteLength(contents.modelLicense),
        sha256: sha256(contents.modelLicense)
      }
    }
  };
  mutate?.(manifest);
  await writeResource(root, 'payload/cpu/llama-server.exe', contents.cpuExe);
  await writeResource(root, 'payload/cpu/ggml-cpu.dll', contents.cpuDll);
  await writeResource(root, 'payload/vulkan/llama-server.exe', contents.vulkanExe);
  await writeResource(root, 'payload/vulkan/ggml-vulkan.dll', contents.vulkanDll);
  await writeResource(root, `payload/model/${policy.model.fileName}`, contents.model);
  await writeResource(root, 'licenses/llama.cpp-MIT.txt', contents.runtimeLicense);
  await writeResource(root, 'licenses/Qwen3.5-4B-Apache-2.0.txt', contents.modelLicense);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { root, cachePath: join(dirname(root), `${root.split(/[\\/]/u).at(-1)}.cache.json`), manifest };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('validateLocalModelManifest', () => {
  test('严格解析固定 Windows x64 发行物并返回根内绝对路径', async () => {
    const fixture = await createFixture();

    const result = await validateLocalModelManifest({
      root: fixture.root,
      applicationVersion: '1.0.0',
      cachePath: fixture.cachePath,
      releasePolicy: policy
    });

    expect(result.modelPath).toBe(join(fixture.root, 'payload/model', policy.model.fileName));
    expect(result.backends.cpu.executablePath).toBe(join(fixture.root, 'payload/cpu/llama-server.exe'));
    expect(result.backends.vulkan.executablePath).toBe(join(fixture.root, 'payload/vulkan/llama-server.exe'));
    expect(JSON.parse(await readFile(fixture.cachePath, 'utf8'))).toMatchObject({
      applicationVersion: '1.0.0',
      sha256: policy.model.sha256
    });
  });

  test.each([
    ['额外字段', (manifest: LocalModelManifestDocument) => Object.assign(manifest, { unexpected: true }), 'RUNTIME_INCOMPATIBLE'],
    ['错误平台', (manifest: LocalModelManifestDocument) => Object.assign(manifest, { platform: 'linux' }), 'RUNTIME_INCOMPATIBLE'],
    ['错误架构', (manifest: LocalModelManifestDocument) => Object.assign(manifest, { arch: 'arm64' }), 'RUNTIME_INCOMPATIBLE'],
    ['错误 runtime revision', (manifest: LocalModelManifestDocument) => { manifest.runtime.revision = 'wrong'; }, 'RUNTIME_INCOMPATIBLE'],
    ['错误模型 revision', (manifest: LocalModelManifestDocument) => { manifest.model.sourceRevision = 'wrong'; }, 'RUNTIME_INCOMPATIBLE'],
    ['错误量化 revision', (manifest: LocalModelManifestDocument) => { manifest.model.quantizationRevision = 'wrong'; }, 'RUNTIME_INCOMPATIBLE'],
    ['模型固定大小被改写', (manifest: LocalModelManifestDocument) => { manifest.model.file.size += 1; }, 'RESOURCE_HASH_MISMATCH'],
    ['模型固定哈希被改写', (manifest: LocalModelManifestDocument) => { manifest.model.file.sha256 = '0'.repeat(64); }, 'RESOURCE_HASH_MISMATCH'],
    ['路径越出 manifest 根', (manifest: LocalModelManifestDocument) => {
      manifest.runtime.backends.cpu.executable = '../outside.exe';
      manifest.runtime.backends.cpu.files[0]!.path = '../outside.exe';
    }, 'RUNTIME_INCOMPATIBLE']
  ] as const)('%s 时拒绝资源', async (_name, mutate, reasonCode) => {
    const fixture = await createFixture(mutate);
    await expect(validateLocalModelManifest({
      root: fixture.root,
      applicationVersion: '1.0.0',
      cachePath: fixture.cachePath,
      releasePolicy: policy
    })).rejects.toMatchObject({ reasonCode });
  });

  test('缺少许可证、存在额外文件或小型 runtime 真实 SHA 不符时拒绝', async () => {
    const missingLicense = await createFixture(manifest => {
      manifest.model.license.path = 'licenses/missing.txt';
    });
    await expect(validateLocalModelManifest({
      root: missingLicense.root,
      applicationVersion: '1.0.0',
      cachePath: missingLicense.cachePath,
      releasePolicy: policy
    })).rejects.toMatchObject({ reasonCode: 'RESOURCE_MISSING' });

    const extraFile = await createFixture();
    await writeResource(extraFile.root, 'payload/cpu/llama-cli.exe', 'forbidden');
    await expect(validateLocalModelManifest({
      root: extraFile.root,
      applicationVersion: '1.0.0',
      cachePath: extraFile.cachePath,
      releasePolicy: policy
    })).rejects.toMatchObject({ reasonCode: 'RUNTIME_INCOMPATIBLE' });

    const badRuntime = await createFixture();
    await writeResource(badRuntime.root, 'payload/cpu/ggml-cpu.dll', 'tampered-library');
    await expect(validateLocalModelManifest({
      root: badRuntime.root,
      applicationVersion: '1.0.0',
      cachePath: badRuntime.cachePath,
      releasePolicy: policy
    })).rejects.toMatchObject({ reasonCode: 'RESOURCE_HASH_MISMATCH' });
  });

  test('模型缓存仅在应用版本和文件元数据均匹配时复用，否则重新计算完整 SHA', async () => {
    const fixture = await createFixture();
    const hashFile = vi.fn(async (path: string) => {
      const content = await readFile(path);
      return createHash('sha256').update(content).digest('hex');
    });
    const options = {
      root: fixture.root,
      applicationVersion: '1.0.0',
      cachePath: fixture.cachePath,
      releasePolicy: policy,
      hashFile
    };

    await validateLocalModelManifest(options);
    await validateLocalModelManifest(options);
    expect(hashFile.mock.calls.filter(([path]) => String(path).endsWith('.gguf'))).toHaveLength(1);

    await validateLocalModelManifest({ ...options, applicationVersion: '1.0.1' });
    expect(hashFile.mock.calls.filter(([path]) => String(path).endsWith('.gguf'))).toHaveLength(2);

    await writeResource(fixture.root, `payload/model/${policy.model.fileName}`, 'changed-small-gguf');
    await expect(validateLocalModelManifest({ ...options, applicationVersion: '1.0.1' }))
      .rejects.toMatchObject({ reasonCode: 'RESOURCE_HASH_MISMATCH' });
    expect(hashFile.mock.calls.filter(([path]) => String(path).endsWith('.gguf'))).toHaveLength(3);
  });
});
