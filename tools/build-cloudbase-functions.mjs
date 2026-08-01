import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = resolve(workspaceRoot, 'apps', 'cloudbase-api');
const distRoot = resolve(apiRoot, 'dist');
const requireFromApi = createRequire(resolve(apiRoot, 'package.json'));
const { build } = requireFromApi('esbuild');
const functions = {
  api: resolve(apiRoot, 'src', 'functions', 'api.ts'),
  'moderation-worker': resolve(
    apiRoot,
    'src',
    'functions',
    'moderation-worker.ts'
  ),
  cleanup: resolve(apiRoot, 'src', 'functions', 'cleanup.ts')
};

await build({
  entryPoints: Object.fromEntries(
    Object.entries(functions).map(([name, source]) => [`${name}/index`, source])
  ),
  outdir: distRoot,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  emptyOutdir: true,
  banner: { js: '/* AI Pet CloudBase 云函数部署产物 */' }
});

// 每个目录会独立部署，显式声明 CommonJS，避免被源码包的 ESM 配置继承。
for (const name of Object.keys(functions)) {
  const functionRoot = resolve(distRoot, name);
  await mkdir(functionRoot, { recursive: true });
  await writeFile(
    resolve(functionRoot, 'package.json'),
    `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
    'utf8'
  );
}
