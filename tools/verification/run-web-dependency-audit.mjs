import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WEB_AUDIT_INPUTS } from './web-chain-catalog.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const dependencyCruiserEntry = import.meta.resolve('dependency-cruiser');
const dependencyCruiserCli = fileURLToPath(
  new URL('../../bin/dependency-cruise.mjs', dependencyCruiserEntry),
);

const ALLOWED_OUTPUT_ARGUMENTS = new Set(['--output-type', '--output-to']);

/** 只保留不会改写配置、输入和遍历范围的单值输出参数。 */
function parseOutputArguments(args) {
  const parsedArguments = [];
  const seenArguments = new Set();

  for (let index = 0; index < args.length; index += 2) {
    const argument = args[index];
    if (!ALLOWED_OUTPUT_ARGUMENTS.has(argument)) {
      throw new Error(`不支持参数 ${argument ?? '<空>'}`);
    }
    if (seenArguments.has(argument)) {
      throw new Error(`参数 ${argument} 不得重复`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`参数 ${argument} 缺少值`);
    }

    seenArguments.add(argument);
    parsedArguments.push(argument, value);
  }

  return parsedArguments;
}

/** 通过 Node 直接启动本地 CLI，参数以数组传递，避免 shell 解释输出参数。 */
function run() {
  let outputArguments;
  try {
    outputArguments = parseOutputArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`网站依赖审查参数错误：${error.message}\n`);
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    [
      dependencyCruiserCli,
      '--config',
      '.dependency-cruiser.web.mjs',
      ...outputArguments,
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

  return result.status ?? 1;
}

process.exitCode = run();
