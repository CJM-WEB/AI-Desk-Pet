import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ClamAvCommandScanner,
  createScannerServer,
} from '/app/dist/server.js';

const protocolVersion = '2026-08-15';
const secret = 'scanner-candidate-local-secret';
const root = '/tmp/scan/candidate';
// 固定 ZIP 夹具避免向生产镜像添加测试依赖；EICAR 原文仅存在于解码后的临时文件。
const eicarZip = 'UEsDBBQAAAgIAABAD108z1FoRgAAAEQAAAAQAAAAZHJhZnQvZHJhZnQuanNvbosw9VcMUHVwDIg2iQmIijA10QiI0zR3dtY0r1Vx9XR2DNINDnH0c3EMctF19AvxDPMMCg3WDXENDtF18/RxVVTx0PbQAgBQSwMEFAAACAgAAEAPXUO/pqMEAAAAAgAAABYAAABjb21waWxlZC9tYW5pZmVzdC5qc29uq64FAFBLAwQUAAAICAAAQA9dQ7+mowQAAAACAAAAEwAAAHNvdXJjZS9jYXRhbG9nLmpzb26rrgUAUEsDBBQAAAgIAABAD12lvutbBgAAAAQAAAARAAAAY29tcGlsZWQvaWRsZS5wbmfrDPBzBwBQSwMEFAAACAgAAEAPXaW+61sGAAAABAAAAC8AAABzb3VyY2UvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLnBuZ+sM8HMHAFBLAQI/AxQAAAgIAABAD108z1FoRgAAAEQAAAAQAAkAAAAAAAAAAAC0gQAAAABkcmFmdC9kcmFmdC5qc29uVVQFAAMArH9qUEsBAj8DFAAACAgAAEAPXUO/pqMEAAAAAgAAABYACQAAAAAAAAAAALSBdAAAAGNvbXBpbGVkL21hbmlmZXN0Lmpzb25VVAUAAwCsf2pQSwECPwMUAAAICAAAQA9dQ7+mowQAAAACAAAAEwAJAAAAAAAAAAAAtIGsAAAAc291cmNlL2NhdGFsb2cuanNvblVUBQADAKx/alBLAQI/AxQAAAgIAABAD12lvutbBgAAAAQAAAARAAkAAAAAAAAAAAC0geEAAABjb21waWxlZC9pZGxlLnBuZ1VUBQADAKx/alBLAQI/AxQAAAgIAABAD12lvutbBgAAAAQAAAAvAAkAAAAAAAAAAAC0gRYBAABzb3VyY2UvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLnBuZ1VUBQADAKx/alBLBQYAAAAABQAFAIwBAABpAQAAAAA=';
const cleanZip = 'UEsDBBQAAAgIAABAD11Dv6ajBAAAAAIAAAAQAAAAZHJhZnQvZHJhZnQuanNvbquuBQBQSwMEFAAACAgAAEAPXUO/pqMEAAAAAgAAABYAAABjb21waWxlZC9tYW5pZmVzdC5qc29uq64FAFBLAwQUAAAICAAAQA9dQ7+mowQAAAACAAAAEwAAAHNvdXJjZS9jYXRhbG9nLmpzb26rrgUAUEsDBBQAAAgIAABAD12lvutbBgAAAAQAAAARAAAAY29tcGlsZWQvaWRsZS5wbmfrDPBzBwBQSwMEFAAACAgAAEAPXaW+61sGAAAABAAAAC8AAABzb3VyY2UvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLnBuZ+sM8HMHAFBLAQI/AxQAAAgIAABAD11Dv6ajBAAAAAIAAAAQAAkAAAAAAAAAAAC0gQAAAABkcmFmdC9kcmFmdC5qc29uVVQFAAMArH9qUEsBAj8DFAAACAgAAEAPXUO/pqMEAAAAAgAAABYACQAAAAAAAAAAALSBMgAAAGNvbXBpbGVkL21hbmlmZXN0Lmpzb25VVAUAAwCsf2pQSwECPwMUAAAICAAAQA9dQ7+mowQAAAACAAAAEwAJAAAAAAAAAAAAtIFqAAAAc291cmNlL2NhdGFsb2cuanNvblVUBQADAKx/alBLAQI/AxQAAAgIAABAD12lvutbBgAAAAQAAAARAAkAAAAAAAAAAAC0gZ8AAABjb21waWxlZC9pZGxlLnBuZ1VUBQADAKx/alBLAQI/AxQAAAgIAABAD12lvutbBgAAAAQAAAAvAAkAAAAAAAAAAAC0gdQAAABzb3VyY2UvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLnBuZ1VUBQADAKx/alBLBQYAAAAABQAFAIwBAAAnAQAAAAA=';

function signature(timestamp, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update(`${protocolVersion}\n${timestamp}\n${digest}`)
    .digest('hex');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('候选探针未绑定端口');
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => (
    error ? reject(error) : resolve()
  )));
}

async function requestScan(port) {
  const now = Date.now();
  const body = JSON.stringify({
    protocolVersion,
    submissionId: '3d594650-3436-4ad0-a9a8-80ca4388824b',
    downloadUrl: 'https://candidate.invalid/package.zip?signature=local',
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const timestamp = String(now);
  const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature(timestamp, Buffer.from(body)),
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

function dependencies(directory, fixture, clamav, scanTimeoutMs) {
  return {
    secret,
    workRoot: join(directory, 'work'),
    replayDirectory: join(directory, 'replay'),
    allowedDownloadHosts: new Set(['candidate.invalid']),
    requiredDownloadQueryParameters: new Set(['signature']),
    clamav,
    imageModerator: {
      review: async ({ path }) => ({
        path,
        provider: 'candidate-probe',
        suggestion: 'pass',
        labels: [],
      }),
    },
    download: async (_url, destination) => copyFile(fixture, destination),
    ...(scanTimeoutMs === undefined ? {} : { scanTimeoutMs }),
  };
}

async function verifyHttpGates() {
  await mkdir(root, { recursive: true });
  const eicarArchive = join(root, 'eicar.zip');
  const timeoutArchive = join(root, 'timeout.zip');
  await writeFile(eicarArchive, Buffer.from(eicarZip, 'base64'));
  await writeFile(timeoutArchive, Buffer.from(cleanZip, 'base64'));

  const eicarServer = createScannerServer(dependencies(
    join(root, 'eicar'),
    eicarArchive,
    new ClamAvCommandScanner(),
  ));
  const eicarPort = await listen(eicarServer);
  try {
    const result = await requestScan(eicarPort);
    if (result.status !== 422 || result.body?.code !== 'dangerous') {
      throw new Error(`EICAR 未被扫描接口阻断：${JSON.stringify(result)}`);
    }
  } finally {
    await close(eicarServer);
  }

  const timeoutServer = createScannerServer(dependencies(
    join(root, 'timeout'),
    timeoutArchive,
    {
      scan: async ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('探针超时')), { once: true });
      }),
    },
    100,
  ));
  const timeoutPort = await listen(timeoutServer);
  try {
    const result = await requestScan(timeoutPort);
    if (result.status !== 503 || result.body?.code !== 'timeout') {
      throw new Error(`超时未按 503 失败关闭：${JSON.stringify(result)}`);
    }
  } finally {
    await close(timeoutServer);
  }
}

try {
  await verifyHttpGates();
  const clamavOutput = execFileSync('clamscan', ['--version'], { encoding: 'utf8' }).trim();
  const version = /ClamAV\s+([^/]+)\/(\d+)\//u.exec(clamavOutput);
  if (!version) throw new Error(`无法解析 ClamAV 病毒库版本：${clamavOutput}`);
  process.stdout.write(`${JSON.stringify({
    nodeVersion: process.version,
    clamavVersion: `ClamAV ${version[1]}`,
    clamavDatabaseVersion: version[2],
    uid: process.getuid?.(),
    eicar: 'blocked',
    timeout: 'http-503',
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
