import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const value = (args, name) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  ?? (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const scenarioNames = ['read', 'question', 'question_explicit', 'repair', 'reject', 'cancel'];
export function parseAcceptanceArguments(args) {
  const scenario = value(args, '--scenario');
  if ((scenario !== undefined || args.includes('--scenario')) && !scenarioNames.includes(scenario)) throw new Error('ACCEPTANCE_SCENARIO_INVALID');
  const selection = scenario === undefined ? {} : { scenario };
  const model = value(args, '--model') ?? 'qwen';
  if (model === 'deepseek') {
    const profileId = value(args, '--profile');
    const userData = value(args, '--user-data');
    if (!profileId || profileId === 'default') throw new Error('ACCEPTANCE_PROFILE_REQUIRED');
    if (!userData) throw new Error('ACCEPTANCE_USER_DATA_REQUIRED');
    return { model, profileId, userData, ...selection };
  }
  if (model !== 'qwen') throw new Error('ACCEPTANCE_MODEL_INVALID');
  const backend = value(args, '--backend');
  if (!backend) throw new Error('ACCEPTANCE_BACKEND_REQUIRED');
  if (!['cpu', 'vulkan'].includes(backend)) throw new Error('ACCEPTANCE_BACKEND_INVALID');
  return { model, backend, ...selection };
}
const code = candidate => typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,119}$/u.test(candidate) ? candidate : null;
const backend = candidate => ['cpu', 'vulkan'].includes(candidate) ? candidate : null;
const count = candidate => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
/** 每层重新构造白名单，模型正文与私有元数据不能随对象扩展进入记录。 */
export function createAcceptanceRecord(result) {
  const selection = scenarioNames.includes(result.selection) ? result.selection : 'all';
  return { schemaVersion: 2, selection, model: result.model === 'deepseek' ? 'deepseek' : 'qwen',
    modelId: typeof result.modelId === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(result.modelId) ? result.modelId : '',
    requestedBackend: backend(result.requestedBackend), activeBackend: backend(result.activeBackend),
    phase: ['passed', 'partial'].includes(result.phase) ? (selection === 'all' ? 'passed' : 'partial') : 'failed', reasonCode: code(result.reasonCode), cleanup: result.cleanup === true,
    checks: Object.fromEntries(['chineseChat', 'providerAbortRecovery', 'cloudCallsZero', 'cloudRouteRestored'].map(key => [key, result.checks?.[key] === true])),
    scenarios: (Array.isArray(result.scenarios) ? result.scenarios : []).filter(item => ['read', 'question', 'question_explicit', 'repair', 'reject', 'cancel'].includes(item.name)).slice(0, 6).map(item => ({
      name: item.name, phase: item.phase === 'passed' ? 'passed' : 'failed', reasonCode: code(item.reasonCode), operations: count(item.operations),
      exits: (Array.isArray(item.exits) ? item.exits : []).filter(exit => Number.isSafeInteger(exit) && Math.abs(exit) <= 2 ** 32).slice(0, 100)
    }))
  };
}
const progress = stage => { if (/^[A-Z_]{1,80}$/u.test(stage)) process.stderr.write(`ACCEPTANCE_STAGE ${stage}\n`); };
async function runElectron(outputFile, args, desktopRoot, bundleRoot) {
  const executable = createRequire(import.meta.url)('electron');
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, [outputFile, args.userData, args.profileId, desktopRoot, bundleRoot, args.scenario ?? 'all'], { windowsHide: true, timeout: 15 * 60_000 + 30_000, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result;
    child.on('message', message => {
      if (message?.type === 'progress') progress(message.stage);
      if (message?.type === 'result') result = createAcceptanceRecord(message.result);
    });
    child.once('error', () => reject(new Error('ELECTRON_START_FAILED')));
    child.once('exit', exit => result ? resolveRun(result) : reject(new Error(exit === 0 ? 'ELECTRON_RESULT_MISSING' : 'ELECTRON_FAILED')));
  });
}
async function run() {
  let bundleRoot;
  let output;
  try {
    const args = parseAcceptanceArguments(process.argv.slice(2));
    if (process.env.NODE_ENV === 'test' && process.env.AI_PET_LOCAL_MODEL_ACCEPTANCE_TIMEOUT_FIXTURE === '1') throw new Error('ACCEPTANCE_TIMEOUT');
    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    const desktopRoot = resolve(scriptDirectory, '..');
    bundleRoot = await mkdtemp(join(tmpdir(), 'ai-pet-local-model-acceptance-bundle-'));
    const outputFile = join(bundleRoot, 'runner.mjs');
    await buildAcceptanceBundle(scriptDirectory, outputFile, args.model);
    if (args.model === 'deepseek') output = await runElectron(outputFile, args, desktopRoot, bundleRoot);
    else {
      const runner = await import(pathToFileURL(outputFile).href);
      output = createAcceptanceRecord(await runner.runLocalModelAcceptance({ requestedBackend: args.backend, scenario: args.scenario, appPath: desktopRoot,
        resourceRoot: join(desktopRoot, 'resources', 'local-model'), applicationVersion: '0.1.0-alpha.1' }, progress));
    }
  } catch (error) { output = { schemaVersion: 2, phase: 'failed', reasonCode: code(error?.message) ?? 'ACCEPTANCE_FAILED' }; }
  finally {
    if (bundleRoot) {
      try {
        const actual = await realpath(bundleRoot);
        if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('ai-pet-local-model-acceptance-bundle-')) throw new Error('CLEANUP_ROOT_INVALID');
        await rm(actual, { recursive: true, force: true });
      } catch { output = { ...output, phase: 'failed', reasonCode: 'PROCESS_CLEANUP_FAILED', cleanup: false }; }
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!['passed', 'partial'].includes(output.phase)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();

export async function buildAcceptanceBundle(scriptDirectory, outputFile, model) {
  await build({ entryPoints: [join(scriptDirectory, model === 'deepseek' ? 'deepseek-acceptance-main.ts' : 'local-model-acceptance-runner.ts')],
    outfile: outputFile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire as acceptanceCreateRequire } from 'node:module'; const require = acceptanceCreateRequire(import.meta.url);" },
    mainFields: ['module', 'main'], external: ['electron'], sourcemap: false, logLevel: 'silent' });
}
