import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';

// Node 原生类型擦除不补全扩展名；测试加载器只为仓库内相对 TypeScript 导入补全 .ts。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code !== 'ERR_MODULE_NOT_FOUND'
        || !context.parentURL
        || (!specifier.startsWith('./') && !specifier.startsWith('../'))
      ) {
        throw error;
      }
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (!existsSync(fileURLToPath(candidate))) throw error;
      return { shortCircuit: true, url: candidate.href };
    }
  }
});

const workspaceRoot = process.env.AI_PET_WORKSPACE_ROOT;
if (!workspaceRoot || typeof process.send !== 'function') {
  throw new Error('CHARACTER_COMPILE_PROCESS_INVALID');
}

let releaseDecode;
const decodeGate = new Promise(resolveGate => {
  releaseDecode = resolveGate;
});

globalThis.createImageBitmap = async () => {
  process.send({ type: 'decode_started' });
  await decodeGate;
  return {
    width: 2,
    height: 2,
    close() {}
  };
};

const compilerUrl = pathToFileURL(resolve(
  workspaceRoot,
  'apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts'
)).href;
const { compileAtlas } = await import(compilerUrl);
process.send({ type: 'ready' });

process.on('message', async message => {
  if (message?.type === 'release_decode') {
    releaseDecode();
    return;
  }
  if (message?.type !== 'start_compile') return;

  try {
    const result = await compileAtlas({
      atlasAssetId: 'integration-atlas',
      mimeType: 'image/png',
      frames: [{
        frameId: 'idle-1',
        sourceAssetId: 'integration-source',
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png'
      }]
    }, (width, height) => ({
      width,
      height,
      getContext: () => ({ drawImage() {} }),
      toBlob: callback => callback(new Blob([
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ], { type: 'image/png' }))
    }));
    process.send({
      type: 'compile_completed',
      width: result.width,
      height: result.height,
      frameCount: result.frames.length
    });
  } catch (error) {
    process.send({
      type: 'compile_failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
