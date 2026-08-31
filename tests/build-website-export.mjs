import { spawn } from 'node:child_process';
import {
  E2E_ADMIN_TOKEN,
  E2E_EXPORT_DIRECTORY,
  assertCanonicalExportClean,
  assertE2eExportReady
} from '../tools/verification/website-export-isolation.mjs';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('缺少 pnpm CLI 路径，无法构建网站 E2E 静态导出');
await assertCanonicalExportClean();

/** E2E 静态产物固定请求同源内存 API，避免继承本机或部署环境配置。 */
const child = spawn(
  process.execPath,
  [pnpmCli, '--filter', '@myself/website', 'build'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: '/api/v1',
      NEXT_PUBLIC_WEBSITE_E2E_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
      AI_PET_WEBSITE_E2E_EXPORT_DIRECTORY: E2E_EXPORT_DIRECTORY
    },
    stdio: 'inherit'
  }
);

child.once('error', error => {
  console.error(`网站 E2E 构建启动失败：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  if (signal) {
    console.error(`网站 E2E 构建被信号终止：${signal}`);
    process.exitCode = 1;
    return;
  }
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  try {
    await assertCanonicalExportClean();
    await assertE2eExportReady();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
