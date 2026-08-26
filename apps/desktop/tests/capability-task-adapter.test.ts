import { describe, expect, test, vi } from 'vitest';
import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type { AgentService } from '../src/main/agent/agent-service';
import { CapabilityTaskAdapter } from '../src/main/conversation/capability-task-adapter';

type AgentDouble = {
  submitFileTask: ReturnType<typeof vi.fn>;
  cancelActive: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  cancelAction: ReturnType<typeof vi.fn>;
  resetForNewConversation: ReturnType<typeof vi.fn>;
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

/** 排空本用例内已知的短 Promise 链，不使用墙钟等待制造竞态。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
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
    resetForNewConversation: vi.fn(async () => undefined),
    close: vi.fn()
  };
}

function asAgentService(agent: AgentDouble): AgentService {
  return agent as unknown as AgentService;
}

type 类型完全一致<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;
type 断言类型<Condition extends true> = Condition;

/** 编译期契约：准备与提交参数必须精确携带任务类型。 */
type 准备参数契约 = 断言类型<类型完全一致<
  Parameters<CapabilityTaskAdapter['prepareTarget']>[0],
  { generation: string; taskKind: 'file' | 'powershell' }
>>;
type 提交参数契约 = 断言类型<类型完全一致<
  Parameters<CapabilityTaskAdapter['submit']>[0],
  {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: 'file' | 'powershell';
    planningHint?: import('@myself/agent-core').FilePlanningHint;
  }
>>;

void (null as unknown as 准备参数契约);
void (null as unknown as 提交参数契约);

function preparedAgent(
  agent: AgentDouble,
  target: {
    profileId: string;
    providerIdentity: string;
    providerName: string;
    capabilityRevision: string;
  } = {
    profileId: 'profile-agent',
    providerIdentity: 'openai',
    providerName: 'OpenAI Agent',
    capabilityRevision: 'revision-agent'
  }
) {
  return { service: asAgentService(agent), ...target };
}

async function submitPrepared(
  adapter: CapabilityTaskAdapter,
  input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: 'file' | 'powershell';
  }
): Promise<void> {
  await adapter.prepareTarget({ generation: input.generation, taskKind: input.taskKind });
  await adapter.submit(input);
}

describe('CapabilityTaskAdapter', () => {
  test('能力快照不创建 Agent，只有显式激活后才构造执行端口', async () => {
    const agent = createAgentDouble();
    const target = preparedAgent(agent);
    const createAgentTarget = vi.fn(() => target);
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createTargetSnapshot: vi.fn(() => {
        const { service: _service, ...snapshot } = target;
        return snapshot;
      }),
      createAgentTarget
    });

    const snapshot = await adapter.prepareSnapshot({ generation: 'g1', taskKind: 'file' });
    expect(createAgentTarget).not.toHaveBeenCalled();

    await adapter.activateTarget({ generation: 'g1', taskKind: 'file', target: snapshot });
    expect(createAgentTarget).toHaveBeenCalledOnce();
  });

  test('没有授权根时抛出稳定错误且不创建 Agent', async () => {
    const createAgentTarget = vi.fn();
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => null),
      createAgentTarget
    });

    await expect(adapter.prepareTarget({ generation: 'g1', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(createAgentTarget).not.toHaveBeenCalled();
  });

  test('取消进行中的目标准备会立即释放 owner，旧授权返回后不得覆盖新目标', async () => {
    const authorization = deferred();
    let authorizationCalls = 0;
    const agent = createAgentDouble();
    const createAgentTarget = vi.fn(() => preparedAgent(agent));
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) await authorization.promise;
        return 'D:\\authorized';
      }),
      createAgentTarget
    });
    const oldPrepare = adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    await vi.waitFor(() => expect(authorizationCalls).toBe(1));

    adapter.cancelActive();
    await expect(adapter.prepareTarget({ generation: 'g-new', taskKind: 'file' })).resolves.toMatchObject({
      profileId: 'profile-agent'
    });

    authorization.resolve();
    await expect(oldPrepare).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await expect(adapter.submit({
      text: '读取 new.txt',
      visibleHistory: [],
      generation: 'g-new',
      taskKind: 'file'
    })).resolves.toBeUndefined();
    expect(createAgentTarget).toHaveBeenCalledOnce();
  });

  test('取消旧 Agent 清理中的准备会释放 owner，但下一准备仍等待清理屏障', async () => {
    const cleanup = deferred();
    const oldAgent = createAgentDouble();
    oldAgent.resetForNewConversation.mockImplementation(() => cleanup.promise);
    const newAgent = createAgentDouble();
    const agents = [oldAgent, newAgent];
    const createAgentTarget = vi.fn(() => preparedAgent(agents.shift()!));
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget
    });
    await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    adapter.cancelActive();

    const replacing = adapter.prepareTarget({ generation: 'g-replacing', taskKind: 'file' });
    await vi.waitFor(() => expect(oldAgent.resetForNewConversation).toHaveBeenCalledOnce());
    adapter.cancelActive();
    let nextSettled = false;
    const next = adapter.prepareTarget({ generation: 'g-new', taskKind: 'file' }).then(target => {
      nextSettled = true;
      return target;
    });
    await flushMicrotasks();
    const settledBeforeCleanup = nextSettled;

    cleanup.resolve();
    await expect(replacing).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await expect(next).resolves.toMatchObject({ profileId: 'profile-agent' });

    expect(settledBeforeCleanup).toBe(false);
    expect(oldAgent.close).toHaveBeenCalledOnce();
    expect(createAgentTarget).toHaveBeenCalledTimes(2);
  });

  test.each(['reset', 'close'] as const)(
    '%s 会等待准备阶段已开始的旧 Agent 清理并完成 reset/close',
    async action => {
      const cleanup = deferred();
      const oldAgent = createAgentDouble();
      oldAgent.resetForNewConversation.mockImplementation(() => cleanup.promise);
      const adapter = new CapabilityTaskAdapter({
        getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
        createAgentTarget: () => preparedAgent(oldAgent)
      });
      await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
      adapter.cancelActive();
      const replacing = adapter.prepareTarget({ generation: 'g-replacing', taskKind: 'file' });
      await vi.waitFor(() => expect(oldAgent.resetForNewConversation).toHaveBeenCalledOnce());

      let lifecycleSettled = false;
      const lifecycle = (action === 'reset'
        ? adapter.resetForNewConversation()
        : adapter.close()).then(() => {
          lifecycleSettled = true;
        });
      await flushMicrotasks();
      const settledBeforeCleanup = lifecycleSettled;

      cleanup.resolve();
      const replacementError = await replacing.catch(error => error);
      await lifecycle;

      expect(settledBeforeCleanup).toBe(false);
      expect(replacementError).toMatchObject({
        code: action === 'reset' ? 'TASK_CANCELLED' : 'CONVERSATION_CLOSED'
      });
      expect(oldAgent.resetForNewConversation).toHaveBeenCalledOnce();
      expect(oldAgent.close).toHaveBeenCalledOnce();
    }
  );

  test('只透传获准可见历史，并给 Agent 事件绑定当前 generation', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(async () => {
      emitAgentEvent({ type: 'phase', phase: 'thinking' });
      emitAgentEvent({ type: 'message', role: 'assistant', text: '目录为空' });
      emitAgentEvent({ type: 'phase', phase: 'success' });
    });
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: ({ emit }) => {
        emitAgentEvent = emit;
        return preparedAgent(agent);
      }
    });
    const visibleHistory = Object.freeze([
      { role: 'user', content: '只允许披露的历史' },
      { role: 'assistant', content: '公开答复' }
    ]) satisfies readonly ModelMessage[];
    const received: Array<{ event: TaskEvent; generation: string }> = [];
    adapter.onEvent((event, generation) => received.push({ event, generation }));

    await submitPrepared(adapter, {
      text: '列出目录',
      visibleHistory,
      generation: 'g-visible',
      taskKind: 'file'
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
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath,
      createAgentTarget: () => preparedAgent(agent)
    });

    await adapter.prepareTarget({ generation: 'g-revoked', taskKind: 'file' });
    await expect(adapter.submit({
      text: '读取文件',
      visibleHistory: [],
      generation: 'g-revoked',
      taskKind: 'file'
    })).rejects.toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(getAuthorizedRootPath).toHaveBeenCalledTimes(2);
    expect(agent.submitFileTask).not.toHaveBeenCalled();
  });

  test('文件数据类别拒绝原样失败关闭并允许后续新任务', async () => {
    let attempt = 0;
    const agent = createAgentDouble(async () => {
      attempt += 1;
      if (attempt === 1) throw codedError('FILE_DISCLOSURE_DENIED');
    });
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => preparedAgent(agent)
    });

    await adapter.prepareTarget({ generation: 'g-denied', taskKind: 'file' });
    await expect(adapter.submit({
      text: '读取私有文件',
      visibleHistory: [],
      generation: 'g-denied',
      taskKind: 'file'
    })).rejects.toMatchObject({ code: 'FILE_DISCLOSURE_DENIED' });
    await expect(submitPrepared(adapter, {
      text: '列出公开目录',
      visibleHistory: [],
      generation: 'g-next',
      taskKind: 'file'
    })).resolves.toBeUndefined();

    expect(agent.submitFileTask).toHaveBeenCalledTimes(2);
  });

  test('活动任务拒绝并发，reset 清理 Agent、订阅和迟到事件', async () => {
    const pending = deferred();
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(() => pending.promise);
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: ({ emit }) => {
        emitAgentEvent = emit;
        return preparedAgent(agent);
      }
    });
    const listener = vi.fn();
    adapter.onEvent(listener);

    await adapter.prepareTarget({ generation: 'g1', taskKind: 'file' });
    const first = adapter.submit({
      text: '第一个任务',
      visibleHistory: [],
      generation: 'g1',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());
    await expect(adapter.prepareTarget({ generation: 'g2', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });

    await adapter.resetForNewConversation();
    expect(agent.resetForNewConversation).toHaveBeenCalledOnce();
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
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => preparedAgent(agent)
    });

    await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    const first = adapter.submit({
      text: '旧任务',
      visibleHistory: [],
      generation: 'g-old',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());
    adapter.cancelActive();

    await expect(adapter.prepareTarget({ generation: 'g-too-early', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });

    pending.resolve();
    await first;
    await expect(submitPrepared(adapter, {
      text: '已隔离的新任务',
      visibleHistory: [],
      generation: 'g-new',
      taskKind: 'file'
    })).resolves.toBeUndefined();
  });

  test('确认进行中取消只清活动代次，旧确认收敛前拒绝新提交', async () => {
    const confirmation = deferred();
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(async () => {
      emitAgentEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    agent.confirm.mockImplementation(() => confirmation.promise);
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: ({ emit }) => {
        emitAgentEvent = emit;
        return preparedAgent(agent);
      }
    });
    const listener = vi.fn();
    adapter.onEvent(listener);
    await submitPrepared(adapter, {
      text: '等待确认',
      visibleHistory: [],
      generation: 'g-confirm',
      taskKind: 'file'
    });

    const confirming = adapter.resolveAction('pending-action', 'confirm');
    await vi.waitFor(() => expect(agent.confirm).toHaveBeenCalledOnce());
    adapter.cancelActive();
    emitAgentEvent({ type: 'phase', phase: 'cancelled' });

    await expect(adapter.prepareTarget({ generation: 'g-too-early', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    expect(listener).not.toHaveBeenCalledWith(
      { type: 'phase', phase: 'cancelled' },
      'g-too-early'
    );

    confirmation.resolve();
    await confirming;
    await expect(submitPrepared(adapter, {
      text: '确认收敛后的任务',
      visibleHistory: [],
      generation: 'g-after-confirm',
      taskKind: 'file'
    })).resolves.toBeUndefined();
  });

  test('确认与取消只转交给当前 Adapter 持有的 Agent', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble(async () => {
      emitAgentEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: ({ emit }) => {
        emitAgentEvent = emit;
        return preparedAgent(agent);
      }
    });
    await submitPrepared(adapter, {
      text: '删除文件',
      visibleHistory: [],
      generation: 'g-action',
      taskKind: 'file'
    });

    await adapter.resolveAction('pending-action', 'confirm');
    await submitPrepared(adapter, {
      text: '取消删除',
      visibleHistory: [],
      generation: 'g-cancel',
      taskKind: 'file'
    });
    await adapter.resolveAction('cancel-action', 'cancel');

    expect(agent.confirm).toHaveBeenCalledExactlyOnceWith('pending-action');
    expect(agent.cancelAction).toHaveBeenCalledExactlyOnceWith('cancel-action');
  });

  test('工厂同步 reset 后不安装或提交刚创建的 Agent，且清理异常不覆盖主错误', async () => {
    const agent = createAgentDouble();
    agent.cancelActive.mockImplementation(() => {
      throw new Error('cancel cleanup failed');
    });
    agent.close.mockImplementation(() => {
      throw new Error('close cleanup failed');
    });
    let adapter!: CapabilityTaskAdapter;
    adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => {
        void adapter.resetForNewConversation();
        return preparedAgent(agent);
      }
    });

    await expect(adapter.prepareTarget({ generation: 'g-reset', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'TASK_CANCELLED' });

    expect(agent.submitFileTask).not.toHaveBeenCalled();
    expect(agent.cancelActive).toHaveBeenCalledOnce();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  test('工厂同步 close 后不安装或提交刚创建的 Agent', async () => {
    const agent = createAgentDouble();
    let adapter!: CapabilityTaskAdapter;
    adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => {
        adapter.close();
        return preparedAgent(agent);
      }
    });

    await expect(adapter.prepareTarget({ generation: 'g-close', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'CONVERSATION_CLOSED' });

    expect(agent.submitFileTask).not.toHaveBeenCalled();
    expect(agent.cancelActive).toHaveBeenCalledOnce();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  test('close 后拒绝新任务并隔离旧 Agent 事件', async () => {
    let emitAgentEvent!: (event: TaskEvent) => void;
    const agent = createAgentDouble();
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: ({ emit }) => {
        emitAgentEvent = emit;
        return preparedAgent(agent);
      }
    });
    const listener = vi.fn();
    adapter.onEvent(listener);
    await submitPrepared(adapter, {
      text: '先运行一次',
      visibleHistory: [],
      generation: 'g1',
      taskKind: 'file'
    });

    await adapter.close();
    emitAgentEvent({ type: 'phase', phase: 'thinking' });

    expect(agent.close).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    await expect(adapter.submit({
      text: '关闭后任务',
      visibleHistory: [],
      generation: 'g2',
      taskKind: 'file'
    })).rejects.toMatchObject({ code: 'CONVERSATION_CLOSED' });
  });

  test('close 先等待 Agent 不可逆执行屏障，再关闭实例且并发调用保持幂等', async () => {
    const barrier = deferred();
    const agent = createAgentDouble();
    agent.resetForNewConversation.mockImplementation(() => barrier.promise);
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => preparedAgent(agent)
    });
    await adapter.prepareTarget({ generation: 'g-irreversible', taskKind: 'file' });
    let settled = false;

    const first = adapter.close().then(() => { settled = true; });
    const second = adapter.close();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(agent.resetForNewConversation).toHaveBeenCalledOnce();
    expect(agent.close).not.toHaveBeenCalled();
    barrier.resolve();
    await Promise.all([first, second]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  test('close 不等待仅悬挂的可撤销 Provider 请求', async () => {
    const provider = deferred();
    const agent = createAgentDouble(() => provider.promise);
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: () => preparedAgent(agent)
    });
    await adapter.prepareTarget({ generation: 'g-provider', taskKind: 'file' });
    const submission = adapter.submit({
      text: '悬挂请求',
      visibleHistory: [],
      generation: 'g-provider',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());

    await expect(adapter.close()).resolves.toBeUndefined();
    provider.resolve();
    await submission;
  });

  test('准备目标时原子绑定 Agent 快照，提交前设置变化不能替换已披露目标', async () => {
    const agentA = createAgentDouble();
    const agentB = createAgentDouble();
    const targets = [
      preparedAgent(agentA, {
        profileId: 'profile-a',
        providerIdentity: 'provider-a',
        providerName: 'Provider A',
        capabilityRevision: 'revision-a'
      }),
      preparedAgent(agentB, {
        profileId: 'profile-b',
        providerIdentity: 'provider-b',
        providerName: 'Provider B',
        capabilityRevision: 'revision-b'
      })
    ];
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: vi.fn(() => targets.shift()!)
    } as never);

    const target = await adapter.prepareTarget({ generation: 'g-bound', taskKind: 'file' });
    await adapter.submit({
      text: '整理文件',
      visibleHistory: [],
      generation: 'g-bound',
      taskKind: 'file'
    });

    expect(target).toEqual({
      profileId: 'profile-a',
      providerIdentity: 'provider-a',
      providerName: 'Provider A',
      capabilityRevision: 'revision-a'
    });
    expect(agentA.submitFileTask).toHaveBeenCalledOnce();
    expect(agentB.submitFileTask).not.toHaveBeenCalled();
  });

  test('reset 立即隔离旧 Agent、等待其收敛，并保留长期订阅供新会话复用', async () => {
    const oldReset = deferred();
    let oldEmit!: (event: TaskEvent) => void;
    let newEmit!: (event: TaskEvent) => void;
    const oldAgent = createAgentDouble();
    oldAgent.resetForNewConversation.mockImplementation(() => oldReset.promise);
    const newAgent = createAgentDouble(async () => {
      newEmit({ type: 'message', role: 'assistant', text: '新会话事件' });
      newEmit({ type: 'phase', phase: 'success' });
    });
    let created = 0;
    const adapter = new CapabilityTaskAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createAgentTarget: vi.fn(({ emit }: { emit: (event: TaskEvent) => void }) => {
        created += 1;
        if (created === 1) {
          oldEmit = emit;
          return preparedAgent(oldAgent);
        }
        newEmit = emit;
        return preparedAgent(newAgent);
      })
    } as never);
    const listener = vi.fn();
    adapter.onEvent(listener);
    await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });

    const resetting = adapter.resetForNewConversation();
    oldEmit({ type: 'message', role: 'assistant', text: '旧会话事件' });
    await expect(adapter.prepareTarget({ generation: 'g-too-early', taskKind: 'file' }))
      .rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    oldReset.resolve();
    await resetting;

    await adapter.prepareTarget({ generation: 'g-new', taskKind: 'file' });
    await adapter.submit({
      text: '新任务',
      visibleHistory: [],
      generation: 'g-new',
      taskKind: 'file'
    });

    expect(listener).not.toHaveBeenCalledWith(
      { type: 'message', role: 'assistant', text: '旧会话事件' },
      'g-old'
    );
    expect(listener).toHaveBeenCalledWith(
      { type: 'message', role: 'assistant', text: '新会话事件' },
      'g-new'
    );
    expect(oldAgent.resetForNewConversation).toHaveBeenCalledOnce();
    expect(oldAgent.close).toHaveBeenCalledOnce();
  });
});
