import { describe, expect, test, vi } from 'vitest';
import type { VerifiedWriteAction } from '@myself/file-tools';
import {
  FileTaskTransactionCoordinator,
  type FileTaskPlaybackGrant,
  type FileTaskResult
} from '../src/main/agent/file-task-transaction-coordinator';

function verifiedAction(id = 'verified-action-1'): VerifiedWriteAction {
  return Object.freeze({
    operation: 'delete_file' as const,
    authorizationGeneration: 0,
    targetRelativePath: 'private/secret.txt',
    targetType: 'file' as const
  });
}

function playbackGrant(overrides: Partial<FileTaskPlaybackGrant> = {}): FileTaskPlaybackGrant {
  return {
    playbackToken: 'playback-token-1',
    actionId: 'carry-action',
    commitFrameId: 'commit-frame',
    ...overrides
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFixture(overrides: {
  now?: () => number;
  execute?: (action: VerifiedWriteAction) => Promise<void>;
  playbackStartTimeoutMs?: number;
  commitTimeoutMs?: number;
} = {}) {
  const results: FileTaskResult[] = [];
  const execute = vi.fn(overrides.execute ?? (async () => undefined));
  const coordinator = new FileTaskTransactionCoordinator({
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.playbackStartTimeoutMs === undefined
      ? {}
      : { playbackStartTimeoutMs: overrides.playbackStartTimeoutMs }),
    ...(overrides.commitTimeoutMs === undefined
      ? {}
      : { commitTimeoutMs: overrides.commitTimeoutMs }),
    execute,
    reportResult: result => results.push(result)
  });
  return { coordinator, execute, results };
}

async function flushExecution(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('FileTaskTransactionCoordinator', () => {
  test('精确播放和提交帧只执行一次，并以真实执行结果成功收敛', async () => {
    const execution = deferred();
    const { coordinator, execute, results } = createFixture({ execute: () => execution.promise });
    const action = verifiedAction();
    const grant = playbackGrant();

    coordinator.begin(action, grant);
    expect(coordinator.snapshot()).toEqual({ state: 'waiting-playback', result: null });
    expect(coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId)).toBe(true);
    expect(coordinator.snapshot().state).toBe('waiting-commit');
    expect(coordinator.onCommitFrame(grant.playbackToken, grant.actionId, grant.commitFrameId!)).toBe(true);
    expect(coordinator.onCommitFrame(grant.playbackToken, grant.actionId, grant.commitFrameId!)).toBe(false);
    expect(coordinator.snapshot().state).toBe('executing');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(action);

    execution.resolve();
    await flushExecution();
    expect(coordinator.snapshot()).toEqual({ state: 'succeeded', result: { status: 'succeeded' } });
    expect(results).toEqual([{ status: 'succeeded' }]);
  });

  test('缺少提交帧时仅由匹配的 started 合成提交', async () => {
    const { coordinator, execute } = createFixture();
    const grant = playbackGrant({ commitFrameId: null });
    coordinator.begin(verifiedAction(), grant);

    expect(coordinator.onCommitFrame(grant.playbackToken, grant.actionId, 'any-frame')).toBe(false);
    expect(coordinator.onPlaybackStarted('forged-token', grant.actionId)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    await flushExecution();
    expect(coordinator.snapshot().state).toBe('succeeded');
  });

  test('伪造、重复和乱序反馈被稳定拒绝且不改变状态', () => {
    const { coordinator, execute } = createFixture();
    const grant = playbackGrant();
    coordinator.begin(verifiedAction(), grant);

    expect(coordinator.onCommitFrame(grant.playbackToken, grant.actionId, grant.commitFrameId!)).toBe(false);
    expect(coordinator.onPlaybackStarted('forged-token', grant.actionId)).toBe(false);
    expect(coordinator.onPlaybackStarted(grant.playbackToken, 'wrong-action')).toBe(false);
    expect(coordinator.snapshot().state).toBe('waiting-playback');
    expect(coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId)).toBe(true);
    expect(coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId)).toBe(false);
    expect(coordinator.onCommitFrame('forged-token', grant.actionId, grant.commitFrameId!)).toBe(false);
    expect(coordinator.onCommitFrame(grant.playbackToken, 'wrong-action', grant.commitFrameId!)).toBe(false);
    expect(coordinator.onCommitFrame(grant.playbackToken, grant.actionId, 'wrong-frame')).toBe(false);
    expect(coordinator.snapshot().state).toBe('waiting-commit');
    expect(execute).not.toHaveBeenCalled();
  });

  test.each(['completed', 'interrupted', 'failed', 'cancelled'] as const)(
    '提交前收到 %s 终态会取消且不执行',
    terminal => {
      const { coordinator, execute, results } = createFixture();
      const grant = playbackGrant();
      coordinator.begin(verifiedAction(), grant);
      expect(coordinator.onPlaybackTerminal(grant.playbackToken, grant.actionId, terminal)).toBe(true);
      expect(coordinator.snapshot().state).toBe('cancelled');
      expect(execute).not.toHaveBeenCalled();
      expect(results).toEqual([{ status: 'cancelled', reason: `playback_${terminal}` }]);
    }
  );

  test('提交后表现中断不伪造回滚，执行结果仍真实收敛', async () => {
    const execution = deferred();
    const { coordinator, results } = createFixture({ execute: () => execution.promise });
    const grant = playbackGrant({ commitFrameId: null });
    coordinator.begin(verifiedAction(), grant);
    coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId);

    expect(coordinator.onPlaybackTerminal(grant.playbackToken, grant.actionId, 'interrupted')).toBe(true);
    expect(coordinator.snapshot().state).toBe('executing');
    expect(results).toEqual([]);
    execution.resolve();
    await flushExecution();
    expect(coordinator.snapshot().state).toBe('succeeded');
    expect(results).toEqual([{ status: 'succeeded' }]);
  });

  test('真实执行失败只报告脱敏失败事实', async () => {
    const { coordinator, results } = createFixture({
      execute: async () => {
        throw new Error('C:\\private\\secret.txt access denied');
      }
    });
    const grant = playbackGrant({ commitFrameId: null });
    coordinator.begin(verifiedAction(), grant);
    coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId);
    await flushExecution();

    expect(coordinator.snapshot()).toEqual({
      state: 'failed',
      result: { status: 'failed', reason: 'execution_failed' }
    });
    expect(JSON.stringify(results)).not.toContain('secret.txt');
  });

  test('取消和关闭仅在提交前生效；执行中关闭仍等待真实结果', async () => {
    const before = createFixture();
    before.coordinator.begin(verifiedAction(), playbackGrant());
    expect(before.coordinator.cancel()).toBe(true);
    expect(before.coordinator.snapshot().state).toBe('cancelled');
    expect(before.execute).not.toHaveBeenCalled();

    const waiting = createFixture();
    waiting.coordinator.begin(verifiedAction(), playbackGrant());
    waiting.coordinator.close();
    expect(waiting.coordinator.snapshot().state).toBe('cancelled');
    expect(() => waiting.coordinator.begin(verifiedAction('second'), playbackGrant())).toThrow('COORDINATOR_CLOSED');

    const execution = deferred();
    const during = createFixture({ execute: () => execution.promise });
    const grant = playbackGrant({ commitFrameId: null });
    during.coordinator.begin(verifiedAction(), grant);
    during.coordinator.onPlaybackStarted(grant.playbackToken, grant.actionId);
    during.coordinator.close();
    expect(during.coordinator.cancel()).toBe(false);
    expect(during.coordinator.snapshot().state).toBe('executing');
    execution.reject(new Error('after close'));
    await flushExecution();
    expect(during.coordinator.snapshot().state).toBe('failed');
  });

  test('启动和提交截止时间由 advance 推进，截止前无副作用', () => {
    let now = 1_000;
    const startup = createFixture({ now: () => now, playbackStartTimeoutMs: 100, commitTimeoutMs: 200 });
    const firstGrant = playbackGrant();
    startup.coordinator.begin(verifiedAction(), firstGrant);
    now = 1_099;
    expect(startup.coordinator.advance()).toBe(false);
    now = 1_100;
    expect(startup.coordinator.advance()).toBe(true);
    expect(startup.coordinator.snapshot().result).toEqual({ status: 'cancelled', reason: 'playback_start_timeout' });
    expect(startup.execute).not.toHaveBeenCalled();

    now = 2_000;
    const commit = createFixture({ now: () => now, playbackStartTimeoutMs: 100, commitTimeoutMs: 200 });
    const secondGrant = playbackGrant();
    commit.coordinator.begin(verifiedAction('second'), secondGrant);
    commit.coordinator.onPlaybackStarted(secondGrant.playbackToken, secondGrant.actionId);
    now = 2_199;
    expect(commit.coordinator.advance()).toBe(false);
    now = 2_200;
    expect(commit.coordinator.advance()).toBe(true);
    expect(commit.coordinator.snapshot().result).toEqual({ status: 'cancelled', reason: 'commit_timeout' });
    expect(commit.execute).not.toHaveBeenCalled();
  });

  test('活动事务拒绝并发 begin，终态后允许开始下一事务', () => {
    const { coordinator } = createFixture();
    coordinator.begin(verifiedAction(), playbackGrant());
    expect(() => coordinator.begin(verifiedAction('second'), playbackGrant())).toThrow('TRANSACTION_ACTIVE');
    coordinator.cancel();
    expect(() => coordinator.begin(verifiedAction('second'), playbackGrant({ playbackToken: 'token-2' }))).not.toThrow();
    expect(coordinator.snapshot().state).toBe('waiting-playback');
  });

  test('公开快照不泄露写动作、绝对路径、播放令牌或提交细节', () => {
    const { coordinator } = createFixture();
    const privateAction = Object.freeze({
      operation: 'delete_file' as const,
      authorizationGeneration: 0,
      targetRelativePath: 'C:\\Users\\private\\secret.txt',
      targetType: 'file' as const
    }) satisfies VerifiedWriteAction;
    coordinator.begin(privateAction, playbackGrant());

    expect(coordinator.snapshot()).toEqual({ state: 'waiting-playback', result: null });
    const serialized = JSON.stringify(coordinator.snapshot());
    expect(serialized).not.toContain('private-id');
    expect(serialized).not.toContain('secret.txt');
    expect(serialized).not.toContain('playback-token');
    expect(serialized).not.toContain('commit-frame');
  });

  test('begin 防御性复制并冻结授权，调用方后续突变不能改写已绑定里程碑', () => {
    const { coordinator, execute } = createFixture();
    const mutableGrant = {
      playbackToken: 'playback-token-1',
      actionId: 'carry-action',
      commitFrameId: 'commit-frame'
    };
    coordinator.begin(verifiedAction(), mutableGrant);

    mutableGrant.playbackToken = 'playback-token-2';
    mutableGrant.actionId = 'other-action';
    mutableGrant.commitFrameId = 'other-frame';

    expect(coordinator.onPlaybackStarted(
      mutableGrant.playbackToken,
      mutableGrant.actionId
    )).toBe(false);
    expect(coordinator.onPlaybackStarted('playback-token-1', 'carry-action')).toBe(true);
    expect(coordinator.onCommitFrame('playback-token-1', 'carry-action', 'other-frame')).toBe(false);
    expect(coordinator.onCommitFrame('playback-token-1', 'carry-action', 'commit-frame')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['', 'carry-action', 'commit-frame'],
    ['UPPERCASE-TOKEN', 'carry-action', 'commit-frame'],
    ['playback-token-1', '', 'commit-frame'],
    ['playback-token-1', '../carry-action', 'commit-frame'],
    ['playback-token-1', 'carry-action', ''],
    ['playback-token-1', 'carry-action', 'bad/frame']
  ])(
    'begin 稳定拒绝非法授权 token=%s action=%s frame=%s 且不改变状态',
    (playbackToken, actionId, commitFrameId) => {
      const { coordinator, execute } = createFixture();

      expect(() => coordinator.begin(verifiedAction(), {
        playbackToken,
        actionId,
        commitFrameId
      })).toThrow('INVALID_PLAYBACK_GRANT');
      expect(coordinator.snapshot()).toEqual({ state: 'idle', result: null });
      expect(execute).not.toHaveBeenCalled();
    }
  );
});
