import type { NextConfig } from 'next';

const e2eBuildMode = process.env.AI_PET_WEBSITE_E2E_BUILD;
if (e2eBuildMode && e2eBuildMode !== '1') {
  throw new Error('AI_PET_WEBSITE_E2E_BUILD 只接受精确值 1');
}

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  // 测试模式只负责选中硬编码目录，外部输入永远不能成为文件系统路径。
  ...(e2eBuildMode === '1' ? { distDir: '.e2e-out' } : {})
};

export default config;
