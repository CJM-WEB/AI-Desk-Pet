import {
  timingSafeEqual
} from 'node:crypto';
import {
  SCANNER_PROTOCOL_VERSION,
  createScannerSignature
} from '@myself/shared-types/scanner-protocol';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { join } from 'node:path';

const SIGNATURE_WINDOW_MS = 5 * 60 * 1_000;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type InternalSignedRequest = {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | undefined>>;
};

export interface SignatureReplayGuard {
  consume(signature: string, expiresAtMs: number, nowMs: number): boolean;
}

export class InternalSignatureError extends Error {
  readonly statusCode = 401;
  readonly code = 'SCANNER_UNAUTHORIZED';

  constructor() {
    super('内部扫描请求未通过身份校验。');
    this.name = 'InternalSignatureError';
  }
}

/**
 * 使用原子文件创建记录已消费签名，避免生产进程仅依赖内存判断重放。
 * 多实例部署时应把该接口替换为具备原子写入能力的共享存储。
 */
export class FileReplayGuard implements SignatureReplayGuard {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  consume(signature: string, expiresAtMs: number, nowMs: number): boolean {
    this.removeExpired(nowMs);
    const receiptPath = join(this.directory, signature);
    try {
      const handle = openSync(receiptPath, 'wx', 0o600);
      writeSync(handle, String(expiresAtMs));
      closeSync(handle);
      return true;
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && error.code === 'EEXIST'
      ) {
        return false;
      }
      throw error;
    }
  }

  private removeExpired(nowMs: number): void {
    for (const fileName of readdirSync(this.directory)) {
      if (!HEX_SHA256_PATTERN.test(fileName)) continue;
      const path = join(this.directory, fileName);
      try {
        const expiresAt = Number(readFileSync(path, 'utf8'));
        if (
          !Number.isSafeInteger(expiresAt)
          || expiresAt < nowMs
        ) {
          unlinkSync(path);
        }
      } catch (error) {
        if (
          !(error instanceof Error)
          || !('code' in error)
          || error.code !== 'ENOENT'
        ) {
          throw error;
        }
      }
    }
  }
}

function unauthorized(): never {
  throw new InternalSignatureError();
}

export function verifyInternalSignature(
  request: InternalSignedRequest,
  secret: string,
  now: Date,
  replayGuard: SignatureReplayGuard
): void {
  const timestampText = request.headers['x-internal-timestamp'];
  const suppliedSignature = request.headers['x-internal-signature'];
  if (
    !timestampText
    || !/^\d{13}$/u.test(timestampText)
    || !suppliedSignature
    || !HEX_SHA256_PATTERN.test(suppliedSignature)
    || secret.length === 0
  ) {
    unauthorized();
  }

  const timestamp = Number(timestampText);
  const nowMs = now.getTime();
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(nowMs - timestamp) > SIGNATURE_WINDOW_MS
  ) {
    unauthorized();
  }

  const expectedSignature = createScannerSignature(
    SCANNER_PROTOCOL_VERSION,
    timestampText,
    request.rawBody,
    secret
  );
  const expected = Buffer.from(expectedSignature, 'hex');
  const supplied = Buffer.from(suppliedSignature, 'hex');
  if (
    expected.byteLength !== supplied.byteLength
    || !timingSafeEqual(expected, supplied)
  ) {
    unauthorized();
  }

  if (!replayGuard.consume(
    suppliedSignature,
    timestamp + SIGNATURE_WINDOW_MS,
    nowMs
  )) {
    unauthorized();
  }
}
