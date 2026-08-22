import { describe, expect, test } from 'vitest';
import config from '../electron.vite.config';

describe('Electron Vite workspace 打包', () => {
  test('Main 构建会内联 workspace 源码并保留 SDK 包名供生产门禁检测', () => {
    if (typeof config === 'function' || config instanceof Promise) {
      throw new Error('测试要求 electron-vite 配置为静态对象');
    }

    expect(config.main?.build?.externalizeDeps).toEqual({
      include: ['@modelcontextprotocol/sdk'],
      exclude: [
        '@myself/agent-core',
        '@myself/character-assets',
        '@myself/character-runtime',
        '@myself/file-tools',
        '@myself/shared-types'
      ]
    });
  });

  test('沙箱 preload 会内联运行时 Schema 的全部普通依赖', () => {
    if (typeof config === 'function' || config instanceof Promise) {
      throw new Error('测试要求 electron-vite 配置为静态对象');
    }

    expect(config.preload?.build?.externalizeDeps).toEqual({
      exclude: [
        'zod',
        '@myself/character-runtime',
        '@myself/shared-types'
      ]
    });
  });
});
