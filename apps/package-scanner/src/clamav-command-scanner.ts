import { spawn } from 'node:child_process';
import type { ClamAvScanner } from './scan-package.js';

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
type SpawnCommand = typeof spawn;

function scannerError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

/**
 * 通过标准输入调用 ClamAV，避免把 ZIP 内条目落盘；超时或取消时必须终止原生进程。
 */
export class ClamAvCommandScanner implements ClamAvScanner {
  constructor(
    private readonly executable = 'clamscan',
    private readonly timeoutMs = DEFAULT_CLAMAV_TIMEOUT_MS,
    private readonly spawnCommand: SpawnCommand = spawn
  ) {}

  async scan(input: {
    path: string;
    bytes: Buffer;
    signal?: AbortSignal;
  }): Promise<{ infected: boolean; signature?: string }> {
    if (input.signal?.aborted) {
      throw scannerError('SCANNER_SCAN_TIMEOUT', input.signal.reason);
    }

    let result: { exitCode: number; output: string };
    try {
      result = await new Promise<{ exitCode: number; output: string }>(
        (resolve, reject) => {
          const child = this.spawnCommand(this.executable, ['--no-summary', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          });
          const chunks: Buffer[] = [];
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;

          const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            input.signal?.removeEventListener('abort', abortScan);
            action();
          };
          const abortScan = () => {
            try {
              child.kill('SIGKILL');
            } finally {
              finish(() => reject(
                scannerError('SCANNER_SCAN_TIMEOUT', input.signal?.reason)
              ));
            }
          };

          timeout = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } finally {
              finish(() => reject(scannerError('SCANNER_CLAMAV_UNAVAILABLE')));
            }
          }, this.timeoutMs);
          input.signal?.addEventListener('abort', abortScan, { once: true });
          if (input.signal?.aborted) abortScan();
          child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
          child.stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
          child.stdin.on('error', () => undefined);
          child.once('error', error => finish(() => reject(error)));
          child.once('close', code => finish(() => resolve({
            exitCode: code ?? 2,
            output: Buffer.concat(chunks).toString('utf8')
          })));
          child.stdin.end(input.bytes);
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'SCANNER_SCAN_TIMEOUT') {
        throw error;
      }
      throw scannerError('SCANNER_CLAMAV_UNAVAILABLE', error);
    }

    if (result.exitCode === 0) return { infected: false };
    if (result.exitCode === 1) {
      const match = /:\s*(.+)\s+FOUND\s*$/mu.exec(result.output);
      return {
        infected: true,
        ...(match?.[1] ? { signature: match[1] } : {})
      };
    }
    throw scannerError('SCANNER_CLAMAV_UNAVAILABLE');
  }
}
