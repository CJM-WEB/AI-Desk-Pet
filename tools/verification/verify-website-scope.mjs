import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_ROOT_DEPENDENCY_RELOCATIONS,
  ALLOWED_ROOT_DEV_DEPENDENCY_CHANGES,
  ALLOWED_ROOT_SCRIPT_CHANGES,
  ALLOWED_WEBSITE_SCOPE_PATHS,
  FORBIDDEN_WEBSITE_SCOPE_PATHS,
  RETIRED_WEBSITE_SCOPE_PATHS,
  WEBSITE_SCOPE_BASELINE,
} from './website-scope-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/** 将 Git 与 Windows 路径统一为仓库相对 POSIX 路径，避免平台差异改变策略结果。 */
function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

/** 精确路径与以 /** 结尾的目录策略共享同一匹配规则。 */
function matchesPolicyPath(path, policyPath) {
  if (!policyPath.endsWith('/**')) {
    return path === policyPath;
  }

  return path.startsWith(policyPath.slice(0, -2));
}

/** 按黑名单、白名单和白名单外三类归纳变更；黑名单判定始终在前。 */
export function classifyChangedPaths(paths) {
  const result = { allowed: [], forbidden: [], outside: [] };

  for (const path of paths) {
    const normalizedPath = normalizePath(path);
    if (FORBIDDEN_WEBSITE_SCOPE_PATHS.some(policyPath => matchesPolicyPath(normalizedPath, policyPath))) {
      result.forbidden.push(normalizedPath);
    } else if (ALLOWED_WEBSITE_SCOPE_PATHS.some(policyPath => matchesPolicyPath(normalizedPath, policyPath))) {
      result.allowed.push(normalizedPath);
    } else {
      result.outside.push(normalizedPath);
    }
  }

  return result;
}

/** 确认仅为删除基线白名单的退役入口未恢复到工作树或 Git 索引。 */
export function assertRetiredWebsiteScopePathsAbsent(
  root,
  fileExists = existsSync,
  indexedPaths = [],
) {
  const indexedPathSet = new Set(indexedPaths.map(normalizePath));
  const restoredPaths = RETIRED_WEBSITE_SCOPE_PATHS
    .filter(path => fileExists(resolve(root, path)) || indexedPathSet.has(path));

  if (restoredPaths.length > 0) {
    throw new Error(`已退役路径不得恢复：${restoredPaths.join(', ')}`);
  }
}

/** 确认一个记录对象中的既有条目没有被删除或改写。 */
function assertExistingEntriesUnchanged(label, baseEntries, currentEntries) {
  for (const [key, value] of Object.entries(baseEntries)) {
    if (!Object.hasOwn(currentEntries, key) || currentEntries[key] !== value) {
      throw new Error(`${label} 不得变化: ${key}`);
    }
  }
}

/** 根 manifest 只允许批准脚本、开发依赖及 manager SDK 精确分类迁移。 */
export function assertRootManifestChange(baseManifest, currentManifest) {
  const baseScripts = baseManifest.scripts ?? {};
  const currentScripts = currentManifest.scripts ?? {};
  const baseDevDependencies = baseManifest.devDependencies ?? {};
  const currentDevDependencies = currentManifest.devDependencies ?? {};
  const baseDependencies = baseManifest.dependencies ?? {};
  const currentDependencies = currentManifest.dependencies ?? {};

  const relocatedDependencies = new Set(Object.entries(ALLOWED_ROOT_DEPENDENCY_RELOCATIONS)
    .filter(([name, version]) => baseDevDependencies[name] === version
      && !Object.hasOwn(currentDevDependencies, name)
      && currentDependencies[name] === version)
    .map(([name]) => name));
  const stableBaseDevDependencies = Object.fromEntries(
    Object.entries(baseDevDependencies).filter(([name]) => !relocatedDependencies.has(name)),
  );

  assertExistingEntriesUnchanged('根 manifest 原有脚本', baseScripts, currentScripts);
  assertExistingEntriesUnchanged('根 manifest 原有开发依赖', stableBaseDevDependencies, currentDevDependencies);
  assertExistingEntriesUnchanged('根 manifest 原有运行依赖', baseDependencies, currentDependencies);

  for (const [key, value] of Object.entries(currentScripts)) {
    if (!Object.hasOwn(baseScripts, key)
      && ALLOWED_ROOT_SCRIPT_CHANGES[key] !== value) {
      throw new Error(`根 manifest 不允许新增或改写脚本: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(currentDevDependencies)) {
    if (!Object.hasOwn(baseDevDependencies, key)
      && ALLOWED_ROOT_DEV_DEPENDENCY_CHANGES[key] !== value) {
      throw new Error(`根 manifest 不允许新增或改写开发依赖: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(currentDependencies)) {
    if (!Object.hasOwn(baseDependencies, key)
      && (!relocatedDependencies.has(key)
        || ALLOWED_ROOT_DEPENDENCY_RELOCATIONS[key] !== value)) {
      throw new Error(`根 manifest 不允许新增或改写运行依赖: ${key}`);
    }
  }

  const ignoredKeys = new Set(['scripts', 'dependencies', 'devDependencies']);
  const rootKeys = new Set([...Object.keys(baseManifest), ...Object.keys(currentManifest)]);
  for (const key of rootKeys) {
    if (!ignoredKeys.has(key) && !isDeepStrictEqual(baseManifest[key], currentManifest[key])) {
      throw new Error(`根 manifest 不允许变化: ${key}`);
    }
  }
}

/** 以参数数组执行只读 Git 命令，并保留失败命令的完整诊断。 */
function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败:\n${result.stdout}${result.stderr}`);
  }

  return result.stdout;
}

/** 读取索引中仍被跟踪的退役入口，防止暂存恢复后删除工作树绕过守卫。 */
function collectRetiredIndexedPaths() {
  return runGit(['ls-files', '--cached', '--', ...RETIRED_WEBSITE_SCOPE_PATHS])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(normalizePath);
}

/** 合并 Git 的路径输出并去重，空行不构成路径。 */
function collectChangedPaths() {
  const commands = [
    ['diff', '--name-only', `${WEBSITE_SCOPE_BASELINE}...HEAD`],
    ['diff', '--cached', '--name-only'],
    ['diff', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const paths = new Set();

  for (const command of commands) {
    for (const path of runGit(command).split(/\r?\n/u)) {
      if (path) {
        paths.add(normalizePath(path));
      }
    }
  }

  return [...paths];
}

/** 收集三种差异状态的空白错误，确保未暂存和暂存变更同样受检。 */
function collectWhitespaceErrors() {
  const commands = [
    ['diff', '--check', `${WEBSITE_SCOPE_BASELINE}...HEAD`],
    ['diff', '--cached', '--check'],
    ['diff', '--check'],
  ];
  const failures = [];

  for (const command of commands) {
    const result = spawnSync('git', command, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: false,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      failures.push(`git ${command.join(' ')}:\n${result.stdout}${result.stderr}`);
    }
  }

  return failures;
}

/** 读取固定基线与当前根 manifest，以语义比较防止借白名单改动桌宠门。 */
async function assertCurrentManifestChange() {
  const baseManifest = JSON.parse(runGit(['show', `${WEBSITE_SCOPE_BASELINE}:package.json`]));
  const currentManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assertRootManifestChange(baseManifest, currentManifest);
}

/** 执行范围、manifest 和空白三重检查；失败时逐项保留精确路径或键。 */
export async function verifyWebsiteScope() {
  const failures = [];
  const paths = collectChangedPaths();
  const classified = classifyChangedPaths(paths);

  for (const path of classified.allowed) {
    process.stdout.write(`允许路径: ${path}\n`);
  }
  for (const path of classified.forbidden) {
    failures.push(`禁止路径: ${path}`);
  }
  for (const path of classified.outside) {
    failures.push(`白名单外路径: ${path}`);
  }

  try {
    await assertCurrentManifestChange();
  } catch (error) {
    failures.push(error.message);
  }

  try {
    assertRetiredWebsiteScopePathsAbsent(
      repositoryRoot,
      existsSync,
      collectRetiredIndexedPaths(),
    );
  } catch (error) {
    failures.push(error.message);
  }

  failures.push(...collectWhitespaceErrors());
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyWebsiteScope().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
