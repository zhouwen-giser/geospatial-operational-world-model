export const PROVIDER_ERROR_CODES = [
  "INVALID_REQUEST",
  "SCHEMA_MISMATCH",
  "OPERATION_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "PROVIDER_NOT_READY",
  "SCOPE_REQUIRED",
  "SCOPE_DENIED",
  "DEADLINE_EXCEEDED",
  "BUDGET_EXCEEDED",
  "IDEMPOTENCY_CONFLICT",
  "OVERLOADED",
  "INTERNAL_PROVIDER_ERROR"
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ProviderErrorCode, number> = {
  INVALID_REQUEST: 422,
  SCHEMA_MISMATCH: 422,
  OPERATION_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  PROVIDER_NOT_READY: 503,
  SCOPE_REQUIRED: 403,
  SCOPE_DENIED: 403,
  DEADLINE_EXCEEDED: 504,
  BUDGET_EXCEEDED: 413,
  IDEMPOTENCY_CONFLICT: 409,
  OVERLOADED: 429,
  INTERNAL_PROVIDER_ERROR: 500
};

export class ProviderProtocolError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Readonly<Record<string, unknown>>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderProtocolError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? ["PROVIDER_NOT_READY", "DEADLINE_EXCEEDED", "OVERLOADED"].includes(code);
    if (options.details !== undefined) this.details = options.details;
  }
}

export function mapProviderError(error: unknown): ProviderProtocolError {
  if (error instanceof ProviderProtocolError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderProtocolError("DEADLINE_EXCEEDED", "provider execution deadline exceeded", { cause: error });
  }
  return new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "provider execution failed", { cause: error });
}
