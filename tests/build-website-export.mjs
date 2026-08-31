import { spawn } from 'node:child_process';
import {
  E2E_ADMIN_TOKEN,
  E2E_BUILD_MODE,
  assertCanonicalExportClean,
  createWebsiteExportBuildFinalizer
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
      AI_PET_WEBSITE_E2E_BUILD: E2E_BUILD_MODE
    },
    stdio: 'inherit'
  }
);

const finalize = createWebsiteExportBuildFinalizer();
child.once('error', error => void finalize({ error }));
child.once('exit', (code, signal) => void finalize({ code, signal }));
