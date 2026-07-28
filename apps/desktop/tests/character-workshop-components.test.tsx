import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import type { CharacterSummaryDto } from '../src/shared/character-ipc';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import {
  CharacterWorkshopWorkspace
} from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import type {
  CharacterWorkshopApi,
  CharacterWorkshopState
} from '../src/renderer/src/characters/store/character-workshop-store';

const currentDraft: CharacterDraftV1 = {
  version: 1,
  id: 'nova',
  name: 'Nova',
  states: [{
    id: 'idle',
    kind: 'core',
    actions: [{
      id: 'idle-main',
      name: '轻呼吸',
      fps: 12,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: []
    }]
  }, {
    id: 'thinking',
    kind: 'core',
    actions: []
  }]
};

const characters: CharacterSummaryDto[] = [{
  id: 'default',
  name: 'AI Pet 默认角色',
  thumbnailAssetId: null,
  active: true,
  completeness: 'complete',
  missingCoreStates: []
}, {
  id: 'nova',
  name: 'Nova',
  thumbnailAssetId: null,
  active: false,
  completeness: 'incomplete',
  missingCoreStates: ['listening']
}];

function apiDouble(): CharacterWorkshopApi {
  return {
    listCharacters: vi.fn(async () => []),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    getCharacterDraft: vi.fn(),
    saveCharacterDraft: vi.fn(),
    chooseCharacterSources: vi.fn(),
    publishCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    onCharacterWorkshopFlushRequested: vi.fn(() => vi.fn())
  };
}

function state(
  overrides: Partial<CharacterWorkshopState> = {}
): CharacterWorkshopState {
  return {
    characters,
    selectedCharacterId: 'nova',
    draft: currentDraft,
    selectedStateId: 'idle',
    selectedActionId: 'idle-main',
    draftStatus: 'saved',
    compileStatus: 'idle',
    loadStatus: 'ready',
    busyAction: null,
    notice: null,
    availableSources: [],
    load: vi.fn(),
    mount: vi.fn(() => vi.fn()),
    selectCharacter: vi.fn(),
    selectState: vi.fn(),
    selectAction: vi.fn(),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    importSources: vi.fn(),
    addAction: vi.fn(),
    addExtensionState: vi.fn(),
    applySpriteSheet: vi.fn(),
    compileAndPublish: vi.fn(),
    publishCharacter: vi.fn(),
    updateCurrentAction: vi.fn(),
    flushDraft: vi.fn(),
    clearNotice: vi.fn(),
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
      '动作属性',
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

  test('已加载工作区显示角色与状态列表、动作属性和稳定预留面板', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state()} />
    );

    expect(markup).toContain('AI Pet 默认角色');
    expect(markup).toContain('Nova');
    expect(markup).toContain('待机');
    expect(markup).toContain('思考');
    expect(markup).toContain('轻呼吸');
    expect(markup).toContain('12');
    expect(markup).toContain('播放控制只使用当前草稿的内存快照');
    expect(markup).not.toContain('批量删除');
  });

  test('工具栏提供显式保存草稿命令', () => {
    const markup = renderToStaticMarkup(
      <CharacterWorkshopWorkspace state={state({ draftStatus: 'dirty' })} />
    );

    expect(markup).toContain('保存草稿');
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
          notice: { tone: 'error', text: 'CHARACTER_LIST_FAILED' }
        })}
      />
    );
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('CHARACTER_LIST_FAILED');
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

  test('CSS 固定工作区为第四轨道且窄窗口可滚动访问 Inspector', async () => {
    const css = await workshopCss();

    expect(css).toMatch(
      /\.character-workshop-shell\s*\{[^}]*grid-template-rows:\s*56px 45px auto minmax\(0,\s*1fr\);/su
    );
    expect(css).toMatch(
      /\.workshop-columns\s*\{[^}]*grid-row:\s*4;/su
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
