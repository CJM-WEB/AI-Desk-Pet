import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { expect, test } from 'vitest';
import { Ripgrep } from '@opencode-ai/core/ripgrep';
import { RipgrepBinary } from '@opencode-ai/core/ripgrep/binary';
import { CrossSpawnSpawner } from '@opencode-ai/core/cross-spawn-spawner';
import { LayerNode } from '@opencode-ai/core/effect/layer-node';
import { HostBoundary } from '@opencode-ai/core/location-mutation';
import { checkTaskPath } from '../src/host-boundary';
import { verifyExecutable } from '../src/trusted-executable';
import { windowsJobLayer } from '../src/windows-job-spawner';
import { protectedSearchGlobs } from '../../file-tools/src/path-policy';
import { helper, ripgrepExecutable } from './windows-fixture';

test('最终搜索边界复核显式文件，真实 rg 不读取私有链接目标', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet-grep-boundary-'));
  const trusted = await ripgrepExecutable();
  const nonce = `private-nonce-${randomUUID()}`;
  const layer = LayerNode.compile(Ripgrep.node, [
    [CrossSpawnSpawner.node, windowsJobLayer(await helper())],
    [RipgrepBinary.node, Layer.succeed(RipgrepBinary.Service, { filepath: Effect.tryPromise(() => verifyExecutable(trusted)) })],
  ]).pipe(Layer.provide(Layer.succeed(HostBoundary, {
    checkPath: path => checkTaskPath(directory, path), searchExclusions: protectedSearchGlobs,
    commandShell: '', commandResource: () => '', trashFile: async () => { throw new Error('不适用'); },
  })));
  try {
    await mkdir(join(directory, '.codex')); await writeFile(join(directory, '.codex/secret.txt'), nonce);
    await writeFile(join(directory, 'ordinary.txt'), 'ordinary-nonce');
    // 先确认同一个真实进程与搜索入口可读取普通文件，再替换为私有文件链接。
    const search = () => Effect.runPromise(Ripgrep.Service.use(rg => rg.grep({ cwd: directory, file: 'ordinary.txt', pattern: 'nonce', limit: 10 })).pipe(Effect.provide(layer)));
    expect(JSON.stringify(await search())).toContain('ordinary-nonce');
    await rm(join(directory, 'ordinary.txt')); await symlink(join(directory, '.codex/secret.txt'), join(directory, 'ordinary.txt'), 'file');
    const result = await search().then(value => ({ value }), error => ({ error }));
    expect(JSON.stringify(result)).not.toContain(nonce);
    expect(result).toHaveProperty('error');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
