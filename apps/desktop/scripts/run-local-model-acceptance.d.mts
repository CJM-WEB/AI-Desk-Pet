export type AcceptanceBackend = 'cpu' | 'vulkan';

export interface AcceptanceChecks {
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
  moveOperation: boolean;
  deleteOperation: boolean;
  chineseRelativePath: boolean;
  clarification: boolean;
  userRejected: boolean;
  toolFailureRecovery: boolean;
}

export interface AcceptanceResult {
  requestedBackend: AcceptanceBackend;
  activeBackend: AcceptanceBackend;
  phase: 'passed';
  reasonCode: null;
  checks: AcceptanceChecks;
  [key: string]: unknown;
}

export function parseAcceptanceArguments(arguments_: string[]): { backend: AcceptanceBackend };
export function createAcceptanceRecord(result: AcceptanceResult): Readonly<{
  schemaVersion: 1;
  requestedBackend: AcceptanceBackend;
  activeBackend: AcceptanceBackend;
  phase: AcceptanceResult['phase'];
  reasonCode: AcceptanceResult['reasonCode'];
  toolName: 'create_file';
  checks: AcceptanceChecks;
}>;
