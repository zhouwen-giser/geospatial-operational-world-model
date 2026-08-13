import { AppError } from '../domain/errors.js';

export function requireMatchingDataScope(
  header: string | string[] | undefined,
  body: unknown,
): string {
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue === undefined || headerValue.length === 0) {
    throw new AppError('DATA_SCOPE_FORBIDDEN', 403, 'Data scope required', 'x-data-scope-id is required and is normally derived from authenticated caller claims.');
  }
  const bodyScope = typeof body === 'object' && body !== null && 'dataScopeId' in body
    ? (body as { dataScopeId?: unknown }).dataScopeId
    : undefined;
  if (typeof bodyScope !== 'string' || bodyScope !== headerValue) {
    throw new AppError('DATA_SCOPE_FORBIDDEN', 403, 'Data scope mismatch', 'The request body dataScopeId must match the authorized x-data-scope-id.');
  }
  return headerValue;
}

export function requireDataScopeHeader(header: string | string[] | undefined): string {
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue === undefined || headerValue.length === 0) {
    throw new AppError('DATA_SCOPE_FORBIDDEN', 403, 'Data scope required', 'x-data-scope-id is required and is normally derived from authenticated caller claims.');
  }
  return headerValue;
}
