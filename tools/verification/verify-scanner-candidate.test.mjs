import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseScannerCandidateReport,
  verifyScannerCandidate,
} from './verify-scanner-candidate.mjs';

const validReport = {
  imageTag: 'ai-pet-package-scanner:stage2-candidate',
  imageId: `sha256:${'a'.repeat(64)}`,
  mode: 'local-cli',
  nodeVersion: 'v22.22.0',
  clamavVersion: 'ClamAV 1.0.9',
  clamavDatabaseVersion: '27867',
  clamavDatabaseUpdatedAt: '2026-09-01T00:00:00.000Z',
  clamavDatabaseAgeDays: 0,
  uid: 999,
  clean: 'manual-review-required',
  manualReviewRequired: true,
  eicar: 'blocked',
  invalid: 'rejected',
};

function dockerResult(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr };
}

function cliFailure(detailCode) {
  return `${JSON.stringify({
    code: 'LOCAL_SCAN_FAILED',
    detailCode,
  })}\n`;
}

function successfulDocker(commands, overrides = {}) {
  return (args, purpose) => {
    commands.push({ args, purpose });
    if (args[0] === 'version' || args[0] === 'build') return dockerResult();
    if (args[0] === 'image') return dockerResult(validReport.imageId);
    if (purpose.includes('运行时身份')) {
      return dockerResult(JSON.stringify(overrides.probe ?? {
        nodeVersion: validReport.nodeVersion,
        clamavVersion: validReport.clamavVersion,
        clamavDatabaseVersion: validReport.clamavDatabaseVersion,
        clamavDatabaseUpdatedAt: validReport.clamavDatabaseUpdatedAt,
        uid: overrides.uid ?? validReport.uid,
      }));
    }
    if (purpose.includes('干净包')) {
      return overrides.clean ?? dockerResult(JSON.stringify({
        code: 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED',
        manualReviewRequired: true,
      }));
    }
    if (purpose.includes('EICAR')) {
      return overrides.eicar ?? dockerResult(
        '',
        1,
        cliFailure('CHARACTER_PACKAGE_MALWARE_DETECTED'),
      );
    }
    if (purpose.includes('非法包')) {
      return overrides.invalid ?? dockerResult(
        '',
        1,
        cliFailure('CHARACTER_PACKAGE_FILE_TYPE_REJECTED'),
      );
    }
    throw new Error(`未预期命令：${purpose}`);
  };
}

test('候选报告只接受本地 CLI 的人工审核与失败关闭证据', () => {
  assert.deepEqual(parseScannerCandidateReport(validReport), validReport);
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, mode: 'isolated-scanner' }),
    /mode/u,
  );
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, manualReviewRequired: false }),
    /manualReviewRequired/u,
  );
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, health: 'pass' }),
    /keys/u,
  );
});

test('候选镜像以无网络、只读输入、非 root 的本地 CLI 验证三类包', () => {
  const commands = [];
  const report = verifyScannerCandidate(
    successfulDocker(commands),
    () => new Date('2026-09-01T12:00:00.000Z'),
  );

  assert.deepEqual(report, validReport);
  const packageRuns = commands.filter(command => (
    command.args[0] === 'run'
    && command.args.includes('/input/package.zip')
  ));
  assert.equal(packageRuns.length, 3);
  for (const command of packageRuns) {
    assert.ok(command.args.includes('--network'));
    assert.ok(command.args.includes('none'));
    assert.ok(command.args.includes('--read-only'));
    assert.ok(command.args.some(argument => argument.includes('readonly')));
    assert.ok(command.args.includes('/tmp/scan:rw,noexec,nosuid,nodev,mode=1777'));
    assert.equal(command.args.some(argument => argument === '--env'), false);
    assert.equal(command.args.includes(validReport.imageId), true);
    assert.equal(command.args.includes(validReport.imageTag), false);
  }
  const identityRun = commands.find(command => command.purpose.includes('运行时身份'));
  assert.ok(identityRun?.args.includes('--network'));
  assert.ok(identityRun?.args.includes('none'));
  assert.ok(identityRun?.args.includes('--read-only'));
  assert.equal(identityRun?.args.includes('--env'), false);
  const buildCommand = commands.find(command => command.args[0] === 'build');
  assert.ok(buildCommand);
  assert.ok(buildCommand.args.includes('--build-arg'));
  assert.ok(buildCommand.args.includes('CLAMAV_DB_REFRESH_DATE=2026-09-01'));
});

test('病毒库年龄使用构建完成后的裁决时刻', () => {
  const times = [
    new Date('2026-09-01T00:00:00.000Z'),
    new Date('2026-09-01T00:10:00.000Z'),
  ];
  let callCount = 0;
  const report = verifyScannerCandidate(
    successfulDocker([], {
      probe: {
        nodeVersion: validReport.nodeVersion,
        clamavVersion: validReport.clamavVersion,
        clamavDatabaseVersion: validReport.clamavDatabaseVersion,
        clamavDatabaseUpdatedAt: '2026-09-01T00:09:00.000Z',
        uid: validReport.uid,
      },
    }),
    () => times[callCount++] ?? times.at(-1),
  );

  assert.equal(callCount, 2);
  assert.equal(report.clamavDatabaseAgeDays, 0);
});

test('构建期间跨过七天边界时按探针裁决时刻失败关闭', () => {
  const times = [
    new Date('2026-09-01T00:00:00.000Z'),
    new Date('2026-09-01T00:10:00.000Z'),
  ];
  let callCount = 0;

  assert.throws(
    () => verifyScannerCandidate(
      successfulDocker([], {
        probe: {
          nodeVersion: validReport.nodeVersion,
          clamavVersion: validReport.clamavVersion,
          clamavDatabaseVersion: validReport.clamavDatabaseVersion,
          clamavDatabaseUpdatedAt: '2026-08-25T00:05:00.000Z',
          uid: validReport.uid,
        },
      }),
      () => times[callCount++] ?? times.at(-1),
    ),
    /病毒库已过期/u,
  );
  assert.equal(callCount, 2);
});

for (const [name, probe, expectedError] of [
  [
    '病毒库时间缺失',
    {
      nodeVersion: validReport.nodeVersion,
      clamavVersion: validReport.clamavVersion,
      clamavDatabaseVersion: validReport.clamavDatabaseVersion,
      uid: validReport.uid,
    },
    /clamavDatabaseUpdatedAt/u,
  ],
  [
    '病毒库时间无法解析',
    {
      nodeVersion: validReport.nodeVersion,
      clamavVersion: validReport.clamavVersion,
      clamavDatabaseVersion: validReport.clamavDatabaseVersion,
      clamavDatabaseUpdatedAt: 'not-a-date',
      uid: validReport.uid,
    },
    /clamavDatabaseUpdatedAt/u,
  ],
  [
    '病毒库超过七天',
    {
      nodeVersion: validReport.nodeVersion,
      clamavVersion: validReport.clamavVersion,
      clamavDatabaseVersion: validReport.clamavDatabaseVersion,
      clamavDatabaseUpdatedAt: '2026-08-25T11:59:59.999Z',
      uid: validReport.uid,
    },
    /病毒库已过期/u,
  ],
]) {
  test(`${name}时失败关闭`, () => {
    assert.throws(
      () => verifyScannerCandidate(
        successfulDocker([], { probe }),
        () => new Date('2026-09-01T12:00:00.000Z'),
      ),
      expectedError,
    );
  });
}

for (const [name, overrides, expectedError] of [
  [
    '干净包非零退出',
    { clean: dockerResult('', 1, 'scan failed') },
    /干净包失败（exit 1）/u,
  ],
  [
    'EICAR 零退出',
    { eicar: dockerResult('{"manualReviewRequired":true}', 0) },
    /EICAR 包失败（exit 0）/u,
  ],
  [
    '非法包零退出',
    { invalid: dockerResult('{"manualReviewRequired":true}', 0) },
    /非法包失败（exit 0）/u,
  ],
  [
    'EICAR 仅一般性失败',
    { eicar: dockerResult('', 1, '{"detailCode":"LOCAL_SCAN_FAILED"}') },
    /EICAR 包失败输出不规范/u,
  ],
  [
    '非法包仅一般性失败',
    { invalid: dockerResult('', 1, '{"detailCode":"LOCAL_SCAN_FAILED"}') },
    /非法包失败输出不规范/u,
  ],
  [
    'EICAR stdout 夹带文本',
    {
      eicar: dockerResult(
        'unexpected',
        1,
        cliFailure('CHARACTER_PACKAGE_MALWARE_DETECTED'),
      ),
    },
    /EICAR 包失败输出不规范/u,
  ],
  [
    'EICAR stderr 夹带前缀',
    {
      eicar: dockerResult(
        '',
        1,
        `warning\n${cliFailure('CHARACTER_PACKAGE_MALWARE_DETECTED')}`,
      ),
    },
    /EICAR 包失败输出不规范/u,
  ],
  [
    'EICAR stderr 存在第二行',
    {
      eicar: dockerResult(
        '',
        1,
        `${cliFailure('CHARACTER_PACKAGE_MALWARE_DETECTED')}extra\n`,
      ),
    },
    /EICAR 包失败输出不规范/u,
  ],
  [
    '非法包 JSON 含额外字段',
    {
      invalid: dockerResult(
        '',
        1,
        '{"code":"LOCAL_SCAN_FAILED","detailCode":"CHARACTER_PACKAGE_FILE_TYPE_REJECTED","extra":true}\n',
      ),
    },
    /非法包失败输出不规范/u,
  ],
  [
    '非法包 JSON code 错误',
    {
      invalid: dockerResult(
        '',
        1,
        '{"code":"OTHER_FAILURE","detailCode":"CHARACTER_PACKAGE_FILE_TYPE_REJECTED"}\n',
      ),
    },
    /非法包失败输出不规范/u,
  ],
  [
    'root 身份',
    { uid: 0 },
    /uid/u,
  ],
]) {
  test(`${name} 时不得生成候选报告`, () => {
    assert.throws(
      () => verifyScannerCandidate(
        successfulDocker([], overrides),
        () => new Date('2026-09-01T12:00:00.000Z'),
      ),
      expectedError,
    );
  });
}

test('缺少 Docker runtime 时明确失败且不生成候选报告', () => {
  const scriptPath = fileURLToPath(
    new URL('./verify-scanner-candidate.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DOCKER_CLI_PATH: 'Z:\\missing-docker-runtime\\docker.exe',
      PATH: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Docker runtime 不可用/u);
  assert.doesNotMatch(result.stdout, /"mode":"local-cli"/u);
});
