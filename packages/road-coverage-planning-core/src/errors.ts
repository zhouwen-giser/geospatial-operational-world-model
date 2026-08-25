export type CoveragePlanningErrorCode =
  | "INVALID_AREA"
  | "INVALID_SELECTION_POLICY"
  | "VERSION_NOT_FOUND"
  | "SCOPE_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "NO_OBLIGATIONS"
  | "CAPABILITY_NOT_AVAILABLE"
  | "DATABASE_UNAVAILABLE";

export class CoveragePlanningError extends Error {
  readonly code: CoveragePlanningErrorCode;
  readonly retryable: boolean;

  constructor(code: CoveragePlanningErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoveragePlanningError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
