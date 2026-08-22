import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        // SDK 已从正式运行图删除；显式外置只为让未来残留 import 保留包名并触发生产门禁。
        include: ['@modelcontextprotocol/sdk'],
        exclude: [
          '@myself/agent-core',
          '@myself/character-assets',
          '@myself/character-runtime',
          '@myself/file-tools',
          '@myself/shared-types'
        ]
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        // 沙箱 preload 不能在运行时 require 普通 Node 依赖，白名单 Schema 必须随入口打包。
        exclude: [
          'zod',
          '@myself/character-runtime',
          '@myself/shared-types'
        ]
      },
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {}
});
