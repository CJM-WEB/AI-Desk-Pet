import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dockerfilePath = fileURLToPath(
  new URL('../Dockerfile', import.meta.url)
);
const dockerignorePath = fileURLToPath(
  new URL('../../../.dockerignore', import.meta.url)
);

describe('扫描容器安全配置', () => {
  it('构建与运行阶段统一使用兼容 pnpm 11 的 Node.js 22', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');

    expect(dockerfile.match(/^FROM node:22-bookworm-slim/gmu)).toHaveLength(2);
    expect(dockerfile).not.toContain('node:20');
  });

  it('运行阶段使用非 root 用户、只提供本地 CLI 且不暴露服务端口', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');

    expect(dockerfile).toContain('WORKDIR /tmp/scan');
    expect(dockerfile).toContain('USER scanner:scanner');
    expect(dockerfile).toContain('/app/dist/local-scan-cli.js');
    expect(dockerfile).not.toMatch(/^EXPOSE\s/gmu);
    expect(dockerfile).not.toMatch(/^HEALTHCHECK\s/gmu);
    expect(dockerfile).not.toContain('SCANNER_INTERNAL_SECRET');
    expect(dockerfile).not.toContain('TENCENTCLOUD_');
  });

  it('Docker 构建上下文排除仓库、依赖、产物和临时缓存', async () => {
    const dockerignore = await readFile(dockerignorePath, 'utf8');

    expect(dockerignore).toContain('.git');
    expect(dockerignore).toContain('**/node_modules');
    expect(dockerignore).toContain('**/dist');
    expect(dockerignore).toContain('coverage');
    expect(dockerignore).toContain('.pnpm-store');
    expect(dockerignore).toContain('*.tmp');
  });
});
