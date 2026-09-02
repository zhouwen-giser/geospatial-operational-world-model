import type { GeometryErrorCode, GeometryErrorPayload, GeometryOperation } from "./types.js";

export class GeometryServiceError extends Error {
  readonly code: GeometryErrorCode;
  readonly operation: GeometryOperation | undefined;
  readonly geometryIndex: number | undefined;
  readonly recoverable: boolean;
  readonly suggestion: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(payload: GeometryErrorPayload, options?: ErrorOptions) {
    super(payload.message, options);
    this.name = "GeometryServiceError";
    this.code = payload.code;
    this.operation = payload.operation;
    this.geometryIndex = payload.geometryIndex;
    this.recoverable = payload.recoverable;
    this.suggestion = payload.suggestion;
    this.details = payload.details;
  }

  toJSON(): { error: GeometryErrorPayload } {
    return {
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        ...(this.operation === undefined ? {} : { operation: this.operation }),
        ...(this.geometryIndex === undefined ? {} : { geometryIndex: this.geometryIndex }),
        ...(this.suggestion === undefined ? {} : { suggestion: this.suggestion }),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function asGeometryServiceError(error: unknown, operation?: GeometryOperation): GeometryServiceError {
  if (error instanceof GeometryServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const topology = lower.includes("topology") || lower.includes("side location conflict") || lower.includes("non-noded");
  return new GeometryServiceError(
    {
      code: topology ? "TOPOLOGY_EXCEPTION" : "ENGINE_ERROR",
      message,
      recoverable: topology,
      ...(operation === undefined ? {} : { operation }),
      ...(topology ? { suggestion: "Validate the input, call geometry.make_valid, or provide a precision grid." } : {}),
    },
    error instanceof Error ? { cause: error } : undefined,
  );
}
