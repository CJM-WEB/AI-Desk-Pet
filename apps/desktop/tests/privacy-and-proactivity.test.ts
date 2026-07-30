import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DisclosurePolicy,
  PrivacySessionRegistry,
  type DisclosureGrantInput,
  type DisclosureRequest
} from '../src/main/agent/disclosure-policy';
import {
  ApprovedEventRegistry,
  ProactivityPolicy,
  type ProactivityRule,
  type TrustedToolPolicy
} from '../src/main/agent/proactivity-policy';
import { AuditWriter } from '../src/main/audit/audit-writer';
import { LocalMemoryStore } from '../src/main/memory/local-memory-store';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'myself-privacy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function expectErrorCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(code);
}

async function expectAsyncErrorCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toThrowError(code);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('PrivacySessionRegistry', () => {
  test('未知会话默认拒绝长期记忆和对话持久化', () => {
    const registry = new PrivacySessionRegistry();

    expect(registry.isLongTermMemoryAllowed('unknown-session')).toBe(false);
    expectErrorCode(
      () => registry.assertConversationPersistenceAllowed('unknown-session'),
      'PRIVACY_SESSION_UNKNOWN'
    );
  });

  test('无痕会话由 Main 注册表强制禁止长期记忆和对话持久化', () => {
    const registry = new PrivacySessionRegistry();
    registry.register('incognito-session', { incognito: true });
    registry.register('regular-session', { incognito: false });

    expect(registry.isLongTermMemoryAllowed('incognito-session')).toBe(false);
    expectErrorCode(
      () => registry.assertConversationPersistenceAllowed('incognito-session'),
      'PRIVACY_CONVERSATION_PERSISTENCE_DENIED'
    );
    expect(registry.isLongTermMemoryAllowed('regular-session')).toBe(true);
    expect(() => registry.assertConversationPersistenceAllowed('regular-session')).not.toThrow();

    registry.unregister('regular-session');
    expect(registry.isLongTermMemoryAllowed('regular-session')).toBe(false);
  });
});

describe('DisclosurePolicy', () => {
  function createHarness() {
    const sessions = new PrivacySessionRegistry();
    sessions.register('session-1', { incognito: false });
    sessions.register('incognito-session', { incognito: true });
    const profiles = new Map([
      ['profile-openai', 'openai'],
      ['profile-anthropic', 'anthropic']
    ]);
    const sources = new Map([
      ['session-1', 'openai'],
      ['incognito-session', 'openai']
    ]);
    let now = 1_000;
    const policy = new DisclosurePolicy({
      privacySessions: sessions,
      resolveProfileProvider: profileId => profiles.get(profileId) ?? null,
      resolveCurrentSourceProvider: sessionId => sources.get(sessionId) ?? null,
      now: () => now,
      requestGrantTtlMs: 500
    });
    return {
      policy,
      sessions,
      profiles,
      sources,
      advanceTime: (milliseconds: number) => {
        now += milliseconds;
      }
    };
  }

  const baseRequest: DisclosureRequest = {
    requestId: 'request-1',
    sessionId: 'session-1',
    targetProfileId: 'profile-openai',
    categories: ['conversation'],
    metadata: {
      conversation: { itemCount: 2, byteLength: 80 }
    }
  };

  function requestGrant(
    category: DisclosureGrantInput['category'],
    overrides: Partial<DisclosureGrantInput> = {}
  ): DisclosureGrantInput {
    return {
      scope: 'request',
      requestId: 'request-1',
      sessionId: 'session-1',
      category,
      targetProfileId: 'profile-openai',
      allowCrossProvider: false,
      ...overrides
    };
  }

  test.each([
    ['file', 'screenshot'],
    ['screenshot', 'clipboard'],
    ['clipboard', 'memory'],
    ['memory', 'file']
  ] as const)('内部授权 %s 不会隐式授权 %s', (granted, requested) => {
    const { policy } = createHarness();
    policy.grant(requestGrant(granted));

    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: [requested]
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
  });

  test('请求级授权成功后一次性消费，同一请求不能重放', () => {
    const { policy } = createHarness();
    policy.grant(requestGrant('file'));
    const request: DisclosureRequest = {
      ...baseRequest,
      categories: ['file']
    };

    expect(policy.createManifest(request).categories).toEqual(['file']);
    expectErrorCode(
      () => policy.createManifest(request),
      'DISCLOSURE_CATEGORY_NOT_AUTHORIZED'
    );
  });

  test('清单生成失败不会误消费已匹配的请求级授权', () => {
    const { policy } = createHarness();
    policy.grant(requestGrant('file'));

    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['file', 'screenshot']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
    expect(policy.createManifest({
      ...baseRequest,
      categories: ['file']
    }).categories).toEqual(['file']);
  });

  test('会话级授权可在同一会话复用，但不能跨会话', () => {
    const { policy, sessions, sources } = createHarness();
    sessions.register('session-2', { incognito: false });
    sources.set('session-2', 'openai');
    policy.grant({
      scope: 'session',
      sessionId: 'session-1',
      category: 'clipboard',
      targetProfileId: 'profile-openai',
      allowCrossProvider: false
    });

    expect(policy.createManifest({
      ...baseRequest,
      requestId: 'request-2',
      categories: ['clipboard']
    }).categories).toEqual(['clipboard']);
    expect(policy.createManifest({
      ...baseRequest,
      requestId: 'request-3',
      categories: ['clipboard']
    }).categories).toEqual(['clipboard']);
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      requestId: 'request-4',
      sessionId: 'session-2',
      categories: ['clipboard']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
  });

  test('请求级授权过期后拒绝且可显式撤销会话授权', () => {
    const { policy, advanceTime } = createHarness();
    policy.grant(requestGrant('file'));
    advanceTime(501);
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['file']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');

    const grantId = policy.grant({
      scope: 'session',
      sessionId: 'session-1',
      category: 'file',
      targetProfileId: 'profile-openai',
      allowCrossProvider: false
    });
    expect(policy.revoke(grantId)).toBe(true);
    expect(policy.revoke(grantId)).toBe(false);
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['file']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
  });

  test('相同语义授权拒绝重复登记', () => {
    const { policy } = createHarness();
    policy.grant(requestGrant('file'));
    expectErrorCode(
      () => policy.grant(requestGrant('file')),
      'DISCLOSURE_GRANT_DUPLICATE'
    );
  });

  test('同 sessionId 重建后旧 request 和 session grants 全部失效', () => {
    const { policy, sessions } = createHarness();
    policy.grant(requestGrant('file'));
    policy.grant({
      scope: 'session',
      sessionId: 'session-1',
      category: 'clipboard',
      targetProfileId: 'profile-openai',
      allowCrossProvider: false
    });

    sessions.unregister('session-1');
    sessions.register('session-1', { incognito: false });
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['file']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['clipboard']
    }), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');

    policy.grant(requestGrant('file'));
    policy.grant({
      scope: 'session',
      sessionId: 'session-1',
      category: 'clipboard',
      targetProfileId: 'profile-openai',
      allowCrossProvider: false
    });
    expect(policy.createManifest({
      ...baseRequest,
      categories: ['file']
    }).categories).toEqual(['file']);
    expect(policy.createManifest({
      ...baseRequest,
      categories: ['clipboard']
    }).categories).toEqual(['clipboard']);
  });

  test('目标 Provider 和当前 source Provider 均由可信 resolver 决定', () => {
    const { policy } = createHarness();
    const spoofed = {
      ...baseRequest,
      categories: ['file'],
      targetProviderIdentity: 'openai',
      sourceProviderIdentity: 'openai'
    } as unknown as DisclosureRequest;

    policy.grant(requestGrant('file'));
    expectErrorCode(
      () => policy.createManifest(spoofed),
      'DISCLOSURE_REQUEST_INVALID'
    );
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      targetProfileId: 'profile-unknown',
      categories: ['conversation']
    }), 'DISCLOSURE_PROFILE_UNKNOWN');
  });

  test('跨 Provider 只接受内部 grant 的明确授权', () => {
    const { policy } = createHarness();
    const crossProviderRequest: DisclosureRequest = {
      ...baseRequest,
      targetProfileId: 'profile-anthropic',
      categories: ['conversation']
    };
    policy.grant(requestGrant('conversation', {
      targetProfileId: 'profile-anthropic'
    }));
    expectErrorCode(
      () => policy.createManifest(crossProviderRequest),
      'DISCLOSURE_CROSS_PROVIDER_NOT_AUTHORIZED'
    );

    policy.revokeAllForSession('session-1');
    policy.grant(requestGrant('conversation', {
      targetProfileId: 'profile-anthropic',
      allowCrossProvider: true
    }));
    expect(policy.createManifest(crossProviderRequest).targetProviderIdentity).toBe('anthropic');
  });

  test('重复类别稳定拒绝，清单只保留类别和受限元数据', () => {
    const { policy } = createHarness();
    policy.grant(requestGrant('file'));
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      categories: ['file', 'file']
    }), 'DISCLOSURE_REQUEST_INVALID');

    const sensitivePath = 'C:\\Users\\Alice\\private.txt';
    const sensitiveBody = '完整文件正文';
    const invalidRequest = {
      ...baseRequest,
      categories: ['file'],
      metadata: {
        file: {
          itemCount: 1,
          byteLength: 128,
          extension: 'txt',
          absolutePath: sensitivePath,
          content: sensitiveBody
        }
      }
    } as unknown as DisclosureRequest;
    expectErrorCode(
      () => policy.createManifest(invalidRequest),
      'DISCLOSURE_REQUEST_INVALID'
    );

    const manifest = policy.createManifest({
      ...baseRequest,
      categories: ['file'],
      metadata: {
        file: { itemCount: 1, byteLength: 128, extension: 'txt' }
      }
    });
    expect(manifest.metadata).toEqual([
      { category: 'file', itemCount: 1, byteLength: 128, extension: 'txt' }
    ]);
    expect(JSON.stringify(manifest)).not.toContain(sensitivePath);
    expect(JSON.stringify(manifest)).not.toContain(sensitiveBody);
  });

  test('无痕和未知会话不能披露长期记忆', () => {
    const { policy } = createHarness();
    policy.grant(requestGrant('memory', {
      sessionId: 'incognito-session',
      requestId: 'incognito-request'
    }));
    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      requestId: 'incognito-request',
      sessionId: 'incognito-session',
      categories: ['memory']
    }), 'DISCLOSURE_INCOGNITO_MEMORY_DENIED');

    expectErrorCode(() => policy.createManifest({
      ...baseRequest,
      sessionId: 'unknown-session',
      categories: ['conversation']
    }), 'DISCLOSURE_SESSION_UNKNOWN');
  });

  test('Provider resolver 失败使用稳定错误且不回显底层输入', () => {
    const sessions = new PrivacySessionRegistry();
    sessions.register('session-1', { incognito: false });
    const secret = 'SECRET_RESOLVER_DETAIL';
    const profileFailure = new DisclosurePolicy({
      privacySessions: sessions,
      resolveProfileProvider: () => {
        throw new Error(secret);
      },
      resolveCurrentSourceProvider: () => 'openai'
    });
    try {
      profileFailure.grant(requestGrant('file'));
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('DISCLOSURE_PROFILE_UNKNOWN');
      expect((error as Error).message).not.toContain(secret);
    }

    const sourceFailure = new DisclosurePolicy({
      privacySessions: sessions,
      resolveProfileProvider: () => 'openai',
      resolveCurrentSourceProvider: () => {
        throw new Error(secret);
      }
    });
    try {
      sourceFailure.createManifest(baseRequest);
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('DISCLOSURE_SOURCE_PROVIDER_UNKNOWN');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('LocalMemoryStore', () => {
  function createSessions(): PrivacySessionRegistry {
    const sessions = new PrivacySessionRegistry();
    sessions.register('regular-session', { incognito: false });
    sessions.register('incognito-session', { incognito: true });
    return sessions;
  }

  test('默认禁用，所有入口仍要求明确会话且不创建文件', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'memory.json');
    const store = new LocalMemoryStore(file, createSessions());

    await expectAsyncErrorCode(store.list('regular-session'), 'MEMORY_DISABLED');
    await expectAsyncErrorCode(store.get('regular-session', 'memory-1'), 'MEMORY_DISABLED');
    await expectAsyncErrorCode(
      store.upsert('regular-session', { id: 'memory-1', title: '标题', body: '正文' }),
      'MEMORY_DISABLED'
    );
    await expectAsyncErrorCode(store.delete('regular-session', 'memory-1'), 'MEMORY_DISABLED');
    await expectAsyncErrorCode(store.clear('regular-session'), 'MEMORY_DISABLED');
    expect(await readdir(directory)).toEqual([]);
  });

  test('省略、未知或无痕 sessionId 均不能绕过长期记忆边界', async () => {
    const directory = await createTemporaryDirectory();
    const store = new LocalMemoryStore(
      join(directory, 'memory.json'),
      createSessions(),
      { enabled: true }
    );

    await expectAsyncErrorCode(
      (store.list as unknown as () => Promise<unknown>)(),
      'MEMORY_SESSION_NOT_ALLOWED'
    );
    await expectAsyncErrorCode(store.list('unknown-session'), 'MEMORY_SESSION_NOT_ALLOWED');
    await expectAsyncErrorCode(store.list('incognito-session'), 'MEMORY_SESSION_NOT_ALLOWED');
    await expectAsyncErrorCode(
      store.upsert('incognito-session', { id: 'memory-1', title: '标题', body: '正文' }),
      'MEMORY_SESSION_NOT_ALLOWED'
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test('普通会话支持 CRUD、返回副本并保持原子文件', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'memory.json');
    const store = new LocalMemoryStore(file, createSessions(), { enabled: true });

    const created = await store.upsert('regular-session', {
      id: 'memory-1',
      title: '项目偏好',
      body: '文档和注释使用中文'
    });
    created.title = '外部篡改';
    expect((await store.get('regular-session', 'memory-1'))?.title).toBe('项目偏好');

    const listed = await store.list('regular-session');
    listed[0]!.body = '外部篡改';
    expect((await store.get('regular-session', 'memory-1'))?.body)
      .toBe('文档和注释使用中文');

    const updated = await store.upsert('regular-session', {
      id: 'memory-1',
      title: '项目偏好',
      body: '结构性注释使用中文'
    });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(await store.delete('regular-session', 'memory-1')).toBe(true);
    expect(await store.delete('regular-session', 'memory-1')).toBe(false);
    expect(await store.list('regular-session')).toEqual([]);
    expect((await readdir(directory)).sort()).toEqual(['memory.json']);
  });

  test('临时记忆字段不能通过长期存储接口落盘', async () => {
    const directory = await createTemporaryDirectory();
    const store = new LocalMemoryStore(
      join(directory, 'memory.json'),
      createSessions(),
      { enabled: true }
    );
    await expectAsyncErrorCode(store.upsert('regular-session', {
      id: 'memory-1',
      title: '临时信息',
      body: '只在会话使用',
      persistence: 'session'
    } as never), 'MEMORY_INPUT_INVALID');
    expect(await readdir(directory)).toEqual([]);
  });

  test('损坏、重复 ID 或超限文件会被整体隔离', async () => {
    const directory = await createTemporaryDirectory();
    const sessions = createSessions();
    const timestamp = '2026-07-28T00:00:00.000Z';

    const malformedFile = join(directory, 'malformed.json');
    await writeFile(malformedFile, '{"version":1,"memories":[{"id":"x"}]}', 'utf8');
    expect(await new LocalMemoryStore(
      malformedFile,
      sessions,
      { enabled: true }
    ).list('regular-session')).toEqual([]);

    const duplicateFile = join(directory, 'duplicate.json');
    await writeFile(duplicateFile, JSON.stringify({
      version: 1,
      memories: [
        { id: 'same', title: '一', body: '一', createdAt: timestamp, updatedAt: timestamp },
        { id: 'same', title: '二', body: '二', createdAt: timestamp, updatedAt: timestamp }
      ]
    }), 'utf8');
    expect(await new LocalMemoryStore(
      duplicateFile,
      sessions,
      { enabled: true }
    ).list('regular-session')).toEqual([]);

    const oversizedFile = join(directory, 'oversized.json');
    await writeFile(
      oversizedFile,
      `${JSON.stringify({ version: 1, memories: [] })}${' '.repeat(512)}`,
      'utf8'
    );
    expect(await new LocalMemoryStore(
      oversizedFile,
      sessions,
      { enabled: true, maxFileBytes: 128 }
    ).list('regular-session')).toEqual([]);

    const files = await readdir(directory);
    expect(files.filter(name => name.includes('.corrupt-'))).toHaveLength(3);
  });

  test('真实路径与 Windows junction 两个实例并发写不会丢失数据', async () => {
    const directory = await createTemporaryDirectory();
    const realDirectory = join(directory, 'real-memory');
    const junctionDirectory = join(directory, 'junction-memory');
    await mkdir(realDirectory);
    await symlink(realDirectory, junctionDirectory, 'junction');
    const sessions = createSessions();
    const first = new LocalMemoryStore(
      join(realDirectory, 'memory.json'),
      sessions,
      { enabled: true }
    );
    const second = new LocalMemoryStore(
      join(junctionDirectory, 'memory.json'),
      sessions,
      { enabled: true }
    );

    await Promise.all([
      first.upsert('regular-session', { id: 'memory-1', title: '一', body: '一' }),
      second.upsert('regular-session', { id: 'memory-2', title: '二', body: '二' })
    ]);

    expect(await first.list('regular-session')).toHaveLength(2);
    expect((await readdir(realDirectory)).sort()).toEqual(['memory.json']);
  });

  test('容量限制、稳定存储错误和临时文件清理保持生效', async () => {
    const directory = await createTemporaryDirectory();
    const sessions = createSessions();
    const limited = new LocalMemoryStore(join(directory, 'limited.json'), sessions, {
      enabled: true,
      maxEntries: 1,
      maxTitleLength: 4,
      maxBodyLength: 8,
      maxFileBytes: 256
    });
    await expectAsyncErrorCode(
      limited.upsert('regular-session', {
        id: 'x'.repeat(65),
        title: '标题',
        body: '正文'
      }),
      'MEMORY_INPUT_INVALID'
    );
    await limited.upsert('regular-session', { id: 'one', title: '标题', body: '正文' });
    await expectAsyncErrorCode(
      limited.upsert('regular-session', { id: 'two', title: '标题', body: '正文' }),
      'MEMORY_LIMIT_EXCEEDED'
    );

    const blockingFile = join(directory, 'not-a-directory');
    await writeFile(blockingFile, 'block', 'utf8');
    const sensitivePath = join(blockingFile, 'private-memory.json');
    const broken = new LocalMemoryStore(sensitivePath, sessions, { enabled: true });
    try {
      await broken.upsert('regular-session', { id: 'one', title: '标题', body: '正文' });
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('MEMORY_STORAGE_FAILED');
      expect((error as Error).message).not.toContain(sensitivePath);
    }
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('AuditWriter', () => {
  function createWriter(
    file: string,
    options: ConstructorParameters<typeof AuditWriter>[2] = {}
  ): AuditWriter {
    return new AuditWriter(
      file,
      profileId => profileId === 'profile-openai' ? 'openai' : null,
      options
    );
  }

  test('detailCode 是封闭集合，格式合法的密钥仍被拒绝且不回显', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'audit.json');
    const writer = createWriter(file);
    const secret = 'SECRET_API_KEY_123';

    try {
      await writer.append({
        action: 'disclosure',
        category: 'file',
        targetProfileId: 'profile-openai',
        outcome: 'denied',
        redactedSummary: { detailCode: secret }
      } as never);
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('AUDIT_RECORD_INVALID');
      expect((error as Error).message).not.toContain(secret);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  test('目标 Provider 由可信 profile resolver 生成且拒绝调用方自报身份', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'audit.json');
    const writer = createWriter(file);
    const secret = 'SECRET_API_KEY_123';

    await expectAsyncErrorCode(writer.append({
      action: 'disclosure',
      category: 'conversation',
      targetProfileId: 'profile-openai',
      targetProviderIdentity: secret,
      outcome: 'allowed',
      redactedSummary: { detailCode: 'CONVERSATION_DISCLOSED' }
    } as never), 'AUDIT_RECORD_INVALID');
    await expectAsyncErrorCode(writer.append({
      action: 'disclosure',
      category: 'conversation',
      targetProfileId: 'profile-unknown',
      outcome: 'allowed',
      redactedSummary: { detailCode: 'CONVERSATION_DISCLOSED' }
    }), 'AUDIT_PROVIDER_UNKNOWN');
    const record = await writer.append({
      action: 'disclosure',
      category: 'conversation',
      targetProfileId: 'profile-openai',
      outcome: 'allowed',
      redactedSummary: { detailCode: 'CONVERSATION_DISCLOSED' }
    });
    expect(record.targetProviderIdentity).toBe('openai');
    expect(await readFile(file, 'utf8')).not.toContain(secret);
  });

  test('结构化审计安全重写且不含正文和绝对路径', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'audit.json');
    const writer = createWriter(file);
    const record = await writer.append({
      action: 'disclosure',
      category: 'file',
      targetProfileId: 'profile-openai',
      outcome: 'allowed',
      redactedSummary: {
        detailCode: 'FILE_METADATA_DISCLOSED',
        itemCount: 1,
        byteLength: 128
      }
    });

    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const serialized = await readFile(file, 'utf8');
    expect(serialized).not.toContain('C:\\Users\\Alice\\secret.txt');
    expect(serialized).not.toContain('完整文件正文');
    expect(JSON.parse(serialized)).toEqual({ version: 1, records: [record] });
  });

  test('真实路径与 Windows junction 两个实例并发追加不会丢失记录', async () => {
    const directory = await createTemporaryDirectory();
    const realDirectory = join(directory, 'real-audit');
    const junctionDirectory = join(directory, 'junction-audit');
    await mkdir(realDirectory);
    await symlink(realDirectory, junctionDirectory, 'junction');
    const first = createWriter(join(realDirectory, 'audit.json'));
    const second = createWriter(join(junctionDirectory, 'audit.json'));

    await Promise.all([
      first.append({
        action: 'permission_decision',
        category: 'tool',
        targetProfileId: null,
        outcome: 'allowed',
        redactedSummary: { detailCode: 'PERMISSION_ALLOWED' }
      }),
      second.append({
        action: 'permission_decision',
        category: 'tool',
        targetProfileId: null,
        outcome: 'denied',
        redactedSummary: { detailCode: 'PERMISSION_DENIED' }
      })
    ]);

    expect(await first.list()).toHaveLength(2);
    expect((await readdir(realDirectory)).sort()).toEqual(['audit.json']);
  });

  test('并发追加、clear、超限隔离和稳定错误保持生效', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'audit.json');
    const writer = createWriter(file);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      writer.append({
        action: 'permission_decision',
        category: 'tool',
        targetProfileId: null,
        outcome: index % 2 === 0 ? 'allowed' : 'denied',
        redactedSummary: {
          detailCode: index % 2 === 0 ? 'PERMISSION_ALLOWED' : 'PERMISSION_DENIED'
        }
      })
    ));
    expect(await writer.list()).toHaveLength(20);
    await writer.clear();
    expect(await writer.list()).toEqual([]);

    const oversized = join(directory, 'oversized-audit.json');
    await writeFile(
      oversized,
      `${JSON.stringify({ version: 1, records: [] })}${' '.repeat(512)}`,
      'utf8'
    );
    expect(await createWriter(oversized, { maxFileBytes: 128 }).list()).toEqual([]);

    const blockingFile = join(directory, 'not-a-directory');
    await writeFile(blockingFile, 'block', 'utf8');
    const sensitivePath = join(blockingFile, 'private-audit.json');
    try {
      await createWriter(sensitivePath).append({
        action: 'disclosure',
        category: 'conversation',
        targetProfileId: 'profile-openai',
        outcome: 'allowed',
        redactedSummary: { detailCode: 'CONVERSATION_DISCLOSED' }
      });
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('AUDIT_STORAGE_FAILED');
      expect((error as Error).message).not.toContain(sensitivePath);
    }
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('ProactivityPolicy', () => {
  function createHarness(mode?: 'passive' | 'assistive' | 'autonomous') {
    let now = 1_000;
    const events = new ApprovedEventRegistry({
      now: () => now,
      eventTtlMs: 500
    });
    const toolPolicies = new Map<string, TrustedToolPolicy>([
      ['builtin.files.list_directory', {
        risk: 'read',
        requiredDataScopes: [{ category: 'file' }]
      }],
      ['builtin.files.create_file', {
        risk: 'recoverable',
        requiredDataScopes: [{ category: 'file' }]
      }],
      ['builtin.system.erase', {
        risk: 'high',
        requiredDataScopes: [{ category: 'file' }]
      }],
      ['builtin.clock.read', {
        risk: 'read',
        requiredDataScopes: []
      }]
    ]);
    const rules: ProactivityRule[] = [
      {
        id: 'rule-list',
        enabled: true,
        eventType: 'workspace_changed',
        toolName: 'builtin.files.list_directory',
        sourceRootId: 'workspace-root'
      },
      {
        id: 'rule-create',
        enabled: true,
        eventType: 'workspace_changed',
        toolName: 'builtin.files.create_file',
        sourceRootId: 'workspace-root'
      },
      {
        id: 'rule-erase',
        enabled: true,
        eventType: 'workspace_changed',
        toolName: 'builtin.system.erase',
        sourceRootId: 'workspace-root'
      },
      {
        id: 'rule-clock',
        enabled: true,
        eventType: 'timer',
        toolName: 'builtin.clock.read',
        sourceRootId: 'timer-source'
      }
    ];
    const authorized = new Set(['session-1:file:workspace-root']);
    const policy = new ProactivityPolicy({
      ...(mode === undefined ? {} : { mode }),
      rules,
      approvedEvents: events,
      resolveToolPolicy: toolName => toolPolicies.get(toolName) ?? null,
      isScopeAuthorized: (sessionId, category, rootId) =>
        authorized.has(`${sessionId}:${category}:${rootId}`)
    });
    return {
      policy,
      events,
      toolPolicies,
      authorized,
      advanceTime: (milliseconds: number) => {
        now += milliseconds;
      },
      registerEvent: (
        eventType = 'workspace_changed',
        rootId = 'workspace-root',
        sessionId = 'session-1'
      ) => events.register({
        sessionId,
        eventType,
        dataSource: { kind: 'authorized_root', rootId }
      })
    };
  }

  test('passive 只响应明确用户指令，assistive 只建议', () => {
    const passiveHarness = createHarness('passive');
    const passiveEventId = passiveHarness.registerEvent();
    expect(passiveHarness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: passiveEventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'ignore',
      code: 'PROACTIVITY_EXPLICIT_INSTRUCTION_REQUIRED'
    });
    // 被动和辅助模式不消费事件，后续模式切换仍可使用。
    passiveHarness.policy.setMode('autonomous');
    expect(passiveHarness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: passiveEventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'execute',
      code: 'PROACTIVITY_RULE_ALLOWED'
    });
    expect(passiveHarness.policy.evaluate('session-1', {
      explicitUserInstruction: true,
      toolName: 'builtin.files.create_file'
    })).toEqual({
      decision: 'respond',
      code: 'PROACTIVITY_USER_DIRECTED'
    });

    const assistiveHarness = createHarness('assistive');
    const assistiveEventId = assistiveHarness.registerEvent();
    expect(assistiveHarness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: assistiveEventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'suggest',
      code: 'PROACTIVITY_SUGGEST_ONLY'
    });
  });

  test('默认模式是 assistive，只建议且不消费事件', () => {
    const { policy, registerEvent } = createHarness();
    const eventId = registerEvent();

    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'suggest',
      code: 'PROACTIVITY_SUGGEST_ONLY'
    });
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'suggest',
      code: 'PROACTIVITY_SUGGEST_ONLY'
    });
  });

  test('构造时非法模式稳定拒绝且不回显原值', () => {
    const invalidMode = 'autonomous-SECRET_MODE_VALUE';
    try {
      createHarness(invalidMode as never);
      throw new Error('测试应当失败');
    } catch (error) {
      expect((error as Error).message).toBe('PROACTIVITY_MODE_INVALID');
      expect((error as Error).message).not.toContain(invalidMode);
    }
  });

  test('setMode 非法值稳定拒绝并保持原 assistive 模式', () => {
    const { policy, registerEvent } = createHarness();
    const invalidMode = 'autonomous-SECRET_MODE_VALUE';

    expectErrorCode(
      () => policy.setMode(invalidMode as never),
      'PROACTIVITY_MODE_INVALID'
    );
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: registerEvent(),
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'suggest',
      code: 'PROACTIVITY_SUGGEST_ONLY'
    });
  });

  test.each([
    {
      mode: 'passive' as const,
      expected: {
        decision: 'ignore',
        code: 'PROACTIVITY_EXPLICIT_INSTRUCTION_REQUIRED'
      }
    },
    {
      mode: 'assistive' as const,
      expected: {
        decision: 'suggest',
        code: 'PROACTIVITY_SUGGEST_ONLY'
      }
    },
    {
      mode: 'autonomous' as const,
      expected: {
        decision: 'execute',
        code: 'PROACTIVITY_RULE_ALLOWED'
      }
    }
  ])('合法模式 $mode 保持既有决策', ({ mode, expected }) => {
    const { policy, registerEvent } = createHarness(mode);
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: registerEvent(),
      toolName: 'builtin.files.list_directory'
    })).toEqual(expected);
  });

  test('autonomous 成功执行后一次性消费 opaque eventId', () => {
    const { policy, registerEvent } = createHarness('autonomous');
    const eventId = registerEvent();
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'execute',
      code: 'PROACTIVITY_RULE_ALLOWED'
    });
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_EVENT_UNKNOWN'
    });
  });

  test('evaluate 不接受调用方自报 eventType、sourceRoot、风险或规则', () => {
    const { policy, registerEvent } = createHarness('autonomous');
    const spoofed = {
      explicitUserInstruction: false,
      eventId: registerEvent(),
      toolName: 'builtin.files.create_file',
      eventType: 'workspace_changed',
      sourceRootId: 'workspace-root',
      risk: 'read',
      requiredDataScopes: [],
      rules: [{
        id: 'forged',
        toolName: 'builtin.files.create_file',
        eventType: 'workspace_changed',
        sourceRootId: 'workspace-root'
      }]
    };
    expect(policy.evaluate('session-1', spoofed as never)).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_INPUT_INVALID'
    });
  });

  test.each([
    ['builtin.files.create_file', 'recoverable'],
    ['builtin.system.erase', 'high']
  ] as const)('可信 %s 风险 %s 仍进入既有确认流程', (toolName, _risk) => {
    const { policy, registerEvent } = createHarness('autonomous');
    const eventId = registerEvent();
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName
    })).toEqual({
      decision: 'require_confirmation',
      code: 'PROACTIVITY_CONFIRMATION_REQUIRED'
    });
    // 未执行的高风险事件不消费，现有确认层可再次读取同一可信事件。
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName
    })).toEqual({
      decision: 'require_confirmation',
      code: 'PROACTIVITY_CONFIRMATION_REQUIRED'
    });
  });

  test('未知、过期和跨 session 事件稳定拒绝', () => {
    const harness = createHarness('autonomous');
    expect(harness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: '00000000-0000-4000-8000-000000000000',
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_EVENT_UNKNOWN'
    });

    const crossSessionEvent = harness.registerEvent();
    expect(harness.policy.evaluate('session-2', {
      explicitUserInstruction: false,
      eventId: crossSessionEvent,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_EVENT_SESSION_MISMATCH'
    });
    expect(harness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: crossSessionEvent,
      toolName: 'builtin.files.list_directory'
    }).decision).toBe('execute');

    const expiredEvent = harness.registerEvent();
    harness.advanceTime(501);
    expect(harness.policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: expiredEvent,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_EVENT_EXPIRED'
    });
  });

  test('无规则或未知工具拒绝且失败不误消费事件', () => {
    const { policy, registerEvent } = createHarness('autonomous');
    const unmatchedEvent = registerEvent('unmatched-event');
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: unmatchedEvent,
      toolName: 'builtin.files.create_file'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_RULE_NOT_MATCHED'
    });
    policy.setRules([{
      id: 'new-rule',
      enabled: true,
      eventType: 'unmatched-event',
      toolName: 'builtin.files.create_file',
      sourceRootId: 'workspace-root'
    }]);
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: unmatchedEvent,
      toolName: 'builtin.files.create_file'
    }).decision).toBe('require_confirmation');

    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: registerEvent(),
      toolName: 'builtin.unknown.tool'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_TOOL_UNKNOWN'
    });
  });

  test('缺失 scope 授权拒绝且授权补齐后同一事件可执行', () => {
    const { policy, authorized, registerEvent } = createHarness('autonomous');
    authorized.clear();
    const eventId = registerEvent();
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_DATA_NOT_AUTHORIZED'
    });
    authorized.add('session-1:file:workspace-root');
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'execute',
      code: 'PROACTIVITY_RULE_ALLOWED'
    });
  });

  test('可信工具策略明确无数据需求时允许空 scope', () => {
    const { policy, registerEvent } = createHarness('autonomous');
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: registerEvent('timer', 'timer-source'),
      toolName: 'builtin.clock.read'
    })).toEqual({
      decision: 'execute',
      code: 'PROACTIVITY_RULE_ALLOWED'
    });
  });

  test.each([
    { kind: 'all_drives' as const },
    { kind: 'unbounded_source' as const }
  ])('全盘或无界数据源在事件登记边界直接拒绝', dataSource => {
    const { events } = createHarness('autonomous');
    expectErrorCode(() => events.register({
      sessionId: 'session-1',
      eventType: 'workspace_changed',
      dataSource
    }), 'APPROVED_EVENT_UNBOUNDED_SOURCE_DENIED');
  });

  test('模式和规则只能通过策略控制面更新', () => {
    const { policy, registerEvent } = createHarness('passive');
    policy.setMode('autonomous');
    policy.setRules([{
      id: 'rule-list-new',
      enabled: true,
      eventType: 'workspace_changed',
      toolName: 'builtin.files.list_directory',
      sourceRootId: 'workspace-root'
    }]);
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId: registerEvent(),
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'execute',
      code: 'PROACTIVITY_RULE_ALLOWED'
    });
  });

  test('工具策略 resolver 失败转换为稳定拒绝且事件不消费', () => {
    const events = new ApprovedEventRegistry();
    const eventId = events.register({
      sessionId: 'session-1',
      eventType: 'workspace_changed',
      dataSource: {
        kind: 'authorized_root',
        rootId: 'workspace-root'
      }
    });
    const policy = new ProactivityPolicy({
      mode: 'autonomous',
      approvedEvents: events,
      rules: [{
        id: 'rule-list',
        enabled: true,
        eventType: 'workspace_changed',
        toolName: 'builtin.files.list_directory',
        sourceRootId: 'workspace-root'
      }],
      resolveToolPolicy: () => {
        throw new Error('SECRET_RESOLVER_DETAIL');
      },
      isScopeAuthorized: () => true
    });
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_TOOL_UNKNOWN'
    });
    expect(policy.evaluate('session-1', {
      explicitUserInstruction: false,
      eventId,
      toolName: 'builtin.files.list_directory'
    })).toEqual({
      decision: 'deny',
      code: 'PROACTIVITY_TOOL_UNKNOWN'
    });
  });
});
