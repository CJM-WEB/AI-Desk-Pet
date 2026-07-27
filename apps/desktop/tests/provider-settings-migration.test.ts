import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  providerCatalog,
  providerCatalogEntrySchema,
  providerProfileV2Schema
} from '@myself/shared-types';
import { afterEach, describe, expect, test } from 'vitest';
import { SettingsStore } from '../src/main/storage/settings-store';

const temporaryDirectories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'myself-provider-migration-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'settings.json');
  return {
    directory,
    file,
    store: new SettingsStore(file, async () => true)
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('模型目录与设置迁移', () => {
  test('内置目录包含稳定的十个提供商和精确模型能力顺序', () => {
    expect(providerCatalog.map(entry => entry.providerId)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'kimi',
      'qwen',
      'zhipu',
      'doubao',
      'hunyuan',
      'minimax'
    ]);

    const expectedCapabilities: Record<string, string[]> = {
      openai: ['chat', 'tools', 'vision', 'streaming', 'longContext'],
      anthropic: ['chat', 'tools', 'vision', 'streaming', 'longContext'],
      gemini: ['chat', 'tools', 'vision', 'streaming', 'longContext'],
      deepseek: ['chat', 'tools', 'streaming', 'longContext'],
      kimi: ['chat', 'tools', 'vision', 'streaming', 'longContext'],
      qwen: ['chat', 'tools', 'streaming', 'longContext'],
      zhipu: ['chat', 'tools', 'streaming', 'longContext'],
      doubao: ['chat', 'tools', 'vision', 'streaming', 'longContext'],
      hunyuan: ['chat', 'tools', 'streaming', 'longContext'],
      minimax: ['chat', 'tools', 'streaming', 'longContext']
    };

    for (const entry of providerCatalog) {
      expect(providerCatalogEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.catalogVersion).toBe(1);
      expect(entry.models).toHaveLength(1);
      expect(entry.models[0]?.capabilities).toEqual(expectedCapabilities[entry.providerId]);
    }
  });

  test('预置档案通过严格契约且拒绝未知字段', () => {
    const profile = {
      id: 'openai-primary',
      displayName: 'OpenAI 主档案',
      modelId: 'gpt-5-mini',
      hasStoredSecret: true,
      mode: 'preset' as const,
      providerId: 'openai'
    };

    expect(providerProfileV2Schema.parse(profile)).toEqual(profile);
    expect(providerProfileV2Schema.safeParse({ ...profile, secret: 'never-store-me' }).success).toBe(false);
  });

  test('高级自定义档案只接受扁平附加参数', () => {
    const profile = {
      id: 'advanced-local',
      displayName: '高级自定义档案',
      modelId: 'local-model',
      hasStoredSecret: false,
      mode: 'custom' as const,
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://api.example.com/v1',
      additionalParameters: {
        temperature: 0.2,
        enableReasoning: true,
        tier: 'fast'
      }
    };

    expect(providerProfileV2Schema.parse(profile)).toEqual(profile);
    expect(providerProfileV2Schema.safeParse({
      ...profile,
      additionalParameters: { nested: { value: '不允许' } }
    }).success).toBe(false);
  });

  test('旧单档案迁移为主自定义档案并保留 v1 公开投影', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 1,
      provider: {
        id: 'legacy-provider',
        displayName: '旧服务',
        baseUrl: 'https://api.example.com/v1',
        model: 'legacy-model'
      },
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    }), 'utf8');

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      version: 1,
      provider: {
        id: 'legacy-provider',
        displayName: '旧服务',
        baseUrl: 'https://api.example.com/v1',
        model: 'legacy-model',
        hasStoredSecret: true
      }
    }));
    const migrated = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      providerProfiles: unknown[];
      modelRoute: unknown;
    };
    expect(migrated).toMatchObject({
      version: 2,
      providerProfiles: [{
        id: 'legacy-provider',
        displayName: '旧服务',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'legacy-model',
        additionalParameters: {}
      }],
      modelRoute: {
        primaryProfileId: 'legacy-provider',
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      }
    });
    expect(migrated.providerProfiles).toEqual([{
      id: 'legacy-provider',
      displayName: '旧服务',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'legacy-model',
      additionalParameters: {}
    }]);
  });

  test('并发首次读取同一 v1 设置时只完成一次安全迁移', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 1,
      provider: {
        id: 'legacy-provider',
        displayName: '旧服务',
        baseUrl: 'https://api.example.com/v1',
        model: 'legacy-model'
      },
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    }), 'utf8');

    const [first, second] = await Promise.all([store.getPublic(), store.getPublic()]);

    expect(first.provider).toEqual(expect.objectContaining({ id: 'legacy-provider' }));
    expect(second.provider).toEqual(expect.objectContaining({ id: 'legacy-provider' }));
    await expect(readFile(file, 'utf8')).resolves.toContain('"version": 2');
  });

  test('迁移写入失败时保留原 v1 文件', async () => {
    const { file, store } = await createStore();
    const legacy = {
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    };
    await writeFile(file, JSON.stringify(legacy), 'utf8');
    await mkdir(`${file}.tmp`);

    await expect(store.getPublic()).rejects.toBeDefined();
    await expect(readFile(file, 'utf8')).resolves.toBe(JSON.stringify(legacy));
  });

  test('未知字段的 v2 设置被隔离并返回空兼容投影', async () => {
    const { directory, file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 2,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false,
      unknown: true
    }), 'utf8');

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      version: 1,
      provider: null
    }));
    await expect(readdir(directory)).resolves.toEqual(expect.arrayContaining([
      expect.stringMatching(/^settings\.json\.corrupt-/)
    ]));
  });
});
