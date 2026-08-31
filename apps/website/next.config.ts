import type { NextConfig } from 'next';

const e2eExportDirectory = process.env.AI_PET_WEBSITE_E2E_EXPORT_DIRECTORY;

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  // 测试构建必须落入独立静态目录，默认生产构建继续使用 canonical out。
  ...(e2eExportDirectory ? { distDir: e2eExportDirectory } : {})
};

export default config;
