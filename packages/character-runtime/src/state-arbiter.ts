import { taskPhaseSchema, type TaskPhase } from '@myself/shared-types';
import {
  createExtensionStateId,
  type CoreCharacterState,
  type ExtensionStateId
} from './character-schema';
import { characterStateFor } from './state-machine';

export type CharacterStateRequest =
  | { type: 'task'; phase: TaskPhase }
  | { type: 'movement'; carrying: boolean }
  | { type: 'extension'; stateId: ExtensionStateId }
  | { type: 'extension_complete' }
  | { type: 'reset' };

export type CharacterStateSnapshot =
  | { stateId: CoreCharacterState; source: 'system' }
  | { stateId: ExtensionStateId; source: 'extension' };

function invalidRequest(): never {
  throw new Error('CHARACTER_STATE_REQUEST_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExtensionStateId(value: unknown): value is ExtensionStateId {
  if (typeof value !== 'string' || !value.startsWith('custom:')) {
    return false;
  }

  try {
    return createExtensionStateId(value.slice('custom:'.length)) === value;
  } catch {
    return false;
  }
}

function validateRequest(request: CharacterStateRequest): void {
  if (!isRecord(request) || typeof request.type !== 'string') {
    invalidRequest();
  }

  if (request.type === 'task') {
    if (!taskPhaseSchema.safeParse(request.phase).success) invalidRequest();
    return;
  }

  if (request.type === 'movement') {
    if (typeof request.carrying !== 'boolean') invalidRequest();
    return;
  }

  if (request.type === 'extension') {
    if (!isExtensionStateId(request.stateId)) invalidRequest();
    return;
  }

  if (request.type !== 'extension_complete' && request.type !== 'reset') {
    invalidRequest();
  }
}

function systemSnapshot(stateId: CoreCharacterState): CharacterStateSnapshot {
  return { stateId, source: 'system' };
}

export function reduceCharacterState(
  snapshot: CharacterStateSnapshot,
  request: CharacterStateRequest
): CharacterStateSnapshot {
  validateRequest(request);

  if (request.type === 'task') {
    return systemSnapshot(characterStateFor(request.phase));
  }

  if (request.type === 'movement') {
    return systemSnapshot(request.carrying ? 'carrying' : 'moving');
  }

  if (request.type === 'extension') {
    if (snapshot.source === 'system' && snapshot.stateId !== 'idle') {
      return snapshot;
    }

    return { stateId: request.stateId, source: 'extension' };
  }

  if (request.type === 'extension_complete') {
    return snapshot.source === 'extension'
      ? systemSnapshot('idle')
      : snapshot;
  }

  return systemSnapshot('idle');
}
