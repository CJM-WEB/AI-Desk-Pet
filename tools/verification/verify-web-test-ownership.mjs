import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTestOwners } from './web-chain-catalog.mjs';

const OWNED_TEST_DIRECTORIES = Object.freeze([
  'packages/shared-types/tests',
  'apps/website/tests',
  'apps/cloudbase-api/tests',
  'apps/package-scanner/tests',
  'tools/release/tests',
  'tools/verification'
]);

const EXACT_TEST_FILES = Object.freeze([
  'tools/cloudbase-migration-inventory.test.mjs',
  'tools/cloudbase-user-migrations.test.mjs',
  'tools/cloudbase-user-migration-adapter.test.mjs',
  'tools/plan-cloudbase-migrations.test.mjs',
  'tools/build-cloudbase-functions.test.mjs',
  'tests/e2e/website.spec.ts'
]);

const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mjs)$/u;

/** 递归收集指定目录内符合网站链命名约定的测试文件。 */
async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(entryPath));
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

/**
 * 验证网站链测试均有且仅有一个归属；失败时逐行输出相对路径与归属列表。
 * @param {string} root 仓库根目录。
 * @returns {Promise<void>}
 */
export async function verifyWebTestOwnership(root) {
  const absoluteRoot = resolve(root);
  const files = [...EXACT_TEST_FILES.map(file => resolve(absoluteRoot, file))];

  for (const directory of OWNED_TEST_DIRECTORIES) {
    files.push(...await collectTestFiles(resolve(absoluteRoot, directory)));
  }

  const failures = files
    .map(file => {
      const path = relative(absoluteRoot, file).replaceAll('\\', '/');
      return { owners: findTestOwners(path), path };
    })
    .filter(({ owners }) => owners.length !== 1);

  if (failures.length > 0) {
    throw new Error(failures.map(({ path, owners }) => `${path}: ${owners.join(', ')}`).join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyWebTestOwnership(process.cwd()).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
