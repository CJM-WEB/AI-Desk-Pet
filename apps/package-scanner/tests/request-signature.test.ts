import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileReplayGuard,
  InternalSignatureError,
  verifyInternalSignature
} from '../src/request-signature';

const SECRET = 'test-secret-with-enough-entropy';
const NOW = new Date('2026-07-31T00:00:00.000Z');
const directories: string[] = [];

async function replayGuard(): Promise<FileReplayGuard> {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-replay-test-'));
  directories.push(directory);
  return new FileReplayGuard(directory);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

function signedRequest(
  body: Buffer,
  timestamp = String(NOW.getTime()),
  signatureOverride?: string
) {
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = signatureOverride ?? createHmac('sha256', SECRET)
    .update(`${timestamp}\n${digest}`)
    .digest('hex');
  return {
    rawBody: body,
    headers: {
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature
    }
  };
}

describe('内部请求签名', () => {
  it('接受五分钟窗口内且正文摘要匹配的请求', async () => {
    const guard = await replayGuard();

    expect(() => verifyInternalSignature(
      signedRequest(Buffer.from('{"downloadUrl":"https://example.test/file"}')),
      SECRET,
      NOW,
      guard
    )).not.toThrow();
  });

  it.each([
    ['超过五分钟', String(NOW.getTime() - 300_001), undefined],
    ['未来超过五分钟', String(NOW.getTime() + 300_001), undefined],
    ['签名不匹配', String(NOW.getTime()), '0'.repeat(64)],
    ['时间戳非法', 'not-a-time', undefined]
  ])('%s 时返回统一未授权错误', async (_name, timestamp, signature) => {
    const guard = await replayGuard();

    expect(() => verifyInternalSignature(
      signedRequest(Buffer.from('{}'), timestamp, signature),
      SECRET,
      NOW,
      guard
    )).toThrowError(new InternalSignatureError());
  });

  it('同一签名在有效窗口内再次使用时拒绝重放', async () => {
    const request = signedRequest(Buffer.from('{}'));
    const guard = await replayGuard();

    verifyInternalSignature(request, SECRET, NOW, guard);

    expect(() => verifyInternalSignature(
      request,
      SECRET,
      new Date(NOW.getTime() + 1_000),
      guard
    )).toThrowError(new InternalSignatureError());
  });
});
