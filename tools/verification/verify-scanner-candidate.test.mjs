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
  nodeVersion: 'v22.22.0',
  clamavVersion: 'ClamAV 1.0.9',
  clamavDatabaseVersion: '27867',
  uid: 999,
  health: 'pass',
  eicar: 'blocked',
  timeout: 'http-503',
};

test('候选报告绑定不可变镜像身份和全部运行时安全门', () => {
  assert.deepEqual(parseScannerCandidateReport(validReport), validReport);
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, imageId: 'latest' }),
    /imageId/u,
  );
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, uid: 0 }),
    /uid/u,
  );
  assert.throws(
    () => parseScannerCandidateReport({ ...validReport, timeout: 'pass' }),
    /timeout/u,
  );
});

test('容器探针按刚读取的不可变 image ID 启动', () => {
  const commands = [];
  const runDocker = (args, purpose) => {
    commands.push({ args, purpose });
    if (args[0] === 'version' || args[0] === 'build') return '';
    if (args[0] === 'image') return validReport.imageId;
    if (args[0] === 'run') {
      return JSON.stringify({
        nodeVersion: validReport.nodeVersion,
        clamavVersion: validReport.clamavVersion,
        clamavDatabaseVersion: validReport.clamavDatabaseVersion,
        uid: validReport.uid,
        health: validReport.health,
        eicar: validReport.eicar,
        timeout: validReport.timeout,
      });
    }
    throw new Error(`未预期命令：${purpose}`);
  };

  assert.deepEqual(verifyScannerCandidate(runDocker), validReport);
  const probeCommand = commands.find(command => command.args[0] === 'run');
  assert.ok(probeCommand);
  assert.equal(probeCommand.args.at(-3), validReport.imageId);
  assert.equal(probeCommand.args.at(-3) === validReport.imageTag, false);
});

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
  assert.doesNotMatch(result.stdout, /"health":"pass"/u);
});
