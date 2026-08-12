import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';

import { PowerShellTool } from '../src/main/agent/powershell-tool';

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor(readonly pid = 4242) {
    super();
  }

  writeStdout(value: string | Buffer): void {
    this.stdout.write(value);
  }

  writeStderr(value: string | Buffer): void {
    this.stderr.write(value);
  }

  finish(exitCode: number | null): void {
    this.emit('close', exitCode);
  }
}

function createFixture(overrides: {
  now?: () => number;
  confirmationTtlMs?: number;
  environment?: NodeJS.ProcessEnv;
  cleanupTimeoutMs?: number;
  killTree?: () => Promise<void>;
} = {}) {
  const child = new FakeProcess();
  const processPort = {
    spawn: vi.fn(() => child),
    killTree: vi.fn(overrides.killTree ?? (async () => undefined))
  };
  const tool = new PowerShellTool({
    processPort,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.confirmationTtlMs === undefined
      ? {}
      : { confirmationTtlMs: overrides.confirmationTtlMs }),
    ...(overrides.cleanupTimeoutMs === undefined
      ? {}
      : { cleanupTimeoutMs: overrides.cleanupTimeoutMs }),
    environment: overrides.environment ?? {
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      API_KEY: 'secret-value',
      Authorization: 'Bearer secret-value',
      MY_APP_TOKEN: 'secret-value'
    }
  });
  return { tool, child, processPort };
}

function preview(tool: PowerShellTool, command = 'Get-ChildItem') {
  return tool.preview({
    command,
    workingDirectory: 'C:\\authorized-root',
    workingDirectoryLabel: '已授权目录',
    generation: 'generation-1'
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PowerShellTool', () => {
  test('确认后以固定前台 argv、授权 cwd 和脱敏白名单环境启动', async () => {
    const { tool, child, processPort } = createFixture();
    const action = preview(tool);
    const execution = tool.execute(action, new AbortController().signal);

    expect(processPort.spawn).toHaveBeenCalledWith({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem'],
      cwd: 'C:\\authorized-root',
      env: {
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        TEMP: 'C:\\Temp',
        TMP: 'C:\\Temp'
      },
      shell: false
    });

    child.writeStdout('output');
    child.writeStderr('warning');
    child.finish(0);

    await expect(execution).resolves.toEqual({
      ok: true,
      toolName: 'powershell',
      status: 'succeeded',
      timeoutKind: null,
      exitCode: 0,
      stdout: 'output',
      stderr: 'warning',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: expect.any(Number)
    });
  });

  test('分别截断两个输出流并真实返回非零退出码', async () => {
    const { tool, child } = createFixture();
    const execution = tool.execute(preview(tool), new AbortController().signal);
    const oversized = 'x'.repeat(256 * 1024 + 16);

    child.writeStdout(oversized);
    child.writeStderr(oversized);
    child.finish(7);

    await expect(execution).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      exitCode: 7,
      stdout: 'x'.repeat(256 * 1024),
      stderr: 'x'.repeat(256 * 1024),
      stdoutTruncated: true,
      stderrTruncated: true
    });
  });

  test('多字节 UTF-8 输出在边界处不会超过 256 KiB', async () => {
    const { tool, child } = createFixture();
    const execution = tool.execute(preview(tool), new AbortController().signal);

    child.writeStdout('x'.repeat(256 * 1024 - 1));
    child.writeStdout('é');
    child.finish(0);

    const result = await execution;
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(256 * 1024 - 1);
    expect(result.stdoutTruncated).toBe(true);
  });

  test('stdout 与 stderr 跨 Buffer 的 UTF-8 字符保持完整', async () => {
    const { tool, child } = createFixture();
    const execution = tool.execute(preview(tool), new AbortController().signal);

    child.writeStdout(Buffer.from([0xc3]));
    child.writeStderr(Buffer.from([0xc3]));
    child.writeStdout(Buffer.from([0xa9]));
    child.writeStderr(Buffer.from([0xa9]));
    child.finish(0);

    await expect(execution).resolves.toMatchObject({ stdout: 'é', stderr: 'é' });
  });

  test.each([
    'Start-Process script.ps1 -Verb RunAs',
    'runas.exe /user:Administrator cmd.exe',
    'Get-Credential',
    'cmdkey /list',
    'vaultcmd /listcreds',
    'Remove-Item C:\\work -Recurse -Force'
  ])('预览拒绝直接可识别的高风险命令：%s', command => {
    const { tool } = createFixture();
    expect(() => preview(tool, command)).toThrow('POWERSHELL_COMMAND_REJECTED');
  });

  test.each([
    "Write-Output 'Get-Credential'",
    'Write-Output "runas.exe"',
    'Get-Help Get-Credential',
    '# vaultcmd'
  ])('展示、帮助或注释中的 %s 仍进入逐次确认', command => {
    const { tool } = createFixture();
    expect(preview(tool, command)).toMatchObject({ command, kind: 'powershell' });
  });

  test.each([
    "& 'Get-Credential'",
    "& 'runas.exe'",
    'Write-Output $(Get-Credential)',
    '{ Remove-Item C:\\work -Recurse -Force }'
  ])('预览拒绝嵌套或静态调用的高风险命令：%s', command => {
    const { tool } = createFixture();
    expect(() => preview(tool, command)).toThrow('POWERSHELL_COMMAND_REJECTED');
  });

  test.each([
    'cmdkey.exe /list',
    'vaultcmd.exe /listcreds',
    'C:\\Windows\\System32\\runas.exe /user:Administrator cmd.exe',
    "& 'C:\\Windows\\System32\\runas.exe' /user:Administrator cmd.exe",
    'Microsoft.PowerShell.Security\\Get-Credential'
  ])('预览拒绝等价的静态高风险命令名：%s', command => {
    const { tool } = createFixture();
    expect(() => preview(tool, command)).toThrow('POWERSHELL_COMMAND_REJECTED');
  });

  test('未知 token 不会被本地解析器误拒绝，仍产生一次确认动作', () => {
    const { tool, processPort } = createFixture();
    const action = preview(tool, 'Invoke-UnknownVendorTool -Feature experimental');

    expect(action).toMatchObject({
      kind: 'powershell',
      command: 'Invoke-UnknownVendorTool -Feature experimental',
      workingDirectoryLabel: '已授权目录',
      runMode: 'foreground',
      generation: 'generation-1'
    });
    expect(processPort.spawn).not.toHaveBeenCalled();
  });

  test('克隆、过期或已消费的确认不能启动进程', async () => {
    let now = 1_000;
    const { tool, child, processPort } = createFixture({
      now: () => now,
      confirmationTtlMs: 100
    });
    const action = preview(tool);

    expect(() => tool.execute({ ...action }, new AbortController().signal)).toThrow('ACTION_EXPIRED');
    expect(processPort.spawn).not.toHaveBeenCalled();

    now = 1_100;
    expect(() => tool.execute(action, new AbortController().signal)).toThrow('ACTION_EXPIRED');
    expect(processPort.spawn).not.toHaveBeenCalled();

    const current = preview(tool);
    const execution = tool.execute(current, new AbortController().signal);
    child.finish(0);
    await expect(execution).resolves.toMatchObject({ status: 'succeeded' });
    expect(() => tool.execute(current, new AbortController().signal)).toThrow('ACTION_EXPIRED');
  });

  test('Abort、静默超时、总超时和 close 都通过同一终止路径收敛，且迟到事件无效', async () => {
    vi.useFakeTimers();
    try {
      const abortFixture = createFixture();
      const abortController = new AbortController();
      const abortRun = abortFixture.tool.execute(preview(abortFixture.tool), abortController.signal);
      abortController.abort();
      await expect(abortRun).resolves.toMatchObject({ status: 'cancelled', timeoutKind: null });
      expect(abortFixture.child.kill).toHaveBeenCalledTimes(1);
      expect(abortFixture.processPort.killTree).toHaveBeenCalledWith(4242);
      abortFixture.child.writeStdout('late');
      abortFixture.child.finish(0);

      const idleFixture = createFixture();
      const idleRun = idleFixture.tool.execute(preview(idleFixture.tool), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(idleRun).resolves.toMatchObject({ status: 'timed_out', timeoutKind: 'idle' });
      expect(idleFixture.child.kill).toHaveBeenCalledTimes(1);

      const totalFixture = createFixture();
      const totalRun = totalFixture.tool.execute(preview(totalFixture.tool), new AbortController().signal);
      for (let elapsed = 0; elapsed < 9; elapsed += 1) {
        await vi.advanceTimersByTimeAsync(59_000);
        totalFixture.child.writeStdout('activity');
      }
      await vi.advanceTimersByTimeAsync(59_000);
      totalFixture.child.writeStdout('activity');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(totalRun).resolves.toMatchObject({ status: 'timed_out', timeoutKind: 'total' });
      expect(totalFixture.child.kill).toHaveBeenCalledTimes(1);

      const closeFixture = createFixture();
      const closeRun = closeFixture.tool.execute(preview(closeFixture.tool), new AbortController().signal);
      const firstClose = closeFixture.tool.close();
      const secondClose = closeFixture.tool.close();
      expect(secondClose).toBe(firstClose);
      await firstClose;
      await expect(closeRun).resolves.toMatchObject({ status: 'cancelled', timeoutKind: null });
      expect(closeFixture.child.kill).toHaveBeenCalledTimes(1);
      closeFixture.child.writeStderr('late');
      closeFixture.child.finish(1);
      await flush();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(['abort', 'idle', 'total', 'close'] as const)(
    'taskkill 清理永不返回时，%s 仍在有界等待后收敛',
    async reason => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const fixture = createFixture({
          cleanupTimeoutMs: 100,
          killTree: () => new Promise<void>(() => undefined)
        });
        const run = fixture.tool.execute(preview(fixture.tool), controller.signal);
        let settled = false;
        void run.then(() => { settled = true; });

        if (reason === 'abort') controller.abort();
        if (reason === 'idle') await vi.advanceTimersByTimeAsync(60_000);
        if (reason === 'total') {
          for (let elapsed = 0; elapsed < 9; elapsed += 1) {
            await vi.advanceTimersByTimeAsync(59_000);
            fixture.child.writeStdout('activity');
          }
          await vi.advanceTimersByTimeAsync(59_000);
          fixture.child.writeStdout('activity');
          await vi.advanceTimersByTimeAsync(10_000);
        }
        const close = reason === 'close' ? fixture.tool.close() : undefined;

        await flush();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(true);
        await expect(run).resolves.toMatchObject({
          status: reason === 'abort' || reason === 'close' ? 'cancelled' : 'timed_out'
        });
        if (close !== undefined) await expect(close).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  test('命令超过 16 KiB 时不签发确认', () => {
    const { tool } = createFixture();
    expect(() => preview(tool, 'x'.repeat(16 * 1024 + 1))).toThrow('POWERSHELL_COMMAND_TOO_LONG');
  });
});
