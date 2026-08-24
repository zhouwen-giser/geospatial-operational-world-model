import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GroundingCatalogOperationId } from "./schemas.js";

export interface CatalogCursor {
  v: 1;
  operationId: GroundingCatalogOperationId;
  scopeDigest: `sha256:${string}`;
  snapshotVersion: string;
  after: string;
}

export function catalogScopeDigest(dataScopeKey: string, datasetScopeKey?: string): `sha256:${string}` {
  return sha256({ dataScopeKey, ...(datasetScopeKey === undefined ? {} : { datasetScopeKey }) });
}

export function encodeCatalogCursor(payload: CatalogCursor, secret: string): string {
  assertSecret(secret);
  validate(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function decodeCatalogCursor(
  value: string | undefined,
  expected: Omit<CatalogCursor, "v" | "after">,
  secret: string
): CatalogCursor | undefined {
  assertSecret(secret);
  if (value === undefined) return undefined;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
  const calculated = Buffer.from(sign(parts[0], secret), "utf8");
  const supplied = Buffer.from(parts[1], "utf8");
  if (calculated.length !== supplied.length || !timingSafeEqual(calculated, supplied)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!isCursor(parsed)) throw invalid();
  validate(parsed);
  if (parsed.operationId !== expected.operationId || parsed.scopeDigest !== expected.scopeDigest || parsed.snapshotVersion !== expected.snapshotVersion) {
    throw new ProviderProtocolError("INVALID_REQUEST", "cursor is unavailable for this operation, scope, or snapshot");
  }
  return parsed;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("catalog cursor secret must contain at least 32 bytes");
}

function validate(value: CatalogCursor): void {
  if (!/^wrf_[0-9a-f]{32}$/u.test(value.after)) throw invalid();
  if (!value.snapshotVersion || value.snapshotVersion.length > 128) throw invalid();
}

function isCursor(value: unknown): value is CatalogCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && typeof candidate.operationId === "string" &&
    typeof candidate.scopeDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate.scopeDigest) &&
    typeof candidate.snapshotVersion === "string" && typeof candidate.after === "string";
}

function invalid(): ProviderProtocolError {
  return new ProviderProtocolError("INVALID_REQUEST", "cursor is invalid");
}
