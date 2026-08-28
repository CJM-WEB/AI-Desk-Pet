import { isRootRelativePathInput } from '@myself/file-tools';
import type { FilePlanningOperation } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type { AgentTrustedToolResult } from '../agent/agent-service';

const 最大可信引用数 = 16;
const 最大可信转录数 = 32;
const 事务滑动过期毫秒 = 10 * 60 * 1_000;

export type CapabilityTransactionPhase =
  | 'planning'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'running'
  | 'completed'
  | 'failed';

export type TrustedFileReference = Readonly<{
  role: 'created' | 'read' | 'moved_source' | 'moved_target' | 'deleted';
  relativePath: string;
}>;

export type CapabilityTransactionIdentity = Readonly<{
  id: string;
  generation: string;
  kind: 'file' | 'powershell';
  profileId: string;
  capabilityRevision: string;
}>;

type CapabilityTransactionExpectedOperation = FilePlanningOperation | 'powershell';

export type CapabilityTransactionInvalidation =
  | 'new_task'
  | 'generation_changed'
  | 'provider_changed'
  | 'authorization_root_changed'
  | 'configuration_changed'
  | 'new_conversation'
  | 'closed';

export type CapabilityTransactionSnapshot = CapabilityTransactionIdentity & Readonly<{
  phase: CapabilityTransactionPhase;
  warningCodes: readonly string[];
  toolTranscript: readonly Readonly<{
    toolName: string;
    ok: boolean;
    resultCode: 'OK' | 'FAILED';
  }>[];
  references: readonly TrustedFileReference[];
}>;

type MutableTransaction = CapabilityTransactionIdentity & {
  phase: CapabilityTransactionPhase;
  toolTranscript: Array<{
    toolName: string;
    ok: boolean;
    resultCode: 'OK' | 'FAILED';
  }>;
  references: TrustedFileReference[];
  warningCodes: string[];
  lastTrustedResultOk: boolean | null;
  expectedOperation: CapabilityTransactionExpectedOperation | null;
  expectedOperationSatisfied: boolean;
  lastUpdatedAtMs: number;
};

interface CapabilityTransactionStoreOptions {
  now?: () => number;
}

/** Main 私有短生命周期事务；公开模型文字从不产生本地文件事实。 */
export class CapabilityTransactionStore {
  private readonly now: () => number;
  private current: MutableTransaction | null = null;

  constructor(options: CapabilityTransactionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  begin(
    input: CapabilityTransactionIdentity,
    options: Readonly<{ expectedOperation?: CapabilityTransactionExpectedOperation }> = {}
  ): void {
    this.current = {
      ...input,
      phase: 'planning',
      toolTranscript: [],
      references: [],
      warningCodes: [],
      lastTrustedResultOk: null,
      expectedOperation: options.expectedOperation ?? null,
      expectedOperationSatisfied: options.expectedOperation === undefined,
      lastUpdatedAtMs: this.now()
    };
  }

  /** 新能力回合保留短期引用，但不继承上一回合的成败事实。 */
  beginTurn(
    options: Readonly<{ expectedOperation?: CapabilityTransactionExpectedOperation }> = {}
  ): void {
    this.expireIfNeeded();
    const current = this.current;
    if (current === null) return;
    current.phase = 'planning';
    current.warningCodes = [];
    current.lastTrustedResultOk = null;
    current.expectedOperation = options.expectedOperation ?? null;
    current.expectedOperationSatisfied = options.expectedOperation === undefined;
    current.lastUpdatedAtMs = this.now();
  }

  apply(
    event: TaskEvent | AgentTrustedToolResult | Readonly<{ type: 'clarification' }>
  ): void {
    this.expireIfNeeded();
    const current = this.current;
    if (current === null) return;
    if ('toolName' in event) {
      this.applyTrustedToolResult(current, event);
      current.lastUpdatedAtMs = this.now();
      return;
    }
    if (event.type === 'clarification') {
      current.phase = 'awaiting_clarification';
      current.lastUpdatedAtMs = this.now();
      return;
    }
    if (event.type === 'pending_action') {
      current.phase = 'awaiting_confirmation';
      current.lastUpdatedAtMs = this.now();
      return;
    }
    if (event.type === 'error') {
      if (
        isSummaryWarning(event.code)
        && current.lastTrustedResultOk === true
        && current.expectedOperationSatisfied
      ) {
        if (!current.warningCodes.includes(event.code)) current.warningCodes.push(event.code);
        current.phase = 'completed';
      } else {
        current.phase = 'failed';
      }
      current.lastUpdatedAtMs = this.now();
      return;
    }
    if (event.type !== 'phase') return;
    switch (event.phase) {
      case 'listening':
      case 'thinking':
        if (current.phase !== 'failed' && current.phase !== 'completed') {
          current.phase = 'planning';
        }
        current.lastUpdatedAtMs = this.now();
        return;
      case 'awaiting_confirmation':
        current.phase = 'awaiting_confirmation';
        current.lastUpdatedAtMs = this.now();
        return;
      case 'acting':
        current.phase = 'running';
        current.lastUpdatedAtMs = this.now();
        return;
      case 'success':
        if (current.lastTrustedResultOk === true
          && current.phase !== 'failed'
          && current.expectedOperationSatisfied) {
          current.phase = 'completed';
        } else if (current.lastTrustedResultOk === true && current.phase !== 'failed') {
          current.phase = 'failed';
        }
        current.lastUpdatedAtMs = this.now();
        return;
      case 'error':
        if (
          current.warningCodes.length > 0
          && current.lastTrustedResultOk === true
          && current.expectedOperationSatisfied
        ) {
          current.phase = 'completed';
          current.lastUpdatedAtMs = this.now();
          return;
        }
        current.phase = 'failed';
        current.lastUpdatedAtMs = this.now();
        return;
      case 'cancelled':
        current.phase = 'failed';
        current.lastUpdatedAtMs = this.now();
        return;
      case 'idle':
        return;
    }
  }

  classifyFollowUp(text: string): 'continue' | 'retry' | 'status' | 'none' {
    this.expireIfNeeded();
    if (this.current === null) return 'none';
    const normalized = text.normalize('NFKC').trim().toLocaleLowerCase();
    if (/^(?:继续(?:执行)?|接着(?:执行)?|continue|go on)[。！!]?$/u.test(normalized)) {
      return 'continue';
    }
    if (/^(?:重试|retry)[。！!]?$/u.test(normalized)) {
      return 'retry';
    }
    if (/^(?:成功了吗|完成了吗|执行成功了吗|成功没|did it succeed|is it done)[？?。]?$/.test(normalized)) {
      return 'status';
    }
    if (blocksFollowUpByShape(normalized)) return 'none';
    return 'none';
  }

  snapshot(): CapabilityTransactionSnapshot | null {
    this.expireIfNeeded();
    const current = this.current;
    if (current === null) return null;
    return Object.freeze({
      id: current.id,
      generation: current.generation,
      kind: current.kind,
      profileId: current.profileId,
      capabilityRevision: current.capabilityRevision,
      phase: current.phase,
      warningCodes: Object.freeze([...current.warningCodes]),
      toolTranscript: Object.freeze(current.toolTranscript.map(item => Object.freeze({ ...item }))),
      references: Object.freeze(current.references.map(item => Object.freeze({ ...item })))
    });
  }

  invalidate(_reason: CapabilityTransactionInvalidation): void {
    this.current = null;
  }

  private applyTrustedToolResult(
    current: MutableTransaction,
    result: AgentTrustedToolResult
  ): void {
    current.toolTranscript.push({
      toolName: result.toolName,
      ok: result.ok,
      resultCode: result.ok ? 'OK' : 'FAILED'
    });
    if (current.toolTranscript.length > 最大可信转录数) current.toolTranscript.shift();
    if (!result.ok) {
      current.lastTrustedResultOk = false;
      current.phase = 'failed';
      return;
    }
    current.lastTrustedResultOk = true;
    if (
      current.expectedOperation === null
      || matchesExpectedOperation(current.expectedOperation, result.toolName)
    ) current.expectedOperationSatisfied = true;
    current.warningCodes = [];
    current.phase = 'running';
    for (const reference of referencesForResult(result)) {
      const existingIndex = current.references.findIndex(existing =>
        existing.relativePath === reference.relativePath
        && existing.role === reference.role);
      if (existingIndex >= 0) current.references.splice(existingIndex, 1);
      current.references.push(reference);
      if (current.references.length > 最大可信引用数) current.references.shift();
    }
  }

  private expireIfNeeded(): void {
    const current = this.current;
    if (current === null) return;
    if (this.now() - current.lastUpdatedAtMs > 事务滑动过期毫秒) {
      this.current = null;
    }
  }
}

function isSummaryWarning(code: string): boolean {
  return code === 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE'
    || code === 'PROVIDER_SUMMARY_FAILED_AFTER_CAPABILITY_RESULT';
}

function referencesForResult(result: AgentTrustedToolResult): readonly TrustedFileReference[] {
  const paths = result.relativePaths.filter(path => isRootRelativePathInput(path));
  const toolName = result.toolName.split('.').at(-1) ?? result.toolName;
  if (toolName === 'move_file') {
    return [
      ...(paths[0] === undefined ? [] : [{ role: 'moved_source' as const, relativePath: paths[0] }]),
      ...(paths[1] === undefined ? [] : [{ role: 'moved_target' as const, relativePath: paths[1] }])
    ];
  }
  const role = toolName === 'create_file' || toolName === 'create_directory'
    ? 'created'
    : toolName === 'delete_file'
      ? 'deleted'
      : 'read';
  return paths.map(relativePath => ({ role, relativePath }));
}

function blocksFollowUpByShape(text: string): boolean {
  return /^(?:>|[`'"“‘’]|~~~|引用)/u.test(text)
    || /(?:^|\n)[ \t]*(?:```|~~~)/u.test(text)
    || /^(?:不要|不用|不必|无需|不需要|别|never\b|do\s+not\b|don't\b)/u.test(text);
}

function matchesExpectedOperation(
  expectedOperation: CapabilityTransactionExpectedOperation,
  toolName: string
): boolean {
  return normalizeOperationName(toolName) === expectedOperation;
}

function normalizeOperationName(toolName: string): string {
  const leaf = toolName.split('.').at(-1) ?? toolName;
  if (leaf === 'read_text' || leaf === 'read_text_file') return 'read_file';
  if (leaf === 'list_directory') return 'list_files';
  return leaf;
}
