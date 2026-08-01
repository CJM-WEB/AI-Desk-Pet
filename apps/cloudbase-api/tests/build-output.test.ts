import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const distRoot = resolve(import.meta.dirname, '..', 'dist');

describe('CloudBase 函数构建产物', () => {
  it('三个部署入口均导出 main 且不包含源码映射', () => {
    for (const name of ['api', 'moderation-worker', 'cleanup']) {
      const entry = resolve(distRoot, name, 'index.js');
      expect(existsSync(entry), `${name} 入口应存在`).toBe(true);
      expect(require(entry).main, `${name} 应导出 main`).toBeTypeOf('function');
      expect(existsSync(`${entry}.map`), `${name} 不应包含源码映射`).toBe(false);
    }
  });

  it('三个部署入口均内嵌 Node SDK 动态加载的运行时依赖', () => {
    for (const name of ['api', 'moderation-worker', 'cleanup']) {
      const source = readFileSync(resolve(distRoot, name, 'index.js'), 'utf8');

      expect(source).not.toContain('npm install ws');
      expect(source).not.toContain('npm install @cloudbase/signature-nodejs');
      expect(source).not.toContain('npm install jsonwebtoken');
    }
  });
});
