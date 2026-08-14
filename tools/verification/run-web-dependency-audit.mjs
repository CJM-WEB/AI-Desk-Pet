import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WEB_AUDIT_INPUTS } from './web-chain-catalog.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const dependencyCruiserEntry = import.meta.resolve('dependency-cruiser');
const dependencyCruiserCli = fileURLToPath(
  new URL('../../bin/dependency-cruise.mjs', dependencyCruiserEntry),
);

/** 通过 Node 直接启动本地 CLI，参数以数组传递，避免 shell 解释用户输出参数。 */
const result = spawnSync(
  process.execPath,
  [
    dependencyCruiserCli,
    '--config',
    '.dependency-cruiser.web.mjs',
    ...process.argv.slice(2),
    ...WEB_AUDIT_INPUTS,
  ],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
