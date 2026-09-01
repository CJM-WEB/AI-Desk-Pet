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
  uid: 999,
  clean: 'manual-review-required',
  manualReviewRequired: true,
  eicar: 'blocked',
  invalid: 'rejected',
};

function dockerResult(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr };
}

function successfulDocker(commands, overrides = {}) {
  return (args, purpose) => {
    commands.push({ args, purpose });
    if (args[0] === 'version' || args[0] === 'build') return dockerResult();
    if (args[0] === 'image') return dockerResult(validReport.imageId);
    if (purpose.includes('运行时身份')) {
      return dockerResult(JSON.stringify({
        nodeVersion: validReport.nodeVersion,
        clamavVersion: validReport.clamavVersion,
        clamavDatabaseVersion: validReport.clamavDatabaseVersion,
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
        '{"detailCode":"CHARACTER_PACKAGE_MALWARE_DETECTED"}',
      );
    }
    if (purpose.includes('非法包')) {
      return overrides.invalid ?? dockerResult(
        '',
        1,
        '{"detailCode":"CHARACTER_PACKAGE_FILE_TYPE_REJECTED"}',
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
  const report = verifyScannerCandidate(successfulDocker(commands));

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
});

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
    /缺少病毒命中证据/u,
  ],
  [
    '非法包仅一般性失败',
    { invalid: dockerResult('', 1, '{"detailCode":"LOCAL_SCAN_FAILED"}') },
    /缺少结构拒绝证据/u,
  ],
  [
    'root 身份',
    { uid: 0 },
    /uid/u,
  ],
]) {
  test(`${name} 时不得生成候选报告`, () => {
    assert.throws(
      () => verifyScannerCandidate(successfulDocker([], overrides)),
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
