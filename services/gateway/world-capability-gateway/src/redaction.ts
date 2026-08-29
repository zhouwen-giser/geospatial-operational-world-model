const SENSITIVE_DETAIL_KEY = /(?:authorization|token|secret|password|credential|cookie|api[-_]?key|geometry|coordinates|payload|input|output|sql|query|body|request|response)/iu;

const PUBLIC_DETAIL_KEYS = new Set([
  "adherenceStatus",
  "allowed",
  "canonicalHash",
  "consumed",
  "field",
  "issues",
  "keyword",
  "limit",
  "metric",
  "missing",
  "nodeId",
  "operationId",
  "operationVersion",
  "path",
  "providerId",
  "registeredHash",
  "requested",
  "retryAfterMs",
  "schemaHash",
  "schemaUri",
  "stage",
  "status"
]);

const MAX_ARRAY_ITEMS = 32;
const MAX_DEPTH = 5;
const SAFE_PUBLIC_STRING = /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,255}$/u;

export function publicErrorMessage(code: string): string {
  if (code === "INVALID_REQUEST") return "Request validation failed";
  if (code === "SCHEMA_MISMATCH") return "Schema validation failed";
  if (["OPERATION_NOT_FOUND", "VERSION_NOT_FOUND"].includes(code)) return "Operation is not available";
  if (["SCOPE_REQUIRED", "SCOPE_DENIED"].includes(code)) return "Request scope is not permitted";
  if (code === "DEADLINE_EXCEEDED") return "Execution deadline exceeded";
  if (code === "BUDGET_EXCEEDED") return "Execution budget exceeded";
  if (code === "IDEMPOTENCY_CONFLICT") return "Idempotency conflict";
  if (code === "OVERLOADED") return "Provider is overloaded";
  if (code === "PROVIDER_NOT_READY") return "Provider is not ready";
  return "Gateway request failed";
}

export function redactPublicDetails(
  details: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) return undefined;
  const redacted = sanitizeRecord(details, 0);
  return Object.keys(redacted).length === 0 ? undefined : redacted;
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    if (!PUBLIC_DETAIL_KEYS.has(key)) continue;
    const sanitized = sanitizeValue(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return SAFE_PUBLIC_STRING.test(value) ? value : "[REDACTED]";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return [];
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (value !== null && typeof value === "object") {
    return sanitizeRecord(value as Readonly<Record<string, unknown>>, depth);
  }
  return undefined;
}
