import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const distRoot = resolve(workspaceRoot, 'apps', 'cloudbase-api', 'dist');
const staleFile = resolve(distRoot, 'obsolete', 'stale.txt');
const { rewriteCloudBaseV3NodeRuntime } = await import(
  './build-cloudbase-functions.mjs'
);

const dynamicDependencyFixture = [
  'const ws=(0,ne.a)(["w","s"],"npm install ws");',
  'const signature=(0,v.optionalRequire)(["@cloudbase","/","signature-nodejs"],"npm install signature");',
  'const jwt=(0,ne.a)(["json","webtoken"],"npm install jsonwebtoken");'
].join('\n');

test('V3 Node rewrite 同时内嵌三个动态依赖', () => {
  const rewritten = rewriteCloudBaseV3NodeRuntime(dynamicDependencyFixture);

  assert.match(rewritten, /require\("ws"\)/u);
  assert.match(rewritten, /require\("@cloudbase\/signature-nodejs"\)/u);
  assert.match(rewritten, /require\("jsonwebtoken"\)/u);
  assert.doesNotMatch(rewritten, /optionalRequire|npm install/u);
});

test('V3 Node rewrite 缺少任一已锁定动态依赖时失败关闭', () => {
  for (const line of dynamicDependencyFixture.split('\n')) {
    const incomplete = dynamicDependencyFixture.replace(`${line}\n`, '')
      .replace(`\n${line}`, '');
    assert.throws(
      () => rewriteCloudBaseV3NodeRuntime(incomplete),
      /未找到 CloudBase 动态依赖/u
    );
  }
});

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
    const source = readFileSync(entry, 'utf8');
    for (const signature of [
      '["w", "s"]',
      '["@cloudbase", "/", "signature-nodejs"]',
      '["json", "webtoken"]'
    ]) {
      assert.equal(source.includes(signature), false, `${name} 不应保留 ${signature}`);
    }
  }
});
