import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const distRoot = resolve(import.meta.dirname, '..', 'dist');

describe('CloudBase 函数构建产物', () => {
  it('仅构建 API 与清理入口，且均导出 main 并不包含源码映射', () => {
    expect(readdirSync(distRoot).sort()).toEqual(['api', 'cleanup']);
    for (const name of ['api', 'cleanup']) {
      const entry = resolve(distRoot, name, 'index.js');
      expect(existsSync(entry), `${name} 入口应存在`).toBe(true);
      expect(require(entry).main, `${name} 应导出 main`).toBeTypeOf('function');
      expect(existsSync(`${entry}.map`), `${name} 不应包含源码映射`).toBe(false);
    }
  });

  it('两个部署入口均内嵌 V3 Node 动态加载的运行时依赖', () => {
    for (const name of ['api', 'cleanup']) {
      const source = readFileSync(resolve(distRoot, name, 'index.js'), 'utf8');

      expect(source).not.toContain('npm install ws');
      expect(source).not.toContain('npm install @cloudbase/signature-nodejs');
      expect(source).not.toContain('npm install jsonwebtoken');
    }
  });

  it('两个生产构建产物均可使用 Node 适配器创建运行时', () => {
    const testEnv = {
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_REGION: 'ap-shanghai',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      CLOUDBASE_API_KEY: 'test-key',
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'test-secret',
      SHARED_PACKAGE_SUBMISSIONS_ENABLED: 'false'
    } as const;
    const originalEnv = Object.fromEntries(
      Object.keys(testEnv).map(key => [key, process.env[key]])
    );
    Object.assign(process.env, testEnv);

    try {
      const api = require(resolve(distRoot, 'api', 'index.js')) as {
        createProductionHandler(context: { eventID: string }): () => Promise<unknown>;
      };
      const cleanup = require(resolve(distRoot, 'cleanup', 'index.js')) as {
        createProductionWorker(context: { eventID: string }): () => Promise<unknown>;
      };

      expect(() => api.createProductionHandler({ eventID: 'test-event' }))
        .not.toThrow();
      expect(() => cleanup.createProductionWorker({ eventID: 'test-event' }))
        .not.toThrow();
    } finally {
      for (const key of Object.keys(testEnv)) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);
});
