import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import {
  mkdir,
  mkdtemp,
  open,
  rm
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ims } from 'tencentcloud-sdk-nodejs';
import {
  SCANNER_PROTOCOL_VERSION,
  SCANNER_RULE_VERSION,
  scannerErrorResponseSchema,
  scannerRequestSchema,
  scannerSuccessResponseSchema,
  type ScannerErrorResponse
} from '@myself/shared-types/scanner-protocol';
import {
  FileReplayGuard,
  InternalSignatureError,
  verifyInternalSignature
} from './request-signature.js';
import {
  scanPackage,
  type ArchiveIdentity,
  type ClamAvScanner,
  type ImageContentModerator,
  type PackageScanResult,
  type ScanPackageInput
} from './scan-package.js';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_DOWNLOAD_URL_LIFETIME_MS = 5 * 60 * 1_000;
const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
const DEFAULT_IMS_TIMEOUT_MS = 15_000;
const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

type Download = (
  url: URL,
  destination: string,
  signal?: AbortSignal
) => Promise<ArchiveIdentity>;
type Scan = (
  input: Pick<ScanPackageInput, 'archivePath' | 'archive' | 'signal'>
) => Promise<PackageScanResult>;
type SpawnCommand = typeof spawn;

export type ScanRemotePackageInput = {
  downloadUrl: string;
  expiresAtMs: number;
  now: Date;
  workRoot: string;
  allowedDownloadHosts: ReadonlySet<string>;
  requiredDownloadQueryParameters: ReadonlySet<string>;
  download: Download;
  scan: Scan;
  signal?: AbortSignal;
};

export type ScannerServerDependencies = {
  secret: string;
  workRoot: string;
  replayDirectory: string;
  allowedDownloadHosts: ReadonlySet<string>;
  requiredDownloadQueryParameters: ReadonlySet<string>;
  clamav: ClamAvScanner;
  imageModerator: ImageContentModerator;
  scanTimeoutMs?: number;
  download?: Download;
  now?: () => Date;
};

function scannerError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function validateDownloadUrl(
  value: string,
  expiresAtMs: number,
  now: Date,
  allowedHosts: ReadonlySet<string>,
  requiredQueryParameters: ReadonlySet<string>
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw scannerError('SCANNER_DOWNLOAD_URL_REJECTED', error);
  }
  if (
    url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !allowedHosts.has(url.hostname.toLocaleLowerCase('en-US'))
    || requiredQueryParameters.size === 0
    || [...requiredQueryParameters].some(parameter => (
      !url.searchParams.has(parameter)
      || url.searchParams.get(parameter)?.trim().length === 0
    ))
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= now.getTime()
    || expiresAtMs > now.getTime() + MAX_DOWNLOAD_URL_LIFETIME_MS
  ) {
    throw scannerError('SCANNER_DOWNLOAD_URL_REJECTED');
  }
  return url;
}

export async function downloadPrivateObject(
  url: URL,
  destination: string,
  signal?: AbortSignal
): Promise<ArchiveIdentity> {
  const downloadTimeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, downloadTimeout])
      : downloadTimeout
  });
  if (!response.ok || !response.body) {
    throw scannerError('SCANNER_DOWNLOAD_FAILED');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_ARCHIVE_BYTES
  ) {
    throw scannerError('CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED');
  }

  const output = await open(destination, 'wx', 0o600);
  let totalBytes = 0;
  const archiveHash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        throw scannerError('CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED');
      }
      archiveHash.update(bytes);
      await output.write(bytes);
    }
    if (totalBytes === 0) {
      throw scannerError('SCANNER_DOWNLOAD_FAILED');
    }
  } finally {
    await output.close();
  }
  return {
    sizeBytes: totalBytes,
    sha256: archiveHash.digest('hex')
  };
}

export async function scanRemotePackage(
  input: ScanRemotePackageInput
): Promise<PackageScanResult> {
  const url = validateDownloadUrl(
    input.downloadUrl,
    input.expiresAtMs,
    input.now,
    input.allowedDownloadHosts,
    input.requiredDownloadQueryParameters
  );
  await mkdir(input.workRoot, { recursive: true });
  const requestDirectory = await mkdtemp(join(input.workRoot, 'request-'));
  const archivePath = join(requestDirectory, 'package.zip');
  try {
    const archive = await input.download(url, archivePath, input.signal);
    return await input.scan({
      archivePath,
      archive,
      ...(input.signal ? { signal: input.signal } : {})
    });
  } finally {
    await rm(requestDirectory, { recursive: true, force: true });
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      throw scannerError('SCANNER_REQUEST_TOO_LARGE');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength);
}

function headerValue(
  request: IncomingMessage,
  name: string
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  value: unknown
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function sendScannerError(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  error: ScannerErrorResponse
): void {
  sendJson(response, statusCode, error);
}

export function createScannerServer(
  dependencies: ScannerServerDependencies
): Server {
  const replayGuard = new FileReplayGuard(dependencies.replayDirectory);
  const now = dependencies.now ?? (() => new Date());
  const download = dependencies.download ?? downloadPrivateObject;
  let scanActive = false;

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/internal/scan') {
      sendScannerError(response, 404, {
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'not_found',
        detailCode: 'SCANNER_NOT_FOUND'
      });
      return;
    }

    try {
      const rawBody = await readRawBody(request);
      const requestNow = now();
      verifyInternalSignature({
        rawBody,
        headers: {
          'x-internal-timestamp': headerValue(request, 'x-internal-timestamp'),
          'x-internal-signature': headerValue(request, 'x-internal-signature')
        }
      }, dependencies.secret, requestNow, replayGuard);

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw scannerError('SCANNER_REQUEST_INVALID');
      }
      const requestResult = scannerRequestSchema.safeParse(payload);
      if (!requestResult.success) {
        throw scannerError('SCANNER_REQUEST_INVALID');
      }
      if (scanActive) {
        sendScannerError(response, 503, {
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          code: 'busy',
          detailCode: 'SCANNER_BUSY'
        });
        return;
      }
      scanActive = true;
      const scanController = new AbortController();
      const scanTimeout = setTimeout(
        () => scanController.abort(
          scannerError('SCANNER_SCAN_TIMEOUT')
        ),
        dependencies.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
      );
      try {
        let result: PackageScanResult;
        try {
          result = await scanRemotePackage({
            downloadUrl: requestResult.data.downloadUrl,
            expiresAtMs: Date.parse(requestResult.data.expiresAt),
            now: requestNow,
            workRoot: dependencies.workRoot,
            allowedDownloadHosts: dependencies.allowedDownloadHosts,
            requiredDownloadQueryParameters:
              dependencies.requiredDownloadQueryParameters,
            download,
            signal: scanController.signal,
            scan: ({ archivePath, archive, signal }) => scanPackage({
              archivePath,
              archive,
              clamav: dependencies.clamav,
              imageModerator: dependencies.imageModerator,
              ...(signal ? { signal } : {})
            })
          });
        } catch (error) {
          if (scanController.signal.aborted) {
            throw scannerError('SCANNER_SCAN_TIMEOUT', error);
          }
          throw error;
        }
        const wireResult = scannerSuccessResponseSchema.safeParse({
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          ruleVersion: SCANNER_RULE_VERSION,
          submissionId: requestResult.data.submissionId,
          completedAt: now().toISOString(),
          ...result
        });
        if (!wireResult.success) {
          throw scannerError('SCANNER_RESPONSE_INVALID', wireResult.error);
        }
        sendJson(response, 200, wireResult.data);
      } finally {
        clearTimeout(scanTimeout);
        scanActive = false;
      }
    } catch (error) {
      if (error instanceof InternalSignatureError) {
        sendScannerError(response, 401, {
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          code: 'unauthorized',
          detailCode: error.code
        });
        return;
      }
      const code = error instanceof Error
        ? error.message
        : 'SCANNER_UNAVAILABLE';
      if (code.startsWith('CHARACTER_PACKAGE_')) {
        if (code === 'CHARACTER_PACKAGE_MALWARE_DETECTED') {
          sendScannerError(response, 422, {
            protocolVersion: SCANNER_PROTOCOL_VERSION,
            code: 'dangerous',
            detailCode: code
          });
          return;
        }
        sendScannerError(response, 422, scannerErrorResponseSchema.parse({
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          code: 'invalid',
          detailCode: code
        }));
        return;
      }
      if (
        code === 'SCANNER_REQUEST_INVALID'
        || code === 'SCANNER_REQUEST_TOO_LARGE'
        || code === 'SCANNER_DOWNLOAD_URL_REJECTED'
      ) {
        sendScannerError(response, 400, scannerErrorResponseSchema.parse({
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          code: 'invalid',
          detailCode: code
        }));
        return;
      }
      if (code === 'SCANNER_SCAN_TIMEOUT') {
        sendScannerError(response, 503, {
          protocolVersion: SCANNER_PROTOCOL_VERSION,
          code: 'timeout',
          detailCode: code
        });
        return;
      }
      sendScannerError(response, 503, {
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'scanner_error',
        detailCode: 'SCANNER_UNAVAILABLE'
      });
    }
  });
}

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
          let settled = false;
          const chunks: Buffer[] = [];
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const abortScan = () => {
            try {
              child.kill('SIGKILL');
            } finally {
              finish(() => reject(
                scannerError('SCANNER_SCAN_TIMEOUT', input.signal?.reason)
              ));
            }
          };
          const finish = (
            action: () => void
          ) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            input.signal?.removeEventListener('abort', abortScan);
            action();
          };
          // 超时或整包取消时必须终止原生进程，不能只让调用方停止等待。
          timeout = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } finally {
              finish(() => reject(
                scannerError('SCANNER_CLAMAV_UNAVAILABLE')
              ));
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
      if (
        error instanceof Error
        && error.message === 'SCANNER_SCAN_TIMEOUT'
      ) {
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

type TencentImsClient = InstanceType<typeof ims.v20201229.Client>;

export class TencentImageContentModerator implements ImageContentModerator {
  constructor(
    private readonly client: Pick<TencentImsClient, 'ImageModeration'>,
    private readonly bizType?: string,
    private readonly timeoutMs = DEFAULT_IMS_TIMEOUT_MS
  ) {}

  async review(input: {
    path: string;
    bytes: Buffer;
    mime: 'image/png' | 'image/webp';
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) {
      throw scannerError('SCANNER_SCAN_TIMEOUT', input.signal.reason);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = () => undefined;
    let response: Awaited<ReturnType<TencentImsClient['ImageModeration']>>;
    try {
      response = await Promise.race([
        this.client.ImageModeration({
          FileContent: input.bytes.toString('base64'),
          DataId: createHash('sha256').update(input.path).digest('hex'),
          Type: 'IMAGE',
          ...(this.bizType ? { BizType: this.bizType } : {})
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(scannerError('SCANNER_IMAGE_MODERATION_UNAVAILABLE')),
            this.timeoutMs
          );
        }),
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(
            scannerError('SCANNER_SCAN_TIMEOUT', input.signal?.reason)
          );
          input.signal?.addEventListener('abort', abort, { once: true });
          removeAbortListener = () => {
            input.signal?.removeEventListener('abort', abort);
          };
          if (input.signal?.aborted) abort();
        })
      ]);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'SCANNER_SCAN_TIMEOUT'
      ) {
        throw error;
      }
      throw scannerError('SCANNER_IMAGE_MODERATION_UNAVAILABLE', error);
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
    }
    const normalized = response.Suggestion?.toLocaleLowerCase('en-US');
    const suggestion = normalized === 'pass'
      ? 'pass' as const
      : normalized === 'block'
        ? 'block' as const
        : 'review' as const;
    const labels = [
      response.Label,
      response.SubLabel,
      ...(response.LabelResults ?? []).flatMap(result => [
        result.Label,
        result.SubLabel
      ])
    ].filter((label): label is string => Boolean(label));
    const ocrText = (response.OcrResults ?? [])
      .map(result => result.Text)
      .filter((text): text is string => Boolean(text))
      .join('\n');
    return {
      path: input.path,
      provider: 'tencent-ims',
      suggestion,
      labels: [...new Set(labels)],
      ...(ocrText ? { ocrText } : {})
    };
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少必需环境变量：${name}`);
  }
  return value;
}

export function startProductionServer(): Server {
  const workRoot = '/tmp/scan';
  const client = createTencentImsClient(process.env);
  const server = createScannerServer({
    secret: requiredEnvironment('SCANNER_INTERNAL_SECRET'),
    workRoot,
    replayDirectory: join(workRoot, '.replay'),
    allowedDownloadHosts: new Set(
      requiredEnvironment('SCANNER_DOWNLOAD_HOSTS')
        .split(',')
        .map(host => host.trim().toLocaleLowerCase('en-US'))
        .filter(Boolean)
    ),
    requiredDownloadQueryParameters: new Set(
      requiredEnvironment('SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS')
        .split(',')
        .map(parameter => parameter.trim())
        .filter(Boolean)
    ),
    clamav: new ClamAvCommandScanner(),
    imageModerator: new TencentImageContentModerator(
      client,
      process.env.TENCENT_IMS_BIZ_TYPE
    )
  });
  const port = Number(process.env.PORT ?? '8080');
  server.listen(port, '0.0.0.0');
  return server;
}

type ImsClientConstructor = new (
  options: ConstructorParameters<typeof ims.v20201229.Client>[0]
) => InstanceType<typeof ims.v20201229.Client>;

/** 仅从显式环境配置创建腾讯 IMS 客户端，禁止依赖空凭据猜测。 */
export function createTencentImsClient(
  env: NodeJS.ProcessEnv,
  Client: ImsClientConstructor = ims.v20201229.Client
): InstanceType<typeof ims.v20201229.Client> {
  const secretId = requiredEnvironmentFrom(env, 'TENCENTCLOUD_SECRETID');
  const secretKey = requiredEnvironmentFrom(env, 'TENCENTCLOUD_SECRETKEY');
  const token = env.TENCENTCLOUD_SESSIONTOKEN?.trim();
  return new Client({
    credential: {
      secretId,
      secretKey,
      ...(token ? { token } : {})
    },
    region: requiredEnvironmentFrom(env, 'TENCENT_CLOUD_REGION'),
    profile: {
      httpProfile: {
        reqTimeout: DEFAULT_IMS_TIMEOUT_MS / 1_000
      }
    }
  });
}

function requiredEnvironmentFrom(
  env: NodeJS.ProcessEnv,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必需环境变量：${name}`);
  return value;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startProductionServer();
}
