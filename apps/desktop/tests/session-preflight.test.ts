import { describe, expect, it } from 'vitest';

import { normalizeModelRoutePreflightError } from '../src/main/settings/session-preflight';

describe('模型会话预检', () => {
  it('将未配置的模型路由映射为设置未完成', () => {
    const error = normalizeModelRoutePreflightError(new Error('MODEL_ROUTE_NOT_CONFIGURED'));

    expect(error).toMatchObject({
      message: 'SETTINGS_INCOMPLETE',
      code: 'SETTINGS_INCOMPLETE',
    });
  });

  it.each([
    'MODEL_PROFILE_NOT_FOUND',
    'MODEL_CAPABILITY_REQUIRED',
    'MODEL_PROVIDER_NOT_FOUND',
    'MODEL_MODEL_NOT_FOUND'
  ])('将模型路由构造与选择错误 %s 映射为设置未完成', (code) => {
    expect(normalizeModelRoutePreflightError(new Error(code))).toMatchObject({
      message: 'SETTINGS_INCOMPLETE',
      code: 'SETTINGS_INCOMPLETE'
    });
  });

  it('保留非路由配置错误以便正常诊断', () => {
    const original = new Error('NETWORK_UNAVAILABLE');

    expect(normalizeModelRoutePreflightError(original)).toBe(original);
  });
});
