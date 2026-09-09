// 用当前桌面依赖的真实 Electron 二进制运行同一读取与终态验收，不借用系统 Node。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('./build-smoke.cjs');
const electron = require(path.join(root, 'apps/desktop/node_modules/electron'));
const result = spawnSync(electron, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(__dirname, 'vitest.config.ts'), ...process.argv.slice(2)], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODING_TEST_ELECTRON: '1', CODING_CORE_BUNDLE: path.join(__dirname, '.electron-smoke/core.mjs') },
  encoding: 'utf8', windowsHide: true, timeout: 60000
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (!result.stdout?.includes('Test Files')) throw new Error('Electron 未输出测试执行结果');
process.exit(result.status ?? 1);
