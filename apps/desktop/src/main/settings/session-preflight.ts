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
