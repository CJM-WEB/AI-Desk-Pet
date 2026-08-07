import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CharacterDraftV2,
  CharacterManifestV2,
  CoreCharacterState
} from '@myself/character-runtime';
import { V1_STATE_SEMANTICS } from '@myself/character-runtime';
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

function presentation(state: CoreCharacterState, assetId: string) {
  return {
    actionId: `${state}-main`,
    fps: 8,
    // 第三帧是搬运循环的中段稳定姿势，避开起手首帧和收势末帧。
    ...(state === 'carrying' ? { commitFrameId: 'carrying-frame-3' } : {}),
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
    const draft: CharacterDraftV2 = {
      version: 2,
      id: DEFAULT_CHARACTER_ID,
      name: 'AI Pet 默认角色',
      thumbnailAssetId: 'idle-atlas',
      identity: {
        description: 'AI Pet 官方默认桌宠角色。',
        background: '随桌面应用一同安装的本地默认角色。',
        traits: ['友好', '可靠'],
        languageStyle: '简洁友好',
        formsOfAddress: [],
        likes: [],
        dislikes: [],
        behavioralTendencies: [],
        boundaries: [],
        exampleLines: []
      },
      defaultSkinId: 'default',
      defaultStateId: 'idle',
      skins: [{
        id: 'default',
        name: '默认皮肤',
        presentations: loaded.map(({ state, assetId }) => presentation(state, assetId)),
        semanticFallbacks: []
      }],
      states: loaded.map(({ state, assetId }) => ({
        id: state,
        name: state,
        kind: 'primary' as const,
        semantic: V1_STATE_SEMANTICS[state],
        tags: [],
        intensity: 1,
        coexistWithStateIds: [],
        forbiddenStateIds: [],
        enterConditions: [],
        exitConditions: [],
        agentInferable: false,
        actionIds: [`${state}-main`]
      })),
      actions: loaded.map(({ state }) => ({
        id: `${state}-main`,
        name: state,
        semantic: V1_STATE_SEMANTICS[state],
        tags: [],
        preference: 1,
        cooldownMs: 0,
        repeatSuppressionMs: 0,
        loopPolicy: 'until-interrupted' as const,
        interrupt: 'normal' as const,
        allowedPrimaryStateIds: [state],
        forbiddenPrimaryStateIds: [],
        requiredModifierStateIds: [],
        forbiddenModifierStateIds: [],
        direction: 'any' as const
      }))
    };
    const manifest: CharacterManifestV2 = {
      ...draft,
      thumbnailAssetId: 'idle-atlas',
      compilerVersion: 'official-default-v2',
      resources: loaded.map(({ state, assetId, bytes }) => ({
        assetId,
        fileName: `${state}.png`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength
      }))
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
