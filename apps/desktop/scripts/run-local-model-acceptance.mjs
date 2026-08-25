import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const allowedBackends = new Set(['cpu', 'vulkan']);

export function parseAcceptanceArguments(arguments_) {
  const equalArgument = arguments_.find(argument => argument.startsWith('--backend='));
  const backendIndex = arguments_.indexOf('--backend');
  const backend = equalArgument?.slice('--backend='.length)
    ?? (backendIndex >= 0 ? arguments_[backendIndex + 1] : undefined);
  if (backend === undefined || backend === '') throw new Error('ACCEPTANCE_BACKEND_REQUIRED');
  if (!allowedBackends.has(backend)) throw new Error('ACCEPTANCE_BACKEND_INVALID');
  return { backend };
}

/** 公开记录只从可信结果重新构造，禁止透传 Prompt、绝对路径、Token 或原始进程日志。 */
export function createAcceptanceRecord(result) {
  return {
    schemaVersion: 1,
    requestedBackend: result.requestedBackend,
    activeBackend: result.activeBackend,
    phase: result.phase,
    reasonCode: result.reasonCode,
    toolName: 'create_file',
    checks: {
      chineseChat: result.checks.chineseChat === true,
      reasoningDisabled: result.checks.reasoningDisabled === true,
      toolCall: result.checks.toolCall === true,
      confirmation: result.checks.confirmation === true,
      fileSideEffect: result.checks.fileSideEffect === true,
      toolResultSummary: result.checks.toolResultSummary === true,
      cancelRecovery: result.checks.cancelRecovery === true,
      cloudCallsZero: result.checks.cloudCallsZero === true,
      cloudRouteRestored: result.checks.cloudRouteRestored === true,
      createOperation: result.checks.createOperation === true,
      moveOperation: result.checks.moveOperation === true,
      deleteOperation: result.checks.deleteOperation === true,
      chineseRelativePath: result.checks.chineseRelativePath === true,
      clarification: result.checks.clarification === true,
      userRejected: result.checks.userRejected === true,
      toolFailureRecovery: result.checks.toolFailureRecovery === true
    }
  };
}

function isMainModule() {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function run() {
  let bundleRoot;
  let output;
  let succeeded = false;
  try {
    const { backend } = parseAcceptanceArguments(process.argv.slice(2));
    // 仅供 CLI 契约测试注入稳定超时码；双重测试开关避免影响人工真实验收。
    if (
      process.env.NODE_ENV === 'test'
      && process.env.AI_PET_LOCAL_MODEL_ACCEPTANCE_TIMEOUT_FIXTURE === '1'
    ) {
      throw new Error('ACCEPTANCE_TIMEOUT');
    }
    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    const desktopRoot = resolve(scriptDirectory, '..');
    bundleRoot = await mkdtemp(join(tmpdir(), 'ai-pet-local-model-acceptance-bundle-'));
    const outputFile = join(bundleRoot, 'runner.mjs');
    await build({
      entryPoints: [join(scriptDirectory, 'local-model-acceptance-runner.ts')],
      outfile: outputFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
      logLevel: 'silent'
    });
    const runner = await import(`${pathToFileURL(outputFile).href}?run=${Date.now()}`);
    const result = await runner.runLocalModelAcceptance({
      requestedBackend: backend,
      resourceRoot: join(desktopRoot, 'resources', 'local-model'),
      applicationVersion: '0.1.0-alpha.1'
    });
    output = createAcceptanceRecord(result);
    succeeded = true;
  } catch (error) {
    const reasonCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : 'ACCEPTANCE_FAILED';
    output = {
      schemaVersion: 1,
      phase: 'failed',
      reasonCode
    };
  } finally {
    if (bundleRoot !== undefined) {
      try {
        await rm(bundleRoot, { recursive: true, force: true });
      } catch {
        output = { schemaVersion: 1, phase: 'failed', reasonCode: 'PROCESS_CLEANUP_FAILED' };
        succeeded = false;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!succeeded) process.exitCode = 1;
}

if (isMainModule()) await run();
