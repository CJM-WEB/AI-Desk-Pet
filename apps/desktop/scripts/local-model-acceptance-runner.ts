import { createCodingSession } from '@myself/coding-task-core';
import { capabilityControlPlanSchema } from '@myself/agent-core';
import { characterMoodUpdateSchema, characterExpressionPlanSchema, characterExplicitPlaybackSchema, movementControlPlanSchema } from '@myself/character-runtime';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import type { ModelProvider } from '@myself/agent-core';
import type { CodingModelConnection } from '@myself/coding-task-core';
import type { AcceptanceResult, AcceptanceScenario } from './run-local-model-acceptance.mjs';
import { CodingTaskService, type CodingTaskToolResult } from '../src/main/agent/coding-task-service';
import { resolveCodingTaskResources } from '../src/main/agent/coding-task-resources';
import { createCodingModelConnection } from '../src/main/providers/coding-model-connection';
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';

import type { ProviderProfileV2, ProviderCatalogEntry, TaskEvent } from '@myself/shared-types';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import type { ConversationBehaviorPort } from '../src/main/characters/character-behavior-director';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import {
  createMainConversationComposition,
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
  scenario?: AcceptanceScenario['name'] | undefined;
  requestedBackend: Backend;
  resourceRoot: string;
  appPath: string;
  applicationVersion: string;
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

/** 验收只采信已提交的助手正文；流式 start/delta 不能单独证明一轮成功。 */
export function findFinalAssistantText(events: readonly TaskEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'assistant_message_commit') return event.text;
    if (event?.type === 'message' && event.role === 'assistant') return event.text;
  }
  return undefined;
}

type PermissionEvent = Extract<TaskEvent, { type: 'task_permission_required' }>;

/** 只识别拒绝场景自己的单文件删除意图；此判断绝不用于批准命令。 */
export function isExpectedDeletionPermission(event: PermissionEvent, directory: string): boolean {
  const target = resolve(directory, 'keep.txt').toLowerCase();
  if (event.request.action === 'delete') return event.request.resources.length === 1
    && resolve(directory, event.request.resources[0]!).toLowerCase() === target;
  if (event.request.action !== 'bash' || resolve(event.request.cwd).toLowerCase() !== resolve(directory).toLowerCase()) return false;
  const command = event.request.command;
  if (/[;&|`$<>\r\n]/u.test(command)) return false;
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? [];
  if (!/^(?:remove-item|rm|del)$/iu.test(tokens.shift() ?? '')) return false;
  const paths = tokens.filter(token => !/^(?:-literalpath|-path|-force)$/iu.test(token));
  return paths.length === 1 && !paths[0]!.startsWith('-') && resolve(directory, paths[0]!).toLowerCase() === target;
}

/** 范围确认只接纳任务；必须继续观察正式最终正文与清理后终态。 */
export async function submitAcceptanceTurn(options: {
  events: readonly TaskEvent[];
  submit(): Promise<void>;
  resolveCapabilityAuthorization(requestId: string, resolution: 'confirm'): Promise<void>;
  assertNoSideEffect(): Promise<unknown>;
  resolvePermission?(event: PermissionEvent): Promise<void>;
  validateScope?(event: Extract<TaskEvent, { type: 'capability_authorization_required' }>): void;
  tick?(): Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<readonly TaskEvent[]> {
  const start = options.events.length;
  let cursor = start;
  let submitError: unknown;
  void options.submit().catch(error => { submitError = error; });
  const deadline = Date.now() + (options.timeoutMs ?? 150_000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw acceptanceError('ACCEPTANCE_CLOSED');
    if (submitError) throw submitError;
    while (cursor < options.events.length) {
      const event = options.events[cursor++]!;
      if (event.type === 'capability_authorization_required') {
        options.validateScope?.(event);
        await options.assertNoSideEffect();
        await options.resolveCapabilityAuthorization(event.requestId, 'confirm');
      } else if (event.type === 'task_permission_required') {
        if (!options.resolvePermission) throw acceptanceError('UNEXPECTED_PERMISSION');
        await options.resolvePermission(event);
      } else if (event.type === 'history_disclosure_required') {
        throw acceptanceError('UNEXPECTED_HISTORY_DISCLOSURE');
      } else if (event.type === 'phase' && ['success', 'error', 'cancelled'].includes(event.phase)) {
        return options.events.slice(start);
      }
    }
    await options.tick?.();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (options.signal?.aborted) throw acceptanceError('ACCEPTANCE_CLOSED');
  throw acceptanceError('TURN_TIMEOUT');
}

function behaviorPort(): ConversationBehaviorPort {
  return {
    prepareUserPrompt: async text => ({ originalText: text, capabilityText: text, explicitDirective: null }),
    getChatContext: () => ({
      character: { idleStateId: 'idle',
        identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
          name: '验收角色', description: '验收角色', background: '验收环境', traits: [],
          languageStyle: '简洁', likes: [], behavioralTendencies: []
        },
        states: []
      },
      runtime: { moving: false, dragging: false, carrying: false, movementMode: 2 },
      proactivityMode: 'assistive',
      recentActions: []
    }),
    completeUserPrompt: async () => undefined,
    captureExpressionContext: () => null,
    handleChatResponseFinished: () => undefined,
    handleTaskEvent: () => undefined,
    applyPlaybackFeedback: () => undefined,
    cancelActive: () => undefined,
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

/** 拒绝单个操作可结束为任务 error；外层仍独立等待正式 close，清理失败不能被此断言覆盖。 */
export function assertRejectionCompleted(events: readonly TaskEvent[]): void {
  if (!events.some(event => event.type === 'phase' && (event.phase === 'success' || event.phase === 'error')))
    throw acceptanceError('REJECTION_NOT_COMPLETED');
}

/** 模型属性读取、调用及其微任务共用 VM 期限；宿主仅消费布尔原始值。 */
export function verifyRepairedFunction(source: string): void {
  const valid: unknown = runInNewContext(`${source}
;(() => {
    const add = exports.add;
    return typeof add === 'function' && add(7, 8) === 15 && add(-5, 2) === -3;
  })()`, { exports: {} }, { timeout: 1_000, microtaskMode: 'afterEvaluate' });
  assert.equal(valid, true);
}

export interface ModelAcceptanceEnvironment {
  scenario?: AcceptanceScenario['name'] | undefined;
  model: 'qwen' | 'deepseek';
  appPath: string;
  resourceRoot: string;
  temporaryRoot: string;
  catalog: readonly ProviderCatalogEntry[];
  readSettings(): Promise<ProviderSettingsSnapshot>;
  createProvider(profile: ProviderProfileV2): ModelProvider;
  createConnection(profile: ProviderProfileV2): CodingModelConnection;
  assertReady(profile: ProviderProfileV2): void;
  start(): Promise<void>;
  close(): Promise<void>;
  requestedBackend: Backend | null;
  activeBackend(): Backend | null;
  verifyIsolation?(): Promise<{ cloudCallsZero: boolean; cloudRouteRestored: boolean }>;
  abortProvider?(): Promise<void>;
  progress?(stage: string): void;
}

/** 诊断包装只映射已知类别，绝不公开异常原文、cause、路径或任意元数据。 */
export function classifyAcceptanceCleanup(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('helper 未正常结算')) return 'CLOSE_HELPER_UNSETTLED';
  if (message.includes('控制通道提前断开')) return 'CLOSE_CONTROL_EARLY';
  if (message.includes('控制消息顺序无效')) return 'CLOSE_CONTROL_ORDER';
  if (message.includes('清理超时')) return 'CLOSE_JOB_TIMEOUT';
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(code))) return 'CLOSE_FILESYSTEM_BUSY';
  return 'CLOSE_OTHER';
}

/** 两模型只共享验收场景；所有任务执行、权限与进程树均由正式组合和 Core 承担。 */
export async function runCodingModelAcceptance(input: ModelAcceptanceEnvironment): Promise<AcceptanceResult> {
  await mkdir(join(input.temporaryRoot, 'project'));
  const authorizedRoot = await realpath(join(input.temporaryRoot, 'project'));
  const note = randomUUID();
  const batch = randomUUID();
  const kept = randomUUID();
  await writeFile(join(authorizedRoot, 'note.txt'), `本轮内容：${note}`, 'utf8');
  await writeFile(join(authorizedRoot, '配置说明.txt'), `批次编号：${batch}`, 'utf8');
  await writeFile(join(authorizedRoot, 'keep.txt'), kept, 'utf8');
  const broken = 'exports.add = (a, b) => a - b;\n';
  const testSource = "const assert = require('node:assert/strict'); const {add} = require('./sum.cjs'); assert.equal(add(2,3),5); assert.equal(add(-1,4),3); console.log('PASS');\n";
  await writeFile(join(authorizedRoot, 'sum.cjs'), broken, 'utf8');
  await writeFile(join(authorizedRoot, 'test.cjs'), testSource, 'utf8');
  await writeFile(join(authorizedRoot, 'watch.cjs'), "const fs = require('node:fs'); fs.writeFileSync('ready.json', JSON.stringify({pid:process.pid})); setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),100); console.log('READY');\n", 'utf8');
  await writeFile(join(authorizedRoot, 'package.json'), JSON.stringify({ name: 'acceptance-project', private: true, scripts: { test: 'node test.cjs', build: 'node watch.cjs' } }), 'utf8');
  const events: TaskEvent[] = [];
  const facts: CodingTaskToolResult[] = [];
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('coding-acceptance', { incognito: false });
  let modelId = '';
  const composition = createMainConversationComposition({
    catalog: input.catalog, privacySessions, sessionId: 'coding-acceptance',
    readProviderSettings: input.readSettings, assertProviderReady: input.assertReady,
    readAuthorizedRootPath: async () => authorizedRoot,
    readPrivacySettings: async () => ({ dataCategories: { memory: false } }),
    createChatAdapter: profile => {
      const provider = input.createProvider(profile);
      return new ConversationChatAdapter({ respond: async (request, signal) => {
        const response = await provider.respond(request, signal);
        const plan = response.type === 'text' ? response.structured_output?.capabilityPlan : undefined;
        const kind = plan && typeof plan === 'object' ? Reflect.get(plan, 'kind') : undefined;
        if (response.type === 'text' && response.structured_output) {
          for (const [field, schema] of Object.entries({ capabilityPlan: capabilityControlPlanSchema, moodUpdate: characterMoodUpdateSchema.optional(), expressionPlan: characterExpressionPlanSchema.optional(), explicitPlayback: characterExplicitPlaybackSchema.optional(), movementControl: movementControlPlanSchema })) {
            const validation = schema.safeParse(response.structured_output[field]);
            if (!validation.success) {
              input.progress?.(`INVALID_${field.toUpperCase()}`);
              for (const issue of validation.error.issues) {
                const part = issue.path.filter(value => ['kind', 'summary', 'strength', 'states', 'stateId', 'actions', 'actionId', 'score', 'minStrength', 'maxStrength', 'validForMs'].includes(String(value))).join('_').toUpperCase();
                input.progress?.(`SCHEMA_${issue.code.toUpperCase()}_${part}`);
              }
            }
          }
          const preferred = plan && typeof plan === 'object' ? Reflect.get(plan, 'preferredTool') : undefined;
          if (['read', 'bash', 'edit', 'write', 'read_file', 'powershell'].includes(String(preferred))) input.progress?.(`PREFERENCE_${String(preferred).toUpperCase()}`);
        }
        input.progress?.(kind === 'agent_task' ? 'CHAT_AGENT_SUGGESTED' : kind === 'chat' ? 'CHAT_ONLY' : 'CHAT_PLAN_MISSING');
        return response;
      } }, error => input.progress?.(`CHAT_${error.code}`));
    },
    createCodingTaskService: ({ snapshot, primaryProfile, emit, emitTrustedToolResult }) => new CodingTaskService({
      createSession: async options => {
        const session = await createCodingSession(options);
        return { ...session, close: async () => {
          try { await session.close(); }
          catch (error) { input.progress?.(classifyAcceptanceCleanup(error)); throw error; }
        } };
      },
      sessionOptions: async () => ({ directory: snapshot.authorizedRootPath, dataDirectory: input.temporaryRoot,
        approvedCommands: snapshot.approvedCommands, model: input.createConnection(primaryProfile),
        ...await resolveCodingTaskResources({ appPath: input.appPath, isPackaged: false, resourcesPath: input.resourceRoot }),
        trashFile: async () => { throw acceptanceError('UNEXPECTED_DELETE'); }
      }), emit,
      emitTrustedToolResult: result => { facts.push(result); emitTrustedToolResult(result); }
    }),
    behavior: behaviorPort(), emit: event => events.push(event)
  });
  const result: AcceptanceResult = { selection: input.scenario ?? 'all', model: input.model, modelId, requestedBackend: input.requestedBackend,
    activeBackend: null, phase: 'failed', reasonCode: null, cleanup: false,
    checks: { chineseChat: false, providerAbortRecovery: false, cloudCallsZero: false, cloudRouteRestored: false }, scenarios: [] };
  const lifecycle = new AbortController();
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    lifecycle.abort();
    const settled = await Promise.allSettled([composition.close(), input.close()]);
    if (settled.some(item => item.status === 'rejected')) throw acceptanceError('PROCESS_CLEANUP_FAILED');
    await removeAcceptanceRoot(input.temporaryRoot);
    result.cleanup = true;
  })();
  // 文件场景使用正式明确入口；首条普通中文聊天单独保留自动入口。
  const turn = (text: string, options: { intent?: 'auto' | 'task'; permission?: (event: PermissionEvent) => Promise<void>; tick?: () => Promise<void>; before?: () => Promise<unknown> } = {}) => submitAcceptanceTurn({
    events, signal: lifecycle.signal, submit: () => composition.coordinator.submit(text, options.intent ?? 'task'),
    resolveCapabilityAuthorization: (id, choice) => composition.coordinator.resolveCapabilityAuthorization(id, choice),
    assertNoSideEffect: options.before ?? (async () => undefined),
    validateScope: scope => {
      if (resolve(scope.directory) !== resolve(authorizedRoot) || scope.modelId !== modelId
        || scope.actions.join(',') !== 'read,create,edit'
        || scope.approvedCommands.some(command => !['npm.cmd run test', 'npm.cmd run build'].includes(command))) throw acceptanceError('SCOPE_MISMATCH');
    },
    ...(options.permission ? { resolvePermission: options.permission } : {}),
    ...(options.tick ? { tick: options.tick } : {})
  });
  const requireSuccess = (turnEvents: readonly TaskEvent[]) => {
    if (!turnEvents.some(event => event.type === 'phase' && event.phase === 'success')) throw acceptanceError('TASK_NOT_SUCCESS');
    const text = findFinalAssistantText(turnEvents);
    if (!text?.trim()) throw acceptanceError('FINAL_TEXT_MISSING');
    return text;
  };
  const scenario = async (name: AcceptanceScenario['name'], run: (start: number) => Promise<void>) => {
    if (input.scenario && input.scenario !== name) return;
    await composition.resetForConfigurationChange();
    const start = facts.length;
    const record: AcceptanceScenario = { name, phase: 'failed', reasonCode: null, operations: 0, exits: [] };
    result.scenarios.push(record);
    input.progress?.(name.toUpperCase());
    try { await run(start); record.phase = 'passed'; }
    catch (error) {
      record.reasonCode = stableAcceptanceError(error, name.toUpperCase()).message;
      await composition.coordinator.cancelActive();
    } finally {
      record.operations = facts.length - start;
      record.exits = facts.slice(start).flatMap(fact => fact.exit === undefined ? [] : [fact.exit]);
      input.progress?.(record.reasonCode ?? `${name.toUpperCase()}_${record.phase.toUpperCase()}`);
    }
  };
  try {
    await runAcceptanceLifecycle({ timeoutMs: ACCEPTANCE_TIMEOUT_MS, cancelActive: () => { void composition.coordinator.cancelActive(); }, close,
      run: async () => {
        input.progress?.('RUNTIME_START');
        await input.start();
        const settings = await input.readSettings();
        modelId = settings.profiles.find(profile => profile.id === settings.route.agentProfileId)?.modelId ?? '';
        if (!modelId) throw acceptanceError('MODEL_MISSING');
        result.modelId = modelId;
        result.activeBackend = input.activeBackend();
        input.progress?.('CHAT');
        const chat = requireSuccess(await turn('只用简短中文回答：你好。', { intent: 'auto' }));
        if (!containsChinese(chat) || /<\/?think>|reasoning_content/iu.test(chat)) throw acceptanceError('CHINESE_CHAT_FAILED');
        result.checks.chineseChat = true;
        if (input.abortProvider) await input.abortProvider();
        await scenario('read', async start => {
          const text = requireSuccess(await turn('帮我看看 note.txt 里写了什么，把内容显示给我。'));
          if (!text.includes(note) || !facts.slice(start).some(fact => fact.toolName === 'read' && fact.ok)) throw acceptanceError('DISK_CONTENT_MISSING');
        });
        result.checks.providerAbortRecovery = input.abortProvider !== undefined && result.scenarios.find(item => item.name === 'read')?.phase === 'passed';
        await scenario('question', async start => {
          const text = requireSuccess(await turn('配置说明里记录的批次编号是多少。'));
          input.progress?.(/(?:粘贴|贴出|贴上|发给我|提供.{0,20}(?:内容|正文)|(?:内容|正文).{0,20}提供)/u.test(text) ? 'ANSWER_REQUEST_CONTENT' : /(?:路径|文件位置|哪份|哪一份|哪个文件|哪一个文件)/u.test(text) ? 'ANSWER_REQUEST_LOCATION' : /(?:请.{0,20}提供|提供.{0,20}说明|未提供|不清楚)/u.test(text) ? 'ANSWER_CLARIFICATION' : /(?:无法.{0,12}(?:访问|读取)|不能.{0,12}(?:访问|读取))/u.test(text) ? 'ANSWER_NO_ACCESS' : /(?:正在.{0,12}(?:读取|查看)|已.{0,12}(?:读取|查看))/u.test(text) ? 'ANSWER_EXECUTION_CLAIM' : 'ANSWER_OTHER');
          if (!text.includes(batch) || !facts.slice(start).some(fact => ['read', 'grep'].includes(fact.toolName) && fact.ok)) throw acceptanceError('DISK_ANSWER_MISSING');
        });
        await scenario('question_explicit', async start => {
          const text = requireSuccess(await turn('请查看项目中的 配置说明.txt，里面记录的批次编号是多少。'));
          if (!text.includes(batch) || !facts.slice(start).some(fact => ['read', 'grep'].includes(fact.toolName) && fact.ok)) throw acceptanceError('DISK_ANSWER_MISSING');
        });
        const permitKnownCommand = (commands: readonly string[]) => async (event: PermissionEvent) => {
          if (event.request.action !== 'bash' || resolve(event.request.cwd) !== resolve(authorizedRoot)
            || !commands.includes(event.request.command)) throw acceptanceError('UNEXPECTED_PERMISSION');
          await composition.coordinator.resolveFileAction(event.actionId, 'confirm');
        };
        await scenario('repair', async start => {
          requireSuccess(await turn('请先运行现有测试确认问题，再修好 sum.cjs 中的函数并重新测试。', {
            before: async () => assert.equal(await readFile(join(authorizedRoot, 'sum.cjs'), 'utf8'), broken),
            permission: permitKnownCommand(['npm test', 'npm run test', 'npm.cmd test', 'node test.cjs'])
          }));
          const exits = facts.slice(start).flatMap(fact => fact.exit === undefined ? [] : [fact.exit]);
          if (exits.length < 2 || exits[0] === 0 || exits.at(-1) !== 0) throw acceptanceError('TEST_EXIT_SEQUENCE_MISSING');
          verifyRepairedFunction(await readFile(join(authorizedRoot, 'sum.cjs'), 'utf8'));
          assert.equal(await readFile(join(authorizedRoot, 'test.cjs'), 'utf8'), testSource);
        });
        await scenario('reject', async () => {
          let rejected = false;
          assertRejectionCompleted(await turn('请删除项目里的 keep.txt 文件。', { permission: async event => {
            input.progress?.(`PERMISSION_${event.request.action.toUpperCase()}`);
            const expected = isExpectedDeletionPermission(event, authorizedRoot);
            await composition.coordinator.resolveFileAction(event.actionId, 'cancel');
            rejected ||= expected;
          } }));
          if (!rejected) throw acceptanceError('PERMISSION_NOT_OBSERVED');
          assert.equal(await readFile(join(authorizedRoot, 'keep.txt'), 'utf8'), kept);
        });
        await scenario('cancel', async () => {
          let cancelled = false;
          let pid = 0;
          const turnEvents = await turn('请运行项目现有的 build 脚本，观察它持续运行的状态。', {
            permission: permitKnownCommand(['npm run build', 'node watch.cjs']),
            tick: async () => {
              if (cancelled) return;
              let ready: string;
              try { ready = await readFile(join(authorizedRoot, 'ready.json'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
              pid = JSON.parse(ready).pid as number;
              if (!Number.isInteger(pid) || pid <= 0) throw acceptanceError('READY_INVALID');
              process.kill(pid, 0);
              cancelled = true;
              await composition.coordinator.cancelActive();
            }
          });
          if (!cancelled || !turnEvents.some(event => event.type === 'phase' && event.phase === 'cancelled')) throw acceptanceError('CANCEL_NOT_OBSERVED');
          try { process.kill(pid, 0); throw acceptanceError('COMMAND_STILL_RUNNING'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          const heartbeat = async () => readFile(join(authorizedRoot, 'heartbeat.txt'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
          const before = await heartbeat();
          await new Promise(resolve => setTimeout(resolve, 350));
          assert.equal(await heartbeat(), before);
        });
        if (input.verifyIsolation) Object.assign(result.checks, await input.verifyIsolation());
        result.phase = result.scenarios.every(item => item.phase === 'passed') ? (input.scenario ? 'partial' : 'passed') : 'failed';
        result.reasonCode = result.scenarios.find(item => item.phase === 'failed')?.reasonCode ?? null;
      }
    });
  } catch (error) { result.phase = 'failed'; result.reasonCode = stableAcceptanceError(error, 'ACCEPTANCE').message; }
  return result;
}

/** 只删除本次 mkdtemp 的真实根；必须先由上层完成模型与 Core 的关闭。 */
export async function removeAcceptanceRoot(root: string): Promise<void> {
  const actual = await realpath(root);
  const parent = await realpath(tmpdir());
  if (dirname(actual).toLowerCase() !== parent.toLowerCase() || !basename(actual).startsWith('ai-pet-')) throw acceptanceError('CLEANUP_ROOT_INVALID');
  await rm(actual, { recursive: true, force: true });
}

export async function runLocalModelAcceptance(input: AcceptanceInput, progress?: (stage: string) => void): Promise<AcceptanceResult> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-pet-real-local-model-acceptance-'));
  let observation: { deviceClass: string; offloadedLayers: number; totalLayers: number } | null = null;
  const runtime = new LocalModelRuntime({ root: input.resourceRoot, applicationVersion: input.applicationVersion,
    cachePath: join(temporaryRoot, 'model-hash-cache.json'), tokenRoot: join(temporaryRoot, 'tokens'),
    backendPreference: input.requestedBackend === 'cpu' ? 'cpu-only' : 'vulkan-only',
    acceptanceDiagnostics: { onVulkanOffloadObserved: value => { observation = value; } }
  });
  const localProvider = new LocalModelProvider(runtime);
  const catalog = [BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY];
  const registry = new ProviderRegistry(catalog, () => localProvider);
  let cloudFetchCalls = 0;
  let cloudSecretCalls = 0;
  let enabled = true;
  const cloudSettings = cloudProviderSettings();
  const local = new LocalModelService({ initialEnabled: true, runtime,
    readCloudProviderSettings: async () => structuredClone(cloudSettings), saveEnabled: async value => { enabled = value; },
    resetForConfigurationChange: async () => undefined, publishStatus: () => undefined
  });
  const createProvider = (profile: ProviderProfileV2) => registry.create(profile,
    async () => { cloudSecretCalls++; return 'acceptance-cloud-secret'; },
    async () => { cloudFetchCalls++; return cloudChatResponse(); });
  return runCodingModelAcceptance({ model: 'qwen', ...input, temporaryRoot, catalog,
    readSettings: () => local.providerSettingsSnapshot(), createProvider,
    createConnection: profile => createCodingModelConnection(profile, { catalog, localModel: runtime,
      readSecret: async () => { cloudSecretCalls++; throw acceptanceError('CLOUD_CALL_DETECTED'); } }),
    assertReady: profile => assertProviderReady(profile, runtime.getStatus()),
    start: async () => {
      await local.start();
      if (runtime.getStatus().backend !== input.requestedBackend) throw acceptanceError('BACKEND_MISMATCH');
      if (input.requestedBackend === 'vulkan') {
        await waitForVulkanOffload(() => observation !== null);
        if (observation?.deviceClass !== 'discrete' || observation.offloadedLayers !== observation.totalLayers) throw acceptanceError('GPU_OFFLOAD_INCOMPLETE');
      }
    }, close: () => local.close(), activeBackend: () => runtime.getStatus().backend as Backend | null,
    abortProvider: async () => {
      const abort = new AbortController();
      const response = localProvider.respond({ messages: [{ role: 'user', content: '这条验收请求会立即取消。' }], tools: [], toolChoice: 'none', reasoningMode: 'disabled' }, abort.signal);
      abort.abort();
      await response.then(() => { throw acceptanceError('PROVIDER_ABORT_FAILED'); }, error => { if (!(error instanceof Error) || error.name !== 'AbortError') throw acceptanceError('PROVIDER_ABORT_FAILED'); });
    },
    verifyIsolation: async () => {
      const cloudCallsZero = cloudFetchCalls === 0 && cloudSecretCalls === 0;
      if (!cloudCallsZero) throw acceptanceError('CLOUD_CALL_DETECTED');
      await local.setEnabled(false);
      const settings = await local.providerSettingsSnapshot();
      const profile = settings.profiles.find(value => value.id === settings.route.chatProfileId)!;
      await createProvider(profile).respond({ messages: [{ role: 'user', content: '你好' }], tools: [], toolChoice: 'none', reasoningMode: 'disabled' }, new AbortController().signal);
      if (enabled || cloudFetchCalls !== 1 || cloudSecretCalls !== 1) throw acceptanceError('CLOUD_ROUTE_RESTORE_FAILED');
      return { cloudCallsZero, cloudRouteRestored: true };
    }, ...(progress ? { progress } : {})
  });
}
