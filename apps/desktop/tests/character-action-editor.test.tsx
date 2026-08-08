import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type {
  AnchorSet,
  CharacterActionDefinitionV2,
  DraftActionClip,
  InteractionRegion
} from '@myself/character-runtime';
import {
  deleteFrame,
  duplicateFrame,
  ensureStableFrameIds,
  reorderFrames,
  updateFrameDuration
} from '../src/renderer/src/characters/workshop/ActionTimeline';
import {
  AnchorEditor,
  beginCanvasInteraction,
  derivePreviewAnchors,
  finishCanvasInteraction,
  mirrorAnchor,
  mirrorRegion,
  moveCanvasInteraction,
  screenToNormalizedPoint,
  updateAnchor,
  updateAnchorCoordinate
} from '../src/renderer/src/characters/workshop/AnchorEditor';
import {
  createPreviewState,
  normalizePreviewState,
  PreviewControls,
  reducePreviewState
} from '../src/renderer/src/characters/workshop/PreviewControls';
import {
  IncompleteCharacterDialog
} from '../src/renderer/src/characters/workshop/IncompleteCharacterDialog';
import {
  ActionInspector
} from '../src/renderer/src/characters/workshop/ActionInspector';

const action: DraftActionClip = {
  id: 'idle-main',
  name: '待机',
  fps: 12,
  loop: true,
  weight: 1,
  direction: 'any',
  anchors: { ground: { x: 0.5, y: 1 } },
  frames: [{
    id: 'frame-a',
    assetId: 'idle-atlas',
    x: 0,
    y: 0,
    width: 64,
    height: 64
  }, {
    id: 'frame-b',
    assetId: 'idle-atlas',
    x: 64,
    y: 0,
    width: 64,
    height: 64
  }, {
    id: 'frame-c',
    assetId: 'idle-atlas',
    x: 128,
    y: 0,
    width: 64,
    height: 64
  }]
};

const actionDefinition: CharacterActionDefinitionV2 = {
  id: 'idle-main',
  name: '待机',
  semantic: 'idle',
  tags: [],
  preference: 1,
  cooldownMs: 0,
  repeatSuppressionMs: 0,
  loopPolicy: 'presentation',
  interrupt: 'normal',
  allowedPrimaryStateIds: [],
  forbiddenPrimaryStateIds: [],
  requiredModifierStateIds: [],
  forbiddenModifierStateIds: [],
  direction: 'any'
};

describe('动作时间轴', () => {
  test('拖动帧后提交稳定的新顺序', () => {
    const next = reorderFrames(action.frames, 2, 0);

    expect(next.map(frame => frame.id)).toEqual([
      'frame-c',
      'frame-a',
      'frame-b'
    ]);
    expect(next[0]).toBe(action.frames[2]);
  });

  test('复制帧生成新稳定标识并保留源帧参数', () => {
    const next = duplicateFrame(action.frames, 'frame-b', () => 'frame-copy');

    expect(next.map(frame => frame.id)).toEqual([
      'frame-a',
      'frame-b',
      'frame-copy',
      'frame-c'
    ]);
    expect(next[2]).toMatchObject({
      assetId: 'idle-atlas',
      x: 64
    });
    expect(next[2]).not.toHaveProperty('durationMs');
  });

  test('删除、持续时间覆盖均按稳定标识处理且拒绝无效时长', () => {
    expect(deleteFrame(action.frames, 'frame-b').map(frame => frame.id))
      .toEqual(['frame-a', 'frame-c']);
    expect(updateFrameDuration(action.frames, 'frame-a', 80)[0]?.durationMs)
      .toBe(80);
    expect(() => updateFrameDuration(action.frames, 'frame-a', 0))
      .toThrow('帧持续时间');
  });

  test('最大长度 assetId 的旧帧生成短确定性安全标识', () => {
    const maximumAssetId = `a${'b'.repeat(119)}`;
    const legacyFrame = {
      assetId: maximumAssetId,
      x: 123456,
      y: 654321,
      width: 4096,
      height: 4096
    };

    const first = ensureStableFrameIds([legacyFrame])[0]!.id;
    const second = ensureStableFrameIds([legacyFrame])[0]!.id;
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(first).toMatch(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
  });

  test('旧帧推导标识与显式标识冲突时确定性避让并保持全局唯一', () => {
    const legacyFrame = {
      assetId: 'idle-atlas',
      x: 192,
      y: 0,
      width: 64,
      height: 64
    };
    const derivedCandidate = ensureStableFrameIds([
      { ...action.frames[0]!, id: 'reserved-frame' },
      legacyFrame
    ])[1]!.id;
    const conflictingFrames = [
      { ...action.frames[0]!, id: derivedCandidate },
      legacyFrame
    ];

    const first = ensureStableFrameIds(conflictingFrames);
    const second = ensureStableFrameIds(conflictingFrames);

    expect(first[0]!.id).toBe(derivedCandidate);
    expect(first[1]!.id).not.toBe(derivedCandidate);
    expect(first.map(frame => frame.id)).toEqual(
      second.map(frame => frame.id)
    );
    expect(new Set(first.map(frame => frame.id)).size).toBe(first.length);
    expect(first.every(frame => (
      /^[a-z0-9][a-z0-9_-]{0,119}$/u.test(frame.id)
    ))).toBe(true);
  });

  test('复制帧有界处理冲突生成器并生成唯一合法标识', () => {
    let attempts = 0;
    const next = duplicateFrame(action.frames, 'frame-a', () => {
      attempts += 1;
      return attempts % 2 === 0 ? '../unsafe' : 'frame-a';
    });

    expect(attempts).toBeLessThanOrEqual(8);
    expect(new Set(next.map(frame => frame.id)).size).toBe(next.length);
    expect(next[1]!.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
  });

  test('损坏输入中的重复显式 ID 不得被删除、时长或复制操作多命中', () => {
    const duplicateIds = [
      action.frames[0]!,
      { ...action.frames[1]!, id: 'frame-a' }
    ];

    expect(() => deleteFrame(duplicateIds, 'frame-a')).toThrow('帧标识');
    expect(() => updateFrameDuration(duplicateIds, 'frame-a', 80))
      .toThrow('帧标识');
    expect(() => duplicateFrame(duplicateIds, 'frame-a'))
      .toThrow('帧标识');
  });
});

describe('动作属性与锚点', () => {
  test('动作属性遵循协议边界并提供可访问标签', () => {
    const markup = renderToStaticMarkup(
      <ActionInspector
        action={actionDefinition}
        actions={[actionDefinition]}
        states={[]}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).not.toContain('帧率');
    expect(markup).toContain('动作语义');
    expect(markup).toContain('min="0.01"');
    expect(markup).toContain('max="100"');
    expect(markup).toContain('朝向');
  });

  test('动作语义仅增加目录藏身表现选项，不暴露路径、权限或系统命令字段', () => {
    const markup = renderToStaticMarkup(
      <ActionInspector
        action={actionDefinition}
        actions={[actionDefinition]}
        states={[]}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('value="hide"');
    expect(markup).toContain('value="emerge"');
    expect(markup).not.toContain('capabilityRef');
    expect(markup).not.toContain('系统命令');
    expect(markup).not.toContain('文件路径');
  });

  test('只有搬运动作展示当前表现的任务提交帧选择器', () => {
    const carrying = { ...actionDefinition, semantic: 'carry' as const };
    const presentation = {
      frames: action.frames,
      commitFrameId: 'frame-b'
    };

    const carryingMarkup = renderToStaticMarkup(
      <ActionInspector
        action={carrying}
        actions={[carrying]}
        states={[]}
        presentation={presentation}
        disabled={false}
        onChange={vi.fn()}
        onCommitFrameChange={vi.fn()}
      />
    );
    const idleMarkup = renderToStaticMarkup(
      <ActionInspector
        action={actionDefinition}
        actions={[actionDefinition]}
        states={[]}
        presentation={presentation}
        disabled={false}
        onChange={vi.fn()}
        onCommitFrameChange={vi.fn()}
      />
    );

    expect(carryingMarkup).toContain('任务提交帧');
    expect(carryingMarkup).toContain('value="frame-b" selected=""');
    expect(carryingMarkup).toContain('value="">不设置</option>');
    expect(idleMarkup).not.toContain('任务提交帧');
  });

  test('左右镜像时锚点同步镜像', () => {
    expect(mirrorAnchor({ x: 0.2, y: 0.8 }))
      .toEqual({ x: 0.8, y: 0.8 });
  });

  test('碰撞区域镜像后仍位于归一化画布内', () => {
    expect(mirrorRegion({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4
    })).toEqual({
      x: 0.6,
      y: 0.2,
      width: 0.3,
      height: 0.4
    });
  });

  test('屏幕坐标转换会钳制到归一化画布', () => {
    const bounds = { left: 100, top: 50, width: 200, height: 100 };

    expect(screenToNormalizedPoint({ x: 150, y: 75 }, bounds))
      .toEqual({ x: 0.25, y: 0.25 });
    expect(screenToNormalizedPoint({ x: 999, y: -10 }, bounds))
      .toEqual({ x: 1, y: 0 });
    expect(() => screenToNormalizedPoint(
      { x: 100, y: 50 },
      { ...bounds, width: 0 }
    )).toThrow('画布边界');
  });

  test('ground 不可删除且逐帧模式只覆盖当前帧', () => {
    const base: AnchorSet = { ground: { x: 0.5, y: 1 } };
    expect(() => updateAnchor(action, {
      anchor: 'ground',
      value: undefined,
      perFrame: false
    })).toThrow('ground');

    const next = updateAnchor(action, {
      anchor: 'carry',
      value: { x: 0.3, y: 0.4 },
      perFrame: true,
      frameId: 'frame-b'
    });

    expect(next.anchors).toEqual(base);
    expect(next.frames[0]?.anchors).toBeUndefined();
    expect(next.frames[1]?.anchors?.carry).toEqual({ x: 0.3, y: 0.4 });
  });

  test('旧草稿首次逐帧编辑会补齐稳定帧标识并命中当前帧', () => {
    const legacy = {
      ...action,
      frames: action.frames.map(({ id: _id, ...frame }) => frame)
    };
    const stableId = ensureStableFrameIds(legacy.frames)[1]!.id;
    const next = updateAnchor(legacy, {
      anchor: 'focus',
      value: { x: 0.4, y: 0.2 },
      perFrame: true,
      frameId: stableId
    });

    expect(next.frames.every(frame => Boolean(frame.id))).toBe(true);
    expect(next.frames[1]).toMatchObject({
      id: stableId,
      anchors: { focus: { x: 0.4, y: 0.2 } }
    });
  });

  test('旧帧规范化后查找逐帧锚点且改单轴时保留另一坐标', () => {
    const legacy = {
      ...action,
      frames: action.frames.map(({ id: _id, ...frame }, index) => ({
        ...frame,
        ...(index === 1
          ? { anchors: { focus: { x: 0.2, y: 0.7 } } }
          : {})
      }))
    };
    const frameId = ensureStableFrameIds(legacy.frames)[1]!.id;
    const next = updateAnchorCoordinate(legacy, {
      anchor: 'focus',
      axis: 'x',
      value: 0.45,
      perFrame: true,
      frameId
    });

    expect(next.frames[1]).toMatchObject({
      id: frameId,
      anchors: { focus: { x: 0.45, y: 0.7 } }
    });
  });

  test('逐帧锚点遇到重复显式帧 ID 时拒绝多命中', () => {
    const duplicateIds = {
      ...action,
      frames: [
        action.frames[0]!,
        { ...action.frames[1]!, id: 'frame-a' }
      ]
    };

    expect(() => updateAnchor(duplicateIds, {
      anchor: 'carry',
      value: { x: 0.4, y: 0.5 },
      perFrame: true,
      frameId: 'frame-a'
    })).toThrow('帧标识');
  });

  test('预览推导缺省锚点但不写回动作草稿', () => {
    const before = structuredClone(action);
    const derived = derivePreviewAnchors(action, {
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.6
    });

    expect(derived).toMatchObject({
      ground: { x: 0.5, y: 1 },
      carry: { x: 0.4, y: 0.352 },
      mouth: { x: 0.4, y: 0.25 },
      seat: { x: 0.4, y: 0.532 },
      focus: { x: 0.4, y: 0.304 }
    });
    expect(action).toEqual(before);
  });

  test('画布锚点 pointer down/move/up 统一换算归一化坐标', () => {
    const bounds = { left: 100, top: 100, width: 200, height: 200 };
    const started = beginCanvasInteraction({
      tool: 'anchor',
      anchor: 'carry',
      pointerId: 7,
      point: { x: 150, y: 150 },
      bounds
    });
    expect(started).toMatchObject({
      kind: 'anchor',
      anchor: 'carry',
      point: { x: 0.25, y: 0.25 }
    });

    const moved = moveCanvasInteraction(
      started,
      7,
      { x: 250, y: 200 },
      bounds
    );
    expect(moved).toMatchObject({ point: { x: 0.75, y: 0.5 } });
    expect(finishCanvasInteraction(moved, 7)).toBeNull();
  });

  test('碰撞矩形 pointer 拖动可反向并始终落在画布内', () => {
    const bounds = { left: 100, top: 100, width: 200, height: 200 };
    const started = beginCanvasInteraction({
      tool: 'collision',
      pointerId: 9,
      point: { x: 180, y: 180 },
      bounds
    });
    const moved = moveCanvasInteraction(
      started,
      9,
      { x: 120, y: 260 },
      bounds
    );

    expect(moved).toMatchObject({
      kind: 'collision',
      region: { x: 0.1, y: 0.4, width: 0.3, height: 0.4 }
    });
    expect(finishCanvasInteraction(moved, 99)).toBe(moved);
  });

  test('点击、拖动和碰撞区域使用同一镜像规则', () => {
    const regions: Record<string, InteractionRegion> = {
      click: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      drag: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      collision: { x: 0.3, y: 0.4, width: 0.2, height: 0.5 }
    };

    for (const region of Object.values(regions)) {
      const mirrored = mirrorRegion(region);
      expect(mirrored.x).toBeGreaterThanOrEqual(0);
      expect(mirrored.x + mirrored.width).toBeLessThanOrEqual(1);
    }
  });

  test('锚点编辑器为三类区域提供归一化矩形与镜像控件', () => {
    const withRegions: DraftActionClip = {
      ...action,
      regions: {
        click: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
      }
    };
    const markup = renderToStaticMarkup(
      <AnchorEditor
        action={withRegions}
        frameId="frame-a"
        perFrame={false}
        disabled={false}
        onPerFrameChange={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('aria-label="click X"');
    expect(markup).toContain('aria-label="click 宽度"');
    expect(markup).toContain('aria-label="镜像 click 区域"');
    expect(markup).toContain('drag 区域');
    expect(markup).toContain('collision 区域');
    expect(markup).toContain('aria-label="锚点与碰撞区域画布"');
    expect(markup).toContain('aria-label="画布交互工具"');
  });
});

describe('预览与不完整角色确认', () => {
  test('完整预览控制只变更内存状态', () => {
    const initial = createPreviewState(3);
    const playing = reducePreviewState(initial, { type: 'play' }, 3);
    const stepped = reducePreviewState(playing, { type: 'next-frame' }, 3);
    const configured = reducePreviewState(stepped, {
      type: 'set-speed',
      speed: 1.5
    }, 3);

    expect(configured).toMatchObject({
      playing: false,
      frameIndex: 1,
      speed: 1.5
    });
    expect(Object.keys(configured)).not.toContain('path');
    expect(Object.keys(configured)).not.toContain('fileHandle');
  });

  test('frameCount 缩减或归零会归一化帧索引和播放状态', () => {
    const playing = {
      ...createPreviewState(5),
      playing: true,
      frameIndex: 4
    };

    expect(normalizePreviewState(playing, 2)).toMatchObject({
      playing: true,
      frameIndex: 1
    });
    expect(normalizePreviewState(playing, 0)).toMatchObject({
      playing: false,
      frameIndex: -1
    });
    expect(normalizePreviewState(createPreviewState(0), 3)).toMatchObject({
      playing: false,
      frameIndex: 0
    });
  });

  test('零帧预览输出明确空状态而不是伪称第一帧', () => {
    const markup = renderToStaticMarkup(
      <PreviewControls
        state={createPreviewState(0)}
        frameCount={0}
        onChange={vi.fn()}
      />
    );

    expect(markup).toContain('无可用帧');
    expect(markup).not.toContain('第 1 帧');
  });

  test('动作不完整确认对话框明确降级效果和两种选择', () => {
    const markup = renderToStaticMarkup(
      <IncompleteCharacterDialog
        characterName="Nova"
        missingStates={['listening', 'thinking']}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(markup).toContain('部分动作尚未配置');
    expect(markup).toContain('缺少动画的状态将暂时播放“待机”动作');
    expect(markup).toContain('返回完善');
    expect(markup).toContain('仍然使用');
    expect(markup).toContain('aria-modal="true"');
  });
});
