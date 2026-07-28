import {
  selectCharacterAction,
  type CharacterMotionMode,
  type CharacterStateId
} from '@myself/character-runtime';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  CharacterRuntimeSnapshot
} from '../../../../shared/character-ipc';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  CharacterResourceCache,
  destroyCharacterAssetBundle,
  type CharacterAssetBundle,
  type CharacterAssetLoader
} from './character-resource-cache';
import {
  PixiCharacterPlayer,
  type CharacterPlayerPort
} from './pixi-character-player';

export type CharacterPlayerPortFactory = (
  container: HTMLElement
) => Promise<CharacterPlayerPort>;

export interface CharacterPlayerProps {
  stateId: CharacterStateId;
  motionMode: CharacterMotionMode;
  direction?: 'left' | 'right';
  fallback?: ReactNode;
  api?: MyselfApi;
  createPlayer?: CharacterPlayerPortFactory;
  loadBundle?: CharacterAssetLoader;
  random?: () => number;
}

const MAX_RUNTIME_LOAD_ATTEMPTS = 2;
const createDefaultPlayer: CharacterPlayerPortFactory = container => (
  PixiCharacterPlayer.create(container)
);

/**
 * React 只编排受限 API、缓存和播放器端口，不持有 Pixi 纹理对象。
 */
export function CharacterPlayer({
  stateId,
  motionMode,
  direction = 'right',
  fallback,
  api = window.myself,
  createPlayer = createDefaultPlayer,
  loadBundle,
  random = Math.random
}: CharacterPlayerProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const activePlayerRef = useRef<CharacterPlayerPort | null>(null);
  const activeSnapshotRef = useRef<CharacterRuntimeSnapshot | null>(null);
  const playbackRef = useRef({ stateId, motionMode, direction, random });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  playbackRef.current = { stateId, motionMode, direction, random };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let revision = 0;
    const candidates = new Set<CharacterPlayerPort>();
    const destroyedPlayers = new WeakSet<CharacterPlayerPort>();
    const loader = loadBundle ?? createRuntimeAssetLoader(api);
    const cache = new CharacterResourceCache(loader, destroyCharacterAssetBundle);
    const placeholder = document.createElement('span');
    placeholder.className = 'character-player-stage';
    host.appendChild(placeholder);

    /** 异步完成路径与卸载路径共享同一所有权门，确保播放器只释放一次。 */
    const destroyPlayerOnce = (player: CharacterPlayerPort): void => {
      if (destroyedPlayers.has(player)) return;
      destroyedPlayers.add(player);
      player.destroy();
    };

    const refresh = async (forceReload = false): Promise<void> => {
      const currentRevision = ++revision;
      let candidate: CharacterPlayerPort | null = null;
      let staging: HTMLSpanElement | null = null;
      setStatus('loading');

      try {
        let snapshot: CharacterRuntimeSnapshot | null = null;
        let assets: CharacterAssetBundle | null = null;

        for (let attempt = 0; attempt < MAX_RUNTIME_LOAD_ATTEMPTS; attempt += 1) {
          snapshot = await api.getCharacterRuntimeSnapshot();
          if (disposed || currentRevision !== revision) return;
          if (!snapshot) throw new Error('CHARACTER_RUNTIME_UNAVAILABLE');

          try {
            assets = await cache.activate(snapshot.activeCharacterId, {
              forceReload: forceReload || attempt > 0,
              context: { snapshot }
            });
            break;
          } catch (error) {
            if (
              !isRuntimeChangedError(error)
              || attempt + 1 >= MAX_RUNTIME_LOAD_ATTEMPTS
            ) {
              throw error;
            }
          }
        }

        if (disposed || currentRevision !== revision || !snapshot || !assets) return;

        staging = document.createElement('span');
        staging.className = 'character-player-stage';
        host.appendChild(staging);
        candidate = await createPlayer(staging);
        candidates.add(candidate);
        if (disposed || currentRevision !== revision) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
          staging.remove();
          return;
        }

        await candidate.load(snapshot.manifest, assets);
        if (disposed || currentRevision !== revision) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
          staging.remove();
          return;
        }

        const playback = playbackRef.current;
        candidate.setDirection(playback.direction);
        candidate.play(selectCharacterAction({
          manifest: snapshot.manifest,
          stateId: playback.stateId,
          direction: playback.direction,
          recentActionIds: [],
          random: playback.random
        }), playback.motionMode);

        const previous = activePlayerRef.current;
        activePlayerRef.current = candidate;
        activeSnapshotRef.current = snapshot;
        candidates.delete(candidate);
        staging.classList.add('is-active');
        for (const child of [...host.children]) {
          if (child !== staging) child.remove();
        }
        if (previous) destroyPlayerOnce(previous);
        setStatus('ready');
      } catch {
        // 候选资源属于本次局部事务，即使修订已过期也必须立即释放。
        if (candidate) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
        }
        staging?.remove();

        if (!disposed && currentRevision === revision) {
          if (activePlayerRef.current) {
            setStatus('ready');
          } else {
            activeSnapshotRef.current = null;
            setStatus('error');
          }
        }
      }
    };

    const unsubscribe = api.subscribeCharacterEvents(event => {
      if (event.type === 'active-character-changed') {
        void refresh(true);
        return;
      }
      if (
        event.type === 'compile-result'
        && event.ok
        && event.characterId === activeSnapshotRef.current?.activeCharacterId
      ) {
        void refresh(true);
      }
    });
    void refresh();

    return () => {
      disposed = true;
      ++revision;
      unsubscribe();
      cache.destroy();
      for (const candidate of candidates) destroyPlayerOnce(candidate);
      candidates.clear();
      if (activePlayerRef.current) destroyPlayerOnce(activePlayerRef.current);
      activePlayerRef.current = null;
      activeSnapshotRef.current = null;
      host.replaceChildren();
    };
  }, [api, createPlayer, loadBundle]);

  useEffect(() => {
    const player = activePlayerRef.current;
    const snapshot = activeSnapshotRef.current;
    if (!player || !snapshot) return;

    player.setDirection(direction);
    player.play(selectCharacterAction({
      manifest: snapshot.manifest,
      stateId,
      direction,
      recentActionIds: [],
      random
    }), motionMode);
  }, [direction, motionMode, random, stateId]);

  return (
    <span
      className="character-player"
      data-status={status}
      aria-busy={status === 'loading'}
    >
      <span ref={hostRef} className="character-player-host" aria-hidden="true" />
      {status === 'error' ? fallback : null}
    </span>
  );
}

export function createRuntimeAssetLoader(api: MyselfApi): CharacterAssetLoader {
  return async (characterId, signal, context): Promise<CharacterAssetBundle> => {
    const expected = context?.snapshot;
    if (!expected || expected.activeCharacterId !== characterId) {
      throw new Error('CHARACTER_RUNTIME_CHANGED');
    }

    const expectedFingerprint = runtimeSnapshotFingerprint(expected);
    const atlasAssetIds = new Set(
      expected.manifest.states.flatMap(state => (
        state.actions.flatMap(action => action.frames.map(frame => frame.assetId))
      ))
    );
    const resources = expected.manifest.resources.filter(resource => (
      atlasAssetIds.has(resource.assetId)
    ));
    const urls = new Map<string, string>();

    try {
      for (const resource of resources) {
        throwIfAborted(signal);
        const bytes = await api.readCharacterRuntimeAsset(resource.assetId);
        throwIfAborted(signal);
        if (await sha256Hex(bytes) !== resource.sha256) {
          throw new Error('CHARACTER_RUNTIME_ASSET_HASH_MISMATCH');
        }
        const mimeType = resource.fileName.endsWith('.webp')
          ? 'image/webp'
          : 'image/png';
        const blob = new Blob([new Uint8Array(bytes).buffer], { type: mimeType });
        urls.set(resource.assetId, URL.createObjectURL(blob));
      }

      throwIfAborted(signal);
      const confirmed = await api.getCharacterRuntimeSnapshot();
      throwIfAborted(signal);
      if (!confirmed || runtimeSnapshotFingerprint(confirmed) !== expectedFingerprint) {
        throw new Error('CHARACTER_RUNTIME_CHANGED');
      }
      return { characterId, atlasUrls: urls };
    } catch (error) {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      throw error;
    }
  };
}

export function runtimeSnapshotFingerprint(snapshot: CharacterRuntimeSnapshot): string {
  return stableSerialize({
    activeCharacterId: snapshot.activeCharacterId,
    manifest: snapshot.manifest,
    resourceHashes: snapshot.manifest.resources
      .map(resource => `${resource.assetId}:${resource.sha256}:${resource.byteLength}`)
      .sort()
  });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('已取消角色资源加载', 'AbortError');
  }
}

function isRuntimeChangedError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'CHARACTER_RUNTIME_CHANGED'
    || error.message === 'CHARACTER_RUNTIME_ASSET_HASH_MISMATCH'
  );
}
