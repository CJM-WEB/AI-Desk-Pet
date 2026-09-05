import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Global } from '@opencode-ai/core/global';
import { ManagedRuntime } from 'effect';
import { createCodingSession } from '../src/index';

vi.mock('effect', async importOriginal => {
  const actual = await importOriginal<typeof import('effect')>();
  return { ...actual, ManagedRuntime: { ...actual.ManagedRuntime, make: vi.fn(actual.ManagedRuntime.make) } };
});

afterEach(() => vi.restoreAllMocks());
test('初始化失败仍删除本实例临时目录并保留原错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-init-')); const failure = new Error('初始化故障');
  vi.spyOn(Global, 'initialize').mockRejectedValueOnce(failure);
  try {
    await expect(createCodingSession({ directory, dataDirectory: directory, approvedCommands: [], model: { baseUrl: 'http://127.0.0.1:1', modelId: 'fixture', contextWindow: 8192, outputTokens: 1024, readCredential: async () => '' }, onEvent: () => undefined })).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dispose 失败仍清理目录，重复 close 保留首次失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task-dispose-')); const failure = new Error('释放故障');
  const original = (await vi.importActual<typeof import('effect')>('effect')).ManagedRuntime.make;
  vi.spyOn(ManagedRuntime, 'make').mockImplementation((...args) => {
    const runtime = original(...args); const dispose = runtime.dispose;
    return { ...runtime, dispose: async () => { await dispose(); throw failure; } };
  });
  try {
    const session = await createCodingSession({ directory, dataDirectory: directory, approvedCommands: [], model: { baseUrl: 'http://127.0.0.1:1', modelId: 'fixture', contextWindow: 8192, outputTokens: 1024, readCredential: async () => '' }, onEvent: () => undefined });
    await expect(session.close()).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    await expect(session.close()).rejects.toBe(failure);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
