import type { FoundationProcessingReceipt } from "./types.js";

export type FoundationErrorCode =
  | "FOUNDATION_INVALID_INPUT"
  | "FOUNDATION_GEOMETRY_INVALID"
  | "FOUNDATION_REPAIR_POLICY_DENIED"
  | "FOUNDATION_CRS_TRANSFORMATION_UNAVAILABLE"
  | "FOUNDATION_H3_INVALID_RESOLUTION"
  | "FOUNDATION_H3_INVALID_COORDINATE"
  | "FOUNDATION_LOCAL_ENGINE_FAILURE"
  | "FOUNDATION_INVALID_ENGINE_RESULT"
  | "FOUNDATION_SCHEMA_HASH_MISMATCH"
  | "FOUNDATION_RECEIPT_FAILURE";

export type FoundationErrorStage =
  | "REQUEST_VALIDATION"
  | "POLICY"
  | "PROVIDER_EXECUTION"
  | "SNAPSHOT"
  | "RESULT_ASSEMBLY";

export interface FoundationPortErrorOptions {
  stage: FoundationErrorStage;
  retryable: boolean;
  details?: Record<string, unknown>;
  receipt?: FoundationProcessingReceipt;
  cause?: unknown;
}

export class FoundationPortError extends Error {
  readonly code: FoundationErrorCode;
  readonly stage: FoundationErrorStage;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly receipt?: FoundationProcessingReceipt;

  constructor(code: FoundationErrorCode, message: string, options: FoundationPortErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FoundationPortError";
    this.code = code;
    this.stage = options.stage;
    this.retryable = options.retryable;
    if (options.details !== undefined) this.details = options.details;
    if (options.receipt !== undefined) this.receipt = options.receipt;
  }

  toPlatformError(requestId: string): {
    schemaVersion: "1.0";
    requestId: string;
    error: {
      code: string;
      message: string;
      retryable: boolean;
      stage: FoundationErrorStage;
      details?: Record<string, unknown>;
    };
  } {
    return {
      schemaVersion: "1.0",
      requestId,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        stage: this.stage,
        ...(this.details === undefined ? {} : { details: this.details })
      }
    };
  }
}

export function asFoundationEngineError(error: unknown, operationId: string): FoundationPortError {
  if (error instanceof FoundationPortError) return error;
  return new FoundationPortError(
    "FOUNDATION_LOCAL_ENGINE_FAILURE",
    `Local engine failed while executing ${operationId}`,
    {
      stage: "PROVIDER_EXECUTION",
      retryable: true,
      details: { operationId },
      cause: error
    }
  );
}
