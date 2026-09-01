import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: [
      '@myself/character-assets',
      '@myself/character-runtime',
      'yauzl',
      'zod'
    ]
  },
  build: {
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    ssr: resolve(import.meta.dirname, 'src/local-scan-cli.ts'),
    rollupOptions: {
      external: ['sharp'],
      output: {
        entryFileNames: 'local-scan-cli.js'
      }
    }
  }
});
