import { describe, expect, test, vi } from 'vitest';
import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type { AgentService } from '../src/main/agent/agent-service';
import { FileTaskAdapter } from '../src/main/conversation/file-task-adapter';

type AgentDouble = {
  submitFileTask: ReturnType<typeof vi.fn>;
  cancelActive: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  cancelAction: ReturnType<typeof vi.fn>;
  onPlaybackStarted: ReturnType<typeof vi.fn>;
  onPlaybackTerminal: ReturnType<typeof vi.fn>;
  onCommitFrame: ReturnType<typeof vi.fn>;
  advanceFileTaskTransaction: ReturnType<typeof vi.fn>;
  invalidateFileTaskPlaybackGrant: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAgentDouble(
  submitFileTask: (input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
  }) => Promise<void> = async () => undefined
): AgentDouble {
  return {
    submitFileTask: vi.fn(submitFileTask),
    cancelActive: vi.fn(),
    confirm: vi.fn(async () => undefined),
    cancelAction: vi.fn(),
    onPlaybackStarted: vi.fn(() => true),
    onPlaybackTerminal: vi.fn(() => true),
    onCommitFrame: vi.fn(() => true),
    advanceFileTaskTransaction: vi.fn(() => true),
    invalidateFileTaskPlaybackGrant: vi.fn(() => true),
    close: vi.fn()
  };
}

function asAgentService(agent: AgentDouble): AgentService {
  return agent as unknown as AgentService;
}

describe('FileTaskAdapter', () => {
  test('没有授权根时抛出稳定错误且不创建 Agent', async () => {
    const createAgentService = vi.fn();
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => null),
      createAgentService
    });

    await expect(adapter.submit({
      text: '列出桌面文件',
      visibleHistory: [],
      generation: 'g1'
    })).rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(createAgentService).not.toHaveBeenCalled();
  });

  test('只透传获准可见历史，并给 Agent 事件绑定当前 generation', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(async () => {
      emitAgentEvent({ type: 'phase', phase: 'thinking' });
      emitAgentEvent({ type: 'message', role: 'assistant', text: '目录为空' });
      emitAgentEvent({ type: 'phase', phase: 'success' });
    });
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: emit => {
        emitAgentEvent = emit;
        return asAgentService(agent);
      }
    });
    const visibleHistory = Object.freeze([
      { role: 'user', content: '只允许披露的历史' },
      { role: 'assistant', content: '公开答复' }
    ]) satisfies readonly ModelMessage[];
    const received: Array<{ event: TaskEvent; generation: string }> = [];
    adapter.onEvent((event, generation) => received.push({ event, generation }));

    await adapter.submit({
      text: '列出目录',
      visibleHistory,
      generation: 'g-visible'
    });

    expect(agent.submitFileTask).toHaveBeenCalledExactlyOnceWith({
      text: '列出目录',
      visibleHistory
    });
    expect(received).toEqual([
      { event: { type: 'phase', phase: 'thinking' }, generation: 'g-visible' },
      {
        event: { type: 'message', role: 'assistant', text: '目录为空' },
        generation: 'g-visible'
      },
      { event: { type: 'phase', phase: 'success' }, generation: 'g-visible' }
    ]);
    expect(JSON.stringify(agent.submitFileTask.mock.calls)).not.toContain('任务私有数据');

    emitAgentEvent({ type: 'message', role: 'assistant', text: '迟到事件' });
    expect(received).toHaveLength(3);
  });

  test('预检后授权被撤销时由真实会话二次检查拒绝且不遗留活动代次', async () => {
    const roots: Array<string | null> = ['D:\\authorized', null];
    const getAuthorizedRootPath = vi.fn(async () => roots.shift() ?? null);
    const agent = createAgentDouble(async () => {
      if (await getAuthorizedRootPath() === null) {
        throw codedError('FILE_AUTHORIZATION_REQUIRED');
      }
    });
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath,
      createAgentService: () => asAgentService(agent)
    });

    await expect(adapter.submit({
      text: '读取文件',
      visibleHistory: [],
      generation: 'g-revoked'
    })).rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(getAuthorizedRootPath).toHaveBeenCalledTimes(2);
    expect(agent.submitFileTask).toHaveBeenCalledOnce();
  });

  test('文件数据类别拒绝原样失败关闭并允许后续新任务', async () => {
    let attempt = 0;
    const agent = createAgentDouble(async () => {
      attempt += 1;
      if (attempt === 1) throw codedError('FILE_DISCLOSURE_DENIED');
    });
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: () => asAgentService(agent)
    });

    await expect(adapter.submit({
      text: '读取私有文件',
      visibleHistory: [],
      generation: 'g-denied'
    })).rejects.toMatchObject({ code: 'FILE_DISCLOSURE_DENIED' });
    await expect(adapter.submit({
      text: '列出公开目录',
      visibleHistory: [],
      generation: 'g-next'
    })).resolves.toBeUndefined();

    expect(agent.submitFileTask).toHaveBeenCalledTimes(2);
  });

  test('活动任务拒绝并发，reset 清理 Agent、订阅和迟到事件', async () => {
    const pending = deferred();
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(() => pending.promise);
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: emit => {
        emitAgentEvent = emit;
        return asAgentService(agent);
      }
    });
    const listener = vi.fn();
    adapter.onEvent(listener);

    const first = adapter.submit({ text: '第一个任务', visibleHistory: [], generation: 'g1' });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());
    await expect(adapter.submit({
      text: '并发任务',
      visibleHistory: [],
      generation: 'g2'
    })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });

    await adapter.resetForNewConversation();
    expect(agent.cancelActive).toHaveBeenCalledOnce();
    expect(agent.close).toHaveBeenCalledOnce();
    emitAgentEvent({ type: 'phase', phase: 'success' });
    expect(listener).not.toHaveBeenCalled();

    pending.resolve();
    await first;
  });

  test('取消后仍等待旧提交收敛，防止旧 Agent 事件被标成新 generation', async () => {
    const pending = deferred();
    let attempts = 0;
    const agent = createAgentDouble(async () => {
      attempts += 1;
      if (attempts === 1) await pending.promise;
    });
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: () => asAgentService(agent)
    });

    const first = adapter.submit({ text: '旧任务', visibleHistory: [], generation: 'g-old' });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());
    adapter.cancelActive();

    await expect(adapter.submit({
      text: '过早的新任务',
      visibleHistory: [],
      generation: 'g-too-early'
    })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });

    pending.resolve();
    await first;
    await expect(adapter.submit({
      text: '已隔离的新任务',
      visibleHistory: [],
      generation: 'g-new'
    })).resolves.toBeUndefined();
  });

  test('确认、取消和动画授权反馈只转交给当前 Adapter 持有的 Agent', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(async () => {
      emitAgentEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: emit => {
        emitAgentEvent = emit;
        return asAgentService(agent);
      }
    });
    await adapter.submit({ text: '删除文件', visibleHistory: [], generation: 'g-action' });

    expect(adapter.onPlaybackStarted('token', 'action')).toBe(true);
    expect(adapter.onPlaybackTerminal('token', 'action', 'completed')).toBe(true);
    expect(adapter.onCommitFrame('token', 'action', 'frame')).toBe(true);
    expect(adapter.advanceFileTaskTransaction()).toBe(true);
    expect(adapter.invalidateFileTaskPlaybackGrant()).toBe(true);
    await adapter.resolveAction('pending-action', 'confirm');
    await adapter.submit({ text: '取消删除', visibleHistory: [], generation: 'g-cancel' });
    await adapter.resolveAction('cancel-action', 'cancel');

    expect(agent.onPlaybackStarted).toHaveBeenCalledExactlyOnceWith('token', 'action');
    expect(agent.onPlaybackTerminal).toHaveBeenCalledExactlyOnceWith(
      'token',
      'action',
      'completed'
    );
    expect(agent.onCommitFrame).toHaveBeenCalledExactlyOnceWith('token', 'action', 'frame');
    expect(agent.advanceFileTaskTransaction).toHaveBeenCalledOnce();
    expect(agent.invalidateFileTaskPlaybackGrant).toHaveBeenCalledOnce();
    expect(agent.confirm).toHaveBeenCalledExactlyOnceWith('pending-action');
    expect(agent.cancelAction).toHaveBeenCalledExactlyOnceWith('cancel-action');
  });

  test('close 后拒绝新任务并隔离旧 Agent 事件', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble();
    const adapter = new FileTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentService: emit => {
        emitAgentEvent = emit;
        return asAgentService(agent);
      }
    });
    const listener = vi.fn();
    adapter.onEvent(listener);
    await adapter.submit({ text: '先运行一次', visibleHistory: [], generation: 'g1' });

    adapter.close();
    emitAgentEvent({ type: 'phase', phase: 'thinking' });

    expect(agent.close).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    await expect(adapter.submit({
      text: '关闭后任务',
      visibleHistory: [],
      generation: 'g2'
    })).rejects.toMatchObject({ code: 'CONVERSATION_CLOSED' });
  });
});
