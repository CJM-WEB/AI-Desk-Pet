import type { ProviderProfileV2 } from '@myself/shared-types';
import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';
import { isBuiltinLocalProviderProfile } from '../local-model/local-model-route';

const modelRouteConfigurationErrors = new Set([
  'MODEL_ROUTE_NOT_CONFIGURED',
  'MODEL_PROFILE_NOT_FOUND',
  'MODEL_CAPABILITY_REQUIRED',
  'MODEL_PROVIDER_NOT_FOUND',
  'MODEL_MODEL_NOT_FOUND'
]);

export function settingsIncompleteError(): Error {
  return Object.assign(new Error('SETTINGS_INCOMPLETE'), { code: 'SETTINGS_INCOMPLETE' });
}

export function normalizeModelRoutePreflightError(error: unknown): Error {
  // 模型路由缺失属于首次对话前可由设置页修复的配置问题。
  if (error instanceof Error && modelRouteConfigurationErrors.has(error.message)) {
    return settingsIncompleteError();
  }

  return error instanceof Error ? error : new Error('AGENT_INTERNAL_ERROR');
}

type LocalModelReadinessCode =
  | 'LOCAL_MODEL_LOADING'
  | 'LOCAL_MODEL_FAULTED'
  | 'LOCAL_MODEL_DISABLED';

function readinessError(code: LocalModelReadinessCode): Error {
  return Object.assign(new Error(code), { code });
}

/** 云档案沿用 Secret 前置条件；固定本地档案只信任 Main Runtime 的公开就绪态。 */
export function assertProviderReady(
  profile: ProviderProfileV2,
  localModelStatus: LocalModelPublicStatus
): void {
  if (!isBuiltinLocalProviderProfile(profile)) {
    if (!profile.hasStoredSecret) throw settingsIncompleteError();
    return;
  }
  if (localModelStatus.phase === 'ready') return;
  if (localModelStatus.phase === 'faulted') throw readinessError('LOCAL_MODEL_FAULTED');
  if (localModelStatus.phase === 'validating' || localModelStatus.phase === 'loading') {
    throw readinessError('LOCAL_MODEL_LOADING');
  }
  throw readinessError('LOCAL_MODEL_DISABLED');
}
