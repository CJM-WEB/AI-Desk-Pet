// @vitest-environment jsdom
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { characterManifestV3Schema, createCharacterPlaybackView } from '@myself/character-runtime';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import { CharacterProactivityScheduler } from '../src/main/characters/character-proactivity-scheduler';
import { CharacterPlayer } from '../src/renderer/src/characters/player/CharacterPlayer';
import type { MyselfApi } from '../src/shared/myself-api';
import type { CharacterMotionEvent } from '../src/shared/character-motion-ipc';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const pair = (stateId: string) => ({ stateId, actionId: `${stateId}-action` });
const bindings = { chatting: pair('state-7'), taskRunning: pair('state-6'), awaitingConfirmation: pair('state-7'), moving: pair('state'),
  success: pair('state-8'), error: pair('state-5'), praise: pair('state-8'), boredom: pair('state-3'), rest: pair('state-2') };

/** 真实 Renderer 的异步加载、事件缓冲和反馈接入真实 Main，只控制资源完成时刻及无副作用运动端口。 */
async function fixture(mode: 1 | 2) {
  vi.useFakeTimers(); let now = 0; let finishLoad!: () => void;
  const loadGate = new Promise<void>(resolve => { finishLoad = resolve; });
  const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, '../resources/characters/default/compiled/manifest.json'), 'utf8')));
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }),
    requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now, random: () => 0 });
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'cold',
    initialSettings: { movementMode: mode, proactivityMode: 'passive' }, saveMovementMode: async () => undefined });
  const scheduler = new CharacterProactivityScheduler({ director, now: () => now, random: () => 0 });
  let listener: (event: CharacterMotionEvent) => void = () => undefined;
  const feedback: Array<{ at: number; status: string; actionId: string }> = [];
  const events: Array<{ at: number; stateId: string; token: string }> = [];
  service.subscribe(event => { if (event.type === 'behavior-action') events.push({ at: now, stateId: event.stateId, token: event.playbackToken }); listener(event); });
  const api = { getCharacterRuntimeSnapshot: async () => ({ activeCharacterId: manifest.id, manifest: createCharacterPlaybackView(manifest, manifest.defaultSkinId) }),
    subscribeCharacterEvents: () => () => undefined, getCharacterMotionSnapshot: async () => motion.getSnapshot(),
    subscribeCharacterMotion: (next: typeof listener) => { listener = next; return () => { listener = () => undefined; }; },
    reportCharacterActionFeedback: async (input: { playbackToken: string; actionId: string; status: 'started' | 'completed' | 'failed' | 'interrupted' }) => {
      feedback.push({ at: now, status: input.status, actionId: input.actionId });
      director.applyPlaybackFeedback({ ...input, occurredAtMs: now });
    } } as unknown as MyselfApi;
  const player = { load: vi.fn(() => loadGate), play: vi.fn(() => 1), stopPlayback: vi.fn(), setDirection: vi.fn(), getAnchor: () => null,
    hitTest: () => false, subscribeHitRegion: () => () => undefined, destroy: vi.fn() };
  const view = render(<CharacterPlayer stateId="idle" motionMode="animated" api={api} createPlayer={async () => player}
    loadBundle={async () => ({ characterId: manifest.id, atlasUrls: new Map() })} />);
  await act(async () => { await service.initialize(); });
  return { director, service, scheduler, motion, feedback, events, player,
    start: () => { scheduler.start(); expect(director.applyBehaviorBindings({ bindings, context: director.captureExpressionContext()!, lifecycle: director.getBehaviorLifecycleGeneration() })).toBe(true); },
    time: async (value: number) => { const delta = value - now; now = value; await act(async () => { director.advance(); await vi.advanceTimersByTimeAsync(delta); }); },
    loaded: async () => { await act(async () => { finishLoad(); }); },
    close: async () => { await scheduler.close(); view.unmount(); await director.close(); } };
}

test('mode1在Renderer首次合法画面前不消耗移动失败重试，资源就绪后无需用户重试便自动移动', async () => {
  const f = await fixture(1);
  try {
    await act(async () => f.start());
    expect(f.feedback.some(event => event.status === 'started')).toBe(false);
    expect(f.director.getChatContext().bindings).toEqual(bindings);
    expect(f.events.every(event => event.stateId === 'idle')).toBe(true);
    await f.time(2000);
    await f.loaded();
    expect(f.feedback.some(event => event.status === 'started' && event.actionId === 'idle-action')).toBe(true);
    expect(f.service.snapshot()?.schedule.current?.startedAtMs).toBe(2000);
    await f.time(2500);
    expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

test('mode2承受相同两秒Renderer加载延迟后，首个间歇到期仍能正常移动', async () => {
  const f = await fixture(2);
  try {
    await act(async () => f.start()); await f.time(2000); await f.loaded();
    expect(f.service.snapshot()?.schedule.current?.startedAtMs).toBe(2000);
    await f.time(12_000);
    expect(f.feedback.some(event => event.status === 'started' && event.actionId === 'state-action')).toBe(true);
    expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

test.each([1, 2] as const)('mode%s资源先于自动首段就绪时，真实Renderer反馈能放行移动', async mode => {
  const f = await fixture(mode);
  try {
    await f.loaded(); await act(async () => f.start());
    if (mode === 2) await f.time(12_000);
    expect(f.feedback.some(event => event.status === 'started' && event.actionId === 'state-action')).toBe(true);
    expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
