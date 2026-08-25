import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { AgentLoop } from '@myself/agent-core';
import { FileToolService, PathPolicy } from '@myself/file-tools';
import type { ProviderProfileV2, TaskEvent, ToolRequest } from '@myself/shared-types';
import { AgentService } from '../src/main/agent/agent-service';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { createMainAgentSession } from '../src/main/agent/main-agent-session-factory';
import { PendingActionStore } from '../src/main/agent/pending-action-store';
import type { ConversationBehaviorPort } from '../src/main/characters/character-behavior-director';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import {
  createMainConversationComposition,
  type MainConversationComposition
} from '../src/main/conversation/main-conversation-composition';
import { BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY } from '../src/main/local-model/local-model-route';
import { LocalModelRuntime } from '../src/main/local-model/local-model-runtime';
import { LocalModelService } from '../src/main/local-model/local-model-service';
import { LocalModelProvider } from '../src/main/providers/local-model-provider';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { assertProviderReady } from '../src/main/settings/session-preflight';
import type { ProviderSettingsSnapshot } from '../src/main/storage/settings-store';

type Backend = 'cpu' | 'vulkan';

interface AcceptanceInput {
  requestedBackend: Backend;
  resourceRoot: string;
  applicationVersion: string;
}

interface Checks {
  discreteGpu: boolean;
  fullGpuOffload: boolean;
  chineseChat: boolean;
  reasoningDisabled: boolean;
  toolCall: boolean;
  confirmation: boolean;
  fileSideEffect: boolean;
  toolResultSummary: boolean;
  cancelRecovery: boolean;
  cloudCallsZero: boolean;
  cloudRouteRestored: boolean;
  createOperation: boolean;
  readOperation: boolean;
  globOperation: boolean;
  grepOperation: boolean;
  editOperation: boolean;
  moveOperation: boolean;
  deleteOperation: boolean;
  chineseRelativePath: boolean;
  clarification: boolean;
  userRejected: boolean;
  toolFailureRecovery: boolean;
}

const VULKAN_OFFLOAD_TIMEOUT_MS = 5_000;
const ACCEPTANCE_TIMEOUT_MS = 15 * 60_000;
const ACCEPTANCE_CLEANUP_TIMEOUT_MS = 30_000;

function acceptanceError(code: string): Error {
  return new Error(code);
}

function stableAcceptanceError(error: unknown, stage: string): Error {
  const candidate = error instanceof Error && 'code' in error
    ? error.code
    : error instanceof Error
      ? error.message
      : undefined;
  return acceptanceError(
    typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(candidate)
      ? `${stage}_${candidate}`
      : `${stage}_FAILED`
  );
}

function containsChinese(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function normalizedRelativePath(value: string): string {
  return value.replace(/\\/gu, '/');
}

/** 验收只采信已提交的助手正文；流式 start/delta 不能单独证明一轮成功。 */
export function findFinalAssistantText(events: readonly TaskEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'assistant_message_commit') return event.text;
    if (event?.type === 'message' && event.role === 'assistant') return event.text;
  }
  return undefined;
}

function findPendingAction(events: readonly TaskEvent[]) {
  const event = events.find(candidate => candidate.type === 'pending_action');
  if (event?.type !== 'pending_action') {
    const failure = [...events].reverse().find(candidate => candidate.type === 'error');
    if (failure?.type === 'error') throw acceptanceError(failure.code);
    if (events.some(candidate => candidate.type === 'history_disclosure_required')) {
      throw acceptanceError('HISTORY_DISCLOSURE_REQUIRED');
    }
    if (findFinalAssistantText(events) !== undefined) {
      throw acceptanceError('MODEL_TEXT_INSTEAD_OF_TOOL');
    }
    throw acceptanceError('TOOL_CALL_MISSING');
  }
  return event.action;
}

async function assertPathDoesNotExist(path: string): Promise<true> {
  try {
    await access(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return true;
    }
    throw acceptanceError('FILE_STATE_CHECK_FAILED');
  }
  throw acceptanceError('CONFIRMATION_SIDE_EFFECT_DETECTED');
}

function behaviorPort(): ConversationBehaviorPort {
  return {
    prepareUserPrompt: async text => ({ originalText: text, capabilityText: text, explicitDirective: null }),
    getChatContext: () => ({
      character: {
        characterName: '验收角色', semantics: ['idle'], stateNames: [], actionNames: [], tags: []
      },
      runtime: { moving: false, dragging: false, carrying: false, movementStopped: false },
      proactivityMode: 'assistive',
      recentActions: []
    }),
    completeUserPrompt: async () => undefined,
    handleTaskEvent: () => undefined,
    applyPlaybackFeedback: () => undefined,
    reset: () => undefined,
    close: async () => undefined
  };
}

function cloudProviderSettings(): ProviderSettingsSnapshot {
  const profile: ProviderProfileV2 = {
    id: 'acceptance-cloud',
    displayName: '验收云模型',
    modelId: 'acceptance-cloud-model',
    hasStoredSecret: true,
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: 'https://acceptance.invalid/v1',
    additionalParameters: {},
    capabilities: ['chat', 'tools']
  };
  return {
    profiles: [profile],
    route: {
      primaryProfileId: profile.id,
      chatProfileId: profile.id,
      agentProfileId: profile.id,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    }
  };
}

function cloudChatResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ text: '云路由已恢复。' }) } }]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function waitForVulkanOffload(readObserved: () => boolean): Promise<void> {
  const deadline = Date.now() + VULKAN_OFFLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readObserved()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw acceptanceError('VULKAN_OFFLOAD_FAILED');
}

/** 所有验收出口共用同一清理上限，底层 Runtime 仍负责精确进程与 Token 清理。 */
function closeAcceptanceWithinDeadline(
  close: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(acceptanceError('PROCESS_CLEANUP_FAILED'));
    }, timeoutMs);
    void Promise.resolve().then(close).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(acceptanceError('PROCESS_CLEANUP_FAILED'));
      }
    );
  });
}

/** deadline 只裁决验收结果；超时清理仍交给正式会话与 Runtime 所有者。 */
export function runAcceptanceWithDeadline<T>(options: {
  run(): Promise<T>;
  cancelActive(): void;
  close(): Promise<void>;
  timeoutMs: number;
  closeTimeoutMs?: number;
  onDeadline?(): void;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: T } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if ('value' in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.onDeadline?.();
      try {
        options.cancelActive();
      } catch {
        // 取消只是触发器；正式 close 仍必须执行并决定清理是否成功。
      }
      const closeTimeoutMs = options.closeTimeoutMs ?? ACCEPTANCE_CLEANUP_TIMEOUT_MS;
      const cleanup = closeAcceptanceWithinDeadline(options.close, closeTimeoutMs);
      void cleanup.then(
        () => reject(acceptanceError('ACCEPTANCE_TIMEOUT')),
        () => reject(acceptanceError('PROCESS_CLEANUP_FAILED'))
      );
    }, options.timeoutMs);
    void Promise.resolve().then(options.run).then(
      value => finish({ value }),
      error => finish({ error })
    );
  });
}

/** 正常结束由外层关闭；deadline 已接管关闭后不得再次等待同一个清理 Promise。 */
export async function runAcceptanceLifecycle<T>(options: {
  run(): Promise<T>;
  cancelActive(): void;
  close(): Promise<void>;
  timeoutMs: number;
  closeTimeoutMs?: number;
}): Promise<T> {
  let deadlineExpired = false;
  try {
    return await runAcceptanceWithDeadline({
      ...options,
      onDeadline: () => { deadlineExpired = true; }
    });
  } finally {
    if (!deadlineExpired) {
      await closeAcceptanceWithinDeadline(
        options.close,
        options.closeTimeoutMs ?? ACCEPTANCE_CLEANUP_TIMEOUT_MS
      );
    }
  }
}

/**
 * 验收只负责组合正式 Main 模块；Runtime 独占进程、Token、health、argv 与清理。
 * 公开结果只返回布尔事实，Prompt、正文、路径和进程输出都留在当前函数内。
 */
export async function runLocalModelAcceptance(input: AcceptanceInput) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-pet-real-local-model-acceptance-'));
  const authorizedRoot = join(temporaryRoot, 'authorized');
  const recycleRoot = join(temporaryRoot, 'recycle');
  await mkdir(authorizedRoot, { recursive: true });
  await mkdir(recycleRoot, { recursive: true });
  let vulkanObservation: Readonly<{
    deviceClass: 'discrete' | 'integrated' | 'unknown';
    offloadedLayers: number;
    totalLayers: number;
  }> | null = null;
  const runtime = new LocalModelRuntime({
    root: input.resourceRoot,
    applicationVersion: input.applicationVersion,
    cachePath: join(temporaryRoot, 'model-hash-cache.json'),
    tokenRoot: join(temporaryRoot, 'tokens'),
    backendPreference: input.requestedBackend === 'cpu' ? 'cpu-only' : 'vulkan-only',
    acceptanceDiagnostics: {
      onVulkanOffloadObserved: observation => { vulkanObservation = observation; }
    }
  });
  const localProvider = new LocalModelProvider(runtime);
  const registry = new ProviderRegistry(
    [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
    () => localProvider
  );
  const cloudSettings = cloudProviderSettings();
  let cloudFetchCalls = 0;
  let cloudSecretCalls = 0;
  let enabled = true;
  let recycleSequence = 0;
  const observedReadTools = new Set<string>();
  let composition: MainConversationComposition | undefined;
  const localModelService = new LocalModelService({
    initialEnabled: true,
    runtime,
    readCloudProviderSettings: async () => structuredClone(cloudSettings),
    saveEnabled: async nextEnabled => { enabled = nextEnabled; },
    resetForConfigurationChange: async () => {
      await composition?.resetForConfigurationChange();
    },
    publishStatus: () => undefined
  });
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('local-model-acceptance', { incognito: false });
  const events: TaskEvent[] = [];
  const createProvider = (profile: ProviderProfileV2) => registry.create(
    profile,
    async () => {
      cloudSecretCalls += 1;
      return 'acceptance-cloud-secret';
    },
    async () => {
      cloudFetchCalls += 1;
      return cloudChatResponse();
    }
  );
  composition = createMainConversationComposition({
    catalog: [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY],
    privacySessions,
    sessionId: 'local-model-acceptance',
    readProviderSettings: () => localModelService.providerSettingsSnapshot(),
    assertProviderReady: profile => assertProviderReady(profile, runtime.getStatus()),
    readAuthorizedRootPath: async () => authorizedRoot,
    readPrivacySettings: async () => ({ dataCategories: { file: true } }),
    createChatAdapter: profile => new ConversationChatAdapter(createProvider(profile)),
    createAgentService: ({ snapshot, generation, primaryProfile, fallbackProfiles, emit }) => {
      const loop = new AgentLoop();
      const pending = new PendingActionStore({
        onDiscard: execution => loop.discard(execution.continuationToken)
      });
      return new AgentService({
        loop,
        pending,
        createSession: () => createMainAgentSession({
          taskKind: snapshot.taskKind,
          authorizedRootPath: snapshot.authorizedRootPath,
          generation,
          fileDisclosureAllowed: snapshot.privacySettings.dataCategories.file,
          provider: createProvider(primaryProfile),
          fallbackProviders: fallbackProfiles.map(createProvider),
          createFileTools: async () => {
            const fileTools = new FileToolService(
              await PathPolicy.create(snapshot.authorizedRootPath), {
              moveToRecycleBin: async absolutePath => {
                if (basename(absolutePath) === 'acceptance-failure.txt') {
                  throw acceptanceError('FIXTURE_RECYCLE_FAILED');
                }
                recycleSequence += 1;
                await rename(absolutePath, join(recycleRoot, `${recycleSequence}.recycled`));
              }
            });
            const executeRead = fileTools.executeRead.bind(fileTools);
            fileTools.executeRead = async (request: ToolRequest) => {
              const result = await executeRead(request);
              observedReadTools.add(request.toolName);
              return result;
            };
            return fileTools;
          },
          createPowerShellTool: () => { throw acceptanceError('TOOL_UNKNOWN'); }
        }),
        emit,
        createConversationId: () => 'local-model-acceptance'
      });
    },
    behavior: behaviorPort(),
    emit: event => events.push(event)
  });

  let closePromise: Promise<void> | undefined;
  const closeAcceptance = (): Promise<void> => {
    closePromise ??= (async () => {
      const cleanup = await Promise.allSettled([
        composition.close(),
        localModelService.close()
      ]);
      let temporaryRootRemoved = true;
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch {
        temporaryRootRemoved = false;
      }
      if (!temporaryRootRemoved || cleanup.some(result => result.status === 'rejected')) {
        throw acceptanceError('PROCESS_CLEANUP_FAILED');
      }
    })();
    return closePromise;
  };

  return runAcceptanceLifecycle({
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
      cancelActive: () => composition.coordinator.cancelActive(),
      close: closeAcceptance,
      run: async () => {
        let acceptanceStage = 'RUNTIME_START';
        try {
        await localModelService.start();
    if (input.requestedBackend === 'vulkan') {
      await waitForVulkanOffload(() => vulkanObservation !== null);
      if (vulkanObservation?.deviceClass !== 'discrete') {
        throw acceptanceError('DISCRETE_GPU_NOT_SELECTED');
      }
      if (vulkanObservation.offloadedLayers !== vulkanObservation.totalLayers) {
        throw acceptanceError('GPU_OFFLOAD_INCOMPLETE');
      }
    }
    const activeBackend = runtime.getStatus().backend;
    if (activeBackend !== input.requestedBackend) throw acceptanceError('BACKEND_MISMATCH');

    const checks: Checks = {
      discreteGpu: input.requestedBackend === 'vulkan',
      fullGpuOffload: input.requestedBackend === 'vulkan',
      chineseChat: false,
      reasoningDisabled: false,
      toolCall: false,
      confirmation: false,
      fileSideEffect: false,
      toolResultSummary: false,
      cancelRecovery: false,
      cloudCallsZero: false,
      cloudRouteRestored: false,
      createOperation: false,
      readOperation: false,
      globOperation: false,
      grepOperation: false,
      editOperation: false,
      moveOperation: false,
      deleteOperation: false,
      chineseRelativePath: false,
      clarification: false,
      userRejected: false,
      toolFailureRecovery: false
    };

    acceptanceStage = 'CHAT';
    const chatEventStart = events.length;
    await composition.coordinator.submit('只用简短中文回答：你好。');
    const chatMessage = findFinalAssistantText(events.slice(chatEventStart));
    if (
      chatMessage === undefined
      || !containsChinese(chatMessage)
      || /<think>|<\/think>|reasoning_content/iu.test(chatMessage)
    ) {
      throw acceptanceError('CHINESE_CHAT_FAILED');
    }
    checks.chineseChat = true;
    checks.reasoningDisabled = true;

    // 同一生产 LocalModelProvider 必须在 Abort 后继续供正式 Main Agent 使用。
    const interruption = new AbortController();
    const interruptedResponse = localProvider.respond({
      messages: [{ role: 'user', content: '这条验收请求会立即取消。' }],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'disabled'
    }, interruption.signal);
    interruption.abort(new DOMException('验收主动取消', 'AbortError'));
    await interruptedResponse.then(
      () => { throw acceptanceError('PROVIDER_ABORT_FAILED'); },
      error => {
        if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
      }
    );
    // 普通聊天与文件工具是两条独立真实探针；用正式会话重置隔离历史，避免互相污染模型裁决。
    await composition.resetForConfigurationChange();

    acceptanceStage = 'CREATE';
    const createEventStart = events.length;
    await composition.coordinator.submit(
      '在授权根目录下创建 acceptance-created.txt，内容只写 accepted。路径和内容齐全，请立即调用创建文件工具。'
    );
    const createAction = findPendingAction(events.slice(createEventStart));
    if (
      createAction.operation !== 'create_file'
      || normalizedRelativePath(createAction.targetRelativePath) !== 'acceptance-created.txt'
    ) throw acceptanceError('TOOL_CALL_MISSING');
    checks.toolCall = true;
    const createdTarget = join(authorizedRoot, 'acceptance-created.txt');
    checks.confirmation = await assertPathDoesNotExist(createdTarget);
    const confirmEventStart = events.length;
    await composition.coordinator.resolveFileAction(createAction.actionId, 'confirm');
    if (await readFile(createdTarget, 'utf8') !== 'accepted') {
      throw acceptanceError('FILE_SIDE_EFFECT_FAILED');
    }
    checks.fileSideEffect = true;
    checks.createOperation = true;
    checks.toolResultSummary = (
      findFinalAssistantText(events.slice(confirmEventStart))?.trim().length ?? 0
    ) > 0;
    if (!checks.toolResultSummary) throw acceptanceError('TOOL_RESULT_SUMMARY_FAILED');

    await mkdir(join(authorizedRoot, '目标目录'));
    await composition.resetForConfigurationChange();
    acceptanceStage = 'MOVE';
    const moveEventStart = events.length;
    await composition.coordinator.submit(
      '把授权根目录的 acceptance-created.txt 移动到目标目录。源和目标目录路径齐全，请立即调用移动文件工具。'
    );
    const moveAction = findPendingAction(events.slice(moveEventStart));
    if (
      moveAction.operation !== 'move_file'
      || normalizedRelativePath(moveAction.sourceRelativePath) !== 'acceptance-created.txt'
      || normalizedRelativePath(moveAction.targetRelativePath) !== '目标目录/acceptance-created.txt'
    ) throw acceptanceError('MOVE_TOOL_CALL_MISSING');
    await access(createdTarget);
    const movedTarget = join(authorizedRoot, '目标目录', 'acceptance-created.txt');
    await assertPathDoesNotExist(movedTarget);
    await composition.coordinator.resolveFileAction(moveAction.actionId, 'confirm');
    await assertPathDoesNotExist(createdTarget);
    if (await readFile(movedTarget, 'utf8') !== 'accepted') {
      throw acceptanceError('MOVE_SIDE_EFFECT_FAILED');
    }
    checks.moveOperation = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'DELETE';
    const deleteEventStart = events.length;
    await composition.coordinator.submit(
      '删除相对路径 目标目录/acceptance-created.txt 的文件。相对路径齐全，请立即调用删除文件工具。'
    );
    const deleteAction = findPendingAction(events.slice(deleteEventStart));
    if (
      deleteAction.operation !== 'delete_file'
      || normalizedRelativePath(deleteAction.targetRelativePath) !== '目标目录/acceptance-created.txt'
    ) throw acceptanceError('DELETE_TOOL_CALL_MISSING');
    await access(movedTarget);
    await composition.coordinator.resolveFileAction(deleteAction.actionId, 'confirm');
    await assertPathDoesNotExist(movedTarget);
    checks.deleteOperation = true;

    await mkdir(join(authorizedRoot, '资料'));
    await composition.resetForConfigurationChange();
    acceptanceStage = 'CHINESE_PATH';
    const chineseEventStart = events.length;
    await composition.coordinator.submit(
      '创建相对路径 资料/中文记录.txt，内容只写 你好。相对路径和内容齐全，请立即调用创建文件工具。'
    );
    const chineseAction = findPendingAction(events.slice(chineseEventStart));
    if (
      chineseAction.operation !== 'create_file'
      || normalizedRelativePath(chineseAction.targetRelativePath) !== '资料/中文记录.txt'
    ) throw acceptanceError('CHINESE_PATH_TOOL_CALL_MISSING');
    const chineseTarget = join(authorizedRoot, '资料', '中文记录.txt');
    await assertPathDoesNotExist(chineseTarget);
    await composition.coordinator.resolveFileAction(chineseAction.actionId, 'confirm');
    if (await readFile(chineseTarget, 'utf8') !== '你好') {
      throw acceptanceError('CHINESE_PATH_SIDE_EFFECT_FAILED');
    }
    checks.chineseRelativePath = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'READ';
    await composition.coordinator.submit(
      '读取相对路径 资料/中文记录.txt 的正文。路径齐全，请立即调用读取文件工具。'
    );
    if (!observedReadTools.has('read_file')) throw acceptanceError('READ_TOOL_CALL_MISSING');
    checks.readOperation = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'GLOB';
    await composition.coordinator.submit(
      '按文件名匹配 资料/*.txt。模式齐全，请立即调用文件名匹配工具。'
    );
    if (!observedReadTools.has('glob_files')) throw acceptanceError('GLOB_TOOL_CALL_MISSING');
    checks.globOperation = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'GREP';
    await composition.coordinator.submit(
      '在文件内容中搜索“你好”。查询齐全，请立即调用内容搜索工具。'
    );
    if (!observedReadTools.has('grep_files')) throw acceptanceError('GREP_TOOL_CALL_MISSING');
    checks.grepOperation = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'EDIT';
    const editEventStart = events.length;
    await composition.coordinator.submit(
      '把相对路径 资料/中文记录.txt 中唯一的“你好”精确替换为“您好”。路径、旧文本和新文本齐全，请立即调用精确编辑文件工具。'
    );
    const editAction = findPendingAction(events.slice(editEventStart));
    if (
      editAction.operation !== 'apply_patch'
      || normalizedRelativePath(editAction.targetRelativePath) !== '资料/中文记录.txt'
    ) throw acceptanceError('EDIT_TOOL_CALL_MISSING');
    await composition.coordinator.resolveFileAction(editAction.actionId, 'confirm');
    if (await readFile(chineseTarget, 'utf8') !== '您好') {
      throw acceptanceError('EDIT_SIDE_EFFECT_FAILED');
    }
    checks.editOperation = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'CLARIFICATION';
    const clarificationEventStart = events.length;
    await composition.coordinator.submit('删除一个文件，但我还没有提供目标路径。请先询问缺少的信息。');
    const clarificationEvents = events.slice(clarificationEventStart);
    if (
      clarificationEvents.some(event => event.type === 'pending_action')
      || findFinalAssistantText(clarificationEvents) !== '请提供目标文件或目录的相对路径。'
    ) {
      throw acceptanceError('CLARIFICATION_FAILED');
    }
    const clarificationTarget = join(authorizedRoot, 'acceptance-clarification.txt');
    await writeFile(clarificationTarget, 'keep after clarification', 'utf8');
    const clarificationContinuationStart = events.length;
    await composition.coordinator.submit('目标相对路径是 acceptance-clarification.txt。');
    const clarificationAction = findPendingAction(events.slice(clarificationContinuationStart));
    if (
      clarificationAction.operation !== 'delete_file'
      || normalizedRelativePath(clarificationAction.targetRelativePath) !== 'acceptance-clarification.txt'
    ) {
      throw acceptanceError('CLARIFICATION_CONTINUATION_FAILED');
    }
    await composition.coordinator.resolveFileAction(clarificationAction.actionId, 'cancel');
    if (await readFile(clarificationTarget, 'utf8') !== 'keep after clarification') {
      throw acceptanceError('CLARIFICATION_CANCEL_SIDE_EFFECT');
    }
    checks.clarification = true;

    await composition.resetForConfigurationChange();
    acceptanceStage = 'USER_REJECTION';
    const cancelEventStart = events.length;
    await composition.coordinator.submit(
      '在授权根目录下创建 acceptance-cancelled.txt，内容只写 cancelled。路径和内容齐全，请立即调用创建文件工具。'
    );
    const cancelAction = findPendingAction(events.slice(cancelEventStart));
    if (
      cancelAction.operation !== 'create_file'
      || normalizedRelativePath(cancelAction.targetRelativePath) !== 'acceptance-cancelled.txt'
    ) throw acceptanceError('USER_REJECTION_TOOL_CALL_MISSING');
    const cancelledTarget = join(authorizedRoot, 'acceptance-cancelled.txt');
    await assertPathDoesNotExist(cancelledTarget);
    await composition.coordinator.resolveFileAction(cancelAction.actionId, 'cancel');
    await assertPathDoesNotExist(cancelledTarget);
    checks.userRejected = true;

    await writeFile(join(authorizedRoot, 'acceptance-failure.txt'), 'keep', 'utf8');
    await composition.resetForConfigurationChange();
    acceptanceStage = 'TOOL_FAILURE';
    const failureEventStart = events.length;
    await composition.coordinator.submit(
      '删除授权根目录的 acceptance-failure.txt。相对路径齐全，请立即调用删除文件工具。'
    );
    const failureAction = findPendingAction(events.slice(failureEventStart));
    if (
      failureAction.operation !== 'delete_file'
      || normalizedRelativePath(failureAction.targetRelativePath) !== 'acceptance-failure.txt'
    ) throw acceptanceError('FAILURE_TOOL_CALL_MISSING');
    await access(join(authorizedRoot, 'acceptance-failure.txt'));
    const failureResolutionStart = events.length;
    await composition.coordinator.resolveFileAction(failureAction.actionId, 'confirm');
    const failureEvents = events.slice(failureResolutionStart);
    if (
      !failureEvents.some(event => event.type === 'error' && event.code === 'RECYCLE_BIN_FAILED')
      || findFinalAssistantText(failureEvents) !== '本地能力操作失败，未完成请求。'
      || !failureEvents.some(event => event.type === 'phase' && event.phase === 'error')
    ) {
      throw acceptanceError('CONTROLLED_TOOL_FAILURE_MISSING');
    }
    await access(join(authorizedRoot, 'acceptance-failure.txt'));

    await composition.resetForConfigurationChange();
    acceptanceStage = 'TOOL_FAILURE_RECOVERY';
    const recoveryEventStart = events.length;
    await composition.coordinator.submit(
      '在授权根目录下创建 acceptance-recovered.txt，内容只写 recovered。路径和内容齐全，请立即调用创建文件工具。'
    );
    const recoveryAction = findPendingAction(events.slice(recoveryEventStart));
    if (
      recoveryAction.operation !== 'create_file'
      || normalizedRelativePath(recoveryAction.targetRelativePath) !== 'acceptance-recovered.txt'
    ) throw acceptanceError('CANCEL_RECOVERY_FAILED');
    const recoveredTarget = join(authorizedRoot, 'acceptance-recovered.txt');
    await assertPathDoesNotExist(recoveredTarget);
    await composition.coordinator.resolveFileAction(recoveryAction.actionId, 'confirm');
    if (await readFile(recoveredTarget, 'utf8') !== 'recovered') {
      throw acceptanceError('TOOL_FAILURE_RECOVERY_FAILED');
    }
    checks.cancelRecovery = true;
    checks.toolFailureRecovery = true;

    acceptanceStage = 'CLOUD_ROUTE';
    checks.cloudCallsZero = cloudFetchCalls === 0 && cloudSecretCalls === 0;
    if (!checks.cloudCallsZero) throw acceptanceError('CLOUD_CALL_DETECTED');
    await localModelService.setEnabled(false);
    if (enabled) throw acceptanceError('CLOUD_ROUTE_RESTORE_FAILED');
    await composition.coordinator.submit('只用简短中文回答：你好。');
    checks.cloudRouteRestored = cloudFetchCalls === 1 && cloudSecretCalls === 1;
    if (!checks.cloudRouteRestored) throw acceptanceError('CLOUD_ROUTE_RESTORE_FAILED');

    return {
      requestedBackend: input.requestedBackend,
          activeBackend,
          phase: 'passed' as const,
          reasonCode: null,
      checks
    };
        } catch (error) {
          throw stableAcceptanceError(error, acceptanceStage);
        }
      }
    });
}
