import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTER_RESOURCE_LIMITS } from '@myself/character-assets';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CharacterAssetService,
  type CharacterAssetServiceDependencies,
  type SourceCatalogEntry
} from '../src/main/characters/character-asset-service';

// 两个夹具均已使用 Sharp 0.34.5 验证为可解码的 1×1 图片。
const PNG_BYTES = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
));
const WEBP_BYTES = new Uint8Array(Buffer.from(
  'UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA',
  'base64'
));
// 以下三个 4097×1 夹具均由 Sharp 0.34.5 生成并回读确认可解码。
const OVERSIZED_WEBP_FIXTURES = [
  [
    'VP8',
    'UklGRsQAAABXRUJQVlA4ILgAAABwEQCdASoBEAEAPm02mUmkIyKhICgAgA2JaW7hd2Ee3AfgAAAT2Ae+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ycfwAP7/uB7///yC5YXXI1///ID/kB/yA//j4pqtOBAAAAAAAAAA'
  ],
  [
    'VP8L',
    'UklGRiIAAABXRUJQVlA4TBUAAAAvABAAAAfQ/4j+B4CE8P+9FtH/9A8A'
  ],
  [
    'VP8X',
    'UklGRugAAABXRUJQVlA4WAoAAAAQAAAAABAAAAAAQUxQSBAAAAARB1DAiAgACeH/ey2i/+kfVlA4ILIAAAAwEQCdASoBEAEAPm02mUmkIyKhICgAgA2JaW7hd2Ee3AAAE9gHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snH8AD+/992f//8gP/8gP/8gP/5Af/+IXeyAwAAAAAAAAAA'
  ]
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** WebP 允许未知块；保留完整 1×1 图像，以 JUNK 验证压缩文件字节而不解码大位图。 */
function webpBeyondPreviousByteLimit(): Uint8Array {
  const junkSize = 32 * 1024 * 1024;
  const bytes = Buffer.alloc(WEBP_BYTES.byteLength + 8 + junkSize);
  bytes.set(WEBP_BYTES);
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('JUNK', WEBP_BYTES.byteLength);
  bytes.writeUInt32LE(junkSize, WEBP_BYTES.byteLength + 4);
  return bytes;
}

async function writeSparseImage(
  file: string,
  byteLength: number,
  signature: Uint8Array
): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.truncate(byteLength);
    await handle.write(signature, 0, signature.byteLength, 0);
  } finally {
    await handle.close();
  }
}

function fileSystemError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
    code: 'EACCES'
  });
}

function lockMarker(
  now: number,
  overrides: Partial<{
    ownerToken: string;
    pid: number;
    createdAt: number;
    heartbeatAt: number;
  }> = {}
): Record<string, unknown> {
  return {
    version: 1,
    ownerToken: randomUUID(),
    pid: process.pid,
    createdAt: now,
    heartbeatAt: now,
    ...overrides
  };
}

// 重置模块缓存可获得独立的进程内队列，用两个真实 Service 实例模拟协作进程接管。
async function loadIndependentCharacterAssetService(): Promise<typeof CharacterAssetService> {
  vi.resetModules();
  const module = await import('../src/main/characters/character-asset-service');
  return module.CharacterAssetService;
}

describe('角色素材 Main 安全边界', () => {
  let testDirectory: string;
  let charactersDirectory: string;
  let characterDirectory: string;
  let selectedDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-character-assets-'));
    charactersDirectory = join(testDirectory, 'characters');
    characterDirectory = join(charactersDirectory, 'demo');
    selectedDirectory = join(testDirectory, 'selected');
    await Promise.all([
      mkdir(join(characterDirectory, 'source'), { recursive: true }),
      mkdir(join(characterDirectory, 'compiled'), { recursive: true }),
      mkdir(selectedDirectory, { recursive: true })
    ]);
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  test('只接收系统选择结果中的 PNG 和 WebP，并以 UUID 内部名原子落盘', async () => {
    const pngPath = join(selectedDirectory, '待机.png');
    const webpPath = join(selectedDirectory, '移动.webp');
    const scriptPath = join(selectedDirectory, '脚本.js');
    await Promise.all([
      writeFile(pngPath, PNG_BYTES),
      writeFile(webpPath, WEBP_BYTES),
      writeFile(scriptPath, 'alert(1)', 'utf8')
    ]);

    const imported = await new CharacterAssetService(charactersDirectory)
      .importSources('demo', [pngPath, scriptPath, webpPath]);

    expect(imported).toHaveLength(2);
    expect(imported.map(item => item.mimeType)).toEqual([
      'image/png',
      'image/webp'
    ]);
    expect(imported.map(item => item.displayName)).toEqual(['待机.png', '移动.webp']);
    expect(imported.every(item => (
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(item.assetId)
    ))).toBe(true);
    expect(JSON.stringify(imported)).not.toContain(testDirectory);

    const storedNames = (await readdir(join(characterDirectory, 'source'))).sort();
    expect(storedNames).toEqual([
      'catalog.json',
      ...imported.map(item => (
        `${item.assetId}.${item.mimeType === 'image/png' ? 'png' : 'webp'}`
      ))
    ].sort());
    const pngSource = imported.find(item => item.mimeType === 'image/png')!;
    expect(new Uint8Array(
      await readFile(join(characterDirectory, 'source', `${pngSource.assetId}.png`))
    )).toEqual(PNG_BYTES);
  }, 15_000);

  test('扩展名与文件签名不同时拒绝整批导入且不留下部分文件', async () => {
    const validPath = join(selectedDirectory, 'valid.png');
    const forgedPath = join(selectedDirectory, 'forged.png');
    await Promise.all([
      writeFile(validPath, PNG_BYTES),
      writeFile(forgedPath, WEBP_BYTES)
    ]);

    await expect(new CharacterAssetService(charactersDirectory).importSources(
      'demo',
      [validPath, forgedPath]
    )).rejects.toThrow('CHARACTER_SOURCE_SIGNATURE_INVALID');
    await expect(readdir(join(characterDirectory, 'source'))).resolves.toEqual([]);
  });

  test('拒绝只有 magic 但缺少完整 PNG/WebP 结构的伪造图片', async () => {
    const brokenPng = join(selectedDirectory, 'broken.png');
    const brokenWebp = join(selectedDirectory, 'broken.webp');
    await Promise.all([
      writeFile(brokenPng, PNG_BYTES.subarray(0, 16)),
      writeFile(brokenWebp, WEBP_BYTES.subarray(0, 20))
    ]);
    const service = new CharacterAssetService(charactersDirectory);

    await expect(service.importSources('demo', [brokenPng]))
      .rejects.toThrow('CHARACTER_SOURCE_STRUCTURE_INVALID');
    await expect(service.importSources('demo', [brokenWebp]))
      .rejects.toThrow('CHARACTER_SOURCE_STRUCTURE_INVALID');
    await expect(readdir(join(characterDirectory, 'source'))).resolves.toEqual([]);
  });

  test.each(OVERSIZED_WEBP_FIXTURES)(
    '%s 源图接受真实 4097×1 WebP，重建服务后仍可读取和校验编译来源',
    async (branch, base64) => {
      const oversized = join(selectedDirectory, `${branch}.webp`);
      const bytes = Buffer.from(base64, 'base64');
      await writeFile(oversized, bytes);

      const [source] = await new CharacterAssetService(charactersDirectory)
        .importSources('demo', [oversized]);
      const reopened = new CharacterAssetService(charactersDirectory);
      expect(await reopened.listSources('demo')).toEqual([source]);
      expect(await reopened.readSource('demo', source!.assetId)).toEqual(new Uint8Array(bytes));
      await expect(reopened.saveCompiled('demo', {
        assetId: 'wide-source-atlas',
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      })).resolves.toBeUndefined();
      await expect(reopened.saveCompiled('demo', {
        assetId: 'oversized-atlas',
        mimeType: 'image/webp',
        bytes,
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      })).rejects.toThrow('CHARACTER_COMPILED_STRUCTURE_INVALID');
    },
    // 包含导入、重建读取与两次落盘校验；给 Windows 全量并行回归保留有限 I/O 余量。
    15_000
  );

  test('超过单批总数上限时在读取文件前拒绝', async () => {
    const selected = Array.from(
      { length: CHARACTER_RESOURCE_LIMITS.maxSourceFilesPerImport + 1 },
      (_, index) => join(selectedDirectory, `${index}.png`)
    );

    await expect(new CharacterAssetService(charactersDirectory).importSources(
      'demo',
      selected
    )).rejects.toThrow('CHARACTER_SOURCE_COUNT_EXCEEDED');
  });

  test('超过旧 32 MiB 的完整 WebP 可导入并在重建服务后校验读取', async () => {
    const oversized = join(selectedDirectory, 'oversized.webp');
    const bytes = webpBeyondPreviousByteLimit();
    await writeFile(oversized, bytes);

    const [source] = await new CharacterAssetService(charactersDirectory)
      .importSources('demo', [oversized]);
    expect(source!.byteLength).toBeGreaterThan(32 * 1024 * 1024);
    const reopened = new CharacterAssetService(charactersDirectory);
    expect(await reopened.listSources('demo')).toEqual([source]);
    const restored = await reopened.readSource('demo', source!.assetId);
    expect(restored.byteLength).toBe(bytes.byteLength);
    expect(sha256(restored)).toBe(sha256(bytes));
    await expect(reopened.saveCompiled('demo', {
      assetId: 'oversized-bytes-atlas',
      mimeType: 'image/webp',
      bytes,
      sourceChecksums: { [source!.assetId]: source!.sha256 }
    })).rejects.toThrow('CHARACTER_COMPILED_FILE_TOO_LARGE');
  });

  test('已有源目录超过旧 512 MiB 总量时仍可导入新素材', async () => {
    await writeSparseImage(
      join(characterDirectory, 'source', `${randomUUID()}.png`),
      512 * 1024 * 1024 + 1,
      PNG_BYTES.subarray(0, 8)
    );
    const selected = join(selectedDirectory, 'next.png');
    await writeFile(selected, PNG_BYTES);

    const [source] = await new CharacterAssetService(charactersDirectory)
      .importSources('demo', [selected]);
    expect(await new CharacterAssetService(charactersDirectory)
      .readSource('demo', source!.assetId)).toEqual(PNG_BYTES);
  });

  test('非法角色标识和不存在的角色均不能生成存储路径', async () => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const service = new CharacterAssetService(charactersDirectory);

    await expect(service.importSources('../escape', [selected]))
      .rejects.toThrow('CHARACTER_INVALID_ID');
    await expect(service.importSources('missing', [selected]))
      .rejects.toThrow('CHARACTER_NOT_FOUND');
    await expect(access(join(testDirectory, 'escape'))).rejects.toThrow();
  });

  test('拒绝选择项符号链接以及角色目录中的目录联接', async () => {
    const externalSelected = join(testDirectory, 'external-selected');
    const linkedDirectory = join(testDirectory, 'selected-linked');
    await mkdir(externalSelected);
    await writeFile(join(externalSelected, 'linked.png'), PNG_BYTES);
    await symlink(externalSelected, linkedDirectory, 'junction');
    const service = new CharacterAssetService(charactersDirectory);

    await expect(service.importSources('demo', [join(linkedDirectory, 'linked.png')]))
      .rejects.toThrow('CHARACTER_SOURCE_PATH_UNSAFE');

    const external = join(testDirectory, 'external');
    await mkdir(external);
    await rm(join(characterDirectory, 'source'), { recursive: true });
    await symlink(external, join(characterDirectory, 'source'), 'junction');
    await expect(service.readSource('demo', randomUUID()))
      .rejects.toThrow('CHARACTER_PATH_UNSAFE');
  });

  test('readSource 只接受内部 UUID，且返回值与错误均不泄露绝对路径', async () => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const service = new CharacterAssetService(charactersDirectory);
    const [source] = await service.importSources('demo', [selected]);

    await expect(service.readSource('demo', source!.assetId)).resolves.toEqual(PNG_BYTES);
    await expect(service.readSource('demo', '../selected/frame'))
      .rejects.toThrow('CHARACTER_ASSET_ID_INVALID');
    await expect(service.readSource('demo', randomUUID())).rejects.toSatisfy((error: unknown) => (
      error instanceof Error
      && error.message === 'CHARACTER_SOURCE_NOT_FOUND'
      && !error.message.includes(testDirectory)
    ));
  });

  test('source catalog 持久化完整元数据并可由新实例恢复', async () => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const firstService = new CharacterAssetService(charactersDirectory);
    const [imported] = await firstService.importSources('demo', [selected]);

    expect(imported).toEqual({
      assetId: expect.any(String),
      displayName: 'frame.png',
      mimeType: 'image/png',
      byteLength: PNG_BYTES.byteLength,
      sha256: sha256(PNG_BYTES)
    });
    await expect(new CharacterAssetService(charactersDirectory).listSources('demo'))
      .resolves.toEqual([imported]);

    const catalog = JSON.parse(await readFile(
      join(characterDirectory, 'source', 'catalog.json'),
      'utf8'
    )) as { version: number; characterId: string; sources: SourceCatalogEntry[] };
    expect(catalog).toEqual({
      version: 1,
      characterId: 'demo',
      sources: [imported]
    });
    expect(JSON.stringify(catalog)).not.toContain(testDirectory);
  });

  test('同一角色并发导入严格串行且不会丢失 catalog 条目', async () => {
    const first = join(selectedDirectory, 'first.png');
    const second = join(selectedDirectory, 'second.webp');
    await Promise.all([writeFile(first, PNG_BYTES), writeFile(second, WEBP_BYTES)]);
    let releaseFirstCommit!: () => void;
    const firstCommitBlocked = new Promise<void>(resolve => {
      releaseFirstCommit = resolve;
    });
    let firstReachedCommit!: () => void;
    const firstAtCommit = new Promise<void>(resolve => {
      firstReachedCommit = resolve;
    });
    let commitVisits = 0;
    const service = new CharacterAssetService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:before-commit') return;
        commitVisits += 1;
        if (commitVisits === 1) {
          firstReachedCommit();
          await firstCommitBlocked;
        }
      }
    });

    const firstImport = service.importSources('demo', [first]);
    await firstAtCommit;
    const secondImport = service.importSources('demo', [second]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(commitVisits).toBe(1);
    releaseFirstCommit();
    await Promise.all([firstImport, secondImport]);

    await expect(service.listSources('demo')).resolves.toEqual([
      expect.objectContaining({ displayName: 'first.png' }),
      expect.objectContaining({ displayName: 'second.webp' })
    ]);
  });

  test('同一进程中的两个 Service 实例共享角色队列且不会争用进程锁', async () => {
    const first = join(selectedDirectory, 'first.png');
    const second = join(selectedDirectory, 'second.webp');
    await Promise.all([writeFile(first, PNG_BYTES), writeFile(second, WEBP_BYTES)]);
    let releaseFirstCommit!: () => void;
    const firstCommitBlocked = new Promise<void>(resolve => {
      releaseFirstCommit = resolve;
    });
    let firstReachedCommit!: () => void;
    const firstAtCommit = new Promise<void>(resolve => {
      firstReachedCommit = resolve;
    });
    let commitVisits = 0;
    const dependencies: CharacterAssetServiceDependencies = {
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:before-commit') return;
        commitVisits += 1;
        if (commitVisits === 1) {
          firstReachedCommit();
          await firstCommitBlocked;
        }
      }
    };
    const firstService = new CharacterAssetService(charactersDirectory, dependencies);
    const secondService = new CharacterAssetService(charactersDirectory, dependencies);

    const firstImport = firstService.importSources('demo', [first]);
    await firstAtCommit;
    const secondImport = secondService.importSources('demo', [second]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(commitVisits).toBe(1);
    releaseFirstCommit();
    await Promise.all([firstImport, secondImport]);

    await expect(firstService.listSources('demo')).resolves.toEqual([
      expect.objectContaining({ displayName: 'first.png' }),
      expect.objectContaining({ displayName: 'second.webp' })
    ]);
  });

  test('create 后写 marker 前崩溃留下的空锁超过宽限期后可回收', async () => {
    const lockDirectory = join(charactersDirectory, '.locks');
    const lockFile = join(lockDirectory, 'demo.lock');
    const now = 10_000;
    await mkdir(lockDirectory);
    await writeFile(lockFile, '');
    await utimes(lockFile, new Date(now - 101), new Date(now - 101));

    await expect(new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockInitializationGraceMs: 100,
      lockLeaseMs: 1_000
    }).listSources('demo')).resolves.toEqual([]);
    await expect(access(lockFile)).rejects.toThrow();
  });

  test('截断 marker 在宽限期内 BUSY，超过宽限期后可原子回收', async () => {
    const lockDirectory = join(charactersDirectory, '.locks');
    const lockFile = join(lockDirectory, 'demo.lock');
    let now = 20_000;
    await mkdir(lockDirectory);
    await writeFile(lockFile, '{"version":1,"ownerToken":');
    await utimes(lockFile, new Date(now - 50), new Date(now - 50));
    const dependencies: CharacterAssetServiceDependencies = {
      now: () => now,
      lockInitializationGraceMs: 100,
      lockLeaseMs: 1_000
    };

    await expect(new CharacterAssetService(charactersDirectory, dependencies)
      .listSources('demo')).rejects.toThrow('CHARACTER_ASSET_BUSY');
    now += 51;
    await expect(new CharacterAssetService(charactersDirectory, dependencies)
      .listSources('demo'))
      .resolves.toEqual([]);
    await expect(access(lockFile)).rejects.toThrow();
  });

  test('PID 已复用但心跳租约过期时仍可回收', async () => {
    const lockDirectory = join(charactersDirectory, '.locks');
    const lockFile = join(lockDirectory, 'demo.lock');
    const now = 30_000;
    await mkdir(lockDirectory);
    await writeFile(
      lockFile,
      JSON.stringify(lockMarker(now, {
        pid: process.pid,
        createdAt: now - 2_000,
        heartbeatAt: now - 1_001
      })),
      'utf8'
    );

    await expect(new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000
    }).listSources('demo')).resolves.toEqual([]);
    await expect(access(lockFile)).rejects.toThrow();
  });

  test('活跃心跳租约即使 PID 不可探测也不会被偷锁', async () => {
    const lockDirectory = join(charactersDirectory, '.locks');
    const now = 40_000;
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'demo.lock'),
      JSON.stringify(lockMarker(now, {
        pid: 2_147_483_647,
        heartbeatAt: now - 999
      })),
      'utf8'
    );

    await expect(new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000
    }).listSources('demo')).rejects.toThrow('CHARACTER_ASSET_BUSY');
  });

  test('持有者按间隔续租并保留 createdAt', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    let now = 50_000;
    let heartbeat: (() => void) | undefined;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let reachedRead!: () => void;
    const readReached = new Promise<void>(resolve => {
      reachedRead = resolve;
    });
    const service = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000,
      lockHeartbeatIntervalMs: 100,
      scheduleLockHeartbeat(callback) {
        heartbeat = callback;
        return 1;
      },
      cancelLockHeartbeat() {},
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:list-before-read') return;
        reachedRead();
        await readBlocked;
      }
    });

    const operation = service.listSources('demo');
    await readReached;
    const initial = JSON.parse(await readFile(lockFile, 'utf8')) as {
      createdAt: number;
      heartbeatAt: number;
    };
    now += 100;
    heartbeat!();
    await new Promise(resolve => setTimeout(resolve, 20));
    const renewed = JSON.parse(await readFile(lockFile, 'utf8')) as {
      createdAt: number;
      heartbeatAt: number;
    };
    expect(renewed.createdAt).toBe(initial.createdAt);
    expect(renewed.heartbeatAt).toBe(now);
    releaseRead();
    await operation;
  });

  test('旧持有者 release 不删除替代持有者的锁', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    const now = 60_000;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let reachedRead!: () => void;
    const readReached = new Promise<void>(resolve => {
      reachedRead = resolve;
    });
    const replacement = lockMarker(now, { ownerToken: randomUUID() });
    const service = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000,
      lockHeartbeatIntervalMs: 500,
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:list-before-read') return;
        reachedRead();
        await readBlocked;
      }
    });

    const operation = service.listSources('demo');
    await readReached;
    await rm(lockFile);
    await writeFile(lockFile, JSON.stringify(replacement), 'utf8');
    releaseRead();

    await expect(operation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    await expect(readFile(lockFile, 'utf8')).resolves.toBe(JSON.stringify(replacement));
  });

  test('初始化空锁被回收后旧进程恢复不得进入业务操作或删除新 owner', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    const now = 70_000;
    let releaseInitialization!: () => void;
    const initializationBlocked = new Promise<void>(resolve => {
      releaseInitialization = resolve;
    });
    let reachedInitialization!: () => void;
    const initializationReached = new Promise<void>(resolve => {
      reachedInitialization = resolve;
    });
    let businessVisits = 0;
    const replacement = lockMarker(now, { ownerToken: randomUUID() });
    const service = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000,
      async onCheckpoint(checkpoint) {
        if (checkpoint === 'lock:after-create') {
          reachedInitialization();
          await initializationBlocked;
        }
        if (checkpoint === 'source:list-before-read') businessVisits += 1;
      }
    });

    const operation = service.listSources('demo');
    await initializationReached;
    await rename(lockFile, `${lockFile}.reclaimed`);
    await writeFile(lockFile, JSON.stringify(replacement), 'utf8');
    releaseInitialization();

    await expect(operation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    expect(businessVisits).toBe(0);
    await expect(readFile(lockFile, 'utf8')).resolves.toBe(JSON.stringify(replacement));
  });

  test('初始化原锁被隔离且替代锁尚未创建时稳定报告租约丢失', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    let releaseInitialization!: () => void;
    const initializationBlocked = new Promise<void>(resolve => {
      releaseInitialization = resolve;
    });
    let reachedInitialization!: () => void;
    const initializationReached = new Promise<void>(resolve => {
      reachedInitialization = resolve;
    });
    let businessVisits = 0;
    const service = new CharacterAssetService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint === 'lock:after-create') {
          reachedInitialization();
          await initializationBlocked;
        }
        if (checkpoint === 'source:list-before-read') businessVisits += 1;
      }
    });

    const operation = service.listSources('demo');
    await initializationReached;
    await rename(lockFile, `${lockFile}.reclaimed`);
    releaseInitialization();

    await expect(operation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    expect(businessVisits).toBe(0);
  });

  test('超过租约后才执行的心跳不得刷新 marker 或复活旧持有者', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    let now = 75_000;
    let heartbeat: (() => void) | undefined;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let reachedRead!: () => void;
    const readReached = new Promise<void>(resolve => {
      reachedRead = resolve;
    });
    const service = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000,
      lockHeartbeatIntervalMs: 100,
      scheduleLockHeartbeat(callback) {
        heartbeat = callback;
        return 1;
      },
      cancelLockHeartbeat() {},
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:list-before-read') return;
        reachedRead();
        await readBlocked;
      }
    });

    const operation = service.listSources('demo');
    await readReached;
    const initial = JSON.parse(await readFile(lockFile, 'utf8')) as {
      heartbeatAt: number;
    };
    now += 1_001;
    heartbeat!();
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterExpiredHeartbeat = JSON.parse(await readFile(lockFile, 'utf8')) as {
      heartbeatAt: number;
    };
    releaseRead();

    await expect(operation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    expect(afterExpiredHeartbeat.heartbeatAt).toBe(initial.heartbeatAt);
  });

  test('真实第二个 Service 接管 source 后旧回滚不得破坏新事务提交', async () => {
    const oldSelected = join(selectedDirectory, 'old-owner.png');
    const newSelected = join(selectedDirectory, 'new-owner.webp');
    await Promise.all([
      writeFile(oldSelected, PNG_BYTES),
      writeFile(newSelected, WEBP_BYTES)
    ]);
    let now = 90_000;
    let releaseOldCommit!: () => void;
    const oldCommitBlocked = new Promise<void>(resolve => {
      releaseOldCommit = resolve;
    });
    let reachedOldCommit!: () => void;
    const oldCommitReached = new Promise<void>(resolve => {
      reachedOldCommit = resolve;
    });
    const oldService = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 100,
      lockHeartbeatIntervalMs: 10,
      scheduleLockHeartbeat() {
        return 1;
      },
      cancelLockHeartbeat() {},
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:before-commit') return;
        reachedOldCommit();
        await oldCommitBlocked;
      }
    });

    const oldOperation = oldService.importSources('demo', [oldSelected]);
    await oldCommitReached;
    now += 101;
    const IndependentService = await loadIndependentCharacterAssetService();
    const newService = new IndependentService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 100,
      lockHeartbeatIntervalMs: 10,
      scheduleLockHeartbeat() {
        return 1;
      },
      cancelLockHeartbeat() {}
    });
    const [newSource] = await newService.importSources('demo', [newSelected]);
    releaseOldCommit();

    await expect(oldOperation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    const catalog = JSON.parse(await readFile(
      join(characterDirectory, 'source', 'catalog.json'),
      'utf8'
    )) as { sources: SourceCatalogEntry[] };
    expect(catalog.sources).toEqual([newSource]);
    expect(new Uint8Array(await readFile(join(
      characterDirectory,
      'source',
      `${newSource!.assetId}.webp`
    )))).toEqual(WEBP_BYTES);
    expect((await readdir(characterDirectory)).filter(name => (
      name.startsWith('.source-import-transaction')
    ))).toEqual([]);
  });

  test('真实第二个 Service 接管 compiled 后旧回滚不得破坏新事务提交', async () => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const setup = new CharacterAssetService(charactersDirectory);
    const [source] = await setup.importSources('demo', [selected]);
    const sourceChecksums = { [source!.assetId]: source!.sha256 };
    let now = 100_000;
    let releaseOldInstall!: () => void;
    const oldInstallBlocked = new Promise<void>(resolve => {
      releaseOldInstall = resolve;
    });
    let reachedOldInstall!: () => void;
    const oldInstallReached = new Promise<void>(resolve => {
      reachedOldInstall = resolve;
    });
    const oldService = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 100,
      lockHeartbeatIntervalMs: 10,
      scheduleLockHeartbeat() {
        return 1;
      },
      cancelLockHeartbeat() {},
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'compiled:before-install') return;
        reachedOldInstall();
        await oldInstallBlocked;
      }
    });

    const oldOperation = oldService.saveCompiled('demo', {
      assetId: 'old-owner-atlas',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums
    });
    await oldInstallReached;
    now += 101;
    const IndependentService = await loadIndependentCharacterAssetService();
    const newService = new IndependentService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 100,
      lockHeartbeatIntervalMs: 10,
      scheduleLockHeartbeat() {
        return 1;
      },
      cancelLockHeartbeat() {}
    });
    await newService.saveCompiled('demo', {
      assetId: 'new-owner-atlas',
      mimeType: 'image/webp',
      bytes: WEBP_BYTES,
      sourceChecksums
    });
    releaseOldInstall();

    await expect(oldOperation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    const catalog = JSON.parse(await readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    )) as {
      resources: Array<{ assetId: string; sha256: string }>;
    };
    expect(catalog.resources).toEqual([
      expect.objectContaining({
        assetId: 'new-owner-atlas',
        sha256: sha256(WEBP_BYTES)
      })
    ]);
    expect(new Uint8Array(await readFile(join(
      characterDirectory,
      'compiled',
      'new-owner-atlas.webp'
    )))).toEqual(WEBP_BYTES);
    expect((await readdir(characterDirectory)).filter(name => (
      name.startsWith('.compiled-save-transaction')
    ))).toEqual([]);
  });

  test('运行中锁被替换且心跳发现失锁后旧操作不得提交并回滚事务', async () => {
    const selected = join(selectedDirectory, 'frame.png');
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');
    let now = 80_000;
    let heartbeat: (() => void) | undefined;
    let releaseCommit!: () => void;
    const commitBlocked = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    let reachedCommit!: () => void;
    const commitReached = new Promise<void>(resolve => {
      reachedCommit = resolve;
    });
    const replacement = lockMarker(now, { ownerToken: randomUUID() });
    await writeFile(selected, PNG_BYTES);
    const service = new CharacterAssetService(charactersDirectory, {
      now: () => now,
      lockLeaseMs: 1_000,
      lockHeartbeatIntervalMs: 100,
      scheduleLockHeartbeat(callback) {
        heartbeat = callback;
        return 1;
      },
      cancelLockHeartbeat() {},
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'source:before-commit') return;
        reachedCommit();
        await commitBlocked;
      }
    });

    const operation = service.importSources('demo', [selected]);
    await commitReached;
    await rm(lockFile);
    await writeFile(lockFile, JSON.stringify(replacement), 'utf8');
    now += 100;
    heartbeat!();
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseCommit();

    await expect(operation).rejects.toThrow('CHARACTER_ASSET_LEASE_LOST');
    await expect(readdir(join(characterDirectory, 'source'))).resolves.toEqual([]);
    await expect(access(join(
      characterDirectory,
      '.source-import-transaction'
    ))).rejects.toThrow();
    await expect(readFile(lockFile, 'utf8')).resolves.toBe(JSON.stringify(replacement));
  });

  test('正常活跃租约持有者通过所有权栅栏并成功释放锁', async () => {
    const lockFile = join(charactersDirectory, '.locks', 'demo.lock');

    await expect(new CharacterAssetService(charactersDirectory).listSources('demo'))
      .resolves.toEqual([]);
    await expect(access(lockFile)).rejects.toThrow();
    await expect(access(join(
      characterDirectory,
      'source',
      'catalog.json'
    ))).resolves.toBeUndefined();
  });

  test('启动时回滚未提交的批次事务并恢复旧 catalog', async () => {
    const oldAssetId = randomUUID();
    const interruptedAssetId = randomUUID();
    const oldEntry: SourceCatalogEntry = {
      assetId: oldAssetId,
      displayName: 'old.png',
      mimeType: 'image/png',
      byteLength: PNG_BYTES.byteLength,
      sha256: sha256(PNG_BYTES)
    };
    await Promise.all([
      writeFile(join(characterDirectory, 'source', `${oldAssetId}.png`), PNG_BYTES),
      writeFile(join(characterDirectory, 'source', `${interruptedAssetId}.webp`), WEBP_BYTES)
    ]);
    await writeFile(
      join(characterDirectory, 'source', 'catalog.json'),
      JSON.stringify({ version: 1, characterId: 'demo', sources: [oldEntry] }),
      'utf8'
    );
    const transaction = join(characterDirectory, '.source-import-transaction');
    await mkdir(join(transaction, 'staged'), { recursive: true });
    await writeFile(
      join(transaction, 'previous-catalog.json'),
      JSON.stringify({ version: 1, characterId: 'demo', sources: [oldEntry] }),
      'utf8'
    );
    await writeFile(
      join(transaction, 'marker.json'),
      JSON.stringify({
        version: 1,
        phase: 'installing',
        hadCatalog: true,
        entries: [{
          assetId: interruptedAssetId,
          extension: '.webp'
        }]
      }),
      'utf8'
    );
    const orphanCatalogTemp = join(
      characterDirectory,
      'source',
      `catalog.json.${randomUUID()}.tmp`
    );
    await writeFile(orphanCatalogTemp, '{}', 'utf8');

    const service = new CharacterAssetService(charactersDirectory);
    await expect(service.listSources('demo')).resolves.toEqual([oldEntry]);
    await expect(access(join(
      characterDirectory,
      'source',
      `${interruptedAssetId}.webp`
    ))).rejects.toThrow();
    await expect(access(orphanCatalogTemp)).rejects.toThrow();
    await expect(access(transaction)).rejects.toThrow();
  });

  test.each([
    ['source', '.source-import-transaction'],
    ['compiled', '.compiled-save-transaction']
  ] as const)('%s 事务目录无 marker 时只清理事务且不触碰正式数据', async (
    kind,
    transactionName
  ) => {
    const officialDirectory = join(characterDirectory, kind);
    const officialFile = join(officialDirectory, 'keep.txt');
    const transaction = join(characterDirectory, transactionName);
    await writeFile(officialFile, '正式数据', 'utf8');
    await mkdir(join(transaction, 'staged'), { recursive: true });
    await writeFile(join(transaction, 'staged', 'junk.tmp'), '临时数据', 'utf8');

    await expect(new CharacterAssetService(charactersDirectory).listSources('demo'))
      .resolves.toEqual([]);
    await expect(readFile(officialFile, 'utf8')).resolves.toBe('正式数据');
    await expect(access(transaction)).rejects.toThrow();
  });

  test.each([
    ['source:after-temp-open', 'CHARACTER_SOURCE_IMPORT_FAILED'],
    ['compiled:after-temp-open', 'CHARACTER_COMPILED_SAVE_FAILED']
  ] as const)('临时文件打开后 %s 失败时关闭句柄并清理零字节文件', async (
    failingCheckpoint,
    expectedCode
  ) => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const setup = new CharacterAssetService(charactersDirectory);
    const [source] = await setup.importSources('demo', [selected]);
    const service = new CharacterAssetService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint === failingCheckpoint) throw fileSystemError(testDirectory);
      }
    });

    const operation = failingCheckpoint.startsWith('source:')
      ? service.importSources('demo', [selected])
      : service.saveCompiled('demo', {
          assetId: 'idle-main-atlas',
          mimeType: 'image/png',
          bytes: PNG_BYTES,
          sourceChecksums: { [source!.assetId]: source!.sha256 }
        });
    await expect(operation).rejects.toThrow(expectedCode);

    const transactionName = failingCheckpoint.startsWith('source:')
      ? '.source-import-transaction'
      : '.compiled-save-transaction';
    await expect(access(join(characterDirectory, transactionName))).rejects.toThrow();
  });

  test.each([
    ['source:list-before-read', 'listSources', 'CHARACTER_SOURCE_LIST_FAILED'],
    ['source:before-stage', 'importSources', 'CHARACTER_SOURCE_IMPORT_FAILED'],
    ['source:before-read', 'readSource', 'CHARACTER_SOURCE_READ_FAILED'],
    ['compiled:before-save', 'saveCompiled', 'CHARACTER_COMPILED_SAVE_FAILED']
  ] as const)('公开方法把 %s 文件系统错误映射为无路径稳定码', async (
    failingCheckpoint,
    method,
    expectedCode
  ) => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const setup = new CharacterAssetService(charactersDirectory);
    const [source] = await setup.importSources('demo', [selected]);
    const service = new CharacterAssetService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint === failingCheckpoint) throw fileSystemError(testDirectory);
      }
    });

    let operation: Promise<unknown>;
    if (method === 'listSources') operation = service.listSources('demo');
    else if (method === 'importSources') operation = service.importSources('demo', [selected]);
    else if (method === 'readSource') operation = service.readSource('demo', source!.assetId);
    else {
      operation = service.saveCompiled('demo', {
        assetId: 'idle-main-atlas',
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      });
    }

    await expect(operation).rejects.toSatisfy((cause: unknown) => (
      cause instanceof Error
      && cause.message === expectedCode
      && !cause.message.includes(testDirectory)
    ));
  });

  test.each([
    'source:before-commit',
    'source:before-read',
    'compiled:before-install'
  ] as const)('关键操作 %s 前后检测目录身份变化并拒绝 TOCTOU 联接替换', async checkpoint => {
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const setup = new CharacterAssetService(charactersDirectory);
    const [source] = await setup.importSources('demo', [selected]);
    const external = join(testDirectory, `external-${checkpoint.replaceAll(':', '-')}`);
    await mkdir(external);
    let replaced = false;
    const service = new CharacterAssetService(charactersDirectory, {
      async onCheckpoint(current) {
        if (current !== checkpoint || replaced) return;
        replaced = true;
        const child = current.startsWith('compiled:') ? 'compiled' : 'source';
        const original = join(characterDirectory, child);
        await rename(original, `${original}-original`);
        await symlink(external, original, 'junction');
      }
    });

    let operation: Promise<unknown>;
    if (checkpoint === 'source:before-commit') {
      operation = service.importSources('demo', [selected]);
    } else if (checkpoint === 'source:before-read') {
      operation = service.readSource('demo', source!.assetId);
    } else {
      operation = service.saveCompiled('demo', {
        assetId: 'idle-main-atlas',
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      });
    }

    await expect(operation).rejects.toThrow('CHARACTER_PATH_IDENTITY_CHANGED');
    await expect(readdir(external)).resolves.toEqual([]);
  });

  test('导入提交失败时清理批次临时文件和已提交文件', async () => {
    const first = join(selectedDirectory, 'first.png');
    const second = join(selectedDirectory, 'second.png');
    await Promise.all([writeFile(first, PNG_BYTES), writeFile(second, PNG_BYTES)]);
    let renameCount = 0;
    const dependencies: CharacterAssetServiceDependencies = {
      async renamePath(source, destination) {
        renameCount += 1;
        if (renameCount === 2) throw new Error('TEST_RENAME_FAILED');
        await rename(source, destination);
      }
    };

    await expect(new CharacterAssetService(
      charactersDirectory,
      dependencies
    ).importSources('demo', [first, second]))
      .rejects.toThrow('CHARACTER_SOURCE_IMPORT_FAILED');
    await expect(readdir(join(characterDirectory, 'source'))).resolves.toEqual([]);
  });

  test('saveCompiled 校验哈希后以内部名保存编译产物', async () => {
    const service = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await service.importSources('demo', [selected]);
    const bytes = PNG_BYTES;
    const assetId = 'idle-main-atlas';

    await service.saveCompiled('demo', {
      assetId,
      mimeType: 'image/png',
      bytes,
      sourceChecksums: { [source!.assetId]: source!.sha256 }
    });

    expect(new Uint8Array(
      await readFile(join(characterDirectory, 'compiled', `${assetId}.png`))
    )).toEqual(bytes);
    expect(await readdir(join(characterDirectory, 'compiled'))).toEqual([
      'catalog.json',
      `${assetId}.png`
    ].sort());
    const catalog = JSON.parse(await readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    )) as {
      characterId: string;
      resources: Array<{
        assetId: string;
        sha256: string;
        sourceChecksums: Record<string, string>;
      }>;
    };
    expect(catalog).toMatchObject({
      characterId: 'demo',
      resources: [{
        assetId,
        sha256: sha256(bytes),
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      }]
    });
  });

  test('saveCompiled 要求至少一个属于当前角色且哈希匹配的源资源', async () => {
    const service = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await service.importSources('demo', [selected]);

    await expect(service.saveCompiled('demo', {
      assetId: 'missing-source',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: {}
    })).rejects.toThrow('CHARACTER_COMPILED_SOURCE_REQUIRED');
    await expect(service.saveCompiled('demo', {
      assetId: 'source-mismatch',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: { [source!.assetId]: '0'.repeat(64) }
    })).rejects.toThrow('CHARACTER_COMPILED_SOURCE_MISMATCH');
    await expect(service.saveCompiled('demo', {
      assetId: 'source-foreign',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: { [randomUUID()]: sha256(PNG_BYTES) }
    })).rejects.toThrow('CHARACTER_COMPILED_SOURCE_NOT_FOUND');
    await expect(readdir(join(characterDirectory, 'compiled'))).resolves.toEqual([]);
  });

  test('saveCompiled 首次写拒绝既有 ID，覆盖要求 expectedPreviousSha256 匹配', async () => {
    const service = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await service.importSources('demo', [selected]);
    const firstBytes = PNG_BYTES;
    const nextBytes = WEBP_BYTES;
    const assetId = 'idle-main-atlas';
    const sourceChecksums = { [source!.assetId]: source!.sha256 };
    await service.saveCompiled('demo', {
      assetId,
      mimeType: 'image/png',
      bytes: firstBytes,
      sourceChecksums
    });

    await expect(service.saveCompiled('demo', {
      assetId,
      mimeType: 'image/webp',
      bytes: nextBytes,
      sourceChecksums
    })).rejects.toThrow('CHARACTER_COMPILED_CONFLICT');
    await expect(service.saveCompiled('demo', {
      assetId,
      mimeType: 'image/webp',
      bytes: nextBytes,
      expectedPreviousSha256: '0'.repeat(64),
      sourceChecksums
    })).rejects.toThrow('CHARACTER_COMPILED_CONFLICT');

    await service.saveCompiled('demo', {
      assetId,
      mimeType: 'image/webp',
      bytes: nextBytes,
      expectedPreviousSha256: sha256(firstBytes),
      sourceChecksums
    });
    await expect(access(join(
      characterDirectory,
      'compiled',
      `${assetId}.png`
    ))).rejects.toThrow();
    expect(new Uint8Array(await readFile(join(
      characterDirectory,
      'compiled',
      `${assetId}.webp`
    )))).toEqual(nextBytes);
  });

  test('saveCompiled 已取消或提交失败时保留旧资源与 catalog', async () => {
    const assetId = 'idle-main-atlas';
    const setup = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await setup.importSources('demo', [selected]);
    const sourceChecksums = { [source!.assetId]: source!.sha256 };
    await setup.saveCompiled('demo', {
      assetId,
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums
    });
    const oldCatalog = await readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    );
    const controller = new AbortController();
    controller.abort();
    await expect(setup.saveCompiled('demo', {
      assetId: 'cancelled',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums,
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });

    const dependencies: CharacterAssetServiceDependencies = {
      async onCheckpoint(checkpoint) {
        if (checkpoint === 'compiled:before-install') {
          throw fileSystemError(testDirectory);
        }
      }
    };

    await expect(new CharacterAssetService(
      charactersDirectory,
      dependencies
    ).saveCompiled('demo', {
      assetId,
      mimeType: 'image/webp',
      bytes: WEBP_BYTES,
      expectedPreviousSha256: sha256(PNG_BYTES),
      sourceChecksums
    })).rejects.toThrow('CHARACTER_COMPILED_SAVE_FAILED');

    expect(new Uint8Array(
      await readFile(join(characterDirectory, 'compiled', `${assetId}.png`))
    )).toEqual(PNG_BYTES);
    await expect(readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    )).resolves.toBe(oldCatalog);
    expect(await readdir(join(characterDirectory, 'compiled'))).toEqual([
      'catalog.json',
      `${assetId}.png`
    ].sort());
  });

  test('启动时回滚中断的 compiled 覆盖事务并恢复旧资源与 catalog', async () => {
    const assetId = 'idle-main-atlas';
    const setup = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await setup.importSources('demo', [selected]);
    await setup.saveCompiled('demo', {
      assetId,
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: { [source!.assetId]: source!.sha256 }
    });
    const oldCatalog = await readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    );
    const transaction = join(characterDirectory, '.compiled-save-transaction');
    await mkdir(transaction);
    await rename(
      join(characterDirectory, 'compiled', `${assetId}.png`),
      join(transaction, 'previous-resource')
    );
    await writeFile(
      join(characterDirectory, 'compiled', `${assetId}.webp`),
      WEBP_BYTES
    );
    await writeFile(
      join(transaction, 'previous-catalog.json'),
      oldCatalog,
      'utf8'
    );
    await writeFile(
      join(transaction, 'marker.json'),
      JSON.stringify({
        version: 1,
        phase: 'installed',
        hadCatalog: true,
        assetId,
        previousExtension: '.png',
        nextExtension: '.webp'
      }),
      'utf8'
    );

    await new CharacterAssetService(charactersDirectory).listSources('demo');
    expect(new Uint8Array(await readFile(join(
      characterDirectory,
      'compiled',
      `${assetId}.png`
    )))).toEqual(PNG_BYTES);
    await expect(access(join(
      characterDirectory,
      'compiled',
      `${assetId}.webp`
    ))).rejects.toThrow();
    await expect(readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    )).resolves.toBe(oldCatalog);
    await expect(access(transaction)).rejects.toThrow();
  });

  test('compiled 旧资源已移入备份但阶段标记未更新时仍可恢复', async () => {
    const assetId = 'idle-main-atlas';
    const setup = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await setup.importSources('demo', [selected]);
    await setup.saveCompiled('demo', {
      assetId,
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: { [source!.assetId]: source!.sha256 }
    });
    const oldCatalog = await readFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      'utf8'
    );
    const transaction = join(characterDirectory, '.compiled-save-transaction');
    await mkdir(transaction);
    await rename(
      join(characterDirectory, 'compiled', `${assetId}.png`),
      join(transaction, 'previous-resource')
    );
    await writeFile(
      join(transaction, 'previous-catalog.json'),
      oldCatalog,
      'utf8'
    );
    await writeFile(
      join(transaction, 'marker.json'),
      JSON.stringify({
        version: 1,
        phase: 'prepared',
        hadCatalog: true,
        assetId,
        previousExtension: '.png',
        nextExtension: '.webp'
      }),
      'utf8'
    );

    await new CharacterAssetService(charactersDirectory).listSources('demo');
    expect(new Uint8Array(await readFile(join(
      characterDirectory,
      'compiled',
      `${assetId}.png`
    )))).toEqual(PNG_BYTES);
    await expect(access(transaction)).rejects.toThrow();
  });

  test('saveCompiled 按角色编译资源总配额拒绝超限', async () => {
    const service = new CharacterAssetService(charactersDirectory);
    const selected = join(selectedDirectory, 'frame.png');
    await writeFile(selected, PNG_BYTES);
    const [source] = await service.importSources('demo', [selected]);
    const resources = [];
    for (let index = 0; index < 16; index += 1) {
      const assetId = `existing-${index}`;
      await writeSparseImage(
        join(characterDirectory, 'compiled', `${assetId}.png`),
        CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile,
        PNG_BYTES.subarray(0, 8)
      );
      resources.push({
        assetId,
        mimeType: 'image/png',
        byteLength: CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile,
        sha256: '0'.repeat(64),
        sourceChecksums: { [source!.assetId]: source!.sha256 }
      });
    }
    await writeFile(
      join(characterDirectory, 'compiled', 'catalog.json'),
      JSON.stringify({ version: 1, characterId: 'demo', resources }),
      'utf8'
    );

    await expect(service.saveCompiled('demo', {
      assetId: 'over-limit',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
      sourceChecksums: { [source!.assetId]: source!.sha256 }
    })).rejects.toThrow('CHARACTER_COMPILED_TOTAL_BYTES_EXCEEDED');
  });
});
