import { isRootRelativePathInput } from '@myself/file-tools';
import type { TaskEvent } from '@myself/shared-types';
import type { AgentTrustedToolResult } from '../agent/agent-service';

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
  providerId: string;
  authorizationRootId: string;
}>;

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
  hasSuccessfulToolResult: boolean;
};

/** Main 私有短生命周期事务；公开模型文字从不产生本地文件事实。 */
export class CapabilityTransactionStore {
  private current: MutableTransaction | null = null;

  begin(input: CapabilityTransactionIdentity): void {
    this.current = {
      ...input,
      phase: 'planning',
      toolTranscript: [],
      references: [],
      hasSuccessfulToolResult: false
    };
  }

  apply(event: TaskEvent | AgentTrustedToolResult | Readonly<{ type: 'clarification' }>): void {
    const current = this.current;
    if (current === null) return;
    if ('toolName' in event) {
      this.applyTrustedToolResult(current, event);
      return;
    }
    if (event.type === 'clarification') {
      current.phase = 'awaiting_clarification';
      return;
    }
    if (event.type === 'pending_action') {
      current.phase = 'awaiting_confirmation';
      return;
    }
    if (event.type !== 'phase') return;
    switch (event.phase) {
      case 'listening':
      case 'thinking':
        if (current.phase !== 'failed' && current.phase !== 'completed') {
          current.phase = 'planning';
        }
        return;
      case 'awaiting_confirmation':
        current.phase = 'awaiting_confirmation';
        return;
      case 'acting':
        current.phase = 'running';
        return;
      case 'success':
        if (current.hasSuccessfulToolResult && current.phase !== 'failed') {
          current.phase = 'completed';
        }
        return;
      case 'error':
      case 'cancelled':
        current.phase = 'failed';
        return;
      case 'idle':
        return;
    }
  }

  classifyFollowUp(text: string): 'continue' | 'status' | 'new_task' | 'none' {
    const normalized = text.normalize('NFKC').trim().toLocaleLowerCase();
    if (/^(?:继续(?:执行)?|接着(?:执行)?|continue|go on)[。！!]?$/u.test(normalized)) {
      return 'continue';
    }
    if (/^(?:成功了吗|完成了吗|执行成功了吗|成功没|did it succeed|is it done)[？?。]?$/.test(normalized)) {
      return 'status';
    }
    if (/(?:刚(?:创建|读取|移动|修改|删除)的|那个文件|这个文件|它)/u.test(normalized)
      && /(?:读取|修改|编辑|移动|删除|内容|read|edit|move|delete)/u.test(normalized)) {
      return 'continue';
    }
    if (/(?:创建|新建|读取|列出|修改|编辑|移动|删除|搜索|create|read|list|edit|move|delete)/u.test(normalized)) {
      return 'new_task';
    }
    return 'none';
  }

  snapshot(): CapabilityTransactionSnapshot | null {
    const current = this.current;
    if (current === null) return null;
    return Object.freeze({
      id: current.id,
      generation: current.generation,
      kind: current.kind,
      providerId: current.providerId,
      authorizationRootId: current.authorizationRootId,
      phase: current.phase,
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
    if (!result.ok) {
      current.phase = 'failed';
      return;
    }
    current.hasSuccessfulToolResult = true;
    current.phase = 'running';
    for (const reference of referencesForResult(result)) {
      if (!current.references.some(existing => existing.role === reference.role
        && existing.relativePath === reference.relativePath)) {
        current.references.push(reference);
      }
    }
  }
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
