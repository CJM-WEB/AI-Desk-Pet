import { describe, expect, test } from 'vitest';
import config from '../electron.vite.config';

describe('Electron Vite workspace 打包', () => {
  test('Main 构建会内联全部 workspace 源码包', () => {
    if (typeof config === 'function' || config instanceof Promise) {
      throw new Error('测试要求 electron-vite 配置为静态对象');
    }

    expect(config.main?.build?.externalizeDeps).toEqual({
      exclude: [
        '@myself/agent-core',
        '@myself/character-assets',
        '@myself/character-runtime',
        '@myself/file-tools',
        '@myself/shared-types'
      ]
    });
  });
});
