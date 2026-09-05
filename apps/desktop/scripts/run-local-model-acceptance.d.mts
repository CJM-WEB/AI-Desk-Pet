export type AcceptanceBackend = 'cpu' | 'vulkan';
export interface AcceptanceScenario {
  name: 'read' | 'question' | 'question_explicit' | 'repair' | 'reject' | 'cancel';
  phase: 'passed' | 'failed';
  reasonCode: string | null;
  operations: number;
  exits: number[];
}
export interface AcceptanceResult {
  selection: 'all' | AcceptanceScenario['name'];
  model: 'qwen' | 'deepseek';
  modelId: string;
  requestedBackend: AcceptanceBackend | null;
  activeBackend: AcceptanceBackend | null;
  phase: 'passed' | 'failed' | 'partial';
  reasonCode: string | null;
  cleanup: boolean;
  checks: { chineseChat: boolean; providerAbortRecovery: boolean; cloudCallsZero: boolean; cloudRouteRestored: boolean };
  scenarios: AcceptanceScenario[];
}
export type AcceptanceArguments = { scenario?: AcceptanceScenario['name'] } & ({ model: 'qwen'; backend: AcceptanceBackend } | { model: 'deepseek'; profileId: string; userData: string });
export function parseAcceptanceArguments(arguments_: string[]): AcceptanceArguments;
export function createAcceptanceRecord(result: AcceptanceResult): AcceptanceResult & { schemaVersion: 2 };

export function buildAcceptanceBundle(scriptDirectory: string, outputFile: string, model: string): Promise<void>;
