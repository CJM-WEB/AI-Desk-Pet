import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ripgrep-prepare-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source', 'fixture');
  await mkdir(source, { recursive: true });
  const files = {
    'rg.exe': Buffer.from('fixture executable'),
    COPYING: Buffer.from('fixture copying'),
    'LICENSE-MIT': Buffer.from('fixture mit'),
    UNLICENSE: Buffer.from('fixture unlicense')
  };
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(source, name), value)));
  const archive = join(root, 'fixture.zip');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '& { param($source, $destination) Compress-Archive -LiteralPath $source -DestinationPath $destination }',
    join(root, 'source', 'fixture'),
    archive
  ]);
  const archiveBytes = await readFile(archive);
  const manifest = join(root, 'manifest.json');
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    repository: 'https://example.invalid/repository',
    releaseTag: 'fixture-v1',
    tagObject: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    archive: {
      url: 'http://127.0.0.1:9/unreachable.zip',
      file: 'fixture.zip',
      size: archiveBytes.length,
      sha256: sha256(archiveBytes),
      root: 'fixture/'
    },
    files: Object.entries(files).map(([name, value]) => ({
      archivePath: `fixture/${name}`,
      outputPath: name === 'rg.exe' ? 'rg.exe' : `ripgrep-licenses/${name}`,
      size: value.length,
      sha256: sha256(value),
      kind: name === 'rg.exe' ? 'executable' : 'license'
    }))
  }, null, 2)}\n`, 'utf8');
  return {
    root,
    archive,
    manifest,
    cache: join(root, 'cache', 'fixture.zip'),
    output: join(root, 'dist'),
    archiveSize: archiveBytes.length,
    files
  };
}

async function prepare(arguments_: string[]) {
  return execFileAsync(process.execPath, [
    resolve(import.meta.dirname, '../prepare-ripgrep.cjs'),
    ...arguments_
  ]);
}

test.runIf(process.platform === 'win32')('固定归档准备后可离线重复并恢复被篡改的输出', async () => {
  const f = await createFixture();
  await prepare([
    '--manifest', f.manifest,
    '--cache', f.cache,
    '--output', f.output,
    '--archive', f.archive,
    '--offline'
  ]);

  expect(await readFile(join(f.output, 'rg.exe'))).toEqual(f.files['rg.exe']);
  expect(await readFile(join(f.output, 'ripgrep-licenses', 'LICENSE-MIT')))
    .toEqual(f.files['LICENSE-MIT']);
  expect(JSON.parse(await readFile(join(f.output, 'ripgrep.json'), 'utf8'))).toEqual({
    file: 'rg.exe',
    sha256: sha256(f.files['rg.exe'])
  });

  await writeFile(join(f.output, 'rg.exe'), 'tampered output');
  await prepare([
    '--manifest', f.manifest,
    '--cache', f.cache,
    '--output', f.output,
    '--offline'
  ]);
  expect(await readFile(join(f.output, 'rg.exe'))).toEqual(f.files['rg.exe']);
});

test.runIf(process.platform === 'win32')('离线模式拒绝缺失或篡改的缓存且不尝试联网', async () => {
  const missing = await createFixture();
  await expect(prepare([
    '--manifest', missing.manifest,
    '--cache', missing.cache,
    '--output', missing.output,
    '--offline'
  ])).rejects.toMatchObject({ stderr: expect.stringContaining('RIPGREP_ARCHIVE_UNAVAILABLE_OFFLINE') });

  const tampered = await createFixture();
  await mkdir(join(tampered.root, 'cache'), { recursive: true });
  await writeFile(tampered.cache, Buffer.alloc(tampered.archiveSize, 1));
  await expect(prepare([
    '--manifest', tampered.manifest,
    '--cache', tampered.cache,
    '--output', tampered.output,
    '--offline'
  ])).rejects.toMatchObject({ stderr: expect.stringContaining('RIPGREP_ARCHIVE_HASH_MISMATCH') });
});
