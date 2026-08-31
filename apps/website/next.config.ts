import type { NextConfig } from 'next';

const e2eBuildMode = process.env.AI_PET_WEBSITE_E2E_BUILD;
if (e2eBuildMode && e2eBuildMode !== '1') {
  throw new Error('AI_PET_WEBSITE_E2E_BUILD 只接受精确值 1');
}
const e2eModeEnabled = e2eBuildMode === '1';
const e2eTokenEnabled = Boolean(process.env.NEXT_PUBLIC_WEBSITE_E2E_ADMIN_TOKEN);
if (e2eModeEnabled !== e2eTokenEnabled) {
  throw new Error('E2E mode 与管理员测试令牌必须成对启用');
}

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  // 测试模式只负责选中硬编码目录，外部输入永远不能成为文件系统路径。
  ...(e2eModeEnabled ? { distDir: '.e2e-out' } : {})
};

export default config;
