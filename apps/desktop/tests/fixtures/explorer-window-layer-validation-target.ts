export interface ExplorerValidationTarget {
  outerHwnd: string;
  switchRound: number;
}

export interface ExplorerValidationSample extends ExplorerValidationTarget {
  status: string;
  matchCount: number;
}

/** manual 给人工切换保留五分钟；smoke 仍保持固定短期限。 */
export function getExplorerLayerSwitchWindowMs(mode: 'manual' | 'smoke'): number {
  return mode === 'manual' ? 300_000 : 5_000;
}

/** ready 只表示候选可用；窗口与轮次也必须仍属于 A/B/A 已证明的同一目标。 */
export function isSameExplorerValidationTarget(
  sample: ExplorerValidationSample,
  target: ExplorerValidationTarget
): boolean {
  return sample.status === 'ready'
    && sample.matchCount === 1
    && sample.outerHwnd === target.outerHwnd
    && sample.switchRound === target.switchRound;
}

/** none 只有在探针同时证明目标 Explorer 仍为前台时，才属于负向目录证据。 */
export function isStrictNegativeExplorerEvidence(
  sample: ExplorerValidationSample,
  foregroundStillExplorer: boolean,
  expectedSwitchRound: number
): boolean {
  return sample.status === 'none'
    && sample.matchCount === 0
    && sample.outerHwnd === '0'
    && sample.switchRound === expectedSwitchRound
    && foregroundStillExplorer;
}

export type HiddenNegativeSampleDecision = 'wait' | 'pass' | 'fail';
export type SearchHiddenDwellDecision = 'wait' | 'probe-stable' | 'fail';
const SEARCH_HIDDEN_DWELL_MS = 2_000;

/** 已隐藏后只等待同一基线的稳定负向 none；任何前台或轮次漂移立即失败。 */
export function classifyHiddenNegativeExplorerSample(
  sample: ExplorerValidationSample,
  foregroundStillExplorer: boolean,
  target: ExplorerValidationTarget
): HiddenNegativeSampleDecision {
  if (!foregroundStillExplorer || sample.switchRound !== target.switchRound) return 'fail';
  if (isStrictNegativeExplorerEvidence(
    sample, foregroundStillExplorer, target.switchRound
  )) return 'pass';
  if (
    (sample.status === 'ambiguous' || sample.status === 'unavailable')
    && sample.matchCount === 0 && sample.outerHwnd === '0'
  ) return 'wait';
  if (isSameExplorerValidationTarget(sample, target)) return 'wait';
  return 'fail';
}

/** 搜索允许同轮次不确定态连续稳定两秒；单次瞬态和身份漂移均不能通过。 */
export function advanceSearchHiddenDwell(
  startedAt: number | undefined,
  probeCount: number,
  sample: ExplorerValidationSample,
  target: ExplorerValidationTarget,
  sampledAt: number,
  freshProbeSafe: boolean
): {
  decision: SearchHiddenDwellDecision;
  startedAt: number | undefined;
  probeCount: number;
} {
  if (sample.switchRound !== target.switchRound) {
    return { decision: 'fail', startedAt, probeCount };
  }
  if (isSameExplorerValidationTarget(sample, target)) {
    return { decision: 'wait', startedAt: undefined, probeCount: 0 };
  }
  if (
    (sample.status !== 'ambiguous' && sample.status !== 'unavailable')
    || sample.matchCount !== 0 || sample.outerHwnd !== '0'
  ) return { decision: 'fail', startedAt, probeCount };
  if (!freshProbeSafe) return { decision: 'fail', startedAt, probeCount };
  const stableStartedAt = startedAt ?? sampledAt;
  const nextProbeCount = probeCount + 1;
  return {
    decision: sampledAt - stableStartedAt >= SEARCH_HIDDEN_DWELL_MS && nextProbeCount >= 3
      ? 'probe-stable'
      : 'wait',
    startedAt: stableStartedAt,
    probeCount: nextProbeCount
  };
}

export interface QuickSwitchInternalSample extends ExplorerValidationSample {
  instanceId: string;
}

export interface QuickSwitchEvidenceState {
  failed: boolean;
  sampleCount: number;
  ambiguousCount: number;
  lastRound: number;
  lastInstanceId: string | undefined;
  sawIdentityChange: boolean;
}

export interface QuickSwitchAutoCompletionState extends QuickSwitchEvidenceState {
  stableAStartedAt: number | undefined;
  stableALastAt: number | undefined;
  stableACount: number;
  completed: boolean;
}

/** 快切只接受同一外层窗口的已知 ready，或不推进轮次的 ambiguous。 */
export function advanceQuickSwitchEvidence(
  state: QuickSwitchEvidenceState | undefined,
  sample: QuickSwitchInternalSample,
  target: ExplorerValidationTarget,
  knownInstances: ReadonlySet<string>
): QuickSwitchEvidenceState {
  const current = state ?? {
    failed: false,
    sampleCount: 0,
    ambiguousCount: 0,
    lastRound: target.switchRound,
    lastInstanceId: undefined,
    sawIdentityChange: false
  };
  if (current.failed) return current;
  const next = { ...current, sampleCount: current.sampleCount + 1 };
  if (sample.status === 'ambiguous') {
    if (
      sample.matchCount !== 0 || sample.outerHwnd !== '0'
      || sample.switchRound !== current.lastRound
    ) return { ...next, failed: true };
    return { ...next, ambiguousCount: current.ambiguousCount + 1 };
  }
  if (
    sample.status !== 'ready' || sample.matchCount !== 1
    || sample.outerHwnd !== target.outerHwnd
    || !knownInstances.has(sample.instanceId)
    || sample.switchRound < current.lastRound
    || sample.switchRound > current.lastRound + 1
    || (current.lastInstanceId !== undefined
      && ((sample.instanceId === current.lastInstanceId
        && sample.switchRound !== current.lastRound)
        || (sample.instanceId !== current.lastInstanceId
          && sample.switchRound !== current.lastRound + 1)))
  ) return { ...next, failed: true };
  return {
    ...next,
    lastRound: sample.switchRound,
    lastInstanceId: sample.instanceId,
    sawIdentityChange: current.sawIdentityChange || sample.switchRound > current.lastRound
  };
}

/** 快速切换必须先出现竞态证据，再由目标 A 在固定驻留期内连续稳定完成。 */
export function advanceQuickSwitchAutoCompletion(
  state: QuickSwitchAutoCompletionState | undefined,
  sample: QuickSwitchInternalSample,
  target: ExplorerValidationTarget,
  knownInstances: ReadonlySet<string>,
  finalA: { instanceId: string },
  sampledAt: number
): QuickSwitchAutoCompletionState {
  const current: QuickSwitchAutoCompletionState = state ?? {
    failed: false,
    sampleCount: 0,
    ambiguousCount: 0,
    lastRound: target.switchRound,
    lastInstanceId: finalA.instanceId,
    sawIdentityChange: false,
    stableAStartedAt: undefined,
    stableALastAt: undefined,
    stableACount: 0,
    completed: false
  };
  const evidence = advanceQuickSwitchEvidence(current, sample, target, knownInstances);
  if (evidence.failed) return { ...current, ...evidence, completed: false };

  const hasRaceEvidence = evidence.ambiguousCount > 0 || evidence.lastRound > target.switchRound;
  const isStableA = sample.status === 'ready'
    && sample.matchCount === 1
    && sample.outerHwnd === target.outerHwnd
    && sample.instanceId === finalA.instanceId;
  if (!hasRaceEvidence || !isStableA) {
    return {
      ...current, ...evidence,
      stableAStartedAt: undefined,
      stableALastAt: undefined,
      stableACount: 0,
      completed: false
    };
  }

  const samplingGapSafe = current.stableALastAt === undefined
    || sampledAt - current.stableALastAt <= 250;
  const stableAStartedAt = samplingGapSafe
    ? (current.stableAStartedAt ?? sampledAt)
    : sampledAt;
  const stableACount = samplingGapSafe ? current.stableACount + 1 : 1;
  return {
    ...current, ...evidence,
    stableAStartedAt,
    stableALastAt: sampledAt,
    stableACount,
    completed: stableACount >= 3 && sampledAt - stableAStartedAt >= 500
  };
}
