import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(new URL('../scripts/verify-production-mcp-boundary.mjs', import.meta.url));
const temporaryRoots: string[] = [];
/**
 * Windows 读取失败夹具通过环境变量传递路径，避免命令行转义与公开参数泄露；只有
 * FileShare.None 成功并 flush 固定 LOCKED 信号后才启动 verifier。测试 finally 会先
 * 请求正常关闭，再按有界时限强制终止并等待退出，确保独占句柄和子进程均不残留。
 */
const fileLockScript = String.raw`
$path = [Environment]::GetEnvironmentVariable('AI_PET_TEST_LOCK_FILE', 'Process')
$stream = [System.IO.File]::Open(
  $path,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  $stream.Dispose()
}`;

const forbiddenMarkers = [
  ['main', '@modelcontextprotocol/sdk'],
  ['main', 'McpManager'],
  ['main', 'McpServerStore'],
  ['main', 'MCP_MODULE_DISABLED'],
  ['main', 'settings:mcp-'],
  ['preload', 'settings:mcp-'],
  ['preload', 'upsertMcpServer'],
  ['preload', 'confirmMcpLaunch'],
  ['preload', 'testMcpServer'],
  ['preload', 'setMcpServerEnabled'],
  ['preload', 'setMcpToolEnabled'],
  ['preload', 'authorizeMcpToolReadOnly'],
  ['preload', 'revokeMcpToolReadOnly'],
  ['preload', 'deleteMcpServer'],
  ['renderer', 'upsertMcpServer'],
  ['renderer', 'MCP 服务'],
  ['renderer', '.mcp-server']
] as const;

async function createOutputFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-pet-production-mcp-boundary-'));
  temporaryRoots.push(root);
  await Promise.all(
    ['main', 'preload', 'renderer'].map(kind => mkdir(join(root, kind), { recursive: true }))
  );
  return root;
}

async function runVerifier(root: string) {
  const result = await execFileAsync(process.execPath, [verifier, root]);
  return { code: 0, stdout: result.stdout, stderr: result.stderr };
}

async function waitForLockedSignal(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveLocked, rejectLocked) => {
    let stdout = '';
    const timeout = setTimeout(() => finish(new Error('FILE_LOCK_SIGNAL_TIMEOUT')), 5_000);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.split(/\r?\n/u).includes('LOCKED')) finish();
    };
    const onExit = () => finish(new Error('FILE_LOCK_PROCESS_EXITED'));
    const onError = () => finish(new Error('FILE_LOCK_PROCESS_FAILED'));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error === undefined) resolveLocked();
      else rejectLocked(error);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>(resolveExit => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const finish = (exited: boolean) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolveExit(exited);
    };
    child.once('exit', onExit);
  });
}

async function stopFileLock(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end('RELEASE\n');
  if (await waitForProcessExit(child, 2_000)) return;
  child.kill();
  if (!await waitForProcessExit(child, 2_000)) throw new Error('FILE_LOCK_PROCESS_EXIT_TIMEOUT');
}

async function lockFileExclusively(file: string): Promise<ChildProcessWithoutNullStreams> {
  const powershell = join(
    process.env.WINDIR!,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const child = spawn(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    fileLockScript
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AI_PET_TEST_LOCK_FILE: file }
  });
  child.stderr.resume();
  try {
    await waitForLockedSignal(child);
    return child;
  } catch (error) {
    await stopFileLock(child);
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MCP 正式产物边界校验器', () => {
  test('允许不含禁止标记的完整产物目录', async () => {
    const root = await createOutputFixture();
    await writeFile(join(root, 'main', 'index.js'), 'const feature = "chat";', 'utf8');

    await expect(runVerifier(root)).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test.each(forbiddenMarkers)('%s 产物拒绝单一标记 %s', async (kind, marker) => {
    const root = await createOutputFixture();
    await writeFile(join(root, kind, 'chunk.js'), marker, 'utf8');

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `MCP_PRODUCTION_BOUNDARY_FAILED ${kind} ${marker}\n`
    });
  });

  test('递归拒绝嵌套产物中的禁止标记', async () => {
    const root = await createOutputFixture();
    const nestedDirectory = join(root, 'main', 'assets');
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, 'chunk.js'), 'McpManager', 'utf8');

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'MCP_PRODUCTION_BOUNDARY_FAILED main McpManager\n'
    });
  });

  test('产物根不可访问时脱敏并 fail-closed', async () => {
    const root = await createOutputFixture();
    await rm(root, { recursive: true, force: true });

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'MCP_PRODUCTION_BOUNDARY_FAILED root IO_ERROR\n'
    });
  });

  test.each(['main', 'preload', 'renderer'] as const)(
    '%s 产物目录不可访问时脱敏并 fail-closed',
    async kind => {
      const root = await createOutputFixture();
      await rm(join(root, kind), { recursive: true, force: true });

      await expect(runVerifier(root)).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: `MCP_PRODUCTION_BOUNDARY_FAILED ${kind} IO_ERROR\n`
      });
    }
  );

  test('二进制噪声中的 UTF-8 禁止标记仍会被拒绝', async () => {
    const root = await createOutputFixture();
    const source = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from('MCP 服务', 'utf8'),
      Buffer.from([0x80, 0x81])
    ]);
    await writeFile(join(root, 'renderer', 'chunk.bin'), source);

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'MCP_PRODUCTION_BOUNDARY_FAILED renderer MCP 服务\n'
    });
  });

  test.skipIf(process.platform !== 'win32')(
    '普通产物读取失败时脱敏并 fail-closed',
    async () => {
      const root = await createOutputFixture();
      const lockedFile = join(root, 'main', 'locked.js');
      await writeFile(lockedFile, 'const feature = "chat";', 'utf8');
      let fileLock: ChildProcessWithoutNullStreams | undefined;

      try {
        fileLock = await lockFileExclusively(lockedFile);
        await expect(runVerifier(root)).rejects.toMatchObject({
          code: 1,
          stdout: '',
          stderr: 'MCP_PRODUCTION_BOUNDARY_FAILED main IO_ERROR\n'
        });
      } finally {
        await stopFileLock(fileLock);
      }
    },
    10_000
  );
});
