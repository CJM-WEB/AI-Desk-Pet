import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const E2E_EXPORT_DIRECTORY = '.e2e-out';
export const E2E_BUILD_MODE = '1';
export const E2E_ADMIN_TOKEN = 'e2e-admin-session';
export const CANONICAL_EXPORT_ROOT = resolve(repositoryRoot, 'apps/website/out');
export const E2E_EXPORT_ROOT = resolve(
  repositoryRoot,
  'apps/website',
  E2E_EXPORT_DIRECTORY
);

/** E2E 静态构建固定使用同源 Memory API，不得继承正式管理员来源。 */
export function createWebsiteE2eBuildEnvironment(environment = process.env) {
  return {
    ...environment,
    NEXT_PUBLIC_API_BASE_URL: '/api/v1',
    NEXT_PUBLIC_ADMIN_ORIGIN: '',
    NEXT_PUBLIC_WEBSITE_E2E_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
    AI_PET_WEBSITE_E2E_BUILD: E2E_BUILD_MODE
  };
}

/** canonical 产物缺失视为尚未构建；一旦存在则不得携带测试认证字面量。 */
export async function assertCanonicalExportClean(root = CANONICAL_EXPORT_ROOT) {
  const polluted = await findTokenFiles(root, E2E_ADMIN_TOKEN);
  if (polluted.length > 0) {
    throw new Error(`canonical out 含测试认证产物：${formatPaths(polluted)}`);
  }
}

/** E2E 服务只接受带测试认证代码的独立产物，禁止静默回退到 canonical out。 */
export async function assertE2eExportReady(root = E2E_EXPORT_ROOT) {
  const polluted = await findTokenFiles(root, E2E_ADMIN_TOKEN);
  if (polluted.length === 0) {
    throw new Error('独立 E2E 静态产物缺失测试认证代码');
  }
  await readFile(resolve(root, 'index.html'));
}

/** 汇合 child 的全部终止事件，保证后置门禁先执行且一次构建只结算一次。 */
export function createWebsiteExportBuildFinalizer({
  assertCanonicalClean = assertCanonicalExportClean,
  assertE2eReady = assertE2eExportReady,
  reportError = message => console.error(message),
  setExitCode = code => { process.exitCode = code; }
} = {}) {
  let settled = false;

  return async outcome => {
    if (settled) return;
    settled = true;

    let canonicalFailed = false;
    try {
      await assertCanonicalClean();
    } catch (error) {
      canonicalFailed = true;
      reportError(formatError(error));
    }

    const succeeded = !outcome.error && !outcome.signal && outcome.code === 0;
    if (succeeded) {
      let e2eFailed = false;
      if (!canonicalFailed) {
        try {
          await assertE2eReady();
        } catch (error) {
          e2eFailed = true;
          reportError(formatError(error));
        }
      }
      setExitCode(canonicalFailed || e2eFailed ? 1 : 0);
      return;
    }

    if (outcome.error) {
      reportError(`网站 E2E 构建启动失败：${formatError(outcome.error)}`);
    } else if (outcome.signal) {
      reportError(`网站 E2E 构建被信号终止：${outcome.signal}`);
    }
    setExitCode(Number.isInteger(outcome.code) && outcome.code !== 0 ? outcome.code : 1);
  };
}

export async function findTokenFiles(root, token) {
  const files = await listFiles(root).catch(error => (
    error?.code === 'ENOENT' ? [] : Promise.reject(error)
  ));
  const marker = Buffer.from(token);
  const matches = [];
  for (const file of files) {
    if ((await readFile(file)).includes(marker)) matches.push(file);
  }
  return matches;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function formatPaths(paths) {
  return paths.map(path => relative(repositoryRoot, path)).join(', ');
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
