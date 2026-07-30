import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const preloadPath = resolve('out/preload/index.cjs');
const source = await readFile(preloadPath, 'utf8');
const requiredModules = [...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)]
  .map(match => match[2]);
const unexpected = [...new Set(requiredModules)]
  .filter(moduleName => moduleName !== 'electron');

if (unexpected.length > 0) {
  throw new Error(`PRELOAD_EXTERNAL_REQUIRE_REJECTED:${unexpected.join(',')}`);
}

console.log('沙箱 preload 外部依赖校验通过。');
