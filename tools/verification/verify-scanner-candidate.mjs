import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const imageTag = 'ai-pet-package-scanner:stage2-candidate';
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const probePath = fileURLToPath(
  new URL('./scanner-candidate-probe.mjs', import.meta.url),
);
const windowsDockerCli = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const healthPollAttempts = 60;
const healthPollIntervalMs = 2_000;

function fail(field) {
  throw new Error(`Scanner 候选报告字段无效：${field}`);
}

/** 严格校验真实容器探针输出，缺失任何门禁均不得生成候选报告。 */
export function parseScannerCandidateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('report');
  const allowedKeys = [
    'imageTag', 'imageId', 'nodeVersion', 'clamavVersion',
    'clamavDatabaseVersion', 'uid', 'health', 'eicar', 'timeout',
  ];
  if (
    Object.keys(value).length !== allowedKeys.length
    || Object.keys(value).some(key => !allowedKeys.includes(key))
  ) fail('keys');
  if (value.imageTag !== imageTag) fail('imageTag');
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.imageId)) fail('imageId');
  if (!/^v22\./u.test(value.nodeVersion)) fail('nodeVersion');
  if (typeof value.clamavVersion !== 'string' || value.clamavVersion.length === 0) fail('clamavVersion');
  if (!/^\d+$/u.test(value.clamavDatabaseVersion)) fail('clamavDatabaseVersion');
  if (!Number.isSafeInteger(value.uid) || value.uid <= 0) fail('uid');
  if (value.health !== 'pass') fail('health');
  if (value.eicar !== 'blocked') fail('eicar');
  if (value.timeout !== 'http-503') fail('timeout');
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

function docker(args, purpose, timeout = 15 * 60 * 1_000) {
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
    throw new Error(`${purpose}失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-4_000);
    throw new Error(`${purpose}失败（exit ${result.status}）：${detail}`);
  }
  return result.stdout.trim();
}

function wait(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

/** Docker HEALTHCHECK 是默认服务器能否启动的事实来源，探针不得替代此门。 */
function waitForCandidateHealth(runDocker, containerId, waitForNextPoll) {
  for (let attempt = 0; attempt < healthPollAttempts; attempt += 1) {
    const state = runDocker([
      'container', 'inspect', '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}',
      containerId,
    ], '读取 Scanner 候选容器健康状态', 30_000);
    const [runtimeStatus, healthStatus] = state.trim().split(/\s+/u);
    if (runtimeStatus !== 'running') {
      throw new Error(`Scanner 候选容器已停止：${runtimeStatus || 'unknown'}`);
    }
    if (healthStatus === 'healthy') return;
    if (healthStatus === 'unhealthy') {
      throw new Error('Scanner 候选容器 health=unhealthy');
    }
    if (healthStatus !== 'starting') {
      throw new Error(`Scanner 候选容器健康状态无效：${healthStatus || 'missing'}`);
    }
    if (attempt + 1 < healthPollAttempts) waitForNextPoll(healthPollIntervalMs);
  }
  throw new Error('Scanner 候选容器健康检查超时');
}

/** 构建并运行本地不可变 Scanner 候选；不连接或修改任何云端环境。 */
export function verifyScannerCandidate(runDocker = docker, waitForNextPoll = wait) {
  runDocker(
    ['version', '--format', '{{.Server.Version}}'],
    '检查 Docker runtime',
    30_000,
  );
  runDocker([
    'build', '--file', 'apps/package-scanner/Dockerfile',
    '--tag', imageTag, '.',
  ], '构建 Scanner 候选镜像');
  const imageId = runDocker(
    ['image', 'inspect', '--format', '{{.Id}}', imageTag],
    '读取 Scanner 候选镜像身份',
  );
  let containerId;
  try {
    containerId = runDocker([
      'run', '--detach', '--network', 'none',
      '--env', 'SCANNER_INTERNAL_SECRET=scanner-candidate-local-secret',
      '--env', 'SCANNER_DOWNLOAD_HOSTS=candidate.invalid',
      '--env', 'SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS=signature',
      '--env', 'TENCENTCLOUD_SECRETID=candidate-local-secret-id',
      '--env', 'TENCENTCLOUD_SECRETKEY=candidate-local-secret-key',
      '--env', 'TENCENT_CLOUD_REGION=ap-shanghai',
      imageId,
    ], '按默认命令启动 Scanner 候选容器').trim();
    if (!containerId) throw new Error('Scanner 候选容器 ID 为空');
    waitForCandidateHealth(runDocker, containerId, waitForNextPoll);
  } finally {
    if (containerId) {
      runDocker(
        ['rm', '--force', containerId],
        '清理 Scanner 候选容器',
        30_000,
      );
    }
  }
  const mount = `${resolve(probePath)}:/candidate/probe.mjs:ro`;
  const probeOutput = runDocker([
    'run', '--rm', '--network', 'none',
    '--volume', mount,
    imageId,
    'node', '/candidate/probe.mjs',
  ], '运行 Scanner 候选安全探针');
  let probe;
  try {
    probe = JSON.parse(probeOutput);
  } catch (error) {
    throw new Error('Scanner 候选探针未返回单一 JSON 报告', { cause: error });
  }
  return parseScannerCandidateReport({
    imageTag,
    imageId,
    ...probe,
    health: 'pass',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(verifyScannerCandidate())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
