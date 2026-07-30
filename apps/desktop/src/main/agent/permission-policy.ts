import type { ToolDecision, ToolRisk } from '@myself/agent-core';

export interface PermissionPolicyOptions {
  highRiskEnabled: boolean;
}

export class PermissionPolicy {
  private readonly highRiskEnabled: boolean;

  constructor(options: PermissionPolicyOptions) {
    this.highRiskEnabled = options.highRiskEnabled;
  }

  decide(risk: ToolRisk): ToolDecision {
    if (risk === 'read') return 'allow';
    if (risk === 'recoverable') return 'confirm';
    return this.highRiskEnabled ? 'confirm' : 'deny';
  }
}
