export type HabitatErrorCode =
  | 'HABITAT_CLOSED'
  | 'HABITAT_OPERATION_BUSY'
  | 'HABITAT_STATE_INVALID'
  | 'HABITAT_ENTRY_BLOCKED'
  | 'HABITAT_AUTOMATION_BLOCKED'
  | 'HABITAT_DIRECTORY_NOT_FOUND'
  | 'HABITAT_DIRECTORY_UNAVAILABLE'
  | 'HABITAT_OBSERVER_FAILED'
  | 'HABITAT_SUMMON_FAILED'
  | 'HABITAT_WINDOW_FAILED';

/** 仅向 Main 调用方暴露稳定错误码，不携带私有路径或窗口事实。 */
export class HabitatServiceError extends Error {
  constructor(readonly code: HabitatErrorCode) {
    super(code);
    this.name = 'HabitatServiceError';
  }
}

export function habitatError(code: HabitatErrorCode): HabitatServiceError {
  return new HabitatServiceError(code);
}
