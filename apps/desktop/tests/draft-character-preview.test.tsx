// @vitest-environment jsdom

import { useLayoutEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CharacterDraftV1,
  CharacterStateId,
  DraftActionClip
} from '@myself/character-runtime';
import type {
  CharacterWorkshopApi
} from '../src/renderer/src/characters/store/character-workshop-store';
import {
  DraftPreviewResourceCache
} from '../src/renderer/src/characters/workshop/draft-preview-resource-cache';
import {
  createPreviewState,
  type PreviewState
} from '../src/renderer/src/characters/workshop/PreviewControls';
import {
  DraftCharacterPreview
} from '../src/renderer/src/characters/workshop/DraftCharacterPreview';
import type {
  PixiCharacterScene
} from '../src/renderer/src/characters/player/pixi-character-player';

const pixiFactory = vi.hoisted(() => vi.fn());

vi.mock(
  '../src/renderer/src/characters/player/pixi-character-player',
  async importOriginal => ({
    ...await importOriginal<
      typeof import('../src/renderer/src/characters/player/pixi-character-player')
    >(),
    createBrowserPixiCharacterScene: pixiFactory
  })
);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50
]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function apiWithReader(
  readCharacterSource: CharacterWorkshopApi['readCharacterSource']
): Pick<CharacterWorkshopApi, 'readCharacterSource'> {
  return { readCharacterSource };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('草稿预览资源缓存', () => {
  const createdBlobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:preview-${createdBlobs.length}`;
  });
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createdBlobs.length = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('同一动作多帧引用相同素材时只读取一次', async () => {
    const readCharacterSource = vi.fn(async () => PNG_BYTES);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    const bundle = await cache.load(
      'nova',
      ['sheet-a', 'sheet-a'],
      new AbortController().signal
    );

    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(readCharacterSource).toHaveBeenCalledWith('nova', 'sheet-a');
    expect([...bundle.urls]).toEqual([['sheet-a', 'blob:preview-1']]);
  });

  test('并发加载相同素材共享读取且分别持有引用', async () => {
    const source = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(() => source.promise);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    const firstLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    const secondLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    expect(readCharacterSource).toHaveBeenCalledOnce();

    source.resolve(PNG_BYTES);
    const [first, second] = await Promise.all([firstLoad, secondLoad]);
    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  test('并发共享慢读取时取消一方不影响另一方取得并释放 URL', async () => {
    const source = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(() => source.promise);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));
    const firstController = new AbortController();

    const firstLoad = cache.load(
      'nova',
      ['sheet-a'],
      firstController.signal
    );
    const secondLoad = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    expect(readCharacterSource).toHaveBeenCalledOnce();

    firstController.abort();
    await expect(firstLoad).rejects.toMatchObject({ name: 'AbortError' });
    source.resolve(PNG_BYTES);

    const second = await secondLoad;
    expect(second.urls.get('sheet-a')).toBe('blob:preview-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  test('取消加载会释放该调用已创建的 Blob URL', async () => {
    const slowSource = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(
      async (_characterId: string, assetId: string) => (
        assetId === 'ready' ? PNG_BYTES : slowSource.promise
      )
    );
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));
    const controller = new AbortController();

    const loading = cache.load(
      'nova',
      ['ready', 'slow'],
      controller.signal
    );
    await settle();
    expect(createObjectURL).toHaveBeenCalledOnce();

    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');

    slowSource.resolve(PNG_BYTES);
    await settle();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  test('单个 bundle 重复 release 只撤销一次', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    const bundle = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    bundle.release();
    bundle.release();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  test('一个 bundle 释放不影响另一个 bundle 使用同一素材', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    const first = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );
    const second = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(second.urls.get('sheet-a')).toBe('blob:preview-1');

    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  test('读取失败会清理条目并允许后续重试', async () => {
    const readCharacterSource = vi.fn()
      .mockRejectedValueOnce(new Error('CHARACTER_SOURCE_READ_FAILED'))
      .mockResolvedValueOnce(PNG_BYTES);
    const cache = new DraftPreviewResourceCache(apiWithReader(readCharacterSource));

    await expect(cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    )).rejects.toThrow('CHARACTER_SOURCE_READ_FAILED');
    const retried = await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    expect(readCharacterSource).toHaveBeenCalledTimes(2);
    expect(retried.urls.get('sheet-a')).toBe('blob:preview-1');
  });

  test('加载过程中 destroy 会阻止晚到结果创建 Blob URL', async () => {
    const source = deferred<Uint8Array>();
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(() => source.promise)
    ));
    const loading = cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    cache.destroy();
    source.resolve(PNG_BYTES);

    await expect(loading).rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test('destroy 释放全部 Blob URL 且后续加载被拒绝', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => PNG_BYTES)
    ));
    await cache.load(
      'nova',
      ['sheet-a', 'sheet-b'],
      new AbortController().signal
    );

    cache.destroy();

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
    await expect(cache.load(
      'nova',
      ['sheet-c'],
      new AbortController().signal
    )).rejects.toThrow('DRAFT_PREVIEW_CACHE_DESTROYED');
  });

  test.each([
    ['PNG', PNG_BYTES, 'image/png'],
    ['WebP', WEBP_BYTES, 'image/webp']
  ] as const)('%s 魔数创建对应 MIME 的 Blob', async (
    _name,
    bytes,
    expectedMimeType
  ) => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => bytes)
    ));

    await cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    );

    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]?.type).toBe(expectedMimeType);
  });

  test('不支持的素材内容沿用角色图片 MIME 错误语义', async () => {
    const cache = new DraftPreviewResourceCache(apiWithReader(
      vi.fn(async () => new Uint8Array([1, 2, 3]))
    ));

    await expect(cache.load(
      'nova',
      ['sheet-a'],
      new AbortController().signal
    )).rejects.toThrow('CHARACTER_IMAGE_MIME_UNSUPPORTED');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

const idleAction: DraftActionClip = {
  id: 'idle-main',
  name: '待机',
  fps: 10,
  loop: true,
  weight: 1,
  direction: 'any',
  anchors: {
    ground: { x: 0.5, y: 1 },
    carry: { x: 0.7, y: 0.4 }
  },
  frames: [{
    id: 'idle-a',
    assetId: 'idle-sheet',
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    durationMs: 100
  }, {
    id: 'idle-b',
    assetId: 'idle-sheet',
    x: 64,
    y: 0,
    width: 64,
    height: 64,
    durationMs: 100,
    anchors: { carry: { x: 0.2, y: 0.3 } }
  }]
};

const actingAction: DraftActionClip = {
  ...idleAction,
  id: 'acting-main',
  name: '动作',
  anchors: { ground: { x: 0.5, y: 1 } },
  frames: [{
    id: 'acting-a',
    assetId: 'acting-sheet',
    x: 0,
    y: 0,
    width: 48,
    height: 48,
    durationMs: 100
  }]
};

function draftWith(
  idle: DraftActionClip = idleAction,
  acting: DraftActionClip = actingAction
): CharacterDraftV1 {
  return {
    version: 1,
    id: 'nova',
    name: 'Nova',
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [idle]
    }, {
      id: 'thinking',
      kind: 'core',
      actions: []
    }, {
      id: 'acting',
      kind: 'core',
      actions: [acting]
    }]
  };
}

function previewState(
  overrides: Partial<PreviewState> = {}
): PreviewState {
  return {
    ...createPreviewState(2),
    ...overrides
  };
}

function previewProps(
  draft: CharacterDraftV1 = draftWith(),
  overrides: Partial<React.ComponentProps<typeof DraftCharacterPreview>> = {}
): React.ComponentProps<typeof DraftCharacterPreview> {
  return {
    characterId: 'nova',
    draft,
    stateId: 'idle',
    actionId: 'idle-main',
    selectedFrameId: 'idle-a',
    preview: previewState(),
    api: apiWithReader(vi.fn(async () => PNG_BYTES)),
    ...overrides
  };
}

function sceneDouble() {
  let currentFrame: ReturnType<PixiCharacterScene['getCurrentFrame']> = null;
  let frameListener: (() => void) | null = null;
  const unsubscribe = vi.fn();
  const scene: PixiCharacterScene = {
    loadAssets: vi.fn(async () => undefined),
    showAction: vi.fn((action, options) => {
      currentFrame = {
        action,
        frameIndex: options.frameIndex ?? 0,
        bounds: { x: 10, y: 20, width: 100, height: 80 }
      };
    }),
    getCurrentFrame: vi.fn(() => currentFrame),
    subscribeFrame: vi.fn(listener => {
      frameListener = listener;
      return unsubscribe;
    }),
    destroy: vi.fn()
  };
  return {
    emitFrame: () => frameListener?.(),
    setFrame: (frameIndex: number) => {
      if (currentFrame) currentFrame = { ...currentFrame, frameIndex };
    },
    scene,
    unsubscribe
  };
}

describe('真实草稿预览', () => {
  const createdUrls: string[] = [];
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createdUrls.length = 0;
    revokeObjectURL.mockClear();
    pixiFactory.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        const url = `blob:draft-${createdUrls.length + 1}`;
        createdUrls.push(url);
        return url;
      }),
      revokeObjectURL
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('内存草稿无需保存或发布即可加载唯一源素材并显示动作', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const readCharacterSource = vi.fn(async () => PNG_BYTES);

    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      preview: previewState({ playing: true }),
      api: apiWithReader(readCharacterSource)
    })} />);

    await waitFor(() => {
      expect(screen.getByTestId('draft-character-preview').getAttribute(
        'data-preview-status'
      )).toBe('ready');
    });
    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(readCharacterSource).toHaveBeenCalledWith('nova', 'idle-sheet');
    expect(current.scene.loadAssets).toHaveBeenCalledWith(
      new Map([['idle-sheet', 'blob:draft-1']])
    );
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({
        direction: 'right',
        loop: true,
        motionMode: 'animated',
        speed: 1
      })
    );
  });

  test('控制重建动作时复用单个帧订阅，暂停逐帧不会请求连续播放', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const props = previewProps();
    const view = render(<DraftCharacterPreview {...props} />);
    await screen.findByText('预览已就绪');

    view.rerender(<DraftCharacterPreview {...props} preview={previewState({
      direction: 'left',
      frameIndex: 1,
      loop: false,
      speed: 1.5
    })} />);

    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({
        direction: 'left',
        frameIndex: 1,
        loop: false,
        motionMode: 'static',
        speed: 1.5
      })
    );
    expect(current.scene.subscribeFrame).toHaveBeenCalledOnce();
    view.unmount();
    expect(current.unsubscribe).toHaveBeenCalledOnce();
    expect(current.scene.destroy).toHaveBeenCalledOnce();
  });

  test('容器尺寸变化通过 ResizeObserver 同步共享场景', async () => {
    const current = sceneDouble();
    current.scene.resize = vi.fn();
    let notifyResize: ResizeObserverCallback | null = null;
    const disconnectObserver = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = vi.fn();
      disconnect = disconnectObserver;
      unobserve = vi.fn();
    });
    pixiFactory.mockResolvedValue(current.scene);
    const view = render(<DraftCharacterPreview {...previewProps()} />);
    await screen.findByText('预览已就绪');

    act(() => notifyResize?.([{
      contentRect: {
        width: 320,
        height: 180
      }
    } as ResizeObserverEntry], {} as ResizeObserver));
    expect(current.scene.resize).toHaveBeenCalledWith(320, 180);
    view.unmount();
    expect(disconnectObserver).toHaveBeenCalledOnce();
  });

  test('场景播放帧回写父级，纯索引同步不重建且后续控制从实际帧继续', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const onFrameChange = vi.fn();
    const props = previewProps(draftWith(), {
      preview: previewState({ playing: true }),
      onFrameChange
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await screen.findByText('预览已就绪');
    current.setFrame(1);
    act(() => current.emitFrame());
    expect(onFrameChange).toHaveBeenCalledWith(1);
    const beforeSync = vi.mocked(current.scene.showAction).mock.calls.length;

    view.rerender(<DraftCharacterPreview
      {...props}
      preview={previewState({ playing: true, frameIndex: 1 })}
    />);
    expect(current.scene.showAction).toHaveBeenCalledTimes(beforeSync);

    view.rerender(<DraftCharacterPreview
      {...props}
      preview={previewState({
        playing: true,
        frameIndex: 1,
        direction: 'left',
        speed: 1.5
      })}
    />);
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({ frameIndex: 1, direction: 'left', speed: 1.5 })
    );
  });

  test('草稿帧与锚点修改立即重建场景且不重复读取相同素材', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const readCharacterSource = vi.fn(async () => PNG_BYTES);
    const props = previewProps(draftWith(), {
      api: apiWithReader(readCharacterSource)
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await screen.findByText('预览已就绪');
    const revisedAction: DraftActionClip = {
      ...idleAction,
      anchors: {
        ...idleAction.anchors,
        carry: { x: 0.4, y: 0.2 }
      },
      frames: idleAction.frames.map((frame, index) => (
        index === 0 ? { ...frame, x: 8 } : frame
      ))
    };

    view.rerender(<DraftCharacterPreview
      {...props}
      draft={draftWith(revisedAction)}
    />);

    await waitFor(() => {
      expect(current.scene.showAction).toHaveBeenLastCalledWith(
        revisedAction,
        expect.anything()
      );
    });
    expect(readCharacterSource).toHaveBeenCalledOnce();
  });

  test('旧素材请求晚到不能覆盖新动作', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const slow = deferred<Uint8Array>();
    const readCharacterSource = vi.fn(
      async (_characterId: string, assetId: string) => (
        assetId === 'idle-sheet' ? slow.promise : PNG_BYTES
      )
    );
    const props = previewProps(draftWith(), {
      api: apiWithReader(readCharacterSource)
    });
    const view = render(<DraftCharacterPreview {...props} />);

    view.rerender(<DraftCharacterPreview
      {...props}
      stateId="acting"
      actionId="acting-main"
      selectedFrameId="acting-a"
    />);
    await waitFor(() => {
      expect(current.scene.showAction).toHaveBeenCalledWith(
        actingAction,
        expect.anything()
      );
    });
    slow.resolve(PNG_BYTES);
    await act(async () => settle());

    expect(current.scene.showAction).not.toHaveBeenCalledWith(
      idleAction,
      expect.anything()
    );
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      actingAction,
      expect.anything()
    );
  });

  test('资源身份切换的首次提交同步显示加载态', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const committedStatuses: Array<string | null> = [];
    const props = previewProps();

    function StatusCommitProbe(probeProps: {
      stateId: CharacterStateId;
      actionId: string;
      selectedFrameId: string;
    }) {
      useLayoutEffect(() => {
        committedStatuses.push(
          screen.getByTestId('draft-character-preview').getAttribute(
            'data-preview-status'
          )
        );
      }, [probeProps.actionId]);
      return (
        <DraftCharacterPreview
          {...props}
          {...probeProps}
        />
      );
    }

    const view = render(<StatusCommitProbe
      stateId="idle"
      actionId="idle-main"
      selectedFrameId="idle-a"
    />);
    await screen.findByText('预览已就绪');
    committedStatuses.length = 0;

    view.rerender(<StatusCommitProbe
      stateId="acting"
      actionId="acting-main"
      selectedFrameId="acting-a"
    />);

    expect(committedStatuses[0]).toBe('loading');
  });

  test('API 切换即使新场景初始化挂起也立即取消旧资源等待', async () => {
    const current = sceneDouble();
    const nextScene = deferred<PixiCharacterScene>();
    pixiFactory
      .mockResolvedValueOnce(current.scene)
      .mockReturnValueOnce(nextScene.promise);
    let oldSignal: AbortSignal | null = null;
    const pendingBundle = deferred<never>();
    const load = vi.spyOn(DraftPreviewResourceCache.prototype, 'load')
      .mockImplementationOnce((_characterId, _assetIds, signal) => {
        oldSignal = signal;
        return pendingBundle.promise;
      });
    const props = previewProps();
    const view = render(<DraftCharacterPreview {...props} />);
    await waitFor(() => expect(load).toHaveBeenCalledOnce());

    view.rerender(<DraftCharacterPreview
      {...props}
      api={apiWithReader(vi.fn(async () => PNG_BYTES))}
    />);

    expect(oldSignal?.aborted).toBe(true);
    view.unmount();
  });

  test('新修订复用素材，角色切换与卸载依次释放旧 bundle 和场景', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const readCharacterSource = vi.fn(async () => PNG_BYTES);
    const props = previewProps(draftWith(), {
      api: apiWithReader(readCharacterSource)
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await screen.findByText('预览已就绪');
    const revisedAction = {
      ...idleAction,
      anchors: {
        ...idleAction.anchors,
        carry: { x: 0.6, y: 0.2 }
      }
    };

    view.rerender(<DraftCharacterPreview
      {...props}
      draft={draftWith(revisedAction)}
    />);
    await waitFor(() => {
      expect(current.scene.showAction).toHaveBeenLastCalledWith(
        revisedAction,
        expect.anything()
      );
    });
    expect(readCharacterSource).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.rerender(<DraftCharacterPreview
      {...props}
      characterId="luna"
      draft={draftWith(revisedAction)}
    />);
    await waitFor(() => expect(readCharacterSource).toHaveBeenCalledTimes(2));
    await screen.findByText('预览已就绪');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:draft-1');

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:draft-2');
    expect(current.unsubscribe).toHaveBeenCalledOnce();
    expect(current.scene.destroy).toHaveBeenCalledOnce();
  });

  test('当前帧覆盖锚点按镜像边界绘制，并仅在 carry 显示模拟文件', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      selectedFrameId: 'idle-b',
      preview: previewState({
        direction: 'left',
        frameIndex: 1,
        mountedFile: true,
        showAnchors: true
      })
    })} />);
    await screen.findByText('预览已就绪');

    const carry = screen.getByLabelText('锚点 carry');
    expect((carry as HTMLElement).style.left).toBe('90px');
    expect((carry as HTMLElement).style.top).toBe('44px');
    const mountedFile = screen.getByLabelText('模拟挂载文件') as HTMLElement;
    expect(mountedFile.style.left).toBe('90px');
    expect(mountedFile.style.top).toBe('44px');
  });

  test('页面隐藏时停止连续播放但保留逐帧，并在恢复可见后继续', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    const props = previewProps(draftWith(), {
      preview: previewState({ playing: true })
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await screen.findByText('预览已就绪');
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({ motionMode: 'animated' })
    );

    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    view.rerender(<DraftCharacterPreview {...props} preview={previewState({
      playing: true,
      frameIndex: 1
    })} />);
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({
        frameIndex: 1,
        motionMode: 'static'
      })
    );

    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({ motionMode: 'animated' })
    );
  });

  test('减少动态效果时强制静态预览', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })));

    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      preview: previewState({ playing: true })
    })} />);
    await screen.findByText('预览已就绪');

    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      idleAction,
      expect.objectContaining({ motionMode: 'static' })
    );
  });

  test.each([
    ['未选择角色', previewProps(draftWith(), {
      characterId: null,
      draft: null,
      stateId: null,
      actionId: null
    }), '请选择角色'],
    ['未选择动作', previewProps(draftWith(), {
      stateId: 'thinking',
      actionId: null
    }), '请选择动作'],
    ['动作没有帧', previewProps(draftWith({
      ...idleAction,
      frames: []
    })), '当前动作没有可预览帧'],
    ['帧矩形无效', previewProps(draftWith({
      ...idleAction,
      frames: [{ ...idleAction.frames[0]!, width: 0 }]
    })), '当前帧矩形无效']
  ])('%s 显示局部稳定状态', async (_name, props, message) => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...props} />);

    expect(await screen.findByText(message)).not.toBeNull();
    expect(screen.getByTestId('draft-character-preview').getAttribute(
      'data-preview-status'
    )).toBe('empty');
  });

  test('素材读取失败只显示局部中文错误', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      api: apiWithReader(vi.fn(async () => {
        throw new Error('CHARACTER_SOURCE_READ_FAILED');
      }))
    })} />);

    expect(await screen.findByText('预览素材读取失败')).not.toBeNull();
    expect(screen.getByTestId('draft-character-preview').getAttribute(
      'data-preview-status'
    )).toBe('error');
  });

  test('深色背景与方向速度语义反映真实场景状态', async () => {
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      preview: previewState({
        darkBackground: true,
        direction: 'left',
        speed: 1.75
      })
    })} />);
    await screen.findByText('预览已就绪');

    const preview = screen.getByTestId('draft-character-preview');
    expect(preview.classList.contains('draft-character-preview--dark'))
      .toBe(true);
    expect(preview.getAttribute('data-preview-direction')).toBe('left');
    expect(preview.getAttribute('data-preview-speed')).toBe('1.75');
  });

  test('ready 只在动作展示成功后提交，速度属性使用场景同一限制', async () => {
    const current = sceneDouble();
    vi.mocked(current.scene.showAction).mockImplementationOnce(() => {
      throw new Error('SHOW_FAILED');
    });
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      preview: previewState({ speed: 3 })
    })} />);

    await screen.findByText('预览渲染失败');
    const preview = screen.getByTestId('draft-character-preview');
    expect(preview.getAttribute('data-preview-status')).toBe('error');
    expect(preview.getAttribute('data-preview-speed')).not.toBe('3');
  });

  test.each([
    [false, ['idle-main', 'acting-main']],
    [true, ['idle-main', 'acting-main', 'idle-main']]
  ])('全状态巡览 loop=%s 跳过空动作并按顺序结束或循环', async (
    loop,
    expectedActions
  ) => {
    vi.useFakeTimers();
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    render(<DraftCharacterPreview {...previewProps(draftWith(), {
      preview: previewState({
        loop,
        playing: true,
        tourAllStates: true
      })
    })} />);
    await act(async () => settle());

    for (let index = 1; index < expectedActions.length; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(index === 1 ? 200 : 100);
        await settle();
      });
    }
    const shownIds = vi.mocked(current.scene.showAction).mock.calls
      .map(([shown]) => shown.id);
    expect(shownIds).toEqual(expect.arrayContaining(expectedActions));
    expect(shownIds.at(-1)).toBe(expectedActions.at(-1));

    if (!loop) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await settle();
      });
      expect(vi.mocked(current.scene.showAction).mock.calls.at(-1)?.[0].id)
        .toBe('acting-main');
    }
  });

  test('巡览帧不映射编辑时间轴且播放中控制重建保留实际帧', async () => {
    vi.useFakeTimers();
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const actingWithThreeFrames: DraftActionClip = {
      ...actingAction,
      frames: [0, 1, 2].map(index => ({
        ...actingAction.frames[0]!,
        id: `acting-${index}`,
        x: index * 48
      }))
    };
    const draft = draftWith(idleAction, actingWithThreeFrames);
    const onFrameChange = vi.fn();
    const props = previewProps(draft, {
      preview: previewState({
        playing: true,
        tourAllStates: true
      }),
      onFrameChange
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await act(async () => settle());
    await act(async () => {
      vi.advanceTimersByTime(200);
      await settle();
    });
    expect(vi.mocked(current.scene.showAction).mock.calls.at(-1)?.[0])
      .toBe(actingWithThreeFrames);

    current.setFrame(2);
    act(() => current.emitFrame());
    view.rerender(<DraftCharacterPreview
      {...props}
      preview={previewState({
        playing: true,
        tourAllStates: true,
        direction: 'left'
      })}
    />);

    expect.soft(onFrameChange).not.toHaveBeenCalled();
    expect(current.scene.showAction).toHaveBeenLastCalledWith(
      actingWithThreeFrames,
      expect.objectContaining({
        direction: 'left',
        frameIndex: 2
      })
    );
  });

  test('非循环巡览结束提交暂停，播放上升沿从首动作重播', async () => {
    vi.useFakeTimers();
    const current = sceneDouble();
    pixiFactory.mockResolvedValue(current.scene);
    const onPlayingChange = vi.fn();
    const props = previewProps(draftWith(), {
      preview: previewState({
        loop: false,
        playing: true,
        tourAllStates: true
      }),
      onPlayingChange
    });
    const view = render(<DraftCharacterPreview {...props} />);
    await act(async () => settle());
    await act(async () => {
      vi.advanceTimersByTime(200);
      await settle();
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await settle();
    });
    expect(onPlayingChange).toHaveBeenCalledWith(false);

    view.rerender(<DraftCharacterPreview
      {...props}
      preview={previewState({
        loop: false,
        playing: false,
        tourAllStates: true
      })}
    />);
    view.rerender(<DraftCharacterPreview {...props} />);
    await act(async () => settle());
    expect(vi.mocked(current.scene.showAction).mock.calls.at(-1)?.[0].id)
      .toBe('idle-main');
  });
});
