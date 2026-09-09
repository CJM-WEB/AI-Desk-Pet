import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';

const repositoryDirectory = fileURLToPath(new URL('../..', import.meta.url));

function gitValue(...arguments_: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repositoryDirectory, ...arguments_], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

/** 构建期只固化可公开类别与短哈希；绝对 Git 路径仅用于分类，不进入 Main 产物。 */
const gitDirectory = gitValue('rev-parse', '--path-format=absolute', '--git-dir');
const gitCommonDirectory = gitValue('rev-parse', '--path-format=absolute', '--git-common-dir');
const commitShortHash = gitValue('rev-parse', '--short=12', 'HEAD');
const buildIdentity = Object.freeze({
  commitShortHash: commitShortHash !== null && /^[0-9a-f]{12}$/u.test(commitShortHash)
    ? commitShortHash
    : 'unavailable',
  buildRootCategory: gitDirectory === null || gitCommonDirectory === null
    ? 'source_archive'
    : gitDirectory === gitCommonDirectory
      ? 'primary_checkout'
      : 'linked_worktree'
});

export default defineConfig({
  main: {
    resolve: {
      // Core 同时提供 UMD 与 ESM 的依赖时，Main 必须优先内联 ESM 入口。
      mainFields: ['module', 'main']
    },
    define: {
      __MYSELF_BUILD_IDENTITY__: JSON.stringify(buildIdentity)
    },
    build: {
      externalizeDeps: {
        // SDK 已从正式运行图删除；显式外置只为让未来残留 import 保留包名并触发生产门禁。
        include: ['@modelcontextprotocol/sdk'],
        exclude: [
          '@myself/agent-core',
          '@myself/coding-task-core',
          '@myself/character-assets',
          '@myself/character-runtime',
          '@myself/file-tools',
          '@myself/shared-types',
          '@opencode-ai/core',
          '@opencode-ai/llm',
          '@opencode-ai/effect-drizzle-sqlite',
          '@opencode-ai/schema',
          '@effect/platform-node',
          'effect',
          'drizzle-orm',
          'jsonc-parser'
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
