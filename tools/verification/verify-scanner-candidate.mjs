import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const imageTag = 'ai-pet-package-scanner:stage2-candidate';
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const probePath = fileURLToPath(
  new URL('./scanner-candidate-probe.mjs', import.meta.url),
);
const windowsDockerCli = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const cleanPackageBase64 = 'UEsDBBQAAAgIAD2UIV1NFA8hQgAAAD8AAAAQAAAAZHJhZnQvZHJhZnQuanNvbqtWKkstKs7Mz1OyMtRRykxRslIqSS0u0S1ILVHSUcpLzE1VslJ6trX7xfqpzxb2PF23QElHqbgksSS1WMkqOrYWAFBLAwQUAAAICAA9lCFd/Iu1fzQBAADPAQAAFgAAAGNvbXBpbGVkL21hbmlmZXN0Lmpzb251ULtOwzAU/ZczmygOjZt4Y0RCjCyog5PcJBZpHNkOpao6MsHKxgA/ABMLA3/Tis9ALq2EQOhO9+qcex4rXJN12vSQnEFXkPDk/NFAHgy9mhMktm93n68P2+f7zcsTGHw7zote6e7EOfKngaOrjsBQmvmgO7IXh5/gURzFYLDkzGhLcpCXK6jfxFp3dP4tFi7R0DdgcK1KUgGJyTEvqRI5FypRCVc8FXScTWOuakrToqimdZblIq+Loi5TUU1rivO8mkzrRKQTEQwUS09n1De+hRTZesbgvPJ7P/qHlSvdh600Nmyq9Nr0f1H7ZjYft9vH9xBgcJA8YeiMGSC9HYlhQbpp/a5Z1ZetsQ5yhcaaMUiscAMZRynDEpKv1wy1VfP/GgrYHTJmWOgqxOAM7UFhPdvNF1BLAwQUAAAICAA9lCFdsoo8lbEAAADtAAAAEwAAAHNvdXJjZS9jYXRhbG9nLmpzb241isFqwzAUBP9lzwqxHOtZ0h8USk+5lR6epCfbEDvGUgsm5N9LTTOHgR32gR/ZynRf4LVCHHnjWGV7S/CoUupplQqFcv/eohT4zwe4FKnHQf9zOtT9yb7mCyikqaw33j94FnhM6SZQmKdZrvt6lJkHOa/LAIWwV3mXZagjPFmFMnJrCB7dRUdJ5DRxy61mbUgutm80ZzEmhNRnax25HEKOhlKfpXEudX1uyXTU4Pn1/AVQSwMEFAAACAgAPZQhXTMzCnFEAAAARAAAABEAAABjb21waWxlZC9pZGxlLnBuZ+sM8HPn5ZLiYmBg4PX0cAliYGBgBGEOFgYGhq0yPEwMDAzcni6OIRW3klN+8DMwsjIyqks8TmNgYGDwdPVzWeeU0AQAUEsDBBQAAAgIAD2UIV0zMwpxRAAAAEQAAAAvAAAAc291cmNlLzExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMS5wbmfrDPBz5+WS4mJgYOD19HAJYmBgYARhDhYGBoatMjxMDAwM3J4ujiEVt5JTfvAzMLIyMqpLPE5jYGBg8HT1c1nnlNAEAFBLAQI/AxQAAAgIAD2UIV1NFA8hQgAAAD8AAAAQAAkAAAAAAAAAAAC0gQAAAABkcmFmdC9kcmFmdC5qc29uVVQFAAMXqpZqUEsBAj8DFAAACAgAPZQhXfyLtX80AQAAzwEAABYACQAAAAAAAAAAALSBcAAAAGNvbXBpbGVkL21hbmlmZXN0Lmpzb25VVAUAAxeqlmpQSwECPwMUAAAICAA9lCFdsoo8lbEAAADtAAAAEwAJAAAAAAAAAAAAtIHYAQAAc291cmNlL2NhdGFsb2cuanNvblVUBQADF6qWalBLAQI/AxQAAAgIAD2UIV0zMwpxRAAAAEQAAAARAAkAAAAAAAAAAAC0gboCAABjb21waWxlZC9pZGxlLnBuZ1VUBQADF6qWalBLAQI/AxQAAAgIAD2UIV0zMwpxRAAAAEQAAAAvAAkAAAAAAAAAAAC0gS0DAABzb3VyY2UvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLnBuZ1VUBQADF6qWalBLBQYAAAAABQAFAIwBAAC+AwAAAAA=';
const eicarPackageBase64 = 'UEsDBBQAAAgIAEyUIV08z1FoRgAAAEQAAAAQAAAAZHJhZnQvZHJhZnQuanNvbosw9VcMUHVwDIg2iQmIijA10QiI0zR3dtY0r1Vx9XR2DNINDnH0c3EMctF19AvxDPMMCg3WDXENDtF18/RxVVTx0PbQAgBQSwMEFAAACAgATJQhXfyLtX80AQAAzwEAABYAAABjb21waWxlZC9tYW5pZmVzdC5qc29udVC7TsMwFP2XM5soDo2beGNEQowsqIOT3CQWaRzZDqWqOjLBysYAPwATCwN/04rPQC6thEDoTvfqnHseK1yTddr0kJxBV5Dw5PzRQB4MvZoTJLZvd5+vD9vn+83LExh8O86LXunuxDnyp4Gjq47AUJr5oDuyF4ef4FEcxWCw5MxoS3KQlyuo38Rad3T+LRYu0dA3YHCtSlIBickxL6kSORcqUQlXPBV0nE1jrmpK06KopnWW5SKvi6IuU1FNa4rzvJpM60SkExEMFEtPZ9Q3voUU2XrG4Lzyez/6h5Ur3YetNDZsqvTa9H9R+2Y2H7fbx/cQYHCQPGHojBkgvR2JYUG6af2uWdWXrbEOcoXGmjFIrHADGUcpwxKSr9cMtVXz/xoK2B0yZljoKsTgDO1BYT3bzRdQSwMEFAAACAgATJQhXbKKPJWxAAAA7QAAABMAAABzb3VyY2UvY2F0YWxvZy5qc29uNYrBasMwFAT/Zc8KsRzrWdIfFEpPuZUenqQn2xA7xlILJuTfS00zh4Ed9oEf2cp0X+C1Qhx541hle0vwqFLqaZUKhXL/3qIU+M8HuBSpx0H/czrU/cm+5gsopKmsN94/eBZ4TOkmUJinWa77epSZBzmvywCFsFd5l2WoIzxZhTJyawge3UVHSeQ0ccutZm1ILrZvNGcxJoTUZ2sduRxCjoZSn6VxLnV9bsl01OD59fwFUEsDBBQAAAgIAEyUIV0zMwpxRAAAAEQAAAARAAAAY29tcGlsZWQvaWRsZS5wbmfrDPBz5+WS4mJgYOD19HAJYmBgYARhDhYGBoatMjxMDAwM3J4ujiEVt5JTfvAzMLIyMqpLPE5jYGBg8HT1c1nnlNAEAFBLAwQUAAAICABMlCFdMzMKcUQAAABEAAAALwAAAHNvdXJjZS8xMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEucG5n6wzwc+flkuJiYGDg9fRwCWJgYGAEYQ4WBgaGrTI8TAwMDNyeLo4hFbeSU37wMzCyMjKqSzxOY2BgYPB09XNZ55TQBABQSwECPwMUAAAICABMlCFdPM9RaEYAAABEAAAAEAAJAAAAAAAAAAAAtIEAAAAAZHJhZnQvZHJhZnQuanNvblVUBQADMaqWalBLAQI/AxQAAAgIAEyUIV38i7V/NAEAAM8BAAAWAAkAAAAAAAAAAAC0gXQAAABjb21waWxlZC9tYW5pZmVzdC5qc29uVVQFAAMxqpZqUEsBAj8DFAAACAgATJQhXbKKPJWxAAAA7QAAABMACQAAAAAAAAAAALSB3AEAAHNvdXJjZS9jYXRhbG9nLmpzb25VVAUAAzGqlmpQSwECPwMUAAAICABMlCFdMzMKcUQAAABEAAAAEQAJAAAAAAAAAAAAtIG+AgAAY29tcGlsZWQvaWRsZS5wbmdVVAUAAzGqlmpQSwECPwMUAAAICABMlCFdMzMKcUQAAABEAAAALwAJAAAAAAAAAAAAtIExAwAAc291cmNlLzExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMS5wbmdVVAUAAzGqlmpQSwUGAAAAAAUABQCMAQAAwgMAAAAA';
const invalidPackageBase64 = 'UEsDBBQAAAgIAE+UIV3Wy7K4CgAAAAgAAAAGAAAAcnVuLmpzS8xJLSrRMNQEAFBLAQI/AxQAAAgIAE+UIV3Wy7K4CgAAAAgAAAAGAAkAAAAAAAAAAAC0gQAAAABydW4uanNVVAUAAzaqlmpQSwUGAAAAAAEAAQA9AAAALgAAAAAA';
const maxDatabaseAgeMs = 7 * 24 * 60 * 60 * 1_000;
const maxFutureClockSkewMs = 5 * 60 * 1_000;

function fail(field) {
  throw new Error(`Scanner 候选报告字段无效：${field}`);
}

/** 本地报告只能证明 CLI 容器门禁，不得伪装成隔离扫描服务通过证据。 */
export function parseScannerCandidateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('report');
  const allowedKeys = [
    'imageTag', 'imageId', 'mode', 'nodeVersion', 'clamavVersion',
    'clamavDatabaseVersion', 'clamavDatabaseUpdatedAt',
    'clamavDatabaseAgeDays', 'uid', 'clean', 'manualReviewRequired',
    'eicar', 'invalid',
  ];
  if (
    Object.keys(value).length !== allowedKeys.length
    || Object.keys(value).some(key => !allowedKeys.includes(key))
  ) fail('keys');
  if (value.imageTag !== imageTag) fail('imageTag');
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.imageId)) fail('imageId');
  if (value.mode !== 'local-cli') fail('mode');
  if (!/^v22\./u.test(value.nodeVersion)) fail('nodeVersion');
  if (typeof value.clamavVersion !== 'string' || value.clamavVersion.length === 0) fail('clamavVersion');
  if (!/^\d+$/u.test(value.clamavDatabaseVersion)) fail('clamavDatabaseVersion');
  if (
    typeof value.clamavDatabaseUpdatedAt !== 'string'
    || Number.isNaN(Date.parse(value.clamavDatabaseUpdatedAt))
    || new Date(value.clamavDatabaseUpdatedAt).toISOString()
      !== value.clamavDatabaseUpdatedAt
  ) fail('clamavDatabaseUpdatedAt');
  if (
    !Number.isSafeInteger(value.clamavDatabaseAgeDays)
    || value.clamavDatabaseAgeDays < 0
    || value.clamavDatabaseAgeDays > 7
  ) fail('clamavDatabaseAgeDays');
  if (!Number.isSafeInteger(value.uid) || value.uid <= 0) fail('uid');
  if (value.clean !== 'manual-review-required') fail('clean');
  if (value.manualReviewRequired !== true) fail('manualReviewRequired');
  if (value.eicar !== 'blocked') fail('eicar');
  if (value.invalid !== 'rejected') fail('invalid');
  return value;
}

function spawnDocker(command, args, timeout) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
}

function docker(args, _purpose, timeout = 15 * 60 * 1_000) {
  const configuredCommand = process.env.DOCKER_CLI_PATH?.trim();
  let result = spawnDocker(configuredCommand || 'docker', args, timeout);
  if (
    !configuredCommand
    && result.error?.code === 'ENOENT'
    && process.platform === 'win32'
    && existsSync(windowsDockerCli)
  ) {
    result = spawnDocker(windowsDockerCli, args, timeout);
  }
  if (result.error?.code === 'ENOENT') {
    throw new Error('Docker runtime 不可用：找不到 docker 命令');
  }
  if (result.error) {
    throw new Error(`Docker 命令失败：${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runChecked(runDocker, args, purpose, expectedStatus = 0) {
  const result = runDocker(args, purpose);
  if (!result || typeof result !== 'object') {
    throw new Error(`${purpose}失败：Docker 执行器返回无效结果`);
  }
  if (result.status !== expectedStatus) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-4_000);
    throw new Error(`${purpose}失败（exit ${String(result.status)}）：${detail}`);
  }
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function assertCanonicalCliFailure(result, detailCode, purpose) {
  const expectedStderr = `${JSON.stringify({
    code: 'LOCAL_SCAN_FAILED',
    detailCode,
  })}\n`;
  if (result.stdout !== '' || result.stderr !== expectedStderr) {
    throw new Error(`${purpose}失败输出不规范`);
  }
}

function packageRunArgs(imageId, archivePath) {
  const mount = `type=bind,source=${resolve(archivePath)},target=/input/package.zip,readonly`;
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--tmpfs', '/tmp/scan:rw,noexec,nosuid,nodev,mode=1777',
    '--mount', mount,
    imageId, '/input/package.zip',
  ];
}

function databaseFreshness(probe, currentDate) {
  const updatedAt = probe?.clamavDatabaseUpdatedAt;
  if (
    typeof updatedAt !== 'string'
    || Number.isNaN(Date.parse(updatedAt))
    || new Date(updatedAt).toISOString() !== updatedAt
  ) {
    fail('clamavDatabaseUpdatedAt');
  }
  const ageMs = currentDate.getTime() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < -maxFutureClockSkewMs) {
    fail('clamavDatabaseUpdatedAt');
  }
  if (ageMs > maxDatabaseAgeMs) {
    throw new Error('Scanner 候选 ClamAV 病毒库已过期');
  }
  return {
    clamavDatabaseUpdatedAt: updatedAt,
    clamavDatabaseAgeDays: Math.floor(Math.max(0, ageMs) / (24 * 60 * 60 * 1_000)),
  };
}

/** 构建并运行本地 CLI 候选；不连接、读取或修改任何云端环境。 */
export function verifyScannerCandidate(
  runDocker = docker,
  now = () => new Date()
) {
  const buildDate = now();
  if (!(buildDate instanceof Date) || Number.isNaN(buildDate.getTime())) {
    fail('buildDate');
  }
  const databaseRefreshDate = buildDate.toISOString().slice(0, 10);
  runChecked(
    runDocker,
    ['version', '--format', '{{.Server.Version}}'],
    '检查 Docker runtime',
  );
  runChecked(runDocker, [
    'build', '--file', 'apps/package-scanner/Dockerfile',
    '--build-arg', `CLAMAV_DB_REFRESH_DATE=${databaseRefreshDate}`,
    '--tag', imageTag, '.',
  ], '构建 Scanner 候选镜像');
  const imageId = runChecked(
    runDocker,
    ['image', 'inspect', '--format', '{{.Id}}', imageTag],
    '读取 Scanner 候选镜像身份',
  ).stdout.trim();

  const probeMount = `type=bind,source=${resolve(probePath)},target=/candidate/probe.mjs,readonly`;
  const probeOutput = runChecked(runDocker, [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--mount', probeMount,
    '--entrypoint', 'node',
    imageId, '/candidate/probe.mjs',
  ], '读取 Scanner 候选运行时身份').stdout.trim();
  let probe;
  try {
    probe = JSON.parse(probeOutput);
  } catch (error) {
    throw new Error('Scanner 候选身份探针未返回单一 JSON', { cause: error });
  }
  const evaluatedAt = now();
  if (!(evaluatedAt instanceof Date) || Number.isNaN(evaluatedAt.getTime())) {
    fail('evaluatedAt');
  }
  const freshness = databaseFreshness(probe, evaluatedAt);

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scanner-candidate-'));
  try {
    const cleanPath = join(fixtureRoot, 'clean.zip');
    const eicarPath = join(fixtureRoot, 'eicar.zip');
    const invalidPath = join(fixtureRoot, 'invalid.zip');
    writeFileSync(cleanPath, Buffer.from(cleanPackageBase64, 'base64'));
    writeFileSync(eicarPath, Buffer.from(eicarPackageBase64, 'base64'));
    writeFileSync(invalidPath, Buffer.from(invalidPackageBase64, 'base64'));

    const cleanOutput = runChecked(
      runDocker,
      packageRunArgs(imageId, cleanPath),
      '运行 Scanner 候选干净包',
    ).stdout.trim();
    let cleanResult;
    try {
      cleanResult = JSON.parse(cleanOutput);
    } catch (error) {
      throw new Error('Scanner 候选干净包未返回单一 JSON', { cause: error });
    }
    if (
      cleanResult.code !== 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED'
      || cleanResult.manualReviewRequired !== true
    ) {
      throw new Error('Scanner 候选干净包缺少人工审核标记');
    }

    const eicarResult = runChecked(
      runDocker,
      packageRunArgs(imageId, eicarPath),
      '运行 Scanner 候选 EICAR 包',
      1,
    );
    assertCanonicalCliFailure(
      eicarResult,
      'CHARACTER_PACKAGE_MALWARE_DETECTED',
      'Scanner 候选 EICAR 包',
    );

    const invalidResult = runChecked(
      runDocker,
      packageRunArgs(imageId, invalidPath),
      '运行 Scanner 候选非法包',
      1,
    );
    assertCanonicalCliFailure(
      invalidResult,
      'CHARACTER_PACKAGE_FILE_TYPE_REJECTED',
      'Scanner 候选非法包',
    );

    return parseScannerCandidateReport({
      imageTag,
      imageId,
      mode: 'local-cli',
      ...probe,
      ...freshness,
      clean: 'manual-review-required',
      manualReviewRequired: true,
      eicar: 'blocked',
      invalid: 'rejected',
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(verifyScannerCandidate())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
