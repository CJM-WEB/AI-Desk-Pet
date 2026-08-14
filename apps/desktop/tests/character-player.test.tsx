// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react';
import type {
  ActionSelectionResult,
  CharacterManifestV1
} from '@myself/character-runtime';
import { describe, expect, test, vi } from 'vitest';
import {
  CharacterResourceCache,
  type CharacterAssetBundle
} from '../src/renderer/src/characters/player/character-resource-cache';
import {
  createBrowserPixiCharacterScene,
  fitCharacterFrames,
  PixiCharacterPlayer,
  resolveDirectionalAnchor,
  type CharacterPlaybackLifecycleEvent,
  type PixiCharacterScene
} from '../src/renderer/src/characters/player/pixi-character-player';
import {
  CharacterPlayer,
  createRuntimeAssetLoader,
  type CharacterPlayerPortFactory
} from '../src/renderer/src/characters/player/CharacterPlayer';
import type { MyselfApi } from '../src/shared/myself-api';
import type { CharacterMotionEvent } from '../src/shared/character-motion-ipc';

function manifest(characterId: string): CharacterManifestV1 {
  return {
    version: 1,
    id: characterId,
    name: characterId,
    thumbnailAssetId: 'atlas',
    compilerVersion: 'test',
    resources: [{
      assetId: 'atlas',
      fileName: 'atlas.png',
      sha256: 'a'.repeat(64),
      byteLength: 4
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'idle',
        name: '待机',
        fps: 12,
        loop: true,
        weight: 1,
        frames: [{
          assetId: 'atlas',
          x: 0,
          y: 0,
          width: 32,
          height: 32,
          anchors: { carry: { x: 0.75, y: 0.4 } }
        }],
        anchors: {
          ground: { x: 0.5, y: 1 },
          carry: { x: 0.7, y: 0.5 }
        }
      }]
    }]
  };
}

function bundle(characterId: string): CharacterAssetBundle {
  return {
    characterId,
    atlasUrls: new Map([['atlas', `blob:${characterId}`]])
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

/** 统一补齐播放器端口新增的命中区域能力，避免测试夹具偏离真实接口。 */
function characterPlayerHitRegionFixture() {
  return {
    hitTest: vi.fn().mockReturnValue(false),
    subscribeHitRegion: vi.fn(() => vi.fn())
  };
}

describe('角色资源缓存', () => {
  test('同角色强制重载成功前保留旧 bundle，提交后才销毁旧 bundle', async () => {
    const replacement = deferred<CharacterAssetBundle>();
    const destroyer = vi.fn();
    const loader = vi.fn()
      .mockResolvedValueOnce(bundle('character-a'))
      .mockImplementationOnce(() => replacement.promise);
    const cache = new CharacterResourceCache(loader, destroyer);

    const previous = await cache.activate('character-a');
    const reload = cache.activate('character-a', { forceReload: true });
    await Promise.resolve();

    expect(cache.current).toBe(previous);
    expect(destroyer).not.toHaveBeenCalled();
    const next = {
      characterId: 'character-a',
      atlasUrls: new Map([['atlas', 'blob:character-a-v2']])
    };
    replacement.resolve(next);
    await expect(reload).resolves.toBe(next);
    expect(cache.current).toBe(next);
    expect(destroyer).toHaveBeenCalledWith(previous);
  });

  test('运行资源加载器只读取动作帧引用的白名单纹理', async () => {
    const currentManifest = manifest('character-a');
    const bytes = new Uint8Array([1]);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    currentManifest.resources[0]!.sha256 = [...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, '0'))
      .join('');
    currentManifest.resources.push({
      assetId: 'metadata',
      fileName: 'metadata.json',
      sha256: 'b'.repeat(64),
      byteLength: 4
    });
    const readCharacterRuntimeAsset = vi.fn(async () => bytes);
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      readCharacterRuntimeAsset
    } as unknown as MyselfApi;
    const createObjectURL = vi.fn(() => 'blob:atlas');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    try {
      const loaded = await createRuntimeAssetLoader(api)(
        currentManifest.id,
        new AbortController().signal,
        {
          snapshot: {
            activeCharacterId: currentManifest.id,
            manifest: currentManifest
          }
        }
      );

      expect([...loaded.atlasUrls.keys()]).toEqual(['atlas']);
      expect(readCharacterRuntimeAsset).toHaveBeenCalledOnce();
      expect(readCharacterRuntimeAsset).toHaveBeenCalledWith('atlas');
      expect(api.getCharacterRuntimeSnapshot).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('切换角色时释放旧资源并只保留当前角色', async () => {
    const destroyer = vi.fn();
    const cache = new CharacterResourceCache(
      async characterId => bundle(characterId),
      destroyer
    );

    await cache.activate('character-a');
    await cache.activate('character-b');

    expect(destroyer).toHaveBeenCalledWith(bundle('character-a'));
    expect(cache.activeCharacterId).toBe('character-b');
  });

  test('较旧的异步加载后返回时会被销毁且不能覆盖当前角色', async () => {
    const oldLoad = deferred<CharacterAssetBundle>();
    const destroyer = vi.fn();
    const cache = new CharacterResourceCache(
      characterId => characterId === 'character-a'
        ? oldLoad.promise
        : Promise.resolve(bundle(characterId)),
      destroyer
    );

    const staleActivation = cache.activate('character-a');
    await cache.activate('character-b');
    oldLoad.resolve(bundle('character-a'));
    await staleActivation;

    expect(cache.activeCharacterId).toBe('character-b');
    expect(destroyer).toHaveBeenCalledWith(bundle('character-a'));
  });
});

describe('PixiJS 适配器边界', () => {
  test('256 像素帧等比缩放到 156×192 内容区且不裁切', () => {
    const fit = fitCharacterFrames(
      [{ width: 256, height: 256 }],
      { width: 156, height: 192 },
      { x: 0.5, y: 1 }
    );

    expect(fit.scale).toBeCloseTo(156 / 256);
    expect(fit.x - 256 * fit.scale * 0.5).toBeGreaterThanOrEqual(0);
    expect(fit.x + 256 * fit.scale * 0.5).toBeLessThanOrEqual(156);
    expect(fit.y - 256 * fit.scale).toBeGreaterThanOrEqual(0);
    expect(fit.y).toBeLessThanOrEqual(192);
  });

  test('左向时返回镜像后的纹理归一化锚点', () => {
    expect(resolveDirectionalAnchor({ x: 0.75, y: 0.4 }, 'left')).toEqual({
      x: 0.25,
      y: 0.4
    });
    expect(resolveDirectionalAnchor({ x: 0.75, y: 0.4 }, 'right')).toEqual({
      x: 0.75,
      y: 0.4
    });
  });

  test('Application.init 失败时最佳努力停止并销毁应用及移除画布', async () => {
    const canvas = document.createElement('canvas');
    const stop = vi.fn(() => {
      throw new Error('ticker 尚未就绪');
    });
    const destroy = vi.fn();
    class FailingApplication {
      canvas = canvas;
      ticker = { stop };
      init = vi.fn().mockRejectedValue(new Error('初始化失败'));
      destroy = destroy;
    }
    const container = document.createElement('div');
    container.appendChild(canvas);

    await expect(createBrowserPixiCharacterScene(
      container,
      async () => ({ Application: FailingApplication }) as never
    )).rejects.toThrow('初始化失败');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(canvas.parentElement).toBeNull();
  });

  test('可注入 Pixi Application 使用 host 的 156×192 实际尺寸初始化 canvas', async () => {
    const canvas = document.createElement('canvas');
    const init = vi.fn(async (options: { width: number; height: number }) => {
      canvas.width = options.width;
      canvas.height = options.height;
    });
    const destroy = vi.fn();
    class MeasuringApplication {
      canvas = canvas;
      ticker = { stop: vi.fn(), started: false };
      stage = {};
      init = init;
      destroy = destroy;
    }
    const container = document.createElement('span');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 156,
      bottom: 192,
      left: 0,
      width: 156,
      height: 192,
      toJSON: () => ({})
    });

    const scene = await createBrowserPixiCharacterScene(
      container,
      async () => ({ Application: MeasuringApplication }) as never
    );

    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      width: 156,
      height: 192
    }));
    expect({ width: canvas.width, height: canvas.height }).toEqual({
      width: 156,
      height: 192
    });
    scene.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('PixiJS 角色播放器端口', () => {
  test('静态模式委托场景显示代表帧且不启动 ticker', async () => {
    const scene = {
      load: vi.fn().mockResolvedValue(undefined),
      show: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue({ x: 0.75, y: 0.4 }),
      stop: vi.fn(),
      destroy: vi.fn(),
      isTickerRunning: vi.fn().mockReturnValue(false)
    };
    const player = new PixiCharacterPlayer(scene);
    const currentManifest = manifest('character-a');
    const selection: ActionSelectionResult = {
      stateId: 'idle',
      action: currentManifest.states[0]!.actions[0]!,
      reason: 'matched'
    };

    await player.load(currentManifest, bundle('character-a'));
    player.setDirection('left');
    player.play(selection, 'static');

    expect(scene.show).toHaveBeenCalledWith(selection, 'static');
    expect(scene.setDirection).toHaveBeenCalledWith('left');
    expect(player.getAnchor('carry')).toEqual({ x: 0.75, y: 0.4 });
    expect(player.isTickerRunning()).toBe(false);
  });

  test('销毁播放器时停止动画、ticker、纹理和应用资源', () => {
    const scene = {
      load: vi.fn().mockResolvedValue(undefined),
      show: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      stop: vi.fn(),
      destroy: vi.fn(),
      isTickerRunning: vi.fn().mockReturnValue(true)
    };

    new PixiCharacterPlayer(scene).destroy();

    expect(scene.stop).toHaveBeenCalledTimes(1);
    expect(scene.destroy).toHaveBeenCalledTimes(1);
  });

  test('重复销毁播放器只停止并释放场景一次', () => {
    let destroyed = false;
    const scene = {
      load: vi.fn().mockResolvedValue(undefined),
      show: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      stop: vi.fn(() => {
        if (destroyed) throw new Error('不应访问已销毁场景');
      }),
      destroy: vi.fn(() => {
        destroyed = true;
      }),
      isTickerRunning: vi.fn().mockReturnValue(false)
    };
    const player = new PixiCharacterPlayer(scene);

    expect(() => {
      player.destroy();
      player.destroy();
    }).not.toThrow();
    expect(scene.stop).toHaveBeenCalledOnce();
    expect(scene.destroy).toHaveBeenCalledOnce();
  });
});

describe('角色播放器组件', () => {
  function behaviorFixture(options?: {
    failActionId?: string;
    behaviorAuthorityMode?: 'main-v2' | 'legacy-v1';
    startedFeedback?: Promise<void>;
  }) {
    const currentManifest = manifest('character-a');
    currentManifest.states.push({
      id: 'thinking',
      kind: 'core',
      actions: [{
        ...currentManifest.states[0]!.actions[0]!,
        id: 'thinking-once',
        name: '思考一次',
        loop: false
      }]
    });
    let motionListener: ((event: CharacterMotionEvent) => void) | undefined;
    let characterListener: ((event: {
      type: 'active-character-changed';
      characterId: string;
    }) => void) | undefined;
    let lifecycleListener: ((event: CharacterPlaybackLifecycleEvent) => void) | undefined;
    let frameListener: ((frameId: string | null) => void) | undefined;
    let nextPlaybackId = 0;
    const reportCharacterActionFeedback = vi.fn(async input => {
      if (input.status === 'started' && options?.startedFeedback) {
        await options.startedFeedback;
      }
    });
    const reportCharacterActionMilestone = vi.fn(async () => undefined);
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn((selection: ActionSelectionResult) => {
        const playbackId = ++nextPlaybackId;
        if (selection.action.id === options?.failActionId) {
          throw new Error('CHARACTER_RUNTIME_ASSET_MISSING');
        }
        return playbackId;
      }),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      subscribePlaybackLifecycle: vi.fn(listener => {
        lifecycleListener = listener;
        return vi.fn();
      }),
      subscribeFrame: vi.fn(listener => {
        frameListener = listener;
        return vi.fn();
      }),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(listener => {
        characterListener = listener;
        return vi.fn();
      }),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1,
        timestampMs: 0,
        position: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        direction: 'right',
        moving: false,
        carrying: false
      })),
      subscribeCharacterMotion: vi.fn(listener => {
        motionListener = listener;
        return vi.fn();
      }),
      reportCharacterActionFeedback,
      reportCharacterActionMilestone
    } as unknown as MyselfApi;
    const createPlayer = async () => player;
    const loadBundle = async () => bundle('character-a');
    const renderPlayer = (stateId: 'idle' | 'thinking') => (
      <CharacterPlayer
        stateId={stateId}
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={loadBundle}
        behaviorAuthorityMode={options?.behaviorAuthorityMode ?? 'legacy-v1'}
      />
    );
    const rendered = render(renderPlayer('idle'));
    return {
      api,
      characterEvent: (event: Parameters<NonNullable<typeof characterListener>>[0]) => (
        characterListener?.(event)
      ),
      lifecycle: (event: CharacterPlaybackLifecycleEvent) => lifecycleListener?.(event),
      frame: (frameId: string | null) => frameListener?.(frameId),
      motion: (event: CharacterMotionEvent) => motionListener?.(event),
      player,
      rerenderState: (stateId: 'idle' | 'thinking') => rendered.rerender(renderPlayer(stateId)),
      rendered,
      reportCharacterActionFeedback,
      reportCharacterActionMilestone
    };
  }

  function refreshRaceFixture(oldActionId: string, newActionId: string) {
    const withAction = (characterId: string, actionId: string, name: string) => {
      const current = manifest(characterId);
      current.states.push({
        id: 'thinking',
        kind: 'core',
        actions: [{
          ...current.states[0]!.actions[0]!,
          id: actionId,
          name,
          loop: false
        }]
      });
      return current;
    };
    const oldManifest = withAction('character-a', oldActionId, '旧投影动作');
    const newManifest = withAction('character-b', newActionId, '新投影动作');
    const nextSnapshot = deferred<{
      activeCharacterId: string;
      manifest: CharacterManifestV1;
    }>();
    let motionListener: ((event: CharacterMotionEvent) => void) | undefined;
    let characterListener: ((event:
      | { type: 'active-character-changed'; characterId: string }
      | { type: 'compile-result'; characterId: string; ok: true }
    ) => void) | undefined;
    const players = ['旧', '新'].map(prefix => {
      let playbackId = 0;
      return {
        load: vi.fn().mockResolvedValue(undefined),
        play: vi.fn((_selection: ActionSelectionResult) => ++playbackId),
        setDirection: vi.fn(),
        getAnchor: vi.fn().mockReturnValue(null),
        ...characterPlayerHitRegionFixture(),
        destroy: vi.fn(),
        prefix
      };
    });
    const reportCharacterActionFeedback = vi.fn(async () => undefined);
    const reportCharacterActionPlayed = vi.fn(async () => undefined);
    const api = {
      getCharacterRuntimeSnapshot: vi.fn()
        .mockResolvedValueOnce({
          activeCharacterId: oldManifest.id,
          manifest: oldManifest
        })
        .mockImplementationOnce(() => nextSnapshot.promise)
        .mockResolvedValue({
          activeCharacterId: newManifest.id,
          manifest: newManifest
        }),
      subscribeCharacterEvents: vi.fn(listener => {
        characterListener = listener;
        return vi.fn();
      }),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1,
        timestampMs: 0,
        position: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        direction: 'right',
        moving: false,
        carrying: false
      })),
      subscribeCharacterMotion: vi.fn(listener => {
        motionListener = listener;
        return vi.fn();
      }),
      reportCharacterActionFeedback,
      reportCharacterActionPlayed
    } as unknown as MyselfApi;
    const rendered = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        behaviorAuthorityMode="main-v2"
        createPlayer={vi.fn()
          .mockResolvedValueOnce(players[0])
          .mockResolvedValueOnce(players[1])}
        loadBundle={async characterId => bundle(characterId)}
      />
    );
    return {
      api,
      characterEvent: (event: Parameters<NonNullable<typeof characterListener>>[0]) => (
        characterListener?.(event)
      ),
      commitNewProjection: () => nextSnapshot.resolve({
        activeCharacterId: newManifest.id,
        manifest: newManifest
      }),
      failNewProjection: () => nextSnapshot.reject(new Error('CHARACTER_RUNTIME_UNAVAILABLE')),
      motion: (event: CharacterMotionEvent) => motionListener?.(event),
      players,
      rendered,
      reportCharacterActionFeedback,
      reportCharacterActionPlayed
    };
  }

  test('V1 回退待机动作在投影切换期间排队，并只在新投影提交后播放', async () => {
    const fixture = refreshRaceFixture('old-action', 'new-action');
    await waitFor(() => expect(fixture.players[0]!.load).toHaveBeenCalledOnce());
    act(() => fixture.characterEvent({
      type: 'active-character-changed',
      characterId: 'character-b'
    }));
    await waitFor(() => expect(fixture.api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2));

    act(() => fixture.motion({
      type: 'idle-action',
      revision: 2,
      actionId: 'idle',
      playbackToken: 'legacy-token-loading'
    }));
    act(() => fixture.motion({
      type: 'snapshot',
      snapshot: {
        revision: 2,
        timestampMs: 20,
        position: { x: 0, y: 0 },
        target: { x: 10, y: 0 },
        direction: 'left',
        moving: true,
        carrying: false
      }
    }));

    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    expect(fixture.reportCharacterActionPlayed).not.toHaveBeenCalled();

    await act(async () => fixture.commitNewProjection());
    await waitFor(() => expect(fixture.reportCharacterActionPlayed).toHaveBeenCalledWith(
      'legacy-token-loading',
      'idle'
    ));
    expect(fixture.players[1]!.play).toHaveBeenCalledOnce();
    expect(fixture.players[1]!.play.mock.calls[0]?.[0].action.id).toBe('idle');
    fixture.rendered.unmount();
  });

  test('任务动作首次进入提交帧只报告一次且旧令牌不会复活', async () => {
    const started = deferred<void>();
    const fixture = behaviorFixture({
      behaviorAuthorityMode: 'main-v2',
      startedFeedback: started.promise
    });
    await waitFor(() => expect(fixture.player.load).toHaveBeenCalledOnce());
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-commit',
      commitFrameId: 'commit-frame'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-commit',
      actionId: 'thinking-once',
      status: 'started'
    }));

    act(() => {
      fixture.frame('other-frame');
      fixture.frame('commit-frame');
      fixture.frame('commit-frame');
    });
    expect(fixture.reportCharacterActionMilestone).not.toHaveBeenCalled();
    await act(async () => started.resolve());
    await waitFor(() => expect(fixture.reportCharacterActionMilestone).toHaveBeenCalledOnce());
    expect(fixture.reportCharacterActionMilestone).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-commit',
      actionId: 'thinking-once',
      kind: 'commit-frame',
      frameId: 'commit-frame'
    });

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 3,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-next'
    }));
    act(() => fixture.frame('commit-frame'));
    expect(fixture.reportCharacterActionMilestone).toHaveBeenCalledOnce();
    fixture.rendered.unmount();
  });

  test('显式 V1 回退权威在投影切换期间保留，并在新投影提交后本地首播', async () => {
    const fixture = refreshRaceFixture('old-action', 'new-action');
    await waitFor(() => expect(fixture.players[0]!.load).toHaveBeenCalledOnce());
    act(() => fixture.characterEvent({
      type: 'active-character-changed',
      characterId: 'character-b'
    }));
    await waitFor(() => expect(fixture.api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2));

    act(() => fixture.motion({
      type: 'behavior-authority',
      characterId: 'character-b',
      mode: 'legacy-v1'
    }));

    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    await act(async () => fixture.commitNewProjection());
    await waitFor(() => expect(fixture.players[1]!.play).toHaveBeenCalledOnce());
    expect(fixture.players[1]!.play.mock.calls[0]?.[0].action.id).toBe('idle');
    fixture.rendered.unmount();
  });

  test.each([
    {
      name: '角色切换且动作 ID 重合',
      oldActionId: 'shared-action',
      newActionId: 'shared-action',
      event: { type: 'active-character-changed', characterId: 'character-b' } as const
    },
    {
      name: '同角色编译且动作 ID 不重合',
      oldActionId: 'old-action',
      newActionId: 'new-action',
      event: { type: 'compile-result', characterId: 'character-a', ok: true } as const
    }
  ])('$name 时新事件等待新投影原子提交后再播放', async scenario => {
    const fixture = refreshRaceFixture(scenario.oldActionId, scenario.newActionId);
    await waitFor(() => expect(fixture.players[0]!.load).toHaveBeenCalledOnce());
    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    act(() => fixture.characterEvent(scenario.event));
    await waitFor(() => expect(fixture.api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2));

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: scenario.newActionId,
      playbackToken: 'behavior-token-race'
    }));

    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    expect(fixture.reportCharacterActionFeedback).not.toHaveBeenCalled();

    await act(async () => fixture.commitNewProjection());
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-race',
      actionId: scenario.newActionId,
      status: 'started'
    }));
    expect(fixture.players[1]!.play).toHaveBeenCalledOnce();
    expect(fixture.players[1]!.play.mock.calls.at(-1)?.[0].action).toMatchObject({
      id: scenario.newActionId,
      name: '新投影动作'
    });
    expect(fixture.reportCharacterActionFeedback).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
    fixture.rendered.unmount();
  });

  test('刷新失败时把加载期排队令牌恰好一次结算为 failed', async () => {
    const fixture = refreshRaceFixture('old-action', 'new-action');
    await waitFor(() => expect(fixture.players[0]!.load).toHaveBeenCalledOnce());
    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    act(() => fixture.characterEvent({
      type: 'compile-result',
      characterId: 'character-a',
      ok: true
    }));
    await waitFor(() => expect(fixture.api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2));
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: 'new-action',
      playbackToken: 'behavior-token-pending'
    }));

    await act(async () => fixture.failNewProjection());

    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-pending',
      actionId: 'new-action',
      status: 'failed'
    }));
    expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledOnce();
    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    fixture.rendered.unmount();
  });

  test('刷新失败进入 unavailable，拒绝新令牌并在后续刷新成功后恢复播放', async () => {
    const fixture = refreshRaceFixture('old-action', 'new-action');
    await waitFor(() => expect(fixture.players[0]!.load).toHaveBeenCalledOnce());
    expect(fixture.players[0]!.play).not.toHaveBeenCalled();
    act(() => fixture.characterEvent({
      type: 'compile-result',
      characterId: 'character-a',
      ok: true
    }));
    await waitFor(() => expect(fixture.api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2));
    await act(async () => fixture.failNewProjection());

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: 'new-action',
      playbackToken: 'behavior-token-unavailable'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-unavailable',
      actionId: 'new-action',
      status: 'failed'
    }));
    expect(fixture.players[0]!.play).not.toHaveBeenCalled();

    act(() => fixture.characterEvent({
      type: 'compile-result',
      characterId: 'character-a',
      ok: true
    }));
    await waitFor(() => expect(fixture.players[1]!.load).toHaveBeenCalledOnce());
    expect(fixture.players[1]!.play).not.toHaveBeenCalled();
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 3,
      stateId: 'thinking-state',
      actionId: 'new-action',
      playbackToken: 'behavior-token-recovered'
    }));

    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-recovered',
      actionId: 'new-action',
      status: 'started'
    }));
    expect(fixture.players[1]!.play).toHaveBeenCalledOnce();
    fixture.rendered.unmount();
  });

  test('行为动作播放成功后报告 started，自然结束只报告一次 completed', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalled());

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-2'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'started'
    }));
    const playbackId = fixture.player.play.mock.results.at(-1)?.value as number;
    act(() => {
      fixture.lifecycle({ playbackId, actionId: 'thinking-once', status: 'completed' });
      fixture.lifecycle({ playbackId, actionId: 'thinking-once', status: 'completed' });
    });

    await waitFor(() => expect(fixture.reportCharacterActionFeedback.mock.calls).toEqual([
      [{ playbackToken: 'behavior-token-2', actionId: 'thinking-once', status: 'started' }],
      [{ playbackToken: 'behavior-token-2', actionId: 'thinking-once', status: 'completed' }]
    ]));
    fixture.rendered.unmount();
  });

  test('V2 Main 动作后任务状态与运动方向更新都不会触发本地抢播', async () => {
    const fixture = behaviorFixture({ behaviorAuthorityMode: 'main-v2' });
    await waitFor(() => expect(fixture.player.load).toHaveBeenCalledOnce());
    expect(fixture.player.play).not.toHaveBeenCalled();

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-authoritative'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-authoritative',
      actionId: 'thinking-once',
      status: 'started'
    }));
    expect(fixture.player.play).toHaveBeenCalledOnce();

    act(() => {
      fixture.rerenderState('thinking');
      fixture.motion({
        type: 'snapshot',
        snapshot: {
          revision: 2,
          timestampMs: 20,
          position: { x: 0, y: 0 },
          target: { x: 10, y: 0 },
          direction: 'left',
          moving: true,
          carrying: false
        }
      });
    });

    await waitFor(() => expect(fixture.player.setDirection).toHaveBeenCalledWith('left'));
    expect(fixture.player.play).toHaveBeenCalledOnce();
    expect(fixture.reportCharacterActionFeedback).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' })
    );
    fixture.rendered.unmount();
  });

  test('新令牌中断旧令牌，旧 revision 与重复事件不会再次播放', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalled());
    const first = {
      type: 'behavior-action' as const,
      revision: 3,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-3'
    };
    act(() => {
      fixture.motion(first);
      fixture.motion(first);
      fixture.motion({ ...first, revision: 2, playbackToken: 'behavior-token-old' });
      fixture.motion({ ...first, revision: 4, playbackToken: 'behavior-token-4' });
    });

    await waitFor(() => expect(fixture.reportCharacterActionFeedback.mock.calls).toEqual([
      [{ playbackToken: 'behavior-token-3', actionId: 'thinking-once', status: 'started' }],
      [{ playbackToken: 'behavior-token-3', actionId: 'thinking-once', status: 'interrupted' }],
      [{ playbackToken: 'behavior-token-4', actionId: 'thinking-once', status: 'started' }]
    ]));
    expect(fixture.player.play).toHaveBeenCalledTimes(3);
    fixture.rendered.unmount();
  });

  test('当前 V1 投影中未知动作直接报告 failed 且不调用播放器', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'unknown-action',
      playbackToken: 'behavior-token-2'
    }));

    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'unknown-action',
      status: 'failed'
    }));
    expect(fixture.player.play).toHaveBeenCalledOnce();
    fixture.rendered.unmount();
  });

  test('未知动作 failed 后忽略相同令牌的更高 revision 事件', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: 'unknown-action',
      playbackToken: 'behavior-token-same'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-same',
      actionId: 'unknown-action',
      status: 'failed'
    }));

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 3,
      stateId: 'thinking-state',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-same'
    }));

    await act(async () => Promise.resolve());
    expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledOnce();
    expect(fixture.player.play).toHaveBeenCalledOnce();
    fixture.rendered.unmount();
  });

  test('completed 后忽略相同令牌的更高 revision 事件', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking-state',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-same'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-same',
      actionId: 'thinking-once',
      status: 'started'
    }));
    const playbackId = fixture.player.play.mock.results.at(-1)?.value as number;
    act(() => fixture.lifecycle({
      playbackId,
      actionId: 'thinking-once',
      status: 'completed'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledTimes(2));

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 3,
      stateId: 'thinking-state',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-same'
    }));

    await act(async () => Promise.resolve());
    expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledTimes(2);
    expect(fixture.player.play).toHaveBeenCalledTimes(2);
    fixture.rendered.unmount();
  });

  test('播放器异常只报告 failed，不跨 IPC 传递错误文本', async () => {
    const fixture = behaviorFixture({ failActionId: 'thinking-once' });
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalledOnce());

    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-2'
    }));

    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'failed'
    }));
    expect(fixture.reportCharacterActionFeedback.mock.calls[0]?.[0])
      .not.toHaveProperty('error');
    fixture.rendered.unmount();
  });

  test('活动角色切换会把当前令牌收敛为 interrupted', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalled());
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-2'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'started'
    }));

    act(() => fixture.characterEvent({
      type: 'active-character-changed',
      characterId: 'character-b'
    }));

    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'interrupted'
    }));
    fixture.rendered.unmount();
  });

  test('组件卸载会把当前令牌收敛为 interrupted', async () => {
    const fixture = behaviorFixture();
    await waitFor(() => expect(fixture.player.play).toHaveBeenCalled());
    act(() => fixture.motion({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-once',
      playbackToken: 'behavior-token-2'
    }));
    await waitFor(() => expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'started'
    }));

    fixture.rendered.unmount();

    expect(fixture.reportCharacterActionFeedback).toHaveBeenCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-once',
      status: 'interrupted'
    });
  });

  test('命中回调身份变化时立即交接当前端口且卸载只撤销新所有者', async () => {
    const currentManifest = manifest('character-a');
    const subscribeCharacterEvents = vi.fn(() => vi.fn());
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents
    } as unknown as MyselfApi;
    const createPlayer = vi.fn(async () => ({
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      hitTest: vi.fn().mockReturnValue(true),
      subscribeHitRegion: vi.fn(() => vi.fn()),
      destroy: vi.fn()
    }));
    const loadBundle = vi.fn(async () => bundle('character-a'));
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={loadBundle}
        onHitTestPortChange={firstCallback}
      />
    );
    await waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(firstCallback.mock.calls.some(([port]) => port !== null)).toBe(true);
    });
    const currentPort = firstCallback.mock.calls
      .map(([port]) => port)
      .find(port => port !== null);
    const firstCallCount = firstCallback.mock.calls.length;

    result.rerender(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={loadBundle}
        onHitTestPortChange={secondCallback}
      />
    );

    expect(firstCallback).toHaveBeenCalledTimes(firstCallCount + 1);
    expect(firstCallback).toHaveBeenLastCalledWith(null);
    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledWith(currentPort);
    expect(createPlayer).toHaveBeenCalledOnce();
    expect(loadBundle).toHaveBeenCalledOnce();
    expect(subscribeCharacterEvents).toHaveBeenCalledOnce();

    firstCallback.mockClear();
    secondCallback.mockClear();
    result.unmount();

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledWith(null);
  });

  test('正式播放器发布局部坐标像素命中端口并在替换与卸载时撤销', async () => {
    const currentManifest = manifest('character-a');
    let characterListener: (() => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(listener => {
        characterListener = () => listener({
          type: 'active-character-changed',
          characterId: currentManifest.id
        });
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const hitRegionListener = vi.fn();
    const unsubscribeHitRegion = vi.fn();
    const players = [0, 1].map(() => ({
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      hitTest: vi.fn().mockReturnValue(true),
      subscribeHitRegion: vi.fn(listener => {
        hitRegionListener.mockImplementation(listener);
        return unsubscribeHitRegion;
      }),
      destroy: vi.fn()
    }));
    let createIndex = 0;
    const onHitTestPortChange = vi.fn();
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async container => {
          vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
            x: 10,
            y: 20,
            left: 10,
            top: 20,
            right: 110,
            bottom: 140,
            width: 100,
            height: 120,
            toJSON: () => ({})
          });
          return players[createIndex++]!;
        }}
        loadBundle={async () => bundle('character-a')}
        onHitTestPortChange={onHitTestPortChange}
      />
    );

    await waitFor(() => {
      expect(onHitTestPortChange.mock.calls.some(([port]) => port !== null)).toBe(true);
    });
    const firstPort = onHitTestPortChange.mock.calls
      .map(([port]) => port)
      .find(port => port !== null);
    expect(firstPort?.hitTest({ x: 15, y: 27 })).toBe(true);
    expect(players[0]!.hitTest).toHaveBeenCalledWith({ x: 5, y: 7 });
    const notify = vi.fn();
    const unsubscribe = firstPort?.subscribe(notify);
    hitRegionListener();
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe?.();
    expect(unsubscribeHitRegion).toHaveBeenCalledOnce();

    onHitTestPortChange.mockClear();
    await act(async () => characterListener?.());
    expect(onHitTestPortChange).toHaveBeenNthCalledWith(1, null);
    await waitFor(() => {
      expect(onHitTestPortChange.mock.calls.some(([port]) => port !== null)).toBe(true);
    });

    onHitTestPortChange.mockClear();
    result.unmount();
    expect(onHitTestPortChange).toHaveBeenCalledWith(null);
  });

  test('运动快照方向变化会按运行时方向重新选择动作并回报运动状态', async () => {
    const currentManifest = manifest('character-a');
    currentManifest.states[0]!.actions = [
      { ...currentManifest.states[0]!.actions[0]!, id: 'idle-right', direction: 'right' },
      { ...currentManifest.states[0]!.actions[0]!, id: 'idle-left', direction: 'left' }
    ];
    let motionListener: ((event: {
      type: 'snapshot';
      snapshot: {
        revision: number;
        timestampMs: number;
        position: { x: number; y: number };
        target: { x: number; y: number };
        direction: 'left' | 'right';
        moving: boolean;
        carrying: boolean;
      };
    }) => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1,
        timestampMs: 0,
        position: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        direction: 'right',
        moving: false,
        carrying: false
      })),
      subscribeCharacterMotion: vi.fn(listener => {
        motionListener = listener;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      getFrameBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 32, height: 32 }),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const onMotionChange = vi.fn();
    const rendered = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => player}
        loadBundle={async () => bundle('character-a')}
        onMotionChange={onMotionChange}
      />
    );
    await waitFor(() => expect(player.play).toHaveBeenCalled());
    expect(player.play.mock.calls.at(-1)?.[0].action.id).toBe('idle-right');

    act(() => motionListener?.({
      type: 'snapshot',
      snapshot: {
        revision: 2,
        timestampMs: 50,
        position: { x: -8, y: 0 },
        target: { x: -100, y: 0 },
        direction: 'left',
        moving: true,
        carrying: false
      }
    }));

    await waitFor(() => {
      expect(player.play.mock.calls.at(-1)?.[0].action.id).toBe('idle-left');
    });
    expect(onMotionChange).toHaveBeenLastCalledWith({
      position: { x: -8, y: 0 },
      moving: true,
      carrying: false,
      direction: 'left'
    });
    rendered.unmount();
  });

  test('RAF 在快照之间持续推进视觉残差并在卸载时清理', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      callbacks.push(callback);
      return callbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const currentManifest = manifest('character-a');
    let listener: ((event: {
      type: 'snapshot';
      snapshot: {
        revision: number; timestampMs: number;
        position: { x: number; y: number }; target: { x: number; y: number };
        direction: 'left' | 'right'; moving: boolean;
      };
    }) => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: 'character-a',
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1, timestampMs: 0,
        position: { x: 100, y: 100 }, target: { x: 100, y: 100 },
        direction: 'right', moving: false
      })),
      subscribeCharacterMotion: vi.fn(next => {
        listener = next;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const onDesktopAnchors = vi.fn();
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn((name: string) => (
        name === 'carry' ? { x: 0.75, y: 0.5 } : null
      )),
      getFrameBounds: vi.fn().mockReturnValue({ x: 10, y: 20, width: 80, height: 100 }),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const rendered = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="static"
        api={api}
        createPlayer={vi.fn(async () => player)}
        loadBundle={vi.fn(async () => bundle('character-a'))}
        onDesktopAnchors={onDesktopAnchors}
      />
    );
    const host = rendered.container.querySelector<HTMLElement>('.character-player-host')!;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => {
      const residual = Number.parseFloat(
        host.style.transform.match(/translate\(([-\d.]+)px/u)?.[1] ?? '0'
      );
      return {
        x: 5 + residual, y: 7, left: 5 + residual, top: 7,
        right: 125 + residual, bottom: 167, width: 120, height: 160,
        toJSON: () => ({})
      };
    });
    await waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    act(() => callbacks.shift()?.(0));
    act(() => listener?.({
      type: 'snapshot',
      snapshot: {
        revision: 2, timestampMs: 100,
        position: { x: 120, y: 100 }, target: { x: 200, y: 100 },
        direction: 'right', moving: true
      }
    }));
    act(() => callbacks.shift()?.(50));
    expect(rendered.container.querySelector<HTMLElement>('.character-player-host')?.style.transform)
      .toBe('translate(-8px, 0px)');
    expect(onDesktopAnchors).toHaveBeenLastCalledWith({
      carry: { x: 187, y: 177 },
      seat: null,
      focus: null
    });
    rendered.unmount();
    expect(cancel).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('RAF 隔离单帧方向异常并继续调度下一帧', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      callbacks.push(callback);
      return callbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    let rejectDirection = false;
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(() => {
        if (rejectDirection) throw new Error('CHARACTER_DIRECTION_REBUILD_FAILED');
      }),
      getAnchor: vi.fn().mockReturnValue(null),
      getFrameBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 32, height: 32 }),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: 'character-a',
        manifest: manifest('character-a')
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1,
        timestampMs: 0,
        position: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
        direction: 'right' as const,
        moving: false
      })),
      subscribeCharacterMotion: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;

    const rendered = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="static"
        behaviorAuthorityMode="main-v2"
        api={api}
        createPlayer={vi.fn(async () => player)}
        loadBundle={vi.fn(async () => bundle('character-a'))}
      />
    );

    try {
      await waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
      rejectDirection = true;
      const callback = callbacks.shift();
      expect(callback).toBeDefined();
      expect(() => act(() => callback?.(0))).not.toThrow();
      expect(callbacks).toHaveLength(1);
    } finally {
      rendered.unmount();
      vi.unstubAllGlobals();
    }
  });

  test('当前帧 carry、seat、focus 锚点转换为 Main 快照对应的桌面坐标', async () => {
    const currentManifest = manifest('character-a');
    let motionListener: ((event: {
      type: 'snapshot';
      snapshot: {
        revision: number;
        timestampMs: number;
        position: { x: number; y: number };
        target: { x: number; y: number };
        direction: 'left' | 'right';
        moving: boolean;
      };
    }) => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn()),
      getCharacterMotionSnapshot: vi.fn(async () => ({
        revision: 1,
        timestampMs: 0,
        position: { x: 100, y: 200 },
        target: { x: 100, y: 200 },
        direction: 'right',
        moving: false
      })),
      subscribeCharacterMotion: vi.fn(listener => {
        motionListener = listener;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn((name: string) => (
        name === 'carry' ? { x: 0.75, y: 0.5 } : null
      )),
      getFrameBounds: vi.fn(() => ({
        x: 10,
        y: 20,
        width: 80,
        height: 100
      })),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const onDesktopAnchors = vi.fn();
    const { container } = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="static"
        api={api}
        createPlayer={vi.fn(async () => player)}
        loadBundle={vi.fn(async () => bundle('character-a'))}
        onDesktopAnchors={onDesktopAnchors}
      />
    );
    const host = container.querySelector('.character-player-host') as HTMLElement;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      x: 5, y: 7, left: 5, top: 7, right: 125, bottom: 167,
      width: 120, height: 160, toJSON: () => ({})
    });

    await waitFor(() => expect(player.play).toHaveBeenCalled());
    act(() => {
      motionListener?.({
        type: 'snapshot',
        snapshot: {
          revision: 2,
          timestampMs: 16,
          position: { x: 100, y: 200 },
          target: { x: 100, y: 200 },
          direction: 'right',
          moving: false
        }
      });
    });
    await waitFor(() => expect(onDesktopAnchors).toHaveBeenCalledWith({
      carry: { x: 175, y: 277 },
      seat: null,
      focus: null
    }));
  });

  test('当前角色成功编译事件会强制重载同一角色，其他角色编译不会刷新', async () => {
    const currentManifest = manifest('character-a');
    let listener: ((event:
      | { type: 'compile-result'; characterId: string; ok: true }
      | { type: 'active-character-changed'; characterId: string }
    ) => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const loader = vi.fn(async characterId => bundle(characterId));
    const createPlayer = vi.fn(async () => ({
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    }));
    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={loader}
      />
    );

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await act(async () => {
      listener?.({ type: 'compile-result', characterId: 'character-b', ok: true });
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      listener?.({ type: 'compile-result', characterId: 'character-a', ok: true });
    });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  test('默认加载器使用期望快照并拒绝读取期间发生的同 ID 发布变化', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    const expected = manifest('character-a');
    expected.resources[0]!.sha256 = [...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, '0'))
      .join('');
    const changed = structuredClone(expected);
    changed.compilerVersion = 'changed';
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: changed.id,
        manifest: changed
      })),
      readCharacterRuntimeAsset: vi.fn(async () => bytes)
    } as unknown as MyselfApi;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:atlas'),
      revokeObjectURL: vi.fn()
    });
    try {
      await expect(createRuntimeAssetLoader(api)(
        expected.id,
        new AbortController().signal,
        { snapshot: { activeCharacterId: expected.id, manifest: expected } }
      )).rejects.toThrow('CHARACTER_RUNTIME_CHANGED');
      expect(api.readCharacterRuntimeAsset).toHaveBeenCalledWith('atlas');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:atlas');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('默认加载器拒绝与清单 SHA-256 不一致的资源字节', async () => {
    const expected = manifest('character-a');
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: expected.id,
        manifest: expected
      })),
      readCharacterRuntimeAsset: vi.fn(async () => new Uint8Array([9, 9, 9]))
    } as unknown as MyselfApi;
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    try {
      await expect(createRuntimeAssetLoader(api)(
        expected.id,
        new AbortController().signal,
        { snapshot: { activeCharacterId: expected.id, manifest: expected } }
      )).rejects.toThrow('CHARACTER_RUNTIME_ASSET_HASH_MISMATCH');
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(api.getCharacterRuntimeSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('同修订校验变化时至多重试一次并使用新快照上下文', async () => {
    const first = manifest('character-a');
    const second = structuredClone(first);
    second.compilerVersion = 'second';
    const snapshots = [first, second];
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('CHARACTER_RUNTIME_CHANGED'))
      .mockImplementationOnce(async characterId => bundle(characterId));
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift()!;
        return { activeCharacterId: next.id, manifest: next };
      }),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => player}
        loadBundle={loader}
      />
    );

    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(1));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[0]?.[2]?.snapshot.manifest.compilerVersion).toBe('test');
    expect(loader.mock.calls[1]?.[2]?.snapshot.manifest.compilerVersion).toBe('second');
    expect(api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  test('默认 loader 遇到 A 清单与 B 字节哈希冲突后重试 B 并提交一致 bundle', async () => {
    const commonBytes = new Uint8Array([1]);
    const oldBytes = new Uint8Array([2]);
    const newBytes = new Uint8Array([3]);
    const hash = async (bytes: Uint8Array): Promise<string> => {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      return [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('');
    };
    const manifestA = manifest('character-a');
    manifestA.resources[0]!.sha256 = await hash(commonBytes);
    manifestA.resources.push({
      assetId: 'atlas-extra',
      fileName: 'atlas-extra.png',
      sha256: await hash(oldBytes),
      byteLength: oldBytes.byteLength
    });
    manifestA.states[0]!.actions[0]!.frames.push({
      assetId: 'atlas-extra',
      x: 0,
      y: 0,
      width: 32,
      height: 32
    });
    const manifestB = structuredClone(manifestA);
    manifestB.compilerVersion = 'revision-b';
    manifestB.resources[1]!.sha256 = await hash(newBytes);
    const snapshots = [manifestA, manifestB, manifestB];
    const readCharacterRuntimeAsset = vi.fn()
      .mockResolvedValueOnce(commonBytes)
      .mockResolvedValueOnce(newBytes)
      .mockResolvedValueOnce(commonBytes)
      .mockResolvedValueOnce(newBytes);
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift()!;
        return { activeCharacterId: next.id, manifest: next };
      }),
      readCharacterRuntimeAsset,
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    const createdUrls = ['blob:first-rollback', 'blob:b-common', 'blob:b-extra'];
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => createdUrls.shift()!),
      revokeObjectURL: vi.fn()
    });
    const candidate = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    try {
      render(
        <CharacterPlayer
          stateId="idle"
          motionMode="animated"
          api={api}
          createPlayer={async () => candidate}
        />
      );

      await waitFor(() => expect(candidate.play).toHaveBeenCalledOnce());
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-rollback');
      expect(api.getCharacterRuntimeSnapshot).toHaveBeenCalledTimes(3);
      expect(readCharacterRuntimeAsset).toHaveBeenCalledTimes(4);
      expect(candidate.load).toHaveBeenCalledWith(
        manifestB,
        expect.objectContaining({
          characterId: 'character-a',
          atlasUrls: new Map([
            ['atlas', 'blob:b-common'],
            ['atlas-extra', 'blob:b-extra']
          ])
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('候选播放器在 host 内按真实布局初始化且成功前不替换旧画面', async () => {
    const secondLoad = deferred<void>();
    const snapshots = [manifest('character-a'), manifest('character-b')];
    let listener: ((event: { type: 'active-character-changed'; characterId: string }) => void)
      | undefined;
    const containers: HTMLElement[] = [];
    const players = [undefined, secondLoad.promise].map(loadPromise => ({
      load: vi.fn(() => loadPromise ?? Promise.resolve()),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    }));
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift()!;
        return { activeCharacterId: next.id, manifest: next };
      }),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async container => {
          containers.push(container);
          return players[containers.length - 1]!;
        }}
        loadBundle={async characterId => bundle(characterId)}
      />
    );

    await waitFor(() => expect(players[0]!.play).toHaveBeenCalledTimes(1));
    const host = result.container.querySelector('.character-player-host')!;
    const oldStage = host.firstElementChild;
    await act(async () => {
      listener?.({ type: 'active-character-changed', characterId: 'character-b' });
    });
    await waitFor(() => expect(containers).toHaveLength(2));
    expect(containers[1]!.parentElement).toBe(host);
    expect(host.firstElementChild).toBe(oldStage);
    expect(containers[1]!.classList.contains('is-active')).toBe(false);
    secondLoad.resolve();
    await act(async () => {
      await secondLoad.promise;
    });
    expect(host.firstElementChild).toBe(containers[1]);
    expect(containers[1]!.classList.contains('is-active')).toBe(true);
  });

  test('活动角色事件会刷新快照，加载中不闪烁备用角色', async () => {
    const snapshots = [manifest('character-a'), manifest('character-b')];
    let listener: ((event: { type: 'active-character-changed'; characterId: string }) => void)
      | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift();
        return next ? { activeCharacterId: next.id, manifest: next } : null;
      }),
      readCharacterRuntimeAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const createPlayer = vi.fn(async () => player) as CharacterPlayerPortFactory;

    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={async characterId => bundle(characterId)}
        fallback={<span>备用角色</span>}
      />
    );

    expect(result.queryByText('备用角色')).toBeNull();
    await waitFor(() => expect(player.load).toHaveBeenCalledTimes(1));
    await act(async () => {
      listener?.({ type: 'active-character-changed', characterId: 'character-b' });
    });
    await waitFor(() => expect(player.load).toHaveBeenCalledTimes(2));
  });

  test('运行角色加载失败后才显示备用角色', async () => {
    const snapshotLoad = deferred<never>();
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(() => snapshotLoad.promise),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;

    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={vi.fn()}
        loadBundle={async characterId => bundle(characterId)}
        fallback={<span>备用角色</span>}
      />
    );

    expect(result.queryByText('备用角色')).toBeNull();
    await act(async () => {
      snapshotLoad.reject(new Error('读取失败'));
    });
    await waitFor(() => expect(result.getByText('备用角色')).toBeTruthy());
  });

  test('运行角色加载失败时上报稳定错误码供修复入口展示', async () => {
    const onRuntimeError = vi.fn();
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
      }),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;

    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={vi.fn()}
        onRuntimeError={onRuntimeError}
      />
    );

    await waitFor(() => expect(onRuntimeError)
      .toHaveBeenCalledWith('CHARACTER_RESOURCE_INTEGRITY_FAILED'));
  });

  test('从 Electron 包装错误中提取共享稳定错误码', async () => {
    const onRuntimeError = vi.fn();
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'character:runtime-snapshot-get': "
          + 'Error: CHARACTER_RESOURCE_INTEGRITY_FAILED'
        );
      }),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;

    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={vi.fn()}
        onRuntimeError={onRuntimeError}
      />
    );

    await waitFor(() => expect(onRuntimeError)
      .toHaveBeenCalledWith('CHARACTER_RESOURCE_INTEGRITY_FAILED'));
  });

  test('运行版本失败后刷新成功会清除旧错误', async () => {
    const onRuntimeError = vi.fn();
    const currentManifest = manifest('character-a');
    let listener: ((event: {
      type: 'active-character-changed';
      characterId: string;
    }) => void) | undefined;
    const api = {
      getCharacterRuntimeSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED'))
        .mockResolvedValueOnce({
          activeCharacterId: currentManifest.id,
          manifest: currentManifest
        }),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;

    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => ({
          load: vi.fn(async () => undefined),
          play: vi.fn(),
          setDirection: vi.fn(),
          getAnchor: vi.fn(() => null),
          ...characterPlayerHitRegionFixture(),
          destroy: vi.fn()
        })}
        loadBundle={async characterId => bundle(characterId)}
        onRuntimeError={onRuntimeError}
      />
    );

    await waitFor(() => expect(onRuntimeError)
      .toHaveBeenCalledWith('CHARACTER_RESOURCE_INTEGRITY_FAILED'));
    await act(async () => {
      listener?.({
        type: 'active-character-changed',
        characterId: currentManifest.id
      });
    });
    await waitFor(() => expect(onRuntimeError).toHaveBeenCalledWith(null));
  });

  test('窗口隐藏时切换静态模式停止 ticker，恢复可见后继续动画', async () => {
    const currentManifest = manifest('character-a');
    const player = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => player}
        loadBundle={async () => bundle('character-a')}
      />
    );
    await waitFor(() => expect(player.play).toHaveBeenCalled());

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(player.play.mock.calls.at(-1)?.[1]).toBe('static'));

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(player.play.mock.calls.at(-1)?.[1]).toBe('animated'));
  });

  test('候选播放器加载失败时立即释放并清空旧画面', async () => {
    const currentManifest = manifest('character-a');
    const candidate = {
      load: vi.fn().mockRejectedValue(new Error('纹理解码失败')),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => candidate}
        loadBundle={async characterId => bundle(characterId)}
        fallback={<span>备用角色</span>}
      />
    );

    await waitFor(() => expect(result.getByText('备用角色')).toBeTruthy());
    expect(candidate.destroy).toHaveBeenCalledTimes(1);
    expect(result.container.querySelector('.character-player-host')?.children).toHaveLength(1);
    expect(
      result.container.querySelector('.character-player-host')
        ?.firstElementChild?.classList.contains('character-player-stage')
    ).toBe(true);
  });

  test('角色切换时较旧候选后完成也不能覆盖新播放器', async () => {
    const oldLoad = deferred<void>();
    const snapshots = [manifest('character-a'), manifest('character-b')];
    let listener: ((event: { type: 'active-character-changed'; characterId: string }) => void)
      | undefined;
    const oldPlayer = {
      load: vi.fn(() => oldLoad.promise),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const newPlayer = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const createPlayer = vi.fn()
      .mockResolvedValueOnce(oldPlayer)
      .mockResolvedValueOnce(newPlayer);
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift();
        return next ? { activeCharacterId: next.id, manifest: next } : null;
      }),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={async characterId => bundle(characterId)}
      />
    );

    await waitFor(() => expect(oldPlayer.load).toHaveBeenCalledTimes(1));
    await act(async () => {
      listener?.({ type: 'active-character-changed', characterId: 'character-b' });
    });
    await waitFor(() => expect(newPlayer.play).toHaveBeenCalledTimes(1));
    oldLoad.resolve();
    await act(async () => {
      await oldLoad.promise;
    });

    expect(oldPlayer.destroy).toHaveBeenCalledTimes(1);
    expect(newPlayer.destroy).not.toHaveBeenCalled();
  });

  test('过期候选加载随后拒绝时仍立即销毁且不改变新播放器状态', async () => {
    const oldLoad = deferred<void>();
    const snapshots = [manifest('character-a'), manifest('character-b')];
    let listener: ((event: { type: 'active-character-changed'; characterId: string }) => void)
      | undefined;
    const oldPlayer = {
      load: vi.fn(() => oldLoad.promise),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      destroy: vi.fn()
    };
    const newPlayer = {
      load: vi.fn().mockResolvedValue(undefined),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      destroy: vi.fn()
    };
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => {
        const next = snapshots.shift()!;
        return { activeCharacterId: next.id, manifest: next };
      }),
      subscribeCharacterEvents: vi.fn(callback => {
        listener = callback;
        return vi.fn();
      })
    } as unknown as MyselfApi;
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={vi.fn()
          .mockResolvedValueOnce(oldPlayer)
          .mockResolvedValueOnce(newPlayer)}
        loadBundle={async characterId => bundle(characterId)}
      />
    );

    await waitFor(() => expect(oldPlayer.load).toHaveBeenCalledTimes(1));
    await act(async () => {
      listener?.({ type: 'active-character-changed', characterId: 'character-b' });
    });
    await waitFor(() => expect(newPlayer.play).toHaveBeenCalledTimes(1));
    oldLoad.reject(new Error('过期加载失败'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(oldPlayer.destroy).toHaveBeenCalledTimes(1);
    expect(newPlayer.destroy).not.toHaveBeenCalled();
    expect(result.container.querySelector('.character-player')?.getAttribute('data-status'))
      .toBe('ready');
  });

  test('卸载期间完成的加载不会挂载且会释放候选播放器', async () => {
    const pendingPlayer = deferred<Awaited<ReturnType<CharacterPlayerPortFactory>>>();
    const candidate = {
      load: vi.fn(),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const currentManifest = manifest('character-a');
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      readCharacterRuntimeAsset: vi.fn(async () => new Uint8Array([1])),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    const createPlayer = vi.fn(() => pendingPlayer.promise);
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={createPlayer}
        loadBundle={async characterId => bundle(characterId)}
      />
    );

    await waitFor(() => expect(createPlayer).toHaveBeenCalledTimes(1));
    result.unmount();
    pendingPlayer.resolve(candidate);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(candidate.destroy).toHaveBeenCalledTimes(1);
    expect(candidate.load).not.toHaveBeenCalled();
  });

  test.each([
    ['resolve', (pending: ReturnType<typeof deferred<void>>) => pending.resolve()],
    ['reject', (pending: ReturnType<typeof deferred<void>>) => pending.reject(
      new Error('卸载后的加载拒绝')
    )]
  ] as const)('candidate.load pending 后卸载再 %s 只销毁一次', async (_name, settle) => {
    const pending = deferred<void>();
    const candidate = {
      load: vi.fn(() => pending.promise),
      play: vi.fn(),
      setDirection: vi.fn(),
      getAnchor: vi.fn().mockReturnValue(null),
      ...characterPlayerHitRegionFixture(),
      destroy: vi.fn()
    };
    const currentManifest = manifest('character-a');
    const api = {
      getCharacterRuntimeSnapshot: vi.fn(async () => ({
        activeCharacterId: currentManifest.id,
        manifest: currentManifest
      })),
      subscribeCharacterEvents: vi.fn(() => vi.fn())
    } as unknown as MyselfApi;
    const result = render(
      <CharacterPlayer
        stateId="idle"
        motionMode="animated"
        api={api}
        createPlayer={async () => candidate}
        loadBundle={async characterId => bundle(characterId)}
      />
    );

    await waitFor(() => expect(candidate.load).toHaveBeenCalledOnce());
    result.unmount();
    settle(pending);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(candidate.destroy).toHaveBeenCalledOnce();
    expect(candidate.play).not.toHaveBeenCalled();
  });
});
