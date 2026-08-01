import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV2 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import { CharacterIdentityInspector } from '../src/renderer/src/characters/workshop/CharacterIdentityInspector';
import { SkinList } from '../src/renderer/src/characters/workshop/SkinList';
import { SkinInspector } from '../src/renderer/src/characters/workshop/SkinInspector';
import { StateInspector } from '../src/renderer/src/characters/workshop/StateInspector';
import { ActionInspector } from '../src/renderer/src/characters/workshop/ActionInspector';
import {
  CharacterWorkshopWorkspace as CharacterWorkshopWorkspaceComponent
} from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import type {
  CharacterWorkshopApi,
  CharacterWorkshopState
} from '../src/renderer/src/characters/store/character-workshop-store';

const currentDraft: CharacterDraftV2 = {
  version: 2,
  id: 'nova',
  name: 'Nova',
  identity: {
    description: '桌面伙伴', background: '来自桌面', traits: ['友好'],
    languageStyle: '简洁', formsOfAddress: ['朋友'], likes: ['晴天'],
    dislikes: ['噪声'], behavioralTendencies: ['问候'], boundaries: ['尊重隐私'],
    exampleLines: ['你好。']
  },
  defaultSkinId: 'default',
  defaultStateId: 'idle',
  skins: [{
    id: 'default',
    name: '默认皮肤',
    presentations: [{
      actionId: 'idle-main', fps: 12, frames: [],
      anchors: { ground: { x: 0.5, y: 1 } }
    }],
    semanticFallbacks: []
  }],
  states: [{
    id: 'idle',
    name: '待机', kind: 'primary', semantic: 'idle', tags: [], intensity: 20,
    coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [],
    exitConditions: [], agentInferable: true, actionIds: ['idle-main']
  }, {
    id: 'thinking',
    name: '思考', kind: 'primary', semantic: 'think', tags: [], intensity: 50,
    coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [],
    exitConditions: [], agentInferable: true, actionIds: []
  }],
  actions: [{
    id: 'idle-main', name: '轻呼吸', semantic: 'idle', tags: [], preference: 1,
    cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
    allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
    forbiddenModifierStateIds: [], direction: 'any'
  }]
};

const characters: CharacterSummaryDto[] = [{
  id: 'default',
  name: 'AI Pet 默认角色',
  thumbnailAssetId: null,
  active: true,
  completeness: 'complete',
  missingRequirements: [],
  migrationRecoveryAvailable: false
}, {
  id: 'nova',
  name: 'Nova',
  thumbnailAssetId: null,
  active: false,
  completeness: 'incomplete',
  missingRequirements: ['default-presentation-unplayable'],
  migrationRecoveryAvailable: false
}];

function apiDouble(): CharacterWorkshopApi {
  return {
    listCharacters: vi.fn(async () => []),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    getCharacterDraft: vi.fn(),
    saveCharacterDraft: vi.fn(),
    chooseCharacterSources: vi.fn(),
    readCharacterSource: vi.fn(),
    publishCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    onCharacterWorkshopFlushRequested: vi.fn(() => vi.fn())
  };
}

function CharacterWorkshopWorkspace(props: {
  state: CharacterWorkshopState;
  pendingDeleteCharacterId?: string | null;
}) {
  return (
    <CharacterWorkshopWorkspaceComponent
      {...props}
      api={apiDouble()}
    />
  );
}

function state(
  overrides: Partial<CharacterWorkshopState> = {}
): CharacterWorkshopState {
  return {
    characters,
    selectedCharacterId: 'nova',
    draft: currentDraft,
    selectedEntity: { kind: 'action', actionId: 'idle-main' },
    selectedSkinId: 'default',
    selectedStateId: 'idle',
    selectedActionId: 'idle-main',
    draftStatus: 'saved',
    compileStatus: 'idle',
    loadStatus: 'ready',
    busyAction: null,
    toastQueue: [],
    availableSources: [],
    load: vi.fn(),
    mount: vi.fn(() => vi.fn()),
    selectCharacter: vi.fn(),
    selectIdentity: vi.fn(),
    selectSkin: vi.fn(),
    selectState: vi.fn(),
    selectAction: vi.fn(),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    importSources: vi.fn(),
    updateIdentity: vi.fn(),
    addSkin: vi.fn(),
    duplicateSkin: vi.fn(),
    updateSkin: vi.fn(),
    setDefaultSkin: vi.fn(),
    requestRemoveSkin: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    addState: vi.fn(),
    updateState: vi.fn(),
    requestRemoveState: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    addAction: vi.fn(),
    updateAction: vi.fn(),
    requestRemoveAction: vi.fn(() => ({ safeReferencePaths: [], blockingReferencePaths: [] })),
    removeAction: vi.fn(),
    addExtensionState: vi.fn(),
    removeExtensionState: vi.fn(),
    applySpriteSheet: vi.fn(),
    compileAndPublish: vi.fn(),
    publishCharacter: vi.fn(),
    updateCurrentAction: vi.fn(),
    flushDraft: vi.fn(),
    dismissToast: vi.fn(),
    dispose: vi.fn(),
    ...overrides
  };
}

async function workshopCss(): Promise<string> {
  return readFile(new URL(
    '../src/renderer/src/characters/workshop/character-workshop.css',
    import.meta.url
  ), 'utf8');
}

function cssToken(css: string, name: string): string {
  const value = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu'))?.[1];
  if (!value) throw new Error(`缺少 CSS token：${name}`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(index => (
    Number.parseInt(hex.slice(index, index + 2), 16) / 255
  )).map(value => (
    value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0]!
    + 0.7152 * channels[1]!
    + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe('角色工作室 SSR 外壳', () => {
  test('入口组件在没有 window 全局 API 时仍可由注入 API 完整 SSR', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopView api={apiDouble()} />
    );

    for (const text of [
      '角色',
      '状态与动作',
      '实时预览',
      '角色人设',
      '新建角色',
      '导入素材',
      '启用角色',
      '导入角色包',
      '导出角色包'
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('当前没有可编辑动作');
    expect(markup).not.toContain('window.myself');
  });

  test('已加载工作区显示角色、动作属性与真实草稿预览语义', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state()} />
    );

    expect(markup).toContain('AI Pet 默认角色');
    expect(markup).toContain('Nova');
    expect(markup).toContain('待机');
    expect(markup).toContain('思考');
    expect(markup).toContain('轻呼吸');
    expect(markup).toContain('12');
    expect(markup).toContain('class="draft-character-preview');
    expect(markup).toContain('data-preview-status="empty"');
    expect(markup).toContain('data-preview-direction="right"');
    expect(markup).toContain('data-preview-speed="1"');
    expect(markup).not.toContain('播放控制只使用当前草稿的内存快照');
    expect(markup).not.toContain('批量删除');
  });

  test('工具栏提供显式保存草稿命令', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state({ draftStatus: 'dirty' })} />
    );

    expect(markup).toContain('保存草稿');
  });

  test('新增入口位于状态与动作层级且顶部旧按钮已移除', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state()} />
    );
    const toolbar = markup.match(
      /<nav class="workshop-toolbar"[\s\S]*?<\/nav>/u
    )?.[0] ?? '';

    expect(toolbar).not.toContain('添加动作');
    expect(toolbar).not.toContain('扩展状态');
    expect(markup).toContain('aria-label="添加扩展状态"');
    expect(markup).toContain('aria-label="向“待机”添加动作"');
    expect(markup).toContain('aria-label="删除动作“轻呼吸”"');
  });

  test('默认状态没有减号而非默认主状态和修饰状态均可删除', () => {
    const extensionDraft: CharacterDraftV2 = {
      ...currentDraft,
      states: [
        ...currentDraft.states,
        {
          id: 'wave', name: '挥手', kind: 'modifier', semantic: 'speak', tags: [],
          intensity: 70, coexistWithStateIds: [], forbiddenStateIds: [],
          enterConditions: [], exitConditions: [], agentInferable: true, actionIds: []
        }
      ]
    };
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state({ draft: extensionDraft })} />
    );

    expect(markup).not.toContain('aria-label="删除状态“待机”"');
    expect(markup).toContain('aria-label="删除状态“思考”"');
    expect(markup).toContain('aria-label="向“挥手”添加动作"');
    expect(markup).toContain('aria-label="删除状态“挥手”"');
  });

  test('官方默认角色不呈现删除命令，自定义角色提供带标签的单项命令', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state()} />
    );

    expect(markup).not.toContain('aria-label="删除 AI Pet 默认角色"');
    expect(markup).toContain('aria-label="复制 Nova"');
    expect(markup).toContain('title="复制角色"');
    expect(markup).toContain('aria-label="删除 Nova"');
    expect(markup).toContain('title="删除角色"');
  });

  test('删除确认对话框包含明确对象、取消与危险操作，并由 dialog 管理焦点语义', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state()}
        pendingDeleteCharacterId="nova"
      />
    );

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('删除角色“Nova”');
    expect(markup).toContain('取消');
    expect(markup).toContain('确认删除');
    expect(markup).toContain('autofocus=""');
  });

  test('空、加载、错误和 busy 状态具有可访问反馈且命令禁用', () => {
    const loadingMarkup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          characters: [],
          selectedCharacterId: null,
          draft: null,
          selectedStateId: null,
          selectedActionId: null,
          loadStatus: 'loading',
          busyAction: 'loading'
        })}
      />
    );
    expect(loadingMarkup).toContain('正在加载角色');
    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('disabled=""');

    const emptyMarkup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          characters: [],
          selectedCharacterId: null,
          draft: null,
          selectedStateId: null,
          selectedActionId: null
        })}
      />
    );
    expect(emptyMarkup).toContain('还没有可编辑角色');
    expect(emptyMarkup).toContain('请选择角色后编辑动作');

    const errorMarkup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          loadStatus: 'error',
          toastQueue: [{
            id: 'load-error',
            tone: 'error',
            text: 'CHARACTER_LIST_FAILED'
          }]
        })}
      />
    );
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('CHARACTER_LIST_FAILED');
  });

  test('保存状态保持在右上角，临时提示为 fixed 队首覆盖层且不渲染旧横幅', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          draftStatus: 'saved',
          toastQueue: [
            { id: 'first', tone: 'info', text: '第一条。' },
            { id: 'second', tone: 'error', text: '第二条。' }
          ]
        })}
      />
    );

    expect(markup).toContain('草稿已保存');
    expect(markup).toContain('workshop-toast-layer');
    expect(markup).toContain('第一条。');
    expect(markup).not.toContain('第二条。');
    expect(markup).not.toContain('workshop-notice');
  });

  test.each([
    ['loading', '正在加载…'],
    ['creating', '正在创建…'],
    ['saving', '正在保存…'],
    ['compiling', '正在编译…'],
    ['activating', '正在启用…'],
    ['importing', '正在导入…'],
    ['exporting', '正在导出…'],
    ['deleting', '正在删除…']
  ] as const)('busyAction=%s 提供明确的 aria-live 状态文案', (
    busyAction,
    label
  ) => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          busyAction,
          draftStatus: busyAction === 'saving' ? 'saving' : 'saved'
        })}
      />
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(label);
  });

  test('后台保存即使没有 foreground busy 也提供正在保存状态', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace
        state={state({
          busyAction: null,
          draftStatus: 'saving'
        })}
      />
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('正在保存…');
  });

  test('Toast 固定覆盖层不占工作区轨道，窄窗口仍可滚动访问 Inspector', async () => {
    const css = await workshopCss();

    expect(css).toMatch(
      /\.character-workshop-shell\s*\{[^}]*grid-template-rows:\s*56px 45px minmax\(0,\s*1fr\);/su
    );
    expect(css).toMatch(
      /\.workshop-columns\s*\{[^}]*grid-row:\s*3;/su
    );
    expect(css).toMatch(
      /\.workshop-toast-layer\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*50;[^}]*top:\s*68px;[^}]*right:\s*16px;[^}]*pointer-events:\s*none;/su
    );
    expect(css).toMatch(
      /\.workshop-toast\s*\{[^}]*pointer-events:\s*auto;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*920px\)[\s\S]*?\.workshop-columns\s*\{[^}]*overflow-y:\s*auto;/su
    );
  });

  test('两列窄窗口使用稳定首行且只在 columns 内纵向滚动', async () => {
    const css = await workshopCss();

    expect(css).toMatch(
      /@media \(max-width:\s*920px\)[\s\S]*?\.workshop-columns\s*\{[^}]*grid-template-rows:\s*minmax\(500px,\s*auto\)\s+minmax\(280px,\s*auto\);[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*920px\)[\s\S]*?\.workshop-sidebar\s*\{[^}]*min-height:\s*500px;[^}]*height:\s*100%;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*920px\)[\s\S]*?\.workshop-stage\s*\{[^}]*min-height:\s*500px;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*920px\)[\s\S]*?\.workshop-inspector\s*\{[^}]*grid-row:\s*2;[^}]*grid-column:\s*1\s*\/\s*-1;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*?\.workshop-columns\s*\{[^}]*display:\s*block;[^}]*overflow:\s*visible;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*?\.character-workshop-shell\s*\{[^}]*height:\s*100vh;[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su
    );
  });

  test('375px 下头部保持 56px 且标题单行不被状态区挤出', async () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state()} />
    );
    const css = await workshopCss();

    expect(markup).toContain('class="workshop-eyebrow"');
    expect(css).toMatch(
      /\.workshop-header\s*\{[^}]*height:\s*56px;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su
    );
    expect(css).toMatch(
      /\.workshop-title\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;/su
    );
    expect(css).toMatch(
      /\.workshop-title > div\s*\{[^}]*min-width:\s*0;/su
    );
    expect(css).toMatch(
      /\.workshop-title h1\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.workshop-eyebrow\s*\{[^}]*display:\s*none;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.workshop-statuses\s*\{[^}]*gap:\s*8px;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.workshop-activity\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;/su
    );
    expect(css).toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.draft-indicator\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;/su
    );
  });

  test('主操作和危险色对白字均满足 WCAG AA 对比度', async () => {
    const css = await workshopCss();
    const primary = cssToken(css, '--workshop-orange');
    const danger = cssToken(css, '--workshop-danger');

    expect(primary).toBe('#b54708');
    expect(contrastRatio('#ffffff', primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', danger)).toBeGreaterThanOrEqual(4.5);
  });

  test('busy 图标旋转、减少动态时停止，且 H1 行高不溢出', async () => {
    const css = await workshopCss();

    expect(css).toMatch(
      /\.workshop-activity svg\s*\{[^}]*animation:\s*workshop-spin/su
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.workshop-activity svg\s*\{[^}]*animation:\s*none;/su
    );
    expect(css).toMatch(
      /\.workshop-title h1\s*\{[^}]*line-height:\s*1\.25;/su
    );
  });
});

describe('V2 结构化 Inspector', () => {
  test('角色与皮肤区域只保留一个二级标题', () => {
    const markup = renderToStaticMarkup(<CharacterWorkshopWorkspace state={state()} />);
    expect(markup.match(/<h2[^>]*>角色与皮肤<\/h2>/gu)).toHaveLength(1);
  });

  test('皮肤列表区分默认皮肤并只允许删除非默认皮肤', () => {
    const markup = renderToStaticMarkup(
      <SkinList
        skins={[
          { id: 'default', name: '默认皮肤', presentations: [], semanticFallbacks: [] },
          { id: 'winter', name: '冬装', presentations: [], semanticFallbacks: [] }
        ]}
        defaultSkinId="default"
        selectedSkinId="winter"
        disabled={false}
        onAdd={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    );

    expect(markup).toContain('aria-label="皮肤"');
    expect(markup).not.toContain('<h2');
    expect(markup).toContain('aria-label="新增皮肤"');
    expect(markup).not.toContain('删除皮肤“默认皮肤”');
    expect(markup).toContain('aria-label="删除皮肤“冬装”"');
  });

  test('人设只提供 V2 结构化字段且复杂字段具有持续帮助文字', () => {
    const markup = renderToStaticMarkup(
      <CharacterIdentityInspector
        identity={{
          description: '爱观察的桌宠',
          background: '来自数字花园',
          traits: ['好奇'],
          languageStyle: '简洁温和',
          formsOfAddress: ['朋友'],
          likes: ['晴天'],
          dislikes: ['噪声'],
          behavioralTendencies: ['主动问候'],
          boundaries: ['不读取隐私'],
          exampleLines: ['今天也一起加油。']
        }}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('角色描述');
    expect(markup).toContain('性格标签');
    expect(markup).toContain('最多 32 项');
    expect(markup).not.toMatch(/系统 Prompt|JSON|脚本/u);
  });

  test('皮肤属性说明当前表现覆盖状态且字段受协议长度限制', () => {
    const markup = renderToStaticMarkup(
      <SkinInspector
        skin={{
          id: 'winter',
          name: '冬装',
          description: '适合冬季',
          presentations: [{
            actionId: 'idle-main',
            fps: 12,
            frames: [],
            anchors: { ground: { x: 0.5, y: 1 } }
          }],
          semanticFallbacks: []
        }}
        selectedActionId="idle-main"
        presentationSource="skin-action"
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('皮肤名称');
    expect(markup).toContain('当前皮肤精确表现');
    expect(markup).toContain('maxLength="120"');
  });

  test.each([
    ['skin-action', '当前皮肤精确表现'],
    ['skin-semantic', '当前皮肤语义回退'],
    ['default-action', '默认皮肤动作'],
    ['default-state', '默认状态回退'],
    [null, '无可播放表现']
  ] as const)('皮肤检查器说明当前动作表现来源：%s', (presentationSource, expected) => {
    const markup = renderToStaticMarkup(
      <SkinInspector
        skin={{ id: 'winter', name: '冬装', presentations: [], semanticFallbacks: [] }}
        selectedActionId="idle-main"
        presentationSource={presentationSource}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain(expected);
  });

  test('状态属性只暴露可信 signal、标准语义和当前状态引用', () => {
    const markup = renderToStaticMarkup(
      <StateInspector
        state={{
          id: 'calm',
          name: '平静',
          kind: 'modifier',
          semantic: 'idle',
          tags: [],
          intensity: 50,
          coexistWithStateIds: [],
          forbiddenStateIds: [],
          enterConditions: [],
          exitConditions: [],
          agentInferable: false,
          actionIds: []
        }}
        allStates={[
          {
            id: 'idle', name: '待机', kind: 'primary', semantic: 'idle', tags: [],
            intensity: 20, coexistWithStateIds: [], forbiddenStateIds: [],
            enterConditions: [], exitConditions: [], agentInferable: false, actionIds: []
          }
        ]}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('进入条件类型');
    expect(markup).toContain('user-interaction');
    expect(markup).toContain('标准语义');
    expect(markup).toContain('当前状态引用');
    expect(markup).not.toMatch(/关键词|情绪文本/u);
  });

  test('动作属性从合法动作生成回退选项且不再编辑表现帧率', () => {
    const action = {
      id: 'wave', name: '挥手', semantic: 'speak' as const, tags: [], preference: 1,
      cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation' as const,
      interrupt: 'normal' as const, allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [],
      requiredModifierStateIds: [], forbiddenModifierStateIds: [], direction: 'any' as const
    };
    const fallback = { ...action, id: 'idle-main', name: '待机', semantic: 'idle' as const };
    const markup = renderToStaticMarkup(
      <ActionInspector
        action={action}
        actions={[action, fallback]}
        states={[]}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('动作失败回退');
    expect(markup).toContain('value="idle-main"');
    expect(markup).not.toMatch(/帧率|表现帧/u);
  });

  test('V2 列表与表单保持 44px 目标和至少 8px 操作间距', async () => {
    const css = await workshopCss();

    expect(css).toMatch(/\.skin-select\s*\{[^}]*min-height:\s*44px;/su);
    expect(css).toMatch(/\.inspector-form\s+(?:input|select|textarea)[^\{]*\{[^}]*min-height:\s*44px;/su);
    expect(css).toMatch(/\.skin-row-commands\s*\{[^}]*gap:\s*8px;/su);
    expect(css).toMatch(/\.recovery-actions\s*\{[^}]*gap:\s*8px;/su);
  });
});
