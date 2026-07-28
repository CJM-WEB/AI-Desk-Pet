import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CharacterDraftV1,
  CharacterManifestV1,
  CoreCharacterState
} from '@myself/character-runtime';
import type { CharacterStore } from './character-store';

const DEFAULT_CHARACTER_ID = 'builtin-default';
const DEFAULT_STATES: readonly CoreCharacterState[] = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function action(state: CoreCharacterState, assetId: string) {
  return {
    id: `${state}-main`,
    name: state,
    fps: 8,
    loop: true,
    weight: 1,
    direction: 'any' as const,
    anchors: {
      ground: { x: 0.5, y: 1 },
      ...(state === 'carrying' ? { carry: { x: 0.7, y: 0.45 } } : {})
    },
    frames: [0, 1, 2, 3].map(index => ({
      id: `${state}-frame-${index + 1}`,
      assetId,
      x: index * 256,
      y: 0,
      width: 256,
      height: 256
    }))
  };
}

/**
 * 官方默认角色只读取随包固定资源；重复调用复用已校验运行版本。
 */
export async function ensureOfficialDefaultCharacter(
  store: CharacterStore,
  resourceDirectory: string
): Promise<void> {
  const existing = await store.list();
  if (!existing.some(character => character.id === DEFAULT_CHARACTER_ID)) {
    await store.create({
      id: DEFAULT_CHARACTER_ID,
      name: 'AI Pet 默认角色'
    });
  }

  let runtimeReady = false;
  try {
    await store.getRuntimeManifest(DEFAULT_CHARACTER_ID);
    runtimeReady = true;
  } catch {
    runtimeReady = false;
  }

  if (!runtimeReady) {
    const loaded = await Promise.all(DEFAULT_STATES.map(async state => {
      const bytes = await readFile(join(resourceDirectory, `${state}.png`));
      return { state, bytes, assetId: `${state}-atlas` };
    }));
    const draft: CharacterDraftV1 = {
      version: 1,
      id: DEFAULT_CHARACTER_ID,
      name: 'AI Pet 默认角色',
      thumbnailAssetId: 'idle-atlas',
      states: loaded.map(({ state, assetId }) => ({
        id: state,
        kind: 'core' as const,
        actions: [action(state, assetId)]
      }))
    };
    const manifest: CharacterManifestV1 = {
      version: 1,
      id: DEFAULT_CHARACTER_ID,
      name: 'AI Pet 默认角色',
      thumbnailAssetId: 'idle-atlas',
      compilerVersion: 'official-default-v1',
      resources: loaded.map(({ state, assetId, bytes }) => ({
        assetId,
        fileName: `${state}.png`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength
      })),
      states: draft.states
    };
    await store.saveDraft(DEFAULT_CHARACTER_ID, draft);
    await store.publishCompiled(
      DEFAULT_CHARACTER_ID,
      manifest,
      Object.fromEntries(loaded.map(({ state, bytes }) => [
        `${state}.png`,
        bytes
      ]))
    );
  }

  await store.setActive(DEFAULT_CHARACTER_ID);
}
