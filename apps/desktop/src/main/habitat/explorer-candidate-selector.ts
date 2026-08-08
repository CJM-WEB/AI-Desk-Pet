export type ExplorerCandidateMatch =
  | { status: 'matched'; directoryId: string }
  | { status: 'hidden' };

export interface ExplorerCandidate {
  candidateId: string;
  hwnd: string;
  activationSequence: number;
  observedAt: number;
  expiresAt: number;
  foreground: boolean;
  minimized: boolean;
  search: boolean;
  ambiguous: boolean;
  match: ExplorerCandidateMatch;
}

export interface ExplorerCandidateFrame {
  instanceId: string;
  sequence: number;
  foregroundHwnd: string;
  now: number;
  destroyed: boolean;
  candidates: readonly ExplorerCandidate[];
}

export interface ExplorerCandidateBinding {
  instanceId: string;
  hwnd: string;
  sequence: number;
  activationSequence: number;
  directoryId: string;
}

export type ExplorerCandidateSelection =
  | { status: 'hidden' }
  | { status: 'selected'; binding: ExplorerCandidateBinding };

export interface ExplorerCandidateSelectionInput {
  activeInstanceId: string;
  frame: ExplorerCandidateFrame;
  previous?: ExplorerCandidateBinding;
}

const HIDDEN_SELECTION = { status: 'hidden' } as const;
const HWND_PATTERN = /^[1-9][0-9]{0,19}$/u;

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function candidateFingerprint(candidate: ExplorerCandidate): string {
  const match = candidate.match.status === 'matched'
    ? `matched:${candidate.match.directoryId}`
    : 'hidden';
  return [
    candidate.hwnd,
    candidate.activationSequence,
    candidate.observedAt,
    candidate.expiresAt,
    candidate.foreground,
    candidate.minimized,
    candidate.search,
    candidate.ambiguous,
    match
  ].join('\0');
}

function hasConflictingFacts(candidates: readonly ExplorerCandidate[]): boolean {
  const facts = new Map<string, string>();
  for (const candidate of candidates) {
    const fingerprint = candidateFingerprint(candidate);
    const existing = facts.get(candidate.candidateId);
    if (existing !== undefined && existing !== fingerprint) return true;
    facts.set(candidate.candidateId, fingerprint);
  }
  return false;
}

function isEligibleCandidate(
  candidate: ExplorerCandidate,
  frame: ExplorerCandidateFrame
): candidate is ExplorerCandidate & { match: { status: 'matched'; directoryId: string } } {
  return candidate.match.status === 'matched'
    && candidate.match.directoryId.length > 0
    && candidate.foreground
    && !candidate.minimized
    && !candidate.search
    && !candidate.ambiguous
    && HWND_PATTERN.test(candidate.hwnd)
    && candidate.hwnd === frame.foregroundHwnd
    && isSequence(candidate.activationSequence)
    && Number.isFinite(candidate.observedAt)
    && Number.isFinite(candidate.expiresAt)
    && candidate.observedAt <= frame.now
    && candidate.expiresAt > frame.now;
}

/**
 * 仅依据桥接事实和已解析身份选择候选；函数自身不访问文件系统或持久化层。
 */
export function selectExplorerCandidate(
  input: ExplorerCandidateSelectionInput
): ExplorerCandidateSelection {
  const { activeInstanceId, frame, previous } = input;
  if (
    frame.destroyed
    || frame.instanceId !== activeInstanceId
    || !isSequence(frame.sequence)
    || !Number.isFinite(frame.now)
    || !HWND_PATTERN.test(frame.foregroundHwnd)
    || hasConflictingFacts(frame.candidates)
  ) return HIDDEN_SELECTION;

  if (previous?.instanceId === frame.instanceId) {
    if (frame.sequence <= previous.sequence || frame.foregroundHwnd !== previous.hwnd) {
      return HIDDEN_SELECTION;
    }
  }

  const eligible = frame.candidates.filter(candidate => isEligibleCandidate(candidate, frame));
  if (eligible.length === 0) return HIDDEN_SELECTION;

  const maximumActivation = Math.max(...eligible.map(candidate => candidate.activationSequence));
  const latest = eligible.filter(candidate => candidate.activationSequence === maximumActivation);
  if (latest.length !== 1) return HIDDEN_SELECTION;

  const selected = latest[0]!;
  return {
    status: 'selected',
    binding: {
      instanceId: frame.instanceId,
      hwnd: selected.hwnd,
      sequence: frame.sequence,
      activationSequence: selected.activationSequence,
      directoryId: selected.match.directoryId
    }
  };
}
