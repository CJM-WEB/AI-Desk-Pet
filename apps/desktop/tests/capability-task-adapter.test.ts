import { describe, expect, test, vi } from 'vitest';
import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type {
  CodingTaskSubmission,
  CodingTaskToolResult
} from '../src/main/agent/coding-task-service';
import { CapabilityTaskAdapter } from '../src/main/conversation/capability-task-adapter';
import { CodingTaskService } from '../src/main/agent/coding-task-service';
import type { CapabilityTaskServicePort, CapabilityTaskAdapterOptions } from '../src/main/conversation/capability-task-adapter';

type CodingTaskServiceDouble = {
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

function createCodingTaskServiceDouble(
  submitFileTask: (input: CodingTaskSubmission) => Promise<void> = async () => undefined
): CodingTaskServiceDouble {
  return {
    submitFileTask: vi.fn(submitFileTask),
    cancelActive: vi.fn(),
    confirm: vi.fn(async () => undefined),
    cancelAction: vi.fn(),
    resetForNewConversation: vi.fn(async () => undefined),
    close: vi.fn()
  };
}

function asCodingTaskService(agent: CodingTaskServiceDouble): CapabilityTaskServicePort {
  return agent as unknown as CapabilityTaskServicePort;
}

type 类型完全一致<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;
type 断言类型<Condition extends true> = Condition;

/** 编译期契约：准备与提交参数必须精确携带任务类型。 */
type 准备参数契约 = 断言类型<类型完全一致<
  Parameters<CapabilityTaskAdapter['prepareTarget']>[0],
  {
    generation: string;
    taskKind: 'file' | 'powershell';
  }
>>;
type 提交参数契约 = 断言类型<类型完全一致<
  Parameters<CapabilityTaskAdapter['submit']>[0],
  {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: 'file' | 'powershell';
  }
>>;

void (null as unknown as 准备参数契约);
void (null as unknown as 提交参数契约);

function preparedCodingTask(
  agent: CodingTaskServiceDouble,
  target: {
    profileId: string;
    providerIdentity: string;
    providerName: string;
    capabilityRevision: string;
    directory: string; modelId: string; approvedCommands: readonly string[];
  } = {
    profileId: 'profile-agent',
    providerIdentity: 'openai',
    providerName: 'OpenAI Agent',
    capabilityRevision: 'revision-agent', directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: []
  }
) {
  return { service: asCodingTaskService(agent), ...target };
}

const defaultTargetSnapshot = Object.freeze({
  profileId: 'profile-agent',
  providerIdentity: 'openai',
  providerName: 'OpenAI Agent',
  capabilityRevision: 'revision-agent', directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: []
});

/** 测试默认显式提供无 Agent 的能力快照，个别目标绑定用例可覆盖它。 */
function createAdapter(
  options: Omit<CapabilityTaskAdapterOptions, 'createTargetSnapshot'>
    & Partial<Pick<CapabilityTaskAdapterOptions, 'createTargetSnapshot'>>
): CapabilityTaskAdapter {
  return new CapabilityTaskAdapter({
    ...options,
    createTargetSnapshot: options.createTargetSnapshot ?? (() => defaultTargetSnapshot)
  });
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
  test('原核心提交未决时可回复许可，拒绝单次许可后仍接收最终正文', async () => {
    const permissionShown = deferred();
    const permissionReply = deferred();
    const finishRun = deferred();
    let emit!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emit({ type: 'phase', phase: 'awaiting_confirmation' });
      permissionShown.resolve();
      await permissionReply.promise;
      await finishRun.promise;
      emit({ type: 'message', role: 'assistant', text: '本次许可已拒绝，任务总结仍可见' });
      emit({ type: 'phase', phase: 'success' });
    });
    agent.cancelAction.mockImplementation(async () => permissionReply.resolve());
    const adapter = createAdapter({
      getAuthorizedRootPath: async () => 'D:\\authorized',
      createCodingTaskTarget: input => { emit = input.emit; return preparedCodingTask(agent); }
    });
    const events: TaskEvent[] = [];
    adapter.onEvent(event => events.push(event));
    await adapter.prepareTarget({ generation: 'g1', taskKind: 'file' });
    const submission = adapter.submit({ text: '读取文件', visibleHistory: [], generation: 'g1', taskKind: 'file' });
    await permissionShown.promise;
    await expect(adapter.resolveAction('permission-1', 'cancel')).resolves.toBeUndefined();
    await expect(adapter.prepareTarget({ generation: 'g1', taskKind: 'file' })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    finishRun.resolve();
    await submission;
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '本次许可已拒绝，任务总结仍可见' });
    expect(events).toContainEqual({ type: 'phase', phase: 'success' });
  });

  test('取消保持 owner 直到服务清理完成，期间拒绝新任务', async () => {
    const cleanup = deferred();
    let emit!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble();
    agent.cancelActive.mockImplementation(async () => {
      await cleanup.promise;
      emit({ type: 'phase', phase: 'cancelled' });
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: async () => 'D:\\authorized',
      createCodingTaskTarget: input => { emit = input.emit; return preparedCodingTask(agent); }
    });
    await adapter.prepareTarget({ generation: 'g1', taskKind: 'file' });
    const cancelling = adapter.cancelActive();
    await expect(adapter.prepareTarget({ generation: 'g1', taskKind: 'file' })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    cleanup.resolve();
    await cancelling;
    await expect(adapter.prepareTarget({ generation: 'g1', taskKind: 'file' })).resolves.toBeDefined();
  });

  test('私有工具结果只在当前 owner 内绑定 generation 与目标转发并丢弃迟到结果', async () => {
    let emitTrustedToolResult!: (result: CodingTaskToolResult) => void;
    let submissionOwner: symbol | undefined;
    const agent = createCodingTaskServiceDouble(async input => {
      if (input.submissionOwner === undefined) throw new Error('缺少 submission owner');
      submissionOwner = input.submissionOwner;
      emitTrustedToolResult({
        toolName: 'create_file',
        ok: true,
        relativePaths: ['result.txt'],
        submissionOwner: input.submissionOwner
      });
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: async () => 'C:\\workspace',
      createCodingTaskTarget: input => {
        emitTrustedToolResult = input.emitTrustedToolResult;
        return preparedCodingTask(agent);
      }
    });
    const forwarded: Array<{
      result: CodingTaskToolResult;
      generation: string;
      target: Parameters<CapabilityTaskAdapter['activateTarget']>[0]['target'];
    }> = [];
    adapter.onTrustedToolResult((result, generation, target) => {
      forwarded.push({ result, generation, target });
    });

    await submitPrepared(adapter, {
      text: '创建 result.txt',
      visibleHistory: [],
      generation: 'generation-current',
      taskKind: 'file'
    });
    expect(submissionOwner).toBeTypeOf('symbol');
    expect(forwarded).toEqual([{
      result: {
        toolName: 'create_file',
        ok: true,
        relativePaths: ['result.txt'],
        submissionOwner
      },
      generation: 'generation-current',
      target: defaultTargetSnapshot
    }]);

    emitTrustedToolResult({
      toolName: 'create_file',
      ok: true,
      relativePaths: ['late.txt']
    });
    expect(forwarded).toHaveLength(1);
  });

  test('旧 submission abort 后的迟到读取结果不污染同 generation 与 target 的新一轮', async () => {
    const firstSubmission = deferred();
    const secondSubmission = deferred();
    const delayedRead = deferred();
    let emitTrustedToolResult!: (result: CodingTaskToolResult) => void;
    let callCount = 0;
    const agent = createCodingTaskServiceDouble(async input => {
      callCount += 1;
      if (callCount === 1) {
        if (input.submissionOwner === undefined) throw new Error('缺少 submission owner');
        const submissionOwner = input.submissionOwner;
        void delayedRead.promise.then(() => {
          emitTrustedToolResult({
            toolName: 'read_file',
            ok: true,
            relativePaths: ['late.txt'],
            submissionOwner
          });
        });
        await firstSubmission.promise;
        return;
      }
      await secondSubmission.promise;
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: async () => 'C:\\workspace',
      createCodingTaskTarget: input => {
        emitTrustedToolResult = input.emitTrustedToolResult;
        return preparedCodingTask(agent);
      }
    });
    const forwarded: CodingTaskToolResult[] = [];
    adapter.onTrustedToolResult(result => forwarded.push(result));

    const target = await adapter.prepareTarget({ generation: 'g1', taskKind: 'file' });
    const first = adapter.submit({
      text: '读取 late.txt',
      visibleHistory: [],
      generation: 'g1',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledTimes(1));
    await adapter.cancelActive();
    firstSubmission.resolve();
    await first;

    await adapter.prepareTarget({
      generation: 'g1',
      taskKind: 'file'
    });
    const second = adapter.submit({
      text: '读取新文件',
      visibleHistory: [],
      generation: 'g1',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledTimes(2));

    delayedRead.resolve();
    await flushMicrotasks();
    expect(forwarded).toEqual([]);

    secondSubmission.resolve();
    await second;
  });

  test('能力快照不创建 Agent，只有显式激活后才构造执行端口', async () => {
    const agent = createCodingTaskServiceDouble();
    const target = preparedCodingTask(agent);
    const createCodingTaskTarget = vi.fn(() => target);
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createTargetSnapshot: vi.fn(() => {
        const { service: _service, ...snapshot } = target;
        return snapshot;
      }),
      createCodingTaskTarget
    });

    const snapshot = await adapter.prepareSnapshot({ generation: 'g1', taskKind: 'file' });
    expect(createCodingTaskTarget).not.toHaveBeenCalled();

    await adapter.activateTarget({ generation: 'g1', taskKind: 'file', target: snapshot });
    expect(createCodingTaskTarget).toHaveBeenCalledOnce();
  });

  test('没有授权根时抛出稳定错误且不创建 Agent', async () => {
    const createCodingTaskTarget = vi.fn();
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => null),
      createCodingTaskTarget
    });

    await expect(adapter.prepareTarget({ generation: 'g1', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'FILE_AUTHORIZATION_REQUIRED' });

    expect(createCodingTaskTarget).not.toHaveBeenCalled();
  });

  test('取消进行中的目标准备会立即释放 owner，旧授权返回后不得覆盖新目标', async () => {
    const authorization = deferred();
    let authorizationCalls = 0;
    const agent = createCodingTaskServiceDouble();
    const createCodingTaskTarget = vi.fn(() => preparedCodingTask(agent));
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) await authorization.promise;
        return 'D:\\authorized';
      }),
      createCodingTaskTarget
    });
    const oldPrepare = adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    await vi.waitFor(() => expect(authorizationCalls).toBe(1));

    await adapter.cancelActive();
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
    expect(createCodingTaskTarget).toHaveBeenCalledOnce();
  });

  test('取消旧 Agent 清理中的准备会释放 owner，但下一准备仍等待清理屏障', async () => {
    const cleanup = deferred();
    const oldAgent = createCodingTaskServiceDouble();
    oldAgent.resetForNewConversation.mockImplementation(() => cleanup.promise);
    const newAgent = createCodingTaskServiceDouble();
    const agents = [oldAgent, newAgent];
    const createCodingTaskTarget = vi.fn(() => preparedCodingTask(agents.shift()!));
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget
    });
    await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    await adapter.cancelActive();

    const replacing = adapter.prepareTarget({ generation: 'g-replacing', taskKind: 'file' });
    await vi.waitFor(() => expect(oldAgent.resetForNewConversation).toHaveBeenCalledOnce());
    await adapter.cancelActive();
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
    expect(createCodingTaskTarget).toHaveBeenCalledTimes(2);
  });

  test.each(['reset', 'close'] as const)(
    '%s 会等待准备阶段已开始的旧 Agent 清理并完成 reset/close',
    async action => {
      const cleanup = deferred();
      const oldAgent = createCodingTaskServiceDouble();
      oldAgent.resetForNewConversation.mockImplementation(() => cleanup.promise);
    const adapter = createAdapter({
        getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
        createCodingTaskTarget: () => preparedCodingTask(oldAgent)
      });
      await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
      await adapter.cancelActive();
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
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'thinking' });
      emitCodingTaskEvent({ type: 'message', role: 'assistant', text: '目录为空' });
      emitCodingTaskEvent({ type: 'phase', phase: 'success' });
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
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
      visibleHistory,
      submissionOwner: expect.any(Symbol)
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

    emitCodingTaskEvent({ type: 'message', role: 'assistant', text: '迟到事件' });
    expect(received).toHaveLength(3);
  });

  test('预检后授权被撤销时由真实会话二次检查拒绝且不遗留活动代次', async () => {
    const roots: Array<string | null> = ['D:\\authorized', null];
    const getAuthorizedRootPath = vi.fn(async () => roots.shift() ?? null);
    const agent = createCodingTaskServiceDouble(async () => {
      if (await getAuthorizedRootPath() === null) {
        throw codedError('FILE_AUTHORIZATION_REQUIRED');
      }
    });
    const adapter = createAdapter({
      getAuthorizedRootPath,
      createCodingTaskTarget: () => preparedCodingTask(agent)
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

  test('活动任务拒绝并发，reset 清理 Agent、订阅和迟到事件', async () => {
    const pending = deferred();
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(() => pending.promise);
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
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
    emitCodingTaskEvent({ type: 'phase', phase: 'success' });
    expect(listener).not.toHaveBeenCalled();

    pending.resolve();
    await first;
  });

  test('取消后仍等待旧提交收敛，防止旧 Agent 事件被标成新 generation', async () => {
    const pending = deferred();
    let attempts = 0;
    const agent = createCodingTaskServiceDouble(async () => {
      attempts += 1;
      if (attempts === 1) await pending.promise;
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: () => preparedCodingTask(agent)
    });

    await adapter.prepareTarget({ generation: 'g-old', taskKind: 'file' });
    const first = adapter.submit({
      text: '旧任务',
      visibleHistory: [],
      generation: 'g-old',
      taskKind: 'file'
    });
    await vi.waitFor(() => expect(agent.submitFileTask).toHaveBeenCalledOnce());
    await adapter.cancelActive();

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
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    agent.confirm.mockImplementation(() => confirmation.promise);
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
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
    await adapter.cancelActive();
    emitCodingTaskEvent({ type: 'phase', phase: 'cancelled' });

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
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
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

  test('首次确认内发布第二张确认卡时保留同一任务所有权', async () => {
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    agent.confirm.mockImplementation(async actionId => {
      if (actionId === 'first-action') {
        emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
      } else {
        emitCodingTaskEvent({ type: 'phase', phase: 'success' });
      }
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
      }
    });
    await submitPrepared(adapter, {
      text: '创建后移动', visibleHistory: [], generation: 'g-multi', taskKind: 'file'
    });

    await adapter.resolveAction('first-action', 'confirm');
    await expect(adapter.resolveAction('second-action', 'confirm')).resolves.toBeUndefined();
    await expect(adapter.resolveAction('second-action', 'confirm')).rejects
      .toMatchObject({ code: 'ACTION_EXPIRED' });

    expect(agent.confirm).toHaveBeenNthCalledWith(1, 'first-action');
    expect(agent.confirm).toHaveBeenNthCalledWith(2, 'second-action');
  });

  test('第二张确认卡取消后立即清理任务且旧 action 不得重放', async () => {
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    agent.confirm.mockImplementation(async () => {
      emitCodingTaskEvent({ type: 'phase', phase: 'awaiting_confirmation' });
    });
    agent.cancelAction.mockImplementation(() => {
      emitCodingTaskEvent({ type: 'phase', phase: 'cancelled' });
    });
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
      }
    });
    await submitPrepared(adapter, {
      text: '多文件任务', visibleHistory: [], generation: 'g-cancel-second', taskKind: 'file'
    });

    await adapter.resolveAction('first-action', 'confirm');
    await adapter.resolveAction('second-action', 'cancel');

    await expect(adapter.resolveAction('second-action', 'confirm')).rejects
      .toMatchObject({ code: 'ACTION_EXPIRED' });
    await expect(adapter.prepareTarget({ generation: 'g-next', taskKind: 'file' }))
      .resolves.toMatchObject({ profileId: 'profile-agent' });
  });

  test('工厂同步 reset 后不安装或提交刚创建的 Agent，且清理异常不覆盖主错误', async () => {
    const agent = createCodingTaskServiceDouble();
    agent.cancelActive.mockImplementation(() => {
      throw new Error('cancel cleanup failed');
    });
    agent.close.mockImplementation(() => {
      throw new Error('close cleanup failed');
    });
    let adapter!: CapabilityTaskAdapter;
    adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: () => {
        void adapter.resetForNewConversation();
        return preparedCodingTask(agent);
      }
    });

    await expect(adapter.prepareTarget({ generation: 'g-reset', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'TASK_CANCELLED' });

    expect(agent.submitFileTask).not.toHaveBeenCalled();
    expect(agent.cancelActive).toHaveBeenCalledOnce();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  test('工厂同步 close 后不安装或提交刚创建的 Agent', async () => {
    const agent = createCodingTaskServiceDouble();
    let adapter!: CapabilityTaskAdapter;
    adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: () => {
        adapter.close();
        return preparedCodingTask(agent);
      }
    });

    await expect(adapter.prepareTarget({ generation: 'g-close', taskKind: 'file' })).rejects
      .toMatchObject({ code: 'CONVERSATION_CLOSED' });

    expect(agent.submitFileTask).not.toHaveBeenCalled();
    expect(agent.cancelActive).toHaveBeenCalledOnce();
    expect(agent.close).toHaveBeenCalledOnce();
  });

  test('旧 Core 清理失败后连续准备及新 generation 均保留失败屏障，reset/close 不得抹掉', async () => {
    let factories = 0;
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit, emitTrustedToolResult }) => {
        factories += 1;
        return { ...defaultTargetSnapshot, service: new CodingTaskService({
          sessionOptions: async () => ({ directory: 'D:\\authorized', dataDirectory: 'D:\\data', approvedCommands: [], model: { baseUrl: '', modelId: 'fixture', contextWindow: 8192, outputTokens: 2048, readCredential: async () => 'fixture' } }),
          createSession: async () => ({ run: async () => ({ text: '运行结束', toolCalls: 0 }), replyPermission: async () => undefined, close: async () => { throw new Error('原 Core 清理未确认'); } }),
          emit, emitTrustedToolResult
        }) };
      }
    });
    await submitPrepared(adapter, { text: '任务', visibleHistory: [], generation: 'g1', taskKind: 'file' });
    for (const generation of ['g1', 'g2']) {
      await expect(adapter.prepareTarget({ generation, taskKind: 'file' })).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
      expect(factories).toBe(1);
    }
    await expect(adapter.resetForNewConversation()).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
    await expect(adapter.resetForNewConversation()).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
    await expect(adapter.prepareTarget({ generation: 'g3', taskKind: 'file' })).rejects.toMatchObject({ code: 'TASK_ALREADY_ACTIVE' });
    await expect(adapter.close()).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
    await expect(adapter.close()).rejects.toMatchObject({ code: 'CODING_TASK_CLEANUP_FAILED' });
    await expect(adapter.prepareTarget({ generation: 'g4', taskKind: 'file' })).rejects.toMatchObject({ code: 'CONVERSATION_CLOSED' });
    expect(factories).toBe(1);
  });

  test('close 后拒绝新任务并隔离旧 Agent 事件', async () => {
    let emitCodingTaskEvent!: (event: TaskEvent) => void;
    const agent = createCodingTaskServiceDouble();
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: ({ emit }) => {
        emitCodingTaskEvent = emit;
        return preparedCodingTask(agent);
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
    emitCodingTaskEvent({ type: 'phase', phase: 'thinking' });

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
    const agent = createCodingTaskServiceDouble();
    agent.resetForNewConversation.mockImplementation(() => barrier.promise);
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: () => preparedCodingTask(agent)
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
    const agent = createCodingTaskServiceDouble(() => provider.promise);
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: () => preparedCodingTask(agent)
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
    const agentA = createCodingTaskServiceDouble();
    const agentB = createCodingTaskServiceDouble();
    const targets = [
      preparedCodingTask(agentA, {
        profileId: 'profile-a',
        providerIdentity: 'provider-a',
        providerName: 'Provider A',
        capabilityRevision: 'revision-a', directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: []
      }),
      preparedCodingTask(agentB, {
        profileId: 'profile-b',
        providerIdentity: 'provider-b',
        providerName: 'Provider B',
        capabilityRevision: 'revision-b', directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: []
      })
    ];
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createTargetSnapshot: vi.fn(() => {
        const { service: _service, ...snapshot } = targets[0]!;
        return snapshot;
      }),
      createCodingTaskTarget: vi.fn(() => targets.shift()!)
    });

    const target = await adapter.prepareTarget({ generation: 'g-bound', taskKind: 'file' });
    await expect(adapter.submit({
      text: '整理文件',
      visibleHistory: [],
      generation: 'g-bound',
      taskKind: 'file'
    })).rejects.toMatchObject({ code: 'FILE_TARGET_MISMATCH' });

    expect(target).toEqual({
      profileId: 'profile-a',
      providerIdentity: 'provider-a',
      providerName: 'Provider A',
      capabilityRevision: 'revision-a', directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: []
    });
    expect(agentA.submitFileTask).not.toHaveBeenCalled();
    expect(agentB.submitFileTask).not.toHaveBeenCalled();
  });

  test('reset 立即隔离旧 Agent、等待其收敛，并保留长期订阅供新会话复用', async () => {
    const oldReset = deferred();
    let oldEmit!: (event: TaskEvent) => void;
    let newEmit!: (event: TaskEvent) => void;
    const oldAgent = createCodingTaskServiceDouble();
    oldAgent.resetForNewConversation.mockImplementation(() => oldReset.promise);
    const newAgent = createCodingTaskServiceDouble(async () => {
      newEmit({ type: 'message', role: 'assistant', text: '新会话事件' });
      newEmit({ type: 'phase', phase: 'success' });
    });
    let created = 0;
    const adapter = createAdapter({
      getAuthorizedRootPath: vi.fn(async () => 'D:\\authorized'),
      createCodingTaskTarget: vi.fn(({ emit }: { emit: (event: TaskEvent) => void }) => {
        created += 1;
        if (created === 1) {
          oldEmit = emit;
          return preparedCodingTask(oldAgent);
        }
        newEmit = emit;
        return preparedCodingTask(newAgent);
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
