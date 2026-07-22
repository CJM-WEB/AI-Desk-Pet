import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          '@myself/agent-core',
          '@myself/character-runtime',
          '@myself/file-tools',
          '@myself/shared-types'
        ]
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {}
});
