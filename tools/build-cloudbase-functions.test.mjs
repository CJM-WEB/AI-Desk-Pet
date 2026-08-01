import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const distRoot = resolve(workspaceRoot, 'apps', 'cloudbase-api', 'dist');
const staleFile = resolve(distRoot, 'obsolete', 'stale.txt');

test('CloudBase 函数构建脚本兼容当前 esbuild', () => {
  mkdirSync(dirname(staleFile), { recursive: true });
  writeFileSync(staleFile, 'obsolete', 'utf8');

  const result = spawnSync(
    process.execPath,
    ['tools/build-cloudbase-functions.mjs'],
    { cwd: workspaceRoot, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(staleFile), false, '构建前的陈旧产物应被清理');
  for (const name of ['api', 'moderation-worker', 'cleanup']) {
    const entry = resolve(
      workspaceRoot,
      'apps',
      'cloudbase-api',
      'dist',
      name,
      'index.js'
    );
    assert.equal(existsSync(entry), true, `${name} 入口应存在`);
    assert.equal(typeof require(entry).main, 'function', `${name} 应导出 main`);
    assert.equal(existsSync(`${entry}.map`), false, `${name} 不应包含源码映射`);
  }
});
