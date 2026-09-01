import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClamAvCommandScanner } from './clamav-command-scanner.js';
import {
  scanPackage,
  type ArchiveIdentity,
  type ClamAvScanner,
  type ImageContentModerator
} from './scan-package.js';

type LocalScanCliDependencies = {
  clamav?: ClamAvScanner;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

const localImageModerator: ImageContentModerator = {
  review: async ({ path }) => ({
    path,
    provider: 'local-manual-review',
    suggestion: 'review',
    labels: ['manual-review-required']
  })
};

async function identifyArchive(archivePath: string): Promise<ArchiveIdentity> {
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(archivePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    digest.update(bytes);
  }
  return {
    sizeBytes,
    sha256: digest.digest('hex')
  };
}

function publicErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^(?:CHARACTER_PACKAGE|SCANNER)_[A-Z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return 'LOCAL_SCAN_FAILED';
}

/**
 * 本地 CLI 只读取一个 ZIP 并输出本地报告；它不连接数据库、对象存储或远端审核服务。
 */
export async function runLocalScanCli(
  args: readonly string[],
  dependencies: LocalScanCliDependencies = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout
    ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr
    ?? ((value: string) => process.stderr.write(value));
  if (args.length !== 1 || !args[0]?.trim()) {
    writeStderr(`${JSON.stringify({
      code: 'LOCAL_SCAN_USAGE_ERROR',
      usage: 'local-scan-cli <package.zip>'
    })}\n`);
    return 2;
  }

  try {
    const archivePath = resolve(args[0]);
    const archive = await identifyArchive(archivePath);
    const result = await scanPackage({
      archivePath,
      archive,
      clamav: dependencies.clamav ?? new ClamAvCommandScanner(),
      imageModerator: localImageModerator
    });
    writeStdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    writeStderr(`${JSON.stringify({
      code: 'LOCAL_SCAN_FAILED',
      detailCode: publicErrorCode(error)
    })}\n`);
    return 1;
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLocalScanCli(process.argv.slice(2));
}
