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
});
