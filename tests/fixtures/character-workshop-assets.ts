import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type {
  CharacterActionDefinitionV3,
  CharacterActionPresentationV3,
  CharacterDraftV3,
  CharacterManifestV3,
  CharacterStateDefinitionV3
} from '@myself/character-runtime';
import { CharacterAssetService } from '../../apps/desktop/src/main/characters/character-asset-service';
import { CharacterPackageService } from '../../apps/desktop/src/main/characters/character-package-service';
import { CharacterStore } from '../../apps/desktop/src/main/characters/character-store';

const SPRITE_NAMES = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
] as const;

export interface CharacterWorkshopFixturePaths {
  characterAssetsDirectory: string;
  safeCharacterPackage: string;
  maliciousCharacterPackage: string;
  characterExportDestination: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeTraversalArchive(destination: string): Promise<void> {
  const temporary = `${destination}.source`;
  const requireFromDesktop = createRequire(
    resolve('apps/desktop/package.json')
  );
  const { ZipFile } = requireFromDesktop('yazl') as {
    ZipFile: new () => {
      outputStream: Readable;
      addBuffer(bytes: Buffer, path: string): void;
      end(): void;
    };
  };
  const archive = new ZipFile();
  archive.addBuffer(Buffer.from('blocked', 'utf8'), 'aa/escape.txt');
  const output = createWriteStream(temporary, { flags: 'wx' });
  archive.outputStream.pipe(output);
  archive.end();
  await finished(output);

  // yazl 正确拒绝路径穿越，因此测试夹具只在临时目录内等长替换 ZIP 条目名。
  const source = await readFile(temporary);
  const safeName = Buffer.from('aa/escape.txt', 'utf8');
  const unsafeName = Buffer.from('../escape.txt', 'utf8');
  let replacements = 0;
  for (let offset = 0; offset <= source.length - safeName.length; offset += 1) {
    if (!source.subarray(offset, offset + safeName.length).equals(safeName)) continue;
    unsafeName.copy(source, offset);
    replacements += 1;
  }
  if (replacements !== 2) throw new Error('E2E_TRAVERSAL_ARCHIVE_BUILD_FAILED');
  await writeFile(destination, source, { flag: 'wx' });
  await rm(temporary, { force: true });
}

/**
 * 使用独立合成小图生成 Electron fixture，避免测试与正式桌宠资源耦合。
 */
export async function materializeCharacterWorkshopFixtures(
  workspaceRoot: string,
  baseDirectory: string,
  characterAssetsDirectory: string,
  packagesDirectory: string,
  exportsDirectory: string
): Promise<CharacterWorkshopFixturePaths> {
  const sourceFile = resolve(
    workspaceRoot,
    'tests/fixtures/assets/character-workshop.png'
  );
  await Promise.all(SPRITE_NAMES.map(name => (
    copyFile(
      sourceFile,
      join(characterAssetsDirectory, `${name}.png`)
    )
  )));

  const stagingCharacters = join(baseDirectory, '.fixture-characters');
  const store = new CharacterStore(stagingCharacters);
  const assets = new CharacterAssetService(stagingCharacters);
  const characterId = 'e2e-safe-character';
  await store.create({ id: characterId, name: 'E2E 安全角色' });
  const [source] = await assets.importSources(characterId, [
    join(characterAssetsDirectory, 'idle.png')
  ]);
  if (!source) throw new Error('E2E_CHARACTER_SOURCE_MISSING');
  const bytes = await readFile(join(characterAssetsDirectory, 'idle.png'));
  const presentation = (
    actionId: string,
    assetId: string
  ): CharacterActionPresentationV3 => ({
    actionId,
    fps: actionId === 'safe-carry-action' ? 1 : 8,
    ...(actionId === 'safe-carry-action' ? { commitFrameId: 'frame-4' } : {}),
    frames: [0, 1, 2, 3].map(index => ({
      id: `frame-${index + 1}`,
      assetId,
      x: index * 256,
      y: 0,
      width: 256,
      height: 256
    })),
    anchors: {
      ground: { x: 0.5, y: 1 },
      carry: { x: 0.7, y: 0.45 }
    }
  });
  const action = (
    id: string,
    name: string,
    description: string,
    loopPolicy: CharacterActionDefinitionV3['loopPolicy'] = 'presentation'
  ): CharacterActionDefinitionV3 => ({
    id,
    name,
    description,
    tags: [],
    preference: 1,
    cooldownMs: 0,
    repeatSuppressionMs: 0,
    loopPolicy,
    interrupt: 'normal',
    direction: 'any'
  });
  const state = (
    id: string,
    name: string,
    description: string,
    actionId: string,
    enterConditions: CharacterStateDefinitionV3['enterConditions'] = []
  ): CharacterStateDefinitionV3 => ({
    id,
    name,
    description,
    tags: [],
    intensity: 50,
    enterConditions,
    exitConditions: [],
    agentInferable: true,
    actionIds: [actionId]
  });
  const identity = {
    description: '用于验证安全导入的 E2E 角色。',
    background: '由隔离测试夹具生成。',
    traits: ['可靠'],
    languageStyle: '简洁',
    formsOfAddress: ['伙伴'],
    likes: ['安全测试'],
    dislikes: ['路径穿越'],
    behavioralTendencies: ['保持待机'],
    boundaries: ['不访问真实用户目录'],
    exampleLines: ['测试已就绪。']
  };
  const states = [
    state('idle', '待机', '安静陪伴时的兜底表现。', 'safe-idle-action'),
    state('listening', '倾听', '专心听伙伴说话。', 'safe-listen-action'),
    state('thinking', '思考', '认真琢磨一个问题。', 'safe-think-action'),
    state('moving', '移动', '在原地展示轻快步伐。', 'safe-move-action'),
    state('success', '成功', '为伙伴的好消息感到欣喜。', 'safe-celebrate-action'),
    state('error', '失败', '对遇到挫折的伙伴表示关切。', 'safe-fail-action'),
    state('carrying', '搬运', '在原地展示抱起物品的动作。', 'safe-carry-action'),
    state('custom-wave', '挥手', '向刚互动的伙伴招手。', 'safe-wave-action', [{
      mode: 'all' as const,
      clauses: [{ kind: 'event' as const, event: 'user-interaction' }]
    }])
  ];
  const actions = [
    action('safe-idle-action', '待机', '轻轻呼吸。', 'until-interrupted'),
    action('safe-listen-action', '倾听', '侧耳倾听。'),
    action('safe-think-action', '思考', '托腮思考。'),
    action('safe-move-action', '移动', '原地踏步，不控制桌面位移。'),
    action('safe-celebrate-action', '庆祝', '轻快庆祝。'),
    action('safe-fail-action', '失败', '轻轻低头。'),
    action('safe-carry-action', '搬运', '展示抱起物品。'),
    action('safe-wave-action', '挥手', '抬手招呼伙伴。')
  ];
  /** 双皮肤夹具复用同一安全素材，仅用默认皮肤的播放属性证明兼容链未丢字段。 */
  const presentations = (
    assetId: string,
    useWinterPlayback = false
  ): CharacterActionPresentationV3[] => actions.map(item => ({
    ...presentation(item.id, assetId),
    ...(useWinterPlayback && item.id === 'safe-idle-action'
      ? { playbackRate: 1.5, mirrorX: true }
      : {})
  }));
  const draft: CharacterDraftV3 = {
    version: 3,
    id: characterId,
    name: 'E2E 安全角色',
    thumbnailAssetId: source.assetId,
    identity,
    defaultSkinId: 'winter',
    idleStateId: 'idle',
    skins: [
      {
        id: 'default',
        name: '默认皮肤',
        presentations: presentations(source.assetId)
      },
      {
        id: 'winter',
        name: '冬装',
        description: '用于验证隐藏编辑界面后的多皮肤兼容。',
        presentations: presentations(source.assetId, true)
      }
    ],
    states,
    actions
  };
  const manifest: CharacterManifestV3 = {
    version: 3,
    id: characterId,
    name: 'E2E 安全角色',
    thumbnailAssetId: 'atlas',
    identity,
    defaultSkinId: 'winter',
    idleStateId: 'idle',
    skins: [
      {
        id: 'default',
        name: '默认皮肤',
        presentations: presentations('atlas').map(item => ({
          ...item,
          geometry: {
            visualBounds: { x: 0, y: 0, width: 1, height: 1 },
            groundAnchor: { x: 0.5, y: 1 },
            resourceRevision: sha256(bytes)
          }
        }))
      },
      {
        id: 'winter',
        name: '冬装',
        description: '用于验证隐藏编辑界面后的多皮肤兼容。',
        presentations: presentations('atlas', true).map(item => ({
          ...item,
          geometry: {
            visualBounds: { x: 0, y: 0, width: 1, height: 1 },
            groundAnchor: { x: 0.5, y: 1 },
            resourceRevision: sha256(bytes)
          }
        }))
      }
    ],
    states,
    actions,
    compilerVersion: 'e2e-fixture-1',
    resources: [{
      assetId: 'atlas',
      fileName: 'atlas.png',
      sha256: sha256(bytes),
      byteLength: bytes.byteLength
    }]
  };
  await store.saveDraft(characterId, draft);
  await store.publishCompiled(characterId, manifest, { 'atlas.png': bytes });

  const safeCharacterPackage = join(packagesDirectory, 'safe-character.zip');
  const maliciousCharacterPackage = join(
    packagesDirectory,
    'malicious-character.zip'
  );
  await new CharacterPackageService(stagingCharacters)
    .exportCharacter(characterId, safeCharacterPackage);
  await writeTraversalArchive(maliciousCharacterPackage);
  await rm(stagingCharacters, { recursive: true, force: true });

  return {
    characterAssetsDirectory,
    safeCharacterPackage,
    maliciousCharacterPackage,
    characterExportDestination: join(exportsDirectory, 'exported-character.zip')
  };
}
