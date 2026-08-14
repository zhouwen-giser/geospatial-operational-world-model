import type { ZodIssue } from 'zod';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'DATA_SCOPE_FORBIDDEN'
  | 'AMBIGUOUS_VERSION'
  | 'CRS_MISMATCH'
  | 'UNSUPPORTED_INTERPOLATION'
  | 'UNSUPPORTED_DIMENSION'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_UNCERTAINTY_MODEL'
  | 'UNSUPPORTED_REACHABILITY_LEVEL'
  | 'INSUFFICIENT_QUALITY'
  | 'INSUFFICIENT_PROVENANCE'
  | 'TOO_MANY_RESULTS'
  | 'TOO_MANY_CANDIDATES'
  | 'RESPONSE_TOO_LARGE'
  | 'QUERY_BUDGET_EXCEEDED'
  | 'DEADLINE_EXCEEDED'
  | 'SNAPSHOT_NOT_AVAILABLE'
  | 'ASYNC_JOBS_NOT_IMPLEMENTED'
  | 'NOT_IMPLEMENTED'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly title: string,
    detail: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(detail);
    this.name = 'AppError';
  }
}

export function validationError(issues: ZodIssue[]): AppError {
  return new AppError('INVALID_ARGUMENT', 400, 'Invalid request', 'The request does not satisfy the tool contract.', {
    invalidParams: issues.map((issue) => ({
      name: issue.path.join('.'),
      reason: issue.message,
    })),
  });
}

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
  statusCode?: number;
}

export function mapDatabaseError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const pgError = error as PgLikeError;
  if (pgError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new AppError('RESPONSE_TOO_LARGE', 413, 'Request body too large', 'The request body exceeds the synchronous canonical-ingestion limit.');
  }
  if (pgError.code === 'FST_ERR_NOT_FOUND' || pgError.statusCode === 404) {
    return new AppError('NOT_FOUND', 404, 'Route not found', pgError.message ?? 'No route matches this request.');
  }
  if (pgError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new AppError('INVALID_ARGUMENT', 415, 'Unsupported media type', pgError.message ?? 'The request content type is not supported.');
  }
  if (pgError.code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' || pgError.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new AppError('INVALID_ARGUMENT', 400, 'Invalid request body', pgError.message ?? 'The request body is missing or has an invalid content length.');
  }
  if (pgError.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return new AppError('INVALID_ARGUMENT', 400, 'Invalid JSON request', pgError.message ?? 'The request body is invalid.');
  }
  if (pgError.code === 'FST_ERR_VALIDATION') {
    return new AppError('INVALID_ARGUMENT', 400, 'Invalid request', pgError.message ?? 'The request does not satisfy the route contract.');
  }
  if (pgError.code === '57014') {
    return new AppError('DEADLINE_EXCEEDED', 504, 'Deadline exceeded', 'The database cancelled the query at its deadline.');
  }
  if (pgError.code === '40001' || pgError.code === '40P01') {
    return new AppError(
      'DATABASE_UNAVAILABLE',
      503,
      'Transaction retry required',
      'A concurrent serializable transaction must be retried from a fresh snapshot.',
      { sqlstate: pgError.code, retryableTransaction: true },
    );
  }
  if (pgError.code === '23503') {
    return new AppError('INVALID_ARGUMENT', 409, 'Invalid reference', 'A referenced immutable input does not exist or belongs to another owner.', {
      constraint: pgError.constraint,
    });
  }
  if (pgError.code === '22023' || pgError.code === '22P02' || pgError.code === '23514') {
    return new AppError('INVALID_ARGUMENT', 400, 'Database input rejected', pgError.message ?? 'A typed database input or invariant is invalid.', {
      constraint: pgError.constraint,
    });
  }
  if (pgError.code === '42501') {
    return new AppError('DATA_SCOPE_FORBIDDEN', 403, 'Database authorization denied', 'The database role denied access to the requested data scope.');
  }
  if (pgError.code === '23505' && (
    pgError.constraint === 'observation_event_source_id_source_record_key_source_revisi_key' ||
    pgError.constraint === 'observation_event_source_id_source_record_key_payload_hash_key'
  )) {
    return new AppError(
      'DATABASE_UNAVAILABLE',
      503,
      'Transaction retry required',
      'A concurrent canonical first writer committed before this serializable snapshot and the request must be retried.',
      { sqlstate: pgError.code, constraint: pgError.constraint, retryableTransaction: true },
    );
  }
  if (pgError.code === '23505') {
    return new AppError('INVALID_ARGUMENT', 409, 'Idempotency conflict', 'The idempotency key is already associated with different content.', {
      constraint: pgError.constraint,
    });
  }
  if (pgError.code === 'P0001') {
    return new AppError('INVALID_ARGUMENT', 409, 'Domain invariant rejected', pgError.message ?? 'A database publish invariant rejected the request.');
  }
  if (pgError.code === 'ECONNREFUSED' || pgError.code === '57P01' || pgError.code === '57P03') {
    return new AppError('DATABASE_UNAVAILABLE', 503, 'Database unavailable', 'The spatiotemporal database is unavailable.');
  }
  return new AppError('INTERNAL_ERROR', 500, 'Internal server error', 'The request could not be completed.');
}
