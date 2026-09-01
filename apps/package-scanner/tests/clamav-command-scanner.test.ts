import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ClamAvCommandScanner } from '../src/clamav-command-scanner';

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function completedChild(exitCode: number, output = ''): FakeChildProcess {
  const child = new FakeChildProcess();
  child.stdin.on('finish', () => {
    child.stdout.end(output);
    child.emit('close', exitCode);
  });
  return child;
}

describe('ClamAV 命令扫描器', () => {
  it('exit 0 返回干净结论', async () => {
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      1_000,
      () => completedChild(0) as never
    );

    await expect(scanner.scan({
      path: 'compiled/idle.png',
      bytes: Buffer.from('clean')
    })).resolves.toEqual({ infected: false });
  });

  it('exit 1 提取病毒签名并返回命中结论', async () => {
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      1_000,
      () => completedChild(1, 'stdin: Eicar-Test-Signature FOUND\n') as never
    );

    await expect(scanner.scan({
      path: 'draft/draft.json',
      bytes: Buffer.from('infected')
    })).resolves.toEqual({
      infected: true,
      signature: 'Eicar-Test-Signature'
    });
  });

  it('ClamAV 其他退出码失败关闭', async () => {
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      1_000,
      () => completedChild(2, 'database unavailable') as never
    );

    await expect(scanner.scan({
      path: 'draft/draft.json',
      bytes: Buffer.from('unknown')
    })).rejects.toThrow('SCANNER_CLAMAV_UNAVAILABLE');
  });

  it('超时后强制终止子进程并返回稳定错误', async () => {
    const child = new FakeChildProcess();
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      5,
      () => child as never
    );

    await expect(scanner.scan({
      path: 'compiled/idle.png',
      bytes: Buffer.from('clean')
    })).rejects.toThrow('SCANNER_CLAMAV_UNAVAILABLE');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('整包取消时立即终止当前 ClamAV 子进程', async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      1_000,
      () => child as never
    );
    const operation = scanner.scan({
      path: 'compiled/idle.png',
      bytes: Buffer.from('clean'),
      signal: controller.signal
    });
    controller.abort();

    await expect(Promise.race([
      operation,
      delay(100).then(() => {
        throw new Error('测试等待 ClamAV 取消失败');
      })
    ])).rejects.toThrow('SCANNER_SCAN_TIMEOUT');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
