import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: [
      '@myself/character-assets',
      '@myself/character-runtime',
      '@myself/shared-types',
      'yauzl',
      'zod'
    ]
  },
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    ssr: resolve(import.meta.dirname, 'src/server.ts'),
    rollupOptions: {
      external: [
        'sharp',
        'tencentcloud-sdk-nodejs'
      ],
      output: {
        entryFileNames: 'server.js'
      }
    }
  }
});
