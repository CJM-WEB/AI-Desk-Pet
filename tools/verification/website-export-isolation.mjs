import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const E2E_EXPORT_DIRECTORY = '.e2e-out';
export const E2E_ADMIN_TOKEN = 'e2e-admin-session';
export const CANONICAL_EXPORT_ROOT = resolve(repositoryRoot, 'apps/website/out');
export const E2E_EXPORT_ROOT = resolve(
  repositoryRoot,
  'apps/website',
  E2E_EXPORT_DIRECTORY
);

/** canonical 产物缺失视为尚未构建；一旦存在则不得携带测试认证字面量。 */
export async function assertCanonicalExportClean() {
  const polluted = await findTokenFiles(CANONICAL_EXPORT_ROOT, E2E_ADMIN_TOKEN);
  if (polluted.length > 0) {
    throw new Error(`canonical out 含测试认证产物：${formatPaths(polluted)}`);
  }
}

/** E2E 服务只接受带测试认证代码的独立产物，禁止静默回退到 canonical out。 */
export async function assertE2eExportReady() {
  const polluted = await findTokenFiles(E2E_EXPORT_ROOT, E2E_ADMIN_TOKEN);
  if (polluted.length === 0) {
    throw new Error('独立 E2E 静态产物缺失测试认证代码');
  }
  await readFile(resolve(E2E_EXPORT_ROOT, 'index.html'));
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
