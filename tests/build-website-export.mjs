import { spawn } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('缺少 pnpm CLI 路径，无法构建网站 E2E 静态导出');

/** E2E 静态产物固定请求同源内存 API，避免继承本机或部署环境配置。 */
const child = spawn(
  process.execPath,
  [pnpmCli, '--filter', '@myself/website', 'build'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: '/api/v1',
      NEXT_PUBLIC_WEBSITE_E2E_ADMIN_TOKEN: 'e2e-admin-session'
    },
    stdio: 'inherit'
  }
);

child.once('error', error => {
  console.error(`网站 E2E 构建启动失败：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`网站 E2E 构建被信号终止：${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
