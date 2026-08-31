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

test('候选镜像按默认启动命令运行并以 Docker health 判定健康', () => {
  const commands = [];
  let inspectCount = 0;
  const runDocker = (args, purpose) => {
    commands.push({ args, purpose });
    if (args[0] === 'version' || args[0] === 'build') return '';
    if (args[0] === 'image') return validReport.imageId;
    if (args[0] === 'container') {
      inspectCount += 1;
      return inspectCount === 1 ? 'running starting' : 'running healthy';
    }
    if (args[0] === 'rm') return '';
    if (args[0] === 'run') {
      if (args.includes('--detach')) return 'candidate-container-id';
      return JSON.stringify({
        nodeVersion: validReport.nodeVersion,
        clamavVersion: validReport.clamavVersion,
        clamavDatabaseVersion: validReport.clamavDatabaseVersion,
        uid: validReport.uid,
        eicar: validReport.eicar,
        timeout: validReport.timeout,
      });
    }
    throw new Error(`未预期命令：${purpose}`);
  };

  assert.deepEqual(verifyScannerCandidate(runDocker, () => undefined), validReport);
  const candidateCommand = commands.find(command => (
    command.args[0] === 'run' && command.args.includes('--detach')
  ));
  assert.ok(candidateCommand);
  assert.deepEqual(candidateCommand.args, [
    'run', '--detach', '--network', 'none',
    '--env', 'SCANNER_INTERNAL_SECRET=scanner-candidate-local-secret',
    '--env', 'SCANNER_DOWNLOAD_HOSTS=candidate.invalid',
    '--env', 'SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS=signature',
    '--env', 'TENCENTCLOUD_SECRETID=candidate-local-secret-id',
    '--env', 'TENCENTCLOUD_SECRETKEY=candidate-local-secret-key',
    '--env', 'TENCENT_CLOUD_REGION=ap-singapore',
    validReport.imageId,
  ]);
  const healthCommands = commands.filter(command => command.args[0] === 'container');
  assert.deepEqual(healthCommands.map(command => command.args.at(-1)), [
    'candidate-container-id',
    'candidate-container-id',
  ]);
  const cleanupCommand = commands.find(command => command.args[0] === 'rm');
  assert.deepEqual(cleanupCommand?.args, [
    'rm', '--force', 'candidate-container-id',
  ]);

  const probeCommand = commands.find(command => (
    command.args[0] === 'run' && command.args.includes('--rm')
  ));
  assert.ok(probeCommand);
  assert.equal(probeCommand.args.at(-3), validReport.imageId);
  assert.equal(probeCommand.args.at(-3) === validReport.imageTag, false);
});

for (const [name, inspectedState, expectedError] of [
  ['health=unhealthy', 'running unhealthy', /unhealthy/u],
  ['容器已退出', 'exited missing', /已停止/u],
  ['inspect 失败', new Error('inspect failure'), /inspect failure/u],
]) {
  test(`${name} 时失败关闭并清理容器`, () => {
  const commands = [];
  const runDocker = (args) => {
    commands.push(args);
    if (args[0] === 'version' || args[0] === 'build') return '';
    if (args[0] === 'image') return validReport.imageId;
    if (args[0] === 'run') return 'candidate-container-id';
    if (args[0] === 'container') {
      if (inspectedState instanceof Error) throw inspectedState;
      return inspectedState;
    }
    if (args[0] === 'rm') return '';
    throw new Error(`未预期命令：${args.join(' ')}`);
  };

  assert.throws(
    () => verifyScannerCandidate(runDocker, () => undefined),
    expectedError,
  );
  assert.deepEqual(commands.at(-1), [
    'rm', '--force', 'candidate-container-id',
  ]);
  assert.equal(commands.some(args => args.includes('/candidate/probe.mjs')), false);
  });
}

test('候选镜像 health 一直 starting 时超时失败并清理容器', () => {
  const commands = [];
  const runDocker = (args) => {
    commands.push(args);
    if (args[0] === 'version' || args[0] === 'build') return '';
    if (args[0] === 'image') return validReport.imageId;
    if (args[0] === 'run') return 'candidate-container-id';
    if (args[0] === 'container') return 'running starting';
    if (args[0] === 'rm') return '';
    throw new Error(`未预期命令：${args.join(' ')}`);
  };

  assert.throws(
    () => verifyScannerCandidate(runDocker, () => undefined),
    /健康检查超时/u,
  );
  assert.deepEqual(commands.at(-1), [
    'rm', '--force', 'candidate-container-id',
  ]);
  assert.equal(commands.filter(args => args[0] === 'container').length > 1, true);
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
