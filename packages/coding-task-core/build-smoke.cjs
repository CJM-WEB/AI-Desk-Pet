// 复用桌面已有 esbuild 检查 Node ESM 分发闭包，输出仅用于本地验收。
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const esbuild = require(path.join(root, 'apps/desktop/node_modules/esbuild'));
const output = path.join(__dirname, '.electron-smoke/core.mjs');
const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/index.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true,
  mainFields: ['module', 'main'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }
});
fs.writeFileSync(path.join(__dirname, '.electron-smoke/meta.json'), JSON.stringify(result.metafile, null, 2));
process.stdout.write(JSON.stringify({ bytes: fs.statSync(output).size, inputs: Object.keys(result.metafile.inputs).length }) + '\n');
